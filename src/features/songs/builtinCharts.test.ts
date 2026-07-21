// Validates every built-in song under public/songs/ against the chart-format
// schema and beat->ms timing pipeline (specs/builtin-song-content.md MUST 12,
// specs/chart-format.md MUST 7 / SHOULD 10). Zero warnings tolerated: any
// validation issue, timing anomaly, or catalog/audio mismatch fails the test.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeNoteTimesMs, createTimingIndex } from '../../lib/chart/timing';
import { loadChart } from '../../lib/chart/validate';
import { PRACTICE_PRESETS } from '../practice/pattern';
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

// --- minimal ogg vorbis header parsing --------------------------------------------
// Validates spec MUST 9 (ogg vorbis, 44.1kHz stereo) without a decoder: the first
// ogg page's first packet is the Vorbis identification header (channels +
// sample rate), and the granule position of the final page is the total PCM
// frame count, which yields the duration exactly (vorbis granules are
// sample-accurate). Peak level (-1dBFS) is enforced at generation time by
// normalizeAndAssertPeak in scripts/builtin-songs/lib.mjs — a lossy file can't
// be re-checked bit-exactly here.

interface OggVorbisInfo {
  sampleRate: number;
  numChannels: number;
  durationMs: number;
}

function parseOggVorbis(buffer: Buffer): OggVorbisInfo {
  if (buffer.length < 58 || buffer.toString('ascii', 0, 4) !== 'OggS') {
    throw new Error('Not an ogg stream (missing OggS capture pattern)');
  }

  // First page payload = Vorbis identification header: 0x01 'vorbis', version(4),
  // channels(1), sampleRate(4 LE).
  const firstSegments = buffer.readUInt8(26);
  const payload = 27 + firstSegments;
  if (
    buffer.readUInt8(payload) !== 0x01 ||
    buffer.toString('ascii', payload + 1, payload + 7) !== 'vorbis'
  ) {
    throw new Error('First ogg packet is not a vorbis identification header');
  }
  const numChannels = buffer.readUInt8(payload + 11);
  const sampleRate = buffer.readUInt32LE(payload + 12);

  // Walk every page (never search for 'OggS' — the byte pattern can occur inside
  // payload data); the last page's granule position = total PCM frames.
  let offset = 0;
  let lastGranule = 0n;
  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new Error(`ogg page boundary mismatch at byte ${offset}`);
    }
    lastGranule = buffer.readBigUInt64LE(offset + 6);
    const segments = buffer.readUInt8(offset + 26);
    let payloadLength = 0;
    for (let i = 0; i < segments; i++) {
      payloadLength += buffer.readUInt8(offset + 27 + i);
    }
    offset += 27 + segments + payloadLength;
  }
  if (offset !== buffer.length) {
    throw new Error('ogg stream has trailing bytes after the final page');
  }

  return { sampleRate, numChannels, durationMs: (Number(lastGranule) / sampleRate) * 1000 };
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
    // The BGM track, or the keysound sample for the no-BGM practice song
    // (practice-song-content.md MUST 11) — parseSongEntry guarantees exactly one.
    const audioAsset = song.audio ?? song.keysound;
    if (audioAsset === undefined) throw new Error(`${song.songId} has no audio asset`);
    const audioPath = join(PUBLIC_DIR, audioAsset);

    it('has an audio asset that exists and parses as ogg vorbis 44.1kHz stereo (MUST 9 / practice MUST 7)', () => {
      expect(existsSync(audioPath)).toBe(true);
      expect(audioAsset.endsWith('.ogg')).toBe(true);
      const buffer = readFileSync(audioPath);
      const info = parseOggVorbis(buffer);
      expect(info.sampleRate).toBe(44100);
      expect(info.numChannels).toBe(2);
      if (song.keysound !== undefined) {
        // practice-song-content.md MUST 7: a short decaying keysound, <=150ms.
        expect(info.durationMs).toBeLessThanOrEqual(150);
      }
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

        // The audio must contain the whole chart, plus at least a 1s tail. The
        // keysound practice song has no BGM to contain the chart — its session
        // length is last note + 2s by construction (practice-song-content MUST 9).
        if (song.audio !== undefined) {
          const audioBuffer = readFileSync(audioPath);
          const audioInfo = parseOggVorbis(audioBuffer);
          const lastTimeMs = times.reduce((max, t) => Math.max(max, t), 0);
          expect(lastTimeMs + 1000).toBeLessThan(audioInfo.durationMs);
        }
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
  // The keysound practice song is excluded from the 3-song aggregate, the 2-slot
  // rule, and the level-band coverage (practice-song-content.md MUST 2 exception):
  // the music catalog must satisfy MUST 1-2 entirely on its own.
  const bgmSongs = catalog.songs.filter((song) => song.keysound === undefined);

  it('ships at least 3 BGM songs, each with at least 2 difficulty slots (MUST 1-2)', () => {
    expect(bgmSongs.length).toBeGreaterThanOrEqual(3);
    for (const song of bgmSongs) {
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
      const covered = bgmSongs.some((song) =>
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

  it('ships a CN showcase: >=1 song charts cn notes, incl. a tail exactly ON a STOP beat (SHOULD 15)', () => {
    const allCharts = catalog.songs.flatMap((song) =>
      song.charts.map((entry) => loadChartAt(entry.chartPath)),
    );
    const cnCharts = allCharts.filter((chart) => chart.notes.some((note) => note.type === 'cn'));
    expect(cnCharts.length, 'no shipped chart contains a cn note').toBeGreaterThanOrEqual(1);

    // Every shipped CN must resolve BOTH ends through the timing index (this is
    // what the play controller does at session start), and a tail landing exactly
    // ON a STOP beat must resolve to the STOP's start time — the same-beat rule
    // (timing.ts control-point semantics) applied to tails, pinned in content.
    let tailOnStop = false;
    for (const chart of cnCharts) {
      const index = createTimingIndex(chart.timing);
      const stopBeats = new Set(chart.timing.stopEvents.map((event) => event.beat));
      for (const note of chart.notes) {
        if (note.type !== 'cn' || note.endBeat === undefined) continue;
        const headMs = index.beatToMs(note.beat);
        const tailMs = index.beatToMs(note.endBeat);
        expect(Number.isFinite(tailMs)).toBe(true);
        expect(tailMs).toBeGreaterThan(headMs);
        if (stopBeats.has(note.endBeat)) tailOnStop = true;
      }
    }
    expect(tailOnStop, 'no shipped cn tail lands exactly on a STOP beat').toBe(true);
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

// --- practice song coverage (specs/practice-song-content.md) ---------------------
// Pins the keysound practice song's SHAPE: the catalog exceptions (MUST 1-2, 7, 11),
// the fixed-BPM-282 16-bar tap-only chart (MUST 3), the A/B/C section structure the
// pattern was authored to (MUST 4-5 + the C-section acceptance criterion), and the
// SHOULD 14 practice-preset excerpts, which must never drift from the shipped chart.

describe('practice song content (practice-song-content.md)', () => {
  const entry = catalog.songs.find((song) => song.keysound !== undefined);

  function dojoChart() {
    if (entry === undefined) throw new Error('keysound practice song missing from catalog');
    const chartEntry = entry.charts[0];
    if (chartEntry === undefined) throw new Error('practice song has no chart');
    return loadChartAt(chartEntry.chartPath);
  }

  it('ships exactly one keysound song: 1 chart slot, PRACTICE genre, no preview (MUST 1-2, 11, SHOULD 13)', () => {
    const keysoundSongs = catalog.songs.filter((song) => song.keysound !== undefined);
    expect(keysoundSongs.length).toBe(1);
    if (entry === undefined) throw new Error('unreachable');
    expect(entry.charts.length).toBe(1);
    expect(entry.charts[0]?.chartId).toBe(`${entry.songId}-another`);
    expect(entry.genre).toBe('PRACTICE');
    expect(entry.audio).toBeUndefined();
    expect(entry.preview).toBeUndefined();
    // audio-playback.md exception paragraph: keysound entries carry offsetMs 0.
    expect(entry.offsetMs).toBe(0);
    // MUST 7: the keysound's license is recorded in index.json (permissive only).
    expect(entry.license).toMatch(/CC0/);
  });

  it('is a fixed-BPM-282, 4/4, 16-bar, tap-only chart (MUST 3)', () => {
    const chart = dojoChart();
    expect(chart.bpm).toEqual({ init: 282, min: 282, max: 282 });
    expect(chart.timing.bpmEvents).toEqual([{ beat: 0, bpm: 282 }]);
    expect(chart.timing.stopEvents).toEqual([]);
    expect(chart.notes.every((note) => note.type === 'tap')).toBe(true);
    const lastBeat = chart.notes[chart.notes.length - 1]?.beat ?? -1;
    expect(lastBeat, 'pattern must reach bar 16').toBeGreaterThanOrEqual(60);
    expect(lastBeat, 'pattern must stay within 16 bars').toBeLessThan(64);
  });

  it('A section (bars 1-9): 2-4-key chord every beat, adjacent chords differ, scratch on allowed beats only (MUST 4-5)', () => {
    const chart = dojoChart();
    let previousChord = '';
    for (let beat = 0; beat < 36; beat++) {
      const keyLanes = chart.notes
        .filter((note) => note.beat === beat && note.lane >= 1)
        .map((note) => note.lane)
        .sort((a, b) => a - b);
      expect(keyLanes.length, `beat ${beat} chord size`).toBeGreaterThanOrEqual(2);
      expect(keyLanes.length, `beat ${beat} chord size`).toBeLessThanOrEqual(4);
      const chord = keyLanes.join(',');
      expect(chord, `adjacent chords at beats ${beat - 1}/${beat} must differ`).not.toBe(
        previousChord,
      );
      previousChord = chord;
    }
    // The chord stream is strictly quarter-note: no off-grid notes before bar 10.
    expect(chart.notes.every((note) => note.beat >= 36 || Number.isInteger(note.beat))).toBe(true);
    // Scratch: on some (not all) bar starts, plus exactly ONE middle bar adding
    // beat 3 (in-bar offset 2) — the spec's "1·3박 2회 배치 마디 1개".
    const scratchBeats = chart.notes
      .filter((note) => note.beat < 36 && note.lane === 0)
      .map((note) => note.beat);
    const offBarStart = scratchBeats.filter((beat) => beat % 4 !== 0);
    expect(offBarStart.length).toBe(1);
    expect((offBarStart[0] ?? 0) % 4).toBe(2);
    const barsWithScratch = new Set(scratchBeats.map((beat) => Math.floor(beat / 4)));
    expect(barsWithScratch.size).toBeGreaterThanOrEqual(2);
    expect(barsWithScratch.size, 'scratch on SOME bars, not all').toBeLessThan(9);
  });

  it('B section (bars 10-12): bar-start scratch+chord kept, singles mixed between (MUST 4)', () => {
    const chart = dojoChart();
    for (let bar = 9; bar < 12; bar++) {
      const start = bar * 4;
      const startScratch = chart.notes.some((note) => note.beat === start && note.lane === 0);
      const startChord = chart.notes.filter((note) => note.beat === start && note.lane >= 1).length;
      expect(startScratch, `bar ${bar + 1} start scratch`).toBe(true);
      expect(startChord, `bar ${bar + 1} start chord`).toBeGreaterThanOrEqual(2);
      // The relaxation is real: at least one in-bar position holds a SINGLE note.
      const positions = new Map<number, number>();
      for (const note of chart.notes) {
        if (note.beat > start && note.beat < start + 4 && note.lane >= 1) {
          positions.set(note.beat, (positions.get(note.beat) ?? 0) + 1);
        }
      }
      expect(
        [...positions.values()].some((count) => count === 1),
        `bar ${bar + 1} has no single notes between chords`,
      ).toBe(true);
    }
  });

  it('C section (bars 13-16): scratch simultaneous with a 2-3-key chord on almost every beat, every bar (MUST 4 + acceptance)', () => {
    const chart = dojoChart();
    for (let bar = 12; bar < 16; bar++) {
      let simultaneous = 0;
      for (let beatInBar = 0; beatInBar < 4; beatInBar++) {
        const beat = bar * 4 + beatInBar;
        const scratch = chart.notes.some((note) => note.beat === beat && note.lane === 0);
        const chordSize = chart.notes.filter((note) => note.beat === beat && note.lane >= 1).length;
        if (scratch && chordSize >= 2 && chordSize <= 3) simultaneous++;
      }
      expect(simultaneous, `bar ${bar + 1} scratch+chord beats`).toBeGreaterThanOrEqual(3);
    }
  });

  it('practice presets mirror the chart excerpts exactly (SHOULD 14 — no drift)', () => {
    const chart = dojoChart();
    const excerpt = (fromBeat: number, toBeat: number) =>
      chart.notes
        .filter((note) => note.beat >= fromBeat && note.beat < toBeat)
        .map((note) => `${note.beat - fromBeat}:${note.lane}`)
        .sort();
    const built = (key: string) => {
      const preset = PRACTICE_PRESETS.find((p) => p.key === key);
      if (preset === undefined) throw new Error(`missing practice preset ${key}`);
      // The excerpts only make sense at the source tempo (editor applies it).
      expect(preset.bpm).toBe(282);
      return preset
        .build(4)
        .map((note) => `${note.beat}:${note.lane}`)
        .sort();
    };
    expect(built('dojo-chords')).toEqual(excerpt(0, 16));
    expect(built('dojo-scratch')).toEqual(excerpt(48, 64));
  });
});
