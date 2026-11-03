import { VIDEO_LIMITS } from "#shared/limits.ts";
import type { ParsedVideo } from "./check.ts";
import { Bits, OPUS_HZ, av1CodecString, opusHead, peakInOneSecond } from "./records.ts";
import { Edits, Tally, refuse, type Budget, type Range, type Source } from "./window.ts";

/**
 * The MP4 header check (docs/design/design-v1-animated-maps.md 10, mp4.ts).
 *
 * The top-level boxes are read through the window, and `moov`, at most
 * 8 MiB, is read whole and walked in memory. Boxes on the allowlist are
 * kept, their times and names zeroed. Every other box is renamed `free`
 * with an all-zero payload, the same length, so no byte moves and every
 * chunk offset stays right. `free`, `skip` and `wide` already in the file
 * are zeroed too (AM-ASTRA-01). Nothing inside `mdat` is ever written, and
 * every sample the tables name must lie inside an `mdat`, so no edit can
 * land on an offset the file's own tables give (D-261102-514).
 *
 * A kept box is read to its last byte (AMBUILD-SOL-003): each FullBox's
 * version and flags are checked, each field is a number in its range, a
 * field the format reserves or fixes is zeroed, and a box the format
 * allows once in its parent is refused the second time, so no copy the
 * check did not read is kept.
 */

type Box = {
  type: string;
  start: number;
  end: number;
  /** Where the payload starts: after the size, the type, any 64-bit size and any `uuid` user type. */
  payload: number;
  /** Where a renamed box's zeroing starts: after the size, the type and any 64-bit size, so a `uuid`'s user type goes too. */
  afterType: number;
};

const PADDING = new Set(["free", "skip", "wide"]);
const FRAGMENTED = new Set(["moof", "mfra", "sidx", "ssix", "styp", "emsg", "prft", "mvex"]);
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * The compatible brands `ftyp` keeps: those of the files this check
 * accepts. Any other is zeroed in place, which no player reads as anything,
 * so a list of brands holds no text.
 */
const KNOWN_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "avc1", "av01", "mp41", "mp42", "mp71",
  "M4V ", "M4VH", "M4VP", "dash", "cmfc", "cmf2", "dby1", "MSNV", "XAVC", "mmp4", "3gp4", "3gp5", "3gp6", "3g2a",
]);

/**
 * Sample group types `sgpd` and `sbgp` may keep, each with its one-record
 * layout (ISO 14496-12 10): AAC's and Opus's roll and pre-roll, random
 * access points, sync samples and temporal levels. Any other type is
 * dropped with its mapping, since an unknown record could be anything.
 */
const SAMPLE_GROUPS: Readonly<Record<string, { bytes: number; check(record: Buffer): boolean }>> = {
  roll: { bytes: 2, check: () => true },
  prol: { bytes: 2, check: () => true },
  "rap ": { bytes: 1, check: () => true },
  // Two reserved bits, then a NAL unit type.
  sync: { bytes: 1, check: (r) => (r[0]! & 0xc0) === 0 },
  // One flag, then seven reserved bits.
  tele: { bytes: 1, check: (r) => (r[0]! & 0x7f) === 0 },
};

type Track = {
  handler: string;
  sampleEntry?: string;
  width?: number;
  height?: number;
  tkhdWidth?: number;
  tkhdHeight?: number;
  identity?: boolean;
  codec?: string;
  channels?: number;
  hz?: number;
  dataRef?: number;
  drefCount?: number;
  timescale?: number;
  /** tkhd's duration in the movie's timescale, and mdhd's in the track's. */
  tkhdDuration?: number;
  mdhdDuration?: number;
  edit?: { segment: number; mediaTime: number } | null;
  stts?: Array<[number, number]>;
  ctts?: Array<[number, number]>;
  stsc?: Array<[number, number]>;
  sizes?: number[];
  chunks?: number[];
  /** cslg's five numbers, checked against the track's own timing once it is known. */
  cslg?: { shift: number; least: number; greatest: number; start: number; end: number };
};

class Moov {
  readonly m: Buffer;
  readonly base: number;
  readonly edits: Edits;
  readonly headers: Tally;
  readonly budget: Budget;

  constructor(m: Buffer, base: number, edits: Edits, headers: Tally, budget: Budget) {
    this.m = m;
    this.base = base;
    this.edits = edits;
    this.headers = headers;
    this.budget = budget;
  }

  children(parent: { payload: number; end: number }, depth: number, from = parent.payload): Box[] {
    if (depth > VIDEO_LIMITS.parseDepth) throw refuse("bad_video");
    const out: Box[] = [];
    let at = from;
    while (at < parent.end) {
      this.budget.check();
      this.headers.add();
      const box = boxHeader((o, n) => this.slice(o, o + n), at, parent.end, false);
      out.push(box);
      at = box.end;
    }
    return out;
  }

  slice(start: number, end: number): Buffer {
    if (start < this.base || end > this.base + this.m.length || end < start) throw refuse("bad_video");
    return this.m.subarray(start - this.base, end - this.base);
  }

  payload(box: Box): Buffer {
    return this.slice(box.payload, box.end);
  }

  /**
   * A FullBox's version, at most `maxVersion`, its flags, which may hold
   * only the `allowed` bits and must hold the `required` ones, and the
   * rest of its payload.
   */
  full(box: Box, maxVersion: number, flags: { allowed?: number; required?: number } = {}): { version: number; flags: number; body: Buffer; at: number } {
    const p = this.payload(box);
    if (p.length < 4) throw refuse("bad_video");
    const version = p[0]!;
    const f = p.readUIntBE(1, 3);
    const allowed = flags.allowed ?? 0;
    const required = flags.required ?? 0;
    if (version > maxVersion || (f & ~allowed) !== 0 || (f & required) !== required) throw refuse("bad_video");
    return { version, flags: f, body: p.subarray(4), at: box.payload + 4 };
  }

