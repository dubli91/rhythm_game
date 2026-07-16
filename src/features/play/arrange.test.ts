import { describe, expect, it } from 'vitest';
import type { Chart, Note } from '../../lib/chart/types';
import { applyArrangement, laneMapFor } from './arrange';
import { createJudge } from './judgement';

function makeChart(notes: Note[]): Chart {
  return {
    formatVersion: 1,
    chartId: 'chart-test',
    difficulty: 'NORMAL',
    level: 5,
    total: 200,
    bpm: { init: 150, min: 150, max: 150 },
    timing: { bpmEvents: [{ beat: 0, bpm: 150 }], stopEvents: [] },
    notes,
  };
}

/** One note per lane 0..7 plus a second scratch note, ascending beats. */
function eightLaneNotes(): Note[] {
  const notes: Note[] = [];
  for (let lane = 0; lane <= 7; lane++) {
    notes.push({ beat: lane, lane, type: 'tap' });
  }
  notes.push({ beat: 8, lane: 0, type: 'tap' });
  return notes;
}

describe('laneMapFor', () => {
  it('OFF is the identity', () => {
    expect(laneMapFor('OFF', 123)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('MIRROR flips keys 1..7 and never touches scratch', () => {
    expect(laneMapFor('MIRROR', 123)).toEqual([0, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('MIRROR applied twice is the identity', () => {
    const map = laneMapFor('MIRROR', 0);
    for (let lane = 0; lane <= 7; lane++) {
      expect(map[map[lane] ?? -1]).toBe(lane);
    }
  });

  it('RANDOM is a bijection of 1..7 with scratch fixed', () => {
    const map = laneMapFor('RANDOM', 42);
    expect(map[0]).toBe(0);
    expect([...map.slice(1)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('RANDOM is reproducible per seed and varies across seeds', () => {
    expect(laneMapFor('RANDOM', 42)).toEqual(laneMapFor('RANDOM', 42));
    // Not every pair of seeds differs (7! orderings), but among many seeds at
    // least one must differ from seed 42 unless the permutation ignored the seed.
    const base = laneMapFor('RANDOM', 42).join(',');
    const anyDifferent = [1, 2, 3, 4, 5].some((s) => laneMapFor('RANDOM', s).join(',') !== base);
    expect(anyDifferent).toBe(true);
  });
});

describe('applyArrangement', () => {
  it('OFF returns the chart unchanged (same reference)', () => {
    const chart = makeChart(eightLaneNotes());
    expect(applyArrangement(chart, 'OFF', 7)).toBe(chart);
  });

  it('remaps lanes only: beats, types, order, and note count are untouched', () => {
    const chart = makeChart(eightLaneNotes());
    const arranged = applyArrangement(chart, 'RANDOM', 99);
    expect(arranged.notes.length).toBe(chart.notes.length);
    arranged.notes.forEach((note, i) => {
      const original = chart.notes[i];
      expect(note.beat).toBe(original?.beat);
      expect(note.type).toBe(original?.type);
    });
    // Input chart must not be mutated.
    chart.notes.forEach((note, i) => {
      expect(note.lane).toBe(i <= 7 ? i : 0);
    });
  });

  it('scratch notes stay in lane 0 under RANDOM and MIRROR', () => {
    const chart = makeChart(eightLaneNotes());
    for (const arrangement of ['RANDOM', 'MIRROR'] as const) {
      const arranged = applyArrangement(chart, arrangement, 1234);
      expect(arranged.notes[0]?.lane).toBe(0);
      expect(arranged.notes[8]?.lane).toBe(0);
    }
  });

  it('MIRROR moves each key note to lane 8 - lane', () => {
    const chart = makeChart(eightLaneNotes());
    const arranged = applyArrangement(chart, 'MIRROR', 0);
    for (let i = 1; i <= 7; i++) {
      expect(arranged.notes[i]?.lane).toBe(8 - i);
    }
  });

  // play-options.md acceptance: playing with RANDOM yields identical judgement
  // aggregation — only lanes change. Autoplay-style perfect consumption of the
  // arranged chart must hit every note exactly once.
  it('judgement aggregation is invariant under RANDOM (perfect play still hits every note)', () => {
    const chart = makeChart(eightLaneNotes());
    const arranged = applyArrangement(chart, 'RANDOM', 777);
    const timesMs = arranged.notes.map((n) => n.beat * 400);
    const judge = createJudge(
      arranged.notes.map((n, i) => ({ timeMs: timesMs[i] ?? 0, lane: n.lane })),
    );
    let pgreats = 0;
    arranged.notes.forEach((note, i) => {
      const event = judge.onInput(note.lane, timesMs[i] ?? 0);
      if (event.kind === 'hit' && event.grade === 'PGREAT') pgreats++;
    });
    expect(pgreats).toBe(chart.notes.length);
    expect(judge.remainingNotes()).toBe(0);
  });
});
