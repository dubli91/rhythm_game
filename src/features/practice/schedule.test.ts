// Loop-timeline math tests (practice-mode.md MUST 5-6, 9 + acceptance criteria:
// zero drift over 10 loops, BPM change lands exactly at the next loop boundary).

import { describe, expect, it } from 'vitest';
import { DEFAULT_JUDGEMENT_WINDOWS_MS } from '../play/judgement';
import type { PracticePatternNote } from './pattern';
import {
  COUNT_IN_BEATS,
  LOOP_HANDOFF_MS,
  LOOP_PREP_AHEAD_SEC,
  type LoopCycle,
  buildSessionNotes,
  cycleBeatsFor,
  cycleClickTimes,
  cycleIndexAt,
  cycleJudgeNotes,
  firstCycle,
  handoffMs,
  nextCycle,
  sessionBeatAt,
} from './schedule';

function lockCycles(startSec: number, beats: number, bpms: readonly number[]): LoopCycle[] {
  const cycles: LoopCycle[] = [];
  for (const bpm of bpms) {
    const prev = cycles[cycles.length - 1];
    cycles.push(prev === undefined ? firstCycle(startSec, bpm, beats) : nextCycle(prev, bpm));
  }
  return cycles;
}

describe('cycleBeatsFor', () => {
  it('adds the 1-bar count-in to the pattern length', () => {
    expect(cycleBeatsFor(1)).toBe(8);
    expect(cycleBeatsFor(4)).toBe(20);
    expect(cycleBeatsFor(8)).toBe(36);
  });
});

describe('cycle chaining', () => {
  it('accumulates zero drift over 10 identical loops (acceptance criterion)', () => {
    const beats = cycleBeatsFor(4); // 20 beats @ 120bpm = 10s per cycle
    const cycles = lockCycles(0.75, beats, new Array<number>(10).fill(120));
    const last = cycles[9];
    expect(last).toBeDefined();
    // Chained addition must equal the closed form to float precision.
    expect(last?.endSec).toBeCloseTo(0.75 + 10 * beats * (60 / 120), 9);
    // Beat axis is exactly continuous: cycle k starts at k*beats.
    cycles.forEach((cycle, k) => {
      expect(cycle.startBeat).toBe(k * beats);
      expect(cycle.index).toBe(k);
    });
  });

  it('applies a BPM change exactly at the next cycle boundary', () => {
    const beats = cycleBeatsFor(2); // 12 beats
    const cycles = lockCycles(1, beats, [120, 120, 180]);
    const c0 = cycles[0];
    const c1 = cycles[1];
    const c2 = cycles[2];
    if (c0 === undefined || c1 === undefined || c2 === undefined) throw new Error('missing');
    expect(c1.startSec).toBe(c0.endSec);
    expect(c2.startSec).toBe(c1.endSec);
    expect(c1.endSec - c1.startSec).toBeCloseTo(12 * 0.5, 12); // 120bpm
    expect(c2.endSec - c2.startSec).toBeCloseTo(12 * (60 / 180), 12); // 180bpm from next loop
    // Beat length per cycle does not depend on BPM.
    expect(c2.startBeat - c1.startBeat).toBe(beats);
  });
});

describe('cycleClickTimes', () => {
  it('emits one click per beat, strong on every bar start', () => {
    const cycle = firstCycle(2, 120, cycleBeatsFor(2)); // 12 beats
    const clicks = cycleClickTimes(cycle);
    expect(clicks).toHaveLength(12);
    clicks.forEach((click, b) => {
      expect(click.timeSec).toBeCloseTo(2 + b * 0.5, 12);
      expect(click.strong).toBe(b % 4 === 0);
    });
    // Count-in downbeat + the two pattern bar starts.
    expect(clicks.filter((c) => c.strong)).toHaveLength(3);
  });
});

describe('cycleJudgeNotes', () => {
  it('offsets pattern notes past the count-in at the cycle BPM, in ms', () => {
    const notes: PracticePatternNote[] = [
      { beat: 0, lane: 1 },
      { beat: 1.5, lane: 2 },
    ];
    const cycle = firstCycle(1, 120, cycleBeatsFor(1));
    const judgeNotes = cycleJudgeNotes(cycle, notes);
    expect(judgeNotes).toEqual([
      { timeMs: (1 + 4 * 0.5) * 1000, lane: 1 },
      { timeMs: (1 + 5.5 * 0.5) * 1000, lane: 2 },
    ]);
  });

  it('same pattern beat lands later in wall-clock at a slower BPM', () => {
    const notes: PracticePatternNote[] = [{ beat: 2, lane: 3 }];
    const beats = cycleBeatsFor(1);
    const fast = cycleJudgeNotes(firstCycle(0, 240, beats), notes)[0];
    const slow = cycleJudgeNotes(firstCycle(0, 60, beats), notes)[0];
    expect(fast?.timeMs).toBeCloseTo(6 * 250, 9);
    expect(slow?.timeMs).toBeCloseTo(6 * 1000, 9);
  });
});

