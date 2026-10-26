import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displaysText, sendsView, viewEvent } from "./tableDisplay.ts";
import { ephEventSchema } from "#shared/protocol.ts";
import { screenToView } from "../../lib/camera.ts";
import { isometric, TOP_DOWN, toView, toWorld, type Turn } from "../../lib/view.ts";

describe("the DM's side", () => {
  test("the view event is the canvas's map area in cells, inside the protocol's bounds", () => {
    assert.deepEqual(viewEvent({ camera: { x: -400, y: -200, scale: 40 }, viewport: { width: 400, height: 800 }, view: TOP_DOWN }), { k: "view", x: 15, y: 15, w: 10, h: 20 });
    const far = viewEvent({ camera: { x: 0, y: 0, scale: 0.001 }, viewport: { width: 4000, height: 4000 }, view: TOP_DOWN });
    assert.equal(far.w, 2_000);
    assert.equal(far.x, 1_000);
    const on = { dm: true, on: true, sceneId: "s1", playerSceneId: "s1", blackout: false };
    assert.equal(sendsView(on), true);
    assert.equal(sendsView({ ...on, sceneId: "s2" }), false, "never another scene");
    assert.equal(sendsView({ ...on, on: false }), false);
    assert.equal(sendsView({ ...on, dm: false }), false);
    // The end of a pause turns sending back on, which sends the camera once (CameraLayer.tsx).
    assert.equal(sendsView({ ...on, blackout: true }), false, "never during a pause");
    assert.equal(displaysText(0), "No table display is connected.");
    assert.equal(displaysText(1), "1 table display connected.");
    assert.equal(displaysText(3), "3 table displays connected.");
  });
});

describe("an Isometric DM's view event (docs/design-v1-isometric-view.md ISO-D17)", () => {
  test("x and y are its middle at 0, w and h the box of its canvas's corners at 0, with its turn and size in view units", () => {
    for (const turn of [0, 1, 2, 3] as Turn[]) {
      const camera = { x: 100, y: -300, scale: 40 };
      const viewport = { width: 400, height: 800 };
      const view = isometric(turn);
      const e = viewEvent({ camera, viewport, view });
      const middle = toWorld(view, screenToView(camera, { x: 200, y: 400 }));
      assert.ok(Math.abs(e.x - middle.x) < 1e-9 && Math.abs(e.y - middle.y) < 1e-9, `turn ${turn}`);
      assert.deepEqual(e.iso, { turn, vw: 10, vh: 20 });
      // Each corner of the canvas lies on the box's edge or inside it.
      for (const corner of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 800 }, { x: 400, y: 800 }]) {
        const p = toWorld(view, screenToView(camera, corner));
        assert.ok(Math.abs(p.x - e.x) <= e.w / 2 + 1e-9 && Math.abs(p.y - e.y) <= e.h / 2 + 1e-9);
      }
      // The middle at 0 shows at the canvas's middle again through the DM's own projection.
      const back = toView(view, { x: e.x, y: e.y });
      assert.ok(Math.abs(back.x * 40 + 100 - 200) < 1e-6);
      assert.ok(ephEventSchema.safeParse(e).success, "inside the protocol's bounds");
    }
  });

  test("a Top-down DM's event is as before, with no iso", () => {
    const e = viewEvent({ camera: { x: -400, y: -200, scale: 40 }, viewport: { width: 400, height: 800 }, view: TOP_DOWN });
    assert.equal("iso" in e, false);
  });
});

