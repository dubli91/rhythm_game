// "First Light" by Prism Unit — the original vertical-slice song: constant
// 150 BPM, no BPM changes, no STOPs (specs/builtin-song-content.md MUST 4).
// Synthesizes a layered synthwave track and authors NORMAL + HYPER charts from
// the SAME pattern data used to synthesize the audio, so notes line up with
// audible events.
//
// IMPORTANT: this module reproduces the original single-song generator's float
// arithmetic exactly (its own beat->sec math, same RNG seed and consumption
// order, same synthesis order kick->snare->hat->bass->lead->pad) so that
// regenerating keeps public/songs/song-6f90aea6/ byte-identical — local
// records stay attached and the M2 sync verification stays valid.

import {
  SAMPLE_RATE,
  addMono,
  addNote,
  addSustainedPad,
  assertChartInvariants,
  assertNoteCountRange,
  computeTotal,
  createSeededRng,
  deriveSongId,
  encodeWav16Stereo,
  normalizeAndAssertPeak,
  noteFreq,
  synthBassNote,
  synthKick,
  synthLeadNote,
  synthNoiseBurst,
} from './lib.mjs';

// --- song constants ------------------------------------------------------------

const TITLE = 'First Light';
const ARTIST = 'Prism Unit';
const GENRE = 'SYNTHPOP';
const BPM = 150;
const BEATS_PER_BAR = 4;
const TOTAL_BARS = 40;
const TOTAL_BEATS = TOTAL_BARS * BEATS_PER_BAR; // 160
const SECONDS_PER_BEAT = 60 / BPM; // 0.4s
const MUSIC_SECONDS = TOTAL_BEATS * SECONDS_PER_BEAT; // 64s
const TAIL_SECONDS = 2;
const TOTAL_SECONDS = MUSIC_SECONDS + TAIL_SECONDS; // 66s

const SONG_ID = deriveSongId(TITLE, ARTIST);
const CHART_ID_NORMAL = `${SONG_ID}-normal`;
const CHART_ID_HYPER = `${SONG_ID}-hyper`;

function barStartBeat(bar1based) {
  return (bar1based - 1) * BEATS_PER_BAR;
}

// Constant-BPM beat->sec kept as the original plain multiplication (NOT the
// generic control-point clock) so the audio stays bit-identical.
function beatToSec(beat) {
  return beat * SECONDS_PER_BEAT;
}

// --- pattern data (shared by audio synthesis AND chart authoring) --------------
// All patterns are generated deterministically from bar/beat arithmetic, so
// the same event lists drive both the synth and the notes.

const KICK_START_BAR = 5; // "every beat from bar 5"
const SNARE_START_BAR = 9; // "beats 2 & 4 of each bar from bar 9"
const HAT_START_BAR = 5; // "offbeats from bar 5"
const BASS_START_BAR = 3; // "2-bar repeating pattern from bar 3"
const LEAD_START_BAR = 9; // "8-bar phrase from bar 9"
const PAD_START_BAR = 1; // "soft pad from bar 1"

/** Every beat, kick drum. */
function buildKickBeats() {
  const beats = [];
  for (let beat = barStartBeat(KICK_START_BAR); beat < TOTAL_BEATS; beat++) {
    beats.push(beat);
  }
  return beats;
}

/** Beats 2 & 4 of every bar (0-indexed offsets 1 and 3), from SNARE_START_BAR. */
function buildSnareBeats() {
  const beats = [];
  for (let bar = SNARE_START_BAR; bar <= TOTAL_BARS; bar++) {
    const start = barStartBeat(bar);
    beats.push(start + 1, start + 3);
  }
  return beats;
}

/** Eighth-note offbeats, from HAT_START_BAR. */
function buildHatBeats() {
  const beats = [];
  for (let beat = barStartBeat(HAT_START_BAR); beat < TOTAL_BEATS; beat++) {
    beats.push(beat + 0.5);
  }
  return beats;
}

// A-minor low register bass, 2-bar (8-beat) repeating cycle.
// Events with dur >= 1 beat are the "accent" notes charts key off of.
const BASS_CYCLE_BEATS = 8;
const BASS_PATTERN = [
  { offset: 0, note: 'A1', dur: 1.0 },
  { offset: 1, note: 'A1', dur: 0.5 },
  { offset: 1.5, note: 'C2', dur: 0.5 },
  { offset: 2, note: 'E2', dur: 1.0 },
  { offset: 3, note: 'E2', dur: 0.5 },
  { offset: 3.5, note: 'G2', dur: 0.5 },
  { offset: 4, note: 'A1', dur: 1.0 },
  { offset: 5, note: 'G2', dur: 1.0 },
  { offset: 6, note: 'E2', dur: 1.0 },
  { offset: 7, note: 'C2', dur: 1.0 },
];

