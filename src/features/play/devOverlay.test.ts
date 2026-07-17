// Dev overlay metrics (playfield-rendering.md SHOULD 16, input-handling.md SHOULD 10).
//
// These tests matter because the overlay is the tool used to VERIFY the specs'
// performance criteria (frame-time p95, event-time judgement under dropped
// frames) — a wrong FPS/latency readout would misdirect any perf debugging.
// Everything is driven by injected timestamps, so window math is pinned exactly.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEV_OVERLAY_WINDOW_MS,
  createDevOverlay,
  isDevOverlayVisible,
  setDevOverlayVisible,
} from './devOverlay';

beforeEach(() => {
  // Visibility is a deliberate page-session global; isolate each test.
  setDevOverlayVisible(false);
});

describe('visibility', () => {
  it('is hidden by default and text() is empty while hidden', () => {
    const overlay = createDevOverlay();
    expect(isDevOverlayVisible()).toBe(false);
    expect(overlay.text()).toBe('');
  });

  it('toggle() flips the shared state and returns the new value', () => {
    const overlay = createDevOverlay();
    expect(overlay.toggle()).toBe(true);
    expect(isDevOverlayVisible()).toBe(true);
    expect(overlay.toggle()).toBe(false);
    expect(isDevOverlayVisible()).toBe(false);
  });

  it('visibility is shared across instances (play and practice sessions agree)', () => {
    const a = createDevOverlay();
    const b = createDevOverlay();
    a.toggle();
    expect(b.text()).not.toBe('');
    expect(b.text()).toContain('FPS');
  });

  it('shows placeholders before any frame window or input sample exists', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    expect(overlay.text()).toBe('FPS —\nFRAME —\nINPUT —\nAVG —');
  });
});

describe('frame window', () => {
  it('publishes FPS and worst frame time once per window', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    // 5 intervals of 100ms fill exactly one 500ms window.
    for (const t of [0, 100, 200, 300, 400, 500]) overlay.frameTick(t);
    const text = overlay.text();
    expect(text).toContain('FPS 10');
    expect(text).toContain('FRAME 100.0ms max');
  });

  it('keeps showing placeholders while the first window is still open', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    for (const t of [0, 16, 33, 50]) overlay.frameTick(t);
    expect(overlay.text()).toContain('FPS —');
  });

  it('resets the worst-frame figure each window (a hitch does not stick forever)', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    for (const t of [0, 400, 500]) overlay.frameTick(t); // window 1: worst 400ms
    expect(overlay.text()).toContain('FRAME 400.0ms max');
    for (const t of [600, 700, 800, 900, 1000]) overlay.frameTick(t); // window 2: all 100ms
    expect(overlay.text()).toContain('FRAME 100.0ms max');
  });

  it('reports ~60 FPS for 16.67ms frames', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    let t = 0;
    // First tick initializes; then one window's worth of 60fps frames.
    overlay.frameTick(t);
    while (t <= DEV_OVERLAY_WINDOW_MS + 20) {
      t += 1000 / 60;
      overlay.frameTick(t);
    }
    expect(overlay.text()).toContain('FPS 60');
  });
});

describe('input latency', () => {
  it('shows the last sample and the running mean with sample count', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    overlay.recordInputLatency(2.0);
    overlay.recordInputLatency(4.0);
    const text = overlay.text();
    expect(text).toContain('INPUT 4.0ms');
    expect(text).toContain('AVG 3.0ms (2)');
  });

  it('keeps accumulating across frame windows (mean is session-scoped)', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    overlay.recordInputLatency(10);
    for (const t of [0, 250, 500]) overlay.frameTick(t);
    overlay.recordInputLatency(2);
    expect(overlay.text()).toContain('AVG 6.0ms (2)');
  });

  it('metrics survive a hide/show toggle', () => {
    const overlay = createDevOverlay();
    overlay.toggle();
    overlay.recordInputLatency(5);
    overlay.toggle();
    expect(overlay.text()).toBe('');
    overlay.toggle();
    expect(overlay.text()).toContain('INPUT 5.0ms');
  });
});
