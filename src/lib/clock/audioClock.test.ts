import { describe, expect, it } from 'vitest';
import type { ClockSources } from './audioClock';
import { clampGlobalOffsetMs, createSongClock } from './audioClock';

/** Fake ClockSources with fixed (or overridden) return values; every field is independently stubbable. */
function makeSources(overrides: Partial<ClockSources> = {}): ClockSources {
  return {
    ctxNow: () => 0,
    performanceNow: () => 0,
    ...overrides,
  };
}

describe('songTimeMs', () => {
  it('applies the exact formula: (ctxNow - t0) * 1000 - global + perSong', () => {
    const sources = makeSources({ ctxNow: () => 3.5 });
    const clock = createSongClock(sources, { globalOffsetMs: 30, perSongOffsetMs: 10 });
    clock.start(1.0);

    expect(clock.songTimeMs()).toBe(2480);
  });

  it('a larger positive global offset DECREASES songTimeMs (sign convention)', () => {
    const sources = makeSources({ ctxNow: () => 2.0 });
    const noOffset = createSongClock(sources, { globalOffsetMs: 0 });
    noOffset.start(1.0);
    const withOffset = createSongClock(sources, { globalOffsetMs: 50 });
    withOffset.start(1.0);

    expect(withOffset.songTimeMs()).toBeLessThan(noOffset.songTimeMs());
    expect(noOffset.songTimeMs() - withOffset.songTimeMs()).toBe(50);
  });

  it('throws if start() has not been called', () => {
    const clock = createSongClock(makeSources());
    expect(() => clock.songTimeMs()).toThrow();
  });
});