  /** Bytes the format reserves or fixes, from `at`, zeroed in place. */
  zeroAt(at: number, length: number): void {
    this.edits.zero(at, at + length);
  }

  /** `bytes` written at `at`, only where the file holds something else, so a stored file checks again with no edit. */
  putAt(at: number, bytes: Buffer): void {
    if (!this.slice(at, at + bytes.length).equals(bytes)) this.edits.put(at, bytes);
  }

  renameFree(box: Box): void {
    this.edits.put(box.start + 4, Buffer.from("free", "latin1"));
    this.edits.zero(box.afterType, box.end);
  }

  zeroPayload(box: Box): void {
    this.edits.zero(box.payload, box.end);
  }

  /** Padding zeroed, anything else off the list renamed `free`. */
  drop(box: Box): void {
    if (PADDING.has(box.type)) this.zeroPayload(box);
    else this.renameFree(box);
  }
}

/** Refuses a second box of a type its parent may hold once (AMBUILD-SOL-006). */
function once(seen: Set<string>, type: string): void {
  if (seen.has(type)) throw refuse("bad_video");
  seen.add(type);
}

/** A box header at `at` inside `[.., parentEnd)`. A size of 0 runs to the end, which only the last top-level box may do. */
function boxHeader(read: (offset: number, length: number) => Buffer, at: number, parentEnd: number, topLevel: boolean): Box {
  if (parentEnd - at < 8) throw refuse("bad_video");
  const head = read(at, Math.min(32, parentEnd - at));
  const size32 = head.readUInt32BE(0);
  const type = head.subarray(4, 8).toString("latin1");
  let size: number;
  let afterType = at + 8;
  if (size32 === 1) {
    if (head.length < 16) throw refuse("bad_video");
    const big = head.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse("bad_video");
    size = Number(big);
    afterType = at + 16;
  } else if (size32 === 0) {
    if (!topLevel) throw refuse("bad_video");
    size = parentEnd - at;
  } else {
    size = size32;
  }
  const payload = afterType + (type === "uuid" ? 16 : 0);
  const end = at + size;
  if (end < payload || end > parentEnd) throw refuse("bad_video");
  return { type, start: at, end, payload, afterType };
}

/** Four printable ASCII bytes, as every brand is written. */
function isFourCc(b: Buffer): boolean {
  return b.length === 4 && b.every((c) => c >= 0x20 && c <= 0x7e);
}

/**
 * `ftyp`: a printable major brand, which names the container to the sniff,
 * the minor version zeroed, and each compatible brand kept only when known.
 */
async function fileType(src: Source, box: Box, edits: Edits): Promise<void> {
  const length = box.end - box.payload;
  if (length < 8 || length > VIDEO_LIMITS.parseValueBytes || (length - 8) % 4 !== 0) throw refuse("bad_video");
  const p = await src.read(box.payload, length);
  if (!isFourCc(p.subarray(0, 4))) throw refuse("bad_video");
  edits.zero(box.payload + 4, box.payload + 8);
  for (let at = 8; at < length; at += 4) {
    if (!KNOWN_BRANDS.has(p.subarray(at, at + 4).toString("latin1"))) edits.zero(box.payload + at, box.payload + at + 4);
  }
}

export async function parseMp4(src: Source, budget: Budget): Promise<ParsedVideo> {
  const edits = new Edits();
  const headers = new Tally(VIDEO_LIMITS.parseElementHeaders);
  const mdats: Range[] = [];
  let moovBox: Box | undefined;
  let at = 0;
  let first = true;
  const windowRead = async (offset: number, length: number) => Buffer.from(await src.read(offset, length));
  while (at < src.size) {
    budget.check();
    headers.add();
    if (src.size - at < 8) throw refuse("bad_video");
    const head = await windowRead(at, Math.min(32, src.size - at));
    const box = boxHeader((o, n) => head.subarray(o - at, o - at + n), at, src.size, true);
    if (first) {
      if (box.type !== "ftyp") throw refuse("video_type");
      await fileType(src, box, edits);
      first = false;
    } else if (box.type === "ftyp") {
      throw refuse("bad_video");
    } else if (box.type === "moov") {
      if (moovBox) throw refuse("bad_video");
      if (box.end - box.start > VIDEO_LIMITS.parseMoovBytes) throw refuse("bad_video");
      moovBox = box;
    } else if (box.type === "mdat") {
      mdats.push({ start: box.payload, end: box.end });
      edits.protect(box.payload, box.end);
    } else if (FRAGMENTED.has(box.type)) {
      throw refuse("video_fragmented");
    } else if (PADDING.has(box.type)) {
      edits.zero(box.payload, box.end);
    } else {
      edits.put(box.start + 4, Buffer.from("free", "latin1"));
      edits.zero(box.afterType, box.end);
    }
    at = box.end;
  }
  if (!moovBox || mdats.length === 0) throw refuse("bad_video");
  const m = await src.readAll(moovBox.start, moovBox.end - moovBox.start);
  const moov = new Moov(Buffer.from(m), moovBox.start, edits, headers, budget);
  return parseMoov(moov, moovBox, mdats);
}

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const IDENTITY_BYTES = Buffer.concat(IDENTITY.map((v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
}));

