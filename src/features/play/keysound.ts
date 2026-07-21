// Keysound trigger policy + player (specs/practice-song-content.md MUST 8): every
// lane key PRESS plays a single preloaded buffer immediately, regardless of
// whether a note was there or what the judgement was. This is the declared
// exception to 00-overview.md's "no real-time keysound playback" non-goal — scope
// is one practice song, one sample. Routed through the caller-supplied destination
// (the MUSIC gain bus per MUST 8, not the effects bus like menu SFX).

import type { SfxScheduleContextLike } from '../../lib/audio/sfx';
import { createSfxScheduler } from '../../lib/audio/sfx';
import type { JudgementEvent, JudgementKind } from './types';

/**
 * True for exactly the two judgement kinds a lane PRESS can produce: 'hit' (a
 * note was consumed, any grade) and 'emptyPoor' (no note in window). The other
 * kinds — 'missPoor' (advance()'s late-window sweep), 'cnBreak'/'cnComplete'
 * (onRelease()/advance()'s hold resolution) — are never presses, so they never
 * trigger a keysound. Autoplay's synthesized presses dispatch as 'hit' through
 * the same onJudgement path, which deliberately makes the autoplay demo
 * audible (IIDX autoplay plays keysounds).
 */
export function keysoundTriggers(kind: JudgementKind): boolean {
  return kind === 'hit' || kind === 'emptyPoor';
}

export interface KeysoundPlayer {
  /** Plays the keysound immediately if `event.kind` is a press (keysoundTriggers). */
  onJudgement(event: JudgementEvent): void;
  /** Stops + disconnects any still-sounding instances. Idempotent. */
  cancelAll(): void;
}

/**
 * Wraps a single preloaded buffer (MUST 10 — no fetch/decode during play) in a
 * scheduler so every triggering press gets a fresh buffer source: simultaneous
 * chord presses overlap naturally instead of cutting each other off (MUST 8).
 */
export function createKeysoundPlayer(
  ctx: SfxScheduleContextLike,
  destination: AudioNode,
  buffer: AudioBuffer,
): KeysoundPlayer {
  const scheduler = createSfxScheduler(ctx, destination);

  function onJudgement(event: JudgementEvent): void {
    if (!keysoundTriggers(event.kind)) return;
    scheduler.schedule(buffer, 0);
  }

  return {
    onJudgement,
    cancelAll: () => scheduler.cancelAll(),
  };
}
