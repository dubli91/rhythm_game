import { CHART_FORMAT_VERSION, DIFFICULTIES, LANE_COUNT } from './types';
import type { Chart, Difficulty, Song } from './types';

/**
 * A single validation problem found while checking a raw (untyped) document
 * against the chart/song schema. `path` uses a dotted/bracketed accessor
 * style, e.g. 'notes[3].lane' or 'timing.bpmEvents[0].beat'.
 */
export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

/** Thrown by loadChart() when a raw document fails schema validation. */
export class ChartValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    const first = issues[0];
    const firstDescription = first
      ? `${first.path || '(root)'}: ${first.message}`
      : 'no validation issues reported';
    const remainder =
      issues.length > 1 ? ` (+${issues.length - 1} more issue${issues.length > 2 ? 's' : ''})` : '';
    super(`Chart validation failed: ${firstDescription}${remainder}`);
    this.name = 'ChartValidationError';
    this.issues = issues;
  }
}

// --- narrowing helpers -----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function joinPath(base: string, field: string): string {
  return base ? `${base}.${field}` : field;
}

// --- chart validation --------------------------------------------------------

function validateBpmRange(raw: unknown, base: string, issues: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    issues.push({ path: base, message: 'bpm must be an object with init, min, max' });
    return;
  }

  const initRaw = raw.init;
  if (!isFiniteNumber(initRaw) || initRaw <= 0) {
    issues.push({
      path: joinPath(base, 'init'),
      message: 'bpm.init must be a finite number greater than 0',
    });
  }

  let min: number | undefined;
  const minRaw = raw.min;
  if (isFiniteNumber(minRaw) && minRaw > 0) {
    min = minRaw;
  } else {
    issues.push({
      path: joinPath(base, 'min'),
      message: 'bpm.min must be a finite number greater than 0',
    });
  }

  let max: number | undefined;
  const maxRaw = raw.max;
  if (isFiniteNumber(maxRaw) && maxRaw > 0) {
    max = maxRaw;
  } else {
    issues.push({
      path: joinPath(base, 'max'),
      message: 'bpm.max must be a finite number greater than 0',
    });
  }

  if (min !== undefined && max !== undefined && min > max) {
    issues.push({ path: base, message: 'bpm.min must be <= bpm.max' });
  }
}

function validateBpmEvents(raw: unknown, base: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(raw)) {
    issues.push({ path: base, message: 'bpmEvents must be an array' });
    return;
  }
  if (raw.length === 0) {
    issues.push({ path: base, message: 'bpmEvents must not be empty' });
    return;
  }

  let previousBeat: number | undefined;
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const entryPath = `${base}[${i}]`;
    if (!isRecord(entry)) {
      issues.push({ path: entryPath, message: 'bpm event must be an object' });
      previousBeat = undefined;
      continue;
    }

    let beat: number | undefined;
    const beatRaw = entry.beat;
    if (isFiniteNumber(beatRaw) && beatRaw >= 0) {
      beat = beatRaw;
    } else {
      issues.push({
        path: joinPath(entryPath, 'beat'),
        message: 'beat must be a finite number >= 0',
      });
    }

    const bpmRaw = entry.bpm;
    if (!isFiniteNumber(bpmRaw) || bpmRaw <= 0) {
      issues.push({
        path: joinPath(entryPath, 'bpm'),
        message: 'bpm must be a finite number greater than 0',
      });
    }

    if (beat !== undefined) {
      if (i === 0 && beat !== 0) {
        issues.push({
          path: joinPath(entryPath, 'beat'),
          message: 'first bpm event beat must be 0',
        });
      }
      if (previousBeat !== undefined && beat <= previousBeat) {
        issues.push({ path: entryPath, message: 'bpmEvents must be strictly ascending by beat' });
      }
      previousBeat = beat;
    } else {
      previousBeat = undefined;
    }
  }
}

