// Practice pattern editor screen (specs/practice-mode.md MUST 1-4, 11, SHOULD 12).
//
// DOM screen (app-shell-navigation.md MUST 13): an 8-lane × time grid rendered
// bottom-up (beat 0 at the bottom, matching falling-note intuition), with
// click AND keyboard (arrows + Space) note placement, bars/snap/BPM controls,
// presets, and IndexedDB save/load/delete. All pattern mutations go through
// the pure ops in pattern.ts — this module is presentation only.
//
// Keyboard scope follows app-shell-navigation.md MUST 17: while a text
// input/select has focus it owns the keys (Escape blurs it); grid navigation
// applies otherwise. The editor attaches its own document keydown listener on
// activate() and removes it on deactivate(), like the play session does.

import { LANE_SCRATCH } from '../../lib/chart/types';
import {
  MAX_BARS,
  MAX_PATTERN_BPM,
  MIN_BARS,
  MIN_PATTERN_BPM,
  PRACTICE_PRESETS,
  type PracticePattern,
  SNAP_VALUES,
  type SnapValue,
  cellCount,
  createEmptyPattern,
  notesInCell,
  setBars,
  setBpm,
  setSnap,
  sortNotes,
  toggleCell,
} from './pattern';
import { deletePracticePattern, listPracticePatterns, savePracticePattern } from './store';

export interface PracticeEditorOptions {
  mount: HTMLElement;
  /** null when IndexedDB is unavailable — save/load degrade with a message. */
  getDb(): IDBDatabase | null;
  onStartPractice(pattern: PracticePattern, targetLoops: number | null): void;
  onExit(): void;
}

export interface PracticeEditor {
  /** Attach keyboard handling + refresh the saved-pattern list. */
  activate(): void;
  deactivate(): void;
  /** Status line injection point (e.g. the post-session summary). */
  setStatus(text: string): void;
}

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

function freshPatternId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  return `pattern-${rand}`;
}

function laneClass(lane: number): string {
  if (lane === LANE_SCRATCH) return 'lane-sc';
  return lane % 2 === 1 ? 'lane-odd' : 'lane-even';
}

