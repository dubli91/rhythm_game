import { describe, expect, it } from 'vitest';
import type { KeyValueStorage } from '../../lib/storage/local';
import type { ChartRecord, RecordablePlay, RecordsData } from './store';
import { applyPlay, openRecordsStore, recordKey } from './store';

/** Small in-memory fake implementing KeyValueStorage, standing in for window.localStorage. */
function createFakeStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };
}

const SONG_ID = 'song-1';
const CHART_ID = 'chart-sp-h';
const NOW_1 = '2026-07-15T00:00:00.000Z';
const NOW_2 = '2026-07-15T00:10:00.000Z';
const NOW_3 = '2026-07-15T00:20:00.000Z';

function basePlay(overrides: Partial<RecordablePlay> = {}): RecordablePlay {
  return {
    songId: SONG_ID,
    chartId: CHART_ID,
    finishedSong: true,
    lamp: 'CLEAR',
    exScore: 100,
    djRank: 'AA',
    bp: 5,
    arrangement: 'OFF',
    autoplay: false,
    ...overrides,
  };
}

function emptyData(): RecordsData {
  return { records: {} };
}

function requireEntry(data: RecordsData): ChartRecord {
  const entry = data.records[recordKey(SONG_ID, CHART_ID)];
  if (entry === undefined) throw new Error('expected record entry to exist');
  return entry;
}

describe('recordKey', () => {
  it('joins songId and chartId with "::"', () => {
    expect(recordKey('s1', 'c1')).toBe('s1::c1');
  });
});

