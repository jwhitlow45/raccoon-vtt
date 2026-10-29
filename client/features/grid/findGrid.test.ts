import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { createStore } from "zustand/vanilla";
import type { GridShape } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { gridOfShape, isHex, SQUARES } from "#shared/rules/grid.ts";
import { hexAt, hexCenter, HEX_S } from "#shared/rules/hex.ts";
import { jpegOrientation, sniffImage } from "../uvtt/image.ts";
import { detectGrid, type AxisFit, type GridDetection } from "./detect.ts";
import { calibrationFromHexFind, canonicalToWorld, FOUND_SNAP, FOUND_SNAP_PX, worldToCanonical, type Calibration, type Point } from "./calibrate.ts";
import { pickShape, type HexDetection } from "./detectHex.ts";
import { cameWithGrid, decodeSize, headerSize, HIGH_CONFIDENCE, importSearch, importSearchFrom, findFound, foundGrid, importFound, keptGridHolds, nameGivesSize, offeredOnly, pickedGrid, replacementFound, searchGrid, searchOnImport, within, type SearchAnswer, type SearchDone, type SearchRequest, type SearchWorker, type Timers } from "./findGrid.ts";
import { foundLine, landSearch, showOutcome } from "./outcome.ts";
import type { GridToolState } from "./store.ts";
import { rng } from "./synthetic.ts";

const AXIS = { found: 20, expected: 20, from: 0, to: 0, snr: 50, between: 0, parity: 1, rms: 0.1, continuity: 1, restart: 0, coverage: 1, drift: 0 } as const;

function detection(cellPx: number, origin: { x: number; y: number }, confidence: number): GridDetection {
  const axis = (phase: number) => ({ ...AXIS, period: cellPx, phase }) as AxisFit & typeof AXIS;
  return { found: true, cellPx, originPx: origin, confidence, polarity: "dark", across: axis(origin.x), down: axis(origin.y) };
}

function done(result: GridDetection, width: number, height: number): SearchDone {
  return { t: "done", result, width, height };
}

/**
 * A grid map 4800 x 2400 as its frame is stored, tagged to be turned a
 * quarter clockwise (EXIF orientation 6), as a phone stores a photo taken
 * on its side: upright it is 2400 x 4800, with 100 px squares.
 */
async function turnedJpeg(): Promise<Buffer> {
  const width = 4800;
  const height = 2400;
  const data = Buffer.alloc(width * height, 200);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (x % 100 < 2 || y % 100 < 2) data[y * width + x] = 40;
  }
  return sharp(data, { raw: { width, height, channels: 1 } }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
}

/** What the browser's createImageBitmap does with the file at a size: turn it upright, then resize to exactly that size. */
async function decodeAt(file: Buffer, size: { width: number; height: number }) {
  const { data, info } = await sharp(file).rotate().resize(size.width, size.height, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data), channels: 1 as const };
}

describe("the size a picked file decodes at", () => {
  test("a large picture is drawn down to the decode's longest side, and a small one decodes as it is", () => {
    assert.deepEqual(decodeSize({ width: 8192, height: 4096 }, 1), { width: 4096, height: 2048 });
    assert.deepEqual(decodeSize({ width: 3000, height: 2000 }, 1), null);
    assert.deepEqual(decodeSize(null, 6), null, "a header the sniff does not know decodes as it is, then is drawn down");
  });

  test("a quarter turn swaps the sides, since the browser turns the picture before it resizes", () => {
    for (const orientation of [5, 6, 7, 8]) assert.deepEqual(decodeSize({ width: 4800, height: 2400 }, orientation), { width: 2048, height: 4096 }, `orientation ${orientation}`);
    for (const orientation of [1, 2, 3, 4]) assert.deepEqual(decodeSize({ width: 4800, height: 2400 }, orientation), { width: 4096, height: 2048 }, `orientation ${orientation}`);
  });

  test("a turned JPEG over 4096 px has its grid found, where the unturned size squashed it", async () => {
    const file = await turnedJpeg();
    const header = new Uint8Array(file.subarray(0, 1 << 20));
    const sniffed = sniffImage(header);
    assert.deepEqual(sniffed && { width: sniffed.width, height: sniffed.height }, { width: 4800, height: 2400 }, "the header gives the frame unturned");
    assert.equal(jpegOrientation(header), 6);
    const size = decodeSize(sniffed, jpegOrientation(header));
    assert.deepEqual(size, { width: 2048, height: 4096 });
    // The server turns its copy upright too (server/assets/process.ts).
    const canonical = { widthPx: 2400, heightPx: 4800 };
    const px = await decodeAt(file, size!);
    const found = foundGrid(detectGrid(px), px, canonical);
    assert.ok(found, "a grid is found");
    assert.ok(Math.abs(found.cal.cellPx - 100) < 0.5, `squares of ${found.cal.cellPx} px`);
    const squashed = await decodeAt(file, { width: 4096, height: 2048 });
    assert.equal(foundGrid(detectGrid(squashed), squashed, canonical), null, "the frame's own size squashes the upright picture");
  });
});

