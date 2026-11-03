import { SOUND_LIMITS } from "#shared/limits.ts";
import type { SoundUse } from "#shared/sound.ts";
import type { ByteSource } from "./bytes.ts";
import { readWavFormat, readsInPieces, type WavFormat } from "./wav.ts";
import type { Refusal } from "./words.ts";

/**
 * What the DM's browser knows about a file before it decodes a byte
 * (docs/design/design-v1-sound.md 4.2 step 1, D-261102-464): its channel
 * count and rate from its own header, and its length where the header
 * says it. A browser's decoder allocates by the file's own channels before
 * it resamples or mixes anything, so a file whose channels these headers do
 * not give, or give as anything but 1, 2, 4 or 6, is refused here, and a
 * file that decodes whole must fit this device's budget by these numbers.
 */

export type Container = "mp3" | "wav" | "aiff" | "flac" | "ogg" | "m4a" | "aac" | "webm" | "other";

export type Probe = {
  container: Container;
  /** Null when the header does not say, which refuses the file. */
  channels: number | null;
  /** The decoder's own output rate, null when the header does not say (counted as SOUND_LIMITS.unknownRateHz). */
  rateHz: number | null;
  /** The source's length from its header, null when only the browser can tell. */
  ms: number | null;
  /** Whether `ms` counts whole frames with the encoder's delay and padding, as an MP3's frames do, so it takes the encoding allowance. */
  framed: boolean;
  /** An MP3 that may be copied as it is: MPEG-1 Layer III at 44.1 or 48 kHz with a first frame at 64 to 192 kbps. The strict walk decides (copy.ts). */
  copyCandidate: boolean;
  /** A WAV's format, when its header placed it. */
  wav: WavFormat | null;
};

/** How a file is read (4.2 step 2). */
export type ReadPath = "mp3Pieces" | "wavPieces" | "whole";

/** How much of the file the probe reads at the start, which every header here fits in but a late MP4 `moov` or WAV `data`. */
const HEAD_BYTES = 256 * 1024;
/** An MP4 `moov` box is read whole only up to this. An audio file's is kilobytes. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** Top-level boxes, Matroska elements or ADTS frames walked at most, so no file keeps the probe going. */
const MAX_BOXES = 4096;

function fourcc(b: Uint8Array, at: number): string {
  return at + 4 <= b.length ? String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!) : "";
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** The size of an ID3v2 tag at `at`, header and footer included, or 0. */
export function id3v2Size(b: Uint8Array, at = 0): number {
  if (b.length < at + 10 || b[at] !== 0x49 || b[at + 1] !== 0x44 || b[at + 2] !== 0x33) return 0;
  const syncsafe = ((b[at + 6]! & 0x7f) << 21) | ((b[at + 7]! & 0x7f) << 14) | ((b[at + 8]! & 0x7f) << 7) | (b[at + 9]! & 0x7f);
  const footer = (b[at + 5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + syncsafe + footer;
}

// ---------------------------------------------------------------- MPEG audio frames

/** An MPEG audio frame header, MPEG-1, 2 or 2.5, any layer, read leniently: the strict walk is mp3.ts's. */
export type MpegFrame = { mpeg1: boolean; layer: 1 | 2 | 3; kbps: number; rateHz: number; channels: 1 | 2; bytes: number; samples: number; crc: boolean; emphasis: boolean };

const KBPS_V1: Record<1 | 2 | 3, readonly number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const KBPS_V2: Record<1 | 2 | 3, readonly number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, readonly number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

export function mpegFrameAt(b: Uint8Array, at: number): MpegFrame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1]! >> 3) & 3;
  const layerBits = (b[at + 1]! >> 1) & 3;
  const bitrateIndex = b[at + 2]! >> 4;
  const rateIndex = (b[at + 2]! >> 2) & 3;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? KBPS_V1 : KBPS_V2)[layer][bitrateIndex]!;
  const rateHz = RATES[version]![rateIndex]!;
  const padding = (b[at + 2]! >> 1) & 1;
  const channels = (b[at + 3]! >> 6) === 3 ? 1 : 2;
  let bytes: number;
  let samples: number;
  if (layer === 1) {
    bytes = (Math.floor((12_000 * kbps) / rateHz) + padding) * 4;
    samples = 384;
  } else if (layer === 3 && !mpeg1) {
    bytes = Math.floor((72_000 * kbps) / rateHz) + padding;
    samples = 576;
  } else {
    bytes = Math.floor((144_000 * kbps) / rateHz) + padding;
    samples = 1152;
  }
  // The protection bit is 0 when a CRC follows the header.
  return { mpeg1, layer, kbps, rateHz, channels, bytes, samples, crc: (b[at + 1]! & 1) === 0, emphasis: (b[at + 3]! & 3) !== 0 };
}

