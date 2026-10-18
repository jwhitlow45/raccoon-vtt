import { jpegOrientation, sniffImage } from "../uvtt/image.ts";
import type { Pixels } from "./detect.ts";
import { DECODE_MAX_SIDE, decodeSize, HEADER_BYTES, type SearchAnswer, type SearchRequest } from "./findGrid.ts";
import { runSearch } from "./searchRun.ts";

/**
 * The grid finder's Worker (docs/design-v1-grid-detect.md section 6). It
 * decodes the map at most DECODE_MAX_SIDE on its long side, so a large map
 * costs a phone tens of megabytes rather than hundreds, and runs the
 * detector away from the page, which never pauses for it. Any failure,
 * such as an image the browser cannot decode or a device out of memory,
 * answers as an error: the page goes on as if no grid were drawn. The
 * search itself is searchRun.ts's, and this file gives it the browser's
 * fetch and canvas.
 */

const scope = self as unknown as {
  postMessage(message: SearchAnswer): void;
  addEventListener(type: "message", listener: (e: MessageEvent<SearchRequest>) => void): void;
};

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

scope.addEventListener("message", (e) => {
  void runSearch(e.data, { fetch: (url) => fetch(url, { credentials: "same-origin" }), pixels: pixelsOf }).then((answer) => scope.postMessage(answer));
});
