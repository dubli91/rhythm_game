// Practice-loop timing (specs/practice-mode.md MUST 5-6, 9).
//
// A practice session is an unbroken sequence of CYCLES on one continuous
// timeline: each cycle = a 1-bar metronome count-in (4 beats) followed by the
// pattern (bars × 4 beats), all at that cycle's BPM. Cycle start times chain
// exactly (T[k+1] = T[k] + beats × 60/bpm[k]) so 10+ loops accumulate zero
// drift by construction — every click/note/judgement time derives from the
// same T[k] values. BPM changes take effect at the next cycle boundary
// (practice-mode.md acceptance: 120→180 applies "from the next loop").
//
// Beats are BPM-independent: cycle k occupies session beats
// [k·beats, (k+1)·beats), so the renderer's beat-distance scroll stays
// continuous across a BPM change even though wall-clock cycle length changes.

import type { Note } from '../../lib/chart/types';
import type { JudgeNote } from '../play/judgement';
import type { PracticePatternNote } from './pattern';

/** One bar of metronome count-in before each pattern repetition (MUST 5). */
export const COUNT_IN_BEATS = 4;

// Inputs are routed to cycle k's judge while inputSongTimeMs <= handoffMs(k).
// 300ms is provably safe for BPM 60..400 and snap up to 1/32:
//   latest late-window end past a cycle end  = 250ms − (4/32)·(60000/400) = 231.25ms
//   earliest early-window start of the next  = 4·(60000/400) − 250ms      = 350ms
// so any constant in (231.25, 350) separates the two; no input can ever
// belong to both cycles.
export const LOOP_HANDOFF_MS = 300;

/** How far before a cycle boundary the next cycle is locked (BPM frozen,
 *  clicks scheduled, judge created). Must stay below the 350ms bound above so
 *  the next cycle's judge always exists before its first input can arrive. */
export const LOOP_PREP_AHEAD_SEC = 0.25;

export interface LoopCycle {
  index: number;
  bpm: number;
  /** COUNT_IN_BEATS + bars×4; constant for every cycle of a session. */
  beats: number;
  secPerBeat: number;
  /** Session-relative seconds (0 = clock t0, offset-free). */
  startSec: number;
  endSec: number;
  /** Continuous session beat at startSec (= index × beats). */
  startBeat: number;
}

export function cycleBeatsFor(bars: number): number {
  return COUNT_IN_BEATS + bars * 4;
}

export function firstCycle(startSec: number, bpm: number, beats: number): LoopCycle {
  const secPerBeat = 60 / bpm;
  return {
    index: 0,
    bpm,
    beats,
    secPerBeat,
    startSec,
    endSec: startSec + beats * secPerBeat,
    startBeat: 0,
  };
}

export function nextCycle(prev: LoopCycle, bpm: number): LoopCycle {
  const secPerBeat = 60 / bpm;
  return {
    index: prev.index + 1,
    bpm,
    beats: prev.beats,
    secPerBeat,
    startSec: prev.endSec,
    endSec: prev.endSec + prev.beats * secPerBeat,
    startBeat: prev.startBeat + prev.beats,
  };
}

/** Metronome clicks: one per integer cycle beat; strong on bar starts (the
 *  count-in downbeat and every 4th beat after — MUST 6 strong/weak). */
export function cycleClickTimes(cycle: LoopCycle): Array<{ timeSec: number; strong: boolean }> {
  const clicks: Array<{ timeSec: number; strong: boolean }> = [];
  for (let b = 0; b < cycle.beats; b++) {
    clicks.push({ timeSec: cycle.startSec + b * cycle.secPerBeat, strong: b % 4 === 0 });
  }
  return clicks;
}

/** Judge notes for one cycle, in session ms (offset-free — the SongClock
 *  applies the global offset to input times, same convention as song play).
 *  `laneMap` (original → display, practice shuffle MUST 15/18) substitutes
 *  lanes only — times are untouched, which is what makes judgement/stats
 *  provably shuffle-invariant. */
export function cycleJudgeNotes(
  cycle: LoopCycle,
  patternNotes: readonly PracticePatternNote[],
  laneMap?: readonly number[],
): JudgeNote[] {
  return patternNotes.map((note) => ({
    timeMs: (cycle.startSec + (COUNT_IN_BEATS + note.beat) * cycle.secPerBeat) * 1000,
    lane: laneMap === undefined ? note.lane : (laneMap[note.lane] ?? note.lane),
  }));
}

/** Renderer notes for the whole session on the continuous beat axis, loop-major
 *  (session note index = loop × patternNotes.length + pattern index). Pattern
 *  notes are sorted by beat, so the result stays ascending — the renderer's
 *  early-break culling relies on that. */
export function buildSessionNotes(
  patternNotes: readonly PracticePatternNote[],
  loops: number,
  beatsPerCycle: number,
): Note[] {
  const out: Note[] = [];
  for (let k = 0; k < loops; k++) {
    const base = k * beatsPerCycle + COUNT_IN_BEATS;
    for (const note of patternNotes) {
      out.push({ beat: base + note.beat, lane: note.lane, type: 'tap' });
    }
  }
  return out;
}

/** Continuous session beat at session time tSec. Piecewise linear over the
 *  locked cycles; extrapolates with the first/last cycle's rate outside them
 *  (negative during the lead-in, exactly like song play's negative songTime). */
export function sessionBeatAt(cycles: readonly LoopCycle[], tSec: number): number {
  const first = cycles[0];
  if (first === undefined) return 0;
  if (tSec < first.startSec) {
    return first.startBeat + (tSec - first.startSec) / first.secPerBeat;
  }
  for (let i = cycles.length - 1; i >= 0; i--) {
    const cycle = cycles[i];
    if (cycle === undefined) continue;
    if (tSec >= cycle.startSec) {
      return cycle.startBeat + (tSec - cycle.startSec) / cycle.secPerBeat;
    }
  }
  return first.startBeat;
}

/** Index of the locked cycle containing tSec, clamped to [0, cycles.length-1]. */
export function cycleIndexAt(cycles: readonly LoopCycle[], tSec: number): number {
  if (cycles.length === 0) return 0;
  for (let i = cycles.length - 1; i >= 0; i--) {
    const cycle = cycles[i];
    if (cycle === undefined) continue;
    if (tSec >= cycle.startSec) return i;
  }
  return 0;
}

/** Latest input songTimeMs still owned by this cycle's judge. */
export function handoffMs(cycle: LoopCycle): number {
  return cycle.endSec * 1000 + LOOP_HANDOFF_MS;
}
