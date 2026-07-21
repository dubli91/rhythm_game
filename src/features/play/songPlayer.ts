// Song playback engine (specs/audio-playback.md MUST 2-4): schedules the
// single AudioBufferSourceNode per song, wires it through a per-song fade
// GainNode into the music bus, and drives the lead-in / abandon(stop) fade
// paths purely off `onended` — no timers, since the audio clock
// (ctx.currentTime) is the only source of truth for song timing.

/** Time (seconds) between calling play() and the buffer actually starting to sound (spec MUST 3). */
export const DEFAULT_LEAD_IN_SEC = 1;

/** Fade duration (ms) used on abandon/fail when the caller doesn't specify one.
 * The spec (MUST 4) requires a fade-out on stop but leaves the duration open;
 * 300ms is this module's documented choice. */
export const STOP_FADE_MS = 300;

/** Minimal structural slice of an AudioParam — real GainNode.gain satisfies this. */
export interface GainParamLike {
  value: number;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
  cancelScheduledValues(t: number): unknown;
}

/** Minimal structural slice of a GainNode — real GainNode satisfies this. */
export interface GainNodeLike {
  gain: GainParamLike;
  connect(dest: unknown): unknown;
  disconnect(): void;
}

/** Minimal structural slice of an AudioBufferSourceNode — real one satisfies this. */
export interface BufferSourceLike {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect(dest: unknown): unknown;
  disconnect(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

/** Minimal structural slice of an AudioContext this module needs. */
export interface SongAudioContextLike {
  currentTime: number;
  createGain(): GainNodeLike;
  createBufferSource(): BufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

/** Minimal structural slice of fetch this module needs (lets tests inject a fake). */
export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface SongPlayback {
  /** ctx-seconds at which the buffer starts sounding. */
  readonly t0: number;
  /** Resolves on natural end OR after stop() completes; never rejects. */
  readonly ended: Promise<void>;
  /** Fades to 0 over fadeMs (default STOP_FADE_MS), then stops+releases the nodes.
   * Idempotent: a second call returns the same promise as the first. */
  stop(opts?: { fadeMs?: number }): Promise<void>;
  /** True from play() until the playback has ended or been stopped. */
  isActive(): boolean;
}

export interface SongPlayer {
  /** Fetches and decodes a built-in song's audio. Throws if the response is not ok. */
  loadFromUrl(url: string, fetchFn?: FetchLike): Promise<AudioBuffer>;
  /** Decodes an imported song's audio from an IndexedDB-stored Blob. */
  loadFromBlob(blob: Blob): Promise<AudioBuffer>;
  /** Schedules a single AudioBufferSourceNode to play `buffer` starting after a lead-in. */
  play(buffer: AudioBuffer, opts?: { leadInSec?: number }): SongPlayback;
}

export function createSongPlayer(ctx: SongAudioContextLike, musicBus: GainNodeLike): SongPlayer {
  async function loadFromUrl(
    url: string,
    fetchFn: FetchLike = globalThis.fetch,
  ): Promise<AudioBuffer> {
    const response = await fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch song audio from ${url}: HTTP ${response.status}`);
    }
    const data = await response.arrayBuffer();
    return ctx.decodeAudioData(data);
  }

  async function loadFromBlob(blob: Blob): Promise<AudioBuffer> {
    const data = await blob.arrayBuffer();
    return ctx.decodeAudioData(data);
  }

  function play(buffer: AudioBuffer, opts?: { leadInSec?: number }): SongPlayback {
    const leadInSec = opts?.leadInSec ?? DEFAULT_LEAD_IN_SEC;
    const t0 = ctx.currentTime + leadInSec;

    const source = ctx.createBufferSource();
    const songGain = ctx.createGain();
    source.buffer = buffer;
    songGain.gain.value = 1;
    source.connect(songGain);
    songGain.connect(musicBus);

    let active = true;
    let released = false;
    let stopPromise: Promise<void> | undefined;
    let resolveEnded: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });

    function release(): void {
      if (released) return;
      released = true;
      active = false;
      source.disconnect();
      songGain.disconnect();
      resolveEnded();
    }

    source.onended = () => {
      release();
    };

    source.start(t0);

    function stop(stopOpts?: { fadeMs?: number }): Promise<void> {
      if (stopPromise) {
        return stopPromise;
      }
      if (!active) {
        // Already ended naturally (or released) — nothing left to fade/stop.
        stopPromise = ended;
        return stopPromise;
      }

      const fadeMs = stopOpts?.fadeMs ?? STOP_FADE_MS;
      const now = ctx.currentTime;
      const fadeEnd = now + fadeMs / 1000;

      songGain.gain.cancelScheduledValues(now);
      songGain.gain.setValueAtTime(songGain.gain.value, now);
      songGain.gain.linearRampToValueAtTime(0, fadeEnd);
      source.stop(fadeEnd);

      stopPromise = ended;
      return stopPromise;
    }

    return {
      t0,
      ended,
      stop,
      isActive: () => active,
    };
  }

  return { loadFromUrl, loadFromBlob, play };
}

/**
 * No-BGM master-clock playback (specs/practice-song-content.md MUST 9): the
 * declared exception to this module's header comment and audio-playback.md
 * MUST 2's single-source-node rule — there is no AudioBufferSourceNode at
 * all, just the t0 reservation (MUST 3) so the rest of the play path's
 * songTimeMs conversion (MUST 5) works unmodified. There is nothing audible
 * to fade or an onended to await, so isActive()/ended are driven entirely by
 * stop(): natural end-of-song is detected by the controller from chart time
 * (last note + 2s), which then calls stop() exactly like the BGM path.
 */
export function createSilentPlayback(
  ctx: { currentTime: number },
  opts?: { leadInSec?: number },
): SongPlayback {
  const leadInSec = opts?.leadInSec ?? DEFAULT_LEAD_IN_SEC;
  const t0 = ctx.currentTime + leadInSec;

  let active = true;
  let stopPromise: Promise<void> | undefined;
  let resolveEnded: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  // fadeMs accepted for interface parity with the BGM path; there is no
  // source/gain node here to ramp, so it's unused and a no-op.
  function stop(_stopOpts?: { fadeMs?: number }): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }
    active = false;
    resolveEnded();
    stopPromise = ended;
    return stopPromise;
  }

  return {
    t0,
    ended,
    stop,
    isActive: () => active,
  };
}
