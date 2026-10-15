import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mapSwap, sameShown, type MapSwapInput, type ShownMap } from "./swap.ts";

type Img = { name: string };
const DAY: Img = { name: "day" };
const NIGHT: Img = { name: "night" };
const FIRE: Img = { name: "fire" };
const RECT = { x: -0.5, y: -0.25, width: 30, height: 20 };
// A half-size phase on the same reference grid lands on the same cells.
const HALF_RECT = { x: -0.5, y: -0.25, width: 30, height: 20 };

function input(over: Partial<MapSwapInput<Img>>): MapSwapInput<Img> {
  return { sceneId: "crypt", assetId: "day", rect: RECT, status: "loading", image: null, ...over };
}

/** Runs the layer's loop: each answer is drawn, and its `keep` is what the next render remembers. */
function run(steps: MapSwapInput<Img>[]) {
  let kept: ShownMap<Img> | null = null;
  return steps.map((step) => {
    const out = mapSwap(step, kept);
    kept = out.keep;
    return { drawn: out.draw?.image.name ?? null, swapping: out.swapping };
  });
}

describe("the map image while the map changes", () => {
  test("a scene's first map shows nothing until it is ready, as before", () => {
    assert.deepEqual(run([input({}), input({ status: "ready", image: DAY })]), [
      { drawn: null, swapping: false },
      { drawn: "day", swapping: false },
    ]);
  });

  test("a phase switch keeps the old image up, at its own place, until the new one has decoded", () => {
    let kept: ShownMap<Img> | null = null;
    kept = mapSwap(input({ status: "ready", image: DAY }), kept).keep;
    const mid = mapSwap(input({ assetId: "night", rect: HALF_RECT, status: "loading" }), kept);
    assert.equal(mid.draw?.image, DAY);
    assert.equal(mid.draw?.rect, RECT);
    assert.equal(mid.swapping, true);
    const done = mapSwap(input({ assetId: "night", rect: HALF_RECT, status: "ready", image: NIGHT }), mid.keep);
    assert.equal(done.draw?.image, NIGHT);
    assert.equal(done.swapping, false);
    assert.equal(done.keep?.assetId, "night");
  });

  test("switching again before the new image is ready keeps the last image drawn", () => {
    assert.deepEqual(
      run([
        input({ status: "ready", image: DAY }),
        input({ assetId: "night" }),
        input({ assetId: "fire" }),
        input({ assetId: "fire", status: "ready", image: FIRE }),
      ]).map((s) => s.drawn),
      ["day", "day", "day", "fire"],
    );
  });

  test("another scene never shows the last scene's map", () => {
    assert.deepEqual(run([input({ status: "ready", image: DAY }), input({ sceneId: "caves", assetId: "cave" })]), [
      { drawn: "day", swapping: false },
      { drawn: null, swapping: false },
    ]);
  });

  test("a new image that fails drops the old one, so the map is never stale", () => {
    assert.deepEqual(
      run([input({ status: "ready", image: DAY }), input({ assetId: "night" }), input({ assetId: "night", status: "failed" }), input({ assetId: "fire" })]).map(
        (s) => s.drawn,
      ),
      ["day", "day", null, null],
    );
  });

  test("a map that cannot be placed draws nothing and keeps nothing", () => {
    assert.deepEqual(run([input({ status: "ready", image: DAY }), input({ assetId: "night", rect: null }), input({ assetId: "fire" })]).map((s) => s.drawn), [
      "day",
      null,
      null,
    ]);
  });

  test("lining up the grid moves the same image at once", () => {
    const moved = { ...RECT, x: 1 };
    const out = run([input({ status: "ready", image: DAY }), input({ status: "ready", image: DAY, rect: moved })]);
    assert.deepEqual(out.map((s) => s.drawn), ["day", "day"]);
  });

  test("an unchanged answer keeps the same value, so the layer stores it once and settles", () => {
    const first = mapSwap(input({ status: "ready", image: DAY }), null);
    const again = mapSwap(input({ status: "ready", image: DAY }), first.keep);
    assert.equal(again.keep, first.keep);
    assert.ok(sameShown(first.keep, { sceneId: "crypt", assetId: "day", image: DAY, rect: { ...RECT } }));
    assert.equal(sameShown(first.keep, { sceneId: "crypt", assetId: "day", image: NIGHT, rect: RECT }), false);
    assert.equal(sameShown(null, first.keep), false);
  });
});
