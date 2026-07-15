// App shell: DOM screens (TITLE / SONG_SELECT / RESULTS), bootstrap, audio unlock, and the
// PLAY hand-off to the session controller (specs/app-shell-navigation.md).
//
// DOM screens render via plain DOM; only PLAY uses the PixiJS canvas (MUST 13). The screen
// state machine (screens.ts) owns legality of transitions; this module owns presentation.

import { type PlayResult, startPlaySession } from '../features/play/controller';
import { DEFAULT_KEY_MAP, isValidKeyMap } from '../features/play/input';
import { type SongAudioContextLike, createSongPlayer } from '../features/play/songPlayer';
import { GAUGE_TYPES, type GaugeType } from '../features/play/types';
import { type RecordUpdateOutcome, openRecordsStore } from '../features/records/store';
import {
  type CatalogChartEntry,
  type CatalogSongEntry,
  type SongCatalog,
  loadBuiltinCatalog,
  loadBuiltinSong,
} from '../features/songs/catalog';
import { type GameAudio, type VolumeSettings, createGameAudio } from '../lib/audio/context';
import type { Chart, Song } from '../lib/chart/types';
import { type LocalDoc, STORAGE_KEYS, createLocalDoc } from '../lib/storage/local';
import { type ScreenId, createScreenMachine } from './screens';

interface PlayOptionsDoc {
  gaugeType: GaugeType;
  autoplay: boolean;
  hiSpeed: number;
}

interface SettingsDoc {
  globalOffsetMs: number;
  volumes: VolumeSettings;
  keyMapLanes: string[];
}

interface SelectableChart {
  song: CatalogSongEntry;
  chart: CatalogChartEntry;
}

