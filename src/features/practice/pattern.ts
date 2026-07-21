// Practice-mode pattern data model (specs/practice-mode.md MUST 2-4, SHOULD 12).
// A practice pattern is a small chart-format subset: tap notes only, no BPM
// changes/STOPs, note positions in decimal beats (4 beats/bar). The editor grid
// (bars x snap) only constrains where toggleCell places new notes — stored note
// beats are otherwise unconstrained decimals, so loaded/preset data need not sit
// on the current snap grid.

import { KEY_LANE_MAX, LANE_SCRATCH } from '../../lib/chart/types';

// Editor grid divisions per bar (practice-mode.md MUST 2).
export const SNAP_VALUES = [4, 8, 12, 16, 24, 32] as const;
export type SnapValue = (typeof SNAP_VALUES)[number];

export const MIN_BARS = 1;
export const MAX_BARS = 8;

// practice-mode.md MUST 3.
export const MIN_PATTERN_BPM = 60;
export const MAX_PATTERN_BPM = 400;

export const BEATS_PER_BAR = 4;

export interface PracticePatternNote {
  beat: number;
  /** 0 = scratch, 1..7 = keys (see LANE_SCRATCH/KEY_LANE_MAX in lib/chart/types). */
  lane: number;
}

export interface PracticePattern {
  patternId: string;
  name: string;
  bpm: number; // integer, MIN_PATTERN_BPM..MAX_PATTERN_BPM
  bars: number; // integer, MIN_BARS..MAX_BARS
  snap: SnapValue; // editor grid resolution; does not constrain stored note beats
  notes: PracticePatternNote[]; // sorted by beat then lane, no (beat,lane) duplicates
  updatedAt: number; // epoch ms; 0 until first save
}

// Tolerance for float grid-boundary comparisons (e.g. snap 12 -> 1/3-beat cells
// whose multiples don't land on exact binary floats). All half-open beat ranges
// below are shifted inward by EPSILON so a value meant to sit exactly on a
// boundary is classified consistently regardless of which side float error puts
// it on.
const EPSILON = 1e-9;

export function createEmptyPattern(patternId: string, name = 'Untitled'): PracticePattern {
  return {
    patternId,
    name,
    bpm: 120,
    bars: 4,
    snap: 16,
    notes: [],
    updatedAt: 0,
  };
}

export function patternBeats(pattern: PracticePattern): number {
  return pattern.bars * BEATS_PER_BAR;
}

export function cellBeats(snap: SnapValue): number {
  return BEATS_PER_BAR / snap;
}

export function cellCount(pattern: PracticePattern): number {
  return pattern.bars * pattern.snap;
}

/** Pure: returns a new array sorted by beat asc, then lane asc (stable). */
export function sortNotes(notes: readonly PracticePatternNote[]): PracticePatternNote[] {
  return [...notes].sort((a, b) => a.beat - b.beat || a.lane - b.lane);
}

function isBeatInBounds(beat: number, maxBeat: number): boolean {
  return beat >= 0 && beat < maxBeat - EPSILON;
}

export function notesInCell(
  pattern: PracticePattern,
  lane: number,
  cellIndex: number,
): PracticePatternNote[] {
  const cb = cellBeats(pattern.snap);
  const start = cellIndex * cb;
  const end = start + cb;
  return pattern.notes.filter(
    (note) => note.lane === lane && note.beat >= start - EPSILON && note.beat < end - EPSILON,
  );
}

/**
 * Pure: returns a NEW pattern. If the target cell holds any notes (on-grid or
 * off-grid, per notesInCell), removes all of them; otherwise adds a single note
 * at the cell's start beat. `updatedAt` is left untouched — callers stamp it on
 * save. No-op (returns `pattern` as-is) for an out-of-range lane or cell.
 */
export function toggleCell(
  pattern: PracticePattern,
  lane: number,
  cellIndex: number,
): PracticePattern {
  if (lane < LANE_SCRATCH || lane > KEY_LANE_MAX) return pattern;
  if (cellIndex < 0 || cellIndex >= cellCount(pattern)) return pattern;

  const existing = notesInCell(pattern, lane, cellIndex);
  if (existing.length > 0) {
    const toRemove = new Set<PracticePatternNote>(existing);
    return { ...pattern, notes: pattern.notes.filter((note) => !toRemove.has(note)) };
  }

  const beat = cellIndex * cellBeats(pattern.snap);
  return { ...pattern, notes: sortNotes([...pattern.notes, { beat, lane }]) };
}