function buildBassEvents() {
  const events = [];
  for (
    let cycleStart = barStartBeat(BASS_START_BAR);
    cycleStart < TOTAL_BEATS;
    cycleStart += BASS_CYCLE_BEATS
  ) {
    for (const step of BASS_PATTERN) {
      const beat = cycleStart + step.offset;
      if (beat >= TOTAL_BEATS) continue;
      events.push({ beat, note: step.note, dur: step.dur, accent: step.dur >= 1 });
    }
  }
  return events;
}

// A-minor pentatonic lead phrase, 8 bars (32 beats) long, transposed/reordered
// every repetition for variety. `degree` indexes PENTATONIC_SCALE.
const PENTATONIC_SCALE = ['E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5'];
const LEAD_PHRASE_BEATS = 32;
const BASE_LEAD_PHRASE = [
  { offset: 0, degree: 2, dur: 1 },
  { offset: 1, degree: 3, dur: 0.5 },
  { offset: 1.5, degree: 4, dur: 0.5 },
  { offset: 2, degree: 5, dur: 1 },
  { offset: 4, degree: 4, dur: 0.5 },
  { offset: 4.5, degree: 3, dur: 0.5 },
  { offset: 5, degree: 2, dur: 1 },
  { offset: 8, degree: 5, dur: 1 },
  { offset: 9, degree: 6, dur: 0.5 },
  { offset: 9.5, degree: 5, dur: 0.5 },
  { offset: 10, degree: 3, dur: 1 },
  { offset: 12, degree: 2, dur: 2 },
  { offset: 16, degree: 3, dur: 1 },
  { offset: 17, degree: 5, dur: 0.5 },
  { offset: 17.5, degree: 6, dur: 0.5 },
  { offset: 18, degree: 5, dur: 1 },
  { offset: 20, degree: 3, dur: 0.5 },
  { offset: 20.5, degree: 2, dur: 0.5 },
  { offset: 21, degree: 3, dur: 1 },
  { offset: 24, degree: 5, dur: 1 },
  { offset: 25, degree: 4, dur: 0.5 },
  { offset: 25.5, degree: 3, dur: 0.5 },
  { offset: 26, degree: 2, dur: 2 },
  { offset: 28, degree: 3, dur: 0.5 },
  { offset: 28.5, degree: 4, dur: 0.5 },
  { offset: 29, degree: 5, dur: 0.5 },
  { offset: 29.5, degree: 6, dur: 0.5 },
  { offset: 30, degree: 5, dur: 2 },
];

/** Deterministic per-repetition variant transform: identity / transpose+1 / retrograde offsets. */
function applyLeadVariant(phrase, variantIndex) {
  const variant = variantIndex % 3;
  if (variant === 0) {
    return phrase.map((n) => ({ ...n }));
  }
  if (variant === 1) {
    // Transpose up one scale degree.
    return phrase.map((n) => ({
      ...n,
      degree: Math.min(n.degree + 1, PENTATONIC_SCALE.length - 1),
    }));
  }
  // Retrograde: mirror the offsets within the phrase (keeps rhythmic durations attached).
  return phrase
    .map((n) => ({ ...n, offset: LEAD_PHRASE_BEATS - n.offset - n.dur }))
    .sort((a, b) => a.offset - b.offset);
}

function buildLeadEvents() {
  const events = [];
  let repetitionIndex = 0;
  for (
    let phraseStart = barStartBeat(LEAD_START_BAR);
    phraseStart < TOTAL_BEATS;
    phraseStart += LEAD_PHRASE_BEATS, repetitionIndex++
  ) {
    const variantPhrase = applyLeadVariant(BASE_LEAD_PHRASE, repetitionIndex);
    for (const step of variantPhrase) {
      const beat = phraseStart + step.offset;
      if (beat >= TOTAL_BEATS) continue;
      events.push({ beat, degree: step.degree, dur: step.dur });
    }
  }
  events.sort((a, b) => a.beat - b.beat);
  return events;
}

// --- chart authoring (derived from the same event lists as the audio) ----------

const FIRST_NOTE_MIN_BEAT = 16;
const LAST_NOTE_MAX_BEAT = 158;

