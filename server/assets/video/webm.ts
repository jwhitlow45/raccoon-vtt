import { VIDEO_LIMITS } from "#shared/limits.ts";
import { webmDrawnWidth } from "#shared/videoGeometry.ts";
import { OPUS_HZ, av1CodecString, opusHead, opusPacketSamples, peakInOneSecond, timelineToleranceMs, vp9CodecPrivate, vp9CodecString, vp9KeyFrame, vp9Level, type Vp9Facts } from "./records.ts";
import { Edits, Tally, refuse, type Budget, type Source } from "./window.ts";
import type { ParsedVideo } from "./check.ts";

/**
 * The WebM header check (docs/design/design-v1-animated-maps.md 10, webm.ts).
 *
 * One walk over every element header, Clusters and their block headers
 * included, never decoding a frame. Elements on the allowlist are kept,
 * their strings and timestamps zeroed where the list says. Every other
 * element becomes a Void with an all-zero payload, the same length, so no
 * byte moves and Cues and SeekHead keep pointing where they did. Voids
 * already in the file have their payloads zeroed too, since an editor may
 * have blanked metadata there without erasing it (AM-ASTRA-01). No write
 * lands inside a block: those are the media data.
 */

export const EBML_ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Void: 0xec,
  CRC32: 0xbf,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  DateUTC: 0x4461,
  Title: 0x7ba9,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  SegmentUUID: 0x73a4,
  SegmentFilename: 0x7384,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  FlagHearingImpaired: 0x55ab,
  FlagVisualImpaired: 0x55ac,
  FlagTextDescriptions: 0x55ad,
  FlagOriginal: 0x55ae,
  FlagCommentary: 0x55af,
  FlagLacing: 0x9c,
  DefaultDuration: 0x23e383,
  Name: 0x536e,
  Language: 0x22b59c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecName: 0x258688,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  ContentEncodings: 0x6d80,
  Video: 0xe0,
  FlagInterlaced: 0x9a,
  StereoMode: 0x53b8,
  AlphaMode: 0x53c0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  PixelCropBottom: 0x54aa,
  PixelCropTop: 0x54bb,
  PixelCropLeft: 0x54cc,
  PixelCropRight: 0x54dd,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  DisplayUnit: 0x54b2,
  Projection: 0x7670,
  ProjectionType: 0x7671,
  ProjectionPrivate: 0x7672,
  ProjectionPoseYaw: 0x7673,
  ProjectionPosePitch: 0x7674,
  ProjectionPoseRoll: 0x7675,
  Colour: 0x55b0,
  TransferCharacteristics: 0x55ba,
  MasteringMetadata: 0x55d0,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueReference: 0xdb,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  PrevSize: 0xab,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockAdditions: 0x75a1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  DiscardPadding: 0x75a2,
  EncryptedBlock: 0xaf,
  Tags: 0x1254c367,
  Tag: 0x7373,
  SimpleTag: 0x67c8,
  TagName: 0x45a3,
  TagString: 0x4487,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
} as const;

const I = EBML_ID;

type El = { id: number; start: number; dataStart: number; end: number; idLength: number; sizeLength: number };

/**
 * How a master kept whole from KEPT reads each child: a number checked by
 * its type and range, or a master read the same way. Each is allowed once
 * unless `many`, as the format allows it (AMBUILD-SOL-006).
 */
type Rule = { leaf: "uint" | "float"; min?: number; max?: number } | { master: true; many?: boolean };

const UINT_FLAGS = [I.FlagEnabled, I.FlagDefault, I.FlagForced, I.FlagHearingImpaired, I.FlagVisualImpaired, I.FlagTextDescriptions, I.FlagOriginal, I.FlagCommentary, I.FlagLacing];
/** Colour's numbers: code points, bit counts, siting and the light levels, none past 16 bits. */
const COLOUR_UINTS = [0x55b1, 0x55b2, 0x55b3, 0x55b4, 0x55b5, 0x55b6, 0x55b7, 0x55b8, 0x55b9, I.TransferCharacteristics, 0x55bb, 0x55bc, 0x55bd];
const MASTERING_FLOATS = [0x55d1, 0x55d2, 0x55d3, 0x55d4, 0x55d5, 0x55d6, 0x55d7, 0x55d8, 0x55d9, 0x55da];

const KEPT: Record<number, Record<number, Rule>> = {
  [I.Colour]: { ...Object.fromEntries(COLOUR_UINTS.map((id) => [id, { leaf: "uint", max: 0xffff } as const])), [I.MasteringMetadata]: { master: true } },
  [I.MasteringMetadata]: Object.fromEntries(MASTERING_FLOATS.map((id) => [id, { leaf: "float", min: 0 } as const])),
};

/**
 * Refuses a second copy of an element its parent may hold once, so the
 * check never vouches for one copy while a browser reads another, and no
 * copy it did not read is kept (AMBUILD-SOL-006).
 */
class Once {
  readonly #seen = new Set<number>();

  take(id: number): void {
    if (this.#seen.has(id)) throw refuse("bad_video");
    this.#seen.add(id);
  }
}

/** The Segment children a SeekHead entry may point at: the ones this check keeps. */
const SEEKABLE = new Set<number>([I.SeekHead, I.Info, I.Tracks, I.Cues, I.Cluster]);

type Track = {
  number: number;
  type: number;
  codecId: string;
  codecPrivate?: Buffer;
  defaultDuration?: number;
  codecDelay: number;
  width?: number;
  height?: number;
  /** The picture's width once its display size applies, when its pixels are not square (docs/design/design-v1-video-turns.md 4.2). */
  displayWidthPx?: number;
  transfer?: number;
  alpha?: number;
  channels?: number;
  /** The Audio element's Channels, which must match OpusHead's. */
  declaredChannels?: number;
  codecPrivateTooLong?: boolean;
};

class Walk {
  readonly src: Source;
  readonly budget: Budget;
  readonly edits = new Edits();
  readonly headers = new Tally(VIDEO_LIMITS.parseElementHeaders);

