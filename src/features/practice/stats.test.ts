// Practice statistics tests (practice-mode.md MUST 8: per-loop counts,
// accuracy %, signed δ mean, cumulative across loops; SHOULD 13: δ histogram).
//
// The histogram bucket boundaries are pinned exactly — an off-by-one there
// silently misfiles every hit near a bucket edge, and nothing downstream
// (a text sparkline) would make that visible.

import { describe, expect, it } from 'vitest';
import { timingClassFor } from '../play/judgement';
import type { JudgementEvent } from '../play/types';
import {
  DELTA_HISTOGRAM_BUCKETS,
  DELTA_HISTOGRAM_BUCKET_MS,
  createPracticeStats,
  formatDeltaHistogram,
  formatMeanDelta,
} from './stats';

function hit(deltaMs: number, grade: JudgementEvent['grade'] = 'PGREAT'): JudgementEvent {
  return {
    kind: 'hit',
    grade,
    lane: 1,
    noteIndex: 0,
    deltaMs,
    timing: timingClassFor(grade, deltaMs),
    songTimeMs: 1000,
  };
}

function missPoor(): JudgementEvent {
  return {
    kind: 'missPoor',
    grade: 'POOR',
    lane: 1,
    noteIndex: 0,
    deltaMs: null,
    timing: null,
    songTimeMs: 0,
  };
}

function emptyPoor(): JudgementEvent {
  return {
    kind: 'emptyPoor',
    grade: 'POOR',
    lane: 1,
    noteIndex: -1,
    deltaMs: null,
    timing: null,
    songTimeMs: 0,
  };
}

describe('createPracticeStats', () => {
  it('tracks per-loop counts and signed mean delta', () => {
    const stats = createPracticeStats(4);
    stats.apply(0, hit(10));
    stats.apply(0, hit(-4, 'GREAT'));
    stats.apply(0, hit(6, 'GOOD'));
    stats.apply(0, missPoor());
    const loop = stats.finalizeLoop(0);
    expect(loop.loopIndex).toBe(0);
    expect(loop.summary.counts.PGREAT).toBe(1);
    expect(loop.summary.counts.GREAT).toBe(1);
    expect(loop.summary.counts.GOOD).toBe(1);
    expect(loop.summary.counts.POOR).toBe(1);
    expect(loop.summary.exScore).toBe(3);
    expect(loop.summary.isComplete).toBe(true);
    expect(loop.meanDeltaMs).toBeCloseTo((10 - 4 + 6) / 3, 12);
  });

  it('meanDeltaMs is null for a loop with no timed hits', () => {
    const stats = createPracticeStats(2);
    stats.apply(0, missPoor());
    stats.apply(0, missPoor());
    expect(stats.finalizeLoop(0).meanDeltaMs).toBeNull();
  });

  it('empty poors count toward BP but not toward judged notes', () => {
    const stats = createPracticeStats(1);
    stats.apply(0, hit(0));
    stats.apply(0, emptyPoor());
    const loop = stats.finalizeLoop(0);
    expect(loop.summary.emptyPoorCount).toBe(1);
    expect(loop.summary.bp).toBe(1);
    expect(loop.summary.judgedNotes).toBe(1);
  });

  it('liveSummary reflects a loop in progress without finalizing it', () => {
    const stats = createPracticeStats(4);
    stats.apply(1, hit(0));
    expect(stats.liveSummary(1).counts.PGREAT).toBe(1);
    expect(stats.cumulative().loopsFinalized).toBe(0);
    expect(stats.lastLoop()).toBeNull();
  });

  it('accumulates cumulative stats over finalized loops only', () => {
    const stats = createPracticeStats(2);
    stats.apply(0, hit(10));
    stats.apply(0, hit(20));
    stats.finalizeLoop(0);
    stats.apply(1, hit(-10, 'GREAT'));
    stats.apply(1, missPoor());
    stats.finalizeLoop(1);
    // Loop 2 is in progress — must not count.
    stats.apply(2, hit(100));

    const total = stats.cumulative();
    expect(total.loopsFinalized).toBe(2);
    expect(total.counts.PGREAT).toBe(2);
    expect(total.counts.GREAT).toBe(1);
    expect(total.counts.POOR).toBe(1);
    expect(total.exScore).toBe(5);
    expect(total.maxExScore).toBe(8);
    expect(total.exPercent).toBeCloseTo(62.5, 12);
    expect(total.bp).toBe(1);
    expect(total.meanDeltaMs).toBeCloseTo((10 + 20 - 10) / 3, 12);
  });

  it('bestMaxCombo is the best single loop, not a chain across loops', () => {
    const stats = createPracticeStats(3);
    for (let i = 0; i < 3; i++) stats.apply(0, hit(0));
    stats.finalizeLoop(0);
    stats.apply(1, hit(0));
    stats.apply(1, missPoor());
    stats.apply(1, hit(0));
    stats.finalizeLoop(1);
    expect(stats.cumulative().bestMaxCombo).toBe(3);
  });

  it('lastLoop returns the most recently finalized loop', () => {
    const stats = createPracticeStats(1);
    stats.apply(0, hit(0));
    stats.finalizeLoop(0);
    stats.apply(1, missPoor());
    stats.finalizeLoop(1);
    expect(stats.lastLoop()?.loopIndex).toBe(1);
    expect(stats.lastLoop()?.summary.counts.POOR).toBe(1);
  });
});