/** The most bytes mpegFrameAt gives a frame: Layer II's size at 160 kbps and 8 kHz, which it reads leniently, padded. */
const MAX_FRAME_BYTES = 2881;

/** Whether a frame is a Xing, Info or VBRI frame, which carries the encoder's counts and no audio. */
function isTagFrame(b: Uint8Array, at: number, frame: MpegFrame): boolean {
  const side = frame.mpeg1 ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
  const tag = fourcc(b, at + 4 + side);
  return tag === "Xing" || tag === "Info" || fourcc(b, at + 36) === "VBRI";
}

/** The top bitrate of a frame's version and layer, so a file's bytes over it are the least it can play. */
function topKbps(frame: MpegFrame): number {
  return Math.max(...(frame.mpeg1 ? KBPS_V1 : KBPS_V2)[frame.layer]);
}

/**
 * The first frame of an MPEG audio file past an ID3v2 tag, confirmed by a
 * second frame header right after it, so a stray 0xFF byte in a tag or
 * junk is not taken for one.
 */
function firstFrame(head: Uint8Array): { at: number; frame: MpegFrame } | null {
  const start = id3v2Size(head);
  const limit = Math.min(head.length - 4, start + 64 * 1024);
  for (let at = start; at < limit; at++) {
    const frame = mpegFrameAt(head, at);
    if (!frame) continue;
    const next = at + frame.bytes;
    // A file of one frame has nothing after it to confirm, and is too short to keep anyway.
    if (next + 4 > head.length || mpegFrameAt(head, next)) return { at, frame };
  }
  return null;
}

/**
 * An MPEG file's length from its own frames, walked leniently to the end in
 * windows, each frame at its own rate. A Xing or VBRI frame's count is only
 * what the file says, and a decoder decodes every frame there is, so the
 * count is never read: a whole decode is budgeted by this length
 * (MUS-SOL-02). A decoder also looks on past a byte that starts no frame,
 * such as junk or a tag between two streams, so the walk does too, and
 * takes a frame found there only when the next header follows it at its
 * end with the same version, layer and rate. The rate and channels are the
 * most any frame has, since a decoder makes the file's audio at those.
 */
async function walkFrames(source: ByteSource, from: number, first: MpegFrame): Promise<{ ms: number; rateHz: number; channels: 1 | 2 }> {
  let ms = 0;
  let rateHz = first.rateHz;
  let channels = first.channels;
  let at = from;
  let synced = true;
  let windowStart = 0;
  let window: Uint8Array = new Uint8Array(0);
  while (at + 4 <= source.size) {
    const windowEnd = windowStart + window.length;
    // The window holds a whole frame and the next one's header, for the check after a byte that started none.
    if (at < windowStart || at + 4 > windowEnd || (at + MAX_FRAME_BYTES + 4 > windowEnd && windowEnd < source.size)) {
      windowStart = at;
      window = await source.read(at, at + HEAD_BYTES);
    }
    const frame = mpegFrameAt(window, at - windowStart);
    const next = frame ? at + frame.bytes : 0;
    const after = frame && !synced && next + 4 <= source.size ? mpegFrameAt(window, next - windowStart) : null;
    if (frame && (synced || next + 4 > source.size || (after && after.mpeg1 === frame.mpeg1 && after.layer === frame.layer && after.rateHz === frame.rateHz))) {
      ms += (frame.samples * 1000) / frame.rateHz;
      rateHz = Math.max(rateHz, frame.rateHz);
      if (frame.channels === 2) channels = 2;
      at = next;
      synced = true;
    } else {
      at++;
      synced = false;
    }
  }
  return { ms, rateHz, channels };
}

