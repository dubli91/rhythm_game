// Records JSON export/import (specs/results-records.md SHOULD 10).
//
// The export file IS the persisted records.v1 envelope ({version, data}) — one
// schema, no second "transfer format" to keep in sync. Import therefore accepts
// exactly what export produces, and the acceptance criterion "import into a
// reset browser fully restores records" holds by construction.
//
// Import into a browser that already has records MERGES per chart, field-wise,
// keeping the better side. The merge is idempotent (importing the same file
// twice changes nothing the second time) and never downgrades local progress —
// an import can only add records or improve fields, mirroring the store's own
// monotonic-lamp philosophy. playCount takes the MAX of the two sides, not the
// sum: summing would double-count every time the same file is re-imported, and
// idempotency is worth more than a cross-device total that would only be
// approximate anyway.

import { CLEAR_LAMP_ORDER, type ClearLamp } from '../play/gauge';
import { ARRANGEMENTS } from '../play/options';
import { DJ_RANKS } from '../play/types';
import { type ChartRecord, type RecordsData, recordKey } from './store';

/** Kept equal to the records.v1 doc version — the file and the store share one schema. */
export const RECORDS_EXPORT_VERSION = 1;

export type ParseRecordsResult = { ok: true; data: RecordsData } | { ok: false; error: string };

export interface MergeRecordsResult {
  data: RecordsData;
  /** imported charts that had no local record */
  added: number;
  /** local records improved in at least one field */
  improved: number;
  /** imported records that changed nothing (local was already >= on every field) */
  unchanged: number;
}

export function serializeRecordsExport(data: RecordsData): string {
  // Pretty-printed: this is a user-facing file they may inspect or hand-carry.
  return JSON.stringify({ version: RECORDS_EXPORT_VERSION, data }, null, 2);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/**
 * Strict per-field validation — unlike the store's own shape check, import text
 * comes from an arbitrary user file, so every field is checked before anything
 * is merged into real records. Returns an error string naming the failing
 * field, or null when valid.
 */
export function chartRecordError(key: string, value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return `records["${key}"]: not an object`;
  const rec = value as Record<string, unknown>;
  const fail = (field: string): string => `records["${key}"].${field}: invalid`;
  if (typeof rec.songId !== 'string' || rec.songId.length === 0) return fail('songId');
  if (typeof rec.chartId !== 'string' || rec.chartId.length === 0) return fail('chartId');
  if (recordKey(rec.songId, rec.chartId) !== key) {
    return `records["${key}"]: key does not match songId/chartId`;
  }
  if (!includes(CLEAR_LAMP_ORDER, rec.clearLamp)) return fail('clearLamp');
  if (!includes(ARRANGEMENTS, rec.lampArrangement)) return fail('lampArrangement');
  if (!isNumberOrNull(rec.bestExScore)) return fail('bestExScore');
  if (rec.bestRank !== null && !includes(DJ_RANKS, rec.bestRank)) return fail('bestRank');
  if (rec.bestExArrangement !== null && !includes(ARRANGEMENTS, rec.bestExArrangement)) {
    return fail('bestExArrangement');
  }
  if (!isNumberOrNull(rec.minBP)) return fail('minBP');
  if (typeof rec.playCount !== 'number' || !Number.isInteger(rec.playCount) || rec.playCount < 0) {
    return fail('playCount');
  }
  if (typeof rec.lastPlayedAt !== 'string') return fail('lastPlayedAt');
  return null;
}

export function parseRecordsExport(text: string): ParseRecordsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'not a records export (expected an object)' };
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version !== RECORDS_EXPORT_VERSION) {
    return {
      ok: false,
      error: `unsupported export version ${String(envelope.version)} (expected ${RECORDS_EXPORT_VERSION})`,
    };
  }
  const data = envelope.data as Record<string, unknown> | null | undefined;
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'missing data' };
  }
  const records = data.records;
  if (typeof records !== 'object' || records === null || Array.isArray(records)) {
    return { ok: false, error: 'missing data.records' };
  }
  for (const [key, value] of Object.entries(records)) {
    const error = chartRecordError(key, value);
    if (error !== null) return { ok: false, error };
  }
  return { ok: true, data: { records: records as Record<string, ChartRecord> } };
}

function lampIndex(lamp: ClearLamp): number {
  return CLEAR_LAMP_ORDER.indexOf(lamp);
}

/** Field-wise best of a local and an imported record (see file header for the rules). */
function mergeRecord(local: ChartRecord, imported: ChartRecord): ChartRecord {
  const merged: ChartRecord = { ...local };
  if (lampIndex(imported.clearLamp) > lampIndex(local.clearLamp)) {
    merged.clearLamp = imported.clearLamp;
    merged.lampArrangement = imported.lampArrangement;
  }
  if (imported.bestExScore !== null && (local.bestExScore ?? -1) < imported.bestExScore) {
    merged.bestExScore = imported.bestExScore;
    merged.bestRank = imported.bestRank;
    merged.bestExArrangement = imported.bestExArrangement;
  }
  if (imported.minBP !== null && (local.minBP === null || imported.minBP < local.minBP)) {
    merged.minBP = imported.minBP;
  }
  merged.playCount = Math.max(local.playCount, imported.playCount);
  // ISO 8601 UTC strings (Date.toISOString) compare correctly as strings.
  if (imported.lastPlayedAt > local.lastPlayedAt) {
    merged.lastPlayedAt = imported.lastPlayedAt;
  }
  return merged;
}

function recordsEqual(a: ChartRecord, b: ChartRecord): boolean {
  // Flat shape — field-by-field compare is exact.
  return (
    a.clearLamp === b.clearLamp &&
    a.lampArrangement === b.lampArrangement &&
    a.bestExScore === b.bestExScore &&
    a.bestRank === b.bestRank &&
    a.bestExArrangement === b.bestExArrangement &&
    a.minBP === b.minBP &&
    a.playCount === b.playCount &&
    a.lastPlayedAt === b.lastPlayedAt
  );
}

/** Pure: mutates neither input. Local-only records are always retained. */
export function mergeRecords(local: RecordsData, imported: RecordsData): MergeRecordsResult {
  const records: Record<string, ChartRecord> = { ...local.records };
  let added = 0;
  let improved = 0;
  let unchanged = 0;
  for (const [key, importedRecord] of Object.entries(imported.records)) {
    const localRecord = records[key];
    if (localRecord === undefined) {
      records[key] = { ...importedRecord };
      added++;
      continue;
    }
    const merged = mergeRecord(localRecord, importedRecord);
    if (recordsEqual(merged, localRecord)) {
      unchanged++;
    } else {
      records[key] = merged;
      improved++;
    }
  }
  return { data: { records }, added, improved, unchanged };
}
