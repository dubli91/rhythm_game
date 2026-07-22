// Score aggregation (specs/judgement-scoring.md).
// Consumes JudgementEvent stream from the judgement engine and accumulates
// combo/EX-score/BP/DJ-rank state. Headless, no rendering.

import type { DjRank, JudgementEvent, JudgementGrade } from './types';

// δ histogram buckets (judgement-scoring.md SHOULD 13): 15 × 10ms covering ±75ms —
// wide enough that the whole GREAT window (±33.3ms) plus most GOODs land in
// distinct buckets, narrow enough that a one-character-per-bucket sparkline
// still reads at a glance. Outliers clamp into the edge buckets, so those two
// mean "≤ −65ms" / "≥ +65ms" rather than an exact 10ms range. Lives in the
// scorer so song play and practice (one Scorer per loop) share one accumulator.
export const DELTA_HISTOGRAM_BUCKET_MS = 10;
export const DELTA_HISTOGRAM_BUCKETS = 15;
const DELTA_HISTOGRAM_HALF_RANGE_MS = (DELTA_HISTOGRAM_BUCKETS * DELTA_HISTOGRAM_BUCKET_MS) / 2;

function deltaBucketIndex(deltaMs: number): number {
  const index = Math.floor((deltaMs + DELTA_HISTOGRAM_HALF_RANGE_MS) / DELTA_HISTOGRAM_BUCKET_MS);
  return Math.max(0, Math.min(DELTA_HISTOGRAM_BUCKETS - 1, index));
}

export interface ScoreSummary {
  // counts.POOR = missPoor count ONLY; empty poors are tracked separately in emptyPoorCount.
  counts: Record<JudgementGrade, number>;
  emptyPoorCount: number;
  /** CN tails released early ("treated as BAD" — judgement-scoring.md SHOULD 12).
   *  Tracked outside counts so a CN stays 1 scored note; contributes to BP and kills FC. */
  cnBreakCount: number;
  combo: number;
  maxCombo: number;
  exScore: number;
  maxExScore: number;
  exPercent: number;
  /** FAST/SLOW session counts (judgement-scoring.md MUST 16): non-PGREAT hits by
   *  δ sign. Aggregated regardless of the timing display option; shown on results
   *  (results-records.md MUST 13) but never persisted into records. */
  fastCount: number;
  slowCount: number;
  /** δ distribution over timed hits (judgement-scoring.md SHOULD 13): per-bucket
   *  counts, index 0 = earliest (≤ −65ms), center = on time. Display-only —
   *  results screen + practice HUD; never persisted into records. */
  deltaHistogram: readonly number[];
  // BP = BAD + missPoor POOR + emptyPoor + cnBreak (empty poors count toward BP per IIDX).
  bp: number;
  djRank: DjRank;
  // true only when isComplete && zero BAD && zero missPoor && zero cnBreak.
  // Empty poors do not break FC.
  fullCombo: boolean;
  judgedNotes: number;
  totalNotes: number;
  isComplete: boolean;
}

export interface Scorer {
  apply(event: JudgementEvent): void;
  snapshot(): ScoreSummary;
}

const RANK_NUMERATORS: ReadonlyArray<{ rank: DjRank; numerator: number }> = [
  { rank: 'AAA', numerator: 8 },
  { rank: 'AA', numerator: 7 },
  { rank: 'A', numerator: 6 },
  { rank: 'B', numerator: 5 },
  { rank: 'C', numerator: 4 },
  { rank: 'D', numerator: 3 },
  { rank: 'E', numerator: 2 },
];

export function djRankFor(exScore: number, maxExScore: number): DjRank {
  if (maxExScore <= 0) return 'F';
  for (const { rank, numerator } of RANK_NUMERATORS) {
    // Exact integer comparison (exScore * 9 >= numerator * maxExScore) avoids
    // float rounding error from computing a ratio.
    if (exScore * 9 >= numerator * maxExScore) {
      return rank;
    }
  }
  return 'F';
}

function emptyCounts(): Record<JudgementGrade, number> {
  return { PGREAT: 0, GREAT: 0, GOOD: 0, BAD: 0, POOR: 0 };
}

export function createScorer(totalNotes: number): Scorer {
  const counts = emptyCounts();
  let emptyPoorCount = 0;
  let cnBreakCount = 0;
  let fastCount = 0;
  let slowCount = 0;
  const deltaHistogram = new Array<number>(DELTA_HISTOGRAM_BUCKETS).fill(0);
  let combo = 0;
  let maxCombo = 0;
  let judgedNotes = 0;

  const maxExScore = totalNotes * 2;

  function apply(event: JudgementEvent): void {
    if (event.kind === 'emptyPoor') {
      emptyPoorCount++;
      return;
    }

    if (event.kind === 'missPoor') {
      counts.POOR++;
      judgedNotes++;
      combo = 0;
      return;
    }

    // CN tail events: the head already scored the note (judgedNotes/EX untouched here).
    if (event.kind === 'cnBreak') {
      cnBreakCount++;
      combo = 0;
      return;
    }
    if (event.kind === 'cnComplete') {
      return;
    }

    // kind === 'hit'
    counts[event.grade]++;
    judgedNotes++;
    // FAST/SLOW aggregation (judgement-scoring.md MUST 16): the judge classified
    // the hit; only hits ever carry a timing, so the non-hit kinds above are
    // excluded by construction.
    if (event.timing === 'FAST') fastCount++;
    else if (event.timing === 'SLOW') slowCount++;
    // δ histogram (judgement-scoring.md SHOULD 13): every timed hit buckets by
    // its signed δ; non-hit kinds carry deltaMs null and returned above.
    if (event.deltaMs !== null) {
      const bucket = deltaBucketIndex(event.deltaMs);
      deltaHistogram[bucket] = (deltaHistogram[bucket] ?? 0) + 1;
    }
    if (event.grade === 'BAD') {
      combo = 0;
    } else {
      combo++;
      if (combo > maxCombo) {
        maxCombo = combo;
      }
    }
  }

  function snapshot(): ScoreSummary {
    const exScore = counts.PGREAT * 2 + counts.GREAT;
    const exPercent = maxExScore === 0 ? 0 : (exScore / maxExScore) * 100;
    const bp = counts.BAD + counts.POOR + emptyPoorCount + cnBreakCount;
    const isComplete = judgedNotes === totalNotes;
    const fullCombo = isComplete && counts.BAD === 0 && counts.POOR === 0 && cnBreakCount === 0;

    return {
      counts: { ...counts },
      emptyPoorCount,
      cnBreakCount,
      fastCount,
      slowCount,
      deltaHistogram: [...deltaHistogram],
      combo,
      maxCombo,
      exScore,
      maxExScore,
      exPercent,
      bp,
      djRank: djRankFor(exScore, maxExScore),
      fullCombo,
      judgedNotes,
      totalNotes,
      isComplete,
    };
  }

  return { apply, snapshot };
}

// One sparkline column per bucket, 8 levels. Any non-zero bucket renders at
// least ▁ so a single stray hit stays visible next to a tall peak.
const SPARK_LEVELS = ' ▁▂▃▄▅▆▇█';

/** δ distribution sparkline (SHOULD 13): 'δ −75ms ▁▃█▃▁ +75ms', '' when empty.
 *  Text-only so both the practice HUD's info Text node and the results screen
 *  render it — the histogram needs no new canvas primitives. */
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
