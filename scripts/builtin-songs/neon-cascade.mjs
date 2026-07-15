// "Neon Cascade" by Aurora Vector — the BPM-change/STOP showcase song
// (specs/builtin-song-content.md MUST 3): two BPM changes (140 -> 175 -> 140)
// plus a 2-beat STOP that lands ON the first BPM-change beat, deliberately
// exercising the pinned same-beat rule (the STOP duration uses the NEW bpm)
// on a real content path. Audio events are placed with the same control-point
// clock semantics as src/lib/chart/timing.ts, so chart timing and audible
// events stay in sync across the tempo map.
//
// Structure (beats, 4/4):
//   0-16    intro: pad + downbeat kicks
//   16-48   groove @140: four-on-floor, offbeat hats, 2-bar bass cycle, snares
//   32-60   arp joins (8th-note A-minor arpeggio)
//   48-60   break: kicks thin out to downbeats
//   60-64   riser only — everything else drops out
//   64      crash + STOP (2 beats @175 ≈ 0.686s of frozen scroll, pad sustains)
//   64-96   drop @175: kick every beat, snares 2&4, hats, driving 8th bass, lead riff
//   96-128  outro @140: half-time kicks, sparse melody, pad fades

import {
  SAMPLE_RATE,
  addMono,
  addNote,
  addSustainedPad,
  assertChartInvariants,
  assertNoteCountRange,
  computeTotal,
  createBeatClock,
  createSeededRng,
  deriveSongId,
  encodeWav16Stereo,
  normalizeAndAssertPeak,
  noteFreq,
  synthBassNote,
  synthKick,
  synthLeadNote,
  synthNoiseBurst,
  synthNoiseRiser,
} from './lib.mjs';

// --- song constants ------------------------------------------------------------

const TITLE = 'Neon Cascade';
const ARTIST = 'Aurora Vector';
const GENRE = 'ELECTRO';
const BPM_MAIN = 140;
const BPM_DROP = 175;
const BEATS_PER_BAR = 4;
const TOTAL_BEATS = 128; // 32 bars
const TAIL_SECONDS = 2;

const DROP_BEAT = 64; // BPM change AND stop land here
const OUTRO_BEAT = 96; // BPM back to main
const STOP_BEATS = 2;

const BPM_EVENTS = [
  { beat: 0, bpm: BPM_MAIN },
  { beat: DROP_BEAT, bpm: BPM_DROP },
  { beat: OUTRO_BEAT, bpm: BPM_MAIN },
];
const STOP_EVENTS = [{ beat: DROP_BEAT, durationBeats: STOP_BEATS }];

const SONG_ID = deriveSongId(TITLE, ARTIST);
const CHART_ID_NORMAL = `${SONG_ID}-normal`;
const CHART_ID_HYPER = `${SONG_ID}-hyper`;

const clock = createBeatClock(BPM_EVENTS, STOP_EVENTS);
const beatToSec = clock.beatToSec;
const MUSIC_SECONDS = beatToSec(TOTAL_BEATS);
const TOTAL_SECONDS = MUSIC_SECONDS + TAIL_SECONDS;

const SEC_PER_BEAT_MAIN = 60 / BPM_MAIN;
const SEC_PER_BEAT_DROP = 60 / BPM_DROP;

// --- pattern data (shared by audio synthesis AND chart authoring) --------------

/** Kicks: downbeats in the intro/break/outro, every beat in groove and drop. */
function buildKickBeats() {
  const beats = [];
  for (let beat = 4; beat < 16; beat += 4) beats.push(beat); // intro downbeats
  for (let beat = 16; beat < 48; beat++) beats.push(beat); // groove four-on-floor
  for (let beat = 48; beat < 60; beat += 4) beats.push(beat); // break downbeats
  for (let beat = DROP_BEAT; beat < OUTRO_BEAT; beat++) beats.push(beat); // drop
  for (let beat = OUTRO_BEAT; beat < 124; beat += 2) beats.push(beat); // outro half-time
  return beats;
}

/** Snares on beats 2 & 4 of each bar in the groove and drop sections. */
function buildSnareBeats() {
  const beats = [];
  for (let bar = 0; bar < TOTAL_BEATS / BEATS_PER_BAR; bar++) {
    const start = bar * BEATS_PER_BAR;
    const inGroove = start >= 16 && start < 48;
    const inDrop = start >= DROP_BEAT && start < OUTRO_BEAT;
    if (inGroove || inDrop) beats.push(start + 1, start + 3);
  }
  return beats;
}

