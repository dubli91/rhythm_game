import { describe, expect, it } from 'vitest';
import { LANE_SCRATCH } from '../../lib/chart/types';
import type { PracticePattern, PracticePatternNote } from './pattern';
import {
  MAX_BARS,
  MAX_PATTERN_BPM,
  MIN_BARS,
  MIN_PATTERN_BPM,
  PRACTICE_PRESETS,
  cellBeats,
  cellCount,
  createEmptyPattern,
  isPracticePattern,
  notesInCell,
  setBars,
  setBpm,
  setSnap,
  sortNotes,
  toggleCell,
} from './pattern';

function withNotes(pattern: PracticePattern, notes: PracticePatternNote[]): PracticePattern {
  return { ...pattern, notes };
}

describe('createEmptyPattern', () => {
  it('applies the documented defaults', () => {
    const pattern = createEmptyPattern('p1');
    expect(pattern).toEqual({
      patternId: 'p1',
      name: 'Untitled',
      bpm: 120,
      bars: 4,
      snap: 16,
      notes: [],
      updatedAt: 0,
    });
  });

  it('accepts an explicit name', () => {
    expect(createEmptyPattern('p1', 'My Trill').name).toBe('My Trill');
  });
});

describe('cellBeats / cellCount', () => {
  it('computes cell size as 4/snap for every snap value', () => {
    expect(cellBeats(4)).toBe(1);
    expect(cellBeats(8)).toBe(0.5);
    expect(cellBeats(12)).toBeCloseTo(1 / 3, 10);
    expect(cellBeats(16)).toBe(0.25);
    expect(cellBeats(24)).toBeCloseTo(1 / 6, 10);
    expect(cellBeats(32)).toBe(0.125);
  });

  it('computes cellCount as bars * snap', () => {
    expect(cellCount(createEmptyPattern('p'))).toBe(64); // default bars 4, snap 16
    expect(cellCount(setSnap(setBars(createEmptyPattern('p'), 1), 4))).toBe(4);
    expect(cellCount(setSnap(setBars(createEmptyPattern('p'), 8), 32))).toBe(256);
  });
});

describe('toggleCell', () => {
  it('adds a note on an empty cell and removes it on a second toggle (round trip)', () => {
    const base = createEmptyPattern('p');
    const added = toggleCell(base, 1, 0);
    expect(added.notes).toEqual([{ beat: 0, lane: 1 }]);

    const removed = toggleCell(added, 1, 0);
    expect(removed.notes).toEqual([]);
  });

  it('removes an off-grid note that falls inside the toggled cell', () => {
    const base = setSnap(createEmptyPattern('p'), 8); // cellBeats = 0.5
    const withOffGrid = withNotes(base, [{ beat: 0.125, lane: 3 }]);

    const result = toggleCell(withOffGrid, 3, 0);
    expect(result.notes).toEqual([]);
  });

  it('is a no-op for an out-of-range lane or cell index', () => {
    const base = createEmptyPattern('p');
    expect(toggleCell(base, -1, 0)).toBe(base);
    expect(toggleCell(base, 8, 0)).toBe(base);
    expect(toggleCell(base, 1, -1)).toBe(base);
    expect(toggleCell(base, 1, cellCount(base))).toBe(base);
  });

  it('keeps notes sorted by beat then lane regardless of toggle order', () => {
    let pattern = createEmptyPattern('p'); // snap 16 -> cellBeats 0.25
    pattern = toggleCell(pattern, 2, 10);
    pattern = toggleCell(pattern, 1, 2);
    pattern = toggleCell(pattern, 5, 2);
    pattern = toggleCell(pattern, 7, 0);

    expect(pattern.notes).toEqual(sortNotes(pattern.notes));
    expect(pattern.notes).toEqual([
      { beat: 0, lane: 7 },
      { beat: 0.5, lane: 1 },
      { beat: 0.5, lane: 5 },
      { beat: 2.5, lane: 2 },
    ]);
  });

  it('is pure: never mutates the input pattern or its notes array', () => {
    const base = createEmptyPattern('p');
    const snapshot = JSON.parse(JSON.stringify(base));

    toggleCell(base, 1, 0);

    expect(base).toEqual(snapshot);
    expect(base.notes).toHaveLength(0);
  });
});

describe('notesInCell', () => {
  it('finds notes within the half-open [start, end) beat range for a lane', () => {
    const pattern = withNotes(createEmptyPattern('p'), [
      { beat: 0, lane: 1 },
      { beat: 0.24, lane: 1 },
      { beat: 0.25, lane: 1 }, // next cell
      { beat: 0, lane: 2 }, // different lane
    ]);
    expect(notesInCell(pattern, 1, 0)).toEqual([
      { beat: 0, lane: 1 },
      { beat: 0.24, lane: 1 },
    ]);
  });
});

describe('setBars', () => {
  it('drops notes at/after the new bar boundary and keeps in-range notes', () => {
    const base = withNotes(createEmptyPattern('p'), [
      { beat: 1, lane: 1 },
      { beat: 7.75, lane: 2 }, // in range for bars=2 (max beat 8)
      { beat: 8, lane: 3 }, // out of range for bars=2
      { beat: 15.75, lane: 4 }, // in range for bars=4 only
    ]);

    const shrunk = setBars(base, 2);
    expect(shrunk.bars).toBe(2);
    expect(shrunk.notes).toEqual([
      { beat: 1, lane: 1 },
      { beat: 7.75, lane: 2 },
    ]);
  });

  it('clamps and truncates to an integer in MIN_BARS..MAX_BARS', () => {
    const base = createEmptyPattern('p');
    expect(setBars(base, 0).bars).toBe(MIN_BARS);
    expect(setBars(base, -5).bars).toBe(MIN_BARS);
    expect(setBars(base, 100).bars).toBe(MAX_BARS);
    expect(setBars(base, 3.9).bars).toBe(3);
  });
});

