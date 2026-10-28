import { detectGrid, type Pixels } from "./detect.ts";
import { detectHex } from "./detectHex.ts";
import type { SearchAnswer, SearchRequest } from "./findGrid.ts";

/**
 * One search as the Worker runs it (detectWorker.ts), apart from the
 * browser's canvas, so the tests can run it with a fetch and a decoder of
 * their own: the picked file, or the first of the server's addresses that
 * answers, decoded and searched. Any failure answers as an error, and the
 * page goes on as if no grid were drawn.
 *
 * Every search looks for squares, hex rows and hex columns on the same
 * pixels, whatever the scene's shape (docs/design-v1-grid-detect.md
 * 10.7), so the DM never has to say which the map is. The page picks the
 * shape from the three (outcome.ts).
 */

export type SearchDeps = {
  fetch(url: string): Promise<{ ok: boolean; blob(): Promise<Blob> }>;
  /** Decodes an image to the pixels the detector reads, drawn down as the Worker draws it. */
  pixels(blob: Blob): Promise<Pixels>;
};

/** The first of the addresses that answers, in order. None answering is an error. */
export async function fetchFirst(urls: readonly string[], fetch: SearchDeps["fetch"]): Promise<Blob> {
  for (const url of urls) {
    const res = await fetch(url);
    if (res.ok) return res.blob();
  }
  throw new Error("no image");
}

export async function runSearch(request: SearchRequest, deps: SearchDeps): Promise<SearchAnswer> {
  try {
    const blob = "file" in request ? request.file : await fetchFirst(request.urls, deps.fetch);
    const px = await deps.pixels(blob);
    const result = detectGrid(px);
    const hex = { rows: detectHex(px, { orient: "rows" }), columns: detectHex(px, { orient: "columns" }) };
    return { t: "done", result, hex, width: px.width, height: px.height };
  } catch {
    return { t: "error" };
  }
}
