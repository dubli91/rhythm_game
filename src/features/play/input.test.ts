import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEY_MAP,
  type KeyEventSource,
  type KeyLikeEvent,
  LANE_COUNT_TOTAL,
  type LaneKeyEvent,
  type LaneKeyMap,
  type PlayControlEvent,
  createPlayInput,
  isValidKeyMap,
} from './input';

type Handler = (event: KeyLikeEvent) => void;

/** Fake KeyEventSource: stores handlers per type, dispatch() invokes them. */
class FakeKeyEventSource implements KeyEventSource {
  private handlers = new Map<'keydown' | 'keyup', Handler[]>();

  addEventListener(type: 'keydown' | 'keyup', handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  removeEventListener(type: 'keydown' | 'keyup', handler: Handler): void {
    const list = this.handlers.get(type);
    if (!list) {
      return;
    }
    const index = list.indexOf(handler);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }

  listenerCount(type: 'keydown' | 'keyup'): number {
    return this.handlers.get(type)?.length ?? 0;
  }

  dispatch(type: 'keydown' | 'keyup', event: KeyLikeEvent): void {
    const list = this.handlers.get(type);
    if (!list) {
      return;
    }
    // Snapshot since handlers themselves don't mutate the list mid-dispatch here.
    for (const handler of list.slice()) {
      handler(event);
    }
  }
}

function makeEvent(code: string, opts: Partial<KeyLikeEvent> = {}): KeyLikeEvent {
  return {
    code,
    repeat: false,
    timeStamp: 0,
    preventDefault: vi.fn(),
    ...opts,
  };
}

function makeHarness(keyMap?: LaneKeyMap) {
  const source = new FakeKeyEventSource();
  const onLane = vi.fn<(event: LaneKeyEvent) => void>();
  const onControl = vi.fn<(event: PlayControlEvent) => void>();
  const input = createPlayInput(source, { keyMap, onLane, onControl });
  return { source, onLane, onControl, input };
}

describe('DEFAULT_KEY_MAP', () => {
  it('is valid and matches the spec order', () => {
    expect(isValidKeyMap(DEFAULT_KEY_MAP)).toBe(true);
    expect(DEFAULT_KEY_MAP.lanes).toEqual([
      'ShiftLeft',
      'KeyS',
      'KeyD',
      'KeyF',
      'Space',
      'KeyJ',
      'KeyK',
      'KeyL',
    ]);
  });
});

describe('isValidKeyMap', () => {
  it('rejects wrong length', () => {
    expect(isValidKeyMap({ lanes: ['ShiftLeft', 'KeyS'] })).toBe(false);
  });

  it('rejects duplicate codes', () => {
    const lanes = [...DEFAULT_KEY_MAP.lanes];
    lanes[1] = lanes[0] as string;
    expect(isValidKeyMap({ lanes })).toBe(false);
  });

  it('rejects empty-string codes', () => {
    const lanes = [...DEFAULT_KEY_MAP.lanes];
    lanes[3] = '';
    expect(isValidKeyMap({ lanes })).toBe(false);
  });

  it('accepts a valid custom map', () => {
    expect(
      isValidKeyMap({
        lanes: ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH'],
      }),
    ).toBe(true);
  });
});

describe('createPlayInput', () => {
  it('routes each default-map code to its lane on keydown, preserving timeStamp', () => {
    const { source, onLane, input } = makeHarness();
    input.attach();

    DEFAULT_KEY_MAP.lanes.forEach((code, lane) => {
      onLane.mockClear();
      const event = makeEvent(code, { timeStamp: 1000 + lane });
      source.dispatch('keydown', event);
      expect(onLane).toHaveBeenCalledTimes(1);
      expect(onLane).toHaveBeenCalledWith({ lane, down: true, timeStampMs: 1000 + lane });
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });
  });

  it('ignores repeat keydowns entirely', () => {
    const { source, onLane, input } = makeHarness();
    input.attach();

    const event = makeEvent('KeyS', { repeat: true });
    source.dispatch('keydown', event);

    expect(onLane).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(input.isHeld(1)).toBe(false);
  });

  it('tracks all 8 lanes independently when pressed simultaneously, then released', () => {
    const { source, onLane, input } = makeHarness();
    input.attach();

    DEFAULT_KEY_MAP.lanes.forEach((code, lane) => {
      source.dispatch('keydown', makeEvent(code, { timeStamp: 2000 + lane }));
    });

    expect(onLane).toHaveBeenCalledTimes(LANE_COUNT_TOTAL);
    expect(input.heldLanes()).toEqual(new Array(LANE_COUNT_TOTAL).fill(true));
    for (let lane = 0; lane < LANE_COUNT_TOTAL; lane += 1) {
      expect(input.isHeld(lane)).toBe(true);
    }

    onLane.mockClear();

    // Release lanes one at a time; each keyup only clears its own lane.
    DEFAULT_KEY_MAP.lanes.forEach((code, lane) => {
      source.dispatch('keyup', makeEvent(code, { timeStamp: 3000 + lane }));
      expect(input.isHeld(lane)).toBe(false);
      expect(onLane).toHaveBeenLastCalledWith({
        lane,
        down: false,
        timeStampMs: 3000 + lane,
      });
    });

    expect(onLane).toHaveBeenCalledTimes(LANE_COUNT_TOTAL);
    expect(input.heldLanes()).toEqual(new Array(LANE_COUNT_TOTAL).fill(false));
  });

  it('calls preventDefault for mapped keys and Escape, not for unmapped keys', () => {
    const { source, input } = makeHarness();
    input.attach();

    const mapped = makeEvent('KeyS');
    source.dispatch('keydown', mapped);
    expect(mapped.preventDefault).toHaveBeenCalledTimes(1);

    const escapeEvent = makeEvent('Escape');
    source.dispatch('keydown', escapeEvent);
    expect(escapeEvent.preventDefault).toHaveBeenCalledTimes(1);

    const unmapped = makeEvent('KeyQ');
    source.dispatch('keydown', unmapped);
    expect(unmapped.preventDefault).not.toHaveBeenCalled();
  });

  it('emits onControl quit on Escape keydown (not repeat)', () => {
    const { source, onControl, input } = makeHarness();
    input.attach();

    source.dispatch('keydown', makeEvent('Escape', { timeStamp: 42 }));
    expect(onControl).toHaveBeenCalledExactlyOnceWith({ action: 'quit', timeStampMs: 42 });

    onControl.mockClear();
    source.dispatch('keydown', makeEvent('Escape', { repeat: true, timeStamp: 43 }));
    expect(onControl).not.toHaveBeenCalled();
  });

  it('emits option-control actions for the play-options keys (play-options.md MUST 3/6)', () => {
    const { source, onControl, onLane, input } = makeHarness();
    input.attach();

    const cases = [
      ['PageUp', 'hiSpeedUp'],
      ['PageDown', 'hiSpeedDown'],
      ['Home', 'suddenToggle'],
      ['ArrowUp', 'coverUp'],
      ['ArrowDown', 'coverDown'],
    ] as const;
    cases.forEach(([code, action], i) => {
      onControl.mockClear();
      const event = makeEvent(code, { timeStamp: 100 + i });
      source.dispatch('keydown', event);
      expect(onControl).toHaveBeenCalledExactlyOnceWith({ action, timeStampMs: 100 + i });
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });
    expect(onLane).not.toHaveBeenCalled();
  });

  it('passes key-repeat through for cover keys only (hold-to-adjust, MUST 6)', () => {
    const { source, onControl, input } = makeHarness();
    input.attach();

    source.dispatch('keydown', makeEvent('ArrowUp', { repeat: true, timeStamp: 1 }));
    source.dispatch('keydown', makeEvent('ArrowDown', { repeat: true, timeStamp: 2 }));
    expect(onControl).toHaveBeenCalledTimes(2);

    onControl.mockClear();
    for (const code of ['PageUp', 'PageDown', 'Home', 'Escape']) {
      source.dispatch('keydown', makeEvent(code, { repeat: true }));
    }
    expect(onControl).not.toHaveBeenCalled();
  });

  it('control codes win over a key map that tries to bind them to a lane', () => {
    const customMap: LaneKeyMap = {
      lanes: ['ArrowUp', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH'],
    };
    const { source, onLane, onControl, input } = makeHarness(customMap);
    input.attach();

    source.dispatch('keydown', makeEvent('ArrowUp', { timeStamp: 9 }));
    expect(onControl).toHaveBeenCalledExactlyOnceWith({ action: 'coverUp', timeStampMs: 9 });
    expect(onLane).not.toHaveBeenCalled();
  });

  it('never emits or preventDefaults for unmapped keys on keyup either', () => {
    const { source, onLane, input } = makeHarness();
    input.attach();

    const event = makeEvent('KeyQ');
    source.dispatch('keyup', event);
    expect(onLane).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores keyup for a lane that is not held', () => {
    const { source, onLane, input } = makeHarness();
    input.attach();

    // KeyS (lane 1) was never pressed down.
    const event = makeEvent('KeyS');
    source.dispatch('keyup', event);

    expect(onLane).not.toHaveBeenCalled();
    // Mapped key still gets preventDefault even if the up is a no-op state change.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(input.isHeld(1)).toBe(false);
  });

  it('ignores a second keydown for an already-held lane (no keyup between)', () => {
    const { source, onLane, input } = makeHarness();
    input.attach();

    source.dispatch('keydown', makeEvent('KeyD', { timeStamp: 10 }));
    expect(onLane).toHaveBeenCalledTimes(1);

    onLane.mockClear();
    source.dispatch('keydown', makeEvent('KeyD', { timeStamp: 20 }));
    expect(onLane).not.toHaveBeenCalled();
    expect(input.isHeld(2)).toBe(true);
  });

  it('detach removes listeners and clears held state; attach/detach are idempotent', () => {
    const { source, onLane, input } = makeHarness();

    input.attach();
    input.attach(); // idempotent: should not double-register
    expect(source.listenerCount('keydown')).toBe(1);
    expect(source.listenerCount('keyup')).toBe(1);

    source.dispatch('keydown', makeEvent('KeyS', { timeStamp: 1 }));
    expect(input.isHeld(1)).toBe(true);

    input.detach();
    expect(source.listenerCount('keydown')).toBe(0);
    expect(source.listenerCount('keyup')).toBe(0);
    expect(input.isHeld(1)).toBe(false);
    expect(input.heldLanes()).toEqual(new Array(LANE_COUNT_TOTAL).fill(false));

    input.detach(); // idempotent: no error

    onLane.mockClear();
    // Dispatch after detach reaches nothing since no listeners are registered.
    source.dispatch('keydown', makeEvent('KeyS', { timeStamp: 2 }));
    expect(onLane).not.toHaveBeenCalled();
    expect(input.isHeld(1)).toBe(false);
  });

  it('respects a custom keyMap', () => {
    const customMap: LaneKeyMap = {
      lanes: ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH'],
    };
    const { source, onLane, input } = makeHarness(customMap);
    input.attach();

    source.dispatch('keydown', makeEvent('KeyA', { timeStamp: 5 }));
    expect(onLane).toHaveBeenCalledExactlyOnceWith({ lane: 0, down: true, timeStampMs: 5 });
    expect(input.isHeld(0)).toBe(true);

    // Default-map code is unmapped under the custom map.
    onLane.mockClear();
    const shiftEvent = makeEvent('ShiftLeft');
    source.dispatch('keydown', shiftEvent);
    expect(onLane).not.toHaveBeenCalled();
    expect(shiftEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('heldLanes() returns the same stable array reference across calls', () => {
    const { input } = makeHarness();
    input.attach();

    const first = input.heldLanes();
    const second = input.heldLanes();
    expect(first).toBe(second);
  });

  it('heldLanes() reference stays stable across state-mutating dispatches', () => {
    const { source, input } = makeHarness();
    input.attach();

    const ref = input.heldLanes();
    source.dispatch('keydown', makeEvent('KeyS', { timeStamp: 1 }));
    expect(input.heldLanes()).toBe(ref);
    source.dispatch('keyup', makeEvent('KeyS', { timeStamp: 2 }));
    expect(input.heldLanes()).toBe(ref);
  });
});
