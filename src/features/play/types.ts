// Shared play-domain contracts (specs/judgement-scoring.md, specs/gauge-clear.md).
// Pure data types only — the judgement/scoring/gauge engines live in sibling modules
// and every consumer (renderer, HUD, results, records) speaks these types.

export type JudgementGrade = 'PGREAT' | 'GREAT' | 'GOOD' | 'BAD' | 'POOR';

/**
 * hit = an input consumed a note; missPoor = a note passed the late BAD edge unjudged;
 * emptyPoor = an input with no note in window (gauge damage, no combo break).
 */
export type JudgementKind = 'hit' | 'missPoor' | 'emptyPoor';

export interface JudgementEvent {
  kind: JudgementKind;
  /** missPoor and emptyPoor always carry grade 'POOR'. */
  grade: JudgementGrade;
  /** 0 = scratch, 1..7 = keys. */
  lane: number;
  /** Index into chart.notes; -1 for emptyPoor (no note involved). */
  noteIndex: number;
  /** inputSongTimeMs − noteTimeMs; null when kind !== 'hit'. */
  deltaMs: number | null;
  songTimeMs: number;
}

export type GaugeType = 'ASSIST_EASY' | 'EASY' | 'NORMAL' | 'HARD' | 'EX_HARD';

export const GAUGE_TYPES: readonly GaugeType[] = [
  'ASSIST_EASY',
  'EASY',
  'NORMAL',
  'HARD',
  'EX_HARD',
];

export type DjRank = 'AAA' | 'AA' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
