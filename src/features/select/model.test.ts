// Headless tests for the song-select model (specs/song-select.md MUST 1-5):
// sorting policies, single-song expansion, flat cursor over songs+difficulties,
// Enter/Escape semantics, mouse activation, and record-driven lamp sorting.

import { describe, expect, it } from 'vitest';
import type { ClearLamp } from '../play/gauge';
import type { LibraryEntry } from '../songs/library';
import {
  type ChartRecordView,
  type RecordLookup,
  SORT_MODES,
  createSelectModel,
  isSortMode,
} from './model';

function entry(overrides: Partial<LibraryEntry> & { songId: string }): LibraryEntry {
  return {
    title: overrides.songId,
    artist: 'artist',
    genre: 'GENRE',
    bpm: { min: 150, max: 150 },
    source: 'builtin',
    charts: [
      { chartId: `${overrides.songId}-n`, difficulty: 'NORMAL', level: 4, noteCount: 100 },
      { chartId: `${overrides.songId}-h`, difficulty: 'HYPER', level: 8, noteCount: 300 },
    ],
    ...overrides,
  };
}

const NO_RECORDS: RecordLookup = () => null;

function recordsFrom(map: Record<string, ClearLamp>): RecordLookup {
  return (songId, chartId): ChartRecordView | null => {
    const lamp = map[`${songId}::${chartId}`];
    return lamp === undefined ? null : { lamp, rank: 'A', exScore: 1000 };
  };
}

function songTitles(model: ReturnType<typeof createSelectModel>): string[] {
  return model
    .rows()
    .filter((r) => r.kind === 'song')
    .map((r) => r.entry.title);
}