  constructor(src: Source, budget: Budget) {
    this.src = src;
    this.budget = budget;
  }

  /** One element's header at `at`, which must end inside `parentEnd`. */
  async header(at: number, parentEnd: number, depth: number): Promise<El> {
    this.budget.check();
    if (depth > VIDEO_LIMITS.parseDepth) throw refuse("bad_video");
    const head = await this.src.read(at, Math.min(12, parentEnd - at));
    const idLength = vintLength(head[0]);
    if (idLength > 4 || idLength > head.length) throw refuse("bad_video");
    let id = 0;
    for (let i = 0; i < idLength; i++) id = id * 256 + head[i]!;
    const sizeLength = vintLength(head[idLength]);
    if (idLength + sizeLength > head.length) throw refuse("bad_video");
    const size = vintValue(head, idLength, sizeLength);
    if (size === "unknown") throw refuse("video_unfinished");
    const dataStart = at + idLength + sizeLength;
    const end = dataStart + size;
    if (!Number.isSafeInteger(end) || end > parentEnd) throw refuse("bad_video");
    return { id, start: at, dataStart, end, idLength, sizeLength };
  }

  /** The children of `[start, end)`, each header counted, unless it is a block, which the frame counts take. */
  async *children(start: number, end: number, depth: number): AsyncGenerator<El> {
    let at = start;
    while (at < end) {
      const el = await this.header(at, end, depth);
      if (el.id !== I.SimpleBlock && el.id !== I.Block) this.headers.add();
      yield el;
      at = el.end;
    }
  }

  async bytes(el: El, max = VIDEO_LIMITS.parseValueBytes): Promise<Buffer> {
    const size = el.end - el.dataStart;
    if (size > max) throw refuse("bad_video");
    return Buffer.from(await this.src.read(el.dataStart, size));
  }

  async uint(el: El): Promise<number> {
    if (el.end - el.dataStart > 8) throw refuse("bad_video");
    const b = await this.bytes(el);
    let value = 0;
    for (const byte of b) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw refuse("bad_video");
    return value;
  }

  async int(el: El): Promise<number> {
    if (el.end - el.dataStart > 8) throw refuse("bad_video");
    const b = await this.bytes(el);
    if (b.length === 0) return 0;
    let value = BigInt.asIntN(b.length * 8, b.reduce((v, byte) => v * 256n + BigInt(byte), 0n));
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw refuse("bad_video");
    return Number(value);
  }

  async float(el: El): Promise<number> {
    const b = await this.bytes(el, 8);
    const value = b.length === 0 ? 0 : b.length === 4 ? b.readFloatBE(0) : b.length === 8 ? b.readDoubleBE(0) : Number.NaN;
    if (!Number.isFinite(value)) throw refuse("bad_video");
    return value;
  }

  async string(el: El): Promise<string> {
    return (await this.bytes(el)).toString("latin1").replace(/\0+$/, "");
  }

  /** An element off the list becomes a Void of the same length with an all-zero payload. */
  void(el: El): void {
    const total = el.end - el.start;
    const sizeLength = Math.min(8, el.idLength + el.sizeLength - 1);
    const payload = total - 1 - sizeLength;
    this.edits.zero(el.start + 1 + sizeLength, el.end);
    this.edits.put(el.start, Buffer.concat([Buffer.from([I.Void]), encodeVint(payload, sizeLength)]));
  }

  /** A kept element whose bytes are cleared: a Void's padding, or a string the format requires. */
  zeroPayload(el: El): void {
    this.edits.zero(el.dataStart, el.end);
  }