function parseMoov(moov: Moov, box: Box, mdats: readonly Range[]): ParsedVideo {
  let movieTimescale = 0;
  let movieDuration = 0;
  let sawHeader = false;
  const tracks: Track[] = [];
  for (const child of moov.children(box, 1)) {
    if (child.type === "mvhd") {
      if (sawHeader) throw refuse("bad_video");
      sawHeader = true;
      const { version, body, at } = moov.full(child, 1);
      if (body.length !== (version === 1 ? 108 : 96)) throw refuse("bad_video");
      const t = version === 1 ? 16 : 8;
      moov.edits.zero(at, at + t);
      movieTimescale = body.readUInt32BE(t);
      movieDuration = version === 1 ? safe(body.readBigUInt64BE(t + 4)) : body.readUInt32BE(t + 4);
      // After the rate and the volume: ten reserved bytes, the movie's matrix, then 24 more reserved before next_track_ID.
      const rate = t + (version === 1 ? 12 : 8);
      moov.zeroAt(at + rate + 6, 10);
      if (!body.subarray(rate + 16, rate + 52).equals(IDENTITY_BYTES)) throw refuse("video_geometry");
      moov.zeroAt(at + rate + 52, 24);
    } else if (child.type === "trak") tracks.push(parseTrak(moov, child));
    else if (child.type === "mvex") throw refuse("video_fragmented");
    else moov.drop(child); // udta, meta, iods, uuid and the rest
  }
  if (!sawHeader || movieTimescale <= 0) throw refuse("bad_video");

  const videos = tracks.filter((t) => t.handler === "vide");
  const sounds = tracks.filter((t) => t.handler === "soun");
  const timecodes = tracks.filter((t) => t.handler === "tmcd");
  if (videos.length !== 1 || sounds.length > 1 || timecodes.length > 1 || videos.length + sounds.length + timecodes.length !== tracks.length) throw refuse("video_tracks");
  const video = videos[0]!;
  const sound = sounds[0];
  for (const track of tracks) {
    if (track.dataRef === undefined || track.drefCount === undefined || track.dataRef < 1 || track.dataRef > track.drefCount) throw refuse("bad_video");
    samplesInsideMdat(moov, track, mdats);
  }

  if (!video.identity) throw refuse("video_geometry");
  if (video.tkhdWidth !== video.width || video.tkhdHeight !== video.height) throw refuse("video_geometry");

  const v = timing(moov, video, movieTimescale, VIDEO_LIMITS.parseVideoFrameHeaders, "video_fps");
  const frames = v.times.length;
  if (frames === 0) throw refuse("bad_video");
  const videoSeconds = v.seconds;
  const frame = videoSeconds / frames;
  const tolerance = Math.max(frame, VIDEO_LIMITS.soundOverrunMs / 1000);
  const covers = (t: { seconds: number; remaining: number | null }) => {
    if (t.remaining !== null && Math.abs(t.seconds - t.remaining) > tolerance) throw refuse("video_layout");
  };
  covers(v);
  let longest = videoSeconds;
  if (sound) {
    const s = timing(moov, sound, movieTimescale, VIDEO_LIMITS.parseSoundFrameHeaders, "bad_video");
    covers(s);
    if (s.seconds > videoSeconds + tolerance) throw refuse("video_layout");
    longest = Math.max(longest, s.seconds);
  }
  for (const t of timecodes) timing(moov, t, movieTimescale, 1_000, "bad_video");
  if (Math.abs(movieDuration / movieTimescale - longest) > tolerance) throw refuse("video_layout");

  const fps = peakInOneSecond(v.times, video.timescale!);
  return {
    container: "mp4",
    widthPx: video.width!,
    heightPx: video.height!,
    video: video.codec!,
    ...(sound ? { audio: sound.codec!, audioChannels: sound.channels!, audioHz: sound.hz! } : {}),
    fps,
    durationMs: Math.round(videoSeconds * 1000),
    edits: moov.edits,
  };
}

function safe(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw refuse("bad_video");
  return Number(n);
}

function parseTrak(moov: Moov, trak: Box): Track {
  const track: Track = { handler: "" };
  const boxes = moov.children(trak, 2);
  // The handler decides how the rest reads, so it is found first, wherever mdia holds it.
  const mdia = boxes.find((b) => b.type === "mdia");
  if (!mdia || boxes.filter((b) => b.type === "mdia").length > 1) throw refuse("bad_video");
  const mdiaKids = moov.children(mdia, 3);
  const hdlr = mdiaKids.filter((b) => b.type === "hdlr");
  if (hdlr.length !== 1) throw refuse("bad_video");
  const h = moov.full(hdlr[0]!, 0);
  if (h.body.length < 20) throw refuse("bad_video");
  track.handler = h.body.subarray(4, 8).toString("latin1");
  if (!["vide", "soun", "tmcd"].includes(track.handler)) throw refuse("video_tracks");
  // pre_defined, where QuickTime names a component type, and the reserved twelve, where it names a maker.
  moov.zeroAt(h.at, 4);
  moov.zeroAt(h.at + 8, 12);
  // The handler's name is free text, so it is zeroed to an empty string.
  moov.edits.zero(h.at + 20, hdlr[0]!.end);

  const seen = new Set<string>();
  for (const box of boxes) {
    if (box.type === "tkhd") {
      once(seen, box.type);
      // Enabled, in the movie, in the preview and the size as an aspect ratio are the only flags.
      const { version, body, at } = moov.full(box, 1, { allowed: 0xf });
      if (body.length !== (version === 1 ? 92 : 80)) throw refuse("bad_video");
      const t = version === 1 ? 16 : 8;
      moov.edits.zero(at, at + t);
      moov.zeroAt(at + t + 4, 4); // reserved after track_ID
      track.tkhdDuration = version === 1 ? safe(body.readBigUInt64BE(t + 8)) : body.readUInt32BE(t + 8);
      const rest = version === 1 ? 32 : 20;
      moov.zeroAt(at + rest, 8);
      moov.zeroAt(at + rest + 14, 2);
      const matrix = body.subarray(rest + 16, rest + 52);
      track.identity = matrix.equals(IDENTITY_BYTES);
      const w = body.readUInt32BE(rest + 52);
      const hgt = body.readUInt32BE(rest + 56);
      track.tkhdWidth = w % 0x10000 === 0 ? w / 0x10000 : Number.NaN;
      track.tkhdHeight = hgt % 0x10000 === 0 ? hgt / 0x10000 : Number.NaN;
      if (track.handler !== "vide") {
        // A sound or timecode track shows nothing: its matrix is the identity and its size none, whatever the file said.
        moov.putAt(at + rest + 16, IDENTITY_BYTES);
        moov.putAt(at + rest + 52, Buffer.alloc(8));
      }
    } else if (box.type === "edts") {
      once(seen, box.type);
      const inEdts = new Set<string>();
      for (const e of moov.children(box, 3)) {
        if (e.type === "elst") {
          once(inEdts, e.type);
          track.edit = editList(moov, e);
        } else moov.drop(e);
      }
    } else if (box.type === "mdia") {
      parseMdia(moov, mdiaKids, track);
    } else {
      moov.drop(box); // tref, udta, meta, uuid and the rest
    }
  }
  if (!seen.has("tkhd")) throw refuse("bad_video");
  return track;
}

