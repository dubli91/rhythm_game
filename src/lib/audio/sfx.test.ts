import { describe, expect, it } from 'vitest';
import type { SfxAudioContextLike, SfxBufferSourceLike } from './sfx';
import { createSfxScheduler, synthClickBuffer } from './sfx';

/** Stub AudioBuffer whose getChannelData(0) is backed by a persistent Float32Array. */
class StubAudioBuffer {
  private readonly channelData: Float32Array;

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channelData = new Float32Array(length);
  }

  getChannelData(channel: number): Float32Array {
    if (channel !== 0) {
      throw new Error(`StubAudioBuffer only supports channel 0, got ${channel}`);
    }
    return this.channelData;
  }
}

/** Records start()/stop()/connect()/disconnect() calls; stands in for a real AudioBufferSourceNode. */
class StubBufferSource implements SfxBufferSourceLike {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connectedTargets: AudioNode[] = [];
  disconnectCallCount = 0;
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];
  /** When set, stop() throws this instead of recording the call. */
  stopError: Error | null = null;

  connect(destination: AudioNode): AudioNode {
    this.connectedTargets.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCallCount += 1;
  }

  start(when?: number): void {
    this.startCalls.push(when ?? 0);
  }

  stop(when?: number): void {
    this.stopCalls.push(when ?? 0);
    if (this.stopError) {
      throw this.stopError;
    }
  }

  /** Test helper: simulates the browser firing `onended`. */
  fireEnded(): void {
    this.onended?.();
  }
}

interface StubCtxOptions {
  currentTime?: number;
  sampleRate?: number;
}

/** Hand-written SfxAudioContextLike stub: mutable currentTime, fresh stub buffers/sources collected in arrays. */
class StubSfxContext implements SfxAudioContextLike {
  currentTime: number;
  readonly sampleRate: number;
  readonly createdBuffers: StubAudioBuffer[] = [];
  readonly createdSources: StubBufferSource[] = [];

