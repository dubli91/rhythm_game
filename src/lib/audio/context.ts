// Thin Web Audio wrapper (specs/audio-playback.md MUST 1, 9): the three-tier
// gain bus (music/effects -> master -> destination), user-gesture unlock, and
// an adapter exposing this context's clocks to the song clock
// (../clock/audioClock, MUST 5-6). The AudioContext itself is never
// constructed here — per autoplay policy, the caller creates it (or a stub,
// in tests) after a user gesture and hands it in.

import type { ClockSources } from '../clock/audioClock';

/** The subset of AudioContext this app touches (lets tests pass a stub; app passes the real one). */
export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNode;
  resume(): Promise<void>;
  close(): Promise<void>;
  createGain(): GainNode;
  getOutputTimestamp?: () => AudioTimestamp;
}

export interface VolumeSettings {
  master: number;
  music: number;
  effects: number;
}

export interface GameAudio {
  readonly ctx: AudioContextLike;
  readonly musicBus: GainNode; // → masterBus
  readonly effectsBus: GainNode; // → masterBus
  readonly masterBus: GainNode; // → destination
  /** Resumes if suspended; safe to call on every user gesture. Resolves true when running. */
  unlock(): Promise<boolean>;
  setVolumes(v: Partial<VolumeSettings>): void;
  getVolumes(): VolumeSettings;
  clockSources(): ClockSources;
  dispose(): Promise<void>;
}

const DEFAULT_VOLUMES: VolumeSettings = { master: 1, music: 1, effects: 1 };

/** Clamp a volume to [0, 1] — the single range rule shared with the settings screen. */
export function clampVolume(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function createGameAudio(
  ctx: AudioContextLike,
  initialVolumes?: Partial<VolumeSettings>,
): GameAudio {
  const masterBus = ctx.createGain();
  const musicBus = ctx.createGain();
  const effectsBus = ctx.createGain();

  musicBus.connect(masterBus);
  effectsBus.connect(masterBus);
  masterBus.connect(ctx.destination);

  const volumes: VolumeSettings = {
    master: clampVolume(initialVolumes?.master ?? DEFAULT_VOLUMES.master),
    music: clampVolume(initialVolumes?.music ?? DEFAULT_VOLUMES.music),
    effects: clampVolume(initialVolumes?.effects ?? DEFAULT_VOLUMES.effects),
  };
  masterBus.gain.value = volumes.master;
  musicBus.gain.value = volumes.music;
  effectsBus.gain.value = volumes.effects;

  function applyVolumes(v: Partial<VolumeSettings>): void {
    if (v.master !== undefined) {
      volumes.master = clampVolume(v.master);
      masterBus.gain.value = volumes.master;
    }
    if (v.music !== undefined) {
      volumes.music = clampVolume(v.music);
      musicBus.gain.value = volumes.music;
    }
    if (v.effects !== undefined) {
      volumes.effects = clampVolume(v.effects);
      effectsBus.gain.value = volumes.effects;
    }
  }

  async function unlock(): Promise<boolean> {
    if (ctx.state !== 'running') {
      await ctx.resume();
    }
    return ctx.state === 'running';
  }

  function setVolumes(v: Partial<VolumeSettings>): void {
    applyVolumes(v);
  }

  function getVolumes(): VolumeSettings {
    return { ...volumes };
  }

  function clockSources(): ClockSources {
    const getOutputTimestamp = ctx.getOutputTimestamp;
    const sources: ClockSources = {
      ctxNow: () => ctx.currentTime,
      performanceNow: () => performance.now(),
    };
    if (getOutputTimestamp) {
      sources.getOutputTimestamp = () => getOutputTimestamp.call(ctx);
    }
    return sources;
  }

  async function dispose(): Promise<void> {
    musicBus.disconnect();
    effectsBus.disconnect();
    masterBus.disconnect();
    await ctx.close();
  }

  return {
    ctx,
    musicBus,
    effectsBus,
    masterBus,
    unlock,
    setVolumes,
    getVolumes,
    clockSources,
    dispose,
  };
}
