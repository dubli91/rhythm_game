// Score aggregation (specs/judgement-scoring.md).
// Consumes JudgementEvent stream from the judgement engine and accumulates
// combo/EX-score/BP/DJ-rank state. Headless, no rendering.

import type { DjRank, JudgementEvent, JudgementGrade } from './types';

export interface ScoreSummary {
  // counts.POOR = missPoor count ONLY; empty poors are tracked separately in emptyPoorCount.
  counts: Record<JudgementGrade, number>;
  emptyPoorCount: number;
  combo: number;
  maxCombo: number;
  exScore: number;
  maxExScore: number;
  exPercent: number;
  // BP = BAD + missPoor POOR + emptyPoor (IIDX convention: empty poors count toward BP).
  bp: number;
  djRank: DjRank;
  // true only when isComplete && zero BAD && zero missPoor. Empty poors do not break FC.
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

    // kind === 'hit'
    counts[event.grade]++;
    judgedNotes++;
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
    const bp = counts.BAD + counts.POOR + emptyPoorCount;
    const isComplete = judgedNotes === totalNotes;
    const fullCombo = isComplete && counts.BAD === 0 && counts.POOR === 0;

    return {
      counts: { ...counts },
      emptyPoorCount,
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
