// Unified song library (specs/song-library.md MUST 2, 6): merges the built-in
// catalog with imported songs read from IndexedDB into one flat list for
// song-select. Only metadata is loaded eagerly here; chart JSON and audio stay
// lazy until a song is actually chosen for play (loadPlayableSong, MUST 2).

import type { Chart, Difficulty, Song } from '../../lib/chart/types';
import { DIFFICULTIES, noteCount } from '../../lib/chart/types';
import { ChartValidationError, loadChart } from '../../lib/chart/validate';
import { STORES, idbGet, idbGetAll } from '../../lib/storage/idb';
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
  source: 'builtin' | 'imported';
  charts: LibraryChartRef[];
  /** present when source === 'builtin'; carries chartPath/audio refs for lazy loading */
  catalogEntry?: CatalogSongEntry;
}

export interface SongLibrary {
  entries: LibraryEntry[];
  /** non-fatal problems collected while building the catalog (shown to the user, do not throw) */
  warnings: string[];
}

export interface LibraryDeps {
  fetchFn?: FetchJsonLike;
  db?: IDBDatabase | null;
}

export type AudioSource = { kind: 'url'; url: string } | { kind: 'blob'; blob: Blob };

export interface PlayableSong {
  song: Song;
  audio: AudioSource;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    source: 'builtin',
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

function toImportedEntry(song: Song): LibraryEntry {
  // bpm range is not stored on Song directly (unlike the built-in catalog); derive
  // it across every chart's own bpm.min/max so imported entries show a comparable range.
  const bpmMins = song.charts.map((chart) => chart.bpm.min);
  const bpmMaxes = song.charts.map((chart) => chart.bpm.max);
  return {
    songId: song.songId,
    title: song.title,
    artist: song.artist,
    genre: song.genre,
    bpm: { min: Math.min(...bpmMins), max: Math.max(...bpmMaxes) },
    source: 'imported',
    charts: sortChartRefs(
      song.charts.map((chart) => ({
        chartId: chart.chartId,
        difficulty: chart.difficulty,
        level: chart.level,
        noteCount: noteCount(chart),
      })),
    ),
  };
}

/** Loads built-in index.json + imported songs metadata from IndexedDB, merged. */
export async function loadLibrary(deps: LibraryDeps = {}): Promise<SongLibrary> {
  const warnings: string[] = [];

  // Built-in catalog fetch failure is fatal: the app has no songs at all without
  // it, matching the current app-shell behavior (song-library.md MUST 1-2).
  const catalog = await loadBuiltinCatalog(deps.fetchFn);

  const entries = new Map<string, LibraryEntry>();
  for (const catalogEntry of catalog.songs) {
    entries.set(catalogEntry.songId, toBuiltinEntry(catalogEntry));
  }

  if (deps.db) {
    try {
      const importedSongs = await idbGetAll<Song>(deps.db, STORES.songs);
      for (const song of importedSongs) {
        if (entries.has(song.songId)) {
          // Deterministic songIds mean a collision is a re-import of the same
          // title+artist; the built-in asset is canonical (song-library.md MUST 6).
          warnings.push(
            `imported song "${song.title}" (${song.songId}) collides with a built-in song; keeping the built-in version`,
          );
          continue;
        }
        entries.set(song.songId, toImportedEntry(song));
      }
    } catch (error) {
      // IndexedDB unavailable/broken must not crash the library, only degrade to
      // built-ins-only (song-library.md MUST 6; song-select "must not crash").
      warnings.push(`imported songs unavailable: ${errorMessage(error)}`);
    }
  }

  return { entries: [...entries.values()], warnings };
}

/** Lazy-loads the full chart data + audio reference for one library entry (called on song decision). */
export async function loadPlayableSong(
  entry: LibraryEntry,
  deps: LibraryDeps = {},
): Promise<PlayableSong> {
  if (entry.source === 'builtin') {
    if (!entry.catalogEntry) {
      throw new Error(
        `builtin library entry "${entry.songId}" has no catalogEntry (programming error)`,
      );
    }
    const song = await loadBuiltinSong(entry.catalogEntry, deps.fetchFn);
    return { song, audio: { kind: 'url', url: entry.catalogEntry.audio } };
  }

  if (!deps.db) {
    throw new Error(`cannot load imported song "${entry.title}": no database connection available`);
  }
  const db = deps.db;

  const stored = await idbGet<Song>(db, STORES.songs, entry.songId);
  if (!stored) {
    throw new Error(`imported song "${entry.title}" is missing from storage`);
  }

  let charts: Chart[];
  try {
    // Re-validate on the load path: imported data in IndexedDB could be stale or
    // corrupt (chart-format.md), so don't trust it just because it round-tripped.
    charts = stored.charts.map((chart) => loadChart(chart));
  } catch (error) {
    if (error instanceof ChartValidationError) {
      throw new Error(
        `imported song "${entry.title}" has an invalid stored chart: ${error.message}`,
      );
    }
    throw error;
  }

  const audioBlob = await idbGet<Blob>(db, STORES.audio, entry.songId);
  if (!audioBlob) {
    throw new Error(
      `audio for "${entry.title}" is missing from storage (it may have been deleted) — re-import the song`,
    );
  }

  const song: Song = { ...stored, charts };
  return { song, audio: { kind: 'blob', blob: audioBlob } };
}