/** Offbeat hats through the groove and drop. */
function buildHatBeats() {
  const beats = [];
  for (let beat = 16; beat < 48; beat++) beats.push(beat + 0.5);
  for (let beat = DROP_BEAT; beat < OUTRO_BEAT; beat++) beats.push(beat + 0.5);
  return beats;
}

// Groove bass: A-minor 2-bar (8-beat) cycle, beats 8-60. Accents (dur >= 1)
// are the chartable events.
const GROOVE_BASS_PATTERN = [
  { offset: 0, note: 'A1', dur: 1.0 },
  { offset: 1.5, note: 'A1', dur: 0.5 },
  { offset: 2, note: 'E2', dur: 1.0 },
  { offset: 3.5, note: 'G2', dur: 0.5 },
  { offset: 4, note: 'D2', dur: 1.0 },
  { offset: 5.5, note: 'C2', dur: 0.5 },
  { offset: 6, note: 'E2', dur: 1.0 },
  { offset: 7, note: 'G2', dur: 1.0 },
];

function buildBassEvents() {
  const events = [];
  for (let cycleStart = 8; cycleStart < 60; cycleStart += 8) {
    for (const step of GROOVE_BASS_PATTERN) {
      const beat = cycleStart + step.offset;
      if (beat >= 60) continue;
      events.push({ beat, note: step.note, dur: step.dur, accent: step.dur >= 1 });
    }
  }
  // Drop bass: driving 8ths alternating A1/A2, every offbeat accented on the beat.
  for (let beat = DROP_BEAT; beat < OUTRO_BEAT; beat += 0.5) {
    const onBeat = beat % 1 === 0;
    events.push({ beat, note: onBeat ? 'A1' : 'A2', dur: 0.5, accent: onBeat });
  }
  // Outro: downbeat accents only.
  for (let beat = OUTRO_BEAT; beat < 124; beat += 4) {
    events.push({ beat, note: 'A1', dur: 2, accent: true });
  }
  return events;
}

// Build-section arpeggio: 8th-note A-minor loop, beats 32-60.
const ARP_CYCLE = ['A4', 'C5', 'E5', 'A5', 'E5', 'C5'];

function buildArpEvents() {
  const events = [];
  let step = 0;
  for (let beat = 32; beat < 60; beat += 0.5, step++) {
    events.push({ beat, note: ARP_CYCLE[step % ARP_CYCLE.length], degree: step % 4 });
  }
  return events;
}

// Drop lead: 8-beat phrase with 16th flourishes, repeated across the drop with
// a per-repeat transpose variant; outro reuses it sparsely at quarter density.
const DROP_PHRASE = [
  { offset: 0, note: 'A4', dur: 1 },
  { offset: 1, note: 'C5', dur: 0.5 },
  { offset: 1.5, note: 'D5', dur: 0.5 },
  { offset: 2, note: 'E5', dur: 1 },
  { offset: 3, note: 'D5', dur: 0.5 },
  { offset: 3.5, note: 'C5', dur: 0.5 },
  { offset: 4, note: 'A4', dur: 1 },
  { offset: 5, note: 'E5', dur: 0.5 },
  { offset: 5.25, note: 'D5', dur: 0.25 },
  { offset: 5.5, note: 'C5', dur: 0.5 },
  { offset: 6, note: 'D5', dur: 0.5 },
  { offset: 6.5, note: 'E5', dur: 0.5 },
  { offset: 7, note: 'A5', dur: 1 },
];
const TRANSPOSE_UP = { A4: 'C5', C5: 'E5', D5: 'G5', E5: 'A5', G5: 'C6', A5: 'E5' };

function buildLeadEvents() {
  const events = [];
  let repeat = 0;
  for (let phraseStart = DROP_BEAT; phraseStart < OUTRO_BEAT; phraseStart += 8, repeat++) {
    for (const step of DROP_PHRASE) {
      const beat = phraseStart + step.offset;
      if (beat >= OUTRO_BEAT) continue;
      const note = repeat % 2 === 1 ? (TRANSPOSE_UP[step.note] ?? step.note) : step.note;
      events.push({ beat, note, dur: step.dur, sixteenth: step.dur < 0.5 });
    }
  }
  // Outro melody: sparse falling quarter notes.
  const OUTRO_NOTES = ['E5', 'D5', 'C5', 'A4'];
  let i = 0;
  for (let beat = OUTRO_BEAT + 2; beat < 124; beat += 4, i++) {
    events.push({ beat, note: OUTRO_NOTES[i % OUTRO_NOTES.length], dur: 1, sixteenth: false });
  }
  events.sort((a, b) => a.beat - b.beat);
  return events;
}

