// Play-session controller: wires audio clock -> input -> judgement -> scoring/gauge -> renderer
// for one song attempt (specs/judgement-scoring.md, gauge-clear.md, audio-playback.md,
// playfield-rendering.md, app-shell-navigation.md MUST 9/14).
//
// The controller owns the rAF loop and all game state; the renderer is strictly read-only.
// Song time comes exclusively from the SongClock (AudioContext.currentTime); input events are
// converted from their event.timeStamp so frame delay never becomes judgement error.

import type { GameAudio } from '../../lib/audio/context';
import { computeNoteTimesMs, createTimingIndex } from '../../lib/chart/timing';
import type { Chart, Song } from '../../lib/chart/types';
import { createSongClock } from '../../lib/clock/audioClock';
import { applyArrangement } from './arrange';
import { createDevOverlay } from './devOverlay';
import { type ClearLamp, clearLampFor, createGauge } from './gauge';
import { DEFAULT_KEY_MAP, type LaneKeyMap, createPlayInput } from './input';
import { createJudge } from './judgement';
import { clampCover, clampGreenTarget, stepCover, stepGreenTarget, stepHiSpeed } from './options';
import {
  NOTE_BROKEN,
  NOTE_CONSUMED,
  NOTE_HELD,
  NOTE_MISSED,
  type PlayFrameView,
  createPlayfieldRenderer,
  greenNumberFor,
  lockedHiSpeedFor,
} from './render';
import { createScorer } from './scoring';
import type { ScoreSummary } from './scoring';
import { type SongAudioContextLike, createSongPlayer } from './songPlayer';
import type { Arrangement, GaugeType, JudgementEvent } from './types';

export interface PlayResult {
  /** false when the player abandoned via Escape before the song ended. */
  finishedSong: boolean;
  abandoned: boolean;
  clear: boolean;
  lamp: ClearLamp;
  gaugeType: GaugeType;
  finalGauge: number;
  /** 0..1 song position where the run ended (1 for completed songs). */
  endedAtProgress: number;
  score: ScoreSummary;
  autoplay: boolean;
  /** Song/chart identity for record keying (results-records.md req 4). */
  songId: string;
  chartId: string;
  /** Options used, for results/record display (results-records.md req 1). Hi-speed
   *  and SUDDEN+ report their FINAL values so in-play adjustments persist to the
   *  next play (play-options.md MUST 4/8). */
  hiSpeed: number;
  arrangement: Arrangement;
  suddenPlusEnabled: boolean;
  /** 0..80 (%) */
  suddenPlusCover: number;
  /** Green-number lock (play-options.md MUST 15/16): the in-play PageUp/PageDown
   *  target adjustments persist via the final value, like hiSpeed. */
  greenLockEnabled: boolean;
  greenLockTargetMs: number;
}

export interface PlaySessionOptions {
  song: Song;
  chart: Chart;
  audioBuffer: AudioBuffer;
  gaugeType: GaugeType;
  autoplay: boolean;
  mount: HTMLElement;
  gameAudio: GameAudio;
  /** The raw AudioContext (createBufferSource/decodeAudioData live here, not on AudioContextLike). */
  audioCtx: SongAudioContextLike;
  globalOffsetMs: number;
  keyMap?: LaneKeyMap;
  hiSpeed?: number;
  /** Defaults to 'OFF'; recorded on the result (play-options.md req 10). */
  arrangement?: Arrangement;
  /** RANDOM permutation seed; omitted = fresh roll per attempt (retries re-roll). */
  arrangementSeed?: number;
  /** SUDDEN+ lane cover carried into the session (play-options.md MUST 5-8). */
  suddenPlusEnabled?: boolean;
  /** 0..80 (%) */
  suddenPlusCover?: number;
  /** Green-number lock (play-options.md MUST 15-17): when enabled the effective
   *  hi-speed is derived per frame from the current BPM + cover; hiSpeed above
   *  is kept as the untouched manual value. ON/OFF is a select-panel decision —
   *  it cannot be toggled mid-play, only the target adjusts. */
  greenLockEnabled?: boolean;
  greenLockTargetMs?: number;
  onFinished(result: PlayResult): void;
}

export interface PlaySession {
  /** Abandon the session programmatically (same path as Escape). */
  abandon(): void;
  /** True until onFinished has been delivered. */
  isRunning(): boolean;
}

/** How long an autoplay hit lights up its lane beam, in ms. */
const AUTOPLAY_BEAM_MS = 90;
/** Delay after the audio buffer ends before results, so the last judgement text is readable. */
const RESULT_DELAY_MS = 300;
/** How long an option change (hi-speed / SUDDEN+) stays on screen (play-options.md MUST 3). */
const OPTION_FLASH_MS = 800;

