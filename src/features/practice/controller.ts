// Practice-session controller (specs/practice-mode.md MUST 5-10).
//
// Reuses the REAL play engines so practice feels identical to song play
// (spec: "판정 엔진·렌더러는 본 게임과 동일한 것을 재사용한다"): createJudge with the
// default windows, createPlayInput (plus practice-only BPM keys), the PixiJS
// playfield renderer (hud: 'practice' — no gauge, MUST 7), and the SongClock
// so judgement uses event timestamps, never frame times.
//
// Timeline model (see schedule.ts): one judge per cycle on a shared session-ms
// axis. Inputs route to the previous cycle's judge until LOOP_HANDOFF_MS past
// its end — provably unambiguous — then the cycle is finalized into stats and
// its judge dropped. Metronome clicks are AudioBufferSourceNodes scheduled at
// exact ctx times (audio-playback.md MUST 8); a rAF stall can never desync
// them because everything derives from the same audio clock.
//
// Practice writes NOTHING to the records store (acceptance criterion) — this
// module has no records dependency at all.

import type { GameAudio } from '../../lib/audio/context';
import {
  type SfxAudioContextLike,
  createSfxScheduler,
  synthClickBuffer,
} from '../../lib/audio/sfx';
import { CHART_FORMAT_VERSION, type Chart } from '../../lib/chart/types';
import { createSongClock } from '../../lib/clock/audioClock';
import { createDevOverlay } from './../play/devOverlay';
import { DEFAULT_KEY_MAP, type LaneKeyMap, createPlayInput } from './../play/input';
import { type Judge, createJudge } from './../play/judgement';
import {
  clampCover,
  clampGreenTarget,
  stepCover,
  stepGreenTarget,
  stepHiSpeed,
} from './../play/options';
import {
  NOTE_CONSUMED,
  NOTE_MISSED,
  type PlayFrameView,
  RENDER_LAYOUT,
  createPlayfieldRenderer,
  formatTimingIndicator,
  lockedHiSpeedFor,
} from './../play/render';
import { formatDeltaHistogram } from './../play/scoring';
import type { JudgementEvent, TimingDisplayMode } from './../play/types';
import { MAX_PATTERN_BPM, MIN_PATTERN_BPM, type PracticePattern, sortNotes } from './pattern';
import {
  LOOP_PREP_AHEAD_SEC,
  type LoopCycle,
  buildSessionNotes,
  cycleBeatsFor,
  cycleClickTimes,
  cycleIndexAt,
  cycleJudgeNotes,
  firstCycle,
  handoffMs,
  nextCycle,
  sessionBeatAt,
} from './schedule';
import {
  type CumulativeStats,
  type LoopStats,
  createPracticeStats,
  formatMeanDelta,
} from './stats';

export interface PracticeOutcome {
  endedBy: 'escape' | 'completed';
  loopsFinalized: number;
  cumulative: CumulativeStats;
  lastLoop: LoopStats | null;
  /** Final values so in-play adjustments persist like song play (play-options.md MUST 4/8). */
  hiSpeed: number;
  suddenPlusEnabled: boolean;
  suddenPlusCover: number;
  /** Green-number lock final values (play-options.md MUST 16 persistence policy). */
  greenLockEnabled: boolean;
  greenLockTargetMs: number;
}

export interface PracticeSessionOptions {
  pattern: PracticePattern;
  /** null = practice until Escape (bounded by the session-size cap below);
   *  a number = auto-end with a summary after that many loops (SHOULD 14). */
  targetLoops: number | null;
  mount: HTMLElement;
  gameAudio: GameAudio;
  /** The raw AudioContext (createBuffer/createBufferSource live here). */
  sfxCtx: SfxAudioContextLike;
  globalOffsetMs: number;
  keyMap?: LaneKeyMap;
  hiSpeed?: number;
  suddenPlusEnabled?: boolean;
  suddenPlusCover?: number;
  /** Green-number lock (play-options.md MUST 15-17) — honored here too so the
   *  scroll feel matches song play ("Hi-speed/SUDDEN+ behave exactly like song
   *  play", practice-mode.md MUST 9 precedent). */
  greenLockEnabled?: boolean;
  greenLockTargetMs?: number;
  /** FAST/SLOW indicator mode — practice shows the same indicator as song play
   *  (playfield-rendering.md MUST 18 "연습 세션에서도 동일하게 동작"). */
  timingDisplay?: TimingDisplayMode;
  onExit(outcome: PracticeOutcome): void;
}

