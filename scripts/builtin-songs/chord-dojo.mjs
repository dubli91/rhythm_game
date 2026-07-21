// "Chord Dojo 282" by Prism Unit — the practice-song content
// (specs/practice-song-content.md): a single ANOTHER ☆12 chart, BPM 282
// fixed, 16 bars split into 3 sections (A chord stream / B break / C scratch
// rush). No BGM: the "track" is one short decaying keysound sample played on
// every key press, not synthesized music — the sole exception to
// specs/00-overview.md's "no real-time keysound playback" non-goal, scoped to
// this one song (MUST 7-10).
//
// The exact per-beat lane layout below is transcribed verbatim from the
// reference chart image (2026-07-21, original bars 51-66, MUST 6); it is not
// procedurally generated like the other built-in songs, so there is no
// shared "pattern data drives both audio and chart" structure here — there's
// no audio to drive.

import {
  SAMPLE_RATE,
  addNote,
  assertChartInvariants,
  assertNoteCountRange,
  computeTotal,
  deriveSongId,
  peakNormalize,
} from './lib.mjs';

// --- song constants ------------------------------------------------------------

const TITLE = 'Chord Dojo 282';
const ARTIST = 'Prism Unit';
const GENRE = 'PRACTICE';
const BPM = 282;
const BEATS_PER_BAR = 4;
const TOTAL_BARS = 16;
const TOTAL_BEATS = TOTAL_BARS * BEATS_PER_BAR; // 64

const SONG_ID = deriveSongId(TITLE, ARTIST);
const CHART_ID_ANOTHER = `${SONG_ID}-another`;

// --- pattern data (transcribed from the reference image, MUST 6) ---------------
// Each entry: [beat, hasScratch, keyLanes[]]. Lane 0 = scratch, lanes 1-7 = keys.

// A — chord stream, bars 1-9 (beats 0-35): one 2-4 note chord per quarter beat.
const SECTION_A = [
  [0, true, [1, 3, 5]],
  [1, false, [4, 6]],
  [2, false, [2, 5, 7]],
  [3, false, [3, 6]],
  [4, false, [1, 4, 6]],
  [5, false, [2, 5]],
  [6, false, [3, 5, 7]],
  [7, false, [1, 4]],
  [8, true, [2, 4, 7]],
  [9, false, [1, 5]],
  [10, false, [3, 6]],
  [11, false, [2, 4, 6]],
  [12, false, [1, 3, 6]],
  [13, false, [4, 7]],
  [14, false, [2, 5]],
  [15, false, [1, 3, 5, 7]],
  [16, true, [2, 6]],
  [17, false, [3, 5, 7]],
  [18, true, [1, 4]],
  [19, false, [2, 5, 7]],
  [20, false, [1, 3, 6]],
  [21, false, [2, 4, 7]],
  [22, false, [1, 5]],
  [23, false, [3, 4, 6]],
  [24, true, [2, 5, 7]],
  [25, false, [1, 3, 6]],
  [26, false, [4, 6]],
  [27, false, [2, 3, 5]],
  [28, false, [1, 4, 7]],
  [29, false, [3, 5]],
  [30, false, [2, 4, 6]],
  [31, false, [1, 3, 5, 7]],
  [32, true, [2, 4, 6]],
  [33, false, [1, 3, 5]],
  [34, false, [4, 5, 7]],
  [35, false, [2, 6]],
];

// B — break, bars 10-12 (beats 36-47): singles interleaved between chords,
// including 8th-note (fractional-beat) hits.
const SECTION_B = [
  [36, true, [1, 5]],
  [37, false, [3]],
  [37.5, false, [6]],
  [38, false, [2, 7]],
  [39, false, [4]],
  [40, true, [2, 6]],
  [40.5, false, [4]],
  [41, false, [1, 5]],
  [42, false, [3]],
  [42.5, false, [7]],
  [43, false, [2, 5]],
  [44, true, [1, 3, 5]],
  [45, false, [6]],
  [45.5, false, [4]],
  [46, false, [2, 7]],
  [46.5, false, [5]],
  [47, false, [1, 6]],
];

// C — scratch rush, bars 13-16 (beats 48-63): scratch coincides with a 2-3
// key chord almost every beat; beat 55 deliberately drops the scratch.
const SECTION_C = [
  [48, true, [1, 5]],
  [49, true, [3, 7]],
  [50, true, [2, 6]],
  [51, true, [1, 4, 7]],
  [52, true, [3, 5]],
  [53, true, [2, 7]],
  [54, true, [4, 6]],
  [55, false, [1, 3, 5]],
  [56, true, [2, 7]],
  [57, true, [1, 4]],
  [58, true, [3, 6]],
  [59, true, [2, 5, 7]],
  [60, true, [1, 3]],
  [61, true, [4, 7]],
  [62, true, [2, 5]],
  [63, true, [1, 3, 5]],
];

// --- chart authoring -------------------------------------------------------------

function buildNotes(sections) {
  const notes = [];
  const seen = new Set();
  for (const [beat, hasScratch, keys] of sections) {
    if (hasScratch) addNote(notes, seen, beat, 0);
    for (const lane of keys) addNote(notes, seen, beat, lane);
  }
  notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane);
  return notes;
}

/** Spec MUST 5: adjacent quarter-beat chords in the A section must not repeat the same lane set. */
function assertAdjacentChordsDiffer(section, label) {
  for (let i = 1; i < section.length; i++) {
    const [prevBeat, , prevKeys] = section[i - 1];
    const [beat, , keys] = section[i];
    const a = [...prevKeys].sort((x, y) => x - y).join(',');
    const b = [...keys].sort((x, y) => x - y).join(',');
    if (a === b) {
      throw new Error(
        `${label}: adjacent chords at beats ${prevBeat} and ${beat} repeat lane set {${a}}`,
      );
    }
  }
}

