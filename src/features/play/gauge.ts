// Gauge engine (specs/gauge-clear.md).
//
// Tracks the play gauge (recovery-type or survival-type) across a song and
// derives the clear lamp at song end. Pure logic, no DOM / timers — driven
// entirely by JudgementEvent objects produced by the judgement engine.

import type { GaugeType, JudgementEvent } from './types';

export interface GaugeSnapshot {
  type: GaugeType;
  value: number;
  clearLine: number;
  isSurvival: boolean;
  failed: boolean;
}

export interface GaugeEngine {
  readonly type: GaugeType;
  apply(event: JudgementEvent): void;
  value(): number;
  /** Survival gauge reached 0% (sticky — stays true once set). Always false for recovery gauges. */
  failed(): boolean;
  /** Call once at song end. Survival: CLEAR unless failed(). Recovery: CLEAR iff value() >= clearLine. */
  finalResult(): 'CLEAR' | 'FAILED';
  snapshot(): GaugeSnapshot;
}

/**
 * Every tunable number in the gauge system, in one place, per specs/gauge-clear.md
 * section "요구사항". Values are the LR2/IIDX-approximate defaults called out in the spec.
 */
export const GAUGE_CONSTANTS = {
  MIN: 0,
  MAX: 100,
  RECOVERY: {
    INITIAL: 22,
    FLOOR: 2,
    CLEAR_LINE: {
      ASSIST_EASY: 60,
      EASY: 80,
      NORMAL: 80,
    },
    // R = total / noteCount (percent). PGREAT/GREAT/GOOD deltas are R * multiplier;
    // BAD / missPoor / emptyPoor are fixed percentage-point deltas.
    NORMAL: {
      PGREAT_R_MULT: 1,
      GREAT_R_MULT: 1,
      GOOD_R_MULT: 0.5,
      BAD: -2.0,
      MISS_POOR: -6.0,
      EMPTY_POOR: -2.0,
    },
    // EASY and ASSIST_EASY share identical deltas; only the clear line differs.
    EASY: {
      PGREAT_R_MULT: 1.2,
      GREAT_R_MULT: 1.2,
      GOOD_R_MULT: 0.6,
      BAD: -1.6,
      MISS_POOR: -4.8,
      EMPTY_POOR: -1.6,
    },
  },
  SURVIVAL: {
    INITIAL: 100,
    FLOOR: 0,
    HARD: {
      PGREAT: 0.16,
      GREAT: 0.16,
      GOOD: 0.08,
      BAD: -6,
      MISS_POOR: -10,
      EMPTY_POOR: -2,
      // Below this value (checked BEFORE applying the delta), decrements are halved.
      MITIGATION_THRESHOLD: 30,
      MITIGATION_FACTOR: 0.5,
    },
    EX_HARD: {
      PGREAT: 0.16,
      GREAT: 0.16,
      GOOD: 0.08,
      BAD: -12,
      MISS_POOR: -20,
      EMPTY_POOR: -4,
    },
  },
} as const;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

type RecoveryTable = typeof GAUGE_CONSTANTS.RECOVERY.NORMAL | typeof GAUGE_CONSTANTS.RECOVERY.EASY;

function recoveryDelta(table: RecoveryTable, event: JudgementEvent, r: number): number {
  if (event.kind === 'missPoor') return table.MISS_POOR;
  if (event.kind === 'emptyPoor') return table.EMPTY_POOR;
  // CN tail (judgement-scoring.md SHOULD 12): early release is "treated as BAD";
  // a completed hold has no gauge effect (the head hit already recovered).
  if (event.kind === 'cnBreak') return table.BAD;
  if (event.kind === 'cnComplete') return 0;
  // event.kind === 'hit': grade is PGREAT | GREAT | GOOD | BAD (POOR cannot occur on a hit).
  if (event.grade === 'PGREAT') return r * table.PGREAT_R_MULT;
  if (event.grade === 'GREAT') return r * table.GREAT_R_MULT;
  if (event.grade === 'GOOD') return r * table.GOOD_R_MULT;
  if (event.grade === 'BAD') return table.BAD;
  // Defensive fallback: a 'hit' with grade POOR is not a valid input per spec.
  return table.BAD;
}

class RecoveryGauge implements GaugeEngine {
  readonly type: GaugeType;
  private val: number;
  private readonly clearLine: number;
  private readonly r: number;
  private readonly table: RecoveryTable;

  constructor(type: 'ASSIST_EASY' | 'EASY' | 'NORMAL', r: number) {
    this.type = type;
    this.val = GAUGE_CONSTANTS.RECOVERY.INITIAL;
    this.r = r;
    this.clearLine = GAUGE_CONSTANTS.RECOVERY.CLEAR_LINE[type];
    this.table =
      type === 'NORMAL' ? GAUGE_CONSTANTS.RECOVERY.NORMAL : GAUGE_CONSTANTS.RECOVERY.EASY;
  }

  apply(event: JudgementEvent): void {
    const delta = recoveryDelta(this.table, event, this.r);
    this.val = clamp(this.val + delta, GAUGE_CONSTANTS.RECOVERY.FLOOR, GAUGE_CONSTANTS.MAX);
  }

