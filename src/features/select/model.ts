// Song-select screen model (specs/song-select.md MUST 1-5, SHOULD 11/13): pure list/cursor
// logic with no DOM so sorting, expansion, filtering, and keyboard navigation are
// unit-testable headless — the same logic/render split the play engines use
// (judgement-scoring.md dependency note).
//
// Shape: two view modes over one flat cursor. SONG view shows one row per song; the single
// "expanded" song additionally shows one row per difficulty chart beneath it (MUST 2).
// LEVEL view (SHOULD 13) shows one folder row per level (1-12) that has charts; the single
// expanded folder shows its charts (title order) beneath it. A flat cursor moves over all
// visible rows (MUST 5: arrows move between rows uniformly), Enter on a song/folder row
// toggles expansion, Enter on a chart row confirms play, Escape collapses.
//
// The search filter (SHOULD 11: case-insensitive partial match on title OR artist) applies
// before row building in BOTH views, so folders shrink/disappear along with song rows. The
// filter is deliberately session-only — persisting it would silently hide songs on the next
// boot with no visible cause.

import { CLEAR_LAMP_ORDER, type ClearLamp } from '../play/gauge';
import type { DjRank } from '../play/types';
import type { LibraryChartRef, LibraryEntry } from '../songs/library';

export type SortMode = 'title' | 'level' | 'lamp';

export const SORT_MODES: readonly SortMode[] = ['title', 'level', 'lamp'];

export function isSortMode(value: unknown): value is SortMode {
  return typeof value === 'string' && (SORT_MODES as readonly string[]).includes(value);
}

/**
 * SONG = one row per song, expandable to its charts; LEVEL = one folder per level,
 * expandable to the charts of that level (song-select.md SHOULD 13). Sort modes apply
 * to the SONG view only — the LEVEL view is fixed level-ascending, title-within-folder.
 */
export type ViewMode = 'song' | 'level';

export const VIEW_MODES: readonly ViewMode[] = ['song', 'level'];

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

/** Best-record surface a chart row displays (song-select.md MUST 3). */
export interface ChartRecordView {
  lamp: ClearLamp;
  rank: DjRank | null;
  exScore: number | null;
}

/**
 * Live lookup into the records store; queried at rows() time so lamps refresh
 * automatically when the player returns from a play (acceptance criterion 3).
 */
export type RecordLookup = (songId: string, chartId: string) => ChartRecordView | null;

export interface SongRow {
  kind: 'song';
  entry: LibraryEntry;
  expanded: boolean;
  selected: boolean;
}

export interface ChartRow {
  kind: 'chart';
  entry: LibraryEntry;
  chart: LibraryChartRef;
  record: ChartRecordView | null;
  selected: boolean;
}

/** Level-folder header row (LEVEL view only). Carries no entry — nothing to preview. */
export interface FolderRow {
  kind: 'folder';
  level: number;
  chartCount: number;
  expanded: boolean;
  selected: boolean;
}

export type SelectRow = SongRow | ChartRow | FolderRow;

export interface PlayRequest {
  entry: LibraryEntry;
  chart: LibraryChartRef;
}

export interface SelectModelOptions {
  entries: LibraryEntry[];
  records: RecordLookup;
  sortMode?: SortMode;
  viewMode?: ViewMode;
}

export interface SelectModel {
  rows(): SelectRow[];
  sortMode(): SortMode;
  setSortMode(mode: SortMode): void;
  cycleSortMode(): SortMode;
  viewMode(): ViewMode;
  setViewMode(mode: ViewMode): void;
  toggleViewMode(): ViewMode;
  /** Normalized (trimmed, lowercased) active search query; '' when inactive. */
  filterText(): string;
  /** Sets the search filter (SHOULD 11); matching is case-insensitive on title/artist. */
  setFilter(text: string): void;
  /** Songs (and their charts) passing the current filter, for the "n matches" readout. */
  filteredCounts(): { songs: number; charts: number };
  /** Moves the cursor over visible rows, wrapping at both ends. */
  moveCursor(delta: number): void;
  /** Enter semantics: song/folder row → toggle expansion (null); chart row → play request. */
  activate(): PlayRequest | null;
  /** Escape semantics: collapse the expanded song/folder (cursor lands on its header row). False if nothing was expanded. */
  collapse(): boolean;
  /** Mouse semantics for the visible row at `index`: selects it; a chart row that was already selected confirms play. */
  activateRowAt(index: number): PlayRequest | null;
  /** Current selection when it is a chart row, else null. */
  selectedChart(): PlayRequest | null;
  /** Replaces the catalog (e.g. after re-loading the library), preserving selection when possible. */
  setEntries(entries: LibraryEntry[]): void;
}

