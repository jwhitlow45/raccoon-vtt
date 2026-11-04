import assert from "node:assert/strict";
import { EBML_ID as I, encodeVint } from "./webm.ts";

/**
 * The test writer (docs/design/design-v1-animated-maps.md 12): WebM
 * elements and MP4 boxes built byte by byte, so every parser test names
 * exactly the file it checks. Each builder answers a tree the test may
 * change before it is encoded. The fixture script (scripts/video-fixtures.ts)
 * uses the same writer to turn a browser's recording into a plain file.
 */

// WebM ------------------------------------------------------------------------

/**
 * One element. `at` makes it a four-byte position: the place of that element
 * from its Segment's data, which the writer fills in as it encodes, so a
 * test may add elements anywhere and the SeekHead and Cues still point
 * where they should.
 */
export type Ebml = { id: number; data?: Buffer; kids?: Ebml[]; unknownSize?: boolean; sizeLength?: number; at?: Ebml };

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

/** An element's encoded length, without encoding it. */
function ebmlLength(node: Ebml): number {
  const payload = node.data ? node.data.length : (node.kids ?? []).reduce((n, k) => n + ebmlLength(k), 0);
  return idBytes(node.id).length + (node.unknownSize ? 8 : sizeBytes(payload, node.sizeLength).length) + payload;
}

/** Fills every position below each Segment with its element's place from the Segment's data. */
function placePositions(top: Ebml[]): void {
  for (const segment of top.filter((n) => n.id === I.Segment)) {
    const places = new Map<Ebml, number>();
    let offset = 0;
    for (const kid of segment.kids ?? []) {
      places.set(kid, offset);
      offset += ebmlLength(kid);
    }
    const fill = (node: Ebml) => {
      if (node.at) {
        const place = places.get(node.at);
        if (place === undefined) throw new Error("a position names an element outside its Segment's children");
        node.data = fixed4(place);
      }
      for (const kid of node.kids ?? []) fill(kid);
    };
    fill(segment);
  }
}

export function encodeWebm(top: Ebml[]): Buffer {
  placePositions(top);
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

/** A VP8 key frame's first bytes (RFC 6386 9.1): a frame tag with show_frame set, the start code and the size, then filler. */
export function vp8Key(fill = 64, seed = 1, width = 640, height = 360): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt16LE(width, 0);
  size.writeUInt16LE(height, 2);
  return Buffer.concat([Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), size, filler(fill, seed)]);
}

/** A VP8 inter frame's tag, shown unless `shown` is false, as an alt-ref is, then filler. */
export function vp8Inter(fill = 32, seed = 2, shown = true): Buffer {
  return Buffer.concat([Buffer.from([shown ? 0x11 : 0x01, 0x02, 0x00]), filler(fill, seed)]);
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
  /** Each frame's payload in bytes after its header, for a file of a given size. Default: 64 for the key frame and 32 for the rest. */
  frameBytes?: number;
  /** Real frames, a recording's, in place of the synthetic ones `frameMs` makes. */
  frames?: Array<{ ms: number; key: boolean; data: Buffer }>;
  /** More children of the video track's Video element, such as a display size or a Projection. */
  videoKids?: Ebml[];
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
  const frames = o.frames?.map((f) => f.ms) ?? o.frameMs ?? Array.from({ length: 60 }, (_, i) => Math.round((i * 1000) / 30));
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
    el(I.Video, uint(I.PixelWidth, width), uint(I.PixelHeight, height), ...(o.videoKids ?? [])),
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
  const items: Item[] = frames.map((ms, i) => {
    const real = o.frames?.[i];
    const key = real ? real.key : i === 0;
    const vp8 = o.codec === "V_VP8";
    const synthetic = i === 0 ? (vp8 ? vp8Key(o.frameBytes ?? 64, i + 1, width, height) : vp9Key(o.frameBytes ?? 64, i + 1)) : vp8 ? vp8Inter(o.frameBytes ?? 32, i + 1) : vp9Inter(o.frameBytes ?? 32, i + 1);
    const data = real ? real.data : synthetic;
    return { ms, node: (cluster) => simpleBlock(1, toTicks(ms) - cluster, key ? 0x80 : 0, data, o.trackVintLength ?? 1) };
  });
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
  const trackList = el(I.Tracks, ...tracks);
  const cues = el(
    I.Cues,
    ...clusters.map((c) => el(I.CuePoint, { id: I.CueTime, data: fixed4(findEbml(c, I.Timestamp).data!.readUIntBE(0, findEbml(c, I.Timestamp).data!.length)) }, el(0xb7, uint(0xf7, 1), { id: 0xf1, data: fixed4(0), at: c }))),
  );
  // Positions are four bytes each, filled in as the tree is encoded (placePositions).
  const at = (target: Ebml) => el(I.Seek, bin(I.SeekID, idBytes(target.id)), { id: I.SeekPosition, data: fixed4(0), at: target });
  const seekHead = el(I.SeekHead, at(info), at(trackList), at(cues));
  return [
    el(I.EBML, uint(I.EBMLVersion, 1), uint(I.EBMLReadVersion, 1), uint(I.EBMLMaxIDLength, 4), uint(I.EBMLMaxSizeLength, 8), str(I.DocType, "webm"), uint(I.DocTypeVersion, 4), uint(I.DocTypeReadVersion, 2)),
    el(I.Segment, seekHead, info, trackList, ...clusters, cues),
  ];
}

