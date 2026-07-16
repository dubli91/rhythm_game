// Playfield renderer + HUD (specs/playfield-rendering.md).
//
// RENDER-ONLY. This module reads a per-frame `PlayFrameView` and draws it with
// PixiJS (WebGL). It MUST NOT contain game logic: no timing/beat derivation
// beyond the note-position formula (spec MUST 4), no judgement/gauge decisions,
// no audio, no requestAnimationFrame timestamps (spec MUST 6). Frame drops must
// never affect game state (spec MUST 13) — the renderer is read-only.
//
// update() runs once per rAF and performs ZERO allocations: every display object
// is created up-front and only its numeric properties (x/y/width/tint/visible)
// are mutated. Strings are rebuilt only when a displayed value actually changed.

import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Chart, Note } from '../../lib/chart/types';
import type { GaugeType, JudgementGrade, JudgementKind } from './types';

export interface PlayRenderInit {
  /** Renderer appends its canvas here and removes it on destroy. */
  mount: HTMLElement;
  chart: Chart;
  songTitle: string;
}

// Note display states, written by the controller each frame (parallel to chart.notes).
export const NOTE_PENDING = 0;
export const NOTE_CONSUMED = 1;
export const NOTE_MISSED = 2;
export type NoteRenderState = 0 | 1 | 2;

export interface PlayFrameView {
  songTimeMs: number;
  /** Controller derives this from the audio clock (TimingIndex.msToBeat). The
   *  renderer NEVER computes time itself. */
  currentBeat: number;
  currentBpm: number;
  /** Read fresh every frame — the controller may adjust it mid-play (PageUp/PageDown). */
  hiSpeed: number;
  /** 0..1 song progress. */
  progress: number;
  /** Length 8, index 0 = scratch. */
  heldLanes: readonly boolean[];
  /** Parallel to chart.notes. */
  noteStates: Uint8Array;
  gauge: { type: GaugeType; value: number; clearLine: number; isSurvival: boolean };
  combo: number;
  exScore: number;
  lastJudgement: { grade: JudgementGrade; kind: JudgementKind; atSongTimeMs: number } | null;
  /** SUDDEN+ cover over the top of the lanes (spec MUST 11, play-options.md MUST 5-7). */
  suddenPlusEnabled: boolean;
  /** Cover height as % of the scroll area above the judgement line (0..80). */
  suddenPlusCover: number;
  /** Brief option-change readout, '' when nothing to show (play-options.md MUST 3). */
  optionFlashText: string;
}

export interface PlayfieldRenderer {
  /** Called once per rAF by the controller. */
  update(view: PlayFrameView): void;
  /** Full teardown; safe to call twice. */
  destroy(): void;
}

// ── Layout & constants (exported for future tuning) ─────────────────────────
export const RENDER_LAYOUT = {
  WIDTH: 1280,
  HEIGHT: 720,
  BG_COLOR: 0x05060a,

  PLAYFIELD_X: 80,
  LANE_TOP_Y: 0,
  JUDGEMENT_LINE_Y: 600,

  SCRATCH_WIDTH: 100,
  KEY_WIDTH: 62,
  LANE_GAP: 2,

  PIXELS_PER_BEAT: 130,
  NOTE_HEIGHT: 13,
  NOTE_INSET: 4, // full lane width minus 4px (2px each side)

  // Visibility window (spec MUST 7/8): only draw a note whose y is in this range.
  CULL_TOP: -40,
  CULL_BOTTOM: 740,

  JUDGEMENT_LINE_HEIGHT: 4,
  JUDGEMENT_LINE_COLOR: 0xff2244,

  BEAM_HEIGHT: 220,
  BEAM_ALPHA: 0.22,

  JUDGEMENT_TEXT_Y: 360,
  COMBO_TEXT_Y: 300,
  JUDGEMENT_HOLD_MS: 500,
  PGREAT_FLASH_MS: 50,

  // Option-change flash sits in the gap between judgement line (600) and gauge (645).
  OPTION_FLASH_Y: 622,
  COVER_COLOR: 0x0d0f1a,

  // HUD
  GAUGE_X: 700,
  GAUGE_Y: 645,
  GAUGE_WIDTH: 530,
  GAUGE_HEIGHT: 26,
  PROGRESS_Y: 6,
  PROGRESS_HEIGHT: 4,
  PANEL_X: 1050,
  EX_SCORE_Y: 80,
  BPM_Y: 130,
  HISPEED_Y: 160,

  INITIAL_NOTE_POOL: 64,
} as const;

