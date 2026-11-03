/**
 * Four and six channels mixed to stereo before measuring and encoding
 * (docs/design/design-v1-music.md 4.2 step 3), by the Web Audio
 * specification's "speakers" down-mix rules, so a file sounds as the
 * browser itself would play it on two speakers. Mono and stereo pass as
 * they are. The six channels are 5.1 in the order L, R, C, LFE, SL, SR,
 * and the LFE channel is dropped, as the rules drop it.
 */

const CENTER = Math.SQRT1_2;

export function toStereo(channels: readonly Float32Array[]): Float32Array[] {
  if (channels.length === 1 || channels.length === 2) return [...channels];
  const length = channels[0]?.length ?? 0;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  if (channels.length === 4) {
    const [l, r, sl, sr] = channels as [Float32Array, Float32Array, Float32Array, Float32Array];
    for (let i = 0; i < length; i++) {
      left[i] = 0.5 * (l[i]! + sl[i]!);
      right[i] = 0.5 * (r[i]! + sr[i]!);
    }
    return [left, right];
  }
  if (channels.length === 6) {
    const [l, r, c, , sl, sr] = channels as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
    for (let i = 0; i < length; i++) {
      left[i] = l[i]! + CENTER * (c[i]! + sl[i]!);
      right[i] = r[i]! + CENTER * (c[i]! + sr[i]!);
    }
    return [left, right];
  }
  throw new Error(`no down-mix for ${channels.length} channels`);
}
