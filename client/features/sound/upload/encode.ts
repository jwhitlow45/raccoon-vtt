import { toStereo } from "./downmix.ts";
import { LoudnessMeter } from "./loudness.ts";
import { wavToFloat, type WavFormat } from "./wav.ts";

/**
 * The encode worker's work, apart from the worker itself so tests run it
 * in Node (docs/design/design-v1-music.md 4.2 steps 3 to 5): each piece
 * mixed to stereo where it has 4 or 6 channels, measured, and, unless the
 * file is copied, encoded to a constant bitrate MP3 at 128 kbps stereo or
 * 64 kbps mono.
 */

/** The part of `@breezystack/lamejs` this uses, so the library loads only in the worker, as its own chunk. */
export type Mp3EncoderClass = new (channels: number, rateHz: number, kbps: number) => {
  encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
  flush(): Uint8Array;
};

export function kbpsFor(channels: 1 | 2): number {
  return channels === 1 ? 64 : 128;
}

/** lamejs takes 16-bit samples. A float past full scale is clipped there: its level is only metadata. */
export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    out[i] = s >= 1 ? 32_767 : s <= -1 ? -32_768 : Math.round(s * 32_767);
  }
  return out;
}

/** lamejs's own examples feed it a frame's samples at a time, and a bounded slice keeps its buffers small. */
const FEED = 1152 * 16;

export class Mp3Writer {
  readonly #encoder: InstanceType<Mp3EncoderClass>;
  readonly #channels: 1 | 2;
  readonly #parts: Uint8Array[] = [];

  constructor(Encoder: Mp3EncoderClass, channels: 1 | 2, rateHz: number) {
    this.#encoder = new Encoder(channels, rateHz, kbpsFor(channels));
    this.#channels = channels;
  }

  push(channels: readonly Float32Array[]): void {
    const length = channels[0]?.length ?? 0;
    for (let at = 0; at < length; at += FEED) {
      const left = toInt16(channels[0]!.subarray(at, at + FEED));
      const out = this.#channels === 1 ? this.#encoder.encodeBuffer(left) : this.#encoder.encodeBuffer(left, toInt16(channels[1]!.subarray(at, at + FEED)));
      // lamejs reuses its output buffer, so each part is copied before the next call.
      if (out.length > 0) this.#parts.push(out.slice());
    }
  }

  end(): Uint8Array[] {
    const last = this.#encoder.flush();
    if (last.length > 0) this.#parts.push(last.slice());
    return this.#parts;
  }
}

/** What the main thread sends the worker. Pieces are transferred, never copied. */
export type ToWorker =
  | { t: "start"; rateHz: number; channels: number; encode: boolean; wav: Pick<WavFormat, "sample" | "bits" | "channels" | "blockAlign"> | null }
  | { t: "pcm"; seq: number; channels: Float32Array[] }
  | { t: "wav"; seq: number; bytes: ArrayBuffer }
  | { t: "end" };

export type FromWorker =
  | { t: "took"; seq: number }
  | { t: "done"; lufs: number; peak: number; mp3: Blob | null }
  | { t: "failed"; message: string };

/** One file's pieces through the mix, the meter and the encoder, in order. */
export class PieceSink {
  readonly #meter: LoudnessMeter;
  readonly #writer: Mp3Writer | null;
  readonly #wav: Pick<WavFormat, "sample" | "bits" | "channels" | "blockAlign"> | null;
  readonly #channels: number;

  constructor(start: Extract<ToWorker, { t: "start" }>, Encoder: Mp3EncoderClass | null) {
    if (start.channels !== 1 && start.channels !== 2 && start.channels !== 4 && start.channels !== 6) throw new Error(`${start.channels} channels`);
    const out = start.channels === 1 ? 1 : 2;
    this.#channels = start.channels;
    this.#meter = new LoudnessMeter(start.rateHz, out);
    this.#writer = start.encode ? new Mp3Writer(Encoder!, out, start.rateHz) : null;
    this.#wav = start.wav;
  }

  pcm(channels: readonly Float32Array[]): void {
    if (channels.length !== this.#channels) throw new Error("a piece with another channel count");
    const mixed = toStereo(channels);
    this.#meter.push(mixed);
    this.#writer?.push(mixed);
  }

  wav(bytes: ArrayBuffer): void {
    if (!this.#wav) throw new Error("not a WAV");
    this.pcm(wavToFloat(new Uint8Array(bytes), this.#wav));
  }

  end(): { lufs: number; peak: number; mp3: Uint8Array[] | null } {
    return { ...this.#meter.result(), mp3: this.#writer?.end() ?? null };
  }
}
