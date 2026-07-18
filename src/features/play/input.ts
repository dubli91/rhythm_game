// Play-screen keyboard input capture (specs/input-handling.md).
//
// Judgement accuracy depends on using the event's own timeStamp (performance.now
// basis) rather than the time a frame happens to poll state, so this module is
// purely event-driven: it never polls. It depends only on the minimal structural
// KeyEventSource/KeyLikeEvent interfaces below (not lib.dom's KeyboardEvent) so it
// can be exercised in vitest's node environment with a fake target.

export const LANE_COUNT_TOTAL = 8; // 0 = scratch, 1..7 = keys

export interface LaneKeyMap {
  /** length 8; index = lane; values are KeyboardEvent.code. */
  lanes: readonly string[];
  /** Optional second code for the scratch lane (lane 0) so alternating
   *  two-finger scratching works (input-handling.md MUST 12). null/absent =
   *  unbound; key lanes 1-7 stay single-code. */
  scratchSecondary?: string | null;
}

export const DEFAULT_KEY_MAP: LaneKeyMap = {
  lanes: ['ShiftLeft', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
  scratchSecondary: null,
};

/** Exactly 8 non-empty, unique lane codes; a bound scratch secondary must be
 *  non-empty and distinct from every lane code too — ALL codes in the map are
 *  mutually unique, max 9 (input-handling.md MUST 14). */
export function isValidKeyMap(map: LaneKeyMap): boolean {
  if (map.lanes.length !== LANE_COUNT_TOTAL) {
    return false;
  }
  const seen = new Set<string>();
  for (const code of map.lanes) {
    if (code.length === 0) {
      return false;
    }
    if (seen.has(code)) {
      return false;
    }
    seen.add(code);
  }
  const secondary = map.scratchSecondary ?? null;
  if (secondary !== null) {
    if (secondary.length === 0) {
      return false;
    }
    if (seen.has(secondary)) {
      return false;
    }
  }
  return true;
}

export interface LaneKeyEvent {
  lane: number;
  down: boolean;
  /** Whether ≥1 bound code for this lane remains physically held AFTER this
   *  event — the key-beam signal (input-handling.md MUST 13): with a scratch
   *  secondary bound, releasing one of two held keys keeps the beam lit.
   *  Always true on down events. */
  laneHeld: boolean;
  /** event.timeStamp verbatim. */
  timeStampMs: number;
}

// Non-gameplay in-play controls: quit (input-handling.md MUST 6) plus the
// option-adjustment keys (play-options.md MUST 3/6) and the dev-overlay toggle
// (playfield-rendering.md SHOULD 16, input-handling.md SHOULD 10). Extensible
// union — future options (LIFT etc.) add variants here. bpmUp/bpmDown only fire
// when a screen maps codes to them via extraControlCodes (practice-mode.md MUST 9).
export type PlayControlAction =
  | 'quit'
  | 'hiSpeedUp'
  | 'hiSpeedDown'
  | 'suddenToggle'
  | 'coverUp'
  | 'coverDown'
  | 'bpmUp'
  | 'bpmDown'
  | 'devOverlayToggle';

// Control keys take priority over lane keys so a custom key map can never
// shadow them (settings-screen.md MUST 10 reserves these codes).
const CONTROL_CODES: ReadonlyMap<string, PlayControlAction> = new Map([
  ['Escape', 'quit'],
  ['PageUp', 'hiSpeedUp'],
  ['PageDown', 'hiSpeedDown'],
  ['Home', 'suddenToggle'],
  ['ArrowUp', 'coverUp'],
  ['ArrowDown', 'coverDown'],
  ['F1', 'devOverlayToggle'],
]);

/** Codes the settings key-config must refuse to bind to a lane (settings-screen.md
 *  MUST 10) — derived from CONTROL_CODES so the two can never drift apart. */
export const RESERVED_LANE_CODES: ReadonlySet<string> = new Set(CONTROL_CODES.keys());

// Cover keys pass key-repeat through so holding them adjusts continuously
// (play-options.md MUST 6); BPM keys get the same hold-to-sweep treatment in
// practice; everything else fires once per physical press.
const REPEATABLE_ACTIONS: ReadonlySet<PlayControlAction> = new Set([
  'coverUp',
  'coverDown',
  'bpmUp',
  'bpmDown',
]);

export interface PlayControlEvent {
  action: PlayControlAction;
  timeStampMs: number;
}

/** Minimal structural subset of KeyboardEvent this module depends on. */
export interface KeyLikeEvent {
  code: string;
  repeat: boolean;
  timeStamp: number;
  preventDefault(): void;
}

/** Minimal structural subset of EventTarget this module depends on. */
export interface KeyEventSource {
  addEventListener(type: 'keydown' | 'keyup', handler: (event: KeyLikeEvent) => void): void;
  removeEventListener(type: 'keydown' | 'keyup', handler: (event: KeyLikeEvent) => void): void;
}

export interface PlayInputOptions {
  /** Defaults to DEFAULT_KEY_MAP. */
  keyMap?: LaneKeyMap;
  /** Screen-specific control keys (e.g. practice BPM adjust). Base CONTROL_CODES
   *  always win a conflict so the reserved keys can never be remapped. */
  extraControlCodes?: Readonly<Record<string, PlayControlAction>>;
  onLane(event: LaneKeyEvent): void;
  onControl(event: PlayControlEvent): void;
}

export interface PlayInput {
  /** Idempotent. */
  attach(): void;
  /** Idempotent; also clears held state. */
  detach(): void;
  isHeld(lane: number): boolean;
  /** Length 8; same stable array reference every call (renderer reads it per frame). */
  heldLanes(): readonly boolean[];
}

export function createPlayInput(target: KeyEventSource, options: PlayInputOptions): PlayInput {
  const keyMap = options.keyMap ?? DEFAULT_KEY_MAP;

  const controlCodes = new Map<string, PlayControlAction>();
  for (const [code, action] of Object.entries(options.extraControlCodes ?? {})) {
    controlCodes.set(code, action);
  }
  for (const [code, action] of CONTROL_CODES) {
    controlCodes.set(code, action); // base codes win conflicts
  }

  const codeToLane = new Map<string, number>();
  keyMap.lanes.forEach((code, lane) => {
    codeToLane.set(code, lane);
  });
  // Scratch secondary (input-handling.md MUST 12): a second physical code
  // feeding lane 0 as an equal, independent input.
  const scratchSecondary = keyMap.scratchSecondary ?? null;
  if (scratchSecondary !== null) {
    codeToLane.set(scratchSecondary, 0);
  }

  // Stable backing array — never reallocated, so heldLanes() can return the
  // same reference every call and the renderer can read it per frame with no
  // per-frame allocation.
  const held: boolean[] = new Array(LANE_COUNT_TOTAL).fill(false);
  // Physical codes currently down. Per-CODE tracking is what makes each keydown
  // of either scratch key an independent input (MUST 13) while `held` stays
  // per-lane ("≥1 code down") for the beam rule.
  const downCodes = new Set<string>();

  function laneStillHeld(lane: number): boolean {
    for (const [code, mapped] of codeToLane) {
      if (mapped === lane && downCodes.has(code)) {
        return true;
      }
    }
    return false;
  }

  let attached = false;

  function handleKeyDown(event: KeyLikeEvent): void {
    const control = controlCodes.get(event.code);
    if (control !== undefined) {
      if (event.repeat && !REPEATABLE_ACTIONS.has(control)) {
        return;
      }
      event.preventDefault();
      options.onControl({ action: control, timeStampMs: event.timeStamp });
      return;
    }

    if (event.repeat) {
      return;
    }

    const lane = codeToLane.get(event.code);
    if (lane === undefined) {
      return;
    }

    event.preventDefault();

    // Belt-and-braces beyond the repeat flag: ignore a keydown for a CODE
    // that's already down. Per-code (not per-lane) so the scratch secondary
    // still fires while the primary is held (MUST 13).
    if (downCodes.has(event.code)) {
      return;
    }

    downCodes.add(event.code);
    held[lane] = true;
    options.onLane({ lane, down: true, laneHeld: true, timeStampMs: event.timeStamp });
  }

  function handleKeyUp(event: KeyLikeEvent): void {
    const lane = codeToLane.get(event.code);
    if (lane === undefined) {
      return;
    }

    event.preventDefault();

    if (!downCodes.has(event.code)) {
      return;
    }

    downCodes.delete(event.code);
    const stillHeld = laneStillHeld(lane);
    held[lane] = stillHeld;
    options.onLane({ lane, down: false, laneHeld: stillHeld, timeStampMs: event.timeStamp });
  }

  function attach(): void {
    if (attached) {
      return;
    }
    attached = true;
    target.addEventListener('keydown', handleKeyDown);
    target.addEventListener('keyup', handleKeyUp);
  }

  function detach(): void {
    if (!attached) {
      return;
    }
    attached = false;
    target.removeEventListener('keydown', handleKeyDown);
    target.removeEventListener('keyup', handleKeyUp);
    held.fill(false);
    downCodes.clear();
  }

  function isHeld(lane: number): boolean {
    return held[lane] === true;
  }

  function heldLanes(): readonly boolean[] {
    return held;
  }

  return { attach, detach, isHeld, heldLanes };
}
