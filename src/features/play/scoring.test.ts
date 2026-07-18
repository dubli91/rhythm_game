import { describe, expect, it } from 'vitest';
import { type JudgeNote, createJudge, timingClassFor } from './judgement';
import { createScorer, djRankFor } from './scoring';
import type { JudgementEvent } from './types';

// timing derives via timingClassFor (the judge's own classifier) so these
// factories can never disagree with the engine about the FAST/SLOW rule.
function hit(
  grade: JudgementEvent['grade'],
  noteIndex: number,
  lane = 1,
  songTimeMs = 0,
  deltaMs = 0,
): JudgementEvent {
  return {
    kind: 'hit',
    grade,
    lane,
    noteIndex,
    deltaMs,
    timing: timingClassFor(grade, deltaMs),
    songTimeMs,
  };
}

function missPoor(noteIndex: number, lane = 1, songTimeMs = 0): JudgementEvent {
  return {
    kind: 'missPoor',
    grade: 'POOR',
    lane,
    noteIndex,
    deltaMs: null,
    timing: null,
    songTimeMs,
  };
}

function emptyPoor(lane = 1, songTimeMs = 0): JudgementEvent {
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

function cnBreak(noteIndex: number, lane = 1, songTimeMs = 0): JudgementEvent {
  return {
    kind: 'cnBreak',
    grade: 'BAD',
    lane,
    noteIndex,
    deltaMs: null,
    timing: null,
    songTimeMs,
  };
}

function cnComplete(noteIndex: number, lane = 1, songTimeMs = 0): JudgementEvent {
  return {
    kind: 'cnComplete',
    grade: 'PGREAT',
    lane,
    noteIndex,
    deltaMs: null,
    timing: null,
    songTimeMs,
  };
}

describe('djRankFor', () => {
  it('maxExScore 0 is F', () => {
    expect(djRankFor(0, 0)).toBe('F');
  });

  it('exact 8/9 boundary is AAA, just below is AA', () => {
    const max = 900; // divisible cleanly with 9
    expect(djRankFor((max * 8) / 9, max)).toBe('AAA');
    expect(djRankFor((max * 8) / 9 - 1, max)).toBe('AA');
  });

  it('exact 7/9 boundary is AA, just below is A', () => {
    const max = 900;
    expect(djRankFor((max * 7) / 9, max)).toBe('AA');
    expect(djRankFor((max * 7) / 9 - 1, max)).toBe('A');
  });

  it('exact 2/9 boundary is E, just below is F', () => {
    const max = 900;
    expect(djRankFor((max * 2) / 9, max)).toBe('E');
    expect(djRankFor((max * 2) / 9 - 1, max)).toBe('F');
  });

  it('uses exact integer math to avoid float error at odd maxExScore', () => {
    // maxExScore = 9 is the classic case where 8/9 as a float ratio can misbehave.
    expect(djRankFor(8, 9)).toBe('AAA');
    expect(djRankFor(7, 9)).toBe('AA');
  });
});

describe('createScorer — combo & counts', () => {
  it('PGREAT/GREAT/GOOD hits increment combo; BAD and missPoor reset it; maxCombo retained', () => {
    const scorer = createScorer(5);
    scorer.apply(hit('PGREAT', 0));
    scorer.apply(hit('GREAT', 1));
    scorer.apply(hit('GOOD', 2));
    let snap = scorer.snapshot();
    expect(snap.combo).toBe(3);
    expect(snap.maxCombo).toBe(3);

    scorer.apply(hit('BAD', 3));
    snap = scorer.snapshot();
    expect(snap.combo).toBe(0);
    expect(snap.maxCombo).toBe(3);

    scorer.apply(hit('PGREAT', 4));
    snap = scorer.snapshot();
    expect(snap.combo).toBe(1);
    expect(snap.maxCombo).toBe(3);
  });

  it('missPoor resets combo and counts toward POOR + BP', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('PGREAT', 0));
    scorer.apply(missPoor(1));
    const snap = scorer.snapshot();
    expect(snap.combo).toBe(0);
    expect(snap.counts.POOR).toBe(1);
    expect(snap.bp).toBe(1);
  });

  it('emptyPoor does not break combo but does count toward BP and emptyPoorCount', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('PGREAT', 0));
    scorer.apply(emptyPoor());
    scorer.apply(hit('GREAT', 1));
    const snap = scorer.snapshot();
    expect(snap.combo).toBe(2);
    expect(snap.emptyPoorCount).toBe(1);
    expect(snap.counts.POOR).toBe(0); // emptyPoor is NOT in counts.POOR
    expect(snap.bp).toBe(1); // but does count toward bp
  });

  it('BP arithmetic sums BAD + missPoor POOR + emptyPoor', () => {
    const scorer = createScorer(4);
    scorer.apply(hit('BAD', 0));
    scorer.apply(missPoor(1));
    scorer.apply(emptyPoor());
    scorer.apply(emptyPoor());
    const snap = scorer.snapshot();
    expect(snap.bp).toBe(1 + 1 + 2);
  });
});

