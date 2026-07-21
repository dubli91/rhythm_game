// App shell: DOM screens (TITLE / SONG_SELECT / PRACTICE_EDIT / RESULTS), bootstrap, audio
// unlock, and the PLAY / PRACTICE_PLAY hand-offs to their session controllers
// (specs/app-shell-navigation.md).
//
// DOM screens render via plain DOM; only PLAY/PRACTICE_PLAY use the PixiJS canvas (MUST 13).
// The screen state machine (screens.ts) owns legality of transitions; this module owns
// presentation.

import {
  type PlayResult,
  type PlaySessionAudio,
  startPlaySession,
} from '../features/play/controller';
import type { ClearLamp } from '../features/play/gauge';
import { DEFAULT_KEY_MAP, type LaneKeyMap, isValidKeyMap } from '../features/play/input';
import {
  ARRANGEMENTS,
  GREEN_TARGET_DEFAULT,
  HI_SPEED_MAX,
  HI_SPEED_MIN,
  HI_SPEED_STEP,
  TIMING_DISPLAY_MODES,
  clampGreenTarget,
  nextArrangement,
  nextTimingDisplay,
  stepCover,
  stepGreenTarget,
  timingDisplayLabel,
} from '../features/play/options';
import { greenNumberFor, lockedHiSpeedFor } from '../features/play/render';
import { type SongAudioContextLike, createSongPlayer } from '../features/play/songPlayer';
import {
  type Arrangement,
  GAUGE_TYPES,
  type GaugeType,
  type TimingDisplayMode,
} from '../features/play/types';
import { startPracticeSession } from '../features/practice/controller';
import { type PracticeEditor, createPracticeEditor } from '../features/practice/editor';
import type { PracticePattern } from '../features/practice/pattern';
import { formatMeanDelta } from '../features/practice/stats';
import { type StatsChartRef, aggregatePlayerStats } from '../features/records/stats';
import { type RecordUpdateOutcome, openRecordsStore } from '../features/records/store';
import {
  type PlayRequest,
  type RecordLookup,
  type SelectModel,
  type SortMode,
  type ViewMode,
  createSelectModel,
  isSortMode,
  isViewMode,
} from '../features/select/model';
import {
  type PreviewAudioContextLike,
  type PreviewPlayer,
  type PreviewTarget,
  createPreviewPlayer,
} from '../features/select/preview';
import type { SettingsValues } from '../features/settings/model';
import { type SettingsScreen, createSettingsScreen } from '../features/settings/screen';
import { type SongLibrary, loadLibrary, loadPlayableSong } from '../features/songs/library';
import {
  type GameAudio,
  type VolumeSettings,
  clampVolume,
  createGameAudio,
} from '../lib/audio/context';
import {
  type MenuSfx,
  type MenuSfxKind,
  type SfxAudioContextLike,
  createMenuSfx,
} from '../lib/audio/sfx';
import type { Chart, Song } from '../lib/chart/types';
import { clampGlobalOffsetMs } from '../lib/clock/audioClock';
import { openDatabase } from '../lib/storage/idb';
import { type LocalDoc, STORAGE_KEYS, createLocalDoc } from '../lib/storage/local';
import { type ScreenId, createScreenMachine } from './screens';

interface PlayOptionsDoc {
  gaugeType: GaugeType;
  autoplay: boolean;
  hiSpeed: number;
  arrangement: Arrangement;
  suddenPlusEnabled: boolean;
  /** 0..80 (%) */
  suddenPlusCover: number;
  /** Green-number lock / floating hi-speed (play-options.md MUST 15-17). */
  greenLockEnabled: boolean;
  /** 200..2000ms, 10ms steps. */
  greenLockTargetMs: number;
  /** FAST/SLOW indicator mode (play-options.md MUST 18); display-only. */
  timingDisplay: TimingDisplayMode;
}

// The settings.v1 doc shape is owned by the settings feature (single source of
// truth) — the shell only adds the storage validator below.
type SettingsDoc = SettingsValues;

/** Select-screen preferences persisted separately from play options (song-select.md MUST 4).
 * The search filter is deliberately NOT persisted — a stale filter would silently hide
 * songs on the next boot (decision recorded in select/model.ts). */
interface SelectDoc {
  sortMode: SortMode;
  viewMode: ViewMode;
}

interface LoadedPlayData {
  song: Song;
  chart: Chart;
  audio: PlaySessionAudio;
}

