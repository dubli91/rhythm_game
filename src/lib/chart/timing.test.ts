import { describe, expect, it } from 'vitest';
import { computeNoteTimesMs, createTimingIndex } from './timing';
import type { Chart, ChartTiming, Note } from './types';
import { CHART_FORMAT_VERSION } from './types';

function buildChart(timing: ChartTiming, notes: Note[]): Chart {
  return {
    formatVersion: CHART_FORMAT_VERSION,
    chartId: 'test-chart',
    difficulty: 'NORMAL',
    level: 5,
    total: 100,
    bpm: { init: 120, min: 60, max: 240 },
    timing,
    notes,
  };
}

describe('createTimingIndex: beatToMs', () => {
  it('converts beats at a single constant BPM (120)', () => {
    const timing: ChartTiming = { bpmEvents: [{ beat: 0, bpm: 120 }], stopEvents: [] };
    const index = createTimingIndex(timing);

    // msPerBeat = 60000/120 = 500
    expect(index.beatToMs(0)).toBe(0);
    expect(index.beatToMs(1)).toBe(500);
    expect(index.beatToMs(4)).toBe(2000);
    expect(index.beatToMs(0.25)).toBe(125);
    expect(index.beatToMs(2.5)).toBe(1250);
  });

  it('applies two BPM changes across segments', () => {
    // 120 for [0,4), 240 for [4,8), 60 for [8, inf)
    const timing: ChartTiming = {
      bpmEvents: [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 240 },
        { beat: 8, bpm: 60 },
      ],
      stopEvents: [],
    };
    const index = createTimingIndex(timing);

    // beat0-4 @120bpm (500ms/beat): 4 beats -> 2000ms
    expect(index.beatToMs(2)).toBe(1000);
    expect(index.beatToMs(4)).toBe(2000);
    // beat4-8 @240bpm (250ms/beat): +4 beats -> +1000ms = 3000ms at beat 8
    expect(index.beatToMs(6)).toBe(2500);
    expect(index.beatToMs(8)).toBe(3000);
    // beat8+ @60bpm (1000ms/beat)
    expect(index.beatToMs(9)).toBe(4000);
    expect(index.beatToMs(10)).toBe(5000);
  });

  it('freezes time during a STOP; the stop beat itself excludes the stop', () => {
    // 120bpm constant, STOP at beat 4 lasting 2 beats = 1000ms (at 120bpm)
    const timing: ChartTiming = {
      bpmEvents: [{ beat: 0, bpm: 120 }],
      stopEvents: [{ beat: 4, durationBeats: 2 }],
    };
    const index = createTimingIndex(timing);

    expect(index.beatToMs(4)).toBe(2000);
    expect(index.beatToMs(4.5)).toBe(3250);
    expect(index.beatToMs(5)).toBe(3500);
  });

  it('a note exactly at the stop beat sounds unaffected by the stop', () => {
    const timing: ChartTiming = {
      bpmEvents: [{ beat: 0, bpm: 120 }],
      stopEvents: [{ beat: 4, durationBeats: 2 }],
    };
    const chart = buildChart(timing, [
      { beat: 0, lane: 1, type: 'tap' },
      { beat: 4, lane: 2, type: 'tap' },
      { beat: 4.5, lane: 3, type: 'tap' },
    ]);
    const times = computeNoteTimesMs(chart);
    expect(times).toEqual([0, 2000, 3250]);
  });

  it('uses the NEW bpm for a stop duration when a BPM change lands on the same beat', () => {
    // 120 -> 240 at beat 4, with a 2-beat stop at beat 4.
    // Arrival at beat 4 uses the OLD rate (120bpm, 500ms/beat): 4*500 = 2000ms.
    // Stop duration uses the NEW rate (240bpm, 250ms/beat): 2*250 = 500ms.
    const timing: ChartTiming = {
      bpmEvents: [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 240 },
      ],
      stopEvents: [{ beat: 4, durationBeats: 2 }],
    };
    const index = createTimingIndex(timing);

    expect(index.beatToMs(4)).toBe(2000);
    expect(index.beatToMs(5)).toBe(2750);
  });

  it('accumulates multiple stops', () => {
    // 120bpm constant, stops at beat 2 (1 beat = 500ms) and beat 6 (1 beat = 500ms)
    const timing: ChartTiming = {
      bpmEvents: [{ beat: 0, bpm: 120 }],
      stopEvents: [
        { beat: 2, durationBeats: 1 },
        { beat: 6, durationBeats: 1 },
      ],
    };
    const index = createTimingIndex(timing);

    expect(index.beatToMs(2)).toBe(1000);
    expect(index.beatToMs(3)).toBe(2000); // 1000 + 500 (stop1) + 500
    expect(index.beatToMs(6)).toBe(3500); // 2000 + 3*500
    expect(index.beatToMs(6.5)).toBe(4250); // 3500 + 500 (stop2) + 250
    expect(index.beatToMs(8)).toBe(5000); // 3500 + 500 (stop2) + 2*500
  });

  it('extrapolates negative beats linearly using the initial BPM', () => {
    const timing: ChartTiming = { bpmEvents: [{ beat: 0, bpm: 120 }], stopEvents: [] };
    const index = createTimingIndex(timing);

    expect(index.beatToMs(-1)).toBe(-500);
    expect(index.beatToMs(-2.5)).toBe(-1250);
  });

  it('does not leak a beat-0 stop backward into the negative lead-in region', () => {
    const timing: ChartTiming = {
      bpmEvents: [{ beat: 0, bpm: 120 }],
      stopEvents: [{ beat: 0, durationBeats: 2 }],
    };
    const index = createTimingIndex(timing);

    expect(index.beatToMs(-1)).toBe(-500);
    expect(index.beatToMs(0)).toBe(0);
    expect(index.beatToMs(0.5)).toBe(1250); // 1000 (stop) + 0.5*500
  });
});

