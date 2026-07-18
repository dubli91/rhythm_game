// Play-option value rules (specs/play-options.md MUST 1-9, 15-17) shared by the
// song-select options panel (shell.ts) and the in-play adjustment keys
// (controller.ts). Single source of truth for ranges/steps/cycle order so the
// two surfaces can never drift apart.

import type { Arrangement, TimingDisplayMode } from './types';

// Hi-speed multiplier (play-options.md MUST 1): 0.50–10.00 in 0.25 steps.
// Every reachable value is an exact binary float, so repeated stepping never drifts.
export const HI_SPEED_MIN = 0.5;
export const HI_SPEED_MAX = 10;
export const HI_SPEED_STEP = 0.25;

// SUDDEN+ cover height as % of the scroll area above the judgement line
// (play-options.md MUST 5): 0–80 in 1% steps.
export const COVER_MIN = 0;
export const COVER_MAX = 80;
export const COVER_STEP = 1;

// Green-number lock target (play-options.md MUST 16): 200–2000ms in 10ms steps.
export const GREEN_TARGET_MIN = 200;
export const GREEN_TARGET_MAX = 2000;
export const GREEN_TARGET_STEP = 10;
/** Stored default before the player ever sets one; mid-range, snapped to step. */
export const GREEN_TARGET_DEFAULT = 1000;

/** Options-panel cycle order (song-select.md MUST 6). */
export const ARRANGEMENTS: readonly Arrangement[] = ['OFF', 'RANDOM', 'MIRROR'];

/** Timing-display cycle order (play-options.md MUST 18). Starts at the default
 * FAST_SLOW (default ON — the JTBD is improvement); select-panel only, no
 * in-play key. Display-only: aggregation runs even at OFF. */
export const TIMING_DISPLAY_MODES: readonly TimingDisplayMode[] = ['FAST_SLOW', 'MS', 'OFF'];

const TIMING_DISPLAY_LABELS: Record<TimingDisplayMode, string> = {
  FAST_SLOW: 'FAST/SLOW',
  MS: '±ms',
  OFF: 'OFF',
};

export function stepHiSpeed(value: number, direction: -1 | 1): number {
  const next = value + direction * HI_SPEED_STEP;
  return Math.min(HI_SPEED_MAX, Math.max(HI_SPEED_MIN, next));
}

export function stepCover(value: number, direction: -1 | 1): number {
  return clampCover(value + direction * COVER_STEP);
}

export function clampCover(value: number): number {
  return Math.min(COVER_MAX, Math.max(COVER_MIN, Math.round(value)));
}

export function nextArrangement(current: Arrangement): Arrangement {
  const index = ARRANGEMENTS.indexOf(current);
  return ARRANGEMENTS[(index + 1) % ARRANGEMENTS.length] ?? 'OFF';
}

export function nextTimingDisplay(current: TimingDisplayMode): TimingDisplayMode {
  const index = TIMING_DISPLAY_MODES.indexOf(current);
  return TIMING_DISPLAY_MODES[(index + 1) % TIMING_DISPLAY_MODES.length] ?? 'FAST_SLOW';
}

/** Options-bar label for a timing display mode (single source, shared with e2e). */
export function timingDisplayLabel(mode: TimingDisplayMode): string {
  return TIMING_DISPLAY_LABELS[mode];
}

/** Snap to the 10ms grid, then clamp to 200–2000 (play-options.md MUST 16). */
export function clampGreenTarget(value: number): number {
  const snapped = Math.round(value / GREEN_TARGET_STEP) * GREEN_TARGET_STEP;
  return Math.min(GREEN_TARGET_MAX, Math.max(GREEN_TARGET_MIN, snapped));
}

export function stepGreenTarget(value: number, direction: -1 | 1): number {
  return clampGreenTarget(value + direction * GREEN_TARGET_STEP);
}

/** Scroll geometry owned by the renderer (RENDER_LAYOUT); injected so this
 *  module stays headless. render.ts exports `greenNumberFor` bound to it. */
export interface ScrollGeometry {
  /** px from the playfield top edge to the judgement line. */
  scrollHeightPx: number;
  pixelsPerBeat: number;
}

// Green number (play-options.md SHOULD 13): how long a note stays visible, in
// ms, under the current hi-speed and SUDDEN+ cover. Notes travel
// pixelsPerBeat × hiSpeed px per beat at bpm beats/min, and the visible run is
// the scroll area minus whatever the cover hides:
//   green = scrollPx × (1 − cover/100) / (pixelsPerBeat × hiSpeed × bpm / 60000)
// Reference BPM (pinned in the spec): song select uses the song's MAX BPM —
// the catalog only carries a song-level min/max before the chart JSON
// lazy-loads, and max keeps the fastest section of a soflan chart readable.
// In play the HUD readout follows the CURRENT BPM instead, because scroll
// speed is BPM-proportional (MUST 2) and the true visible time moves with it.
export function greenNumberMs(
  bpm: number,
  hiSpeed: number,
  coverPercent: number,
  geometry: ScrollGeometry,
): number {
  if (bpm <= 0 || hiSpeed <= 0) return 0;
  const visiblePx = geometry.scrollHeightPx * (1 - clampCover(coverPercent) / 100);
  const pxPerMs = (geometry.pixelsPerBeat * hiSpeed * bpm) / 60000;
  return Math.round(visiblePx / pxPerMs);
}

// Green-number lock (play-options.md MUST 15/17): the inverse of greenNumberMs,
// solved for hiSpeed — the effective hi-speed that makes the visible time equal
// targetMs at the given BPM and cover. NOT snapped to the manual 0.25 grid
// (quantizing would defeat "GREEN stays at the target through soflan"); clamped
// to the manual range per MUST 17, so the actual visible time can differ from
// the target at extreme BPM × target combinations — display code must always
// recompute the actual green from the returned value, never echo the target.
export function hiSpeedForGreenTarget(
  bpm: number,
  targetMs: number,
  coverPercent: number,
  geometry: ScrollGeometry,
): number {
  if (bpm <= 0 || targetMs <= 0) return HI_SPEED_MAX;
  const visiblePx = geometry.scrollHeightPx * (1 - clampCover(coverPercent) / 100);
  const raw = (visiblePx * 60000) / (geometry.pixelsPerBeat * bpm * targetMs);
  return Math.min(HI_SPEED_MAX, Math.max(HI_SPEED_MIN, raw));
}