const STYLES = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #0a0a12; color: #e8e8f0; font-family: 'Segoe UI', system-ui, sans-serif; }
  #app { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .screen { display: none; width: min(960px, 92vw); }
  .screen.active { display: block; }
  .screen-play { width: 100vw; height: 100vh; display: none; align-items: center; justify-content: center; }
  .screen-play.active { display: flex; }
  h1 { font-size: 44px; letter-spacing: 0.28em; margin: 0 0 8px; color: #7df3ff; text-shadow: 0 0 24px #2fd8ff66; }
  .subtitle { color: #8a8aa8; letter-spacing: 0.12em; margin-bottom: 42px; }
  .press-key { font-size: 20px; color: #ffe066; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .boot-note { margin-top: 28px; color: #55557a; font-size: 13px; }
  .song-list { list-style: none; margin: 0 0 18px; padding: 0; max-height: 52vh; overflow-y: auto; }
  .song-list li { padding: 10px 16px; border-left: 4px solid transparent; display: flex; gap: 14px; align-items: baseline; cursor: pointer; }
  .song-list li.selected { background: #16182b; border-left-color: #7df3ff; }
  .song-list li.chart-row { padding: 7px 16px 7px 44px; }
  .song-list .expander { color: #55557a; font-size: 12px; width: 12px; }
  .song-list .title { font-size: 17px; }
  .song-list .meta { color: #8a8aa8; font-size: 13px; }
  .song-list .diff { font-weight: 700; font-size: 13px; padding: 1px 8px; border-radius: 3px; }
  .source-badge { margin-left: auto; font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: #55557a; border: 1px solid #2a2a44; border-radius: 3px; padding: 1px 6px; }
  .record { margin-left: auto; display: flex; gap: 10px; align-items: baseline; font-size: 13px; color: #8a8aa8; }
  .lamp { font-size: 10px; font-weight: 800; letter-spacing: 0.06em; border-radius: 3px; padding: 2px 7px; background: #1c1c2e; }
  .lamp-NO_PLAY { color: #55557a; }
  .lamp-FAILED { color: #ff5f7a; }
  .lamp-ASSIST_CLEAR { color: #c084fc; }
  .lamp-EASY_CLEAR { color: #7dff9a; }
  .lamp-CLEAR { color: #6fd0ff; }
  .lamp-HARD_CLEAR { color: #f4f4ff; }
  .lamp-EX_HARD_CLEAR { color: #ffe066; }
  .lamp-FULL_COMBO { color: #10101c; background: linear-gradient(90deg, #ff5f7a, #ffe066, #6ffce0, #7df3ff); }
  .sort-line { color: #55557a; font-size: 12px; letter-spacing: 0.14em; margin-bottom: 8px; }
  .sort-line b { color: #7df3ff; }
  .search-line { display: flex; gap: 10px; align-items: center; color: #55557a; font-size: 12px; letter-spacing: 0.14em; margin-bottom: 8px; }
  .select-search { background: #10101c; border: 1px solid #2a2a44; border-radius: 4px; color: #e8e8f0; padding: 4px 10px; font-size: 13px; width: 220px; font-family: inherit; }
  .select-search:focus { outline: none; border-color: #7df3ff; }
  .song-list .folder-title { color: #ffc24a; font-weight: 700; letter-spacing: 0.12em; }
  .diff-NORMAL { color: #6fd0ff; border: 1px solid #6fd0ff55; }
  .diff-HYPER { color: #ffc24a; border: 1px solid #ffc24a55; }
  .diff-ANOTHER { color: #ff5f7a; border: 1px solid #ff5f7a55; }
  .diff-BEGINNER { color: #7dff9a; border: 1px solid #7dff9a55; }
  .options-bar { display: flex; gap: 24px; padding: 12px 16px; background: #10101c; border-radius: 6px; font-size: 14px; }
  .options-bar b { color: #7df3ff; }
  .hint { margin-top: 14px; color: #55557a; font-size: 13px; }
  .error-banner { display: none; margin-bottom: 14px; padding: 10px 14px; background: #3a1020; border: 1px solid #ff4455; border-radius: 6px; color: #ffb3bd; font-size: 14px; }
  .error-banner.visible { display: block; }
  .loading-overlay { position: fixed; inset: 0; background: #0a0a12dd; display: none; align-items: center; justify-content: center; font-size: 20px; letter-spacing: 0.2em; color: #7df3ff; z-index: 40; }
  .loading-overlay.visible { display: flex; }
  .result-status { font-size: 42px; font-weight: 800; letter-spacing: 0.18em; margin-bottom: 2px; }
  .result-status.clear { color: #6ffce0; text-shadow: 0 0 22px #2fd8b066; }
  .result-status.failed { color: #ff5f7a; text-shadow: 0 0 22px #ff445566; }
  .result-sub { color: #8a8aa8; margin-bottom: 26px; }
  .result-title { font-size: 20px; margin-bottom: 2px; }
  .result-chart { display: inline-block; font-weight: 700; font-size: 13px; padding: 1px 8px; border-radius: 3px; margin-bottom: 14px; }
  .result-grid { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 8px 40px; max-width: 560px; font-size: 15px; }
  .result-grid .row { display: flex; justify-content: space-between; border-bottom: 1px solid #1c1c2e; padding: 5px 0; }
  .result-grid .label { color: #8a8aa8; }
  .result-grid .value-wrap { display: flex; align-items: center; gap: 8px; }
  .result-diff { color: #6fd0ff; font-size: 12px; letter-spacing: 0.02em; }
  .new-record { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #241a00; background: #ffcc33; border-radius: 3px; padding: 2px 6px; text-shadow: none; }
  .result-rank { font-size: 64px; font-weight: 800; color: #ffe066; margin: 10px 0 20px; }
  .practice-status { min-height: 18px; color: #ffe066; font-size: 13px; margin-bottom: 10px; }
  .practice-controls { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-bottom: 10px; }
  .practice-controls label { display: flex; gap: 6px; align-items: center; font-size: 12px; color: #8a8aa8; letter-spacing: 0.08em; }
  .practice-controls input, .practice-controls select { background: #10101c; color: #e8e8f0; border: 1px solid #2a2a44; border-radius: 4px; padding: 4px 8px; font: inherit; font-size: 13px; }
  .practice-controls input[type=number] { width: 64px; }
  .practice-controls input[type=text] { width: 160px; }
  .practice-buttons { display: flex; gap: 10px; margin-bottom: 12px; }
  .practice-btn { background: #16182b; color: #7df3ff; border: 1px solid #2a2a44; border-radius: 4px; padding: 6px 14px; font: inherit; font-size: 13px; letter-spacing: 0.08em; cursor: pointer; }
  .practice-btn:hover { border-color: #7df3ff; }
  .practice-btn.small { padding: 2px 8px; font-size: 11px; }
  .practice-meta { color: #8a8aa8; font-size: 13px; margin-bottom: 6px; }
  .practice-grid-head { display: grid; grid-template-columns: 64px repeat(7, 44px); gap: 2px; font-size: 11px; color: #55557a; text-align: center; margin-bottom: 2px; }
  .practice-grid { display: grid; grid-template-columns: 64px repeat(7, 44px); gap: 2px; max-height: 38vh; overflow-y: auto; padding: 4px; background: #0a0a14; border-radius: 6px; align-content: start; }
  .pcell { height: 15px; background: #0c0c14; border-radius: 2px; cursor: pointer; }
  .pcell.beatstart { box-shadow: inset 0 -1px 0 #1a1e2a; }
  .pcell.barstart { box-shadow: inset 0 -2px 0 #2a2a44; }
  .pcell.note.lane-sc { background: #ff3344; }
  .pcell.note.lane-odd { background: #f0f0f5; }
  .pcell.note.lane-even { background: #3fa7ff; }
  .pcell.cursor { outline: 2px solid #ffe066; outline-offset: -2px; }
  .practice-list-title { color: #55557a; font-size: 12px; letter-spacing: 0.14em; margin: 14px 0 6px; }
  .practice-list { list-style: none; margin: 0; padding: 0; max-height: 18vh; overflow-y: auto; }
  .practice-list li { display: flex; gap: 12px; align-items: center; padding: 6px 10px; border-bottom: 1px solid #16182b; font-size: 13px; }
  .practice-list-name { min-width: 160px; }
  .practice-list-meta { color: #8a8aa8; margin-right: auto; }
  .practice-list-empty { color: #55557a; }
  .settings-status { min-height: 18px; color: #ffe066; font-size: 13px; margin-bottom: 6px; }
  .settings-list { list-style: none; margin: 0; padding: 0; }
  .settings-section { display: flex; justify-content: space-between; align-items: baseline; color: #55557a; font-size: 12px; letter-spacing: 0.14em; margin: 16px 0 4px; padding: 0 12px 4px; border-bottom: 1px solid #1c1c2e; }
  .settings-summary { color: #8a8aa8; letter-spacing: 0.02em; }
  .settings-row { display: flex; gap: 14px; align-items: center; padding: 6px 12px; border-left: 4px solid transparent; cursor: pointer; font-size: 14px; }
  .settings-row.focused { background: #16182b; border-left-color: #7df3ff; }
  .settings-row.conflict { background: #3a1020; border-left-color: #ff4455; }
  .settings-label { min-width: 150px; color: #8a8aa8; letter-spacing: 0.06em; }
  .settings-value { min-width: 220px; }
  .settings-row.capturing .settings-value { color: #ffe066; animation: pulse 1.4s ease-in-out infinite; }
  .settings-row input[type=range] { flex: 1; accent-color: #7df3ff; }
  .settings-modal { position: fixed; inset: 0; background: #0a0a12ee; display: none; align-items: center; justify-content: center; z-index: 50; }
  .settings-modal.visible { display: flex; }
  .settings-modal-card { background: #10101c; border: 1px solid #2a2a44; border-radius: 8px; padding: 28px 36px; text-align: center; min-width: 380px; }
  .settings-modal-title { color: #7df3ff; letter-spacing: 0.2em; font-size: 15px; margin-bottom: 14px; }
  .settings-modal-body { display: grid; gap: 8px; font-size: 14px; margin-bottom: 12px; }
  .settings-cal-count { font-size: 30px; font-weight: 800; color: #ffe066; }
  .settings-stats-card { min-width: 440px; max-height: 82vh; overflow-y: auto; }
  .settings-stats-lamps, .settings-stats-levels { display: grid; gap: 4px; text-align: left; margin-top: 8px; }
  .settings-stats-row { display: flex; justify-content: space-between; align-items: baseline; gap: 24px; border-bottom: 1px solid #1c1c2e; padding: 3px 0; }
`;

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

function defaultPlayOptions(): PlayOptionsDoc {
  // Cover defaults to 30% (disabled) so the first SUDDEN+ toggle visibly covers
  // something; the spec leaves the default white number open.
  return {
    gaugeType: 'NORMAL',
    autoplay: false,
    hiSpeed: 1.0,
    arrangement: 'OFF',
    suddenPlusEnabled: false,
    suddenPlusCover: 30,
    greenLockEnabled: false,
    greenLockTargetMs: GREEN_TARGET_DEFAULT,
    // Default ON as FAST/SLOW (play-options.md MUST 18 — the JTBD is improvement).
    timingDisplay: 'FAST_SLOW',
  };
}

function defaultSettings(): SettingsDoc {
  return {
    globalOffsetMs: 0,
    volumes: { master: 1, music: 1, effects: 1 },
    keyMapLanes: [...DEFAULT_KEY_MAP.lanes],
    // Default mapping binds no scratch secondary (input-handling.md MUST 12).
    keyMapScratchSecondary: null,
  };
}

function isPlayOptionsDoc(data: unknown): data is PlayOptionsDoc {
  if (typeof data !== 'object' || data === null) return false;
  const doc = data as Record<string, unknown>;
  const base =
    typeof doc.gaugeType === 'string' &&
    (GAUGE_TYPES as readonly string[]).includes(doc.gaugeType) &&
    typeof doc.autoplay === 'boolean' &&
    typeof doc.hiSpeed === 'number' &&
    Number.isFinite(doc.hiSpeed);
  if (!base) return false;
  // Newer fields (arrangement/SUDDEN+) may be absent from docs stored by older builds — the read
  // path fills them from defaults (spread below), so absence isn't corruption,
  // but a present-and-mistyped field is.
  if (
    doc.arrangement !== undefined &&
    !(
      typeof doc.arrangement === 'string' &&
      (ARRANGEMENTS as readonly string[]).includes(doc.arrangement)
    )
  ) {
    return false;
  }
  if (doc.suddenPlusEnabled !== undefined && typeof doc.suddenPlusEnabled !== 'boolean') {
    return false;
  }
  if (
    doc.suddenPlusCover !== undefined &&
    !(typeof doc.suddenPlusCover === 'number' && Number.isFinite(doc.suddenPlusCover))
  ) {
    return false;
  }
  if (doc.greenLockEnabled !== undefined && typeof doc.greenLockEnabled !== 'boolean') {
    return false;
  }
  if (
    doc.greenLockTargetMs !== undefined &&
    !(typeof doc.greenLockTargetMs === 'number' && Number.isFinite(doc.greenLockTargetMs))
  ) {
    return false;
  }
  if (
    doc.timingDisplay !== undefined &&
    !(
      typeof doc.timingDisplay === 'string' &&
      (TIMING_DISPLAY_MODES as readonly string[]).includes(doc.timingDisplay)
    )
  ) {
    return false;
  }
  return true;
}

function defaultSelectDoc(): SelectDoc {
  return { sortMode: 'title', viewMode: 'song' };
}

// Same tolerance policy as isPlayOptionsDoc: fields added after a doc was stored may be
// ABSENT (read path spreads over defaults) but must validate when present.
function isSelectDoc(data: unknown): data is SelectDoc {
  if (typeof data !== 'object' || data === null) return false;
  const doc = data as Record<string, unknown>;
  if (!isSortMode(doc.sortMode)) return false;
  return doc.viewMode === undefined || isViewMode(doc.viewMode);
}

function isSettingsDoc(data: unknown): data is SettingsDoc {
  if (typeof data !== 'object' || data === null) return false;
  const doc = data as Record<string, unknown>;
  if (typeof doc.globalOffsetMs !== 'number' || !Number.isFinite(doc.globalOffsetMs)) return false;
  const volumes = doc.volumes as Record<string, unknown> | undefined;
  if (
    typeof volumes !== 'object' ||
    volumes === null ||
    !(typeof volumes.master === 'number' && Number.isFinite(volumes.master)) ||
    !(typeof volumes.music === 'number' && Number.isFinite(volumes.music)) ||
    !(typeof volumes.effects === 'number' && Number.isFinite(volumes.effects))
  ) {
    return false;
  }
  if (!(Array.isArray(doc.keyMapLanes) && doc.keyMapLanes.every((c) => typeof c === 'string'))) {
    return false;
  }
  // Newer field (scratch secondary, input-handling.md MUST 12): absent in older
  // docs (normalized to null at boot), but mistyped-when-present is corruption.
  return (
    doc.keyMapScratchSecondary === undefined ||
    doc.keyMapScratchSecondary === null ||
    typeof doc.keyMapScratchSecondary === 'string'
  );
}

export function bootShell(root: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  const machine = createScreenMachine();

  // --- persisted documents (corruption-safe: each falls back independently, MUST 5) ---
  const playOptionsDoc: LocalDoc<PlayOptionsDoc> = createLocalDoc({
    storage: window.localStorage,
    key: STORAGE_KEYS.playOptions,
    version: 1,
    defaultValue: defaultPlayOptions,
    validate: isPlayOptionsDoc,
  });
  const settingsDoc: LocalDoc<SettingsDoc> = createLocalDoc({
    storage: window.localStorage,
    key: STORAGE_KEYS.settings,
    version: 1,
    defaultValue: defaultSettings,
    validate: isSettingsDoc,
  });
  const selectDoc: LocalDoc<SelectDoc> = createLocalDoc({
    storage: window.localStorage,
    key: STORAGE_KEYS.select,
    version: 1,
    defaultValue: defaultSelectDoc,
    validate: isSelectDoc,
  });
  // openRecordsStore performs corruption backup-then-prompt on open (results-records.md MUST 9).
  const recordsStore = openRecordsStore({
    storage: window.localStorage,
    confirmReset: (message) => window.confirm(message),
  });
  // Spread over defaults fills fields added after the doc was stored (see validator).
  const playOptions: PlayOptionsDoc = { ...defaultPlayOptions(), ...playOptionsDoc.read() };
  // The validator is type-only; a hand-edited target still lands on the 10ms grid.
  playOptions.greenLockTargetMs = clampGreenTarget(playOptions.greenLockTargetMs);
  // `settings` is the ONE live settings object: the settings screen mutates it in
  // place and sessions read it at start, so a change applies to the very next play
  // with no refresh (settings-screen.md MUST 11). Normalize once at boot — the
  // validator only checks types, so a hand-edited doc could still hold an invalid
  // key map or out-of-range numbers.
  const settings: SettingsDoc = settingsDoc.read();
  if (!isValidKeyMap({ lanes: settings.keyMapLanes })) {
    settings.keyMapLanes = [...DEFAULT_KEY_MAP.lanes];
  }
  // Older docs lack the scratch secondary (input-handling.md MUST 12); a
  // hand-edited one that collides with a lane code or is empty drops to null.
  settings.keyMapScratchSecondary =
    typeof settings.keyMapScratchSecondary === 'string' &&
    isValidKeyMap({
      lanes: settings.keyMapLanes,
      scratchSecondary: settings.keyMapScratchSecondary,
    })
      ? settings.keyMapScratchSecondary
      : null;
  settings.globalOffsetMs = clampGlobalOffsetMs(Math.round(settings.globalOffsetMs));
  settings.volumes = {
    master: clampVolume(settings.volumes.master),
    music: clampVolume(settings.volumes.music),
    effects: clampVolume(settings.volumes.effects),
  };
  /** Read fresh at each session start so settings-screen rebinds apply immediately. */
  function currentKeyMap(): LaneKeyMap {
    const map = {
      lanes: settings.keyMapLanes,
      scratchSecondary: settings.keyMapScratchSecondary,
    };
    return isValidKeyMap(map) ? map : DEFAULT_KEY_MAP;
  }

  // --- screens ---
  const screens = new Map<ScreenId, HTMLElement>();
  function screenDiv(id: ScreenId, extraClass = 'screen'): HTMLElement {
    const div = el('div', extraClass);
    div.dataset.screen = id;
    screens.set(id, div);
    root.appendChild(div);
    return div;
  }

  root.textContent = '';
  const titleEl = screenDiv('TITLE');
  const selectEl = screenDiv('SONG_SELECT');
  const settingsEl = screenDiv('SETTINGS');
  const playEl = screenDiv('PLAY', 'screen-play');
  const practiceEditEl = screenDiv('PRACTICE_EDIT');
  const practicePlayEl = screenDiv('PRACTICE_PLAY', 'screen-play');
  const resultsEl = screenDiv('RESULTS');
  const loadingOverlay = el('div', 'loading-overlay', 'LOADING…');
  document.body.appendChild(loadingOverlay);

  machine.onChange(() => {
    for (const [id, node] of screens) {
      node.classList.toggle('active', id === machine.current());
    }
  });
  function setLoading(visible: boolean): void {
    loadingOverlay.classList.toggle('visible', visible);
  }

  // --- TITLE ---
  titleEl.appendChild(el('h1', undefined, 'PRISMBEAT'));
  titleEl.appendChild(el('div', 'subtitle', '7KEY + SCRATCH / BROWSER EDITION'));
  titleEl.appendChild(el('div', 'press-key', 'PRESS ANY KEY'));
  const bootNote = el('div', 'boot-note', 'loading song library…');
  titleEl.appendChild(bootNote);
  titleEl.classList.add('active');

  // --- bootstrap (runs alongside TITLE, MUST 3/4) ---
  let library: SongLibrary | null = null;
  let db: IDBDatabase | null = null;
  let bootError: string | null = null;
  const bootstrap = (async () => {
    // Imported songs live in IndexedDB; a broken/unavailable IDB must degrade to
    // built-ins only, never block boot (song-library.md MUST 6/8).
    try {
      db = await openDatabase();
    } catch (err) {
      console.error('IndexedDB unavailable; imported songs will be missing', err);
    }
    library = await loadLibrary({ db });
    bootNote.textContent = `${library.entries.length} song(s) ready`;
  })().catch((err: unknown) => {
    bootError = err instanceof Error ? err.message : String(err);
    bootNote.textContent = `song library failed to load: ${bootError}`;
  });

  // --- audio (created on first gesture, MUST 7) ---
  let gameAudio: GameAudio | null = null;
  let audioCtx: AudioContext | null = null;
  let menuSfx: MenuSfx | null = null;
  async function unlockAudio(): Promise<void> {
    if (audioCtx === null) {
      audioCtx = new AudioContext();
      gameAudio = createGameAudio(audioCtx, settings.volumes);
      // Menu move/confirm/cancel cues share the effects bus so the EFFECTS
      // volume tier governs them like every other SFX (audio-playback.md MUST 8-9).
      menuSfx = createMenuSfx(audioCtx as unknown as SfxAudioContextLike, gameAudio.effectsBus);
    }
    await gameAudio?.unlock();
  }
  // Safe before unlock: menu screens are reachable only after the title
  // gesture, so a null kit just means silence, never an error.
  function playMenuSfx(kind: MenuSfxKind): void {
    menuSfx?.play(kind);
  }

  // --- SONG_SELECT (song-select.md MUST 1-8) ---
  selectEl.appendChild(el('h1', undefined, 'SELECT'));
  const errorBanner = el('div', 'error-banner');
  selectEl.appendChild(errorBanner);
  const sortLine = el('div', 'sort-line');
  selectEl.appendChild(sortLine);
  // Search box (song-select.md SHOULD 11): '/' focuses it, typing filters live. While
  // focused it owns the keyboard (app-shell-navigation.md MUST 17) — stopPropagation
  // keeps the menu bindings (S/G/R/A/arrows…) from firing mid-word; Escape/Enter blur,
  // handing control back to the list. The filter itself stays (visible in the box).
  const searchLine = el('div', 'search-line');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'select-search';
  searchInput.placeholder = 'title / artist';
  searchInput.dataset.role = 'select-search';
  searchLine.append(el('span', undefined, 'SEARCH'), searchInput);
  selectEl.appendChild(searchLine);
  searchInput.addEventListener('input', () => {
    selectModel?.setFilter(searchInput.value);
    renderSelectList();
  });
  searchInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.code === 'Escape' || event.code === 'Enter') {
      event.preventDefault();
      searchInput.blur();
    }
  });
  const listEl = el('ul', 'song-list');
  selectEl.appendChild(listEl);
  const optionsBar = el('div', 'options-bar');
  const gaugeOpt = el('span');
  const hiSpeedOpt = el('span');
  const greenOpt = el('span');
  const glockOpt = el('span');
  const arrangeOpt = el('span');
  const suddenOpt = el('span');
  const timingOpt = el('span');
  const autoplayOpt = el('span');
  optionsBar.append(
    gaugeOpt,
    hiSpeedOpt,
    greenOpt,
    glockOpt,
    arrangeOpt,
    suddenOpt,
    timingOpt,
    autoplayOpt,
  );
  selectEl.appendChild(optionsBar);
  selectEl.appendChild(
    el(
      'div',
      'hint',
      '↑/↓ move · ENTER expand/play · ESC collapse · S sort · F folders · / search · G gauge · ←/→ hi-speed · L g-lock · R arrange · Home sudden+ · PgUp/PgDn cover · T timing · A autoplay · P practice · O settings · keys: LShift S D F Space J K L',
    ),
  );

  // Live view into the records store so lamps/bests refresh whenever the list
  // re-renders after a play (song-select.md MUST 3, acceptance criterion 3).
  const recordLookup: RecordLookup = (songId, chartId) => {
    const record = recordsStore.getRecord(songId, chartId);
    if (record === null) return null;
    return { lamp: record.clearLamp, rank: record.bestRank, exScore: record.bestExScore };
  };
  let selectModel: SelectModel | null = null;

  // --- song preview (song-select.md SHOULD 12 / audio-playback.md SHOULD 12) ---
  // Created lazily after the audio unlock; follows the select cursor's song and
  // is silenced whenever the current screen is not SONG_SELECT. State mirrors
  // into data attributes so e2e (and CSS, later) can observe it.
  let previewPlayer: PreviewPlayer | null = null;
  function ensurePreviewPlayer(): PreviewPlayer | null {
    if (previewPlayer === null && audioCtx !== null && gameAudio !== null) {
      previewPlayer = createPreviewPlayer({
        ctx: audioCtx as unknown as PreviewAudioContextLike,
        musicBus: gameAudio.musicBus,
        onStateChange: (state) => {
          selectEl.dataset.previewState = state.phase;
          selectEl.dataset.previewSong = state.songId ?? '';
        },
      });
    }
    return previewPlayer;
  }
  function selectedPreviewTarget(): PreviewTarget | null {
    if (selectModel === null) return null;
    const row = selectModel.rows().find((r) => r.selected);
    // Chart rows inherit their song's preview; folder rows have no song and entries
    // without preview metadata (no catalogEntry, e.g. imported songs; the keysound
    // practice song, song-select.md SHOULD 12) stay silent.
    const catalogEntry =
      row === undefined || row.kind === 'folder' ? undefined : row.entry.catalogEntry;
    if (catalogEntry?.preview === undefined || catalogEntry.audio === undefined) return null;
    return {
      songId: catalogEntry.songId,
      audioUrl: catalogEntry.audio,
      startMs: catalogEntry.preview.startMs,
      durationMs: catalogEntry.preview.durationMs,
    };
  }
  /** Converge the preview onto the current screen + cursor; safe to call from anywhere. */
  function updatePreview(): void {
    ensurePreviewPlayer()?.request(
      machine.current() === 'SONG_SELECT' ? selectedPreviewTarget() : null,
    );
  }
  // Any screen change re-evaluates the preview: leaving SONG_SELECT fades it
  // out (no residual audio, audio-playback.md acceptance), returning resumes it.
  machine.onChange(() => {
    updatePreview();
  });

  const LAMP_LABELS: Record<ClearLamp, string> = {
    NO_PLAY: 'NO PLAY',
    FAILED: 'FAILED',
    ASSIST_CLEAR: 'ASSIST',
    EASY_CLEAR: 'EASY',
    CLEAR: 'CLEAR',
    HARD_CLEAR: 'HARD',
    EX_HARD_CLEAR: 'EX HARD',
    FULL_COMBO: 'FC',
  };

  function showSelectError(message: string | null): void {
    errorBanner.textContent = message ?? '';
    errorBanner.classList.toggle('visible', message !== null);
  }

  function renderOptionsBar(): void {
    gaugeOpt.innerHTML = `GAUGE <b>${playOptions.gaugeType.replace('_', ' ')}</b>`;
    // Green number (play-options.md SHOULD 13). Reference BPM here is the
    // selected song's MAX BPM: the catalog only has a song-level range before
    // the chart JSON lazy-loads, and max keeps a soflan chart's fastest
    // section readable. The in-play HUD readout follows the live BPM instead.
    const row = selectModel?.rows().find((r) => r.selected);
    const refBpm = row !== undefined && row.kind !== 'folder' ? row.entry.bpm.max : null;
    const cover = playOptions.suddenPlusEnabled ? playOptions.suddenPlusCover : 0;
    // Green-number lock (play-options.md MUST 15/17): locked mode derives the
    // hi-speed (shown as AUTO) and GREEN shows the ACTUAL value recomputed from
    // the derived, clamped hi-speed — equal to the target unless the clamp bit.
    const effHiSpeed =
      playOptions.greenLockEnabled && refBpm !== null
        ? lockedHiSpeedFor(refBpm, playOptions.greenLockTargetMs, cover)
        : playOptions.hiSpeed;
    hiSpeedOpt.innerHTML = playOptions.greenLockEnabled
      ? `HI-SPEED <b>${refBpm === null ? 'AUTO' : `AUTO ${effHiSpeed.toFixed(2)}`}</b>`
      : `HI-SPEED <b>${playOptions.hiSpeed.toFixed(2)}</b>`;
    greenOpt.innerHTML =
      refBpm === null
        ? 'GREEN <b>—</b>'
        : `GREEN <b>${greenNumberFor(refBpm, effHiSpeed, cover)}</b>`;
    glockOpt.innerHTML = `G-LOCK <b>${
      playOptions.greenLockEnabled ? `${playOptions.greenLockTargetMs}ms` : 'OFF'
    }</b>`;
    arrangeOpt.innerHTML = `ARRANGE <b>${playOptions.arrangement}</b>`;
    suddenOpt.innerHTML = `SUDDEN+ <b>${
      playOptions.suddenPlusEnabled ? `${playOptions.suddenPlusCover}%` : 'OFF'
    }</b>`;
    timingOpt.innerHTML = `TIMING <b>${timingDisplayLabel(playOptions.timingDisplay)}</b>`;
    autoplayOpt.innerHTML = `AUTOPLAY <b>${playOptions.autoplay ? 'ON (no record)' : 'OFF'}</b>`;
  }

  function renderSelectList(): void {
    // Selection drives the GREEN readout, so every list re-render (cursor move,
    // sort, filter, view toggle) refreshes the options bar too.
    renderOptionsBar();
    listEl.textContent = '';
    if (selectModel === null) {
      sortLine.innerHTML = 'SORT <b>TITLE</b>';
      return;
    }
    const view = selectModel.viewMode();
    // Sort modes only order the SONG view (LEVEL view is fixed level-ascending),
    // so the readout hides SORT there rather than showing a dead setting.
    let line =
      view === 'level'
        ? 'VIEW <b>LEVEL FOLDERS</b>'
        : `VIEW <b>SONGS</b> · SORT <b>${selectModel.sortMode().toUpperCase()}</b>`;
    if (selectModel.filterText() !== '') {
      const { songs, charts } = selectModel.filteredCounts();
      line += ` · FILTER <b>${songs} SONG${songs === 1 ? '' : 'S'} / ${charts} CHART${charts === 1 ? '' : 'S'}</b>`;
    }
    sortLine.innerHTML = line;
    listEl.dataset.viewMode = view;
    selectModel.rows().forEach((row, index) => {
      const li = el(
        'li',
        row.kind === 'song' ? 'song-row' : row.kind === 'folder' ? 'folder-row' : 'chart-row',
      );
      if (row.selected) li.classList.add('selected');
      if (row.kind === 'folder') {
        li.appendChild(el('span', 'expander', row.expanded ? '▾' : '▸'));
        li.appendChild(el('span', 'title folder-title', `LEVEL ${row.level}`));
        li.appendChild(
          el('span', 'meta', `${row.chartCount} chart${row.chartCount === 1 ? '' : 's'}`),
        );
      } else if (row.kind === 'song') {
        li.appendChild(el('span', 'expander', row.expanded ? '▾' : '▸'));
        li.appendChild(el('span', 'title', row.entry.title));
        const bpm =
          row.entry.bpm.min === row.entry.bpm.max
            ? `${row.entry.bpm.min}`
            : `${row.entry.bpm.min}-${row.entry.bpm.max}`;
        li.appendChild(el('span', 'meta', `${row.entry.artist} · ${row.entry.genre} · BPM ${bpm}`));
        li.appendChild(
          el('span', 'source-badge', row.entry.source === 'builtin' ? 'BUILT-IN' : 'IMPORTED'),
        );
      } else {
        li.appendChild(
          el(
            'span',
            `diff diff-${row.chart.difficulty}`,
            `${row.chart.difficulty} ${row.chart.level}`,
          ),
        );
        // Inside a level folder the chart row is the only place the song is named.
        if (view === 'level') li.appendChild(el('span', 'title', row.entry.title));
        li.appendChild(el('span', 'meta', `${row.chart.noteCount} notes`));
        const recordEl = el('span', 'record');
        const lamp = row.record?.lamp ?? 'NO_PLAY';
        recordEl.appendChild(el('span', `lamp lamp-${lamp}`, LAMP_LABELS[lamp]));
        if (row.record !== null && row.record.exScore !== null) {
          recordEl.appendChild(
            el('span', undefined, `${row.record.rank ?? ''} ${row.record.exScore}`.trim()),
          );
        }
        li.appendChild(recordEl);
      }
      li.addEventListener('click', () => {
        if (selectModel === null) return;
        const play = selectModel.activateRowAt(index);
        playMenuSfx('confirm');
        renderSelectList();
        if (play !== null) void enterPlayFromSelect(play);
      });
      listEl.appendChild(li);
    });
    listEl.querySelector('li.selected')?.scrollIntoView({ block: 'nearest' });
    // Every selection-changing path re-renders the list, so this single hook
    // keeps the preview following the cursor.
    updatePreview();
  }

  function saveSelectDoc(): void {
    try {
      selectDoc.write({
        sortMode: selectModel?.sortMode() ?? 'title',
        viewMode: selectModel?.viewMode() ?? 'song',
      });
    } catch (err) {
      console.error('failed to persist select preferences', err);
    }
  }

  function savePlayOptions(): void {
    try {
      playOptionsDoc.write(playOptions);
    } catch (err) {
      console.error('failed to persist play options', err);
    }
  }

  function saveSettings(): void {
    try {
      settingsDoc.write(settings);
    } catch (err) {
      console.error('failed to persist settings', err);
    }
  }

  // --- SETTINGS (settings-screen.md; entry per song-select.md MUST 10) ---
  let settingsScreen: SettingsScreen | null = null;

  /** Chart list for stats aggregation — records don't store levels, the library does. */
  function libraryChartRefs(): StatsChartRef[] {
    return (library?.entries ?? []).flatMap((entry) =>
      entry.charts.map((chart) => ({
        songId: entry.songId,
        chartId: chart.chartId,
        level: chart.level,
      })),
    );
  }

  function ensureSettingsScreen(): SettingsScreen {
    if (settingsScreen === null) {
      settingsScreen = createSettingsScreen({
        mount: settingsEl,
        values: settings,
        onPersist: saveSettings,
        applyVolumes: (volumes) => gameAudio?.setVolumes(volumes),
        records: {
          stats: () => aggregatePlayerStats(recordsStore.all(), libraryChartRefs()),
          exportJson: () => recordsStore.exportJson(),
          importJson: (text) => recordsStore.importJson(text),
        },
        // Select rows read records live on render, so one re-render refreshes lamps.
        onRecordsImported: () => renderSelectList(),
        getAudio: () =>
          gameAudio === null || audioCtx === null
            ? null
            : {
                sfxCtx: audioCtx as unknown as SfxAudioContextLike,
                effectsBus: gameAudio.effectsBus,
                clockSources: gameAudio.clockSources(),
                getOutputLatencySec: () => audioCtx?.outputLatency,
              },
        playMenuSfx,
        onExit: () => {
          playMenuSfx('cancel');
          settingsScreen?.deactivate();
          machine.transition('SONG_SELECT');
        },
      });
    }
    return settingsScreen;
  }

  function enterSettings(): void {
    const screen = ensureSettingsScreen();
    playMenuSfx('confirm');
    machine.transition('SETTINGS');
    screen.activate();
  }

  // --- PRACTICE (practice-mode.md; entry per song-select.md MUST 10) ---
  let practiceEditor: PracticeEditor | null = null;
  let practiceBusy = false;

  function ensurePracticeEditor(): PracticeEditor {
    if (practiceEditor === null) {
      practiceEditor = createPracticeEditor({
        mount: practiceEditEl,
        getDb: () => db,
        onStartPractice: (pattern, targetLoops) => void startPractice(pattern, targetLoops),
        onExit: () => {
          playMenuSfx('cancel');
          practiceEditor?.deactivate();
          machine.transition('SONG_SELECT');
        },
      });
    }
    return practiceEditor;
  }

  function enterPracticeEditor(): void {
    const editor = ensurePracticeEditor();
    playMenuSfx('confirm');
    machine.transition('PRACTICE_EDIT');
    editor.activate();
  }

  async function startPractice(
    pattern: PracticePattern,
    targetLoops: number | null,
  ): Promise<void> {
    if (practiceBusy) return;
    const editor = ensurePracticeEditor();
    if (gameAudio === null || audioCtx === null) {
      editor.setStatus('audio not unlocked — cannot start practice');
      return;
    }
    practiceBusy = true;
    editor.deactivate();
    machine.transition('PRACTICE_PLAY');
    practicePlayEl.textContent = '';
    try {
      await startPracticeSession({
        pattern,
        targetLoops,
        mount: practicePlayEl,
        gameAudio,
        sfxCtx: audioCtx as unknown as SfxAudioContextLike,
        globalOffsetMs: settings.globalOffsetMs,
        keyMap: currentKeyMap(),
        hiSpeed: playOptions.hiSpeed,
        suddenPlusEnabled: playOptions.suddenPlusEnabled,
        suddenPlusCover: playOptions.suddenPlusCover,
        greenLockEnabled: playOptions.greenLockEnabled,
        greenLockTargetMs: playOptions.greenLockTargetMs,
        timingDisplay: playOptions.timingDisplay,
        onExit(outcome) {
          practiceBusy = false;
          // Hi-speed / SUDDEN+ behave exactly like song play, persistence included
          // (practice-mode.md MUST 9, play-options.md MUST 4/8; MUST 16 target).
          playOptions.hiSpeed = outcome.hiSpeed;
          playOptions.suddenPlusEnabled = outcome.suddenPlusEnabled;
          playOptions.suddenPlusCover = outcome.suddenPlusCover;
          playOptions.greenLockTargetMs = outcome.greenLockTargetMs;
          savePlayOptions();
          renderOptionsBar();
          practicePlayEl.textContent = '';
          machine.transition('PRACTICE_EDIT');
          editor.activate();
          const total = outcome.cumulative;
          editor.setStatus(
            total.loopsFinalized > 0
              ? `session ${outcome.endedBy === 'completed' ? 'complete' : 'ended'}: ` +
                  `${total.loopsFinalized} loop(s) · ACC ${total.exPercent.toFixed(1)}% · ` +
                  `${formatMeanDelta(total.meanDeltaMs)} · BEST COMBO ${total.bestMaxCombo}`
              : 'session ended before the first loop finished',
          );
        },
      });
    } catch (err) {
      practiceBusy = false;
      practicePlayEl.textContent = '';
      if (machine.current() === 'PRACTICE_PLAY') machine.transition('PRACTICE_EDIT');
      editor.activate();
      editor.setStatus(
        `failed to start practice: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- PLAY / RESULTS state ---
  let loaded: LoadedPlayData | null = null;
  let lastResult: PlayResult | null = null;
  let playBusy = false;

  async function loadSelected(request: PlayRequest): Promise<LoadedPlayData> {
    // Lazy load on song decision (song-library.md MUST 2): built-in charts/audio are
    // fetched, imported ones come from IndexedDB — loadPlayableSong hides the split.
    const playable = await loadPlayableSong(request.entry, { db });
    const chart = playable.song.charts.find((c) => c.chartId === request.chart.chartId);
    if (chart === undefined) {
      throw new Error(`chart ${request.chart.chartId} missing from song ${playable.song.songId}`);
    }
    if (audioCtx === null || gameAudio === null) throw new Error('audio not unlocked');
    const player = createSongPlayer(
      audioCtx as unknown as SongAudioContextLike,
      gameAudio.musicBus,
    );
    // Keysound entries preload + decode the sample here, at song decision — play
    // never fetches (practice-song-content.md MUST 10); loadFromUrl is reused
    // purely as fetch+decode.
    const audio: PlaySessionAudio =
      playable.audio.kind === 'keysound'
        ? { kind: 'keysound', buffer: await player.loadFromUrl(playable.audio.url) }
        : {
            kind: 'bgm',
            buffer:
              playable.audio.kind === 'url'
                ? await player.loadFromUrl(playable.audio.url)
                : await player.loadFromBlob(playable.audio.blob),
          };
    return { song: playable.song, chart, audio };
  }

  async function startPlay(data: LoadedPlayData): Promise<void> {
    if (gameAudio === null || audioCtx === null) throw new Error('audio not unlocked');
    machine.transition('PLAY');
    playEl.textContent = '';
    await startPlaySession({
      song: data.song,
      chart: data.chart,
      audio: data.audio,
      gaugeType: playOptions.gaugeType,
      autoplay: playOptions.autoplay,
      mount: playEl,
      gameAudio,
      audioCtx: audioCtx as unknown as SongAudioContextLike,
      globalOffsetMs: settings.globalOffsetMs,
      keyMap: currentKeyMap(),
      hiSpeed: playOptions.hiSpeed,
      arrangement: playOptions.arrangement,
      suddenPlusEnabled: playOptions.suddenPlusEnabled,
      suddenPlusCover: playOptions.suddenPlusCover,
      greenLockEnabled: playOptions.greenLockEnabled,
      greenLockTargetMs: playOptions.greenLockTargetMs,
      timingDisplay: playOptions.timingDisplay,
      onFinished(result) {
        lastResult = result;
        // In-play PageUp/PageDown and SUDDEN+ adjustments persist to the next play,
        // retries included (play-options.md MUST 4/8; MUST 16 for the locked target).
        playOptions.hiSpeed = result.hiSpeed;
        playOptions.suddenPlusEnabled = result.suddenPlusEnabled;
        playOptions.suddenPlusCover = result.suddenPlusCover;
        playOptions.greenLockTargetMs = result.greenLockTargetMs;
        savePlayOptions();
        renderOptionsBar();
        // recordPlay writes the record once per song end and skips (returns null)
        // for autoplay plays (results-records.md req 6/7).
        const outcome = recordsStore.recordPlay(
          {
            songId: result.songId,
            chartId: result.chartId,
            finishedSong: result.finishedSong,
            lamp: result.lamp,
            exScore: result.score.exScore,
            djRank: result.score.djRank,
            bp: result.score.bp,
            arrangement: result.arrangement,
            autoplay: result.autoplay,
          },
          new Date().toISOString(),
        );
        playEl.textContent = '';
        renderResults(result, outcome);
        machine.transition('RESULTS');
      },
    });
  }

  async function enterPlayFromSelect(request: PlayRequest): Promise<void> {
    if (playBusy) return;
    playBusy = true;
    setLoading(true);
    showSelectError(null);
    try {
      loaded = await loadSelected(request);
      await startPlay(loaded);
    } catch (err) {
      // Load failure: stay on (or return to) SONG_SELECT with the cause (MUST 15/16).
      const message = err instanceof Error ? err.message : String(err);
      if (machine.current() === 'PLAY') machine.transition('RESULTS');
      if (machine.current() === 'RESULTS') machine.transition('SONG_SELECT');
      showSelectError(`failed to start song: ${message}`);
    } finally {
      setLoading(false);
      playBusy = false;
    }
  }

  // --- RESULTS ---
  function formatExDiff(diff: number): string {
    if (diff > 0) return `(+${diff})`;
    if (diff < 0) return `(−${Math.abs(diff)})`;
    return '(±0)';
  }

  function renderResults(result: PlayResult, outcome: RecordUpdateOutcome | null): void {
    resultsEl.textContent = '';
    const cleared = result.clear;
    resultsEl.appendChild(
      el('div', `result-status ${cleared ? 'clear' : 'failed'}`, cleared ? 'CLEAR' : 'FAILED'),
    );

    // Song/chart header (results-records.md req 1). `loaded` should always be set by
    // the time a result is rendered, but guard defensively rather than assume.
    if (loaded !== null) {
      const { song, chart } = loaded;
      resultsEl.appendChild(el('div', 'result-title', `${song.title} / ${song.artist}`));
      resultsEl.appendChild(
        el('div', `result-chart diff-${chart.difficulty}`, `${chart.difficulty} ${chart.level}`),
      );
    }

    const subParts: string[] = [`${result.gaugeType.replace('_', ' ')} GAUGE`];
    subParts.push(`HS ${result.hiSpeed.toFixed(2)}`);
    if (result.arrangement !== 'OFF') subParts.push(result.arrangement);
    if (result.suddenPlusEnabled) subParts.push(`SUD+ ${result.suddenPlusCover}%`);
    if (result.abandoned) subParts.push('early termination (give-up)');
    if (!result.finishedSong && !result.abandoned)
      subParts.push(`died at ${(result.endedAtProgress * 100).toFixed(0)}%`);
    if (result.autoplay) subParts.push('AUTOPLAY — no record saved');
    resultsEl.appendChild(el('div', 'result-sub', subParts.join(' · ')));
    resultsEl.appendChild(el('div', 'result-rank', result.score.djRank));

    const grid = el('div', 'result-grid');
    function addRow(label: string, value: string, opts?: { badge?: boolean; note?: string }): void {
      const row = el('div', 'row');
      row.appendChild(el('span', 'label', label));
      const valueWrap = el('span', 'value-wrap');
      valueWrap.appendChild(el('span', undefined, value));
      if (opts?.note !== undefined) valueWrap.appendChild(el('span', 'result-diff', opts.note));
      if (opts?.badge === true) valueWrap.appendChild(el('span', 'new-record', 'NEW RECORD'));
      row.appendChild(valueWrap);
      grid.appendChild(row);
    }

    // ±diff vs best / FIRST PLAY (results-records.md req 2). Autoplay plays (outcome
    // === null) show nothing extra here — the AUTOPLAY sub-line above already explains why.
    let exNote: string | undefined;
    if (outcome !== null) {
      if (outcome.exScoreDiff !== null) {
        exNote = formatExDiff(outcome.exScoreDiff);
      } else if (outcome.previous === null || outcome.previous.bestExScore === null) {
        exNote = 'FIRST PLAY';
      }
    }

    addRow(
      'EX SCORE',
      `${result.score.exScore} / ${result.score.maxExScore} (${result.score.exPercent.toFixed(2)}%)`,
      { badge: outcome?.newExScore === true, note: exNote },
    );
    addRow('CLEAR LAMP', result.lamp.replace(/_/g, ' '), { badge: outcome?.newLamp === true });
    addRow('MAX COMBO', String(result.score.maxCombo));
    addRow('PGREAT', String(result.score.counts.PGREAT));
    addRow('GREAT', String(result.score.counts.GREAT));
    addRow('GOOD', String(result.score.counts.GOOD));
    addRow('BAD', String(result.score.counts.BAD));
    addRow('POOR (miss)', String(result.score.counts.POOR));
    addRow('POOR (empty)', String(result.score.emptyPoorCount));
    // FAST/SLOW counts (results-records.md MUST 13): always aggregated and shown,
    // even when the display mode was OFF; never written into records.
    addRow('FAST', String(result.score.fastCount));
    addRow('SLOW', String(result.score.slowCount));
    addRow('BP', String(result.score.bp), { badge: outcome?.newMinBP === true });
    addRow('GAUGE', `${result.finalGauge.toFixed(1)}%`);
    addRow('FULL COMBO', result.score.fullCombo ? 'YES' : 'no');

    resultsEl.appendChild(grid);
    resultsEl.appendChild(el('div', 'hint', 'ENTER retry · ESC back to select'));
  }

  async function retryFromResults(): Promise<void> {
    if (loaded === null || playBusy) return;
    playBusy = true;
    setLoading(true);
    try {
      await startPlay(loaded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (machine.current() === 'PLAY') machine.transition('RESULTS');
      machine.transition('SONG_SELECT');
      showSelectError(`failed to restart song: ${message}`);
    } finally {
      setLoading(false);
      playBusy = false;
    }
  }

  // --- global menu keyboard handling (PLAY input is owned by the session) ---
  document.addEventListener('keydown', (event) => {
    const screen = machine.current();
    if (screen === 'TITLE') {
      void handleTitleGesture();
      return;
    }
    if (screen === 'SONG_SELECT') {
      if (selectModel === null) return;
      if (event.code === 'ArrowUp') {
        event.preventDefault();
        selectModel.moveCursor(-1);
        playMenuSfx('move');
        renderSelectList();
      } else if (event.code === 'ArrowDown') {
        event.preventDefault();
        selectModel.moveCursor(1);
        playMenuSfx('move');
        renderSelectList();
      } else if (event.code === 'Enter') {
        event.preventDefault();
        const play = selectModel.activate();
        playMenuSfx('confirm');
        renderSelectList();
        if (play !== null) void enterPlayFromSelect(play);
      } else if (event.code === 'Escape') {
        // Escape backs out of the difficulty list to the song row (song-select.md MUST 5);
        // at song level there is nowhere further back, so it does nothing (and stays silent).
        if (selectModel.collapse()) {
          playMenuSfx('cancel');
          renderSelectList();
        }
      } else if (event.code === 'KeyS') {
        selectModel.cycleSortMode();
        playMenuSfx('move');
        saveSelectDoc();
        renderSelectList();
      } else if (event.code === 'KeyF') {
        // Level-folder view toggle (song-select.md SHOULD 13); persisted like sort mode.
        selectModel.toggleViewMode();
        playMenuSfx('move');
        saveSelectDoc();
        renderSelectList();
      } else if (event.code === 'Slash') {
        // preventDefault keeps the '/' keystroke from typing into the just-focused box.
        event.preventDefault();
        playMenuSfx('move');
        searchInput.focus();
      } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault();
        const direction = event.code === 'ArrowRight' ? 1 : -1;
        if (playOptions.greenLockEnabled) {
          // Locked mode repurposes the hi-speed arrows for the target, mirroring
          // in-play PageUp/PageDown (play-options.md MUST 16): → = faster =
          // shorter visible time, so the target decreases.
          playOptions.greenLockTargetMs = stepGreenTarget(
            playOptions.greenLockTargetMs,
            direction === 1 ? -1 : 1,
          );
        } else {
          playOptions.hiSpeed = Math.min(
            HI_SPEED_MAX,
            Math.max(HI_SPEED_MIN, playOptions.hiSpeed + direction * HI_SPEED_STEP),
          );
        }
        playMenuSfx('move');
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'KeyL') {
        // Green-number lock toggle (play-options.md MUST 15). Enabling seeds the
        // target from the current manual green number so the scroll feel doesn't
        // jump the moment the lock engages (decision recorded in the plan).
        playOptions.greenLockEnabled = !playOptions.greenLockEnabled;
        if (playOptions.greenLockEnabled) {
          const row = selectModel.rows().find((r) => r.selected);
          const refBpm = row !== undefined && row.kind !== 'folder' ? row.entry.bpm.max : null;
          if (refBpm !== null) {
            const manualGreen = greenNumberFor(
              refBpm,
              playOptions.hiSpeed,
              playOptions.suddenPlusEnabled ? playOptions.suddenPlusCover : 0,
            );
            if (manualGreen > 0) playOptions.greenLockTargetMs = clampGreenTarget(manualGreen);
          }
        }
        playMenuSfx('move');
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'KeyG') {
        const next =
          GAUGE_TYPES[(GAUGE_TYPES.indexOf(playOptions.gaugeType) + 1) % GAUGE_TYPES.length];
        if (next !== undefined) playOptions.gaugeType = next;
        playMenuSfx('move');
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'KeyR') {
        playOptions.arrangement = nextArrangement(playOptions.arrangement);
        playMenuSfx('move');
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'Home') {
        event.preventDefault();
        playOptions.suddenPlusEnabled = !playOptions.suddenPlusEnabled;
        playMenuSfx('move');
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'PageUp' || event.code === 'PageDown') {
        event.preventDefault();
        // Same gate as in-play: the white number only moves while the cover is on.
        if (playOptions.suddenPlusEnabled) {
          playOptions.suddenPlusCover = stepCover(
            playOptions.suddenPlusCover,
            event.code === 'PageUp' ? 1 : -1,
          );
          playMenuSfx('move');
          renderOptionsBar();
          savePlayOptions();
        }
      } else if (event.code === 'KeyT') {
        // FAST/SLOW display mode (play-options.md MUST 18): select-panel only —
        // there is deliberately no in-play key for it.
        playOptions.timingDisplay = nextTimingDisplay(playOptions.timingDisplay);
        playMenuSfx('move');
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'KeyA') {
        playOptions.autoplay = !playOptions.autoplay;
        playMenuSfx('move');
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'KeyP') {
        // Practice-session entry (song-select.md MUST 10).
        enterPracticeEditor();
      } else if (event.code === 'KeyO') {
        // Settings entry (song-select.md MUST 10).
        enterSettings();
      }
      return;
    }
    if (screen === 'RESULTS') {
      if (event.code === 'Enter') {
        event.preventDefault();
        playMenuSfx('confirm');
        void retryFromResults();
      } else if (event.code === 'Escape') {
        event.preventDefault();
        playMenuSfx('cancel');
        lastResult = null;
        machine.transition('SONG_SELECT');
        renderSelectList();
      }
    }
  });
  document.addEventListener('click', () => {
    if (machine.current() === 'TITLE') void handleTitleGesture();
  });

  let unlocking = false;
  async function handleTitleGesture(): Promise<void> {
    if (unlocking) return;
    unlocking = true;
    try {
      await unlockAudio();
      await bootstrap;
      if (bootError !== null || library === null) {
        bootNote.textContent = `cannot continue: ${bootError ?? 'song library missing'}`;
        return;
      }
      if (selectModel === null) {
        // Spread over defaults fills fields added after the doc was stored (see validator).
        const prefs = { ...defaultSelectDoc(), ...selectDoc.read() };
        selectModel = createSelectModel({
          entries: library.entries,
          records: recordLookup,
          sortMode: prefs.sortMode,
          viewMode: prefs.viewMode,
        });
      }
      // Non-fatal library problems (e.g. imported songs unavailable) surface on the
      // select screen instead of blocking entry (song-library.md MUST 6/8).
      if (library.warnings.length > 0) showSelectError(library.warnings.join(' — '));
      renderSelectList();
      renderOptionsBar();
      machine.transition('SONG_SELECT');
      playMenuSfx('confirm');
    } catch (err) {
      bootNote.textContent = `audio unlock failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      unlocking = false;
    }
  }

  // Suspended-context auto-resume on later inputs (MUST 8).
  document.addEventListener('keydown', () => {
    if (gameAudio !== null && audioCtx !== null && audioCtx.state === 'suspended') {
      void gameAudio.unlock();
    }
  });
}
