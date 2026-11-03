import { VIDEO_LIMITS } from "#shared/limits.ts";
import { OPUS_HZ, av1CodecString, opusHead, opusPacketSamples, peakInOneSecond, vp9CodecPrivate, vp9CodecString, vp9KeyFrame, vp9Level, type Vp9Facts } from "./records.ts";
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

type Leaf = "uint" | "int" | "float" | "zeroString";

/** Leaves kept by type in each master the walk keeps whole: anything else there becomes a Void. */
const UINT_FLAGS = [I.FlagEnabled, I.FlagDefault, I.FlagForced, I.FlagHearingImpaired, I.FlagVisualImpaired, I.FlagTextDescriptions, I.FlagOriginal, I.FlagCommentary, I.FlagLacing];
const COLOUR_UINTS = [0x55b1, 0x55b2, 0x55b3, 0x55b4, 0x55b5, 0x55b6, 0x55b7, 0x55b8, 0x55b9, I.TransferCharacteristics, 0x55bb, 0x55bc, 0x55bd];
const MASTERING_FLOATS = [0x55d1, 0x55d2, 0x55d3, 0x55d4, 0x55d5, 0x55d6, 0x55d7, 0x55d8, 0x55d9, 0x55da];

const KEPT: Record<number, Record<number, Leaf | "master">> = {
  [I.EBML]: { [I.EBMLVersion]: "uint", [I.EBMLReadVersion]: "uint", [I.EBMLMaxIDLength]: "uint", [I.EBMLMaxSizeLength]: "uint", [I.DocTypeVersion]: "uint", [I.DocTypeReadVersion]: "uint" },
  [I.Colour]: { ...Object.fromEntries(COLOUR_UINTS.map((id) => [id, "uint" as const])), [I.MasteringMetadata]: "master" },
  [I.MasteringMetadata]: Object.fromEntries(MASTERING_FLOATS.map((id) => [id, "float" as const])),
  [I.Cues]: { [I.CuePoint]: "master" },
  [I.CuePoint]: { [I.CueTime]: "uint", [I.CueTrackPositions]: "master" },
  [I.CueTrackPositions]: { 0xf7: "uint", 0xf1: "uint", 0xf0: "uint", 0xb2: "uint", 0x5378: "uint", 0xea: "uint", [I.CueReference]: "master" },
  [I.CueReference]: { 0x96: "uint" },
};

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
  transfer?: number;
  alpha?: number;
  channels?: number;
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
   * A master kept whole from KEPT: its listed leaves checked by type, Voids
   * padded, everything else made Void. `seen` hears each number kept.
   */
  async keepMaster(el: El, depth: number, seen?: (id: number, value: number) => void): Promise<void> {
    const allowed = KEPT[el.id] ?? {};
    for await (const child of this.children(el.dataStart, el.end, depth + 1)) {
      const rule = allowed[child.id];
      if (child.id === I.Void) this.zeroPayload(child);
      else if (rule === "master") await this.keepMaster(child, depth + 1, seen);
      else if (rule === "uint") seen?.(child.id, await this.uint(child));
      else if (rule === "int") seen?.(child.id, await this.int(child));
      else if (rule === "float") seen?.(child.id, await this.float(child));
      else if (rule === "zeroString") this.zeroPayload(child);
      else this.void(child);
    }
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

async function ebmlHeader(walk: Walk, el: El): Promise<void> {
  let docType = "matroska";
  for await (const child of walk.children(el.dataStart, el.end, 2)) {
    if (child.id === I.DocType) docType = await walk.string(child);
    else if (child.id === I.EBMLReadVersion && (await walk.uint(child)) !== 1) throw refuse("bad_video");
    else if (child.id === I.EBMLMaxIDLength && (await walk.uint(child)) > 4) throw refuse("bad_video");
    else if (child.id === I.EBMLMaxSizeLength && (await walk.uint(child)) > 8) throw refuse("bad_video");
    else if (child.id === I.DocTypeReadVersion && (await walk.uint(child)) > 4) throw refuse("bad_video");
    else if (child.id === I.Void) walk.zeroPayload(child);
    else if (KEPT[I.EBML]![child.id]) await walk.uint(child);
    else walk.void(child);
  }
  if (docType !== "webm") throw refuse("video_type");
}

type BlockTiming = { duration?: number; discardPadding?: number };

async function parseSegment(walk: Walk, segment: El): Promise<ParsedVideo> {
  let scale: number | undefined;
  let duration: number | undefined;
  let tracks: Track[] | undefined;
  const videoFrames = new Tally(VIDEO_LIMITS.parseVideoFrameHeaders, "video_fps");
  const soundFrames = new Tally(VIDEO_LIMITS.parseSoundFrameHeaders);
  const frameTimes: number[] = [];
  let soundEnd = -Infinity;
  let lastClusterTimestamp = 0;
  let firstVideoHead: Buffer | undefined;

  for await (const el of walk.children(segment.dataStart, segment.end, 2)) {
    if (el.id === I.Void) walk.zeroPayload(el);
    else if (el.id === I.SeekHead) await seekHead(walk, el);
    else if (el.id === I.Info) {
      if (scale !== undefined) throw refuse("bad_video");
      ({ scale, duration } = await info(walk, el));
    } else if (el.id === I.Tracks) {
      if (tracks) throw refuse("bad_video");
      tracks = await trackList(walk, el);
    } else if (el.id === I.Cues) await walk.keepMaster(el, 2);
    else if (el.id === I.Cluster) {
      // Blocks are read by their track, in Info's time scale, so both come first, as every muxer writes them.
      if (scale === undefined || !tracks) throw refuse("bad_video");
      const known = { scale, tracks };
      let timestamp: number | undefined;
      const block = async (b: El, timing: BlockTiming) => {
        if (timestamp === undefined) throw refuse("bad_video");
        const read = await blockHeader(walk, b, known.tracks);
        walk.edits.protect(b.dataStart, b.end);
        const time = (timestamp + read.relative) * known.scale;
        if (read.track.type === 1) {
          videoFrames.add();
          if (read.lacing !== 0) throw refuse("bad_video");
          if (read.invisible) return;
          frameTimes.push(time);
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
          timestamp = await walk.uint(child);
          lastClusterTimestamp = timestamp;
        } else if (child.id === I.SimpleBlock) await block(child, {});
        else if (child.id === I.BlockGroup) {
          let inner: El | undefined;
          const timing: BlockTiming = {};
          for await (const g of walk.children(child.dataStart, child.end, 4)) {
            if (g.id === I.Block) {
              if (inner) throw refuse("bad_video");
              inner = g;
            } else if (g.id === I.BlockDuration) timing.duration = await walk.uint(g);
            else if (g.id === I.ReferenceBlock) await walk.int(g);
            else if (g.id === I.DiscardPadding) timing.discardPadding = await walk.int(g);
            else if (g.id === I.BlockAdditions) throw refuse("video_alpha");
            else if (g.id === I.Void) walk.zeroPayload(g);
            else walk.void(g);
          }
          if (!inner) throw refuse("bad_video");
          await block(inner, timing);
        } else if (child.id === I.PrevSize) await walk.uint(child);
        else if (child.id === I.EncryptedBlock) throw refuse("bad_video");
        else if (child.id === I.Void) walk.zeroPayload(child);
        else walk.void(child);
      }
    } else walk.void(el); // Tags, Attachments, Chapters, CRC-32 and anything unknown
  }

  if (scale === undefined || duration === undefined) throw refuse("video_unfinished");
  if (!tracks) throw refuse("bad_video");
  const video = tracks.find((t) => t.type === 1)!;
  const sound = tracks.find((t) => t.type === 2);
  if (frameTimes.length === 0) throw refuse("bad_video");
  // A Duration the Clusters run past says less than the file holds.
  if (lastClusterTimestamp > duration) throw refuse("video_unfinished");

  const fps = peakInOneSecond(frameTimes, 1e9);
  const first = Math.min(...frameTimes);
  const last = Math.max(...frameTimes);
  const frame = video.defaultDuration ?? (frameTimes.length > 1 ? (last - first) / (frameTimes.length - 1) : 0);
  // Sound may end up to a frame or 50 ms after the picture (AMN-4, AMR-3): AAC and Opus pad their last packet.
  const tolerance = Math.max(frame, VIDEO_LIMITS.soundOverrunMs * 1e6);
  if (sound && soundEnd > last + frame + tolerance) throw refuse("video_layout");

  return {
    container: "webm",
    widthPx: video.width!,
    heightPx: video.height!,
    video: videoCodecString(video, firstVideoHead, fps),
    ...(sound ? { audio: "opus", audioChannels: sound.channels!, audioHz: OPUS_HZ } : {}),
    fps,
    durationMs: Math.round((duration * scale) / 1e6),
    edits: walk.edits,
  };
}

async function seekHead(walk: Walk, el: El): Promise<void> {
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
    const kids: El[] = [];
    for await (const child of walk.children(seek.dataStart, seek.end, 4)) kids.push(child);
    for (const child of kids) {
      if (child.id === I.SeekID) {
        const id = await walk.bytes(child, 4);
        target = id.reduce((v, b) => v * 256 + b, 0);
      }
    }
    // An entry pointing at an element this check drops would point at a Void, so it goes with it.
    if (target === undefined || !SEEKABLE.has(target)) {
      walk.void(seek);
      continue;
    }
    for (const child of kids) {
      if (child.id === I.SeekID) continue;
      if (child.id === I.SeekPosition) await walk.uint(child);
      else if (child.id === I.Void) walk.zeroPayload(child);
      else walk.void(child);
    }
  }
}