describe("what a found grid becomes", () => {
  test("high confidence applies, lower only offers", () => {
    const decoded = { width: 1000, height: 800 };
    const map = { widthPx: 1000, heightPx: 800 };
    assert.equal(foundGrid(detection(50, { x: 10, y: 20 }, 0.9), decoded, map)?.tier, "high");
    assert.equal(foundGrid(detection(50, { x: 10, y: 20 }, 0.6), decoded, map)?.tier, "high");
    assert.equal(foundGrid(detection(50, { x: 10, y: 20 }, 0.45), decoded, map)?.tier, "medium");
    assert.equal(foundGrid({ found: false, reason: "none" }, decoded, map), null);
  });

  test("a grid found on the smaller decoded copy is scaled to the map's own pixels, its origin kept where the lines are", () => {
    // Decoded at 4096 of an 8192 px map: everything doubles.
    const found = foundGrid(detection(35.2, { x: 12.3, y: 0.4 }, 0.9), { width: 4096, height: 2048 }, { widthPx: 8192, heightPx: 4096 });
    assert.deepEqual(found?.cal, { cellPx: 70.4, originPx: { x: 24.6, y: 0.8 } });
  });

  test("a sure find on 140 px squares keeps a small offset, which the box's snap would have moved to the edge", () => {
    const decoded = { width: 2000, height: 1600 };
    const map = { widthPx: 2000, heightPx: 1600 };
    const origin = (o: number) => foundGrid(detection(140, { x: o, y: o }, 0.99), decoded, map)?.cal.originPx;
    assert.deepEqual(origin(1), { x: 1, y: 1 });
    assert.deepEqual(origin(6.0006), { x: 6, y: 6 });
    assert.deepEqual(origin(7.5), { x: 7.5, y: 7.5 });
    assert.deepEqual(origin(133), { x: 133, y: 133 });
    assert.deepEqual(origin(139), { x: 0, y: 0 }, "a line a pixel before the edge starts the first square there");
  });

  test("a copy whose shape differs from the map's, read in another orientation, offers nothing", () => {
    assert.equal(foundGrid(detection(50, { x: 0, y: 0 }, 0.9), { width: 800, height: 1000 }, { widthPx: 1000, heightPx: 800 }), null);
  });

  test("a size from the file name wins over a found grid", () => {
    const answer = done(detection(50, { x: 10, y: 20 }, 0.9), 1000, 800);
    const map = { widthPx: 1000, heightPx: 800 };
    assert.equal(importFound(answer, true, map), null);
    assert.equal(importFound(answer, false, map)?.cal.cellPx, 50);
    assert.equal(importFound(null, false, map), null);
  });

  test("an import is searched only for an image whose name gives no size, never for a Universal VTT file", () => {
    assert.equal(searchOnImport({ source: "image", named: false }), true);
    assert.equal(searchOnImport({ source: "image", named: true }), false);
    assert.equal(searchOnImport({ source: "uvtt", named: false }), false);
  });

  test("a scene that came with its own grid, from a Universal VTT file, is only offered a find, however sure", () => {
    const corner = { originPx: { x: 0, y: 0 } };
    assert.equal(cameWithGrid({ gridFromFile: true, map: corner }), true, "the import marks its scene");
    assert.equal(cameWithGrid({ map: { originPx: { x: -25, y: 0 } } }), true, "an import from before the mark: only the import puts the first line before the image");
    assert.equal(cameWithGrid({ map: corner }), false);
    assert.equal(cameWithGrid({ map: { originPx: { x: 12, y: 30 } } }), false);
    const sure = { tier: "high", cal: { cellPx: 50, originPx: { x: 0, y: 0 } } } as const;
    assert.deepEqual(findFound(sure, true), { ...sure, tier: "medium" });
    assert.equal(findFound(sure, false), sure, "everywhere else a sure find applies");
    assert.equal(findFound({ ...sure, tier: "medium" }, true)?.tier, "medium");
    assert.equal(findFound(null, true), null);
  });

  test("names that give a size, as the server reads them", () => {
    assert.equal(nameGivesSize("crypt_30x20.jpg"), true);
    assert.equal(nameGivesSize("Crypt 30 X 20 final.png"), true);
    assert.equal(nameGivesSize("road-24×18.webp"), true);
    assert.equal(nameGivesSize("tavern.jpg"), false);
    assert.equal(nameGivesSize("big_300x200.jpg"), false);
    assert.equal(nameGivesSize("zero_0x10.jpg"), false);
  });
});