function editList(moov: Moov, box: Box): { segment: number; mediaTime: number } | null {
  const { version, body } = moov.full(box, 1);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  const each = version === 1 ? 20 : 12;
  if (body.length !== 4 + count * each) throw refuse("bad_video");
  if (count === 0) return null;
  // One edit that plays the media from its start or one positive offset, at normal speed: anything else is an edited timeline.
  if (count > 1) throw refuse("video_layout");
  const segment = version === 1 ? safe(body.readBigUInt64BE(4)) : body.readUInt32BE(4);
  const mediaTime = version === 1 ? Number(body.readBigInt64BE(12)) : body.readInt32BE(8);
  const rate = body.readUInt32BE(version === 1 ? 20 : 12);
  if (mediaTime < 0 || rate !== 0x10000 || !Number.isSafeInteger(mediaTime)) throw refuse("video_layout");
  return { segment, mediaTime };
}

/** The language a kept `mdhd` says: "und", packed, since a track's language is the place it was made as much as WebM's Language is. */
const UNDETERMINED = Buffer.from([0x55, 0xc4]);

function parseMdia(moov: Moov, kids: Box[], track: Track): void {
  const seen = new Set<string>();
  for (const box of kids) {
    if (box.type === "hdlr") continue;
    if (box.type === "mdhd") {
      once(seen, box.type);
      const { version, body, at } = moov.full(box, 1);
      if (body.length !== (version === 1 ? 32 : 20)) throw refuse("bad_video");
      const t = version === 1 ? 16 : 8;
      moov.edits.zero(at, at + t);
      track.timescale = body.readUInt32BE(t);
      if (track.timescale <= 0) throw refuse("bad_video");
      track.mdhdDuration = version === 1 ? safe(body.readBigUInt64BE(t + 4)) : body.readUInt32BE(t + 4);
      moov.putAt(at + body.length - 4, UNDETERMINED);
      moov.zeroAt(at + body.length - 2, 2);
    } else if (box.type === "minf") {
      once(seen, box.type);
      parseMinf(moov, box, track);
    } else {
      moov.drop(box); // elng, udta and the rest
    }
  }
  if (!seen.has("mdhd")) throw refuse("bad_video");
}

function parseMinf(moov: Moov, minf: Box, track: Track): void {
  const seen = new Set<string>();
  for (const box of moov.children(minf, 4)) {
    if (box.type === "vmhd" && track.handler === "vide") {
      once(seen, box.type);
      const { body, at } = moov.full(box, 0, { allowed: 1 });
      if (body.length !== 8) throw refuse("bad_video");
      moov.zeroAt(at, 8); // graphicsmode and opcolor, both 0 in a plain file
    } else if (box.type === "smhd" && track.handler === "soun") {
      once(seen, box.type);
      const { body, at } = moov.full(box, 0);
      if (body.length !== 4) throw refuse("bad_video");
      moov.zeroAt(at, 4); // balance, centred, and a reserved two
    } else if (box.type === "dinf") {
      once(seen, box.type);
      const inDinf = new Set<string>();
      for (const d of moov.children(box, 5)) {
        if (d.type === "dref") {
          once(inDinf, d.type);
          track.drefCount = dataReferences(moov, d);
        } else moov.drop(d);
      }
    } else if (box.type === "stbl") {
      once(seen, box.type);
      parseStbl(moov, box, track);
    } else {
      moov.drop(box); // gmhd, nmhd, a data handler's hdlr and the rest
    }
  }
  if (!seen.has("stbl")) throw refuse("bad_video");
}

/** Every data reference must be the file itself: a `url ` with the self-contained flag and no location. */
function dataReferences(moov: Moov, dref: Box): number {
  const { body } = moov.full(dref, 0);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  const entries = moov.children(dref, 6, dref.payload + 8);
  if (count < 1 || entries.length !== count) throw refuse("bad_video");
  for (const e of entries) {
    if (e.type !== "url ") throw refuse("bad_video");
    const { body: rest } = moov.full(e, 0, { allowed: 1, required: 1 });
    if (rest.some((b) => b !== 0)) throw refuse("bad_video");
  }
  return count;
}

/** The sample tables read once each, and the optional ones checked once the sample count is known. */
const STBL_ONCE = new Set(["stsd", "stts", "ctts", "stsc", "stsz", "stz2", "stco", "co64", "stss", "sdtp", "cslg"]);

function parseStbl(moov: Moov, stbl: Box, track: Track): void {
  const seen = new Set<string>();
  const later: Box[] = [];
  for (const box of moov.children(stbl, 5)) {
    if (STBL_ONCE.has(box.type)) once(seen, box.type);
    if (box.type === "stsd") sampleDescription(moov, box, track);
    else if (box.type === "stts") track.stts = pairs(moov, box, 0);
    else if (box.type === "ctts") track.ctts = pairs(moov, box, 1);
    else if (box.type === "stsc") track.stsc = chunkRuns(moov, box);
    else if (box.type === "stsz" || box.type === "stz2") track.sizes = sampleSizes(moov, box);
    else if (box.type === "stco" || box.type === "co64") track.chunks = chunkOffsets(moov, box);
    else if (box.type === "stss" || box.type === "sdtp" || box.type === "sbgp" || box.type === "sgpd" || box.type === "cslg") later.push(box);
    else moov.drop(box); // subs, saiz, saio, senc and the rest
  }
  if ((seen.has("stsz") && seen.has("stz2")) || (seen.has("stco") && seen.has("co64"))) throw refuse("bad_video");
  if (!track.sampleEntry || !track.stts || !track.stsc || !track.sizes || !track.chunks) throw refuse("bad_video");
  optionalTables(moov, later, track, track.sizes.length);
}

