// Song-select screen model (specs/song-select.md MUST 1-5): pure list/cursor logic with
// no DOM so sorting, expansion, and keyboard navigation are unit-testable headless —
// the same logic/render split the play engines use (judgement-scoring.md dependency note).
//
// Shape: the list shows one row per song; the single "expanded" song additionally shows
// one row per difficulty chart beneath it (MUST 2). A flat cursor moves over all visible
// rows (MUST 5: arrows move between songs AND difficulties), Enter on a song row toggles
// expansion, Enter on a chart row confirms play, Escape collapses back to the song row.

import { CLEAR_LAMP_ORDER, type ClearLamp } from '../play/gauge';
import type { DjRank } from '../play/types';
import type { LibraryChartRef, LibraryEntry } from '../songs/library';

export type SortMode = 'title' | 'level' | 'lamp';

export const SORT_MODES: readonly SortMode[] = ['title', 'level', 'lamp'];

export function isSortMode(value: unknown): value is SortMode {
  return typeof value === 'string' && (SORT_MODES as readonly string[]).includes(value);
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

export type SelectRow = SongRow | ChartRow;

export interface PlayRequest {
  entry: LibraryEntry;
  chart: LibraryChartRef;
}

export interface SelectModelOptions {
  entries: LibraryEntry[];
  records: RecordLookup;
  sortMode?: SortMode;
}

export interface SelectModel {
  rows(): SelectRow[];
  sortMode(): SortMode;
  setSortMode(mode: SortMode): void;
  cycleSortMode(): SortMode;
  /** Moves the cursor over visible rows, wrapping at both ends. */
  moveCursor(delta: number): void;
  /** Enter semantics: song row → toggle expansion (null); chart row → play request. */
  activate(): PlayRequest | null;
  /** Escape semantics: collapse the expanded song (cursor lands on its song row). False if nothing was expanded. */
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

export function createSelectModel(opts: SelectModelOptions): SelectModel {
  let entries = [...opts.entries];
  let mode: SortMode = opts.sortMode ?? 'title';
  const records = opts.records;

  // Selection is tracked by id (not row index) so it survives re-sorting: lamp-sort
  // order legitimately changes right after a play updates a record.
  let selectedSongId: string | null = null;
  let selectedChartId: string | null = null;
  let expandedSongId: string | null = null;

  function orderedEntries(): LibraryEntry[] {
    return sortEntries(entries, mode, records);
  }

  function buildRows(): SelectRow[] {
    const rows: SelectRow[] = [];
    for (const entry of orderedEntries()) {
      const expanded = entry.songId === expandedSongId;
      rows.push({
        kind: 'song',
        entry,
        expanded,
        selected: entry.songId === selectedSongId && selectedChartId === null,
      });
      if (expanded) {
        for (const chart of entry.charts) {
          rows.push({
            kind: 'chart',
            entry,
            chart,
            record: records(entry.songId, chart.chartId),
            selected: entry.songId === selectedSongId && chart.chartId === selectedChartId,
          });
        }
      }
    }
    return rows;
  }

  function selectedRowIndex(rows: SelectRow[]): number {
    return rows.findIndex((row) => row.selected);
  }

  function ensureSelection(): void {
    const rows = buildRows();
    if (rows.length === 0) {
      selectedSongId = null;
      selectedChartId = null;
      expandedSongId = null;
      return;
    }
    if (selectedRowIndex(rows) === -1) {
      const first = rows[0] as SelectRow;
      selectedSongId = first.entry.songId;
      selectedChartId = first.kind === 'chart' ? first.chart.chartId : null;
    }
  }

  function selectRow(row: SelectRow): void {
    selectedSongId = row.entry.songId;
    selectedChartId = row.kind === 'chart' ? row.chart.chartId : null;
  }

  function toggleExpand(entry: LibraryEntry): void {
    if (expandedSongId === entry.songId) {
      expandedSongId = null;
      selectedSongId = entry.songId;
      selectedChartId = null;
      return;
    }
    // Only one song expanded at a time keeps the list compact and the cursor model simple.
    expandedSongId = entry.songId;
    const firstChart = entry.charts[0];
    selectedSongId = entry.songId;
    selectedChartId = firstChart !== undefined ? firstChart.chartId : null;
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
      toggleExpand(row.entry);
      return null;
    },
    collapse(): boolean {
      if (expandedSongId === null) return false;
      const songId = expandedSongId;
      expandedSongId = null;
      selectedSongId = songId;
      selectedChartId = null;
      return true;
    },
    activateRowAt(index: number): PlayRequest | null {
      ensureSelection();
      const rows = buildRows();
      const row = rows[index];
      if (row === undefined) return null;
      if (row.kind === 'song') {
        toggleExpand(row.entry);
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
      const stillThere = entries.some((e) => e.songId === selectedSongId);
      if (!stillThere) {
        selectedSongId = null;
        selectedChartId = null;
        expandedSongId = null;
      } else if (expandedSongId !== null && !entries.some((e) => e.songId === expandedSongId)) {
        expandedSongId = null;
      }
      ensureSelection();
    },
  };
}