/** A Worker that answers when told to, and counts how often it is ended. */
class FakeWorker implements SearchWorker {
  onmessage: ((e: { data: SearchAnswer }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: SearchRequest[] = [];
  terminated = 0;
  postMessage(message: SearchRequest): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated++;
  }
  answer(a: SearchAnswer): void {
    this.onmessage?.({ data: a });
  }
  fail(): void {
    this.onerror?.(new Error("crashed"));
  }
}

function fakeTimers(): Timers & { fire(): void; pending(): number } {
  let next = 1;
  const due = new Map<number, () => void>();
  return {
    set(fn) {
      const handle = next++;
      due.set(handle, fn);
      return handle;
    },
    clear(handle) {
      due.delete(handle as number);
    },
    fire() {
      for (const [handle, fn] of [...due]) {
        due.delete(handle);
        fn();
      }
    },
    pending: () => due.size,
  };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("a search's Worker, cancel and deadline", () => {
  test("the Worker gets the file, and its answer comes back", async () => {
    const worker = new FakeWorker();
    const file = new Blob(["x"]);
    const search = searchGrid({ file }, () => worker);
    assert.deepEqual(worker.posted, [{ file }]);
    const answer = done(detection(50, { x: 0, y: 0 }, 0.9), 10, 10);
    worker.answer(answer);
    assert.equal(await search.result, answer);
    assert.equal(worker.terminated, 1);
  });

  test("a browser without module Workers finds nothing", async () => {
    const search = searchGrid({ urls: ["/a"] }, () => {
      throw new Error("no workers");
    });
    assert.equal(await search.result, null);
    search.cancel();
  });

  /**
   * Random runs of what can happen to a search: the Worker answers, fails
   * or answers late, the page cancels, the deadline passes, in any order
   * and any number of times. Invariants, every run:
   * - The search and its deadline each settle once, with the answer only
   *   when the answer came before any cancel, failure or deadline.
   * - Nothing that comes after the first ending changes either result:
   *   a late answer to a cancelled search applies nothing.
   * - The Worker is ended exactly once when anything ended the search, and
   *   never otherwise. No deadline timer is left behind once it settles.
   */
  test("random answers, failures, cancels and deadlines keep every invariant", async () => {
    const next = rng(20261018);
    const kinds = ["answer", "error", "cancel", "timeout"] as const;
    for (let run = 0; run < 400; run++) {
      const worker = new FakeWorker();
      const timers = fakeTimers();
      const search = searchGrid({ urls: ["/map"] }, () => worker);
      const answer = done(detection(40 + run, { x: 1, y: 2 }, 0.9), 100, 100);
      const searchResults: unknown[] = [];
      const deadlineResults: unknown[] = [];
      void search.result.then((r) => searchResults.push(r));
      void within(search, 1000, timers).then((r) => deadlineResults.push(r));
      const events = Array.from({ length: Math.floor(next() * 6) }, () => kinds[Math.floor(next() * kinds.length)]!);
      for (const event of events) {
        if (event === "answer") worker.answer(answer);
        else if (event === "error") worker.fail();
        else if (event === "cancel") search.cancel();
        else timers.fire();
        await settled();
      }
      const first = events[0];
      const label = `run ${run}: ${events.join(", ") || "nothing"}`;
      if (first === undefined) {
        assert.deepEqual(searchResults, [], label);
        assert.deepEqual(deadlineResults, [], label);
        assert.equal(worker.terminated, 0, label);
        search.cancel();
        await settled();
        continue;
      }
      const expected = first === "answer" ? answer : null;
      assert.deepEqual(searchResults, [expected], label);
      assert.deepEqual(deadlineResults, [expected], label);
      assert.equal(worker.terminated, 1, label);
      assert.equal(timers.pending(), 0, label);
    }
  });
});

/** A header read the test lets finish when it chooses. */
function heldSize() {
  let answer!: (size: { width: number; height: number } | null) => void;
  const read = new Promise<{ width: number; height: number } | null>((resolve) => (answer = resolve));
  return { size: () => read, answer };
}

describe("where an import searches a picked map", () => {
  test("a computer searches the file, a phone or an iPad only a file no larger than the decode, else the server's copy", () => {
    const big = { width: 8000, height: 3000 };
    const small = { width: 4096, height: 2000 };
    assert.equal(importSearchFrom({ device: "computer", size: big }), "file");
    assert.equal(importSearchFrom({ device: "computer", size: null }), "file");
    for (const device of ["phone", "iPad"] as const) {
      assert.equal(importSearchFrom({ device, size: small }), "file", device);
      assert.equal(importSearchFrom({ device, size: big }), "copy", device);
      assert.equal(importSearchFrom({ device, size: { width: 3000, height: 4097 } }), "copy", `${device}: either side`);
      assert.equal(importSearchFrom({ device, size: null }), "copy", `${device}: a header that gives no size`);
    }
  });

  test("the size comes from the file's first bytes, and a file that is no image gives none", async () => {
    const turned = await turnedJpeg();
    assert.deepEqual(await headerSize(new Blob([new Uint8Array(turned)])), { type: "image/jpeg", width: 4800, height: 2400 });
    assert.equal(await headerSize(new Blob(["not an image"])), null);
  });

  test("a computer starts on the file at the pick, as before", async () => {
    const worker = new FakeWorker();
    const file = new Blob(["x"]);
    const search = importSearch(file, "computer", { makeWorker: () => worker, size: () => assert.fail("a computer reads no header") });
    assert.deepEqual(worker.posted, [{ file }]);
    const answer = done(detection(50, { x: 0, y: 0 }, 0.9), 10, 10);
    worker.answer(answer);
    assert.deepEqual(await search.afterUpload(["/m"], 2000), { answer, later: null });
  });

  test("a phone with a small file searches the file once its header is read", async () => {
    const workers: FakeWorker[] = [];
    const file = new Blob(["x"]);
    const header = heldSize();
    const search = importSearch(file, "phone", { makeWorker: () => (workers.push(new FakeWorker()), workers.at(-1)!), size: header.size });
    assert.equal(workers.length, 0, "nothing decodes before the header says how big it is");
    header.answer({ width: 3000, height: 2000 });
    await settled();
    assert.deepEqual(workers[0]?.posted, [{ file }]);
    const answer = done(detection(50, { x: 0, y: 0 }, 0.9), 10, 10);
    workers[0]!.answer(answer);
    assert.deepEqual(await search.afterUpload(["/m/mobile", "/m/full"], 2000), { answer, later: null });
    assert.equal(workers.length, 1);
  });

  test("a phone with a large file, or one of no known size, never decodes it, and searches the copy once the upload answers", async () => {
    for (const size of [{ width: 8000, height: 6000 }, null]) {
      const workers: FakeWorker[] = [];
      const timers = fakeTimers();
      const search = importSearch(new Blob(["x"]), "phone", { makeWorker: () => (workers.push(new FakeWorker()), workers.at(-1)!), timers, size: async () => size });
      await settled();
      assert.equal(workers.length, 0, "no Worker while it uploads");
      const result = search.afterUpload(["/m/mobile"], 2000);
      await settled();
      assert.deepEqual(workers[0]?.posted, [{ urls: ["/m/mobile"] }], "the copy");
      const answer = done(detection(50, { x: 0, y: 0 }, 0.9), 10, 10);
      workers[0]!.answer(answer);
      assert.deepEqual(await result, { answer, later: null });
      assert.equal(timers.pending(), 0);
    }
  });

  test("the scene waits 2 s after the upload for the copy's answer, then opens with the search still running", async () => {
    const workers: FakeWorker[] = [];
    const timers = fakeTimers();
    const search = importSearch(new Blob(["x"]), "iPad", { makeWorker: () => (workers.push(new FakeWorker()), workers.at(-1)!), timers, size: async () => null });
    const result = search.afterUpload(["/m"], 2000);
    await settled();
    timers.fire();
    const wait = await result;
    assert.equal(wait.answer, null);
    assert.ok(wait.later, "the copy's search is handed on");
    assert.equal(workers[0]?.terminated, 0, "and still runs");
    search.cancel();
    assert.equal(workers[0]?.terminated, 0, "the import's own cancel no longer reaches it");
    const answer = done(detection(50, { x: 0, y: 0 }, 0.9), 10, 10);
    workers[0]!.answer(answer);
    assert.equal(await wait.later.result, answer);
    assert.equal(timers.pending(), 0);
  });

  test("on the file's path the 2 s wait ends the search, as it always did", async () => {
    for (const [device, size] of [
      ["computer", null],
      ["phone", { width: 3000, height: 2000 }],
    ] as const) {
      const workers: FakeWorker[] = [];
      const timers = fakeTimers();
      const search = importSearch(new Blob(["x"]), device, { makeWorker: () => (workers.push(new FakeWorker()), workers.at(-1)!), timers, size: async () => size });
      await settled();
      const result = search.afterUpload(["/m"], 2000);
      await settled();
      timers.fire();
      assert.deepEqual(await result, { answer: null, later: null }, device);
      assert.equal(workers[0]?.terminated, 1, `${device}: the search ends with the wait`);
    }
  });

  test("a cancel before the header is read starts nothing, ever", async () => {
    let made = 0;
    const header = heldSize();
    const search = importSearch(new Blob(["x"]), "phone", { makeWorker: () => (made++, new FakeWorker()), size: header.size });
    search.cancel();
    header.answer({ width: 100, height: 100 });
    await settled();
    assert.deepEqual(await search.afterUpload(["/m"], 2000), { answer: null, later: null });
    assert.equal(made, 0);
  });
});

const FAMILY = { period: 30, phase: 0, found: 20, expected: 20, snr: 50, between: 0, rms: 0.1 };

function hexFind(orient: "rows" | "columns", cellPx: number, center: { x: number; y: number }, confidence: number): HexDetection {
  return { found: true, orient, cellPx, center, box: { x: 0, y: 0, size: 3 * cellPx }, confidence, polarity: "dark", broken: 0.9, coverage: 1, checked: true, families: [FAMILY, FAMILY, FAMILY] };
}

const NO_HEX: HexDetection = { found: false, reason: "none" };
const NO_SQUARES: GridDetection = { found: false, reason: "none" };

function looked(squares: GridDetection, rows: HexDetection, columns: HexDetection, width = 1000, height = 800): SearchDone {
  return { t: "done", result: squares, hex: { rows, columns }, width, height };
}

describe("the shape a search picks (docs/design-v1-grid-detect.md 10.5 to 10.7)", () => {
  const map = { widthPx: 1000, heightPx: 800 };

  test("hexes found alone are the scene's grid, scaled to the map's pixels, whatever the scene's shape", () => {
    // Decoded at half the map's size: the cell and the center double.
    const answer = looked(NO_SQUARES, hexFind("rows", 30.1, { x: 250.2, y: 199.6 }, 0.9), NO_HEX, 500, 400);
    for (const shape of [undefined, "hexRows", "hexColumns"] as const) {
      const found = pickedGrid(answer, map, shape);
      assert.equal(found?.shape, "hexRows", String(shape));
      assert.equal(found?.tier, "high");
      assert.deepEqual(found?.cal, calibrationFromHexFind({ cellPx: 60.2, center: { x: 500.4, y: 399.2 }, orient: "rows" }));
      assert.equal(found?.contested, undefined);
    }
    assert.equal(pickedGrid(looked(NO_SQUARES, NO_HEX, hexFind("columns", 50, { x: 500, y: 400 }, 0.45)), map, undefined)?.tier, "medium");
    assert.equal(pickedGrid(looked(NO_SQUARES, NO_HEX, hexFind("columns", 50, { x: 500, y: 400 }, 0.45)), map, undefined)?.shape, "hexColumns");
  });

  test("squares found alone are squares, as they always were, on a hex scene too", () => {
    const answer = looked(detection(50, { x: 10, y: 20 }, 0.9), NO_HEX, NO_HEX);
    assert.deepEqual(pickedGrid(answer, map, "hexRows"), { tier: "high", cal: { cellPx: 50, originPx: { x: 10, y: 20 } } });
    assert.deepEqual(pickedGrid(done(detection(50, { x: 10, y: 20 }, 0.9), 1000, 800), map, undefined), { tier: "high", cal: { cellPx: 50, originPx: { x: 10, y: 20 } } }, "an answer that looked for squares alone");
    assert.equal(pickedGrid(looked(NO_SQUARES, NO_HEX, NO_HEX), map, undefined), null);
  });

  test("two shapes found are only offered, on the scene's own shape when it is one of them, the other named", () => {
    const answer = looked(detection(70, { x: 10, y: 20 }, 0.7), hexFind("rows", 52, { x: 500, y: 400 }, 0.8), NO_HEX);
    // A square scene: its own squares are offered, though the hexes were surer.
    assert.deepEqual(pickedGrid(answer, map, undefined), { tier: "medium", cal: { cellPx: 70, originPx: { x: 10, y: 20 } }, contested: { shape: "hexRows", cellPx: 52 } });
    const onRows = pickedGrid(answer, map, "hexRows");
    assert.equal(onRows?.shape, "hexRows");
    assert.equal(onRows?.tier, "medium");
    assert.deepEqual(onRows?.contested, { shape: "squares", cellPx: 70 });
    // Neither is the scene's: the surer, still only offered.
    const onColumns = pickedGrid(answer, map, "hexColumns");
    assert.equal(onColumns?.shape, "hexRows");
    assert.equal(onColumns?.tier, "medium");
    assert.deepEqual(onColumns?.contested, { shape: "squares", cellPx: 70 });
  });

  test("a copy whose shape differs from the map's offers no hexes either", () => {
    assert.equal(pickedGrid(looked(NO_SQUARES, hexFind("rows", 50, { x: 0, y: 0 }, 0.9), NO_HEX, 800, 1000), map, undefined), null);
  });

  test("an import and new art take the shape found, a file name's size winning only on squares", () => {
    const answer = looked(NO_SQUARES, hexFind("columns", 50, { x: 500, y: 400 }, 0.9), NO_HEX);
    assert.equal(importFound(answer, false, map)?.shape, "hexColumns");
    assert.equal(importFound(answer, true, map), null, "named");
    const scene = { gridShape: "hexRows" as const, map: { originPx: { x: 0, y: 0 } } };
    assert.equal(replacementFound(answer, false, map, scene).found?.shape, "hexColumns");
  });
});

/** Line up grid's store and the ops a landing sends. */
function gridRoom() {
  const sent: ClientOp[] = [];
  let ids = 0;
  const actions = { dispatch: (op: ClientOp) => sent.push(op), newId: () => `g${++ids}` };
  const store = createStore<GridToolState>(() => ({ box: null, drag: null, fitScene: true, sceneId: null, found: null, finding: null }));
  return { sent, actions, store };
}

/** The center of the cell of a grid that holds a point, in the map's pixels. */
function nearestCenter(cal: Calibration, shape: GridShape | undefined, p: Point): Point {
  const g = gridOfShape(shape);
  const w = canonicalToWorld(cal, p);
  return worldToCanonical(cal, isHex(g) ? hexCenter(g, hexAt(g, w)) : { x: Math.floor(w.x) + 0.5, y: Math.floor(w.y) + 0.5 });
}

/** Whether every cell of `a` with its center on the map has a center of `b` within the slack, by brute force over every cell. */
function everyCellMeets(a: Calibration, b: Calibration, shape: GridShape | undefined, map: { widthPx: number; heightPx: number }, slack: number): boolean {
  const g = gridOfShape(shape);
  const from = canonicalToWorld(a, { x: 0, y: 0 });
  const to = canonicalToWorld(a, { x: map.widthPx, y: map.heightPx });
  const lo = (v: number) => Math.floor(Math.min(v, v / HEX_S)) - 2;
  const hi = (v: number) => Math.ceil(Math.max(v, v / HEX_S)) + 2;
  for (let col = lo(from.x); col <= hi(to.x); col++) {
    for (let row = lo(from.y); row <= hi(to.y); row++) {
      const c = worldToCanonical(a, isHex(g) ? hexCenter(g, { col, row }) : { x: col + 0.5, y: row + 0.5 });
      if (c.x < 0 || c.y < 0 || c.x > map.widthPx || c.y > map.heightPx) continue;
      const near = nearestCenter(b, shape, c);
      if (Math.hypot(near.x - c.x, near.y - c.y) > slack) return false;
    }
  }
  return true;
}

describe("new art of the old image's shape keeps the scene's grid, and a find there is only offered (D-261029-50)", () => {
  // The scene stood on 70 px squares from (20, 35) on a 1400 x 1000 map, and the new art is 1400 x 1000 too.
  const next = { widthPx: 1400, heightPx: 1000 };
  const kept = { cellPx: 70, originPx: { x: 20, y: 35 }, scale: 1 };
  const before = { map: { originPx: kept.originPx } };
  const landing = { id: "s1", bounds: { w: 20, h: 14 }, map: { assetId: "b", ...next, cellPx: kept.cellPx, originPx: kept.originPx } };
  /** A square find in the map's pixels, as the Worker answers it from a 700 x 500 decode. */
  const squaresAt = (cellPx: number, origin: { x: number; y: number }, confidence = 0.9) => done(detection(cellPx / 2, { x: origin.x / 2, y: origin.y / 2 }, confidence), 700, 500);

  test("a sure find that differs from the kept grid is only offered, and Line up grid applies nothing", () => {
    const sure = squaresAt(70, { x: 45, y: 10 });
    assert.equal(replacementFound(sure, false, next, before).found?.tier, "high", "on art of another shape it applies");
    const { found } = replacementFound(sure, false, next, before, kept);
    assert.deepEqual(found, { tier: "medium", cal: { cellPx: 70, originPx: { x: 45, y: 10 } } });
    const { sent, actions, store } = gridRoom();
    showOutcome({ actions, store, scene: landing, found, fit: true, at: { x: 700, y: 500 }, fallback: kept });
    assert.deepEqual(sent, [], "nothing applied");
    assert.equal(store.getState().found?.outcome, "offered");
    assert.deepEqual(store.getState().found?.cal, found?.cal, "the box on the lines found");
  });

  test("a find that puts its cells where the kept grid has them is none, sure or doubtful: the scene stands on it already", () => {
    assert.equal(replacementFound(squaresAt(70, { x: 20, y: 35 }), false, next, before, kept).found, null);
    assert.equal(replacementFound(squaresAt(70.01, { x: 20.4, y: 34.7 }), false, next, before, kept).found, null, "within a pixel at every corner");
    assert.equal(replacementFound(squaresAt(70, { x: 20, y: 35 }, 0.45), false, next, before, kept).found, null);
  });

  test("a size off by half a percent lines up at the map's middle but not at its corners, and is offered", () => {
    // 70.35 px squares whose lines meet the kept ones at the middle's cell, (9, 6), and miss them by 3 px at the corners.
    const found = replacementFound(squaresAt(70.35, { x: 16.85, y: 32.9 }), false, next, before, kept).found;
    assert.equal(found?.tier, "medium");
    assert.equal(found?.cal.cellPx, 70.35);
  });

  test("on hex rows the same hexes say nothing, and squares found surely are only offered, the shape kept", () => {
    const center = { x: 704, y: 498 };
    const hexKept = { ...calibrationFromHexFind({ cellPx: 64, center, orient: "rows" }), scale: 1 };
    const hexScene = { gridShape: "hexRows" as const, map: { originPx: hexKept.originPx } };
    const hexes = looked(NO_SQUARES, hexFind("rows", 32, { x: center.x / 2, y: center.y / 2 }, 0.9), NO_HEX, 700, 500);
    assert.equal(replacementFound(hexes, false, next, hexScene, hexKept).found, null);
    assert.equal(keptGridHolds({ tier: "high", cal: hexKept }, hexKept, "hexRows", next), false, "squares are not the hexes, whatever their numbers");
    const squares = looked(detection(35, { x: 10, y: 17.5 }, 0.9), NO_HEX, NO_HEX, 700, 500);
    assert.equal(replacementFound(squares, false, next, hexScene).found?.tier, "high", "on art of another shape squares would switch the scene");
    const { found } = replacementFound(squares, false, next, hexScene, hexKept);
    assert.equal(found?.tier, "medium");
    const { sent, actions, store } = gridRoom();
    showOutcome({ actions, store, scene: { ...landing, gridShape: "hexRows", map: { ...landing.map, cellPx: hexKept.cellPx, originPx: hexKept.originPx } }, found, fit: true, at: { x: 700, y: 500 }, fallback: hexKept });
    assert.deepEqual(sent, [], "neither the shape nor the grid sent");
    assert.equal(store.getState().found?.other?.shape, "squares", "the squares said, for Grid shape to bring");
  });

  /** A phone's search of the copy that outlived the wait, landed by Line up grid with the kept grid or without it, answering `answer`, on the scene as `now` has it then. */
  const landLate = async (answer: SearchDone, withKept: boolean, now: typeof landing = landing) => {
    const room = gridRoom();
    const worker = new FakeWorker();
    const search = searchGrid({ urls: ["/m/mobile"] }, () => worker);
    const landed = landSearch({ actions: room.actions, store: room.store, sceneId: "s1", start: landing, scene: () => now, search, ms: 30_000, timers: fakeTimers(), fit: true, fallback: kept, ...(withKept ? { kept } : {}) });
    worker.answer(answer);
    await landed;
    return room;
  };

  test("a phone's search that outlives the wait lands only as an offer", async () => {
    for (const withKept of [false, true]) {
      const { sent, store } = await landLate(squaresAt(70, { x: 45, y: 10 }), withKept);
      assert.equal(store.getState().found?.outcome, withKept ? "offered" : "applied");
      assert.equal(sent.length > 0, !withKept);
    }
  });

  test("a phone's late find on the kept grid's lines is dropped silently, sure or doubtful, as on time (FU35B-LATE-MATCH)", async () => {
    for (const confidence of [0.9, 0.45]) {
      const { sent, store } = await landLate(squaresAt(70.01, { x: 20.4, y: 34.7 }, confidence), true);
      assert.deepEqual(sent, [], `${confidence}: nothing applied`);
      assert.equal(store.getState().found, null, `${confidence}: no box, no line`);
      assert.equal(store.getState().finding, null, `${confidence}: no longer looking`);
    }
    // The same lines beside hexes are still said, naming both, as on time.
    const both = looked(detection(35, { x: 10, y: 17.5 }, 0.7), hexFind("rows", 26, { x: 350, y: 250 }, 0.8), NO_HEX, 700, 500);
    const { store } = await landLate(both, true);
    assert.equal(store.getState().found?.outcome, "offered");
    assert.deepEqual(store.getState().found?.contested, { shape: "hexRows", cellPx: 52 });
    // On a scene that changed meanwhile, the kept grid's lines are still no find, so nothing says a grid found was not applied. Lines that differ say so.
    const resized = { ...landing, bounds: { w: 21, h: 14 } };
    assert.equal((await landLate(squaresAt(70, { x: 20, y: 35 }), true, resized)).store.getState().found, null);
    assert.equal((await landLate(squaresAt(70, { x: 45, y: 10 }), true, resized)).store.getState().found?.outcome, "changed");
  });

  test("a finer or coarser grid on the kept grid's centers is another grid, and offered (review FU35B-ASTRA-01)", () => {
    // Every kept center lies on a lattice a whole fraction of its size from the same origin, so the sizes decide.
    assert.equal(replacementFound(squaresAt(70, { x: 20, y: 35 }), false, next, before, { cellPx: 210, originPx: { x: 20, y: 35 }, scale: 1 }).found?.cal.cellPx, 70, "a third of the kept squares");
    assert.equal(replacementFound(squaresAt(70 / 3, { x: 20, y: 35 }), false, next, before, kept).found?.tier, "medium", "70 against 70 / 3");
    const center = { x: 704, y: 498 };
    const rows = { ...calibrationFromHexFind({ cellPx: 64, center, orient: "rows" }), scale: 1 };
    const halfRows = looked(NO_SQUARES, hexFind("rows", 16, { x: center.x / 2, y: center.y / 2 }, 0.9), NO_HEX, 700, 500);
    assert.equal(replacementFound(halfRows, false, next, { gridShape: "hexRows", map: { originPx: rows.originPx } }, rows).found?.cal.cellPx, 32, "64 against 32 on hex rows");
  });

  test("on hex columns the same hexes say nothing", () => {
    const center = { x: 702, y: 497 };
    const columns = { ...calibrationFromHexFind({ cellPx: 64, center, orient: "columns" }), scale: 1 };
    const again = looked(NO_SQUARES, NO_HEX, hexFind("columns", 32, { x: center.x / 2, y: center.y / 2 }, 0.9), 700, 500);
    assert.equal(replacementFound(again, false, next, { gridShape: "hexColumns", map: { originPx: columns.originPx } }, columns).found, null);
  });

  test("the kept squares found again beside hexes are still said, naming both (review FU35B-ASTRA-02)", () => {
    // Squares on the kept lines and hexes as tiles under them: the squares alone would say nothing, but the hexes are news (design 10.6).
    const both = looked(detection(35, { x: 10, y: 17.5 }, 0.7), hexFind("rows", 26, { x: 350, y: 250 }, 0.8), NO_HEX, 700, 500);
    const { found } = replacementFound(both, false, next, before, kept);
    assert.deepEqual(found, { tier: "medium", cal: { cellPx: 70, originPx: { x: 20, y: 35 } }, contested: { shape: "hexRows", cellPx: 52 } });
    const { sent, actions, store } = gridRoom();
    const note = showOutcome({ actions, store, scene: landing, found, fit: true, at: { x: 700, y: 500 }, fallback: kept });
    assert.deepEqual(sent, [], "nothing applied");
    assert.equal(note && foundLine(note, SQUARES).content, "The map shows squares of 70 px and hexes of 52 px. Check the box, then Apply.");
  });

  test("art twice the size keeps a grid found on the smaller copy, scaled with its errors, and the same lines found again say nothing (D-261029-54)", () => {
    // Hex rows whose first row sits 0.7 px under the small copy's edge, folded there (FOUND_SNAP_PX), and 1.4 px under it at twice the size, kept.
    const center = { x: 700.3, y: 721.75 };
    const small = calibrationFromHexFind({ cellPx: 44.73 / 2, center: { x: center.x / 2, y: center.y / 2 }, orient: "rows" });
    const scaled = { cellPx: small.cellPx * 2, originPx: { x: small.originPx.x * 2, y: small.originPx.y * 2 } };
    const scene = { gridShape: "hexRows" as const, map: { originPx: small.originPx } };
    const again = looked(NO_SQUARES, hexFind("rows", 44.73 / 2, { x: center.x / 2, y: center.y / 2 }, 0.9), NO_HEX, 700, 500);
    assert.equal(replacementFound(again, false, next, scene, { ...scaled, scale: 2 }).found, null);
    assert.equal(replacementFound(again, false, next, scene, { ...scaled, scale: 1 }).found?.tier, "medium", "the 1 px slack of art the same size would offer it");
  });

  test("a grid of another spacing whose centers meet the kept ones at all five points is another grid, and offered (review FU35B-ASTRA-01, round 2)", () => {
    // 100 px squares from the corner and 80 px ones from (10, 10) meet every 400 px, at every point looked at on 900 by 900.
    const squares = done(detection(80, { x: 10, y: 10 }, 0.9), 900, 900);
    const square100 = { cellPx: 100, originPx: { x: 0, y: 0 }, scale: 1 };
    assert.equal(replacementFound(squares, false, { widthPx: 900, heightPx: 900 }, { map: { originPx: square100.originPx } }, square100).found?.cal.cellPx, 80);
    // 70 px squares from the corner and 52.5 px ones from (8.75, 8.75) meet every 210 px, at all five points on 500 by 500.
    const square70 = { cellPx: 70, originPx: { x: 0, y: 0 }, scale: 1 };
    const quarters = done(detection(52.5, { x: 8.75, y: 8.75 }, 0.9), 500, 500);
    assert.equal(replacementFound(quarters, false, { widthPx: 500, heightPx: 500 }, { map: { originPx: square70.originPx } }, square70).found?.cal.cellPx, 52.5);
    // Hexes of 100 and 80 px around one center meet on a lattice of 400: on 1300 by 793 at all five points too.
    for (const [orient, shape, size] of [
      ["rows", "hexRows", { widthPx: 1300, heightPx: 793 }],
      ["columns", "hexColumns", { widthPx: 793, heightPx: 1300 }],
    ] as const) {
      const center = { x: 50, y: 50 };
      const hex100 = { ...calibrationFromHexFind({ cellPx: 100, center, orient }), scale: 1 };
      const find = hexFind(orient, 80, center, 0.9);
      const answer = looked(NO_SQUARES, orient === "rows" ? find : NO_HEX, orient === "rows" ? NO_HEX : find, size.widthPx, size.heightPx);
      assert.equal(replacementFound(answer, false, size, { gridShape: shape, map: { originPx: hex100.originPx } }, hex100).found?.cal.cellPx, 80, orient);
    }
  });

  test("grids of near sizes drift apart a cell at a time, so one that meets the kept grid at the middle and every corner can miss it between (review FU35B-ASTRA-01, round 3)", () => {
    // Astra's map: 20 px squares from the corner and 19.2 px ones from (0.4, 0.4) meet at the middle and at all four corners, and miss by 9.6 px between.
    const kept20 = { cellPx: 20, originPx: { x: 0, y: 0 }, scale: 1 };
    const map980 = { widthPx: 980, heightPx: 980 };
    assert.equal(keptGridHolds({ tier: "high", cal: { cellPx: 19.2, originPx: { x: 0.4, y: 0.4 } } }, kept20, undefined, map980), false);
    const answer = done(detection(19.2, { x: 0.4, y: 0.4 }, 0.78), 980, 980);
    assert.equal(replacementFound(answer, false, map980, { map: { originPx: kept20.originPx } }, kept20).found?.tier, "medium");
    // The same slip on hexes: 19 px hexes against 20 px ones, a whole hex out between the middle and each corner.
    const rows = { tier: "high" as const, cal: { cellPx: 19, originPx: { x: 67, y: 49.941 } }, shape: "hexRows" as const };
    assert.equal(keptGridHolds(rows, kept20, "hexRows", { widthPx: 2673, heightPx: 2010 }), false, "hex rows");
    const columns = { tier: "high" as const, cal: { cellPx: 19, originPx: { x: 49.941, y: 67 } }, shape: "hexColumns" as const };
    assert.equal(keptGridHolds(columns, kept20, "hexColumns", { widthPx: 2010, heightPx: 2673 }), false, "hex columns");
    // Every row is measured at its ends, not only the first and the last: hex rows start half a hex apart, so the second row can reach further out.
    const kept49 = { cellPx: 49.086, originPx: { x: 46.53, y: 22.381 }, scale: 1 };
    const near49 = { tier: "high" as const, cal: { cellPx: 49.16, originPx: { x: 45.613, y: 22.029 } }, shape: "hexRows" as const };
    const map978 = { widthPx: 978, heightPx: 418 };
    assert.equal(keptGridHolds(near49, kept49, "hexRows", map978), false, "a row's end inside the outer rows'");
    assert.equal(everyCellMeets(kept49, near49.cal, "hexRows", map978, 1), false);
  });

  test("a find holds the kept grid exactly when each cell of either with its center on the map has a cell of the other within the slack, on 3,000 drawn pairs (review FU35B-ASTRA-01, round 3)", () => {
    const random = rng(20261029);
    const between = (lo: number, hi: number) => lo + (hi - lo) * random();
    let holds = 0;
    let made = 0;
    const wrong: string[] = [];
    while (made < 3000) {
      const shape = ([undefined, "hexRows", "hexColumns"] as const)[Math.floor(3 * random())];
      let map = { widthPx: Math.round(between(200, 2000)), heightPx: Math.round(between(200, 2000)) };
      const scale = random() < 0.7 ? 1 : 2 + Math.floor(7 * random());
      // Every map holds 3 cells or more across, and its cells are 10 times the slack or more: a scene's map and grid.
      const largest = Math.min(150, map.widthPx / 3, map.heightPx / 3);
      const smallest = Math.max(12, 10 * scale);
      if (smallest > largest) continue;
      made++;
      const cellPx = smallest * (largest / smallest) ** random();
      const kept = { cellPx, originPx: { x: between(0, cellPx), y: between(0, cellPx) }, scale };
      const slack = Math.max(FOUND_SNAP_PX * scale, FOUND_SNAP * cellPx);
      // A grid that slips a whole cell of its own in n cells, on a map n cells either side of its middle cell, square or a few cells across the other way:
      // the slip lands on the corners, or on the ends of every row.
      const n = Math.ceil(cellPx / slack) + Math.floor(3 * random());
      const tuned = random() < 0.2 && cellPx * (2 * n + 1) <= 2600;
      if (tuned) {
        const long = Math.round(cellPx * (2 * n + 1));
        const short = random() < 0.5 ? long : Math.round(cellPx * between(3, 6));
        map = random() < 0.5 ? { widthPx: long, heightPx: short } : { widthPx: short, heightPx: long };
      }
      const middle = nearestCenter(kept, shape, { x: map.widthPx / 2, y: map.heightPx / 2 });
      // A found grid of `size` px whose cell at the kept middle cell's place is `off` from it.
      const meeting = (size: number, off: number): Calibration => {
        const world = canonicalToWorld(kept, middle);
        return { cellPx: size, originPx: { x: middle.x + between(-off, off) - size * world.x, y: middle.y + between(-off, off) - size * world.y } };
      };
      // Near the kept grid by about what the slack allows across this map; slipping a whole cell every n cells, within the slack in size;
      // a whole fraction or multiple of its size; or any other grid near its size.
      const kind = random();
      const across = Math.max(map.widthPx, map.heightPx) / cellPx;
      let cal: Calibration;
      if (tuned) cal = meeting(cellPx * (random() < 0.5 ? n / (n + 1) : n / (n - 1)), 0.5 * slack);
      else if (kind < 0.35) cal = meeting(cellPx + between(-2, 2) * (slack / across), 0.8 * slack);
      else if (kind < 0.6) {
        const n = Math.ceil(cellPx / slack) + Math.floor(20 * random());
        cal = meeting(cellPx * (1 + (random() < 0.5 ? 1 : -1) / n), 0.8 * slack);
      } else if (kind < 0.75) cal = meeting(cellPx * [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 4 / 3, 3 / 2, 2, 3][Math.floor(9 * random())]!, slack);
      else {
        const size = cellPx * between(0.95, 1.05);
        cal = { cellPx: size, originPx: { x: between(0, size), y: between(0, size) } };
      }
      const found = { tier: "high" as const, cal, ...(shape ? { shape } : {}) };
      const truth = everyCellMeets(kept, cal, shape, map, slack) && everyCellMeets(cal, kept, shape, map, slack);
      if (truth) holds++;
      if (keptGridHolds(found, kept, shape, map) !== truth) wrong.push(`${shape ?? "squares"} ${map.widthPx} x ${map.heightPx}, kept ${JSON.stringify(kept)}, found ${JSON.stringify(cal)}: truth ${truth}`);
    }
    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} wrong`);
    assert.ok(holds > 300 && holds < 2700, `${holds} hold`);
  });

  test("the slack's pixel floor grows with the art, its share of a cell only with the cell (review FU35B-ASTRA-04)", () => {
    // 700 px art replaced by 5600 px art: kept 70 px squares become 560 px, and the slack 8 px, not 1% of 560 px times 8.
    const big = { widthPx: 5600, heightPx: 4000 };
    const at = (cellPx: number, x: number, y: number) => done(detection(cellPx, { x, y }, 0.9), 5600, 4000);
    const by8 = { cellPx: 560, originPx: { x: 160, y: 280 }, scale: 8 };
    assert.equal(replacementFound(at(560, 190, 280), false, big, { map: { originPx: by8.originPx } }, by8).found?.tier, "medium", "30 px off is another grid");
    assert.equal(replacementFound(at(560, 166, 280), false, big, { map: { originPx: by8.originPx } }, by8).found, null, "6 px off is within 8");
    // 4 times larger, 280 px cells: the slack is 4 px, the floor times the scale.
    const by4 = { cellPx: 280, originPx: { x: 80, y: 140 }, scale: 4 };
    assert.equal(replacementFound(at(280, 86, 140), false, big, { map: { originPx: by4.originPx } }, by4).found?.tier, "medium", "6 px off");
    assert.equal(replacementFound(at(280, 83, 140), false, big, { map: { originPx: by4.originPx } }, by4).found, null, "3 px off");
  });

  test("only offered: the surest just under the line, the shapes in the same order", () => {
    const answer = looked(detection(35, { x: 10, y: 17.5 }, 0.9), hexFind("rows", 26, { x: 350, y: 250 }, 0.8), NO_HEX, 700, 500);
    const offered = offeredOnly(answer);
    const pick = pickShape(offered.result, offered.hex!.rows, offered.hex!.columns);
    assert.deepEqual(pick && { shape: pick.shape, contested: pick.contested }, { shape: "squares", contested: true });
    assert.ok(pick && pick.confidence < HIGH_CONFIDENCE && pick.confidence > HIGH_CONFIDENCE - 0.02);
    const doubtful = done(detection(35, { x: 10, y: 17.5 }, 0.45), 700, 500);
    assert.equal(offeredOnly(doubtful), doubtful, "a doubtful answer as it was");
  });
});
