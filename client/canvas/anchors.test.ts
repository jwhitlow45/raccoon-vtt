import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { viewToScreen, type Camera } from "../lib/camera.ts";
import { isometric, K, TOP_DOWN, toView, type Turn } from "../lib/view.ts";
import { footAnchor, groundAnchor, headAnchor } from "./anchors.ts";

const CAM: Camera = { x: 120, y: -40, scale: 30 };
const BOX = { x: 4, y: 6, w: 2, h: 2 };

describe("the chrome's anchors (docs/design-v1-isometric-view.md 5.3)", () => {
  test("Top-down: under the box's bottom middle and at its top edge, as before, whatever the height", () => {
    const top = { view: TOP_DOWN };
    assert.deepEqual(footAnchor(CAM, top, BOX, 3), viewToScreen(CAM, toView(TOP_DOWN, { x: 5, y: 8 })));
    assert.deepEqual(headAnchor(CAM, top, BOX, 3), viewToScreen(CAM, toView(TOP_DOWN, { x: 4, y: 6 })));
    assert.deepEqual(groundAnchor(CAM, top, { x: 2, y: 3 }, 5), viewToScreen(CAM, toView(TOP_DOWN, { x: 2, y: 3 })));
  });

  test("Isometric: under the ring at the drawn base, the art's top a footprint's height above its ring, both raised by the base", () => {
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const pick = { view: isometric(turn) };
      const ring = viewToScreen(CAM, toView(pick.view, { x: 5, y: 7 }, 2));
      const foot = footAnchor(CAM, pick, BOX, 2);
      assert.ok(Math.abs(foot.x - ring.x) < 1e-9);
      // A circle 2 across shows as an ellipse 1 tall in view units, so the ring's bottom is half a view unit under its middle.
      assert.ok(Math.abs(foot.y - (ring.y + 0.5 * CAM.scale)) < 1e-9, `turn ${turn}`);
      assert.ok(Math.abs(headAnchor(CAM, pick, BOX, 2).y - (ring.y - 2 * CAM.scale)) < 1e-9);
      const flat = footAnchor(CAM, pick, BOX, 0);
      assert.ok(Math.abs(flat.y - foot.y - 2 * K * CAM.scale) < 1e-9, "a base 2 cells up lifts it 2K view units");
    }
  });
});
