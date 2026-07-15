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
import { type ClearLamp, clearLampFor, createGauge } from './gauge';
import { DEFAULT_KEY_MAP, type LaneKeyMap, createPlayInput } from './input';
import { createJudge } from './judgement';
import { NOTE_CONSUMED, NOTE_MISSED, type PlayFrameView, createPlayfieldRenderer } from './render';
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
  /** Options used, for results/record display (results-records.md req 1). */
  hiSpeed: number;
  arrangement: Arrangement;
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

function bpmAtBeat(chart: Chart, beat: number): number {
  let bpm = chart.bpm.init;
  for (const event of chart.timing.bpmEvents) {
    if (event.beat > beat) break;
    bpm = event.bpm;
  }
  return bpm;
}

export async function startPlaySession(opts: PlaySessionOptions): Promise<PlaySession> {
  const { chart, song, autoplay } = opts;
  const timingIndex = createTimingIndex(chart.timing);
  const noteTimesMs = computeNoteTimesMs(chart);
  const totalNotes = chart.notes.length;

  const judge = createJudge(
    chart.notes.map((note, i) => ({ timeMs: noteTimesMs[i] ?? 0, lane: note.lane })),
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
  const resolvedHiSpeed = opts.hiSpeed ?? 1.0;
  const resolvedArrangement = opts.arrangement ?? 'OFF';

  const view: PlayFrameView = {
    songTimeMs: 0,
    currentBeat: 0,
    currentBpm: chart.bpm.init,
    hiSpeed: resolvedHiSpeed,
    progress: 0,
    heldLanes,
    noteStates,
    gauge: gauge.snapshot(),
    combo: 0,
    exScore: 0,
    lastJudgement: null,
  };

  function dispatch(event: JudgementEvent): void {
    scorer.apply(event);
    gauge.apply(event);
    if (event.noteIndex >= 0 && event.noteIndex < noteStates.length) {
      noteStates[event.noteIndex] = event.kind === 'missPoor' ? NOTE_MISSED : NOTE_CONSUMED;
    }
    lastJudgement = { grade: event.grade, kind: event.kind, atSongTimeMs: event.songTimeMs };
  }

  const input = createPlayInput(window, {
    keyMap: opts.keyMap ?? DEFAULT_KEY_MAP,
    onLane(e) {
      if (autoplay) return; // demo mode: player keys don't judge
      heldLanes[e.lane] = e.down;
      if (!e.down || ending) return;
      const t = clock.eventTimeToSongTimeMs(e.timeStampMs);
      for (const miss of judge.advance(t)) dispatch(miss);
      dispatch(judge.onInput(e.lane, t));
    },
    onControl(e) {
      if (e.action === 'quit') endSession({ abandonedRun: true });
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
      hiSpeed: resolvedHiSpeed,
      arrangement: resolvedArrangement,
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
            dispatch(judge.onInput(note.lane, noteTime));
            autoplayBeamUntil[note.lane] = noteTime + AUTOPLAY_BEAM_MS;
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
