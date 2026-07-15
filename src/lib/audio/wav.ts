// Pure, headless audio post-processing for the BMS import mixdown pipeline
// (specs/bms-import.md MUST 11-12): peak-normalize the OfflineAudioContext render
// output, then encode it as a 16-bit PCM WAV file for IndexedDB storage.
// Operates on Float32Array channel data only — no Web Audio dependency — so it
// is testable in Node and safe to run inside a Worker.

/** ≈ −1 dBFS as linear amplitude: 10^(−1/20). */
export const TARGET_PEAK_LINEAR: number = 10 ** (-1 / 20);

/**
 * Scales all channels IN PLACE so the loudest sample's magnitude equals targetPeak.
 * Silent input (peak 0) is returned unchanged. Returns the gain factor applied.
 */
export function peakNormalize(
  channels: Float32Array[],
  targetPeak: number = TARGET_PEAK_LINEAR,
): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i] ?? 0;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
  }

  if (peak === 0) {
    return 1;
  }

  const gain = targetPeak / peak;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      channel[i] = (channel[i] ?? 0) * gain;
    }
  }

  return gain;
}

/** Clamp to [-1, 1], then scale asymmetrically to use the full int16 range without overflow. */
function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  const scaled = clamped < 0 ? clamped * 32768 : clamped * 32767;
  return Math.round(scaled);
}

/**
 * Encodes channel data as a 16-bit PCM RIFF/WAVE file.
 * channels: 1 (mono) or 2 (stereo) Float32Arrays of equal length, samples nominally in [-1, 1]
 * (values outside are hard-clamped). Returns the complete file bytes.
 */
export function encodeWav16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = channels.length;
  if (numChannels === 0 || numChannels > 2) {
    throw new Error(`encodeWav16: unsupported channel count ${numChannels} (must be 1 or 2)`);
  }
  if (sampleRate <= 0) {
    throw new Error(`encodeWav16: sampleRate must be > 0, got ${sampleRate}`);
  }

  const firstChannel = channels[0];
  if (!firstChannel) {
    throw new Error('encodeWav16: missing first channel');
  }
  const numFrames = firstChannel.length;
  for (const channel of channels) {
    if (channel.length !== numFrames) {
      throw new Error('encodeWav16: all channels must have equal length');
    }
  }

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const fileSize = 44 + dataSize;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bitsPerSample

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const channel = channels[ch];
      const sample = channel ? (channel[frame] ?? 0) : 0;
      view.setInt16(offset, floatToInt16(sample), true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
