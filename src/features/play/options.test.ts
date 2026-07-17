import { describe, expect, it } from 'vitest';
import {
  ARRANGEMENTS,
  COVER_MAX,
  COVER_MIN,
  HI_SPEED_MAX,
  HI_SPEED_MIN,
  HI_SPEED_STEP,
  type ScrollGeometry,
  clampCover,
  greenNumberMs,
  nextArrangement,
  stepCover,
  stepHiSpeed,
} from './options';
import { RENDER_LAYOUT, greenNumberFor } from './render';

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

describe('greenNumberMs (play-options.md SHOULD 13)', () => {
  // The shipped geometry: judgement line 600px below the playfield top,
  // 130px per beat (RENDER_LAYOUT).
  const GEOMETRY: ScrollGeometry = { scrollHeightPx: 600, pixelsPerBeat: 130 };

  it('computes the visible time: scrollPx / (pixelsPerBeat × hiSpeed × bpm/60000)', () => {
    // 600px / (130 × 150/60000 px/ms) = 1846.15…
    expect(greenNumberMs(150, 1.0, 0, GEOMETRY)).toBe(1846);
    expect(greenNumberMs(150, 1.5, 0, GEOMETRY)).toBe(1231);
  });

  it('equal perceived speed ⇒ equal green number (BPM150×HS2.00 ≡ BPM300×HS1.00 criterion)', () => {
    expect(greenNumberMs(150, 2.0, 0, GEOMETRY)).toBe(greenNumberMs(300, 1.0, 0, GEOMETRY));
    expect(greenNumberMs(150, 2.0, 0, GEOMETRY)).toBe(923);
  });

  it('SUDDEN+ cover shrinks the visible run proportionally', () => {
    expect(greenNumberMs(150, 1.0, 50, GEOMETRY)).toBe(923); // half the 0% figure
    expect(greenNumberMs(150, 1.5, 32, GEOMETRY)).toBe(837); // 600×0.68 = 408px visible
  });

  it('returns 0 on degenerate inputs instead of Infinity/NaN', () => {
    expect(greenNumberMs(0, 1.0, 0, GEOMETRY)).toBe(0);
    expect(greenNumberMs(150, 0, 0, GEOMETRY)).toBe(0);
  });

  it('greenNumberFor is bound to the real RENDER_LAYOUT geometry (no drift with this test)', () => {
    const scrollHeightPx = RENDER_LAYOUT.JUDGEMENT_LINE_Y - RENDER_LAYOUT.LANE_TOP_Y;
    expect(greenNumberFor(150, 1.0, 0)).toBe(
      greenNumberMs(150, 1.0, 0, { scrollHeightPx, pixelsPerBeat: RENDER_LAYOUT.PIXELS_PER_BEAT }),
    );
    // Pins the shipped tuning; retuning RENDER_LAYOUT should consciously update
    // the expected values above AND the e2e options-bar assertions.
    expect(greenNumberFor(150, 1.0, 0)).toBe(1846);
  });
});