function fixed4(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
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
  face: "Face of Mallory Example at 0.41 0.22",
  device: "Phone of Niaj Example",
} as const;

/**
 * A Projection element (Matroska's 0x7670) with its type and its pose in
 * degrees, as a 360 or a turned WebM carries one
 * (docs/design/design-v1-video-turns.md 4.2): ProjectionType 0x7671, then
 * PoseYaw, PosePitch and PoseRoll, 0x7673 to 0x7675.
 */
export function projectionEl(pose: { yaw?: number; pitch?: number; roll?: number } = {}, type = 0): Ebml {
  return el(0x7670, uint(0x7671, type), float(0x7673, pose.yaw ?? 0, 4), float(0x7674, pose.pitch ?? 0, 4), float(0x7675, pose.roll ?? 0, 4));
}

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

/** A QuickTime version 1 sound entry (docs/design/design-v1-video-turns.md 4.5): its compression ID and four counts after the version 0 fields. */
export function audioEntryV1(type: string, channels: number, hz: number, o: { compressionId?: number; samplesPerPacket?: number; bytesPerPacket?: number; bytesPerFrame?: number; bytesPerSample?: number; version?: number } = {}, ...kids: Box[]): Box {
  return bx(
    type,
    fields(Buffer.alloc(6), [2, 1], [2, o.version ?? 1], [2, 0], [4, 0], [2, channels], [2, 16], [2, o.compressionId ?? 0xfffe], [2, 0], [4, hz * 0x10000], [4, o.samplesPerPacket ?? 1024], [4, o.bytesPerPacket ?? 0], [4, o.bytesPerFrame ?? 0], [4, o.bytesPerSample ?? 2]),
    ...kids,
  );
}

/** QuickTime's `wave` around AAC's `esds`, as FFmpeg and Apple write it: `frma`, an `mp4a` of four zero bytes, the `esds` and a terminator. */
export function waveBox(esds: Buffer = esdsBytes(), ...extra: Box[]): Box {
  return bx("wave", undefined, bx("frma", Buffer.from("mp4a", "latin1")), bx("mp4a", Buffer.alloc(4)), bx("esds", esds), ...extra, { type: "\0\0\0\0" });
}

/** A `pasp` of h:v. */
export const paspBox = (h: number, v: number): Box => bx("pasp", fields([4, h], [4, v]));

/** A `clap` of width wN/wD, height hN/hD and offsets xN/xD, yN/yD, the offsets signed. */
export function clapBox(wN: number, wD: number, hN: number, hD: number, xN = 0, xD = 1, yN = 0, yD = 1): Box {
  return bx("clap", fields(...[wN, wD, hN, hD, xN, xD, yN, yD].map((v): [4, number] => [4, v >>> 0])));
}

/** A MOV's `tapt` with its clean, production and encoded sizes in pixels. */
export function taptBox(clef: [number, number], prof: [number, number] = clef, enof: [number, number] = clef): Box {
  const size = (type: string, [w, h]: [number, number]) => bx(type, fields([4, 0], [4, w * 0x10000], [4, h * 0x10000]));
  return bx("tapt", undefined, size("clef", clef), size("prof", prof), size("enof", enof));
}

/** QuickTime's `colr` of type `nclc`: primaries, transfer and matrix, without nclx's range byte. */
export const nclcBox = (primaries = 1, transfer = 1, matrix = 1): Box => bx("colr", Buffer.concat([Buffer.from("nclc", "latin1"), fields([2, primaries], [2, transfer], [2, matrix])]));

