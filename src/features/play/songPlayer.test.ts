import { describe, expect, it, vi } from 'vitest';
import type { BufferSourceLike, FetchLike, GainNodeLike, SongAudioContextLike } from './songPlayer';
import {
  DEFAULT_LEAD_IN_SEC,
  STOP_FADE_MS,
  createSilentPlayback,
  createSongPlayer,
} from './songPlayer';

/** Records gain automation calls; stands in for a real AudioParam. */
class StubGainParam {
  value = 1;
  readonly setValueAtTimeCalls: Array<[number, number]> = [];
  readonly linearRampCalls: Array<[number, number]> = [];
  readonly cancelScheduledValuesCalls: number[] = [];

  setValueAtTime(v: number, t: number): unknown {
    this.value = v;
    this.setValueAtTimeCalls.push([v, t]);
    return this;
  }

  linearRampToValueAtTime(v: number, t: number): unknown {
    this.linearRampCalls.push([v, t]);
    return this;
  }

  cancelScheduledValues(t: number): unknown {
    this.cancelScheduledValuesCalls.push(t);
    return this;
  }
}

/** Records connect()/disconnect() calls; stands in for a real GainNode. */
class StubGainNode implements GainNodeLike {
  readonly gain = new StubGainParam();
  readonly connectedTargets: unknown[] = [];
  disconnectCallCount = 0;

  connect(dest: unknown): unknown {
    this.connectedTargets.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnectCallCount += 1;
  }
}

/** Records start()/stop()/connect()/disconnect() calls; stands in for a real AudioBufferSourceNode. */
class StubBufferSource implements BufferSourceLike {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connectedTargets: unknown[] = [];
  disconnectCallCount = 0;
  startCalls: number[] = [];
  stopCalls: number[] = [];

  connect(dest: unknown): unknown {
    this.connectedTargets.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnectCallCount += 1;
  }

  start(when?: number): void {
    this.startCalls.push(when ?? 0);
  }

  stop(when?: number): void {
    this.stopCalls.push(when ?? 0);
  }

  /** Test helper: simulates the browser firing `onended` (natural end or after a scheduled stop). */
  fireEnded(): void {
    this.onended?.();
  }
}

interface StubCtxOptions {
  currentTime?: number;
}

/** Hand-written SongAudioContextLike stub: mutable currentTime, fresh stub nodes, decode spy. */
class StubSongAudioContext implements SongAudioContextLike {
  currentTime: number;
  readonly createdGains: StubGainNode[] = [];
  readonly createdSources: StubBufferSource[] = [];
  readonly decodeAudioDataCalls: ArrayBuffer[] = [];
  decodedBuffer: AudioBuffer = {} as unknown as AudioBuffer;

  constructor(options: StubCtxOptions = {}) {
    this.currentTime = options.currentTime ?? 0;
  }

  createGain(): StubGainNode {
    const gain = new StubGainNode();
    this.createdGains.push(gain);
    return gain;
  }

  createBufferSource(): StubBufferSource {
    const source = new StubBufferSource();
    this.createdSources.push(source);
    return source;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.decodeAudioDataCalls.push(data);
    return Promise.resolve(this.decodedBuffer);
  }
}

function dummyBuffer(): AudioBuffer {
  return {} as unknown as AudioBuffer;
}

