import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { apply, room } from "#shared/testutil.ts";
import { builderScene, fogsWithFirstMap, guessCellPx, mapScene, matScene, nameFromFile, replaceMap, sameArt, viewFromCamera } from "./create.ts";

function valid(scene: unknown) {
  const parsed = clientOpSchema.safeParse({ t: "scene.create", scene });
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
}

describe("new scenes", () => {
  test("a battle mat has fog off and a builder scene has fog on", () => {
    const mat = matScene({ id: "m", name: "  ", w: 30.4, h: 500 });
    valid(mat);
    assert.equal(mat.name, "Battle mat");
    assert.deepEqual(mat.bounds, { w: 30, h: 200 });
    const state = apply(room(), { t: "scene.create", scene: mat });
    assert.equal(state.scenes.m!.fogEnabled, false);

    const dungeon = builderScene({ id: "b", name: "Crypt", w: 40, h: 30 });
    valid(dungeon);
    assert.equal(apply(room(), { t: "scene.create", scene: dungeon }).scenes.b!.fogEnabled, true);
  });

  test("a map with a hint in its name gets that scale and is sized to its squares", () => {
    const { scene, hinted } = mapScene({ id: "s", name: nameFromFile("crypt_30x20.jpg"), asset: { id: "a", width: 3000, height: 2000, cellPx: 100 } });
    valid(scene);
    assert.ok(hinted);
    assert.equal(scene.name, "crypt 30x20");
    assert.deepEqual(scene.map, { assetId: "a", widthPx: 3000, heightPx: 2000, cellPx: 100, originPx: { x: 0, y: 0 } });
    assert.deepEqual(scene.bounds, { w: 30, h: 20 });
    // Fog starts on for a map scene.
    assert.equal(apply(room(), { t: "scene.create", scene }).scenes.s!.fogEnabled, true);
  });

  test("a scene from a map image walls floor only, and a blank mat or builder scene keeps the older rule", () => {
    // The reducer never infers the rule, so the op must carry it (design-v1-maps-vision 2.1).
    assert.equal(mapScene({ id: "s", name: "Cave", asset: { id: "a", width: 900, height: 600 } }).scene.autoWalls, "floor");
    // Absent reads as "all", so a mat or a builder scene sends nothing.
    assert.equal("autoWalls" in matScene({ id: "m", name: "Mat", w: 10, h: 10 }), false);
    assert.equal("autoWalls" in builderScene({ id: "b", name: "Crypt", w: 10, h: 10 }), false);
  });

  test("every new scene stops players' moves at its walls and ledges", () => {
    // Absent reads as off, which older scenes keep (docs/design-v1-maps-vision.md 4.1).
    assert.equal(matScene({ id: "m", name: "Mat", w: 10, h: 10 }).blockMovement, true);
    assert.equal(builderScene({ id: "b", name: "Crypt", w: 10, h: 10 }).blockMovement, true);
    assert.equal(mapScene({ id: "s", name: "Cave", asset: { id: "a", width: 900, height: 600 } }).scene.blockMovement, true);
  });

  test("a map with no hint gets a guess that keeps the scene within 200 cells", () => {
    const { scene, hinted } = mapScene({ id: "s", name: "Cave", asset: { id: "a", width: 8192, height: 5000 } });
    valid(scene);
    assert.equal(hinted, false);
    assert.ok(scene.bounds.w <= 200 && scene.bounds.h <= 200);
    assert.equal(guessCellPx(2100, 1400), 70);
    // A huge thin image still fits.
    assert.ok(8192 / guessCellPx(8192, 10) <= 200);
    // A bad hint is ignored.
    assert.equal(mapScene({ id: "s", name: "x", asset: { id: "a", width: 900, height: 600, cellPx: Number.NaN } }).hinted, false);
  });

  test("a replacement image at another size keeps the alignment, scaled", () => {
    const old = { assetId: "a", widthPx: 2440, heightPx: 1690, cellPx: 80, originPx: { x: 40, y: 50 } };
    const half = replaceMap(old, { id: "b", width: 1220, height: 845 });
    assert.deepEqual(half, { assetId: "b", widthPx: 1220, heightPx: 845, cellPx: 40, originPx: { x: 20, y: 25 } });
    // Different art (another shape) starts over from the upload.
    const other = replaceMap(old, { id: "c", width: 1000, height: 1000, cellPx: 50 });
    assert.equal(other.cellPx, 50);
    assert.deepEqual(other.originPx, { x: 0, y: 0 });
    assert.equal(sameArt(old, { id: "b", width: 1220, height: 845 }), true);
    assert.equal(sameArt(old, { id: "c", width: 1000, height: 1000 }), false);
  });
});

describe("scene list", () => {
  test("the default view is the world point at the canvas center, within the schema", () => {
    const view = viewFromCamera({ x: 100, y: 50, scale: 40 }, { width: 900, height: 600 });
    assert.deepEqual(view, { x: 8.75, y: 6.25, zoom: 40 });
    const close = viewFromCamera({ x: 0, y: 0, scale: 300 }, { width: 900, height: 600 });
    assert.equal(close.zoom, 100);
    const parsed = clientOpSchema.safeParse({ t: "scene.update", sceneId: "s1", patch: { defaultView: close } });
    assert.ok(parsed.success);
  });
});

describe("a scene's first map", () => {
  test("turns fog on for a blank battle mat, as a scene made from the image starts", () => {
    assert.equal(fogsWithFirstMap({ fogEnabled: false }, false), true);
  });

  test("leaves the fog alone on a scene that already had a map or a build, or has fog on", () => {
    assert.equal(fogsWithFirstMap({ fogEnabled: false, map: {} }, false), false);
    assert.equal(fogsWithFirstMap({ fogEnabled: false }, true), false);
    assert.equal(fogsWithFirstMap({ fogEnabled: true }, false), false);
  });
});
