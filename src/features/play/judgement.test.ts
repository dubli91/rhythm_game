import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JUDGEMENT_WINDOWS_MS,
  type JudgeNote,
  createJudge,
  timingClassFor,
} from './judgement';

describe('createJudge — judgement windows (spec acceptance)', () => {
  it('δ = ±16ms is PGREAT', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const early = createJudge(notes).onInput(1, 984);
    expect(early.kind).toBe('hit');
    expect(early.grade).toBe('PGREAT');
    expect(early.deltaMs).toBe(-16);

    const late = createJudge(notes).onInput(1, 1016);
    expect(late.grade).toBe('PGREAT');
    expect(late.deltaMs).toBe(16);
  });

  it('δ = ±34ms is GOOD (34 > 33.33 great window)', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const early = createJudge(notes).onInput(1, 966);
    expect(early.grade).toBe('GOOD');

    const late = createJudge(notes).onInput(1, 1034);
    expect(late.grade).toBe('GOOD');
  });

  it('exact boundary 16.67ms is inclusive PGREAT', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const event = createJudge(notes).onInput(1, 1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.pgreat);
    expect(event.grade).toBe('PGREAT');
  });

  it('exact boundary 33.33ms is inclusive GREAT', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const event = createJudge(notes).onInput(1, 1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.great);
    expect(event.grade).toBe('GREAT');
  });

  it('exact boundary 116.67ms is inclusive GOOD', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const event = createJudge(notes).onInput(1, 1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.good);
    expect(event.grade).toBe('GOOD');
  });

  it('exact boundary 250ms is inclusive BAD', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const event = createJudge(notes).onInput(1, 1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.bad);
    expect(event.kind).toBe('hit');
    expect(event.grade).toBe('BAD');
  });

  it('δ = 251ms (just past BAD) is emptyPoor, note stays pending', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const judge = createJudge(notes);
    const event = judge.onInput(1, 1251);
    expect(event.kind).toBe('emptyPoor');
    expect(event.grade).toBe('POOR');
    expect(event.noteIndex).toBe(-1);
    expect(event.deltaMs).toBeNull();
    expect(judge.noteState(0)).toBe('pending');
  });

  it('early BAD (δ = -200) consumes the note', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const judge = createJudge(notes);
    const event = judge.onInput(1, 800);
    expect(event.kind).toBe('hit');
    expect(event.grade).toBe('BAD');
    expect(event.deltaMs).toBe(-200);
    expect(judge.noteState(0)).toBe('hit');
  });
});

describe('createJudge — overlapping same-lane notes', () => {
  it('one input never consumes two notes; earliest pending note is judged first', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1 },
      { timeMs: 1010, lane: 1 },
    ];
    const judge = createJudge(notes);

    const first = judge.onInput(1, 1000);
    expect(first.noteIndex).toBe(0);
    expect(first.kind).toBe('hit');
    expect(judge.noteState(0)).toBe('hit');
    expect(judge.noteState(1)).toBe('pending');

    const second = judge.onInput(1, 1010);
    expect(second.noteIndex).toBe(1);
    expect(second.kind).toBe('hit');
    expect(judge.noteState(1)).toBe('hit');

    expect(judge.remainingNotes()).toBe(0);
  });

  it('noteIndex refers to the index in the original notes array across lanes', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 0 },
      { timeMs: 1000, lane: 1 },
      { timeMs: 1005, lane: 0 },
    ];
    const judge = createJudge(notes);
    const scratchFirst = judge.onInput(0, 1000);
    expect(scratchFirst.noteIndex).toBe(0);
    const scratchSecond = judge.onInput(0, 1005);
    expect(scratchSecond.noteIndex).toBe(2);
    const key = judge.onInput(1, 1000);
    expect(key.noteIndex).toBe(1);
  });
});

describe('createJudge — advance() / miss handling', () => {
  it('zero-input playthrough: advance past end marks all notes missPoor', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1 },
      { timeMs: 2000, lane: 2 },
      { timeMs: 3000, lane: 0 },
    ];
    const judge = createJudge(notes);
    const events = judge.advance(10_000);

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.kind).toBe('missPoor');
      expect(event.grade).toBe('POOR');
      expect(event.deltaMs).toBeNull();
    }
    // Returned in note-time order.
    expect(events.map((e) => e.noteIndex)).toEqual([0, 1, 2]);
    expect(events[0]?.songTimeMs).toBe(1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.bad);

    expect(judge.remainingNotes()).toBe(0);
    expect(judge.noteState(0)).toBe('missed');
    expect(judge.noteState(1)).toBe('missed');
    expect(judge.noteState(2)).toBe('missed');
  });

  it('advance() only misses notes whose bad window has fully elapsed', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1 },
      { timeMs: 5000, lane: 1 },
    ];
    const judge = createJudge(notes);
    const events = judge.advance(1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.bad + 1);

    expect(events).toHaveLength(1);
    expect(events[0]?.noteIndex).toBe(0);
    expect(judge.noteState(1)).toBe('pending');
    expect(judge.remainingNotes()).toBe(1);
  });

  it('missed note then input in its old window is emptyPoor', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const judge = createJudge(notes);
    judge.advance(1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.bad + 1);
    expect(judge.noteState(0)).toBe('missed');

    const late = judge.onInput(1, 1000);
    expect(late.kind).toBe('emptyPoor');
    expect(late.noteIndex).toBe(-1);
  });
});