describe('buildSessionNotes', () => {
  it('replicates the pattern loop-major on the continuous beat axis, ascending', () => {
    const notes: PracticePatternNote[] = [
      { beat: 0, lane: 0 },
      { beat: 3.75, lane: 7 },
    ];
    const beats = cycleBeatsFor(1); // 8
    const session = buildSessionNotes(notes, 3, beats);
    expect(session).toHaveLength(6);
    expect(session.map((n) => n.beat)).toEqual([4, 7.75, 12, 15.75, 20, 23.75]);
    expect(session.every((n, i) => i === 0 || n.beat > (session[i - 1]?.beat ?? 0))).toBe(true);
    expect(session.every((n) => n.type === 'tap')).toBe(true);
    // Session index = loop * patternNotes.length + pattern index.
    expect(session[2]?.lane).toBe(0);
    expect(session[3]?.lane).toBe(7);
  });
});

describe('sessionBeatAt / cycleIndexAt', () => {
  const beats = cycleBeatsFor(1); // 8 beats
  const cycles = lockCycles(1, beats, [120, 240]); // cycle0: 1..5s, cycle1: 5..7s

  it('is continuous and exact at cycle boundaries', () => {
    expect(sessionBeatAt(cycles, 1)).toBe(0);
    expect(sessionBeatAt(cycles, 5)).toBe(8); // end of cycle0 == start of cycle1
    expect(sessionBeatAt(cycles, 6)).toBeCloseTo(8 + 4, 12); // 240bpm: 4 beats/sec
  });

  it('extrapolates negatively during the lead-in (like song play)', () => {
    expect(sessionBeatAt(cycles, 0)).toBeCloseTo(-2, 12); // 1s before start @120bpm
  });

  it('extrapolates past the last locked cycle at its rate', () => {
    expect(sessionBeatAt(cycles, 8)).toBeCloseTo(8 + 12, 12);
  });

  it('is monotonically increasing across a BPM change', () => {
    let prev = Number.NEGATIVE_INFINITY;
    for (let t = 0; t <= 7.5; t += 0.05) {
      const beat = sessionBeatAt(cycles, t);
      expect(beat).toBeGreaterThan(prev);
      prev = beat;
    }
  });

  it('cycleIndexAt clamps to the locked range', () => {
    expect(cycleIndexAt(cycles, 0)).toBe(0);
    expect(cycleIndexAt(cycles, 4.99)).toBe(0);
    expect(cycleIndexAt(cycles, 5)).toBe(1);
    expect(cycleIndexAt(cycles, 100)).toBe(1);
    expect(cycleIndexAt([], 3)).toBe(0);
  });
});

describe('handoff bound (LOOP_HANDOFF_MS proof pinned as a test)', () => {
  it('separates adjacent cycles for extreme BPM/snap combinations', () => {
    const bad = DEFAULT_JUDGEMENT_WINDOWS_MS.bad;
    for (const bpmA of [60, 400]) {
      for (const bpmB of [60, 400]) {
        for (const bars of [1, 8]) {
          const beats = cycleBeatsFor(bars);
          const a = firstCycle(0, bpmA, beats);
          const b = nextCycle(a, bpmB);
          // Latest note cycle A can contain: last 1/32 grid cell of the pattern.
          const lastNoteMs = cycleJudgeNotes(a, [{ beat: bars * 4 - 4 / 32, lane: 1 }])[0]?.timeMs;
          // Earliest note cycle B can contain: pattern beat 0.
          const firstNextMs = cycleJudgeNotes(b, [{ beat: 0, lane: 1 }])[0]?.timeMs;
          if (lastNoteMs === undefined || firstNextMs === undefined) throw new Error('missing');
          // A's late window must close before the handoff; B's early window must open after.
          expect(lastNoteMs + bad).toBeLessThan(handoffMs(a));
          expect(firstNextMs - bad).toBeGreaterThan(handoffMs(a));
        }
      }
    }
  });

  it('prep lead stays below the earliest-input bound so the next judge exists in time', () => {
    // Earliest input for cycle B arrives 350ms after the boundary (400bpm, beat-0 note,
    // 250ms early). Prep happens LOOP_PREP_AHEAD_SEC before the boundary — well before.
    expect(LOOP_PREP_AHEAD_SEC * 1000).toBeLessThan(350);
    expect(LOOP_HANDOFF_MS).toBeLessThan(350);
    expect(LOOP_HANDOFF_MS).toBeGreaterThan(231.25);
  });
});
