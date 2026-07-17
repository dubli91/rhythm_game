// Dev overlay metrics (playfield-rendering.md SHOULD 16, input-handling.md SHOULD 10).
//
// Headless: the controllers feed it wall-clock timestamps (performance.now) and
// keydown→judgement latencies; it produces the overlay string the renderer
// mirrors. Wall-clock is correct here — these are diagnostics about the frame
// loop and event delivery themselves, not song time, so the audio clock rules
// don't apply (and MUST NOT be used: an FPS counter driven by the audio clock
// would hide exactly the rAF stalls it exists to reveal).
//
// The latency figure is performance.now() at the end of judgement processing
// minus event.timeStamp (same time base) — i.e. how long a keydown waited in
// the event queue plus the judge/dispatch work. It is diagnostic only: the
// judgement itself always uses event.timeStamp, so this delay never becomes
// judgement error (input-handling.md MUST 2); the overlay lets a developer
// confirm that delay stays small.
//
// Visibility is a page-session global (deliberately NOT persisted — a debug
// tool must never ship enabled via someone's saved settings) so toggling it
// once keeps it on across retries and across play/practice sessions.

/** FPS/worst-frame figures refresh once per window; latency lines update per press. */
export const DEV_OVERLAY_WINDOW_MS = 500;

let overlayVisible = false;

export function isDevOverlayVisible(): boolean {
  return overlayVisible;
}

/** Direct setter for tests and programmatic control. */
export function setDevOverlayVisible(visible: boolean): void {
  overlayVisible = visible;
}

export interface DevOverlay {
  /** Call once per rAF with performance.now(); cheap enough to run unconditionally. */
  frameTick(nowMs: number): void;
  /** Record one real keydown→judgement-processed delay in ms (never autoplay). */
  recordInputLatency(latencyMs: number): void;
  /** Flip the shared visibility; returns the new state. */
  toggle(): boolean;
  /** Overlay string; '' whenever the overlay is hidden (renderer shows nothing). */
  text(): string;
}

export function createDevOverlay(): DevOverlay {
  // Frame window accumulators.
  let prevFrameMs: number | null = null;
  let windowStartMs = 0;
  let frameCount = 0;
  let worstFrameMs = 0;
  // Published once per window so the readout is legible, not a blur.
  let fps: number | null = null;
  let publishedWorstMs = 0;
  // Latency accumulators, session-scoped (mean over every real press this session).
  let lastLatencyMs: number | null = null;
  let latencySumMs = 0;
  let latencyCount = 0;

  let cached = '';
  let dirty = true;

  function frameTick(nowMs: number): void {
    if (prevFrameMs === null) {
      // First frame after creation: no interval to measure yet.
      prevFrameMs = nowMs;
      windowStartMs = nowMs;
      return;
    }
    const frameMs = nowMs - prevFrameMs;
    prevFrameMs = nowMs;
    frameCount++;
    if (frameMs > worstFrameMs) worstFrameMs = frameMs;
    const elapsed = nowMs - windowStartMs;
    if (elapsed >= DEV_OVERLAY_WINDOW_MS) {
      fps = (frameCount * 1000) / elapsed;
      publishedWorstMs = worstFrameMs;
      frameCount = 0;
      worstFrameMs = 0;
      windowStartMs = nowMs;
      dirty = true;
    }
  }

  function recordInputLatency(latencyMs: number): void {
    lastLatencyMs = latencyMs;
    latencySumMs += latencyMs;
    latencyCount++;
    dirty = true;
  }

  function toggle(): boolean {
    overlayVisible = !overlayVisible;
    dirty = true;
    return overlayVisible;
  }

  function text(): string {
    if (!overlayVisible) return '';
    if (dirty) {
      const fpsLine = fps === null ? 'FPS —' : `FPS ${fps.toFixed(0)}`;
      const frameLine = fps === null ? 'FRAME —' : `FRAME ${publishedWorstMs.toFixed(1)}ms max`;
      const inputLine = lastLatencyMs === null ? 'INPUT —' : `INPUT ${lastLatencyMs.toFixed(1)}ms`;
      const avgLine =
        latencyCount === 0
          ? 'AVG —'
          : `AVG ${(latencySumMs / latencyCount).toFixed(1)}ms (${latencyCount})`;
      cached = `${fpsLine}\n${frameLine}\n${inputLine}\n${avgLine}`;
      dirty = false;
    }
    return cached;
  }

  return { frameTick, recordInputLatency, toggle, text };
}
