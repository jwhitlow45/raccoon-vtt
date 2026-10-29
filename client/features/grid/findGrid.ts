import type { GridShape, Scene } from "#shared/model.ts";
import { gridOfShape, isHex, type Grid } from "#shared/rules/grid.ts";
import { hexAt, hexCenter, HEX_R, HEX_S } from "#shared/rules/hex.ts";
import { sniffImage } from "../uvtt/image.ts";
import type { Device } from "../uvtt/limits.ts";
import type { GridDetection } from "./detect.ts";
import { pickShape, type HexDetection, type HexFound, type MapShape } from "./detectHex.ts";
import { canonicalToWorld, calibrationFromFind, calibrationFromHexFind, FOUND_SNAP, FOUND_SNAP_PX, worldToCanonical, type Calibration, type KeptGrid, type Point } from "./calibrate.ts";

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

/**
 * A grid found on a map: applied when `tier` is high, else only offered.
 * `shape` is the shape its lines make, as a scene stores it, absent for
 * squares. `contested` names the other shape found on the same map, which
 * makes even a sure find only an offer (docs/design-v1-grid-detect.md 10.6).
 */
export type FoundGrid = { tier: "high" | "medium"; cal: Calibration; shape?: GridShape; contested?: { shape: MapShape; cellPx: number } };

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

/** A hex find in the map's canonical pixels, or null, scaled and checked as `foundGrid` scales a square one. */
function foundHexGrid(result: HexFound, decoded: { width: number; height: number }, canonical: { widthPx: number; heightPx: number }): FoundGrid | null {
  const kx = canonical.widthPx / decoded.width;
  const ky = canonical.heightPx / decoded.height;
  if (!(kx > 0 && ky > 0) || Math.abs(kx - ky) / kx > 0.01) return null;
  const cal = calibrationFromHexFind({ cellPx: result.cellPx * kx, center: { x: result.center.x * kx, y: result.center.y * ky }, orient: result.orient });
  return { tier: result.confidence >= HIGH_CONFIDENCE ? "high" : "medium", cal, shape: result.orient === "rows" ? "hexRows" : "hexColumns" };
}

/** A search's answer when the Worker read the image. */
export type SearchDone = Extract<SearchAnswer, { t: "done" }>;

const NO_HEXES: HexDetection = { found: false, reason: "none" };

/**
 * The grid a search's answer gives a scene of `shape` (absent for
 * squares), in the map's canonical pixels, or null: the surest of the
 * three looks (detectHex.ts `pickShape`), whatever shape the scene is.
 * When two shapes were found, the find is only offered, and on the
 * scene's own shape when that is one of them, since the map holds both
 * and either may be tiles under the other. Whether a find of another
 * shape may switch the scene is the landing's to say (outcome.ts).
 */
export function pickedGrid(answer: SearchDone, canonical: { widthPx: number; heightPx: number }, shape: GridShape | undefined): FoundGrid | null {
  const looks = { squares: answer.result, hexRows: answer.hex?.rows ?? NO_HEXES, hexColumns: answer.hex?.columns ?? NO_HEXES };
  const pick = pickShape(looks.squares, looks.hexRows, looks.hexColumns);
  if (!pick) return null;
  const own: MapShape = shape ?? "squares";
  const offered: MapShape = pick.contested && looks[own].found ? own : pick.shape;
  const at = (s: MapShape): FoundGrid | null => {
    const look = looks[s];
    if (!look.found) return null;
    return "orient" in look ? foundHexGrid(look, answer, canonical) : foundGrid(look, answer, canonical);
  };
  const found = at(offered);
  if (!found || !pick.contested) return found;
  const others = (["squares", "hexRows", "hexColumns"] as const).filter((s) => s !== offered && looks[s].found);
  others.sort((a, b) => confidenceOf(looks[b]) - confidenceOf(looks[a]));
  const other = others[0]!;
  const otherFound = at(other);
  return { ...found, tier: "medium", ...(otherFound ? { contested: { shape: other, cellPx: otherFound.cal.cellPx } } : {}) };
}

