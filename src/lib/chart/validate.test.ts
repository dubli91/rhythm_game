import { describe, expect, it } from 'vitest';
import { CHART_FORMAT_VERSION } from './types';
import type { Note } from './types';
import { ChartValidationError, loadChart, validateChart, validateSong } from './validate';

// Minimal valid chart; tests override individual fields to isolate one rule each.
function chartFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: CHART_FORMAT_VERSION,
    chartId: 'song-test-normal',
    difficulty: 'NORMAL',
    level: 5,
    total: 180,
    bpm: { init: 150, min: 150, max: 150 },
    timing: { bpmEvents: [{ beat: 0, bpm: 150 }], stopEvents: [] },
    notes: [
      { beat: 0, lane: 1, type: 'tap' },
      { beat: 1, lane: 2, type: 'tap' },
    ],
    ...overrides,
  };
}

function issuesFor(raw: unknown): string[] {
  const result = validateChart(raw);
  if (result.ok) return [];
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe('validateChart — basic schema', () => {
  it('accepts a minimal valid chart', () => {
    expect(validateChart(chartFixture()).ok).toBe(true);
  });

  it('rejects non-object roots and reports field-path errors', () => {
    expect(validateChart(null).ok).toBe(false);
    expect(validateChart([]).ok).toBe(false);
    expect(issuesFor(chartFixture({ level: 13 }))).toEqual([
      'level: level must be an integer between 1 and 12',
    ]);
  });

  it('rejects unsupported formatVersion and bad difficulty', () => {
    expect(issuesFor(chartFixture({ formatVersion: CHART_FORMAT_VERSION + 1 }))).toEqual([
      'formatVersion: unsupported formatVersion',
    ]);
    expect(issuesFor(chartFixture({ difficulty: 'EXPERT' }))[0]).toContain('difficulty');
  });

  it('rejects lane out of range and negative beat with the exact note path', () => {
    const badLane = issuesFor(chartFixture({ notes: [{ beat: 0, lane: 8, type: 'tap' }] }));
    expect(badLane).toEqual(['notes[0].lane: lane must be an integer between 0 and 7']);
    const badBeat = issuesFor(chartFixture({ notes: [{ beat: -1, lane: 1, type: 'tap' }] }));
    expect(badBeat).toEqual(['notes[0].beat: beat must be a finite number >= 0']);
  });

  it('rejects duplicate lane+beat and unsorted notes', () => {
    const dup = issuesFor(
      chartFixture({
        notes: [
          { beat: 1, lane: 1, type: 'tap' },
          { beat: 1, lane: 1, type: 'tap' },
        ],
      }),
    );
    expect(dup).toEqual(['notes[1]: duplicate note: same lane and beat as an earlier note']);

    const unsorted = issuesFor(
      chartFixture({
        notes: [
          { beat: 2, lane: 1, type: 'tap' },
          { beat: 1, lane: 2, type: 'tap' },
        ],
      }),
    );
    expect(unsorted).toEqual(['notes: notes must be sorted by beat ascending']);
  });
});

describe('validateChart — CN rules (chart-format.md SHOULD 9)', () => {
  it('accepts a cn note with endBeat > beat', () => {
    const notes: Note[] = [{ beat: 0, lane: 1, type: 'cn', endBeat: 2 }];
    expect(validateChart(chartFixture({ notes })).ok).toBe(true);
  });

  it('rejects a cn note without endBeat', () => {
    const issues = issuesFor(chartFixture({ notes: [{ beat: 0, lane: 1, type: 'cn' }] }));
    expect(issues).toEqual([
      'notes[0].endBeat: endBeat is required and must be a finite number for cn notes',
    ]);
  });

  it('rejects endBeat <= beat', () => {
    const equal = issuesFor(
      chartFixture({ notes: [{ beat: 2, lane: 1, type: 'cn', endBeat: 2 }] }),
    );
    expect(equal).toEqual(['notes[0].endBeat: endBeat must be greater than beat']);
    const before = issuesFor(
      chartFixture({ notes: [{ beat: 2, lane: 1, type: 'cn', endBeat: 1 }] }),
    );
    expect(before).toEqual(['notes[0].endBeat: endBeat must be greater than beat']);
  });

  it('rejects endBeat on a tap note', () => {
    const issues = issuesFor(
      chartFixture({ notes: [{ beat: 0, lane: 1, type: 'tap', endBeat: 2 }] }),
    );
    expect(issues).toEqual(['notes[0].endBeat: endBeat is only valid for cn notes']);
  });

  it("rejects unknown note types (only 'tap' and 'cn')", () => {
    const issues = issuesFor(chartFixture({ notes: [{ beat: 0, lane: 1, type: 'hold' }] }));
    expect(issues).toEqual(["notes[0].type: type must be 'tap' or 'cn'"]);
  });
});

describe('validateChart — CN span overlap (same lane)', () => {
  // The judge allows at most one hold per lane and a held key cannot play another
  // note; the validator must guarantee that at load time.
  it('rejects a tap strictly inside a cn span on the same lane', () => {
    const issues = issuesFor(
      chartFixture({
        notes: [
          { beat: 0, lane: 1, type: 'cn', endBeat: 4 },
          { beat: 2, lane: 1, type: 'tap' },
        ],
      }),
    );
    expect(issues).toEqual([
      'notes[1]: note overlaps an earlier cn span on the same lane (beat must be greater than that cn endBeat)',
    ]);
  });

  it('rejects a note exactly at the cn endBeat (inclusive: instant repress is unplayable)', () => {
    const issues = issuesFor(
      chartFixture({
        notes: [
          { beat: 0, lane: 1, type: 'cn', endBeat: 4 },
          { beat: 4, lane: 1, type: 'tap' },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
  });

  it('rejects a cn starting inside an earlier cn span on the same lane', () => {
    const issues = issuesFor(
      chartFixture({
        notes: [
          { beat: 0, lane: 1, type: 'cn', endBeat: 4 },
          { beat: 2, lane: 1, type: 'cn', endBeat: 8 },
        ],
      }),
    );
    expect(issues).toHaveLength(1);
  });

  it('accepts a note after the cn span, and any note on a different lane during it', () => {
    const ok = validateChart(
      chartFixture({
        notes: [
          { beat: 0, lane: 1, type: 'cn', endBeat: 4 },
          { beat: 1, lane: 2, type: 'tap' },
          { beat: 2, lane: 0, type: 'cn', endBeat: 3 },
          { beat: 4.25, lane: 1, type: 'tap' },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
  });
});

describe('validateSong', () => {
  function songFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      songId: 'song-test',
      title: 'Test Song',
      artist: 'Test Artist',
      genre: 'TEST',
      audio: { source: 'builtin', ref: 'songs/song-test/audio.wav', offsetMs: 0 },
      charts: [chartFixture()],
      ...overrides,
    };
  }

  it('accepts a valid song and rejects duplicate chartIds', () => {
    expect(validateSong(songFixture()).ok).toBe(true);
    const dup = validateSong(songFixture({ charts: [chartFixture(), chartFixture()] }));
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.issues.some((i) => i.message === 'duplicate chartId across charts')).toBe(true);
    }
  });

  it('surfaces nested chart issues under charts[i] paths', () => {
    const bad = validateSong(songFixture({ charts: [chartFixture({ level: 0 })] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues[0]?.path).toBe('charts[0].level');
    }
  });
});

describe('loadChart', () => {
  it('returns the chart on success and throws ChartValidationError with issues on failure', () => {
    const chart = loadChart(chartFixture());
    expect(chart.chartId).toBe('song-test-normal');
    expect(() => loadChart(chartFixture({ total: 0 }))).toThrow(ChartValidationError);
    try {
      loadChart(chartFixture({ total: 0 }));
    } catch (error) {
      expect((error as ChartValidationError).issues[0]?.path).toBe('total');
    }
  });

  it('throws when an older formatVersion has no registered migration', () => {
    expect(() => loadChart(chartFixture({ formatVersion: 0 }))).toThrow(/no migration registered/);
  });
});
