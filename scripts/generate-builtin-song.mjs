#!/usr/bin/env node
// Generates the first built-in song ("First Light" by Prism Unit) end to end:
// synthesizes a layered synthwave track, authors NORMAL + HYPER charts from the
// SAME pattern data used to synthesize the audio (so notes line up with audible
// events), and writes public/songs/<songId>/{chart-normal,chart-hyper,audio}
// plus public/songs/index.json.
//
// specs/builtin-song-content.md MUST 4: this is the "single constant BPM, no
// BPM changes, no STOPs" vertical-slice baseline chart pair.
//
// AUDIO FORMAT NOTE: specs/builtin-song-content.md MUST 9 asks for ogg vorbis.
// No ogg/vorbis encoder is available in this environment, so this script ships
// 16-bit PCM WAV (44.1kHz stereo, peak-normalized to -1dBFS) instead.
// decodeAudioData() handles WAV natively. TODO: swap in an ogg encoder
// (e.g. run through a WASM vorbis encoder) once available, without changing
// the note-timing pipeline.
//
// Deterministic and re-runnable: no Math.random anywhere; a seeded mulberry32
// PRNG is used for noise-layer texture so re-running this script byte-for-byte
// reproduces audio.wav and both chart JSON files.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- deterministic id derivation ---------------------------------------------
// specs/builtin-song-content.md MUST 8 / specs/results-records.md SHOULD 12:
// songId/chartId are a deterministic hash of title+artist so rebuilds keep the
// same id (and thus keep local records attached).
//
// The canonical browser-side copy of fnv1a32/deriveSongId lives in
// src/lib/chart/ids.ts (this script is plain node and can't import TS); both
// copies are pinned to agree by src/lib/chart/ids.test.ts.

/** FNV-1a, 32-bit, operating on the UTF-8 bytes of `str`. Returns an unsigned uint32. */
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function deriveSongId(title, artist) {
  const key = `${title.toLowerCase()} ${artist.toLowerCase()}`;
  const hex = fnv1a32(key).toString(16).padStart(8, '0');
  return `song-${hex}`;
}

// --- seeded RNG (mulberry32) --------------------------------------------------
// Used only for noise-layer texture (snare/hat bursts); everything about note/
// event placement is derived from fixed pattern data, never from the RNG.

function createSeededRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
const SAMPLE_RATE = 44100;

const SONG_ID = deriveSongId(TITLE, ARTIST);
const CHART_ID_NORMAL = `${SONG_ID}-normal`;
const CHART_ID_HYPER = `${SONG_ID}-hyper`;

function barStartBeat(bar1based) {
  return (bar1based - 1) * BEATS_PER_BAR;
}

function beatToSec(beat) {
  return beat * SECONDS_PER_BEAT;
}

// --- pitch helpers -------------------------------------------------------------

const SEMITONE_FROM_A = {
  C: -9,
  'C#': -8,
  D: -7,
  'D#': -6,
  E: -5,
  F: -4,
  'F#': -3,
  G: -2,
  'G#': -1,
  A: 0,
  'A#': 1,
  B: 2,
};

function noteFreq(note) {
  const match = /^([A-G]#?)(\d)$/.exec(note);
  if (!match) {
    throw new Error(`noteFreq: invalid note name "${note}"`);
  }
  const [, pitchClass, octaveStr] = match;
  const semitone = SEMITONE_FROM_A[pitchClass];
  const octave = Number.parseInt(octaveStr, 10);
  return 440 * 2 ** (octave - 4 + semitone / 12);
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

const KICK_BEATS = buildKickBeats();
const SNARE_BEATS = buildSnareBeats();
const HAT_BEATS = buildHatBeats();
const BASS_EVENTS = buildBassEvents();
const LEAD_EVENTS = buildLeadEvents();

// --- audio synthesis ------------------------------------------------------------

const totalSamples = Math.round(TOTAL_SECONDS * SAMPLE_RATE);
const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);

function addMono(buf, startSec, samples, gain) {
  const startSample = Math.round(startSec * SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) {
    const idx = startSample + i;
    if (idx < 0 || idx >= buf.length) continue;
    buf[idx] += samples[i] * gain;
  }
}

function synthKick(beat) {
  const dur = 0.15;
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 45 + (150 - 45) * Math.exp(-t / 0.04);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const amp = Math.exp(-t / 0.15);
    out[i] = Math.sin(phase) * amp;
  }
  return out;
}