describe('eventTimeToSongTimeMs', () => {
  it('derives skew from getOutputTimestamp when it reports a usable contextTime', () => {
    // Sync sources imply skew 2.04 − 5 = −2.96; the output timestamp implies
    // −3.0, i.e. a 40ms output latency — plausible, so the OUTPUT skew wins
    // (the fallback would have produced 1540, not 1500).
    const sources = makeSources({
      ctxNow: () => 2.04,
      performanceNow: () => 5000,
      getOutputTimestamp: () => ({ contextTime: 2.0, performanceTime: 5000 }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    // skew = 2.0 - 5000/1000 = -3.0; eventCtxSec = 5500/1000 - 3.0 = 2.5; (2.5-1.0)*1000 = 1500
    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);
  });

  it('rejects a stalled output timestamp (implausibly large implied latency)', () => {
    // A headless/no-sink output pipeline: currentTime marches on (sync skew
    // −2.96) while the output timestamp has fallen ~1s behind (skew −4.0).
    // Implied latency 1.04s is no real device — the sync fallback must win,
    // else every input event maps ~1s early and nothing is ever judged.
    const sources = makeSources({
      ctxNow: () => 2.04,
      performanceNow: () => 5000,
      getOutputTimestamp: () => ({ contextTime: 1.0, performanceTime: 5000 }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    // fallback skew = 2.04 - 5.0 = -2.96; eventCtxSec = 5.5 - 2.96 = 2.54 -> 1540
    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1540);
  });

  it('rejects an output timestamp AHEAD of the sync correspondence (negative latency)', () => {
    // Output cannot lead currentTime; beyond small jitter this is garbage.
    const sources = makeSources({
      ctxNow: () => 2.04,
      performanceNow: () => 5000,
      getOutputTimestamp: () => ({ contextTime: 2.5, performanceTime: 5000 }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1540);
  });

  it('accepts a large-but-real Bluetooth-class output latency (300ms)', () => {
    const sources = makeSources({
      ctxNow: () => 2.3,
      performanceNow: () => 5000,
      getOutputTimestamp: () => ({ contextTime: 2.0, performanceTime: 5000 }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    // output skew −3.0 accepted (implied latency 0.3s) -> 1500, not the fallback 1800.
    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);
  });

  it('falls back to sampled skew when getOutputTimestamp is absent', () => {
    const sources = makeSources({ ctxNow: () => 4.0, performanceNow: () => 7000 });
    const clock = createSongClock(sources);
    clock.start(1.0);

    // skew = 4.0 - 7000/1000 = -3.0; same math as the getOutputTimestamp case above.
    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);
  });

  it('falls back to sampled skew when getOutputTimestamp returns zeros', () => {
    const sources = makeSources({
      ctxNow: () => 4.0,
      performanceNow: () => 7000,
      getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);
  });

  it('falls back to sampled skew when getOutputTimestamp returns undefined', () => {
    const sources = makeSources({
      ctxNow: () => 4.0,
      performanceNow: () => 7000,
      getOutputTimestamp: () => undefined,
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);
  });

  it('falls back to sampled skew when getOutputTimestamp returns undefined fields', () => {
    const sources = makeSources({
      ctxNow: () => 4.0,
      performanceNow: () => 7000,
      getOutputTimestamp: () => ({ contextTime: undefined, performanceTime: undefined }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);
  });

  it('caches skew across calls; only recalibrate() picks up a new correspondence', () => {
    let ctxNow = 2.04;
    let contextTime = 2.0;
    const sources = makeSources({
      ctxNow: () => ctxNow,
      performanceNow: () => 5000,
      getOutputTimestamp: () => ({ contextTime, performanceTime: 5000 }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);

    // Mutate the correspondence after first use; cached skew must still apply.
    ctxNow = 10.04;
    contextTime = 10.0;
    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);

    clock.recalibrate();
    // new skew = 10.0 - 5000/1000 = 5.0; eventCtxSec = 5.5 + 5.0 = 10.5; (10.5-1.0)*1000 = 9500
    expect(clock.eventTimeToSongTimeMs(5500)).toBe(9500);
  });

  it('uses the median of 5 fallback samples so one outlier does not skew the result', () => {
    const perfSamples = [7000, 7000, 999999, 7000, 7000];
    let callIndex = 0;
    const sources = makeSources({
      ctxNow: () => 4.0,
      performanceNow: () => {
        const value = perfSamples[callIndex] ?? 7000;
        callIndex += 1;
        return value;
      },
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    // Majority skew = 4.0 - 7000/1000 = -3.0; the single outlier sample is out-voted.
    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);
  });
});

describe('render/input axis agreement (playfield-rendering.md MUST 19)', () => {
  // The alignment guarantee "a δ=0 input coincides with the note at the
  // judgement line" reduces to: songTimeMs() (the render/frame axis) and
  // eventTimeToSongTimeMs() (the judge input axis) must return the SAME value
  // for the same physical instant, for ANY offset. If they agree, then at the
  // instant an input's song time equals a note's timeMs, the frame axis reads
  // that same value, currentBeat = msToBeat(noteTime) = note.beat, and the
  // render formula y = lineY − (beat − currentBeat)·ppb·hiSpeed collapses to
  // the judgement line for every hi-speed/green-lock/SUDDEN+ setting.
  it.each([-60, 0, 60])(
    'both axes read identically at the same instant (globalOffset %dms)',
    (globalOffsetMs) => {
      // Fixed perf↔ctx correspondence: ctx 8.0s ↔ perf 5000ms (skew +3.0s).
      const sources = makeSources({
        ctxNow: () => 8.0,
        performanceNow: () => 5000,
        getOutputTimestamp: () => ({ contextTime: 8.0, performanceTime: 5000 }),
      });
      const clock = createSongClock(sources, { globalOffsetMs, perSongOffsetMs: 7 });
      clock.start(1.0);

      // An input event stamped at the exact instant the frame samples the clock
      // maps to the exact same song time — the offset cancels symmetrically.
      expect(clock.eventTimeToSongTimeMs(5000)).toBe(clock.songTimeMs());
    },
  );

  it('changing the offset mid-session shifts both axes by the same amount', () => {
    const sources = makeSources({ ctxNow: () => 8.0, performanceNow: () => 5000 });
    const clock = createSongClock(sources);
    clock.start(1.0);
    const frameBefore = clock.songTimeMs();
    const inputBefore = clock.eventTimeToSongTimeMs(5000);

    clock.setGlobalOffsetMs(60);
    expect(clock.songTimeMs()).toBe(frameBefore - 60);
    expect(clock.eventTimeToSongTimeMs(5000)).toBe(inputBefore - 60);
  });
});

describe('clampGlobalOffsetMs', () => {
  it('clamps to [-200, 200] and passes values inside the range through unchanged', () => {
    expect(clampGlobalOffsetMs(-500)).toBe(-200);
    expect(clampGlobalOffsetMs(500)).toBe(200);
    expect(clampGlobalOffsetMs(37)).toBe(37);
  });
});

describe('setGlobalOffsetMs / getGlobalOffsetMs', () => {
  it('clamps out-of-range values via clampGlobalOffsetMs', () => {
    const clock = createSongClock(makeSources());
    clock.setGlobalOffsetMs(1000);
    expect(clock.getGlobalOffsetMs()).toBe(200);
  });

  it('honors an in-range initial globalOffsetMs option', () => {
    const clock = createSongClock(makeSources(), { globalOffsetMs: 77 });
    expect(clock.getGlobalOffsetMs()).toBe(77);
  });
});
