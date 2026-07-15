// "Overdrive Core" by Redline Theory — the high-level built-in song
// (specs/builtin-song-content.md MUST 1: at least one song in the 9-12 band).
// Constant 185 BPM hardcore: relentless four-on-floor, driving 8th bass and a
// 16th-note E-minor riff. Charts are HYPER ☆9 and ANOTHER ☆11; the density
// comes from the same event lists that drive the synth, so every note maps to
// an audible event.
//
// Structure (beats, 4/4, 176 beats = 44 bars ≈ 57s):
//   0-8     pad swell
//   8-16    kicks enter (downbeats), bass pickup
//   16-96   main: kick every beat, snares 2&4, offbeat hats, 8th bass, riff from 32
//   96-112  breakdown: kicks to downbeats, riff continues over pad
//   112-172 finale: everything, riff transposed up, chord stabs

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

const TITLE = 'Overdrive Core';
const ARTIST = 'Redline Theory';
const GENRE = 'HARDCORE';
const BPM = 185;
const BEATS_PER_BAR = 4;
const TOTAL_BEATS = 176; // 44 bars
const SECONDS_PER_BEAT = 60 / BPM;
const MUSIC_SECONDS = TOTAL_BEATS * SECONDS_PER_BEAT;
const TAIL_SECONDS = 2;
const TOTAL_SECONDS = MUSIC_SECONDS + TAIL_SECONDS;

const BREAKDOWN_START = 96;
const FINALE_START = 112;
const LAST_EVENT_BEAT = 172;

const SONG_ID = deriveSongId(TITLE, ARTIST);
const CHART_ID_HYPER = `${SONG_ID}-hyper`;
const CHART_ID_ANOTHER = `${SONG_ID}-another`;

function beatToSec(beat) {
  return beat * SECONDS_PER_BEAT;
}

// --- pattern data (shared by audio synthesis AND chart authoring) --------------

function buildKickBeats() {
  const beats = [];
  for (let beat = 8; beat < 16; beat += 4) beats.push(beat); // pickup downbeats
  for (let beat = 16; beat < BREAKDOWN_START; beat++) beats.push(beat); // main
  for (let beat = BREAKDOWN_START; beat < FINALE_START; beat += 4) beats.push(beat); // breakdown
  for (let beat = FINALE_START; beat < LAST_EVENT_BEAT; beat++) beats.push(beat); // finale
  return beats;
}

function buildSnareBeats() {
  const beats = [];
  for (let bar = 0; bar < TOTAL_BEATS / BEATS_PER_BAR; bar++) {
    const start = bar * BEATS_PER_BAR;
    const inMain = start >= 16 && start < BREAKDOWN_START;
    const inFinale = start >= FINALE_START && start < LAST_EVENT_BEAT;
    if (inMain || inFinale) beats.push(start + 1, start + 3);
  }
  return beats;
}

function buildHatBeats() {
  const beats = [];
  for (let beat = 16; beat < BREAKDOWN_START; beat++) beats.push(beat + 0.5);
  for (let beat = FINALE_START; beat < LAST_EVENT_BEAT; beat++) beats.push(beat + 0.5);
  return beats;
}

/** Driving 8th-note bass alternating E1/E2; accents on the beat. */
function buildBassEvents() {
  const events = [];
  const addRun = (from, to) => {
    for (let beat = from; beat < to; beat += 0.5) {
      const onBeat = beat % 1 === 0;
      events.push({ beat, note: onBeat ? 'E1' : 'E2', dur: 0.5, accent: onBeat });
    }
  };
  addRun(12, BREAKDOWN_START);
  addRun(FINALE_START, LAST_EVENT_BEAT);
  // Breakdown: long root swells on downbeats.
  for (let beat = BREAKDOWN_START; beat < FINALE_START; beat += 4) {
    events.push({ beat, note: 'E1', dur: 3, accent: true });
  }
  return events;
}

// E-minor riff, 8-beat phrase with 16th-note runs. The finale transposes it up
// a fourth (A minor shape) for lift.
const RIFF_PHRASE = [
  { offset: 0, note: 'E4', dur: 0.5 },
  { offset: 0.5, note: 'G4', dur: 0.5 },
  { offset: 1, note: 'A4', dur: 0.5 },
  { offset: 1.5, note: 'E4', dur: 0.5 },
  { offset: 2, note: 'B4', dur: 0.75 },
  { offset: 2.75, note: 'A4', dur: 0.25 },
  { offset: 3, note: 'G4', dur: 0.5 },
  { offset: 3.5, note: 'E4', dur: 0.5 },
  { offset: 4, note: 'A4', dur: 0.25 },
  { offset: 4.25, note: 'B4', dur: 0.25 },
  { offset: 4.5, note: 'C5', dur: 0.5 },
  { offset: 5, note: 'A4', dur: 0.5 },
  { offset: 5.5, note: 'G4', dur: 0.5 },
  { offset: 6, note: 'E4', dur: 0.5 },
  { offset: 6.5, note: 'G4', dur: 0.5 },
  { offset: 7, note: 'A4', dur: 0.5 },
  { offset: 7.5, note: 'B4', dur: 0.5 },
];
const TRANSPOSE_FOURTH = { E4: 'A4', G4: 'C5', A4: 'D5', B4: 'E5', C5: 'F5' };