function confidenceOf(d: GridDetection | HexDetection): number {
  return d.found ? d.confidence : 0;
}

/**
 * The grid an import applies or offers, on a new scene of `shape`. A size
 * from the file name wins: a map the server sized by its name takes no
 * found grid, even one the search had already answered with.
 */
export function importFound(answer: SearchDone | null, named: boolean, map: { widthPx: number; heightPx: number }, shape?: GridShape): FoundGrid | null {
  return answer && !named ? pickedGrid(answer, map, shape) : null;
}

/**
 * Whether a new map's grid is looked for while it uploads, whatever the
 * room's shape, since squares and hexes are both looked for. A size from
 * the file name wins, so a file that names one is not searched. The
 * caller says `named` only on squares: on hexes names are not read
 * (D-261028-05). A Universal VTT file states its grid, so it is never
 * searched on import. Find the grid, which the DM asks for, runs whatever
 * the scene came from.
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
 * What a scene's new image makes of its search (Scene settings): an
 * import's find, except that on a scene that came with its own grid even
 * a sure one is only offered, as Find the grid's is. New art keeps the
 * imported walls, which stand in the file's grid, so the scene keeps its
 * mark. `scene.map` is the image before, whose first line before the image
 * marks an import from before the mark.
 *
 * Art of the old image's shape keeps the scene's grid, scaled (`kept`,
 * scenes/create.ts `replacement`). A find there is only offered, since the
 * DM may have lined that grid up by hand, and a find that puts its cells
 * where the kept grid has them is no find at all: the scene already
 * stands on it (D-261029-50). A find that names another shape too is
 * still said, though its own shape matches: the map may hold either as
 * tiles under the other (design 10.6).
 */
export function replacementFound(
  answer: SearchDone | null,
  named: boolean,
  next: { widthPx: number; heightPx: number },
  scene: Pick<Scene, "gridFromFile" | "gridShape"> & { map?: { originPx: Point } },
  kept: KeptGrid | null = null,
): { found: FoundGrid | null; ownGrid: boolean } {
  const ownGrid = cameWithGrid({ gridFromFile: scene.gridFromFile, map: scene.map ?? { originPx: { x: 0, y: 0 } } });
  const found = findFound(importFound(answer && kept ? offeredOnly(answer) : answer, named, next, scene.gridShape), ownGrid);
  return { found: beside(found, kept, scene.gridShape, next), ownGrid };
}

/**
 * A find on art that keeps its scene's grid (`kept`), as `replacementFound`
 * and a phone's late search (outcome.ts `landSearch`) both take it: none
 * when it puts its cells where the kept grid has them, unless another
 * shape contests it.
 */
export function beside(found: FoundGrid | null, kept: KeptGrid | null, shape: GridShape | undefined, map: { widthPx: number; heightPx: number }): FoundGrid | null {
  return found && kept && !found.contested && keptGridHolds(found, kept, shape, map) ? null : found;
}

/**
 * Whether a find puts its cells where a kept grid has them: the same
 * shape, and every cell of each with its center on the map within the
 * slack of its partner in the other. FOUND_SNAP of a cell is the slack,
 * FOUND_SNAP_PX at least. The kept grid was scaled up with the art, its
 * errors with it, so the slack's pixel floor grows by as much
 * (D-261029-54). Its share of a cell grows already, with the kept cell.
 *
 * Partners are paired by their steps from the map's middle cell, not as
 * each cell's nearest: grids of near sizes drift apart by their sizes'
 * difference a cell, and drift of a whole cell meets the nearest again
 * (20 px squares and 19.2 px ones meet every 25 cells, and miss by 9.6 px
 * between). Two partners part by the middle pair's offset plus that
 * drift times their distance from the middle, a straight line across the
 * map, so the farthest apart are at the ends of a row of cells, and only
 * those are measured. Sizes are not compared apart: on a map 3 cells
 * across, a size more than the slack off already parts a cell beside the
 * middle from its partner by more than the slack.
 */
