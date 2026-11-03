import { SOUND_LIMITS } from "../limits.ts";

/**
 * The MP3 check both sides run (docs/design/design-v1-music.md 7.1). It reads
 * frame headers only and decodes nothing, so a crafted file meets no
 * decoder on the server (D-261102-463). The server stores a file only when
 * `walkMp3` takes it whole. The DM's browser runs `stripTags` and then the
 * same walk, to tell a file it may copy from one it must encode: whatever
 * the walk refuses is encoded instead, so a strict rule here costs a copy,
 * never a file.
 *
 * Every byte a stored file holds is a frame header the walk read, audio
 * data inside a frame (which only a browser's decoder reads, in its media
 * sandbox, 7.4), or a field of the one leading tag frame, each held to its
 * range and checked against the frames counted. Each pass is linear in
 * the file, and a caller may pass a `tick` that ends a walk run too long.
 */

/** What a file the walk takes is. */
export type Mp3Facts = {
  rateHz: 44_100 | 48_000;
  /** The one bitrate of every frame, 64 to 192. */
  kbps: number;
  /** Mono, or any two-channel mode (stereo, joint stereo, dual channel), one mode for every frame. */
  channels: 1 | 2;
  /** Every frame but a leading Xing, Info or LAME frame. */
  frames: number;
  /** `frames` times 1152 over the rate, rounded down, from 0.2 s to SOUND_LIMITS.fileMaxMs. */
  ms: number;
  /**
   * Each counted frame's first byte, in order, so the DM's browser cuts
   * pieces on frame boundaries (4.2). The first is past a leading tag
   * frame, so `bytes.subarray(offsets[0])` is the file without it.
   */
  offsets: Uint32Array;
};

/**
 * Why the walk refused: `sound_type` for anything but the one accepted
 * form (another layer, version, rate or bitrate, a second bitrate or mode,
 * a tag, a stray byte, a cut last frame), `sound_length` for a well-formed
 * file of the wrong length. `why` is for logs and tests, never shown.
 */
export type Mp3Refusal = { ok: false; code: "sound_type" | "sound_length"; why: string };

export type Mp3Walk = { ok: true; facts: Mp3Facts } | Mp3Refusal;

export type WalkOptions = {
  /**
   * Called before the walk and every few thousand frames. It may throw to
   * end a walk that has run past its time, as the server's worker does
   * (server/assets/audio/check.ts). The walk itself never throws.
   */
  tick?: () => void;
};

/** Samples in an MPEG-1 Layer III frame. */
export const SAMPLES_PER_FRAME = 1152;

/** MPEG-1 Layer III bitrates by header index, in kbps: 0 is free format and 15 is forbidden. */
export const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0] as const;
/** MPEG-1 sample rates by header index: 3 is reserved. */
export const MP3_RATES = [44_100, 48_000, 32_000, 0] as const;

/** The header bits every frame must share with the first: sync, version, layer, protection, bitrate, rate, channel mode and emphasis. */
const FIXED_BITS = 0xffff_fcc3;

const TICK_FRAMES = 4096;

/**
 * Where a tag frame's name sits in an MPEG-1 Layer III frame: past the
 * header and the side information, 17 bytes of it for mono and 32 for two
 * channels. VBRI's sits 32 bytes past the header in either mode.
 */
const MONO_NAME = 4 + 17;
const STEREO_NAME = 4 + 32;
const VBRI_NAME = 4 + 32;
/** The names as big-endian words, so the walk reads each frame's place once. */
const XING = 0x5869_6e67;
const INFO = 0x496e_666f;
const VBRI = 0x5642_5249;

