// Deterministic songId/chartId derivation (specs/results-records.md SHOULD 12,
// specs/builtin-song-content.md requirement 8): ids are a hash of title+artist
// (and difficulty, for chart ids) rather than random/incrementing, so that
// deleting and re-importing the same song reproduces the same songId and
// reconnects any local records (best times, play history) already stored
// under that id in localStorage.
//
// scripts/generate-builtin-song.mjs keeps a deliberately independent copy of
// fnv1a32/deriveSongId (it's a plain node script and can't import this TS
// module). This file is the canonical browser-side implementation; the two
// must stay byte-for-byte in agreement, which src/lib/chart/ids.test.ts pins
// via the known songId for the "First Light" built-in song.

/** FNV-1a, 32-bit, operating on the UTF-8 bytes of `str`. Returns an unsigned uint32. */
export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(str);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic songId: `song-` + 8 hex digits of fnv1a32(lowercased "title artist"). */
export function deriveSongId(title: string, artist: string): string {
  const key = `${title.toLowerCase()} ${artist.toLowerCase()}`;
  const hex = fnv1a32(key).toString(16).padStart(8, '0');
  return `song-${hex}`;
}

/** Deterministic chartId: `${songId}-${difficulty}`, lowercased (e.g. "song-6f90aea6-hyper"). */
export function deriveChartId(songId: string, difficulty: string): string {
  return `${songId}-${difficulty.toLowerCase()}`;
}