function inNoteRange(beat) {
  return beat >= FIRST_NOTE_MIN_BEAT && beat <= LAST_NOTE_MAX_BEAT;
}

function kickLane(beat) {
  const barIndex0 = Math.floor(beat / BEATS_PER_BAR);
  const isDownbeat = beat % BEATS_PER_BAR === 0;
  if (isDownbeat && barIndex0 % 2 === 0) return 0; // scratch on downbeats every 2 bars
  return 4;
}

function snareLane(beat, bar) {
  const offsetInBar = beat - barStartBeat(bar);
  return offsetInBar === 1 ? 2 : 6;
}

const LEAD_LANES = [1, 3, 5, 7];

function leadLane(index) {
  return LEAD_LANES[index % LEAD_LANES.length];
}

function bassLane(index) {
  return index % 2 === 0 ? 2 : 6;
}

function buildNotes(
  { kickStride, snareStride, hatStride, bassStride, leadStride, addChords },
  { kickBeats, snareBeats, hatBeats, bassEvents, leadEvents },
) {
  const notes = [];
  const seen = new Set();

  kickBeats
    .filter((b) => inNoteRange(b))
    .forEach((beat, i) => {
      if (i % kickStride !== 0) return;
      addNote(notes, seen, beat, kickLane(beat));
    });

  snareBeats
    .filter((b) => inNoteRange(b))
    .forEach((beat, i) => {
      if (i % snareStride !== 0) return;
      // Recover the owning bar for lane alternation (2 entries per bar).
      const bar =
        SNARE_START_BAR + Math.floor((beat - barStartBeat(SNARE_START_BAR)) / BEATS_PER_BAR);
      addNote(notes, seen, beat, snareLane(beat, bar));
    });

  if (hatStride > 0) {
    hatBeats
      .filter((b) => inNoteRange(b))
      .forEach((beat, i) => {
        if (i % hatStride !== 0) return;
        addNote(notes, seen, beat, leadLane(i));
      });
  }

  if (bassStride > 0) {
    bassEvents
      .filter((ev) => ev.accent && inNoteRange(ev.beat))
      .forEach((ev, i) => {
        if (i % bassStride !== 0) return;
        addNote(notes, seen, ev.beat, bassLane(i));
      });
  }

  leadEvents
    .filter((ev) => inNoteRange(ev.beat))
    .forEach((ev, i) => {
      if (i % leadStride !== 0) return;
      const lane = leadLane(ev.degree);
      const added = addNote(notes, seen, ev.beat, lane);
      if (added && addChords && i % 6 === 0) {
        // Occasional 2-note chord: harmony a third below in pentatonic-degree space.
        const harmonyLane = leadLane(ev.degree + 2);
        if (harmonyLane !== lane) {
          addNote(notes, seen, ev.beat, harmonyLane);
        }
      }
    });

  notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane);
  return notes;
}

function buildChart(chartId, difficulty, level, notes) {
  return {
    formatVersion: 1,
    chartId,
    difficulty,
    level,
    total: computeTotal(notes.length),
    bpm: { init: BPM, min: BPM, max: BPM },
    timing: {
      bpmEvents: [{ beat: 0, bpm: BPM }],
      stopEvents: [],
    },
    notes,
  };
}

// --- build ------------------------------------------------------------------------

