import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_TRANSITIONS, type ScreenId, createScreenMachine } from './screens';

const ALL_SCREENS: readonly ScreenId[] = [
  'TITLE',
  'SONG_SELECT',
  'SETTINGS',
  'IMPORT',
  'PRACTICE_EDIT',
  'PRACTICE_PLAY',
  'PLAY',
  'RESULTS',
];

describe('ALLOWED_TRANSITIONS', () => {
  it('is exhaustive over all 8 screens as keys', () => {
    const keys = Object.keys(ALLOWED_TRANSITIONS).sort();
    expect(keys).toEqual([...ALL_SCREENS].sort());
  });
});

describe('allowed edges succeed', () => {
  for (const from of ALL_SCREENS) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      it(`${from} -> ${to} succeeds`, () => {
        const machine = createScreenMachine(from);
        expect(machine.canTransition(to)).toBe(true);
        expect(() => machine.transition(to)).not.toThrow();
        expect(machine.current()).toBe(to);
      });
    }
  }
});

describe('forbidden transitions throw and leave state unchanged', () => {
  const forbidden: Array<[ScreenId, ScreenId]> = [
    ['TITLE', 'SETTINGS'],
    ['TITLE', 'PLAY'],
    ['PLAY', 'SONG_SELECT'],
    ['RESULTS', 'SETTINGS'],
    ['SONG_SELECT', 'RESULTS'],
    ['SONG_SELECT', 'TITLE'],
    ['SETTINGS', 'TITLE'],
    ['PLAY', 'TITLE'],
    ['RESULTS', 'TITLE'],
    ['PRACTICE_PLAY', 'TITLE'],
    ['TITLE', 'TITLE'],
    ['SONG_SELECT', 'SONG_SELECT'],
    ['PLAY', 'PLAY'],
    ['RESULTS', 'RESULTS'],
  ];

  for (const [from, to] of forbidden) {
    it(`${from} -> ${to} throws`, () => {
      const machine = createScreenMachine(from);
      expect(machine.canTransition(to)).toBe(false);
      expect(() => machine.transition(to)).toThrow(`forbidden screen transition: ${from} -> ${to}`);
      expect(machine.current()).toBe(from);
    });
  }
});

describe('canTransition mirrors transition behavior', () => {
  it('returns true exactly for allowed edges, false otherwise, without throwing', () => {
    for (const from of ALL_SCREENS) {
      const machine = createScreenMachine(from);
      for (const to of ALL_SCREENS) {
        const allowed = ALLOWED_TRANSITIONS[from].includes(to);
        expect(machine.canTransition(to)).toBe(allowed);
      }
      // canTransition never mutates or throws regardless of outcome
      expect(machine.current()).toBe(from);
    }
  });
});

describe('onChange', () => {
  it('fires with (from, to) after current() reflects the new screen', () => {
    const machine = createScreenMachine('TITLE');
    let observedCurrent: ScreenId | undefined;
    machine.onChange((from, to) => {
      observedCurrent = machine.current();
      expect(from).toBe('TITLE');
      expect(to).toBe('SONG_SELECT');
    });
    machine.transition('SONG_SELECT');
    expect(observedCurrent).toBe('SONG_SELECT');
  });

  it('unsubscribe stops further notifications', () => {
    const machine = createScreenMachine('TITLE');
    const handler = vi.fn();
    const unsubscribe = machine.onChange(handler);
    machine.transition('SONG_SELECT');
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
    machine.transition('SETTINGS');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler does not block other handlers or corrupt state', () => {
    const machine = createScreenMachine('TITLE');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];

    machine.onChange(() => {
      order.push('first');
      throw new Error('boom');
    });
    machine.onChange((from, to) => {
      order.push('second');
      expect(from).toBe('TITLE');
      expect(to).toBe('SONG_SELECT');
    });

    expect(() => machine.transition('SONG_SELECT')).not.toThrow();
    expect(order).toEqual(['first', 'second']);
    expect(machine.current()).toBe('SONG_SELECT');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it('multiple handlers all receive the same transition', () => {
    const machine = createScreenMachine('TITLE');
    const a = vi.fn();
    const b = vi.fn();
    machine.onChange(a);
    machine.onChange(b);
    machine.transition('SONG_SELECT');
    expect(a).toHaveBeenCalledWith('TITLE', 'SONG_SELECT');
    expect(b).toHaveBeenCalledWith('TITLE', 'SONG_SELECT');
  });
});

describe('happy path walk', () => {
  it('TITLE -> SONG_SELECT -> PLAY -> RESULTS -> PLAY -> RESULTS -> SONG_SELECT', () => {
    const machine = createScreenMachine();
    expect(machine.current()).toBe('TITLE');

    machine.transition('SONG_SELECT');
    expect(machine.current()).toBe('SONG_SELECT');

    machine.transition('PLAY');
    expect(machine.current()).toBe('PLAY');

    machine.transition('RESULTS');
    expect(machine.current()).toBe('RESULTS');

    machine.transition('PLAY');
    expect(machine.current()).toBe('PLAY');

    machine.transition('RESULTS');
    expect(machine.current()).toBe('RESULTS');

    machine.transition('SONG_SELECT');
    expect(machine.current()).toBe('SONG_SELECT');
  });
});

describe('createScreenMachine defaults', () => {
  it('defaults to TITLE when no initial screen is given', () => {
    const machine = createScreenMachine();
    expect(machine.current()).toBe('TITLE');
  });
});
