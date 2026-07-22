// Song library (specs/song-library.md MUST 2, 6): maps the built-in catalog into
// the flat entry list song-select consumes. Only metadata is loaded eagerly here;
// chart JSON and audio stay lazy until a song is actually chosen for play
// (loadPlayableSong, MUST 2).

import type { Difficulty, Song } from '../../lib/chart/types';
import { DIFFICULTIES } from '../../lib/chart/types';
import type { CatalogSongEntry, FetchJsonLike } from './catalog';
import { loadBuiltinCatalog, loadBuiltinSong } from './catalog';

export interface LibraryChartRef {
  chartId: string;
  difficulty: Difficulty;
  level: number;
  noteCount: number;
}

export interface LibraryEntry {
  songId: string;
  title: string;
  artist: string;
  genre: string;
  bpm: { min: number; max: number };
  charts: LibraryChartRef[];
  /** carries chartPath/audio refs for lazy loading (and preview metadata for select) */
  catalogEntry: CatalogSongEntry;
}

export interface SongLibrary {
  entries: LibraryEntry[];
}

export interface LibraryDeps {
  fetchFn?: FetchJsonLike;
}

export type AudioSource =
  | { kind: 'url'; url: string }
  /** no-BGM practice song: url points at the keysound sample, not a music track */
  | { kind: 'keysound'; url: string };

export interface PlayableSong {
  song: Song;
  audio: AudioSource;
}

// BEGINNER < NORMAL < HYPER < ANOTHER, matching chart/types.ts DIFFICULTIES order.
const DIFFICULTY_ORDER = new Map<Difficulty, number>(DIFFICULTIES.map((d, i) => [d, i]));

function sortChartRefs(charts: LibraryChartRef[]): LibraryChartRef[] {
  return [...charts].sort((a, b) => {
    const orderDiff =
      (DIFFICULTY_ORDER.get(a.difficulty) ?? 0) - (DIFFICULTY_ORDER.get(b.difficulty) ?? 0);
    if (orderDiff !== 0) {
      return orderDiff;
    }
    return a.level - b.level;
  });
}

function toBuiltinEntry(catalogEntry: CatalogSongEntry): LibraryEntry {
  return {
    songId: catalogEntry.songId,
    title: catalogEntry.title,
    artist: catalogEntry.artist,
    genre: catalogEntry.genre,
    bpm: { min: catalogEntry.bpm.min, max: catalogEntry.bpm.max },
    charts: sortChartRefs(
      catalogEntry.charts.map((chartEntry) => ({
        chartId: chartEntry.chartId,
        difficulty: chartEntry.difficulty,
        level: chartEntry.level,
        noteCount: chartEntry.noteCount,
      })),
    ),
    catalogEntry,
  };
}

/** Loads built-in index.json metadata into library entries. */
export async function loadLibrary(deps: LibraryDeps = {}): Promise<SongLibrary> {
  // Catalog fetch failure is fatal: the app has no songs at all without it,
  // matching the current app-shell behavior (song-library.md MUST 1-2).
  const catalog = await loadBuiltinCatalog(deps.fetchFn);
  return { entries: catalog.songs.map(toBuiltinEntry) };
}

/** Lazy-loads the full chart data + audio reference for one library entry (called on song decision). */
export async function loadPlayableSong(
  entry: LibraryEntry,
  deps: LibraryDeps = {},
): Promise<PlayableSong> {
  const song = await loadBuiltinSong(entry.catalogEntry, deps.fetchFn);
  const { audio, keysound } = entry.catalogEntry;
  if (keysound !== undefined) {
    return { song, audio: { kind: 'keysound', url: keysound } };
  }
  if (audio === undefined) {
    // parseSongEntry guarantees one of the two; reaching here is a programming error.
    throw new Error(`builtin library entry "${entry.songId}" has neither audio nor keysound`);
  }
  return { song, audio: { kind: 'url', url: audio } };
}
