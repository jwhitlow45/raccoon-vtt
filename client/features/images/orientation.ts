/**
 * The one-time check that this browser honors EXIF orientation in
 * `createImageBitmap(blob, { imageOrientation: "from-image" })` (design
 * section 11.1). Phone photos are often stored sideways with an EXIF tag
 * saying how to turn them. The downscale draws the bitmap to a canvas,
 * which drops the tag, so a browser that ignored it would upload the photo
 * sideways. Where the check fails, the original goes up instead and the
 * server's `autoOrient()` turns it.
 *
 * The probe is a 2 x 1 pixel baseline JPEG tagged Orientation 6 ("rotate
 * 90 degrees clockwise"), written out byte by byte below rather than drawn
 * or generated, so every byte is accounted for. A browser that honors the
 * tag decodes it as 1 x 2.
 */

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

/** A marker segment: FF, the marker, then a length that counts itself and the payload. */
function segment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...u16(payload.length + 2), ...payload];
}

/** Big-endian TIFF with one IFD entry: Orientation (0x0112), SHORT, count 1, value 6. */
const EXIF_PAYLOAD = [
  ...[0x45, 0x78, 0x69, 0x66, 0x00, 0x00], // "Exif\0\0"
  ...[0x4d, 0x4d, 0x00, 0x2a], // "MM", TIFF magic 42
  ...[0x00, 0x00, 0x00, 0x08], // offset of IFD0
  ...u16(1), // one entry
  ...[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00], // Orientation = 6
  ...[0x00, 0x00, 0x00, 0x00], // no next IFD
];

/**
 * The smallest Huffman table a decoder accepts for this image: one code of
 * length 2 for symbol 0. As a DC table, symbol 0 means "no change from the
 * last DC value". As an AC table, symbol 0 is end of block.
 */
function huffman(tableClassAndId: number): number[] {
  const counts = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return [tableClassAndId, ...counts, 0x00];
}

export const ORIENTED_JPEG: Uint8Array = new Uint8Array([
  0xff, 0xd8, // SOI
  ...segment(0xe1, EXIF_PAYLOAD), // APP1 Exif
  ...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]), // DQT: table 0, every quantizer 1
  ...segment(0xc0, [8, ...u16(1), ...u16(2), 1, 1, 0x11, 0]), // SOF0: 8 bit, height 1, width 2, one gray component
  ...segment(0xc4, huffman(0x00)), // DHT: DC table 0
  ...segment(0xc4, huffman(0x10)), // DHT: AC table 0
  ...segment(0xda, [1, 1, 0x00, 0, 63, 0]), // SOS: component 1 uses tables 0 and 0, full spectrum
  // One 8 x 8 block: DC code 00 (no change, so mid gray), AC code 00 (end of
  // block), padded with 1 bits to a whole byte.
  0x0f,
  0xff, 0xd9, // EOI
]);

let result: Promise<boolean> | undefined;

/** Whether a 1 x 2 bitmap came back. Memoized: the browser does not change while the page lives. */
export function honorsImageOrientation(): Promise<boolean> {
  result ??= probe();
  return result;
}

async function probe(): Promise<boolean> {
  if (typeof createImageBitmap !== "function" || typeof Blob !== "function") return false;
  try {
    const blob = new Blob([ORIENTED_JPEG as BlobPart], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const ok = bitmap.width === 1 && bitmap.height === 2;
    bitmap.close();
    return ok;
  } catch {
    return false;
  }
}