describe('formatMeanDelta', () => {
  it('labels late/early tendencies and handles null', () => {
    expect(formatMeanDelta(4.23)).toBe('δ +4.2ms late');
    expect(formatMeanDelta(-3.14)).toBe('δ −3.1ms early');
    expect(formatMeanDelta(0.01)).toBe('δ ±0.0ms');
    expect(formatMeanDelta(null)).toBe('δ —');
  });
});

describe('δ histogram (SHOULD 13)', () => {
  const CENTER = Math.floor(DELTA_HISTOGRAM_BUCKETS / 2);

  it('buckets hits by signed delta; bucket edges are [lo, hi)', () => {
    const stats = createPracticeStats(8);
    stats.apply(0, hit(0)); // dead center
    stats.apply(0, hit(4.9)); // still the center bucket [−5, +5)
    stats.apply(0, hit(5)); // first late bucket [+5, +15)
    stats.apply(0, hit(-5.1)); // first early bucket [−15, −5)
    const loop = stats.finalizeLoop(0);
    expect(loop.deltaHistogram[CENTER]).toBe(2);
    expect(loop.deltaHistogram[CENTER + 1]).toBe(1);
    expect(loop.deltaHistogram[CENTER - 1]).toBe(1);
    expect(loop.deltaHistogram.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('clamps outliers into the edge buckets instead of dropping them', () => {
    const stats = createPracticeStats(4);
    stats.apply(0, hit(-240, 'BAD')); // far early — beyond the ±75ms range
    stats.apply(0, hit(240, 'BAD')); // far late
    const loop = stats.finalizeLoop(0);
    expect(loop.deltaHistogram[0]).toBe(1);
    expect(loop.deltaHistogram[DELTA_HISTOGRAM_BUCKETS - 1]).toBe(1);
  });

  it('ignores non-hit events (miss/empty poor have no delta)', () => {
    const stats = createPracticeStats(2);
    stats.apply(0, missPoor());
    stats.apply(0, emptyPoor());
    const loop = stats.finalizeLoop(0);
    expect(loop.deltaHistogram.every((n) => n === 0)).toBe(true);
  });

  it('cumulative histogram sums finalized loops only', () => {
    const stats = createPracticeStats(2);
    stats.apply(0, hit(0));
    stats.finalizeLoop(0);
    stats.apply(1, hit(1));
    stats.finalizeLoop(1);
    stats.apply(2, hit(2)); // in progress — must not count
    const total = stats.cumulative();
    expect(total.deltaHistogram[CENTER]).toBe(2);
    expect(total.deltaHistogram.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('bucket width times count covers the documented ±range', () => {
    expect(DELTA_HISTOGRAM_BUCKET_MS * DELTA_HISTOGRAM_BUCKETS).toBe(150);
  });
});

describe('formatDeltaHistogram', () => {
  it('is empty until a timed hit lands', () => {
    expect(formatDeltaHistogram(new Array(DELTA_HISTOGRAM_BUCKETS).fill(0))).toBe('');
  });

  it('renders one column per bucket with the peak at full height', () => {
    const histogram = new Array<number>(DELTA_HISTOGRAM_BUCKETS).fill(0);
    histogram[7] = 8; // peak
    histogram[8] = 4; // half height
    histogram[0] = 1; // single stray hit must stay visible
    const line = formatDeltaHistogram(histogram);
    expect(line.startsWith('δ −75ms ')).toBe(true);
    expect(line.endsWith(' +75ms')).toBe(true);
    const bars = line.slice('δ −75ms '.length, -' +75ms'.length);
    expect(bars).toHaveLength(DELTA_HISTOGRAM_BUCKETS);
    expect(bars[7]).toBe('█');
    expect(bars[8]).toBe('▄');
    expect(bars[0]).toBe('▁');
    expect(bars[3]).toBe(' ');
  });
});