export interface PracticeSession {
  /** Programmatic Escape (same path as the key). */
  stop(): void;
  isRunning(): boolean;
}

/** Practice BPM adjust step per keypress (practice-mode.md MUST 9). */
export const PRACTICE_BPM_STEP = 5;
/** Practice-only control keys, layered over the reserved base set. */
export const PRACTICE_CONTROL_CODES = { Equal: 'bpmUp', Minus: 'bpmDown' } as const;

/** Session-size cap when no target loop count is set: enough for any real
 *  practice run while bounding the renderer's session-note array. */
const MAX_LOOPS = 200;
const MAX_SESSION_NOTES = 20_000;
/** Short lead-in before the first count-in bar; the count-in itself is the
 *  "get ready" period, so this only needs to absorb scheduling latency. */
const LEAD_IN_SEC = 0.75;
const OPTION_FLASH_MS = 800;
/** Metronome voicing: strong (bar start) vs weak beats (MUST 6). */
const CLICK_STRONG_HZ = 1720;
const CLICK_WEAK_HZ = 1080;

function countsLine(label: string, s: LoopStats['summary']): string {
  const c = s.counts;
  return `${label}  PG ${c.PGREAT}  GR ${c.GREAT}  GD ${c.GOOD}  BD ${c.BAD}  PR ${c.POOR}  EP ${s.emptyPoorCount}`;
}

