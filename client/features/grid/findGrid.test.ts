import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { jpegOrientation, sniffImage } from "../uvtt/image.ts";
import { detectGrid, type AxisFit, type GridDetection } from "./detect.ts";
import { calibrationFromHexFind } from "./calibrate.ts";
import type { HexDetection } from "./detectHex.ts";
import { cameWithGrid, decodeSize, headerSize, importSearch, importSearchFrom, findFound, foundGrid, importFound, nameGivesSize, pickedGrid, replacementFound, searchGrid, searchOnImport, within, type SearchAnswer, type SearchDone, type SearchRequest, type SearchWorker, type Timers } from "./findGrid.ts";
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
