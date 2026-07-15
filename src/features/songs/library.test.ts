import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { CHART_FORMAT_VERSION } from '../../lib/chart/types';
import type { Chart, Song } from '../../lib/chart/types';
import { openDatabase, putSongAtomic } from '../../lib/storage/idb';
import type { CatalogSongEntry } from './catalog';
import type { FetchJsonLike } from './catalog';
import { loadLibrary, loadPlayableSong } from './library';

// --- fake fetch, modeled on catalog.ts's FetchJsonLike (specs/song-library.md
// MUST 1-2: only songs/index.json is fetched eagerly; chart JSON is lazy). -------

function makeFetch(files: Map<string, unknown>): FetchJsonLike {
  return async (url: string) => {
    if (!files.has(url)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => files.get(url) };
  };
}

// --- minimal valid fixtures, satisfying every validate.ts constraint -----------

function makeChart(
  overrides: Partial<Chart> & Pick<Chart, 'chartId' | 'difficulty' | 'level'>,
): Chart {
  return {
    formatVersion: CHART_FORMAT_VERSION,
    total: 200,
    bpm: { init: 150, min: 150, max: 150 },
    timing: { bpmEvents: [{ beat: 0, bpm: 150 }], stopEvents: [] },
    notes: [{ beat: 0, lane: 1, type: 'tap' }],
    ...overrides,
  };
}

function makeCatalogEntry(
  overrides: Partial<CatalogSongEntry> & { songId: string },
): CatalogSongEntry {
  return {
    title: `Title ${overrides.songId}`,
    artist: 'Builtin Artist',
    genre: 'Pop',
    bpm: { min: 140, max: 160 },
    charts: [
      {
        chartId: `${overrides.songId}-another`,
        difficulty: 'ANOTHER',
        level: 8,
        noteCount: 1,
        chartPath: `songs/${overrides.songId}/another.json`,
      },
      {
        chartId: `${overrides.songId}-beginner`,
        difficulty: 'BEGINNER',
        level: 2,
        noteCount: 1,
        chartPath: `songs/${overrides.songId}/beginner.json`,
      },
    ],
    audio: `songs/${overrides.songId}/audio.ogg`,
    offsetMs: 0,
    license: 'CC0',
    ...overrides,
  };
}

function makeImportedSong(songId: string): Song {
  return {
    songId,
    title: `Imported ${songId}`,
    artist: 'Imported Artist',
    genre: 'Rock',
    audio: { source: 'imported', ref: songId, offsetMs: 0 },
    charts: [
      makeChart({
        chartId: `${songId}-hyper`,
        difficulty: 'HYPER',
        level: 6,
        bpm: { init: 180, min: 170, max: 190 },
      }),
      makeChart({
        chartId: `${songId}-normal`,
        difficulty: 'NORMAL',
        level: 4,
        bpm: { init: 100, min: 90, max: 110 },
      }),
    ],
  };
}

function makeAudioBlob(content = 'RIFF....WAVEfmt '): Blob {
  return new Blob([content], { type: 'audio/wav' });
}

