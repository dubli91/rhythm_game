// Play-option value rules (specs/play-options.md MUST 1-9) shared by the
// song-select options panel (shell.ts) and the in-play adjustment keys
// (controller.ts). Single source of truth for ranges/steps/cycle order so the
// two surfaces can never drift apart.

import type { Arrangement } from './types';

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

/** Options-panel cycle order (song-select.md MUST 6). */
export const ARRANGEMENTS: readonly Arrangement[] = ['OFF', 'RANDOM', 'MIRROR'];

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
