import { MP3_BITRATES, MP3_RATES, SAMPLES_PER_FRAME, frameBytes } from "./mp3.ts";

/**
 * MP3 streams of silence built byte by byte, so the frame walk's tests and
 * the server's need no encoder and ship no recording
 * (docs/design/design-v1-sound.md 12). A Layer III frame whose side
 * information and main data are all zero decodes as silence: every granule
 * has no coded values. The tag builders make the ID3v2, ID3v1, APEv2,
 * Lyrics3 and Xing or Info frames the walk and `stripTags` meet in the wild.
 */

export type FrameBits = {
  /** 0 stereo, 1 joint stereo, 2 dual channel, 3 mono. */
  mode?: 0 | 1 | 2 | 3;
  modeExt?: 0 | 1 | 2 | 3;
  private?: boolean;
  copyright?: boolean;
  original?: boolean;
};

export type StreamShape = {
  rateHz?: 44_100 | 48_000 | 32_000;
  kbps?: number;
  mode?: 0 | 1 | 2 | 3;
  /** Each frame's own bits, beside the mode, which every frame shares unless this gives another. */
  bits?: (index: number) => FrameBits;
};

/** One frame header the walk accepts: MPEG-1 Layer III with no CRC and no emphasis, joint stereo unless `mode` says. */
export function frameHeader(shape: { rateHz: number; kbps: number; padded: boolean } & FrameBits): number {
  const bitrate = MP3_BITRATES.indexOf(shape.kbps as (typeof MP3_BITRATES)[number]);
  const rate = MP3_RATES.indexOf(shape.rateHz as (typeof MP3_RATES)[number]);
  if (bitrate < 1 || rate < 0) throw new Error(`no MPEG-1 Layer III header has ${shape.kbps} kbps at ${shape.rateHz} Hz`);
  return (
    (0xffe0_0000 |
      (3 << 19) |
      (1 << 17) |
      (1 << 16) |
      (bitrate << 12) |
      (rate << 10) |
      (shape.padded ? 1 << 9 : 0) |
      (shape.private ? 1 << 8 : 0) |
      ((shape.mode ?? 1) << 6) |
      ((shape.modeExt ?? 0) << 4) |
      (shape.copyright ? 1 << 3 : 0) |
      (shape.original ? 1 << 2 : 0)) >>>
    0
  );
}

