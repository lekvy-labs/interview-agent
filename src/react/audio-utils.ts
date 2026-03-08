/** Audio utility functions shared by capture and playback modules. */

/**
 * Downsample Float32 audio from srcRate to dstRate using linear interpolation,
 * then convert to Int16 LE.
 */
export function downsampleToInt16(
  float32: Float32Array,
  srcRate: number,
  dstRate: number,
): Int16Array {
  const ratio = srcRate / dstRate;
  const outLength = Math.floor(float32.length / ratio);
  const result = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, float32.length - 1);
    const frac = srcIdx - lo;
    const sample = float32[lo]! * (1 - frac) + float32[hi]! * frac;
    result[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }

  return result;
}

/**
 * Decode base64 PCM Int16 LE into Float32Array for Web Audio playback.
 */
export function decodeBase64PcmToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i]! / 0x7fff;
  }
  return float32;
}

/** Compute RMS energy of a Float32 audio chunk. */
export function computeEnergy(float32: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) {
    sum += float32[i]! * float32[i]!;
  }
  return sum / float32.length;
}
