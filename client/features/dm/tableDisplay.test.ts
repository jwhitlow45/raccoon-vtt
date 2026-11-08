import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { displaysText, sendsView, viewEvent } from "./tableDisplay.ts";
import { ephEventSchema } from "#shared/protocol.ts";
import { screenToView } from "../../lib/camera.ts";
import { isometric, TOP_DOWN, toView, toWorld, type Turn } from "../../lib/view.ts";
import { playersSee } from "#shared/rules/floors.ts";
import { room } from "#shared/testutil.ts";
import { ATTIC, CAVE, TOWER, tower, UPPER } from "../floors/testing.ts";

describe("the DM's side", () => {
  test("the view event is the canvas's map area in cells, inside the protocol's bounds", () => {
    assert.deepEqual(viewEvent({ camera: { x: -400, y: -200, scale: 40 }, viewport: { width: 400, height: 800 }, view: TOP_DOWN }), { k: "view", x: 15, y: 15, w: 10, h: 20 });
    const far = viewEvent({ camera: { x: 0, y: 0, scale: 0.001 }, viewport: { width: 4000, height: 4000 }, view: TOP_DOWN });
    assert.equal(far.w, 2_000);
    assert.equal(far.x, 1_000);
    const on = { dm: true, on: true, seen: true };
    assert.equal(sendsView(on), true);
    assert.equal(sendsView({ ...on, seen: false }), false, "never a scene or a floor players do not see");
    assert.equal(sendsView({ ...on, on: false }), false);
    assert.equal(sendsView({ ...on, dm: false }), false);
    assert.equal(displaysText(0), "No table display is connected.");
    assert.equal(displaysText(1), "1 table display connected.");
    assert.equal(displaysText(3), "3 table displays connected.");
  });
});

describe("which floors the DM's camera goes out from (docs/design/design-v1-floors.md 8.3)", () => {
  // CameraLayer.tsx passes playersSee of the floor shown as `seen`.
  const seenOn = (state: ReturnType<typeof tower>, sceneId: string) => sendsView({ dm: true, on: true, seen: playersSee(state, sceneId) });

  test("the players' scene of one floor, as before, and never another scene", () => {
    const state = room();
    assert.equal(seenOn(state, "s1"), true);
    assert.equal(seenOn(state, "s2"), false, "never another scene");
  });

  test("an open floor of the players' scene: the start floor, a floor a party member stands on, a floor shown, never one not reached", () => {
    const state = tower();
    assert.equal(seenOn(state, TOWER), true, "the start floor");
    assert.equal(seenOn(state, UPPER), false, "a floor players have not reached");
    assert.equal(seenOn(tower({ openFloors: { [UPPER]: { sceneId: UPPER, rev: 0 } } }), UPPER), true, "a floor shown or reached before");
    // A fresh state for each: the rules remember their answers per state object, as the store's states never change.
    const on = (over: Partial<ReturnType<typeof tower>["tokens"][string]>) => tower({ tokens: { ...tower().tokens, bree: { ...tower().tokens.bree!, sceneId: ATTIC, ...over } } });
    assert.equal(seenOn(on({}), ATTIC), true, "a party member stands there");
    assert.equal(seenOn(on({ visibility: "dm" }), ATTIC), false, "a party member the DM hid opens nothing");
    assert.equal(seenOn(state, CAVE), false, "another scene");
  });

  test("never during a pause: the end of one turns sending back on, which sends the camera once (CameraLayer.tsx)", () => {
    const state = tower();
    state.meta.view = { follow: false, blackout: true };
    assert.equal(seenOn(state, TOWER), false);
  });
});

describe("an Isometric DM's view event (docs/design/design-v1-isometric-view.md ISO-D17)", () => {
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

