// Song-time master clock (specs/audio-playback.md MUST 5-7): the single
// conversion from AudioContext.currentTime to "song time" milliseconds that
// judgement, rendering, and practice mode all read from, plus the sibling
// conversion for performance.now()-based input event timestamps. Pure math
// over injectable time sources (ClockSources) so it is fully headless-testable
// without a real AudioContext.

/**
 * Injectable views of the two clocks. ctxNow() returns AudioContext.currentTime SECONDS;
 * performanceNow() returns ms.
 */
export interface ClockSources {
  ctxNow(): number;
  performanceNow(): number;
  /** Mirrors AudioContext.getOutputTimestamp; may be absent or return zeros/undefined fields
   * before playback. */
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number } | undefined;
}

export interface SongClock {
  /** t0 in AudioContext seconds (the scheduled source.start time). */
  start(t0: number): void;
  /** Current song time in ms (formula above). Throws if start() not called. */
  songTimeMs(): number;
  /** Converts an input event's performance.now-based timestamp (ms) to song time ms. */
  eventTimeToSongTimeMs(eventTimeStampMs: number): number;
  setGlobalOffsetMs(ms: number): void;
  getGlobalOffsetMs(): number;
  setPerSongOffsetMs(ms: number): void;
  /** Re-samples the perf↔ctx correspondence (call occasionally; cheap). */
  recalibrate(): void;
}

const MIN_GLOBAL_OFFSET_MS = -200;
const MAX_GLOBAL_OFFSET_MS = 200;

/** Number of same-tick samples used to median-guard the fallback perf↔ctx skew. */
const FALLBACK_SAMPLE_COUNT = 5;

/** Plausibility window (seconds) for the output latency implied by a
 * getOutputTimestamp() reading, i.e. fallbackSkew − outputSkew. On real
 * hardware this is the device latency: ≈0 wired, up to ~0.3s on Bluetooth,
 * never negative. A stalled output pipeline (headless browser, missing audio
 * sink) keeps advancing currentTime while the output timestamp falls ever
 * further behind — trusting it there maps every input event seconds off song
 * time (observed: ~140ms of spurious skew per second of context life in
 * headless Chromium, which silently un-judges all real input). */
const MAX_PLAUSIBLE_OUTPUT_LATENCY_SEC = 0.35;
const MIN_PLAUSIBLE_OUTPUT_LATENCY_SEC = -0.02;

/** Clamp to [-200, 200] (specs/audio-playback.md MUST 7). */
export function clampGlobalOffsetMs(ms: number): number {
  return Math.min(MAX_GLOBAL_OFFSET_MS, Math.max(MIN_GLOBAL_OFFSET_MS, ms));
}

/**
 * Samples ctxNow() − performanceNow()/1000 FALLBACK_SAMPLE_COUNT times back-to-back and
 * returns the median, guarding against a scheduler hiccup landing between the two reads
 * of a single sample.
 */
function sampleFallbackSkewSec(sources: ClockSources): number {
  const samples: number[] = [];
  for (let i = 0; i < FALLBACK_SAMPLE_COUNT; i++) {
    const ctxSec = sources.ctxNow();
    const perfMs = sources.performanceNow();
    samples.push(ctxSec - perfMs / 1000);
  }
  samples.sort((a, b) => a - b);
  const medianIndex = Math.floor(samples.length / 2);
  const median = samples[medianIndex];
  if (median === undefined) {
    throw new Error('sampleFallbackSkewSec: no samples collected');
  }
  return median;
}

/**
 * Resolves perfToCtxSkewSec = ctxTime − perfTimeMs/1000 for the current instant: prefers
 * getOutputTimestamp() when it reports a usable (finite, positive contextTime) reading
 * whose implied output latency vs the sync-sampled skew is plausible, otherwise falls
 * back to the median-sampled sync reads. The output-based skew is the better mapping
 * when trustworthy — inputs then get judged against the audio the player actually
 * hears — but only the sync sample can tell a legit device latency from a runaway
 * output clock.
 */
function calibrateSkewSec(sources: ClockSources): number {
  const fallbackSkewSec = sampleFallbackSkewSec(sources);
  const getOutputTimestamp = sources.getOutputTimestamp;
  if (getOutputTimestamp) {
    const timestamp = getOutputTimestamp();
    const contextTime = timestamp?.contextTime;
    const performanceTime = timestamp?.performanceTime;
    if (
      contextTime !== undefined &&
      performanceTime !== undefined &&
      Number.isFinite(contextTime) &&
      Number.isFinite(performanceTime) &&
      contextTime > 0
    ) {
      const outputSkewSec = contextTime - performanceTime / 1000;
      const impliedLatencySec = fallbackSkewSec - outputSkewSec;
      if (
        impliedLatencySec >= MIN_PLAUSIBLE_OUTPUT_LATENCY_SEC &&
        impliedLatencySec <= MAX_PLAUSIBLE_OUTPUT_LATENCY_SEC
      ) {
        return outputSkewSec;
      }
    }
  }
  return fallbackSkewSec;
}

export function createSongClock(
  sources: ClockSources,
  opts?: { globalOffsetMs?: number; perSongOffsetMs?: number },
): SongClock {
  let t0: number | undefined;
  let globalOffsetMs = clampGlobalOffsetMs(opts?.globalOffsetMs ?? 0);
  let perSongOffsetMs = opts?.perSongOffsetMs ?? 0;
  // Cached lazily; recomputed only on first use and on recalibrate() — never per-event.
  let skewSec: number | undefined;

  function requireT0(): number {
    if (t0 === undefined) {
      throw new Error('SongClock: start() has not been called');
    }
    return t0;
  }

  function getSkewSec(): number {
    if (skewSec === undefined) {
      skewSec = calibrateSkewSec(sources);
    }
    return skewSec;
  }

  function start(startT0: number): void {
    t0 = startT0;
  }

  function songTimeMs(): number {
    const startTime = requireT0();
    return (sources.ctxNow() - startTime) * 1000 - globalOffsetMs + perSongOffsetMs;
  }

  function eventTimeToSongTimeMs(eventTimeStampMs: number): number {
    const startTime = requireT0();
    const eventCtxSec = eventTimeStampMs / 1000 + getSkewSec();
    return (eventCtxSec - startTime) * 1000 - globalOffsetMs + perSongOffsetMs;
  }

  function setGlobalOffsetMs(ms: number): void {
    globalOffsetMs = clampGlobalOffsetMs(ms);
  }

  function getGlobalOffsetMs(): number {
    return globalOffsetMs;
  }

  function setPerSongOffsetMs(ms: number): void {
    perSongOffsetMs = ms;
  }

  function recalibrate(): void {
    skewSec = calibrateSkewSec(sources);
  }

  return {
    start,
    songTimeMs,
    eventTimeToSongTimeMs,
    setGlobalOffsetMs,
    getGlobalOffsetMs,
    setPerSongOffsetMs,
    recalibrate,
  };
}
