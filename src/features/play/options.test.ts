import { describe, expect, it } from 'vitest';
import {
  ARRANGEMENTS,
  COVER_MAX,
  COVER_MIN,
  HI_SPEED_MAX,
  HI_SPEED_MIN,
  HI_SPEED_STEP,
  clampCover,
  nextArrangement,
  stepCover,
  stepHiSpeed,
} from './options';

describe('stepHiSpeed', () => {
  it('steps by 0.25 in both directions', () => {
    expect(stepHiSpeed(1.0, 1)).toBe(1.25);
    expect(stepHiSpeed(1.0, -1)).toBe(0.75);
  });

  it('clamps at the 0.50–10.00 spec range (play-options.md MUST 1)', () => {
    expect(stepHiSpeed(HI_SPEED_MIN, -1)).toBe(HI_SPEED_MIN);
    expect(stepHiSpeed(HI_SPEED_MAX, 1)).toBe(HI_SPEED_MAX);
  });

  it('walking the full range and back lands exactly on the endpoints (no float drift)', () => {
    let v = HI_SPEED_MIN;
    const steps = Math.round((HI_SPEED_MAX - HI_SPEED_MIN) / HI_SPEED_STEP);
    for (let i = 0; i < steps; i++) v = stepHiSpeed(v, 1);
    expect(v).toBe(HI_SPEED_MAX);
    for (let i = 0; i < steps; i++) v = stepHiSpeed(v, -1);
    expect(v).toBe(HI_SPEED_MIN);
  });
});

describe('stepCover / clampCover', () => {
  it('steps by 1% and clamps at 0–80 (play-options.md MUST 5)', () => {
    expect(stepCover(30, 1)).toBe(31);
    expect(stepCover(30, -1)).toBe(29);
    expect(stepCover(COVER_MIN, -1)).toBe(COVER_MIN);
    expect(stepCover(COVER_MAX, 1)).toBe(COVER_MAX);
  });

  it('clampCover rounds and clamps arbitrary values', () => {
    expect(clampCover(-5)).toBe(0);
    expect(clampCover(200)).toBe(80);
    expect(clampCover(40.6)).toBe(41);
  });
});

describe('nextArrangement', () => {
  it('cycles OFF → RANDOM → MIRROR → OFF', () => {
    expect(nextArrangement('OFF')).toBe('RANDOM');
    expect(nextArrangement('RANDOM')).toBe('MIRROR');
    expect(nextArrangement('MIRROR')).toBe('OFF');
  });

  it('covers every arrangement exactly once per full cycle', () => {
    const seen = new Set([ARRANGEMENTS[0]]);
    let current = ARRANGEMENTS[0] ?? 'OFF';
    for (let i = 0; i < ARRANGEMENTS.length - 1; i++) {
      current = nextArrangement(current);
      seen.add(current);
    }
    expect(seen.size).toBe(ARRANGEMENTS.length);
  });
});
