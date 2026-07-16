import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEY_MAP, isValidKeyMap } from '../play/input';
import {
  OFFSET_STEP_COARSE_MS,
  type SettingsValues,
  VOLUME_STEP,
  createSettingsModel,
  laneName,
} from './model';

function makeValues(overrides: Partial<SettingsValues> = {}): SettingsValues {
  return {
    globalOffsetMs: 0,
    volumes: { master: 1, music: 1, effects: 1 },
    keyMapLanes: [...DEFAULT_KEY_MAP.lanes],
    ...overrides,
  };
}

function makeModel(values: SettingsValues = makeValues()) {
  const onPersist = vi.fn();
  const onVolumesChanged = vi.fn();
  const model = createSettingsModel({ values, onPersist, onVolumesChanged });
  return { model, values, onPersist, onVolumesChanged };
}

// Row indices (fixed layout): 0..7 lanes, 8 resetAll, 9 offset,
// 10..12 volumes (master/music/effects), 13 calibration.
const ROW_RESET_ALL = 8;
const ROW_OFFSET = 9;
const ROW_VOLUME_MASTER = 10;
const ROW_VOLUME_EFFECTS = 12;
const ROW_CALIBRATION = 13;

describe('row layout', () => {
  it('lists scratch then keys 1-7 first (settings-screen.md MUST 5 order), then the value rows', () => {
    const { model } = makeModel();
    const rows = model.rows();
    expect(rows).toHaveLength(14);
    for (let lane = 0; lane < 8; lane++) {
      expect(rows[lane]).toEqual({ kind: 'lane', lane });
    }
    expect(rows[ROW_RESET_ALL]).toEqual({ kind: 'resetAll' });
    expect(rows[ROW_OFFSET]).toEqual({ kind: 'offset' });
    expect(rows[ROW_VOLUME_MASTER]).toEqual({ kind: 'volume', channel: 'master' });
    expect(rows[11]).toEqual({ kind: 'volume', channel: 'music' });
    expect(rows[ROW_VOLUME_EFFECTS]).toEqual({ kind: 'volume', channel: 'effects' });
    expect(rows[ROW_CALIBRATION]).toEqual({ kind: 'calibration' });
  });

  it('laneName maps scratch and keys', () => {
    expect(laneName(0)).toBe('SCRATCH');
    expect(laneName(1)).toBe('KEY 1');
    expect(laneName(7)).toBe('KEY 7');
  });
});

describe('focus movement', () => {
  it('clamps at both ends', () => {
    const { model } = makeModel();
    model.moveFocus(-1);
    expect(model.focusIndex()).toBe(0);
    model.moveFocus(99);
    expect(model.focusIndex()).toBe(ROW_CALIBRATION);
    model.moveFocus(1);
    expect(model.focusIndex()).toBe(ROW_CALIBRATION);
  });

  it('is ignored while capturing (screen routes keys to capture first anyway)', () => {
    const { model } = makeModel();
    expect(model.activate()).toBe('capture');
    model.moveFocus(1);
    expect(model.focusIndex()).toBe(0);
    expect(model.capturingLane()).toBe(0);
  });

  it('clears the notice/conflict feedback', () => {
    const { model } = makeModel();
    model.activate();
    model.captureKey('KeyS'); // conflict with KEY 1
    expect(model.notice()).not.toBeNull();
    model.cancelCapture();
    model.moveFocus(1);
    expect(model.notice()).toBeNull();
    expect(model.conflictLane()).toBeNull();
  });
});