function buildRiffEvents() {
  const events = [];
  for (let phraseStart = 32; phraseStart < LAST_EVENT_BEAT; phraseStart += 8) {
    const transposed = phraseStart >= FINALE_START;
    for (const step of RIFF_PHRASE) {
      const beat = phraseStart + step.offset;
      if (beat >= LAST_EVENT_BEAT) continue;
      const note = transposed ? (TRANSPOSE_FOURTH[step.note] ?? step.note) : step.note;
      events.push({ beat, note, dur: step.dur, sixteenth: step.dur < 0.5 });
    }
  }
  return events;
}

/** Finale chord stabs on bar downbeats (audible as stacked lead notes). */
function buildStabEvents() {
  const events = [];
  for (let beat = FINALE_START; beat < LAST_EVENT_BEAT; beat += 4) {
    events.push({ beat, notes: ['A3', 'E4', 'A4'] });
  }
  return events;
}

// --- chart authoring -------------------------------------------------------------

const FIRST_NOTE_MIN_BEAT = 8;
const LAST_NOTE_MAX_BEAT = 174;

const LEAD_LANES = [1, 3, 5, 7];

function kickLane(beat) {
  const barIndex0 = Math.floor(beat / BEATS_PER_BAR);
  const isDownbeat = beat % BEATS_PER_BAR === 0;
  if (isDownbeat && barIndex0 % 2 === 1) return 0; // scratch on odd-bar downbeats
  return 4;
}

function snareLane(beat) {
  const offsetInBar = beat % BEATS_PER_BAR;
  return offsetInBar === 1 ? 6 : 2;
}

function bassLane(index) {
  return index % 2 === 0 ? 2 : 6;
}

const NOTE_TO_LANE_INDEX = {
  E4: 0,
  G4: 1,
  A4: 2,
  B4: 3,
  C5: 0,
  D5: 1,
  E5: 2,
  F5: 3,
};

function riffLane(noteName, fallbackIndex) {
  const idx = NOTE_TO_LANE_INDEX[noteName];
  return LEAD_LANES[(idx ?? fallbackIndex) % LEAD_LANES.length];
}

