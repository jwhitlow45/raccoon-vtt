import { SOUND_LIMITS } from "#shared/limits.ts";
import { LEVEL_MAX, LEVEL_MIN } from "#shared/sound.ts";

/**
 * Integrated loudness by ITU-R BS.1770-4, gated, and the sample peak
 * (docs/design/design-v1-sound.md 4.2 step 4, D-261102-465), fed piece by
 * piece so a long file is never held whole. The level that evens a sound
 * comes from them.
 *
 * The K-weighting filters are the standard's two biquads, derived for any
 * rate from their analog prototypes as libebur128 does, since the
 * standard tabulates them only at 48 kHz.
 */

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

export function kWeighting(rateHz: number): [Biquad, Biquad] {
  // The high shelf: about +4 dB above 1.5 kHz.
  let f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / rateHz);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  // The high pass: the RLB curve's roll-off below about 38 Hz.
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / rateHz);
  a0 = 1 + k / q + k * k;
  const highPass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
  return [shelf, highPass];
}

/** The absolute gate, in LUFS, and the relative gate below the ungated mean, in LU. */
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

/** Loudness of a mean square, in LUFS. */
function lufsOf(meanSquare: number): number {
  return -0.691 + 10 * Math.log10(meanSquare);
}

/**
 * A streaming meter for one or two channels. A mono file plays from both
 * speakers, so it is measured as the same signal on both, 3 dB louder than
 * on one, as BS.1770's dual mono is: a sound evened as mono then plays as
 * loud as a stereo one evened alike.
 */
export class LoudnessMeter {
  readonly #channels: number;
  readonly #weight: number;
  readonly #filters: [Biquad, Biquad];
  /** Each channel's filter state, x1 x2 y1 y2 for each of the two biquads. */
  readonly #state: Float64Array[];
  /** 100 ms steps: a 400 ms gating block is four of them, so blocks overlap by 75%. */
  readonly #stepSamples: number;
  #stepSum = 0;
  #stepFill = 0;
  #steps: number[] = [];
  #peak = 0;

  constructor(rateHz: number, channels: 1 | 2) {
    this.#channels = channels;
    this.#weight = channels === 1 ? 2 : 1;
    this.#filters = kWeighting(rateHz);
    this.#state = Array.from({ length: channels }, () => new Float64Array(8));
    this.#stepSamples = Math.round(rateHz / 10);
  }

  push(channels: readonly Float32Array[]): void {
    if (channels.length !== this.#channels) throw new Error("the meter takes the channels it was made for");
    const length = channels[0]?.length ?? 0;
    const [s, h] = this.#filters;
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let c = 0; c < this.#channels; c++) {
        const x = channels[c]![i]!;
        const abs = x < 0 ? -x : x;
        if (abs > this.#peak) this.#peak = abs;
        const st = this.#state[c]!;
        const y1 = s.b0 * x + s.b1 * st[0]! + s.b2 * st[1]! - s.a1 * st[2]! - s.a2 * st[3]!;
        st[1] = st[0]!;
        st[0] = x;
        st[3] = st[2]!;
        st[2] = y1;
        const y2 = h.b0 * y1 + h.b1 * st[4]! + h.b2 * st[5]! - h.a1 * st[6]! - h.a2 * st[7]!;
        st[5] = st[4]!;
        st[4] = y1;
        st[7] = st[6]!;
        st[6] = y2;
        sum += y2 * y2;
      }
      this.#stepSum += sum * this.#weight;
      if (++this.#stepFill === this.#stepSamples) {
        this.#steps.push(this.#stepSum / this.#stepSamples);
        this.#stepSum = 0;
        this.#stepFill = 0;
      }
    }
  }

  /** Integrated loudness in LUFS (-Infinity when every block is under the absolute gate) and the sample peak, 0 to 1 and over. */
  result(): { lufs: number; peak: number } {
    const blocks: number[] = [];
    for (let i = 3; i < this.#steps.length; i++) blocks.push((this.#steps[i - 3]! + this.#steps[i - 2]! + this.#steps[i - 1]! + this.#steps[i]!) / 4);
    // A sound shorter than one block is measured as the one block it is.
    if (blocks.length === 0) {
      const all = [...this.#steps, ...(this.#stepFill > 0 ? [this.#stepSum / this.#stepFill] : [])];
      if (all.length > 0) blocks.push(all.reduce((a, b) => a + b, 0) / all.length);
    }
    const loud = blocks.filter((z) => lufsOf(z) > ABSOLUTE_GATE);
    if (loud.length === 0) return { lufs: -Infinity, peak: this.#peak };
    const relative = lufsOf(loud.reduce((a, b) => a + b, 0) / loud.length) + RELATIVE_GATE;
    const gated = loud.filter((z) => lufsOf(z) > relative);
    return { lufs: lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length), peak: this.#peak };
  }
}

/** The bounds of the level, in dB: -24 to +12 (LEVEL_MIN and LEVEL_MAX are in tenths). */
const MIN_DB = LEVEL_MIN / 10;
const MAX_DB = LEVEL_MAX / 10;

/**
 * The level that brings a sound to SOUND_LIMITS.targetLufs, within -24 and
 * +12 dB, never so high that its peak passes SOUND_LIMITS.peakDbfs, in
 * tenths of a dB rounded down, so rounding never lifts the peak past it.
 * A silent sound keeps 0, since no gain makes it louder.
 */
export function levelOf(measured: { lufs: number; peak: number }): number {
  if (!Number.isFinite(measured.lufs) || measured.peak <= 0) return 0;
  const toTarget = SOUND_LIMITS.targetLufs - measured.lufs;
  const peakRoom = SOUND_LIMITS.peakDbfs - 20 * Math.log10(measured.peak);
  const db = Math.max(MIN_DB, Math.min(MAX_DB, toTarget, peakRoom));
  const tenths = Math.floor(db * 10 + 1e-9);
  // Adding 0 turns a -0 into 0.
  return Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, tenths)) + 0;
}