  value(): number {
    return this.val;
  }

  failed(): boolean {
    return false;
  }

  finalResult(): 'CLEAR' | 'FAILED' {
    return this.val >= this.clearLine ? 'CLEAR' : 'FAILED';
  }

  snapshot(): GaugeSnapshot {
    return {
      type: this.type,
      value: this.val,
      clearLine: this.clearLine,
      isSurvival: false,
      failed: false,
    };
  }
}

type SurvivalKind = 'HARD' | 'EX_HARD';
type SurvivalTable = typeof GAUGE_CONSTANTS.SURVIVAL.HARD | typeof GAUGE_CONSTANTS.SURVIVAL.EX_HARD;

function survivalRawDelta(table: SurvivalTable, event: JudgementEvent): number {
  if (event.kind === 'missPoor') return table.MISS_POOR;
  if (event.kind === 'emptyPoor') return table.EMPTY_POOR;
  // CN tail: early release takes the BAD decrement (HARD <30% mitigation applies
  // naturally since it keys off raw < 0); a completed hold is neutral.
  if (event.kind === 'cnBreak') return table.BAD;
  if (event.kind === 'cnComplete') return 0;
  if (event.grade === 'PGREAT') return table.PGREAT;
  if (event.grade === 'GREAT') return table.GREAT;
  if (event.grade === 'GOOD') return table.GOOD;
  if (event.grade === 'BAD') return table.BAD;
  // Defensive fallback: a 'hit' with grade POOR is not a valid input per spec.
  return table.BAD;
}

function survivalDelta(kind: SurvivalKind, event: JudgementEvent, currentValue: number): number {
  if (kind === 'HARD') {
    const table = GAUGE_CONSTANTS.SURVIVAL.HARD;
    let raw = survivalRawDelta(table, event);
    if (raw < 0 && currentValue < table.MITIGATION_THRESHOLD) {
      raw *= table.MITIGATION_FACTOR;
    }
    return raw;
  }
  return survivalRawDelta(GAUGE_CONSTANTS.SURVIVAL.EX_HARD, event);
}

class SurvivalGauge implements GaugeEngine {
  readonly type: GaugeType;
  private val: number;
  private isFailed: boolean;
  private readonly kind: SurvivalKind;

  constructor(type: SurvivalKind) {
    this.type = type;
    this.kind = type;
    this.val = GAUGE_CONSTANTS.SURVIVAL.INITIAL;
    this.isFailed = false;
  }

  apply(event: JudgementEvent): void {
    if (this.isFailed) return;
    const delta = survivalDelta(this.kind, event, this.val);
    const next = clamp(this.val + delta, GAUGE_CONSTANTS.MIN, GAUGE_CONSTANTS.MAX);
    this.val = next;
    if (this.val <= GAUGE_CONSTANTS.SURVIVAL.FLOOR) {
      this.val = GAUGE_CONSTANTS.SURVIVAL.FLOOR;
      this.isFailed = true;
    }
  }

  value(): number {
    return this.val;
  }

  failed(): boolean {
    return this.isFailed;
  }

  finalResult(): 'CLEAR' | 'FAILED' {
    return this.isFailed ? 'FAILED' : 'CLEAR';
  }

  snapshot(): GaugeSnapshot {
    return {
      type: this.type,
      value: this.val,
      clearLine: 0,
      isSurvival: true,
      failed: this.isFailed,
    };
  }
}

export function createGauge(
  type: GaugeType,
  opts: { total: number; noteCount: number },
): GaugeEngine {
  if (type === 'HARD' || type === 'EX_HARD') {
    return new SurvivalGauge(type);
  }
  const r = opts.noteCount > 0 ? opts.total / opts.noteCount : 0;
  return new RecoveryGauge(type, r);
}

export type ClearLamp =
  | 'NO_PLAY'
  | 'FAILED'
  | 'ASSIST_CLEAR'
  | 'EASY_CLEAR'
  | 'CLEAR'
  | 'HARD_CLEAR'
  | 'EX_HARD_CLEAR'
  | 'FULL_COMBO';

/** Ascending order, exactly as listed in the ClearLamp union. */
export const CLEAR_LAMP_ORDER: readonly ClearLamp[] = [
  'NO_PLAY',
  'FAILED',
  'ASSIST_CLEAR',
  'EASY_CLEAR',
  'CLEAR',
  'HARD_CLEAR',
  'EX_HARD_CLEAR',
  'FULL_COMBO',
];

export function clearLampFor(type: GaugeType, cleared: boolean, fullCombo: boolean): ClearLamp {
  if (fullCombo && cleared) return 'FULL_COMBO';
  if (!cleared) return 'FAILED';
  switch (type) {
    case 'ASSIST_EASY':
      return 'ASSIST_CLEAR';
    case 'EASY':
      return 'EASY_CLEAR';
    case 'NORMAL':
      return 'CLEAR';
    case 'HARD':
      return 'HARD_CLEAR';
    case 'EX_HARD':
      return 'EX_HARD_CLEAR';
  }
}