describe('setBpm', () => {
  it('rounds to the nearest integer', () => {
    expect(setBpm(createEmptyPattern('p'), 150.6).bpm).toBe(151);
    expect(setBpm(createEmptyPattern('p'), 150.4).bpm).toBe(150);
  });

  it('clamps to MIN_PATTERN_BPM..MAX_PATTERN_BPM', () => {
    expect(setBpm(createEmptyPattern('p'), 59).bpm).toBe(MIN_PATTERN_BPM);
    expect(setBpm(createEmptyPattern('p'), 401).bpm).toBe(MAX_PATTERN_BPM);
  });

  it('keeps the previous bpm for non-finite input', () => {
    const base = setBpm(createEmptyPattern('p'), 140);
    expect(setBpm(base, Number.NaN).bpm).toBe(140);
    expect(setBpm(base, Number.POSITIVE_INFINITY).bpm).toBe(140);
  });
});

describe('isPracticePattern', () => {
  function validPattern(): unknown {
    return {
      patternId: 'p1',
      name: 'Trill',
      bpm: 120,
      bars: 4,
      snap: 16,
      notes: [
        { beat: 2, lane: 1 },
        { beat: 0, lane: 2 }, // deliberately unsorted
      ],
      updatedAt: 1000,
    };
  }

  it('accepts a structurally valid pattern, unsorted notes included', () => {
    expect(isPracticePattern(validPattern())).toBe(true);
  });

  it('rejects an invalid snap value', () => {
    expect(isPracticePattern({ ...(validPattern() as object), snap: 5 })).toBe(false);
  });

  it('rejects bpm below MIN_PATTERN_BPM', () => {
    expect(isPracticePattern({ ...(validPattern() as object), bpm: 59 })).toBe(false);
  });

  it('rejects bars above MAX_BARS', () => {
    expect(isPracticePattern({ ...(validPattern() as object), bars: 9 })).toBe(false);
  });

  it('rejects a note at/after bars*4 beats', () => {
    const pattern = {
      ...(validPattern() as Record<string, unknown>),
      bars: 1,
      notes: [{ beat: 4, lane: 1 }],
    };
    expect(isPracticePattern(pattern)).toBe(false);
  });

  it('rejects an out-of-range lane', () => {
    const pattern = {
      ...(validPattern() as Record<string, unknown>),
      notes: [{ beat: 0, lane: 8 }],
    };
    expect(isPracticePattern(pattern)).toBe(false);
  });

  it('rejects duplicate (beat, lane) pairs', () => {
    const pattern = {
      ...(validPattern() as Record<string, unknown>),
      notes: [
        { beat: 1, lane: 1 },
        { beat: 1, lane: 1 },
      ],
    };
    expect(isPracticePattern(pattern)).toBe(false);
  });

  it('rejects a pattern missing required fields', () => {
    const { patternId, ...rest } = validPattern() as Record<string, unknown>;
    expect(isPracticePattern(rest)).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isPracticePattern(null)).toBe(false);
    expect(isPracticePattern(undefined)).toBe(false);
  });
});

describe('PRACTICE_PRESETS', () => {
  const barsCases = [1, 4, 8];

  function asPattern(notes: PracticePatternNote[], bars: number): unknown {
    return {
      patternId: 'preset-check',
      name: 'check',
      bpm: 120,
      bars,
      snap: 16,
      notes,
      updatedAt: 0,
    };
  }

  it('covers exactly the four documented presets', () => {
    expect(PRACTICE_PRESETS.map((p) => p.key)).toEqual([
      'trill',
      'stairs',
      'chords',
      'scratch-keys',
    ]);
  });

  for (const preset of PRACTICE_PRESETS) {
    describe(preset.key, () => {
      for (const bars of barsCases) {
        it(`produces a valid, sorted, non-empty pattern for ${bars} bar(s)`, () => {
          const notes = preset.build(bars);
          expect(notes.length).toBeGreaterThan(0);
          expect(notes).toEqual(sortNotes(notes));
          expect(isPracticePattern(asPattern(notes, bars))).toBe(true);
        });
      }
    });
  }

  it('trill alternates lanes 1 and 2 starting from lane 1', () => {
    const notes = PRACTICE_PRESETS.find((p) => p.key === 'trill')?.build(1) ?? [];
    expect(notes.map((n) => n.lane)).toEqual(notes.map((_, i) => 1 + (i % 2)));
  });

  it('chords places exactly two notes on every beat', () => {
    const notes = PRACTICE_PRESETS.find((p) => p.key === 'chords')?.build(2) ?? [];
    const byBeat = new Map<number, number[]>();
    for (const note of notes) {
      const lanes = byBeat.get(note.beat) ?? [];
      lanes.push(note.lane);
      byBeat.set(note.beat, lanes);
    }
    expect(byBeat.size).toBe(2 * 4); // bars * BEATS_PER_BAR
    for (const [beat, lanes] of byBeat) {
      expect(lanes.length).toBe(2);
      expect(lanes.slice().sort()).toEqual(beat % 2 === 0 ? [1, 3] : [5, 7]);
    }
  });

  it('scratch+keys places lane 0 (scratch) at every bar start', () => {
    const bars = 3;
    const notes = PRACTICE_PRESETS.find((p) => p.key === 'scratch-keys')?.build(bars) ?? [];
    for (let bar = 0; bar < bars; bar++) {
      expect(notes).toContainEqual({ beat: bar * 4, lane: LANE_SCRATCH });
    }
  });
});
