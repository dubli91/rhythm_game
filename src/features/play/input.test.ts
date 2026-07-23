import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KEY_MAP,
  type KeyEventSource,
  type KeyLikeEvent,
  LANE_COUNT_TOTAL,
  type LaneKeyEvent,
  type LaneKeyMap,
  type PlayControlEvent,
  RESERVED_LANE_CODES,
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

  it('binds no scratch secondary by default (input-handling.md MUST 12)', () => {
    expect(DEFAULT_KEY_MAP.scratchSecondary).toBeNull();
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

  it('scratch secondary must be distinct from every lane code (MUST 14: 9 unique max)', () => {
    expect(isValidKeyMap({ ...DEFAULT_KEY_MAP, scratchSecondary: 'ShiftRight' })).toBe(true);
    expect(isValidKeyMap({ ...DEFAULT_KEY_MAP, scratchSecondary: 'ShiftLeft' })).toBe(false);
    expect(isValidKeyMap({ ...DEFAULT_KEY_MAP, scratchSecondary: 'KeyK' })).toBe(false);
    expect(isValidKeyMap({ ...DEFAULT_KEY_MAP, scratchSecondary: '' })).toBe(false);
    expect(isValidKeyMap({ ...DEFAULT_KEY_MAP, scratchSecondary: null })).toBe(true);
    expect(isValidKeyMap({ lanes: DEFAULT_KEY_MAP.lanes })).toBe(true); // absent field ok
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
      expect(onLane).toHaveBeenCalledWith({
        lane,
        down: true,
        laneHeld: true,
        timeStampMs: 1000 + lane,
      });
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
        laneHeld: false,
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
    for (const code of ['PageUp', 'PageDown', 'Home', 'Escape', 'F1']) {
      source.dispatch('keydown', makeEvent(code, { repeat: true }));
    }
    expect(onControl).not.toHaveBeenCalled();
  });

  it('emits devOverlayToggle on F1 (playfield-rendering.md SHOULD 16)', () => {
    const { source, onControl, onLane, input } = makeHarness();
    input.attach();

    const event = makeEvent('F1', { timeStamp: 77 });
    source.dispatch('keydown', event);
    expect(onControl).toHaveBeenCalledExactlyOnceWith({
      action: 'devOverlayToggle',
      timeStampMs: 77,
    });
    // preventDefault so the browser's own F1 behavior (help) never fires in play.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onLane).not.toHaveBeenCalled();
  });

  it('reserves F1 alongside the six option codes (settings must refuse lane binds)', () => {
    for (const code of ['Escape', 'PageUp', 'PageDown', 'Home', 'ArrowUp', 'ArrowDown', 'F1']) {
      expect(RESERVED_LANE_CODES.has(code)).toBe(true);
    }
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
    expect(onLane).toHaveBeenCalledExactlyOnceWith({
      lane: 0,
      down: true,
      laneHeld: true,
      timeStampMs: 5,
    });
    expect(input.isHeld(0)).toBe(true);

    // Default-map code is unmapped under the custom map.
    onLane.mockClear();
    const shiftEvent = makeEvent('ShiftLeft');
    source.dispatch('keydown', shiftEvent);
    expect(onLane).not.toHaveBeenCalled();
    expect(shiftEvent.preventDefault).not.toHaveBeenCalled();
  });

  describe('focused text widget owns the keyboard (app-shell-navigation.md MUST 17)', () => {
    // Why: the practice shuffle entry (practice-mode.md MUST 15) is a DOM
    // <input> living inside a running session — typing '7654321' or pressing
    // Escape there must never judge lanes or quit the session.
    it('ignores keydowns targeting an INPUT/TEXTAREA/SELECT — lanes AND controls', () => {
      const { source, onLane, onControl, input } = makeHarness();
      input.attach();

      for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
        const lane = makeEvent('KeyS', { target: { tagName } });
        source.dispatch('keydown', lane);
        const control = makeEvent('Escape', { target: { tagName } });
        source.dispatch('keydown', control);
        // Ignored entirely: no dispatch, and no preventDefault (the widget
        // needs the default behavior — text insertion, caret moves).
        expect(lane.preventDefault).not.toHaveBeenCalled();
        expect(control.preventDefault).not.toHaveBeenCalled();
      }
      expect(onLane).not.toHaveBeenCalled();
      expect(onControl).not.toHaveBeenCalled();
    });

    it('non-widget targets (body, canvas, absent) still dispatch normally', () => {
      const { source, onLane, input } = makeHarness();
      input.attach();

      source.dispatch('keydown', makeEvent('KeyS', { target: { tagName: 'BODY' } }));
      source.dispatch('keyup', makeEvent('KeyS', { target: { tagName: 'BODY' } }));
      source.dispatch('keydown', makeEvent('KeyS', { target: null }));
      expect(onLane).toHaveBeenCalledTimes(3);
    });

    it('keyups are NOT guarded: a lane released after focus moved into a widget still clears', () => {
      const { source, onLane, input } = makeHarness();
      input.attach();

      source.dispatch('keydown', makeEvent('KeyS'));
      expect(input.isHeld(1)).toBe(true);
      // Focus moved into the shuffle input before the key was released.
      source.dispatch('keyup', makeEvent('KeyS', { target: { tagName: 'INPUT' } }));
      expect(input.isHeld(1)).toBe(false);
      expect(onLane).toHaveBeenLastCalledWith(
        expect.objectContaining({ lane: 1, down: false, laneHeld: false }),
      );
    });
  });

  describe('scratch secondary key (input-handling.md MUST 12-13)', () => {
    const mapWithSecondary: LaneKeyMap = {
      lanes: [...DEFAULT_KEY_MAP.lanes],
      scratchSecondary: 'ShiftRight',
    };

    it('either code fires an independent lane-0 keydown, even while the other is held', () => {
      const { source, onLane, input } = makeHarness(mapWithSecondary);
      input.attach();

      source.dispatch('keydown', makeEvent('ShiftLeft', { timeStamp: 10 }));
      expect(onLane).toHaveBeenLastCalledWith({
        lane: 0,
        down: true,
        laneHeld: true,
        timeStampMs: 10,
      });
      // The secondary keydown is NOT swallowed by the held primary — each
      // physical keydown is one scratch input (MUST 13, alternating fingers).
      source.dispatch('keydown', makeEvent('ShiftRight', { timeStamp: 20 }));
      expect(onLane).toHaveBeenCalledTimes(2);
      expect(onLane).toHaveBeenLastCalledWith({
        lane: 0,
        down: true,
        laneHeld: true,
        timeStampMs: 20,
      });
      expect(input.isHeld(0)).toBe(true);
    });

    it('laneHeld stays true until the LAST of the two keys is released (beam rule)', () => {
      const { source, onLane, input } = makeHarness(mapWithSecondary);
      input.attach();

      source.dispatch('keydown', makeEvent('ShiftLeft', { timeStamp: 1 }));
      source.dispatch('keydown', makeEvent('ShiftRight', { timeStamp: 2 }));
      onLane.mockClear();

      source.dispatch('keyup', makeEvent('ShiftLeft', { timeStamp: 3 }));
      expect(onLane).toHaveBeenLastCalledWith({
        lane: 0,
        down: false,
        laneHeld: true, // secondary still down — beam stays lit
        timeStampMs: 3,
      });
      expect(input.isHeld(0)).toBe(true);

      source.dispatch('keyup', makeEvent('ShiftRight', { timeStamp: 4 }));
      expect(onLane).toHaveBeenLastCalledWith({
        lane: 0,
        down: false,
        laneHeld: false,
        timeStampMs: 4,
      });
      expect(input.isHeld(0)).toBe(false);
    });

    it('rapid alternation delivers every keydown as its own input', () => {
      const { source, onLane, input } = makeHarness(mapWithSecondary);
      input.attach();

      const downs = () =>
        onLane.mock.calls.filter(([e]) => e.down && e.lane === 0).map(([e]) => e.timeStampMs);
      for (let i = 0; i < 4; i++) {
        const code = i % 2 === 0 ? 'ShiftLeft' : 'ShiftRight';
        source.dispatch('keydown', makeEvent(code, { timeStamp: 100 + i * 2 }));
        source.dispatch('keyup', makeEvent(code, { timeStamp: 101 + i * 2 }));
      }
      expect(downs()).toEqual([100, 102, 104, 106]);
      expect(input.isHeld(0)).toBe(false);
    });

    it('detach clears per-code state so a re-attach starts clean', () => {
      const { source, input } = makeHarness(mapWithSecondary);
      input.attach();
      source.dispatch('keydown', makeEvent('ShiftRight', { timeStamp: 1 }));
      input.detach();
      input.attach();
      // Without the down-code cleared, this keyup would report laneHeld leftovers.
      source.dispatch('keyup', makeEvent('ShiftRight', { timeStamp: 2 }));
      expect(input.isHeld(0)).toBe(false);
    });
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
