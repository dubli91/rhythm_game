import { describe, expect, it } from 'vitest';
import type { AudioContextLike } from './context';
import { createGameAudio } from './context';

/** Records connect() targets and disconnect() calls; stands in for a real GainNode. */
class StubGainNode {
  readonly gain: { value: number } = { value: 1 };
  readonly connectedTargets: AudioNode[] = [];
  disconnectCallCount = 0;

  connect(destination: AudioNode): AudioNode {
    this.connectedTargets.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCallCount += 1;
  }
}

function toGainNode(stub: StubGainNode): GainNode {
  return stub as unknown as GainNode;
}

/** Reaches back through the GainNode-typed value returned by createGameAudio to its StubGainNode. */
function asStub(node: GainNode): StubGainNode {
  return node as unknown as StubGainNode;
}

interface StubAudioContextOptions {
  state?: AudioContextState;
  /** When false, resume() is called but state stays as-is (simulates a browser still blocking playback). */
  resumeTransitionsToRunning?: boolean;
  getOutputTimestamp?: () => AudioTimestamp;
}

/** Hand-written AudioContextLike stub: mutable state, fresh StubGainNodes, and call counters for assertions. */
class StubAudioContext implements AudioContextLike {
  state: AudioContextState;
  currentTime = 0;
  readonly destination: AudioNode = {} as unknown as AudioNode;
  readonly createdGains: StubGainNode[] = [];
  resumeCallCount = 0;
  closeCallCount = 0;
  getOutputTimestamp?: () => AudioTimestamp;

  private readonly resumeTransitionsToRunning: boolean;

  constructor(options: StubAudioContextOptions = {}) {
    this.state = options.state ?? 'suspended';
    this.resumeTransitionsToRunning = options.resumeTransitionsToRunning ?? true;
    this.getOutputTimestamp = options.getOutputTimestamp;
  }

  createGain(): GainNode {
    const stub = new StubGainNode();
    this.createdGains.push(stub);
    return toGainNode(stub);
  }

  resume(): Promise<void> {
    this.resumeCallCount += 1;
    if (this.resumeTransitionsToRunning) {
      this.state = 'running';
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCallCount += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
}

describe('createGameAudio bus wiring', () => {
  it('connects music and effects into master, and master into destination', () => {
    const ctx = new StubAudioContext();
    const game = createGameAudio(ctx);

    expect(asStub(game.musicBus).connectedTargets).toEqual([game.masterBus]);
    expect(asStub(game.effectsBus).connectedTargets).toEqual([game.masterBus]);
    expect(asStub(game.masterBus).connectedTargets).toEqual([ctx.destination]);
  });
});

describe('volumes', () => {
  it('defaults to 1/1/1 when no initial volumes are given', () => {
    const ctx = new StubAudioContext();
    const game = createGameAudio(ctx);

    expect(game.getVolumes()).toEqual({ master: 1, music: 1, effects: 1 });
    expect(game.masterBus.gain.value).toBe(1);
    expect(game.musicBus.gain.value).toBe(1);
    expect(game.effectsBus.gain.value).toBe(1);
  });

  it('clamps out-of-range initial volumes to [0, 1]', () => {
    const ctx = new StubAudioContext();
    const game = createGameAudio(ctx, { master: 1.5, music: -1, effects: 0.5 });

    expect(game.getVolumes()).toEqual({ master: 1, music: 0, effects: 0.5 });
    expect(game.masterBus.gain.value).toBe(1);
    expect(game.musicBus.gain.value).toBe(0);
    expect(game.effectsBus.gain.value).toBe(0.5);
  });

  it('setVolumes updates only the given buses, and still clamps', () => {
    const ctx = new StubAudioContext();
    const game = createGameAudio(ctx);

    game.setVolumes({ music: 0.4 });

    expect(game.getVolumes()).toEqual({ master: 1, music: 0.4, effects: 1 });
    expect(game.musicBus.gain.value).toBe(0.4);
    expect(game.masterBus.gain.value).toBe(1);
    expect(game.effectsBus.gain.value).toBe(1);

    game.setVolumes({ master: 2, effects: -3 });

    expect(game.getVolumes()).toEqual({ master: 1, music: 0.4, effects: 0 });
    expect(game.masterBus.gain.value).toBe(1);
    expect(game.effectsBus.gain.value).toBe(0);
  });
});

describe('unlock', () => {
  it('calls resume() once when suspended and resolves true once running', async () => {
    const ctx = new StubAudioContext({ state: 'suspended' });
    const game = createGameAudio(ctx);

    const result = await game.unlock();

    expect(ctx.resumeCallCount).toBe(1);
    expect(result).toBe(true);
    expect(ctx.state).toBe('running');
  });

  it('does not call resume() when already running, and resolves true', async () => {
    const ctx = new StubAudioContext({ state: 'running' });
    const game = createGameAudio(ctx);

    const result = await game.unlock();

    expect(ctx.resumeCallCount).toBe(0);
    expect(result).toBe(true);
  });

  it('resolves false when resume() resolves but the context stays suspended', async () => {
    const ctx = new StubAudioContext({ state: 'suspended', resumeTransitionsToRunning: false });
    const game = createGameAudio(ctx);

    const result = await game.unlock();

    expect(ctx.resumeCallCount).toBe(1);
    expect(result).toBe(false);
    expect(ctx.state).toBe('suspended');
  });
});

describe('clockSources', () => {
  it('ctxNow() tracks the live stub currentTime', () => {
    const ctx = new StubAudioContext();
    const game = createGameAudio(ctx);
    const sources = game.clockSources();

    ctx.currentTime = 5;
    expect(sources.ctxNow()).toBe(5);

    ctx.currentTime = 9;
    expect(sources.ctxNow()).toBe(9);
  });

  it('exposes getOutputTimestamp, bound to the context, when the stub provides one', () => {
    const ctx = new StubAudioContext({
      getOutputTimestamp: () => ({ contextTime: 3, performanceTime: 4000 }),
    });
    const game = createGameAudio(ctx);

    const sources = game.clockSources();
    expect(sources.getOutputTimestamp).toBeDefined();
    expect(sources.getOutputTimestamp?.()).toEqual({ contextTime: 3, performanceTime: 4000 });
  });

  it('omits getOutputTimestamp when the stub does not provide one', () => {
    const ctx = new StubAudioContext();
    const game = createGameAudio(ctx);

    expect(game.clockSources().getOutputTimestamp).toBeUndefined();
  });
});

describe('dispose', () => {
  it('disconnects all three buses and closes the context, leaving no residual nodes', async () => {
    const ctx = new StubAudioContext();
    const game = createGameAudio(ctx);

    await game.dispose();

    expect(asStub(game.musicBus).disconnectCallCount).toBe(1);
    expect(asStub(game.effectsBus).disconnectCallCount).toBe(1);
    expect(asStub(game.masterBus).disconnectCallCount).toBe(1);
    expect(ctx.closeCallCount).toBe(1);
    expect(ctx.state).toBe('closed');
  });
});