function writeU32(out: Uint8Array, at: number, value: number): void {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

function writeU32le(out: Uint8Array, at: number, value: number): void {
  out[at] = value & 0xff;
  out[at + 1] = (value >>> 8) & 0xff;
  out[at + 2] = (value >>> 16) & 0xff;
  out[at + 3] = (value >>> 24) & 0xff;
}

function writeAscii(out: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
}

/**
 * Which frames of a constant bitrate stream carry the padding byte, as an
 * encoder spreads them: 44.1 kHz frames are a fraction of a byte longer
 * than their unpadded size, and padding keeps the bitrate exact.
 */
export function paddingPattern(kbps: number, rateHz: number, frames: number): boolean[] {
  const remainder = (144_000 * kbps) % rateHz;
  const out: boolean[] = [];
  let carry = 0;
  for (let i = 0; i < frames; i++) {
    carry += remainder;
    const padded = carry >= rateHz;
    if (padded) carry -= rateHz;
    out.push(padded);
  }
  return out;
}

/** `frames` frames of silence at one bitrate, rate and mode, padded as an encoder pads them. */
export function silentFrames(frames: number, shape: StreamShape = {}): Uint8Array {
  const rateHz = shape.rateHz ?? 44_100;
  const kbps = shape.kbps ?? 128;
  const pads = paddingPattern(kbps, rateHz, frames);
  const sizes = pads.map((p) => frameBytes(kbps, rateHz, p));
  const out = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let at = 0;
  for (let i = 0; i < frames; i++) {
    writeU32(out, at, frameHeader({ rateHz, kbps, padded: pads[i]!, mode: shape.mode, ...shape.bits?.(i) }));
    at += sizes[i]!;
  }
  return out;
}

/** The frames a stream of `ms` milliseconds needs at this rate, rounded up. */
export function framesFor(ms: number, rateHz: number = 44_100): number {
  return Math.ceil((ms * rateHz) / (SAMPLES_PER_FRAME * 1000));
}

export type TagFrameShape = {
  name?: "Xing" | "Info";
  /** The frame count to declare, the stream's own unless given. */
  frames?: number | null;
  /** The byte count to declare, the whole file's unless given. */
  streamBytes?: number | null;
  /** A seek table: "linear" for a constant bitrate's, or the 100 bytes to write. */
  toc?: "linear" | Uint8Array | null;
  quality?: number | null;
  /** LAME's extension, as LAME 3.100 writes it unless a field is given. */
  lame?: { name?: string; method?: number; delay?: number; padding?: number; musicBytes?: number; peak?: number; radio?: number } | null;
};

/**
 * The stream with a Xing or Info frame first, of the stream's own header,
 * declaring what `shape` says: by default every field LAME writes for a
 * constant bitrate file, its frame count, byte count, a linear seek table,
 * a quality and LAME's extension.
 */
export function withTagFrame(stream: Uint8Array, shape: TagFrameShape = {}): Uint8Array {
  const first = ((stream[0]! << 24) | (stream[1]! << 16) | (stream[2]! << 8) | stream[3]!) >>> 0;
  const kbps = MP3_BITRATES[(first >>> 12) & 0xf]!;
  const rateHz = MP3_RATES[(first >>> 10) & 3]!;
  const mono = ((first >>> 6) & 3) === 3;
  const size = frameBytes(kbps, rateHz, false);
  const out = new Uint8Array(size + stream.length);
  out.set(stream, size);
  writeU32(out, 0, first & ~(1 << 9));
  let countFrames = 0;
  for (let at = 0; at < stream.length; countFrames++) at += frameBytes(kbps, rateHz, ((stream[at + 2]! >> 1) & 1) === 1);
  const name = 4 + (mono ? 17 : 32);
  writeAscii(out, name, shape.name ?? "Info");
  const frames = shape.frames === undefined ? countFrames : shape.frames;
  const streamBytes = shape.streamBytes === undefined ? out.length : shape.streamBytes;
  const toc = shape.toc === undefined ? "linear" : shape.toc;
  const quality = shape.quality === undefined ? 50 : shape.quality;
  const flags = (frames !== null ? 1 : 0) | (streamBytes !== null ? 2 : 0) | (toc !== null ? 4 : 0) | (quality !== null ? 8 : 0);
  writeU32(out, name + 4, flags);
  let p = name + 8;
  if (frames !== null) {
    writeU32(out, p, frames);
    p += 4;
  }
  if (streamBytes !== null) {
    writeU32(out, p, streamBytes);
    p += 4;
  }
  if (toc !== null) {
    for (let i = 0; i < 100; i++) out[p + i] = toc === "linear" ? Math.floor((256 * i) / 100) : toc[i]!;
    p += 100;
  }
  if (quality !== null) {
    writeU32(out, p, quality);
    p += 4;
  }
  const lame = shape.lame === undefined ? {} : shape.lame;
  if (lame !== null) {
    writeAscii(out, p, (lame.name ?? "LAME3.100").padEnd(9, "\0").slice(0, 9));
    out[p + 9] = lame.method ?? 1;
    out[p + 10] = 160;
    writeU32(out, p + 11, lame.peak ?? 0);
    out[p + 15] = ((lame.radio ?? 0) >> 8) & 0xff;
    out[p + 16] = (lame.radio ?? 0) & 0xff;
    out[p + 20] = kbps;
    const delay = lame.delay ?? 576;
    const padding = lame.padding ?? 1152;
    out[p + 21] = delay >> 4;
    out[p + 22] = ((delay & 0xf) << 4) | (padding >> 8);
    out[p + 23] = padding & 0xff;
    writeU32(out, p + 28, lame.musicBytes ?? out.length);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An ID3v2 tag of `body` bytes after its header, holding a title, or `version` 4 with a footer. */
export function id3v2(body: number, opts: { version?: 2 | 3 | 4; footer?: boolean } = {}): Uint8Array {
  const footer = opts.version === 4 && opts.footer === true;
  const out = new Uint8Array(10 + body + (footer ? 10 : 0));
  writeAscii(out, 0, "ID3");
  out[3] = opts.version ?? 3;
  out[5] = footer ? 0x10 : 0;
  for (let i = 0; i < 4; i++) out[6 + i] = (body >> (7 * (3 - i))) & 0x7f;
  writeAscii(out, 10, "TIT2".slice(0, Math.min(4, body)));
  if (footer) writeAscii(out, 10 + body, "3DI");
  return out;
}

/** An ID3v1 tag: its 128 bytes with a title. */
export function id3v1(title = "A private title"): Uint8Array {
  const out = new Uint8Array(128);
  writeAscii(out, 0, "TAG");
  writeAscii(out, 3, title.slice(0, 30));
  return out;
}

/** An APEv2 tag of `items` bytes, with or without its header. */
export function apeTag(items: number, opts: { header?: boolean; version?: number } = {}): Uint8Array {
  const header = opts.header ?? true;
  const out = new Uint8Array((header ? 32 : 0) + items + 32);
  const block = (at: number, isHeader: boolean) => {
    writeAscii(out, at, "APETAGEX");
    writeU32le(out, at + 8, opts.version ?? 2000);
    writeU32le(out, at + 12, items + 32);
    writeU32le(out, at + 16, 1);
    writeU32le(out, at + 20, ((header ? 0x8000_0000 : 0) | (isHeader ? 0x2000_0000 : 0)) >>> 0);
  };
  if (header) block(0, true);
  block(out.length - 32, false);
  return out;
}

/** A Lyrics3 v2 tag of these lyrics, sized by its six digits. */
export function lyrics3v2(lyrics = "IND00002101LYR00005hello"): Uint8Array {
  const body = `LYRICSBEGIN${lyrics}`;
  return new TextEncoder().encode(`${body}${String(body.length).padStart(6, "0")}LYRICS200`);
}

/** A Lyrics3 v1 tag of these lyrics, which has no size of its own. */
export function lyrics3v1(lyrics = "hello"): Uint8Array {
  return new TextEncoder().encode(`LYRICSBEGIN${lyrics}LYRICSEND`);
}
