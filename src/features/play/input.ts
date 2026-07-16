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
}

export const DEFAULT_KEY_MAP: LaneKeyMap = {
  lanes: ['ShiftLeft', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
};

/** Exactly 8 non-empty, unique codes. */
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
  return true;
}

export interface LaneKeyEvent {
  lane: number;
  down: boolean;
  /** event.timeStamp verbatim. */
  timeStampMs: number;
}

// Non-gameplay in-play controls: quit (input-handling.md MUST 6) plus the
// option-adjustment keys (play-options.md MUST 3/6). Extensible union — future
// options (LIFT etc.) add variants here. bpmUp/bpmDown only fire when a screen
// maps codes to them via extraControlCodes (practice-mode.md MUST 9).
export type PlayControlAction =
  | 'quit'
  | 'hiSpeedUp'
  | 'hiSpeedDown'
  | 'suddenToggle'
  | 'coverUp'
  | 'coverDown'
  | 'bpmUp'
  | 'bpmDown';

// Control keys take priority over lane keys so a custom key map can never
// shadow them (settings-screen.md MUST 10 reserves these codes).
const CONTROL_CODES: ReadonlyMap<string, PlayControlAction> = new Map([
  ['Escape', 'quit'],
  ['PageUp', 'hiSpeedUp'],
  ['PageDown', 'hiSpeedDown'],
  ['Home', 'suddenToggle'],
  ['ArrowUp', 'coverUp'],
  ['ArrowDown', 'coverDown'],
]);

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

  // Stable backing array — never reallocated, so heldLanes() can return the
  // same reference every call and the renderer can read it per frame with no
  // per-frame allocation.
  const held: boolean[] = new Array(LANE_COUNT_TOTAL).fill(false);

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

    // Belt-and-braces beyond the repeat flag: ignore a keydown for a lane
    // that's already held.
    if (held[lane] === true) {
      return;
    }

    held[lane] = true;
    options.onLane({ lane, down: true, timeStampMs: event.timeStamp });
  }

  function handleKeyUp(event: KeyLikeEvent): void {
    const lane = codeToLane.get(event.code);
    if (lane === undefined) {
      return;
    }

    event.preventDefault();

    if (held[lane] !== true) {
      return;
    }

    held[lane] = false;
    options.onLane({ lane, down: false, timeStampMs: event.timeStamp });
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
  }

  function isHeld(lane: number): boolean {
    return held[lane] === true;
  }

  function heldLanes(): readonly boolean[] {
    return held;
  }

  return { attach, detach, isHeld, heldLanes };
}
