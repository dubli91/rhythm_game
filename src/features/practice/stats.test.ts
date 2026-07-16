// Practice statistics tests (practice-mode.md MUST 8: per-loop counts,
// accuracy %, signed δ mean, cumulative across loops).

import { describe, expect, it } from 'vitest';
import type { JudgementEvent } from '../play/types';
import { createPracticeStats, formatMeanDelta } from './stats';

function hit(deltaMs: number, grade: JudgementEvent['grade'] = 'PGREAT'): JudgementEvent {
  return { kind: 'hit', grade, lane: 1, noteIndex: 0, deltaMs, songTimeMs: 1000 };
}

function missPoor(): JudgementEvent {
  return { kind: 'missPoor', grade: 'POOR', lane: 1, noteIndex: 0, deltaMs: null, songTimeMs: 0 };
}

function emptyPoor(): JudgementEvent {
  return { kind: 'emptyPoor', grade: 'POOR', lane: 1, noteIndex: -1, deltaMs: null, songTimeMs: 0 };
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