describe('applyPlay', () => {
  it('creates a new entry on the first finished CLEAR play with all bests set', () => {
    const play = basePlay({ lamp: 'CLEAR', exScore: 100, djRank: 'AA', bp: 5, arrangement: 'OFF' });
    const result = applyPlay(emptyData(), play, NOW_1);

    expect(result).not.toBeNull();
    const { data, outcome } = result as NonNullable<typeof result>;
    const entry = requireEntry(data);

    expect(entry).toEqual({
      songId: SONG_ID,
      chartId: CHART_ID,
      clearLamp: 'CLEAR',
      lampArrangement: 'OFF',
      bestExScore: 100,
      bestRank: 'AA',
      bestExArrangement: 'OFF',
      minBP: 5,
      playCount: 1,
      lastPlayedAt: NOW_1,
    });

    expect(outcome.entry).toEqual(entry);
    expect(outcome.previous).toBeNull();
    expect(outcome.newLamp).toBe(true);
    expect(outcome.newExScore).toBe(true);
    expect(outcome.newMinBP).toBe(true);
    expect(outcome.exScoreDiff).toBeNull();
  });

  it('never downgrades the lamp: HARD CLEAR then finished FAILED keeps HARD CLEAR', () => {
    const first = applyPlay(
      emptyData(),
      basePlay({ lamp: 'HARD_CLEAR', exScore: 100, bp: 3 }),
      NOW_1,
    );
    const afterFirst = (first as NonNullable<typeof first>).data;

    const second = applyPlay(
      afterFirst,
      basePlay({ lamp: 'FAILED', finishedSong: true, exScore: 50, bp: 20 }),
      NOW_2,
    );
    const { data, outcome } = second as NonNullable<typeof second>;
    const entry = requireEntry(data);

    expect(entry.clearLamp).toBe('HARD_CLEAR');
    expect(entry.playCount).toBe(2);
    expect(entry.lastPlayedAt).toBe(NOW_2);
    expect(outcome.newLamp).toBe(false);
  });

  it('never decreases bestExScore on a worse finished play, and improves it (with rank/arrangement) on a better one', () => {
    const r1 = applyPlay(
      emptyData(),
      basePlay({ exScore: 100, djRank: 'AA', arrangement: 'OFF' }),
      NOW_1,
    );
    const d1 = (r1 as NonNullable<typeof r1>).data;

    const r2 = applyPlay(d1, basePlay({ exScore: 80, djRank: 'A' }), NOW_2);
    const { data: d2, outcome: o2 } = r2 as NonNullable<typeof r2>;
    const e2 = requireEntry(d2);
    expect(e2.bestExScore).toBe(100);
    expect(e2.bestRank).toBe('AA');
    expect(o2.newExScore).toBe(false);
    expect(o2.exScoreDiff).toBe(-20);

    const r3 = applyPlay(
      d2,
      basePlay({ exScore: 150, djRank: 'AAA', arrangement: 'RANDOM' }),
      NOW_3,
    );
    const { data: d3, outcome: o3 } = r3 as NonNullable<typeof r3>;
    const e3 = requireEntry(d3);
    expect(e3.bestExScore).toBe(150);
    expect(e3.bestRank).toBe('AAA');
    expect(e3.bestExArrangement).toBe('RANDOM');
    expect(o3.newExScore).toBe(true);
    expect(o3.exScoreDiff).toBe(50); // 150 - 100 (previous best, not the 80 that never became best)
  });

  it('updates lamp and best score independently (EASY-lamp play improves score, HARD CLEAR lamp preserved)', () => {
    const r1 = applyPlay(
      emptyData(),
      basePlay({ lamp: 'HARD_CLEAR', exScore: 100, arrangement: 'OFF' }),
      NOW_1,
    );
    const d1 = (r1 as NonNullable<typeof r1>).data;

    const r2 = applyPlay(d1, basePlay({ lamp: 'EASY_CLEAR', exScore: 200, djRank: 'AAA' }), NOW_2);
    const { data: d2, outcome: o2 } = r2 as NonNullable<typeof r2>;
    const e2 = requireEntry(d2);

    expect(e2.clearLamp).toBe('HARD_CLEAR');
    expect(e2.lampArrangement).toBe('OFF');
    expect(e2.bestExScore).toBe(200);
    expect(e2.bestRank).toBe('AAA');
    expect(o2.newLamp).toBe(false);
    expect(o2.newExScore).toBe(true);
  });

  it('FULL COMBO ranks above everything and upgrades the lamp regardless of prior gauge type', () => {
    const r1 = applyPlay(emptyData(), basePlay({ lamp: 'EX_HARD_CLEAR' }), NOW_1);
    const d1 = (r1 as NonNullable<typeof r1>).data;

    const r2 = applyPlay(d1, basePlay({ lamp: 'FULL_COMBO' }), NOW_2);
    const { data: d2, outcome: o2 } = r2 as NonNullable<typeof r2>;
    const e2 = requireEntry(d2);

    expect(e2.clearLamp).toBe('FULL_COMBO');
    expect(o2.newLamp).toBe(true);
  });

  it('minBP only decreases and is unaffected by a finished play with higher BP', () => {
    const r1 = applyPlay(emptyData(), basePlay({ bp: 10 }), NOW_1);
    const d1 = (r1 as NonNullable<typeof r1>).data;

    const r2 = applyPlay(d1, basePlay({ bp: 25 }), NOW_2);
    const { data: d2, outcome: o2 } = r2 as NonNullable<typeof r2>;
    const e2 = requireEntry(d2);
    expect(e2.minBP).toBe(10);
    expect(o2.newMinBP).toBe(false);

    const r3 = applyPlay(d2, basePlay({ bp: 3 }), NOW_3);
    const { data: d3, outcome: o3 } = r3 as NonNullable<typeof r3>;
    const e3 = requireEntry(d3);
    expect(e3.minBP).toBe(3);
    expect(o3.newMinBP).toBe(true);
  });

  it('abandoned play (finishedSong=false) updates playCount/lastPlayedAt/lamp but not bests', () => {
    const play = basePlay({ finishedSong: false, lamp: 'FAILED', exScore: 40, bp: 30 });
    const result = applyPlay(emptyData(), play, NOW_1);
    const { data, outcome } = result as NonNullable<typeof result>;
    const entry = requireEntry(data);

    expect(entry.clearLamp).toBe('FAILED');
    expect(entry.playCount).toBe(1);
    expect(entry.lastPlayedAt).toBe(NOW_1);
    expect(entry.bestExScore).toBeNull();
    expect(entry.bestRank).toBeNull();
    expect(entry.minBP).toBeNull();
    expect(outcome.exScoreDiff).toBeNull();
  });

  it('is pure: does not mutate the input RecordsData', () => {
    const initial = emptyData();
    const snapshotBefore = JSON.stringify(initial);

    applyPlay(initial, basePlay(), NOW_1);

    expect(JSON.stringify(initial)).toBe(snapshotBefore);
    expect(initial.records).toEqual({});
  });

  it('retains the arrangement used on the best-setting play (RANDOM)', () => {
    const play = basePlay({ arrangement: 'RANDOM', lamp: 'CLEAR' });
    const result = applyPlay(emptyData(), play, NOW_1);
    const { data } = result as NonNullable<typeof result>;
    const entry = requireEntry(data);

    expect(entry.bestExArrangement).toBe('RANDOM');
    expect(entry.lampArrangement).toBe('RANDOM');
  });
});