describe('library', () => {
  let factory: IDBFactory;

  beforeEach(() => {
    // Fresh factory per test: fake-indexeddb persists databases per-instance, so a
    // shared factory would leak state across tests (matches idb.test.ts pattern).
    factory = new IDBFactory();
  });

  // song-library.md MUST 1-3, 6: built-in metadata loads at startup and maps
  // 1:1 into LibraryEntry, with each entry's charts sorted BEGINNER..ANOTHER
  // then by level ascending (catalog fixture intentionally lists ANOTHER first).
  it('loadLibrary maps built-in catalog entries and sorts charts by difficulty then level', async () => {
    const songA = makeCatalogEntry({ songId: 'song-a' });
    const files = new Map<string, unknown>([['songs/index.json', { songs: [songA] }]]);

    const library = await loadLibrary({ fetchFn: makeFetch(files) });

    expect(library.warnings).toEqual([]);
    expect(library.entries).toHaveLength(1);
    const entry = library.entries[0];
    expect(entry).toMatchObject({
      songId: 'song-a',
      title: 'Title song-a',
      artist: 'Builtin Artist',
      genre: 'Pop',
      bpm: { min: 140, max: 160 },
      source: 'builtin',
    });
    // parseCatalog() reconstructs a fresh object from the raw JSON, so compare
    // by value rather than identity.
    expect(entry?.catalogEntry).toEqual(songA);
    expect(entry?.charts.map((c) => c.difficulty)).toEqual(['BEGINNER', 'ANOTHER']);
  });

  // song-library.md MUST 2: "내장 곡은 네트워크 지연이 있어도 곡 선택 목록 표시를
  // 막지 않는다" implies the catalog fetch is load-bearing; if it fails outright
  // the app cannot start, so loadLibrary must rethrow rather than swallow it.
  it('loadLibrary rethrows when the built-in catalog fetch fails', async () => {
    const files = new Map<string, unknown>(); // songs/index.json intentionally absent -> 404

    await expect(loadLibrary({ fetchFn: makeFetch(files) })).rejects.toThrow(
      /Failed to load built-in song catalog/,
    );
  });

  // song-library.md MUST 6: imported songs (from IndexedDB) merge with built-ins
  // into one catalog; imported entries derive bpm range/noteCount from their charts.
  it('loadLibrary merges built-in and imported songs, deriving bpm/noteCount for imported entries', async () => {
    const songA = makeCatalogEntry({ songId: 'song-a' });
    const files = new Map<string, unknown>([['songs/index.json', { songs: [songA] }]]);

    const db = await openDatabase(factory);
    const imported = makeImportedSong('song-imported-1');
    await putSongAtomic(db, imported, makeAudioBlob());

    const library = await loadLibrary({ fetchFn: makeFetch(files), db });

    expect(library.warnings).toEqual([]);
    expect(library.entries).toHaveLength(2);

    const importedEntry = library.entries.find((e) => e.songId === 'song-imported-1');
    expect(importedEntry).toMatchObject({
      title: 'Imported song-imported-1',
      source: 'imported',
      bpm: { min: 90, max: 190 }, // min across hyper.min(170)/normal.min(90), max across hyper.max(190)/normal.max(110)
    });
    expect(importedEntry?.catalogEntry).toBeUndefined();
    expect(importedEntry?.charts.map((c) => c.difficulty)).toEqual(['NORMAL', 'HYPER']);
    expect(importedEntry?.charts.every((c) => c.noteCount === 1)).toBe(true);

    db.close();
  });

  // song-library.md MUST 6: deterministic songIds mean a collision is a
  // re-import of the same title+artist; the built-in wins and a warning surfaces
  // (not a silent overwrite, not a crash).
  it('loadLibrary keeps the built-in entry and warns on a songId collision with an imported song', async () => {
    const songA = makeCatalogEntry({ songId: 'song-a' });
    const files = new Map<string, unknown>([['songs/index.json', { songs: [songA] }]]);

    const db = await openDatabase(factory);
    const collidingImport = { ...makeImportedSong('song-a'), title: 'Imported Duplicate' };
    await putSongAtomic(db, collidingImport, makeAudioBlob());

    const library = await loadLibrary({ fetchFn: makeFetch(files), db });

    expect(library.entries).toHaveLength(1);
    expect(library.entries[0]).toMatchObject({ songId: 'song-a', source: 'builtin' });
    expect(library.warnings).toHaveLength(1);
    expect(library.warnings[0]).toMatch(/collides with a built-in song/);

    db.close();
  });

  // song-library.md MUST 6 + song-select "must not crash": a broken IndexedDB
  // connection degrades to built-ins-only with a warning instead of throwing.
  it('loadLibrary falls back to built-ins only and warns when IndexedDB access fails', async () => {
    const songA = makeCatalogEntry({ songId: 'song-a' });
    const files = new Map<string, unknown>([['songs/index.json', { songs: [songA] }]]);

    const db = await openDatabase(factory);
    db.close(); // any transaction() call on a closed connection throws synchronously

    const library = await loadLibrary({ fetchFn: makeFetch(files), db });

    expect(library.entries).toHaveLength(1);
    expect(library.entries[0]?.source).toBe('builtin');
    expect(library.warnings).toHaveLength(1);
    expect(library.warnings[0]).toMatch(/imported songs unavailable/);
  });

  // song-library.md MUST 2: chart/audio for a builtin song are lazy-loaded only
  // once a song is decided for play.
  it('loadPlayableSong for a builtin entry fetches+validates charts and returns url audio', async () => {
    const chartAnother = makeChart({ chartId: 'song-a-another', difficulty: 'ANOTHER', level: 8 });
    const chartBeginner = makeChart({
      chartId: 'song-a-beginner',
      difficulty: 'BEGINNER',
      level: 2,
    });
    const songA = makeCatalogEntry({ songId: 'song-a' });
    const files = new Map<string, unknown>([
      ['songs/index.json', { songs: [songA] }],
      ['songs/song-a/another.json', chartAnother],
      ['songs/song-a/beginner.json', chartBeginner],
    ]);

    const library = await loadLibrary({ fetchFn: makeFetch(files) });
    const entry = library.entries[0];
    if (!entry) throw new Error('expected one library entry');

    const playable = await loadPlayableSong(entry, { fetchFn: makeFetch(files) });

    expect(playable.audio).toEqual({ kind: 'url', url: 'songs/song-a/audio.ogg' });
    expect(playable.song.songId).toBe('song-a');
    expect(playable.song.charts).toHaveLength(2);
    expect(playable.song.charts.map((c) => c.chartId).sort()).toEqual([
      'song-a-another',
      'song-a-beginner',
    ]);
  });

  // song-library.md MUST 4: imported songs' mixdown audio is a Blob in IndexedDB,
  // not a URL, and playing one must not touch the network.
  it('loadPlayableSong for an imported entry returns the stored blob audio and re-validated song', async () => {
    const db = await openDatabase(factory);
    const imported = makeImportedSong('song-imported-1');
    const blob = makeAudioBlob('mixdown-bytes');
    await putSongAtomic(db, imported, blob);

    const library = await loadLibrary({
      fetchFn: makeFetch(new Map([['songs/index.json', { songs: [] }]])),
      db,
    });
    const entry = library.entries[0];
    if (!entry) throw new Error('expected one library entry');

    const playable = await loadPlayableSong(entry, { db });

    expect(playable.audio.kind).toBe('blob');
    if (playable.audio.kind === 'blob') {
      expect(await playable.audio.blob.text()).toBe('mixdown-bytes');
    }
    expect(playable.song.songId).toBe('song-imported-1');
    expect(playable.song.charts).toHaveLength(2);

    db.close();
  });

  // song-library.md acceptance: audio blob deletion (e.g. partial cleanup, quota
  // eviction) must surface a clear, user-actionable error rather than crash.
  it('loadPlayableSong throws a clear error when an imported song is missing its audio blob', async () => {
    const db = await openDatabase(factory);
    const imported = makeImportedSong('song-imported-1');
    await putSongAtomic(db, imported, null); // metadata present, audio blob absent

    const library = await loadLibrary({
      fetchFn: makeFetch(new Map([['songs/index.json', { songs: [] }]])),
      db,
    });
    const entry = library.entries[0];
    if (!entry) throw new Error('expected one library entry');

    await expect(loadPlayableSong(entry, { db })).rejects.toThrow(
      /audio for "Imported song-imported-1" is missing from storage/,
    );
  });

  // chart-format.md: imported data could be stale/corrupt, so loadPlayableSong
  // re-validates every chart rather than trusting whatever round-tripped from IDB.
  it('loadPlayableSong throws a validation error naming the song when a stored chart is invalid', async () => {
    const db = await openDatabase(factory);
    const imported = makeImportedSong('song-imported-1');
    // Corrupt one chart after building a structurally valid Song (level out of range).
    const corrupted: Song = {
      ...imported,
      charts: [{ ...imported.charts[0], level: 99 } as Chart, imported.charts[1] as Chart],
    };
    await putSongAtomic(db, corrupted, makeAudioBlob());

    const library = await loadLibrary({
      fetchFn: makeFetch(new Map([['songs/index.json', { songs: [] }]])),
      db,
    });
    const entry = library.entries[0];
    if (!entry) throw new Error('expected one library entry');

    await expect(loadPlayableSong(entry, { db })).rejects.toThrow(
      /imported song "Imported song-imported-1" has an invalid stored chart/,
    );
  });

  // Guards the "no db" branch: an imported entry can only be played with a live
  // IndexedDB connection; missing deps.db must fail clearly, not throw a raw TypeError.
  it('loadPlayableSong throws when an imported entry is played without a db connection', async () => {
    const db = await openDatabase(factory);
    const imported = makeImportedSong('song-imported-1');
    await putSongAtomic(db, imported, makeAudioBlob());
    const library = await loadLibrary({
      fetchFn: makeFetch(new Map([['songs/index.json', { songs: [] }]])),
      db,
    });
    const entry = library.entries[0];
    if (!entry) throw new Error('expected one library entry');
    db.close();

    await expect(loadPlayableSong(entry, {})).rejects.toThrow(/no database connection available/);
  });
});