/** QuickTime's `alis` data reference to the file itself: the self-reference flag and nothing else. */
export const alisRef = (): Box => bx("alis", full(0, 1));

/** The matrix of one of 4.1's rows (a, b, c, d in units), with its translation in raw 16.16. */
export function tkhdMatrix(row: { a: number; b: number; c: number; d: number }, tx = 0, ty = 0): number[] {
  return [row.a * 0x10000, row.b * 0x10000, 0, row.c * 0x10000, row.d * 0x10000, 0, tx, ty, 0x40000000];
}

/**
 * One raw data block of AAC-LC stereo that decodes to silence: a channel
 * pair with no common window, each channel's global gain 0 and no scale
 * factor bands, then the end element (ISO 14496-3 4.4.2). Worked out bit by
 * bit, so a fixture's sound plays without an encoder.
 */
export const SILENT_AAC_STEREO = Buffer.from([0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0e]);

/**
 * A timed metadata track, handler `meta` with one `mebx` entry, as an
 * iPhone writes for detected faces and the still image's time
 * (docs/design/design-v1-video-turns.md 4.5). Its keys name what it holds.
 */
export function metadataTrack(o: Partial<Mp4Track> & { samples: Mp4Sample[]; keys?: string[] }): Mp4Track {
  const keys = (o.keys ?? ["com.apple.quicktime.detected-face"]).map((key, i) => ({
    type: String.fromCharCode(0, 0, 0, i + 1),
    kids: [bx("keyd", Buffer.concat([Buffer.from("mdta", "latin1"), Buffer.from(key, "latin1")])), bx("dtyp", fields([4, 0], [4, 0]))],
  }));
  const { keys: _keys, ...rest } = o;
  return { handler: "meta", entry: bx("mebx", fields(Buffer.alloc(6), [2, 1]), bx("keys", undefined, ...keys)), timescale: 600, ...rest };
}

export type Mp4Sample = { size: number; delta: number; cts?: number; bytes?: Buffer; key?: boolean };

export type Mp4Track = {
  handler: string;
  entry: Box;
  timescale: number;
  samples: Mp4Sample[];
  /** One edit (segment in the movie's timescale, media time), several, or none. */
  edits?: Array<{ segment: number; mediaTime: number; rate?: number }>;
  matrix?: number[];
  tkhdSize?: { width: number; height: number };
  /** tkhd's size in raw 16.16, for a size that is not whole pixels. */
  tkhdRaw?: { width: number; height: number };
  /** tkhd's flags. Default: enabled and in the movie. */
  tkhdFlags?: number;
  handlerName?: string;
  /** The data references. Default: one `url ` to the file itself. */
  dataRefs?: Box[];
  extraTrak?: Box[];
  extraStbl?: Box[];
  extraMinf?: Box[];
  /** Samples per chunk. Default: the whole track in one chunk. */
  chunkSamples?: number;
  /** The chunk offsets in place of where the writer puts the samples, given the mdat payload and those defaults. */
  chunkOffsets?: (layout: { mdat: { start: number; end: number }; defaults: number[] }) => number[];
};