  /**
   * A master kept whole from KEPT: each listed child read and checked by
   * its rule whether or not anyone hears its value, Voids padded,
   * everything else made Void. `seen` hears each number kept.
   * (AMBUILD-ASTRA-02: a value read only for `seen` went unchecked.)
   */
  async keepMaster(el: El, depth: number, seen?: (id: number, value: number) => void): Promise<void> {
    const allowed = KEPT[el.id] ?? {};
    const once = new Once();
    for await (const child of this.children(el.dataStart, el.end, depth + 1)) {
      const rule = allowed[child.id];
      if (child.id === I.Void) {
        this.zeroPayload(child);
        continue;
      }
      if (!rule) {
        this.void(child);
        continue;
      }
      if (!("master" in rule && rule.many)) once.take(child.id);
      if ("master" in rule) {
        await this.keepMaster(child, depth + 1, seen);
        continue;
      }
      const value = rule.leaf === "uint" ? await this.uint(child) : await this.float(child);
      if ((rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) throw refuse("bad_video");
      seen?.(child.id, value);
    }
  }

  /** A uint that must lie in `[min, max]`. */
  async uintIn(el: El, min: number, max: number): Promise<number> {
    const value = await this.uint(el);
    if (value < min || value > max) throw refuse("bad_video");
    return value;
  }
}

export async function parseWebm(src: Source, budget: Budget): Promise<ParsedVideo> {
  const walk = new Walk(src, budget);
  let at = 0;
  let segment: El | undefined;
  let sawHeader = false;
  while (at < src.size) {
    const el = await walk.header(at, src.size, 1);
    walk.headers.add();
    if (!sawHeader) {
      if (el.id !== I.EBML) throw refuse("video_type");
      await ebmlHeader(walk, el);
      sawHeader = true;
    } else if (el.id === I.Void) {
      walk.zeroPayload(el);
    } else if (el.id === I.Segment && !segment) {
      segment = el;
    } else {
      // A second Segment, or anything else at the top, is not one plain WebM.
      throw refuse("bad_video");
    }
    at = el.end;
  }
  // The Segment must reach the file's end: nothing may follow it.
  if (!segment || segment.end !== src.size) throw refuse("bad_video");
  return parseSegment(walk, segment);
}

const EBML_HEADER_KEPT = new Set<number>([I.EBMLVersion, I.EBMLReadVersion, I.EBMLMaxIDLength, I.EBMLMaxSizeLength, I.DocType, I.DocTypeVersion, I.DocTypeReadVersion]);

async function ebmlHeader(walk: Walk, el: El): Promise<void> {
  let docType = "matroska";
  const once = new Once();
  for await (const child of walk.children(el.dataStart, el.end, 2)) {
    const id = child.id;
    if (id === I.Void) {
      walk.zeroPayload(child);
      continue;
    }
    if (!EBML_HEADER_KEPT.has(id)) {
      walk.void(child);
      continue;
    }
    once.take(id);
    // Only "webm" passes, with nothing but the zero padding a string may end with.
    if (id === I.DocType) docType = await walk.string(child);
    else if (id === I.EBMLVersion || id === I.EBMLReadVersion) await walk.uintIn(child, 1, 1);
    else if (id === I.EBMLMaxIDLength) await walk.uintIn(child, 1, 4);
    else if (id === I.EBMLMaxSizeLength) await walk.uintIn(child, 1, 8);
    else await walk.uintIn(child, 1, 4); // DocTypeVersion and DocTypeReadVersion: WebM is at most version 4
  }
  if (docType !== "webm") throw refuse("video_type");
}

type BlockTiming = { duration?: number; discardPadding?: number };

/** Where a SeekHead entry points, checked once the walk knows every element's place. */
type SeekEntry = { target: number; position: number };

/** One CueTrackPositions with its CuePoint's time, checked once the walk knows every Cluster and block. */
type CueEntry = { time: number; track: number; cluster: number; relative?: number; blockNumber?: number; duration?: number; codecState?: number; refTimes: number[] };

/** A Cluster as the Cues may point at it: its data's length and how many blocks it holds. */
type ClusterAt = { bytes: number; blocks: number };

/** The most ReferenceBlocks a BlockGroup holds: a B-frame names one frame before it and one after. */
const MAX_REFERENCES = 2;

async function parseSegment(walk: Walk, segment: El): Promise<ParsedVideo> {
  let scale: number | undefined;
  let duration: number | undefined;
  let tracks: Track[] | undefined;
  let sawInfo = false;
  let sawCues = false;
  let seekHeads = 0;
  const videoFrames = new Tally(VIDEO_LIMITS.parseVideoFrameHeaders, "video_fps");
  const soundFrames = new Tally(VIDEO_LIMITS.parseSoundFrameHeaders);
  /** The shown frames, each with its own BlockDuration where it has one, in ns (AMBUILD-ASTRA-08): a duration belongs to its block, not to its time. */
  const frames: Frame[] = [];
  let soundEnd = -Infinity;
  /** The latest invisible block, in ns: it lies on the timeline though it shows nothing. */
  let invisibleEnd = -Infinity;
  let lastClusterTimestamp = 0;
  /** The latest block's timestamp in the Segment's ticks, which no Cue may pass. */
  let lastTicks = 0;
  let firstVideoHead: Buffer | undefined;
  const seeks: SeekEntry[] = [];
  const cueEntries: CueEntry[] = [];
  /** Each Segment child's id by its place from the Segment's data, as SeekPosition and CueClusterPosition count. */
  const placed = new Map<number, number>();
  const clusters = new Map<number, ClusterAt>();

  for await (const el of walk.children(segment.dataStart, segment.end, 2)) {
    placed.set(el.start - segment.dataStart, el.id);
    if (el.id === I.Void) walk.zeroPayload(el);
    else if (el.id === I.SeekHead) {
      // The format allows a second SeekHead, which the first points at.
      if (++seekHeads > 2) throw refuse("bad_video");
      await seekHead(walk, el, seeks);
    } else if (el.id === I.Info) {
      if (sawInfo) throw refuse("bad_video");
      sawInfo = true;
      ({ scale, duration } = await info(walk, el));
    } else if (el.id === I.Tracks) {
      if (tracks) throw refuse("bad_video");
      tracks = await trackList(walk, el);
    } else if (el.id === I.Cues) {
      if (sawCues) throw refuse("bad_video");
      sawCues = true;
      await cues(walk, el, cueEntries);
    } else if (el.id === I.Cluster) {
      // Blocks are read by their track, in Info's time scale, so both come first, as every muxer writes them.
      if (scale === undefined || !tracks) throw refuse("bad_video");
      const known = { scale, tracks };
      // A ReferenceBlock names another block by its distance in ticks, which no timeline under the cap exceeds.
      const farthest = Math.ceil((VIDEO_LIMITS.maxDurationMs * 1e6) / scale);
      const at: ClusterAt = { bytes: el.end - el.dataStart, blocks: 0 };
      clusters.set(el.start - segment.dataStart, at);
      let timestamp: number | undefined;
      const once = new Once();
      const block = async (b: El, timing: BlockTiming, simple: boolean) => {
        if (timestamp === undefined) throw refuse("bad_video");
        const read = await blockHeader(walk, b, known.tracks, simple);
        walk.edits.protect(b.dataStart, b.end);
        // A block's own time, the Cluster's plus its signed offset, is never before the file starts.
        if (timestamp + read.relative < 0) throw refuse("bad_video");
        lastTicks = Math.max(lastTicks, timestamp + read.relative);
        const time = (timestamp + read.relative) * known.scale;
        if (read.track.type === 1) {
          videoFrames.add();
          if (read.lacing !== 0) throw refuse("bad_video");
          if (read.invisible || (read.track.codecId === "V_VP8" && !(await vp8Shown(walk, b, read.payloadStart)))) {
            invisibleEnd = Math.max(invisibleEnd, time);
            return;
          }
          frames.push({ time, own: timing.duration === undefined ? undefined : timing.duration * known.scale });
          if (!firstVideoHead) firstVideoHead = await walk.src.read(read.payloadStart, Math.min(16, b.end - read.payloadStart));
        } else {
          const samples = await soundSamples(walk, b, read, soundFrames);
          const length = timing.duration !== undefined ? timing.duration * known.scale : (samples * 1e9) / OPUS_HZ;
          const trimmed = timing.discardPadding !== undefined && timing.discardPadding > 0 ? timing.discardPadding : 0;
          soundEnd = Math.max(soundEnd, time - read.track.codecDelay + length - trimmed);
        }
      };
      for await (const child of walk.children(el.dataStart, el.end, 3)) {
        if (child.id === I.Timestamp) {
          once.take(child.id);
          timestamp = await walk.uint(child);
          lastClusterTimestamp = timestamp;
        } else if (child.id === I.SimpleBlock) {
          at.blocks++;
          await block(child, {}, true);
        } else if (child.id === I.BlockGroup) {
          at.blocks++;
          let inner: El | undefined;
          let references = 0;
          const timing: BlockTiming = {};
          const inGroup = new Once();
          for await (const g of walk.children(child.dataStart, child.end, 4)) {
            if (g.id === I.Block) {
              inGroup.take(g.id);
              inner = g;
            } else if (g.id === I.BlockDuration) {
              inGroup.take(g.id);
              timing.duration = await walk.uint(g);
            } else if (g.id === I.ReferenceBlock) {
              if (++references > MAX_REFERENCES) throw refuse("bad_video");
              const distance = await walk.int(g);
              if (Math.abs(distance) > farthest) throw refuse("bad_video");
            } else if (g.id === I.DiscardPadding) {
              inGroup.take(g.id);
              timing.discardPadding = await walk.int(g);
              // Padding trims part of one packet, and an Opus packet is at most 120 ms.
              if (Math.abs(timing.discardPadding) > 120_000_000) throw refuse("bad_video");
            } else if (g.id === I.BlockAdditions) throw refuse("video_alpha");
            else if (g.id === I.Void) walk.zeroPayload(g);
            else walk.void(g);
          }
          if (!inner) throw refuse("bad_video");
          await block(inner, timing, false);
        } else if (child.id === I.EncryptedBlock) throw refuse("bad_video");
        else if (child.id === I.Void) walk.zeroPayload(child);
        // PrevSize goes too: it only helps play backwards, and a free number in every Cluster is room for text.
        else walk.void(child);
      }
    } else walk.void(el); // Tags, Attachments, Chapters, CRC-32 and anything unknown
  }

  if (scale === undefined || duration === undefined) throw refuse("video_unfinished");
  if (!tracks) throw refuse("bad_video");
  const video = tracks.find((t) => t.type === 1)!;
  const sound = tracks.find((t) => t.type === 2);
  if (frames.length === 0) throw refuse("bad_video");
  // Each SeekHead entry must point at the element it names.
  for (const seek of seeks) if (placed.get(seek.position) !== seek.target) throw refuse("bad_video");

  const fps = peakInOneSecond(frames.map((f) => f.time), 1e9);
  const videoEnd = framesEnd(frames, video.defaultDuration);
  const tolerance = timelineToleranceMs((video.defaultDuration ?? videoEnd.gap) / 1e6) * 1e6;
  // Sound may end up to a frame or 50 ms after the picture (AMN-4, AMR-3): AAC and Opus pad their last packet.
  if (sound && soundEnd > videoEnd.end + tolerance) throw refuse("video_layout");
  const endNs = Math.max(videoEnd.end, invisibleEnd, soundEnd);
  checkTimeline({ declaredNs: duration * scale, clusterNs: lastClusterTimestamp * scale, endNs, toleranceNs: tolerance });
  // Two shown frames at one time: a browser shows only one of them, so the file is not the one its frames say (D-261102-740).
  if (videoEnd.repeated) throw refuse("video_layout");
  checkCues(cueEntries, { tracks, clusters, lastTicks, endTicks: Math.ceil(endNs / scale), segmentBytes: segment.end - segment.dataStart });

  return {
    container: "webm",
    widthPx: video.width!,
    heightPx: video.height!,
    ...(video.displayWidthPx !== undefined ? { displayWidthPx: video.displayWidthPx } : {}),
    video: videoCodecString(video, firstVideoHead, fps),
    ...(sound ? { audio: "opus", audioChannels: sound.channels!, audioHz: OPUS_HZ } : {}),
    fps,
    durationMs: Math.round((duration * scale) / 1e6),
    edits: walk.edits,
  };
}

type Frame = { time: number; own: number | undefined };

/**
 * Where the shown frames end, in ns, with the gap a frame takes where the
 * file says none, and whether two frames share a time. A frame's
 * BlockDuration is its own end, then the track's
 * DefaultDuration, and the last frame without either lasts the larger of
 * the average gap and the gap before it, as a variable rate's last frame
 * and a muxer's Duration count it. A DefaultDuration far longer than the
 * frames' spacing still ends the frames where it says, so a Duration or a
 * cap it would pass is refused rather than trusted.
 */
function framesEnd(frames: readonly Frame[], defaultDuration: number | undefined): { end: number; gap: number; repeated: boolean } {
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  const first = sorted[0]!.time;
  const last = sorted[sorted.length - 1]!.time;
  const gap = sorted.length > 1 ? (last - first) / (sorted.length - 1) : 0;
  const lastGap = sorted.length > 1 ? last - sorted[sorted.length - 2]!.time : 0;
  let end = -Infinity;
  let repeated = false;
  for (const [i, f] of sorted.entries()) {
    if (i > 0 && f.time === sorted[i - 1]!.time) repeated = true;
    const own = f.own;
    if (own !== undefined) end = Math.max(end, f.time + own);
    else if (defaultDuration !== undefined) end = Math.max(end, f.time + defaultDuration);
    else if (i === sorted.length - 1) end = Math.max(end, f.time + Math.max(gap, lastGap));
  }
  return { end: Math.max(end, last), gap, repeated };
}

/**
 * The presentation timeline against the Duration and the length cap
 * (AMBUILD-ASTRA-03, AMBUILD-SOL-005): the shown frames' ends, every
 * invisible block and the sound's end. The cap holds the timeline first and
 * on its own, whatever the Duration says, so a file that runs past it is
 * too long rather than unfinished. A Duration the timeline runs past says
 * less than the file holds. One the timeline falls short of is an edited
 * timeline, a gap the player would hold. The tolerance is never more than
 * TIMELINE_SLACK_MS.
 */
function checkTimeline(t: { declaredNs: number; clusterNs: number; endNs: number; toleranceNs: number }): void {
  if (Math.max(t.endNs, t.clusterNs) > VIDEO_LIMITS.maxDurationMs * 1e6 + t.toleranceNs) throw refuse("video_length");
  if (t.declaredNs < t.clusterNs || t.declaredNs < t.endNs - t.toleranceNs) throw refuse("video_unfinished");
  const declaredMs = Math.round(t.declaredNs / 1e6);
  if (declaredMs < VIDEO_LIMITS.minDurationMs || declaredMs > VIDEO_LIMITS.maxDurationMs) throw refuse("video_length");
  if (t.declaredNs > t.endNs + t.toleranceNs) throw refuse("video_layout");
}

async function seekHead(walk: Walk, el: El, seeks: SeekEntry[]): Promise<void> {
  for await (const seek of walk.children(el.dataStart, el.end, 3)) {
    if (seek.id === I.Void) {
      walk.zeroPayload(seek);
      continue;
    }
    if (seek.id !== I.Seek) {
      walk.void(seek);
      continue;
    }
    let target: number | undefined;
    let position: El | undefined;
    const kids: El[] = [];
    const once = new Once();
    for await (const child of walk.children(seek.dataStart, seek.end, 4)) kids.push(child);
    for (const child of kids) {
      if (child.id === I.SeekID) {
        once.take(child.id);
        const id = await walk.bytes(child, 4);
        target = id.reduce((v, b) => v * 256 + b, 0);
      } else if (child.id === I.SeekPosition) {
        once.take(child.id);
        position = child;
      }
    }
    // An entry pointing at an element this check drops would point at a Void, so it goes with it.
    if (target === undefined || !SEEKABLE.has(target)) {
      walk.void(seek);
      continue;
    }
    if (!position) throw refuse("bad_video");
    seeks.push({ target, position: await walk.uint(position) });
    for (const child of kids) {
      if (child.id === I.SeekID || child.id === I.SeekPosition) continue;
      if (child.id === I.Void) walk.zeroPayload(child);
      else walk.void(child);
    }
  }
}

async function info(walk: Walk, el: El): Promise<{ scale: number | undefined; duration: number | undefined }> {
  let scale: number | undefined;
  let duration: number | undefined;
  const once = new Once();
  for await (const child of walk.children(el.dataStart, el.end, 3)) {
    if (child.id === I.TimestampScale) {
      once.take(child.id);
      scale = await walk.uint(child);
      if (scale <= 0) throw refuse("bad_video");
    } else if (child.id === I.Duration) {
      once.take(child.id);
      duration = await walk.float(child);
      if (duration <= 0) throw refuse("bad_video");
    } else if (child.id === I.MuxingApp || child.id === I.WritingApp) {
      once.take(child.id);
      walk.zeroPayload(child);
    } else if (child.id === I.Void) walk.zeroPayload(child);
    else walk.void(child); // Title, DateUTC, SegmentUUID, SegmentFilename, CRC-32 and the rest
  }
  return { scale, duration };
}

const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;
const CUE_RELATIVE_POSITION = 0xf0;
const CUE_DURATION = 0xb2;
const CUE_BLOCK_NUMBER = 0x5378;
const CUE_CODEC_STATE = 0xea;
const CUE_REF_TIME = 0x96;

/**
 * The Cues, read into their entries, each number once where the format
 * allows one (AMBUILD-ASTRA-02). They may come before the Clusters, so
 * what they point at is checked after the walk (checkCues).
 */
async function cues(walk: Walk, el: El, out: CueEntry[]): Promise<void> {
  for await (const point of walk.children(el.dataStart, el.end, 3)) {
    if (point.id === I.Void) {
      walk.zeroPayload(point);
      continue;
    }
    if (point.id !== I.CuePoint) {
      walk.void(point);
      continue;
    }
    let time: number | undefined;
    const positions: El[] = [];
    const once = new Once();
    for await (const child of walk.children(point.dataStart, point.end, 4)) {
      if (child.id === I.CueTime) {
        once.take(child.id);
        time = await walk.uint(child);
      } else if (child.id === I.CueTrackPositions) positions.push(child);
      else if (child.id === I.Void) walk.zeroPayload(child);
      else walk.void(child);
    }
    if (time === undefined || positions.length === 0) throw refuse("bad_video");
    for (const p of positions) out.push(await cuePositions(walk, p, time));
  }
}

async function cuePositions(walk: Walk, el: El, time: number): Promise<CueEntry> {
  const entry: Partial<CueEntry> & { refTimes: number[] } = { time, refTimes: [] };
  const once = new Once();
  for await (const child of walk.children(el.dataStart, el.end, 5)) {
    const id = child.id;
    if (id === I.Void) walk.zeroPayload(child);
    else if (id === I.CueReference) {
      let refTime: number | undefined;
      const inRef = new Once();
      for await (const r of walk.children(child.dataStart, child.end, 6)) {
        if (r.id === CUE_REF_TIME) {
          inRef.take(r.id);
          refTime = await walk.uint(r);
        } else if (r.id === I.Void) walk.zeroPayload(r);
        else walk.void(r);
      }
      if (refTime === undefined) throw refuse("bad_video");
      entry.refTimes.push(refTime);
    } else if (id === CUE_TRACK || id === CUE_CLUSTER_POSITION || id === CUE_RELATIVE_POSITION || id === CUE_DURATION || id === CUE_BLOCK_NUMBER || id === CUE_CODEC_STATE) {
      once.take(id);
      const value = await walk.uint(child);
      if (id === CUE_TRACK) entry.track = value;
      else if (id === CUE_CLUSTER_POSITION) entry.cluster = value;
      else if (id === CUE_RELATIVE_POSITION) entry.relative = value;
      else if (id === CUE_DURATION) entry.duration = value;
      else if (id === CUE_BLOCK_NUMBER) entry.blockNumber = value;
      else entry.codecState = value;
    } else walk.void(child);
  }
  if (entry.track === undefined || entry.cluster === undefined) throw refuse("bad_video");
  return entry as CueEntry;
}

/**
 * Every Cue names a track the file has, a Cluster where one starts, a place
 * and a block number inside it, and times inside the file's own: a Cue's
 * numbers say where the file's parts are, so they hold nothing else. The
 * place in the Cluster is only bounded, since a muxer may count it from
 * before or after a CRC-32 at the Cluster's start.
 */
function checkCues(entries: readonly CueEntry[], file: { tracks: readonly Track[]; clusters: ReadonlyMap<number, ClusterAt>; lastTicks: number; endTicks: number; segmentBytes: number }): void {
  for (const cue of entries) {
    const cluster = file.clusters.get(cue.cluster);
    if (!cluster || !file.tracks.some((t) => t.number === cue.track)) throw refuse("bad_video");
    if (cue.relative !== undefined && cue.relative >= cluster.bytes) throw refuse("bad_video");
    if (cue.blockNumber !== undefined && (cue.blockNumber < 1 || cue.blockNumber > cluster.blocks)) throw refuse("bad_video");
    if (cue.codecState !== undefined && cue.codecState > file.segmentBytes) throw refuse("bad_video");
    // A Cue's times are block times, and its CueDuration is a block's length (AMBUILD-ASTRA-07): it ends no later than the timeline does.
    for (const t of [cue.time, ...cue.refTimes]) if (t > file.lastTicks) throw refuse("bad_video");
    if (cue.time + (cue.duration ?? 0) > file.endTicks) throw refuse("bad_video");
  }
}

async function trackList(walk: Walk, el: El): Promise<Track[]> {
  const tracks: Track[] = [];
  for await (const child of walk.children(el.dataStart, el.end, 3)) {
    if (child.id === I.TrackEntry) tracks.push(await trackEntry(walk, child));
    else if (child.id === I.Void) walk.zeroPayload(child);
    else walk.void(child);
  }
  // The tracks are counted before any codec is judged, so a second sound track is refused as one, whatever its codec.
  const videos = tracks.filter((t) => t.type === 1);
  const sounds = tracks.filter((t) => t.type === 2);
  if (videos.length !== 1 || sounds.length > 1 || videos.length + sounds.length !== tracks.length) throw refuse("video_tracks");
  if (new Set(tracks.map((t) => t.number)).size !== tracks.length) throw refuse("bad_video");
  for (const track of tracks) {
    if (track.codecId === "A_VORBIS") throw refuse("video_vorbis");
    if (track.type === 1 && !["V_VP8", "V_VP9", "V_AV1"].includes(track.codecId)) throw refuse("video_codec");
    if (track.type === 2 && track.codecId !== "A_OPUS") throw refuse("video_codec");
    if (track.type === 1 && (track.width === undefined || track.height === undefined)) throw refuse("bad_video");
    if (track.codecPrivateTooLong) throw refuse("bad_video");
    if (track.type === 2) {
      if (!track.codecPrivate) throw refuse("video_sound");
      track.channels = opusHead(track.codecPrivate, "webm").channels;
      // The Audio element's own count, where given, says the same.
      if (track.declaredChannels !== undefined && track.declaredChannels !== track.channels) throw refuse("video_sound");
    }
    if (track.codecId === "V_VP8" && track.codecPrivate) throw refuse("bad_video");
    if (track.codecId === "V_AV1" && !track.codecPrivate) throw refuse("bad_video");
  }
  return tracks;
}

/** A TrackEntry's children the check reads, each allowed once. */
const TRACK_KEPT = new Set<number>([I.TrackNumber, I.TrackUID, I.TrackType, ...UINT_FLAGS, I.DefaultDuration, I.CodecID, I.CodecPrivate, I.CodecDelay, I.SeekPreRoll, I.ContentEncodings, I.Video, I.Audio]);

/** A time in nanoseconds no file under the length cap needs more than. */
const LONGEST_NS = VIDEO_LIMITS.maxDurationMs * 1e6;

async function trackEntry(walk: Walk, el: El): Promise<Track> {
  const kids: El[] = [];
  const once = new Once();
  for await (const child of walk.children(el.dataStart, el.end, 4)) {
    if (TRACK_KEPT.has(child.id)) once.take(child.id);
    kids.push(child);
  }
  const track: Track = { number: 0, type: 0, codecId: "", codecDelay: 0 };
  // CodecID first, so a Vorbis track is refused as Vorbis whatever the size of its CodecPrivate (AMR-6).
  for (const child of kids) {
    if (child.id === I.TrackType) track.type = await walk.uint(child);
    else if (child.id === I.CodecID) track.codecId = await walk.string(child);
  }
  for (const child of kids) {
    const id = child.id;
    if (id === I.TrackType || id === I.CodecID) continue;
    if (id === I.TrackNumber) track.number = await walk.uint(child);
    else if (id === I.TrackUID) await walk.uint(child);
    else if (UINT_FLAGS.includes(id as (typeof UINT_FLAGS)[number])) await walk.uintIn(child, 0, 1);
    else if (id === I.SeekPreRoll) await walk.uintIn(child, 0, LONGEST_NS);
    else if (id === I.DefaultDuration) track.defaultDuration = await walk.uintIn(child, 1, LONGEST_NS);
    else if (id === I.CodecDelay) track.codecDelay = await walk.uintIn(child, 0, LONGEST_NS);
    else if (id === I.CodecPrivate) {
      // Vorbis's comment header is free text, never read: the track is refused once the tracks are counted.
      if (track.codecId === "A_VORBIS") continue;
      if (child.end - child.dataStart > VIDEO_LIMITS.parseValueBytes) track.codecPrivateTooLong = true;
      else track.codecPrivate = await walk.bytes(child);
    } else if (id === I.ContentEncodings) throw refuse("bad_video");
    else if (id === I.Video && track.type === 1) await videoSettings(walk, child, track);
    else if (id === I.Audio && track.type === 2) await audioSettings(walk, child, track);
    else if (id === I.Void) walk.zeroPayload(child);
    else walk.void(child); // Name, Language, CodecName, AttachmentLink, CRC-32 and the rest
  }
  if (track.type !== 1 && track.type !== 2) throw refuse("video_tracks");
  if (track.number < 1) throw refuse("bad_video");
  return track;
}

const VIDEO_KEPT = new Set<number>([I.PixelWidth, I.PixelHeight, I.DisplayWidth, I.DisplayHeight, I.DisplayUnit, I.FlagInterlaced, I.AlphaMode, I.PixelCropBottom, I.PixelCropTop, I.PixelCropLeft, I.PixelCropRight, I.Colour]);

async function videoSettings(walk: Walk, el: El, track: Track): Promise<void> {
  let displayWidth: number | undefined;
  let displayHeight: number | undefined;
  const display: El[] = [];
  let unit = 0;
  const once = new Once();
  for await (const child of walk.children(el.dataStart, el.end, 5)) {
    const id = child.id;
    if (VIDEO_KEPT.has(id)) once.take(id);
    if (id === I.PixelWidth) track.width = await walk.uint(child);
    else if (id === I.PixelHeight) track.height = await walk.uint(child);
    else if (id === I.DisplayWidth) {
      displayWidth = await walk.uint(child);
      display.push(child);
    } else if (id === I.DisplayHeight) {
      displayHeight = await walk.uint(child);
      display.push(child);
    } else if (id === I.DisplayUnit) unit = await walk.uint(child);
    else if (id === I.Projection) await projection(walk, child);
    else if (id === I.FlagInterlaced) await walk.uintIn(child, 0, 2);
    else if (id === I.AlphaMode) track.alpha = await walk.uint(child);
    else if (id === I.PixelCropBottom || id === I.PixelCropTop || id === I.PixelCropLeft || id === I.PixelCropRight) {
      if ((await walk.uint(child)) !== 0) throw refuse("video_geometry");
      walk.void(child);
    } else if (id === I.Colour) {
      await walk.keepMaster(child, 5, (leaf, value) => {
        if (leaf === I.TransferCharacteristics) track.transfer = value;
      });
    } else if (id === I.Void) walk.zeroPayload(child);
    else walk.void(child);
  }
  if (track.alpha === 1) throw refuse("video_alpha");
  if (track.alpha !== undefined && track.alpha > 1) throw refuse("bad_video");
  if (track.transfer === 16 || track.transfer === 18) throw refuse("video_hdr");
  if (unit !== 0) throw refuse("video_geometry");
  // Without a pixel size the track list refuses the file as unreadable.
  if (track.width === undefined || track.height === undefined) return;
  const drawn = webmDrawnWidth({ pixelWidth: track.width, pixelHeight: track.height, displayWidth, displayHeight });
  if (drawn === undefined) throw refuse("video_geometry");
  if (drawn !== track.width) track.displayWidthPx = drawn;
  // A display size unlike the pixel size goes, so the stored file plays at its pixel size in every browser and the facts say how to draw it (4.2, 5).
  if ((displayWidth !== undefined && displayWidth !== track.width) || (displayHeight !== undefined && displayHeight !== track.height)) {
    for (const d of display) walk.void(d);
  }
}

const PROJECTION_POSES = new Set<number>([I.ProjectionPoseYaw, I.ProjectionPosePitch, I.ProjectionPoseRoll]);

/**
 * A Projection goes as a Void, as every element off the list does, but is
 * read first: Chromium's WebM parser and FFmpeg turn and mirror the picture
 * by its pose, which the stored file must not keep asking for. So a pose
 * other than zero is `video_geometry` (docs/design/design-v1-video-turns.md
 * 4.2, D-261102-858).
 */
async function projection(walk: Walk, el: El): Promise<void> {
  const once = new Once();
  for await (const child of walk.children(el.dataStart, el.end, 6)) {
    if (!PROJECTION_POSES.has(child.id)) continue;
    once.take(child.id);
    if ((await walk.float(child)) !== 0) throw refuse("video_geometry");
  }
  walk.void(el);
}

const AUDIO_KEPT = new Set<number>([I.SamplingFrequency, I.OutputSamplingFrequency, I.Channels, I.BitDepth]);

async function audioSettings(walk: Walk, el: El, track: Track): Promise<void> {
  const once = new Once();
  for await (const child of walk.children(el.dataStart, el.end, 5)) {
    const id = child.id;
    if (AUDIO_KEPT.has(id)) once.take(id);
    if (id === I.SamplingFrequency || id === I.OutputSamplingFrequency) {
      if ((await walk.float(child)) <= 0) throw refuse("bad_video");
    } else if (id === I.Channels) track.declaredChannels = await walk.uintIn(child, 1, 255);
    else if (id === I.BitDepth) await walk.uintIn(child, 1, 64);
    else if (id === I.Void) walk.zeroPayload(child);
    else walk.void(child);
  }
}

/**
 * Whether a VP8 frame shows: bit 4 of its frame tag, show_frame (RFC 6386
 * 9.1). FFmpeg never sets Matroska's invisible flag, so a VP8 alt-ref is a
 * plain block at its neighbor's time, known only by this bit (D-261102-740).
 * VP9 and AV1 need no such read: FFmpeg packs a hidden VP9 frame into a
 * superframe with the next shown one, and an AV1 Block is one temporal
 * unit, which presents one frame.
 */
async function vp8Shown(walk: Walk, b: El, payloadStart: number): Promise<boolean> {
  if (payloadStart >= b.end) throw refuse("bad_video");
  const tag = await walk.src.read(payloadStart, 1);
  return (tag[0]! & 0x10) !== 0;
}

type BlockRead = { track: Track; relative: number; invisible: boolean; lacing: number; headerLength: number; payloadStart: number };

/** The flag bits the format reserves, which must be clear: a SimpleBlock's three after the key frame bit, and a Block's top four and its last. */
const RESERVED_FLAGS = { simple: 0x70, group: 0xf1 } as const;

/** A block's own header: the track as a VINT of up to 8 bytes, the 2-byte relative timestamp and the flags (AMN-13). */
async function blockHeader(walk: Walk, el: El, tracks: readonly Track[], simple: boolean): Promise<BlockRead> {
  const head = await walk.src.read(el.dataStart, Math.min(11, el.end - el.dataStart));
  const length = vintLength(head[0]);
  if (length > 8 || length + 3 > head.length) throw refuse("bad_video");
  const number = vintValue(head, 0, length);
  const track = tracks.find((t) => t.number === number);
  if (!track) throw refuse("bad_video");
  const relative = head.readInt16BE(length);
  const flags = head[length + 2]!;
  if (flags & RESERVED_FLAGS[simple ? "simple" : "group"]) throw refuse("bad_video");
  return { track, relative, invisible: (flags & 0x08) !== 0, lacing: (flags >> 1) & 3, headerLength: length + 3, payloadStart: el.dataStart + length + 3 };
}

/**
 * A sound block's length in 48 kHz samples, from its packets' TOC bytes,
 * after reading its lacing (Xiph, EBML or fixed). These few payload bytes
 * are the only ones of a block the check reads, and none is written.
 */
async function soundSamples(walk: Walk, el: El, read: BlockRead, packets: Tally): Promise<number> {
  const payloadEnd = el.end;
  let at = read.payloadStart;
  const sizes: number[] = [];
  let count = 1;
  if (read.lacing !== 0) {
    const head = await walk.src.read(at, Math.min(VIDEO_LIMITS.parseValueBytes, payloadEnd - at));
    let i = 0;
    const byte = () => {
      const b = head[i++];
      if (b === undefined) throw refuse("bad_video");
      return b;
    };
    count = byte() + 1;
    if (read.lacing === 1) {
      for (let f = 0; f < count - 1; f++) {
        let size = 0;
        let b: number;
        do {
          b = byte();
          size += b;
        } while (b === 255);
        sizes.push(size);
      }
    } else if (read.lacing === 3) {
      const first = readVintAt(head, i, false);
      i += first.length;
      sizes.push(first.value);
      for (let f = 1; f < count - 1; f++) {
        const diff = readVintAt(head, i, true);
        i += diff.length;
        const next = sizes[sizes.length - 1]! + diff.value;
        if (next < 0) throw refuse("bad_video");
        sizes.push(next);
      }
    }
    at += i;
    if (read.lacing === 2) {
      const each = (payloadEnd - at) / count;
      if (!Number.isInteger(each)) throw refuse("bad_video");
      for (let f = 0; f < count - 1; f++) sizes.push(each);
    }
  }
  const lastSize = payloadEnd - at - sizes.reduce((a, b) => a + b, 0);
  if (lastSize < 0) throw refuse("bad_video");
  sizes.push(lastSize);
  let samples = 0;
  for (const size of sizes) {
    walk.budget.check();
    packets.add();
    if (size < 1) throw refuse("bad_video");
    const toc = await walk.src.read(at, Math.min(2, size));
    samples += opusPacketSamples(toc[0]!, toc[1]);
    at += size;
  }
  return samples;
}

function videoCodecString(track: Track, firstHead: Buffer | undefined, fps: number): string {
  if (track.codecId === "V_VP8") return "vp8";
  if (track.codecId === "V_AV1") return av1CodecString(track.codecPrivate!);
  const declared = track.codecPrivate ? vp9CodecPrivate(track.codecPrivate) : {};
  let facts: Vp9Facts;
  if (declared.profile !== undefined && declared.bitDepth !== undefined) facts = { profile: declared.profile, bitDepth: declared.bitDepth };
  else {
    if (!firstHead) throw refuse("bad_video");
    facts = vp9KeyFrame(firstHead);
  }
  return vp9CodecString({ ...facts, level: declared.level ?? vp9Level(track.width!, track.height!, fps) });
}

/** A VINT's length from its first byte: one more than its leading zeros. A zero byte would make it longer than 8. */
export function vintLength(first: number | undefined): number {
  if (first === undefined || first === 0) return 9;
  return Math.clz32(first) - 23;
}

/** A VINT's value with its marker bit removed, or "unknown" when every value bit is set. */
function vintValue(bytes: Buffer, at: number, length: number): number | "unknown" {
  if (length > 8 || at + length > bytes.length) throw refuse("bad_video");
  let value = bytes[at]! & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = bytes[at + i]!;
    value = value * 256 + b;
    allOnes &&= b === 0xff;
  }
  if (allOnes) return "unknown";
  if (!Number.isSafeInteger(value)) throw refuse("bad_video");
  return value;
}

function readVintAt(bytes: Buffer, at: number, signed: boolean): { value: number; length: number } {
  const length = vintLength(bytes[at]);
  const value = vintValue(bytes, at, length);
  if (value === "unknown") throw refuse("bad_video");
  return { value: signed ? value - (2 ** (7 * length - 1) - 1) : value, length };
}

/** `value` as a VINT of exactly `length` bytes. */
export function encodeVint(value: number, length: number): Buffer {
  if (length < 1 || length > 8 || value >= 2 ** (7 * length) - 1) throw new Error("a VINT too small for its value");
  const out = Buffer.alloc(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}
