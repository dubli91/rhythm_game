// Song-preview player for the select screen (song-select.md SHOULD 12,
// audio-playback.md SHOULD 12): when the cursor settles on a song, loop its
// highlighted excerpt through the music bus until the cursor moves on or the
// screen changes.
//
// The SHOULD is a one-liner in both specs; the concrete behavior decided here:
// - The preview follows the cursor's SONG — moving between a song row and its
//   difficulty rows never restarts playback.
// - Playback starts PREVIEW_DEBOUNCE_MS after the cursor settles on a new song
//   (no audio churn while scrolling) and fades in/out over PREVIEW_FADE_MS;
//   switching songs crossfades (old fade-out overlaps the new fade-in).
// - The excerpt loops seamlessly via AudioBufferSourceNode loopStart/loopEnd,
//   with bounds clamped defensively against the decoded buffer duration.
// - Decoded buffers are cached per songId for the session, so audio is fetched
//   at most once per song, on first hover — never eagerly at boot (index.json
//   stays the only startup fetch, song-library.md MUST 2 intent).
// - Fetch/decode failure logs a warning and stays silent; a broken preview
//   must never take down the select screen (song-select.md acceptance 4).

import type { FetchLike, GainNodeLike } from '../play/songPlayer';

/** Cursor settle time before a preview starts loading/playing. */
export const PREVIEW_DEBOUNCE_MS = 300;
/** Fade-in and fade-out duration for preview starts/stops/crossfades. */
export const PREVIEW_FADE_MS = 250;

/** Minimal structural slice of an AudioBufferSourceNode incl. loop fields. */
export interface PreviewBufferSourceLike {
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  onended: (() => void) | null;
  connect(dest: unknown): unknown;
  disconnect(): void;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

/** Minimal structural slice of an AudioContext this module needs. */
export interface PreviewAudioContextLike {
  currentTime: number;
  createGain(): GainNodeLike;
  createBufferSource(): PreviewBufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

export interface PreviewTarget {
  songId: string;
  audioUrl: string;
  /** Highlighted-excerpt start within the song (catalog preview.startMs). */
  startMs: number;
  /** Excerpt length (catalog preview.durationMs). */
  durationMs: number;
}

export type PreviewPhase = 'idle' | 'pending' | 'playing';

export interface PreviewState {
  phase: PreviewPhase;
  songId: string | null;
}

export interface PreviewPlayer {
  /** Converge playback onto `target` (null = fade out to silence). Repeat calls
   * with the same songId are no-ops, so callers can invoke this on every cursor
   * move / screen change without any bookkeeping of their own. */
  request(target: PreviewTarget | null): void;
  state(): PreviewState;
}

export interface PreviewPlayerOptions {
  ctx: PreviewAudioContextLike;
  musicBus: GainNodeLike;
  fetchFn?: FetchLike;
  /** Injectable timer pair for headless tests; default setTimeout/clearTimeout. */
  scheduleTimeout?: (fn: () => void, ms: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  /** Fired on every phase/song change (the shell mirrors it into DOM data attributes). */
  onStateChange?: (state: PreviewState) => void;
}

/** Loop bounds in buffer seconds, clamped so bad metadata can never produce an
 * empty or out-of-range loop: an out-of-range start falls back to 0, an invalid
 * end falls back to the buffer end. */
export function previewLoopBounds(
  bufferDurationSec: number,
  target: Pick<PreviewTarget, 'startMs' | 'durationMs'>,
): { startSec: number; endSec: number } {
  let startSec = target.startMs / 1000;
  if (!Number.isFinite(startSec) || startSec < 0 || startSec >= bufferDurationSec) {
    startSec = 0;
  }
  let endSec = startSec + target.durationMs / 1000;
  if (!Number.isFinite(endSec) || endSec <= startSec || endSec > bufferDurationSec) {
    endSec = bufferDurationSec;
  }
  return { startSec, endSec };
}

export function createPreviewPlayer(options: PreviewPlayerOptions): PreviewPlayer {
  const ctx = options.ctx;
  const fetchFn: FetchLike = options.fetchFn ?? globalThis.fetch;
  const scheduleTimeout =
    options.scheduleTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelTimeout =
    options.cancelTimeout ?? ((handle: unknown) => clearTimeout(handle as number));

  const bufferCache = new Map<string, AudioBuffer>();

  let currentTarget: PreviewTarget | null = null;
  let phase: PreviewPhase = 'idle';
  let debounceHandle: unknown = null;
  /** Bumped whenever the target changes; in-flight loads compare against it so a
   * stale fetch/decode can never start audio for a song the cursor already left. */
  let loadToken = 0;
  let playing: { source: PreviewBufferSourceLike; gain: GainNodeLike } | null = null;

  function setPhase(next: PreviewPhase): void {
    phase = next;
    options.onStateChange?.({ phase, songId: currentTarget?.songId ?? null });
  }

  function cancelPending(): void {
    if (debounceHandle !== null) {
      cancelTimeout(debounceHandle);
      debounceHandle = null;
    }
    loadToken += 1;
  }

  function fadeOutPlaying(): void {
    if (playing === null) return;
    const { source, gain } = playing;
    playing = null;
    const now = ctx.currentTime;
    const fadeEnd = now + PREVIEW_FADE_MS / 1000;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, fadeEnd);
    source.stop(fadeEnd);
    // The onended handler installed in startPlayback releases the nodes.
  }

  function startPlayback(buffer: AudioBuffer, target: PreviewTarget): void {
    const { startSec, endSec } = previewLoopBounds(buffer.duration, target);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = startSec;
    source.loopEnd = endSec;
    source.connect(gain);
    gain.connect(options.musicBus);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + PREVIEW_FADE_MS / 1000);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start(now, startSec);
    playing = { source, gain };
    setPhase('playing');
  }

  async function loadAndStart(target: PreviewTarget, token: number): Promise<void> {
    try {
      const response = await fetchFn(target.audioUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      if (token !== loadToken) return; // cursor moved on while loading
      bufferCache.set(target.songId, buffer);
      startPlayback(buffer, target);
    } catch (err) {
      if (token !== loadToken) return;
      console.warn(
        `song preview unavailable for ${target.songId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Clear the target so re-hovering the song retries the load.
      currentTarget = null;
      setPhase('idle');
    }
  }

  function request(target: PreviewTarget | null): void {
    if (target !== null && currentTarget !== null && target.songId === currentTarget.songId) {
      return; // already pending/playing this song (e.g. moving across its chart rows)
    }
    cancelPending();
    fadeOutPlaying();
    currentTarget = target;
    if (target === null) {
      setPhase('idle');
      return;
    }
    const token = loadToken;
    debounceHandle = scheduleTimeout(() => {
      debounceHandle = null;
      const cached = bufferCache.get(target.songId);
      if (cached !== undefined) {
        startPlayback(cached, target);
      } else {
        void loadAndStart(target, token);
      }
    }, PREVIEW_DEBOUNCE_MS);
    setPhase('pending');
  }

  return {
    request,
    state: () => ({ phase, songId: currentTarget?.songId ?? null }),
  };
}
