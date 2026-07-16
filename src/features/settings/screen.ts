// Unified settings screen (specs/settings-screen.md MUST 1-11, SHOULD 12).
//
// DOM screen (app-shell-navigation.md MUST 13). The row skeleton is built once
// and render() only updates text/classes/slider values — rebuilding a range
// slider mid-drag would kill the drag. All interaction rules live in the
// headless model (model.ts); this module is presentation plus the two
// audio-touching pieces the model must not own: the live volume apply /
// effects-preview click (MUST 3, 11) and the calibration click loop
// (SHOULD 12), both through the shared effects bus.
//
// Keyboard scope follows app-shell-navigation.md MUST 17: a focused native
// widget (slider/button) owns the keys until Escape blurs it; key capture is
// an internal mode of the model, not DOM focus, and eats every key while
// active. Like the practice editor, the screen attaches its own document
// keydown listener on activate() and removes it on deactivate().

import type { VolumeSettings } from '../../lib/audio/context';
import {
  type MenuSfxKind,
  type SfxAudioContextLike,
  createSfxScheduler,
  synthClickBuffer,
} from '../../lib/audio/sfx';
import type { SfxScheduler } from '../../lib/audio/sfx';
import { type ClockSources, type SongClock, createSongClock } from '../../lib/clock/audioClock';
import {
  CALIBRATION_TAP_TARGET,
  type CalibrationSession,
  createCalibrationSession,
  initialLatencyEstimateMs,
} from './calibration';
import {
  type SettingsModel,
  type SettingsRow,
  type SettingsValues,
  createSettingsModel,
  laneName,
} from './model';

/** Audio plumbing the screen needs; null until the title-screen gesture unlock. */
export interface SettingsAudio {
  sfxCtx: SfxAudioContextLike;
  effectsBus: AudioNode;
  clockSources: ClockSources;
  getOutputLatencySec(): number | undefined;
}

export interface SettingsScreenOptions {
  mount: HTMLElement;
  /** The live settings object shared with the shell/session starts. */
  values: SettingsValues;
  onPersist(): void;
  /** Live GainNode apply — volume changes are audible immediately (MUST 11). */
  applyVolumes(volumes: VolumeSettings): void;
  getAudio(): SettingsAudio | null;
  /**
   * Menu cue hook (audio-playback.md MUST 8). This screen only emits
   * move/confirm — the cancel cue on exit belongs to the shell's onExit
   * handler, and value adjustments stay silent (volume rows already give live
   * audible feedback; a tick on top would double-sound them).
   */
  playMenuSfx?(kind: MenuSfxKind): void;
  onExit(): void;
}

export interface SettingsScreen {
  /** Attach keyboard handling; idempotent. */
  activate(): void;
  /** Detach keyboard handling; cancels any capture/calibration in flight. */
  deactivate(): void;
}

