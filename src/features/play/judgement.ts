// Judgement engine (specs/judgement-scoring.md).
// Headless: evaluates input timing against chart notes and yields JudgementEvent
// records for downstream gauge/scoring/HUD consumers. No DOM, no rendering.

import type { JudgementEvent, JudgementGrade } from './types';

export interface JudgementWindowsMs {
  pgreat: number;
  great: number;
  good: number;
  bad: number;
}

// Default IIDX-style windows in ms. Tunable: pass a custom JudgementWindowsMs
// to createJudge() to override. Boundaries are inclusive (see gradeForDelta).
export const DEFAULT_JUDGEMENT_WINDOWS_MS: JudgementWindowsMs = {
  pgreat: 16.67,
  great: 33.33,
  good: 116.67,
  bad: 250,
};

export interface JudgeNote {
  timeMs: number;
  lane: number;
}

export interface Judge {
  onInput(lane: number, songTimeMs: number): JudgementEvent;
  advance(songTimeMs: number): JudgementEvent[];
  remainingNotes(): number;
  noteState(noteIndex: number): 'pending' | 'hit' | 'missed';
}

type NoteState = 'pending' | 'hit' | 'missed';

interface LaneEntry {
  noteIndex: number;
  timeMs: number;
}

// Guards inclusive-boundary comparisons against float drift (e.g. computing
// `1000 + 116.67 - 1000` yields 116.67000000000007, not exactly 116.67).
const BOUNDARY_EPSILON_MS = 1e-6;

function gradeForDelta(absDeltaMs: number, windows: JudgementWindowsMs): JudgementGrade | null {
  if (absDeltaMs <= windows.pgreat + BOUNDARY_EPSILON_MS) return 'PGREAT';
  if (absDeltaMs <= windows.great + BOUNDARY_EPSILON_MS) return 'GREAT';
  if (absDeltaMs <= windows.good + BOUNDARY_EPSILON_MS) return 'GOOD';
  if (absDeltaMs <= windows.bad + BOUNDARY_EPSILON_MS) return 'BAD';
  return null;
}

export function createJudge(
  notes: readonly JudgeNote[],
  windows: JudgementWindowsMs = DEFAULT_JUDGEMENT_WINDOWS_MS,
): Judge {
  const states: NoteState[] = new Array(notes.length).fill('pending');
  const laneQueues = new Map<number, LaneEntry[]>();
  const laneHeads = new Map<number, number>();

  notes.forEach((note, noteIndex) => {
    let queue = laneQueues.get(note.lane);
    if (!queue) {
      queue = [];
      laneQueues.set(note.lane, queue);
    }
    queue.push({ noteIndex, timeMs: note.timeMs });
  });
  for (const lane of laneQueues.keys()) {
    laneHeads.set(lane, 0);
  }

  let remaining = notes.length;

  function onInput(lane: number, songTimeMs: number): JudgementEvent {
    const queue = laneQueues.get(lane);

    if (queue) {
      let cursor = laneHeads.get(lane) ?? 0;
      // Skip entries already resolved by advance() (missed) that haven't been
      // pruned from the head yet.
      while (cursor < queue.length) {
        const candidate = queue[cursor];
        if (candidate === undefined || states[candidate.noteIndex] === 'pending') {
          break;
        }
        cursor++;
      }

      const entry = cursor < queue.length ? queue[cursor] : undefined;
      if (entry !== undefined) {
        const deltaMs = songTimeMs - entry.timeMs;
        const grade = gradeForDelta(Math.abs(deltaMs), windows);
        if (grade !== null) {
          states[entry.noteIndex] = 'hit';
          laneHeads.set(lane, cursor + 1);
          remaining--;
          return {
            kind: 'hit',
            grade,
            lane,
            noteIndex: entry.noteIndex,
            deltaMs,
            songTimeMs,
          };
        }
      }
      laneHeads.set(lane, cursor);
    }

    return {
      kind: 'emptyPoor',
      grade: 'POOR',
      lane,
      noteIndex: -1,
      deltaMs: null,
      songTimeMs,
    };
  }

  function advance(songTimeMs: number): JudgementEvent[] {
    const missed: JudgementEvent[] = [];

    for (const [lane, queue] of laneQueues) {
      let head = laneHeads.get(lane) ?? 0;
      while (head < queue.length) {
        const entry = queue[head];
        if (entry === undefined) break;
        if (states[entry.noteIndex] !== 'pending') {
          head++;
          continue;
        }
        if (entry.timeMs + windows.bad < songTimeMs) {
          states[entry.noteIndex] = 'missed';
          remaining--;
          missed.push({
            kind: 'missPoor',
            grade: 'POOR',
            lane,
            noteIndex: entry.noteIndex,
            deltaMs: null,
            songTimeMs: entry.timeMs + windows.bad,
          });
          head++;
        } else {
          break;
        }
      }
      laneHeads.set(lane, head);
    }

    missed.sort((a, b) => a.songTimeMs - b.songTimeMs);
    return missed;
  }

  function remainingNotes(): number {
    return remaining;
  }

  function noteState(noteIndex: number): NoteState {
    return states[noteIndex] ?? 'pending';
  }

  return { onInput, advance, remainingNotes, noteState };
}
