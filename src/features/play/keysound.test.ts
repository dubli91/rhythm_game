import { describe, expect, it } from 'vitest';
import type { SfxBufferSourceLike, SfxScheduleContextLike } from '../../lib/audio/sfx';
import { createKeysoundPlayer, keysoundTriggers } from './keysound';
import type { JudgementEvent, JudgementKind } from './types';

/** Records start()/stop()/connect()/disconnect() calls; stands in for a real AudioBufferSourceNode. */
class StubBufferSource implements SfxBufferSourceLike {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connectedTargets: AudioNode[] = [];
  disconnectCallCount = 0;
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];

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
  }

  /** Test helper: simulates the browser firing `onended`. */
  fireEnded(): void {
    this.onended?.();
  }
}

interface StubCtxOptions {
  currentTime?: number;
}

/** Hand-written SfxScheduleContextLike stub: mutable currentTime, fresh stub sources collected in an array. */
class StubScheduleContext implements SfxScheduleContextLike {
  currentTime: number;
  readonly createdSources: StubBufferSource[] = [];

  constructor(options: StubCtxOptions = {}) {
    this.currentTime = options.currentTime ?? 0;
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

function makeEvent(kind: JudgementKind, overrides: Partial<JudgementEvent> = {}): JudgementEvent {
  return {
    kind,
    grade: 'PGREAT',
    lane: 0,
    noteIndex: 0,
    deltaMs: null,
    timing: null,
    songTimeMs: 0,
    ...overrides,
  };
}

describe('keysoundTriggers', () => {
  it('truth table: true for hit/emptyPoor, false for missPoor/cnBreak/cnComplete', () => {
    expect(keysoundTriggers('hit')).toBe(true);
    expect(keysoundTriggers('emptyPoor')).toBe(true);
    expect(keysoundTriggers('missPoor')).toBe(false);
    expect(keysoundTriggers('cnBreak')).toBe(false);
    expect(keysoundTriggers('cnComplete')).toBe(false);
  });
});

describe('createKeysoundPlayer', () => {
  it('hit plays immediately: started at ctx.currentTime, routed to destination', () => {
    const ctx = new StubScheduleContext({ currentTime: 7 });
    const destination = {} as unknown as AudioNode;
    const buffer = dummyBuffer();
    const player = createKeysoundPlayer(ctx, destination, buffer);

    player.onJudgement(makeEvent('hit'));

    expect(ctx.createdSources).toHaveLength(1);
    const source = ctx.createdSources[0] as StubBufferSource;
    expect(source.startCalls).toEqual([7]);
    expect(source.buffer).toBe(buffer);
    expect(source.connectedTargets).toEqual([destination]);
  });

  it('emptyPoor plays too (a press with no note in window still sounds)', () => {
    const ctx = new StubScheduleContext({ currentTime: 3 });
    const destination = {} as unknown as AudioNode;
    const player = createKeysoundPlayer(ctx, destination, dummyBuffer());

    player.onJudgement(makeEvent('emptyPoor'));

    expect(ctx.createdSources).toHaveLength(1);
  });

  it('missPoor/cnBreak/cnComplete do not play (not presses)', () => {
    const ctx = new StubScheduleContext();
    const destination = {} as unknown as AudioNode;
    const player = createKeysoundPlayer(ctx, destination, dummyBuffer());

    player.onJudgement(makeEvent('missPoor'));
    player.onJudgement(makeEvent('cnBreak'));
    player.onJudgement(makeEvent('cnComplete'));

    expect(ctx.createdSources).toHaveLength(0);
  });

  it('5 rapid presses (a chord) yield 5 concurrently-live overlapping sources', () => {
    const ctx = new StubScheduleContext({ currentTime: 2 });
    const destination = {} as unknown as AudioNode;
    const player = createKeysoundPlayer(ctx, destination, dummyBuffer());

    for (let lane = 0; lane < 5; lane++) {
      player.onJudgement(makeEvent('hit', { lane }));
    }

    expect(ctx.createdSources).toHaveLength(5);
    for (const source of ctx.createdSources) {
      expect(source.startCalls).toEqual([2]);
      expect(source.stopCalls).toEqual([]);
    }
  });

  it('cancelAll stops and disconnects every live source', () => {
    const ctx = new StubScheduleContext();
    const destination = {} as unknown as AudioNode;
    const player = createKeysoundPlayer(ctx, destination, dummyBuffer());

    player.onJudgement(makeEvent('hit'));
    player.onJudgement(makeEvent('hit'));
    player.cancelAll();

    expect(ctx.createdSources).toHaveLength(2);
    for (const source of ctx.createdSources) {
      expect(source.stopCalls).toEqual([0]);
      expect(source.disconnectCallCount).toBe(1);
    }
  });
});