async function info(walk: Walk, el: El): Promise<{ scale: number | undefined; duration: number | undefined }> {
  let scale: number | undefined;
  let duration: number | undefined;
  for await (const child of walk.children(el.dataStart, el.end, 3)) {
    if (child.id === I.TimestampScale) {
      scale = await walk.uint(child);
      if (scale <= 0) throw refuse("bad_video");
    } else if (child.id === I.Duration) {
      duration = await walk.float(child);
      if (duration <= 0) throw refuse("bad_video");
    } else if (child.id === I.MuxingApp || child.id === I.WritingApp) walk.zeroPayload(child);
    else if (child.id === I.Void) walk.zeroPayload(child);
    else walk.void(child); // Title, DateUTC, SegmentUUID, SegmentFilename, CRC-32 and the rest
  }
  return { scale, duration };
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
    }
    if (track.codecId === "V_VP8" && track.codecPrivate) throw refuse("bad_video");
    if (track.codecId === "V_AV1" && !track.codecPrivate) throw refuse("bad_video");
  }
  return tracks;
}

async function trackEntry(walk: Walk, el: El): Promise<Track> {
  const kids: El[] = [];
  for await (const child of walk.children(el.dataStart, el.end, 4)) kids.push(child);
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
    else if (id === I.TrackUID || UINT_FLAGS.includes(id as (typeof UINT_FLAGS)[number]) || id === I.SeekPreRoll) await walk.uint(child);
    else if (id === I.DefaultDuration) track.defaultDuration = await walk.uint(child);
    else if (id === I.CodecDelay) track.codecDelay = await walk.uint(child);
    else if (id === I.CodecPrivate) {
      // Vorbis's comment header is free text, never read: the track is refused once the tracks are counted.
      if (track.codecId === "A_VORBIS") continue;
      if (child.end - child.dataStart > VIDEO_LIMITS.parseValueBytes) track.codecPrivateTooLong = true;
      else track.codecPrivate = await walk.bytes(child);
    } else if (id === I.ContentEncodings) throw refuse("bad_video");
    else if (id === I.Video && track.type === 1) await videoSettings(walk, child, track);
    else if (id === I.Audio && track.type === 2) await audioSettings(walk, child);
    else if (id === I.Void) walk.zeroPayload(child);
    else walk.void(child); // Name, Language, CodecName, AttachmentLink, CRC-32 and the rest
  }
  if (track.type !== 1 && track.type !== 2) throw refuse("video_tracks");
  if (track.number < 1) throw refuse("bad_video");
  return track;
}

