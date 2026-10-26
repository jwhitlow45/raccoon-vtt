import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Scene } from "../model.ts";
import { HEX_ORIGIN } from "../rules/grid.ts";
import { apply, refused, room, scene } from "../testutil.ts";

/**
 * A phase switch on a hex scene keeps the map's origin at or after the
 * image's top-left (D-261026-8), as every other op that writes a map does.
 * No op makes such a scene, so the case is a hand-made backup's (HXD-6).
 */

function phased(gridShape?: Scene["gridShape"]): Scene {
  return scene("s1", {
    ...(gridShape ? { gridShape } : {}),
    map: { assetId: "day", widthPx: 2000, heightPx: 1000, cellPx: 100, originPx: { x: 20, y: 10 } },
    phases: [
      { id: "p1", name: "Day", assetId: "day", widthPx: 2000, heightPx: 1000 },
      { id: "p2", name: "Night", assetId: "night", widthPx: 1000, heightPx: 500 },
    ],
    phaseId: "p1",
    // The reference grid's first line lies before the image.
    phaseGrid: { refWidthPx: 2000, refHeightPx: 1000, cellPx: 100, originPx: { x: -20, y: 10 } },
  });
}

describe("a phase switch on a hex scene (HXD-6)", () => {
  test("is refused when it would write a map whose origin lies before the image", () => {
    const state = room({ scenes: { s1: phased("hexRows"), s2: scene("s2", { order: 1 }) } });
    const r = refused(state, { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" });
    assert.deepEqual([r.code, r.message], ["invalid", HEX_ORIGIN]);
  });

  test("goes through on squares, where such an origin marks a file's own grid", () => {
    const state = apply(room({ scenes: { s1: phased(), s2: scene("s2", { order: 1 }) } }), { t: "scene.setPhase", sceneId: "s1", phaseId: "p2" });
    assert.equal(state.scenes.s1!.phaseId, "p2");
    assert.deepEqual(state.scenes.s1!.map!.originPx, { x: -10, y: 5 });
  });
});
