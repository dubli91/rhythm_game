import { describe, expect, it } from 'vitest';
import { CHART_FORMAT_VERSION } from '../../lib/chart/types';
import type { Chart } from '../../lib/chart/types';
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

describe('library', () => {
  // song-library.md MUST 1-3: built-in metadata loads at startup and maps
  // 1:1 into LibraryEntry, with each entry's charts sorted BEGINNER..ANOTHER
  // then by level ascending (catalog fixture intentionally lists ANOTHER first).
  it('loadLibrary maps built-in catalog entries and sorts charts by difficulty then level', async () => {
    const songA = makeCatalogEntry({ songId: 'song-a' });
    const files = new Map<string, unknown>([['songs/index.json', { songs: [songA] }]]);

    const library = await loadLibrary({ fetchFn: makeFetch(files) });

    expect(library.entries).toHaveLength(1);
    const entry = library.entries[0];
    expect(entry).toMatchObject({
      songId: 'song-a',
      title: 'Title song-a',
      artist: 'Builtin Artist',
      genre: 'Pop',
      bpm: { min: 140, max: 160 },
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

  // practice-song-content.md MUST 11: a keysound entry (no BGM) resolves to the
  // keysound audio source instead of a BGM url.
  it('loadPlayableSong returns keysound audio for a keysound catalog entry', async () => {
    const chart = makeChart({ chartId: 'song-k-another', difficulty: 'ANOTHER', level: 12 });
    const { audio: _droppedAudio, ...songK } = makeCatalogEntry({
      songId: 'song-k',
      charts: [
        {
          chartId: 'song-k-another',
          difficulty: 'ANOTHER',
          level: 12,
          noteCount: 1,
          chartPath: 'songs/song-k/another.json',
        },
      ],
    });
    songK.keysound = 'songs/song-k/keysound.ogg';
    const files = new Map<string, unknown>([
      ['songs/index.json', { songs: [songK] }],
      ['songs/song-k/another.json', chart],
    ]);

    const library = await loadLibrary({ fetchFn: makeFetch(files) });
    const entry = library.entries[0];
    if (!entry) throw new Error('expected one library entry');

    const playable = await loadPlayableSong(entry, { fetchFn: makeFetch(files) });

    expect(playable.audio).toEqual({ kind: 'keysound', url: 'songs/song-k/keysound.ogg' });
  });
});
