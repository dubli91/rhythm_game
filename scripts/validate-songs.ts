// Built-in song asset consistency validator (specs/builtin-song-content.md SHOULD 14).
//
// Run: `npm run validate:songs`. Executed with vite-node so it imports the SAME
// TypeScript modules the app runs — catalog parsing (parseCatalog), chart schema
// validation (loadChart via loadBuiltinSong), and beat→ms conversion — instead of
// a parallel re-implementation that could silently drift from the real load path.
// The Vitest suite (builtinCharts.test.ts) covers MUST 12 in CI; this script is
// the standalone npm-invokable form the spec asks for, usable right after
// `node scripts/generate-builtin-song.mjs` without spinning up the test runner.
//
// Checks, per catalog entry in public/songs/index.json:
//   - every chartPath loads, passes full schema validation, and beat→ms
//     conversion yields finite note times
//   - the catalog slot's chartId/difficulty/level/noteCount match the chart JSON
//   - songId/chartId match their deterministic derivations (results-records.md
//     SHOULD 12 — a drifted ID would silently orphan players' local records)
//   - the referenced audio/keysound file exists on disk

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchJsonLike } from '../src/features/songs/catalog';
import { loadBuiltinCatalog, loadBuiltinSong } from '../src/features/songs/catalog';
import { deriveChartId, deriveSongId } from '../src/lib/chart/ids';
import { computeNoteTimesMs } from '../src/lib/chart/timing';
import { noteCount } from '../src/lib/chart/types';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// Same URL space the browser sees ('songs/...'), served from public/ on disk.
const fetchJson: FetchJsonLike = async (url: string) => {
  try {
    const text = await readFile(path.join(PUBLIC_DIR, url), 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return { ok: true, status: 200, json: async () => parsed };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

async function fileExists(rel: string): Promise<boolean> {
  try {
    await access(path.join(PUBLIC_DIR, rel));
    return true;
  } catch {
    return false;
  }
}

const errors: string[] = [];
let chartCount = 0;

const catalog = await loadBuiltinCatalog(fetchJson);

for (const entry of catalog.songs) {
  const where = `${entry.songId} ("${entry.title}")`;

  const expectedSongId = deriveSongId(entry.title, entry.artist);
  if (expectedSongId !== entry.songId) {
    errors.push(`${where}: songId does not match deriveSongId(title, artist) = ${expectedSongId}`);
  }

  const audioRef = entry.audio ?? entry.keysound;
  if (audioRef !== undefined && !(await fileExists(audioRef))) {
    errors.push(`${where}: referenced audio file missing: ${audioRef}`);
  }

  let songCharts;
  try {
    songCharts = (await loadBuiltinSong(entry, fetchJson)).charts;
  } catch (error) {
    errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  for (const slot of entry.charts) {
    const chart = songCharts.find((c) => c.chartId === slot.chartId);
    if (chart === undefined) {
      errors.push(`${where}: chart "${slot.chartId}" missing from ${entry.songId}'s chart files`);
      continue;
    }
    chartCount += 1;
    const slotWhere = `${where} / ${slot.chartId}`;

    if (deriveChartId(entry.songId, chart.difficulty) !== chart.chartId) {
      errors.push(`${slotWhere}: chartId does not match deriveChartId(songId, difficulty)`);
    }
    if (chart.difficulty !== slot.difficulty) {
      errors.push(
        `${slotWhere}: index.json difficulty ${slot.difficulty} != chart ${chart.difficulty}`,
      );
    }
    if (chart.level !== slot.level) {
      errors.push(`${slotWhere}: index.json level ${slot.level} != chart ${chart.level}`);
    }
    const actualNotes = noteCount(chart);
    if (actualNotes !== slot.noteCount) {
      errors.push(`${slotWhere}: index.json noteCount ${slot.noteCount} != chart ${actualNotes}`);
    }
    if (computeNoteTimesMs(chart).some((t) => !Number.isFinite(t))) {
      errors.push(`${slotWhere}: beat→ms conversion produced a non-finite note time`);
    }
  }
}

if (errors.length > 0) {
  console.error(`validate-songs: ${errors.length} problem(s) found:`);
  for (const problem of errors) {
    console.error(`  - ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `validate-songs: OK — ${catalog.songs.length} songs, ${chartCount} charts consistent with index.json`,
  );
}