const EFFECT_PREVIEW_THROTTLE_MS = 150;
const CALIBRATION_LEAD_IN_SEC = 0.5;
const CALIBRATION_SCHEDULE_AHEAD_SEC = 1.2;
const CALIBRATION_TOPUP_INTERVAL_MS = 200;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatOffsetMs(ms: number): string {
  return `${ms >= 0 ? '+' : '−'}${Math.abs(ms)}ms`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const VOLUME_LABELS: Record<keyof VolumeSettings, string> = {
  master: 'MASTER',
  music: 'MUSIC',
  effects: 'EFFECTS',
};

export function createSettingsScreen(opts: SettingsScreenOptions): SettingsScreen {
  const { mount, values } = opts;
  let active = false;

  // --- effects preview click (MUST 3), throttled so slider drags don't machine-gun it ---
  let previewScheduler: SfxScheduler | null = null;
  let previewBuffer: AudioBuffer | null = null;
  let lastPreviewAt = Number.NEGATIVE_INFINITY;
  function playEffectPreview(): void {
    const audio = opts.getAudio();
    if (audio === null) return;
    const now = performance.now();
    if (now - lastPreviewAt < EFFECT_PREVIEW_THROTTLE_MS) return;
    lastPreviewAt = now;
    previewBuffer ??= synthClickBuffer(audio.sfxCtx, { frequencyHz: 1080 });
    previewScheduler ??= createSfxScheduler(audio.sfxCtx, audio.effectsBus);
    previewScheduler.schedule(previewBuffer, 0);
  }

  const model: SettingsModel = createSettingsModel({
    values,
    onPersist: opts.onPersist,
    onVolumesChanged(channel) {
      opts.applyVolumes(values.volumes);
      if (channel === 'effects') playEffectPreview();
    },
  });
  const rows = model.rows();

  // --- static DOM skeleton ----------------------------------------------------
  mount.appendChild(el('h1', undefined, 'SETTINGS'));
  const statusEl = el('div', 'settings-status');
  mount.appendChild(statusEl);

  const list = el('ul', 'settings-list');
  mount.appendChild(list);

  interface RowView {
    li: HTMLLIElement;
    value: HTMLSpanElement;
    slider?: HTMLInputElement;
  }
  const rowViews: RowView[] = [];
  const summaries = {
    keys: el('span', 'settings-summary'),
    offset: el('span', 'settings-summary'),
    volume: el('span', 'settings-summary'),
    calibration: el('span', 'settings-summary'),
  };

  function sectionHeader(title: string, summary: HTMLSpanElement): void {
    const li = el('li', 'settings-section');
    li.appendChild(el('span', undefined, title));
    li.appendChild(summary);
    list.appendChild(li);
  }

  function performActivate(): void {
    if (model.activate() === 'calibration') openCalibration();
  }

  function rowLabel(row: SettingsRow): string {
    switch (row.kind) {
      case 'lane':
        return laneName(row.lane);
      case 'resetAll':
        return 'ALL KEYS';
      case 'offset':
        return 'GLOBAL OFFSET';
      case 'volume':
        return VOLUME_LABELS[row.channel];
      case 'calibration':
        return 'CALIBRATION';
    }
  }

  rows.forEach((row, index) => {
    if (row.kind === 'lane' && row.lane === 0) sectionHeader('KEY CONFIG', summaries.keys);
    if (row.kind === 'offset') sectionHeader('JUDGEMENT OFFSET', summaries.offset);
    if (row.kind === 'volume' && row.channel === 'master')
      sectionHeader('VOLUME', summaries.volume);
    if (row.kind === 'calibration') sectionHeader('OFFSET CALIBRATION', summaries.calibration);

    const li = el('li', 'settings-row');
    li.dataset.row =
      row.kind === 'lane'
        ? `lane-${row.lane}`
        : row.kind === 'volume'
          ? `volume-${row.channel}`
          : row.kind;
    li.appendChild(el('span', 'settings-label', rowLabel(row)));
    const value = el('span', 'settings-value');
    li.appendChild(value);
    const view: RowView = { li, value };

    function smallButton(label: string, onClick: () => void): HTMLButtonElement {
      const btn = el('button', 'practice-btn small', label);
      btn.type = 'button';
      btn.addEventListener('click', (event) => {
        event.stopPropagation(); // keep the row's click handler out of it
        btn.blur(); // Enter/arrows go back to screen navigation (MUST 17)
        onClick();
        render();
      });
      return btn;
    }

    if (row.kind === 'lane') {
      li.appendChild(smallButton('RESET', () => model.resetLane(row.lane)));
    } else if (row.kind === 'resetAll') {
      li.appendChild(smallButton('RESET ALL TO DEFAULTS', () => model.resetAllLanes()));
    } else if (row.kind === 'offset') {
      const slider = el('input');
      slider.type = 'range';
      slider.min = '-200';
      slider.max = '200';
      slider.step = '1';
      slider.addEventListener('input', () => {
        model.setOffset(Number(slider.value));
        render();
      });
      li.appendChild(slider);
      view.slider = slider;
    } else if (row.kind === 'volume') {
      const slider = el('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.addEventListener('input', () => {
        model.setVolume(row.channel, Number(slider.value) / 100);
        render();
      });
      li.appendChild(slider);
      view.slider = slider;
    } else if (row.kind === 'calibration') {
      value.textContent = 'tap along with a steady click to measure your offset';
      li.appendChild(smallButton('START', () => performActivate()));
    }

    li.addEventListener('click', (event) => {
      // Sliders keep their own click/drag behavior; row click just focuses.
      const isSlider = event.target instanceof HTMLInputElement;
      model.setFocus(index);
      if (!isSlider && (row.kind === 'lane' || row.kind === 'calibration')) performActivate();
      render();
    });

    list.appendChild(li);
    rowViews[index] = view;
  });

  mount.appendChild(
    el(
      'div',
      'hint',
      '↑/↓ move · ENTER capture/apply · ←/→ adjust (+SHIFT ×10) · DEL reset key · ESC back to select',
    ),
  );

  // --- calibration modal (SHOULD 12; in-screen modal, not a screen-machine state) ---
  const modal = el('div', 'settings-modal');
  const modalCard = el('div', 'settings-modal-card');
  modalCard.appendChild(el('div', 'settings-modal-title', 'OFFSET CALIBRATION'));
  const modalBody = el('div', 'settings-modal-body');
  const modalHint = el('div', 'hint');
  modalCard.append(modalBody, modalHint);
  modal.appendChild(modalCard);
  mount.appendChild(modal);

  interface CalibrationRun {
    session: CalibrationSession;
    clock: SongClock;
    scheduler: SfxScheduler;
    clickBuffer: AudioBuffer;
    sfxCtx: SfxAudioContextLike;
    t0Sec: number;
    nextClickIndex: number;
    topUpTimer: number;
    latencyEstimateMs: number | null;
  }
  let calRun: CalibrationRun | null = null;

  function topUpClicks(): void {
    const run = calRun;
    if (run === null || run.session.state().done) return;
    const periodSec = run.session.periodMs / 1000;
    const horizonSec = run.sfxCtx.currentTime + CALIBRATION_SCHEDULE_AHEAD_SEC;
    while (run.t0Sec + run.nextClickIndex * periodSec < horizonSec) {
      run.scheduler.schedule(run.clickBuffer, run.t0Sec + run.nextClickIndex * periodSec);
      run.nextClickIndex++;
    }
  }

  function openCalibration(): void {
    if (calRun !== null) return;
    const audio = opts.getAudio();
    if (audio === null) {
      statusEl.textContent = 'audio is not unlocked — cannot calibrate';
      return;
    }
    // Offset-free clock: the measured mean IS the proposed offset (see calibration.ts).
    const clock = createSongClock(audio.clockSources, {});
    const t0Sec = audio.sfxCtx.currentTime + CALIBRATION_LEAD_IN_SEC;
    clock.start(t0Sec);
    calRun = {
      session: createCalibrationSession(),
      clock,
      scheduler: createSfxScheduler(audio.sfxCtx, audio.effectsBus),
      clickBuffer: synthClickBuffer(audio.sfxCtx, { frequencyHz: 1440, durationSec: 0.05 }),
      sfxCtx: audio.sfxCtx,
      t0Sec,
      nextClickIndex: 0,
      topUpTimer: 0,
      latencyEstimateMs: initialLatencyEstimateMs(audio.getOutputLatencySec()),
    };
    topUpClicks();
    calRun.topUpTimer = window.setInterval(topUpClicks, CALIBRATION_TOPUP_INTERVAL_MS);
    modal.classList.add('visible');
    renderCalibration();
  }

  function closeCalibration(apply: boolean): void {
    const run = calRun;
    if (run === null) return;
    if (apply) {
      const proposed = run.session.state().proposedOffsetMs;
      if (proposed !== null) model.setOffset(proposed);
    }
    window.clearInterval(run.topUpTimer);
    run.scheduler.cancelAll();
    calRun = null;
    modal.classList.remove('visible');
    render();
  }

  function stopClicks(run: CalibrationRun): void {
    window.clearInterval(run.topUpTimer);
    run.scheduler.cancelAll();
  }

  function handleCalibrationKey(event: KeyboardEvent): void {
    event.preventDefault();
    if (event.repeat) return;
    const run = calRun;
    if (run === null) return;
    if (event.code === 'Escape') {
      closeCalibration(false);
      return;
    }
    const before = run.session.state();
    if (before.done) {
      if (event.code === 'Enter') closeCalibration(true);
      return;
    }
    if (event.code === 'Enter') return; // apply-only key, never counted as a tap
    const raw = run.clock.eventTimeToSongTimeMs(event.timeStamp);
    const after = run.session.addTap(raw);
    if (after.done) stopClicks(run); // measurement over — silence, show the proposal
    renderCalibration();
  }

  function renderCalibration(): void {
    const run = calRun;
    if (run === null) return;
    const st = run.session.state();
    modalBody.textContent = '';
    if (st.done) {
      modalBody.appendChild(
        el('div', 'settings-cal-count', formatOffsetMs(st.proposedOffsetMs ?? 0)),
      );
      modalBody.appendChild(
        el(
          'div',
          undefined,
          `mean error over ${st.tapCount} taps: ${(st.meanErrorMs ?? 0).toFixed(1)}ms`,
        ),
      );
      modalBody.appendChild(el('div', undefined, 'apply as the new global offset?'));
      modalHint.textContent = 'ENTER apply · ESC cancel';
    } else {
      modalBody.appendChild(el('div', 'settings-cal-count', `${st.tapCount} / ${st.tapTarget}`));
      modalBody.appendChild(
        el('div', undefined, `tap any key on each click (${run.session.bpm} BPM)`),
      );
      if (st.meanErrorMs !== null) {
        modalBody.appendChild(el('div', undefined, `running mean: ${st.meanErrorMs.toFixed(1)}ms`));
      }
      if (run.latencyEstimateMs !== null) {
        modalBody.appendChild(
          el(
            'div',
            undefined,
            `device output latency ≈ ${run.latencyEstimateMs}ms (initial estimate)`,
          ),
        );
      }
      modalHint.textContent = 'ESC cancel';
    }
  }

  // --- render (updates only; never rebuilds nodes) ------------------------------
  function render(): void {
    statusEl.textContent = model.notice() ?? '';
    const focusIndex = model.focusIndex();
    const capturing = model.capturingLane();
    const conflict = model.conflictLane();
    rows.forEach((row, index) => {
      const view = rowViews[index];
      if (view === undefined) return;
      view.li.classList.toggle('focused', index === focusIndex);
      view.li.classList.toggle('conflict', row.kind === 'lane' && row.lane === conflict);
      switch (row.kind) {
        case 'lane': {
          const isCapturing = row.lane === capturing;
          view.li.classList.toggle('capturing', isCapturing);
          view.value.textContent = isCapturing
            ? 'PRESS A KEY… (ESC cancels)'
            : (values.keyMapLanes[row.lane] ?? '');
          break;
        }
        case 'offset':
          view.value.textContent = formatOffsetMs(values.globalOffsetMs);
          if (view.slider !== undefined) view.slider.value = String(values.globalOffsetMs);
          break;
        case 'volume':
          view.value.textContent = percent(values.volumes[row.channel]);
          if (view.slider !== undefined) {
            view.slider.value = String(Math.round(values.volumes[row.channel] * 100));
          }
          break;
        default:
          break;
      }
    });
    // Section headers summarize current values (MUST 1).
    summaries.keys.textContent = values.keyMapLanes.join(' ');
    summaries.offset.textContent = formatOffsetMs(values.globalOffsetMs);
    summaries.volume.textContent = `MASTER ${percent(values.volumes.master)} · MUSIC ${percent(values.volumes.music)} · FX ${percent(values.volumes.effects)}`;
    summaries.calibration.textContent = `${CALIBRATION_TAP_TARGET} taps`;
  }

  // --- keyboard (attached while the screen is active) ---------------------------
  function handleKeyDown(event: KeyboardEvent): void {
    if (calRun !== null) {
      handleCalibrationKey(event);
      return;
    }
    if (model.capturingLane() !== null) {
      // Capture mode eats every key (MUST 6): the next keydown is an assignment
      // attempt, judged entirely by the model.
      event.preventDefault();
      if (event.repeat) return;
      model.captureKey(event.code);
      render();
      return;
    }
    const target = event.target as HTMLElement | null;
    const inWidget =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLButtonElement;
    if (inWidget) {
      // Focused widget owns the keys (app-shell-navigation.md MUST 17); Escape blurs.
      if (event.code === 'Escape') {
        event.preventDefault();
        target.blur();
      }
      return;
    }
    switch (event.code) {
      case 'Escape':
        event.preventDefault();
        opts.onExit();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        event.preventDefault();
        model.moveFocus(event.code === 'ArrowDown' ? 1 : -1);
        opts.playMenuSfx?.('move');
        render();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        event.preventDefault();
        model.adjustFocused(event.code === 'ArrowRight' ? 1 : -1, event.shiftKey);
        render();
        break;
      case 'Enter':
        event.preventDefault();
        opts.playMenuSfx?.('confirm');
        performActivate();
        render();
        break;
      case 'Delete':
      case 'Backspace': {
        const row = model.focusedRow();
        if (row.kind === 'lane') {
          event.preventDefault();
          model.resetLane(row.lane);
          render();
        }
        break;
      }
      default:
        break;
    }
  }

  render();

  return {
    activate(): void {
      if (active) return;
      active = true;
      document.addEventListener('keydown', handleKeyDown);
      render();
    },
    deactivate(): void {
      if (!active) return;
      active = false;
      document.removeEventListener('keydown', handleKeyDown);
      if (calRun !== null) closeCalibration(false);
      model.cancelCapture();
      render();
    },
  };
}