describe('createJudge — autoplay simulation', () => {
  it('input at each note exact time yields all PGREAT hits', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1 },
      { timeMs: 1500, lane: 2 },
      { timeMs: 2000, lane: 0 },
    ];
    const judge = createJudge(notes);
    for (const [index, note] of notes.entries()) {
      const event = judge.onInput(note.lane, note.timeMs);
      expect(event.kind).toBe('hit');
      expect(event.grade).toBe('PGREAT');
      expect(event.noteIndex).toBe(index);
      expect(event.deltaMs).toBe(0);
    }
    expect(judge.remainingNotes()).toBe(0);
  });
});

describe('createJudge — CN (charge notes)', () => {
  // Head at 1000ms, tail at 2000ms; end window opens at 2000 − good (±116.67ms end
  // window per judgement-scoring.md SHOULD 12).
  const cn: JudgeNote[] = [{ timeMs: 1000, lane: 1, endTimeMs: 2000 }];

  it('head hit is judged like a tap and parks the note in held', () => {
    const judge = createJudge(cn);
    const head = judge.onInput(1, 1016);
    expect(head.kind).toBe('hit');
    expect(head.grade).toBe('PGREAT');
    expect(head.deltaMs).toBe(16);
    expect(head.noteIndex).toBe(0);
    expect(judge.noteState(0)).toBe('held');
    // The head is the note's single scored judgement: remaining drops immediately.
    expect(judge.remainingNotes()).toBe(0);
  });

  it('release inside the end window is cnComplete and resolves the note to hit', () => {
    const judge = createJudge(cn);
    judge.onInput(1, 1000);
    const release = judge.onRelease(1, 2000 - DEFAULT_JUDGEMENT_WINDOWS_MS.good);
    expect(release?.kind).toBe('cnComplete');
    expect(release?.noteIndex).toBe(0);
    expect(judge.noteState(0)).toBe('hit');
  });

  it('release before the end window opens is cnBreak with grade BAD', () => {
    const judge = createJudge(cn);
    judge.onInput(1, 1000);
    const release = judge.onRelease(1, 2000 - DEFAULT_JUDGEMENT_WINDOWS_MS.good - 1);
    expect(release?.kind).toBe('cnBreak');
    expect(release?.grade).toBe('BAD');
    expect(release?.noteIndex).toBe(0);
    expect(judge.noteState(0)).toBe('broken');
  });

  it('holding through the end auto-completes via advance() at endTimeMs', () => {
    const judge = createJudge(cn);
    judge.onInput(1, 1000);
    const events = judge.advance(2500);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('cnComplete');
    expect(events[0]?.songTimeMs).toBe(2000);
    expect(judge.noteState(0)).toBe('hit');
    // A later release finds no active hold (keyup after completion is free).
    expect(judge.onRelease(1, 2600)).toBeNull();
  });

  it('a missed head never opens a hold: one note, one missPoor', () => {
    const judge = createJudge(cn);
    const events = judge.advance(1000 + DEFAULT_JUDGEMENT_WINDOWS_MS.bad + 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('missPoor');
    expect(judge.noteState(0)).toBe('missed');
    // Advancing past the tail produces nothing more.
    expect(judge.advance(3000)).toHaveLength(0);
    expect(judge.onRelease(1, 2000)).toBeNull();
  });

  it('release with no active hold returns null (keyup after a tap is free)', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const judge = createJudge(notes);
    judge.onInput(1, 1000);
    expect(judge.onRelease(1, 1050)).toBeNull();
  });

  it('release exactly at the end-window edge (endTimeMs − good) succeeds inclusively', () => {
    const judge = createJudge(cn);
    judge.onInput(1, 1000);
    // Float-arithmetic form of the edge: BOUNDARY_EPSILON must absorb the drift.
    const edge = 2000 - DEFAULT_JUDGEMENT_WINDOWS_MS.good;
    const release = judge.onRelease(1, edge);
    expect(release?.kind).toBe('cnComplete');
  });

  it('holds are independent per lane', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1, endTimeMs: 2000 },
      { timeMs: 1000, lane: 2, endTimeMs: 2000 },
    ];
    const judge = createJudge(notes);
    judge.onInput(1, 1000);
    judge.onInput(2, 1000);
    const breakEvent = judge.onRelease(1, 1200);
    expect(breakEvent?.kind).toBe('cnBreak');
    expect(breakEvent?.noteIndex).toBe(0);
    expect(judge.noteState(1)).toBe('held');
    const complete = judge.onRelease(2, 2000);
    expect(complete?.kind).toBe('cnComplete');
    expect(complete?.noteIndex).toBe(1);
  });

  it('after a cnBreak, a later note on the same lane is still judgeable', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1, endTimeMs: 2000 },
      { timeMs: 2500, lane: 1 },
    ];
    const judge = createJudge(notes);
    judge.onInput(1, 1000);
    judge.onRelease(1, 1100); // break
    const next = judge.onInput(1, 2500);
    expect(next.kind).toBe('hit');
    expect(next.noteIndex).toBe(1);
    expect(next.grade).toBe('PGREAT');
  });

  it('press-only autoplay on a CN chart yields PGREAT head + auto cnComplete (no break)', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1, endTimeMs: 2000 },
      { timeMs: 2500, lane: 1, endTimeMs: 3000 },
    ];
    const judge = createJudge(notes);
    // Frame loop: advance() runs before each press (controller ordering).
    expect(judge.advance(1000)).toHaveLength(0);
    expect(judge.onInput(1, 1000).grade).toBe('PGREAT');
    const mid = judge.advance(2500);
    expect(mid.map((e) => e.kind)).toEqual(['cnComplete']);
    expect(judge.onInput(1, 2500).grade).toBe('PGREAT');
    const end = judge.advance(4000);
    expect(end.map((e) => e.kind)).toEqual(['cnComplete']);
    expect(judge.noteState(0)).toBe('hit');
    expect(judge.noteState(1)).toBe('hit');
  });
});

