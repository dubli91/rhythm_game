// Judgement engine (specs/judgement-scoring.md).
// Headless: evaluates input timing against chart notes and yields JudgementEvent
// records for downstream gauge/scoring/HUD consumers. No DOM, no rendering.

import type { JudgementEvent, JudgementGrade, TimingClass } from './types';

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
  /** CN (charge note) tail time; present = the note is a CN and its head hit opens a hold. */
  endTimeMs?: number;
}

/**
 * CN lifecycle (judgement-scoring.md SHOULD 12): the head is judged exactly like a tap
 * and is the note's single scored judgement. A successful head hit opens a per-lane
 * hold; the tail then resolves one of two ways:
 *   - release at t >= endTimeMs − windows.good  → cnComplete (success, no scoring effect)
 *   - release earlier                            → cnBreak ("treated as BAD")
 * While still held, advance() auto-completes the hold once songTimeMs reaches endTimeMs
 * (holding through the end is never punished — this is also what makes press-only
 * autoplay produce FULL COMBO on CN charts). Because advance() runs before onRelease()
 * on every input, a "late release" can never reach onRelease — the hold is already
 * complete — so the spec's late window edge (+good) is unreachable by construction.
 * A missed head (missPoor) never opens a hold: one note, one miss.
 */
export interface Judge {
  onInput(lane: number, songTimeMs: number): JudgementEvent;
  /** Resolves the lane's active CN hold, if any; null when nothing is held (a keyup
   *  after a tap hit is normal and must be free — emptyPoor is for presses only). */
  onRelease(lane: number, songTimeMs: number): JudgementEvent | null;
  advance(songTimeMs: number): JudgementEvent[];
  remainingNotes(): number;
  noteState(noteIndex: number): NoteState;
}

/** held = CN head hit, tail unresolved; broken = CN tail failed (early release).
 *  'hit' means fully resolved success (tap hit, or CN completed). */
export type NoteState = 'pending' | 'held' | 'hit' | 'missed' | 'broken';

interface LaneEntry {
  noteIndex: number;
  timeMs: number;
  endTimeMs: number | undefined;
}

interface ActiveHold {
  noteIndex: number;
  endTimeMs: number;
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

/** FAST/SLOW classification of a δ-based judgement (judgement-scoring.md MUST 14):
 * the sign of the same offset-adjusted δ that graded the hit. PGREAT is neither,
 * regardless of δ; δ exactly 0 is neither (unreachable for non-PGREAT grades with
 * any real window set, but the rule stays total). Single source of truth — the
 * scorer and every display surface consume the event's `timing` field, never
 * re-derive the sign themselves. */
export function timingClassFor(grade: JudgementGrade, deltaMs: number): TimingClass | null {
  if (grade === 'PGREAT') return null;
  if (deltaMs < 0) return 'FAST';
  if (deltaMs > 0) return 'SLOW';
  return null;
}

export function createJudge(
  notes: readonly JudgeNote[],
  windows: JudgementWindowsMs = DEFAULT_JUDGEMENT_WINDOWS_MS,
): Judge {
  const states: NoteState[] = new Array(notes.length).fill('pending');
  const laneQueues = new Map<number, LaneEntry[]>();
  const laneHeads = new Map<number, number>();
  // At most one hold per lane: a physical key can only hold one CN at a time, and
  // validate.ts rejects same-lane notes inside a CN span.
  const activeHolds = new Map<number, ActiveHold>();

  notes.forEach((note, noteIndex) => {
    let queue = laneQueues.get(note.lane);
    if (!queue) {
      queue = [];
      laneQueues.set(note.lane, queue);
    }
    queue.push({ noteIndex, timeMs: note.timeMs, endTimeMs: note.endTimeMs });
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
          const isCn = entry.endTimeMs !== undefined;
          states[entry.noteIndex] = isCn ? 'held' : 'hit';
          if (isCn && entry.endTimeMs !== undefined) {
            activeHolds.set(lane, { noteIndex: entry.noteIndex, endTimeMs: entry.endTimeMs });
          }
          laneHeads.set(lane, cursor + 1);
          remaining--;
          return {
            kind: 'hit',
            grade,
            lane,
            noteIndex: entry.noteIndex,
            deltaMs,
            timing: timingClassFor(grade, deltaMs),
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
      timing: null,
      songTimeMs,
    };
  }

  function onRelease(lane: number, songTimeMs: number): JudgementEvent | null {
    const hold = activeHolds.get(lane);
    if (hold === undefined) return null;
    activeHolds.delete(lane);
    // Success once the release lands inside the end window's early edge; the late
    // edge is unreachable because advance() auto-completes held notes at endTimeMs.
    const success = songTimeMs >= hold.endTimeMs - windows.good - BOUNDARY_EPSILON_MS;
    states[hold.noteIndex] = success ? 'hit' : 'broken';
    // CN tail events are not δ-based, so a cnBreak's BAD is never FAST/SLOW
    // (judgement-scoring.md MUST 14 excludes it explicitly).
    return {
      kind: success ? 'cnComplete' : 'cnBreak',
      grade: success ? 'PGREAT' : 'BAD',
      lane,
      noteIndex: hold.noteIndex,
      deltaMs: null,
      timing: null,
      songTimeMs,
    };
  }

  function advance(songTimeMs: number): JudgementEvent[] {
    const events: JudgementEvent[] = [];

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
          // A missed CN head never opens a hold: one note, one missPoor.
          states[entry.noteIndex] = 'missed';
          remaining--;
          events.push({
            kind: 'missPoor',
            grade: 'POOR',
            lane,
            noteIndex: entry.noteIndex,
            deltaMs: null,
            timing: null,
            songTimeMs: entry.timeMs + windows.bad,
          });
          head++;
        } else {
          break;
        }
      }
      laneHeads.set(lane, head);
    }

    // Auto-complete CN holds whose end has passed while still held (holding through
    // the end is success; press-only autoplay relies on this).
    for (const [lane, hold] of activeHolds) {
      if (hold.endTimeMs <= songTimeMs) {
        activeHolds.delete(lane);
        states[hold.noteIndex] = 'hit';
        events.push({
          kind: 'cnComplete',
          grade: 'PGREAT',
          lane,
          noteIndex: hold.noteIndex,
          deltaMs: null,
          timing: null,
          songTimeMs: hold.endTimeMs,
        });
      }
    }

    events.sort((a, b) => a.songTimeMs - b.songTimeMs);
    return events;
  }

  function remainingNotes(): number {
    return remaining;
  }

  function noteState(noteIndex: number): NoteState {
    return states[noteIndex] ?? 'pending';
  }

  return { onInput, onRelease, advance, remainingNotes, noteState };
}
