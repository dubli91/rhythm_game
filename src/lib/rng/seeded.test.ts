import { describe, expect, it } from 'vitest';
import type { SeededRng } from './seeded';
import { createSeededRng, randomPermutation, shuffled } from './seeded';

function draws(rng: SeededRng, count: number): number[] {
  return Array.from({ length: count }, () => rng.next());
}

function sortedCopy<T>(items: readonly T[]): T[] {
  return items.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('createSeededRng', () => {
  it('reproduces an identical sequence for the same seed', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);

    expect(draws(a, 20)).toEqual(draws(b, 20));
  });

  it('produces different sequences for different seeds', () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);

    expect(draws(a, 20)).not.toEqual(draws(b, 20));
  });

  it('exposes the coerced seed', () => {
    expect(createSeededRng(42).seed).toBe(42);
    expect(createSeededRng(-1).seed).toBe(-1 >>> 0);
  });

  it('next() always returns a value in [0, 1)', () => {
    const rng = createSeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  describe('nextInt', () => {
    it('respects bounds over many draws', () => {
      const rng = createSeededRng(123);
      for (let i = 0; i < 500; i++) {
        const value = rng.nextInt(5);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(5);
      }
    });

    it('covers all values of a small range given enough draws', () => {
      const rng = createSeededRng(99);
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) {
        seen.add(rng.nextInt(4));
      }
      expect(seen).toEqual(new Set([0, 1, 2, 3]));
    });

    it('throws on maxExclusive of 0', () => {
      const rng = createSeededRng(1);
      expect(() => rng.nextInt(0)).toThrow(RangeError);
    });

    it('throws on a non-integer maxExclusive', () => {
      const rng = createSeededRng(1);
      expect(() => rng.nextInt(3.5)).toThrow(RangeError);
    });
  });
});

describe('shuffled', () => {
  it('returns a permutation containing the same multiset of items', () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const rng = createSeededRng(42);

    const result = shuffled(rng, items);

    expect(sortedCopy(result)).toEqual(sortedCopy(items));
  });

  it('does not mutate the input array', () => {
    const items = [1, 2, 3, 4, 5];
    const original = items.slice();
    const rng = createSeededRng(42);

    shuffled(rng, items);

    expect(items).toEqual(original);
  });

  it('is deterministic for a fixed seed', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    const first = shuffled(createSeededRng(42), items);
    const second = shuffled(createSeededRng(42), items);

    expect(first).toEqual(second);
    expect(sortedCopy(first)).toEqual(sortedCopy(items));
  });
});

describe('randomPermutation', () => {
  it('returns a valid permutation of 0..n-1', () => {
    const rng = createSeededRng(2024);

    const permutation = randomPermutation(rng, 7);

    expect(permutation).toHaveLength(7);
    expect(sortedCopy(permutation)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('is deterministic for a fixed seed', () => {
    const first = randomPermutation(createSeededRng(2024), 7);
    const second = randomPermutation(createSeededRng(2024), 7);

    expect(first).toEqual(second);
  });
});
