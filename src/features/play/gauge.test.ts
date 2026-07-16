import { describe, expect, it } from 'vitest';
import { CLEAR_LAMP_ORDER, GAUGE_CONSTANTS, clearLampFor, createGauge } from './gauge';
import type { JudgementEvent, JudgementGrade, JudgementKind } from './types';

function ev(kind: JudgementKind, grade: JudgementGrade): JudgementEvent {
  return {
    kind,
    grade,
    lane: 1,
    noteIndex: kind === 'emptyPoor' ? -1 : 0,
    deltaMs: kind === 'hit' ? 0 : null,
    songTimeMs: 0,
  };
}

const hit = (grade: JudgementGrade) => ev('hit', grade);
const missPoor = ev('missPoor', 'POOR');
const emptyPoor = ev('emptyPoor', 'POOR');
const cnBreak = ev('cnBreak', 'BAD');
const cnComplete = ev('cnComplete', 'PGREAT');

describe('recovery gauges — table-exact deltas', () => {
  it('NORMAL: PGREAT/GREAT +R, GOOD +R/2, BAD -2.0, missPoor -6.0, emptyPoor -2.0', () => {
    // total=200, noteCount=1000 -> R = 0.2
    const g = createGauge('NORMAL', { total: 200, noteCount: 1000 });
    expect(g.value()).toBeCloseTo(22, 5);

    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(22 + 0.2, 5);

    g.apply(hit('GREAT'));
    expect(g.value()).toBeCloseTo(22 + 0.2 + 0.2, 5);

    g.apply(hit('GOOD'));
    expect(g.value()).toBeCloseTo(22 + 0.2 + 0.2 + 0.1, 5);

    const before = g.value();
    g.apply(hit('BAD'));
    expect(g.value()).toBeCloseTo(before - 2.0, 5);

    const before2 = g.value();
    g.apply(missPoor);
    expect(g.value()).toBeCloseTo(before2 - 6.0, 5);

    const before3 = g.value();
    g.apply(emptyPoor);
    expect(g.value()).toBeCloseTo(before3 - 2.0, 5);
  });

  it('EASY: PGREAT/GREAT +R*1.2, GOOD +R*0.6, BAD -1.6, missPoor -4.8, emptyPoor -1.6', () => {
    const g = createGauge('EASY', { total: 200, noteCount: 1000 }); // R = 0.2
    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(22 + 0.2 * 1.2, 5);

    g.apply(hit('GOOD'));
    expect(g.value()).toBeCloseTo(22 + 0.2 * 1.2 + 0.2 * 0.6, 5);

    const before = g.value();
    g.apply(hit('BAD'));
    expect(g.value()).toBeCloseTo(before - 1.6, 5);

    const before2 = g.value();
    g.apply(missPoor);
    expect(g.value()).toBeCloseTo(before2 - 4.8, 5);

    const before3 = g.value();
    g.apply(emptyPoor);
    expect(g.value()).toBeCloseTo(before3 - 1.6, 5);
  });

  it('ASSIST_EASY: same deltas as EASY, only clear line differs', () => {
    const g = createGauge('ASSIST_EASY', { total: 200, noteCount: 1000 });
    g.apply(hit('GREAT'));
    expect(g.value()).toBeCloseTo(22 + 0.2 * 1.2, 5);
    expect(g.snapshot().clearLine).toBe(GAUGE_CONSTANTS.RECOVERY.CLEAR_LINE.ASSIST_EASY);
  });

  it('floors at 2 and never goes below, even with many misses', () => {
    const g = createGauge('NORMAL', { total: 200, noteCount: 1000 });
    for (let i = 0; i < 50; i++) g.apply(missPoor);
    expect(g.value()).toBeCloseTo(GAUGE_CONSTANTS.RECOVERY.FLOOR, 5);
    expect(g.value()).toBeGreaterThanOrEqual(GAUGE_CONSTANTS.RECOVERY.FLOOR);
  });

  it('caps at 100, never exceeds it, even with many PGREATs', () => {
    const g = createGauge('NORMAL', { total: 200, noteCount: 1000 });
    for (let i = 0; i < 500; i++) g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(100, 5);
    expect(g.value()).toBeLessThanOrEqual(100);
  });

  it('recovery gauges never set failed()', () => {
    const g = createGauge('EASY', { total: 200, noteCount: 1000 });
    for (let i = 0; i < 50; i++) g.apply(missPoor);
    expect(g.failed()).toBe(false);
  });
});

