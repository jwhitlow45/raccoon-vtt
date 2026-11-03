import { refuse } from "./window.ts";

/**
 * Codec records both containers share, and the frame count
 * (docs/design/design-v1-animated-maps.md 10). Each record is consumed to
 * its last byte, and bytes left over are `bad_video` (AMQ-3): a record is a
 * fixed layout, so anything after it is something this check cannot vouch for.
 */

/** Most bits read MSB first from a buffer, as codec headers are written. */
export class Bits {
  readonly #bytes: Buffer;
  #at = 0;

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }

  get position(): number {
    return this.#at;
  }

  get left(): number {
    return this.#bytes.length * 8 - this.#at;
  }

  read(n: number): number {
    if (n > this.left) throw refuse("bad_video");
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.#bytes[(this.#at >> 3)]!;
      value = value * 2 + ((byte >> (7 - (this.#at & 7))) & 1);
      this.#at++;
    }
    return value;
  }

  /** Whether every bit from here to the end is zero, the padding a record may end with. */
  restIsZero(): boolean {
    while (this.left > 0) if (this.read(1) !== 0) return false;
    return true;
  }
}

/**
 * The most frames in any one second, a sliding count over the frames'
 * presentation times (AM-ASTRA-06): no fast stretch hides behind a slow
 * start, and a variable rate is measured as it is. `perSecond` is the
 * times' units in a second, so the window is half open and 60 frames
 * exactly 1/60 s apart count 60, not 61.
 */
export function peakInOneSecond(times: readonly number[], perSecond: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  let peak = 0;
  let first = 0;
  for (let last = 0; last < sorted.length; last++) {
    while (sorted[last]! - sorted[first]! >= perSecond) first++;
    peak = Math.max(peak, last - first + 1);
  }
  return peak;
}

/**
 * An AV1CodecConfigurationRecord, required for AV1 in either container
 * (AM-ASTRA-10), as its RFC 6381 string `av01.P.LLT.DD`. Its config OBUs
 * may hold only sequence headers: a metadata OBU can carry free text, and
 * this record sits outside the media data, where nothing is left unread.
 */
export function av1CodecString(record: Buffer): string {
  if (record.length < 4) throw refuse("bad_video");
  const bits = new Bits(record);
  if (bits.read(1) !== 1 || bits.read(7) !== 1) throw refuse("bad_video");
  const profile = bits.read(3);
  const level = bits.read(5);
  const tier = bits.read(1);
  const highBitdepth = bits.read(1);
  const twelveBit = bits.read(1);
  bits.read(5); // monochrome, the chroma subsampling and the sample position, which the short string leaves out
  if (bits.read(3) !== 0) throw refuse("bad_video");
  const delayPresent = bits.read(1);
  const delay = bits.read(4);
  if (!delayPresent && delay !== 0) throw refuse("bad_video");
  if (profile > 2 || (twelveBit && profile !== 2) || (twelveBit && !highBitdepth)) throw refuse("bad_video");
  let at = 4;
  while (at < record.length) {
    const header = record[at]!;
    const type = (header >> 3) & 0x0f;
    const extension = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    if (header & 0x81 || type !== 1 || !hasSize) throw refuse("bad_video");
    at += 1 + extension;
    const { value, length } = leb128(record, at);
    at += length;
    if (at + value > record.length) throw refuse("bad_video");
    at += value;
  }
  const depth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(depth).padStart(2, "0")}`;
}

function leb128(bytes: Buffer, at: number): { value: number; length: number } {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) throw refuse("bad_video");
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) {
      if (!Number.isSafeInteger(value)) throw refuse("bad_video");
      return { value, length: i + 1 };
    }
  }
  throw refuse("bad_video");
}

export type OpusFacts = { channels: number };

/**
 * An Opus identification header: WebM's CodecPrivate (`OpusHead`, little
 * endian, RFC 7845 5.1) or MP4's `dOps` (big endian, no magic). It holds
 * only numbers, which is why Opus is the WebM sound codec this accepts.
 */
export function opusHead(record: Buffer, form: "webm" | "mp4"): OpusFacts {
  const magic = form === "webm" ? 8 : 0;
  if (form === "webm" && record.subarray(0, 8).toString("latin1") !== "OpusHead") throw refuse("video_sound");
  const fixed = magic + 11;
  if (record.length < fixed) throw refuse("video_sound");
  const version = record[magic]!;
  if (form === "webm" ? version >> 4 !== 0 || version === 0 : version !== 0) throw refuse("video_sound");
  const channels = record[magic + 1]!;
  const family = record[magic + 10]!;
  if (channels < 1) throw refuse("video_sound");
  let length = fixed;
  if (family === 0) {
    if (channels > 2) throw refuse("video_sound");
  } else if (family === 1) {
    if (channels > 8) throw refuse("video_sound");
    length += 2 + channels;
  } else {
    throw refuse("video_sound");
  }
  if (record.length !== length) throw refuse("bad_video");
  if (family === 1) {
    const streams = record[fixed]!;
    const coupled = record[fixed + 1]!;
    if (streams < 1 || coupled > streams || streams + coupled > 255) throw refuse("video_sound");
    for (let i = 0; i < channels; i++) {
      const index = record[fixed + 2 + i]!;
      if (index !== 255 && index >= streams + coupled) throw refuse("video_sound");
    }
  }
  return { channels };
}

/** Opus decodes at 48 kHz whatever rate its input had, so Media Capabilities is asked about that. */
export const OPUS_HZ = 48_000;

/**
 * One Opus packet's length in 48 kHz samples from its first bytes (RFC 6716
 * 3.1): the TOC byte's configuration gives the frame size and its code the
 * frame count, which code 3 keeps in the next byte. At most 120 ms.
 */
export function opusPacketSamples(toc: number, countByte: number | undefined): number {
  const config = toc >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3]! : config < 16 ? [480, 960][config & 1]! : [120, 240, 480, 960][config & 3]!;
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code < 3) frames = 2;
  else {
    if (countByte === undefined) throw refuse("bad_video");
    frames = countByte & 0x3f;
    if (frames < 1) throw refuse("bad_video");
  }
  const samples = frame * frames;
  if (samples > 5760) throw refuse("bad_video");
  return samples;
}

export type Vp9Facts = { profile: number; level?: number; bitDepth: number };

/**
 * WebM's VP9 CodecPrivate (the VP9 codec feature metadata): one-byte
 * profile, level, bit depth and chroma entries, each at most once.
 */
export function vp9CodecPrivate(record: Buffer): Partial<Vp9Facts> {
  const out: Partial<Vp9Facts> = {};
  const seen = new Set<number>();
  let at = 0;
  while (at < record.length) {
    const id = record[at]!;
    const length = record[at + 1];
    const value = record[at + 2];
    if (length !== 1 || value === undefined || seen.has(id)) throw refuse("bad_video");
    seen.add(id);
    if (id === 1) {
      if (value > 3) throw refuse("bad_video");
      out.profile = value;
    } else if (id === 2) {
      if (!VP9_LEVELS.some((l) => l.level === value)) throw refuse("bad_video");
      out.level = value;
    } else if (id === 3) {
      if (value !== 8 && value !== 10 && value !== 12) throw refuse("bad_video");
      out.bitDepth = value;
    } else if (id === 4) {
      if (value > 3) throw refuse("bad_video");
    } else {
      throw refuse("bad_video");
    }
    at += 3;
  }
  return out;
}

/**
 * Profile and bit depth from a VP9 key frame's uncompressed header (VP9
 * bitstream 6.2), for a file whose CodecPrivate leaves them out. Only these
 * first bytes of the payload are read, and nothing in it is written.
 */
export function vp9KeyFrame(head: Buffer): { profile: number; bitDepth: number } {
  const bits = new Bits(head);
  if (bits.read(2) !== 2) throw refuse("bad_video");
  const low = bits.read(1);
  const high = bits.read(1);
  const profile = high * 2 + low;
  if (profile === 3 && bits.read(1) !== 0) throw refuse("bad_video");
  if (bits.read(1) !== 0) throw refuse("bad_video"); // show_existing_frame: a stream starts with a frame of its own
  if (bits.read(1) !== 0) throw refuse("bad_video"); // frame_type: the first frame is a key frame
  bits.read(2); // show_frame, error_resilient_mode
  if (bits.read(24) !== 0x498342) throw refuse("bad_video");
  const bitDepth = profile >= 2 ? (bits.read(1) ? 12 : 10) : 8;
  return { profile, bitDepth };
}

/** The VP9 levels (webmproject.org/vp9/levels): luma samples a second, luma picture size and the longest side. */
const VP9_LEVELS = [
  { level: 10, rate: 829_440, size: 36_864, side: 512 },
  { level: 11, rate: 2_764_800, size: 73_728, side: 768 },
  { level: 20, rate: 4_608_000, size: 122_880, side: 960 },
  { level: 21, rate: 9_216_000, size: 245_760, side: 1344 },
  { level: 30, rate: 20_736_000, size: 552_960, side: 2048 },
  { level: 31, rate: 36_864_000, size: 983_040, side: 2752 },
  { level: 40, rate: 83_558_400, size: 2_228_224, side: 4160 },
  { level: 41, rate: 160_432_128, size: 2_228_224, side: 4160 },
  { level: 50, rate: 311_951_360, size: 8_912_896, side: 8384 },
  { level: 51, rate: 588_251_136, size: 8_912_896, side: 8384 },
  { level: 52, rate: 1_176_502_272, size: 8_912_896, side: 8384 },
  { level: 60, rate: 1_176_502_272, size: 35_651_584, side: 16_832 },
  { level: 61, rate: 2_353_004_544, size: 35_651_584, side: 16_832 },
  { level: 62, rate: 4_706_009_088, size: 35_651_584, side: 16_832 },
] as const;

/** The lowest VP9 level that holds this size at this peak rate. */
export function vp9Level(width: number, height: number, fps: number): number {
  const size = width * height;
  const found = VP9_LEVELS.find((l) => size <= l.size && size * fps <= l.rate && Math.max(width, height) <= l.side);
  return found?.level ?? 62;
}

export function vp9CodecString(facts: Vp9Facts): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `vp09.${two(facts.profile)}.${two(facts.level ?? 10)}.${two(facts.bitDepth)}`;
}
