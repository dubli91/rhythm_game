import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_BPM,
  CALIBRATION_TAP_TARGET,
  beatPeriodMs,
  createCalibrationSession,
  initialLatencyEstimateMs,
  tapErrorMs,
} from './calibration';

describe('tapErrorMs', () => {
  // 120 BPM → 500ms period; clicks at 0, 500, 1000, …
  const PERIOD = 500;

  it('is the signed distance to the NEAREST click (positive = late)', () => {
    expect(tapErrorMs(10, PERIOD)).toBe(10);
    expect(tapErrorMs(490, PERIOD)).toBe(-10);
    expect(tapErrorMs(1500, PERIOD)).toBe(0);
    expect(tapErrorMs(1520, PERIOD)).toBe(20);
    expect(tapErrorMs(1480, PERIOD)).toBe(-20);
  });

  it('wraps at half a period — a very late tap reads as early for the next click', () => {
    expect(tapErrorMs(260, PERIOD)).toBe(-240);
    expect(tapErrorMs(240, PERIOD)).toBe(240);
  });
});

describe('createCalibrationSession', () => {
  it('defaults to 120 BPM / 16 taps (settings-screen.md SHOULD 12)', () => {
    const session = createCalibrationSession();
    expect(session.bpm).toBe(CALIBRATION_BPM);
    expect(session.periodMs).toBe(beatPeriodMs(CALIBRATION_BPM));
    expect(session.state().tapTarget).toBe(CALIBRATION_TAP_TARGET);
  });

  it('accumulates a running mean and proposes the rounded mean once done', () => {
    const session = createCalibrationSession();
    const period = session.periodMs;
    for (let k = 0; k < CALIBRATION_TAP_TARGET; k++) {
      session.addTap(k * period + 20); // consistently 20ms late
    }
    const st = session.state();
    expect(st.done).toBe(true);
    expect(st.tapCount).toBe(CALIBRATION_TAP_TARGET);
    expect(st.meanErrorMs).toBeCloseTo(20, 6);
    expect(st.proposedOffsetMs).toBe(20);
  });

  it('has no proposal before the target is reached', () => {
    const session = createCalibrationSession();
    const st = session.addTap(10);
    expect(st.done).toBe(false);
    expect(st.meanErrorMs).toBeCloseTo(10, 6);
    expect(st.proposedOffsetMs).toBeNull();
  });

  it('alternating early/late taps cancel to a zero proposal', () => {
    const session = createCalibrationSession();
    const period = session.periodMs;
    for (let k = 0; k < CALIBRATION_TAP_TARGET; k++) {
      session.addTap(k * period + (k % 2 === 0 ? 15 : -15));
    }
    expect(session.state().meanErrorMs).toBeCloseTo(0, 6);
    expect(session.state().proposedOffsetMs).toBe(0);
  });

  it('clamps the proposal to the legal ±200ms offset range', () => {
    const session = createCalibrationSession();
    const period = session.periodMs;
    for (let k = 0; k < CALIBRATION_TAP_TARGET; k++) {
      session.addTap(k * period + 240); // mean 240 > clamp
    }
    expect(session.state().proposedOffsetMs).toBe(200);
  });

  it('rounds the proposal to an integer', () => {
    const session = createCalibrationSession({ tapTarget: 2 });
    session.addTap(12);
    session.addTap(session.periodMs + 13);
    expect(session.state().meanErrorMs).toBeCloseTo(12.5, 6);
    expect(session.state().proposedOffsetMs).toBe(13); // Math.round(12.5)
  });

  it('ignores taps after the target (proposal frozen)', () => {
    const session = createCalibrationSession({ tapTarget: 3 });
    session.addTap(5);
    session.addTap(session.periodMs + 5);
    session.addTap(2 * session.periodMs + 5);
    expect(session.state().done).toBe(true);
    session.addTap(3 * session.periodMs + 200);
    expect(session.state().tapCount).toBe(3);
    expect(session.state().proposedOffsetMs).toBe(5);
  });

  it('ignores taps that predate the first click by more than half a period', () => {
    const session = createCalibrationSession();
    const st = session.addTap(-session.periodMs); // way before click 0
    expect(st.tapCount).toBe(0);
    const st2 = session.addTap(-100); // plausibly aimed at click 0
    expect(st2.tapCount).toBe(1);
    expect(st2.meanErrorMs).toBeCloseTo(-100, 6);
  });
});

describe('initialLatencyEstimateMs (audio-playback.md SHOULD 11)', () => {
  it('rounds a reported outputLatency to whole ms', () => {
    expect(initialLatencyEstimateMs(0.02)).toBe(20);
    expect(initialLatencyEstimateMs(0.0355)).toBe(36);
  });

  it('returns null for absent, non-finite, or non-positive values', () => {
    expect(initialLatencyEstimateMs(undefined)).toBeNull();
    expect(initialLatencyEstimateMs(Number.NaN)).toBeNull();
    expect(initialLatencyEstimateMs(0)).toBeNull();
    expect(initialLatencyEstimateMs(-0.01)).toBeNull();
  });
});
