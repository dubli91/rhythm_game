// Built-in song catalog loader (specs/builtin-song-content.md MUST 6-8, 13;
// specs/song-library.md MUST 1-3). App startup fetches ONLY songs/index.json;
// chart JSON and audio are fetched lazily, once a song is chosen for play.

import type { Chart, Difficulty, Song } from '../../lib/chart/types';
import { loadChart } from '../../lib/chart/validate';

export interface CatalogChartEntry {
  chartId: string;
  difficulty: Difficulty;
  level: number;
  noteCount: number;
  chartPath: string;
}

export interface CatalogSongEntry {
  songId: string;
  title: string;
  artist: string;
  genre: string;
  bpm: { min: number; max: number };
  charts: CatalogChartEntry[];
  /** BGM track URL. Exactly one of audio/keysound is present (parseSongEntry enforces it). */
  audio?: string;
  /**
   * Keysound-sample URL for the no-BGM practice song (practice-song-content.md
   * MUST 11): replaces audio AND preview — the entry is silent on song select
   * by construction and plays only the keysound during play.
   */
  keysound?: string;
  offsetMs: number;
  preview?: { startMs: number; durationMs: number };
  license: string;
}

export interface SongCatalog {
  songs: CatalogSongEntry[];
}

export type FetchJsonLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// --- minimal shape validation --------------------------------------------------
// Deliberately not the full chart-format validator: this only checks that the
// catalog document has the fields loadBuiltinCatalog()/loadBuiltinSong() rely
// on. Chart JSON itself is validated via loadChart() at fetch time.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const DIFFICULTIES: readonly Difficulty[] = ['BEGINNER', 'NORMAL', 'HYPER', 'ANOTHER'];

function parseChartEntry(raw: unknown, path: string): CatalogChartEntry {
  if (!isRecord(raw)) {
    throw new Error(`Invalid song catalog: ${path} must be an object`);
  }
  if (!isNonEmptyString(raw.chartId)) {
    throw new Error(`Invalid song catalog: ${path}.chartId must be a non-empty string`);
  }
  const difficulty = raw.difficulty;
  if (typeof difficulty !== 'string' || !DIFFICULTIES.includes(difficulty as Difficulty)) {
    throw new Error(
      `Invalid song catalog: ${path}.difficulty must be one of ${DIFFICULTIES.join(', ')}`,
    );
  }
  if (!isFiniteNumber(raw.level)) {
    throw new Error(`Invalid song catalog: ${path}.level must be a finite number`);
  }
  if (!isFiniteNumber(raw.noteCount)) {
    throw new Error(`Invalid song catalog: ${path}.noteCount must be a finite number`);
  }
  if (!isNonEmptyString(raw.chartPath)) {
    throw new Error(`Invalid song catalog: ${path}.chartPath must be a non-empty string`);
  }
  return {
    chartId: raw.chartId,
    difficulty: difficulty as Difficulty,
    level: raw.level,
    noteCount: raw.noteCount,
    chartPath: raw.chartPath,
  };
}

function parseBpmRange(raw: unknown, path: string): { min: number; max: number } {
  if (!isRecord(raw) || !isFiniteNumber(raw.min) || !isFiniteNumber(raw.max)) {
    throw new Error(`Invalid song catalog: ${path} must be an object with numeric min/max`);
  }
  return { min: raw.min, max: raw.max };
}

function parsePreview(
  raw: unknown,
  path: string,
): { startMs: number; durationMs: number } | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw) || !isFiniteNumber(raw.startMs) || !isFiniteNumber(raw.durationMs)) {
    throw new Error(
      `Invalid song catalog: ${path} must be an object with numeric startMs/durationMs`,
    );
  }
  return { startMs: raw.startMs, durationMs: raw.durationMs };
}