// Lane background colors: near-black alternating, scratch slightly red-tinted.
const LANE_BG_SCRATCH = 0x160d12;
const LANE_BG_A = 0x0c0c14;
const LANE_BG_B = 0x101822;

// Note / beam colors (spec MUST 2): scratch red; odd keys white; even keys blue.
const COLOR_SCRATCH = 0xff3344;
const COLOR_KEY_ODD = 0xf0f0f5;
const COLOR_KEY_EVEN = 0x3fa7ff;

// Gauge fill colors.
const GAUGE_SURVIVAL = 0xff3b4c;
const GAUGE_RECOVERY_LOW = 0x2fd8b0;
const GAUGE_RECOVERY_HIGH = 0x6ffce0;

// Judgement grade colors.
const GRADE_PGREAT_A = 0xffe066;
const GRADE_PGREAT_B = 0xffffff;
const GRADE_GREAT = 0x9dff4a;
const GRADE_GOOD = 0x4ad2ff;
const GRADE_BAD = 0xb066ff;
const GRADE_POOR = 0xff4455;

function laneColor(lane: number): number {
  if (lane === 0) return COLOR_SCRATCH;
  return lane % 2 === 1 ? COLOR_KEY_ODD : COLOR_KEY_EVEN;
}

/** Left edge and width of each lane (index 0 = scratch, 1..7 = keys). */
function computeLaneGeometry(): { x: readonly number[]; w: readonly number[] } {
  const L = RENDER_LAYOUT;
  const x: number[] = new Array(8);
  const w: number[] = new Array(8);
  x[0] = L.PLAYFIELD_X;
  w[0] = L.SCRATCH_WIDTH;
  let cursor = L.PLAYFIELD_X + L.SCRATCH_WIDTH + L.LANE_GAP;
  for (let lane = 1; lane <= 7; lane++) {
    x[lane] = cursor;
    w[lane] = L.KEY_WIDTH;
    cursor += L.KEY_WIDTH + L.LANE_GAP;
  }
  return { x, w };
}

function gradeColor(grade: JudgementGrade): number {
  switch (grade) {
    case 'PGREAT':
      return GRADE_PGREAT_B;
    case 'GREAT':
      return GRADE_GREAT;
    case 'GOOD':
      return GRADE_GOOD;
    case 'BAD':
      return GRADE_BAD;
    case 'POOR':
      return GRADE_POOR;
  }
}

