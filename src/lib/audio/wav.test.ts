import { describe, expect, it } from 'vitest';
import { TARGET_PEAK_LINEAR, encodeWav16, peakNormalize } from './wav';

function readAscii(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  return new TextDecoder('ascii').decode(bytes);
}

describe('TARGET_PEAK_LINEAR', () => {
  it('is ≈ -1 dBFS as linear amplitude', () => {
    expect(TARGET_PEAK_LINEAR).toBeCloseTo(0.8912509381337456, 12);
  });
});

describe('encodeWav16 header', () => {
  it('writes a standard 44-byte RIFF/WAVE/fmt/data header for stereo audio', () => {
    const numFrames = 10;
    const left = new Float32Array(numFrames);
    const right = new Float32Array(numFrames);
    const buffer = encodeWav16([left, right], 44100);
    const view = new DataView(buffer);

    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(readAscii(view, 8, 4)).toBe('WAVE');
    expect(readAscii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM format
    expect(view.getUint16(22, true)).toBe(2); // numChannels
    expect(view.getUint32(24, true)).toBe(44100); // sampleRate
    expect(view.getUint32(28, true)).toBe(44100 * 2 * 2); // byteRate
    expect(view.getUint16(32, true)).toBe(2 * 2); // blockAlign
    expect(view.getUint16(34, true)).toBe(16); // bitsPerSample
    expect(readAscii(view, 36, 4)).toBe('data');

    const dataLength = numFrames * 2 * 2;
    expect(view.getUint32(40, true)).toBe(dataLength);
    expect(view.getUint32(4, true)).toBe(buffer.byteLength - 8); // fileSize - 8
    expect(buffer.byteLength).toBe(44 + dataLength);
  });

  it('writes a correct header for mono audio', () => {
    const numFrames = 5;
    const mono = new Float32Array(numFrames);
    const buffer = encodeWav16([mono], 22050);
    const view = new DataView(buffer);

    expect(view.getUint16(22, true)).toBe(1); // numChannels
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint32(28, true)).toBe(22050 * 1 * 2); // byteRate
    expect(view.getUint16(32, true)).toBe(1 * 2); // blockAlign

    const dataLength = numFrames * 1 * 2;
    expect(view.getUint32(40, true)).toBe(dataLength);
    expect(buffer.byteLength).toBe(44 + dataLength);
  });
});

describe('encodeWav16 sample encoding', () => {
  it('maps known float samples to int16 with asymmetric scaling, rounding, and clamping', () => {
    const samples = [0, 0.5, -0.5, 1, -1, 1.5, -1.5];
    const mono = new Float32Array(samples);
    const buffer = encodeWav16([mono], 44100);
    const view = new DataView(buffer);

    const expected = [0, 16384, -16384, 32767, -32768, 32767, -32768];
    for (let i = 0; i < samples.length; i++) {
      const actual = view.getInt16(44 + i * 2, true);
      const target = expected[i] ?? 0;
      expect(Math.abs(actual - target)).toBeLessThanOrEqual(1);
    }
  });

  it('interleaves stereo frames as L,R,L,R,...', () => {
    const left = new Float32Array([1, 0.5, -1]);
    const right = new Float32Array([-1, -0.5, 1]);
    const buffer = encodeWav16([left, right], 44100);
    const view = new DataView(buffer);

    // frame 0: L=1 -> 32767, R=-1 -> -32768
    expect(view.getInt16(44 + 0, true)).toBe(32767);
    expect(view.getInt16(44 + 2, true)).toBe(-32768);
    // frame 1: L=0.5 -> ~16384, R=-0.5 -> ~-16384
    expect(view.getInt16(44 + 4, true)).toBeCloseTo(16384, -1);
    expect(view.getInt16(44 + 6, true)).toBeCloseTo(-16384, -1);
    // frame 2: L=-1 -> -32768, R=1 -> 32767
    expect(view.getInt16(44 + 8, true)).toBe(-32768);
    expect(view.getInt16(44 + 10, true)).toBe(32767);
  });
});

describe('encodeWav16 errors', () => {
  it('throws on 0 channels', () => {
    expect(() => encodeWav16([], 44100)).toThrow();
  });

  it('throws on more than 2 channels', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(4);
    const c = new Float32Array(4);
    expect(() => encodeWav16([a, b, c], 44100)).toThrow();
  });

  it('throws on unequal channel lengths', () => {
    const left = new Float32Array(4);
    const right = new Float32Array(5);
    expect(() => encodeWav16([left, right], 44100)).toThrow();
  });

  it('throws on sampleRate <= 0', () => {
    const mono = new Float32Array(4);
    expect(() => encodeWav16([mono], 0)).toThrow();
    expect(() => encodeWav16([mono], -1)).toThrow();
  });
});

describe('peakNormalize', () => {
  function peakOf(channels: Float32Array[]): number {
    let peak = 0;
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i++) {
        const sample = channel[i] ?? 0;
        peak = Math.max(peak, Math.abs(sample));
      }
    }
    return peak;
  }

  it('scales stereo channels so the peak reaches TARGET_PEAK_LINEAR, preserving relative balance', () => {
    const left = new Float32Array([0.5, 0.25, -0.1]);
    const right = new Float32Array([0.1, -0.5, 0.05]);
    const originalLeft = Float32Array.from(left);
    const originalRight = Float32Array.from(right);

    const gain = peakNormalize([left, right]);

    expect(gain).toBeCloseTo(TARGET_PEAK_LINEAR / 0.5, 6);
    expect(peakOf([left, right])).toBeCloseTo(TARGET_PEAK_LINEAR, 6);

    for (let i = 0; i < left.length; i++) {
      const leftSample = left[i] ?? 0;
      const originalLeftSample = originalLeft[i] ?? 0;
      expect(leftSample).toBeCloseTo(originalLeftSample * gain, 6);
    }
    for (let i = 0; i < right.length; i++) {
      const rightSample = right[i] ?? 0;
      const originalRightSample = originalRight[i] ?? 0;
      expect(rightSample).toBeCloseTo(originalRightSample * gain, 6);
    }
  });

  it('leaves silent input unchanged and returns gain 1', () => {
    const left = new Float32Array([0, 0, 0]);
    const right = new Float32Array([0, 0, 0]);

    const gain = peakNormalize([left, right]);

    expect(gain).toBe(1);
    expect(Array.from(left)).toEqual([0, 0, 0]);
    expect(Array.from(right)).toEqual([0, 0, 0]);
  });

  it('honors a custom targetPeak', () => {
    const mono = new Float32Array([0.2, -0.1, 0.05]);
    const customTarget = 0.6;

    const gain = peakNormalize([mono], customTarget);

    expect(gain).toBeCloseTo(customTarget / 0.2, 6);
    expect(peakOf([mono])).toBeCloseTo(customTarget, 6);
  });

  it('is a ~1.0 gain no-op when already at target', () => {
    const mono = new Float32Array([TARGET_PEAK_LINEAR, -0.2, 0.1]);

    const gain = peakNormalize([mono]);

    expect(gain).toBeCloseTo(1, 6);
    expect(peakOf([mono])).toBeCloseTo(TARGET_PEAK_LINEAR, 6);
  });
});
