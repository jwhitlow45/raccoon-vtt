import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, lift, wall } from "../discoveryTestutil.ts";
import type { RoomState } from "../model.ts";
import { projectState } from "../project.ts";
import { P1, token } from "../testutil.ts";
import { coreBlocked, isPreview, landing, legStop, lineClear, ownWalk, previewChunks, resizeStands, stepTester, straightClear, walkEnd } from "./movement.ts";

/*
 * The movement rule's two tests of a held build's pieces
 * (docs/design-v1-map-discovery.md 5.2): a build read as it comes is the
 * gate's, `pieceBlocks`, and one read through `previewChunks` the
 * preview's, `pieceTouches`. Every entry point a device asks takes the
 * build's test. Astra's wall passes about 0.00004 cell north of (5.5, 5.5),
 * inside the band of the piece the player holds of it, and the exact wall
 * allows a Medium creature's walk from (5, 6) to (5, 5).
 */

function astra(): { state: RoomState; gate: RoomState; preview: RoomState } {
  const state = fogRoom({ scene: { blockMovement: true } });
  wall(state, "aaaaaaaaaaaa", [4.265625, 6.484375], [10.515625, 1.5]);
  edge(state, "6,5,w", { kind: "door", state: "closed", secret: false, discovered: false });
  lift(state, "dm", { x: 0, y: 0, w: 16, h: 12 });
  const gate = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
  return { state, gate, preview: { ...gate, buildChunks: previewChunks(gate.buildChunks) } };
}

const walker = ownWalk({ ...token("t", { x: 5, y: 6 }), sceneId: "s1" });
const at55 = ownWalk({ ...token("t", { x: 5, y: 5 }), sceneId: "s1" });
const north = { x: 5, y: 5, elevation: 0 };

describe("the device's two tests of a piece in the movement rule", () => {
  test("the exact wall allows astra's walk, the gate sends it, a preview holds it", () => {
    const { state, gate, preview } = astra();
    assert.equal(legStop(state, walker, north), null);
    assert.equal(legStop(gate, walker, north), null);
    assert.equal(legStop(preview, walker, north)?.blocker, "wall");
    assert.equal(straightClear(gate, walker, north), true);
    assert.equal(straightClear(preview, walker, north), false);
  });

  test("a landing and a stand", () => {
    const { gate, preview } = astra();
    assert.deepEqual(landing(gate, walker, north, "walk"), { x: 5, y: 5, squeeze: false, stopped: null });
    assert.deepEqual(landing(preview, walker, north, "walk").stopped?.blocker, "wall");
    // Standing at (5, 5), the core lies inside the band: the gate lets it stand, a preview does not.
    assert.equal(coreBlocked(gate, walkEnd(gate, walker, { x: 5, y: 5 })), false);
    assert.equal(coreBlocked(preview, walkEnd(preview, walker, { x: 5, y: 5 })), true);
    assert.equal(resizeStands(gate, at55, { ...at55, size: "medium" }), true);
    assert.equal(resizeStands(preview, at55, { ...at55, size: "medium" }), false);
  });

  test("a route's step test", () => {
    const { gate, preview } = astra();
    assert.equal(stepTester(gate, walker)!.clear(5, 6, 5, 5), true);
    assert.equal(stepTester(preview, walker)!.clear(5, 6, 5, 5), false);
  });

  test("a door's clear line", () => {
    const { gate, preview } = astra();
    const door = { edge: "6,5,w" };
    assert.equal(lineClear(gate, at55, { x: 6, y: 5.5 }, door), true);
    assert.equal(lineClear(preview, at55, { x: 6, y: 5.5 }, door), false);
  });

  test("a preview's collection is kept per collection, and reading it again changes nothing", () => {
    const { gate } = astra();
    const once = previewChunks(gate.buildChunks);
    assert.equal(previewChunks(gate.buildChunks), once);
    assert.equal(previewChunks(once), once);
    assert.equal(isPreview(once), true);
    assert.equal(isPreview(gate.buildChunks), false);
    assert.deepEqual(Object.keys(once), Object.keys(gate.buildChunks));
  });
});