async function probeMpeg(source: ByteSource, head: Uint8Array): Promise<Probe | null> {
  const found = firstFrame(head);
  if (!found) return null;
  const { at, frame } = found;
  const audio = isTagFrame(head, at, frame) ? at + frame.bytes : at;
  // The file's bytes over its version and layer's top bitrate are the least it can play. A file over four times the
  // longest use even so is refused unwalked, so a 200 MB file is never read for its length.
  const least = ((source.size - audio) * 8) / topKbps(frame);
  const walked = least > 4 * SOUND_LIMITS.fileMaxMs ? { ms: least, rateHz: frame.rateHz, channels: frame.channels } : await walkFrames(source, audio, frame);
  return {
    container: "mp3",
    channels: walked.channels,
    rateHz: walked.rateHz,
    ms: walked.ms,
    framed: true,
    // The server's walk refuses CRC and emphasis frames (D-261102-690), so such a file is planned for the encoder at once.
    copyCandidate:
      frame.mpeg1 && frame.layer === 3 && !frame.crc && !frame.emphasis && (frame.rateHz === 44_100 || frame.rateHz === 48_000) && frame.kbps >= SOUND_LIMITS.minKbps && frame.kbps <= SOUND_LIMITS.maxKbps,
    wav: null,
  };
}

// ---------------------------------------------------------------- ADTS (raw AAC)

const ADTS_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];

function adtsAt(b: Uint8Array, at: number): { rateHz: number; config: number; bytes: number; blocks: number } | null {
  if (at + 7 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xf6) !== 0xf0) return null;
  const rateIndex = (b[at + 2]! >> 2) & 0xf;
  const rateHz = ADTS_RATES[rateIndex];
  if (rateHz === undefined) return null;
  const config = ((b[at + 2]! & 1) << 2) | (b[at + 3]! >> 6);
  const bytes = ((b[at + 3]! & 3) << 11) | (b[at + 4]! << 3) | (b[at + 5]! >> 5);
  if (bytes < 7) return null;
  return { rateHz, config, bytes, blocks: (b[at + 6]! & 3) + 1 };
}

/** Channels of an AAC channel configuration (ISO 14496-3 table 1.19). 0 is set in the stream's own element, which this does not read. */
const AAC_CHANNELS: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8, 11: 7, 12: 8, 13: 24, 14: 8 };

async function probeAdts(source: ByteSource, head: Uint8Array): Promise<Probe | null> {
  const start = id3v2Size(head);
  const first = adtsAt(head, start);
  if (!first) return null;
  // HE-AAC signals its core rate in ADTS and decodes at twice it, so a low core rate counts double for the budget.
  const rateHz = first.rateHz <= 24_000 ? first.rateHz * 2 : first.rateHz;
  let at = start;
  let samples = 0;
  let windowStart = -1;
  let window: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < MAX_BOXES * 64; i++) {
    if (at + 7 > source.size) break;
    if (at < windowStart || at + 7 > windowStart + window.length) {
      windowStart = at;
      window = await source.read(at, at + HEAD_BYTES);
    }
    const frame = adtsAt(window, at - windowStart);
    if (!frame) break;
    samples += frame.blocks * 1024;
    at += frame.bytes;
  }
  const done = at + 7 > source.size;
  return {
    container: "aac",
    channels: AAC_CHANNELS[first.config] ?? null,
    rateHz,
    ms: done ? (samples / first.rateHz) * 1000 : null,
    framed: true,
    copyCandidate: false,
    wav: null,
  };
}

// ---------------------------------------------------------------- AIFF and FLAC

/** An 80-bit IEEE extended float, AIFF's sample rate. */
function extended80(b: Uint8Array, at: number): number {
  const v = view(b);
  const exponent = v.getUint16(at) & 0x7fff;
  const sign = (b[at]! & 0x80) !== 0 ? -1 : 1;
  const hi = v.getUint32(at + 2);
  const lo = v.getUint32(at + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** (exponent - 16383 - 31) + lo * 2 ** (exponent - 16383 - 63));
}

