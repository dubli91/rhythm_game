import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../play/songPlayer';
import type {
  PreviewAudioContextLike,
  PreviewBufferSourceLike,
  PreviewPlayer,
  PreviewState,
  PreviewTarget,
} from './preview';
import { PREVIEW_FADE_MS, createPreviewPlayer, previewLoopBounds } from './preview';

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

class StubGainNode {
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

class StubPreviewSource implements PreviewBufferSourceLike {
  buffer: AudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  readonly connectedTargets: unknown[] = [];
  disconnectCallCount = 0;
  readonly startCalls: Array<[number, number]> = [];
  readonly stopCalls: number[] = [];

  connect(dest: unknown): unknown {
    this.connectedTargets.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnectCallCount += 1;
  }

  start(when?: number, offset?: number): void {
    this.startCalls.push([when ?? 0, offset ?? 0]);
  }

  stop(when?: number): void {
    this.stopCalls.push(when ?? 0);
  }

  /** Test helper: simulates the browser firing `onended` after a scheduled stop. */
  fireEnded(): void {
    this.onended?.();
  }
}

class StubPreviewCtx implements PreviewAudioContextLike {
  currentTime = 0;
  decodedDurationSec = 60;
  readonly createdGains: StubGainNode[] = [];
  readonly createdSources: StubPreviewSource[] = [];
  readonly decodeCalls: ArrayBuffer[] = [];

  createGain(): StubGainNode {
    const gain = new StubGainNode();
    this.createdGains.push(gain);
    return gain;
  }

  createBufferSource(): StubPreviewSource {
    const source = new StubPreviewSource();
    this.createdSources.push(source);
    return source;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.decodeCalls.push(data);
    return Promise.resolve({ duration: this.decodedDurationSec } as unknown as AudioBuffer);
  }
}

/** Deterministic injectable replacement for setTimeout/clearTimeout. */
class FakeTimers {
  private nextId = 1;
  private readonly tasks = new Map<number, () => void>();

  readonly schedule = (fn: () => void, _ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, fn);
    return id;
  };

  readonly cancel = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  get pendingCount(): number {
    return this.tasks.size;
  }

  fireAll(): void {
    const fns = [...this.tasks.values()];
    this.tasks.clear();
    for (const fn of fns) fn();
  }
}