function lampIndex(lamp: ClearLamp): number {
  return CLEAR_LAMP_ORDER.indexOf(lamp);
}

/** Best (highest) lamp across a song's charts; NO_PLAY when nothing is recorded. */
function bestLampIndex(entry: LibraryEntry, records: RecordLookup): number {
  let best = lampIndex('NO_PLAY');
  for (const chart of entry.charts) {
    const record = records(entry.songId, chart.chartId);
    if (record !== null) best = Math.max(best, lampIndex(record.lamp));
  }
  return best;
}

function minLevel(entry: LibraryEntry): number {
  return entry.charts.reduce((min, c) => Math.min(min, c.level), Number.POSITIVE_INFINITY);
}

function byTitle(a: LibraryEntry, b: LibraryEntry): number {
  return (
    a.title.localeCompare(b.title) ||
    a.artist.localeCompare(b.artist) ||
    a.songId.localeCompare(b.songId)
  );
}

/**
 * Sort policies (song-select.md MUST 4 names the three criteria; concrete ordering is
 * our decision, recorded here): title = alphabetical; level = easiest chart ascending
 * (tiebreak title); lamp = weakest best-lamp first (unplayed/uncleared songs surface at
 * the top — the ordering a player grinding for lamps wants), tiebreak title.
 */
function sortEntries(
  entries: readonly LibraryEntry[],
  mode: SortMode,
  records: RecordLookup,
): LibraryEntry[] {
  const sorted = [...entries];
  switch (mode) {
    case 'title':
      sorted.sort(byTitle);
      break;
    case 'level':
      sorted.sort((a, b) => minLevel(a) - minLevel(b) || byTitle(a, b));
      break;
    case 'lamp':
      sorted.sort((a, b) => bestLampIndex(a, records) - bestLampIndex(b, records) || byTitle(a, b));
      break;
  }
  return sorted;
}

/** One chart plus its owning entry — the unit the LEVEL view groups and lists. */
interface ChartAt {
  entry: LibraryEntry;
  chart: LibraryChartRef;
}

// Selection is tracked by identity (not row index) so it survives re-sorting and
// re-filtering: lamp-sort order legitimately changes right after a play updates a
// record, and typing in the search box reshapes the list every keystroke.
type Selection =
  | { kind: 'song'; songId: string }
  | { kind: 'chart'; songId: string; chartId: string }
  | { kind: 'folder'; level: number }
  | null;

