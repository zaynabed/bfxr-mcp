/** Minimal 16-bit PCM mono WAV encoder. */

export const SAMPLE_RATE = 44100;

/**
 * @param {Float32Array} samples samples in [-1, 1]
 * @param {number} sampleRate
 * @returns {Buffer} a complete RIFF/WAVE file
 */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    // rescale [-1.0, 1.0) to signed 16-bit, matching bfxr's own export
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    let value = Math.floor(32768 * clamped);
    if (value > 32767) value = 32767;
    buffer.writeInt16LE(value, 44 + i * bytesPerSample);
  }

  return buffer;
}