export type Mp4Options = {
  tracks?: Mp4Track[];
  movieTimescale?: number;
  /** mvhd's duration in its timescale. Default: the longest track's. */
  movieDuration?: number;
  brand?: string;
  /** ftyp's compatible brands. Default: isom, iso2, avc1 and mp41. */
  compatible?: string[];
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
  const raw = t.tkhdRaw ?? { width: size.width * 0x10000, height: size.height * 0x10000 };
  const matrix = Buffer.concat((t.matrix ?? IDENTITY_MATRIX).map((v) => fields([4, v >>> 0])));
  const tkhd = bx("tkhd", Buffer.concat([full(0, t.tkhdFlags ?? 3), fields([4, 0x7a6b5c4d], [4, 0x7a6b5c4e], [4, id], [4, 0], [4, segmentTotal], Buffer.alloc(8), [2, 0], [2, 0], [2, t.handler === "soun" ? 0x100 : 0], [2, 0]), matrix, fields([4, raw.width], [4, raw.height])]));
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
    // Sync samples, when any sample is not one: a recording's inter frames.
    ...(t.samples.some((x) => x.key === false)
      ? [bx("stss", Buffer.concat([full(0), fields([4, t.samples.filter((x) => x.key !== false).length]), ...t.samples.flatMap((x, i) => (x.key !== false ? [fields([4, i + 1])] : []))]))]
      : []),
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
  const refs = t.dataRefs ?? [bx("url ", full(0, 1))];
  const minf = bx("minf", undefined, ...header, bx("dinf", undefined, bx("dref", Buffer.concat([full(0), fields([4, refs.length])]), ...refs)), stbl, ...(t.extraMinf ?? []));
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
  const ftyp = bx("ftyp", Buffer.concat([Buffer.from(o.brand ?? "isom", "latin1"), fields([4, 0x200]), Buffer.from((o.compatible ?? ["isom", "iso2", "avc1", "mp41"]).join(""), "latin1")]));
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
      const placed = t.chunkOffsets ? t.chunkOffsets({ mdat: { start: mdatStart, end: mdatStart + mdatPayload.length }, defaults: offsets }) : offsets;
      return trakBox(t, i + 1, movieTimescale, placed);
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

/** QuickTime metadata with one key for each entry, as an iPhone writes its place, its model and its software. */
export function appleMeta(entries: Array<[key: string, value: string]>): Box {
  return bx(
    "meta",
    full(0),
    bx("hdlr", Buffer.concat([full(0), fields([4, 0]), Buffer.from("mdta", "latin1"), Buffer.alloc(12), Buffer.from([0])])),
    bx("keys", Buffer.concat([full(0), fields([4, entries.length]), ...entries.map(([key]) => Buffer.concat([fields([4, 8 + key.length]), Buffer.from("mdta", "latin1"), Buffer.from(key, "latin1")]))])),
    bx("ilst", undefined, ...entries.map(([, value], i) => ({ type: String.fromCharCode(0, 0, 0, i + 1), kids: [bx("data", Buffer.concat([fields([4, 1], [4, 0]), Buffer.from(value, "latin1")]))] }))),
  );
}

/** The four rows an iPhone or Android camera, Apple's editors and FFmpeg write most, from 4.1's table. */
export const ROWS = {
  turn90: { a: 0, b: 1, c: -1, d: 0 },
  turn180: { a: -1, b: 0, c: 0, d: -1 },
  turn270: { a: 0, b: -1, c: 1, d: 0 },
  turn270Mirror: { a: 0, b: -1, c: -1, d: 0 },
} as const;

/** A visual sample entry with any colour box swapped for QuickTime's `nclc`, whether its children are boxes or bytes after the fixed 78. */
function withNclc(entry: Box): Box {
  const head = entry.head!;
  const kept = rawBoxes(head, 78, head.length).filter((b) => b.type !== "colr").map((b) => head.subarray(b.start, b.end));
  return { type: entry.type, head: Buffer.concat([head.subarray(0, 78), ...kept]), kids: [...(entry.kids ?? []).filter((k) => k.type !== "colr"), nclcBox()] };
}

/**
 * An iPhone's Most Compatible MOV as public reports describe one
 * (docs/design/design-v1-video-turns.md 2 and 4.5), its strings made up:
 * the `qt  ` brand, `alis` data references, an `nclc` colour, AAC in a
 * version 1 sound entry inside `wave` with a `chan`, a `tapt` at the
 * turned size, two timed metadata tracks holding a face and a place (the
 * second starting with an empty edit), the movie's `meta` and `udta` with a
 * place and the phone, and the 90 row with Apple's translation (H, 0).
 * `video` is the picture's track, which keeps its samples.
 */
export function iphoneMov(video: Mp4Track = defaultVideoTrack()): Buffer {
  const width = video.entry.head!.readUInt16BE(24);
  const height = video.entry.head!.readUInt16BE(26);
  const picture: Mp4Track = { ...video, entry: withNclc(video.entry), matrix: tkhdMatrix(ROWS.turn90, height * 0x10000, 0), dataRefs: [alisRef()], handlerName: SECRETS.device, extraTrak: [taptBox([height, width])] };
  const aac = defaultSoundTrack();
  const sound: Mp4Track = {
    ...aac,
    entry: audioEntryV1("mp4a", 2, 48000, {}, waveBox(), bx("chan", Buffer.alloc(24))),
    samples: aac.samples.map((s) => ({ ...s, size: SILENT_AAC_STEREO.length, bytes: SILENT_AAC_STEREO })),
    dataRefs: [alisRef()],
    handlerName: SECRETS.device,
  };
  const text = (s: string) => Buffer.from(s, "latin1");
  const faces = metadataTrack({ samples: Array.from({ length: 4 }, () => ({ size: SECRETS.face.length, delta: 300, bytes: text(SECRETS.face) })), handlerName: SECRETS.device });
  const place = metadataTrack({
    keys: ["com.apple.quicktime.still-image-time", "com.apple.quicktime.location.ISO6709"],
    samples: [{ size: SECRETS.location.length, delta: 600, bytes: text(SECRETS.location) }],
    edits: [{ segment: 500, mediaTime: -1 }, { segment: 1000, mediaTime: 0 }],
  });
  return mp4File({
    brand: "qt  ",
    compatible: ["qt  "],
    tracks: [picture, sound, faces, place],
    inMoov: [appleMeta([["com.apple.quicktime.location.ISO6709", SECRETS.location], ["com.apple.quicktime.model", SECRETS.device], ["com.apple.quicktime.software", "17.4"]]), locationUdta()],
  });
}

// Recordings ------------------------------------------------------------------

/** One EBML header at `at`: an unknown size, as a recording writes it, reads as Infinity. */
function ebmlHead(bytes: Buffer, at: number): { id: number; dataStart: number; end: number } {
  const idLength = Math.clz32(bytes[at]!) - 23;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[at + i]!;
  const sizeAt = at + idLength;
  const sizeLength = Math.clz32(bytes[sizeAt]!) - 23;
  let size = bytes[sizeAt]! & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + bytes[sizeAt + i]!;
    unknown &&= bytes[sizeAt + i] === 0xff;
  }
  const dataStart = sizeAt + sizeLength;
  return { id, dataStart, end: unknown ? Infinity : dataStart + size };
}