async function videoSettings(walk: Walk, el: El, track: Track): Promise<void> {
  let displayWidth: number | undefined;
  let displayHeight: number | undefined;
  let unit = 0;
  for await (const child of walk.children(el.dataStart, el.end, 5)) {
    const id = child.id;
    if (id === I.PixelWidth) track.width = await walk.uint(child);
    else if (id === I.PixelHeight) track.height = await walk.uint(child);
    else if (id === I.DisplayWidth) displayWidth = await walk.uint(child);
    else if (id === I.DisplayHeight) displayHeight = await walk.uint(child);
    else if (id === I.DisplayUnit) unit = await walk.uint(child);
    else if (id === I.FlagInterlaced) await walk.uint(child);
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
  if (track.transfer === 16 || track.transfer === 18) throw refuse("video_hdr");
  if (unit !== 0) throw refuse("video_geometry");
  if ((displayWidth !== undefined && displayWidth !== track.width) || (displayHeight !== undefined && displayHeight !== track.height)) throw refuse("video_geometry");
}

async function audioSettings(walk: Walk, el: El): Promise<void> {
  for await (const child of walk.children(el.dataStart, el.end, 5)) {
    const id = child.id;
    if (id === I.SamplingFrequency || id === I.OutputSamplingFrequency) {
      if ((await walk.float(child)) <= 0) throw refuse("bad_video");
    } else if (id === I.Channels || id === I.BitDepth) await walk.uint(child);
    else if (id === I.Void) walk.zeroPayload(child);
    else walk.void(child);
  }
}

type BlockRead = { track: Track; relative: number; invisible: boolean; lacing: number; headerLength: number; payloadStart: number };

/** A block's own header: the track as a VINT of up to 8 bytes, the 2-byte relative timestamp and the flags (AMN-13). */
async function blockHeader(walk: Walk, el: El, tracks: readonly Track[]): Promise<BlockRead> {
  const head = await walk.src.read(el.dataStart, Math.min(11, el.end - el.dataStart));
  const length = vintLength(head[0]);
  if (length > 8 || length + 3 > head.length) throw refuse("bad_video");
  const number = vintValue(head, 0, length);
  const track = tracks.find((t) => t.number === number);
  if (!track) throw refuse("bad_video");
  const relative = head.readInt16BE(length);
  const flags = head[length + 2]!;
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