function buildNotes(
  { kickStride, snareStride, hatStride, bassStride, riffStride, sixteenths, stabChordSize },
  { kickBeats, snareBeats, hatBeats, bassEvents, riffEvents, stabEvents },
) {
  const notes = [];
  const seen = new Set();

  kickBeats.forEach((beat, i) => {
    if (i % kickStride !== 0) return;
    addNote(notes, seen, beat, kickLane(beat));
  });

  snareBeats.forEach((beat, i) => {
    if (i % snareStride !== 0) return;
    addNote(notes, seen, beat, snareLane(beat));
  });

  if (hatStride > 0) {
    hatBeats.forEach((beat, i) => {
      if (i % hatStride !== 0) return;
      addNote(notes, seen, beat, LEAD_LANES[i % LEAD_LANES.length]);
    });
  }

  bassEvents
    .filter((ev) => ev.accent)
    .forEach((ev, i) => {
      if (i % bassStride !== 0) return;
      addNote(notes, seen, ev.beat, bassLane(i));
    });

  riffEvents.forEach((ev, i) => {
    if (!sixteenths && ev.sixteenth) return;
    if (i % riffStride !== 0) return;
    addNote(notes, seen, ev.beat, riffLane(ev.note, i));
  });

  stabEvents.forEach((ev, i) => {
    for (let k = 0; k < stabChordSize; k++) {
      addNote(notes, seen, ev.beat, LEAD_LANES[(i + k) % LEAD_LANES.length]);
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

export function buildOverdriveCore() {
  const kickBeats = buildKickBeats();
  const snareBeats = buildSnareBeats();
  const hatBeats = buildHatBeats();
  const bassEvents = buildBassEvents();
  const riffEvents = buildRiffEvents();
  const stabEvents = buildStabEvents();

  // --- audio synthesis ---
  const totalSamples = Math.round(TOTAL_SECONDS * SAMPLE_RATE);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const rng = createSeededRng(0x3d91af5);

  for (const beat of kickBeats) {
    const s = synthKick(180, 50, 0.13); // harder, punchier hardcore kick
    addMono(left, beatToSec(beat), s, 0.55);
    addMono(right, beatToSec(beat), s, 0.55);
  }

  for (const beat of snareBeats) {
    const s = synthNoiseBurst(rng, 0.1, 0.65);
    addMono(left, beatToSec(beat), s, 0.28);
    addMono(right, beatToSec(beat), s, 0.28);
  }

  for (const beat of hatBeats) {
    const s = synthNoiseBurst(rng, 0.025, 0.85);
    addMono(left, beatToSec(beat), s, 0.11);
    addMono(right, beatToSec(beat), s, 0.11);
  }

  for (const ev of bassEvents) {
    const s = synthBassNote(noteFreq(ev.note), ev.dur * SECONDS_PER_BEAT * 0.9);
    addMono(left, beatToSec(ev.beat), s, 0.24);
    addMono(right, beatToSec(ev.beat), s, 0.24);
  }

  for (const ev of riffEvents) {
    const s = synthLeadNote(noteFreq(ev.note), 0.25 * SECONDS_PER_BEAT);
    addMono(left, beatToSec(ev.beat), s.left, 0.24);
    addMono(right, beatToSec(ev.beat), s.right, 0.24);
  }

  for (const ev of stabEvents) {
    for (const stabNote of ev.notes) {
      const s = synthLeadNote(noteFreq(stabNote), 0.5 * SECONDS_PER_BEAT);
      addMono(left, beatToSec(ev.beat), s.left, 0.13);
      addMono(right, beatToSec(ev.beat), s.right, 0.13);
    }
  }

  // Dark low pad through the whole track.
  addSustainedPad(left, right, {
    startSec: 0,
    endSec: MUSIC_SECONDS,
    attackSec: 3.0,
    releaseSec: 2.0,
    rootNote: 'E2',
    fifthNote: 'B2',
    detuneCents: 6,
    gain: 0.08,
  });

  const measuredPeak = normalizeAndAssertPeak(left, right, 'overdrive-core');
  const wav = encodeWav16Stereo(left, right, SAMPLE_RATE);

  // --- charts ---
  const events = { kickBeats, snareBeats, hatBeats, bassEvents, riffEvents, stabEvents };
  const chartHyper = buildChart(
    CHART_ID_HYPER,
    'HYPER',
    9,
    buildNotes(
      {
        kickStride: 1,
        snareStride: 1,
        hatStride: 3,
        bassStride: 2,
        riffStride: 2,
        sixteenths: false,
        stabChordSize: 1,
      },
      events,
    ),
  );
  const chartAnother = buildChart(
    CHART_ID_ANOTHER,
    'ANOTHER',
    11,
    buildNotes(
      {
        kickStride: 1,
        snareStride: 1,
        hatStride: 2,
        bassStride: 1,
        riffStride: 1,
        sixteenths: true,
        stabChordSize: 3,
      },
      events,
    ),
  );

  const invariantOpts = {
    firstNoteMinBeat: FIRST_NOTE_MIN_BEAT,
    lastNoteMaxBeat: LAST_NOTE_MAX_BEAT,
    totalBeats: TOTAL_BEATS,
  };
  assertChartInvariants(chartHyper, 'overdrive-core chart-hyper', invariantOpts);
  assertChartInvariants(chartAnother, 'overdrive-core chart-another', invariantOpts);
  assertNoteCountRange(chartHyper, 'overdrive-core chart-hyper', [380, 560]);
  assertNoteCountRange(chartAnother, 'overdrive-core chart-another', [540, 820]);

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
          chartId: CHART_ID_HYPER,
          difficulty: 'HYPER',
          level: 9,
          noteCount: chartHyper.notes.length,
          chartPath: `songs/${SONG_ID}/chart-hyper.json`,
        },
        {
          chartId: CHART_ID_ANOTHER,
          difficulty: 'ANOTHER',
          level: 11,
          noteCount: chartAnother.notes.length,
          chartPath: `songs/${SONG_ID}/chart-another.json`,
        },
      ],
      audio: `songs/${SONG_ID}/audio.wav`,
      offsetMs: 0,
      preview: { startMs: 36000, durationMs: 10000 },
      license:
        'CC0-1.0 — original programmatically generated composition (no third-party material)',
    },
    chartFiles: [
      { filename: 'chart-hyper.json', chart: chartHyper },
      { filename: 'chart-another.json', chart: chartAnother },
    ],
    wav,
    summary: [
      `chartId (hyper):   ${CHART_ID_HYPER}  notes=${chartHyper.notes.length}  total=${chartHyper.total}`,
      `chartId (another): ${CHART_ID_ANOTHER}  notes=${chartAnother.notes.length}  total=${chartAnother.total}`,
      `audio: ${MUSIC_SECONDS.toFixed(3)}s music + ${TAIL_SECONDS}s tail, ${wav.length} bytes`,
      `normalized peak: ${measuredPeak.toFixed(6)}`,
    ],
  };
}