export function createPracticeEditor(opts: PracticeEditorOptions): PracticeEditor {
  const { mount } = opts;
  let pattern: PracticePattern = createEmptyPattern(freshPatternId());
  let cursorLane = 1;
  let cursorCell = 0;
  let active = false;

  // ── static DOM skeleton ────────────────────────────────────────────────────
  mount.appendChild(el('h1', undefined, 'PRACTICE'));
  const statusEl = el('div', 'practice-status');
  mount.appendChild(statusEl);

  const controls = el('div', 'practice-controls');
  function labelled(text: string, control: HTMLElement): HTMLLabelElement {
    const label = el('label', undefined, text);
    label.appendChild(control);
    return label;
  }
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.value = pattern.name;
  const bpmInput = el('input');
  bpmInput.type = 'number';
  bpmInput.min = String(MIN_PATTERN_BPM);
  bpmInput.max = String(MAX_PATTERN_BPM);
  bpmInput.value = String(pattern.bpm);
  const barsSelect = el('select');
  for (let b = MIN_BARS; b <= MAX_BARS; b++) {
    const option = el('option', undefined, String(b));
    option.value = String(b);
    barsSelect.appendChild(option);
  }
  const snapSelect = el('select');
  for (const snap of SNAP_VALUES) {
    const option = el('option', undefined, `1/${snap}`);
    option.value = String(snap);
    snapSelect.appendChild(option);
  }
  const loopsInput = el('input');
  loopsInput.type = 'number';
  loopsInput.min = '0';
  loopsInput.max = '200';
  loopsInput.value = '0';
  loopsInput.title = '0 = practice until Escape';
  const presetSelect = el('select');
  presetSelect.appendChild(el('option', undefined, '—'));
  for (const preset of PRACTICE_PRESETS) {
    const option = el('option', undefined, preset.name);
    option.value = preset.key;
    presetSelect.appendChild(option);
  }
  controls.append(
    labelled('NAME', nameInput),
    labelled('BPM', bpmInput),
    labelled('BARS', barsSelect),
    labelled('SNAP', snapSelect),
    labelled('LOOPS', loopsInput),
    labelled('PRESET', presetSelect),
  );
  mount.appendChild(controls);

  const buttons = el('div', 'practice-buttons');
  function button(label: string, onClick: () => void): HTMLButtonElement {
    const btn = el('button', 'practice-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      btn.blur(); // keep Space/Enter owned by the grid, not a focused button
      onClick();
    });
    buttons.appendChild(btn);
    return btn;
  }
  button('NEW', () => {
    pattern = createEmptyPattern(freshPatternId());
    syncInputs();
    rebuildGrid();
    setStatus('new pattern');
  });
  button('APPLY PRESET', applyPreset);
  button('SAVE', () => void save());
  button('START PRACTICE', startPractice);
  mount.appendChild(buttons);

  const metaEl = el('div', 'practice-meta');
  mount.appendChild(metaEl);

  const gridHead = el('div', 'practice-grid-head');
  const laneNames = ['SC', '1', '2', '3', '4', '5', '6', '7'];
  for (const name of laneNames) gridHead.appendChild(el('div', undefined, name));
  mount.appendChild(gridHead);
  const gridEl = el('div', 'practice-grid');
  mount.appendChild(gridEl);

  mount.appendChild(el('div', 'practice-list-title', 'SAVED PATTERNS'));
  const listEl = el('ul', 'practice-list');
  mount.appendChild(listEl);

  mount.appendChild(
    el(
      'div',
      'hint',
      '←→↑↓ move cursor · SPACE place/delete · ENTER start · ESC back to select · ' +
        'in practice: ESC edit · PgUp/PgDn hi-speed · Home/↑↓ sudden+ · +/− next-loop BPM',
    ),
  );

  // ── grid ───────────────────────────────────────────────────────────────────
  // cellEls[cellIndex][lane]; rows are appended top-down from the LAST cell so
  // beat 0 sits at the bottom.
  let cellEls: HTMLElement[][] = [];

  function rebuildGrid(): void {
    gridEl.textContent = '';
    const cells = cellCount(pattern);
    cellEls = new Array(cells);
    for (let c = cells - 1; c >= 0; c--) {
      const row: HTMLElement[] = new Array(8);
      for (let lane = 0; lane <= 7; lane++) {
        const cell = el('div', 'pcell');
        cell.dataset.lane = String(lane);
        cell.dataset.cell = String(c);
        if (c % pattern.snap === 0) cell.classList.add('barstart');
        else if (c % (pattern.snap / 4) === 0) cell.classList.add('beatstart');
        row[lane] = cell;
        gridEl.appendChild(cell);
      }
      cellEls[c] = row;
    }
    if (cursorCell >= cells) cursorCell = cells - 1;
    renderCells();
    gridEl.scrollTop = gridEl.scrollHeight; // beat 0 (bottom) visible first
  }

  function renderCells(): void {
    const cells = cellEls.length;
    for (let c = 0; c < cells; c++) {
      const row = cellEls[c];
      if (row === undefined) continue;
      for (let lane = 0; lane <= 7; lane++) {
        const cell = row[lane];
        if (cell === undefined) continue;
        const hasNote = notesInCell(pattern, lane, c).length > 0;
        cell.classList.toggle('note', hasNote);
        cell.classList.toggle('lane-sc', hasNote && lane === LANE_SCRATCH);
        cell.classList.toggle('lane-odd', hasNote && lane !== LANE_SCRATCH && lane % 2 === 1);
        cell.classList.toggle('lane-even', hasNote && lane !== LANE_SCRATCH && lane % 2 === 0);
        cell.classList.toggle('cursor', lane === cursorLane && c === cursorCell);
      }
    }
    metaEl.textContent = `${pattern.notes.length} note(s) · ${pattern.bars} bar(s) @ ${pattern.bpm} BPM`;
  }

  gridEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target === null || target.dataset.lane === undefined || target.dataset.cell === undefined) {
      return;
    }
    cursorLane = Number(target.dataset.lane);
    cursorCell = Number(target.dataset.cell);
    pattern = toggleCell(pattern, cursorLane, cursorCell);
    renderCells();
  });

  // ── controls behavior ──────────────────────────────────────────────────────
  function syncInputs(): void {
    nameInput.value = pattern.name;
    bpmInput.value = String(pattern.bpm);
    barsSelect.value = String(pattern.bars);
    snapSelect.value = String(pattern.snap);
  }
  syncInputs();

  nameInput.addEventListener('change', () => {
    pattern = { ...pattern, name: nameInput.value.trim() || 'Untitled' };
    nameInput.value = pattern.name;
  });
  bpmInput.addEventListener('change', () => {
    pattern = setBpm(pattern, Number(bpmInput.value));
    bpmInput.value = String(pattern.bpm);
    renderCells();
  });
  barsSelect.addEventListener('change', () => {
    pattern = setBars(pattern, Number(barsSelect.value));
    rebuildGrid();
  });
  snapSelect.addEventListener('change', () => {
    const snap = Number(snapSelect.value);
    if ((SNAP_VALUES as readonly number[]).includes(snap)) {
      pattern = setSnap(pattern, snap as SnapValue);
      rebuildGrid();
    }
  });

  function applyPreset(): void {
    const preset = PRACTICE_PRESETS.find((p) => p.key === presetSelect.value);
    if (preset === undefined) {
      setStatus('pick a preset first');
      return;
    }
    pattern = { ...pattern, notes: sortNotes(preset.build(pattern.bars)) };
    renderCells();
    setStatus(`preset applied: ${preset.name}`);
  }

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  // ── persistence (practice-mode.md MUST 11) ─────────────────────────────────
  async function save(): Promise<void> {
    const db = opts.getDb();
    if (db === null) {
      setStatus('cannot save: local storage (IndexedDB) unavailable');
      return;
    }
    pattern = { ...pattern, name: nameInput.value.trim() || 'Untitled', updatedAt: Date.now() };
    nameInput.value = pattern.name;
    try {
      await savePracticePattern(db, pattern);
      setStatus(`saved "${pattern.name}"`);
      await refreshList();
    } catch (err) {
      setStatus(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function refreshList(): Promise<void> {
    const db = opts.getDb();
    listEl.textContent = '';
    if (db === null) {
      listEl.appendChild(el('li', 'practice-list-empty', 'IndexedDB unavailable'));
      return;
    }
    try {
      const patterns = await listPracticePatterns(db);
      if (patterns.length === 0) {
        listEl.appendChild(el('li', 'practice-list-empty', 'no saved patterns yet'));
        return;
      }
      for (const saved of patterns) {
        const li = el('li');
        li.appendChild(el('span', 'practice-list-name', saved.name));
        li.appendChild(
          el(
            'span',
            'practice-list-meta',
            `${saved.notes.length}n · ${saved.bars} bar(s) · ${saved.bpm} BPM`,
          ),
        );
        const loadBtn = el('button', 'practice-btn small', 'LOAD');
        loadBtn.type = 'button';
        loadBtn.addEventListener('click', () => {
          loadBtn.blur();
          pattern = saved;
          syncInputs();
          rebuildGrid();
          setStatus(`loaded "${saved.name}"`);
        });
        const deleteBtn = el('button', 'practice-btn small', 'DELETE');
        deleteBtn.type = 'button';
        deleteBtn.addEventListener('click', () => {
          deleteBtn.blur();
          if (!window.confirm(`Delete pattern "${saved.name}"?`)) return;
          void deletePracticePattern(db, saved.patternId)
            .then(() => {
              setStatus(`deleted "${saved.name}"`);
              return refreshList();
            })
            .catch((err: unknown) => {
              setStatus(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        });
        li.append(loadBtn, deleteBtn);
        listEl.appendChild(li);
      }
    } catch (err) {
      listEl.appendChild(
        el(
          'li',
          'practice-list-empty',
          `could not list patterns: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  function startPractice(): void {
    if (pattern.notes.length === 0) {
      setStatus('place at least one note (or apply a preset) before practicing');
      return;
    }
    const loops = Number(loopsInput.value);
    pattern = { ...pattern, name: nameInput.value.trim() || 'Untitled' };
    opts.onStartPractice(pattern, Number.isFinite(loops) && loops >= 1 ? Math.floor(loops) : null);
  }

  // ── keyboard (attached while the screen is active) ─────────────────────────
  function handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const inWidget =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLButtonElement;
    if (inWidget) {
      // Focused widget owns the keys (MUST 17); Escape releases focus.
      if (event.code === 'Escape') {
        event.preventDefault();
        (target as HTMLElement).blur();
      }
      return;
    }
    switch (event.code) {
      case 'Escape':
        event.preventDefault();
        opts.onExit();
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault();
        const dir = event.code === 'ArrowRight' ? 1 : -1;
        cursorLane = Math.min(7, Math.max(0, cursorLane + dir));
        renderCells();
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        // Grid is bottom-up: ArrowUp moves to a LATER time cell.
        const dir = event.code === 'ArrowUp' ? 1 : -1;
        cursorCell = Math.min(cellCount(pattern) - 1, Math.max(0, cursorCell + dir));
        renderCells();
        const row = cellEls[cursorCell];
        row?.[cursorLane]?.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'Space':
        event.preventDefault();
        pattern = toggleCell(pattern, cursorLane, cursorCell);
        renderCells();
        break;
      case 'Enter':
        event.preventDefault();
        startPractice();
        break;
    }
  }

  rebuildGrid();

  return {
    activate(): void {
      if (active) return;
      active = true;
      document.addEventListener('keydown', handleKeyDown);
      void refreshList();
    },
    deactivate(): void {
      if (!active) return;
      active = false;
      document.removeEventListener('keydown', handleKeyDown);
    },
    setStatus,
  };
}