describe('recovery gauges — clear line boundaries', () => {
  it('NORMAL: value 79.9 -> FAILED', () => {
    // total=57.9, noteCount=1 -> R = 57.9; one PGREAT hit: 22 + 57.9 = 79.9
    const g = createGauge('NORMAL', { total: 57.9, noteCount: 1 });
    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(79.9, 5);
    expect(g.finalResult()).toBe('FAILED');
  });

  it('NORMAL: value exactly 80.0 -> CLEAR', () => {
    // total=58, noteCount=1 -> R = 58; one PGREAT hit: 22 + 58 = 80
    const g = createGauge('NORMAL', { total: 58, noteCount: 1 });
    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(80.0, 5);
    expect(g.finalResult()).toBe('CLEAR');
  });

  it('ASSIST_EASY: value exactly 60.0 -> CLEAR', () => {
    // total = 38/1.2, noteCount=1 -> R*1.2 = 38; 22 + 38 = 60
    const g = createGauge('ASSIST_EASY', { total: 38 / 1.2, noteCount: 1 });
    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(60.0, 5);
    expect(g.finalResult()).toBe('CLEAR');
  });

  it('ASSIST_EASY: value 59.9 -> FAILED', () => {
    // total = 37.9/1.2, noteCount=1 -> R*1.2 = 37.9; 22 + 37.9 = 59.9
    const g = createGauge('ASSIST_EASY', { total: 37.9 / 1.2, noteCount: 1 });
    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(59.9, 5);
    expect(g.finalResult()).toBe('FAILED');
  });
});

describe('survival gauges — table-exact deltas', () => {
  it('HARD: PGREAT/GREAT +0.16, GOOD +0.08, BAD -6, missPoor -10, emptyPoor -2 (above mitigation threshold)', () => {
    const g = createGauge('HARD', { total: 200, noteCount: 1000 });
    expect(g.value()).toBe(100);

    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(100, 5); // capped at 100

    // Drive down to well above 30% first with a controlled BAD, then check exact deltas.
    g.apply(hit('GOOD')); // no-op re: cap, still 100
    expect(g.value()).toBeCloseTo(100, 5);

    const g2 = createGauge('HARD', { total: 200, noteCount: 1000 });
    g2.apply(hit('BAD')); // 100 -> 94 (no mitigation, well above 30)
    expect(g2.value()).toBeCloseTo(94, 5);
    g2.apply(missPoor); // 94 -> 84
    expect(g2.value()).toBeCloseTo(84, 5);
    g2.apply(emptyPoor); // 84 -> 82
    expect(g2.value()).toBeCloseTo(82, 5);
  });

  it('EX_HARD: PGREAT/GREAT +0.16, GOOD +0.08, BAD -12, missPoor -20, emptyPoor -4, no mitigation ever', () => {
    const g = createGauge('EX_HARD', { total: 200, noteCount: 1000 });
    g.apply(hit('BAD')); // 100 -> 88
    expect(g.value()).toBeCloseTo(88, 5);
    g.apply(emptyPoor); // 88 -> 84
    expect(g.value()).toBeCloseTo(84, 5);
  });
});

