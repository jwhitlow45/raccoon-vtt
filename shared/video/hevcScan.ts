import { VIDEO_LIMITS } from "#shared/limits.ts";

/**
 * HEVC said from a file's first and last MiB (AMROT-O-06), shared so the server's differential test reads the same code the device runs. An iPhone's
 * default MOV is HEVC, which the server refuses as `video_hevc` only once
 * the whole file, up to 64 MB, has gone up, maybe over cellular.
 *
 * The video track's sample entry sits in `moov`, at the start of a file made
 * for streaming and at the end of a phone's, so the scan reads the file's
 * first and last MiB, never more, and walks the boxes the way
 * server/assets/video/mp4.ts does to its HEVC check: `ftyp` first, one
 * `moov`, an `mdat`, then the first video track's one `stsd` entry. A file
 * those bytes cannot decide (a `moov` in neither part, or a box the server
 * would call malformed) answers null, and the upload goes on as before, so
 * the server stays the judge. Only the four HEVC entries refuse.
 *
 * So the scan calls a file HEVC only where the server, reading the same
 * boxes, reaches that entry or refuses the file sooner for another reason.
 * It never refuses a file the server would take
 * (server/assets/video/hevcScan.differential.test.ts).
 */

/** How much of each end of the file the scan reads. */
export const SCAN_BYTES = 1024 * 1024;

/** The sample entries the server refuses as `video_hevc`: HEVC, and Dolby Vision over HEVC (server/assets/video/mp4.ts HEVC_ENTRIES). */
export const HEVC_ENTRIES: ReadonlySet<string> = new Set(["hvc1", "hev1", "dvh1", "dvhe"]);

/** Top-level boxes of a fragmented file, which the server refuses as `video_fragmented` before it reads `moov`. */
const FRAGMENTED = new Set(["moof", "mfra", "sidx", "ssix", "styp", "emsg", "prft", "mvex"]);

/** Bytes of the file read from `start`. */
export type FilePart = { start: number; bytes: Uint8Array };

type Box = { type: string; start: number; end: number; payload: number };

/** The bytes `[at, at + length)`, or null when no one part holds them all. */
type Read = (at: number, length: number) => Uint8Array | null;

/** The parts the scan reads: the whole file up to two MiB, where the first and last MiB meet, else each end's MiB. */
export function scanRanges(size: number): Array<[start: number, end: number]> {
  if (size <= 2 * SCAN_BYTES) return [[0, size]];
  return [
    [0, SCAN_BYTES],
    [size - SCAN_BYTES, size],
  ];
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

function fourCc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
}

/** A box header at `at` inside `[.., parentEnd)`, by the server's rules (mp4.ts boxHeader), or null for one it would refuse. */
function boxAt(read: Read, at: number, parentEnd: number, topLevel: boolean): Box | null {
  if (parentEnd - at < 8) return null;
  const head = read(at, 8);
  if (!head) return null;
  const size32 = u32(head, 0);
  const type = fourCc(head, 4);
  let size: number;
  let afterType = at + 8;
  if (size32 === 1) {
    if (parentEnd - at < 16) return null;
    const large = read(at + 8, 8);
    if (!large) return null;
    const high = u32(large, 0);
    // Past 2^53 the size is no number the server takes.
    if (high >= 0x200000) return null;
    size = high * 0x1_0000_0000 + u32(large, 4);
    afterType = at + 16;
  } else if (size32 === 0) {
    if (!topLevel) return null;
    size = parentEnd - at;
  } else {
    size = size32;
  }
  const payload = afterType + (type === "uuid" ? 16 : 0);
  const end = at + size;
  if (end < payload || end > parentEnd) return null;
  return { type, start: at, end, payload };
}

/** Every child of `parent` from `from`, or null when one is malformed: the server reads all of a box's children before any of them. */
function children(read: Read, parent: Box, from = parent.payload): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at < parent.end) {
    const box = boxAt(read, at, parent.end, false);
    if (!box) return null;
    out.push(box);
    at = box.end;
  }
  return out;
}

/** The one child of a type a box may hold once, or null for none or two. */
function only(boxes: readonly Box[], type: string): Box | null {
  const found = boxes.filter((b) => b.type === type);
  return found.length === 1 ? found[0]! : null;
}

/** A FullBox's version and flags, which the server's `full(box, 0)` needs to be zero. */
function plainFull(read: Read, box: Box): boolean {
  const head = box.end - box.payload >= 4 ? read(box.payload, 4) : null;
  return head !== null && head.every((b) => b === 0);
}

/**
 * The first video track's sample entry type, such as "avc1" or "hvc1", from
 * the parts of a file of `size` bytes, or null when they do not decide it.
 */
export function videoSampleEntry(parts: readonly FilePart[], size: number): string | null {
  const read: Read = (at, length) => {
    for (const part of parts) {
      if (at >= part.start && at + length <= part.start + part.bytes.length) return part.bytes.subarray(at - part.start, at - part.start + length);
    }
    return null;
  };
  let moov: Box | null = null;
  let mdat = false;
  // Every top-level header must lie in a part, so the walk follows the file's own sizes from its first byte to its last.
  for (let at = 0; at < size; ) {
    const box = boxAt(read, at, size, true);
    if (!box) return null;
    if ((at === 0) !== (box.type === "ftyp")) return null;
    if (box.type === "moov") {
      if (moov || box.end - box.start > VIDEO_LIMITS.parseMoovBytes) return null;
      moov = box;
    } else if (box.type === "mdat") mdat = true;
    else if (FRAGMENTED.has(box.type)) return null;
    at = box.end;
  }
  if (!moov || !mdat) return null;

  // A header or field in the unread middle reads as null, so a moov that spans it decides only when its first video track lies in one part.
  const traks = children(read, moov);
  if (!traks) return null;
  for (const trak of traks) {
    if (trak.type !== "trak") continue;
    const inTrak = children(read, trak);
    const mdia = inTrak && only(inTrak, "mdia");
    const inMdia = mdia && children(read, mdia);
    const hdlr = inMdia && only(inMdia, "hdlr");
    // The handler's type follows the version, the flags and four predefined bytes, and the server needs 20 bytes after the first 4.
    if (!inMdia || !hdlr || hdlr.end - hdlr.payload < 24 || !plainFull(read, hdlr)) return null;
    if (fourCc(read(hdlr.payload + 8, 4)!, 0) !== "vide") continue;
    const minf = only(inMdia, "minf");
    const inMinf = minf && children(read, minf);
    const stbl = inMinf && only(inMinf, "stbl");
    const inStbl = stbl && children(read, stbl);
    const stsd = inStbl && only(inStbl, "stsd");
    if (!stsd || stsd.end - stsd.payload < 8 || !plainFull(read, stsd) || u32(read(stsd.payload + 4, 4)!, 0) !== 1) return null;
    const entries = children(read, stsd, stsd.payload + 8);
    if (!entries || entries.length !== 1 || entries[0]!.end - entries[0]!.payload < 8) return null;
    return entries[0]!.type;
  }
  return null;
}