describe('key capture (input-handling.md MUST 7-8, settings-screen.md MUST 6-7, 10)', () => {
  it('Enter on a lane row starts capture; a fresh code is assigned and persisted', () => {
    const { model, values, onPersist } = makeModel();
    expect(model.activate()).toBe('capture');
    expect(model.capturingLane()).toBe(0);
    const outcome = model.captureKey('KeyZ');
    expect(outcome).toEqual({ kind: 'assigned', lane: 0, code: 'KeyZ' });
    expect(values.keyMapLanes[0]).toBe('KeyZ');
    expect(model.capturingLane()).toBeNull();
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(isValidKeyMap({ lanes: values.keyMapLanes })).toBe(true);
  });

  it('rejects every reserved in-play control code with a reason and stays capturing', () => {
    for (const code of ['PageUp', 'PageDown', 'Home', 'ArrowUp', 'ArrowDown']) {
      const { model, values, onPersist } = makeModel();
      model.activate();
      const outcome = model.captureKey(code);
      expect(outcome).toEqual({ kind: 'rejected-reserved', code });
      expect(model.capturingLane()).toBe(0);
      expect(model.notice()).toContain('reserved');
      expect(values.keyMapLanes[0]).toBe('ShiftLeft');
      expect(onPersist).not.toHaveBeenCalled();
    }
  });

  it('Escape cancels the capture with no rejection reason', () => {
    const { model, values, onPersist } = makeModel();
    model.activate();
    const outcome = model.captureKey('Escape');
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(model.capturingLane()).toBeNull();
    expect(model.notice()).toBeNull();
    expect(values.keyMapLanes[0]).toBe('ShiftLeft');
    expect(onPersist).not.toHaveBeenCalled();
  });

  it('rejects a code already bound to another lane and highlights it', () => {
    const { model, values, onPersist } = makeModel();
    model.activate(); // capture on SCRATCH
    const outcome = model.captureKey('KeyS'); // KEY 1's binding
    expect(outcome).toEqual({ kind: 'rejected-conflict', code: 'KeyS', conflictLane: 1 });
    expect(model.conflictLane()).toBe(1);
    expect(model.notice()).toContain('KEY 1');
    expect(model.capturingLane()).toBe(0); // still capturing — user can try another key
    expect(values.keyMapLanes[0]).toBe('ShiftLeft');
    expect(onPersist).not.toHaveBeenCalled();
  });

  it('re-pressing the lane’s own current key is an idempotent assignment', () => {
    const { model, values } = makeModel();
    model.activate();
    const outcome = model.captureKey('ShiftLeft');
    expect(outcome).toEqual({ kind: 'assigned', lane: 0, code: 'ShiftLeft' });
    expect(values.keyMapLanes[0]).toBe('ShiftLeft');
    expect(isValidKeyMap({ lanes: values.keyMapLanes })).toBe(true);
  });

  it('setFocus (mouse click elsewhere) cancels an active capture', () => {
    const { model } = makeModel();
    model.activate();
    model.setFocus(ROW_OFFSET);
    expect(model.capturingLane()).toBeNull();
    expect(model.focusIndex()).toBe(ROW_OFFSET);
  });
});

describe('per-lane and all-lane reset (settings-screen.md MUST 8)', () => {
  it('resets a rebound lane to its default and persists', () => {
    const { model, values, onPersist } = makeModel();
    model.setFocus(1);
    model.activate();
    model.captureKey('KeyZ');
    expect(values.keyMapLanes[1]).toBe('KeyZ');
    model.resetLane(1);
    expect(values.keyMapLanes[1]).toBe('KeyS');
    expect(onPersist).toHaveBeenCalledTimes(2);
  });

  it('refuses a per-lane reset that would duplicate a default code held by another lane', () => {
    const { model, values } = makeModel();
    // Free KeyS from lane 1, then give it to lane 2. Resetting lane 1 would now collide.
    model.setFocus(1);
    model.activate();
    model.captureKey('KeyX');
    model.setFocus(2);
    model.activate();
    model.captureKey('KeyS');
    expect(values.keyMapLanes).toEqual([
      'ShiftLeft',
      'KeyX',
      'KeyS',
      'KeyF',
      'Space',
      'KeyJ',
      'KeyK',
      'KeyL',
    ]);
    model.resetLane(1);
    expect(values.keyMapLanes[1]).toBe('KeyX'); // unchanged
    expect(model.conflictLane()).toBe(2);
    expect(model.notice()).toContain('KEY 2');
    expect(isValidKeyMap({ lanes: values.keyMapLanes })).toBe(true);
  });

  it('reset-all restores the full default map in place (same array reference)', () => {
    const { model, values, onPersist } = makeModel();
    const ref = values.keyMapLanes;
    model.activate();
    model.captureKey('KeyZ');
    model.setFocus(ROW_RESET_ALL);
    expect(model.activate()).toBe('reset-all');
    expect(values.keyMapLanes).toEqual([...DEFAULT_KEY_MAP.lanes]);
    expect(values.keyMapLanes).toBe(ref); // mutated in place — the shell holds this reference
    expect(onPersist).toHaveBeenCalledTimes(2);
  });
});