export function keptGridHolds(found: FoundGrid, kept: KeptGrid, shape: GridShape | undefined, map: { widthPx: number; heightPx: number }): boolean {
  if (found.shape !== shape) return false;
  const slack = Math.max(FOUND_SNAP_PX * Math.max(1, kept.scale), kept.cellPx * FOUND_SNAP);
  const g = gridOfShape(shape);
  const keptMiddle = cellCenter(kept, g, { x: map.widthPx / 2, y: map.heightPx / 2 });
  const foundMiddle = cellCenter(found.cal, g, keptMiddle);
  return partnersWithin(kept, keptMiddle, found.cal, foundMiddle, g, map, slack) && partnersWithin(found.cal, foundMiddle, kept, keptMiddle, g, map, slack);
}

/** Whether each of `a`'s cells on the map lies within the slack of its partner in `b`, the cell as many steps from `bMiddle` as it is from `aMiddle`. */
function partnersWithin(a: Calibration, aMiddle: Point, b: Calibration, bMiddle: Point, g: Grid, map: { widthPx: number; heightPx: number }, slack: number): boolean {
  const drift = b.cellPx / a.cellPx - 1;
  return rowEnds(a, g, map).every((p) => Math.hypot(bMiddle.x - aMiddle.x + drift * (p.x - aMiddle.x), bMiddle.y - aMiddle.y + drift * (p.y - aMiddle.y)) <= slack);
}

/**
 * The centers on the map of the cells at each end of a row of a grid's
 * cells, in canonical pixels: of a column on hex columns, whose cells
 * stand in columns. Every other center on the map lies between two.
 */
function rowEnds(cal: Calibration, g: Grid, map: { widthPx: number; heightPx: number }): Point[] {
  const hex = isHex(g);
  const [along, down] = hex && g.orient === "columns" ? (["y", "x"] as const) : (["x", "y"] as const);
  const size = { x: map.widthPx, y: map.heightPx };
  // In cells, where a row lies across the map (hexes' rows HEX_S apart, from HEX_R) and a cell along its row. A cell more at
  // either end takes in the hexes of every other row, half a cell along, and only the centers on the map are kept.
  const rowAt = (v: number) => ((v - cal.originPx[down]) / cal.cellPx - (hex ? HEX_R : 0.5)) / (hex ? HEX_S : 1);
  const cellAt = (v: number) => (v - cal.originPx[along]) / cal.cellPx - 0.5;
  const center = (i: number, j: number) => worldToCanonical(cal, hex ? hexCenter(g, along === "y" ? { col: j, row: i } : { col: i, row: j }) : { x: i + 0.5, y: j + 0.5 });
  const onMap = (c: Point) => c.x >= 0 && c.y >= 0 && c.x <= map.widthPx && c.y <= map.heightPx;
  const ends: Point[] = [];
  for (let j = Math.floor(rowAt(0)) - 1; j <= Math.ceil(rowAt(size[down])) + 1; j++) {
    let i0 = Math.floor(cellAt(0)) - 1;
    let i1 = Math.ceil(cellAt(size[along])) + 1;
    while (i0 <= i1 && !onMap(center(i0, j))) i0++;
    while (i1 >= i0 && !onMap(center(i1, j))) i1--;
    if (i0 <= i1) ends.push(center(i0, j), center(i1, j));
  }
  return ends;
}

/** The center of the cell of `g` under `cal` that holds a point, in canonical pixels. */
function cellCenter(cal: Calibration, g: Grid, p: Point): Point {
  const w = canonicalToWorld(cal, p);
  return worldToCanonical(cal, isHex(g) ? hexCenter(g, hexAt(g, w)) : { x: Math.floor(w.x) + 0.5, y: Math.floor(w.y) + 0.5 });
}

