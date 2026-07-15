// Validates every built-in song under public/songs/ against the chart-format
// schema and beat->ms timing pipeline (specs/builtin-song-content.md MUST 12,
// specs/chart-format.md MUST 7 / SHOULD 10). Zero warnings tolerated: any
// validation issue, timing anomaly, or catalog/audio mismatch fails the test.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeNoteTimesMs, createTimingIndex } from '../../lib/chart/timing';
import { loadChart } from '../../lib/chart/validate';
import { parseCatalog } from './catalog';
import type { CatalogSongEntry } from './catalog';

const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');
const PUBLIC_SONGS_DIR = join(PUBLIC_DIR, 'songs');
const INDEX_PATH = join(PUBLIC_SONGS_DIR, 'index.json');

// --- FNV-1a 32-bit, reimplemented here (not imported) to independently verify
// the generator script's deterministic songId derivation. ---------------------

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deriveSongId(title: string, artist: string): string {
  const key = `${title.toLowerCase()} ${artist.toLowerCase()}`;
  return `song-${fnv1a32(key).toString(16).padStart(8, '0')}`;
}

// --- minimal WAV header parsing -------------------------------------------------

interface WavInfo {
  isPcm: boolean;
  bitsPerSample: number;
  sampleRate: number;
  numChannels: number;
  durationMs: number;
}

function parseWavHeader(buffer: Buffer): WavInfo {
  if (buffer.length < 44) {
    throw new Error('WAV file too small to contain a valid header');
  }
  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error(`Not a RIFF/WAVE file (got "${riff}"/"${wave}")`);
  }

  // Walk chunks after the 12-byte RIFF/WAVE header to find 'fmt ' and 'data'.
  let offset = 12;
  let audioFormat = -1;
  let numChannels = -1;
  let sampleRate = -1;
  let bitsPerSample = -1;
  let dataSize = -1;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      audioFormat = buffer.readUInt16LE(chunkStart);
      numChannels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (audioFormat === -1 || dataSize === -1) {
    throw new Error('WAV file missing fmt or data chunk');
  }

  const blockAlign = numChannels * (bitsPerSample / 8);
  const numFrames = dataSize / blockAlign;
  const durationMs = (numFrames / sampleRate) * 1000;

  return {
    isPcm: audioFormat === 1,
    bitsPerSample,
    sampleRate,
    numChannels,
    durationMs,
  };
}

// --- load + validate the catalog once -------------------------------------------

const rawIndex: unknown = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const catalog = parseCatalog(rawIndex);

describe('built-in song catalog', () => {
  it('parses as a valid SongCatalog', () => {
    expect(catalog.songs.length).toBeGreaterThan(0);
  });

  it.each(catalog.songs)(
    'songId "$songId" is deterministically derived from title+artist',
    (song: CatalogSongEntry) => {
      expect(song.songId).toBe(deriveSongId(song.title, song.artist));
    },
  );

  describe.each(catalog.songs)('song $songId ($title by $artist)', (song: CatalogSongEntry) => {
    const audioPath = join(PUBLIC_DIR, song.audio);

    it('has an audio file that exists and parses as 16-bit PCM 44.1kHz stereo', () => {
      expect(existsSync(audioPath)).toBe(true);
      const buffer = readFileSync(audioPath);
      const info = parseWavHeader(buffer);
      expect(info.isPcm).toBe(true);
      expect(info.bitsPerSample).toBe(16);
      expect(info.sampleRate).toBe(44100);
      expect(info.numChannels).toBe(2);
    });

    it.each(song.charts)(
      'chart $chartId ($difficulty) matches the catalog entry and loads cleanly',
      (chartEntry) => {
        const resolvedPath = join(PUBLIC_DIR, chartEntry.chartPath);
        expect(existsSync(resolvedPath)).toBe(true);

        const raw: unknown = JSON.parse(readFileSync(resolvedPath, 'utf8'));
        const chart = loadChart(raw); // throws ChartValidationError on any schema issue

        expect(chart.chartId).toBe(chartEntry.chartId);
        expect(chart.difficulty).toBe(chartEntry.difficulty);
        expect(chart.level).toBe(chartEntry.level);
        expect(chart.notes.length).toBe(chartEntry.noteCount);
        expect(chartEntry.noteCount).toBe(chart.notes.length);

        // beat->ms timing must succeed and produce sane, monotonic-safe times.
        createTimingIndex(chart.timing);
        const times = computeNoteTimesMs(chart);
        expect(times.length).toBe(chart.notes.length);

        let previousTime = Number.NEGATIVE_INFINITY;
        const notesByBeat = [...chart.notes]
          .map((note, i) => ({ note, timeMs: times[i] ?? Number.NaN }))
          .sort((a, b) => a.note.beat - b.note.beat);

        for (const { timeMs } of notesByBeat) {
          expect(Number.isFinite(timeMs)).toBe(true);
          expect(timeMs).toBeGreaterThanOrEqual(0);
          expect(timeMs).toBeGreaterThanOrEqual(previousTime - 1e-9);
          previousTime = timeMs;
        }

        // The audio must contain the whole chart, plus at least a 1s tail.
        const audioBuffer = readFileSync(audioPath);
        const audioInfo = parseWavHeader(audioBuffer);
        const lastTimeMs = times.reduce((max, t) => Math.max(max, t), 0);
        expect(lastTimeMs + 1000).toBeLessThan(audioInfo.durationMs);
      },
    );
  });
});