describe('play() wiring', () => {
  it('creates one source and one song gain, wires source -> gain -> musicBus, sets buffer', () => {
    const ctx = new StubSongAudioContext();
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);
    const buffer = dummyBuffer();

    const playback = player.play(buffer);

    expect(ctx.createdSources).toHaveLength(1);
    expect(ctx.createdGains).toHaveLength(1);
    const source = ctx.createdSources[0] as StubBufferSource;
    const songGain = ctx.createdGains[0] as StubGainNode;

    expect(source.buffer).toBe(buffer);
    expect(source.connectedTargets).toEqual([songGain]);
    expect(songGain.connectedTargets).toEqual([musicBus]);
    expect(songGain.gain.value).toBe(1);
    expect(playback.isActive()).toBe(true);
  });

  it('starts at ctx.currentTime + default lead-in when no leadInSec given', () => {
    const ctx = new StubSongAudioContext({ currentTime: 10 });
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer());

    expect(playback.t0).toBe(10 + DEFAULT_LEAD_IN_SEC);
    const source = ctx.createdSources[0] as StubBufferSource;
    expect(source.startCalls).toEqual([10 + DEFAULT_LEAD_IN_SEC]);
  });

  it('starts at ctx.currentTime + custom leadInSec when given', () => {
    const ctx = new StubSongAudioContext({ currentTime: 5 });
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer(), { leadInSec: 2.5 });

    expect(playback.t0).toBe(7.5);
    const source = ctx.createdSources[0] as StubBufferSource;
    expect(source.startCalls).toEqual([7.5]);
  });
});

describe('natural end', () => {
  it('resolves ended, disconnects both nodes, and clears isActive when onended fires', async () => {
    const ctx = new StubSongAudioContext();
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer());
    const source = ctx.createdSources[0] as StubBufferSource;
    const songGain = ctx.createdGains[0] as StubGainNode;

    expect(playback.isActive()).toBe(true);

    source.fireEnded();
    await playback.ended;

    expect(playback.isActive()).toBe(false);
    expect(source.disconnectCallCount).toBe(1);
    expect(songGain.disconnectCallCount).toBe(1);
  });
});

describe('stop()', () => {
  it('schedules a ramp to 0 over the default fade and stops the source at now+fade, resolving on onended', async () => {
    const ctx = new StubSongAudioContext({ currentTime: 3 });
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer());
    const source = ctx.createdSources[0] as StubBufferSource;
    const songGain = ctx.createdGains[0] as StubGainNode;

    ctx.currentTime = 4; // advance clock between play() and stop()
    const stopPromise = playback.stop();

    const expectedFadeEnd = 4 + STOP_FADE_MS / 1000;
    expect(songGain.gain.cancelScheduledValuesCalls).toEqual([4]);
    expect(songGain.gain.setValueAtTimeCalls).toEqual([[1, 4]]);
    expect(songGain.gain.linearRampCalls).toEqual([[0, expectedFadeEnd]]);
    expect(source.stopCalls).toEqual([expectedFadeEnd]);

    source.fireEnded();
    await stopPromise;
    await playback.ended;

    expect(playback.isActive()).toBe(false);
    expect(source.disconnectCallCount).toBe(1);
    expect(songGain.disconnectCallCount).toBe(1);
  });

  it('stop() during lead-in (before t0) still schedules the fade and stop', () => {
    const ctx = new StubSongAudioContext({ currentTime: 0 });
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer()); // t0 = 1 (default lead-in)
    const source = ctx.createdSources[0] as StubBufferSource;

    void playback.stop();

    expect(source.stopCalls).toEqual([STOP_FADE_MS / 1000]);
  });

  it('accepts a custom fadeMs', () => {
    const ctx = new StubSongAudioContext({ currentTime: 0 });
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer());
    const source = ctx.createdSources[0] as StubBufferSource;
    const songGain = ctx.createdGains[0] as StubGainNode;

    void playback.stop({ fadeMs: 1000 });

    expect(songGain.gain.linearRampCalls).toEqual([[0, 1]]);
    expect(source.stopCalls).toEqual([1]);
  });

  it('fadeMs: 0 stops immediately via the same ramp path', () => {
    const ctx = new StubSongAudioContext({ currentTime: 2 });
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer());
    const source = ctx.createdSources[0] as StubBufferSource;
    const songGain = ctx.createdGains[0] as StubGainNode;

    void playback.stop({ fadeMs: 0 });

    expect(songGain.gain.linearRampCalls).toEqual([[0, 2]]);
    expect(source.stopCalls).toEqual([2]);
  });

  it('is idempotent: a second concurrent call returns the same promise and schedules only one ramp', async () => {
    const ctx = new StubSongAudioContext();
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer());
    const source = ctx.createdSources[0] as StubBufferSource;
    const songGain = ctx.createdGains[0] as StubGainNode;

    const first = playback.stop();
    const second = playback.stop();

    expect(second).toBe(first);
    expect(songGain.gain.linearRampCalls).toHaveLength(1);
    expect(source.stopCalls).toHaveLength(1);

    source.fireEnded();
    await Promise.all([first, second]);
    expect(playback.isActive()).toBe(false);
  });

  it('resolves immediately without error when called after natural end', async () => {
    const ctx = new StubSongAudioContext();
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const playback = player.play(dummyBuffer());
    const source = ctx.createdSources[0] as StubBufferSource;
    const songGain = ctx.createdGains[0] as StubGainNode;

    source.fireEnded();
    await playback.ended;

    await expect(playback.stop()).resolves.toBeUndefined();
    // no additional ramp/stop scheduling after the source already ended
    expect(songGain.gain.linearRampCalls).toHaveLength(0);
    expect(source.stopCalls).toHaveLength(0);
  });
});

