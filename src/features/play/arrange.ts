// Arrangement (RANDOM/MIRROR) lane substitution (specs/play-options.md MUST 9-10).
//
// A pure, pre-play transform: key lanes 1..7 of the chart's notes are remapped and
// nothing else changes — beats/types/order stay identical and the scratch lane (0)
// is never moved. Because the substituted chart is what judge, renderer, and
// autoplay all consume, judgement/gauge aggregation is provably identical to the
// original chart (only the column each note appears in differs).

import type { Chart } from '../../lib/chart/types';
import { createSeededRng, randomPermutation } from '../../lib/rng/seeded';
import type { Arrangement } from './types';

/**
 * Lane map for an arrangement: index = original lane (0..7), value = displayed lane.
 * RANDOM derives a reproducible permutation of lanes 1..7 from `seed`; the caller
 * re-rolls the seed per play attempt (retries included — decision recorded in
 * IMPLEMENTATION_PLAN.md).
 */
export function laneMapFor(arrangement: Arrangement, seed: number): readonly number[] {
  const map = [0, 1, 2, 3, 4, 5, 6, 7];
  if (arrangement === 'MIRROR') {
    for (let lane = 1; lane <= 7; lane++) map[lane] = 8 - lane;
  } else if (arrangement === 'RANDOM') {
    const perm = randomPermutation(createSeededRng(seed), 7);
    for (let lane = 1; lane <= 7; lane++) map[lane] = (perm[lane - 1] ?? lane - 1) + 1;
  }
  return map;
}

/** Chart with note lanes substituted; OFF returns the input chart untouched. */
export function applyArrangement(chart: Chart, arrangement: Arrangement, seed: number): Chart {
  if (arrangement === 'OFF') return chart;
  const map = laneMapFor(arrangement, seed);
  return {
    ...chart,
    notes: chart.notes.map((note) => ({ ...note, lane: map[note.lane] ?? note.lane })),
  };
}
