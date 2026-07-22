import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  openDatabase,
} from './idb';

// Minimal pattern-shaped rows: the store's keyPath is 'patternId' (practice-mode.md);
// the real document shape is owned/validated by src/features/practice/store.ts.
function makePattern(patternId: string): Record<string, unknown> {
  return { patternId, name: `Pattern ${patternId}`, bpm: 150, bars: 2, snap: 16, notes: [] };
}

describe('idb', () => {
  let factory: IDBFactory;

  beforeEach(() => {
    // Fresh factory per test: fake-indexeddb persists databases on the factory instance,
    // so isolation between tests requires a new one rather than the shared global.
    factory = new IDBFactory();
  });

  it('openDatabase creates the practicePatterns store', async () => {
    const db = await openDatabase(factory);

    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    expect(Array.from(db.objectStoreNames)).toEqual([STORES.practicePatterns]);

    db.close();
  });

  it('opening the same factory a second time succeeds with no upgrade needed', async () => {
    const first = await openDatabase(factory);
    first.close();

    const second = await openDatabase(factory);
    expect(Array.from(second.objectStoreNames)).toEqual([STORES.practicePatterns]);

    second.close();
  });

  it('idbPut round-trips a row keyed by its keyPath and idbPut again overwrites it', async () => {
    const db = await openDatabase(factory);
    const pattern = makePattern('pat-1');

    await idbPut(db, STORES.practicePatterns, pattern);
    expect(await idbGet(db, STORES.practicePatterns, 'pat-1')).toEqual(pattern);

    const renamed = { ...pattern, name: 'Renamed' };
    await idbPut(db, STORES.practicePatterns, renamed);
    expect(await idbGet(db, STORES.practicePatterns, 'pat-1')).toEqual(renamed);

    db.close();
  });

  it('idbGetAll returns every stored row', async () => {
    const db = await openDatabase(factory);
    await idbPut(db, STORES.practicePatterns, makePattern('pat-a'));
    await idbPut(db, STORES.practicePatterns, makePattern('pat-b'));

    const all = await idbGetAll<{ patternId: string }>(db, STORES.practicePatterns);
    expect(all.map((row) => row.patternId).sort()).toEqual(['pat-a', 'pat-b']);

    db.close();
  });

  it('idbGet resolves undefined for a missing key', async () => {
    const db = await openDatabase(factory);

    expect(await idbGet(db, STORES.practicePatterns, 'does-not-exist')).toBeUndefined();

    db.close();
  });

  it('idbDelete removes a stored row', async () => {
    const db = await openDatabase(factory);
    await idbPut(db, STORES.practicePatterns, makePattern('pat-gone'));

    await idbDelete(db, STORES.practicePatterns, 'pat-gone');
    expect(await idbGet(db, STORES.practicePatterns, 'pat-gone')).toBeUndefined();

    db.close();
  });
});
