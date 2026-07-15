import { describe, expect, it } from 'vitest';
import { DEFAULT_JUDGEMENT_WINDOWS_MS, type JudgeNote, createJudge } from './judgement';

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