function validateStopEvents(raw: unknown, base: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(raw)) {
    issues.push({ path: base, message: 'stopEvents must be an array' });
    return;
  }

  let previousBeat: number | undefined;
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const entryPath = `${base}[${i}]`;
    if (!isRecord(entry)) {
      issues.push({ path: entryPath, message: 'stop event must be an object' });
      previousBeat = undefined;
      continue;
    }

    let beat: number | undefined;
    const beatRaw = entry.beat;
    if (isFiniteNumber(beatRaw) && beatRaw >= 0) {
      beat = beatRaw;
    } else {
      issues.push({
        path: joinPath(entryPath, 'beat'),
        message: 'beat must be a finite number >= 0',
      });
    }

    const durationRaw = entry.durationBeats;
    if (!isFiniteNumber(durationRaw) || durationRaw <= 0) {
      issues.push({
        path: joinPath(entryPath, 'durationBeats'),
        message: 'durationBeats must be a finite number greater than 0',
      });
    }

    if (beat !== undefined) {
      if (previousBeat !== undefined && beat <= previousBeat) {
        issues.push({ path: entryPath, message: 'stopEvents must be strictly ascending by beat' });
      }
      previousBeat = beat;
    } else {
      previousBeat = undefined;
    }
  }
}

function validateTiming(raw: unknown, base: string, issues: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    issues.push({ path: base, message: 'timing must be an object with bpmEvents and stopEvents' });
    return;
  }
  validateBpmEvents(raw.bpmEvents, joinPath(base, 'bpmEvents'), issues);
  validateStopEvents(raw.stopEvents, joinPath(base, 'stopEvents'), issues);
}

function validateNotes(raw: unknown, base: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(raw)) {
    issues.push({ path: base, message: 'notes must be an array' });
    return;
  }

  const seen = new Set<string>();
  let previousBeat: number | undefined;
  let sorted = true;
  // Per-lane entries for the CN span-overlap check below. Only entries whose
  // beat/lane (and endBeat, for cn) parsed cleanly participate.
  const perLane = new Map<number, { beat: number; endBeat?: number; index: number }[]>();

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const entryPath = `${base}[${i}]`;
    if (!isRecord(entry)) {
      issues.push({ path: entryPath, message: 'note must be an object' });
      previousBeat = undefined;
      continue;
    }

    let beat: number | undefined;
    const beatRaw = entry.beat;
    if (isFiniteNumber(beatRaw) && beatRaw >= 0) {
      beat = beatRaw;
    } else {
      issues.push({
        path: joinPath(entryPath, 'beat'),
        message: 'beat must be a finite number >= 0',
      });
    }

    let lane: number | undefined;
    const laneRaw = entry.lane;
    if (isInteger(laneRaw) && laneRaw >= 0 && laneRaw <= LANE_COUNT - 1) {
      lane = laneRaw;
    } else {
      issues.push({
        path: joinPath(entryPath, 'lane'),
        message: `lane must be an integer between 0 and ${LANE_COUNT - 1}`,
      });
    }

    const type = entry.type;
    const isTap = type === 'tap';
    const isCn = type === 'cn';
    if (!isTap && !isCn) {
      issues.push({ path: joinPath(entryPath, 'type'), message: "type must be 'tap' or 'cn'" });
    }

    let endBeat: number | undefined;
    if (isCn) {
      const endBeatRaw = entry.endBeat;
      if (!isFiniteNumber(endBeatRaw)) {
        issues.push({
          path: joinPath(entryPath, 'endBeat'),
          message: 'endBeat is required and must be a finite number for cn notes',
        });
      } else if (beat !== undefined && endBeatRaw <= beat) {
        issues.push({
          path: joinPath(entryPath, 'endBeat'),
          message: 'endBeat must be greater than beat',
        });
      } else if (beat !== undefined) {
        endBeat = endBeatRaw;
      }
    } else if (isTap) {
      if (entry.endBeat !== undefined) {
        issues.push({
          path: joinPath(entryPath, 'endBeat'),
          message: 'endBeat is only valid for cn notes',
        });
      }
    }

    if (beat !== undefined && lane !== undefined) {
      const key = `${lane}:${beat}`;
      if (seen.has(key)) {
        issues.push({
          path: entryPath,
          message: 'duplicate note: same lane and beat as an earlier note',
        });
      } else {
        seen.add(key);
      }

      let laneEntries = perLane.get(lane);
      if (laneEntries === undefined) {
        laneEntries = [];
        perLane.set(lane, laneEntries);
      }
      laneEntries.push({ beat, endBeat, index: i });
    }

    if (beat !== undefined) {
      if (previousBeat !== undefined && beat < previousBeat) {
        sorted = false;
      }
      previousBeat = beat;
    }
  }

  if (!sorted) {
    issues.push({ path: base, message: 'notes must be sorted by beat ascending' });
  }

  // CN span overlap (chart-format.md SHOULD 9): while a CN is held the lane's key is
  // down, so no other note on that lane is playable until the tail — and the judge
  // relies on at most one hold per lane. Rejection is INCLUSIVE of the tail beat: a
  // note exactly at endBeat would require an instant release+repress.
  for (const laneEntries of perLane.values()) {
    laneEntries.sort((a, b) => a.beat - b.beat);
    let openEndBeat: number | undefined;
    for (const entry of laneEntries) {
      if (openEndBeat !== undefined && entry.beat <= openEndBeat) {
        issues.push({
          path: `${base}[${entry.index}]`,
          message:
            'note overlaps an earlier cn span on the same lane (beat must be greater than that cn endBeat)',
        });
      }
      if (
        entry.endBeat !== undefined &&
        (openEndBeat === undefined || entry.endBeat > openEndBeat)
      ) {
        openEndBeat = entry.endBeat;
      }
    }
  }
}