function bpmAtBeat(chart: Chart, beat: number): number {
  let bpm = chart.bpm.init;
  for (const event of chart.timing.bpmEvents) {
    if (event.beat > beat) break;
    bpm = event.bpm;
  }
  return bpm;
}

export async function startPlaySession(opts: PlaySessionOptions): Promise<PlaySession> {
  const { song, autoplay } = opts;
  const resolvedArrangement = opts.arrangement ?? 'OFF';
  // Pure lane substitution applied ONCE, before judge/renderer/autoplay ever see the
  // chart — every consumer agrees on lanes and judgement/gauge stay provably
  // unaffected (play-options.md MUST 10). Timing derives from beats only, so note
  // times are identical either way.
  const chart = applyArrangement(
    opts.chart,
    resolvedArrangement,
    opts.arrangementSeed ?? Math.floor(Math.random() * 0x100000000),
  );
  const timingIndex = createTimingIndex(chart.timing);
  const noteTimesMs = computeNoteTimesMs(chart);
  // CN tail times (chart-format.md SHOULD 9): computeNoteTimesMs only converts head
  // beats, so the controller resolves endBeat through the same timing index.
  const noteEndTimesMs = chart.notes.map((note) =>
    note.endBeat === undefined ? undefined : timingIndex.beatToMs(note.endBeat),
  );
  const totalNotes = chart.notes.length;

  const judge = createJudge(
    chart.notes.map((note, i) => ({
      timeMs: noteTimesMs[i] ?? 0,
      lane: note.lane,
      endTimeMs: noteEndTimesMs[i],
    })),
  );
  const scorer = createScorer(totalNotes);
  const gauge = createGauge(opts.gaugeType, { total: chart.total, noteCount: totalNotes });

  const renderer = await createPlayfieldRenderer({
    mount: opts.mount,
    chart,
    songTitle: `${song.title} / ${song.artist}`,
  });

  const clock = createSongClock(opts.gameAudio.clockSources(), {
    globalOffsetMs: opts.globalOffsetMs,
    perSongOffsetMs: song.audio.offsetMs,
  });
  const player = createSongPlayer(opts.audioCtx, opts.gameAudio.musicBus);
  const playback = player.play(opts.audioBuffer);
  clock.start(playback.t0);

  const durationMs = opts.audioBuffer.duration * 1000;
  const noteStates = new Uint8Array(totalNotes);
  const heldLanes: boolean[] = new Array<boolean>(8).fill(false);
  const autoplayBeamUntil = new Float64Array(8);
  let lastJudgement: PlayFrameView['lastJudgement'] = null;
  let rafId = 0;
  let running = true;
  let ending = false;
  let abandoned = false;
  let autoplayCursor = 0;
  // Mutable during play (play-options.md MUST 3/6); final values land on PlayResult.
  let hiSpeed = opts.hiSpeed ?? 1.0;
  let suddenEnabled = opts.suddenPlusEnabled ?? false;
  let suddenCover = clampCover(opts.suddenPlusCover ?? 0);
  // Green-number lock (play-options.md MUST 15-17): display-only — it feeds the
  // renderer's hiSpeed, never the judge/gauge, so results are provably identical
  // to manual mode for the same inputs.
  const greenLock = opts.greenLockEnabled ?? false;
  let greenTargetMs = clampGreenTarget(opts.greenLockTargetMs ?? 1000);
  // Judgement explosions (playfield-rendering.md MUST 17): per-lane last
  // PGREAT/GREAT hit time; stable arrays shared with the frame view.
  const explosionAtMs = new Float64Array(8).fill(Number.NEGATIVE_INFINITY);
  const explosionPgreat = new Uint8Array(8);
  // Option-change flash is pure UI feedback, so wall-clock time is fine here —
  // the audio clock stays reserved for anything that touches judgement.
  let optionFlashText = '';
  let optionFlashUntilMs = 0;
  // Dev overlay (SHOULD 16 / input-handling SHOULD 10): metrics are per-session,
  // visibility is page-global (survives retries). Mirrored onto the mount's
  // dataset because e2e cannot read canvas text.
  const devOverlay = createDevOverlay();
  let lastDevMirrored = '';
  let lastGreenMirrored = '';

  function flashOption(text: string): void {
    optionFlashText = text;
    optionFlashUntilMs = performance.now() + OPTION_FLASH_MS;
  }

  const view: PlayFrameView = {
    songTimeMs: 0,
    currentBeat: 0,
    currentBpm: chart.bpm.init,
    hiSpeed,
    progress: 0,
    heldLanes,
    noteStates,
    gauge: gauge.snapshot(),
    combo: 0,
    exScore: 0,
    lastJudgement: null,
    explosionAtMs,
    explosionPgreat,
    suddenPlusEnabled: suddenEnabled,
    suddenPlusCover: suddenCover,
    optionFlashText: '',
  };

  function dispatch(event: JudgementEvent): void {
    scorer.apply(event);
    gauge.apply(event);
    if (event.noteIndex >= 0 && event.noteIndex < noteStates.length) {
      // A CN head hit parks the note in HELD until its tail resolves (cnComplete →
      // CONSUMED, cnBreak → BROKEN so the body scrolls off dimmed).
      noteStates[event.noteIndex] =
        event.kind === 'missPoor'
          ? NOTE_MISSED
          : event.kind === 'cnBreak'
            ? NOTE_BROKEN
            : event.kind === 'hit' && chart.notes[event.noteIndex]?.type === 'cn'
              ? NOTE_HELD
              : NOTE_CONSUMED;
    }
    // A completed hold is silent — the head's judgement text is the note's grade.
    if (event.kind !== 'cnComplete') {
      lastJudgement = { grade: event.grade, kind: event.kind, atSongTimeMs: event.songTimeMs };
    }
    // Explosion on PGREAT/GREAT hits only (playfield-rendering.md MUST 17):
    // kind === 'hit' covers taps AND CN heads while excluding cnComplete, whose
    // PGREAT grade is cosmetic (never scored or displayed).
    if (event.kind === 'hit' && (event.grade === 'PGREAT' || event.grade === 'GREAT')) {
      explosionAtMs[event.lane] = event.songTimeMs;
      explosionPgreat[event.lane] = event.grade === 'PGREAT' ? 1 : 0;
    }
  }

  const input = createPlayInput(window, {
    keyMap: opts.keyMap ?? DEFAULT_KEY_MAP,
    onLane(e) {
      if (autoplay) return; // demo mode: player keys don't judge
      heldLanes[e.lane] = e.down;
      if (ending) return;
      const t = clock.eventTimeToSongTimeMs(e.timeStampMs);
      for (const miss of judge.advance(t)) dispatch(miss);
      if (e.down) {
        dispatch(judge.onInput(e.lane, t));
        // Keydown → judgement-processed delay (input-handling.md SHOULD 10):
        // event.timeStamp and performance.now() share a time base. Diagnostic
        // only — the judgement above already used the event time.
        devOverlay.recordInputLatency(performance.now() - e.timeStampMs);
      } else {
        // CN tail resolution (judgement-scoring.md SHOULD 12); null for the common
        // keyup-after-a-tap case, which must stay free of penalties.
        const release = judge.onRelease(e.lane, t);
        if (release !== null) dispatch(release);
      }
    },
    onControl(e) {
      switch (e.action) {
        case 'quit':
          endSession({ abandonedRun: true });
          break;
        case 'hiSpeedUp':
        case 'hiSpeedDown':
          if (greenLock) {
            // Locked mode repurposes PageUp/PageDown for the target (MUST 16):
            // PageUp = faster = shorter visible time, so the target DECREASES.
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
          // White number only moves while the cover is shown (IIDX convention);
          // the height is remembered across toggles.
          if (!suddenEnabled) break;
          suddenCover = stepCover(suddenCover, e.action === 'coverUp' ? 1 : -1);
          flashOption(`SUDDEN+ ${suddenCover}%`);
          break;
        case 'devOverlayToggle':
          devOverlay.toggle();
          break;
      }
    },
  });
  input.attach();

  function cleanup(): void {
    running = false;
    cancelAnimationFrame(rafId);
    input.detach();
    renderer.destroy();
    delete opts.mount.dataset.devOverlay;
    delete opts.mount.dataset.green;
  }

  function buildResult(endProgress: number, finishedSong: boolean): PlayResult {
    const score = scorer.snapshot();
    const clear = !abandoned && finishedSong && gauge.finalResult() === 'CLEAR';
    return {
      finishedSong,
      abandoned,
      clear,
      lamp: clearLampFor(opts.gaugeType, clear, score.fullCombo && clear),
      gaugeType: opts.gaugeType,
      finalGauge: gauge.value(),
      endedAtProgress: endProgress,
      score,
      autoplay,
      songId: song.songId,
      chartId: chart.chartId,
      hiSpeed,
      arrangement: resolvedArrangement,
      suddenPlusEnabled: suddenEnabled,
      suddenPlusCover: suddenCover,
      greenLockEnabled: greenLock,
      greenLockTargetMs: greenTargetMs,
    };
  }

  function endSession(cause: {
    abandonedRun?: boolean;
    failed?: boolean;
    completed?: boolean;
  }): void {
    if (ending) return;
    ending = true;
    abandoned = cause.abandonedRun === true;
    const endProgress = cause.completed
      ? 1
      : Math.min(1, Math.max(0, clockSafeTime() / durationMs));
    const finishedSong = cause.completed === true;
    // Fade-out-then-stop is the single stop path for abandon/fail/natural end alike
    // (audio-playback.md MUST 4; natural end has nothing left to fade).
    void playback.stop().then(() => {
      cleanup();
      opts.onFinished(buildResult(endProgress, finishedSong));
    });
  }

  function clockSafeTime(): number {
    try {
      return clock.songTimeMs();
    } catch {
      return 0;
    }
  }

  playback.ended.then(() => {
    if (ending) return;
    // Natural audio end: finalize any straggler notes, then deliver results.
    const t = durationMs + 10_000;
    for (const miss of judge.advance(t)) dispatch(miss);
    endSession({ completed: true });
  });

  function frame(): void {
    if (!running) return;
    devOverlay.frameTick(performance.now());
    const t = clockSafeTime();

    if (!ending) {
      if (autoplay) {
        // Perfect play: consume each note exactly at its own time (judgement/gauge animate).
        while (autoplayCursor < totalNotes) {
          const noteTime = noteTimesMs[autoplayCursor] ?? 0;
          if (noteTime > t) break;
          const note = chart.notes[autoplayCursor];
          if (note !== undefined && judge.noteState(autoplayCursor) === 'pending') {
            // Resolve holds ending at/before this press first: after a frame stall the
            // catch-up loop can press two same-lane CNs in one frame, and the second
            // onInput would otherwise replace the first still-active hold unresolved
            // (stuck 'held' forever). Safe re: misses — every earlier note was already
            // pressed, and later notes have timeMs >= noteTime, outside the bad window.
            for (const event of judge.advance(noteTime)) dispatch(event);
            dispatch(judge.onInput(note.lane, noteTime));
            // Autoplay never releases: judge.advance() auto-completes the hold at its
            // end time, so the beam stays lit through the whole CN body.
            const beamBase = noteEndTimesMs[autoplayCursor] ?? noteTime;
            autoplayBeamUntil[note.lane] = beamBase + AUTOPLAY_BEAM_MS;
          }
          autoplayCursor++;
        }
        for (let lane = 0; lane < 8; lane++) heldLanes[lane] = t < (autoplayBeamUntil[lane] ?? 0);
      }
      for (const miss of judge.advance(t)) dispatch(miss);

      if (gauge.failed()) {
        endSession({ failed: true });
      } else if (t > durationMs + RESULT_DELAY_MS) {
        // Belt-and-braces: ended promise should have fired already.
        endSession({ completed: true });
      }
    }

    const beat = timingIndex.msToBeat(t);
    view.songTimeMs = t;
    view.currentBeat = beat;
    view.currentBpm = bpmAtBeat(chart, beat);
    // Green-number lock (play-options.md MUST 15/17): re-derive the effective
    // hi-speed every frame from the live BPM + cover, so soflan and in-play
    // cover changes keep the visible time pinned to the target (clamped to the
    // manual range — the HUD GREEN then shows the true, differing value).
    view.hiSpeed = greenLock
      ? lockedHiSpeedFor(view.currentBpm, greenTargetMs, suddenEnabled ? suddenCover : 0)
      : hiSpeed;
    view.suddenPlusEnabled = suddenEnabled;
    view.suddenPlusCover = suddenCover;
    view.optionFlashText = performance.now() < optionFlashUntilMs ? optionFlashText : '';
    view.progress = Math.min(1, Math.max(0, t / durationMs));
    view.gauge = gauge.snapshot();
    const score = scorer.snapshot();
    view.combo = score.combo;
    view.exScore = score.exScore;
    view.lastJudgement = lastJudgement;
    const devText = devOverlay.text();
    view.devText = devText;
    if (devText !== lastDevMirrored) {
      opts.mount.dataset.devOverlay = devText;
      lastDevMirrored = devText;
    }
    // Mirror the HUD green number for e2e (canvas text is unreadable there) —
    // same pattern as data-dev-overlay. This is what proves "GREEN holds the
    // target through a BPM change" at the browser surface.
    const greenMirror = String(
      greenNumberFor(view.currentBpm, view.hiSpeed, suddenEnabled ? suddenCover : 0),
    );
    if (greenMirror !== lastGreenMirrored) {
      opts.mount.dataset.green = greenMirror;
      lastGreenMirrored = greenMirror;
    }
    renderer.update(view);

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  return {
    abandon(): void {
      endSession({ abandonedRun: true });
    },
    isRunning(): boolean {
      return running;
    },
  };
}
