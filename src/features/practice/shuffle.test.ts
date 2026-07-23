// Practice lane shuffle (specs/practice-mode.md MUST 15-18).
//
// Why these tests matter: the shuffle's whole contract is "display-only". The
// permutation semantics (position i shows ORIGINAL lane d) are easy to invert
// accidentally — the MIRROR-equivalence pin catches that — and the judgement
// invariance test is the acceptance criterion "판정·통계 결과가 배치와 무관하게
// 동일하다" made executable: same-timing inputs through a shuffled judge must
// produce byte-identical grades/deltas, lanes aside.

import { describe, expect, it } from 'vitest';
import { laneMapFor } from '../play/arrange';
import { createJudge } from '../play/judgement';
import { cycleJudgeNotes, firstCycle } from './schedule';
import {
  IDENTITY_SHUFFLE,
  createShuffleState,
  parseShuffleMapping,
  shuffleLaneMap,
} from './shuffle';

describe('parseShuffleMapping', () => {
  it('accepts every permutation shape the spec names', () => {
    expect(parseShuffleMapping('1234567')).toEqual({ ok: true, mapping: '1234567' });
    expect(parseShuffleMapping('7654321')).toEqual({ ok: true, mapping: '7654321' });
    expect(parseShuffleMapping('2416375')).toEqual({ ok: true, mapping: '2416375' });
  });

  it('trims surrounding whitespace before validating', () => {
    expect(parseShuffleMapping('  7654321 ')).toEqual({ ok: true, mapping: '7654321' });
  });

  it('rejects the acceptance-criteria inputs with a reason (MUST 16)', () => {
    // '1234566' duplicate, '123456' too short, '123456A' non-digit.
    const dup = parseShuffleMapping('1234566');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toContain('DUPLICATE');
    const short = parseShuffleMapping('123456');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.reason).toContain('7 DIGITS');
    const alpha = parseShuffleMapping('123456A');
    expect(alpha.ok).toBe(false);
    if (!alpha.ok) expect(alpha.reason).toContain("'A'");
  });

  it('rejects over-length, out-of-range digits, and empty input', () => {
    expect(parseShuffleMapping('12345678').ok).toBe(false);
    expect(parseShuffleMapping('1234568').ok).toBe(false); // 8 outside 1-7
    expect(parseShuffleMapping('0234567').ok).toBe(false); // 0 outside 1-7
    expect(parseShuffleMapping('').ok).toBe(false);
  });
});

describe('shuffleLaneMap', () => {
  it('identity mapping maps every lane to itself', () => {
    expect(shuffleLaneMap(IDENTITY_SHUFFLE)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("'7654321' equals MIRROR's lane map exactly (MUST 15)", () => {
    expect(shuffleLaneMap('7654321')).toEqual([...laneMapFor('MIRROR', 0)]);
  });

  it('position i shows ORIGINAL lane d: map is original→display', () => {
    // '2416375': screen lane 1 shows original 2 ⇒ map[2] = 1, etc.
    const map = shuffleLaneMap('2416375');
    expect(map[2]).toBe(1);
    expect(map[4]).toBe(2);
    expect(map[1]).toBe(3);
    expect(map[6]).toBe(4);
    expect(map[3]).toBe(5);
    expect(map[7]).toBe(6);
    expect(map[5]).toBe(7);
  });

  it('never moves the scratch lane (MUST 15)', () => {
    expect(shuffleLaneMap('7654321')[0]).toBe(0);
    expect(shuffleLaneMap('2416375')[0]).toBe(0);
  });
});

describe('createShuffleState (undo stack, MUST 17)', () => {
  it('starts at the identity and tracks applied mappings', () => {
    const state = createShuffleState();
    expect(state.current()).toBe(IDENTITY_SHUFFLE);
    state.apply('7654321');
    expect(state.current()).toBe('7654321');
    state.apply('2416375');
    expect(state.current()).toBe('2416375');
  });

  it('undo steps back one applied shuffle at a time, down to the identity', () => {
    const state = createShuffleState();
    state.apply('7654321');
    state.apply('2416375');
    expect(state.undo()).toBe(true);
    expect(state.current()).toBe('7654321');
    expect(state.undo()).toBe(true);
    expect(state.current()).toBe(IDENTITY_SHUFFLE);
    // Bottomed out: nothing left to undo, identity stays.
    expect(state.undo()).toBe(false);
    expect(state.current()).toBe(IDENTITY_SHUFFLE);
  });
});

describe('judgement invariance under shuffle (MUST 18 / acceptance)', () => {
  it('same-timing inputs produce identical grades/deltas — only lanes differ', () => {
    const cycle = firstCycle(0, 120, 20); // 4-beat count-in + 4 bars
    // A 1→7 staircase plus a scratch note (must stay untouched).
    const pattern = [
      { beat: 0, lane: 0 },
      { beat: 0, lane: 1 },
      { beat: 0.5, lane: 2 },
      { beat: 1, lane: 3 },
      { beat: 1.5, lane: 4 },
      { beat: 2, lane: 5 },
      { beat: 2.5, lane: 6 },
      { beat: 3, lane: 7 },
    ];
    const map = shuffleLaneMap('7654321');
    const plainNotes = cycleJudgeNotes(cycle, pattern);
    const shuffledNotes = cycleJudgeNotes(cycle, pattern, map);

    // Identical times; lanes substituted per the map; scratch untouched.
    expect(shuffledNotes.map((n) => n.timeMs)).toEqual(plainNotes.map((n) => n.timeMs));
    expect(shuffledNotes.map((n) => n.lane)).toEqual(plainNotes.map((n) => map[n.lane] ?? n.lane));
    expect(shuffledNotes[0]?.lane).toBe(0);

    // Drive both judges with the SAME input timings, each aimed at the lane its
    // judge displays that note on (physical lane = display lane in play).
    const deltas = [0, 12, -20, 40, 5, -3, 100, -180]; // spans PGREAT..BAD
    const plainJudge = createJudge(plainNotes);
    const shuffledJudge = createJudge(shuffledNotes);
    const plainEvents = plainNotes.map((n, i) =>
      plainJudge.onInput(n.lane, n.timeMs + (deltas[i] ?? 0)),
    );
    const shuffledEvents = shuffledNotes.map((n, i) =>
      shuffledJudge.onInput(n.lane, n.timeMs + (deltas[i] ?? 0)),
    );

    expect(shuffledEvents.map((e) => e.grade)).toEqual(plainEvents.map((e) => e.grade));
    expect(shuffledEvents.map((e) => e.kind)).toEqual(plainEvents.map((e) => e.kind));
    expect(shuffledEvents.map((e) => e.deltaMs)).toEqual(plainEvents.map((e) => e.deltaMs));
    expect(shuffledEvents.map((e) => e.noteIndex)).toEqual(plainEvents.map((e) => e.noteIndex));
    // The one permitted difference: the lane each judgement lands on.
    expect(shuffledEvents.map((e) => e.lane)).toEqual(
      plainEvents.map((e) => map[e.lane] ?? e.lane),
    );
  });
});
