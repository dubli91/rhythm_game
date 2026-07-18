// Shared play-domain contracts (specs/judgement-scoring.md, specs/gauge-clear.md).
// Pure data types only — the judgement/scoring/gauge engines live in sibling modules
// and every consumer (renderer, HUD, results, records) speaks these types.

export type JudgementGrade = 'PGREAT' | 'GREAT' | 'GOOD' | 'BAD' | 'POOR';

/**
 * hit = an input consumed a note; missPoor = a note passed the late BAD edge unjudged;
 * emptyPoor = an input with no note in window (gauge damage, no combo break).
 *
 * CN tail events (judgement-scoring.md SHOULD 12). The HEAD hit is the note's single
 * scored judgement (a CN counts as 1 note — see noteCount()); the tail only ever
 * downgrades the outcome:
 *   cnBreak    = released before the end window opened — "treated as BAD": combo
 *                reset + gauge BAD delta + BP, but NOT added to the grade counts
 *                (same extra-event precedent as emptyPoor, so maxEX stays notes×2).
 *   cnComplete = tail resolved successfully (released inside the ±GOOD end window,
 *                or still held when the end passed). No scoring/gauge effect.
 */
export type JudgementKind = 'hit' | 'missPoor' | 'emptyPoor' | 'cnBreak' | 'cnComplete';

/** δ-sign classification of a hit (judgement-scoring.md MUST 14): FAST = early input
 * (δ < 0), SLOW = late (δ > 0). Only δ-based non-PGREAT judgements are classified —
 * PGREAT and every non-hit kind (missPoor/emptyPoor/cnBreak/cnComplete) are neither. */
export type TimingClass = 'FAST' | 'SLOW';

export interface JudgementEvent {
  kind: JudgementKind;
  /** missPoor and emptyPoor always carry grade 'POOR'; cnBreak carries 'BAD';
   *  cnComplete carries 'PGREAT' (cosmetic only — never scored or displayed). */
  grade: JudgementGrade;
  /** 0 = scratch, 1..7 = keys. */
  lane: number;
  /** Index into chart.notes; -1 for emptyPoor (no note involved). */
  noteIndex: number;
  /** inputSongTimeMs − noteTimeMs; null when kind !== 'hit'. */
  deltaMs: number | null;
  /** FAST/SLOW classification of a non-PGREAT hit (judgement-scoring.md MUST 15);
   *  display + aggregation only — never feeds judgement/combo/gauge/score. */
  timing: TimingClass | null;
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

/** Runtime list matching the DjRank union — canonical for validating external data
 * (e.g. imported record JSON); scoring.ts owns the thresholds, not the membership. */
export const DJ_RANKS: readonly DjRank[] = ['AAA', 'AA', 'A', 'B', 'C', 'D', 'E', 'F'];

/** Lane-arrangement play option (play-options.md MUST 9-10). Results/records have carried
 * the field since before gameplay support existed so record schemas never migrate. */
export type Arrangement = 'OFF' | 'RANDOM' | 'MIRROR';

/** Judgement-timing display option (play-options.md MUST 18): OFF, the FAST/SLOW
 * word, or the signed δ in ms. Display-only — FAST/SLOW aggregation runs even at
 * OFF (judgement-scoring.md MUST 16). Cycle order/labels live in options.ts. */
export type TimingDisplayMode = 'OFF' | 'FAST_SLOW' | 'MS';
