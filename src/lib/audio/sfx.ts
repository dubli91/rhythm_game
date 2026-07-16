// Short-buffer SFX scheduling (specs/audio-playback.md MUST 8): menu SFX
// (move/confirm/cancel) and the practice-mode metronome click are synthesized
// as short AudioBuffers and scheduled at exact AudioContext times
// (`source.start(when)`) through the game's effects GainNode bus
// (specs/practice-mode.md MUST 5-6: loop-accurate count-in clicks scheduled
// off the audio clock). Practice mode consumes this today; menu SFX will
// later.

/** Minimal structural slice of an AudioBufferSourceNode this module needs. */
export interface SfxBufferSourceLike {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect(destination: AudioNode): AudioNode;
  disconnect(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

// Minimal structural slice of AudioContext needed to synthesize + schedule short buffers.
// (AudioContextLike in ./context deliberately omits buffer APIs; the raw AudioContext satisfies this.)
export interface SfxAudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): SfxBufferSourceLike;
}

export interface ClickBufferOptions {
  frequencyHz: number;
  /** Buffer duration in seconds. Default 0.06. */
  durationSec?: number;
  /** Peak amplitude, clamped to [0, 1]. Default 0.9. */
  amplitude?: number;
}

const DEFAULT_DURATION_SEC = 0.06;
const DEFAULT_AMPLITUDE = 0.9;
const ATTACK_SEC = 0.003;

/**
 * Synthesizes a mono click buffer: a sine tone at frequencyHz shaped by a
 * short linear attack (3ms) followed by an exponential decay across the
 * buffer's duration, at ctx.sampleRate.
 */
export function synthClickBuffer(ctx: SfxAudioContextLike, opts: ClickBufferOptions): AudioBuffer {
  const durationSec = opts.durationSec ?? DEFAULT_DURATION_SEC;
  const amplitude = Math.min(1, Math.max(0, opts.amplitude ?? DEFAULT_AMPLITUDE));
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.round(durationSec * sampleRate));
  const decayTau = durationSec / 5;

  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const attackEnvelope = Math.min(1, t / ATTACK_SEC);
    const decayEnvelope = Math.exp(-t / decayTau);
    const envelope = attackEnvelope * decayEnvelope;
    data[i] = Math.sin(2 * Math.PI * opts.frequencyHz * t) * envelope * amplitude;
  }

  return buffer;
}

export interface SfxScheduler {
  /**
   * Creates a source, sets buffer, connects it to the destination, and calls
   * source.start(max(whenSec, ctx.currentTime)) — a past time plays
   * immediately. Tracks the source as live until its onended fires (then
   * disconnect + untrack).
   */
  schedule(buffer: AudioBuffer, whenSec: number): void;
  /**
   * stop(0) (swallowing errors from already-stopped sources) + disconnect
   * every live source and clear tracking. Idempotent.
   */
  cancelAll(): void;
  /** Number of tracked live sources (for cleanup assertions). */
  liveCount(): number;
}

export function createSfxScheduler(ctx: SfxAudioContextLike, destination: AudioNode): SfxScheduler {
  const liveSources = new Set<SfxBufferSourceLike>();

  function schedule(buffer: AudioBuffer, whenSec: number): void {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);

    liveSources.add(source);
    source.onended = () => {
      liveSources.delete(source);
      source.disconnect();
    };

    source.start(Math.max(whenSec, ctx.currentTime));
  }

  function cancelAll(): void {
    for (const source of liveSources) {
      try {
        source.stop(0);
      } catch {
        // Already stopped/ended — nothing to do.
      }
      // Prevent a late onended (fired after we've already torn this down)
      // from double-disconnecting or re-tracking the source.
      source.onended = null;
      source.disconnect();
    }
    liveSources.clear();
  }

  function liveCount(): number {
    return liveSources.size;
  }

  return { schedule, cancelAll, liveCount };
}
