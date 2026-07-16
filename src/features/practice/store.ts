// Local persistence for named practice patterns (practice-mode.md MUST 11): save a pattern
// under a name, list saved patterns, load one back, delete one. Patterns live in the
// `practicePatterns` IndexedDB store (keyPath 'patternId'), created by openDatabase in
// ../../lib/storage/idb.ts. Quota/write failures already surface as StorageQuotaError from
// the generic helpers below — this module just lets them propagate.

import { STORES, idbDelete, idbGet, idbGetAll, idbPut } from '../../lib/storage/idb';
import { type PracticePattern, isPracticePattern, sortNotes } from './pattern';

export async function savePracticePattern(
  db: IDBDatabase,
  pattern: PracticePattern,
): Promise<void> {
  await idbPut(db, STORES.practicePatterns, pattern);
}

export async function loadPracticePattern(
  db: IDBDatabase,
  patternId: string,
): Promise<PracticePattern | null> {
  const raw = await idbGet<unknown>(db, STORES.practicePatterns, patternId);
  if (!isPracticePattern(raw)) return null;
  return { ...raw, notes: sortNotes(raw.notes) };
}

export async function listPracticePatterns(db: IDBDatabase): Promise<PracticePattern[]> {
  const all = await idbGetAll<unknown>(db, STORES.practicePatterns);
  return all
    .filter(isPracticePattern)
    .map((pattern) => ({ ...pattern, notes: sortNotes(pattern.notes) }))
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.patternId < b.patternId ? -1 : a.patternId > b.patternId ? 1 : 0;
    });
}

export async function deletePracticePattern(db: IDBDatabase, patternId: string): Promise<void> {
  await idbDelete(db, STORES.practicePatterns, patternId);
}
