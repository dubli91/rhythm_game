#!/usr/bin/env node
// Generates ALL built-in songs end to end (specs/builtin-song-content.md):
// each song module under scripts/builtin-songs/ synthesizes its track and
// authors its charts from the SAME pattern data (so notes line up with
// audible events), and this entry point writes
// public/songs/<songId>/{chart-*.json,audio.ogg} plus the merged
// public/songs/index.json catalog.
//
// Songs (MUST 1-4 coverage):
//   "First Light" (Prism Unit)     — NORMAL ☆4 / HYPER ☆7, constant 150 BPM,
//                                    no BPM changes/STOPs (the MUST 4 baseline).
//   "Neon Cascade" (Aurora Vector) — NORMAL ☆6 / HYPER ☆8, 140->175->140 BPM
//                                    with a 2-beat STOP on the first change
//                                    beat (the MUST 3 timing showcase).
//   "Overdrive Core" (Redline Theory) — HYPER ☆9 / ANOTHER ☆11, constant
//                                    185 BPM (the MUST 1 high-level band).
//   "Chord Dojo 282" (Prism Unit)  — ANOTHER ☆12 practice song (single chart
//                                    slot), constant 282 BPM chord+scratch
//                                    drill, no BGM (specs/practice-song-content.md).
//
// AUDIO: ogg vorbis 44.1kHz stereo, peak-normalized to -1dBFS (spec MUST 9),
// encoded with wasm-media-encoders (libvorbis in WASM — no system ffmpeg
// needed). The practice song is the one exception: it has no BGM, so its
// `pcm` is a single short keysound sample instead, peak-normalized to 0.18
// linear (see scripts/builtin-songs/chord-dojo.mjs) and written under
// `audioFilename: 'keysound.ogg'` instead of the default audio.ogg.
//
// Deterministic and re-runnable: no Math.random anywhere; seeded mulberry32
// PRNGs are used for noise-layer texture, and the ogg stream serial is fixed
// (see lib.mjs), so re-running this script byte-for-byte reproduces every
// audio.ogg and chart JSON.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChordDojo } from './builtin-songs/chord-dojo.mjs';
import { buildFirstLight } from './builtin-songs/first-light.mjs';
import { encodeOggVorbisStereo } from './builtin-songs/lib.mjs';
import { buildNeonCascade } from './builtin-songs/neon-cascade.mjs';
import { buildOverdriveCore } from './builtin-songs/overdrive-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SONGS_DIR = join(REPO_ROOT, 'public', 'songs');

// Catalog order is also the "fresh install" display order (song-select sorts by
// title by default, which happens to match the first three: First Light, Neon
// Cascade, Overdrive Core). The practice song is appended last regardless of
// alphabetical title order — specs/practice-song-content.md wants it after the
// music songs in catalog display order.
const songs = [buildFirstLight(), buildNeonCascade(), buildOverdriveCore(), buildChordDojo()];

const seenSongIds = new Set();
for (const song of songs) {
  if (seenSongIds.has(song.songId)) {
    throw new Error(`duplicate songId ${song.songId} — title+artist hash collision`);
  }
  seenSongIds.add(song.songId);

  const songDir = join(SONGS_DIR, song.songId);
  mkdirSync(songDir, { recursive: true });
  for (const { filename, chart } of song.chartFiles) {
    writeFileSync(join(songDir, filename), `${JSON.stringify(chart, null, 2)}\n`);
  }
  const ogg = await encodeOggVorbisStereo(song.pcm.left, song.pcm.right, song.pcm.sampleRate);
  const audioFilename = song.audioFilename ?? 'audio.ogg';
  writeFileSync(join(songDir, audioFilename), ogg);
  song.summary.push(`encoded: ${audioFilename} ${ogg.length} bytes`);
  rmSync(join(songDir, 'audio.wav'), { force: true }); // pre-ogg leftover
}

const index = { songs: songs.map((song) => song.entry) };
writeFileSync(join(SONGS_DIR, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

console.log('generate-builtin-song: OK');
for (const song of songs) {
  console.log(`  ${song.entry.title} — ${song.entry.artist} (${song.songId})`);
  for (const line of song.summary) {
    console.log(`    ${line}`);
  }
}
