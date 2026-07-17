// Per-loop + cumulative practice statistics (practice-mode.md MUST 8).
//
// Each loop gets its own Scorer (the real scoring engine — practice must feel
// identical to song play), plus a signed-delta accumulator the main game
// discards: mean δ = mean(inputSongTimeMs − noteTimeMs) over timed hits, so
// positive = tendency to hit late/slow, negative = early/fast. Accuracy is
// defined as EX-score percentage (EX / 2·notes), matching the game's exPercent
// so the number is comparable with song results.
//
// Practice results deliberately never touch the records store
// (practice-mode.md acceptance: no writes to results-records).

import { type ScoreSummary, createScorer } from '../play/scoring';
import type { JudgementEvent, JudgementGrade } from '../play/types';

// δ histogram buckets (practice-mode.md SHOULD 13): 15 × 10ms covering ±75ms —
// wide enough that the whole GREAT window (±33.3ms) plus most GOODs land in
// distinct buckets, narrow enough that a one-character-per-bucket sparkline
// still reads at a glance. Outliers clamp into the edge buckets, so those two
// mean "≤ −65ms" / "≥ +65ms" rather than an exact 10ms range.
export const DELTA_HISTOGRAM_BUCKET_MS = 10;
export const DELTA_HISTOGRAM_BUCKETS = 15;
const DELTA_HISTOGRAM_HALF_RANGE_MS = (DELTA_HISTOGRAM_BUCKETS * DELTA_HISTOGRAM_BUCKET_MS) / 2;

function deltaBucketIndex(deltaMs: number): number {
  const index = Math.floor((deltaMs + DELTA_HISTOGRAM_HALF_RANGE_MS) / DELTA_HISTOGRAM_BUCKET_MS);
  return Math.max(0, Math.min(DELTA_HISTOGRAM_BUCKETS - 1, index));
}

export interface LoopStats {
  loopIndex: number;
  summary: ScoreSummary;
  /** Signed mean of hit deltas in ms; null when the loop had no timed hits. */
  meanDeltaMs: number | null;
  /** Per-bucket hit counts, index 0 = earliest (≤ −65ms), center = on time. */
  deltaHistogram: readonly number[];
}

export interface CumulativeStats {
  loopsFinalized: number;
  counts: Record<JudgementGrade, number>;
  emptyPoorCount: number;
  exScore: number;
  maxExScore: number;
  /** Accuracy %: EX / max EX over finalized loops. */
  exPercent: number;
  bp: number;
  /** Best single-loop max combo (combo does not chain across the count-in). */
  bestMaxCombo: number;
  meanDeltaMs: number | null;
  /** Judgement distribution over all finalized loops (SHOULD 13). */
  deltaHistogram: readonly number[];
}

export interface PracticeStats {
  apply(loopIndex: number, event: JudgementEvent): void;
  /** Live snapshot of a loop still in progress (renderer HUD). */
  liveSummary(loopIndex: number): ScoreSummary;
  /** Seals a loop; safe to call once per loop after its handoff passes. */
  finalizeLoop(loopIndex: number): LoopStats;
  lastLoop(): LoopStats | null;
  cumulative(): CumulativeStats;
}

interface LoopAccumulator {
  scorer: ReturnType<typeof createScorer>;
  deltaSumMs: number;
  deltaCount: number;
  histogram: number[];
}

function emptyCounts(): Record<JudgementGrade, number> {
  return { PGREAT: 0, GREAT: 0, GOOD: 0, BAD: 0, POOR: 0 };
}