function ebmlKids(bytes: Buffer, start: number, end: number): Array<{ id: number; dataStart: number; end: number }> {
  const out = [];
  for (let at = start; at < end; ) {
    const h = ebmlHead(bytes, at);
    out.push(h);
    at = h.end;
  }
  return out;
}

const uintOf = (bytes: Buffer, h: { dataStart: number; end: number }) => bytes.subarray(h.dataStart, h.end).reduce((v, b) => v * 256 + b, 0);

export type Recording = { codecId: string; codecPrivate?: Buffer; width: number; height: number; frames: Array<{ ms: number; key: boolean; data: Buffer }> };

/**
 * The video frames of a browser's WebM recording. Chrome's MediaRecorder
 * writes the Segment and each Cluster with an unknown size, and no Duration
 * or Cues, which the server refuses as unfinished, so the walk steps into
 * both and reads each block where it lies.
 */
export function readWebmRecording(bytes: Buffer): Recording {
  let scale = 1_000_000;
  let track: { number: number; codecId: string; codecPrivate?: Buffer; width: number; height: number } | undefined;
  let clusterTimestamp = 0;
  const frames: Recording["frames"] = [];
  for (let at = 0; at < bytes.length; ) {
    const h = ebmlHead(bytes, at);
    if (h.id === I.Segment || h.id === I.Cluster) {
      at = h.dataStart;
      continue;
    }
    if (h.end === Infinity) throw new Error(`an unknown size on 0x${h.id.toString(16)}`);
    if (h.id === I.Info) {
      for (const k of ebmlKids(bytes, h.dataStart, h.end)) if (k.id === I.TimestampScale) scale = uintOf(bytes, k);
    } else if (h.id === I.Tracks) {
      for (const entry of ebmlKids(bytes, h.dataStart, h.end)) {
        const t = { number: 0, type: 0, codecId: "", codecPrivate: undefined as Buffer | undefined, width: 0, height: 0 };
        for (const k of ebmlKids(bytes, entry.dataStart, entry.end)) {
          if (k.id === I.TrackNumber) t.number = uintOf(bytes, k);
          else if (k.id === I.TrackType) t.type = uintOf(bytes, k);
          else if (k.id === I.CodecID) t.codecId = bytes.subarray(k.dataStart, k.end).toString("latin1");
          else if (k.id === I.CodecPrivate) t.codecPrivate = Buffer.from(bytes.subarray(k.dataStart, k.end));
          else if (k.id === I.Video) {
            for (const v of ebmlKids(bytes, k.dataStart, k.end)) {
              if (v.id === I.PixelWidth) t.width = uintOf(bytes, v);
              else if (v.id === I.PixelHeight) t.height = uintOf(bytes, v);
            }
          }
        }
        if (t.type === 1 && !track) track = t;
      }
    } else if (h.id === I.Timestamp) {
      clusterTimestamp = uintOf(bytes, h);
    } else if ((h.id === I.SimpleBlock || h.id === I.BlockGroup) && track) {
      // A BlockGroup's Block is a key frame when no ReferenceBlock names an earlier one.
      const kids = h.id === I.BlockGroup ? ebmlKids(bytes, h.dataStart, h.end) : [];
      const b = h.id === I.SimpleBlock ? h : kids.find((k) => k.id === I.Block);
      if (kids.some((k) => k.id === I.BlockAdditions)) throw new Error("the recording has block additions, such as an alpha plane");
      if (b) {
        const length = Math.clz32(bytes[b.dataStart]!) - 23;
        const number = bytes[b.dataStart]! & (0xff >> length);
        if (number === track.number) {
          const relative = bytes.readInt16BE(b.dataStart + length);
          const flags = bytes[b.dataStart + length + 2]!;
          const key = h.id === I.SimpleBlock ? (flags & 0x80) !== 0 : !kids.some((k) => k.id === I.ReferenceBlock);
          frames.push({ ms: ((clusterTimestamp + relative) * scale) / 1e6, key, data: Buffer.from(bytes.subarray(b.dataStart + length + 3, b.end)) });
        }
      }
    }
    at = h.end;
  }
  if (!track) throw new Error("the recording has no video track");
  return { codecId: track.codecId, ...(track.codecPrivate ? { codecPrivate: track.codecPrivate } : {}), width: track.width, height: track.height, frames };
}