/**
 * `stss`, `sdtp`, `sbgp`, `sgpd` and `cslg`, each read whole against the
 * track's sample count (AMBUILD-SOL-003). A sample group of a type off
 * SAMPLE_GROUPS is dropped with its mapping.
 */
function optionalTables(moov: Moov, boxes: readonly Box[], track: Track, samples: number): void {
  const descriptions = new Map<string, { box: Box; entries: number }>();
  const mappings = new Map<string, Box>();
  for (const box of boxes) {
    if (box.type === "stss") syncSamples(moov, box, samples);
    else if (box.type === "sdtp") dependencies(moov, box, samples);
    else if (box.type === "cslg") track.cslg = compositionShift(moov, box);
    else {
      const type = moov.payload(box).subarray(4, 8).toString("latin1");
      const held = box.type === "sgpd" ? descriptions : mappings;
      if (held.has(type)) throw refuse("bad_video");
      if (box.type === "sgpd") descriptions.set(type, { box, entries: 0 });
      else mappings.set(type, box);
    }
  }
  for (const [type, d] of descriptions) {
    if (SAMPLE_GROUPS[type]) d.entries = groupDescriptions(moov, d.box, SAMPLE_GROUPS[type]);
    else moov.renameFree(d.box);
  }
  for (const [type, box] of mappings) {
    const d = descriptions.get(type);
    if (!SAMPLE_GROUPS[type] || !d) {
      moov.renameFree(box);
      continue;
    }
    groupMapping(moov, box, samples, d.entries);
  }
}

/** `stss`: sample numbers, rising, each a sample the track has. */
function syncSamples(moov: Moov, box: Box, samples: number): void {
  const { body } = moov.full(box, 0);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  if (body.length !== 4 + count * 4) throw refuse("bad_video");
  let previous = 0;
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) moov.budget.check();
    const n = body.readUInt32BE(4 + i * 4);
    if (n <= previous || n > samples) throw refuse("bad_video");
    previous = n;
  }
}

/** `sdtp`: a byte a sample, none of its three two-bit fields after the first holding the reserved 3. */
function dependencies(moov: Moov, box: Box, samples: number): void {
  const { body } = moov.full(box, 0);
  if (body.length !== samples) throw refuse("bad_video");
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if ((b & 0x30) === 0x30 || (b & 0x0c) === 0x0c || (b & 0x03) === 0x03) throw refuse("bad_video");
  }
}

function compositionShift(moov: Moov, box: Box): NonNullable<Track["cslg"]> {
  const { version, body } = moov.full(box, 1);
  const each = version === 1 ? 8 : 4;
  if (body.length !== each * 5) throw refuse("bad_video");
  const read = (i: number) => (version === 1 ? Number(body.readBigInt64BE(i * 8)) : body.readInt32BE(i * 4));
  const [shift, least, greatest, start, end] = [0, 1, 2, 3, 4].map(read) as [number, number, number, number, number];
  if (![shift, least, greatest, start, end].every(Number.isSafeInteger) || least > greatest || start > end) throw refuse("bad_video");
  return { shift, least, greatest, start, end };
}

/** `sgpd` of a known type: every record that type's length and layout. Answers how many it holds. */
function groupDescriptions(moov: Moov, box: Box, kind: (typeof SAMPLE_GROUPS)[string]): number {
  const { version, body } = moov.full(box, 2);
  let at = 4;
  const u32 = () => {
    if (at + 4 > body.length) throw refuse("bad_video");
    const v = body.readUInt32BE(at);
    at += 4;
    return v;
  };
  const defaultLength = version === 1 ? u32() : kind.bytes;
  const defaultIndex = version === 2 ? u32() : 0;
  const count = u32();
  if (defaultLength !== 0 && defaultLength !== kind.bytes) throw refuse("bad_video");
  if (defaultIndex > count) throw refuse("bad_video");
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) moov.budget.check();
    const length = version === 1 && defaultLength === 0 ? u32() : kind.bytes;
    if (length !== kind.bytes || at + length > body.length) throw refuse("bad_video");
    if (!kind.check(body.subarray(at, at + length))) throw refuse("bad_video");
    at += length;
  }
  if (at !== body.length) throw refuse("bad_video");
  return count;
}

/** `sbgp`: runs of samples, no more than the track has, each naming a description its `sgpd` holds or none. */
function groupMapping(moov: Moov, box: Box, samples: number, descriptions: number): void {
  const { version, body } = moov.full(box, 1);
  const head = version === 1 ? 12 : 8;
  if (body.length < head) throw refuse("bad_video");
  // A known type takes no parameter.
  if (version === 1 && body.readUInt32BE(4) !== 0) throw refuse("bad_video");
  const count = body.readUInt32BE(head - 4);
  if (body.length !== head + count * 8) throw refuse("bad_video");
  let mapped = 0;
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) moov.budget.check();
    mapped += body.readUInt32BE(head + i * 8);
    if (mapped > samples || body.readUInt32BE(head + i * 8 + 4) > descriptions) throw refuse("bad_video");
  }
}

/** stts or ctts: (count, value) runs. ctts version 1 takes signed offsets. */
function pairs(moov: Moov, box: Box, signedVersion: number): Array<[number, number]> {
  const { version, body } = moov.full(box, signedVersion);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  if (body.length !== 4 + count * 8) throw refuse("bad_video");
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) moov.budget.check();
    out.push([body.readUInt32BE(4 + i * 8), version === 1 ? body.readInt32BE(8 + i * 8) : body.readUInt32BE(8 + i * 8)]);
  }
  return out;
}