/** Acceptance criterion: every C-section bar has >=3 beats where scratch coincides with a 2-3 key chord. */
function assertScratchRushBars(section, label) {
  const perBar = new Map();
  for (const [beat, hasScratch, keys] of section) {
    const bar = Math.floor(beat / BEATS_PER_BAR);
    const qualifies = hasScratch && keys.length >= 2 && keys.length <= 3;
    perBar.set(bar, (perBar.get(bar) ?? 0) + (qualifies ? 1 : 0));
  }
  for (const [bar, count] of perBar) {
    if (count < 3) {
      throw new Error(
        `${label}: bar ${bar + 1} has only ${count} scratch+2-3-key coincidences (need >=3)`,
      );
    }
  }
}

// --- keysound synthesis (MUST 7: <=150ms, no BGM) ---------------------------------

const KEYSOUND_DUR_SEC = 0.12;
const ATTACK_SEC = 0.003;
const DECAY_TAU_SEC = 0.03;
const END_FADE_SEC = 0.005;
// Up to 5 keysound instances can play sample-aligned simultaneously (scratch +
// a 4-key chord, e.g. beats 15/31 in section A): 5 * 0.18 = 0.9 keeps the
// summed peak under full scale, where the song-track -1dBFS target
// (normalizeAndAssertPeak, ~0.89 per voice) would hard-clip a 5-voice stack.
const KEYSOUND_TARGET_PEAK = 0.18;

function synthKeysound() {
  const n = Math.round(KEYSOUND_DUR_SEC * SAMPLE_RATE);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const tone = Math.sin(2 * Math.PI * 1046.5 * t) + 0.5 * Math.sin(2 * Math.PI * 2093 * t);
    const env = t < ATTACK_SEC ? t / ATTACK_SEC : Math.exp(-(t - ATTACK_SEC) / DECAY_TAU_SEC);
    mono[i] = tone * env;
  }
  // Linear-fade the final END_FADE_SEC to exactly 0 (rather than relying on
  // the exponential decay alone) so the buffer never ends on a nonzero
  // sample and clicks.
  const fadeSamples = Math.round(END_FADE_SEC * SAMPLE_RATE);
  for (let k = 0; k < fadeSamples; k++) {
    const i = n - fadeSamples + k;
    if (i < 0) continue;
    const fadeGain = (fadeSamples - 1 - k) / (fadeSamples - 1);
    mono[i] *= fadeGain;
  }
  return mono;
}

// --- build ------------------------------------------------------------------------

export function buildChordDojo() {
  const allSections = [...SECTION_A, ...SECTION_B, ...SECTION_C];
  const notes = buildNotes(allSections);

  assertAdjacentChordsDiffer(SECTION_A, 'chord-dojo section A');
  assertScratchRushBars(SECTION_C, 'chord-dojo section C');

  const chart = {
    formatVersion: 1,
    chartId: CHART_ID_ANOTHER,
    difficulty: 'ANOTHER',
    level: 12,
    total: computeTotal(notes.length),
    bpm: { init: BPM, min: BPM, max: BPM },
    timing: {
      bpmEvents: [{ beat: 0, bpm: BPM }],
      stopEvents: [],
    },
    notes,
  };

  assertChartInvariants(chart, 'chord-dojo chart-another', {
    firstNoteMinBeat: 0,
    lastNoteMaxBeat: 63,
    totalBeats: TOTAL_BEATS,
  });
  assertNoteCountRange(chart, 'chord-dojo chart-another', [182, 182]);

  // --- keysound (no BGM: pcm below is the single keysound sample) ---
  const mono = synthKeysound();
  const left = Float32Array.from(mono);
  const right = Float32Array.from(mono);
  peakNormalize([left, right], KEYSOUND_TARGET_PEAK);
  let measuredPeak = 0;
  for (const channel of [left, right]) {
    for (let i = 0; i < channel.length; i++) {
      measuredPeak = Math.max(measuredPeak, Math.abs(channel[i]));
    }
  }
  if (measuredPeak < 0.17 || measuredPeak > 0.19) {
    throw new Error(`chord-dojo keysound: peak ${measuredPeak} outside expected [0.17, 0.19]`);
  }

  return {
    songId: SONG_ID,
    entry: {
      songId: SONG_ID,
      title: TITLE,
      artist: ARTIST,
      genre: GENRE,
      bpm: { min: BPM, max: BPM },
      charts: [
        {
          chartId: CHART_ID_ANOTHER,
          difficulty: 'ANOTHER',
          level: 12,
          noteCount: chart.notes.length,
          chartPath: `songs/${SONG_ID}/chart-another.json`,
        },
      ],
      // No `audio`/`preview`: this song has no BGM (MUST 11) and no
      // song-select preview (spec: "곡 선택 미리듣기 없음 — 무음").
      keysound: `songs/${SONG_ID}/keysound.ogg`,
      offsetMs: 0,
      license: 'CC0-1.0 — original programmatically generated keysound (no third-party material)',
    },
    chartFiles: [{ filename: 'chart-another.json', chart }],
    pcm: { left, right, sampleRate: SAMPLE_RATE },
    audioFilename: 'keysound.ogg',
    summary: [
      `chartId (another): ${CHART_ID_ANOTHER}  notes=${chart.notes.length}  total=${chart.total}`,
      `keysound: ${(KEYSOUND_DUR_SEC * 1000).toFixed(0)}ms, peak=${measuredPeak.toFixed(6)}`,
    ],
  };
}
