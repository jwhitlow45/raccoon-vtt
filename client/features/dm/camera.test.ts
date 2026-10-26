import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ephEventSchema } from "#shared/protocol.ts";
import { cameraForView } from "../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";
import { focusEvent, focusFromStage } from "./camera.ts";

describe("follow the DM's camera", () => {
  test("a player's canvas of the same size lands exactly on the DM's camera", () => {
    const size = { width: 800, height: 600 };
    const cam = { x: -120, y: 35, scale: 48 };
    const focus = focusFromStage({ camera: cam, viewport: size, view: TOP_DOWN });
    assert.deepEqual(cameraForView(size, toView(TOP_DOWN, focus), focus.zoom), cam);
  });

  test("a smaller screen centers the same point at the same zoom", () => {
    const focus = focusFromStage({ camera: { x: 0, y: 0, scale: 40 }, viewport: { width: 1200, height: 800 }, view: TOP_DOWN });
    assert.deepEqual(focus, { x: 15, y: 10, zoom: 40 });
    const phone = cameraForView({ width: 390, height: 700 }, toView(TOP_DOWN, focus), focus.zoom);
    assert.equal((195 - phone.x) / phone.scale, 15);
  });

  test("the event stays inside the protocol's bounds", () => {
    const e = focusEvent({ x: 5000, y: -5000, zoom: 400 });
    assert.deepEqual(e, { k: "focus", x: 1000, y: -1000, zoom: 100 });
    assert.ok(ephEventSchema.safeParse(e).success);
  });
});