function chunkRuns(moov: Moov, box: Box): Array<[number, number]> {
  const { body } = moov.full(box, 0);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  if (body.length !== 4 + count * 12) throw refuse("bad_video");
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) moov.budget.check();
    const firstChunk = body.readUInt32BE(4 + i * 12);
    const perChunk = body.readUInt32BE(8 + i * 12);
    const description = body.readUInt32BE(12 + i * 12);
    const previous = out[out.length - 1];
    if (firstChunk < 1 || perChunk < 1 || description !== 1 || (previous && firstChunk <= previous[0])) throw refuse("bad_video");
    out.push([firstChunk, perChunk]);
  }
  return out;
}

function sampleSizes(moov: Moov, box: Box): number[] {
  const { body } = moov.full(box, 0);
  if (body.length < 8) throw refuse("bad_video");
  // No track here may hold more samples than the sound's cap, the larger of the two.
  const cap = VIDEO_LIMITS.parseSoundFrameHeaders;
  if (box.type === "stsz") {
    const fixed = body.readUInt32BE(0);
    const count = body.readUInt32BE(4);
    if (count > cap) throw refuse("bad_video");
    if (fixed !== 0) {
      if (body.length !== 8) throw refuse("bad_video");
      return new Array<number>(count).fill(fixed);
    }
    if (body.length !== 8 + count * 4) throw refuse("bad_video");
    return Array.from({ length: count }, (_, i) => body.readUInt32BE(8 + i * 4));
  }
  const field = body[3]!;
  const count = body.readUInt32BE(4);
  if (count > cap || ![4, 8, 16].includes(field) || body.readUIntBE(0, 3) !== 0) throw refuse("bad_video");
  if (body.length !== 8 + Math.ceil((count * field) / 8)) throw refuse("bad_video");
  const bits = new Bits(body.subarray(8));
  const sizes = Array.from({ length: count }, () => bits.read(field));
  // An odd count of 4-bit sizes leaves half a byte, which must be zero.
  if (!bits.restIsZero()) throw refuse("bad_video");
  return sizes;
}

function chunkOffsets(moov: Moov, box: Box): number[] {
  const { body } = moov.full(box, 0);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  const each = box.type === "co64" ? 8 : 4;
  if (count > VIDEO_LIMITS.parseSoundFrameHeaders || body.length !== 4 + count * each) throw refuse("bad_video");
  return Array.from({ length: count }, (_, i) => (each === 8 ? safe(body.readBigUInt64BE(4 + i * 8)) : body.readUInt32BE(4 + i * 4)));
}

/**
 * Every sample's bytes, from the chunk tables, must lie inside an `mdat`:
 * the only place the check never writes. The top-level walk finds the
 * `mdat` payloads in file order, so they are sorted and disjoint, and each
 * sample's is found by halving rather than by trying every one: a file
 * may hold some 200,000 empty `mdat` boxes (AM-R1-01).
 */
function samplesInsideMdat(moov: Moov, track: Track, mdats: readonly Range[]): void {
  const sizes = track.sizes!;
  const chunks = track.chunks!;
  const runs = track.stsc!;
  if (runs.length === 0 || runs[0]![0] !== 1) throw refuse("bad_video");
  if (runs[runs.length - 1]![0] > chunks.length) throw refuse("bad_video");
  let sample = 0;
  let run = 0;
  for (let chunk = 1; chunk <= chunks.length; chunk++) {
    if ((chunk & 1023) === 0) moov.budget.check();
    while (run + 1 < runs.length && runs[run + 1]![0] <= chunk) run++;
    const perChunk = runs[run]![1];
    let at = chunks[chunk - 1]!;
    for (let i = 0; i < perChunk; i++) {
      if ((sample & 1023) === 0) moov.budget.check();
      const size = sizes[sample];
      if (size === undefined) throw refuse("bad_video");
      const end = at + size;
      if (!insideMdat(mdats, at, end)) throw refuse("bad_video");
      at = end;
      sample++;
    }
  }
  if (sample !== sizes.length) throw refuse("bad_video");
}

/**
 * Whether `[at, end)` lies inside one of the sorted, disjoint `mdats`. Only
 * the last one starting at or before `at` can hold it: any earlier one
 * ends at least a box header before that one starts.
 */