/** The surest a find may be and still only be offered. */
const OFFERED_MOST = HIGH_CONFIDENCE - 0.01;

/**
 * A search's answer with every find only offered: each look's confidence
 * scaled down by one factor, so the surest stands just under
 * HIGH_CONFIDENCE and the shapes keep their order (`pickShape`).
 */
export function offeredOnly(answer: SearchDone): SearchDone {
  const top = Math.max(confidenceOf(answer.result), confidenceOf(answer.hex?.rows ?? NO_HEXES), confidenceOf(answer.hex?.columns ?? NO_HEXES));
  if (top < HIGH_CONFIDENCE) return answer;
  const k = OFFERED_MOST / top;
  const scaled = <T extends GridDetection | HexDetection>(d: T): T => (d.found ? { ...d, confidence: d.confidence * k } : d);
  return { ...answer, result: scaled(answer.result), ...(answer.hex ? { hex: { rows: scaled(answer.hex.rows), columns: scaled(answer.hex.columns) } } : {}) };
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
/**
 * What the Worker answers: the square finder's detection (`result`) and
 * the hex finder's both ways, with the size it decoded at, or that it
 * could not read the image. An answer without `hex` looked for squares
 * alone, and reads as no hexes found.
 */
export type SearchAnswer = { t: "done"; result: GridDetection; hex?: { rows: HexDetection; columns: HexDetection }; width: number; height: number } | { t: "error" };

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

/**
 * What an import's wait after its upload ends with: the answer, or, when
 * the wait ran out on the copy's path, the search still running, which the
 * page hands to Line up grid to land later (outcome.ts `landSearch`).
 */
export type ImportWait = { answer: SearchDone | null; later: GridSearch | null };

export type ImportSearch = {
  /**
   * The answer, once the upload has answered with the map's addresses,
   * within `ms` of the call. A search of the copy starts here, and one that
   * has not answered by then comes back as `later`, still running. On the
   * file's path the deadline ends the search, as it always did.
   */
  afterUpload(urls: string[], ms: number): Promise<ImportWait>;
  /** Ends it, on either path, with any Worker it started. A later `afterUpload` answers with nothing. */
  cancel(): void;
};

/**
 * An import's search for a picked file, on the path `importSearchFrom`
 * picks. A computer's starts on the file at once, as it always did.
 * Elsewhere the header is read first, then the file is searched or the
 * copy waits for the upload. The wait after the upload holds either way.
 * The copy's search on a phone takes longer than the wait, downloading
 * and decoding a 4096 px image, so instead of ending there it goes on
 * after the scene opens.
 */
export function importSearch(
  file: Blob,
  device: Device,
  deps: { makeWorker?: () => SearchWorker; timers?: Timers; size?: (file: Blob) => Promise<{ width: number; height: number } | null> } = {},
): ImportSearch {
  const timers = deps.timers ?? realTimers;
  let cancelled = false;
  let fromCopy = false;
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
  const nothing: ImportWait = { answer: null, later: null };
  return {
    afterUpload(urls, ms) {
      if (cancelled) return Promise.resolve(nothing);
      const found = path.then((from): Promise<SearchDone | null> | null => {
        if (cancelled) return null;
        if (from === "copy" && !search) {
          fromCopy = true;
          start({ urls });
        }
        return search?.result ?? null;
      });
      return new Promise<ImportWait>((resolve) => {
        let done = false;
        const handle = timers.set(() => {
          if (done) return;
          done = true;
          if (fromCopy && search && !cancelled) {
            // The landing owns it from here: this import's cancel no longer reaches it.
            const later = search;
            search = null;
            resolve({ answer: null, later });
          } else {
            cancel();
            resolve(nothing);
          }
        }, ms);
        void Promise.race([stopped, found]).then((answer) => {
          if (done) return;
          done = true;
          timers.clear(handle);
          resolve({ answer, later: null });
        });
      });
    },
    cancel,
  };
}
