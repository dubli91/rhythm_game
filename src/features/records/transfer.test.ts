// Records export/import + merge rules (results-records.md SHOULD 10).
//
// The two properties that make import safe to offer at all are pinned here:
// IDEMPOTENT (importing the same file twice === importing it once — spec
// acceptance criterion) and MONOTONIC (an import can never downgrade a local
// lamp/best — same philosophy as the store's own applyPlay). If either breaks,
// import silently corrupts real player progress, so these are load-bearing.

import { describe, expect, it } from 'vitest';
import type { ChartRecord, RecordsData } from './store';
import { recordKey } from './store';
import {
  RECORDS_EXPORT_VERSION,
  chartRecordError,
  mergeRecords,
  parseRecordsExport,
  serializeRecordsExport,
} from './transfer';

function record(overrides: Partial<ChartRecord> = {}): ChartRecord {
  return {
    songId: 'song-1',
    chartId: 'chart-h',
    clearLamp: 'CLEAR',
    lampArrangement: 'OFF',
    bestExScore: 100,
    bestRank: 'AA',
    bestExArrangement: 'OFF',
    minBP: 5,
    playCount: 3,
    lastPlayedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function dataOf(...records: ChartRecord[]): RecordsData {
  return {
    records: Object.fromEntries(records.map((r) => [recordKey(r.songId, r.chartId), r])),
  };
}

describe('serialize/parse round-trip', () => {
  it('parse(serialize(data)) restores the data exactly (reset-browser acceptance criterion)', () => {
    const data = dataOf(record(), record({ songId: 'song-2', clearLamp: 'FULL_COMBO' }));
    const parsed = parseRecordsExport(serializeRecordsExport(data));
    expect(parsed).toEqual({ ok: true, data });
  });

  it('serializes the records.v1 envelope shape — one schema for store and file', () => {
    const envelope = JSON.parse(serializeRecordsExport(dataOf(record()))) as {
      version: number;
      data: RecordsData;
    };
    expect(envelope.version).toBe(RECORDS_EXPORT_VERSION);
    expect(envelope.data.records[recordKey('song-1', 'chart-h')]).toBeDefined();
  });
});

describe('parseRecordsExport rejection', () => {
  it('rejects non-JSON', () => {
    expect(parseRecordsExport('not json {')).toEqual({ ok: false, error: 'not valid JSON' });
  });

  it('rejects a non-object and a missing/mismatched version', () => {
    expect(parseRecordsExport('42').ok).toBe(false);
    expect(parseRecordsExport('{"data":{"records":{}}}').ok).toBe(false);
    const wrongVersion = parseRecordsExport('{"version":2,"data":{"records":{}}}');
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.error).toContain('version 2');
  });

  it('rejects missing data.records', () => {
    expect(parseRecordsExport('{"version":1}').ok).toBe(false);
    expect(parseRecordsExport('{"version":1,"data":{}}').ok).toBe(false);
    expect(parseRecordsExport('{"version":1,"data":{"records":[]}}').ok).toBe(false);
  });

  it('rejects a record whose key does not match its songId/chartId', () => {
    const data = { records: { 'wrong::key': record() } };
    const parsed = parseRecordsExport(JSON.stringify({ version: 1, data }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('key does not match');
  });

  it('rejects per-field corruption with the failing field named', () => {
    const key = recordKey('song-1', 'chart-h');
    const cases: Array<[Partial<Record<keyof ChartRecord, unknown>>, string]> = [
      [{ clearLamp: 'SUPER_CLEAR' }, 'clearLamp'],
      [{ lampArrangement: 'FLIP' }, 'lampArrangement'],
      [{ bestExScore: 'high' }, 'bestExScore'],
      [{ bestRank: 'S' }, 'bestRank'],
      [{ bestExArrangement: 7 }, 'bestExArrangement'],
      // NB: NaN is unrepresentable in JSON (stringifies to null, which minBP allows),
      // so the type-corruption case must be a non-number.
      [{ minBP: 'many' }, 'minBP'],
      [{ playCount: -1 }, 'playCount'],
      [{ playCount: 1.5 }, 'playCount'],
      [{ lastPlayedAt: 12345 }, 'lastPlayedAt'],
    ];
    for (const [override, field] of cases) {
      const bad = { ...record(), ...override };
      const parsed = parseRecordsExport(
        JSON.stringify({ version: 1, data: { records: { [key]: bad } } }),
      );
      expect(parsed.ok, `${field} should be rejected`).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(field);
    }
  });

  it('chartRecordError accepts a fully valid record and nulls where allowed', () => {
    const fresh = record({
      bestExScore: null,
      bestRank: null,
      bestExArrangement: null,
      minBP: null,
    });
    expect(chartRecordError(recordKey('song-1', 'chart-h'), fresh)).toBeNull();
  });
});

describe('mergeRecords', () => {
  it('into empty local = exact copy of the import (full restore)', () => {
    const imported = dataOf(record(), record({ chartId: 'chart-a', clearLamp: 'FAILED' }));
    const result = mergeRecords({ records: {} }, imported);
    expect(result.data).toEqual(imported);
    expect(result).toMatchObject({ added: 2, improved: 0, unchanged: 0 });
  });

  it('is idempotent: importing the same file twice changes nothing the second time', () => {
    const local = dataOf(record({ bestExScore: 50, clearLamp: 'EASY_CLEAR' }));
    const imported = dataOf(record({ bestExScore: 120, clearLamp: 'HARD_CLEAR', playCount: 10 }));
    const once = mergeRecords(local, imported);
    const twice = mergeRecords(once.data, imported);
    expect(twice.data).toEqual(once.data);
    expect(twice).toMatchObject({ added: 0, improved: 0, unchanged: 1 });
  });

  it('never downgrades: worse imported lamp/score/BP leaves local untouched', () => {
    const local = dataOf(
      record({
        clearLamp: 'HARD_CLEAR',
        bestExScore: 200,
        bestRank: 'AAA',
        minBP: 1,
        playCount: 9,
      }),
    );
    const imported = dataOf(
      record({ clearLamp: 'FAILED', bestExScore: 10, bestRank: 'F', minBP: 50, playCount: 2 }),
    );
    const result = mergeRecords(local, imported);
    expect(result.data).toEqual(local);
    expect(result).toMatchObject({ added: 0, improved: 0, unchanged: 1 });
  });

  it('takes the better side per field independently, carrying the winner’s companions', () => {
    const local = dataOf(
      record({
        clearLamp: 'HARD_CLEAR',
        lampArrangement: 'OFF',
        bestExScore: 100,
        bestRank: 'AA',
        bestExArrangement: 'OFF',
        minBP: 3,
        playCount: 4,
        lastPlayedAt: '2026-07-10T00:00:00.000Z',
      }),
    );
    const imported = dataOf(
      record({
        clearLamp: 'FULL_COMBO', // better — wins, brings its arrangement
        lampArrangement: 'RANDOM',
        bestExScore: 90, // worse — local best + rank + arrangement stay
        bestRank: 'AAA',
        bestExArrangement: 'MIRROR',
        minBP: 1, // better — wins
        playCount: 2, // max(4, 2) = 4, NOT 6: summing would double-count on re-import
        lastPlayedAt: '2026-07-14T00:00:00.000Z', // later — wins
      }),
    );
    const merged = mergeRecords(local, imported).data.records[recordKey('song-1', 'chart-h')];
    expect(merged).toEqual(
      record({
        clearLamp: 'FULL_COMBO',
        lampArrangement: 'RANDOM',
        bestExScore: 100,
        bestRank: 'AA',
        bestExArrangement: 'OFF',
        minBP: 1,
        playCount: 4,
        lastPlayedAt: '2026-07-14T00:00:00.000Z',
      }),
    );
  });

  it('a null local best is beaten by any imported best (with rank/arrangement)', () => {
    const local = dataOf(
      record({ bestExScore: null, bestRank: null, bestExArrangement: null, minBP: null }),
    );
    const imported = dataOf(
      record({ bestExScore: 42, bestRank: 'B', bestExArrangement: 'MIRROR', minBP: 12 }),
    );
    const merged = mergeRecords(local, imported).data.records[recordKey('song-1', 'chart-h')];
    expect(merged).toMatchObject({
      bestExScore: 42,
      bestRank: 'B',
      bestExArrangement: 'MIRROR',
      minBP: 12,
    });
  });

  it('keeps local-only records and imports unknown-to-library charts alike', () => {
    const localOnly = record({ songId: 'song-local' });
    const importedOnly = record({ songId: 'song-imported' });
    const result = mergeRecords(dataOf(localOnly), dataOf(importedOnly));
    expect(Object.keys(result.data.records)).toHaveLength(2);
    expect(result.added).toBe(1);
  });

  it('mutates neither input', () => {
    const local = dataOf(record({ bestExScore: 50 }));
    const imported = dataOf(record({ bestExScore: 120 }));
    const localSnapshot = JSON.parse(JSON.stringify(local)) as RecordsData;
    const importedSnapshot = JSON.parse(JSON.stringify(imported)) as RecordsData;
    mergeRecords(local, imported);
    expect(local).toEqual(localSnapshot);
    expect(imported).toEqual(importedSnapshot);
  });
});