describe('openRecordsStore', () => {
  it('returns null and never writes to storage for autoplay plays', () => {
    const storage = createFakeStorage();
    const store = openRecordsStore({ storage, confirmReset: () => true });

    const outcome = store.recordPlay(basePlay({ autoplay: true }), NOW_1);

    expect(outcome).toBeNull();
    expect(storage.getItem('records.v1')).toBeNull();
    expect(store.getRecord(SONG_ID, CHART_ID)).toBeNull();
  });

  it('persists across restarts: a second store opened over the same storage sees the record', () => {
    const storage = createFakeStorage();
    const store1 = openRecordsStore({ storage, confirmReset: () => true });
    store1.recordPlay(basePlay({ lamp: 'CLEAR', exScore: 100 }), NOW_1);

    const store2 = openRecordsStore({ storage, confirmReset: () => true });
    const record = store2.getRecord(SONG_ID, CHART_ID);

    expect(record).not.toBeNull();
    expect(record?.clearLamp).toBe('CLEAR');
    expect(record?.bestExScore).toBe(100);
    expect(store2.all().records[recordKey(SONG_ID, CHART_ID)]).toEqual(record);
  });

  it('on corruption with confirmReset=true: backs up raw bytes and resets the doc to empty', () => {
    const storage = createFakeStorage();
    storage.setItem('records.v1', '{not valid json');

    let confirmMessage = '';
    const store = openRecordsStore({
      storage,
      confirmReset: (message) => {
        confirmMessage = message;
        return true;
      },
    });

    expect(confirmMessage).toContain('corrupt');
    expect(storage.getItem('records.v1.corrupt')).toBe('{not valid json');
    expect(storage.getItem('records.v1')).toBe(
      JSON.stringify({ version: 1, data: { records: {} } }),
    );
    expect(store.all()).toEqual({ records: {} });
  });

  it('on corruption with confirmReset=false: backs up raw bytes, leaves the raw key untouched, and operates empty', () => {
    const storage = createFakeStorage();
    storage.setItem('records.v1', '{not valid json');

    const store = openRecordsStore({ storage, confirmReset: () => false });

    expect(storage.getItem('records.v1.corrupt')).toBe('{not valid json');
    expect(storage.getItem('records.v1')).toBe('{not valid json');
    expect(store.all()).toEqual({ records: {} });
    expect(store.getRecord(SONG_ID, CHART_ID)).toBeNull();

    // The next recordPlay() is allowed to overwrite the corrupt bytes with valid data.
    store.recordPlay(basePlay({ lamp: 'CLEAR' }), NOW_1);
    expect(storage.getItem('records.v1')).not.toBe('{not valid json');
    expect(store.getRecord(SONG_ID, CHART_ID)?.clearLamp).toBe('CLEAR');
  });
});

describe('export/import (results-records.md SHOULD 10)', () => {
  it('exportJson → importJson into a fresh store fully restores records (acceptance criterion)', () => {
    const storage1 = createFakeStorage();
    const store1 = openRecordsStore({ storage: storage1, confirmReset: () => true });
    store1.recordPlay(basePlay({ lamp: 'HARD_CLEAR', exScore: 150, bp: 2 }), NOW_1);
    const exported = store1.exportJson();

    const storage2 = createFakeStorage(); // "reset browser"
    const store2 = openRecordsStore({ storage: storage2, confirmReset: () => true });
    const outcome = store2.importJson(exported);

    expect(outcome).toEqual({ ok: true, added: 1, improved: 0, unchanged: 0 });
    expect(store2.getRecord(SONG_ID, CHART_ID)).toEqual(store1.getRecord(SONG_ID, CHART_ID));
    // And it persisted: a third store over the same storage still sees it.
    const store3 = openRecordsStore({ storage: storage2, confirmReset: () => true });
    expect(store3.getRecord(SONG_ID, CHART_ID)?.clearLamp).toBe('HARD_CLEAR');
  });

  it('re-importing the same file writes nothing (stored bytes stay identical)', () => {
    const storage = createFakeStorage();
    const store = openRecordsStore({ storage, confirmReset: () => true });
    store.recordPlay(basePlay(), NOW_1);
    const exported = store.exportJson();
    store.importJson(exported);
    const bytes = storage.getItem('records.v1');

    const outcome = store.importJson(exported);

    expect(outcome).toEqual({ ok: true, added: 0, improved: 0, unchanged: 1 });
    expect(storage.getItem('records.v1')).toBe(bytes);
  });

  it('merges an import on top of existing local records without downgrading', () => {
    const storage = createFakeStorage();
    const store = openRecordsStore({ storage, confirmReset: () => true });
    store.recordPlay(basePlay({ lamp: 'HARD_CLEAR', exScore: 200 }), NOW_1);

    // A file from "another device": strictly worse results on the shared chart
    // (same timestamp/playCount so ONLY the lamp/bests differ), plus one new song.
    const other = createFakeStorage();
    const otherStore = openRecordsStore({ storage: other, confirmReset: () => true });
    otherStore.recordPlay(basePlay({ lamp: 'FAILED', exScore: 10, finishedSong: false }), NOW_1);
    otherStore.recordPlay(basePlay({ songId: 'song-other', lamp: 'CLEAR', exScore: 90 }), NOW_2);

    const outcome = store.importJson(otherStore.exportJson());

    expect(outcome).toEqual({ ok: true, added: 1, improved: 0, unchanged: 1 });
    expect(store.getRecord(SONG_ID, CHART_ID)?.clearLamp).toBe('HARD_CLEAR');
    expect(store.getRecord(SONG_ID, CHART_ID)?.bestExScore).toBe(200);
    expect(store.getRecord('song-other', CHART_ID)?.clearLamp).toBe('CLEAR');
  });

  it('rejects invalid import text without touching stored records', () => {
    const storage = createFakeStorage();
    const store = openRecordsStore({ storage, confirmReset: () => true });
    store.recordPlay(basePlay(), NOW_1);
    const bytes = storage.getItem('records.v1');

    for (const bad of ['not json {', '{"version":9,"data":{"records":{}}}', '{"version":1}']) {
      const outcome = store.importJson(bad);
      expect(outcome.ok).toBe(false);
    }
    expect(storage.getItem('records.v1')).toBe(bytes);
  });
});