// --- chart authoring -------------------------------------------------------------

const FIRST_NOTE_MIN_BEAT = 4;
const LAST_NOTE_MAX_BEAT = 126;

const LEAD_LANES = [1, 3, 5, 7];

function kickLane(beat) {
  const barIndex0 = Math.floor(beat / BEATS_PER_BAR);
  const isDownbeat = beat % BEATS_PER_BAR === 0;
  if (isDownbeat && barIndex0 % 2 === 0) return 0; // scratch on downbeats every 2 bars
  return 4;
}

function snareLane(beat) {
  const offsetInBar = beat % BEATS_PER_BAR;
  return offsetInBar === 1 ? 2 : 6;
}

function bassLane(index) {
  return index % 2 === 0 ? 2 : 6;
}

const NOTE_TO_LANE_INDEX = {
  A4: 0,
  C5: 1,
  D5: 2,
  E5: 3,
  G5: 0,
  A5: 1,
  C6: 2,
  E4: 3,
};

function melodyLane(noteName, fallbackIndex) {
  const idx = NOTE_TO_LANE_INDEX[noteName];
  return LEAD_LANES[(idx ?? fallbackIndex) % LEAD_LANES.length];
}

function buildNotes(
  { kickStride, snareStride, hatStride, bassStride, arpStride, leadStride, sixteenths, addChords },
  { kickBeats, snareBeats, hatBeats, bassEvents, arpEvents, leadEvents },
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

  arpEvents.forEach((ev, i) => {
    if (i % arpStride !== 0) return;
    addNote(notes, seen, ev.beat, melodyLane(ev.note, ev.degree));
  });

  leadEvents.forEach((ev, i) => {
    if (!sixteenths && ev.sixteenth) return;
    if (i % leadStride !== 0) return;
    const lane = melodyLane(ev.note, i);
    const added = addNote(notes, seen, ev.beat, lane);
    if (added && addChords && ev.dur >= 1) {
      const harmonyLane = LEAD_LANES[(LEAD_LANES.indexOf(lane) + 2) % LEAD_LANES.length];
      addNote(notes, seen, ev.beat, harmonyLane);
    }
  });

  // The crash that marks the STOP boundary is always chartable: a scratch note
  // exactly AT the stop beat pins the "note at a STOP's beat sounds when the
  // STOP begins" rule into shipped content.
  addNote(notes, seen, DROP_BEAT, 0);

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
    bpm: { init: BPM_MAIN, min: BPM_MAIN, max: BPM_DROP },
    timing: {
      bpmEvents: BPM_EVENTS.map((e) => ({ ...e })),
      stopEvents: STOP_EVENTS.map((e) => ({ ...e })),
    },
    notes,
  };
}

// --- build ------------------------------------------------------------------------

