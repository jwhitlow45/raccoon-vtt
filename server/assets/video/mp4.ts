import { VIDEO_LIMITS } from "#shared/limits.ts";
import type { VideoGeometry } from "#shared/videoGeometry.ts";
import { mp4DrawnWidth, mp4Orientation, orientationFacts } from "#shared/videoGeometry.ts";
import type { ParsedVideo } from "./check.ts";
import { Bits, OPUS_HZ, TIMELINE_SLACK_MS, av1CodecString, opusHead, peakInOneSecond, timelineToleranceMs } from "./records.ts";
import { Edits, Tally, joined, refuse, type Budget, type Range, type Source } from "./window.ts";

/**
 * The MP4 header check (docs/design/design-v1-animated-maps.md 10, mp4.ts).
 *
 * The top-level boxes are read through the window, and `moov`, at most
 * 8 MiB, is read whole and walked in memory. Boxes on the allowlist are
 * kept, their times and names zeroed. Every other box is renamed `free`
 * with an all-zero payload, the same length, so no byte moves and every
 * chunk offset stays right. `free`, `skip` and `wide` already in the file
 * are zeroed too (AM-ASTRA-01). No header edit lands inside `mdat`, and
 * every sample the tables name must lie inside an `mdat`, so no edit can
 * land on an offset a kept track's tables give (D-261102-514).
 *
 * A kept box is read to its last byte (AMBUILD-SOL-003): each FullBox's
 * version and flags are checked, each field is a number in its range, a
 * field the format reserves or fixes is zeroed, and a box the format
 * allows once in its parent is refused the second time, so no copy the
 * check did not read is kept.
 *
 * Turned and stretched pictures (docs/design/design-v1-video-turns.md 4.1
 * and 5): the video `tkhd`'s matrix may be one of the eight square turns
 * and its pixels non-square up to 2:1, by exact values only. The header is
 * rewritten plain in place, the identity at the coded size with a 1:1
 * `pasp`, and the facts carry the turn, the mirror and the stretched width
 * for the app to draw. A QuickTime MOV (major brand `qt  `) reads the same
 * way, with the few QuickTime boxes an iPhone writes kept, renamed or
 * refused as 4.5 lists, and only under that brand, so an ISO file's output
 * is what it always was. Timed metadata tracks, such as an iPhone's
 * detected faces, are dropped in both brands and their samples zeroed
 * under the scrub's guard (D-261102-893).
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
 * QuickTime's brand. As the major brand it names a MOV, whose sound and
 * colour boxes FFmpeg and CoreMedia read by the brand (D-261102-894). As a
 * compatible brand it is kept only in a MOV: FFmpeg also reads QuickTime's
 * sound fields when an ISO file lists it, so in one it is zeroed, as it
 * always was.
 */
const QUICKTIME_BRAND = "qt  ";

