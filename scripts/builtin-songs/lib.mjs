// Shared helpers for the built-in song generators (scripts/builtin-songs/*.mjs).
// Everything here is deterministic: no Math.random, no Date — re-running the
// generator reproduces every byte of public/songs/.

// --- deterministic id derivation ---------------------------------------------
// specs/builtin-song-content.md MUST 8 / specs/results-records.md SHOULD 12:
// songId/chartId are a deterministic hash of title+artist so rebuilds keep the
// same id (and thus keep local records attached).
//
// The canonical browser-side copy of fnv1a32/deriveSongId lives in
// src/lib/chart/ids.ts (this script is plain node and can't import TS); both
// copies are pinned to agree by src/lib/chart/ids.test.ts.

/** FNV-1a, 32-bit, operating on the UTF-8 bytes of `str`. Returns an unsigned uint32. */
export function fnv1a32(str) {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function deriveSongId(title, artist) {
  const key = `${title.toLowerCase()} ${artist.toLowerCase()}`;
  const hex = fnv1a32(key).toString(16).padStart(8, '0');
  return `song-${hex}`;
}

// --- seeded RNG (mulberry32) --------------------------------------------------
// Used only for noise-layer texture (snare/hat bursts); everything about note/
// event placement is derived from fixed pattern data, never from the RNG.

export function createSeededRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

export function noteFreq(note) {
  const match = /^([A-G]#?)(\d)$/.exec(note);
  if (!match) {
    throw new Error(`noteFreq: invalid note name "${note}"`);
  }
  const [, pitchClass, octaveStr] = match;
  const semitone = SEMITONE_FROM_A[pitchClass];
  const octave = Number.parseInt(octaveStr, 10);
  return 440 * 2 ** (octave - 4 + semitone / 12);
}

// --- beat -> seconds clock -------------------------------------------------------
// Mirror of src/lib/chart/timing.ts control-point semantics, in seconds. The
// audio synthesis MUST place events with this exact clock so that the beat the
// chart says a note is on and the second the audible event lands on agree —
// this is what makes the BPM-change/STOP showcase song a real-usage validation
// of the timing pipeline (specs/builtin-song-content.md MUST 3).
//
// Semantics pinned by src/lib/chart/timing.test.ts:
//  - a BPM change at a beat applies BEFORE a same-beat STOP (the STOP duration
//    uses the NEW bpm);
//  - an event exactly at a STOP's beat sounds when the STOP begins (arrival
//    time excludes the STOP duration); events after it are delayed by it.

export function createBeatClock(bpmEvents, stopEvents = []) {
  const first = bpmEvents[0];
  if (first === undefined || first.beat !== 0) {
    throw new Error('createBeatClock: bpmEvents must start with a beat-0 event');
  }

  const beatSet = new Set();
  for (const event of bpmEvents) beatSet.add(event.beat);
  for (const event of stopEvents) beatSet.add(event.beat);
  const beats = Array.from(beatSet).sort((a, b) => a - b);

  const points = [];
  let currentSecPerBeat = 60 / first.bpm;
  let lastBeat = 0;
  let cumSec = 0;
  let bpmIdx = 0;
  let stopIdx = 0;

  for (const beat of beats) {
    if (points.length > 0) {
      cumSec += (beat - lastBeat) * currentSecPerBeat;
    }
    const secAtBeat = cumSec;

    while (bpmIdx < bpmEvents.length && bpmEvents[bpmIdx].beat === beat) {
      currentSecPerBeat = 60 / bpmEvents[bpmIdx].bpm;
      bpmIdx++;
    }

    let stopSec = 0;
    while (stopIdx < stopEvents.length && stopEvents[stopIdx].beat === beat) {
      stopSec += stopEvents[stopIdx].durationBeats * currentSecPerBeat;
      stopIdx++;
    }

    points.push({ beat, secAtBeat, departSec: secAtBeat + stopSec, secPerBeat: currentSecPerBeat });
    lastBeat = beat;
    cumSec = secAtBeat + stopSec;
  }

  function beatToSec(beat) {
    let point = null;
    for (const p of points) {
      if (p.beat <= beat) point = p;
      else break;
    }
    if (point === null) {
      const firstPoint = points[0];
      return firstPoint.secAtBeat + (beat - firstPoint.beat) * firstPoint.secPerBeat;
    }
    if (beat === point.beat) return point.secAtBeat;
    return point.departSec + (beat - point.beat) * point.secPerBeat;
  }

  return { beatToSec };
}

// --- synth voices ----------------------------------------------------------------

export const SAMPLE_RATE = 44100;

export function addMono(buf, startSec, samples, gain) {
  const startSample = Math.round(startSec * SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) {
    const idx = startSample + i;
    if (idx < 0 || idx >= buf.length) continue;
    buf[idx] += samples[i] * gain;
  }
}

export function synthKick(startFreq = 150, endFreq = 45, dur = 0.15) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const freq = endFreq + (startFreq - endFreq) * Math.exp(-t / 0.04);
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const amp = Math.exp(-t / dur);
    out[i] = Math.sin(phase) * amp;
  }
  return out;
}