export function buildFirstLight() {
  const kickBeats = buildKickBeats();
  const snareBeats = buildSnareBeats();
  const hatBeats = buildHatBeats();
  const bassEvents = buildBassEvents();
  const leadEvents = buildLeadEvents();

  // --- audio synthesis (order matters: the shared RNG is consumed by snare
  // bursts first, then hat bursts, exactly like the original generator) ---
  const totalSamples = Math.round(TOTAL_SECONDS * SAMPLE_RATE);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const rng = createSeededRng(0x1a5f0d3);

  // Kick (mono, center)
  for (const beat of kickBeats) {
    const s = synthKick();
    addMono(left, beatToSec(beat), s, 0.5);
    addMono(right, beatToSec(beat), s, 0.5);
  }

  // Snare (mono, center) ~0.12s filtered noise
  for (const beat of snareBeats) {
    const s = synthNoiseBurst(rng, 0.12, 0.6);
    addMono(left, beatToSec(beat), s, 0.3);
    addMono(right, beatToSec(beat), s, 0.3);
  }

  // Closed hat (mono, center) ~0.03s filtered noise
  for (const beat of hatBeats) {
    const s = synthNoiseBurst(rng, 0.03, 0.8);
    addMono(left, beatToSec(beat), s, 0.12);
    addMono(right, beatToSec(beat), s, 0.12);
  }

  // Bass (mono, center)
  for (const ev of bassEvents) {
    const s = synthBassNote(noteFreq(ev.note), ev.dur * SECONDS_PER_BEAT * 0.95);
    addMono(left, beatToSec(ev.beat), s, 0.22);
    addMono(right, beatToSec(ev.beat), s, 0.22);
  }

  // Lead (stereo spread, detuned pulse pair)
  for (const ev of leadEvents) {
    const scaleNote = PENTATONIC_SCALE[ev.degree] ?? PENTATONIC_SCALE[0];
    const s = synthLeadNote(noteFreq(scaleNote), 0.25 * SECONDS_PER_BEAT);
    addMono(left, beatToSec(ev.beat), s.left, 0.25);
    addMono(right, beatToSec(ev.beat), s.right, 0.25);
  }

  // Pad: two detuned sines (root + fifth of A minor), slow attack, sustained
  // across the whole track, from PAD_START_BAR.
  addSustainedPad(left, right, {
    startSec: beatToSec(barStartBeat(PAD_START_BAR)),
    endSec: MUSIC_SECONDS,
    attackSec: 2.0,
    releaseSec: 1.5,
    rootNote: 'A3',
    fifthNote: 'E4',
    detuneCents: 4,
    gain: 0.1,
  });

  const measuredPeak = normalizeAndAssertPeak(left, right, 'first-light');
  const wav = encodeWav16Stereo(left, right, SAMPLE_RATE);

  // --- charts ---
  const events = { kickBeats, snareBeats, hatBeats, bassEvents, leadEvents };
  const chartNormal = buildChart(
    CHART_ID_NORMAL,
    'NORMAL',
    4,
    buildNotes(
      {
        kickStride: 3,
        snareStride: 2,
        hatStride: 0,
        bassStride: 4,
        leadStride: 3,
        addChords: false,
      },
      events,
    ),
  );
  const chartHyper = buildChart(
    CHART_ID_HYPER,
    'HYPER',
    7,
    buildNotes(
      {
        kickStride: 1,
        snareStride: 1,
        hatStride: 6,
        bassStride: 4,
        leadStride: 2,
        addChords: true,
      },
      events,
    ),
  );

  const invariantOpts = {
    firstNoteMinBeat: FIRST_NOTE_MIN_BEAT,
    lastNoteMaxBeat: LAST_NOTE_MAX_BEAT,
    totalBeats: TOTAL_BEATS,
  };
  assertChartInvariants(chartNormal, 'first-light chart-normal', invariantOpts);
  assertChartInvariants(chartHyper, 'first-light chart-hyper', invariantOpts);
  assertNoteCountRange(chartNormal, 'first-light chart-normal', [140, 170]);
  assertNoteCountRange(chartHyper, 'first-light chart-hyper', [280, 340]);

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
          chartId: CHART_ID_NORMAL,
          difficulty: 'NORMAL',
          level: 4,
          noteCount: chartNormal.notes.length,
          chartPath: `songs/${SONG_ID}/chart-normal.json`,
        },
        {
          chartId: CHART_ID_HYPER,
          difficulty: 'HYPER',
          level: 7,
          noteCount: chartHyper.notes.length,
          chartPath: `songs/${SONG_ID}/chart-hyper.json`,
        },
      ],
      audio: `songs/${SONG_ID}/audio.wav`,
      offsetMs: 0,
      preview: { startMs: 25600, durationMs: 10000 },
      license:
        'CC0-1.0 — original programmatically generated composition (no third-party material)',
    },
    chartFiles: [
      { filename: 'chart-normal.json', chart: chartNormal },
      { filename: 'chart-hyper.json', chart: chartHyper },
    ],
    wav,
    summary: [
      `chartId (normal): ${CHART_ID_NORMAL}  notes=${chartNormal.notes.length}  total=${chartNormal.total}`,
      `chartId (hyper):  ${CHART_ID_HYPER}  notes=${chartHyper.notes.length}  total=${chartHyper.total}`,
      `audio: ${MUSIC_SECONDS}s music + ${TAIL_SECONDS}s tail = ${TOTAL_SECONDS}s, ${wav.length} bytes`,
      `normalized peak: ${measuredPeak.toFixed(6)}`,
    ],
  };
}
