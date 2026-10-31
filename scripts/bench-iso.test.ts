import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CDPSession, Page } from "playwright-core";
import { CAP_FIRST_ROW, gate, hexRelief, largestGate, partsPast, tetherWork, timedUntil } from "./bench-iso.ts";

/*
 * The isometric bench's build rows (docs/design-v1-iso-area-shapes.md 6
 * and 11, review ISOA2-ASTRA-04): a build's frames are taken until it is
 * done, none of the idle ones after it, and each is held by the gate.
 */

/** A page whose main thread is busy `costs[i]` ms in its `i`th frame, and whose build is done after `doneAfter` frames. */
function fakePage(costs: readonly number[], doneAfter: number): { page: Page; cdp: CDPSession; done: () => Promise<boolean> } {
  let frame = 0;
  let busy = 0;
  const page = {
    evaluate: async () => {
      busy += costs[frame] ?? 0.1;
      frame++;
    },
  } as unknown as Page;
  const cdp = { send: async () => ({ metrics: [{ name: "TaskDuration", value: busy / 1000 }] }) } as unknown as CDPSession;
  return { page, cdp, done: async () => frame >= doneAfter };
}

describe("the isometric bench's build rows", () => {
  test("the long diagonal tether row exercises the full stroke within a linear candidate bound", async () => {
    const work = await tetherWork();
    assert.equal(work.visited, 2404);
    assert.ok(work.candidates <= 32 * 200 + 32, `${work.candidates} candidates`);
  });
  test("take a build's frames until it is done, and none of the idle ones after it", async () => {
    const costs = [40, 6, 6, 6, 6, 180, 0.1, 0.1, 0.1];
    const { page, cdp, done } = fakePage(costs, 6);
    const got = await timedUntil(page, cdp, async () => {}, done);
    assert.equal(got.frames.length, 6);
    assert.deepEqual(got.frames.map((f) => Math.round(f)), [40, 6, 6, 6, 6, 180]);
  });

  test("hold every frame of a build to the budget, not their median", () => {
    const frames = [...Array<number>(30).fill(6), 180];
    assert.match(gate(CAP_FIRST_ROW, { median: 6, max: 180, n: frames.length, frames }, undefined), /^OVER: 1 of 31 frames past 16\.0, the largest 180\.0/);
    assert.match(gate(CAP_FIRST_ROW, { median: 6, max: 12, n: 2, frames: [6, 12] }, undefined), /^ok, every frame/);
    assert.match(gate("pan, typical, 40 px", { median: 15, max: 40, n: 2 }, 9), /^ok/, "a row of frames that are not a build's keeps its median");
  });
});

describe("the hex relief rooms (docs/design-v1-iso-hex-relief.md 9)", () => {
  test("each orientation raises every one of a 40 by 40 scene's 1,778 hexes, across the whole height range, with a wall, 40 creatures and four areas", () => {
    for (const orient of ["rows", "columns"] as const) {
      const built = hexRelief(orient)("s1", "dm");
      const heights = built.ops.filter((o) => o.t === "build.height") as { cells: string[]; height: number }[];
      const cells = heights.flatMap((o) => o.cells);
      assert.equal(new Set(cells).size, 1778, orient);
      assert.equal(cells.length, 1778, `${orient}: each hex once`);
      assert.ok(heights.every((o) => o.height !== 0), `${orient}: none left at 0`);
      const feet = heights.map((o) => o.height);
      assert.ok(Math.min(...feet) <= -100 + 5 && Math.max(...feet) >= 195, `${orient}: ${Math.min(...feet)} to ${Math.max(...feet)}`);
      assert.equal(built.ops.filter((o) => o.t === "token.create").length, 40);
      assert.equal(built.ops.filter((o) => o.t === "template.create").length, 4);
      assert.ok(built.ops.some((o) => o.t === "build.walls"));
    }
  });
});

describe("the largest-move gate (D-261030-538, review HXPERF2-ASTRA-09)", () => {
  const ms = (rounds: number[]) => ({ median: 8, max: Math.max(...rounds), n: 48, rounds });
  test("each round's largest move against its own round's Top-down match: a row misses when two of three pairs do, and says its medians and its worst move apart", () => {
    const row = "pan, 12 px, hex relief rows";
    // Top-down's 20, 30, 20: budgets 35, 52.5, 35. Isometric's 40 misses its pair, 40 makes the second, 30 the third.
    assert.match(largestGate(row, ms([40, 40, 30]), ms([20, 30, 20])), /ok in 2 of 3 pairs$/, "the medians' comparison would miss: 40 against 1.75 times 20");
    assert.match(largestGate(row, ms([40, 60, 30]), ms([20, 30, 20])), /OVER in 2 of 3 pairs$/);
    assert.match(largestGate(row, ms([40, 60, 30]), ms([20, 30, 20])), /^largest moves 40\.0, 60\.0, 30\.0 \(median 40\.0, worst 60\.0\)/);
    assert.match(largestGate(row, ms([10, 12, 15]), ms([2, 2, 2])), /budgets 16\.0, 16\.0, 16\.0: ok/, "the 16 ms floor");
  });

  test("the caps report theirs, ungated", () => {
    assert.match(largestGate("pan, caps, 12 px", ms([90, 90, 90]), ms([10, 10, 10])), /: reported$/);
  });
});

describe("the square relief room (docs/design-v1-relief-pan.md 9)", () => {
  test("the hex room's generator on squares raises each of the 1,600 squares once, none at 0", () => {
    const built = hexRelief("squares")("s1", "dm");
    const heights = built.ops.filter((o) => o.t === "build.height") as { cells: string[]; height: number }[];
    const cells = heights.flatMap((o) => o.cells);
    assert.equal(new Set(cells).size, 1600);
    assert.equal(cells.length, 1600);
    assert.ok(heights.every((o) => o.height !== 0));
    assert.ok(!built.ops.some((o) => o.t === "scene.update" && "gridShape" in (o.patch as object)), "squares, the default grid");
  });
});

describe("the parts of a pan's slow frames among building areas (docs/design-v1-relief-pan.md 8)", () => {
  test("only the frames past the floor are counted, each by every part it holds, and the slices of every frame apart", () => {
    const f = (ms: number, whole = false, sliced = false, rendered = false) => ({ ms, whole, sliced, rendered });
    const parts = [f(8, false, true), f(16), f(17, true, false, true), f(21, false, true), f(30, true, true, true)];
    assert.deepEqual(partsPast(parts, 16), { frames: 3, whole: 2, sliced: 2, rendered: 2, slicedAll: 3 });
  });
});