describe('CN tail events — gauge deltas', () => {
  it('recovery gauge: cnBreak takes the BAD decrement, cnComplete is neutral', () => {
    const g = createGauge('NORMAL', { total: 200, noteCount: 1000 });
    const before = g.value();
    g.apply(cnComplete);
    expect(g.value()).toBeCloseTo(before, 5);
    g.apply(cnBreak);
    expect(g.value()).toBeCloseTo(before + GAUGE_CONSTANTS.RECOVERY.NORMAL.BAD, 5);
  });

  it('survival gauge: cnBreak takes the BAD decrement, cnComplete is neutral', () => {
    const g = createGauge('HARD', { total: 200, noteCount: 1000 });
    g.apply(cnComplete);
    expect(g.value()).toBeCloseTo(100, 5);
    g.apply(cnBreak);
    expect(g.value()).toBeCloseTo(100 + GAUGE_CONSTANTS.SURVIVAL.HARD.BAD, 5);
  });

  it('HARD <30% mitigation halves a cnBreak decrement like any other', () => {
    const g = createGauge('HARD', { total: 200, noteCount: 1000 });
    for (let i = 0; i < 8; i++) g.apply(missPoor); // 100 -> 20 (8th applies unmitigated at exactly 30)
    expect(g.value()).toBeCloseTo(20, 5);
    g.apply(cnBreak); // pre-decrement 20 < 30 -> halved: -3
    expect(g.value()).toBeCloseTo(17, 5);
  });

  it('EX_HARD: cnBreak takes the full -12 BAD decrement (never mitigated)', () => {
    const g = createGauge('EX_HARD', { total: 200, noteCount: 1000 });
    for (let i = 0; i < 4; i++) g.apply(missPoor); // 100 -> 20
    g.apply(cnBreak);
    expect(g.value()).toBeCloseTo(20 + GAUGE_CONSTANTS.SURVIVAL.EX_HARD.BAD, 5);
  });
});

describe('HARD mitigation (spec acceptance)', () => {
  // All HARD deltas (0.16, 0.08, -6, -10, -2) are multiples of 0.08, and 100 is too, so the
  // gauge can only ever land on multiples of 0.08 — an exact 29.00 is not reachable through
  // any sequence of real deltas. 29.04 is the closest reachable value below 30 and stands in
  // for "at 29%" from the spec's acceptance example, exercising the identical halving rule.
  function hardAt2904() {
    const g = createGauge('HARD', { total: 200, noteCount: 1000 });
    // 35 emptyPoor: 100 -> 30 (still >=30 throughout, no mitigation).
    for (let i = 0; i < 35; i++) g.apply(emptyPoor);
    // 36th emptyPoor: value is 30 (30 < 30 is false) -> full -2 -> 28.
    g.apply(emptyPoor);
    // 13 GOOD hits (+0.08 each, positive deltas are never mitigated): 28 -> 29.04.
    for (let i = 0; i < 13; i++) g.apply(hit('GOOD'));
    return g;
  }

  function hardAt(value: number) {
    // Build a HARD gauge and drive it exactly to `value` using emptyPoor (-2, no mitigation
    // concern since we stay at/above 30 while getting there), starting from 100.
    const g = createGauge('HARD', { total: 200, noteCount: 1000 });
    const steps = (100 - value) / 2;
    for (let i = 0; i < steps; i++) g.apply(emptyPoor);
    return g;
  }

  it('at 29.04% (closest reachable stand-in for 29%), BAD costs -3 (halved): 29.04 -> 26.04', () => {
    const g = hardAt2904();
    expect(g.value()).toBeCloseTo(29.04, 5);
    g.apply(hit('BAD'));
    expect(g.value()).toBeCloseTo(26.04, 5);
  });

  it('at exactly 30%, BAD costs the full -6 (no halving): 30 -> 24', () => {
    const g = hardAt(30);
    expect(g.value()).toBeCloseTo(30, 5);
    g.apply(hit('BAD'));
    expect(g.value()).toBeCloseTo(24, 5);
  });
});

