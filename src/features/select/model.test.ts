// Headless tests for the song-select model (specs/song-select.md MUST 1-5, SHOULD 11/13):
// sorting policies, single-song expansion, flat cursor over songs+difficulties,
// Enter/Escape semantics, mouse activation, record-driven lamp sorting, the
// title/artist search filter, and the level-folder view.

import { describe, expect, it } from 'vitest';
import type { ClearLamp } from '../play/gauge';
import type { LibraryEntry } from '../songs/library';
import {
  type ChartRecordView,
  type RecordLookup,
  SORT_MODES,
  VIEW_MODES,
  createSelectModel,
  isSortMode,
  isViewMode,
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
    expect(model.rows().find((r) => r.selected)).toMatchObject({ entry: { songId: 'b' } });
    model.setEntries([a]); // Bravo gone -> reset to first row
    expect(model.rows().find((r) => r.selected)).toMatchObject({ entry: { songId: 'a' } });
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

describe('search filter (SHOULD 11)', () => {
  function catalog(): LibraryEntry[] {
    return [
      entry({ songId: 'fl', title: 'First Light', artist: 'Prism Unit' }),
      entry({ songId: 'nc', title: 'Neon Cascade', artist: 'Aurora Vector' }),
      entry({ songId: 'oc', title: 'Overdrive Core', artist: 'Redline Theory' }),
    ];
  }

  it('matches a case-insensitive partial title', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    model.setFilter('NEON');
    expect(songTitles(model)).toEqual(['Neon Cascade']);
    expect(model.filterText()).toBe('neon');
  });

  it('matches on artist as well as title', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    model.setFilter('redline');
    expect(songTitles(model)).toEqual(['Overdrive Core']);
  });

  it('whitespace-only input means no filter', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    model.setFilter('   ');
    expect(model.filterText()).toBe('');
    expect(songTitles(model)).toHaveLength(3);
  });

  it('a zero-match filter empties the list without crashing, and clearing restores it', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    model.setFilter('zzz');
    expect(model.rows()).toEqual([]);
    model.moveCursor(1);
    expect(model.activate()).toBeNull();
    model.setFilter('');
    expect(songTitles(model)).toHaveLength(3);
    expect(model.rows()[0]).toMatchObject({ selected: true });
  });

  it('selection survives when it still matches, re-anchors to the top when filtered out', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    model.moveCursor(1); // Neon Cascade
    model.setFilter('cascade');
    expect(model.rows().find((r) => r.selected)).toMatchObject({ entry: { songId: 'nc' } });
    model.setFilter('first');
    expect(model.rows().find((r) => r.selected)).toMatchObject({ entry: { songId: 'fl' } });
  });

  it('filteredCounts reports matching songs and their charts', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    expect(model.filteredCounts()).toEqual({ songs: 3, charts: 6 });
    model.setFilter('neon');
    expect(model.filteredCounts()).toEqual({ songs: 1, charts: 2 });
  });
});