describe('createScorer — CN tail events', () => {
  it('cnBreak resets combo, adds to BP, but never touches the grade counts', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('PGREAT', 0)); // CN head — the note's single scored judgement
    scorer.apply(cnBreak(0));
    scorer.apply(hit('PGREAT', 1));
    const snap = scorer.snapshot();
    expect(snap.combo).toBe(1); // reset by the break, rebuilt by the second hit
    expect(snap.maxCombo).toBe(1);
    expect(snap.cnBreakCount).toBe(1);
    expect(snap.bp).toBe(1);
    expect(snap.counts.BAD).toBe(0); // "treated as BAD" is penalty-only, not a count
    expect(snap.counts.PGREAT).toBe(2); // head grade stands even after the break
  });

  it('cnBreak does not affect judgedNotes/EX: a CN is 1 note, scored at the head', () => {
    const scorer = createScorer(1);
    scorer.apply(hit('PGREAT', 0));
    scorer.apply(cnBreak(0));
    const snap = scorer.snapshot();
    expect(snap.judgedNotes).toBe(1);
    expect(snap.isComplete).toBe(true);
    expect(snap.exScore).toBe(2);
    expect(snap.maxExScore).toBe(2);
  });

  it('cnComplete is a scoring no-op', () => {
    const scorer = createScorer(1);
    scorer.apply(hit('GREAT', 0));
    const before = scorer.snapshot();
    scorer.apply(cnComplete(0));
    const after = scorer.snapshot();
    expect(after).toEqual(before);
  });

  it('fullCombo is killed by a cnBreak even with clean grade counts', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('PGREAT', 0));
    scorer.apply(cnBreak(0));
    scorer.apply(hit('PGREAT', 1));
    const snap = scorer.snapshot();
    expect(snap.isComplete).toBe(true);
    expect(snap.counts.BAD).toBe(0);
    expect(snap.counts.POOR).toBe(0);
    expect(snap.fullCombo).toBe(false);
  });

  it('completed holds preserve fullCombo', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('PGREAT', 0));
    scorer.apply(cnComplete(0));
    scorer.apply(hit('GREAT', 1));
    const snap = scorer.snapshot();
    expect(snap.fullCombo).toBe(true);
  });

  it('BP arithmetic folds in cnBreak alongside BAD/missPoor/emptyPoor', () => {
    const scorer = createScorer(3);
    scorer.apply(hit('BAD', 0));
    scorer.apply(missPoor(1));
    scorer.apply(emptyPoor());
    scorer.apply(hit('PGREAT', 2));
    scorer.apply(cnBreak(2));
    const snap = scorer.snapshot();
    expect(snap.bp).toBe(4);
  });
});

describe('createScorer — EX score, percent, rank, completeness', () => {
  it('zero-input playthrough: all missPoor gives exScore 0, combo 0, isComplete true', () => {
    const scorer = createScorer(3);
    scorer.apply(missPoor(0));
    scorer.apply(missPoor(1));
    scorer.apply(missPoor(2));
    const snap = scorer.snapshot();
    expect(snap.exScore).toBe(0);
    expect(snap.combo).toBe(0);
    expect(snap.maxExScore).toBe(6);
    expect(snap.exPercent).toBe(0);
    expect(snap.isComplete).toBe(true);
    expect(snap.judgedNotes).toBe(3);
    expect(snap.fullCombo).toBe(false);
    expect(snap.djRank).toBe('F');
  });

  it('perfect playthrough (all PGREAT) yields maxExScore, fullCombo true, djRank AAA', () => {
    const totalNotes = 4;
    const scorer = createScorer(totalNotes);
    for (let i = 0; i < totalNotes; i++) {
      scorer.apply(hit('PGREAT', i));
    }
    const snap = scorer.snapshot();
    expect(snap.exScore).toBe(snap.maxExScore);
    expect(snap.exPercent).toBe(100);
    expect(snap.fullCombo).toBe(true);
    expect(snap.djRank).toBe('AAA');
    expect(snap.isComplete).toBe(true);
  });

  it('fullCombo requires isComplete and excludes BAD/missPoor but tolerates emptyPoor', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('GOOD', 0));
    scorer.apply(emptyPoor());
    scorer.apply(hit('GREAT', 1));
    const snap = scorer.snapshot();
    expect(snap.isComplete).toBe(true);
    expect(snap.fullCombo).toBe(true);
  });

  it('fullCombo is false if any BAD occurred, even if combo later recovers', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('BAD', 0));
    scorer.apply(hit('PGREAT', 1));
    const snap = scorer.snapshot();
    expect(snap.isComplete).toBe(true);
    expect(snap.fullCombo).toBe(false);
  });

  it('not complete until judgedNotes === totalNotes', () => {
    const scorer = createScorer(3);
    scorer.apply(hit('PGREAT', 0));
    const snap = scorer.snapshot();
    expect(snap.isComplete).toBe(false);
    expect(snap.judgedNotes).toBe(1);
    expect(snap.totalNotes).toBe(3);
  });

  it('snapshot returns fresh copies (no aliasing internal state)', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('PGREAT', 0));
    const first = scorer.snapshot();
    first.counts.PGREAT = 999;
    scorer.apply(hit('GREAT', 1));
    const second = scorer.snapshot();
    expect(second.counts.PGREAT).toBe(1);
    expect(second.counts.GREAT).toBe(1);
  });
});

