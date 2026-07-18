import { describe, expect, it } from 'vitest';
import {
  ARRANGEMENTS,
  COVER_MAX,
  COVER_MIN,
  GREEN_TARGET_MAX,
  GREEN_TARGET_MIN,
  HI_SPEED_MAX,
  HI_SPEED_MIN,
  HI_SPEED_STEP,
  type ScrollGeometry,
  TIMING_DISPLAY_MODES,
  clampCover,
  clampGreenTarget,
  greenNumberMs,
  hiSpeedForGreenTarget,
  nextArrangement,
  nextTimingDisplay,
  stepCover,
  stepGreenTarget,
  stepHiSpeed,
  timingDisplayLabel,
} from './options';
import { RENDER_LAYOUT, formatTimingIndicator, greenNumberFor, lockedHiSpeedFor } from './render';

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

describe('timing display mode (play-options.md MUST 18)', () => {
  it('defaults to FAST_SLOW: the cycle order starts at the spec default', () => {
    // Default ON — the JTBD is improvement, so the indicator ships enabled.
    expect(TIMING_DISPLAY_MODES[0]).toBe('FAST_SLOW');
  });

  it('cycles FAST_SLOW → MS → OFF → FAST_SLOW', () => {
    expect(nextTimingDisplay('FAST_SLOW')).toBe('MS');
    expect(nextTimingDisplay('MS')).toBe('OFF');
    expect(nextTimingDisplay('OFF')).toBe('FAST_SLOW');
  });

  it('covers every mode exactly once per full cycle', () => {
    const seen = new Set([TIMING_DISPLAY_MODES[0]]);
    let current = TIMING_DISPLAY_MODES[0] ?? 'FAST_SLOW';
    for (let i = 0; i < TIMING_DISPLAY_MODES.length - 1; i++) {
      current = nextTimingDisplay(current);
      seen.add(current);
    }
    expect(seen.size).toBe(TIMING_DISPLAY_MODES.length);
  });

  it('labels every mode distinctly for the options bar', () => {
    const labels = TIMING_DISPLAY_MODES.map(timingDisplayLabel);
    expect(labels).toEqual(['FAST/SLOW', '±ms', 'OFF']);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('formatTimingIndicator (playfield-rendering.md MUST 18)', () => {
  it('FAST_SLOW mode renders the word; MS mode renders the signed integer δ', () => {
    expect(formatTimingIndicator('FAST_SLOW', 'FAST', -20)).toBe('FAST');
    expect(formatTimingIndicator('FAST_SLOW', 'SLOW', 20)).toBe('SLOW');
    expect(formatTimingIndicator('MS', 'FAST', -13.4)).toBe('-13ms');
    expect(formatTimingIndicator('MS', 'SLOW', 27.6)).toBe('+28ms');
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

describe('green-number lock target rules (play-options.md MUST 16)', () => {
  it('clampGreenTarget snaps to the 10ms grid and clamps to 200–2000', () => {
    expect(clampGreenTarget(504)).toBe(500);
    expect(clampGreenTarget(506)).toBe(510);
    expect(clampGreenTarget(50)).toBe(GREEN_TARGET_MIN);
    expect(clampGreenTarget(9999)).toBe(GREEN_TARGET_MAX);
    expect(clampGreenTarget(GREEN_TARGET_MIN)).toBe(GREEN_TARGET_MIN);
    expect(clampGreenTarget(GREEN_TARGET_MAX)).toBe(GREEN_TARGET_MAX);
  });

  it('stepGreenTarget moves ±10ms and clamps at the range edges', () => {
    expect(stepGreenTarget(500, 1)).toBe(510);
    expect(stepGreenTarget(500, -1)).toBe(490);
    expect(stepGreenTarget(GREEN_TARGET_MIN, -1)).toBe(GREEN_TARGET_MIN);
    expect(stepGreenTarget(GREEN_TARGET_MAX, 1)).toBe(GREEN_TARGET_MAX);
  });
});

describe('hiSpeedForGreenTarget (play-options.md MUST 15/17)', () => {
  const GEOMETRY: ScrollGeometry = { scrollHeightPx: 600, pixelsPerBeat: 130 };

  it('inverts greenNumberMs: the derived hi-speed reproduces the target exactly', () => {
    for (const bpm of [60, 140, 150, 175, 185, 400]) {
      for (const target of [300, 500, 1000, 1500]) {
        const hs = hiSpeedForGreenTarget(bpm, target, 0, GEOMETRY);
        if (hs > HI_SPEED_MIN && hs < HI_SPEED_MAX) {
          expect(greenNumberMs(bpm, hs, 0, GEOMETRY)).toBe(target);
        }
      }
    }
  });

  it('holds the target through a soflan BPM change (140→175 acceptance criterion)', () => {
    // The whole point of the lock: at target 500ms, both BPM extremes of the
    // Neon Cascade soflan derive hi-speeds whose ACTUAL green number is 500.
    const hs140 = hiSpeedForGreenTarget(140, 500, 0, GEOMETRY);
    const hs175 = hiSpeedForGreenTarget(175, 500, 0, GEOMETRY);
    expect(hs140).not.toBe(hs175);
    expect(greenNumberMs(140, hs140, 0, GEOMETRY)).toBe(500);
    expect(greenNumberMs(175, hs175, 0, GEOMETRY)).toBe(500);
  });

  it('accounts for the SUDDEN+ cover in the derivation', () => {
    const hs = hiSpeedForGreenTarget(150, 500, 32, GEOMETRY);
    expect(greenNumberMs(150, hs, 32, GEOMETRY)).toBe(500);
    // Less visible run at the same target ⇒ slower derived speed.
    expect(hs).toBeLessThan(hiSpeedForGreenTarget(150, 500, 0, GEOMETRY));
  });

  it('clamps to the manual hi-speed range; the actual green then diverges (MUST 17)', () => {
    // BPM 400 × target 2000 wants HS 0.346… → clamps to 0.50.
    expect(hiSpeedForGreenTarget(400, 2000, 0, GEOMETRY)).toBe(HI_SPEED_MIN);
    expect(greenNumberMs(400, HI_SPEED_MIN, 0, GEOMETRY)).not.toBe(2000);
    // BPM 60 × target 200 wants HS 23.1 → clamps to 10.00.
    expect(hiSpeedForGreenTarget(60, 200, 0, GEOMETRY)).toBe(HI_SPEED_MAX);
  });

  it('degenerate inputs return the clamp ceiling instead of Infinity/NaN', () => {
    expect(hiSpeedForGreenTarget(0, 500, 0, GEOMETRY)).toBe(HI_SPEED_MAX);
    expect(hiSpeedForGreenTarget(150, 0, 0, GEOMETRY)).toBe(HI_SPEED_MAX);
  });

  it('lockedHiSpeedFor is bound to the real RENDER_LAYOUT geometry like greenNumberFor', () => {
    const scrollHeightPx = RENDER_LAYOUT.JUDGEMENT_LINE_Y - RENDER_LAYOUT.LANE_TOP_Y;
    expect(lockedHiSpeedFor(150, 500, 0)).toBe(
      hiSpeedForGreenTarget(150, 500, 0, {
        scrollHeightPx,
        pixelsPerBeat: RENDER_LAYOUT.PIXELS_PER_BEAT,
      }),
    );
    // Round-trip through the renderer-bound pair: lock at 500 ⇒ GREEN reads 500.
    expect(greenNumberFor(150, lockedHiSpeedFor(150, 500, 0), 0)).toBe(500);
  });
});
