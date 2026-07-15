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
    const sources = makeSources({
      getOutputTimestamp: () => ({ contextTime: 2.0, performanceTime: 5000 }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    // skew = 2.0 - 5000/1000 = -3.0; eventCtxSec = 5500/1000 - 3.0 = 2.5; (2.5-1.0)*1000 = 1500
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
    let contextTime = 2.0;
    let performanceTime = 5000;
    const sources = makeSources({
      getOutputTimestamp: () => ({ contextTime, performanceTime }),
    });
    const clock = createSongClock(sources);
    clock.start(1.0);

    expect(clock.eventTimeToSongTimeMs(5500)).toBe(1500);

    // Mutate the correspondence after first use; cached skew must still apply.
    contextTime = 10.0;
    performanceTime = 5000;
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