  constructor(options: StubCtxOptions = {}) {
    this.currentTime = options.currentTime ?? 0;
    this.sampleRate = options.sampleRate ?? 48000;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    const buffer = new StubAudioBuffer(numberOfChannels, length, sampleRate);
    this.createdBuffers.push(buffer);
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource(): StubBufferSource {
    const source = new StubBufferSource();
    this.createdSources.push(source);
    return source;
  }
}

function dummyBuffer(): AudioBuffer {
  return {} as unknown as AudioBuffer;
}

function rms(samples: Float32Array): number {
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

describe('synthClickBuffer', () => {
  it('has length = round(durationSec * sampleRate) for the default duration', () => {
    const ctx = new StubSfxContext({ sampleRate: 48000 });

    const buffer = synthClickBuffer(ctx, { frequencyHz: 1000 });

    expect(buffer.length).toBe(Math.round(0.06 * 48000));
  });

  it('has length = round(durationSec * sampleRate) for a custom duration', () => {
    const ctx = new StubSfxContext({ sampleRate: 44100 });

    const buffer = synthClickBuffer(ctx, { frequencyHz: 1000, durationSec: 0.02 });

    expect(buffer.length).toBe(Math.round(0.02 * 44100));
  });

  it('first sample is 0 (attack envelope starts at 0)', () => {
    const ctx = new StubSfxContext();

    const buffer = synthClickBuffer(ctx, { frequencyHz: 1000 });
    const data = buffer.getChannelData(0);

    expect(data[0]).toBe(0);
  });

  it('peak amplitude does not exceed the amplitude option', () => {
    const ctx = new StubSfxContext();
    const amplitude = 0.5;

    const buffer = synthClickBuffer(ctx, { frequencyHz: 1000, amplitude });
    const data = buffer.getChannelData(0);

    let peak = 0;
    for (const sample of data) {
      peak = Math.max(peak, Math.abs(sample));
    }
    expect(peak).toBeLessThanOrEqual(amplitude + 1e-9);
  });

  it('decays: RMS of the last 10% of samples is well below RMS of the 3-13ms window', () => {
    const ctx = new StubSfxContext({ sampleRate: 48000 });
    const durationSec = 0.06;

    const buffer = synthClickBuffer(ctx, { frequencyHz: 1000, durationSec });
    const data = buffer.getChannelData(0);

    const earlyStart = Math.round(0.003 * 48000);
    const earlyEnd = Math.round(0.013 * 48000);
    const earlyWindow = data.subarray(earlyStart, earlyEnd);

    const tailStart = Math.round(data.length * 0.9);
    const tailWindow = data.subarray(tailStart);

    const earlyRms = rms(earlyWindow);
    const tailRms = rms(tailWindow);

    expect(tailRms).toBeLessThan(earlyRms * 0.2);
  });

  it('different frequencies produce different sample data', () => {
    const ctx = new StubSfxContext();

    const bufferA = synthClickBuffer(ctx, { frequencyHz: 1000 });
    const bufferB = synthClickBuffer(ctx, { frequencyHz: 2000 });

    expect(Array.from(bufferA.getChannelData(0))).not.toEqual(
      Array.from(bufferB.getChannelData(0)),
    );
  });
});

describe('SfxScheduler.schedule', () => {
  it('passes a future whenSec through to start() unchanged', () => {
    const ctx = new StubSfxContext({ currentTime: 1 });
    const destination = {} as unknown as AudioNode;
    const scheduler = createSfxScheduler(ctx, destination);
    const buffer = dummyBuffer();

    scheduler.schedule(buffer, 5);

    const source = ctx.createdSources[0] as StubBufferSource;
    expect(source.startCalls).toEqual([5]);
  });

  it('clamps a past whenSec (< currentTime) to start at currentTime', () => {
    const ctx = new StubSfxContext({ currentTime: 10 });
    const destination = {} as unknown as AudioNode;
    const scheduler = createSfxScheduler(ctx, destination);
    const buffer = dummyBuffer();

    scheduler.schedule(buffer, 2);

    const source = ctx.createdSources[0] as StubBufferSource;
    expect(source.startCalls).toEqual([10]);
  });

  it('connects the source to the destination and assigns the buffer', () => {
    const ctx = new StubSfxContext();
    const destination = {} as unknown as AudioNode;
    const scheduler = createSfxScheduler(ctx, destination);
    const buffer = dummyBuffer();

    scheduler.schedule(buffer, 0);

    const source = ctx.createdSources[0] as StubBufferSource;
    expect(source.connectedTargets).toEqual([destination]);
    expect(source.buffer).toBe(buffer);
  });
});

describe('SfxScheduler lifecycle', () => {
  it('liveCount increments per schedule() and decrements when fireEnded() runs, disconnecting exactly once', () => {
    const ctx = new StubSfxContext();
    const destination = {} as unknown as AudioNode;
    const scheduler = createSfxScheduler(ctx, destination);

    scheduler.schedule(dummyBuffer(), 0);
    scheduler.schedule(dummyBuffer(), 0);
    expect(scheduler.liveCount()).toBe(2);

    const [first, second] = ctx.createdSources as [StubBufferSource, StubBufferSource];
    first.fireEnded();

    expect(scheduler.liveCount()).toBe(1);
    expect(first.disconnectCallCount).toBe(1);
    expect(second.disconnectCallCount).toBe(0);

    second.fireEnded();
    expect(scheduler.liveCount()).toBe(0);
    expect(second.disconnectCallCount).toBe(1);
  });
});

describe('SfxScheduler.cancelAll', () => {
  it('stops and disconnects every live source, and liveCount drops to 0', () => {
    const ctx = new StubSfxContext();
    const destination = {} as unknown as AudioNode;
    const scheduler = createSfxScheduler(ctx, destination);

    scheduler.schedule(dummyBuffer(), 0);
    scheduler.schedule(dummyBuffer(), 0);

    scheduler.cancelAll();

    const sources = ctx.createdSources as StubBufferSource[];
    for (const source of sources) {
      expect(source.stopCalls).toEqual([0]);
      expect(source.disconnectCallCount).toBe(1);
    }
    expect(scheduler.liveCount()).toBe(0);
  });

  it('is idempotent: safe to call twice', () => {
    const ctx = new StubSfxContext();
    const destination = {} as unknown as AudioNode;
    const scheduler = createSfxScheduler(ctx, destination);

    scheduler.schedule(dummyBuffer(), 0);

    scheduler.cancelAll();
    expect(() => scheduler.cancelAll()).not.toThrow();

    const source = ctx.createdSources[0] as StubBufferSource;
    expect(source.stopCalls).toEqual([0]);
    expect(source.disconnectCallCount).toBe(1);
    expect(scheduler.liveCount()).toBe(0);
  });

  it('a source whose stop() throws does not prevent the others from being cleaned up', () => {
    const ctx = new StubSfxContext();
    const destination = {} as unknown as AudioNode;
    const scheduler = createSfxScheduler(ctx, destination);

    scheduler.schedule(dummyBuffer(), 0);
    scheduler.schedule(dummyBuffer(), 0);
    const [first, second] = ctx.createdSources as [StubBufferSource, StubBufferSource];
    first.stopError = new Error('already stopped');

    expect(() => scheduler.cancelAll()).not.toThrow();

    expect(first.disconnectCallCount).toBe(1);
    expect(second.stopCalls).toEqual([0]);
    expect(second.disconnectCallCount).toBe(1);
    expect(scheduler.liveCount()).toBe(0);
  });
});