describe('createJudge — custom windows', () => {
  it('accepts a custom JudgementWindowsMs override', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const judge = createJudge(notes, { pgreat: 5, great: 10, good: 20, bad: 40 });
    const event = judge.onInput(1, 1015);
    expect(event.grade).toBe('GOOD');
    const outside = createJudge(notes, { pgreat: 5, great: 10, good: 20, bad: 40 }).onInput(
      1,
      1050,
    );
    expect(outside.kind).toBe('emptyPoor');
  });
});

describe('createJudge — FAST/SLOW classification (judgement-scoring.md MUST 14/15)', () => {
  it('δ = −20ms is GREAT + FAST, δ = +20ms is GREAT + SLOW (spec acceptance)', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const early = createJudge(notes).onInput(1, 980);
    expect(early.grade).toBe('GREAT');
    expect(early.timing).toBe('FAST');
    expect(early.deltaMs).toBe(-20);

    const late = createJudge(notes).onInput(1, 1020);
    expect(late.grade).toBe('GREAT');
    expect(late.timing).toBe('SLOW');
    expect(late.deltaMs).toBe(20);
  });

  it('classifies every non-PGREAT δ grade: GOOD and BAD both carry the sign', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    expect(createJudge(notes).onInput(1, 900).timing).toBe('FAST'); // GOOD
    expect(createJudge(notes).onInput(1, 1100).timing).toBe('SLOW'); // GOOD
    expect(createJudge(notes).onInput(1, 800).timing).toBe('FAST'); // BAD
    expect(createJudge(notes).onInput(1, 1200).timing).toBe('SLOW'); // BAD
  });

  it('PGREAT is never classified, regardless of δ sign', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const early = createJudge(notes).onInput(1, 984);
    expect(early.grade).toBe('PGREAT');
    expect(early.timing).toBeNull();
    const late = createJudge(notes).onInput(1, 1016);
    expect(late.grade).toBe('PGREAT');
    expect(late.timing).toBeNull();
  });

  it('timingClassFor: δ 0 is neither, PGREAT is neither at any δ', () => {
    expect(timingClassFor('GREAT', 0)).toBeNull();
    expect(timingClassFor('PGREAT', -200)).toBeNull();
    expect(timingClassFor('GOOD', -0.001)).toBe('FAST');
    expect(timingClassFor('BAD', 0.001)).toBe('SLOW');
  });

  it('non-δ judgements are unclassified: missPoor, emptyPoor, cnBreak, cnComplete', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const [miss] = createJudge(notes).advance(10_000);
    expect(miss?.kind).toBe('missPoor');
    expect(miss?.timing).toBeNull();

    const empty = createJudge(notes).onInput(1, 5000);
    expect(empty.kind).toBe('emptyPoor');
    expect(empty.timing).toBeNull();

    const cnNotes: JudgeNote[] = [{ timeMs: 1000, lane: 1, endTimeMs: 2000 }];
    const breakJudge = createJudge(cnNotes);
    breakJudge.onInput(1, 1000);
    const broke = breakJudge.onRelease(1, 1200);
    expect(broke?.kind).toBe('cnBreak');
    expect(broke?.timing).toBeNull(); // "treated as BAD" but not δ-based (MUST 14)

    const completeJudge = createJudge(cnNotes);
    completeJudge.onInput(1, 1000);
    const done = completeJudge.onRelease(1, 1950);
    expect(done?.kind).toBe('cnComplete');
    expect(done?.timing).toBeNull();
  });

  it('a CN head hit is classified exactly like a tap (MUST 14: CN 시작 판정 포함)', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1, endTimeMs: 2000 }];
    const head = createJudge(notes).onInput(1, 975);
    expect(head.kind).toBe('hit');
    expect(head.grade).toBe('GREAT');
    expect(head.timing).toBe('FAST');
  });
});
