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
import { type ClearLamp, clearLampFor, createGauge } from './gauge';
import { DEFAULT_KEY_MAP, type LaneKeyMap, createPlayInput } from './input';
import { createJudge } from './judgement';
import { clampCover, stepCover, stepHiSpeed } from './options';
import {
  NOTE_BROKEN,
  NOTE_CONSUMED,
  NOTE_HELD,
  NOTE_MISSED,
  type PlayFrameView,
  createPlayfieldRenderer,
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
  // Option-change flash is pure UI feedback, so wall-clock time is fine here —
  // the audio clock stays reserved for anything that touches judgement.
  let optionFlashText = '';
  let optionFlashUntilMs = 0;

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
          hiSpeed = stepHiSpeed(hiSpeed, e.action === 'hiSpeedUp' ? 1 : -1);
          flashOption(`HI-SPEED ${hiSpeed.toFixed(2)}`);
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
      }
    },
  });
  input.attach();

  function cleanup(): void {
    running = false;
    cancelAnimationFrame(rafId);
    input.detach();
    renderer.destroy();
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
    view.hiSpeed = hiSpeed;
    view.suddenPlusEnabled = suddenEnabled;
    view.suddenPlusCover = suddenCover;
    view.optionFlashText = performance.now() < optionFlashUntilMs ? optionFlashText : '';
    view.progress = Math.min(1, Math.max(0, t / durationMs));
    view.gauge = gauge.snapshot();
    const score = scorer.snapshot();
    view.combo = score.combo;
    view.exScore = score.exScore;
    view.lastJudgement = lastJudgement;
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