export function synthNoiseBurst(rng, dur, highpassAlpha) {
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

/** Reversed noise swell (riser): amplitude grows toward the END of the buffer. */
export function synthNoiseRiser(rng, dur, highpassAlpha) {
  const n = Math.round(dur * SAMPLE_RATE);
  const out = new Float32Array(n);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < n; i++) {
    const tRemain = (n - i) / SAMPLE_RATE;
    const white = rng() * 2 - 1;
    const hp = highpassAlpha * (prevOut + white - prevIn);
    prevIn = white;
    prevOut = hp;
    const amp = Math.exp(-tRemain / (dur / 3));
    out[i] = hp * amp;
  }
  return out;
}

export function synthBassNote(freq, durSec) {
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

/** Detuned square/pulse pair, short plucky gate; returns stereo {left, right}. */
export function synthLeadNote(freq, gateSec) {
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

/**
 * Sustained detuned-sine pad written directly into the stereo buffers
 * (root ± detune cents + a fifth), slow attack/release. Mix shape matches the
 * original First Light pad exactly: (sin+sin)*0.5 + sin*0.4, per-buffer gain.
 */
export function addSustainedPad(left, right, opts) {
  const {
    startSec,
    endSec,
    attackSec,
    releaseSec,
    rootNote,
    fifthNote,
    detuneCents = 4,
    gain = 0.1,
  } = opts;
  const freqRoot = noteFreq(rootNote) * 2 ** (-detuneCents / 1200);
  const freqRootDetuned = noteFreq(rootNote) * 2 ** (detuneCents / 1200);
  const freqFifth = noteFreq(fifthNote);
  const startSample = Math.round(startSec * SAMPLE_RATE);
  const endSample = Math.round(endSec * SAMPLE_RATE);
  let phase1 = 0;
  let phase2 = 0;
  let phase3 = 0;
  for (let idx = startSample; idx < endSample && idx < left.length; idx++) {
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
    left[idx] += sample * gain;
    right[idx] += sample * gain;
  }
}

// --- peak normalize to -1dBFS, matching src/lib/audio/wav.ts convention ----------

export const TARGET_PEAK_LINEAR = 10 ** (-1 / 20);

export function peakNormalize(channels, targetPeak) {
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

/** Normalizes in place and fails loudly if the post-normalize peak drifts from target. */
export function normalizeAndAssertPeak(left, right, label) {
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
      `${label}: normalized peak ${measuredPeak} is outside the expected [0.85, 0.895] band`,
    );
  }
  return measuredPeak;
}

// --- WAV encoding (16-bit PCM stereo, 44-byte RIFF header, inline) --------------

function floatToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
}

export function encodeWav16Stereo(leftCh, rightCh, sampleRate) {
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

// --- chart helpers ----------------------------------------------------------------

/** BMS #TOTAL heritage default: 160 + notes*0.16, rounded to 1 decimal (specs/bms-import.md). */
export function computeTotal(noteCount) {
  return Math.round((160 + noteCount * 0.16) * 10) / 10;
}

/** Adds a note, skipping (never overwriting) if the (lane,beat) slot is already taken. */
export function addNote(notes, seen, beat, lane, type = 'tap') {
  const key = `${lane}:${beat}`;
  if (seen.has(key)) return false;
  seen.add(key);
  notes.push({ beat, lane, type });
  return true;
}

// --- sanity assertions (fail loudly rather than silently shipping bad content) --

export function assertChartInvariants(
  chart,
  label,
  { firstNoteMinBeat, lastNoteMaxBeat, totalBeats },
) {
  const notes = chart.notes;
  if (notes.length === 0) {
    throw new Error(`${label}: no notes generated`);
  }
  const first = notes[0];
  const last = notes[notes.length - 1];
  if (first.beat < firstNoteMinBeat) {
    throw new Error(`${label}: first note at beat ${first.beat} is before ${firstNoteMinBeat}`);
  }
  if (last.beat > lastNoteMaxBeat) {
    throw new Error(`${label}: last note at beat ${last.beat} is after ${lastNoteMaxBeat}`);
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
    if (n.beat < 0 || n.beat >= totalBeats) {
      throw new Error(`${label}: beat ${n.beat} out of [0, ${totalBeats}) range`);
    }
    const key = `${n.lane}:${n.beat}`;
    if (seen.has(key)) {
      throw new Error(`${label}: duplicate (lane,beat) at ${key}`);
    }
    seen.add(key);
  }
}

export function assertNoteCountRange(chart, label, [min, max]) {
  if (chart.notes.length < min || chart.notes.length > max) {
    throw new Error(
      `${label} note count ${chart.notes.length} outside target range [${min}, ${max}]`,
    );
  }
}