describe('global offset (audio-playback.md MUST 7)', () => {
  it('steps ±1ms fine and ±10ms coarse via adjustFocused', () => {
    const { model, values, onPersist } = makeModel();
    model.setFocus(ROW_OFFSET);
    expect(model.adjustFocused(1, false)).toBe(true);
    expect(values.globalOffsetMs).toBe(1);
    expect(model.adjustFocused(1, true)).toBe(true);
    expect(values.globalOffsetMs).toBe(1 + OFFSET_STEP_COARSE_MS);
    expect(model.adjustFocused(-1, false)).toBe(true);
    expect(values.globalOffsetMs).toBe(OFFSET_STEP_COARSE_MS);
    expect(onPersist).toHaveBeenCalledTimes(3);
  });

  it('clamps to ±200 and rounds to integer ms; unchanged values do not persist', () => {
    const { model, values, onPersist } = makeModel();
    model.setOffset(1000);
    expect(values.globalOffsetMs).toBe(200);
    model.setOffset(200.4);
    expect(values.globalOffsetMs).toBe(200); // same after round+clamp — no extra write
    expect(onPersist).toHaveBeenCalledTimes(1);
    model.setOffset(-987.6);
    expect(values.globalOffsetMs).toBe(-200);
    model.setOffset(12.6);
    expect(values.globalOffsetMs).toBe(13);
  });

  it('adjustFocused returns false on non-adjustable rows', () => {
    const { model } = makeModel();
    model.setFocus(0);
    expect(model.adjustFocused(1, false)).toBe(false);
    model.setFocus(ROW_CALIBRATION);
    expect(model.adjustFocused(1, false)).toBe(false);
  });
});

describe('volumes (audio-playback.md MUST 9, settings-screen.md MUST 3)', () => {
  it('steps by 5% via adjustFocused and notifies the live-apply hook', () => {
    const { model, values, onPersist, onVolumesChanged } = makeModel();
    model.setFocus(ROW_VOLUME_MASTER);
    model.adjustFocused(-1, false);
    expect(values.volumes.master).toBeCloseTo(1 - VOLUME_STEP, 10);
    expect(onVolumesChanged).toHaveBeenCalledWith('master');
    expect(onPersist).toHaveBeenCalledTimes(1);
  });

  it('clamps to [0,1]; a clamped-to-same value neither persists nor notifies', () => {
    const { model, values, onPersist, onVolumesChanged } = makeModel();
    model.setFocus(ROW_VOLUME_MASTER);
    model.adjustFocused(1, false); // already at 100%
    expect(values.volumes.master).toBe(1);
    expect(onPersist).not.toHaveBeenCalled();
    expect(onVolumesChanged).not.toHaveBeenCalled();
    for (let i = 0; i < 30; i++) model.adjustFocused(-1, false);
    expect(values.volumes.master).toBe(0);
  });

  it('setVolume (slider path) stores whole percents and notifies the channel', () => {
    const { model, values, onVolumesChanged } = makeModel();
    model.setVolume('effects', 0.37);
    expect(values.volumes.effects).toBe(0.37);
    expect(onVolumesChanged).toHaveBeenCalledWith('effects');
    model.setVolume('effects', 0.371111);
    expect(values.volumes.effects).toBe(0.37); // rounds to same percent — no change
    expect(onVolumesChanged).toHaveBeenCalledTimes(1);
  });
});

describe('activate outcomes', () => {
  it('returns calibration on the calibration row and none on value rows', () => {
    const { model } = makeModel();
    model.setFocus(ROW_CALIBRATION);
    expect(model.activate()).toBe('calibration');
    model.setFocus(ROW_OFFSET);
    expect(model.activate()).toBe('none');
    model.setFocus(ROW_VOLUME_EFFECTS);
    expect(model.activate()).toBe('none');
  });
});