/** Drains the fetch→arrayBuffer→decode microtask chain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function makeFetch(): { calls: string[]; fn: FetchLike } {
  const calls: string[] = [];
  const fn: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });
  };
  return { calls, fn };
}

const TARGET_A: PreviewTarget = {
  songId: 'song-a',
  audioUrl: '/songs/a.wav',
  startMs: 25000,
  durationMs: 10000,
};
const TARGET_B: PreviewTarget = {
  songId: 'song-b',
  audioUrl: '/songs/b.wav',
  startMs: 5000,
  durationMs: 8000,
};

interface Harness {
  ctx: StubPreviewCtx;
  musicBus: StubGainNode;
  timers: FakeTimers;
  fetchCalls: string[];
  states: PreviewState[];
  player: PreviewPlayer;
}

function makePlayer(overrides: { fetchFn?: FetchLike } = {}): Harness {
  const ctx = new StubPreviewCtx();
  const musicBus = new StubGainNode();
  const timers = new FakeTimers();
  const { calls, fn } = makeFetch();
  const states: PreviewState[] = [];
  const player = createPreviewPlayer({
    ctx,
    musicBus,
    fetchFn: overrides.fetchFn ?? fn,
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
    onStateChange: (state) => states.push(state),
  });
  return { ctx, musicBus, timers, fetchCalls: calls, states, player };
}

describe('previewLoopBounds', () => {
  it('converts startMs/durationMs into buffer seconds', () => {
    expect(previewLoopBounds(60, { startMs: 25000, durationMs: 10000 })).toEqual({
      startSec: 25,
      endSec: 35,
    });
  });

  it('clamps an end beyond the buffer to the buffer end', () => {
    expect(previewLoopBounds(30, { startMs: 25600, durationMs: 10000 })).toEqual({
      startSec: 25.6,
      endSec: 30,
    });
  });

  it('falls back to start 0 when startMs lies beyond the buffer', () => {
    expect(previewLoopBounds(30, { startMs: 40000, durationMs: 10000 })).toEqual({
      startSec: 0,
      endSec: 10,
    });
  });

  it('falls back to the buffer end when the duration is non-positive', () => {
    expect(previewLoopBounds(30, { startMs: 5000, durationMs: 0 })).toEqual({
      startSec: 5,
      endSec: 30,
    });
  });
});

describe('request() debounce + playback wiring', () => {
  it('does nothing until the debounce fires, then fetches, loops, and fades in', async () => {
    const h = makePlayer();
    h.ctx.currentTime = 2;

    h.player.request(TARGET_A);
    expect(h.player.state()).toEqual({ phase: 'pending', songId: 'song-a' });
    expect(h.fetchCalls).toEqual([]);
    expect(h.ctx.createdSources).toHaveLength(0);

    h.timers.fireAll();
    await settle();

    expect(h.fetchCalls).toEqual(['/songs/a.wav']);
    expect(h.ctx.decodeCalls).toHaveLength(1);
    expect(h.ctx.createdSources).toHaveLength(1);
    const source = h.ctx.createdSources[0] as StubPreviewSource;
    const gain = h.ctx.createdGains[0] as StubGainNode;
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(25);
    expect(source.loopEnd).toBe(35);
    expect(source.startCalls).toEqual([[2, 25]]); // starts at the excerpt offset
    expect(source.connectedTargets).toEqual([gain]);
    expect(gain.connectedTargets).toEqual([h.musicBus]);
    expect(gain.gain.setValueAtTimeCalls).toEqual([[0, 2]]);
    expect(gain.gain.linearRampCalls).toEqual([[1, 2 + PREVIEW_FADE_MS / 1000]]);
    expect(h.player.state()).toEqual({ phase: 'playing', songId: 'song-a' });
  });

  it('treats a repeat request for the same song as a no-op (chart-row moves)', async () => {
    const h = makePlayer();
    h.player.request(TARGET_A);
    h.player.request({ ...TARGET_A }); // fresh object, same songId, still pending
    expect(h.timers.pendingCount).toBe(1);

    h.timers.fireAll();
    await settle();
    h.player.request({ ...TARGET_A }); // now playing

    expect(h.ctx.createdSources).toHaveLength(1);
    expect(h.fetchCalls).toEqual(['/songs/a.wav']);
    expect(h.player.state()).toEqual({ phase: 'playing', songId: 'song-a' });
  });

  it('switching songs before the debounce fires cancels the first entirely', async () => {
    const h = makePlayer();
    h.player.request(TARGET_A);
    h.player.request(TARGET_B);
    expect(h.timers.pendingCount).toBe(1);

    h.timers.fireAll();
    await settle();

    expect(h.fetchCalls).toEqual(['/songs/b.wav']);
    expect(h.ctx.createdSources).toHaveLength(1);
    const source = h.ctx.createdSources[0] as StubPreviewSource;
    expect(source.loopStart).toBe(5);
    expect(source.loopEnd).toBe(13);
    expect(h.player.state()).toEqual({ phase: 'playing', songId: 'song-b' });
  });
});

describe('switching and stopping while playing', () => {
  it('crossfades: fades out the old source and starts the new one', async () => {
    const h = makePlayer();
    h.player.request(TARGET_A);
    h.timers.fireAll();
    await settle();
    const sourceA = h.ctx.createdSources[0] as StubPreviewSource;
    const gainA = h.ctx.createdGains[0] as StubGainNode;

    h.ctx.currentTime = 5;
    h.player.request(TARGET_B);

    const fadeEnd = 5 + PREVIEW_FADE_MS / 1000;
    expect(gainA.gain.cancelScheduledValuesCalls).toEqual([5]);
    expect(gainA.gain.linearRampCalls.at(-1)).toEqual([0, fadeEnd]);
    expect(sourceA.stopCalls).toEqual([fadeEnd]);

    h.timers.fireAll();
    await settle();
    expect(h.ctx.createdSources).toHaveLength(2);
    expect(h.player.state()).toEqual({ phase: 'playing', songId: 'song-b' });

    // The scheduled stop eventually fires onended -> the old nodes are released.
    sourceA.fireEnded();
    expect(sourceA.disconnectCallCount).toBe(1);
    expect(gainA.disconnectCallCount).toBe(1);
  });

  it('request(null) while pending cancels the timer without fetching', () => {
    const h = makePlayer();
    h.player.request(TARGET_A);
    h.player.request(null);

    expect(h.timers.pendingCount).toBe(0);
    expect(h.fetchCalls).toEqual([]);
    expect(h.player.state()).toEqual({ phase: 'idle', songId: null });
  });

  it('request(null) while playing fades out and stops the source', async () => {
    const h = makePlayer();
    h.player.request(TARGET_A);
    h.timers.fireAll();
    await settle();
    const source = h.ctx.createdSources[0] as StubPreviewSource;

    h.ctx.currentTime = 8;
    h.player.request(null);

    const fadeEnd = 8 + PREVIEW_FADE_MS / 1000;
    expect(source.stopCalls).toEqual([fadeEnd]);
    expect(h.player.state()).toEqual({ phase: 'idle', songId: null });
  });
});

describe('caching and stale loads', () => {
  it('caches decoded buffers per song: returning to a song refetches nothing', async () => {
    const h = makePlayer();
    h.player.request(TARGET_A);
    h.timers.fireAll();
    await settle();
    h.player.request(TARGET_B);
    h.timers.fireAll();
    await settle();

    h.player.request(TARGET_A);
    h.timers.fireAll();
    await settle();

    expect(h.fetchCalls).toEqual(['/songs/a.wav', '/songs/b.wav']);
    expect(h.ctx.decodeCalls).toHaveLength(2);
    expect(h.ctx.createdSources).toHaveLength(3); // cached restart still makes a new source
    expect(h.player.state()).toEqual({ phase: 'playing', songId: 'song-a' });
  });

  it('a fetch that resolves after the cursor moved on never starts audio', async () => {
    const resolvers = new Map<string, (r: Awaited<ReturnType<FetchLike>>) => void>();
    const fetchFn: FetchLike = (url) =>
      new Promise((resolve) => {
        resolvers.set(url, resolve);
      });
    const h = makePlayer({ fetchFn });

    h.player.request(TARGET_A);
    h.timers.fireAll(); // A's load is now in flight
    h.player.request(TARGET_B);
    h.timers.fireAll(); // B's load is now in flight

    resolvers.get('/songs/a.wav')?.({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });
    await settle();
    expect(h.ctx.createdSources).toHaveLength(0); // stale A discarded

    resolvers.get('/songs/b.wav')?.({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    });
    await settle();
    expect(h.ctx.createdSources).toHaveLength(1);
    const source = h.ctx.createdSources[0] as StubPreviewSource;
    expect(source.loopStart).toBe(5); // B's excerpt, not A's
    expect(h.player.state()).toEqual({ phase: 'playing', songId: 'song-b' });
  });
});

describe('failure handling', () => {
  it('a failed fetch stays silent, returns to idle, and allows a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const calls: string[] = [];
      const fetchFn: FetchLike = (url) => {
        calls.push(url);
        return Promise.resolve({
          ok: false,
          status: 404,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      };
      const h = makePlayer({ fetchFn });

      h.player.request(TARGET_A);
      h.timers.fireAll();
      await settle();

      expect(h.ctx.createdSources).toHaveLength(0);
      expect(h.player.state()).toEqual({ phase: 'idle', songId: null });
      expect(warn).toHaveBeenCalledTimes(1);

      // The failed target was cleared, so re-hovering the song retries the load.
      h.player.request(TARGET_A);
      h.timers.fireAll();
      await settle();
      expect(calls).toEqual(['/songs/a.wav', '/songs/a.wav']);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('state change notifications', () => {
  it('reports pending -> playing -> idle across a full hover cycle', async () => {
    const h = makePlayer();
    h.player.request(TARGET_A);
    h.timers.fireAll();
    await settle();
    h.player.request(null);

    expect(h.states).toEqual([
      { phase: 'pending', songId: 'song-a' },
      { phase: 'playing', songId: 'song-a' },
      { phase: 'idle', songId: null },
    ]);
  });
});