export function insideMdat(mdats: readonly Range[], at: number, end: number): boolean {
  let lo = 0;
  let hi = mdats.length - 1;
  let found: Range | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (mdats[mid]!.start <= at) {
      found = mdats[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found !== undefined && end <= found.end;
}

/**
 * A track's sample times and presentation length. The length is the edit's
 * segment where an edit list plays the media, else the media's own, and
 * `remaining` is what the media holds from the edit's start, which the
 * caller checks the segment covers (AM-ASTRA-08).
 */
function timing(moov: Moov, track: Track, movieTimescale: number, cap: number, code: "video_fps" | "bad_video"): { times: number[]; seconds: number; remaining: number | null } {
  const tally = new Tally(cap, code);
  const times: number[] = [];
  let dts = 0;
  for (const [count, delta] of track.stts!) {
    tally.add(count);
    for (let i = 0; i < count; i++) {
      if ((times.length & 1023) === 0) moov.budget.check();
      times.push(dts);
      dts += delta;
    }
  }
  if (!Number.isSafeInteger(dts) || times.length !== track.sizes!.length) throw refuse("bad_video");
  if (track.ctts) {
    let i = 0;
    for (const [count, offset] of track.ctts) {
      for (let k = 0; k < count; k++) {
        if (i >= times.length) throw refuse("bad_video");
        times[i] = times[i]! + offset;
        i++;
      }
    }
    if (i !== times.length) throw refuse("bad_video");
  }
  const scale = track.timescale!;
  const media = dts / scale;
  const edit = track.edit;
  if (!edit) return { times, seconds: media, remaining: null };
  return { times, seconds: edit.segment / movieTimescale, remaining: (dts - edit.mediaTime) / scale };
}

function sampleDescription(moov: Moov, stsd: Box, track: Track): void {
  const { body } = moov.full(stsd, 0);
  if (body.length < 4 || body.readUInt32BE(0) !== 1) throw refuse("bad_video");
  const entries = moov.children(stsd, 6, stsd.payload + 8);
  if (entries.length !== 1) throw refuse("bad_video");
  const entry = entries[0]!;
  track.sampleEntry = entry.type;
  const p = moov.payload(entry);
  if (p.length < 8) throw refuse("bad_video");
  // Every sample entry starts with six reserved bytes.
  moov.zeroAt(entry.payload, 6);
  track.dataRef = p.readUInt16BE(6);
  if (track.handler === "vide") visualEntry(moov, entry, track);
  else if (track.handler === "soun") audioEntry(moov, entry, track);
  else timecodeEntry(moov, entry);
}

function visualEntry(moov: Moov, entry: Box, track: Track): void {
  if (!["avc1", "avc3", "av01"].includes(entry.type)) throw refuse("video_codec");
  const p = moov.payload(entry);
  if (p.length < 78) throw refuse("bad_video");
  // The predefined and reserved sixteen, where QuickTime puts a version, a vendor and qualities, and the reserved four after the resolutions.
  moov.zeroAt(entry.payload + 8, 16);
  moov.zeroAt(entry.payload + 36, 4);
  track.width = p.readUInt16BE(24);
  track.height = p.readUInt16BE(26);
  // The compressor name is a free-text Pascal string, so it is zeroed to an empty one.
  moov.edits.zero(entry.payload + 42, entry.payload + 74);
  let sawConfig = false;
  const seen = new Set<string>();
  for (const box of moov.children(entry, 7, entry.payload + 78)) {
    if ((box.type === "avcC" && entry.type !== "av01") || (box.type === "av1C" && entry.type === "av01")) {
      if (sawConfig) throw refuse("bad_video");
      sawConfig = true;
      track.codec = box.type === "avcC" ? avcCodecString(entry.type, moov.payload(box)) : av1CodecString(moov.payload(box));
    } else if (box.type === "pasp") {
      once(seen, box.type);
      const b = moov.payload(box);
      if (b.length !== 8) throw refuse("bad_video");
      if (b.readUInt32BE(0) !== b.readUInt32BE(4)) throw refuse("video_geometry");
      // Square pixels as N:N say 1:1, which is all a square ratio needs to say.
      moov.putAt(box.payload, Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]));
    } else if (box.type === "clap") {
      throw refuse("video_geometry");
    } else if (box.type === "colr") {
      const b = moov.payload(box);
      // One of each colour type, as the format allows an nclx beside an ICC profile.
      once(seen, `colr ${b.subarray(0, 4).toString("latin1")}`);
      if (b.length >= 4 && b.subarray(0, 4).toString("latin1") === "nclx") {
        if (b.length !== 11) throw refuse("bad_video");
        // Primaries, transfer and matrix are 8-bit code points in 16-bit fields, then the full-range bit and seven reserved.
        if (b[4] !== 0 || b[6] !== 0 || b[8] !== 0 || (b[10]! & 0x7f) !== 0) throw refuse("bad_video");
        const transfer = b.readUInt16BE(6);
        if (transfer === 16 || transfer === 18) throw refuse("video_hdr");
      } else {
        // An ICC profile (prof, rICC) can hold text tags, so only nclx is kept (AMR-4).
        moov.renameFree(box);
      }
    } else {
      // btrt goes too: three free numbers no player needs to play the file.
      moov.drop(box); // fiel, clli, mdcv, btrt, the spherical boxes and the rest
    }
  }
  if (!sawConfig) throw refuse("bad_video");
}

/** NAL unit types an avcC's parameter sets may be: a sequence, a picture and a sequence extension set. */
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_SPS_EXT = 13;

/**
 * `avcC` (ISO 14496-15 5.3.3.1), read with its High-profile extension
 * optional, since some muxers omit it. Bytes after the record that are all
 * zero are kept, still zero, and only others are refused (AMS-3). Each
 * parameter set must be a NAL unit of its own kind, so no other unit rides
 * along outside the media data.
 */
export function avcCodecString(entryType: string, b: Buffer): string {
  if (b.length < 7 || b[0] !== 1) throw refuse("bad_video");
  const profile = b[1]!;
  let at = 5;
  const sets = (count: number, type: number) => {
    for (let i = 0; i < count; i++) {
      if (at + 2 > b.length) throw refuse("bad_video");
      const n = b.readUInt16BE(at);
      const nal = b[at + 2];
      if (n < 1 || nal === undefined || (nal & 0x80) !== 0 || (nal & 0x1f) !== type) throw refuse("bad_video");
      at += 2 + n;
      if (at > b.length) throw refuse("bad_video");
    }
  };
  sets(b[at++]! & 0x1f, NAL_SPS);
  if (at >= b.length) throw refuse("bad_video");
  sets(b[at++]!, NAL_PPS);
  const zeroFrom = (from: number) => b.subarray(from).every((x) => x === 0);
  if (at < b.length && !zeroFrom(at)) {
    if (![100, 110, 122, 144].includes(profile) || at + 4 > b.length) throw refuse("bad_video");
    at += 3;
    sets(b[at++]!, NAL_SPS_EXT);
    if (at < b.length && !zeroFrom(at)) throw refuse("bad_video");
  }
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return `${entryType}.${hex(profile)}${hex(b[2]!)}${hex(b[3]!)}`;
}

