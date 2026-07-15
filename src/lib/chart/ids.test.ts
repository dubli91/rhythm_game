import { describe, expect, it } from 'vitest';
import { deriveChartId, deriveSongId, fnv1a32 } from './ids';

describe('deriveSongId', () => {
  it('matches the known songId for the "First Light" built-in song, pinning agreement with scripts/generate-builtin-song.mjs', () => {
    expect(deriveSongId('First Light', 'Prism Unit')).toBe('song-6f90aea6');
  });

  it('is case-insensitive', () => {
    expect(deriveSongId('First Light', 'Prism Unit')).toBe(
      deriveSongId('FIRST LIGHT', 'prism unit'),
    );
  });

  it('produces ids matching /^song-[0-9a-f]{8}$/ for arbitrary inputs', () => {
    for (const [title, artist] of [
      ['Some Song', 'Some Artist'],
      ['', ''],
      ['Numbers 123', 'Artist!?'],
    ] as const) {
      expect(deriveSongId(title, artist)).toMatch(/^song-[0-9a-f]{8}$/);
    }
  });

  it('is stable: the same input always produces the same output', () => {
    expect(deriveSongId('Repeat Test', 'Artist')).toBe(deriveSongId('Repeat Test', 'Artist'));
  });

  it('produces different ids for different title/artist pairs', () => {
    expect(deriveSongId('Song A', 'Artist')).not.toBe(deriveSongId('Song B', 'Artist'));
  });
});

describe('deriveChartId', () => {
  it('joins songId and lowercased difficulty', () => {
    expect(deriveChartId('song-6f90aea6', 'HYPER')).toBe('song-6f90aea6-hyper');
  });
});

describe('fnv1a32', () => {
  it('handles non-ASCII input without throwing and returns an unsigned 32-bit int', () => {
    const hash = fnv1a32('첫 번째 빛');
    expect(() => fnv1a32('첫 번째 빛')).not.toThrow();
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});