describe('loadFromUrl', () => {
  it('fetches, checks ok, and decodes the array buffer', async () => {
    const ctx = new StubSongAudioContext();
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);
    const bytes = new ArrayBuffer(4);

    const fetchFn: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(bytes),
    });

    const result = await player.loadFromUrl('/songs/foo.wav', fetchFn);

    expect(fetchFn).toHaveBeenCalledWith('/songs/foo.wav');
    expect(ctx.decodeAudioDataCalls).toEqual([bytes]);
    expect(result).toBe(ctx.decodedBuffer);
  });

  it('rejects with an Error containing the url and status when the response is not ok', async () => {
    const ctx = new StubSongAudioContext();
    const musicBus = new StubGainNode();
    const player = createSongPlayer(ctx, musicBus);

    const fetchFn: FetchLike = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await expect(player.loadFromUrl('/songs/missing.wav', fetchFn)).rejects.toThrow(
      /\/songs\/missing\.wav.*404/,
    );
  });
});

describe('createSilentPlayback', () => {
  it('t0 = ctx.currentTime + default lead-in when no leadInSec given', () => {
    const playback = createSilentPlayback({ currentTime: 10 });

    expect(playback.t0).toBe(10 + DEFAULT_LEAD_IN_SEC);
  });

  it('t0 = ctx.currentTime + custom leadInSec when given', () => {
    const playback = createSilentPlayback({ currentTime: 5 }, { leadInSec: 2.5 });

    expect(playback.t0).toBe(7.5);
  });

  it('isActive() is true before stop() and false after', async () => {
    const playback = createSilentPlayback({ currentTime: 0 });

    expect(playback.isActive()).toBe(true);

    await playback.stop();

    expect(playback.isActive()).toBe(false);
  });

  it('stop() resolves ended (nothing audible to fade)', async () => {
    const playback = createSilentPlayback({ currentTime: 0 });

    void playback.stop();

    await expect(playback.ended).resolves.toBeUndefined();
  });

  it('stop() is idempotent: a second call returns the same promise', () => {
    const playback = createSilentPlayback({ currentTime: 0 });

    const first = playback.stop();
    const second = playback.stop();

    expect(second).toBe(first);
  });

  it('ended resolves exactly once across repeated stop() calls', async () => {
    const playback = createSilentPlayback({ currentTime: 0 });
    let resolveCount = 0;
    playback.ended.then(() => {
      resolveCount++;
    });

    await playback.stop();
    await playback.stop();
    await playback.ended;
    await Promise.resolve(); // flush any pending .then callbacks

    expect(resolveCount).toBe(1);
  });
});