function audioEntry(moov: Moov, entry: Box, track: Track): void {
  if (!["mp4a", "Opus"].includes(entry.type)) throw refuse("video_codec");
  const p = moov.payload(entry);
  if (p.length < 28) throw refuse("bad_video");
  // Version 0, as ISO writes it: QuickTime's later versions put the codec record in other places.
  if (p.readUInt16BE(8) !== 0) throw refuse("video_sound");
  // The reserved eight, where QuickTime keeps a version, a revision and a vendor, and the predefined and reserved four after the sample size.
  moov.zeroAt(entry.payload + 8, 8);
  moov.zeroAt(entry.payload + 20, 4);
  let sawConfig = false;
  for (const box of moov.children(entry, 7, entry.payload + 28)) {
    if ((box.type === "esds" && entry.type === "mp4a") || (box.type === "dOps" && entry.type === "Opus")) {
      if (sawConfig) throw refuse("bad_video");
      sawConfig = true;
      if (box.type === "esds") {
        const aac = elementaryStream(moov.payload(box));
        track.codec = `mp4a.40.${aac.objectType}`;
        track.channels = aac.channels;
        track.hz = aac.hz;
      } else {
        track.codec = "opus";
        track.channels = opusHead(moov.payload(box), "mp4").channels;
        track.hz = OPUS_HZ;
      }
    } else {
      moov.drop(box); // chan, wave, btrt and the rest
    }
  }
  if (!sawConfig) throw refuse("video_sound");
}

/** The timecode's sample entry keeps only its fixed fields, its reserved ones zeroed: its `name` box and anything else go. */
function timecodeEntry(moov: Moov, entry: Box): void {
  if (entry.type !== "tmcd") throw refuse("video_tracks");
  if (moov.payload(entry).length < 26) throw refuse("bad_video");
  moov.zeroAt(entry.payload + 8, 4);
  moov.zeroAt(entry.payload + 25, 1);
  for (const box of moov.children(entry, 7, entry.payload + 26)) moov.drop(box);
}

/**
 * `esds`, accepted only in a bounded subset (AM-ASTRA-21, AMR-4, AMQ-3,
 * AM-ASTRA-27): one ES_Descriptor with no URL, dependence or OCR stream,
 * one DecoderConfigDescriptor for MPEG-4 audio holding one
 * DecoderSpecificInfo, then a predefined SLConfigDescriptor, every length
 * exact. Anything else could carry a URL or a comment, so it is refused
 * rather than read.
 */
export function elementaryStream(payload: Buffer): { objectType: number; channels: number; hz: number } {
  if (payload.length < 4 || payload.readUInt32BE(0) !== 0) throw refuse("video_sound");
  let at = 4;
  const byte = () => {
    const b = payload[at++];
    if (b === undefined) throw refuse("video_sound");
    return b;
  };
  const descriptor = (tag: number): number => {
    if (byte() !== tag) throw refuse("video_sound");
    let size = 0;
    for (let i = 0; i < 4; i++) {
      const b = byte();
      size = size * 128 + (b & 0x7f);
      if (!(b & 0x80)) return at + size;
    }
    throw refuse("video_sound");
  };
  const esEnd = descriptor(0x03);
  if (esEnd !== payload.length) throw refuse("video_sound");
  at += 2; // ES_ID
  if (byte() & 0xe0) throw refuse("video_sound"); // streamDependenceFlag, URL_Flag, OCRstreamFlag
  const configEnd = descriptor(0x04);
  if (byte() !== 0x40) throw refuse("video_sound"); // MPEG-4 audio, not MPEG-2 AAC (0x66 to 0x68) or anything else
  const stream = byte();
  if (stream >> 2 !== 0x05 || stream & 0x02) throw refuse("video_sound");
  at += 11; // bufferSizeDB, maxBitrate, avgBitrate
  const infoEnd = descriptor(0x05);
  if (infoEnd !== configEnd || infoEnd > payload.length) throw refuse("video_sound");
  const config = audioSpecificConfig(payload.subarray(at, infoEnd));
  at = infoEnd;
  const slEnd = descriptor(0x06);
  if (slEnd !== at + 1) throw refuse("video_sound");
  const predefined = byte();
  if (predefined !== 1 && predefined !== 2) throw refuse("video_sound");
  if (at !== esEnd) throw refuse("video_sound");
  return config;
}

/**
 * An AudioSpecificConfig of AAC-LC, or SBR or PS over AAC-LC, with
 * channels 1 to 7 (0 would bring a program configuration element and its
 * comment), no core coder and no extension. The one sync extension let
 * through is FFmpeg's SBR-absent one, followed only by zero bits to the
 * byte's end (AM-ASTRA-27). The record must end there.
 */
export function audioSpecificConfig(record: Buffer): { objectType: number; channels: number; hz: number } {
  const bits = new Bits(record);
  const objectType = () => {
    const t = bits.read(5);
    return t === 31 ? 32 + bits.read(6) : t;
  };
  // A rate outside the table (index 15 and its 24 bits) is refused, since no AAC encoder for video writes one and its range runs past what a stored video may say (AM-R1-05).
  const rate = () => {
    const hz = AAC_RATES[bits.read(4)];
    if (hz === undefined) throw refuse("video_sound");
    return hz;
  };
  const first = objectType();
  let hz = rate();
  const channelConfiguration = bits.read(4);
  let inner = first;
  const explicitSbr = first === 5 || first === 29;
  if (explicitSbr) {
    hz = rate();
    inner = objectType();
  }
  if (inner !== 2 || ![2, 5, 29].includes(first)) throw refuse("video_sound");
  if (channelConfiguration < 1 || channelConfiguration > 7) throw refuse("video_sound");
  bits.read(1); // frameLengthFlag
  if (bits.read(1) !== 0) throw refuse("video_sound"); // dependsOnCoreCoder
  if (bits.read(1) !== 0) throw refuse("video_sound"); // extensionFlag
  if (!explicitSbr && bits.left >= 16) {
    if (bits.read(11) !== 0x2b7 || objectType() !== 5 || bits.read(1) !== 0) throw refuse("video_sound");
  }
  if (bits.left >= 8 || !bits.restIsZero()) throw refuse("video_sound");
  const channels = first === 29 ? 2 : channelConfiguration === 7 ? 8 : channelConfiguration;
  return { objectType: first, channels, hz };
}
