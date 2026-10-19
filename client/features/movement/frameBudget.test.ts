import assert from "node:assert/strict";
import { test } from "node:test";
import { frameBudget } from "./frameBudget.ts";

test("a frame's search time is one budget for every search that asks in it (5.2)", () => {
  let clock = 100;
  const frames: (() => void)[] = [];
  const deadline = frameBudget(() => clock, (run) => frames.push(run), 4);
  assert.equal(deadline(), 104);
  clock = 103;
  assert.equal(deadline(), 104, "a second search in the same frame shares what is left");
  assert.equal(frames.length, 1);
  frames.shift()!();
  clock = 117;
  assert.equal(deadline(), 121, "the next frame opens its own");
});