export function createSelectModel(opts: SelectModelOptions): SelectModel {
  let entries = [...opts.entries];
  let mode: SortMode = opts.sortMode ?? 'title';
  let view: ViewMode = opts.viewMode ?? 'song';
  let query = '';
  const records = opts.records;

  let selection: Selection = null;
  // Expansion state is kept per view (toggling views does not forget the other
  // view's open song/folder); empty folders simply stop rendering, so a stale
  // expandedLevel is harmless.
  let expandedSongId: string | null = null;
  let expandedLevel: number | null = null;

  function matchesFilter(entry: LibraryEntry): boolean {
    if (query === '') return true;
    return entry.title.toLowerCase().includes(query) || entry.artist.toLowerCase().includes(query);
  }

  function filteredEntries(): LibraryEntry[] {
    return entries.filter(matchesFilter);
  }

  /** Charts of the filtered catalog grouped by level, folder-internal order applied. */
  function chartsByLevel(): Map<number, ChartAt[]> {
    const byLevel = new Map<number, ChartAt[]>();
    for (const entry of filteredEntries()) {
      for (const chart of entry.charts) {
        const bucket = byLevel.get(chart.level);
        if (bucket === undefined) byLevel.set(chart.level, [{ entry, chart }]);
        else bucket.push({ entry, chart });
      }
    }
    for (const bucket of byLevel.values()) {
      bucket.sort(
        (a, b) => byTitle(a.entry, b.entry) || a.chart.chartId.localeCompare(b.chart.chartId),
      );
    }
    return byLevel;
  }

  function buildRows(): SelectRow[] {
    const rows: SelectRow[] = [];
    if (view === 'song') {
      for (const entry of sortEntries(filteredEntries(), mode, records)) {
        const expanded = entry.songId === expandedSongId;
        rows.push({
          kind: 'song',
          entry,
          expanded,
          selected: selection?.kind === 'song' && selection.songId === entry.songId,
        });
        if (expanded) {
          for (const chart of entry.charts) rows.push(chartRow(entry, chart));
        }
      }
      return rows;
    }
    const byLevel = chartsByLevel();
    for (const level of [...byLevel.keys()].sort((a, b) => a - b)) {
      const charts = byLevel.get(level) as ChartAt[];
      const expanded = level === expandedLevel;
      rows.push({
        kind: 'folder',
        level,
        chartCount: charts.length,
        expanded,
        selected: selection?.kind === 'folder' && selection.level === level,
      });
      if (expanded) {
        for (const { entry, chart } of charts) rows.push(chartRow(entry, chart));
      }
    }
    return rows;
  }

  function chartRow(entry: LibraryEntry, chart: LibraryChartRef): ChartRow {
    return {
      kind: 'chart',
      entry,
      chart,
      record: records(entry.songId, chart.chartId),
      selected:
        selection?.kind === 'chart' &&
        selection.songId === entry.songId &&
        selection.chartId === chart.chartId,
    };
  }

  function selectedRowIndex(rows: SelectRow[]): number {
    return rows.findIndex((row) => row.selected);
  }

  function ensureSelection(): void {
    const rows = buildRows();
    if (rows.length === 0) {
      selection = null;
      expandedSongId = null;
      expandedLevel = null;
      return;
    }
    if (selectedRowIndex(rows) === -1) selectRow(rows[0] as SelectRow);
  }

  function selectRow(row: SelectRow): void {
    selection =
      row.kind === 'folder'
        ? { kind: 'folder', level: row.level }
        : row.kind === 'song'
          ? { kind: 'song', songId: row.entry.songId }
          : { kind: 'chart', songId: row.entry.songId, chartId: row.chart.chartId };
  }

  function toggleExpandSong(entry: LibraryEntry): void {
    if (expandedSongId === entry.songId) {
      expandedSongId = null;
      selection = { kind: 'song', songId: entry.songId };
      return;
    }
    // Only one song expanded at a time keeps the list compact and the cursor model simple.
    expandedSongId = entry.songId;
    const firstChart = entry.charts[0];
    selection =
      firstChart !== undefined
        ? { kind: 'chart', songId: entry.songId, chartId: firstChart.chartId }
        : { kind: 'song', songId: entry.songId };
  }

  function toggleExpandFolder(level: number): void {
    if (expandedLevel === level) {
      expandedLevel = null;
      selection = { kind: 'folder', level };
      return;
    }
    // Mirrors the single-expanded-song rule.
    expandedLevel = level;
    const first = chartsByLevel().get(level)?.[0];
    selection =
      first !== undefined
        ? { kind: 'chart', songId: first.entry.songId, chartId: first.chart.chartId }
        : { kind: 'folder', level };
  }

  function levelOfSelectedChart(): number | null {
    if (selection?.kind !== 'chart') return null;
    const sel = selection;
    const entry = entries.find((e) => e.songId === sel.songId);
    const chart = entry?.charts.find((c) => c.chartId === sel.chartId);
    return chart?.level ?? null;
  }

  function applyViewMode(next: ViewMode): void {
    if (next === view) return;
    view = next;
    // A selected chart carries across the toggle (its container auto-expands so the
    // row is visible); any other selection re-anchors to the top of the new view.
    if (selection?.kind === 'chart') {
      if (view === 'level') expandedLevel = levelOfSelectedChart();
      else expandedSongId = selection.songId;
    } else {
      selection = null;
    }
  }

  ensureSelection();

  return {
    rows(): SelectRow[] {
      ensureSelection();
      return buildRows();
    },
    sortMode(): SortMode {
      return mode;
    },
    setSortMode(next: SortMode): void {
      mode = next;
    },
    cycleSortMode(): SortMode {
      const next = SORT_MODES[(SORT_MODES.indexOf(mode) + 1) % SORT_MODES.length] as SortMode;
      mode = next;
      return next;
    },
    viewMode(): ViewMode {
      return view;
    },
    setViewMode(next: ViewMode): void {
      applyViewMode(next);
    },
    toggleViewMode(): ViewMode {
      applyViewMode(view === 'song' ? 'level' : 'song');
      return view;
    },
    filterText(): string {
      return query;
    },
    setFilter(text: string): void {
      query = text.trim().toLowerCase();
      // Selection re-anchoring (if the selected row got filtered out) happens in
      // ensureSelection on the next read — no state to fix eagerly here.
    },
    filteredCounts(): { songs: number; charts: number } {
      const matched = filteredEntries();
      return {
        songs: matched.length,
        charts: matched.reduce((sum, e) => sum + e.charts.length, 0),
      };
    },
    moveCursor(delta: number): void {
      ensureSelection();
      const rows = buildRows();
      if (rows.length === 0) return;
      const index = selectedRowIndex(rows);
      const next =
        ((((index === -1 ? 0 : index) + delta) % rows.length) + rows.length) % rows.length;
      selectRow(rows[next] as SelectRow);
    },
    activate(): PlayRequest | null {
      ensureSelection();
      const rows = buildRows();
      const row = rows[selectedRowIndex(rows)];
      if (row === undefined) return null;
      if (row.kind === 'chart') return { entry: row.entry, chart: row.chart };
      if (row.kind === 'song') toggleExpandSong(row.entry);
      else toggleExpandFolder(row.level);
      return null;
    },
    collapse(): boolean {
      if (view === 'song') {
        if (expandedSongId === null) return false;
        selection = { kind: 'song', songId: expandedSongId };
        expandedSongId = null;
        return true;
      }
      if (expandedLevel === null) return false;
      selection = { kind: 'folder', level: expandedLevel };
      expandedLevel = null;
      return true;
    },
    activateRowAt(index: number): PlayRequest | null {
      ensureSelection();
      const rows = buildRows();
      const row = rows[index];
      if (row === undefined) return null;
      if (row.kind === 'song') {
        toggleExpandSong(row.entry);
        return null;
      }
      if (row.kind === 'folder') {
        toggleExpandFolder(row.level);
        return null;
      }
      // Click a chart row once to select it, again to start play — keeps a stray
      // single click from launching a song while still allowing mouse-only flow.
      if (row.selected) return { entry: row.entry, chart: row.chart };
      selectRow(row);
      return null;
    },
    selectedChart(): PlayRequest | null {
      ensureSelection();
      const rows = buildRows();
      const row = rows[selectedRowIndex(rows)];
      if (row === undefined || row.kind !== 'chart') return null;
      return { entry: row.entry, chart: row.chart };
    },
    setEntries(next: LibraryEntry[]): void {
      entries = [...next];
      const survives = (songId: string): boolean => entries.some((e) => e.songId === songId);
      if (
        (selection?.kind === 'song' || selection?.kind === 'chart') &&
        !survives(selection.songId)
      ) {
        selection = null;
      }
      if (expandedSongId !== null && !survives(expandedSongId)) expandedSongId = null;
      // Folder selection/expansion self-heals: a level with no charts simply stops
      // rendering, and ensureSelection re-anchors if the selected row vanished.
      ensureSelection();
    },
  };
}
