import { jpegOrientation, sniffImage } from "../uvtt/image.ts";
import { detectGrid, type Pixels } from "./detect.ts";
import { DECODE_MAX_SIDE, decodeSize, type SearchAnswer, type SearchRequest } from "./findGrid.ts";

/**
 * The grid finder's Worker (docs/design-v1-grid-detect.md section 6). It
 * decodes the map at most DECODE_MAX_SIDE on its long side, so a large map
 * costs a phone tens of megabytes rather than hundreds, and runs the
 * detector away from the page, which never pauses for it. Any failure,
 * such as an image the browser cannot decode or a device out of memory,
 * answers as an error: the page goes on as if no grid were drawn.
 */

const scope = self as unknown as {
  postMessage(message: SearchAnswer): void;
  addEventListener(type: "message", listener: (e: MessageEvent<SearchRequest>) => void): void;
};

/** Enough of the file for a JPEG's size, which can follow a large EXIF block. */
const HEADER_BYTES = 1 << 20;

async function pixelsOf(blob: Blob): Promise<Pixels> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") throw new Error("no canvas");
  const header = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  const scaleFor = (w: number, h: number) => Math.min(1, DECODE_MAX_SIDE / Math.max(w, h));
  // Decoding straight to the smaller size spares the full-size bitmap. A
  // browser that ignores the size, or a type the header sniff does not
  // know, decodes at full size and is drawn down below.
  const size = decodeSize(sniffImage(header), jpegOrientation(header));
  const bitmap = size
    ? await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "medium" })
    : await createImageBitmap(blob);
  try {
    const fit = scaleFor(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * fit));
    const height = Math.max(1, Math.round(bitmap.height * fit));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return { width, height, data: image.data, channels: 4 };
  } finally {
    bitmap.close();
  }
}

/** The first of the addresses that answers: the phone-sized copy, else the full image. */
async function fetchFirst(urls: readonly string[]): Promise<Blob> {
  for (const url of urls) {
    const res = await fetch(url, { credentials: "same-origin" });
    if (res.ok) return res.blob();
  }
  throw new Error("no image");
}

scope.addEventListener("message", (e) => {
  const request = e.data;
  const run = async () => {
    const blob = "file" in request ? request.file : await fetchFirst(request.urls);
    const px = await pixelsOf(blob);
    scope.postMessage({ t: "done", result: detectGrid(px), width: px.width, height: px.height });
  };
  run().catch(() => scope.postMessage({ t: "error" }));
});
