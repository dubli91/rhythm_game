// Player statistics aggregation (results-records.md SHOULD 11). The important
// definitions pinned here: "cleared" means ASSIST_CLEAR or better (FAILED and
// NO_PLAY are not clears), NO_PLAY buckets come from library charts without a
// record, and records for charts missing from the library still count toward
// totals (a record outlives its content).

import { describe, expect, it } from 'vitest';
import { type StatsChartRef, aggregatePlayerStats, isClearedLamp } from './stats';
import type { ChartRecord, RecordsData } from './store';
import { recordKey } from './store';

function record(overrides: Partial<ChartRecord> = {}): ChartRecord {
  return {
    songId: 'song-1',
    chartId: 'chart-n',
    clearLamp: 'CLEAR',
    lampArrangement: 'OFF',
    bestExScore: 100,
    bestRank: 'AA',
    bestExArrangement: 'OFF',
    minBP: 5,
    playCount: 3,
    lastPlayedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function dataOf(...records: ChartRecord[]): RecordsData {
  return {
    records: Object.fromEntries(records.map((r) => [recordKey(r.songId, r.chartId), r])),
  };
}

const CHARTS: StatsChartRef[] = [
  { songId: 'song-1', chartId: 'chart-n', level: 4 },
  { songId: 'song-1', chartId: 'chart-h', level: 7 },
  { songId: 'song-2', chartId: 'chart-n', level: 4 },
  { songId: 'song-2', chartId: 'chart-a', level: 11 },
];

describe('isClearedLamp', () => {
  it('counts ASSIST_CLEAR and above as cleared, FAILED/NO_PLAY as not', () => {
    expect(isClearedLamp('ASSIST_CLEAR')).toBe(true);
    expect(isClearedLamp('CLEAR')).toBe(true);
    expect(isClearedLamp('FULL_COMBO')).toBe(true);
    expect(isClearedLamp('FAILED')).toBe(false);
    expect(isClearedLamp('NO_PLAY')).toBe(false);
  });
});

describe('aggregatePlayerStats', () => {
  it('returns all-zero stats for empty records', () => {
    const stats = aggregatePlayerStats({ records: {} }, CHARTS);
    expect(stats.totalPlays).toBe(0);
    expect(stats.playedCharts).toBe(0);
    expect(stats.totalCharts).toBe(4);
    expect(stats.lampCounts.NO_PLAY).toBe(4);
    expect(stats.clearByLevel).toEqual([
      { level: 4, total: 2, cleared: 0 },
      { level: 7, total: 1, cleared: 0 },
      { level: 11, total: 1, cleared: 0 },
    ]);
  });

  it('sums playCount, buckets lamps, and counts clears per level', () => {
    const data = dataOf(
      record({ songId: 'song-1', chartId: 'chart-n', clearLamp: 'CLEAR', playCount: 3 }),
      record({ songId: 'song-1', chartId: 'chart-h', clearLamp: 'FAILED', playCount: 5 }),
      record({ songId: 'song-2', chartId: 'chart-n', clearLamp: 'FULL_COMBO', playCount: 2 }),
    );
    const stats = aggregatePlayerStats(data, CHARTS);
    expect(stats.totalPlays).toBe(10);
    expect(stats.playedCharts).toBe(3);
    expect(stats.lampCounts.CLEAR).toBe(1);
    expect(stats.lampCounts.FAILED).toBe(1);
    expect(stats.lampCounts.FULL_COMBO).toBe(1);
    expect(stats.lampCounts.NO_PLAY).toBe(1); // chart-a of song-2 never played
    expect(stats.clearByLevel).toEqual([
      { level: 4, total: 2, cleared: 2 }, // CLEAR + FULL_COMBO
      { level: 7, total: 1, cleared: 0 }, // FAILED is not a clear
      { level: 11, total: 1, cleared: 0 },
    ]);
  });

  it('counts records for charts unknown to the library in totals but not level rows', () => {
    const data = dataOf(record({ songId: 'song-gone', chartId: 'chart-x', playCount: 7 }));
    const stats = aggregatePlayerStats(data, CHARTS);
    expect(stats.totalPlays).toBe(7);
    expect(stats.playedCharts).toBe(1);
    expect(stats.lampCounts.CLEAR).toBe(1);
    expect(stats.lampCounts.NO_PLAY).toBe(4); // library charts all unplayed
    expect(stats.clearByLevel.reduce((sum, row) => sum + row.total, 0)).toBe(4);
  });

  it('levels come out ascending and only for levels that exist', () => {
    const stats = aggregatePlayerStats({ records: {} }, CHARTS);
    expect(stats.clearByLevel.map((row) => row.level)).toEqual([4, 7, 11]);
  });
});