// --- content coverage (specs/builtin-song-content.md MUST 1-4) -------------------
// These pin the SHAPE of the shipped catalog, not just per-chart validity: losing
// a song, a difficulty slot, a level band, or the BPM-change/STOP showcase chart
// silently weakens what the built-in content is required to exercise.

function loadChartAt(chartPath: string) {
  const raw: unknown = JSON.parse(readFileSync(join(PUBLIC_DIR, chartPath), 'utf8'));
  return loadChart(raw);
}

describe('built-in content coverage (builtin-song-content.md MUST 1-4)', () => {
  it('ships at least 3 songs, each with at least 2 difficulty slots (MUST 1-2)', () => {
    expect(catalog.songs.length).toBeGreaterThanOrEqual(3);
    for (const song of catalog.songs) {
      expect(song.charts.length, `${song.title} needs >=2 difficulty slots`).toBeGreaterThanOrEqual(
        2,
      );
    }
  });

  it('covers the low (1-4), mid (5-8), and high (9-12) level bands (MUST 1)', () => {
    const bands: Array<[number, number]> = [
      [1, 4],
      [5, 8],
      [9, 12],
    ];
    for (const [lo, hi] of bands) {
      const covered = catalog.songs.some((song) =>
        song.charts.some((chart) => chart.level >= lo && chart.level <= hi),
      );
      expect(covered, `no song has a chart in level band ${lo}-${hi}`).toBe(true);
    }
  });

  it('ships a >=2-BPM-change + >=1-STOP showcase chart AND a single-BPM baseline (MUST 3-4)', () => {
    const allCharts = catalog.songs.flatMap((song) =>
      song.charts.map((entry) => loadChartAt(entry.chartPath)),
    );
    // bpmEvents[0] is the initial BPM, so >=2 changes means >=3 events.
    const showcase = allCharts.find(
      (chart) => chart.timing.bpmEvents.length >= 3 && chart.timing.stopEvents.length >= 1,
    );
    expect(showcase, 'no chart with >=2 BPM changes and >=1 STOP').toBeDefined();
    const baseline = allCharts.some(
      (chart) => chart.timing.bpmEvents.length === 1 && chart.timing.stopEvents.length === 0,
    );
    expect(baseline, 'no single-BPM/no-STOP baseline chart').toBe(true);

    // The showcase chart must have a note exactly ON a STOP beat, pinning the
    // "note at a STOP's beat sounds when the STOP begins" timing rule
    // (src/lib/chart/timing.ts) into real shipped content.
    const stopBeats = new Set(showcase?.timing.stopEvents.map((event) => event.beat));
    const noteOnStop = showcase?.notes.some((note) => stopBeats.has(note.beat));
    expect(noteOnStop, 'showcase chart has no note exactly on a STOP beat').toBe(true);
  });

  it('chart bpm metadata matches bpmEvents and the catalog bpm range spans the charts', () => {
    for (const song of catalog.songs) {
      let songMin = Number.POSITIVE_INFINITY;
      let songMax = Number.NEGATIVE_INFINITY;
      for (const entry of song.charts) {
        const chart = loadChartAt(entry.chartPath);
        const bpms = chart.timing.bpmEvents.map((event) => event.bpm);
        expect(chart.bpm.init).toBe(chart.timing.bpmEvents[0]?.bpm);
        expect(chart.bpm.min).toBe(Math.min(...bpms));
        expect(chart.bpm.max).toBe(Math.max(...bpms));
        songMin = Math.min(songMin, chart.bpm.min);
        songMax = Math.max(songMax, chart.bpm.max);
      }
      expect(song.bpm.min, `${song.title} catalog bpm.min`).toBe(songMin);
      expect(song.bpm.max, `${song.title} catalog bpm.max`).toBe(songMax);
    }
  });
});
