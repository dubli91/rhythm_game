// Headless settings-screen model (specs/settings-screen.md MUST 5-11,
// specs/input-handling.md MUST 7-9).
//
// Owns the navigation cursor, the key-capture mode, and every value mutation
// (key rebinds, global offset, volumes) so the whole interaction contract is
// unit-testable without a DOM — screen.ts is presentation over this. The model
// operates on the SAME live object the shell passes to play/practice sessions
// (SettingsValues), which is what makes "change offset, then play immediately"
// work with no refresh (MUST 11): there is exactly one source of truth.
//
// Invariant: keyMapLanes + keyMapScratchSecondary is always a valid map (8
// unique non-empty lane codes, plus an optional scratch secondary distinct from
// all of them — input-handling.md MUST 12/14). Every mutation path preserves
// it — duplicate assignments are rejected with the conflicting lane (MUST 7),
// reserved in-play control codes are rejected with a reason (MUST 10), and a
// per-lane reset is rejected when the default code is currently bound to a
// DIFFERENT lane or to the scratch secondary (otherwise the reset itself would
// create a duplicate and silently invalidate the whole map). Scratch reset
// clears the secondary slot too (settings-screen.md MUST 15).

import type { VolumeSettings } from '../../lib/audio/context';
import { clampVolume } from '../../lib/audio/context';
import { clampGlobalOffsetMs } from '../../lib/clock/audioClock';
import { DEFAULT_KEY_MAP, LANE_COUNT_TOTAL, RESERVED_LANE_CODES } from '../play/input';

/** The persisted settings document shape (settings.v1) — also the live in-memory object. */
export interface SettingsValues {
  globalOffsetMs: number;
  volumes: VolumeSettings;
  keyMapLanes: string[];
  /** Optional scratch secondary key (input-handling.md MUST 12); null = unbound. */
  keyMapScratchSecondary: string | null;
}

export type VolumeChannel = keyof VolumeSettings;

export type SettingsRow =
  | { kind: 'lane'; lane: number }
  | { kind: 'resetAll' }
  | { kind: 'offset' }
  | { kind: 'volume'; channel: VolumeChannel }
  | { kind: 'calibration' }
  | { kind: 'stats' }
  | { kind: 'exportRecords' }
  | { kind: 'importRecords' };

export const OFFSET_STEP_FINE_MS = 1;
export const OFFSET_STEP_COARSE_MS = 10;
/** Keyboard volume step (5%); mouse sliders move in 1% steps. */
export const VOLUME_STEP = 0.05;

const LANE_NAMES = ['SCRATCH', 'KEY 1', 'KEY 2', 'KEY 3', 'KEY 4', 'KEY 5', 'KEY 6', 'KEY 7'];

export function laneName(lane: number): string {
  return LANE_NAMES[lane] ?? `LANE ${lane}`;
}

/** Display name for the scratch secondary slot in notices/conflicts. */
export const SCRATCH_SECONDARY_NAME = 'SCRATCH (2ND)';

export type LaneSlot = 'primary' | 'secondary';

export type CaptureOutcome =
  | { kind: 'assigned'; lane: number; code: string }
  | { kind: 'cancelled' }
  | { kind: 'rejected-reserved'; code: string }
  | { kind: 'rejected-conflict'; code: string; conflictLane: number };

export type ActivateOutcome =
  | 'capture'
  | 'reset-all'
  | 'calibration'
  | 'stats'
  | 'export-records'
  | 'import-records'
  | 'none';

export interface SettingsModelOptions {
  /** Live shared object — mutated in place, never replaced. */
  values: SettingsValues;
  /** Called after every persisted-value change (write-through, MUST 11). */
  onPersist(): void;
  /** Called after a volume actually changed (live GainNode apply + effects preview). */
  onVolumesChanged(channel: VolumeChannel): void;
}

export interface SettingsModel {
  rows(): readonly SettingsRow[];
  focusIndex(): number;
  focusedRow(): SettingsRow;
  /** Clamps to the row list; cancels an active capture (mouse moved on). */
  setFocus(index: number): void;
  moveFocus(delta: number): void;
  /** Lane currently in key-capture mode, or null (MUST 6). */
  capturingLane(): number | null;
  /** Which slot of the capturing lane, or null when not capturing. Only the
   *  scratch lane ever captures 'secondary' (settings-screen.md MUST 15). */
  capturingSlot(): LaneSlot | null;
  /** Lane to highlight after a duplicate-key rejection, or null (MUST 7). */
  conflictLane(): number | null;
  /** One-line status/rejection message for the screen, or null. */
  notice(): string | null;
  /**
   * Screen-owned outcomes (e.g. export/import results) surface through the same
   * notice line; cleared like any other feedback on the next focus move.
   */
  setNotice(message: string | null): void;
  /** Enter on the focused row. */
  activate(): ActivateOutcome;
  /** A keydown while capturing. Escape cancels capture only (MUST 9/10). */
  captureKey(code: string): CaptureOutcome;
  cancelCapture(): void;
  /** Enter capture mode for the scratch secondary slot (settings-screen.md MUST 15). */
  beginSecondaryCapture(): void;
  /** Unbind the scratch secondary (the slot may be empty — MUST 15). */
  clearScratchSecondary(): void;
  resetLane(lane: number): void;
  resetAllLanes(): void;
  /** ←/→ on the focused row; returns whether the row is adjustable. */
  adjustFocused(direction: 1 | -1, coarse: boolean): boolean;
  setOffset(ms: number): void;
  /** value in [0, 1]. */
  setVolume(channel: VolumeChannel, value: number): void;
}

