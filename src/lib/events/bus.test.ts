import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, EventMap } from './bus';
import { createEventBus } from './bus';

interface TestEvents extends EventMap {
  judgement: { lane: number; grade: 'PGREAT' | 'GREAT' | 'GOOD' | 'BAD' | 'POOR' };
  input: { lane: number; pressed: boolean };
  ping: number;
}

describe('createEventBus', () => {
  let bus: EventBus<TestEvents>;

  beforeEach(() => {
    bus = createEventBus<TestEvents>();
  });

  it('calls handlers in subscription order', () => {
    const calls: string[] = [];
    bus.on('ping', () => calls.push('a'));
    bus.on('ping', () => calls.push('b'));
    bus.on('ping', () => calls.push('c'));

    bus.emit('ping', 1);

    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('passes the payload through to handlers', () => {
    const handler = vi.fn();
    bus.on('judgement', handler);

    bus.emit('judgement', { lane: 3, grade: 'PGREAT' });

    expect(handler).toHaveBeenCalledWith({ lane: 3, grade: 'PGREAT' });
  });

  it('returns an unsubscribe function from on()', () => {
    const handler = vi.fn();
    const unsubscribe = bus.on('ping', handler);

    unsubscribe();
    bus.emit('ping', 1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('off() removes a specific handler', () => {
    const handler = vi.fn();
    bus.on('ping', handler);

    bus.off('ping', handler);
    bus.emit('ping', 1);

    expect(handler).not.toHaveBeenCalled();
  });

  it('registering the same handler twice calls it twice, and off() removes one at a time', () => {
    const handler = vi.fn();
    bus.on('ping', handler);
    bus.on('ping', handler);

    bus.emit('ping', 1);
    expect(handler).toHaveBeenCalledTimes(2);

    bus.off('ping', handler);
    bus.emit('ping', 1);
    // One registration remains, so the running total goes from 2 to 3.
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('a throwing handler does not block later handlers, and is reported via console.error', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const calls: string[] = [];
      bus.on('ping', () => {
        calls.push('first');
        throw new Error('boom');
      });
      bus.on('ping', () => calls.push('second'));

      expect(() => bus.emit('ping', 1)).not.toThrow();

      expect(calls).toEqual(['first', 'second']);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('defers handlers subscribed during emit to the next emit', () => {
    const calls: string[] = [];
    bus.on('ping', () => {
      calls.push('first');
      bus.on('ping', () => calls.push('added-during-emit'));
    });

    bus.emit('ping', 1);
    expect(calls).toEqual(['first']);

    bus.emit('ping', 1);
    expect(calls).toEqual(['first', 'first', 'added-during-emit']);
  });

  it('unsubscribing a not-yet-called handler during emit prevents its pending call', () => {
    const calls: string[] = [];
    let unsubscribeThird: () => void = () => undefined;

    bus.on('ping', () => {
      calls.push('first');
      unsubscribeThird();
    });
    bus.on('ping', () => calls.push('second'));
    unsubscribeThird = bus.on('ping', () => calls.push('third'));

    bus.emit('ping', 1);

    expect(calls).toEqual(['first', 'second']);
  });

  it('clear() removes all handlers across all event types', () => {
    const pingHandler = vi.fn();
    const inputHandler = vi.fn();
    bus.on('ping', pingHandler);
    bus.on('input', inputHandler);

    bus.clear();
    bus.emit('ping', 1);
    bus.emit('input', { lane: 0, pressed: true });

    expect(pingHandler).not.toHaveBeenCalled();
    expect(inputHandler).not.toHaveBeenCalled();
  });

  it('emitting an event with no subscribers is a no-op', () => {
    expect(() => bus.emit('ping', 1)).not.toThrow();
  });
});