describe('level folder view (SHOULD 13)', () => {
  // Levels: Alpha N4/H8, Bravo N4/H9, Charlie A11 — folders 4 (2), 8 (1), 9 (1), 11 (1).
  function catalog(): LibraryEntry[] {
    return [
      entry({
        songId: 'b',
        title: 'Bravo',
        charts: [
          { chartId: 'b-n', difficulty: 'NORMAL', level: 4, noteCount: 90 },
          { chartId: 'b-h', difficulty: 'HYPER', level: 9, noteCount: 400 },
        ],
      }),
      entry({ songId: 'a', title: 'Alpha' }),
      entry({
        songId: 'c',
        title: 'Charlie',
        charts: [{ chartId: 'c-a', difficulty: 'ANOTHER', level: 11, noteCount: 900 }],
      }),
    ];
  }

  it('VIEW_MODES/isViewMode expose the two views', () => {
    expect(VIEW_MODES).toEqual(['song', 'level']);
    expect(isViewMode('level')).toBe(true);
    expect(isViewMode('bogus')).toBe(false);
  });

  it('shows one folder per populated level, ascending, with chart counts', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    expect(model.toggleViewMode()).toBe('level');
    const rows = model.rows();
    expect(rows.map((r) => (r.kind === 'folder' ? [r.level, r.chartCount] : r.kind))).toEqual([
      [4, 2],
      [8, 1],
      [9, 1],
      [11, 1],
    ]);
    expect(rows[0]).toMatchObject({ kind: 'folder', selected: true, expanded: false });
  });

  it('expanding a folder lists only that level, title-ordered, and Enter on a chart plays', () => {
    const model = createSelectModel({
      entries: catalog(),
      records: NO_RECORDS,
      viewMode: 'level',
    });
    expect(model.activate()).toBeNull(); // expand LEVEL 4, cursor on first chart
    const rows = model.rows();
    expect(rows).toHaveLength(6); // 4 folders + 2 charts of level 4
    expect(rows[1]).toMatchObject({
      kind: 'chart',
      selected: true,
      entry: { title: 'Alpha' },
      chart: { level: 4 },
    });
    expect(rows[2]).toMatchObject({ kind: 'chart', entry: { title: 'Bravo' } });
    const play = model.activate();
    expect(play?.chart.chartId).toBe('a-n');
  });

  it('expanding another folder collapses the previous one; Escape collapses too', () => {
    const model = createSelectModel({
      entries: catalog(),
      records: NO_RECORDS,
      viewMode: 'level',
    });
    model.activate(); // expand LEVEL 4
    const folder11 = model.rows().findIndex((r) => r.kind === 'folder' && r.level === 11);
    model.activateRowAt(folder11);
    const expanded = model.rows().filter((r) => r.kind === 'folder' && r.expanded);
    expect(expanded).toMatchObject([{ level: 11 }]);
    expect(model.collapse()).toBe(true);
    expect(model.rows().filter((r) => r.kind === 'chart')).toHaveLength(0);
    expect(model.rows().find((r) => r.selected)).toMatchObject({ kind: 'folder', level: 11 });
    expect(model.collapse()).toBe(false);
  });

  it('cursor wraps over folder and chart rows uniformly', () => {
    const model = createSelectModel({
      entries: catalog(),
      records: NO_RECORDS,
      viewMode: 'level',
    });
    model.moveCursor(-1);
    const rows = model.rows();
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'folder', level: 11, selected: true });
  });

  it('a selected chart carries across view toggles with its container auto-expanded', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    model.activate(); // song view: expand Alpha, cursor on a-n (level 4)
    expect(model.toggleViewMode()).toBe('level');
    let rows = model.rows();
    expect(rows.find((r) => r.selected)).toMatchObject({
      kind: 'chart',
      chart: { chartId: 'a-n' },
    });
    expect(rows.find((r) => r.kind === 'folder' && r.level === 4)).toMatchObject({
      expanded: true,
    });
    expect(model.toggleViewMode()).toBe('song');
    rows = model.rows();
    expect(rows.find((r) => r.selected)).toMatchObject({
      kind: 'chart',
      chart: { chartId: 'a-n' },
    });
    expect(rows.find((r) => r.kind === 'song' && r.entry.songId === 'a')).toMatchObject({
      expanded: true,
    });
  });

  it('toggling views with a non-chart selection re-anchors to the top of the new view', () => {
    const model = createSelectModel({ entries: catalog(), records: NO_RECORDS });
    model.moveCursor(1); // a song row
    model.toggleViewMode();
    expect(model.rows()[0]).toMatchObject({ kind: 'folder', level: 4, selected: true });
  });

  it('the search filter shrinks folders and drops emptied ones', () => {
    const model = createSelectModel({
      entries: catalog(),
      records: NO_RECORDS,
      viewMode: 'level',
    });
    model.setFilter('bravo');
    const rows = model.rows();
    expect(rows.map((r) => (r.kind === 'folder' ? [r.level, r.chartCount] : r.kind))).toEqual([
      [4, 1],
      [9, 1],
    ]);
  });

  it('selectedChart works on level-view chart rows', () => {
    const model = createSelectModel({
      entries: catalog(),
      records: NO_RECORDS,
      viewMode: 'level',
    });
    expect(model.selectedChart()).toBeNull(); // folder row selected
    model.activate();
    expect(model.selectedChart()?.chart.chartId).toBe('a-n');
  });
});