/** The bytes of a Layer III frame with this header, padding included. */
export function frameBytes(kbps: number, rateHz: number, padded: boolean): number {
  return Math.floor((144_000 * kbps) / rateHz) + (padded ? 1 : 0);
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function u32le(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at < 0 || at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

function refuse(code: Mp3Refusal["code"], why: string): Mp3Refusal {
  return { ok: false, code, why };
}

/**
 * A frame header the walk accepts on its own, before it is compared with
 * the first: MPEG-1 Layer III with no CRC, a bitrate of 64 to 192 kbps, 44.1
 * or 48 kHz, and no emphasis. A CRC moves the side information, where the
 * leading tag frame is read, by two bytes, and emphasis asks the decoder for
 * a filter only some browsers apply, so a file with either is encoded
 * instead of copied.
 */
function headerProblem(h: number): string | null {
  if (h >>> 21 !== 0x7ff) return "no frame sync";
  if (((h >>> 19) & 3) !== 3) return "not MPEG-1";
  if (((h >>> 17) & 3) !== 1) return "not Layer III";
  if (((h >>> 16) & 1) !== 1) return "a frame with a CRC";
  const kbps = MP3_BITRATES[(h >>> 12) & 0xf]!;
  if (kbps < SOUND_LIMITS.minKbps || kbps > SOUND_LIMITS.maxKbps) return `a bitrate of ${kbps || "free format or a forbidden index"}`;
  const rate = MP3_RATES[(h >>> 10) & 3]!;
  if (!SOUND_LIMITS.ratesHz.includes(rate)) return `a sample rate of ${rate || "a reserved index"}`;
  if ((h & 3) !== 0) return "emphasis";
  return null;
}

/**
 * Takes a file that is MPEG-1 Layer III from its first byte to its last,
 * at 44.1 or 48 kHz, every frame at one bitrate from 64 to 192 kbps and one
 * channel mode, with at most one Xing, Info or LAME frame first and no
 * frame after it named as one, ending on a frame boundary, with no tag and
 * no other byte.
 *
 * Padding, private, copyright, original and mode extension bits may differ
 * from frame to frame, since encoders set them frame by frame. A LAME frame
 * is an Info or Xing frame that carries LAME's extension. Browsers read its
 * frame count, its seek table and its encoder delay and padding for what
 * they play, so each is checked against the frames counted here.
 */
export function walkMp3(bytes: Uint8Array, opts: WalkOptions = {}): Mp3Walk {
  opts.tick?.();
  const length = bytes.length;
  if (length < 4) return refuse("sound_type", "shorter than a frame header");
  // Offsets are 32-bit. No MP3 the app takes comes near this, and the DM's tab refuses a file over 200 MB unread.
  if (length > 0xffff_ffff) return refuse("sound_type", "larger than 4 GiB");
  const first = u32(bytes, 0);
  const problem = headerProblem(first);
  if (problem) return refuse("sound_type", `the first frame: ${problem}`);
  const kbps = MP3_BITRATES[(first >>> 12) & 0xf]!;
  const rateHz = MP3_RATES[(first >>> 10) & 3] as 44_100 | 48_000;
  const mono = ((first >>> 6) & 3) === 3;
  const fixed = first & FIXED_BITS;
  // The most frames a file within the length cap holds at this rate. The offsets are bounded by it, not by the input.
  const maxFrames = Math.floor(((SOUND_LIMITS.fileMaxMs + 1) * rateHz - 1) / (SAMPLES_PER_FRAME * 1000));
  const offsets = new Uint32Array(Math.min(Math.floor(length / frameBytes(kbps, rateHz, false)) + 1, maxFrames + 1));

  const tag = tagFrameAt(bytes, 0, frameBytes(kbps, rateHz, ((first >>> 9) & 1) === 1), mono);
  if (!tag.ok) return tag;
  let at = tag.frame ? tag.frame.bytes : 0;
  const name = mono ? MONO_NAME : STEREO_NAME;
  let frames = 0;
  while (at < length) {
    if (frames % TICK_FRAMES === 0) opts.tick?.();
    if (at + 4 > length) return refuse("sound_type", `${length - at} stray bytes at the end`);
    const h = u32(bytes, at);
    if ((h & FIXED_BITS) !== fixed) {
      return refuse("sound_type", `the frame at byte ${at}: ${headerProblem(h) ?? "another bitrate, rate, channel mode or form than the first frame's"}`);
    }
    const size = frameBytes(kbps, rateHz, ((h >>> 9) & 1) === 1);
    if (at + size > length) return refuse("sound_type", `the last frame is cut ${at + size - length} bytes short`);
    // Only the first frame may be a tag frame: a later one's fields would be stored and served as audio no check read.
    // Every frame is at least 192 bytes, so both places lie inside it.
    const named = u32(bytes, at + name);
    const vbri = name === VBRI_NAME ? named : u32(bytes, at + VBRI_NAME);
    if (named === XING || named === INFO || vbri === VBRI) return refuse("sound_type", `a tag frame at byte ${at}, where only the first frame may be one`);
    if (frames < offsets.length) offsets[frames] = at;
    frames++;
    at += size;
  }
  // A tag at the end whose bytes happen to tile as frames is still a tag: a player's browser would read it as one.
  if (endTagAt(bytes, 0, length) !== null) return refuse("sound_type", "a tag at the end");
  if (tag.frame) {
    const declared = tagFrameProblem(tag.frame, frames, length);
    if (declared) return refuse("sound_type", `the leading tag frame: ${declared}`);
  }
  const ms = Math.floor((frames * SAMPLES_PER_FRAME * 1000) / rateHz);
  // Past the cap here exactly when past `maxFrames`, so the offsets kept every frame of any file this takes.
  if (ms > SOUND_LIMITS.fileMaxMs) return refuse("sound_length", `${ms} ms is longer than ${SOUND_LIMITS.fileMaxMs}`);
  if (ms < SOUND_LIMITS.fileMinMs) return refuse("sound_length", `${ms} ms is shorter than ${SOUND_LIMITS.fileMinMs}`);
  return { ok: true, facts: { rateHz, kbps, channels: mono ? 1 : 2, frames, ms, offsets: offsets.subarray(0, frames) } };
}

/** What a leading tag frame declares, checked once the frames are counted. */
type TagFrame = {
  bytes: number;
  frames?: number;
  streamBytes?: number;
  toc?: Uint8Array;
  lame?: { delay: number; padding: number; musicBytes: number };
};

/** The encoder names a LAME extension may carry: LAME's own, and FFmpeg's, which writes the same layout. */
const ENCODER = /^(LAME|Lavc|Lavf)$/;
const ENCODER_NAME = /^(LAME|Lavc|Lavf)[0-9a-z. ]{0,5}\0*$/;

/**
 * The first frame read as Xing's tag frame, when it is one: its side
 * information zero, as a tag frame's is, only the four defined flags, the
 * fields they place, an optional LAME extension, and zeros from there to
 * the frame's end. A VBRI frame, or a Xing or Info name at the other
 * channel mode's place, is refused: a browser reading either would take a
 * length or a seek table this walk never checked.
 */
function tagFrameAt(bytes: Uint8Array, start: number, frameSize: number, mono: boolean): { ok: true; frame: TagFrame | null } | Mp3Refusal {
  const name = start + (mono ? MONO_NAME : STEREO_NAME);
  const otherName = start + (mono ? STEREO_NAME : MONO_NAME);
  const size = start + frameSize;
  if (ascii(bytes, start + VBRI_NAME, "VBRI")) return refuse("sound_type", "a VBRI frame");
  if (ascii(bytes, otherName, "Xing") || ascii(bytes, otherName, "Info")) return refuse("sound_type", "a tag frame's name at the other channel mode's place");
  if (!ascii(bytes, name, "Xing") && !ascii(bytes, name, "Info")) return { ok: true, frame: null };
  if (size > bytes.length) return refuse("sound_type", "a tag frame cut short");
  if (!allZero(bytes, start + 4, name)) return refuse("sound_type", "a tag frame whose side information is not zero");
  if (name + 8 > size) return refuse("sound_type", "a tag frame too small for its flags");
  const flags = u32(bytes, name + 4);
  if ((flags & ~0xf) !== 0) return refuse("sound_type", "a tag frame with undefined flags");
  const frame: TagFrame = { bytes: frameSize };
  let p = name + 8;
  const fits = (n: number) => p + n <= size;
  if (flags & 1) {
    if (!fits(4)) return refuse("sound_type", "a tag frame too small for its frame count");
    frame.frames = u32(bytes, p);
    p += 4;
  }
  if (flags & 2) {
    if (!fits(4)) return refuse("sound_type", "a tag frame too small for its byte count");
    frame.streamBytes = u32(bytes, p);
    p += 4;
  }
  if (flags & 4) {
    if (!fits(100)) return refuse("sound_type", "a tag frame too small for its seek table");
    frame.toc = bytes.subarray(p, p + 100);
    p += 100;
  }
  if (flags & 8) {
    if (!fits(4)) return refuse("sound_type", "a tag frame too small for its quality");
    if (u32(bytes, p) > 100) return refuse("sound_type", "a tag frame's quality over 100");
    p += 4;
  }
  if (fits(36) && ENCODER.test(latin1(bytes, p, p + 4))) {
    const lame = lameExtension(bytes, p);
    if (typeof lame === "string") return refuse("sound_type", `a LAME extension with ${lame}`);
    frame.lame = lame;
    p += 36;
  }
  if (!allZero(bytes, p, size)) return refuse("sound_type", "a tag frame with bytes after its fields");
  return { ok: true, frame };
}

/**
 * LAME's 36-byte extension (the LAME tag, revisions 0 and 1): an encoder
 * name of letters, digits and dots, then encoder settings, all numbers.
 * Each field with a defined range is held to it. The encoder delay and
 * padding are what browsers trim from the start and the end, so they are
 * kept for the check against the frames.
 */
function lameExtension(bytes: Uint8Array, p: number): TagFrame["lame"] | string {
  if (!ENCODER_NAME.test(latin1(bytes, p, p + 9))) return "an encoder name that is not an encoder's";
  const revision = bytes[p + 9]! >> 4;
  const method = bytes[p + 9]! & 0xf;
  if (revision > 1) return `revision ${revision}`;
  // 0 unknown, 1 constant bitrate, 8 two-pass constant bitrate: the only methods a file of one bitrate comes from.
  if (method !== 0 && method !== 1 && method !== 8) return `encoding method ${method}`;
  // The peak sample, 9.23 fixed point: no file's peak comes near 16 times full scale.
  if (u32(bytes, p + 11) > 16 * 2 ** 23) return "a peak that is no sample's";
  // Replay gain: each field's name code in its top three bits, radio 1 or audiophile 2 in its own field, or 0 for none.
  if (bytes[p + 15]! >> 5 > 1 || (bytes[p + 17]! >> 5 !== 0 && bytes[p + 17]! >> 5 !== 2)) return "a replay gain of another kind";
  if ((bytes[p + 26]! & 0xc0) !== 0) return "unused preset bits set";
  const delay = (bytes[p + 21]! << 4) | (bytes[p + 22]! >> 4);
  const padding = ((bytes[p + 22]! & 0xf) << 8) | bytes[p + 23]!;
  return { delay, padding, musicBytes: u32(bytes, p + 28) };
}

/**
 * The tag frame's declarations against the stream: a frame count must be
 * the frames counted, and a byte count and LAME's music length the file's
 * length with or without the tag frame, since encoders differ on which. The
 * seek table must step through the file as one bitrate does, within the
 * sampling LAME's own tables show, so a browser that seeks by it lands
 * where the others do. The delay and padding a browser trims must leave
 * some audio.
 */
function tagFrameProblem(tag: TagFrame, frames: number, length: number): string | null {
  const byteCountFits = (n: number) => n === 0 || (n >= length - tag.bytes && n <= length);
  if (tag.frames !== undefined && tag.frames !== frames) return `a frame count of ${tag.frames} for ${frames} frames`;
  if (tag.streamBytes !== undefined && !byteCountFits(tag.streamBytes)) return `a byte count of ${tag.streamBytes} for ${length} bytes`;
  if (tag.lame && !byteCountFits(tag.lame.musicBytes)) return `a music length of ${tag.lame.musicBytes} for ${length} bytes`;
  if (tag.lame && tag.lame.delay + tag.lame.padding >= frames * SAMPLES_PER_FRAME) return "a delay and padding as long as the audio";
  if (tag.toc) {
    // In the table's 1/256 steps of the file: one for rounding, 1.5 for LAME sampling at most 400 frames for it, and two
    // frames each way for a file so short that one frame is many steps.
    const slack = 2.5 + (256 * 2 * tag.bytes) / length;
    let last = 0;
    for (let i = 0; i < 100; i++) {
      const entry = tag.toc[i]!;
      if (entry < last) return "a seek table that steps back";
      if (Math.abs(entry - (256 * i) / 100) > slack) return "a seek table of another bitrate's steps";
      last = entry;
    }
  }
  return null;
}

/**
 * The file without its tags, for the DM's browser before it walks a file
 * to copy: an ID3v2 tag at the start by its own size (at most
 * SOUND_LIMITS.id3v2MaxBytes), and ID3v1, APEv2 and Lyrics3 tags at the
 * end, at most SOUND_LIMITS.endTagsMax. `bytes` is a view of the input, not
 * a copy, and `stripped` counts the bytes that went. A tag whose size runs
 * past the file or its bound is `sound_type`, and so is a fourth at the end.
 */
export function stripTags(bytes: Uint8Array): { ok: true; bytes: Uint8Array; stripped: number } | { ok: false; code: "sound_type"; why: string } {
  const refused = (why: string) => ({ ok: false as const, code: "sound_type" as const, why });
  let start = 0;
  if (ascii(bytes, 0, "ID3")) {
    if (bytes.length < 10) return refused("an ID3v2 header cut short");
    const major = bytes[3]!;
    if (major < 2 || major > 4 || bytes[4] === 0xff) return refused(`ID3v2.${major}`);
    let size = 0;
    for (let i = 6; i < 10; i++) {
      if (bytes[i]! & 0x80) return refused("an ID3v2 size that is not syncsafe");
      size = size * 128 + bytes[i]!;
    }
    // ID3v2.4's footer flag adds a second 10-byte header at the tag's end.
    const total = 10 + size + (major === 4 && bytes[5]! & 0x10 ? 10 : 0);
    if (total > SOUND_LIMITS.id3v2MaxBytes) return refused("an ID3v2 tag over its bound");
    if (total > bytes.length) return refused("an ID3v2 tag past the file's end");
    start = total;
  }
  let end = bytes.length;
  for (let n = 0; ; n++) {
    const tag = endTagAt(bytes, start, end);
    if (tag === null) break;
    if (typeof tag === "string") return refused(tag);
    if (n === SOUND_LIMITS.endTagsMax) return refused(`more than ${SOUND_LIMITS.endTagsMax} tags at the end`);
    end -= tag;
  }
  return { ok: true, bytes: bytes.subarray(start, end), stripped: start + (bytes.length - end) };
}

/** Lyrics3 v1 has no size field: its lyrics run at most this long before its end marker. */
const LYRICS3V1_MAX = 5100;

/**
 * The size of the tag that ends at `end` within [start, end), null when
 * none does, or why one that does is refused. Each kind is found by its own
 * marker at a fixed place from the end. The one scan, for Lyrics3 v1's
 * start, is bounded by that tag's size, so stripping stays linear.
 */
function endTagAt(bytes: Uint8Array, start: number, end: number): number | string | null {
  const room = end - start;
  if (room >= 128 && ascii(bytes, end - 128, "TAG")) return 128;
  if (room >= 32 && ascii(bytes, end - 32, "APETAGEX")) {
    const version = u32le(bytes, end - 24);
    const size = u32le(bytes, end - 20);
    const flags = u32le(bytes, end - 12);
    if (version !== 1000 && version !== 2000) return `APE tag version ${version}`;
    // Bit 29 marks a header, and a footer is what ends a tag.
    if (flags & 0x2000_0000) return "an APE header where its footer belongs";
    const header = flags & 0x8000_0000 ? 32 : 0;
    if (size < 32 || size + header > room) return "an APE tag past the file's start";
    if (header && !ascii(bytes, end - size - header, "APETAGEX")) return "an APE tag whose header is missing";
    return size + header;
  }
  if (room >= 15 && ascii(bytes, end - 9, "LYRICS200")) {
    const digits = latin1(bytes, end - 15, end - 9);
    if (!/^\d{6}$/.test(digits)) return "a Lyrics3 size that is not six digits";
    const total = Number(digits) + 15;
    if (total > room || !ascii(bytes, end - total, "LYRICSBEGIN")) return "a Lyrics3 tag past the file's start";
    return total;
  }
  if (room >= 20 && ascii(bytes, end - 9, "LYRICSEND")) {
    const earliest = Math.max(start, end - 20 - LYRICS3V1_MAX);
    for (let at = end - 20; at >= earliest; at--) if (ascii(bytes, at, "LYRICSBEGIN")) return end - at;
    return "a Lyrics3 tag with no start";
  }
  return null;
}
