import type { Scene } from "#shared/model.ts";
import { sniffImage } from "../uvtt/image.ts";
import type { Device } from "../uvtt/limits.ts";
import type { GridDetection } from "./detect.ts";
import { calibrationFromFind, type Calibration, type Point } from "./calibrate.ts";

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
 * The size the Worker asks the browser to decode a file at, or null to
 * decode it as it is: the picture upright, drawn down to DECODE_MAX_SIDE
 * on its long side. The browser turns a JPEG by its EXIF orientation
 * before it resizes (createImageBitmap's default), as the server turns its
 * copy, so for a quarter turn (5 to 8) the header's sides swap. Asked for
 * the unturned size, it would squash the upright picture into it, and the
 * squares would no longer be square.
 */
export function decodeSize(header: { width: number; height: number } | null, orientation: number): { width: number; height: number } | null {
  if (!header) return null;
  const turned = orientation >= 5 && orientation <= 8;
  const width = turned ? header.height : header.width;
  const height = turned ? header.width : header.height;
  const k = Math.min(1, DECODE_MAX_SIDE / Math.max(width, height));
  return k < 1 ? { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) } : null;
}

/**
 * A detection in the map's canonical pixels, or null. The Worker measures
 * an image decoded at most DECODE_MAX_SIDE wide, so its sizes are scaled
 * by the canonical size over the decoded one. If the two shapes differ,
 * the browser read the file's orientation differently from the server,
 * and the lines would land elsewhere, so nothing is offered. The
 * calibration goes through `calibrationFromFind`, which keeps the
 * measured origin where a hand-drawn box's would be snapped.
 */
export function foundGrid(result: GridDetection, decoded: { width: number; height: number }, canonical: { widthPx: number; heightPx: number }): FoundGrid | null {
  if (!result.found) return null;
  const kx = canonical.widthPx / decoded.width;
  const ky = canonical.heightPx / decoded.height;
  if (!(kx > 0 && ky > 0) || Math.abs(kx - ky) / kx > 0.01) return null;
  const cal = calibrationFromFind({ cellPx: result.cellPx * kx, originPx: { x: result.originPx.x * kx, y: result.originPx.y * ky } });
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
 * before Apply. The import marks its scene (`gridFromFile`), and nothing
 * the DM changes later, such as Automatic walls, takes the mark away. A
 * scene imported before the mark existed counts by the one sign only the
 * import leaves: a first grid line before the image.
 */
export function cameWithGrid(scene: Pick<Scene, "gridFromFile"> & { map: { originPx: Point } }): boolean {
  return scene.gridFromFile === true || scene.map.originPx.x < 0 || scene.map.originPx.y < 0;
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

/** Enough of a file for its size: a JPEG's can follow a large EXIF block. */
export const HEADER_BYTES = 1 << 20;

/**
 * Where an import looks for a picked map's grid: in the picked file, or in
 * the server's phone-sized copy once the upload answers, as Find the grid
 * looks. A computer decodes the file from the pick, so the answer is often
 * in by the time the upload is. A phone or an iPad decodes it only when its
 * header gives both sides at most DECODE_MAX_SIDE. WebKit decodes the whole
 * picture before it resizes it, and a large map's full decode in the middle
 * of its upload could cost the tab its memory. So a larger file, or one
 * whose header gives no size, is searched on the copy.
 */
export function importSearchFrom(input: { device: Device; size: { width: number; height: number } | null }): "file" | "copy" {
  if (input.device === "computer") return "file";
  const { size } = input;
  return size && size.width <= DECODE_MAX_SIDE && size.height <= DECODE_MAX_SIDE ? "file" : "copy";
}

/**
 * The addresses a search of a map already uploaded fetches, the first
 * that answers taken (searchRun.ts `fetchFirst`). A computer falls back to
 * the full image when the phone-sized copy fails. A phone or an iPad never
 * does: the full image, up to 8192 px, is the very decode the copy is
 * there to spare it, so there a copy that fails is no grid found.
 */
export function copyUrls(device: Device, url: (variant: "mobile" | "full") => string): string[] {
  return device === "computer" ? [url("mobile"), url("full")] : [url("mobile")];
}

/** The size a file's header gives, or null when it gives none or cannot be read. Only its first bytes are read. */
export async function headerSize(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    return sniffImage(new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()));
  } catch {
    return null;
  }
}

export type ImportSearch = {
  /** The answer, once the upload has answered with the map's addresses, within `ms` of the call or null. A search of the copy starts here. */
  afterUpload(urls: string[], ms: number): Promise<SearchDone | null>;
  /** Ends it, on either path, with any Worker it started. A later `afterUpload` answers null. */
  cancel(): void;
};

/**
 * An import's search for a picked file, on the path `importSearchFrom`
 * picks. A computer's starts on the file at once, as it always did.
 * Elsewhere the header is read first, then the file is searched or the
 * copy waits for the upload. The wait after the upload holds either way.
 */
export function importSearch(
  file: Blob,
  device: Device,
  deps: { makeWorker?: () => SearchWorker; timers?: Timers; size?: (file: Blob) => Promise<{ width: number; height: number } | null> } = {},
): ImportSearch {
  let cancelled = false;
  let search: GridSearch | null = null;
  const start = (request: SearchRequest) => (search = searchGrid(request, deps.makeWorker));
  if (device === "computer") start({ file });
  const path: Promise<"file" | "copy"> =
    device === "computer"
      ? Promise.resolve("file")
      : (deps.size ?? headerSize)(file).then((size) => {
          const from = importSearchFrom({ device, size });
          if (from === "file" && !cancelled) start({ file });
          return from;
        });
  // A cancel answers a wait at once, even one still waiting on the header.
  let stop!: () => void;
  const stopped = new Promise<null>((resolve) => (stop = () => resolve(null)));
  const cancel = () => {
    cancelled = true;
    search?.cancel();
    stop();
  };
  return {
    afterUpload(urls, ms) {
      if (cancelled) return Promise.resolve(null);
      const found = path.then((from): Promise<SearchDone | null> | null => {
        if (cancelled) return null;
        if (from === "copy" && !search) start({ urls });
        return search?.result ?? null;
      });
      return within({ result: Promise.race([stopped, found]), cancel }, ms, deps.timers);
    },
    cancel,
  };
}