interface LoadedPlayData {
  song: Song;
  chart: Chart;
  audioBuffer: AudioBuffer;
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
  .song-list li { padding: 10px 16px; border-left: 4px solid transparent; display: flex; gap: 14px; align-items: baseline; }
  .song-list li.selected { background: #16182b; border-left-color: #7df3ff; }
  .song-list .title { font-size: 17px; }
  .song-list .meta { color: #8a8aa8; font-size: 13px; }
  .song-list .diff { font-weight: 700; font-size: 13px; padding: 1px 8px; border-radius: 3px; }
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
  return { gaugeType: 'NORMAL', autoplay: false, hiSpeed: 1.0 };
}

function defaultSettings(): SettingsDoc {
  return {
    globalOffsetMs: 0,
    volumes: { master: 1, music: 1, effects: 1 },
    keyMapLanes: [...DEFAULT_KEY_MAP.lanes],
  };
}

function isPlayOptionsDoc(data: unknown): data is PlayOptionsDoc {
  if (typeof data !== 'object' || data === null) return false;
  const doc = data as Record<string, unknown>;
  return (
    typeof doc.gaugeType === 'string' &&
    (GAUGE_TYPES as readonly string[]).includes(doc.gaugeType) &&
    typeof doc.autoplay === 'boolean' &&
    typeof doc.hiSpeed === 'number' &&
    Number.isFinite(doc.hiSpeed)
  );
}

function isSettingsDoc(data: unknown): data is SettingsDoc {
  if (typeof data !== 'object' || data === null) return false;
  const doc = data as Record<string, unknown>;
  if (typeof doc.globalOffsetMs !== 'number') return false;
  const volumes = doc.volumes as Record<string, unknown> | undefined;
  if (
    typeof volumes !== 'object' ||
    volumes === null ||
    typeof volumes.master !== 'number' ||
    typeof volumes.music !== 'number' ||
    typeof volumes.effects !== 'number'
  ) {
    return false;
  }
  return Array.isArray(doc.keyMapLanes) && doc.keyMapLanes.every((c) => typeof c === 'string');
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
  // openRecordsStore performs corruption backup-then-prompt on open (results-records.md MUST 9).
  const recordsStore = openRecordsStore({
    storage: window.localStorage,
    confirmReset: (message) => window.confirm(message),
  });
  const playOptions = playOptionsDoc.read();
  const settings = settingsDoc.read();
  const keyMap = { lanes: settings.keyMapLanes };
  const activeKeyMap = isValidKeyMap(keyMap) ? keyMap : DEFAULT_KEY_MAP;

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
  const playEl = screenDiv('PLAY', 'screen-play');
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
  titleEl.appendChild(el('h1', undefined, 'IIDX WEB'));
  titleEl.appendChild(el('div', 'subtitle', '7KEY + SCRATCH / BROWSER EDITION'));
  titleEl.appendChild(el('div', 'press-key', 'PRESS ANY KEY'));
  const bootNote = el('div', 'boot-note', 'loading song library…');
  titleEl.appendChild(bootNote);
  titleEl.classList.add('active');

  // --- bootstrap (runs alongside TITLE, MUST 3/4) ---
  let catalog: SongCatalog | null = null;
  let bootError: string | null = null;
  const bootstrap = loadBuiltinCatalog()
    .then((loaded) => {
      catalog = loaded;
      bootNote.textContent = `${loaded.songs.length} song(s) ready`;
    })
    .catch((err: unknown) => {
      bootError = err instanceof Error ? err.message : String(err);
      bootNote.textContent = `song library failed to load: ${bootError}`;
    });

  // --- audio (created on first gesture, MUST 7) ---
  let gameAudio: GameAudio | null = null;
  let audioCtx: AudioContext | null = null;
  async function unlockAudio(): Promise<void> {
    if (audioCtx === null) {
      audioCtx = new AudioContext();
      gameAudio = createGameAudio(audioCtx, settings.volumes);
    }
    await gameAudio?.unlock();
  }

  // --- SONG_SELECT ---
  selectEl.appendChild(el('h1', undefined, 'SELECT'));
  const errorBanner = el('div', 'error-banner');
  selectEl.appendChild(errorBanner);
  const listEl = el('ul', 'song-list');
  selectEl.appendChild(listEl);
  const optionsBar = el('div', 'options-bar');
  const gaugeOpt = el('span');
  const autoplayOpt = el('span');
  optionsBar.append(gaugeOpt, autoplayOpt);
  selectEl.appendChild(optionsBar);
  selectEl.appendChild(
    el(
      'div',
      'hint',
      '↑/↓ choose chart · ENTER play · G gauge type · A autoplay demo · keys: LShift S D F Space J K L',
    ),
  );

  let selectables: SelectableChart[] = [];
  let selectedIndex = 0;

  function showSelectError(message: string | null): void {
    errorBanner.textContent = message ?? '';
    errorBanner.classList.toggle('visible', message !== null);
  }

  function renderOptionsBar(): void {
    gaugeOpt.innerHTML = `GAUGE <b>${playOptions.gaugeType.replace('_', ' ')}</b>`;
    autoplayOpt.innerHTML = `AUTOPLAY <b>${playOptions.autoplay ? 'ON (no record)' : 'OFF'}</b>`;
  }

  function renderSongList(): void {
    listEl.textContent = '';
    selectables = [];
    if (catalog === null) return;
    for (const song of catalog.songs) {
      for (const chart of song.charts) {
        selectables.push({ song, chart });
      }
    }
    selectables.forEach((item, i) => {
      const li = el('li');
      if (i === selectedIndex) li.classList.add('selected');
      const diff = el(
        'span',
        `diff diff-${item.chart.difficulty}`,
        `${item.chart.difficulty} ${item.chart.level}`,
      );
      const title = el('span', 'title', item.song.title);
      const meta = el(
        'span',
        'meta',
        `${item.song.artist} · ${item.song.genre} · BPM ${item.song.bpm.min === item.song.bpm.max ? item.song.bpm.min : `${item.song.bpm.min}-${item.song.bpm.max}`} · ${item.chart.noteCount} notes`,
      );
      li.append(diff, title, meta);
      listEl.appendChild(li);
    });
  }

  function moveSelection(delta: number): void {
    if (selectables.length === 0) return;
    selectedIndex = (selectedIndex + delta + selectables.length) % selectables.length;
    renderSongList();
  }

  function savePlayOptions(): void {
    try {
      playOptionsDoc.write(playOptions);
    } catch (err) {
      console.error('failed to persist play options', err);
    }
  }

  // --- PLAY / RESULTS state ---
  let loaded: LoadedPlayData | null = null;
  let lastResult: PlayResult | null = null;
  let playBusy = false;

  async function loadSelected(item: SelectableChart): Promise<LoadedPlayData> {
    const song = await loadBuiltinSong(item.song);
    const chart = song.charts.find((c) => c.chartId === item.chart.chartId);
    if (chart === undefined) {
      throw new Error(`chart ${item.chart.chartId} missing from song ${song.songId}`);
    }
    if (audioCtx === null || gameAudio === null) throw new Error('audio not unlocked');
    const player = createSongPlayer(
      audioCtx as unknown as SongAudioContextLike,
      gameAudio.musicBus,
    );
    const audioBuffer = await player.loadFromUrl(song.audio.ref);
    return { song, chart, audioBuffer };
  }

  async function startPlay(data: LoadedPlayData): Promise<void> {
    if (gameAudio === null || audioCtx === null) throw new Error('audio not unlocked');
    machine.transition('PLAY');
    playEl.textContent = '';
    await startPlaySession({
      song: data.song,
      chart: data.chart,
      audioBuffer: data.audioBuffer,
      gaugeType: playOptions.gaugeType,
      autoplay: playOptions.autoplay,
      mount: playEl,
      gameAudio,
      audioCtx: audioCtx as unknown as SongAudioContextLike,
      globalOffsetMs: settings.globalOffsetMs,
      keyMap: activeKeyMap,
      hiSpeed: playOptions.hiSpeed,
      onFinished(result) {
        lastResult = result;
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

  async function enterPlayFromSelect(): Promise<void> {
    const item = selectables[selectedIndex];
    if (item === undefined || playBusy) return;
    playBusy = true;
    setLoading(true);
    showSelectError(null);
    try {
      loaded = await loadSelected(item);
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
      if (event.code === 'ArrowUp') {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.code === 'ArrowDown') {
        event.preventDefault();
        moveSelection(1);
      } else if (event.code === 'Enter') {
        event.preventDefault();
        void enterPlayFromSelect();
      } else if (event.code === 'KeyG') {
        const next =
          GAUGE_TYPES[(GAUGE_TYPES.indexOf(playOptions.gaugeType) + 1) % GAUGE_TYPES.length];
        if (next !== undefined) playOptions.gaugeType = next;
        renderOptionsBar();
        savePlayOptions();
      } else if (event.code === 'KeyA') {
        playOptions.autoplay = !playOptions.autoplay;
        renderOptionsBar();
        savePlayOptions();
      }
      return;
    }
    if (screen === 'RESULTS') {
      if (event.code === 'Enter') {
        event.preventDefault();
        void retryFromResults();
      } else if (event.code === 'Escape') {
        event.preventDefault();
        lastResult = null;
        machine.transition('SONG_SELECT');
        renderSongList();
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
      if (bootError !== null || catalog === null) {
        bootNote.textContent = `cannot continue: ${bootError ?? 'song library missing'}`;
        return;
      }
      renderSongList();
      renderOptionsBar();
      machine.transition('SONG_SELECT');
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