async function probeAiff(source: ByteSource, head: Uint8Array): Promise<Probe | null> {
  if (fourcc(head, 0) !== "FORM" || (fourcc(head, 8) !== "AIFF" && fourcc(head, 8) !== "AIFC")) return null;
  let at = 12;
  for (let i = 0; i < 64 && at + 8 <= source.size; i++) {
    const header = await source.read(at, at + 8);
    const size = view(header).getUint32(4);
    if (fourcc(header, 0) === "COMM") {
      const comm = await source.read(at + 8, at + 8 + Math.min(size, 64));
      if (comm.length < 18) return null;
      const channels = view(comm).getUint16(0);
      const frames = view(comm).getUint32(2);
      const rateHz = extended80(comm, 8);
      const known = Number.isFinite(rateHz) && rateHz > 0;
      return { container: "aiff", channels, rateHz: known ? rateHz : null, ms: known ? (frames / rateHz) * 1000 : null, framed: false, copyCandidate: false, wav: null };
    }
    at += 8 + size + (size % 2);
  }
  return { container: "aiff", channels: null, rateHz: null, ms: null, framed: false, copyCandidate: false, wav: null };
}

function probeFlac(head: Uint8Array): Probe | null {
  const at = id3v2Size(head);
  if (fourcc(head, at) !== "fLaC") return null;
  // STREAMINFO is always the first metadata block: a 4-byte block header, then 34 bytes.
  const info = at + 8;
  if (info + 18 > head.length || (head[at + 4]! & 0x7f) !== 0) return { container: "flac", channels: null, rateHz: null, ms: null, framed: false, copyCandidate: false, wav: null };
  const rateHz = (head[info + 10]! << 12) | (head[info + 11]! << 4) | (head[info + 12]! >> 4);
  const channels = ((head[info + 12]! >> 1) & 7) + 1;
  const total = (head[info + 13]! & 0x0f) * 2 ** 32 + view(head).getUint32(info + 14);
  return {
    container: "flac",
    channels,
    rateHz: rateHz > 0 ? rateHz : null,
    // A total of 0 means the encoder did not know it.
    ms: rateHz > 0 && total > 0 ? (total / rateHz) * 1000 : null,
    framed: false,
    copyCandidate: false,
    wav: null,
  };
}

// ---------------------------------------------------------------- Ogg (Vorbis, Opus)

async function probeOgg(source: ByteSource, head: Uint8Array): Promise<Probe | null> {
  if (fourcc(head, 0) !== "OggS" || head.length < 28) return null;
  const segments = head[26]!;
  const packet = 27 + segments;
  const serial = view(head).getUint32(14, true);
  let channels: number | null = null;
  let rateHz: number | null = null;
  let preSkip = 0;
  let granuleRate = 0;
  if (head[packet] === 0x01 && String.fromCharCode(...head.subarray(packet + 1, packet + 7)) === "vorbis" && packet + 16 <= head.length) {
    channels = head[packet + 11]!;
    rateHz = view(head).getUint32(packet + 12, true) || null;
    granuleRate = rateHz ?? 0;
  } else if (String.fromCharCode(...head.subarray(packet, packet + 8)) === "OpusHead" && packet + 16 <= head.length) {
    channels = head[packet + 9]!;
    preSkip = view(head).getUint16(packet + 10, true);
    // Opus always decodes at 48 kHz, whatever rate its header says it was made from.
    rateHz = 48_000;
    granuleRate = 48_000;
  } else return { container: "ogg", channels: null, rateHz: null, ms: null, framed: false, copyCandidate: false, wav: null };
  // The last page's granule position counts the stream's samples.
  const tailStart = Math.max(0, source.size - 64 * 1024);
  const tail = await source.read(tailStart, source.size);
  let ms: number | null = null;
  for (let at = tail.length - 27; at >= 0 && granuleRate > 0; at--) {
    if (fourcc(tail, at) !== "OggS" || view(tail).getUint32(at + 14, true) !== serial) continue;
    const granule = view(tail).getUint32(at + 6, true) + view(tail).getUint32(at + 10, true) * 2 ** 32;
    if (granule > preSkip && granule < 2 ** 53) ms = ((granule - preSkip) / granuleRate) * 1000;
    break;
  }
  return { container: "ogg", channels, rateHz, ms, framed: false, copyCandidate: false, wav: null };
}

