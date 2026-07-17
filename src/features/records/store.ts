// Local record store (specs/results-records.md).
// One JSON document, keyed by songId+chartId, tracking each chart's best lamp/score/BP
// across plays. Pure update logic (applyPlay) is separated from the storage-backed
// wrapper (openRecordsStore) so the merge rules can be unit tested without touching
// localStorage or a confirm() dialog.

import { type KeyValueStorage, STORAGE_KEYS, createLocalDoc } from '../../lib/storage/local';
import { CLEAR_LAMP_ORDER, type ClearLamp } from '../play/gauge';
import type { Arrangement, DjRank } from '../play/types';
import { mergeRecords, parseRecordsExport, serializeRecordsExport } from './transfer';

// Arrangement (RANDOM/MIRROR lane-arrangement option) is defined in ../play/types —
// see that file for why the record schema retains it ahead of Milestone 6 gameplay
// support (play-options.md req 10, results-records.md req 8). Re-exported here so
// consumers of the record store don't need a second import path for it.
export type { Arrangement } from '../play/types';

export interface ChartRecord {
  songId: string;
  chartId: string;
  clearLamp: ClearLamp; // monotonic: only upgrades per CLEAR_LAMP_ORDER
  lampArrangement: Arrangement; // arrangement used on the play that set the current lamp
  bestExScore: number | null; // null until first FINISHED play
  bestRank: DjRank | null; // replaced only together with bestExScore (results-records.md req 4)
  bestExArrangement: Arrangement | null;
  minBP: number | null; // null until first finished play; only finished plays comparable
  playCount: number;
  lastPlayedAt: string; // ISO 8601, injected by caller
}

export interface RecordsData {
  records: Record<string, ChartRecord>; // key = recordKey(songId, chartId)
}

export function recordKey(songId: string, chartId: string): string {
  return `${songId}::${chartId}`;
}

export interface RecordablePlay {
  songId: string;
  chartId: string;
  finishedSong: boolean; // false = abandoned via ESC or died mid-song
  lamp: ClearLamp; // already classified (FAILED for non-clears)
  exScore: number;
  djRank: DjRank;
  bp: number;
  arrangement: Arrangement;
  autoplay: boolean;
}

export interface RecordUpdateOutcome {
  entry: ChartRecord; // post-update entry
  previous: ChartRecord | null; // pre-update entry (deep copy), null on first play
  newLamp: boolean; // lamp strictly upgraded this play
  newExScore: boolean; // bestExScore set/improved this play
  newMinBP: boolean; // minBP set/improved this play
  exScoreDiff: number | null; // play exScore − previous bestExScore; null when no previous best
}

function freshEntry(
  songId: string,
  chartId: string,
  arrangement: Arrangement,
  nowIso: string,
): ChartRecord {
  return {
    songId,
    chartId,
    clearLamp: 'NO_PLAY',
    lampArrangement: arrangement,
    bestExScore: null,
    bestRank: null,
    bestExArrangement: null,
    minBP: null,
    playCount: 0,
    lastPlayedAt: nowIso,
  };
}

/**
 * Pure. Mutates nothing; returns updated data + outcome. Returns null (and must not
 * be persisted) for autoplay plays.
 */
export function applyPlay(
  data: RecordsData,
  play: RecordablePlay,
  nowIso: string,
): { data: RecordsData; outcome: RecordUpdateOutcome } | null {
  // Rule 1: autoplay never touches records at all, not even playCount
  // (play-options.md req 11: "records are not saved").
  if (play.autoplay) {
    return null;
  }

  const key = recordKey(play.songId, play.chartId);
  const existing = data.records[key] ?? null;
  // Deep copy for the outcome's `previous` field — flat shape, so a shallow spread
  // is sufficient; no nested objects/arrays to worry about.
  const previous: ChartRecord | null = existing ? { ...existing } : null;
  const base = existing ?? freshEntry(play.songId, play.chartId, play.arrangement, nowIso);

  // Rule 3: upgrade only when play.lamp strictly outranks the stored lamp (never
  // downgrade — spec req 4 + acceptance "HARD CLEAR then NORMAL FAILED keeps HARD
  // CLEAR"). A brand-new entry starts at NO_PLAY, so any real play.lamp beats it and
  // newLamp is true on the first play.
  const previousLampIndex = CLEAR_LAMP_ORDER.indexOf(base.clearLamp);
  const playLampIndex = CLEAR_LAMP_ORDER.indexOf(play.lamp);
  const newLamp = playLampIndex > previousLampIndex;

  const entry: ChartRecord = {
    ...base,
    // Rule 2: every non-autoplay play (finished OR abandoned/died) counts.
    // WHY: app-shell-navigation.md req 9 counts an ESC-abandon as FAILED, and
    // results-records.md req 6 writes once per song end.
    playCount: base.playCount + 1,
    lastPlayedAt: nowIso,
  };

  if (newLamp) {
    entry.clearLamp = play.lamp;
    entry.lampArrangement = play.arrangement;
  }

  let newExScore = false;
  let newMinBP = false;
  let exScoreDiff: number | null = null;

  // Rule 4: score/rank/BP bests update ONLY when the song was actually finished.
  // WHY (project decision): a partial run's EX score and BP are not comparable to a
  // full chart — recording minBP from a play abandoned at 5% would be meaningless.
  // Lamp and score update independently (spec req 5: an EASY play can improve score
  // while a HARD CLEAR lamp is preserved).
  if (play.finishedSong) {
    const previousBestEx = base.bestExScore;
    // Rule 5: diff is only meaningful against a finished-play best.
    if (previousBestEx !== null) {
      exScoreDiff = play.exScore - previousBestEx;
    }
    if (previousBestEx === null || play.exScore > previousBestEx) {
      entry.bestExScore = play.exScore;
      entry.bestRank = play.djRank;
      entry.bestExArrangement = play.arrangement;
      newExScore = true;
    }
    if (base.minBP === null || play.bp < base.minBP) {
      entry.minBP = play.bp;
      newMinBP = true;
    }
  }

  const outcome: RecordUpdateOutcome = {
    entry,
    previous,
    newLamp,
    newExScore,
    newMinBP,
    exScoreDiff,
  };

  // Rule 6: pure — shallow-copy the records map, never mutate the input.
  const records = { ...data.records, [key]: entry };
  return { data: { records }, outcome };
}