describe('sorting (MUST 4)', () => {
  const entries = [
    entry({
      songId: 'c',
      title: 'Charlie',
      charts: [{ chartId: 'c-a', difficulty: 'ANOTHER', level: 11, noteCount: 900 }],
    }),
    entry({
      songId: 'a',
      title: 'Alpha',
      charts: [{ chartId: 'a-n', difficulty: 'NORMAL', level: 5, noteCount: 200 }],
    }),
    entry({
      songId: 'b',
      title: 'Bravo',
      charts: [{ chartId: 'b-n', difficulty: 'NORMAL', level: 2, noteCount: 80 }],
    }),
  ];

  it('title sort is alphabetical', () => {
    const model = createSelectModel({ entries, records: NO_RECORDS, sortMode: 'title' });
    expect(songTitles(model)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('level sort orders by easiest chart ascending', () => {
    const model = createSelectModel({ entries, records: NO_RECORDS, sortMode: 'level' });
    expect(songTitles(model)).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('lamp sort surfaces weakest best-lamp first, tiebreak title', () => {
    const records = recordsFrom({ 'a::a-n': 'FULL_COMBO', 'b::b-n': 'FAILED' });
    const model = createSelectModel({ entries, records, sortMode: 'lamp' });
    // Charlie NO_PLAY < Bravo FAILED < Alpha FULL_COMBO.
    expect(songTitles(model)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('lamp sort uses the BEST lamp across the charts of a song', () => {
    const two = [entry({ songId: 'a', title: 'Alpha' }), entry({ songId: 'b', title: 'Bravo' })];
    // Alpha: NORMAL failed but HYPER cleared -> best is CLEAR; Bravo: only FAILED.
    const records = recordsFrom({ 'a::a-n': 'FAILED', 'a::a-h': 'CLEAR', 'b::b-n': 'FAILED' });
    const model = createSelectModel({ entries: two, records, sortMode: 'lamp' });
    expect(songTitles(model)).toEqual(['Bravo', 'Alpha']);
  });

  it('cycleSortMode walks title -> level -> lamp -> title and setSortMode validates via isSortMode', () => {
    const model = createSelectModel({ entries, records: NO_RECORDS });
    expect(model.sortMode()).toBe('title');
    expect(model.cycleSortMode()).toBe('level');
    expect(model.cycleSortMode()).toBe('lamp');
    expect(model.cycleSortMode()).toBe('title');
    expect(SORT_MODES).toEqual(['title', 'level', 'lamp']);
    expect(isSortMode('lamp')).toBe(true);
    expect(isSortMode('bogus')).toBe(false);
  });
});

describe('expansion and cursor (MUST 2, 5)', () => {
  function threeSongs(): LibraryEntry[] {
    return [
      entry({ songId: 'a', title: 'Alpha' }),
      entry({ songId: 'b', title: 'Bravo' }),
      entry({ songId: 'c', title: 'Charlie' }),
    ];
  }

  it('starts with the first song selected and nothing expanded', () => {
    const model = createSelectModel({ entries: threeSongs(), records: NO_RECORDS });
    const rows = model.rows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'song', selected: true, expanded: false });
  });

  it('Enter on a song row expands it and selects its first chart', () => {
    const model = createSelectModel({ entries: threeSongs(), records: NO_RECORDS });
    expect(model.activate()).toBeNull();
    const rows = model.rows();
    expect(rows).toHaveLength(5); // 3 songs + 2 charts of Alpha
    expect(rows[0]).toMatchObject({ kind: 'song', expanded: true });
    expect(rows[1]).toMatchObject({ kind: 'chart', selected: true });
  });

  it('Enter on a chart row returns a play request', () => {
    const model = createSelectModel({ entries: threeSongs(), records: NO_RECORDS });
    model.activate(); // expand Alpha, cursor on NORMAL chart
    const play = model.activate();
    expect(play).not.toBeNull();
    expect(play?.entry.songId).toBe('a');
    expect(play?.chart.chartId).toBe('a-n');
    expect(model.selectedChart()?.chart.chartId).toBe('a-n');
  });

  it('expanding another song collapses the previous one', () => {
    const model = createSelectModel({ entries: threeSongs(), records: NO_RECORDS });
    model.activate(); // expand Alpha
    model.moveCursor(3); // Alpha, a-n(selected)->a-h->Bravo... land on Bravo? verify by rows
    // Cursor should now be on a song row; activate expands it.
    const before = model.rows().filter((r) => r.kind === 'song' && r.expanded);
    expect(before).toHaveLength(1);
    // Move to Bravo song row explicitly: find its index and activate via mouse path.
    const bravoIndex = model.rows().findIndex((r) => r.kind === 'song' && r.entry.songId === 'b');
    model.activateRowAt(bravoIndex);
    const expanded = model.rows().filter((r) => r.kind === 'song' && r.expanded);
    expect(expanded).toHaveLength(1);
    expect((expanded[0] as { entry: LibraryEntry }).entry.songId).toBe('b');
  });

  it('cursor wraps at both ends over visible rows', () => {
    const model = createSelectModel({ entries: threeSongs(), records: NO_RECORDS });
    model.moveCursor(-1);
    let rows = model.rows();
    expect(rows[rows.length - 1]).toMatchObject({ selected: true });
    model.moveCursor(1);
    rows = model.rows();
    expect(rows[0]).toMatchObject({ selected: true });
  });

  it('Escape collapses the expanded song and re-selects its song row', () => {
    const model = createSelectModel({ entries: threeSongs(), records: NO_RECORDS });
    model.activate(); // expand Alpha
    model.moveCursor(1); // onto HYPER chart
    expect(model.collapse()).toBe(true);
    const rows = model.rows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'song', selected: true, expanded: false });
    expect(model.collapse()).toBe(false); // nothing left to collapse
  });

  it('Enter on an already-expanded song row collapses it', () => {
    const model = createSelectModel({ entries: threeSongs(), records: NO_RECORDS });
    model.activate(); // expand, cursor on first chart
    model.moveCursor(-1); // back onto Alpha song row
    expect(model.activate()).toBeNull(); // toggles collapsed
    expect(model.rows()).toHaveLength(3);
  });
});

describe('mouse activation', () => {
  const entries = [entry({ songId: 'a', title: 'Alpha' }), entry({ songId: 'b', title: 'Bravo' })];

  it('clicking a song row toggles expansion; clicking a chart row selects then confirms', () => {
    const model = createSelectModel({ entries, records: NO_RECORDS });
    expect(model.activateRowAt(1)).toBeNull(); // expand Bravo
    const chartIndex = model.rows().findIndex((r) => r.kind === 'chart');
    // First chart is auto-selected by expansion, so a click on it confirms play;
    // a click on the OTHER chart selects it first, then a second click confirms.
    const otherChart = chartIndex + 1;
    expect(model.activateRowAt(otherChart)).toBeNull(); // select only
    const play = model.activateRowAt(otherChart); // confirm
    expect(play?.chart.chartId).toBe('b-h');
  });

  it('activateRowAt out of range is a no-op', () => {
    const model = createSelectModel({ entries, records: NO_RECORDS });
    expect(model.activateRowAt(99)).toBeNull();
    expect(model.rows()[0]).toMatchObject({ selected: true });
  });
});

describe('records and catalog refresh', () => {
  it('chart rows carry the live record view (lamps refresh after plays)', () => {
    let lamp: ClearLamp | null = null;
    const records: RecordLookup = (_songId, chartId) =>
      lamp === null || chartId !== 'a-n' ? null : { lamp, rank: 'AA', exScore: 1234 };
    const model = createSelectModel({ entries: [entry({ songId: 'a' })], records });
    model.activate(); // expand
    let chartRow = model.rows().find((r) => r.kind === 'chart' && r.chart.chartId === 'a-n');
    expect(chartRow).toMatchObject({ record: null });
    lamp = 'CLEAR'; // simulates the store updating after a play
    chartRow = model.rows().find((r) => r.kind === 'chart' && r.chart.chartId === 'a-n');
    expect(chartRow).toMatchObject({ record: { lamp: 'CLEAR', rank: 'AA', exScore: 1234 } });
  });

  it('setEntries preserves the selection when the song survives, resets otherwise', () => {
    const a = entry({ songId: 'a', title: 'Alpha' });
    const b = entry({ songId: 'b', title: 'Bravo' });
    const model = createSelectModel({ entries: [a, b], records: NO_RECORDS });
    model.moveCursor(1); // select Bravo
    model.setEntries([a, b, entry({ songId: 'c', title: 'Charlie' })]);
    const selected = model.rows().find((r) => r.selected);
    expect(selected?.entry.songId).toBe('b');
    model.setEntries([a]); // Bravo gone -> reset to first row
    const reset = model.rows().find((r) => r.selected);
    expect(reset?.entry.songId).toBe('a');
  });

  it('handles an empty library without crashing', () => {
    const model = createSelectModel({ entries: [], records: NO_RECORDS });
    expect(model.rows()).toEqual([]);
    model.moveCursor(1);
    expect(model.activate()).toBeNull();
    expect(model.collapse()).toBe(false);
    expect(model.selectedChart()).toBeNull();
  });
});
