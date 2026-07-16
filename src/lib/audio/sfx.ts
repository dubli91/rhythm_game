// Short-buffer SFX scheduling (specs/audio-playback.md MUST 8): menu SFX
// (move/confirm/cancel, createMenuSfx below) and the practice-mode metronome
// click are synthesized as short AudioBuffers and scheduled at exact
// AudioContext times (`source.start(when)`) through the game's effects
// GainNode bus (specs/practice-mode.md MUST 5-6: loop-accurate count-in
// clicks scheduled off the audio clock).

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

export interface ToneSegment {
  frequencyHz: number;
  /** Segment duration in seconds. */
  durationSec: number;
  /** Peak amplitude, clamped to [0, 1]. Default 0.9. */
  amplitude?: number;
}

/**
 * Synthesizes a mono buffer of consecutive sine segments, each shaped by a
 * short linear attack (3ms) followed by an exponential decay across the
 * segment's duration, at ctx.sampleRate. A single segment is a click; two
 * segments make the rising/falling two-tone menu blips one schedulable buffer.
 */
export function synthToneSequenceBuffer(
  ctx: SfxAudioContextLike,
  segments: readonly ToneSegment[],
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const segmentLengths = segments.map((s) => Math.max(1, Math.round(s.durationSec * sampleRate)));
  const totalLength = Math.max(
    1,
    segmentLengths.reduce((a, b) => a + b, 0),
  );

  const buffer = ctx.createBuffer(1, totalLength, sampleRate);
  const data = buffer.getChannelData(0);

  let writeIndex = 0;
  segments.forEach((segment, segmentIndex) => {
    const amplitude = Math.min(1, Math.max(0, segment.amplitude ?? DEFAULT_AMPLITUDE));
    const length = segmentLengths[segmentIndex] ?? 0;
    const decayTau = segment.durationSec / 5;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const attackEnvelope = Math.min(1, t / ATTACK_SEC);
      const decayEnvelope = Math.exp(-t / decayTau);
      const envelope = attackEnvelope * decayEnvelope;
      data[writeIndex + i] = Math.sin(2 * Math.PI * segment.frequencyHz * t) * envelope * amplitude;
    }
    writeIndex += length;
  });

  return buffer;
}

/**
 * Synthesizes a mono click buffer: a sine tone at frequencyHz shaped by a
 * short linear attack (3ms) followed by an exponential decay across the
 * buffer's duration, at ctx.sampleRate.
 */
export function synthClickBuffer(ctx: SfxAudioContextLike, opts: ClickBufferOptions): AudioBuffer {
  return synthToneSequenceBuffer(ctx, [
    {
      frequencyHz: opts.frequencyHz,
      durationSec: opts.durationSec ?? DEFAULT_DURATION_SEC,
      amplitude: opts.amplitude,
    },
  ]);
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

// --- menu SFX (specs/audio-playback.md MUST 8: move/confirm/cancel as short buffers) ---

export type MenuSfxKind = 'move' | 'confirm' | 'cancel';

// Menu sound palette: move is a single light tick; confirm/cancel are two-tone
// blips (rising = accept, falling = back out) so the three cues are
// distinguishable without looking. Pitches are musical (B4/E5/B5/E6/G6) so
// overlapping cues during fast navigation stay consonant.
const MENU_SFX_TONES: Record<MenuSfxKind, readonly ToneSegment[]> = {
  move: [{ frequencyHz: 1568, durationSec: 0.035, amplitude: 0.35 }],
  confirm: [
    { frequencyHz: 988, durationSec: 0.05, amplitude: 0.5 },
    { frequencyHz: 1319, durationSec: 0.09, amplitude: 0.5 },
  ],
  cancel: [
    { frequencyHz: 659, durationSec: 0.05, amplitude: 0.5 },
    { frequencyHz: 494, durationSec: 0.09, amplitude: 0.5 },
  ],
};

export interface MenuSfx {
  /** Plays the cue immediately (schedule clamps a past time to "now"). */
  play(kind: MenuSfxKind): void;
  /** stop + disconnect any still-sounding cues. Idempotent. */
  cancelAll(): void;
}

/**
 * Synthesizes the three menu-cue buffers once and plays them on demand through
 * `destination` — pass the effects bus so the EFFECTS volume tier governs menu
 * sounds like every other SFX (audio-playback.md MUST 8-9).
 */
export function createMenuSfx(ctx: SfxAudioContextLike, destination: AudioNode): MenuSfx {
  const scheduler = createSfxScheduler(ctx, destination);
  const buffers: Record<MenuSfxKind, AudioBuffer> = {
    move: synthToneSequenceBuffer(ctx, MENU_SFX_TONES.move),
    confirm: synthToneSequenceBuffer(ctx, MENU_SFX_TONES.confirm),
    cancel: synthToneSequenceBuffer(ctx, MENU_SFX_TONES.cancel),
  };

  return {
    play(kind: MenuSfxKind): void {
      scheduler.schedule(buffers[kind], 0);
    },
    cancelAll(): void {
      scheduler.cancelAll();
    },
  };
}