/** HEVC and Dolby Vision over HEVC, an iPhone's default, which most browsers cannot play (4.5, D-261102-892). */
const HEVC_ENTRIES = new Set(["hvc1", "hev1", "dvh1", "dvhe"]);

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
  /** `tkhd`'s size in raw 16.16, its flags and its matrix as read, with where the matrix and the size lie, for the video's rewrite. */
  tkhd?: { width: number; height: number; flags: number; matrix: number[]; matrixAt: number; sizeAt: number };
  /** The sample entry's `pasp` as read, h:v. */
  pasp?: { h: number; v: number };
  /** A real `clap` crop or an uneven `tapt`: `video_geometry`, once the codec has been judged (4.1, 4.5). */
  reshaped?: boolean;
  /** A MOV's `tapt` sizes in raw 16.16, clean, production and encoded, checked against `tkhd`'s once both are read. Null for one that is not those three. */
  aperture?: Array<[number, number]> | null;
  /** A dropped timed metadata track's `trak`, renamed `free` once its samples are known to be safe to zero (4.5). */
  dropped?: Box;
  /** A dropped track's presentation in the movie's timescale, from its edits, when it has any. */
  presentation?: number;
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
  /** Whether the major brand is `qt  `, which alone lets QuickTime's own boxes through (4.5, D-261102-894). */
  readonly quickTime: boolean;

  constructor(m: Buffer, base: number, edits: Edits, headers: Tally, budget: Budget, quickTime: boolean) {
    this.m = m;
    this.base = base;
    this.edits = edits;
    this.headers = headers;
    this.budget = budget;
    this.quickTime = quickTime;
  }

  /**
   * The same `moov` read with edits that are thrown away, for a track that
   * goes whole: the shared readers zero what they read, and a write inside
   * a box renamed `free` would leave bytes in its zeroed payload.
   */
  discarding(): Moov {
    return new Moov(this.m, this.base, new Edits(), this.headers, this.budget, this.quickTime);
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
 * Answers whether the file is a MOV.
 */
async function fileType(src: Source, box: Box, edits: Edits): Promise<boolean> {
  const length = box.end - box.payload;
  if (length < 8 || length > VIDEO_LIMITS.parseValueBytes || (length - 8) % 4 !== 0) throw refuse("bad_video");
  const p = await src.read(box.payload, length);
  if (!isFourCc(p.subarray(0, 4))) throw refuse("bad_video");
  const quickTime = p.subarray(0, 4).toString("latin1") === QUICKTIME_BRAND;
  edits.zero(box.payload + 4, box.payload + 8);
  for (let at = 8; at < length; at += 4) {
    const brand = p.subarray(at, at + 4).toString("latin1");
    if (!KNOWN_BRANDS.has(brand) && !(quickTime && brand === QUICKTIME_BRAND)) edits.zero(box.payload + at, box.payload + at + 4);
  }
  return quickTime;
}

export async function parseMp4(src: Source, budget: Budget): Promise<ParsedVideo> {
  const edits = new Edits();
  const headers = new Tally(VIDEO_LIMITS.parseElementHeaders);
  const mdats: Range[] = [];
  let moovBox: Box | undefined;
  let at = 0;
  let first = true;
  let quickTime = false;
  const windowRead = async (offset: number, length: number) => Buffer.from(await src.read(offset, length));
  while (at < src.size) {
    budget.check();
    headers.add();
    if (src.size - at < 8) throw refuse("bad_video");
    const head = await windowRead(at, Math.min(32, src.size - at));
    const box = boxHeader((o, n) => head.subarray(o - at, o - at + n), at, src.size, true);
    if (first) {
      if (box.type !== "ftyp") throw refuse("video_type");
      quickTime = await fileType(src, box, edits);
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
  const moov = new Moov(Buffer.from(m), moovBox.start, edits, headers, budget, quickTime);
  return parseMoov(moov, moovBox, mdats);
}

function words(values: readonly number[]): Buffer {
  return Buffer.concat(values.map((v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v);
    return b;
  }));
}

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const IDENTITY_BYTES = words(IDENTITY);
const PASP_SQUARE = words([1, 1]);

/** The most timed metadata tracks a file may drop, the samples all of them may hold, and the edits each may have (4.5, D-261102-893). */
const MAX_METADATA_TRACKS = 8;
const MAX_METADATA_SAMPLES = 60_000;
const MAX_METADATA_EDITS = 4;

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

  const metadata = tracks.filter((t) => t.handler === "meta");
  const kept = tracks.filter((t) => t.handler !== "meta");
  const videos = kept.filter((t) => t.handler === "vide");
  const sounds = kept.filter((t) => t.handler === "soun");
  const timecodes = kept.filter((t) => t.handler === "tmcd");
  if (metadata.length > MAX_METADATA_TRACKS) throw refuse("video_tracks");
  if (videos.length !== 1 || sounds.length > 1 || timecodes.length > 1 || videos.length + sounds.length + timecodes.length !== kept.length) throw refuse("video_tracks");
  const video = videos[0]!;
  const sound = sounds[0];
  const keptChunks: Range[] = [];
  for (const track of kept) {
    if (track.dataRef === undefined || track.drefCount === undefined || track.dataRef < 1 || track.dataRef > track.drefCount) throw refuse("bad_video");
    for (const chunk of chunkRanges(moov, track)) {
      if (!insideMdat(mdats, chunk.start, chunk.end)) throw refuse("bad_video");
      moov.edits.keep(chunk.start, chunk.end);
      keptChunks.push(chunk);
    }
  }
  dropMetadata(moov, metadata, mdats, keptChunks);

  const geometry = plainVideoHeader(moov, video);
  for (const track of kept) if (track.aperture !== undefined && !evenAperture(track)) throw refuse("video_geometry");

  const v = timing(moov, video, movieTimescale, VIDEO_LIMITS.parseVideoFrameHeaders, "video_fps");
  const frames = v.times.length;
  if (frames === 0) throw refuse("bad_video");
  const videoSeconds = v.seconds;
  const tolerance = timelineToleranceMs(v.frame * 1000) / 1000;
  presents(v, tolerance);
  trackDurations(video, v, movieTimescale, tolerance);
  let longest = videoSeconds;
  if (sound) {
    const s = timing(moov, sound, movieTimescale, VIDEO_LIMITS.parseSoundFrameHeaders, "bad_video");
    presents(s, tolerance);
    trackDurations(sound, s, movieTimescale, tolerance);
    if (s.seconds > videoSeconds + tolerance) throw refuse("video_layout");
    longest = Math.max(longest, s.seconds);
  }
  for (const t of timecodes) timing(moov, t, movieTimescale, 1_000, "bad_video");
  // A dropped track still ends by the picture's end, so the movie's own length, which counts it, says no more than the kept tracks do.
  for (const t of metadata) {
    const ends = t.presentation !== undefined ? t.presentation / movieTimescale : t.mdhdDuration! / t.timescale!;
    if (ends > videoSeconds + tolerance) throw refuse("video_layout");
  }
  if (Math.abs(movieDuration / movieTimescale - longest) > tolerance) throw refuse("video_layout");

  const fps = peakInOneSecond(v.times, video.timescale!);
  return {
    container: "mp4",
    widthPx: video.width!,
    heightPx: video.height!,
    ...geometry,
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

/**
 * 4.1's rules on the video `tkhd` and `pasp`, then the rewrite to plain:
 * the identity matrix at the coded size, the `pasp` already said 1:1 as it
 * was read. Answers the geometry the facts carry, so the app draws what the
 * file showed. Anything outside the rules, or a real crop, is
 * `video_geometry`, never clamped.
 */
function plainVideoHeader(moov: Moov, video: Track): VideoGeometry {
  const tkhd = video.tkhd!;
  const orientation = mp4Orientation(tkhd.matrix, tkhd.width, tkhd.height);
  const drawnWidth = mp4DrawnWidth({
    codedWidthPx: video.width!,
    codedHeightPx: video.height!,
    tkhdWidth: tkhd.width,
    tkhdHeight: tkhd.height,
    pasp: video.pasp,
    sizeIsAspectRatio: (tkhd.flags & 0x8) !== 0,
  });
  if (!orientation || drawnWidth === undefined || video.reshaped) throw refuse("video_geometry");
  moov.putAt(tkhd.matrixAt, IDENTITY_BYTES);
  moov.putAt(tkhd.sizeAt, words([video.width! * 0x10000, video.height! * 0x10000]));
  return { ...orientationFacts(orientation), ...(drawnWidth !== video.width ? { displayWidthPx: drawnWidth } : {}) };
}

/** A MOV's `tapt` says nothing new when each of its three sizes is `tkhd`'s, either way round (4.5: unconfirmed which way an iPhone writes it). */
function evenAperture(track: Track): boolean {
  const t = track.tkhd!;
  return track.aperture != null && track.aperture.every(([w, h]) => (w === t.width && h === t.height) || (w === t.height && h === t.width));
}

const APERTURE_SIZES = new Set(["clef", "prof", "enof"]);

/** A MOV's `tapt`: its clean, production and encoded sizes in raw 16.16, each once. Anything else in it answers null, which is uneven. */
function aperture(moov: Moov, box: Box): Array<[number, number]> | null {
  const sizes = new Map<string, [number, number]>();
  for (const child of moov.children(box, 3)) {
    const p = moov.payload(child);
    if (!APERTURE_SIZES.has(child.type) || sizes.has(child.type) || p.length !== 12 || p.readUInt32BE(0) !== 0) return null;
    sizes.set(child.type, [p.readUInt32BE(4), p.readUInt32BE(8)]);
  }
  return sizes.size === APERTURE_SIZES.size ? [...sizes.values()] : null;
}

/**
 * The timed metadata tracks go (4.5, D-261102-893): each `trak` is renamed
 * `free` and its samples are zeroed by the scrub, since they may hold
 * detected faces or a place. Before any is, every chunk must lie inside one
 * `mdat` and meet no kept track's chunk, by one sweep over both lists
 * sorted, so the scrub never reaches a frame a browser plays. A file that
 * breaks either is `bad_video`: no muxer writes such tables.
 */
function dropMetadata(moov: Moov, metadata: readonly Track[], mdats: readonly Range[], kept: readonly Range[]): void {
  const samples = new Tally(MAX_METADATA_SAMPLES);
  const dropped: Range[] = [];
  for (const track of metadata) {
    samples.add(track.sizes!.length);
    for (const chunk of chunkRanges(moov, track)) {
      if (!insideMdat(mdats, chunk.start, chunk.end)) throw refuse("bad_video");
      dropped.push(chunk);
    }
  }
  if (meets(dropped, kept, moov.budget)) throw refuse("bad_video");
  for (const track of metadata) moov.renameFree(track.dropped!);
  for (const chunk of dropped) moov.edits.scrub(chunk.start, chunk.end);
}

/** Whether any range of `a` overlaps any of `b`: `b` joined into sorted, disjoint stretches, then one pass over `a` sorted by start. */
export function meets(a: readonly Range[], b: readonly Range[], budget: Budget): boolean {
  const stretches = joined(b.filter((r) => r.end > r.start), budget);
  const sorted = a.filter((r) => r.end > r.start).sort((x, y) => x.start - y.start);
  let next = 0;
  for (let i = 0; i < sorted.length; i++) {
    if ((i & 1023) === 0) budget.check();
    const r = sorted[i]!;
    while (next < stretches.length && stretches[next]!.end <= r.start) next++;
    const s = stretches[next];
    if (s && s.start < r.end) return true;
  }
  return false;
}

/**
 * A timed metadata track: handler `meta` with one `mebx` entry, as an
 * iPhone writes for detected faces, the still image's time and more, and
 * as Apple's spec allows for places (4.5). Only what the drop needs is
 * read, its chunk tables, its length and its edits, through edits that are
 * thrown away, since the whole `trak` goes. Any other `meta` track is
 * `video_tracks`.
 */
function metadataTrack(moov: Moov, trak: Box, boxes: readonly Box[], mdiaKids: readonly Box[]): Track {
  const quiet = moov.discarding();
  const track: Track = { handler: "meta", dropped: trak };
  const seen = new Set<string>();
  for (const box of boxes) {
    if (box.type !== "edts") continue;
    once(seen, box.type);
    for (const e of quiet.children(box, 3)) {
      if (e.type !== "elst") continue;
      once(seen, e.type);
      track.presentation = metadataEdits(quiet, e);
    }
  }
  for (const box of mdiaKids) {
    if (box.type === "mdhd") {
      once(seen, box.type);
      const { version, body } = quiet.full(box, 1);
      if (body.length !== (version === 1 ? 32 : 20)) throw refuse("bad_video");
      const t = version === 1 ? 16 : 8;
      track.timescale = body.readUInt32BE(t);
      if (track.timescale <= 0) throw refuse("bad_video");
      track.mdhdDuration = version === 1 ? safe(body.readBigUInt64BE(t + 4)) : body.readUInt32BE(t + 4);
    } else if (box.type === "minf") {
      once(seen, box.type);
      for (const stbl of quiet.children(box, 4)) {
        if (stbl.type !== "stbl") continue;
        once(seen, stbl.type);
        for (const s of quiet.children(stbl, 5)) {
          if (METADATA_TABLES.has(s.type)) once(seen, s.type);
          if (s.type === "stsd") {
            const { body } = quiet.full(s, 0);
            if (body.length < 4) throw refuse("bad_video");
            const entries = quiet.children(s, 6, s.payload + 8);
            if (body.readUInt32BE(0) !== 1 || entries.length !== 1 || entries[0]!.type !== "mebx") throw refuse("video_tracks");
            track.sampleEntry = "mebx";
          } else if (s.type === "stsc") track.stsc = chunkRuns(quiet, s);
          else if (s.type === "stsz" || s.type === "stz2") track.sizes = sampleSizes(quiet, s);
          else if (s.type === "stco" || s.type === "co64") track.chunks = chunkOffsets(quiet, s);
        }
      }
    }
  }
  if ((seen.has("stsz") && seen.has("stz2")) || (seen.has("stco") && seen.has("co64"))) throw refuse("bad_video");
  if (!track.sampleEntry || !track.stsc || !track.sizes || !track.chunks || track.timescale === undefined) throw refuse("bad_video");
  return track;
}

const METADATA_TABLES = new Set(["stsd", "stsc", "stsz", "stz2", "stco", "co64"]);

/**
 * A dropped track's edits: at most four at normal rate, only the first of
 * which may be empty, as an iPhone's still-image-time track starts with
 * one. Answers the presentation's length in the movie's timescale, or
 * undefined for an empty list, which plays the media as it is.
 */
function metadataEdits(moov: Moov, box: Box): number | undefined {
  const { version, body } = moov.full(box, 1);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  const each = version === 1 ? 20 : 12;
  if (body.length !== 4 + count * each) throw refuse("bad_video");
  if (count === 0) return undefined;
  if (count > MAX_METADATA_EDITS) throw refuse("video_layout");
  let total = 0;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * each;
    const segment = version === 1 ? safe(body.readBigUInt64BE(at)) : body.readUInt32BE(at);
    const mediaTime = version === 1 ? body.readBigInt64BE(at + 8) : BigInt(body.readInt32BE(at + 4));
    const rate = body.readUInt32BE(at + (version === 1 ? 16 : 8));
    if (rate !== 0x10000 || mediaTime < -1n || (mediaTime === -1n && i > 0)) throw refuse("video_layout");
    total += segment;
  }
  return total;
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
  if (track.handler === "meta") return metadataTrack(moov, trak, boxes, mdiaKids);
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
      const { version, flags, body, at } = moov.full(box, 1, { allowed: 0xf });
      if (body.length !== (version === 1 ? 92 : 80)) throw refuse("bad_video");
      const t = version === 1 ? 16 : 8;
      moov.edits.zero(at, at + t);
      moov.zeroAt(at + t + 4, 4); // reserved after track_ID
      track.tkhdDuration = version === 1 ? safe(body.readBigUInt64BE(t + 8)) : body.readUInt32BE(t + 8);
      const rest = version === 1 ? 32 : 20;
      moov.zeroAt(at + rest, 8);
      moov.zeroAt(at + rest + 14, 2);
      track.tkhd = {
        width: body.readUInt32BE(rest + 52),
        height: body.readUInt32BE(rest + 56),
        flags,
        matrix: Array.from({ length: 9 }, (_, i) => body.readUInt32BE(rest + 16 + i * 4)),
        matrixAt: at + rest + 16,
        sizeAt: at + rest + 52,
      };
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
    } else if (box.type === "tapt" && moov.quickTime) {
      // Kept as a no-op only: it goes as free, and one unlike tkhd's size is refused once the codec has been judged (4.5).
      once(seen, box.type);
      track.aperture = aperture(moov, box);
      moov.renameFree(box);
    } else {
      moov.drop(box); // tref, udta, meta, clip, matt, load, imap, uuid and the rest
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

/**
 * Every data reference must be the file itself: a `url ` with the
 * self-contained flag and no location, or in a MOV, QuickTime's `alis` the
 * same way, which says "this file" (4.5).
 */
function dataReferences(moov: Moov, dref: Box): number {
  const { body } = moov.full(dref, 0);
  if (body.length < 4) throw refuse("bad_video");
  const count = body.readUInt32BE(0);
  const entries = moov.children(dref, 6, dref.payload + 8);
  if (count < 1 || entries.length !== count) throw refuse("bad_video");
  for (const e of entries) {
    if (e.type !== "url " && !(e.type === "alis" && moov.quickTime)) throw refuse("bad_video");
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
  // Versions 1 and 2 both say a default length, and per-entry lengths where it is 0 (AMBUILD-SOL-008). Version 2 adds the default index.
  const defaultLength = version >= 1 ? u32() : kind.bytes;
  const defaultIndex = version === 2 ? u32() : 0;
  const count = u32();
  if (defaultLength !== 0 && defaultLength !== kind.bytes) throw refuse("bad_video");
  if (defaultIndex > count) throw refuse("bad_video");
  for (let i = 0; i < count; i++) {
    if ((i & 1023) === 0) moov.budget.check();
    const length = version >= 1 && defaultLength === 0 ? u32() : kind.bytes;
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
 * A track's chunks as byte ranges, from its chunk tables: a chunk's samples
 * lie one after another from its offset, so a chunk inside an `mdat` has
 * every sample inside it. The tables must name each sample exactly once.
 * The caller holds every kept chunk inside an `mdat`, the only place no
 * header edit writes. The top-level walk finds the `mdat` payloads in file
 * order, so they are sorted and disjoint, and each chunk's is found by
 * halving rather than by trying every one: a file may hold some 200,000
 * empty `mdat` boxes (AM-R1-01).
 */
function chunkRanges(moov: Moov, track: Track): Range[] {
  const sizes = track.sizes!;
  const chunks = track.chunks!;
  const runs = track.stsc!;
  if (runs.length === 0 || runs[0]![0] !== 1) throw refuse("bad_video");
  if (runs[runs.length - 1]![0] > chunks.length) throw refuse("bad_video");
  const out: Range[] = [];
  let sample = 0;
  let run = 0;
  for (let chunk = 1; chunk <= chunks.length; chunk++) {
    if ((chunk & 1023) === 0) moov.budget.check();
    while (run + 1 < runs.length && runs[run + 1]![0] <= chunk) run++;
    const perChunk = runs[run]![1];
    const start = chunks[chunk - 1]!;
    let at = start;
    for (let i = 0; i < perChunk; i++) {
      if ((sample & 1023) === 0) moov.budget.check();
      const size = sizes[sample];
      if (size === undefined) throw refuse("bad_video");
      at += size;
      sample++;
    }
    out.push({ start, end: at });
  }
  if (sample !== sizes.length) throw refuse("bad_video");
  return out;
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

/** The most frames a decoder may hold back to present out of order: H.264's largest decoded picture buffer. */
const MAX_REORDER_FRAMES = 16;

/** The most frames a B-frame file with no edit list may start in: a b-pyramid delays two or three, and more is a gap at the start (D-261102-732). */
const MAX_IMPLICIT_DELAY_FRAMES = 4;

/**
 * A track's samples on its presentation timeline, in seconds from where the
 * track starts to play: `seconds` is the length the durations give (the
 * edit's segment where an edit list plays the media, else the media's own),
 * and `start` and `end` are where the first sample shows and the last one
 * ends, from the composition times with the edit's media time taken off.
 */
type Timing = { times: number[]; seconds: number; start: number; end: number; media: number; reorder: number; frame: number };

/**
 * A track's sample times and presentation interval. A composition offset
 * may present a sample later or earlier than it decodes, but by no more
 * than a decoder can reorder, counted in the track's typical frame, and
 * never before the media's start (AMBUILD-ASTRA-03). The typical frame is
 * the most common sample duration, so one long sample cannot raise the
 * allowance for every offset (AMBUILD-SOL-009).
 */
function timing(moov: Moov, track: Track, movieTimescale: number, cap: number, code: "video_fps" | "bad_video"): Timing {
  const tally = new Tally(cap, code);
  const times: number[] = [];
  const deltas: number[] = [];
  const counts = new Map<number, number>();
  let dts = 0;
  for (const [count, delta] of track.stts!) {
    tally.add(count);
    if (count > 0 && delta > 0) counts.set(delta, (counts.get(delta) ?? 0) + count);
    for (let i = 0; i < count; i++) {
      if ((times.length & 1023) === 0) moov.budget.check();
      times.push(dts);
      deltas.push(delta);
      dts += delta;
    }
  }
  if (!Number.isSafeInteger(dts) || times.length !== track.sizes!.length) throw refuse("bad_video");
  const typical = mostCommon(counts);
  const reorder = MAX_REORDER_FRAMES * typical;
  if (track.ctts) {
    let i = 0;
    for (const [count, offset] of track.ctts) {
      if (Math.abs(offset) > reorder) throw refuse("video_layout");
      for (let k = 0; k < count; k++) {
        if (i >= times.length) throw refuse("bad_video");
        times[i] = times[i]! + offset;
        if (times[i]! < 0) throw refuse("video_layout");
        i++;
      }
    }
    if (i !== times.length) throw refuse("bad_video");
  }
  let first = times.length > 0 ? Infinity : 0;
  let last = 0;
  for (const [i, t] of times.entries()) {
    first = Math.min(first, t);
    last = Math.max(last, t + deltas[i]!);
  }
  const scale = track.timescale!;
  const media = dts / scale;
  const edit = track.edit;
  // Some writers leave out the edit a B-frame file needs, so its first frame
  // shows a frame or two in. With no edit list, that first composition time
  // stands in for the edit's media time (D-261102-732), up to four typical
  // frames and never past the fixed slack, since a typical frame is the
  // file's own number. The reorder allowance would bound nothing: the offset
  // rule already holds the first composition time within it.
  const implicitLimit = Math.min(MAX_IMPLICIT_DELAY_FRAMES * typical, (TIMELINE_SLACK_MS / 1000) * scale);
  const from = edit ? edit.mediaTime : first <= implicitLimit ? first : 0;
  const seconds = edit ? edit.segment / movieTimescale : media;
  return { times, seconds, start: (first - from) / scale, end: (last - from) / scale, media, reorder, frame: typical / scale };
}

/** The sample duration most samples have, the shorter on a tie. */
function mostCommon(counts: ReadonlyMap<number, number>): number {
  let best = 0;
  let most = 0;
  for (const [delta, count] of counts) if (count > most || (count === most && delta < best)) (best = delta), (most = count);
  return best;
}

/**
 * A track's presentation interval against the cap and its durations
 * (AMBUILD-ASTRA-03, AMBUILD-SOL-009). The cap holds where the last sample
 * actually ends, whatever the durations say. The first sample must show at
 * the start, and the last must end where the durations do, within the
 * bounded tolerance: a gap at either end is an edited timeline, and an
 * edit's segment must be what its media holds (AM-ASTRA-08).
 */
function presents(t: Timing, tolerance: number): void {
  if (t.end > VIDEO_LIMITS.maxDurationMs / 1000 + tolerance) throw refuse("video_length");
  if (t.start > tolerance || Math.abs(t.seconds - t.end) > tolerance) throw refuse("video_layout");
}

/**
 * A track's own durations against its samples (AMBUILD-ASTRA-03): `mdhd`'s
 * against the media, `tkhd`'s against what it presents, and `cslg`'s
 * bounds inside the media's composition times. A player that read either
 * duration would otherwise show a length the facts do not.
 */
function trackDurations(track: Track, t: { seconds: number; media: number; reorder: number }, movieTimescale: number, tolerance: number): void {
  const scale = track.timescale!;
  if (Math.abs(track.mdhdDuration! / scale - t.media) > tolerance) throw refuse("video_layout");
  if (Math.abs(track.tkhdDuration! / movieTimescale - t.seconds) > tolerance) throw refuse("video_layout");
  const c = track.cslg;
  if (c) {
    const bound = t.media * scale + t.reorder;
    if ([c.shift, c.least, c.greatest, c.start, c.end].some((v) => Math.abs(v) > bound)) throw refuse("bad_video");
  }
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

/**
 * A `clap` that crops nothing: its width and height exactly the coded size
 * and both offsets zero, each fraction with a denominator. AVAssetWriter
 * writes one from the format's extensions (4.1, D-261102-895).
 */
function noOpAperture(b: Buffer, width: number, height: number): boolean {
  if (b.length !== 32) return false;
  const [wN, wD, hN, hD, xN, xD, yN, yD] = Array.from({ length: 8 }, (_, i) => b.readUInt32BE(i * 4)) as [number, number, number, number, number, number, number, number];
  return [wD, hD, xD, yD].every((d) => d >= 1) && wN === width * wD && hN === height * hD && xN === 0 && yN === 0;
}

function visualEntry(moov: Moov, entry: Box, track: Track): void {
  // Read first, before the tracks are counted or a tapt judged, so an iPhone's default file is told how to get one that plays (4.5).
  if (HEVC_ENTRIES.has(entry.type)) throw refuse("video_hevc");
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
      track.pasp = { h: b.readUInt32BE(0), v: b.readUInt32BE(4) };
      // The stored file's pixels are square, whatever the file said: a square ratio as N:N says 1:1, and a stretch is the facts' to draw (4.1, 5).
      moov.putAt(box.payload, PASP_SQUARE);
    } else if (box.type === "clap") {
      once(seen, box.type);
      // A real crop is refused once the codec is judged, so an HEVC file still hears how to get one that plays.
      if (noOpAperture(moov.payload(box), track.width!, track.height!)) moov.renameFree(box);
      else track.reshaped = true;
    } else if (box.type === "colr") {
      const b = moov.payload(box);
      const colour = b.subarray(0, 4).toString("latin1");
      // QuickTime's nclc says what nclx does, without the range bit, so a MOV holds one of the two (4.5).
      const nclc = moov.quickTime && colour === "nclc";
      // One of each colour type, as the format allows an nclx beside an ICC profile.
      once(seen, moov.quickTime && (colour === "nclx" || colour === "nclc") ? "colr ncl" : `colr ${colour}`);
      if (b.length >= 4 && colour === "nclx") {
        if (b.length !== 11) throw refuse("bad_video");
        // Primaries, transfer and matrix are 8-bit code points in 16-bit fields, then the full-range bit and seven reserved.
        if (b[4] !== 0 || b[6] !== 0 || b[8] !== 0 || (b[10]! & 0x7f) !== 0) throw refuse("bad_video");
        const transfer = b.readUInt16BE(6);
        if (transfer === 16 || transfer === 18) throw refuse("video_hdr");
      } else if (nclc) {
        if (b.length !== 10) throw refuse("bad_video");
        if (b[4] !== 0 || b[6] !== 0 || b[8] !== 0) throw refuse("bad_video");
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

/** The sample counts a QuickTime version 1 sound entry may give an AAC track: AAC-LC's frame, and HE-AAC's at its doubled rate (D-261102-899). */
const V1_SAMPLES_PER_PACKET = new Set([1024, 2048]);
/** QuickTime's compression ID for a version 1 entry: 0, or -2 for a compressed format with its own record, as FFmpeg writes for AAC. */
const V1_COMPRESSION_IDS = new Set([0, 0xfffe]);

function audioEntry(moov: Moov, entry: Box, track: Track): void {
  if (!["mp4a", "Opus"].includes(entry.type)) throw refuse("video_codec");
  const p = moov.payload(entry);
  if (p.length < 28) throw refuse("bad_video");
  // Version 0, as ISO writes it. A MOV may give version 1, whose four counts follow (4.5). Version 2 puts the codec record elsewhere.
  const version = p.readUInt16BE(8);
  if (version !== 0 && !(version === 1 && moov.quickTime)) throw refuse("video_sound");
  let configAt = entry.payload + 28;
  if (version === 0) {
    // The reserved eight, where QuickTime keeps a version, a revision and a vendor, and the predefined and reserved four after the sample size.
    moov.zeroAt(entry.payload + 8, 8);
    moov.zeroAt(entry.payload + 20, 4);
  } else {
    if (p.length < 44) throw refuse("bad_video");
    // The version stays, since readers find the counts by it. The revision and the vendor go, and so does the packet size, which AAC leaves 0.
    moov.zeroAt(entry.payload + 10, 6);
    moov.zeroAt(entry.payload + 22, 2);
    if (!V1_COMPRESSION_IDS.has(p.readUInt16BE(20))) throw refuse("video_sound");
    // Samples per packet, then bytes per packet, per frame and per sample: bounded, so none is room for text, and kept, since an untested reader may use them.
    if (!V1_SAMPLES_PER_PACKET.has(p.readUInt32BE(28)) || [32, 36, 40].some((at) => p.readUInt32BE(at) >= 0x10000)) throw refuse("video_sound");
    configAt = entry.payload + 44;
  }
  let sawConfig = false;
  const config = (box: Box) => {
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
  };
  for (const box of moov.children(entry, 7, configAt)) {
    if ((box.type === "esds" && entry.type === "mp4a") || (box.type === "dOps" && entry.type === "Opus")) config(box);
    else if (box.type === "wave" && entry.type === "mp4a" && moov.quickTime) config(soundWave(moov, box));
    else moov.drop(box); // chan, wave, btrt and the rest
  }
  if (!sawConfig) throw refuse("video_sound");
}

/** An empty box of type 0, which ends QuickTime's `wave`. */
const TERMINATOR = "\0\0\0\0";

/**
 * QuickTime's `wave` around AAC's `esds`, kept only exactly as FFmpeg and
 * Apple write it (4.5): `frma` naming `mp4a`, an `mp4a` holding four zero
 * bytes, the `esds` and the terminator. Anything else in it, or any other
 * order, is `video_sound`. Answers the `esds`.
 */
function soundWave(moov: Moov, wave: Box): Box {
  const kids = moov.children(wave, 8);
  const [frma, mp4a, esds, end] = kids;
  const holds = (box: Box | undefined, type: string, payload: Buffer) => box !== undefined && box.type === type && moov.payload(box).equals(payload);
  if (kids.length !== 4 || !holds(frma, "frma", Buffer.from("mp4a", "latin1")) || !holds(mp4a, "mp4a", Buffer.alloc(4)) || esds?.type !== "esds" || !holds(end, TERMINATOR, Buffer.alloc(0))) {
    throw refuse("video_sound");
  }
  return esds;
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