describe('createScorer — integration with createJudge', () => {
  it('autoplay simulation via createJudge feeding createScorer yields AAA full combo', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1 },
      { timeMs: 1500, lane: 2 },
      { timeMs: 2000, lane: 0 },
    ];
    const judge = createJudge(notes);
    const scorer = createScorer(notes.length);

    for (const note of notes) {
      scorer.apply(judge.onInput(note.lane, note.timeMs));
    }

    const snap = scorer.snapshot();
    expect(snap.fullCombo).toBe(true);
    expect(snap.djRank).toBe('AAA');
    expect(snap.exScore).toBe(snap.maxExScore);
  });

  it('zero-input playthrough via createJudge.advance() feeding createScorer', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1 },
      { timeMs: 2000, lane: 2 },
    ];
    const judge = createJudge(notes);
    const scorer = createScorer(notes.length);

    for (const event of judge.advance(10_000)) {
      scorer.apply(event);
    }

    const snap = scorer.snapshot();
    expect(snap.exScore).toBe(0);
    expect(snap.isComplete).toBe(true);
    expect(snap.combo).toBe(0);
  });
});

describe('createScorer — FAST/SLOW aggregation (judgement-scoring.md MUST 16)', () => {
  it('counts FAST for early and SLOW for late non-PGREAT hits', () => {
    const scorer = createScorer(4);
    scorer.apply(hit('GREAT', 0, 1, 0, -20));
    scorer.apply(hit('GOOD', 1, 1, 0, -60));
    scorer.apply(hit('GREAT', 2, 1, 0, 20));
    scorer.apply(hit('BAD', 3, 1, 0, 200));
    const snap = scorer.snapshot();
    expect(snap.fastCount).toBe(2);
    expect(snap.slowCount).toBe(2);
  });

  it('PGREAT hits count toward neither side, regardless of δ sign', () => {
    const scorer = createScorer(2);
    scorer.apply(hit('PGREAT', 0, 1, 0, -16));
    scorer.apply(hit('PGREAT', 1, 1, 0, 16));
    const snap = scorer.snapshot();
    expect(snap.fastCount).toBe(0);
    expect(snap.slowCount).toBe(0);
  });

  it('missPoor / emptyPoor / cnBreak / cnComplete never contribute (not δ-based)', () => {
    const scorer = createScorer(3);
    scorer.apply(missPoor(0));
    scorer.apply(emptyPoor());
    scorer.apply(hit('PGREAT', 1)); // CN head
    scorer.apply(cnBreak(1));
    scorer.apply(hit('PGREAT', 2)); // CN head
    scorer.apply(cnComplete(2));
    const snap = scorer.snapshot();
    expect(snap.fastCount).toBe(0);
    expect(snap.slowCount).toBe(0);
  });

  it('aggregation is independent of any display option: counters live on ScoreSummary', () => {
    // The scorer has no notion of the timing display mode (play-options.md MUST 18:
    // OFF must still aggregate) — this pins that no such coupling gets introduced.
    const scorer = createScorer(1);
    scorer.apply(hit('GOOD', 0, 1, 0, 40));
    expect(scorer.snapshot().slowCount).toBe(1);
  });

  it('autoplay simulation via createJudge yields zero FAST/SLOW (spec acceptance)', () => {
    const notes: JudgeNote[] = [
      { timeMs: 1000, lane: 1 },
      { timeMs: 1500, lane: 2 },
      { timeMs: 2000, lane: 0 },
    ];
    const judge = createJudge(notes);
    const scorer = createScorer(notes.length);
    for (const note of notes) {
      scorer.apply(judge.onInput(note.lane, note.timeMs));
    }
    const snap = scorer.snapshot();
    expect(snap.fullCombo).toBe(true);
    expect(snap.fastCount).toBe(0);
    expect(snap.slowCount).toBe(0);
  });

  it('judge-classified events flow through: early GREAT via createJudge counts FAST', () => {
    const notes: JudgeNote[] = [{ timeMs: 1000, lane: 1 }];
    const judge = createJudge(notes);
    const scorer = createScorer(1);
    scorer.apply(judge.onInput(1, 980));
    const snap = scorer.snapshot();
    expect(snap.counts.GREAT).toBe(1);
    expect(snap.fastCount).toBe(1);
    expect(snap.slowCount).toBe(0);
  });
});