export type RecordsImportOutcome =
  | { ok: true; added: number; improved: number; unchanged: number }
  | { ok: false; error: string };

export interface RecordsStore {
  // applies + writes doc exactly once; null for autoplay (no write)
  recordPlay(play: RecordablePlay, nowIso: string): RecordUpdateOutcome | null;
  getRecord(songId: string, chartId: string): ChartRecord | null;
  all(): RecordsData;
  /** results-records.md SHOULD 10 — the export file IS the records.v1 envelope. */
  exportJson(): string;
  /** Validates then best-merges (see transfer.ts); writes only when something changed. */
  importJson(text: string): RecordsImportOutcome;
}

export interface OpenRecordsStoreOptions {
  storage: KeyValueStorage;
  // shell passes window.confirm
  confirmReset: (message: string) => boolean;
}

function isRecordsData(data: unknown): data is RecordsData {
  if (typeof data !== 'object' || data === null || !('records' in data)) {
    return false;
  }
  const records = (data as Record<string, unknown>).records;
  return typeof records === 'object' && records !== null;
}

const CORRUPT_BACKUP_KEY = `${STORAGE_KEYS.records}.corrupt`;

export function openRecordsStore(opts: OpenRecordsStoreOptions): RecordsStore {
  const { storage, confirmReset } = opts;

  const doc = createLocalDoc<RecordsData>({
    storage,
    key: STORAGE_KEYS.records,
    version: 1,
    defaultValue: () => ({ records: {} }),
    validate: isRecordsData,
  });

  // Rule (data safety, results-records.md req 9): never crash on corrupt data. Back
  // up the raw bytes first, then ask the user whether to reset.
  const opened = doc.readDetailed();
  if (opened.status === 'corrupt') {
    if (opened.raw !== undefined) {
      storage.setItem(CORRUPT_BACKUP_KEY, opened.raw);
    }
    const shouldReset = confirmReset(
      'Your saved play records could not be read and appear to be corrupted. ' +
        'A backup of the corrupted data has been kept. Reset your records to start fresh?',
    );
    if (shouldReset) {
      // Clean reset persisted immediately.
      doc.write({ records: {} });
    }
    // If declined: leave the stored bytes at STORAGE_KEYS.records untouched — the
    // backup above already preserves them. createLocalDoc's read()/readDetailed()
    // already fall back to an empty default whenever the stored bytes are corrupt,
    // so the store transparently behaves as an in-memory empty doc from here on,
    // until the next recordPlay() call writes valid data and overwrites the corrupt
    // bytes (acceptable — the backup key still holds the original raw string).
  }

  function recordPlay(play: RecordablePlay, nowIso: string): RecordUpdateOutcome | null {
    const result = applyPlay(doc.read(), play, nowIso);
    if (result === null) {
      return null;
    }
    doc.write(result.data);
    return result.outcome;
  }

  function getRecord(songId: string, chartId: string): ChartRecord | null {
    return doc.read().records[recordKey(songId, chartId)] ?? null;
  }

  function all(): RecordsData {
    return doc.read();
  }

  function exportJson(): string {
    return serializeRecordsExport(doc.read());
  }

  function importJson(text: string): RecordsImportOutcome {
    const parsed = parseRecordsExport(text);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const merged = mergeRecords(doc.read(), parsed.data);
    // Skip the write when nothing changed (re-importing the same file) — the
    // stored bytes stay byte-identical, which also keeps e2e assertions simple.
    if (merged.added > 0 || merged.improved > 0) {
      doc.write(merged.data);
    }
    return {
      ok: true,
      added: merged.added,
      improved: merged.improved,
      unchanged: merged.unchanged,
    };
  }

  return { recordPlay, getRecord, all, exportJson, importJson };
}