type RawBox = { type: string; start: number; payload: number; end: number };

function rawBoxes(bytes: Buffer, start: number, end: number): RawBox[] {
  const out: RawBox[] = [];
  for (let at = start; at + 8 <= end; ) {
    let size = bytes.readUInt32BE(at);
    let payload = at + 8;
    if (size === 1) {
      size = Number(bytes.readBigUInt64BE(at + 8));
      payload = at + 16;
    } else if (size === 0) size = end - at;
    out.push({ type: bytes.subarray(at + 4, at + 8).toString("latin1"), start: at, payload, end: at + size });
    at += size;
  }
  return out;
}

const child = (bytes: Buffer, box: RawBox, ...path: string[]): RawBox => {
  let found = box;
  for (const type of path) {
    const next = rawBoxes(bytes, found.payload, found.end).find((b) => b.type === type);
    if (!next) throw new Error(`no ${type} in ${found.type}`);
    found = next;
  }
  return found;
};

export type Mp4Recording = { entry: Box; timescale: number; width: number; height: number; samples: Array<Required<Pick<Mp4Sample, "size" | "delta" | "bytes" | "key">> & { cts: number }> };

/**
 * The video samples of a browser's MP4 recording, or of a plain MP4 such as
 * a fixture. Chrome's MediaRecorder writes a fragmented MP4, which the
 * server refuses, so each fragment's `trun` is read for its samples' sizes,
 * durations, offsets and sync flags, against the defaults in `tfhd` and
 * `trex`. A plain file's come from its sample tables.
 */
