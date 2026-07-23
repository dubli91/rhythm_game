// Practice lane shuffle (specs/practice-mode.md MUST 15-18).
//
// A user-entered 7-digit permutation string remaps key lanes 1-7 for a practice
// session: digit d at position i means "screen lane i shows original lane d's
// notes", so '1234567' is the identity and '7654321' has exactly MIRROR's
// effect (play/arrange.ts laneMapFor — pinned by a test). Scratch (lane 0) is
// never moved. Like play arrangements (play-options.md MUST 10), a shuffle is a
// pure lane substitution: note TIMES are untouched, so judgement and stats are
// provably invariant — only the column each note appears in differs (MUST 18).
//
// Applied mappings form a stack so undo (MUST 17) steps back one applied
// shuffle at a time, bottoming out at the session-start identity. Mappings are
// absolute (always relative to the pattern's ORIGINAL lanes, per the spec's
// "원본 d번 레인" wording), never composed with the previous mapping.

export const IDENTITY_SHUFFLE = '1234567';

export type ShuffleParseResult = { ok: true; mapping: string } | { ok: false; reason: string };

/** Validates a shuffle entry (MUST 16): exactly 7 chars, each a digit 1-7,
 *  no duplicates. Reasons are short HUD-ready strings naming the failure. */
export function parseShuffleMapping(raw: string): ShuffleParseResult {
  const mapping = raw.trim();
  if (mapping.length !== 7) {
    return { ok: false, reason: `NEED 7 DIGITS, GOT ${mapping.length}` };
  }
  const seen = new Set<string>();
  for (const ch of mapping) {
    if (ch < '1' || ch > '7') {
      return { ok: false, reason: `INVALID CHAR '${ch}'` };
    }
    if (seen.has(ch)) {
      return { ok: false, reason: `DUPLICATE DIGIT ${ch}` };
    }
    seen.add(ch);
  }
  return { ok: true, mapping };
}

/** Lane map for a parsed-valid mapping: index = ORIGINAL lane (0..7), value =
 *  displayed lane — the same shape as play/arrange.ts laneMapFor, so it plugs
 *  into the same substitution sites. mapping[i-1] = d ⇒ map[d] = i; map[0] = 0. */
export function shuffleLaneMap(mapping: string): readonly number[] {
  const map = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < 7; i++) {
    const digit = mapping.charCodeAt(i) - 48;
    map[digit] = i + 1;
  }
  return map;
}

export interface ShuffleState {
  /** The mapping new loops will lock in (stack top; identity when empty). */
  current(): string;
  /** Push an already-validated mapping. */
  apply(mapping: string): void;
  /** Pop the last applied mapping; false when already at the identity. */
  undo(): boolean;
}

export function createShuffleState(): ShuffleState {
  const stack: string[] = [];
  return {
    current(): string {
      return stack[stack.length - 1] ?? IDENTITY_SHUFFLE;
    },
    apply(mapping: string): void {
      stack.push(mapping);
    },
    undo(): boolean {
      return stack.pop() !== undefined;
    },
  };
}
