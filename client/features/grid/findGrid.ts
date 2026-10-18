import type { AutoWalls } from "#shared/model.ts";
import type { GridDetection } from "./detect.ts";
import { calibrationFromBox, type Calibration, type Point } from "./calibrate.ts";

/**
 * Finding a map's drawn grid from the page (docs/design-v1-grid-detect.md
 * section 6): what to do with a detection, and the Worker that makes one,
 * with its cancel and its deadline.
 */

/** At or above this confidence a found grid is applied. Below it, down to detect.ts's MIN_CONFIDENCE, it is only offered. */
export const HIGH_CONFIDENCE = 0.6;
/** The longest side the Worker decodes: the server's phone-sized copy, and the most pixels iOS will draw. */
export const DECODE_MAX_SIDE = 4096;
/** How long an import waits for a search still running once its upload is done, ms. */
export const IMPORT_WAIT_MS = 2000;

export type FoundGrid = { tier: "high" | "medium"; cal: Calibration };

/**
 * A detection in the map's canonical pixels, or null. The Worker measures
 * an image decoded at most DECODE_MAX_SIDE wide, so its sizes are scaled
 * by the canonical size over the decoded one. If the two shapes differ,
 * the browser read the file's orientation differently from the server,
 * and the lines would land elsewhere, so nothing is offered. The
 * calibration goes through `calibrationFromBox`, so it is rounded and its
 * origin snapped exactly as a box the DM applied would be.
 */
export function foundGrid(result: GridDetection, decoded: { width: number; height: number }, canonical: { widthPx: number; heightPx: number }): FoundGrid | null {
  if (!result.found) return null;
  const kx = canonical.widthPx / decoded.width;
  const ky = canonical.heightPx / decoded.height;
  if (!(kx > 0 && ky > 0) || Math.abs(kx - ky) / kx > 0.01) return null;
  const cellPx = result.cellPx * kx;
  const cal = calibrationFromBox({ x: result.originPx.x * kx, y: result.originPx.y * ky, size: 3 * cellPx });
  return { tier: result.confidence >= HIGH_CONFIDENCE ? "high" : "medium", cal };
}

/** A search's answer when the Worker read the image. */
export type SearchDone = Extract<SearchAnswer, { t: "done" }>;

/**
 * The grid an import applies or offers. A size from the file name wins:
 * a map the server sized by its name takes no found grid, even one the
 * search had already answered with.
 */
export function importFound(answer: SearchDone | null, named: boolean, map: { widthPx: number; heightPx: number }): FoundGrid | null {
  return answer && !named ? foundGrid(answer.result, answer, map) : null;
}

/**
 * Whether a new map's grid is looked for while it uploads. A size from
 * the file name wins, so a file that names one is not searched. A
 * Universal VTT file states its grid, so it is never searched on import.
 * Find the grid, which the DM asks for, runs whatever the scene came from.
 */
export function searchOnImport(input: { source: "image" | "uvtt"; named: boolean }): boolean {
  return input.source === "image" && !input.named;
}

/**
 * Whether a scene came with its own grid, exact, from a Universal VTT
 * file. Its walls stand in squares of that grid, so Find the grid only
 * places the box there, however sure the find, for the DM to compare
 * before Apply. A scene keeps no record of where it came from, so this
 * reads the two marks the import leaves: automatic walls off, which a DM
 * may also choose, and a first line before the image, which only the
 * import makes.
 */
export function cameWithGrid(scene: { autoWalls?: AutoWalls; map: { originPx: Point } }): boolean {
  return scene.autoWalls === "off" || scene.map.originPx.x < 0 || scene.map.originPx.y < 0;
}

/** What Find the grid makes of a find: on a scene that came with its own grid, even a sure one is only offered. */
export function findFound(found: FoundGrid | null, ownGrid: boolean): FoundGrid | null {
  return found && ownGrid ? { ...found, tier: "medium" } : found;
}

/**
 * Whether a file name looks like it gives the map's size in squares, as
 * `crypt_30x20.jpg` does. The server decides (server/assets/kinds.ts
 * `cellPxHint`), and may still refuse counts that do not fit the image, so
 * this only says whether to wait for its answer before searching.
 */
export function nameGivesSize(fileName: string): boolean {
  const match = /(?:^|[^0-9])(\d{1,3})\s*[x×]\s*(\d{1,3})(?![0-9])/i.exec(fileName);
  if (!match) return false;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  return cols >= 1 && rows >= 1 && cols <= 200 && rows <= 200;
}

/** What the page sends the Worker: the picked file, or the addresses of a map already uploaded, the first that answers taken. */
export type SearchRequest = { file: Blob } | { urls: string[] };
/** What the Worker answers: a detection with the size it decoded at, or that it could not read the image. */
export type SearchAnswer = { t: "done"; result: GridDetection; width: number; height: number } | { t: "error" };

/** The Worker as the search uses it, so the tests can stand in for it. */
export type SearchWorker = {
  postMessage(message: SearchRequest): void;
  terminate(): void;
  onmessage: ((e: { data: SearchAnswer }) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type GridSearch = {
  /** The Worker's answer, or null when it failed, was cancelled or ran out of time. Settles once. */
  readonly result: Promise<SearchDone | null>;
  /** Stops the search: the Worker ends and `result` is null, unless it has already settled. */
  cancel(): void;
};

function defaultWorker(): SearchWorker {
  return new Worker(new URL("./detectWorker.ts", import.meta.url), { type: "module", name: "grid-finder" }) as unknown as SearchWorker;
}

/**
 * One search in its own Worker. Whatever ends it first (an answer, an
 * error, a cancel) settles `result` and ends the Worker, once. A message
 * that arrives after that is ignored, so a late answer to a cancelled
 * search can never apply a grid.
 */
export function searchGrid(request: SearchRequest, makeWorker: () => SearchWorker = defaultWorker): GridSearch {
  let settle!: (answer: SearchDone | null) => void;
  const result = new Promise<SearchDone | null>((resolve) => (settle = resolve));
  let worker: SearchWorker | null = null;
  const finish = (answer: SearchDone | null) => {
    if (!worker) return;
    const w = worker;
    worker = null;
    w.onmessage = null;
    w.onerror = null;
    w.terminate();
    settle(answer);
  };
  try {
    worker = makeWorker();
  } catch {
    // A browser without module Workers finds nothing, as an image it cannot read does.
    settle(null);
    return { result, cancel: () => {} };
  }
  worker.onmessage = (e) => finish(e.data.t === "done" ? e.data : null);
  worker.onerror = () => finish(null);
  worker.postMessage(request);
  return { result, cancel: () => finish(null) };
}

export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** The search's answer if it comes within `ms`, or null, and then the search is cancelled. */
export function within<T>(search: { result: Promise<T | null>; cancel(): void }, ms: number, timers: Timers = realTimers): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const handle = timers.set(() => {
      if (done) return;
      done = true;
      search.cancel();
      resolve(null);
    }, ms);
    void search.result.then((answer) => {
      if (done) return;
      done = true;
      timers.clear(handle);
      resolve(answer);
    });
  });
}
