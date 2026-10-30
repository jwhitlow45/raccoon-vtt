import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CDPSession, Page } from "playwright-core";
import { CAP_FIRST_ROW, gate, tetherWork, timedUntil } from "./bench-iso.ts";

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
