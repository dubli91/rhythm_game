// Score aggregation (specs/judgement-scoring.md).
// Consumes JudgementEvent stream from the judgement engine and accumulates
// combo/EX-score/BP/DJ-rank state. Headless, no rendering.

import type { DjRank, JudgementEvent, JudgementGrade } from './types';

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
