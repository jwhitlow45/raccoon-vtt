import { EBML_ID as I, encodeVint } from "./webm.ts";

/**
 * The test writer (docs/design/design-v1-animated-maps.md 12): WebM
 * elements and MP4 boxes built byte by byte, so every parser test names
 * exactly the file it checks. Each builder answers a tree the test may
 * change before it is encoded. The fixture script (scripts/video-fixtures.ts)
 * uses the same writer to turn a browser's recording into a plain file.
 */

// WebM ------------------------------------------------------------------------

export type Ebml = { id: number; data?: Buffer; kids?: Ebml[]; unknownSize?: boolean; sizeLength?: number };

export const el = (id: number, ...kids: Ebml[]): Ebml => ({ id, kids });
export const bin = (id: number, data: Buffer): Ebml => ({ id, data });
export const str = (id: number, text: string): Ebml => ({ id, data: Buffer.from(text, "utf8") });
export function uint(id: number, value: number): Ebml {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return { id, data: Buffer.from(bytes) };
}
export function sint(id: number, value: number): Ebml {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(value));
  let at = 0;
  while (at < 7 && ((b[at] === 0 && !(b[at + 1]! & 0x80)) || (b[at] === 0xff && b[at + 1]! & 0x80))) at++;
  return { id, data: b.subarray(at) };
}
export function float(id: number, value: number, bytes: 4 | 8 = 8): Ebml {
  const b = Buffer.alloc(bytes);
  if (bytes === 4) b.writeFloatBE(value);
  else b.writeDoubleBE(value);
  return { id, data: b };
}

function idBytes(id: number): Buffer {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(out);
}

function sizeBytes(size: number, length?: number): Buffer {
  let n = length ?? 1;
  while (size >= 2 ** (7 * n) - 1) n++;
  return encodeVint(size, n);
}

export function encodeEbml(node: Ebml): Buffer {
  const payload = node.data ?? Buffer.concat((node.kids ?? []).map(encodeEbml));
  const size = node.unknownSize ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : sizeBytes(payload.length, node.sizeLength);
  return Buffer.concat([idBytes(node.id), size, payload]);
}

export function encodeWebm(top: Ebml[]): Buffer {
  return Buffer.concat(top.map(encodeEbml));
}

/** The first node by a path of ids below `root` (a node's children, or a list), for a test to change. */
export function findEbml(root: Ebml | Ebml[], ...path: number[]): Ebml {
  let nodes = Array.isArray(root) ? root : (root.kids ?? []);
  let found: Ebml | undefined;
  for (const id of path) {
    found = nodes.find((n) => n.id === id);
    if (!found) throw new Error(`no element 0x${id.toString(16)} on the path`);
    nodes = found.kids ?? [];
  }
  return found!;
}

/** A SimpleBlock's payload: track, relative timestamp, flags, then the frame. */
export function simpleBlock(track: number, relative: number, flags: number, frame: Buffer, trackVintLength = 1): Ebml {
  const head = Buffer.alloc(3);
  head.writeInt16BE(relative, 0);
  head[2] = flags;
  return bin(I.SimpleBlock, Buffer.concat([encodeVint(track, trackVintLength), head, frame]));
}

export function block(track: number, relative: number, flags: number, frame: Buffer): Ebml {
  const head = Buffer.alloc(3);
  head.writeInt16BE(relative, 0);
  head[2] = flags;
  return bin(I.Block, Buffer.concat([encodeVint(track, 1), head, frame]));
}

/** A VP9 key frame's first bytes (profile 0, 8 bit, shown), then filler the parser must never touch. */
export function vp9Key(fill = 64, seed = 1): Buffer {
  return Buffer.concat([Buffer.from([0x82, 0x49, 0x83, 0x42, 0x00]), filler(fill, seed)]);
}

export function vp9Inter(fill = 32, seed = 2): Buffer {
  return Buffer.concat([Buffer.from([0x86, 0x00]), filler(fill, seed)]);
}