function buildRows(): SettingsRow[] {
  const rows: SettingsRow[] = [];
  // Scratch first, then keys 1-7 (MUST 5 ordering).
  for (let lane = 0; lane < LANE_COUNT_TOTAL; lane++) {
    rows.push({ kind: 'lane', lane });
  }
  rows.push(
    { kind: 'resetAll' },
    { kind: 'offset' },
    { kind: 'volume', channel: 'master' },
    { kind: 'volume', channel: 'music' },
    { kind: 'volume', channel: 'effects' },
    { kind: 'calibration' },
    // Records section (settings-screen.md SHOULD 13, results-records.md SHOULD 10/11):
    // the stats view and the export/import entry points live here — the screen enum
    // stays closed (app-shell-navigation.md MUST 1), same precedent as calibration.
    { kind: 'stats' },
    { kind: 'exportRecords' },
    { kind: 'importRecords' },
  );
  return rows;
}

export function createSettingsModel(opts: SettingsModelOptions): SettingsModel {
  const { values } = opts;
  const rows = buildRows();

  let focus = 0;
  let capturing: number | null = null;
  let capturingSecondary = false;
  let conflict: number | null = null;
  let notice: string | null = null;

  function clearFeedback(): void {
    conflict = null;
    notice = null;
  }

  function endCapture(): void {
    capturing = null;
    capturingSecondary = false;
  }

  function focusedRow(): SettingsRow {
    const row = rows[focus];
    if (row === undefined) throw new Error(`settings focus out of range: ${focus}`);
    return row;
  }

  function setFocus(index: number): void {
    endCapture();
    clearFeedback();
    focus = Math.min(rows.length - 1, Math.max(0, index));
  }

  function moveFocus(delta: number): void {
    if (capturing !== null) return;
    setFocus(focus + delta);
  }

  function activate(): ActivateOutcome {
    if (capturing !== null) return 'none';
    const row = focusedRow();
    switch (row.kind) {
      case 'lane':
        clearFeedback();
        capturing = row.lane;
        return 'capture';
      case 'resetAll':
        resetAllLanes();
        return 'reset-all';
      case 'calibration':
        clearFeedback();
        return 'calibration';
      case 'stats':
        clearFeedback();
        return 'stats';
      case 'exportRecords':
        clearFeedback();
        return 'export-records';
      case 'importRecords':
        clearFeedback();
        return 'import-records';
      default:
        // Offset/volume rows have no Enter action — they adjust with ←/→.
        return 'none';
    }
  }

  function captureKey(code: string): CaptureOutcome {
    const lane = capturing;
    if (lane === null) return { kind: 'cancelled' };
    const secondary = capturingSecondary;
    if (code === 'Escape') {
      // Escape cancels the capture only, with no rejection reason (MUST 9/10).
      endCapture();
      clearFeedback();
      return { kind: 'cancelled' };
    }
    if (RESERVED_LANE_CODES.has(code)) {
      conflict = null;
      notice = `${code} is reserved for in-play controls and cannot be bound`;
      return { kind: 'rejected-reserved', code };
    }
    // Duplicate rule spans the WHOLE map, secondary included — all codes must
    // be mutually unique, max 9 (input-handling.md MUST 14).
    const existing = values.keyMapLanes.indexOf(code);
    if (secondary) {
      if (existing !== -1) {
        conflict = existing;
        notice = `${code} is already bound to ${laneName(existing)}`;
        return { kind: 'rejected-conflict', code, conflictLane: existing };
      }
      // Re-pressing the current secondary code is an idempotent re-assign.
      values.keyMapScratchSecondary = code;
      endCapture();
      clearFeedback();
      notice = `${SCRATCH_SECONDARY_NAME} bound to ${code}`;
      opts.onPersist();
      return { kind: 'assigned', lane, code };
    }
    if (existing !== -1 && existing !== lane) {
      conflict = existing;
      notice = `${code} is already bound to ${laneName(existing)}`;
      return { kind: 'rejected-conflict', code, conflictLane: existing };
    }
    if (existing === -1 && code === values.keyMapScratchSecondary) {
      // Conflicts with the secondary slot: highlight the scratch row (lane 0
      // hosts both slots) and name the slot in the notice.
      conflict = 0;
      notice = `${code} is already bound to ${SCRATCH_SECONDARY_NAME}`;
      return { kind: 'rejected-conflict', code, conflictLane: 0 };
    }
    values.keyMapLanes[lane] = code;
    endCapture();
    clearFeedback();
    notice = `${laneName(lane)} bound to ${code}`;
    opts.onPersist();
    return { kind: 'assigned', lane, code };
  }

  function cancelCapture(): void {
    if (capturing === null) return;
    endCapture();
    clearFeedback();
  }

  function beginSecondaryCapture(): void {
    clearFeedback();
    capturing = 0;
    capturingSecondary = true;
  }

  function clearScratchSecondary(): void {
    endCapture();
    clearFeedback();
    if (values.keyMapScratchSecondary === null) {
      notice = `${SCRATCH_SECONDARY_NAME} is not bound`;
      return;
    }
    values.keyMapScratchSecondary = null;
    notice = `${SCRATCH_SECONDARY_NAME} unbound`;
    opts.onPersist();
  }

  function resetLane(lane: number): void {
    const defaultCode = DEFAULT_KEY_MAP.lanes[lane];
    if (defaultCode === undefined) return;
    const existing = values.keyMapLanes.indexOf(defaultCode);
    if (existing !== -1 && existing !== lane) {
      conflict = existing;
      notice = `cannot reset ${laneName(lane)}: ${defaultCode} is bound to ${laneName(existing)}`;
      return;
    }
    // Scratch reset clears the secondary too (MUST 15), so its own default can
    // never collide there; for other lanes the secondary is a real conflict.
    if (lane !== 0 && defaultCode === values.keyMapScratchSecondary) {
      conflict = 0;
      notice = `cannot reset ${laneName(lane)}: ${defaultCode} is bound to ${SCRATCH_SECONDARY_NAME}`;
      return;
    }
    values.keyMapLanes[lane] = defaultCode;
    if (lane === 0) values.keyMapScratchSecondary = null;
    clearFeedback();
    notice =
      lane === 0
        ? `${laneName(lane)} reset to ${defaultCode} (secondary cleared)`
        : `${laneName(lane)} reset to ${defaultCode}`;
    opts.onPersist();
  }

  function resetAllLanes(): void {
    values.keyMapLanes.length = 0;
    values.keyMapLanes.push(...DEFAULT_KEY_MAP.lanes);
    // Default mapping has no secondary bound (input-handling.md MUST 12).
    values.keyMapScratchSecondary = null;
    clearFeedback();
    notice = 'all keys reset to defaults';
    opts.onPersist();
  }

  function setOffset(ms: number): void {
    const next = clampGlobalOffsetMs(Math.round(ms));
    if (next === values.globalOffsetMs) return;
    values.globalOffsetMs = next;
    clearFeedback();
    opts.onPersist();
  }

  function setVolume(channel: VolumeChannel, value: number): void {
    // Round to whole percent so repeated 5% keyboard steps can't accumulate float dust.
    const next = Math.round(clampVolume(value) * 100) / 100;
    if (next === values.volumes[channel]) return;
    values.volumes[channel] = next;
    clearFeedback();
    opts.onPersist();
    opts.onVolumesChanged(channel);
  }

  function adjustFocused(direction: 1 | -1, coarse: boolean): boolean {
    if (capturing !== null) return false;
    const row = focusedRow();
    if (row.kind === 'offset') {
      const step = coarse ? OFFSET_STEP_COARSE_MS : OFFSET_STEP_FINE_MS;
      setOffset(values.globalOffsetMs + direction * step);
      return true;
    }
    if (row.kind === 'volume') {
      setVolume(row.channel, values.volumes[row.channel] + direction * VOLUME_STEP);
      return true;
    }
    return false;
  }

  return {
    rows: () => rows,
    focusIndex: () => focus,
    focusedRow,
    setFocus,
    moveFocus,
    capturingLane: () => capturing,
    capturingSlot: () => (capturing === null ? null : capturingSecondary ? 'secondary' : 'primary'),
    conflictLane: () => conflict,
    notice: () => notice,
    setNotice: (message) => {
      notice = message;
    },
    activate,
    captureKey,
    cancelCapture,
    beginSecondaryCapture,
    clearScratchSecondary,
    resetLane,
    resetAllLanes,
    adjustFocused,
    setOffset,
    setVolume,
  };
}