// ---------------------------------------------------------------- MP4 (M4A)

type Box = { type: string; start: number; body: number; end: number };

function boxesIn(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to && out.length < MAX_BOXES) {
    let size = view(b).getUint32(at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = view(b).getUint32(at + 8) * 2 ** 32 + view(b).getUint32(at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    out.push({ type: fourcc(b, at + 4), start: at, body, end: at + size });
    at += size;
  }
  return out;
}

function child(b: Uint8Array, parent: Box, type: string, skip = 0): Box | undefined {
  return boxesIn(b, parent.body + skip, parent.end).find((box) => box.type === type);
}

/** The bits of an AudioSpecificConfig (ISO 14496-3 1.6.2.1), from its first bit. */
class Bits {
  #at = 0;
  readonly #b: Uint8Array;
  constructor(b: Uint8Array) {
    this.#b = b;
  }
  read(n: number): number | null {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.#b[this.#at >> 3];
      if (byte === undefined) return null;
      value = value * 2 + ((byte >> (7 - (this.#at & 7))) & 1);
      this.#at++;
    }
    return value;
  }
}

/** An `esds` box's AudioSpecificConfig: its channels and its output rate, SBR's doubling counted. */
export function readEsds(b: Uint8Array): { channels: number | null; rateHz: number | null } | null {
  // A full box: version and flags first.
  let at = 4;
  const descriptor = (): { tag: number; body: number; end: number } | null => {
    if (at >= b.length) return null;
    const tag = b[at++]!;
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const byte = b[at++];
      if (byte === undefined) return null;
      size = (size << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return { tag, body: at, end: Math.min(b.length, at + size) };
  };
  const es = descriptor();
  if (!es || es.tag !== 3) return null;
  const flags = b[at + 2] ?? 0;
  at += 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + (b[at] ?? 0);
  if (flags & 0x20) at += 2;
  const config = descriptor();
  if (!config || config.tag !== 4) return null;
  at += 13;
  const specific = descriptor();
  if (!specific || specific.tag !== 5) return null;
  const bits = new Bits(b.subarray(specific.body, specific.end));
  const objectType = (): number | null => {
    const t = bits.read(5);
    if (t !== 31) return t;
    const more = bits.read(6);
    return more === null ? null : 32 + more;
  };
  const rate = (): number | null => {
    const index = bits.read(4);
    if (index === null) return null;
    return index === 15 ? bits.read(24) : (ADTS_RATES[index] ?? null);
  };
  const type = objectType();
  const core = rate();
  const configBits = bits.read(4);
  let rateHz = core;
  if (type === 5 || type === 29) {
    // SBR (and PS, which rides on it): the stream decodes at the extension rate, or at twice the core rate.
    const extension = rate();
    rateHz = extension ?? (core === null ? null : core * 2);
  }
  let channels = configBits === null || configBits === 0 ? null : (AAC_CHANNELS[configBits] ?? null);
  // Parametric stereo decodes a mono core to two channels.
  if (type === 29 && channels !== null) channels = Math.max(channels, 2);
  return { channels, rateHz };
}

/**
 * The first sound track's sample entry in a `moov`: its channels and rate
 * from `stsd`, and for AAC the larger of those and the `esds`
 * configuration's, since either may understate what the decoder makes. The
 * track's length from its `mdhd`.
 */
export function readMoov(b: Uint8Array): { channels: number | null; rateHz: number | null; ms: number | null } {
  const moov: Box = { type: "moov", start: 0, body: 8, end: b.length };
  for (const trak of boxesIn(b, moov.body, moov.end).filter((box) => box.type === "trak")) {
    const mdia = child(b, trak, "mdia");
    if (!mdia) continue;
    const hdlr = child(b, mdia, "hdlr");
    if (!hdlr || fourcc(b, hdlr.body + 8) !== "soun") continue;
    let ms: number | null = null;
    const mdhd = child(b, mdia, "mdhd");
    if (mdhd) {
      const v1 = b[mdhd.body] === 1;
      const scaleAt = mdhd.body + (v1 ? 20 : 12);
      if (scaleAt + (v1 ? 12 : 8) <= mdhd.end) {
        const scale = view(b).getUint32(scaleAt);
        const duration = v1 ? view(b).getUint32(scaleAt + 4) * 2 ** 32 + view(b).getUint32(scaleAt + 8) : view(b).getUint32(scaleAt + 4);
        if (scale > 0) ms = (duration / scale) * 1000;
      }
    }
    const minf = child(b, mdia, "minf");
    const stbl = minf && child(b, minf, "stbl");
    const stsd = stbl && child(b, stbl, "stsd");
    // stsd is a full box with an entry count before its entries.
    const entry = stsd && boxesIn(b, stsd.body + 8, stsd.end)[0];
    if (!entry || entry.body + 28 > entry.end) return { channels: null, rateHz: null, ms };
    const version = view(b).getUint16(entry.body + 8);
    let channels: number | null;
    let rateHz: number | null;
    let children: number;
    if (version === 2) {
      if (entry.body + 64 > entry.end) return { channels: null, rateHz: null, ms };
      rateHz = view(b).getFloat64(entry.body + 32);
      channels = view(b).getUint32(entry.body + 40);
      children = entry.body + 64;
    } else {
      channels = view(b).getUint16(entry.body + 16);
      rateHz = view(b).getUint32(entry.body + 24) / 65_536;
      children = entry.body + (version === 1 ? 44 : 28);
    }
    if (!(rateHz > 0) || !Number.isFinite(rateHz)) rateHz = null;
    if (!(channels > 0)) channels = null;
    if (entry.type === "mp4a") {
      const inner = boxesIn(b, children, entry.end);
      // QuickTime files keep the esds inside a `wave` box.
      const wave = inner.find((box) => box.type === "wave");
      const esds = inner.find((box) => box.type === "esds") ?? (wave ? boxesIn(b, wave.body, wave.end).find((box) => box.type === "esds") : undefined);
      const asc = esds ? readEsds(b.subarray(esds.body, esds.end)) : null;
      if (asc?.channels != null) channels = Math.max(channels ?? 0, asc.channels);
      if (asc?.rateHz != null) rateHz = Math.max(rateHz ?? 0, asc.rateHz);
    }
    return { channels, rateHz, ms };
  }
  return { channels: null, rateHz: null, ms: null };
}

async function probeMp4(source: ByteSource, head: Uint8Array): Promise<Probe | null> {
  if (fourcc(head, 4) !== "ftyp") return null;
  const none: Probe = { container: "m4a", channels: null, rateHz: null, ms: null, framed: false, copyCandidate: false, wav: null };
  let at = 0;
  for (let i = 0; i < MAX_BOXES && at + 8 <= source.size; i++) {
    const header = await source.read(at, at + 16);
    let size = view(header).getUint32(0);
    if (size === 1 && header.length >= 16) size = view(header).getUint32(8) * 2 ** 32 + view(header).getUint32(12);
    else if (size === 0) size = source.size - at;
    if (size < 8) return none;
    if (fourcc(header, 4) === "moov") {
      if (size > MAX_MOOV_BYTES) return none;
      const moov = await source.read(at, at + size);
      return { ...none, ...readMoov(moov) };
    }
    at += size;
  }
  return none;
}

// ---------------------------------------------------------------- WebM (Matroska)

/** A Matroska element ID at `at`, its marker bits kept as the specification writes IDs. */
function ebmlId(b: Uint8Array, at: number): { id: number; length: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 4 || at + length > b.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + b[at + i]!;
  return { id, length };
}

/** A Matroska size at `at`, its marker removed. Null size is "unknown", which a live stream's Segment uses. */
function ebmlSize(b: Uint8Array, at: number): { size: number | null; length: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > b.length) return null;
  let size = first & (0xff >> length);
  let allOnes = size === 0xff >> length;
  for (let i = 1; i < length; i++) {
    size = size * 256 + b[at + i]!;
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? null : size, length };
}

type Element = { id: number; body: number; end: number };

function elementsIn(b: Uint8Array, from: number, to: number): Element[] {
  const out: Element[] = [];
  let at = from;
  while (at < to && out.length < MAX_BOXES) {
    const id = ebmlId(b, at);
    const size = id && ebmlSize(b, at + id.length);
    if (!id || !size) break;
    const body = at + id.length + size.length;
    const end = size.size === null ? to : Math.min(to, body + size.size);
    out.push({ id: id.id, body, end });
    // A Cluster holds the audio itself: the tracks and info come before it.
    if (id.id === 0x1f43b675 || size.size === null) break;
    at = end;
  }
  return out;
}

function ebmlUint(b: Uint8Array, e: Element): number {
  let value = 0;
  for (let at = e.body; at < e.end; at++) value = value * 256 + b[at]!;
  return value;
}

function ebmlFloat(b: Uint8Array, e: Element): number {
  if (e.end - e.body === 4) return view(b).getFloat32(e.body);
  if (e.end - e.body === 8) return view(b).getFloat64(e.body);
  return Number.NaN;
}

export function readWebm(b: Uint8Array): { channels: number | null; rateHz: number | null; ms: number | null } | null {
  const top = elementsIn(b, 0, b.length);
  if (top[0]?.id !== 0x1a45dfa3) return null;
  // A Segment of unknown size, as a recorder writes, runs to the end of what was read.
  const seg = top.find((e) => e.id === 0x18538067);
  if (!seg) return { channels: null, rateHz: null, ms: null };
  let channels: number | null = null;
  let rateHz: number | null = null;
  let ms: number | null = null;
  let scale = 1_000_000;
  let duration: number | null = null;
  for (const e of elementsIn(b, seg.body, seg.end)) {
    if (e.id === 0x1549a966) {
      for (const f of elementsIn(b, e.body, e.end)) {
        if (f.id === 0x2ad7b1) scale = ebmlUint(b, f);
        if (f.id === 0x4489) duration = ebmlFloat(b, f);
      }
    }
    if (e.id === 0x1654ae6b) {
      for (const track of elementsIn(b, e.body, e.end).filter((t) => t.id === 0xae)) {
        const fields = elementsIn(b, track.body, track.end);
        const type = fields.find((f) => f.id === 0x83);
        if (!type || ebmlUint(b, type) !== 2) continue;
        const codec = fields.find((f) => f.id === 0x86);
        const codecId = codec ? String.fromCharCode(...b.subarray(codec.body, codec.end)) : "";
        const audio = fields.find((f) => f.id === 0xe1);
        const inner = audio ? elementsIn(b, audio.body, audio.end) : [];
        const ch = inner.find((f) => f.id === 0x9f);
        // Channels defaults to 1 in the specification, and SamplingFrequency to 8 kHz.
        channels = ch ? ebmlUint(b, ch) : 1;
        const rates = inner.filter((f) => f.id === 0xb5 || f.id === 0x78b5).map((f) => ebmlFloat(b, f)).filter((r) => r > 0);
        rateHz = codecId === "A_OPUS" ? 48_000 : rates.length > 0 ? Math.max(...rates) : 8_000;
        break;
      }
    }
  }
  if (duration !== null && Number.isFinite(duration) && duration > 0) ms = (duration * scale) / 1_000_000;
  return { channels, rateHz, ms };
}

// ---------------------------------------------------------------- the probe and its rules

/** Every header this app reads, in order of how sure its signature is. */
export async function probeFile(source: ByteSource): Promise<Probe> {
  const head = await source.read(0, HEAD_BYTES);
  const wav = await readWavFormat(source);
  if (wav) return { container: "wav", channels: wav.channels, rateHz: wav.rateHz, ms: (wav.frames / wav.rateHz) * 1000, framed: false, copyCandidate: false, wav };
  if (fourcc(head, 0) === "RIFF") return { container: "wav", channels: null, rateHz: null, ms: null, framed: false, copyCandidate: false, wav: null };
  const known = (await probeAiff(source, head)) ?? probeFlac(head) ?? (await probeOgg(source, head)) ?? (await probeMp4(source, head));
  if (known) return known;
  const webm = readWebm(head);
  if (webm) return { container: "webm", ...webm, framed: false, copyCandidate: false, wav: null };
  return (await probeAdts(source, head)) ?? (await probeMpeg(source, head)) ?? { container: "other", channels: null, rateHz: null, ms: null, framed: false, copyCandidate: false, wav: null };
}

/**
 * Why a length does not fit a use, or null when it fits (4.2 step 5). The
 * caps hold exactly on the source's own length, but a length counted in
 * frames (an MP3's or AAC's), which carries its encoder's delay and padding
 * already, takes the encoding allowance over each upper cap, as the
 * reducer's check does. No lower cap has one.
 */
export function lengthRefusal(use: SoundUse, ms: number, framed: boolean): Refusal | null {
  const allowance = framed ? SOUND_LIMITS.encodeAllowanceMs : 0;
  const range = SOUND_LIMITS.use[use];
  if (!(ms >= SOUND_LIMITS.fileMinMs)) return { t: "tooShort" };
  if (ms > SOUND_LIMITS.use.music.maxMs + allowance) return { t: "tooLong" };
  if (ms > range.maxMs + allowance) return { t: "useTooLong", use };
  if (ms < range.minMs) return { t: "useTooShort", use };
  return null;
}

/**
 * Bytes a whole decode takes at its peak (4.2 step 1): the file's own
 * bytes, the decoder's output at the file's own rate and channels, the
 * same resampled to 44.1 kHz, and a stereo mix of that for 4 or 6
 * channels. An unknown rate counts as 96 kHz.
 */
export function wholeDecodeBytes(input: { fileBytes: number; ms: number; channels: number; rateHz: number | null }): number {
  const seconds = input.ms / 1000;
  const own = seconds * 4 * input.channels * (input.rateHz ?? SOUND_LIMITS.unknownRateHz);
  const resampled = seconds * 4 * input.channels * 44_100;
  const mix = input.channels > 2 ? seconds * 4 * 2 * 44_100 : 0;
  return input.fileBytes + own + resampled + mix;
}

/** A device's budget for a whole decode: a phone's or a tablet's (touch, no fine pointer) is the smaller. */
export function decodeBudget(device: { touch: boolean; finePointer: boolean }): number {
  return device.touch && !device.finePointer ? SOUND_LIMITS.decodeBudgetTouchBytes : SOUND_LIMITS.decodeBudgetComputerBytes;
}

/** This browser's device, for the budget. */
export function thisDeviceBudget(): number {
  const touch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  const finePointer = typeof matchMedia === "function" && matchMedia("(any-pointer: fine)").matches;
  return decodeBudget({ touch, finePointer });
}

/**
 * Before decoding: a refusal, or how to read the file. `ms` is the probe's
 * or, where the header says no length, the browser's media element's. A
 * candidate MP3 is read in pieces only if the strict walk takes it, which
 * read.ts checks, falling back to a whole decode under this same budget.
 */
export function planRead(input: { probe: Probe; ms: number | null; fileBytes: number; use: SoundUse; budget: number }): { ok: true; path: ReadPath; ms: number } | { ok: false; why: Refusal } {
  const { probe, use } = input;
  if (input.fileBytes > SOUND_LIMITS.readFileBytes) return { ok: false, why: { t: "fileTooLarge" } };
  if (probe.channels === null) return { ok: false, why: { t: "channelsUnknown" } };
  if (!SOUND_LIMITS.channels.includes(probe.channels)) return { ok: false, why: { t: "channels", channels: probe.channels } };
  if (input.ms === null || !Number.isFinite(input.ms)) return { ok: false, why: { t: "lengthUnknown" } };
  // A length the media element read takes the allowance too: it may count an encoder's padding.
  const length = lengthRefusal(use, input.ms, probe.framed || probe.ms === null);
  if (length) return { ok: false, why: length };
  if (probe.copyCandidate) return { ok: true, path: "mp3Pieces", ms: input.ms };
  if (probe.wav && readsInPieces(probe.wav)) return { ok: true, path: "wavPieces", ms: input.ms };
  if (!wholeDecodeFits({ fileBytes: input.fileBytes, ms: input.ms, channels: probe.channels, rateHz: probe.rateHz, budget: input.budget })) return { ok: false, why: { t: "tooBigToRead" } };
  return { ok: true, path: "whole", ms: input.ms };
}

export function wholeDecodeFits(input: { fileBytes: number; ms: number; channels: number; rateHz: number | null; budget: number }): boolean {
  return wholeDecodeBytes(input) <= input.budget;
}