describe('createTimingIndex: msToBeat', () => {
  it('returns the constant stop beat throughout a frozen interval', () => {
    const timing: ChartTiming = {
      bpmEvents: [{ beat: 0, bpm: 120 }],
      stopEvents: [{ beat: 4, durationBeats: 2 }],
    };
    const index = createTimingIndex(timing);

    // Stop spans ms [2000, 3000].
    expect(index.msToBeat(2000)).toBe(4);
    expect(index.msToBeat(2500)).toBe(4);
    expect(index.msToBeat(3000)).toBe(4);
    expect(index.msToBeat(3250)).toBe(4.5);
  });

  it('extrapolates negative ms linearly using the initial BPM', () => {
    const timing: ChartTiming = { bpmEvents: [{ beat: 0, bpm: 120 }], stopEvents: [] };
    const index = createTimingIndex(timing);

    expect(index.msToBeat(-500)).toBe(-1);
    expect(index.msToBeat(-1250)).toBe(-2.5);
  });

  it('is the exact inverse of beatToMs (round trip) across BPM changes and stops', () => {
    const timing: ChartTiming = {
      bpmEvents: [
        { beat: 0, bpm: 120 },
        { beat: 8, bpm: 180 },
      ],
      stopEvents: [
        { beat: 4, durationBeats: 2 },
        { beat: 12, durationBeats: 1 },
      ],
    };
    const index = createTimingIndex(timing);

    for (let beat = -5; beat <= 20; beat += 0.37) {
      const ms = index.beatToMs(beat);
      const roundTripped = index.msToBeat(ms);
      expect(Math.abs(roundTripped - beat)).toBeLessThan(1e-9);
    }
  });
});

describe('createTimingIndex: validation', () => {
  it('throws when bpmEvents is empty', () => {
    const timing: ChartTiming = { bpmEvents: [], stopEvents: [] };
    expect(() => createTimingIndex(timing)).toThrow();
  });

  it('throws when the first bpm event is not at beat 0', () => {
    const timing: ChartTiming = { bpmEvents: [{ beat: 1, bpm: 120 }], stopEvents: [] };
    expect(() => createTimingIndex(timing)).toThrow();
  });

  it('throws when bpmEvents are not sorted ascending', () => {
    const timing: ChartTiming = {
      bpmEvents: [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 150 },
        { beat: 2, bpm: 180 },
      ],
      stopEvents: [],
    };
    expect(() => createTimingIndex(timing)).toThrow();
  });

  it('throws when a bpm value is not positive', () => {
    const timing: ChartTiming = { bpmEvents: [{ beat: 0, bpm: 0 }], stopEvents: [] };
    expect(() => createTimingIndex(timing)).toThrow();
  });

  it('throws when a stop duration is not positive', () => {
    const timing: ChartTiming = {
      bpmEvents: [{ beat: 0, bpm: 120 }],
      stopEvents: [{ beat: 4, durationBeats: 0 }],
    };
    expect(() => createTimingIndex(timing)).toThrow();
  });

  it('throws when stopEvents are not sorted ascending', () => {
    const timing: ChartTiming = {
      bpmEvents: [{ beat: 0, bpm: 120 }],
      stopEvents: [
        { beat: 6, durationBeats: 1 },
        { beat: 2, durationBeats: 1 },
      ],
    };
    expect(() => createTimingIndex(timing)).toThrow();
  });
});

describe('computeNoteTimesMs', () => {
  it('returns an array parallel to chart.notes', () => {
    const timing: ChartTiming = { bpmEvents: [{ beat: 0, bpm: 120 }], stopEvents: [] };
    const chart = buildChart(timing, [
      { beat: 0, lane: 0, type: 'tap' },
      { beat: 1, lane: 1, type: 'tap' },
      { beat: 4, lane: 2, type: 'tap' },
    ]);

    expect(computeNoteTimesMs(chart)).toEqual([0, 500, 2000]);
  });

  it('computes 2000 note times well under the 100ms budget', () => {
    const timing: ChartTiming = {
      bpmEvents: [
        { beat: 0, bpm: 120 },
        { beat: 200, bpm: 180 },
        { beat: 400, bpm: 150 },
      ],
      stopEvents: [
        { beat: 100, durationBeats: 2 },
        { beat: 300, durationBeats: 1 },
      ],
    };
    const notes: Note[] = [];
    for (let i = 0; i < 2000; i++) {
      notes.push({ beat: i * 0.25, lane: (i % 7) + 1, type: 'tap' });
    }
    const chart = buildChart(timing, notes);

    const start = performance.now();
    const times = computeNoteTimesMs(chart);
    const elapsed = performance.now() - start;

    expect(times).toHaveLength(2000);
    expect(elapsed).toBeLessThan(100);
  });
});