function synthNoiseBurst(rng, dur, highpassAlpha) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const white = rng() * 2 - 1;
    // one-pole highpass to remove rumble, keeping a "snappy" texture
    const hp = highpassAlpha * (prevOut + white - prevIn);
    prevIn = white;
    prevOut = hp;
    const amp = Math.exp(-t / (dur / 3));
    out[i] = hp * amp;
  }
  return out;
}

function synthBassNote(freq, durSec) {
  const n = Math.round(durSec * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  let lp = 0;
  const cutoffAlpha = 0.15; // one-pole lowpass coefficient
  const attackSamples = Math.round(0.005 * SAMPLE_RATE);
  const releaseSamples = Math.round(0.02 * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    phase += freq / SAMPLE_RATE;
    phase -= Math.floor(phase);
    const saw = 2 * phase - 1;
    lp = lp + cutoffAlpha * (saw - lp);
    let env = 1;
    if (i < attackSamples) env = i / attackSamples;
    else if (i > n - releaseSamples) env = Math.max(0, (n - i) / releaseSamples);
    out[i] = lp * env;
  }
  return out;
}

function synthLeadNote(freq) {
  // Detuned square/pulse pair, short plucky gate (~0.25 beat worth of audio).
  const gateSec = 0.25 * SECONDS_PER_BEAT;
  const n = Math.round(gateSec * SAMPLE_RATE);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const detuneCents = 6;
  const freqA = freq * 2 ** (-detuneCents / 1200);
  const freqB = freq * 2 ** (detuneCents / 1200);
  let phaseA = 0;
  let phaseB = 0;
  const attackSamples = Math.round(0.003 * SAMPLE_RATE);
  const releaseSamples = Math.round(0.03 * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    phaseA += freqA / SAMPLE_RATE;
    phaseA -= Math.floor(phaseA);
    phaseB += freqB / SAMPLE_RATE;
    phaseB -= Math.floor(phaseB);
    const sqA = phaseA < 0.5 ? 1 : -1;
    const sqB = phaseB < 0.5 ? 1 : -1;
    let env = 1;
    if (i < attackSamples) env = i / attackSamples;
    else if (i > n - releaseSamples) env = Math.max(0, (n - i) / releaseSamples);
    // slight stereo spread: osc A leans left, osc B leans right
    outL[i] = (sqA * 0.65 + sqB * 0.35) * env;
    outR[i] = (sqA * 0.35 + sqB * 0.65) * env;
  }
  return { left: outL, right: outR };
}

const rng = createSeededRng(0x1a5f0d3);

// Kick (mono, center)
for (const beat of KICK_BEATS) {
  const s = synthKick(beat);
  addMono(left, beatToSec(beat), s, 0.5);
  addMono(right, beatToSec(beat), s, 0.5);
}

// Snare (mono, center) ~0.12s filtered noise
for (const beat of SNARE_BEATS) {
  const s = synthNoiseBurst(rng, 0.12, 0.6);
  addMono(left, beatToSec(beat), s, 0.3);
  addMono(right, beatToSec(beat), s, 0.3);
}

// Closed hat (mono, center) ~0.03s filtered noise
for (const beat of HAT_BEATS) {
  const s = synthNoiseBurst(rng, 0.03, 0.8);
  addMono(left, beatToSec(beat), s, 0.12);
  addMono(right, beatToSec(beat), s, 0.12);
}

// Bass (mono, center)
for (const ev of BASS_EVENTS) {
  const s = synthBassNote(noteFreq(ev.note), ev.dur * SECONDS_PER_BEAT * 0.95);
  addMono(left, beatToSec(ev.beat), s, 0.22);
  addMono(right, beatToSec(ev.beat), s, 0.22);
}

// Lead (stereo spread, detuned pulse pair)
for (const ev of LEAD_EVENTS) {
  const scaleNote = PENTATONIC_SCALE[ev.degree] ?? PENTATONIC_SCALE[0];
  const s = synthLeadNote(noteFreq(scaleNote));
  addMono(left, beatToSec(ev.beat), s.left, 0.25);
  addMono(right, beatToSec(ev.beat), s.right, 0.25);
}

// Pad: two detuned sines (root + fifth of A minor), slow attack, sustained
// across the whole track, from PAD_START_BAR.
{
  const padStartSec = beatToSec(barStartBeat(PAD_START_BAR));
  const padEndSec = MUSIC_SECONDS;
  const attackSec = 2.0;
  const releaseSec = 1.5;
  const freqRoot = noteFreq('A3') * 2 ** (-4 / 1200);
  const freqRootDetuned = noteFreq('A3') * 2 ** (4 / 1200);
  const freqFifth = noteFreq('E4');
  const startSample = Math.round(padStartSec * SAMPLE_RATE);
  const endSample = Math.round(padEndSec * SAMPLE_RATE);
  let phase1 = 0;
  let phase2 = 0;
  let phase3 = 0;
  for (let idx = startSample; idx < endSample && idx < totalSamples; idx++) {
    const t = (idx - startSample) / SAMPLE_RATE;
    const tRemain = (endSample - idx) / SAMPLE_RATE;
    let env = 1;
    if (t < attackSec) env = t / attackSec;
    if (tRemain < releaseSec) env = Math.min(env, tRemain / releaseSec);
    phase1 += freqRoot / SAMPLE_RATE;
    phase1 -= Math.floor(phase1);
    phase2 += freqRootDetuned / SAMPLE_RATE;
    phase2 -= Math.floor(phase2);
    phase3 += freqFifth / SAMPLE_RATE;
    phase3 -= Math.floor(phase3);
    const sample =
      (Math.sin(2 * Math.PI * phase1) + Math.sin(2 * Math.PI * phase2)) * 0.5 +
      Math.sin(2 * Math.PI * phase3) * 0.4;
    left[idx] += sample * 0.1;
    right[idx] += sample * 0.1;
  }
}

// --- peak normalize to -1dBFS, matching src/lib/audio/wav.ts convention ----------

const TARGET_PEAK_LINEAR = 10 ** (-1 / 20);

function peakNormalize(channels, targetPeak) {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
    }
  }
  if (peak === 0) return 1;
  const gain = targetPeak / peak;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      channel[i] *= gain;
    }
  }
  return gain;
}