function collectChartIssues(raw: unknown, base: string, issues: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    issues.push({ path: base, message: 'chart must be a plain object' });
    return;
  }

  const formatVersion = raw.formatVersion;
  if (!isInteger(formatVersion) || formatVersion < 1) {
    issues.push({
      path: joinPath(base, 'formatVersion'),
      message: 'formatVersion must be an integer >= 1',
    });
  } else if (formatVersion > CHART_FORMAT_VERSION) {
    issues.push({ path: joinPath(base, 'formatVersion'), message: 'unsupported formatVersion' });
  }

  if (!isNonEmptyString(raw.chartId)) {
    issues.push({ path: joinPath(base, 'chartId'), message: 'chartId must be a non-empty string' });
  }

  const difficulty = raw.difficulty;
  if (!isString(difficulty) || !DIFFICULTIES.includes(difficulty as Difficulty)) {
    issues.push({
      path: joinPath(base, 'difficulty'),
      message: `difficulty must be one of ${DIFFICULTIES.join(', ')}`,
    });
  }

  const level = raw.level;
  if (!isInteger(level) || level < 1 || level > 12) {
    issues.push({
      path: joinPath(base, 'level'),
      message: 'level must be an integer between 1 and 12',
    });
  }

  const total = raw.total;
  if (!isFiniteNumber(total) || total <= 0) {
    issues.push({
      path: joinPath(base, 'total'),
      message: 'total must be a finite number greater than 0',
    });
  }

  validateBpmRange(raw.bpm, joinPath(base, 'bpm'), issues);
  validateTiming(raw.timing, joinPath(base, 'timing'), issues);
  validateNotes(raw.notes, joinPath(base, 'notes'), issues);
}

export function validateChart(raw: unknown): ValidationResult<Chart> {
  const issues: ValidationIssue[] = [];
  collectChartIssues(raw, '', issues);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: raw as Chart };
}

// --- song validation ---------------------------------------------------------

