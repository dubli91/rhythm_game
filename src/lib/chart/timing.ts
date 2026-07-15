// Beat <-> ms timing conversion (specs/chart-format.md MUST 7, specs/playfield-rendering.md MUST 5).
// This is the sync-critical core shared by judgement, rendering, and BMS mixdown: every
// consumer that needs "when does beat X sound" or "what beat is the audio clock at now"
// goes through this module.

import type { Chart, ChartTiming } from './types';

export interface TimingIndex {
  beatToMs(beat: number): number;
  msToBeat(ms: number): number;
}

/**
 * A control point marks a beat where the BPM and/or the STOP state can change.
 * `msAtBeat` is the time the timeline reaches `beat`, BEFORE any STOP that starts there.
 * `departMs` is the time the timeline resumes advancing past `beat`, AFTER that STOP.
 * `msPerBeat` is the rate in effect for beats strictly greater than `beat` (i.e. after any
 * BPM change that lands exactly on this beat).
 */
interface ControlPoint {
  beat: number;
  msAtBeat: number;
  departMs: number;
  msPerBeat: number;
}

function msPerBeatFromBpm(bpm: number): number {
  return 60000 / bpm;
}

function validateTiming(timing: ChartTiming): void {
  const { bpmEvents, stopEvents } = timing;

  const first = bpmEvents[0];
  if (first === undefined) {
    throw new Error('ChartTiming.bpmEvents must not be empty');
  }
  if (first.beat !== 0) {
    throw new Error(`ChartTiming.bpmEvents[0] must be at beat 0, got beat ${first.beat}`);
  }

  let prevBpmBeat = first.beat;
  for (let i = 0; i < bpmEvents.length; i++) {
    const event = bpmEvents[i];
    if (event === undefined) {
      continue;
    }
    if (event.bpm <= 0) {
      throw new Error(`ChartTiming.bpmEvents[${i}].bpm must be > 0, got ${event.bpm}`);
    }
    if (i > 0 && event.beat <= prevBpmBeat) {
      throw new Error('ChartTiming.bpmEvents must be sorted ascending by beat');
    }
    prevBpmBeat = event.beat;
  }

  let prevStopBeat = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < stopEvents.length; i++) {
    const event = stopEvents[i];
    if (event === undefined) {
      continue;
    }
    if (event.durationBeats <= 0) {
      throw new Error(
        `ChartTiming.stopEvents[${i}].durationBeats must be > 0, got ${event.durationBeats}`,
      );
    }
    if (event.beat <= prevStopBeat) {
      throw new Error('ChartTiming.stopEvents must be sorted ascending by beat');
    }
    prevStopBeat = event.beat;
  }
}

function buildControlPoints(timing: ChartTiming): ControlPoint[] {
  const { bpmEvents, stopEvents } = timing;

  const firstBpmEvent = bpmEvents[0];
  if (firstBpmEvent === undefined) {
    // Unreachable once validateTiming() has run; kept for noUncheckedIndexedAccess safety.
    throw new Error('ChartTiming.bpmEvents must not be empty');
  }

  const beatSet = new Set<number>();
  for (const event of bpmEvents) {
    beatSet.add(event.beat);
  }
  for (const event of stopEvents) {
    beatSet.add(event.beat);
  }
  const beats = Array.from(beatSet).sort((a, b) => a - b);

  const points: ControlPoint[] = [];
  let currentMsPerBeat = msPerBeatFromBpm(firstBpmEvent.bpm);
  let lastBeat = 0;
  let cumMs = 0;
  let bpmIdx = 0;
  let stopIdx = 0;

  for (const beat of beats) {
    // Arrival time at `beat` is an instantaneous point, so it only depends on the rate that
    // was in effect for beats strictly before it, never on a BPM change landing exactly here.
    if (points.length > 0) {
      cumMs += (beat - lastBeat) * currentMsPerBeat;
    }
    const msAtBeat = cumMs;

    // A BPM change at this beat takes effect before any STOP at the same beat is measured,
    // so a same-beat STOP's duration is computed using the NEW bpm.
    while (bpmIdx < bpmEvents.length) {
      const event = bpmEvents[bpmIdx];
      if (event === undefined || event.beat !== beat) {
        break;
      }
      currentMsPerBeat = msPerBeatFromBpm(event.bpm);
      bpmIdx++;
    }

    let stopMs = 0;
    while (stopIdx < stopEvents.length) {
      const event = stopEvents[stopIdx];
      if (event === undefined || event.beat !== beat) {
        break;
      }
      stopMs += event.durationBeats * currentMsPerBeat;
      stopIdx++;
    }

    const departMs = msAtBeat + stopMs;
    points.push({ beat, msAtBeat, departMs, msPerBeat: currentMsPerBeat });
    lastBeat = beat;
    cumMs = departMs;
  }

  return points;
}

function findLastIndexMatching(
  points: ControlPoint[],
  predicate: (point: ControlPoint) => boolean,
): number {
  let lo = 0;
  let hi = points.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid];
    if (point === undefined) {
      break;
    }
    if (predicate(point)) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export function createTimingIndex(timing: ChartTiming): TimingIndex {
  validateTiming(timing);
  const points = buildControlPoints(timing);

  const maybeFirstPoint = points[0];
  if (maybeFirstPoint === undefined) {
    // Unreachable: validateTiming() guarantees at least the beat-0 BPM event.
    throw new Error('ChartTiming produced no control points');
  }
  const firstPoint: ControlPoint = maybeFirstPoint;

  function beatToMs(beat: number): number {
    const idx = findLastIndexMatching(points, (p) => p.beat <= beat);
    if (idx === -1) {
      // Before beat 0: extrapolate with the initial BPM. Use msAtBeat (not departMs) so a
      // STOP placed at beat 0 never leaks backward into the lead-in region.
      return firstPoint.msAtBeat + (beat - firstPoint.beat) * firstPoint.msPerBeat;
    }
    const point = points[idx];
    if (point === undefined) {
      throw new Error('timing index: control point lookup out of range');
    }
    if (beat === point.beat) {
      // Stop-inclusivity convention: a note exactly at a STOP's beat sounds when the STOP
      // begins, so the exact boundary excludes the STOP duration.
      return point.msAtBeat;
    }
    return point.departMs + (beat - point.beat) * point.msPerBeat;
  }

  function msToBeat(ms: number): number {
    const idx = findLastIndexMatching(points, (p) => p.msAtBeat <= ms);
    if (idx === -1) {
      return firstPoint.beat + (ms - firstPoint.msAtBeat) / firstPoint.msPerBeat;
    }
    const point = points[idx];
    if (point === undefined) {
      throw new Error('timing index: control point lookup out of range');
    }
    if (ms <= point.departMs) {
      // Inside (or at the edges of) a STOP's frozen interval: beat position is constant.
      return point.beat;
    }
    return point.beat + (ms - point.departMs) / point.msPerBeat;
  }

  return { beatToMs, msToBeat };
}

/** Returns array parallel to chart.notes; for CN notes this is the head time (endBeat handled by callers). */
export function computeNoteTimesMs(chart: Chart): number[] {
  const index = createTimingIndex(chart.timing);
  return chart.notes.map((note) => index.beatToMs(note.beat));
}