peakNormalize([left, right], TARGET_PEAK_LINEAR);

let measuredPeak = 0;
for (const channel of [left, right]) {
  for (let i = 0; i < channel.length; i++) {
    const magnitude = Math.abs(channel[i]);
    if (magnitude > measuredPeak) measuredPeak = magnitude;
  }
}
if (measuredPeak < 0.85 || measuredPeak > 0.895) {
  throw new Error(
    `generate-builtin-song: normalized peak ${measuredPeak} is outside the expected [0.85, 0.895] band`,
  );
}

// --- WAV encoding (16-bit PCM stereo, 44-byte RIFF header, inline) --------------

function floatToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
}

function encodeWav16Stereo(leftCh, rightCh, sampleRate) {
  const numFrames = leftCh.length;
  const numChannels = 2;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const fileSize = 44 + dataSize;

  const buffer = Buffer.alloc(fileSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    buffer.writeInt16LE(floatToInt16(leftCh[frame]), offset);
    offset += 2;
    buffer.writeInt16LE(floatToInt16(rightCh[frame]), offset);
    offset += 2;
  }
  return buffer;
}

const wavBuffer = encodeWav16Stereo(left, right, SAMPLE_RATE);

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

/** Adds a note, skipping (never overwriting) if the (lane,beat) slot is already taken. */
function addNote(notes, seen, beat, lane, type = 'tap') {
  const key = `${lane}:${beat}`;
  if (seen.has(key)) return false;
  seen.add(key);
  notes.push({ beat, lane, type });
  return true;
}