export async function startPracticeSession(opts: PracticeSessionOptions): Promise<PracticeSession> {
  const patternNotes = sortNotes(opts.pattern.notes);
  if (patternNotes.length === 0) {
    throw new Error('practice pattern has no notes');
  }
  const notesPerLoop = patternNotes.length;
  const beatsPerCycle = cycleBeatsFor(opts.pattern.bars);
  const loopsTotal = Math.max(
    1,
    Math.min(
      MAX_LOOPS,
      opts.targetLoops ?? Math.max(1, Math.floor(MAX_SESSION_NOTES / notesPerLoop)),
    ),
  );

  const sessionNotes = buildSessionNotes(patternNotes, loopsTotal, beatsPerCycle);
  // Synthetic chart wrapper: the renderer only reads .notes; timing/gauge fields
  // are inert here because this controller derives beats from the loop schedule.
  const sessionChart: Chart = {
    formatVersion: CHART_FORMAT_VERSION,
    chartId: 'practice-session',
    difficulty: 'NORMAL',
    level: 1,
    total: 100,
    bpm: { init: opts.pattern.bpm, min: MIN_PATTERN_BPM, max: MAX_PATTERN_BPM },
    timing: { bpmEvents: [{ beat: 0, bpm: opts.pattern.bpm }], stopEvents: [] },
    notes: sessionNotes,
  };

  const timingDisplay = opts.timingDisplay ?? 'FAST_SLOW';
  const renderer = await createPlayfieldRenderer({
    mount: opts.mount,
    chart: sessionChart,
    songTitle: `PRACTICE  ${opts.pattern.name}`,
    hud: 'practice',
    timingDisplay,
  });

  const sources = opts.gameAudio.clockSources();
  const clock = createSongClock(sources, { globalOffsetMs: opts.globalOffsetMs });
  const t0 = sources.ctxNow() + LEAD_IN_SEC;
  clock.start(t0);

  const strongClick = synthClickBuffer(opts.sfxCtx, { frequencyHz: CLICK_STRONG_HZ });
  const weakClick = synthClickBuffer(opts.sfxCtx, { frequencyHz: CLICK_WEAK_HZ });
  const sfx = createSfxScheduler(opts.sfxCtx, opts.gameAudio.effectsBus);

  const stats = createPracticeStats(notesPerLoop);
  const cycles: LoopCycle[] = [];
  const judges: Array<Judge | null> = [];
  const noteStates = new Uint8Array(sessionNotes.length);
  const heldLanes: boolean[] = new Array<boolean>(8).fill(false);
  let retiredThrough = 0; // loops < this are finalized
  let pendingBpm = opts.pattern.bpm; // applies from the next locked cycle (MUST 9)
  let lastJudgement: PlayFrameView['lastJudgement'] = null;
  let rafId = 0;
  let running = true;
  let ending = false;
  let hiSpeed = opts.hiSpeed ?? 1.0;
  let suddenEnabled = opts.suddenPlusEnabled ?? false;
  let suddenCover = clampCover(opts.suddenPlusCover ?? 0);
  const greenLock = opts.greenLockEnabled ?? false;
  let greenTargetMs = clampGreenTarget(opts.greenLockTargetMs ?? 1000);
  // Judgement explosions (playfield-rendering.md MUST 17 — practice included).
  const explosionAtMs = new Float64Array(8).fill(Number.NEGATIVE_INFINITY);
  const explosionPgreat = new Uint8Array(8);
  let optionFlashText = '';
  let optionFlashUntilMs = 0;
  let infoDirty = true;
  let infoString = '';
  let lastInfoLoopShown = -1;
  // Dev overlay: same shared toggle as song play (F1), per-session metrics.
  const devOverlay = createDevOverlay();
  let lastDevMirrored = '';
  let lastTimingMirrored = '';

  function flashOption(text: string): void {
    optionFlashText = text;
    optionFlashUntilMs = performance.now() + OPTION_FLASH_MS;
  }

  /** Lock the next cycle: freeze its BPM, create its judge, schedule its clicks. */
  function prepCycle(): void {
    const index = cycles.length;
    if (index >= loopsTotal) return;
    const prev = cycles[index - 1];
    // Session time 0 (= clock t0, LEAD_IN_SEC after now) is where the first
    // count-in bar begins, mirroring song play where songTime 0 = audio start.
    const cycle =
      prev === undefined ? firstCycle(0, pendingBpm, beatsPerCycle) : nextCycle(prev, pendingBpm);
    cycles.push(cycle);
    judges.push(createJudge(cycleJudgeNotes(cycle, patternNotes)));
    const now = sources.ctxNow();
    for (const click of cycleClickTimes(cycle)) {
      const when = t0 + click.timeSec;
      // Skip clicks already in the past (catch-up after a background-tab stall)
      // instead of firing a burst of stale clicks at once.
      if (when < now - 0.05) continue;
      sfx.schedule(click.strong ? strongClick : weakClick, when);
    }
  }
  prepCycle();

  function dispatch(loopIndex: number, event: JudgementEvent): void {
    stats.apply(loopIndex, event);
    if (event.noteIndex >= 0) {
      const sessionIndex = loopIndex * notesPerLoop + event.noteIndex;
      if (sessionIndex < noteStates.length) {
        noteStates[sessionIndex] = event.kind === 'missPoor' ? NOTE_MISSED : NOTE_CONSUMED;
      }
    }
    lastJudgement = {
      grade: event.grade,
      kind: event.kind,
      timing: event.timing,
      deltaMs: event.deltaMs,
      atSongTimeMs: event.songTimeMs,
    };
    // Explosion on PGREAT/GREAT hits (playfield-rendering.md MUST 17). Practice
    // patterns are tap-only, so kind === 'hit' is every scored press here.
    if (event.kind === 'hit' && (event.grade === 'PGREAT' || event.grade === 'GREAT')) {
      explosionAtMs[event.lane] = event.songTimeMs;
      explosionPgreat[event.lane] = event.grade === 'PGREAT' ? 1 : 0;
    }
    infoDirty = true;
  }

  /** Which cycle's judge owns an input at session time tMs (handoff rule). */
  function routeLoopIndex(tMs: number): number {
    const idx = cycleIndexAt(cycles, tMs / 1000);
    const prev = cycles[idx - 1];
    if (prev !== undefined && tMs <= handoffMs(prev) && judges[idx - 1] !== null) {
      return idx - 1;
    }
    return idx;
  }

  const input = createPlayInput(window, {
    keyMap: opts.keyMap ?? DEFAULT_KEY_MAP,
    extraControlCodes: PRACTICE_CONTROL_CODES,
    onLane(e) {
      // "≥1 bound code held" beam rule (input-handling.md MUST 13).
      heldLanes[e.lane] = e.laneHeld;
      if (!e.down || ending) return;
      const t = clock.eventTimeToSongTimeMs(e.timeStampMs);
      const loopIndex = routeLoopIndex(t);
      const judge = judges[loopIndex];
      if (judge === undefined || judge === null) return;
      for (const miss of judge.advance(t)) dispatch(loopIndex, miss);
      dispatch(loopIndex, judge.onInput(e.lane, t));
      // Keydown → judgement-processed delay (input-handling.md SHOULD 10).
      devOverlay.recordInputLatency(performance.now() - e.timeStampMs);
    },
    onControl(e) {
      switch (e.action) {
        case 'quit':
          endSession('escape');
          break;
        case 'hiSpeedUp':
        case 'hiSpeedDown':
          if (greenLock) {
            // PageUp = faster = shorter visible time (play-options.md MUST 16).
            greenTargetMs = stepGreenTarget(greenTargetMs, e.action === 'hiSpeedUp' ? -1 : 1);
            flashOption(`GREEN TARGET ${greenTargetMs}`);
          } else {
            hiSpeed = stepHiSpeed(hiSpeed, e.action === 'hiSpeedUp' ? 1 : -1);
            flashOption(`HI-SPEED ${hiSpeed.toFixed(2)}`);
          }
          break;
        case 'suddenToggle':
          suddenEnabled = !suddenEnabled;
          flashOption(suddenEnabled ? `SUDDEN+ ${suddenCover}%` : 'SUDDEN+ OFF');
          break;
        case 'coverUp':
        case 'coverDown':
          if (!suddenEnabled) break;
          suddenCover = stepCover(suddenCover, e.action === 'coverUp' ? 1 : -1);
          flashOption(`SUDDEN+ ${suddenCover}%`);
          break;
        case 'bpmUp':
        case 'bpmDown': {
          const step = e.action === 'bpmUp' ? PRACTICE_BPM_STEP : -PRACTICE_BPM_STEP;
          pendingBpm = Math.min(MAX_PATTERN_BPM, Math.max(MIN_PATTERN_BPM, pendingBpm + step));
          flashOption(`NEXT LOOP BPM ${pendingBpm}`);
          infoDirty = true;
          break;
        }
        case 'devOverlayToggle':
          devOverlay.toggle();
          break;
      }
    },
  });
  input.attach();

  const view: PlayFrameView = {
    songTimeMs: 0,
    currentBeat: 0,
    currentBpm: opts.pattern.bpm,
    hiSpeed,
    progress: 0,
    heldLanes,
    noteStates,
    gauge: null,
    combo: 0,
    exScore: 0,
    lastJudgement: null,
    explosionAtMs,
    explosionPgreat,
    suddenPlusEnabled: suddenEnabled,
    suddenPlusCover: suddenCover,
    optionFlashText: '',
    infoText: '',
  };

  function clockSafeTime(): number {
    try {
      return clock.songTimeMs();
    } catch {
      return 0;
    }
  }

  function buildOutcome(endedBy: PracticeOutcome['endedBy']): PracticeOutcome {
    return {
      endedBy,
      loopsFinalized: retiredThrough,
      cumulative: stats.cumulative(),
      lastLoop: stats.lastLoop(),
      hiSpeed,
      suddenPlusEnabled: suddenEnabled,
      suddenPlusCover: suddenCover,
      greenLockEnabled: greenLock,
      greenLockTargetMs: greenTargetMs,
    };
  }

  function endSession(endedBy: PracticeOutcome['endedBy']): void {
    if (ending) return;
    ending = true;
    running = false;
    cancelAnimationFrame(rafId);
    input.detach();
    sfx.cancelAll(); // clicks are ≤60ms buffers — no fade path needed
    renderer.destroy();
    delete opts.mount.dataset.devOverlay;
    delete opts.mount.dataset.timing;
    opts.onExit(buildOutcome(endedBy));
  }

  function rebuildInfo(currentLoop: number): void {
    const lines: string[] = [`LOOP ${Math.min(currentLoop + 1, loopsTotal)}/${loopsTotal}`];
    const currentCycle = cycles[Math.min(currentLoop, cycles.length - 1)];
    if (currentCycle !== undefined && pendingBpm !== currentCycle.bpm) {
      lines.push(`NEXT LOOP BPM ${pendingBpm}`);
    }
    lines.push(countsLine('THIS ', stats.liveSummary(currentLoop)));
    const last = stats.lastLoop();
    if (last !== null) {
      lines.push(countsLine('LAST ', last.summary));
      lines.push(
        `       ACC ${last.summary.exPercent.toFixed(1)}% · ${formatMeanDelta(last.meanDeltaMs)}`,
      );
    }
    const total = stats.cumulative();
    if (total.loopsFinalized > 0) {
      lines.push(
        `TOTAL  ACC ${total.exPercent.toFixed(1)}% · ${formatMeanDelta(total.meanDeltaMs)}`,
      );
      lines.push(`       BEST COMBO ${total.bestMaxCombo} · BP ${total.bp}`);
      // δ distribution over all finalized loops (SHOULD 13); '' until a timed hit lands.
      const histogramLine = formatDeltaHistogram(total.deltaHistogram);
      if (histogramLine !== '') lines.push(histogramLine);
    }
    infoString = lines.join('\n');
  }

  function frame(): void {
    if (!running) return;
    devOverlay.frameTick(performance.now());
    const t = clockSafeTime();
    const tSec = t / 1000;

    // Lock upcoming cycles just ahead of real time (BPM freezes here, MUST 9 —
    // "next loop"). The while-loop also catches up after a rAF stall.
    let lastCycle = cycles[cycles.length - 1];
    while (
      cycles.length < loopsTotal &&
      lastCycle !== undefined &&
      sources.ctxNow() - t0 >= lastCycle.endSec - LOOP_PREP_AHEAD_SEC
    ) {
      prepCycle();
      lastCycle = cycles[cycles.length - 1];
    }

    // Sweep active judges for miss POORs; retire cycles past their handoff.
    for (let k = retiredThrough; k < cycles.length; k++) {
      const judge = judges[k];
      const cycle = cycles[k];
      if (judge === undefined || judge === null || cycle === undefined) continue;
      for (const miss of judge.advance(t)) dispatch(k, miss);
      if (t > handoffMs(cycle)) {
        stats.finalizeLoop(k);
        judges[k] = null;
        retiredThrough = k + 1;
        infoDirty = true;
      } else {
        break; // cycles are ordered; later ones can't be past handoff either
      }
    }

    if (retiredThrough >= loopsTotal) {
      // Auto-end with summary (SHOULD 14); handoff already gave the last
      // judgement text ~300ms on screen.
      endSession('completed');
      return;
    }

    const currentLoop = cycleIndexAt(cycles, tSec);
    if (infoDirty || currentLoop !== lastInfoLoopShown) {
      rebuildInfo(currentLoop);
      infoDirty = false;
      lastInfoLoopShown = currentLoop;
    }

    const cycle = cycles[currentLoop];
    const live = stats.liveSummary(currentLoop);
    view.songTimeMs = t;
    view.currentBeat = sessionBeatAt(cycles, tSec);
    view.currentBpm = cycle?.bpm ?? pendingBpm;
    // Green-number lock re-derives per frame like song play; practice BPM only
    // changes at loop boundaries, so this reacts there + on cover changes.
    view.hiSpeed = greenLock
      ? lockedHiSpeedFor(view.currentBpm, greenTargetMs, suddenEnabled ? suddenCover : 0)
      : hiSpeed;
    view.suddenPlusEnabled = suddenEnabled;
    view.suddenPlusCover = suddenCover;
    view.optionFlashText = performance.now() < optionFlashUntilMs ? optionFlashText : '';
    view.progress =
      cycle === undefined
        ? 0
        : Math.min(
            1,
            Math.max(
              0,
              (currentLoop +
                Math.min(
                  1,
                  Math.max(0, (tSec - cycle.startSec) / (cycle.endSec - cycle.startSec)),
                )) /
                loopsTotal,
            ),
          );
    view.combo = live.combo;
    view.exScore = live.exScore;
    view.lastJudgement = lastJudgement;
    view.infoText = infoString;
    const devText = devOverlay.text();
    view.devText = devText;
    if (devText !== lastDevMirrored) {
      opts.mount.dataset.devOverlay = devText;
      lastDevMirrored = devText;
    }
    // FAST/SLOW indicator e2e mirror — same rule as song play's controller.
    let timingMirror = '';
    if (timingDisplay !== 'OFF' && lastJudgement !== null && lastJudgement.timing !== null) {
      const jAge = t - lastJudgement.atSongTimeMs;
      if (jAge >= 0 && jAge < RENDER_LAYOUT.JUDGEMENT_HOLD_MS) {
        timingMirror = formatTimingIndicator(
          timingDisplay,
          lastJudgement.timing,
          lastJudgement.deltaMs ?? 0,
        );
      }
    }
    if (timingMirror !== lastTimingMirrored) {
      opts.mount.dataset.timing = timingMirror;
      lastTimingMirrored = timingMirror;
    }
    renderer.update(view);

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  return {
    stop(): void {
      endSession('escape');
    },
    isRunning(): boolean {
      return running;
    },
  };
}
