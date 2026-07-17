// Player statistics aggregation (specs/results-records.md SHOULD 11): total
// plays, clear-lamp distribution, and clear status by level. Pure — takes the
// records data plus the library's chart list (ChartRecord doesn't store level;
// the library is the single source of truth for chart levels), so the whole
// computation is unit-testable and the settings screen just renders the result.

import { CLEAR_LAMP_ORDER, type ClearLamp } from '../play/gauge';
import { type RecordsData, recordKey } from './store';

/** The slice of a library chart the aggregation needs. */
export interface StatsChartRef {
  songId: string;
  chartId: string;
  level: number;
}

export interface LevelClearRow {
  level: number;
  /** known library charts at this level */
  total: number;
  /** of those, charts whose lamp is ASSIST_CLEAR or better */
  cleared: number;
}

export interface PlayerStats {
  /** sum of playCount across all records (abandons included; autoplay never recorded) */
  totalPlays: number;
  /** records with at least one play */
  playedCharts: number;
  /** known library charts */
  totalCharts: number;
  /**
   * Lamp distribution over charts. Known charts without a record count as
   * NO_PLAY; records for charts missing from the library (e.g. removed
   * content) still count under their lamp — the record is real even if the
   * chart is gone.
   */
  lampCounts: Record<ClearLamp, number>;
  /** ascending by level; only levels with at least one known chart */
  clearByLevel: LevelClearRow[];
}

const CLEARED_MIN_INDEX = CLEAR_LAMP_ORDER.indexOf('ASSIST_CLEAR');

/** Any clear lamp counts as cleared (ASSIST_CLEAR and up); FAILED/NO_PLAY do not. */
export function isClearedLamp(lamp: ClearLamp): boolean {
  return CLEAR_LAMP_ORDER.indexOf(lamp) >= CLEARED_MIN_INDEX;
}

export function aggregatePlayerStats(data: RecordsData, charts: StatsChartRef[]): PlayerStats {
  const lampCounts = Object.fromEntries(CLEAR_LAMP_ORDER.map((lamp) => [lamp, 0])) as Record<
    ClearLamp,
    number
  >;

  let totalPlays = 0;
  let playedCharts = 0;
  for (const record of Object.values(data.records)) {
    totalPlays += record.playCount;
    if (record.playCount > 0) playedCharts++;
    lampCounts[record.clearLamp]++;
  }

  const byLevel = new Map<number, LevelClearRow>();
  for (const chart of charts) {
    const record = data.records[recordKey(chart.songId, chart.chartId)];
    if (record === undefined) {
      // Known chart, never played: it belongs to the NO_PLAY bucket.
      lampCounts.NO_PLAY++;
    }
    let row = byLevel.get(chart.level);
    if (row === undefined) {
      row = { level: chart.level, total: 0, cleared: 0 };
      byLevel.set(chart.level, row);
    }
    row.total++;
    if (record !== undefined && isClearedLamp(record.clearLamp)) row.cleared++;
  }

  return {
    totalPlays,
    playedCharts,
    totalCharts: charts.length,
    lampCounts,
    clearByLevel: [...byLevel.values()].sort((a, b) => a.level - b.level),
  };
}