export function createPracticeStats(notesPerLoop: number): PracticeStats {
  const live = new Map<number, LoopAccumulator>();
  let last: LoopStats | null = null;

  // Cumulative over finalized loops only — a half-played loop would skew the
  // totals with notes the player never reached.
  let loopsFinalized = 0;
  const totalCounts = emptyCounts();
  let totalEmptyPoor = 0;
  let totalDeltaSumMs = 0;
  let totalDeltaCount = 0;
  let bestMaxCombo = 0;
  const totalHistogram: number[] = new Array<number>(DELTA_HISTOGRAM_BUCKETS).fill(0);

  function accumulatorFor(loopIndex: number): LoopAccumulator {
    let acc = live.get(loopIndex);
    if (acc === undefined) {
      acc = {
        scorer: createScorer(notesPerLoop),
        deltaSumMs: 0,
        deltaCount: 0,
        histogram: new Array<number>(DELTA_HISTOGRAM_BUCKETS).fill(0),
      };
      live.set(loopIndex, acc);
    }
    return acc;
  }

  function apply(loopIndex: number, event: JudgementEvent): void {
    const acc = accumulatorFor(loopIndex);
    acc.scorer.apply(event);
    if (event.kind === 'hit' && event.deltaMs !== null) {
      acc.deltaSumMs += event.deltaMs;
      acc.deltaCount++;
      const bucket = deltaBucketIndex(event.deltaMs);
      acc.histogram[bucket] = (acc.histogram[bucket] ?? 0) + 1;
    }
  }

  function liveSummary(loopIndex: number): ScoreSummary {
    return accumulatorFor(loopIndex).scorer.snapshot();
  }

  function finalizeLoop(loopIndex: number): LoopStats {
    const acc = accumulatorFor(loopIndex);
    const summary = acc.scorer.snapshot();
    const stats: LoopStats = {
      loopIndex,
      summary,
      meanDeltaMs: acc.deltaCount > 0 ? acc.deltaSumMs / acc.deltaCount : null,
      deltaHistogram: acc.histogram,
    };
    live.delete(loopIndex);
    last = stats;

    loopsFinalized++;
    for (const grade of Object.keys(totalCounts) as JudgementGrade[]) {
      totalCounts[grade] += summary.counts[grade];
    }
    totalEmptyPoor += summary.emptyPoorCount;
    totalDeltaSumMs += acc.deltaSumMs;
    totalDeltaCount += acc.deltaCount;
    for (let i = 0; i < DELTA_HISTOGRAM_BUCKETS; i++) {
      totalHistogram[i] = (totalHistogram[i] ?? 0) + (acc.histogram[i] ?? 0);
    }
    if (summary.maxCombo > bestMaxCombo) bestMaxCombo = summary.maxCombo;
    return stats;
  }

  function lastLoop(): LoopStats | null {
    return last;
  }

  function cumulative(): CumulativeStats {
    const exScore = totalCounts.PGREAT * 2 + totalCounts.GREAT;
    const maxExScore = loopsFinalized * notesPerLoop * 2;
    return {
      loopsFinalized,
      counts: { ...totalCounts },
      emptyPoorCount: totalEmptyPoor,
      exScore,
      maxExScore,
      exPercent: maxExScore === 0 ? 0 : (exScore / maxExScore) * 100,
      bp: totalCounts.BAD + totalCounts.POOR + totalEmptyPoor,
      bestMaxCombo,
      meanDeltaMs: totalDeltaCount > 0 ? totalDeltaSumMs / totalDeltaCount : null,
      deltaHistogram: [...totalHistogram],
    };
  }

  return { apply, liveSummary, finalizeLoop, lastLoop, cumulative };
}

/** Signed δ readout: '+4.2ms late' / '−3.1ms early' / '±0.0ms'. */
export function formatMeanDelta(meanDeltaMs: number | null): string {
  if (meanDeltaMs === null) return 'δ —';
  const rounded = Math.round(meanDeltaMs * 10) / 10;
  if (rounded > 0) return `δ +${rounded.toFixed(1)}ms late`;
  if (rounded < 0) return `δ −${Math.abs(rounded).toFixed(1)}ms early`;
  return 'δ ±0.0ms';
}

// One sparkline column per bucket, 8 levels. Any non-zero bucket renders at
// least ▁ so a single stray hit stays visible next to a tall peak.
const SPARK_LEVELS = ' ▁▂▃▄▅▆▇█';

/** δ distribution sparkline (SHOULD 13): 'δ −75ms ▁▃█▃▁ +75ms', '' when empty.
 *  Text-only so the practice HUD's existing info Text node renders it — the
 *  histogram needs no new canvas primitives. */
export function formatDeltaHistogram(histogram: readonly number[]): string {
  let max = 0;
  for (const count of histogram) {
    if (count > max) max = count;
  }
  if (max === 0) return '';
  let bars = '';
  for (const count of histogram) {
    const level = count === 0 ? 0 : Math.max(1, Math.round((count / max) * 8));
    bars += SPARK_LEVELS[level] ?? ' ';
  }
  return `δ −${DELTA_HISTOGRAM_HALF_RANGE_MS}ms ${bars} +${DELTA_HISTOGRAM_HALF_RANGE_MS}ms`;
}
