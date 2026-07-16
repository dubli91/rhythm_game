// Offset-calibration math (specs/settings-screen.md SHOULD 12,
// specs/audio-playback.md SHOULD 10-11): the player taps along with a
// steady-BPM click; the mean signed error over ~16 taps becomes the proposed
// global offset. Pure math — the screen owns the click scheduling and key
// capture and feeds raw song-times in here.
//
// Why the proposal is exactly the mean raw error: taps are converted through a
// SongClock created with globalOffsetMs = 0, so a tap's error vs the nearest
// click is the player's full perceived latency (device output latency + their
// timing tendency). Play-time judgement computes δ = rawδ − globalOffset
// (audioClock formula), so setting globalOffset = mean(rawδ) centres the
// player's δ distribution on zero — the same shift the acceptance criterion
// "+50ms offset moves the δ distribution by 50ms" describes.

import { clampGlobalOffsetMs } from '../../lib/clock/audioClock';

export const CALIBRATION_BPM = 120;
export const CALIBRATION_TAP_TARGET = 16;

export function beatPeriodMs(bpm: number): number {
  return 60000 / bpm;
}

/**
 * Signed error of a tap vs the NEAREST click, in ms. Range is
 * [-periodMs/2, +periodMs/2]; positive = the tap landed late.
 */
export function tapErrorMs(rawSongTimeMs: number, periodMs: number): number {
  return rawSongTimeMs - Math.round(rawSongTimeMs / periodMs) * periodMs;
}

/**
 * Initial offset estimate from AudioContext.outputLatency (SHOULD 11), or null
 * when the browser doesn't report a usable value. Display-only seed — the
 * measured mean always wins.
 */
export function initialLatencyEstimateMs(outputLatencySec: number | undefined): number | null {
  if (outputLatencySec === undefined || !Number.isFinite(outputLatencySec)) return null;
  if (outputLatencySec <= 0) return null;
  return Math.round(outputLatencySec * 1000);
}

export interface CalibrationState {
  tapCount: number;
  tapTarget: number;
  /** Running mean of tap errors; null before the first tap. */
  meanErrorMs: number | null;
  /** Integer ms, clamped to the legal offset range; set once done. */
  proposedOffsetMs: number | null;
  done: boolean;
}

export interface CalibrationSession {
  readonly bpm: number;
  readonly periodMs: number;
  /**
   * Records one tap (raw = offset-free song time ms) and returns the new state.
   * Taps before the first click could plausibly be aimed at it (raw ≤ −period/2)
   * and taps after the target is reached are ignored.
   */
  addTap(rawSongTimeMs: number): CalibrationState;
  state(): CalibrationState;
}

export function createCalibrationSession(opts?: {
  bpm?: number;
  tapTarget?: number;
}): CalibrationSession {
  const bpm = opts?.bpm ?? CALIBRATION_BPM;
  const tapTarget = opts?.tapTarget ?? CALIBRATION_TAP_TARGET;
  const periodMs = beatPeriodMs(bpm);
  const errors: number[] = [];

  function state(): CalibrationState {
    const tapCount = errors.length;
    const mean = tapCount === 0 ? null : errors.reduce((sum, e) => sum + e, 0) / tapCount;
    const done = tapCount >= tapTarget;
    return {
      tapCount,
      tapTarget,
      meanErrorMs: mean,
      proposedOffsetMs: done && mean !== null ? clampGlobalOffsetMs(Math.round(mean)) : null,
      done,
    };
  }

  function addTap(rawSongTimeMs: number): CalibrationState {
    if (!state().done && rawSongTimeMs > -periodMs / 2) {
      errors.push(tapErrorMs(rawSongTimeMs, periodMs));
    }
    return state();
  }

  return { bpm, periodMs, addTap, state };
}