export function readMp4Recording(bytes: Buffer): Mp4Recording {
  const top = rawBoxes(bytes, 0, bytes.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov");
  const trak = rawBoxes(bytes, moov.payload, moov.end)
    .filter((b) => b.type === "trak")
    .find((t) => bytes.subarray(child(bytes, t, "mdia", "hdlr").payload + 8, child(bytes, t, "mdia", "hdlr").payload + 12).toString("latin1") === "vide");
  if (!trak) throw new Error("no video track");
  const tkhd = child(bytes, trak, "tkhd");
  const trackId = bytes.readUInt32BE(tkhd.payload + (bytes[tkhd.payload] === 1 ? 20 : 12));
  const mdhd = child(bytes, trak, "mdia", "mdhd");
  const timescale = bytes.readUInt32BE(mdhd.payload + (bytes[mdhd.payload] === 1 ? 20 : 12));
  const stsd = child(bytes, trak, "mdia", "minf", "stbl", "stsd");
  const entryBox = rawBoxes(bytes, stsd.payload + 8, stsd.end)[0]!;
  const entry: Box = { type: entryBox.type, head: Buffer.from(bytes.subarray(entryBox.payload, entryBox.end)) };
  const width = entry.head!.readUInt16BE(24);
  const height = entry.head!.readUInt16BE(26);
  let defaults = { duration: 0, size: 0, flags: 0 };
  const mvex = rawBoxes(bytes, moov.payload, moov.end).find((b) => b.type === "mvex");
  for (const trex of mvex ? rawBoxes(bytes, mvex.payload, mvex.end).filter((b) => b.type === "trex") : []) {
    if (bytes.readUInt32BE(trex.payload + 4) === trackId) defaults = { duration: bytes.readUInt32BE(trex.payload + 12), size: bytes.readUInt32BE(trex.payload + 16), flags: bytes.readUInt32BE(trex.payload + 20) };
  }
  const samples: Mp4Recording["samples"] = [];
  if (!top.some((b) => b.type === "moof")) return { entry, timescale, width, height, samples: plainSamples(bytes, child(bytes, trak, "mdia", "minf", "stbl")) };
  for (const moof of top.filter((b) => b.type === "moof")) {
    for (const traf of rawBoxes(bytes, moof.payload, moof.end).filter((b) => b.type === "traf")) {
      const tfhd = child(bytes, traf, "tfhd");
      const tfFlags = bytes.readUIntBE(tfhd.payload + 1, 3);
      if (bytes.readUInt32BE(tfhd.payload + 4) !== trackId) continue;
      let at = tfhd.payload + 8;
      let base = moof.start;
      if (tfFlags & 0x1) {
        base = Number(bytes.readBigUInt64BE(at));
        at += 8;
      }
      if (tfFlags & 0x2) at += 4;
      const own = { ...defaults };
      if (tfFlags & 0x8) (own.duration = bytes.readUInt32BE(at)), (at += 4);
      if (tfFlags & 0x10) (own.size = bytes.readUInt32BE(at)), (at += 4);
      if (tfFlags & 0x20) (own.flags = bytes.readUInt32BE(at)), (at += 4);
      for (const trun of rawBoxes(bytes, traf.payload, traf.end).filter((b) => b.type === "trun")) {
        const version = bytes[trun.payload]!;
        const flags = bytes.readUIntBE(trun.payload + 1, 3);
        const count = bytes.readUInt32BE(trun.payload + 4);
        let p = trun.payload + 8;
        let offset = base;
        if (flags & 0x1) (offset = base + bytes.readInt32BE(p)), (p += 4);
        let first: number | undefined;
        if (flags & 0x4) (first = bytes.readUInt32BE(p)), (p += 4);
        for (let i = 0; i < count; i++) {
          let duration = own.duration;
          let size = own.size;
          let sampleFlags = i === 0 && first !== undefined ? first : own.flags;
          let cts = 0;
          if (flags & 0x100) (duration = bytes.readUInt32BE(p)), (p += 4);
          if (flags & 0x200) (size = bytes.readUInt32BE(p)), (p += 4);
          if (flags & 0x400) (sampleFlags = bytes.readUInt32BE(p)), (p += 4);
          if (flags & 0x800) (cts = version === 1 ? bytes.readInt32BE(p) : bytes.readUInt32BE(p)), (p += 4);
          samples.push({ size, delta: duration, cts, bytes: Buffer.from(bytes.subarray(offset, offset + size)), key: (sampleFlags & 0x10000) === 0 });
          offset += size;
        }
      }
    }
  }
  return { entry, timescale, width, height, samples };
}

function plainSamples(bytes: Buffer, stbl: RawBox): Mp4Recording["samples"] {
  const table = (type: string) => rawBoxes(bytes, stbl.payload, stbl.end).find((b) => b.type === type);
  const u32 = (box: RawBox, i: number) => bytes.readUInt32BE(box.payload + 4 + i * 4);
  const stsz = table("stsz")!;
  const count = u32(stsz, 1);
  const sizes = Array.from({ length: count }, (_, i) => (u32(stsz, 0) || u32(stsz, 2 + i)));
  const deltas: number[] = [];
  const stts = table("stts")!;
  for (let e = 0; e < u32(stts, 0); e++) for (let k = 0; k < u32(stts, 1 + e * 2); k++) deltas.push(u32(stts, 2 + e * 2));
  const offsets: number[] = new Array<number>(count).fill(0);
  const ctts = table("ctts");
  if (ctts) {
    let i = 0;
    for (let e = 0; e < u32(ctts, 0); e++) for (let k = 0; k < u32(ctts, 1 + e * 2); k++) offsets[i++] = u32(ctts, 2 + e * 2);
  }
  const stss = table("stss");
  const sync = stss ? new Set(Array.from({ length: u32(stss, 0) }, (_, i) => u32(stss, 1 + i))) : null;
  const stco = table("stco")!;
  const stsc = table("stsc")!;
  const runs = Array.from({ length: u32(stsc, 0) }, (_, i) => [u32(stsc, 1 + i * 3), u32(stsc, 2 + i * 3)] as const);
  const out: Mp4Recording["samples"] = [];
  let sample = 0;
  for (let chunk = 1; chunk <= u32(stco, 0); chunk++) {
    const per = [...runs].reverse().find(([firstChunk]) => firstChunk <= chunk)![1];
    let at = u32(stco, chunk);
    for (let k = 0; k < per && sample < count; k++, sample++) {
      out.push({ size: sizes[sample]!, delta: deltas[sample]!, cts: offsets[sample]!, bytes: Buffer.from(bytes.subarray(at, at + sizes[sample]!)), key: sync ? sync.has(sample + 1) : true });
      at += sizes[sample]!;
    }
  }
  return out;
}

/**
 * A real WebM, such as e2e/fixtures/map-loop.webm, rebuilt with every kind
 * of identifying text 7 names added (a Title, DateUTC, Tags, CRC-32
 * elements, a Void and a track name holding text), for the check to clear.
 */
export function webmWithSecretsFrom(bytes: Buffer): Buffer {
  const rec = readWebmRecording(bytes);
  const last = rec.frames.at(-1)!.ms;
  return encodeWebm(webmWithSecrets({ width: rec.width, height: rec.height, codec: rec.codecId, ...(rec.codecPrivate ? { codecPrivate: rec.codecPrivate } : {}), frames: rec.frames, durationMs: Math.ceil(last / 1000) * 1000 }));
}

/**
 * A real MP4, such as e2e/fixtures/map-loop.mp4, rebuilt with a phone's
 * location atoms, a handler name, a compressor name and padding holding text.
 */
export function mp4WithSecretsFrom(bytes: Buffer): Buffer {
  const rec = readMp4Recording(bytes);
  const head = Buffer.from(rec.entry.head!);
  head[42] = SECRETS.compressor.length;
  head.write(SECRETS.compressor, 43, "latin1");
  return mp4File({
    tracks: [{ handler: "vide", entry: { type: rec.entry.type, head }, timescale: rec.timescale, samples: rec.samples, handlerName: SECRETS.handler, extraTrak: [locationUdta(), appleLocationMeta()] }],
    beforeMoov: [bx("free", Buffer.from(SECRETS.free))],
    inMoov: [locationUdta(), appleLocationMeta()],
  });
}

// Growth ----------------------------------------------------------------------

/**
 * The heavy tests compare the work at the caps with the work at an eighth of
 * them, rather than time it against a fixed budget: a slow or shared test
 * machine stretches both alike, so the ratio proves the same thing on any
 * machine. Linear work grows about 8 times, and the quadratic work these tests
 * guard against (every edit against every media range, every sample against
 * every mdat) 64 times. 20 leaves room for noise either way.
 */
export const GROWTH_SCALE = 8;
export const NEAR_LINEAR_GROWTH = 20;

/**
 * Asserts that `cpuMsAt(scale)`, the CPU time of the work at 1/scale of the
 * caps, grows near linearly from an eighth to the whole, and that the whole
 * stays under `backstopMs`, a cap no runner comes near. One eighth runs first
 * and is dropped, so every timed run finds the code warm. The eighth takes
 * the least of two runs, since noise only ever adds time, and runs before
 * the whole, so it never pays for collecting the whole's garbage.
 */
export async function assertNearLinear(what: string, cpuMsAt: (scale: number) => Promise<number>, backstopMs: number): Promise<void> {
  await cpuMsAt(GROWTH_SCALE);
  const eighth = Math.min(await cpuMsAt(GROWTH_SCALE), await cpuMsAt(GROWTH_SCALE));
  const whole = await cpuMsAt(1);
  const growth = whole / Math.max(eighth, 0.1);
  const read = `${what} took ${whole.toFixed(1)} ms of CPU at the caps and ${eighth.toFixed(1)} ms at an eighth`;
  assert.ok(growth < NEAR_LINEAR_GROWTH, `${read}, ${growth.toFixed(1)} times: not near linear`);
  assert.ok(whole < backstopMs, `${read}, over the ${backstopMs} ms backstop`);
}
