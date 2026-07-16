import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { STORES, idbPut, openDatabase } from '../../lib/storage/idb';
import type { PracticePattern } from './pattern';
import {
  deletePracticePattern,
  listPracticePatterns,
  loadPracticePattern,
  savePracticePattern,
} from './store';

function makePattern(overrides: Partial<PracticePattern> = {}): PracticePattern {
  return {
    patternId: 'pattern-1',
    name: 'Trill practice',
    bpm: 150,
    bars: 4,
    snap: 16,
    notes: [
      { beat: 0, lane: 1 },
      { beat: 1, lane: 2 },
    ],
    updatedAt: 1000,
    ...overrides,
  };
}

describe('practice pattern store', () => {
  let factory: IDBFactory;

  beforeEach(() => {
    // Fresh factory per test: fake-indexeddb persists databases on the factory instance,
    // so isolation between tests requires a new one rather than the shared global.
    factory = new IDBFactory();
  });

  it('save then load round-trips a pattern, normalizing notes to sorted order', async () => {
    const db = await openDatabase(factory);
    const pattern = makePattern({
      notes: [
        { beat: 2, lane: 3 },
        { beat: 0, lane: 5 },
        { beat: 0, lane: 1 },
      ],
    });

    await savePracticePattern(db, pattern);
    const loaded = await loadPracticePattern(db, pattern.patternId);

    expect(loaded).toEqual({
      ...pattern,
      notes: [
        { beat: 0, lane: 1 },
        { beat: 0, lane: 5 },
        { beat: 2, lane: 3 },
      ],
    });

    db.close();
  });

  it('load of a missing id returns null', async () => {
    const db = await openDatabase(factory);

    expect(await loadPracticePattern(db, 'does-not-exist')).toBeNull();

    db.close();
  });

  it('a corrupt row is dropped by load and omitted from list', async () => {
    const db = await openDatabase(factory);
    const valid = makePattern({ patternId: 'good', updatedAt: 500 });
    await savePracticePattern(db, valid);
    await idbPut(db, STORES.practicePatterns, { patternId: 'bad', junk: true });

    expect(await loadPracticePattern(db, 'bad')).toBeNull();

    const list = await listPracticePatterns(db);
    expect(list.map((pattern) => pattern.patternId)).toEqual(['good']);

    db.close();
  });

  it('list orders by updatedAt DESC, tiebreaking by name ASC', async () => {
    const db = await openDatabase(factory);
    const older = makePattern({ patternId: 'p-older', name: 'Older', updatedAt: 100 });
    const newer = makePattern({ patternId: 'p-newer', name: 'Newer', updatedAt: 300 });
    const tieA = makePattern({ patternId: 'p-tie-a', name: 'Alpha', updatedAt: 200 });
    const tieB = makePattern({ patternId: 'p-tie-b', name: 'Beta', updatedAt: 200 });

    await savePracticePattern(db, older);
    await savePracticePattern(db, newer);
    await savePracticePattern(db, tieB);
    await savePracticePattern(db, tieA);

    const list = await listPracticePatterns(db);

    expect(list.map((pattern) => pattern.patternId)).toEqual([
      'p-newer',
      'p-tie-a',
      'p-tie-b',
      'p-older',
    ]);

    db.close();
  });

  it('delete removes exactly the targeted pattern, and deleting a missing id is a no-op', async () => {
    const db = await openDatabase(factory);
    const keep = makePattern({ patternId: 'keep' });
    const remove = makePattern({ patternId: 'remove' });
    await savePracticePattern(db, keep);
    await savePracticePattern(db, remove);

    await deletePracticePattern(db, 'remove');

    expect(await loadPracticePattern(db, 'remove')).toBeNull();
    expect(await loadPracticePattern(db, 'keep')).not.toBeNull();

    await expect(deletePracticePattern(db, 'does-not-exist')).resolves.toBeUndefined();

    db.close();
  });

  it('overwriting a pattern with the same patternId replaces it rather than duplicating', async () => {
    const db = await openDatabase(factory);
    const original = makePattern({ patternId: 'p-1', name: 'Original', updatedAt: 100 });
    await savePracticePattern(db, original);

    const updated = makePattern({ patternId: 'p-1', name: 'Renamed', updatedAt: 200 });
    await savePracticePattern(db, updated);

    const list = await listPracticePatterns(db);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Renamed');

    const loaded = await loadPracticePattern(db, 'p-1');
    expect(loaded?.name).toBe('Renamed');

    db.close();
  });
});
