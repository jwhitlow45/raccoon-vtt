import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AxisFit, GridDetection } from "./detect.ts";
import { cameWithGrid, findFound, foundGrid, importFound, nameGivesSize, searchGrid, searchOnImport, within, type SearchAnswer, type SearchDone, type SearchRequest, type SearchWorker, type Timers } from "./findGrid.ts";
import { rng } from "./synthetic.ts";

const AXIS = { found: 20, expected: 20, from: 0, to: 0, snr: 50, between: 0, parity: 1, rms: 0.1, continuity: 1, restart: 0, coverage: 1, drift: 0 } as const;

function detection(cellPx: number, origin: { x: number; y: number }, confidence: number): GridDetection {
  const axis = (phase: number) => ({ ...AXIS, period: cellPx, phase }) as AxisFit & typeof AXIS;
  return { found: true, cellPx, originPx: origin, confidence, polarity: "dark", across: axis(origin.x), down: axis(origin.y) };
}

function done(result: GridDetection, width: number, height: number): SearchDone {
  return { t: "done", result, width, height };
}

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
    assert.equal(cameWithGrid({ autoWalls: "off", map: corner }), true, "the import turns automatic walls off");
    assert.equal(cameWithGrid({ autoWalls: "floor", map: { originPx: { x: -25, y: 0 } } }), true, "only the import puts the first line before the image");
    assert.equal(cameWithGrid({ autoWalls: "floor", map: corner }), false);
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