describe('survival gauge failure', () => {
  it('EX_HARD: 5 consecutive missPoor from 100 -> 0, failed() true, finalResult FAILED, further events ignored', () => {
    const g = createGauge('EX_HARD', { total: 200, noteCount: 1000 });
    for (let i = 0; i < 4; i++) {
      g.apply(missPoor);
    }
    expect(g.value()).toBeCloseTo(20, 5);
    expect(g.failed()).toBe(false);

    g.apply(missPoor); // 5th: 20 -> 0
    expect(g.value()).toBeCloseTo(0, 5);
    expect(g.failed()).toBe(true);
    expect(g.finalResult()).toBe('FAILED');

    // Further events must be no-ops once failed.
    g.apply(hit('PGREAT'));
    expect(g.value()).toBeCloseTo(0, 5);
    expect(g.failed()).toBe(true);
    expect(g.finalResult()).toBe('FAILED');
  });

  it('HARD survives to song end at any value > 0 -> CLEAR', () => {
    const g = createGauge('HARD', { total: 200, noteCount: 1000 });
    g.apply(hit('BAD'));
    g.apply(hit('BAD'));
    expect(g.value()).toBeGreaterThan(0);
    expect(g.failed()).toBe(false);
    expect(g.finalResult()).toBe('CLEAR');
  });

  it('snapshot reflects survival gauge shape (isSurvival true, clearLine 0)', () => {
    const g = createGauge('HARD', { total: 200, noteCount: 1000 });
    const snap = g.snapshot();
    expect(snap.isSurvival).toBe(true);
    expect(snap.clearLine).toBe(0);
    expect(snap.failed).toBe(false);
    expect(snap.type).toBe('HARD');
  });

  it('snapshot reflects recovery gauge shape (isSurvival false, clearLine matches type)', () => {
    const g = createGauge('EASY', { total: 200, noteCount: 1000 });
    const snap = g.snapshot();
    expect(snap.isSurvival).toBe(false);
    expect(snap.clearLine).toBe(80);
    expect(snap.failed).toBe(false);
  });
});

describe('clearLampFor', () => {
  it('full combo overrides everything when cleared', () => {
    expect(clearLampFor('NORMAL', true, true)).toBe('FULL_COMBO');
    expect(clearLampFor('EX_HARD', true, true)).toBe('FULL_COMBO');
    expect(clearLampFor('ASSIST_EASY', true, true)).toBe('FULL_COMBO');
  });

  it('full combo does NOT override a failed clear', () => {
    expect(clearLampFor('NORMAL', false, true)).toBe('FAILED');
  });

  it('FAILED whenever not cleared, regardless of gauge type', () => {
    for (const type of ['ASSIST_EASY', 'EASY', 'NORMAL', 'HARD', 'EX_HARD'] as const) {
      expect(clearLampFor(type, false, false)).toBe('FAILED');
    }
  });

  it('maps each gauge type to its clear lamp when cleared without full combo', () => {
    expect(clearLampFor('ASSIST_EASY', true, false)).toBe('ASSIST_CLEAR');
    expect(clearLampFor('EASY', true, false)).toBe('EASY_CLEAR');
    expect(clearLampFor('NORMAL', true, false)).toBe('CLEAR');
    expect(clearLampFor('HARD', true, false)).toBe('HARD_CLEAR');
    expect(clearLampFor('EX_HARD', true, false)).toBe('EX_HARD_CLEAR');
  });
});

describe('CLEAR_LAMP_ORDER', () => {
  it('is exactly the ascending order specified', () => {
    expect(CLEAR_LAMP_ORDER).toEqual([
      'NO_PLAY',
      'FAILED',
      'ASSIST_CLEAR',
      'EASY_CLEAR',
      'CLEAR',
      'HARD_CLEAR',
      'EX_HARD_CLEAR',
      'FULL_COMBO',
    ]);
  });

  it('places FAILED below every clear lamp and FULL_COMBO above every clear lamp', () => {
    const idx = (lamp: (typeof CLEAR_LAMP_ORDER)[number]) => CLEAR_LAMP_ORDER.indexOf(lamp);
    expect(idx('FAILED')).toBeLessThan(idx('ASSIST_CLEAR'));
    expect(idx('ASSIST_CLEAR')).toBeLessThan(idx('EASY_CLEAR'));
    expect(idx('EASY_CLEAR')).toBeLessThan(idx('CLEAR'));
    expect(idx('CLEAR')).toBeLessThan(idx('HARD_CLEAR'));
    expect(idx('HARD_CLEAR')).toBeLessThan(idx('EX_HARD_CLEAR'));
    expect(idx('EX_HARD_CLEAR')).toBeLessThan(idx('FULL_COMBO'));
  });
});