/** Clamps+truncates bars to an integer in MIN_BARS..MAX_BARS, dropping notes that fall out of range. */
export function setBars(pattern: PracticePattern, bars: number): PracticePattern {
  const clamped = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.trunc(bars)));
  const maxBeat = clamped * BEATS_PER_BAR;
  return {
    ...pattern,
    bars: clamped,
    notes: pattern.notes.filter((note) => isBeatInBounds(note.beat, maxBeat)),
  };
}

/** Rounds to an integer and clamps to MIN_PATTERN_BPM..MAX_PATTERN_BPM. Non-finite input keeps the previous bpm. */
export function setBpm(pattern: PracticePattern, bpm: number): PracticePattern {
  if (!Number.isFinite(bpm)) return pattern;
  const clamped = Math.min(MAX_PATTERN_BPM, Math.max(MIN_PATTERN_BPM, Math.round(bpm)));
  return { ...pattern, bpm: clamped };
}

export function setSnap(pattern: PracticePattern, snap: SnapValue): PracticePattern {
  return { ...pattern, snap };
}

/**
 * Structural guard for IndexedDB reads. Note order is NOT checked here —
 * normalize with sortNotes() after a successful load.
 */
export function isPracticePattern(raw: unknown): raw is PracticePattern {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;

  if (typeof p.patternId !== 'string' || p.patternId.length === 0) return false;
  if (typeof p.name !== 'string') return false;
  if (
    typeof p.bpm !== 'number' ||
    !Number.isFinite(p.bpm) ||
    p.bpm < MIN_PATTERN_BPM ||
    p.bpm > MAX_PATTERN_BPM
  ) {
    return false;
  }
  if (
    typeof p.bars !== 'number' ||
    !Number.isInteger(p.bars) ||
    p.bars < MIN_BARS ||
    p.bars > MAX_BARS
  ) {
    return false;
  }
  if (typeof p.snap !== 'number' || !(SNAP_VALUES as readonly number[]).includes(p.snap)) {
    return false;
  }
  if (typeof p.updatedAt !== 'number' || !Number.isFinite(p.updatedAt)) return false;
  if (!Array.isArray(p.notes)) return false;

  const maxBeat = p.bars * BEATS_PER_BAR;
  const seen = new Set<string>();
  for (const rawNote of p.notes) {
    if (typeof rawNote !== 'object' || rawNote === null) return false;
    const note = rawNote as Record<string, unknown>;

    if (typeof note.beat !== 'number' || !isBeatInBounds(note.beat, maxBeat)) return false;
    if (typeof note.lane !== 'number' || !Number.isInteger(note.lane)) return false;
    if (note.lane < LANE_SCRATCH || note.lane > KEY_LANE_MAX) return false;

    const key = `${note.beat}:${note.lane}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }

  return true;
}

export interface PracticePreset {
  key: string;
  name: string;
  build(bars: number): PracticePatternNote[];
  /** Source tempo the excerpt was transcribed at; unset presets don't touch pattern.bpm. */
  bpm?: number;
}

// practice-mode.md SHOULD 12: trill / staircase / chords / scratch+keys.

function buildTrill(bars: number): PracticePatternNote[] {
  const notes: PracticePatternNote[] = [];
  const count = bars * 16;
  for (let c = 0; c < count; c++) {
    notes.push({ beat: c * 0.25, lane: 1 + (c % 2) });
  }
  return sortNotes(notes);
}

const STAIRS_SEQUENCE = [1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2] as const;

function buildStairs(bars: number): PracticePatternNote[] {
  const notes: PracticePatternNote[] = [];
  const count = bars * 16;
  for (let c = 0; c < count; c++) {
    const lane = STAIRS_SEQUENCE[c % STAIRS_SEQUENCE.length] ?? 1;
    notes.push({ beat: c * 0.25, lane });
  }
  return sortNotes(notes);
}

function buildChords(bars: number): PracticePatternNote[] {
  const notes: PracticePatternNote[] = [];
  const count = bars * BEATS_PER_BAR;
  for (let b = 0; b < count; b++) {
    const laneA = b % 2 === 0 ? 1 : 5;
    const laneB = b % 2 === 0 ? 3 : 7;
    notes.push({ beat: b, lane: laneA }, { beat: b, lane: laneB });
  }
  return sortNotes(notes);
}

function buildScratchKeys(bars: number): PracticePatternNote[] {
  const notes: PracticePatternNote[] = [];
  for (let bar = 0; bar < bars; bar++) {
    notes.push({ beat: bar * BEATS_PER_BAR, lane: LANE_SCRATCH });
  }
  const count = bars * 8;
  for (let c = 0; c < count; c++) {
    notes.push({ beat: c * 0.5, lane: 3 + (c % 2) * 2 });
  }
  return sortNotes(notes);
}

// practice-song-content.md SHOULD 14: 4-bar (16-beat) excerpts transcribed verbatim from the
// built-in "Chord Dojo 282" chart — dojo-chords mirrors bars 1-4 (A "chord stream" section),
// dojo-scratch mirrors bars 13-16 (C "scratch rush" section). Index = beat within the excerpt.
const DOJO_CHORDS_EXCERPT: readonly (readonly number[])[] = [
  [0, 1, 3, 5],
  [4, 6],
  [2, 5, 7],
  [3, 6],
  [1, 4, 6],
  [2, 5],
  [3, 5, 7],
  [1, 4],
  [0, 2, 4, 7],
  [1, 5],
  [3, 6],
  [2, 4, 6],
  [1, 3, 6],
  [4, 7],
  [2, 5],
  [1, 3, 5, 7],
];

const DOJO_SCRATCH_EXCERPT: readonly (readonly number[])[] = [
  [0, 1, 5],
  [0, 3, 7],
  [0, 2, 6],
  [0, 1, 4, 7],
  [0, 3, 5],
  [0, 2, 7],
  [0, 4, 6],
  [1, 3, 5],
  [0, 2, 7],
  [0, 1, 4],
  [0, 3, 6],
  [0, 2, 5, 7],
  [0, 1, 3],
  [0, 4, 7],
  [0, 2, 5],
  [0, 1, 3, 5],
];

const DOJO_EXCERPT_BEATS = 16; // 4 bars

/**
 * Tiles a 16-beat excerpt every 16 beats to fill `bars`, dropping notes at/after
 * bars*BEATS_PER_BAR (so bars<4 truncates the excerpt; bars=8 repeats it twice).
 */
function buildDojoExcerpt(
  excerpt: readonly (readonly number[])[],
  bars: number,
): PracticePatternNote[] {
  const notes: PracticePatternNote[] = [];
  const maxBeat = bars * BEATS_PER_BAR;
  for (let tileStart = 0; tileStart < maxBeat; tileStart += DOJO_EXCERPT_BEATS) {
    for (let beat = 0; beat < excerpt.length; beat++) {
      const absBeat = tileStart + beat;
      if (absBeat >= maxBeat) break; // beat is increasing, so every later beat is out too
      const lanes = excerpt[beat];
      if (lanes === undefined) continue;
      for (const lane of lanes) notes.push({ beat: absBeat, lane });
    }
  }
  return sortNotes(notes);
}

function buildDojoChords(bars: number): PracticePatternNote[] {
  return buildDojoExcerpt(DOJO_CHORDS_EXCERPT, bars);
}

function buildDojoScratch(bars: number): PracticePatternNote[] {
  return buildDojoExcerpt(DOJO_SCRATCH_EXCERPT, bars);
}

export const PRACTICE_PRESETS: readonly PracticePreset[] = [
  { key: 'trill', name: 'Trill (1-2 16ths)', build: buildTrill },
  { key: 'stairs', name: 'Staircase (1→7→1 16ths)', build: buildStairs },
  { key: 'chords', name: 'Chords (quarter 2-note)', build: buildChords },
  { key: 'scratch-keys', name: 'Scratch + keys', build: buildScratchKeys },
  { key: 'dojo-chords', name: 'DOJO-A CHORDS 282', build: buildDojoChords, bpm: 282 },
  { key: 'dojo-scratch', name: 'DOJO-C SCRATCH 282', build: buildDojoScratch, bpm: 282 },
];