/** Bytes that look like media data, a fixed pattern from `seed`. */
export function filler(n: number, seed = 1): Buffer {
  const out = Buffer.alloc(n);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** OpusHead for WebM's CodecPrivate: version 1, stereo, 312 samples of pre-skip, 48 kHz, family 0. */
export function opusHeadBytes(channels = 2, preSkip = 312): Buffer {
  const b = Buffer.alloc(19);
  b.write("OpusHead", 0, "latin1");
  b[8] = 1;
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  b.writeInt16LE(0, 16);
  b[18] = 0;
  return b;
}

/** One Opus packet: a CELT 20 ms full-band TOC (config 31, code 0), 960 samples, then filler. */
export const OPUS_20MS = 0xf8;

export type WebmOptions = {
  width?: number;
  height?: number;
  codec?: "V_VP8" | "V_VP9" | "V_AV1" | string;
  codecPrivate?: Buffer;
  /** Frame times in ms from the start. Default: 2 s at 30 fps. */
  frameMs?: number[];
  scale?: number;
  /** Info's Duration in ms. Default: the last frame plus one frame. */
  durationMs?: number | null;
  /** Sound blocks: each a start in ms and its packets' TOC bytes. Default: none. */
  sound?: { blocks: Array<{ ms: number; tocs?: number[] }>; codecDelayNs?: number; codec?: string; codecPrivate?: Buffer } | null;
  /** Frames per Cluster. Default: one Cluster per second. */
  clusterMs?: number;
  trackVintLength?: number;
};

/**
 * A plain WebM: the EBML header, then one Segment with a SeekHead, Info,
 * Tracks, Clusters of SimpleBlocks and Cues. The tree comes back unencoded,
 * so a test can add a Title, Tags, a CRC-32 or anything else first.
 */
export function webmTree(o: WebmOptions = {}): Ebml[] {
  const width = o.width ?? 640;
  const height = o.height ?? 360;
  const scale = o.scale ?? 1_000_000;
  const frames = o.frameMs ?? Array.from({ length: 60 }, (_, i) => Math.round((i * 1000) / 30));
  const frameGap = frames.length > 1 ? frames[frames.length - 1]! - frames[frames.length - 2]! : 33;
  const durationMs = o.durationMs === undefined ? frames[frames.length - 1]! + frameGap : o.durationMs;
  const toTicks = (ms: number) => Math.round((ms * 1e6) / scale);
  const clusterMs = o.clusterMs ?? 1000;

  const videoTrack = el(
    I.TrackEntry,
    uint(I.TrackNumber, 1),
    uint(I.TrackUID, 0x1234),
    uint(I.TrackType, 1),
    str(I.CodecID, o.codec ?? "V_VP9"),
    ...(o.codecPrivate ? [bin(I.CodecPrivate, o.codecPrivate)] : []),
    el(I.Video, uint(I.PixelWidth, width), uint(I.PixelHeight, height)),
  );
  const tracks = [videoTrack];
  const sound = o.sound ?? null;
  if (sound) {
    tracks.push(
      el(
        I.TrackEntry,
        uint(I.TrackNumber, 2),
        uint(I.TrackUID, 0x5678),
        uint(I.TrackType, 2),
        str(I.CodecID, sound.codec ?? "A_OPUS"),
        bin(I.CodecPrivate, sound.codecPrivate ?? opusHeadBytes()),
        uint(I.CodecDelay, sound.codecDelayNs ?? 6_500_000),
        uint(I.SeekPreRoll, 80_000_000),
        el(I.Audio, float(I.SamplingFrequency, 48000), uint(I.Channels, 2)),
      ),
    );
  }

  type Item = { ms: number; node: (cluster: number) => Ebml };
  const items: Item[] = frames.map((ms, i) => ({
    ms,
    node: (cluster) => simpleBlock(1, toTicks(ms) - cluster, i === 0 ? 0x80 : 0, i === 0 ? vp9Key(64, i + 1) : vp9Inter(32, i + 1), o.trackVintLength ?? 1),
  }));
  for (const [i, b] of (sound?.blocks ?? []).entries()) {
    const tocs = b.tocs ?? [OPUS_20MS];
    const frame = Buffer.concat(tocs.map((t, k) => Buffer.concat([Buffer.from([t]), filler(3, 1000 + i * 8 + k)])));
    const lacing = tocs.length > 1 ? 0x04 : 0; // fixed lacing, frames of equal size
    const laced = tocs.length > 1 ? Buffer.concat([Buffer.from([tocs.length - 1]), frame]) : frame;
    items.push({ ms: b.ms, node: (cluster) => simpleBlock(2, toTicks(b.ms) - cluster, 0x80 | lacing, laced) });
  }
  items.sort((a, b) => a.ms - b.ms);
  const clusters: Ebml[] = [];
  let current: { start: number; kids: Ebml[] } | undefined;
  for (const item of items) {
    if (!current || item.ms - current.start >= clusterMs) {
      if (current) clusters.push(el(I.Cluster, ...current.kids));
      current = { start: item.ms, kids: [uint(I.Timestamp, toTicks(item.ms))] };
    }
    current.kids.push(item.node(toTicks(current.start)));
  }
  if (current) clusters.push(el(I.Cluster, ...current.kids));

  const info = el(I.Info, uint(I.TimestampScale, scale), ...(durationMs === null ? [] : [float(I.Duration, toTicks(durationMs))]), str(I.MuxingApp, "raccoon test writer"), str(I.WritingApp, "raccoon test writer"));
  return [
    el(I.EBML, uint(I.EBMLVersion, 1), uint(I.EBMLReadVersion, 1), uint(I.EBMLMaxIDLength, 4), uint(I.EBMLMaxSizeLength, 8), str(I.DocType, "webm"), uint(I.DocTypeVersion, 4), uint(I.DocTypeReadVersion, 2)),
    el(I.Segment, el(I.SeekHead, el(I.Seek, bin(I.SeekID, Buffer.from([0x15, 0x49, 0xa9, 0x66])), uint(I.SeekPosition, 0))), info, el(I.Tracks, ...tracks), ...clusters, el(I.Cues, el(I.CuePoint, uint(I.CueTime, 0), el(0xb7, uint(0xf7, 1), uint(0xf1, 0))))),
  ];
}

export function webmFile(o: WebmOptions = {}): Buffer {
  return encodeWebm(webmTree(o));
}

/** Every Segment child of a tree with an id, for a test to add to. */
export function segmentOf(tree: Ebml[]): Ebml {
  return findEbml(tree, I.Segment);
}

/** Every element below `root` with this id, depth first. */
export function allEbml(root: Ebml | Ebml[], id: number): Ebml[] {
  const nodes = Array.isArray(root) ? root : [root];
  return nodes.flatMap((n) => [...(n.id === id ? [n] : []), ...allEbml(n.kids ?? [], id)]);
}

/** Identifying text a phone or an editor could leave, which no stored file may hold. */
export const SECRETS = {
  title: "Secret Lair of Ser Pemberton",
  date: "DateUTC was here",
  tag: "Recorded at 221B Baker Street",
  crc: "CRC holding a name",
  void: "Void still holding Alice Example",
  name: "Track named by Bob Example",
  attachment: "attached-cover-of-Carol.jpg",
  chapter: "Chapter by Dave Example",
  location: "+51.5237-000.1585/",
  handler: "Handler named by Erin Example",
  compressor: "Frank's Encoder",
  free: "free box holding Grace Example",
  icc: "ICC profile by Heidi Example",
  udta: "User data of Ivan Example",
  tmcd: "Reel of Judy Example",
} as const;

/** A WebM with every kind of identifying text 7 names, in each place a tool may leave it. */
export function webmWithSecrets(o: WebmOptions = {}): Ebml[] {
  const tree = webmTree(o);
  const seg = segmentOf(tree);
  const info = findEbml(seg, I.Info);
  info.kids!.push(str(I.Title, SECRETS.title), bin(I.DateUTC, Buffer.from(SECRETS.date)), bin(I.CRC32, Buffer.from(SECRETS.crc)), str(I.SegmentFilename, SECRETS.attachment));
  const track = findEbml(seg, I.Tracks, I.TrackEntry);
  track.kids!.push(str(I.Name, SECRETS.name), str(I.CodecName, SECRETS.name), str(I.Language, "eng"));
  seg.kids!.splice(1, 0, bin(I.Void, Buffer.from(SECRETS.void)));
  seg.kids!.push(
    el(I.Tags, el(I.Tag, el(I.SimpleTag, str(I.TagName, "LOCATION"), str(I.TagString, SECRETS.tag)))),
    el(I.Attachments, el(0x61a7, str(0x466e, SECRETS.attachment), str(0x4660, "image/jpeg"), bin(0x465c, Buffer.from(SECRETS.attachment)))),
    el(I.Chapters, el(0x45b9, el(0xb6, uint(0x73c4, 1), uint(0x91, 0), el(0x80, str(0x85, SECRETS.chapter))))),
    bin(I.CRC32, Buffer.from(SECRETS.crc)),
  );
  // A SeekHead entry pointing at the Tags, which goes with them.
  findEbml(seg, I.SeekHead).kids!.push(el(I.Seek, bin(I.SeekID, Buffer.from([0x12, 0x54, 0xc3, 0x67])), uint(I.SeekPosition, 1)));
  return tree;
}

// MP4 -------------------------------------------------------------------------

export type Box = { type: string; head?: Buffer; kids?: Box[]; large?: boolean; usertype?: Buffer; sizeZero?: boolean };

export const bx = (type: string, head?: Buffer, ...kids: Box[]): Box => ({ type, ...(head ? { head } : {}), ...(kids.length ? { kids } : {}) });

export function encodeBox(b: Box): Buffer {
  const body = Buffer.concat([b.usertype ?? Buffer.alloc(0), b.head ?? Buffer.alloc(0), ...(b.kids ?? []).map(encodeBox)]);
  const type = Buffer.from(b.type, "latin1");
  if (b.large) {
    const h = Buffer.alloc(16);
    h.writeUInt32BE(1, 0);
    type.copy(h, 4);
    h.writeBigUInt64BE(BigInt(16 + body.length), 8);
    return Buffer.concat([h, body]);
  }
  const h = Buffer.alloc(8);
  h.writeUInt32BE(b.sizeZero ? 0 : 8 + body.length, 0);
  type.copy(h, 4);
  return Buffer.concat([h, body]);
}

/** The first box by a path of types below `root` (a box's children, or a list). */
export function findBox(root: Box | Box[], ...path: string[]): Box {
  let nodes = Array.isArray(root) ? root : (root.kids ?? []);
  let found: Box | undefined;
  for (const type of path) {
    found = nodes.find((n) => n.type === type);
    if (!found) throw new Error(`no box ${type} on the path`);
    nodes = found.kids ?? [];
  }
  return found!;
}

/** Big-endian fields, each [bytes, value], for fixed box layouts. */
export function fields(...parts: Array<[1 | 2 | 3 | 4 | 8, number | bigint] | Buffer>): Buffer {
  return Buffer.concat(
    parts.map((p) => {
      if (Buffer.isBuffer(p)) return p;
      const [n, v] = p;
      const b = Buffer.alloc(n);
      if (n === 8) b.writeBigUInt64BE(BigInt(v));
      else b.writeUIntBE(Number(v), 0, n);
      return b;
    }),
  );
}

const full = (version: number, flags = 0) => fields([1, version], [3, flags]);

export const IDENTITY_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

/** An avcC as FFmpeg writes Baseline: one SPS and one PPS, no High extension. */
export function avcCBytes(profile = 0x42, extension?: Buffer): Buffer {
  const sps = Buffer.from([0x67, profile, 0xc0, 0x1e, 0xd9, 0x01, 0x40, 0x16, 0xec, 0x04, 0x40]);
  const pps = Buffer.from([0x68, 0xcb, 0x83, 0xcb, 0x20]);
  return Buffer.concat([Buffer.from([1, profile, 0xc0, 0x1e, 0xff, 0xe1]), fields([2, sps.length]), sps, Buffer.from([1]), fields([2, pps.length]), pps, extension ?? Buffer.alloc(0)]);
}

/** An av1C for Main profile, level 3.0 (08), 8 bit, with one sequence header OBU. */
export function av1CBytes(obus: Buffer = Buffer.from([0x0a, 0x0b, 0x00, 0x00, 0x00, 0x24, 0xcf, 0x7f, 0x0d, 0xbf, 0xff, 0x30, 0x08])): Buffer {
  return Buffer.concat([Buffer.from([0x81, 0x08, 0x0c, 0x00]), obus]);
}

/** FFmpeg's 48 kHz stereo AAC-LC AudioSpecificConfig, with its SBR-absent sync extension (AM-ASTRA-27). */
export const FFMPEG_AAC_LC = Buffer.from([0x11, 0x90, 0x56, 0xe5, 0x00]);

function descriptor(tag: number, body: Buffer): Buffer {
  const n = body.length;
  return Buffer.concat([Buffer.from([tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f]), body]);
}

/** An esds as FFmpeg writes it, with the parts a test may change. */
export function esdsBytes(o: { asc?: Buffer; esFlags?: number; oti?: number; afterInfo?: Buffer; sl?: number; extraEs?: Buffer } = {}): Buffer {
  const config = descriptor(0x04, Buffer.concat([Buffer.from([o.oti ?? 0x40, 0x15]), fields([3, 0], [4, 128000], [4, 128000]), descriptor(0x05, o.asc ?? FFMPEG_AAC_LC), o.afterInfo ?? Buffer.alloc(0)]));
  const es = descriptor(0x03, Buffer.concat([fields([2, 2]), Buffer.from([o.esFlags ?? 0]), o.extraEs ?? Buffer.alloc(0), config, descriptor(0x06, Buffer.from([o.sl ?? 2]))]));
  return Buffer.concat([full(0), es]);
}

/** MP4's dOps: version 0, stereo, 312 samples of pre-skip, 48 kHz, family 0. */
export function dOpsBytes(): Buffer {
  return fields([1, 0], [1, 2], [2, 312], [4, 48000], [2, 0], [1, 0]);
}

export function visualEntry(type: string, width: number, height: number, compressor = "", ...kids: Box[]): Box {
  const name = Buffer.alloc(32);
  name[0] = Math.min(31, compressor.length);
  name.write(compressor.slice(0, 31), 1, "latin1");
  return bx(type, fields(Buffer.alloc(6), [2, 1], [2, 0], [2, 0], Buffer.alloc(12), [2, width], [2, height], [4, 0x480000], [4, 0x480000], [4, 0], [2, 1], name, [2, 0x18], [2, 0xffff]), ...kids);
}

export function audioEntry(type: string, channels: number, hz: number, ...kids: Box[]): Box {
  return bx(type, fields(Buffer.alloc(6), [2, 1], [2, 0], [2, 0], [4, 0], [2, channels], [2, 16], [2, 0], [2, 0], [4, hz * 0x10000]), ...kids);
}

export type Mp4Sample = { size: number; delta: number; cts?: number; bytes?: Buffer };

export type Mp4Track = {
  handler: string;
  entry: Box;
  timescale: number;
  samples: Mp4Sample[];
  /** One edit (segment in the movie's timescale, media time), several, or none. */
  edits?: Array<{ segment: number; mediaTime: number; rate?: number }>;
  matrix?: number[];
  tkhdSize?: { width: number; height: number };
  handlerName?: string;
  extraTrak?: Box[];
  extraStbl?: Box[];
  extraMinf?: Box[];
  /** Samples per chunk. Default: the whole track in one chunk. */
  chunkSamples?: number;
};

export type Mp4Options = {
  tracks?: Mp4Track[];
  movieTimescale?: number;
  /** mvhd's duration in its timescale. Default: the longest track's. */
  movieDuration?: number;
  brand?: string;
  /** Boxes between ftyp and moov, and inside moov after the tracks. */
  beforeMoov?: Box[];
  inMoov?: Box[];
  /** Boxes after mdat. */
  afterMdat?: Box[];
  /** moov after mdat, as many cameras write it. */
  moovLast?: boolean;
};

/** 2 s of 30 fps H.264 Baseline at 640 x 360, in a 15360 timescale as FFmpeg writes it. */
export function defaultVideoTrack(o: Partial<Mp4Track> & { width?: number; height?: number; frames?: number; delta?: number } = {}): Mp4Track {
  const width = o.width ?? 640;
  const height = o.height ?? 360;
  const frames = o.frames ?? 60;
  return {
    handler: "vide",
    entry: visualEntry("avc1", width, height, "", bx("avcC", avcCBytes()), bx("pasp", fields([4, 1], [4, 1]))),
    timescale: 15360,
    samples: Array.from({ length: frames }, (_, i) => ({ size: i === 0 ? 120 : 40, delta: o.delta ?? 512 })),
    ...o,
  };
}

/** AAC-LC at 48 kHz in 1024-sample frames, with FFmpeg's priming edit of 1024 samples, ending with the video. */
export function defaultSoundTrack(o: Partial<Mp4Track> & { seconds?: number } = {}): Mp4Track {
  const seconds = o.seconds ?? 2;
  const frames = Math.ceil((seconds * 48000 + 1024) / 1024);
  return {
    handler: "soun",
    entry: audioEntry("mp4a", 2, 48000, bx("esds", esdsBytes())),
    timescale: 48000,
    samples: Array.from({ length: frames }, () => ({ size: 12, delta: 1024 })),
    edits: [{ segment: Math.round(seconds * 1000), mediaTime: 1024 }],
    ...o,
  };
}

function trakBox(t: Mp4Track, id: number, movieTimescale: number, chunkOffsets: number[]): Box {
  const mediaTicks = t.samples.reduce((s, x) => s + x.delta, 0);
  const segmentTotal = t.edits?.reduce((s, e) => s + e.segment, 0) ?? Math.round((mediaTicks / t.timescale) * movieTimescale);
  const size = t.tkhdSize ?? (t.handler === "vide" ? { width: t.entry.head!.readUInt16BE(24), height: t.entry.head!.readUInt16BE(26) } : { width: 0, height: 0 });
  const matrix = Buffer.concat((t.matrix ?? IDENTITY_MATRIX).map((v) => fields([4, v >>> 0])));
  const tkhd = bx("tkhd", Buffer.concat([full(0, 3), fields([4, 0x7a6b5c4d], [4, 0x7a6b5c4e], [4, id], [4, 0], [4, segmentTotal], Buffer.alloc(8), [2, 0], [2, 0], [2, t.handler === "soun" ? 0x100 : 0], [2, 0]), matrix, fields([4, size.width * 0x10000], [4, size.height * 0x10000])]));
  const per = t.chunkSamples ?? t.samples.length;
  const stts: Array<[number, number]> = [];
  for (const s of t.samples) {
    const last = stts[stts.length - 1];
    if (last && last[1] === s.delta) last[0]++;
    else stts.push([1, s.delta]);
  }
  const hasCts = t.samples.some((s) => s.cts !== undefined);
  const stbl = bx(
    "stbl",
    undefined,
    bx("stsd", Buffer.concat([full(0), fields([4, 1])]), t.entry),
    bx("stts", Buffer.concat([full(0), fields([4, stts.length]), ...stts.map(([n, d]) => fields([4, n], [4, d]))])),
    ...(hasCts ? [bx("ctts", Buffer.concat([full(0), fields([4, t.samples.length]), ...t.samples.map((s) => fields([4, 1], [4, s.cts ?? 0]))]))] : []),
    bx("stsc", Buffer.concat([full(0), ...(() => {
      const whole = Math.floor(t.samples.length / per);
      const rest = t.samples.length % per;
      const runs = [fields([4, 1], [4, per], [4, 1]), ...(rest && whole ? [fields([4, whole + 1], [4, rest], [4, 1])] : [])];
      if (!whole) runs[0] = fields([4, 1], [4, rest], [4, 1]);
      return [fields([4, runs.length]), ...runs];
    })()])),
    bx("stsz", Buffer.concat([full(0), fields([4, 0], [4, t.samples.length]), ...t.samples.map((s) => fields([4, s.size]))])),
    bx("stco", Buffer.concat([full(0), fields([4, chunkOffsets.length]), ...chunkOffsets.map((o) => fields([4, o]))])),
    ...(t.extraStbl ?? []),
  );
  const handlerName = Buffer.concat([Buffer.from(t.handlerName ?? "", "latin1"), Buffer.from([0])]);
  const header = t.handler === "vide" ? [bx("vmhd", Buffer.concat([full(0, 1), Buffer.alloc(8)]))] : t.handler === "soun" ? [bx("smhd", Buffer.concat([full(0), Buffer.alloc(4)]))] : [];
  const minf = bx("minf", undefined, ...header, bx("dinf", undefined, bx("dref", Buffer.concat([full(0), fields([4, 1])]), bx("url ", full(0, 1)))), stbl, ...(t.extraMinf ?? []));
  const mdia = bx(
    "mdia",
    undefined,
    bx("mdhd", Buffer.concat([full(0), fields([4, 0x7a6b5c4d], [4, 0x7a6b5c4e], [4, t.timescale], [4, mediaTicks], [2, 0x55c4], [2, 0])])),
    bx("hdlr", Buffer.concat([full(0), fields([4, 0]), Buffer.from(t.handler, "latin1"), Buffer.alloc(12), handlerName])),
    minf,
  );
  const edts = t.edits
    ? [bx("edts", undefined, bx("elst", Buffer.concat([full(0), fields([4, t.edits.length]), ...t.edits.map((e) => Buffer.concat([fields([4, e.segment]), (() => { const b = Buffer.alloc(4); b.writeInt32BE(e.mediaTime); return b; })(), fields([4, e.rate ?? 0x10000])]))])))]
    : [];
  return bx("trak", undefined, tkhd, ...edts, mdia, ...(t.extraTrak ?? []));
}

/**
 * A plain MP4: ftyp, moov, then one mdat holding every track's samples,
 * each track its own run of chunks. Two passes, so the chunk offsets point
 * at where the samples land.
 */
export function mp4File(o: Mp4Options = {}): Buffer {
  const tracks = o.tracks ?? [defaultVideoTrack()];
  const movieTimescale = o.movieTimescale ?? 1000;
  const ftyp = bx("ftyp", Buffer.concat([Buffer.from(o.brand ?? "isom", "latin1"), fields([4, 0x200]), Buffer.from("isomiso2avc1mp41", "latin1")]));
  const samples = tracks.flatMap((t, ti) => t.samples.map((s, i) => s.bytes ?? filler(s.size, ti * 100000 + i + 1)));
  const mdatPayload = Buffer.concat(samples);
  const build = (mdatStart: number) => {
    let at = mdatStart;
    const traks = tracks.map((t, i) => {
      const per = t.chunkSamples ?? t.samples.length;
      const offsets: number[] = [];
      for (let k = 0; k < t.samples.length; k++) {
        if (k % per === 0) offsets.push(at);
        at += t.samples[k]!.size;
      }
      return trakBox(t, i + 1, movieTimescale, offsets);
    });
    const longest = Math.max(...tracks.map((t) => (t.edits ? t.edits.reduce((s, e) => s + e.segment, 0) : Math.round((t.samples.reduce((s, x) => s + x.delta, 0) / t.timescale) * movieTimescale))));
    const mvhd = bx("mvhd", Buffer.concat([full(0), fields([4, 0x7a6b5c4d], [4, 0x7a6b5c4e], [4, movieTimescale], [4, o.movieDuration ?? longest], [4, 0x10000], [2, 0x100], Buffer.alloc(10)), ...IDENTITY_MATRIX.map((v) => fields([4, v])), Buffer.alloc(24), fields([4, tracks.length + 1])]));
    return bx("moov", undefined, mvhd, ...traks, ...(o.inMoov ?? []));
  };
  const before = [ftyp, ...(o.beforeMoov ?? [])].map(encodeBox);
  const beforeBytes = before.reduce((s, b) => s + b.length, 0);
  if (o.moovLast) {
    const mdatStart = beforeBytes + 8;
    const moov = encodeBox(build(mdatStart));
    return Buffer.concat([...before, encodeBox(bx("mdat", mdatPayload)), ...(o.afterMdat ?? []).map(encodeBox), moov]);
  }
  const moovSize = encodeBox(build(0)).length;
  const moov = encodeBox(build(beforeBytes + moovSize + 8));
  return Buffer.concat([...before, moov, encodeBox(bx("mdat", mdatPayload)), ...(o.afterMdat ?? []).map(encodeBox)]);
}

/** A phone's location atom, `©xyz`, in udta, as iPhones and Android cameras write it. */
export function locationUdta(text: string = SECRETS.location): Box {
  return bx("udta", undefined, bx("©xyz", Buffer.concat([fields([2, text.length], [2, 0x15c7]), Buffer.from(text, "latin1")])));
}

/** A QuickTime metadata box with `com.apple.quicktime.location.ISO6709`. */
export function appleLocationMeta(text: string = SECRETS.location): Box {
  const key = "com.apple.quicktime.location.ISO6709";
  return bx(
    "meta",
    full(0),
    bx("hdlr", Buffer.concat([full(0), fields([4, 0]), Buffer.from("mdta", "latin1"), Buffer.alloc(12), Buffer.from([0])])),
    bx("keys", Buffer.concat([full(0), fields([4, 1], [4, 8 + key.length]), Buffer.from("mdta", "latin1"), Buffer.from(key, "latin1")])),
    bx("ilst", undefined, { type: "\u0000\u0000\u0000\u0001", kids: [bx("data", Buffer.concat([fields([4, 1], [4, 0]), Buffer.from(text, "latin1")]))] }),
  );
}
