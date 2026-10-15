import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displaysText, sendsView, viewEvent } from "./tableDisplay.ts";

describe("the DM's side", () => {
  test("the view event is the canvas's map area in cells, inside the protocol's bounds", () => {
    assert.deepEqual(viewEvent({ x: -400, y: -200, scale: 40, width: 400, height: 800 }), { k: "view", x: 15, y: 15, w: 10, h: 20 });
    const far = viewEvent({ x: 0, y: 0, scale: 0.001, width: 4000, height: 4000 });
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