function buildNotes({ kickStride, snareStride, hatStride, bassStride, leadStride, addChords }) {
  const notes = [];
  const seen = new Set();

  KICK_BEATS.filter((b) => inNoteRange(b)).forEach((beat, i) => {
    if (i % kickStride !== 0) return;
    addNote(notes, seen, beat, kickLane(beat));
  });

  SNARE_BEATS.filter((b) => inNoteRange(b)).forEach((beat, i) => {
    if (i % snareStride !== 0) return;
    // Recover the owning bar for lane alternation (2 entries per bar).
    const bar =
      SNARE_START_BAR + Math.floor((beat - barStartBeat(SNARE_START_BAR)) / BEATS_PER_BAR);
    addNote(notes, seen, beat, snareLane(beat, bar));
  });

  if (hatStride > 0) {
    HAT_BEATS.filter((b) => inNoteRange(b)).forEach((beat, i) => {
      if (i % hatStride !== 0) return;
      addNote(notes, seen, beat, leadLane(i));
    });
  }

  if (bassStride > 0) {
    BASS_EVENTS.filter((ev) => ev.accent && inNoteRange(ev.beat)).forEach((ev, i) => {
      if (i % bassStride !== 0) return;
      addNote(notes, seen, ev.beat, bassLane(i));
    });
  }

  LEAD_EVENTS.filter((ev) => inNoteRange(ev.beat)).forEach((ev, i) => {
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

const normalNotes = buildNotes({
  kickStride: 3,
  snareStride: 2,
  hatStride: 0,
  bassStride: 4,
  leadStride: 3,
  addChords: false,
});

const hyperNotes = buildNotes({
  kickStride: 1,
  snareStride: 1,
  hatStride: 6,
  bassStride: 4,
  leadStride: 2,
  addChords: true,
});

function computeTotal(noteCount) {
  return Math.round((160 + noteCount * 0.16) * 10) / 10;
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

const chartNormal = buildChart(CHART_ID_NORMAL, 'NORMAL', 4, normalNotes);
const chartHyper = buildChart(CHART_ID_HYPER, 'HYPER', 7, hyperNotes);

// --- sanity assertions (fail loudly rather than silently shipping bad content) --

function assertChartInvariants(chart, label) {
  const notes = chart.notes;
  if (notes.length === 0) {
    throw new Error(`${label}: no notes generated`);
  }
  const first = notes[0];
  const last = notes[notes.length - 1];
  if (first.beat < FIRST_NOTE_MIN_BEAT) {
    throw new Error(`${label}: first note at beat ${first.beat} is before ${FIRST_NOTE_MIN_BEAT}`);
  }
  if (last.beat > LAST_NOTE_MAX_BEAT) {
    throw new Error(`${label}: last note at beat ${last.beat} is after ${LAST_NOTE_MAX_BEAT}`);
  }
  const seen = new Set();
  let prevBeat = Number.NEGATIVE_INFINITY;
  for (const n of notes) {
    if (n.beat < prevBeat) {
      throw new Error(`${label}: notes not sorted by beat ascending`);
    }
    prevBeat = n.beat;
    if (n.lane < 0 || n.lane > 7) {
      throw new Error(`${label}: lane ${n.lane} out of range`);
    }
    if (n.beat < 0 || n.beat >= TOTAL_BEATS) {
      throw new Error(`${label}: beat ${n.beat} out of [0, ${TOTAL_BEATS}) range`);
    }
    const key = `${n.lane}:${n.beat}`;
    if (seen.has(key)) {
      throw new Error(`${label}: duplicate (lane,beat) at ${key}`);
    }
    seen.add(key);
  }
}

assertChartInvariants(chartNormal, 'chart-normal');
assertChartInvariants(chartHyper, 'chart-hyper');

const NORMAL_RANGE = [140, 170];
const HYPER_RANGE = [280, 340];
if (chartNormal.notes.length < NORMAL_RANGE[0] || chartNormal.notes.length > NORMAL_RANGE[1]) {
  throw new Error(
    `chart-normal note count ${chartNormal.notes.length} outside target range [${NORMAL_RANGE[0]}, ${NORMAL_RANGE[1]}]`,
  );
}
if (chartHyper.notes.length < HYPER_RANGE[0] || chartHyper.notes.length > HYPER_RANGE[1]) {
  throw new Error(
    `chart-hyper note count ${chartHyper.notes.length} outside target range [${HYPER_RANGE[0]}, ${HYPER_RANGE[1]}]`,
  );
}

// --- write outputs ---------------------------------------------------------------

const songDir = join(REPO_ROOT, 'public', 'songs', SONG_ID);
mkdirSync(songDir, { recursive: true });

writeFileSync(join(songDir, 'chart-normal.json'), `${JSON.stringify(chartNormal, null, 2)}\n`);
writeFileSync(join(songDir, 'chart-hyper.json'), `${JSON.stringify(chartHyper, null, 2)}\n`);
writeFileSync(join(songDir, 'audio.wav'), wavBuffer);

const index = {
  songs: [
    {
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
  ],
};

writeFileSync(
  join(REPO_ROOT, 'public', 'songs', 'index.json'),
  `${JSON.stringify(index, null, 2)}\n`,
);

// --- listen-check summary ---------------------------------------------------------

const audioBytes = wavBuffer.length;
console.log('generate-builtin-song: OK');
console.log(`  songId: ${SONG_ID}`);
console.log(
  `  chartId (normal): ${CHART_ID_NORMAL}  notes=${chartNormal.notes.length}  total=${chartNormal.total}`,
);
console.log(
  `  chartId (hyper):  ${CHART_ID_HYPER}  notes=${chartHyper.notes.length}  total=${chartHyper.total}`,
);
console.log(
  `  audio: ${MUSIC_SECONDS}s music + ${TAIL_SECONDS}s tail = ${TOTAL_SECONDS}s, ${audioBytes} bytes`,
);
console.log(
  `  normalized peak: ${measuredPeak.toFixed(6)} (target ${TARGET_PEAK_LINEAR.toFixed(6)})`,
);
