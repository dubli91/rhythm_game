// Deterministic RNG for the RANDOM play option: a reproducible shuffle of key
// lanes 1..7 (scratch lane 0 is never touched) so a play's lane arrangement
// can be recorded and replayed (specs/play-options.md).

export interface SeededRng {
  /** Uniform float in [0, 1). Deterministic per seed. */
  next(): number;
  /** Uniform integer in [0, maxExclusive). Throws if maxExclusive < 1 or not an integer. */
  nextInt(maxExclusive: number): number;
  readonly seed: number;
}

/** mulberry32: tiny, well-known 32-bit PRNG. */
export function createSeededRng(seed: number): SeededRng {
  const initialSeed = seed >>> 0;
  let state = initialSeed;

  function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError(`nextInt: maxExclusive must be an integer >= 1, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  }

  return {
    next,
    nextInt,
    seed: initialSeed,
  };
}

/** Swaps in place; throws if either index is out of bounds (invariant guard, never `!`). */
function swap<T>(arr: T[], i: number, j: number): void {
  const a = arr[i];
  const b = arr[j];
  if (a === undefined || b === undefined) {
    throw new RangeError(`swap: index out of bounds (i=${i}, j=${j}, length=${arr.length})`);
  }
  arr[i] = b;
  arr[j] = a;
}

/** Fisher-Yates shuffle; returns a NEW array, input untouched. */
export function shuffled<T>(rng: SeededRng, items: readonly T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    swap(result, i, j);
  }
  return result;
}

/** Permutation of [0..n-1] as an array (e.g. randomPermutation(rng, 7) for lanes 1..7 mapping). */
export function randomPermutation(rng: SeededRng, n: number): number[] {
  const identity = Array.from({ length: n }, (_, i) => i);
  return shuffled(rng, identity);
}
