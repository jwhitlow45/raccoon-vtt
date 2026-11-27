/**
 * A GLB texture's size from its header, without decoding it
 * (docs/design/design-v1-token-models.md 5, D-261127-476). The reader
 * keeps or leaves out each image by these sizes before any decode runs, so
 * a texture whose header claims 20,000 px a side costs nothing. The format
 * comes from the bytes, never from the file's `mimeType`. Every read is
 * bounds-checked, and a header that cannot be read gives null. So does a
 * walk that stops before it is done, on a budget or a broken box: a size
 * read partway could be a decoy smaller than the image, and the decode,
 * believing it, would not draw the image down.
 */

/** How many JPEG segments or AVIF boxes a walk reads before it gives up: a real header is a few dozen. */
export const HEADER_STEPS = 1_000;

export type ImageHeader = { mime: "image/png" | "image/jpeg" | "image/webp" | "image/avif"; width: number; height: number };

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, s: string) => {
  if (i < 0 || i + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
};

function sized(mime: ImageHeader["mime"], width: number, height: number): ImageHeader | null {
  return width > 0 && height > 0 ? { mime, width, height } : null;
}

function png(b: Uint8Array): ImageHeader | null {
  if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
  return sized("image/png", u32be(b, 16), u32be(b, 20));
}

/** JPEG: the first start-of-frame marker's size, walking at most `HEADER_STEPS` segments by their lengths. */
function jpeg(b: Uint8Array): ImageHeader | null {
  let i = 2;
  for (let steps = 0; i + 4 <= b.length && steps < HEADER_STEPS; steps++) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1]!;
    // Fill bytes: any number of 0xFF before a marker.
    while (marker === 0xff && i + 2 < b.length) marker = b[++i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return i + 9 <= b.length ? sized("image/jpeg", u16be(b, i + 7), u16be(b, i + 5)) : null;
    i += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): ImageHeader | null {
  if (b.length < 30 || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    // A lossy frame: a 3-byte tag, the 9D 01 2A start code, then 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized("image/webp", u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return sized("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8X")) return sized("image/webp", u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

/**
 * AVIF: the largest `ispe` (image spatial extent) in `meta`'s `iprp`'s
 * `ipco`, and only there. A file may hold several, for a grid's tiles, an
 * alpha plane or a thumbnail, and the largest bounds what a decode makes.
 * The walk must reach the end of every box it enters: one that stops early
 * gives null, since the real extent may come after the ones it read.
 */
function avif(b: Uint8Array): ImageHeader | null {
  if (!ascii(b, 4, "ftyp")) return null;
  const ftyp = u32be(b, 0);
  let brand = false;
  for (let i = 8; i + 4 <= Math.min(ftyp, b.length); i += 4) if (ascii(b, i, "avif") || ascii(b, i, "avis")) brand = true;
  if (!brand) return null;
  let best: ImageHeader | null = null;
  let boxes = 0;
  /** The boxes from `from` to `to` inside `parent`, descending on the way to `ispe`. False when it stopped before `to`. */
  const walk = (from: number, to: number, parent: string): boolean => {
    let i = from;
    while (i + 8 <= to) {
      if (++boxes > HEADER_STEPS) return false;
      let size = u32be(b, i);
      let head = 8;
      if (size === 1) {
        if (i + 16 > to || u32be(b, i + 8) !== 0) return false;
        size = u32be(b, i + 12);
        head = 16;
      } else if (size === 0) size = to - i;
      if (size < head || i + size > to) return false;
      const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
      if (type === "meta" && parent === "") {
        if (!walk(i + head + 4, i + size, "meta")) return false;
      } else if ((type === "iprp" && parent === "meta") || (type === "ipco" && parent === "iprp")) {
        if (!walk(i + head, i + size, type)) return false;
      } else if (type === "ispe" && parent === "ipco") {
        if (size < head + 12) return false;
        const width = u32be(b, i + head + 4);
        const height = u32be(b, i + head + 8);
        if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { mime: "image/avif", width, height };
      }
      i += size;
    }
    // Trailing bytes too few for a box header: the file ends inside a box.
    return i === to;
  };
  return walk(0, b.length, "") ? best : null;
}

export function imageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, "PNG\r\n\x1a\n")) return png(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  if (ascii(bytes, 0, "RIFF")) return webp(bytes);
  if (ascii(bytes, 4, "ftyp")) return avif(bytes);
  return null;
}