export function buildNeonCascade() {
  const kickBeats = buildKickBeats();
  const snareBeats = buildSnareBeats();
  const hatBeats = buildHatBeats();
  const bassEvents = buildBassEvents();
  const arpEvents = buildArpEvents();
  const leadEvents = buildLeadEvents();

  // --- audio synthesis ---
  const totalSamples = Math.round(TOTAL_SECONDS * SAMPLE_RATE);
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const rng = createSeededRng(0x2b7c1e9);

  const secPerBeatAt = (beat) =>
    beat >= DROP_BEAT && beat < OUTRO_BEAT ? SEC_PER_BEAT_DROP : SEC_PER_BEAT_MAIN;

  for (const beat of kickBeats) {
    const s = synthKick(160, 45, 0.14);
    addMono(left, beatToSec(beat), s, 0.5);
    addMono(right, beatToSec(beat), s, 0.5);
  }

  for (const beat of snareBeats) {
    const s = synthNoiseBurst(rng, 0.12, 0.6);
    addMono(left, beatToSec(beat), s, 0.3);
    addMono(right, beatToSec(beat), s, 0.3);
  }

  for (const beat of hatBeats) {
    const s = synthNoiseBurst(rng, 0.03, 0.8);
    addMono(left, beatToSec(beat), s, 0.12);
    addMono(right, beatToSec(beat), s, 0.12);
  }

  for (const ev of bassEvents) {
    const s = synthBassNote(noteFreq(ev.note), ev.dur * secPerBeatAt(ev.beat) * 0.95);
    addMono(left, beatToSec(ev.beat), s, 0.22);
    addMono(right, beatToSec(ev.beat), s, 0.22);
  }

  for (const ev of arpEvents) {
    const s = synthLeadNote(noteFreq(ev.note), 0.25 * secPerBeatAt(ev.beat));
    addMono(left, beatToSec(ev.beat), s.left, 0.2);
    addMono(right, beatToSec(ev.beat), s.right, 0.2);
  }

  for (const ev of leadEvents) {
    const s = synthLeadNote(noteFreq(ev.note), 0.3 * secPerBeatAt(ev.beat));
    addMono(left, beatToSec(ev.beat), s.left, 0.25);
    addMono(right, beatToSec(ev.beat), s.right, 0.25);
  }

  // Riser sweeping beats 60-64 into the stop, crash at the stop boundary. The
  // crash decays THROUGH the ~0.686s frozen-scroll window (only the pad and
  // crash tail sound while the beat clock is stopped).
  {
    const riserStart = beatToSec(60);
    const riserDur = beatToSec(DROP_BEAT) - riserStart;
    const riser = synthNoiseRiser(rng, riserDur, 0.55);
    addMono(left, riserStart, riser, 0.28);
    addMono(right, riserStart, riser, 0.28);

    const crash = synthNoiseBurst(rng, 0.9, 0.45);
    addMono(left, beatToSec(DROP_BEAT), crash, 0.4);
    addMono(right, beatToSec(DROP_BEAT), crash, 0.4);
  }

  // Pad sustains from the top of the song to the end, straight through the STOP.
  addSustainedPad(left, right, {
    startSec: 0,
    endSec: MUSIC_SECONDS,
    attackSec: 2.5,
    releaseSec: 2.0,
    rootNote: 'A2',
    fifthNote: 'E3',
    detuneCents: 5,
    gain: 0.09,
  });

  const measuredPeak = normalizeAndAssertPeak(left, right, 'neon-cascade');
  const wav = encodeWav16Stereo(left, right, SAMPLE_RATE);

  // --- charts ---
  const events = { kickBeats, snareBeats, hatBeats, bassEvents, arpEvents, leadEvents };
  const chartNormal = buildChart(
    CHART_ID_NORMAL,
    'NORMAL',
    6,
    buildNotes(
      {
        kickStride: 2,
        snareStride: 1,
        hatStride: 0,
        bassStride: 2,
        arpStride: 2,
        leadStride: 1,
        sixteenths: false,
        addChords: false,
      },
      events,
    ),
  );
  const chartHyper = buildChart(
    CHART_ID_HYPER,
    'HYPER',
    8,
    buildNotes(
      {
        kickStride: 1,
        snareStride: 1,
        hatStride: 4,
        bassStride: 1,
        arpStride: 1,
        leadStride: 1,
        sixteenths: true,
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
  assertChartInvariants(chartNormal, 'neon-cascade chart-normal', invariantOpts);
  assertChartInvariants(chartHyper, 'neon-cascade chart-hyper', invariantOpts);
  assertNoteCountRange(chartNormal, 'neon-cascade chart-normal', [160, 280]);
  assertNoteCountRange(chartHyper, 'neon-cascade chart-hyper', [320, 480]);

  return {
    songId: SONG_ID,
    entry: {
      songId: SONG_ID,
      title: TITLE,
      artist: ARTIST,
      genre: GENRE,
      bpm: { min: BPM_MAIN, max: BPM_DROP },
      charts: [
        {
          chartId: CHART_ID_NORMAL,
          difficulty: 'NORMAL',
          level: 6,
          noteCount: chartNormal.notes.length,
          chartPath: `songs/${SONG_ID}/chart-normal.json`,
        },
        {
          chartId: CHART_ID_HYPER,
          difficulty: 'HYPER',
          level: 8,
          noteCount: chartHyper.notes.length,
          chartPath: `songs/${SONG_ID}/chart-hyper.json`,
        },
      ],
      audio: `songs/${SONG_ID}/audio.wav`,
      offsetMs: 0,
      preview: { startMs: 28000, durationMs: 10000 },
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
      `bpm map: 140 -> 175 @ beat ${DROP_BEAT} (with ${STOP_BEATS}-beat STOP) -> 140 @ beat ${OUTRO_BEAT}`,
      `audio: ${MUSIC_SECONDS.toFixed(3)}s music + ${TAIL_SECONDS}s tail, ${wav.length} bytes`,
      `normalized peak: ${measuredPeak.toFixed(6)}`,
    ],
  };
}
