// Internal chart format (specs/chart-format.md).
// This is the single source of truth for note/timing data: gameplay, rendering,
// judgement, and practice mode all consume these types.

export const CHART_FORMAT_VERSION = 1;

export const LANE_SCRATCH = 0;
export const KEY_LANE_MIN = 1;
export const KEY_LANE_MAX = 7;
export const LANE_COUNT = 8;

export type Difficulty = 'BEGINNER' | 'NORMAL' | 'HYPER' | 'ANOTHER';

export const DIFFICULTIES: readonly Difficulty[] = ['BEGINNER', 'NORMAL', 'HYPER', 'ANOTHER'];

export type NoteType = 'tap' | 'cn';

/** Note position is a fractional beat; bars/snap divisions are an editor concern only. */
export interface Note {
  beat: number;
  /** 0 = scratch, 1..7 = keys */
  lane: number;
  type: NoteType;
  /** CN (charge note) only; must be > beat when present. */
  endBeat?: number;
}

/** First event must sit at beat 0 and carries the initial BPM. */
export interface BpmEvent {
  beat: number;
  bpm: number;
}

/** Scroll/time freeze: time advances by durationBeats at the BPM in effect at `beat`. */
export interface StopEvent {
  beat: number;
  durationBeats: number;
}

export interface ChartTiming {
  bpmEvents: BpmEvent[];
  stopEvents: StopEvent[];
}

export interface Chart {
  formatVersion: number;
  chartId: string;
  difficulty: Difficulty;
  /** Displayed level, 1..12 */
  level: number;
  /** Gauge recovery pool (BMS #TOTAL heritage); R = total / noteCount (gauge-clear.md). */
  total: number;
  bpm: { init: number; min: number; max: number };
  timing: ChartTiming;
  notes: Note[];
}

export interface SongAudio {
  source: 'builtin';
  /** URL under public/songs/ (the practice song's ref points at its keysound sample). */
  ref: string;
  /** Per-song audio offset in ms, added when converting audio time to song time. */
  offsetMs: number;
}

export interface Song {
  songId: string;
  title: string;
  artist: string;
  genre: string;
  audio: SongAudio;
  charts: Chart[];
}

/** Total note count; a CN counts as 1 note (decision recorded in IMPLEMENTATION_PLAN.md). */
export function noteCount(chart: Chart): number {
  return chart.notes.length;
}