function parseSongEntry(raw: unknown, path: string): CatalogSongEntry {
  if (!isRecord(raw)) {
    throw new Error(`Invalid song catalog: ${path} must be an object`);
  }
  if (!isNonEmptyString(raw.songId)) {
    throw new Error(`Invalid song catalog: ${path}.songId must be a non-empty string`);
  }
  if (!isNonEmptyString(raw.title)) {
    throw new Error(`Invalid song catalog: ${path}.title must be a non-empty string`);
  }
  if (!isNonEmptyString(raw.artist)) {
    throw new Error(`Invalid song catalog: ${path}.artist must be a non-empty string`);
  }
  if (typeof raw.genre !== 'string') {
    throw new Error(`Invalid song catalog: ${path}.genre must be a string`);
  }
  const bpm = parseBpmRange(raw.bpm, `${path}.bpm`);
  const chartsRaw = raw.charts;
  if (!Array.isArray(chartsRaw) || chartsRaw.length === 0) {
    throw new Error(`Invalid song catalog: ${path}.charts must be a non-empty array`);
  }
  const charts = chartsRaw.map((entry, i) => parseChartEntry(entry, `${path}.charts[${i}]`));
  // Exactly one of audio/keysound (practice-song-content.md MUST 11): a BGM song
  // carries audio (+ optional preview); the keysound practice song carries only
  // the keysound path and MUST NOT carry preview (no select-screen preview — silent).
  if (raw.keysound !== undefined) {
    if (!isNonEmptyString(raw.keysound)) {
      throw new Error(`Invalid song catalog: ${path}.keysound must be a non-empty string`);
    }
    if (raw.audio !== undefined) {
      throw new Error(`Invalid song catalog: ${path} must not have both audio and keysound`);
    }
    if (raw.preview !== undefined) {
      throw new Error(`Invalid song catalog: ${path}.preview is not allowed on a keysound entry`);
    }
  } else if (!isNonEmptyString(raw.audio)) {
    throw new Error(`Invalid song catalog: ${path}.audio must be a non-empty string`);
  }
  if (!isFiniteNumber(raw.offsetMs)) {
    throw new Error(`Invalid song catalog: ${path}.offsetMs must be a finite number`);
  }
  const preview = parsePreview(raw.preview, `${path}.preview`);
  if (!isNonEmptyString(raw.license)) {
    throw new Error(`Invalid song catalog: ${path}.license must be a non-empty string`);
  }
  return {
    songId: raw.songId,
    title: raw.title,
    artist: raw.artist,
    genre: raw.genre,
    bpm,
    charts,
    audio: typeof raw.audio === 'string' ? raw.audio : undefined,
    keysound: typeof raw.keysound === 'string' ? raw.keysound : undefined,
    offsetMs: raw.offsetMs,
    preview,
    license: raw.license,
  };
}

/** Validates the minimal SongCatalog shape; throws a descriptive Error on malformed data. */
export function parseCatalog(raw: unknown): SongCatalog {
  if (!isRecord(raw)) {
    throw new Error('Invalid song catalog: document must be an object');
  }
  const songsRaw = raw.songs;
  if (!Array.isArray(songsRaw)) {
    throw new Error('Invalid song catalog: songs must be an array');
  }
  const songs = songsRaw.map((entry, i) => parseSongEntry(entry, `songs[${i}]`));
  return { songs };
}

// --- loaders --------------------------------------------------------------------

function defaultFetch(): FetchJsonLike {
  return globalThis.fetch.bind(globalThis) as unknown as FetchJsonLike;
}

/** Loads and validates songs/index.json. This is the ONLY built-in request made at app startup. */
export async function loadBuiltinCatalog(
  fetchFn: FetchJsonLike = defaultFetch(),
): Promise<SongCatalog> {
  const response = await fetchFn('songs/index.json');
  if (!response.ok) {
    throw new Error(`Failed to load built-in song catalog: HTTP ${response.status}`);
  }
  const raw = await response.json();
  return parseCatalog(raw);
}

/** Fetches every chart for a catalog entry, validates each via loadChart(), and assembles a Song. */
export async function loadBuiltinSong(
  entry: CatalogSongEntry,
  fetchFn: FetchJsonLike = defaultFetch(),
): Promise<Song> {
  const charts: Chart[] = [];
  for (const chartEntry of entry.charts) {
    const response = await fetchFn(chartEntry.chartPath);
    if (!response.ok) {
      throw new Error(
        `Failed to load chart "${chartEntry.chartId}" from ${chartEntry.chartPath}: HTTP ${response.status}`,
      );
    }
    const raw = await response.json();
    charts.push(loadChart(raw));
  }
  // Song.audio.ref is whichever audio asset the song plays from — the BGM track,
  // or the keysound sample for the no-BGM practice song (parseSongEntry
  // guarantees exactly one of the two is present).
  const audioRef = entry.audio ?? entry.keysound;
  if (audioRef === undefined) {
    throw new Error(`catalog entry "${entry.songId}" has neither audio nor keysound`);
  }
  return {
    songId: entry.songId,
    title: entry.title,
    artist: entry.artist,
    genre: entry.genre,
    audio: { source: 'builtin', ref: audioRef, offsetMs: entry.offsetMs },
    charts,
  };
}
