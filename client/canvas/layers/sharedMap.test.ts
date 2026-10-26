import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mapSwap, type ShownMap } from "../../features/phases/swap.ts";
import { mapReadable, release, type MapImageState, type MapSource } from "../useImage.ts";
import { LOADING, treeMap, type SharedMap } from "./sharedMap.ts";

/** A decoded bitmap as the loader makes one: close() frees it, and a freed one throws when drawn. */
function bitmap(name: string): MapSource & { closed: boolean } {
  const b = { name, width: 100, height: 80, closed: false, close: () => void (b.closed = true) };
  return b as unknown as MapSource & { closed: boolean };
}

const RECT = { x: 0, y: 0, width: 10, height: 8 };
const ready = (image: MapSource): MapImageState => ({ image, status: "ready" });

/** One render of one tree's map layer under the shared loader: what it draws, and what it keeps for the next render. */
function render(shared: SharedMap, propsUrl: string, kept: ShownMap<MapSource> | null) {
  const { state, keepsLast } = treeMap(shared, propsUrl, LOADING);
  return mapSwap({ sceneId: "s1", assetId: propsUrl, rect: RECT, status: state.status, image: state.image }, keepsLast ? kept : null);
}

describe("the board's trees share one map image", () => {
  test("a map layer whose map differs from the shared one draws nothing and keeps no image (ISO2-OPUS-11)", () => {
    const a = bitmap("a");
    const shown = render({ url: "a", state: ready(a) }, "a", null);
    assert.equal(shown.draw?.image, a);
    // A hidden tree keeps map a's props while the loader moves on to b.
    const hidden = render({ url: "b", state: LOADING }, "a", shown.keep);
    assert.equal(hidden.draw, null, "it draws nothing of a");
    assert.equal(hidden.keep, null, "and keeps nothing, so its tints let go of a too");
    // Its own loader, as off the board, still keeps the last image up while the next loads.
    assert.equal(mapSwap({ sceneId: "s1", assetId: "b", rect: RECT, ...treeMap(null, "b", LOADING).state }, shown.keep).draw?.image, a);
  });

  test("two phase swaps while Top-down is frozen never draw a freed bitmap when it shows again", () => {
    const a1 = bitmap("a1");
    const a2 = bitmap("a2");
    let kept = render({ url: "a1", state: ready(a1) }, "a1", null).keep;
    // Isometric shows and Top-down is frozen on phase a1's props. The loader swaps to a2, then frees a1.
    kept = render({ url: "a2", state: LOADING }, "a1", kept).keep;
    kept = render({ url: "a2", state: ready(a2) }, "a1", kept).keep;
    release(a1);
    // Then to a3, which is still loading when Top-down shows again on a3's props.
    kept = render({ url: "a3", state: LOADING }, "a1", kept).keep;
    const back = render({ url: "a3", state: LOADING }, "a3", kept);
    assert.ok(!back.draw || !(back.draw.image as unknown as { closed: boolean }).closed, "no freed bitmap drawn");
    assert.equal(back.draw, null);
  });

  test("a drawn map stays readable only while the loader still holds it, and never once freed", () => {
    const a = bitmap("a");
    const b = bitmap("b");
    assert.equal(mapReadable(a, ready(a)), true);
    assert.equal(mapReadable(a, LOADING), true, "the loader holds the last image while the next loads");
    // The render in which b settles, before the commit that frees a.
    assert.equal(mapReadable(a, ready(b)), false);
    assert.equal(mapReadable(a, { image: null, status: "failed" }), false);
    assert.equal(mapReadable(a, null), true, "an image a reader's own hook loaded");
    release(a);
    assert.equal(mapReadable(a, LOADING), false, "a freed bitmap, whatever the loader says");
    assert.equal(mapReadable(a, null), false);
  });
});