export async function createPlayfieldRenderer(init: PlayRenderInit): Promise<PlayfieldRenderer> {
  const L = RENDER_LAYOUT;
  const { mount, chart, songTitle } = init;
  const notes: readonly Note[] = chart.notes;
  const lane = computeLaneGeometry();
  const playfieldRight =
    L.PLAYFIELD_X + L.SCRATCH_WIDTH + L.LANE_GAP + 7 * (L.KEY_WIDTH + L.LANE_GAP) - L.LANE_GAP;
  const playfieldWidth = playfieldRight - L.PLAYFIELD_X;
  const playfieldCenterX = L.PLAYFIELD_X + playfieldWidth / 2;

  const app = new Application();
  await app.init({
    width: L.WIDTH,
    height: L.HEIGHT,
    background: L.BG_COLOR,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    antialias: true,
  });

  const canvas = app.canvas;
  mount.appendChild(canvas);

  // ── Scene graph, ordered back-to-front (spec: bg < beams < notes < line < cover < HUD).
  // The SUDDEN+ cover must occlude notes/beams (spec MUST 11) but never the HUD.
  const bgContainer = new Container();
  const beamContainer = new Container();
  const notesContainer = new Container();
  const lineContainer = new Container();
  const coverContainer = new Container();
  const hudContainer = new Container();
  app.stage.addChild(
    bgContainer,
    beamContainer,
    notesContainer,
    lineContainer,
    coverContainer,
    hudContainer,
  );

  // Lane backgrounds (static).
  const laneBg = new Graphics();
  for (let i = 0; i <= 7; i++) {
    const lx = lane.x[i];
    const lw = lane.w[i];
    if (lx === undefined || lw === undefined) continue;
    const color = i === 0 ? LANE_BG_SCRATCH : i % 2 === 1 ? LANE_BG_A : LANE_BG_B;
    laneBg.rect(lx, L.LANE_TOP_Y, lw, L.JUDGEMENT_LINE_Y).fill(color);
  }
  bgContainer.addChild(laneBg);

  // Key beams (spec MUST 9): one sprite per lane, toggled by heldLanes.
  const beams: Sprite[] = new Array(8);
  for (let i = 0; i <= 7; i++) {
    const lx = lane.x[i];
    const lw = lane.w[i];
    const beam = new Sprite(Texture.WHITE);
    if (lx !== undefined && lw !== undefined) {
      beam.x = lx;
      beam.width = lw;
    }
    beam.y = L.JUDGEMENT_LINE_Y - L.BEAM_HEIGHT;
    beam.height = L.BEAM_HEIGHT;
    beam.alpha = L.BEAM_ALPHA;
    beam.tint = laneColor(i);
    beam.visible = false;
    beams[i] = beam;
    beamContainer.addChild(beam);
  }

  // Judgement line (spec MUST 3): red bar across all lanes.
  const judgementLine = new Sprite(Texture.WHITE);
  judgementLine.x = L.PLAYFIELD_X;
  judgementLine.y = L.JUDGEMENT_LINE_Y - L.JUDGEMENT_LINE_HEIGHT / 2;
  judgementLine.width = playfieldWidth;
  judgementLine.height = L.JUDGEMENT_LINE_HEIGHT;
  judgementLine.tint = L.JUDGEMENT_LINE_COLOR;
  lineContainer.addChild(judgementLine);

  // SUDDEN+ cover (spec MUST 11): opaque panel from the top of the lanes, with the
  // white-number % printed on it (play-options.md MUST 7). Created once; only its
  // height/visibility/text mutate per frame (zero-allocation contract).
  const coverSprite = new Sprite(Texture.WHITE);
  coverSprite.x = L.PLAYFIELD_X;
  coverSprite.y = L.LANE_TOP_Y;
  coverSprite.width = playfieldWidth;
  coverSprite.height = 0;
  coverSprite.tint = L.COVER_COLOR;
  coverSprite.visible = false;
  coverContainer.addChild(coverSprite);

  const coverText = new Text({
    text: '',
    style: { fill: 0xffffff, fontFamily: 'Arial', fontSize: 24, fontWeight: 'bold' },
  });
  coverText.anchor.set(0.5, 1);
  coverText.x = playfieldCenterX;
  coverText.visible = false;
  coverContainer.addChild(coverText);

  // Note sprite pool (spec MUST 12): reuse tinted white sprites, never per-note Graphics.
  const notePool: Sprite[] = [];
  function growPool(target: number): void {
    while (notePool.length < target) {
      const s = new Sprite(Texture.WHITE);
      s.height = L.NOTE_HEIGHT;
      s.visible = false;
      notesContainer.addChild(s);
      notePool.push(s);
    }
  }
  growPool(L.INITIAL_NOTE_POOL);

  // ── HUD text ──────────────────────────────────────────────────────────────
  const titleText = new Text({
    text: songTitle,
    style: { fill: 0xe8ecff, fontFamily: 'Arial', fontSize: 22, fontWeight: 'bold' },
  });
  titleText.x = 20;
  titleText.y = 20;
  hudContainer.addChild(titleText);

  const exScoreText = new Text({
    text: 'EX SCORE  0',
    style: { fill: 0xffe9a8, fontFamily: 'Arial', fontSize: 26, fontWeight: 'bold' },
  });
  exScoreText.x = L.PANEL_X;
  exScoreText.y = L.EX_SCORE_Y;
  hudContainer.addChild(exScoreText);

  const bpmText = new Text({
    text: 'BPM  0',
    style: { fill: 0xc8d2ff, fontFamily: 'Arial', fontSize: 18 },
  });
  bpmText.x = L.PANEL_X;
  bpmText.y = L.BPM_Y;
  hudContainer.addChild(bpmText);

  const hiSpeedText = new Text({
    text: 'Hi-Speed  1.00',
    style: { fill: 0xc8d2ff, fontFamily: 'Arial', fontSize: 18 },
  });
  hiSpeedText.x = L.PANEL_X;
  hiSpeedText.y = L.HISPEED_Y;
  hudContainer.addChild(hiSpeedText);

  const gaugePctText = new Text({
    text: '0.0%',
    style: { fill: 0xffffff, fontFamily: 'Arial', fontSize: 20, fontWeight: 'bold' },
  });
  gaugePctText.x = L.GAUGE_X + L.GAUGE_WIDTH + 10;
  gaugePctText.y = L.GAUGE_Y + 2;
  hudContainer.addChild(gaugePctText);

  // Gauge track (static) + fill sprite + clear-line tick.
  const gaugeTrack = new Graphics();
  gaugeTrack.rect(L.GAUGE_X, L.GAUGE_Y, L.GAUGE_WIDTH, L.GAUGE_HEIGHT).fill(0x1a1e2a);
  hudContainer.addChild(gaugeTrack);

  const gaugeFill = new Sprite(Texture.WHITE);
  gaugeFill.x = L.GAUGE_X;
  gaugeFill.y = L.GAUGE_Y;
  gaugeFill.height = L.GAUGE_HEIGHT;
  gaugeFill.width = 0;
  gaugeFill.tint = GAUGE_RECOVERY_LOW;
  hudContainer.addChild(gaugeFill);

  const clearTick = new Sprite(Texture.WHITE);
  clearTick.y = L.GAUGE_Y - 3;
  clearTick.width = 2;
  clearTick.height = L.GAUGE_HEIGHT + 6;
  clearTick.tint = 0xffffff;
  clearTick.visible = false;
  hudContainer.addChild(clearTick);

  // Song progress bar (top, full width).
  const progressFill = new Sprite(Texture.WHITE);
  progressFill.x = 0;
  progressFill.y = L.PROGRESS_Y;
  progressFill.height = L.PROGRESS_HEIGHT;
  progressFill.width = 0;
  progressFill.tint = 0x6fa8ff;
  hudContainer.addChild(progressFill);

  // Judgement + combo (spec MUST 10), centered over the lanes.
  const comboText = new Text({
    text: '',
    style: {
      fill: 0xffffff,
      fontFamily: 'Arial',
      fontSize: 52,
      fontWeight: 'bold',
      align: 'center',
    },
  });
  comboText.anchor.set(0.5);
  comboText.x = playfieldCenterX;
  comboText.y = L.COMBO_TEXT_Y;
  comboText.visible = false;
  hudContainer.addChild(comboText);

  const judgementText = new Text({
    text: '',
    style: {
      fill: 0xffffff,
      fontFamily: 'Arial',
      fontSize: 40,
      fontWeight: 'bold',
      align: 'center',
    },
  });
  judgementText.anchor.set(0.5);
  judgementText.x = playfieldCenterX;
  judgementText.y = L.JUDGEMENT_TEXT_Y;
  judgementText.visible = false;
  hudContainer.addChild(judgementText);

  // Brief option-change readout (play-options.md MUST 3): "HI-SPEED 2.25" etc.
  const optionFlash = new Text({
    text: '',
    style: { fill: 0xffe066, fontFamily: 'Arial', fontSize: 20, fontWeight: 'bold' },
  });
  optionFlash.anchor.set(0.5);
  optionFlash.x = playfieldCenterX;
  optionFlash.y = L.OPTION_FLASH_Y;
  optionFlash.visible = false;
  hudContainer.addChild(optionFlash);

  // ── Aspect-fit canvas sizing (spec MUST 1): preserve 16:9, letterbox in mount.
  function handleResize(): void {
    const availW = mount.clientWidth || window.innerWidth;
    const availH = mount.clientHeight || window.innerHeight;
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / L.WIDTH, availH / L.HEIGHT);
    canvas.style.width = `${Math.round(L.WIDTH * scale)}px`;
    canvas.style.height = `${Math.round(L.HEIGHT * scale)}px`;
  }
  handleResize();
  window.addEventListener('resize', handleResize);

  // ── Per-frame state caches (avoid rebuilding strings / re-culling from 0) ───
  let firstLiveNote = 0;
  let lastUsedSprites = 0;
  let lastExScore = -1;
  let lastBpmShown = Number.NaN;
  let lastHiSpeedShown = Number.NaN;
  let lastGaugePctShown = Number.NaN;
  let lastComboShown = -1;
  let lastGradeShown = '';
  let lastClearLineShown = -1;
  let lastCoverShown = -1; // -1 = hidden
  let lastOptionFlashShown = '';
  let destroyed = false;

  function noteY(beat: number, currentBeat: number, hiSpeed: number): number {
    // spec MUST 4 (verbatim): beat-distance based. STOP freezing is free because
    // currentBeat freezes when the controller's clock freezes.
    return L.JUDGEMENT_LINE_Y - (beat - currentBeat) * L.PIXELS_PER_BEAT * hiSpeed;
  }

  function update(view: PlayFrameView): void {
    if (destroyed) return;
    const { currentBeat, hiSpeed } = view;
    const states = view.noteStates;
    const n = notes.length;

    // Advance the live cursor: skip notes that are consumed forever, or missed
    // notes that have already scrolled below the screen (spec MUST 7/8).
    while (firstLiveNote < n) {
      const s = states[firstLiveNote];
      if (s === undefined) break;
      if (s === NOTE_CONSUMED) {
        firstLiveNote++;
        continue;
      }
      if (s === NOTE_MISSED) {
        const note = notes[firstLiveNote];
        if (note !== undefined && noteY(note.beat, currentBeat, hiSpeed) > L.CULL_BOTTOM) {
          firstLiveNote++;
          continue;
        }
      }
      break;
    }

    // Assign visible notes to pool sprites. Notes are ascending by beat, so y
    // decreases as we advance — once above the top edge, all later notes are too.
    let used = 0;
    for (let i = firstLiveNote; i < n; i++) {
      const s = states[i];
      if (s === undefined || s === NOTE_CONSUMED) continue;
      const note = notes[i];
      if (note === undefined) continue;
      const y = noteY(note.beat, currentBeat, hiSpeed);
      if (y > L.CULL_BOTTOM) continue;
      if (y < L.CULL_TOP) break;
      const lx = lane.x[note.lane];
      const lw = lane.w[note.lane];
      if (lx === undefined || lw === undefined) continue;
      if (used >= notePool.length) growPool(notePool.length * 2);
      const spr = notePool[used];
      if (spr === undefined) continue;
      spr.x = lx + L.NOTE_INSET / 2;
      spr.y = y - L.NOTE_HEIGHT / 2;
      spr.width = lw - L.NOTE_INSET;
      spr.tint = laneColor(note.lane);
      spr.visible = true;
      used++;
    }
    for (let k = used; k < lastUsedSprites; k++) {
      const spr = notePool[k];
      if (spr !== undefined) spr.visible = false;
    }
    lastUsedSprites = used;

    // Key beams (spec MUST 9).
    for (let i = 0; i <= 7; i++) {
      const beam = beams[i];
      if (beam === undefined) continue;
      beam.visible = view.heldLanes[i] === true;
    }

    // Judgement + combo text (spec MUST 10).
    const j = view.lastJudgement;
    if (j !== null) {
      const age = view.songTimeMs - j.atSongTimeMs;
      if (age >= 0 && age < L.JUDGEMENT_HOLD_MS) {
        if (lastGradeShown !== j.grade) {
          judgementText.text = j.grade;
          lastGradeShown = j.grade;
        }
        if (j.grade === 'PGREAT') {
          // Flash: alternate tint + scale pulse to distinguish PGREAT.
          const phase = Math.floor(age / L.PGREAT_FLASH_MS) % 2;
          judgementText.tint = phase === 0 ? GRADE_PGREAT_A : GRADE_PGREAT_B;
          judgementText.scale.set(phase === 0 ? 1.15 : 1.0);
        } else {
          judgementText.tint = gradeColor(j.grade);
          judgementText.scale.set(1.0);
        }
        judgementText.visible = true;
      } else {
        judgementText.visible = false;
      }
    } else {
      judgementText.visible = false;
    }

    // Combo, shown only when >= 2.
    if (view.combo >= 2) {
      if (lastComboShown !== view.combo) {
        comboText.text = String(view.combo);
        lastComboShown = view.combo;
      }
      comboText.visible = judgementText.visible;
    } else {
      comboText.visible = false;
      lastComboShown = view.combo;
    }

    // Gauge fill (spec MUST 3).
    const g = view.gauge;
    const clamped = g.value < 0 ? 0 : g.value > 100 ? 100 : g.value;
    gaugeFill.width = (L.GAUGE_WIDTH * clamped) / 100;
    if (g.isSurvival) {
      gaugeFill.tint = GAUGE_SURVIVAL;
    } else {
      gaugeFill.tint = g.value >= g.clearLine ? GAUGE_RECOVERY_HIGH : GAUGE_RECOVERY_LOW;
    }
    if (lastClearLineShown !== g.clearLine) {
      if (g.clearLine > 0) {
        clearTick.x = L.GAUGE_X + (L.GAUGE_WIDTH * g.clearLine) / 100;
        clearTick.visible = true;
      } else {
        clearTick.visible = false;
      }
      lastClearLineShown = g.clearLine;
    }
    const pct = Math.round(clamped * 10) / 10;
    if (pct !== lastGaugePctShown) {
      gaugePctText.text = `${pct.toFixed(1)}%`;
      lastGaugePctShown = pct;
    }

    // Numeric HUD (update-on-change).
    if (view.exScore !== lastExScore) {
      exScoreText.text = `EX SCORE  ${view.exScore}`;
      lastExScore = view.exScore;
    }
    const bpmShown = Math.round(view.currentBpm * 10) / 10;
    if (bpmShown !== lastBpmShown) {
      bpmText.text = `BPM  ${bpmShown.toFixed(1)}`;
      lastBpmShown = bpmShown;
    }
    const hiShown = Math.round(view.hiSpeed * 100) / 100;
    if (hiShown !== lastHiSpeedShown) {
      hiSpeedText.text = `Hi-Speed  ${hiShown.toFixed(2)}`;
      lastHiSpeedShown = hiShown;
    }

    // SUDDEN+ cover (spec MUST 11). Height is a % of the scroll area above the
    // judgement line, so 60% leaves exactly the bottom 40% visible (play-options.md
    // acceptance criterion).
    const coverPct = view.suddenPlusEnabled ? view.suddenPlusCover : -1;
    if (coverPct !== lastCoverShown) {
      if (coverPct < 0) {
        coverSprite.visible = false;
        coverText.visible = false;
      } else {
        const coverHeight = ((L.JUDGEMENT_LINE_Y - L.LANE_TOP_Y) * coverPct) / 100;
        coverSprite.height = coverHeight;
        coverSprite.visible = true;
        coverText.text = `${coverPct}%`;
        // Just above the cover's bottom edge; floor keeps 0% readable.
        coverText.y = Math.max(L.LANE_TOP_Y + 30, L.LANE_TOP_Y + coverHeight - 6);
        coverText.visible = true;
      }
      lastCoverShown = coverPct;
    }

    // Option-change flash (play-options.md MUST 3): controller owns the timing,
    // renderer just mirrors the string.
    if (view.optionFlashText !== lastOptionFlashShown) {
      optionFlash.text = view.optionFlashText;
      optionFlash.visible = view.optionFlashText !== '';
      lastOptionFlashShown = view.optionFlashText;
    }

    // Progress bar.
    const p = view.progress < 0 ? 0 : view.progress > 1 ? 1 : view.progress;
    progressFill.width = L.WIDTH * p;
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('resize', handleResize);
    if (canvas.parentNode === mount) mount.removeChild(canvas);
    app.destroy(true, { children: true, texture: true });
    notePool.length = 0;
  }

  return { update, destroy };
}
