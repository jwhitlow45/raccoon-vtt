import { count, MAX_MAP_SIDE, MAX_MAP_UPLOAD_BYTES, MAX_SOURCE_PIXELS, MAX_SOURCE_SIDE, PHONE_CANVAS_PIXELS, type Device } from "./limits.ts";

/**
 * The image step of a Universal VTT import (docs/design-v1-maps-vision.md
 * section 3.1 step 2): the base64 in the file becomes bytes, the bytes say
 * what they are, and their header says how big the picture is, all before
 * anything decodes a pixel. The server's sharp pipeline still checks and
 * re-encodes whatever is uploaded, so this is never the trust boundary.
 */

export type ImageType = "image/png" | "image/webp" | "image/jpeg";
export type ImageInfo = { type: ImageType; width: number; height: number };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;
// The URL-safe alphabet, which some writers use.
DECODE["-".charCodeAt(0)] = 62;
DECODE["_".charCodeAt(0)] = 63;
/** Space, tab, carriage return and line feed, which MIME-style base64 puts between lines. */
const SKIP = new Set([0x20, 0x09, 0x0d, 0x0a]);

/** Where the base64 starts: after a `data:image/png;base64,` prefix, if the writer added one. */
function payloadStart(text: string): number {
  if (!text.startsWith("data:")) return 0;
  const comma = text.indexOf(",");
  return comma > 0 && comma < 100 ? comma + 1 : 0;
}

/**
 * Decodes base64 into bytes, or null when it is not base64. Written out
 * rather than through atob, which would first build a binary string as
 * long as the image. The output can never be longer than three quarters of
 * the input, which the file's own size already bounds.
 */
export function decodeBase64(text: string): Uint8Array | null {
  const start = payloadStart(text);
  const out = new Uint8Array(Math.floor(((text.length - start) * 3) / 4) + 3);
  let o = 0;
  let acc = 0;
  let bits = 0;
  let padding = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x3d) {
      padding = true;
      continue;
    }
    if (SKIP.has(c)) continue;
    // Nothing but padding and spaces may follow the first "=".
    if (padding || c >= 128) return null;
    const v = DECODE[c]!;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= 0xff;
  }
  // A lone leftover character holds only 6 bits, less than one byte: not base64.
  if (bits === 6) return null;
  return out.subarray(0, o);
}

/**
 * Decodes with the browser's own Uint8Array.fromBase64 where it has one,
 * which is far faster, and with decodeBase64 otherwise.
 */
export function decodeImageBase64(text: string): Uint8Array | null {
  const typed = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
  if (typeof typed.fromBase64 === "function") {
    try {
      return typed.fromBase64(text.slice(payloadStart(text)));
    } catch {
      // Not the standard alphabet, perhaps URL-safe, which the hand-written decoder also reads.
    }
  }
  return decodeBase64(text);
}

function u16be(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
}
function u16le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8);
}
function u24le(b: Uint8Array, i: number): number {
  return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
}
function ascii(b: Uint8Array, i: number, text: string): boolean {
  for (let k = 0; k < text.length; k++) if (b[i + k] !== text.charCodeAt(k)) return false;
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(b: Uint8Array): ImageInfo | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((v, i) => b[i] === v) || !ascii(b, 12, "IHDR")) return null;
  return { type: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function webp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8X")) return { type: "image/webp", width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/** JPEG start-of-frame markers, which carry the size: C0 to CF except C4 (tables), C8 (reserved) and CC (arithmetic tables). */
function isFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (isFrame(marker)) return { type: "image/jpeg", width: u16be(b, i + 7), height: u16be(b, i + 5) };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Every other segment says its own length, which counts its two length bytes.
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

/** The type and size from the bytes' own header, or null when they are not a PNG, WebP or JPEG image. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const info = png(bytes) ?? webp(bytes) ?? jpeg(bytes);
  if (!info || info.width < 1 || info.height < 1) return null;
  return info;
}

export type ImagePlan =
  | { kind: "as-is" }
  | { kind: "resize"; width: number; height: number }
  | { kind: "refuse"; error: string };

/**
 * Whether the bytes can go up as they are. At most 8,192 px on the long
 * side and 32 MiB, they do. Otherwise the device draws them down to 8,192
 * px and encodes them again, which a phone or an iPad can do only while
 * both images fit the iOS canvas limit.
 */
export function planImage(info: { width: number; height: number; bytes: number }, device: Device): ImagePlan {
  const { width, height } = info;
  const size = `${count(width)} by ${count(height)} pixels`;
  if (width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE || width * height > MAX_SOURCE_PIXELS) {
    return { kind: "refuse", error: `This map's image is ${size}, more than a browser can resize. Export it smaller.` };
  }
  const long = Math.max(width, height);
  if (long <= MAX_MAP_SIDE && info.bytes <= MAX_MAP_UPLOAD_BYTES) return { kind: "as-is" };
  const k = Math.min(1, MAX_MAP_SIDE / long);
  const target = { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
  if (device !== "computer" && (width * height > PHONE_CANVAS_PIXELS || target.width * target.height > PHONE_CANVAS_PIXELS)) {
    const which = device === "phone" ? "a phone" : "an iPad";
    return { kind: "refuse", error: `This map's image is ${size}, too large for ${which} to resize. Import it on a computer.` };
  }
  return { kind: "resize", ...target };
}