function validateAudio(raw: unknown, base: string, issues: ValidationIssue[]): void {
  if (!isRecord(raw)) {
    issues.push({ path: base, message: 'audio must be an object' });
    return;
  }

  const source = raw.source;
  if (source !== 'builtin' && source !== 'imported') {
    issues.push({
      path: joinPath(base, 'source'),
      message: "audio.source must be 'builtin' or 'imported'",
    });
  }

  if (!isNonEmptyString(raw.ref)) {
    issues.push({ path: joinPath(base, 'ref'), message: 'audio.ref must be a non-empty string' });
  }

  if (!isFiniteNumber(raw.offsetMs)) {
    issues.push({
      path: joinPath(base, 'offsetMs'),
      message: 'audio.offsetMs must be a finite number',
    });
  }
}

export function validateSong(raw: unknown): ValidationResult<Song> {
  const issues: ValidationIssue[] = [];

  if (!isRecord(raw)) {
    issues.push({ path: '', message: 'song must be a plain object' });
    return { ok: false, issues };
  }

  if (!isNonEmptyString(raw.songId)) {
    issues.push({ path: 'songId', message: 'songId must be a non-empty string' });
  }
  if (!isNonEmptyString(raw.title)) {
    issues.push({ path: 'title', message: 'title must be a non-empty string' });
  }
  if (!isNonEmptyString(raw.artist)) {
    issues.push({ path: 'artist', message: 'artist must be a non-empty string' });
  }
  if (!isString(raw.genre)) {
    issues.push({ path: 'genre', message: 'genre must be a string' });
  }

  validateAudio(raw.audio, 'audio', issues);

  const chartsRaw = raw.charts;
  if (!Array.isArray(chartsRaw) || chartsRaw.length === 0) {
    issues.push({ path: 'charts', message: 'charts must be a non-empty array' });
  } else {
    const seenChartIds = new Set<string>();
    for (let i = 0; i < chartsRaw.length; i++) {
      const chartRaw = chartsRaw[i];
      const chartPath = `charts[${i}]`;
      collectChartIssues(chartRaw, chartPath, issues);

      if (isRecord(chartRaw) && isNonEmptyString(chartRaw.chartId)) {
        const chartId = chartRaw.chartId;
        if (seenChartIds.has(chartId)) {
          issues.push({
            path: joinPath(chartPath, 'chartId'),
            message: 'duplicate chartId across charts',
          });
        } else {
          seenChartIds.add(chartId);
        }
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: raw as unknown as Song };
}

// --- loader + migration seam --------------------------------------------------

type Migration = (raw: unknown) => unknown;

const migrations = new Map<number, Migration>();

/**
 * Migration seam: register with registerChartMigration(fromVersion, fn) — fn
 * upgrades a raw doc from fromVersion to fromVersion+1. Exported for future
 * use; registry starts empty.
 */
export function registerChartMigration(fromVersion: number, migrate: Migration): void {
  migrations.set(fromVersion, migrate);
}

/** Validates + applies formatVersion migrations; throws ChartValidationError on failure. */
export function loadChart(raw: unknown): Chart {
  let doc: unknown = raw;

  if (isRecord(doc)) {
    const formatVersion = doc.formatVersion;
    if (isInteger(formatVersion) && formatVersion < CHART_FORMAT_VERSION) {
      let version = formatVersion;
      while (version < CHART_FORMAT_VERSION) {
        const migrate = migrations.get(version);
        if (!migrate) {
          throw new ChartValidationError([
            {
              path: 'formatVersion',
              message: `no migration registered to upgrade chart from formatVersion ${version} to ${version + 1}`,
            },
          ]);
        }

        const migrated = migrate(doc);
        if (!isRecord(migrated)) {
          throw new ChartValidationError([
            {
              path: 'formatVersion',
              message: `migration registered for formatVersion ${version} must return an object`,
            },
          ]);
        }

        const migratedVersion = migrated.formatVersion;
        if (!isInteger(migratedVersion) || migratedVersion <= version) {
          throw new ChartValidationError([
            {
              path: 'formatVersion',
              message: `migration registered for formatVersion ${version} did not advance formatVersion`,
            },
          ]);
        }

        doc = migrated;
        version = migratedVersion;
      }
    }
  }

  const result = validateChart(doc);
  if (!result.ok) {
    throw new ChartValidationError(result.issues);
  }
  return result.value;
}
