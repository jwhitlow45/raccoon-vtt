import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { apply, room, scene } from "#shared/testutil.ts";
import {
  builderScene,
  fogsWithFirstMap,
  guessCellPx,
  likeGoneText,
  mapScene,
  matScene,
  nameFromFile,
  newSceneIntent,
  newScenePick,
  newScenePreset,
  pickNow,
  playersSeeFields,
  replaceMap,
  sameArt,
  stepsDown,
  viewFromCamera,
  withPlayersSee,
} from "./create.ts";
import { TOP_DOWN } from "../../lib/view.ts";

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
    const view = viewFromCamera({ camera: { x: 100, y: 50, scale: 40 }, viewport: { width: 900, height: 600 }, view: TOP_DOWN });
    assert.deepEqual(view, { x: 8.75, y: 6.25, zoom: 40 });
    const close = viewFromCamera({ camera: { x: 0, y: 0, scale: 300 }, viewport: { width: 900, height: 600 }, view: TOP_DOWN });
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

describe("what players see on a new scene (docs/design-v1-map-discovery.md 8.2)", () => {
  const kinds = ["builder", "uvtt", "map", "mat"] as const;

  test("each kind starts on the room's default, a map image steps down from Explore, and a room that never set one starts as before", () => {
    // The design's table: a row per default, a column per kind.
    const table = {
      explore: ["explore", "explore", "reveal", "explore"],
      reveal: ["reveal", "reveal", "reveal", "reveal"],
      all: ["all", "all", "all", "all"],
      unset: ["reveal", "reveal", "reveal", "all"],
    } as const;
    for (const [row, want] of Object.entries(table)) {
      const setting = row === "unset" ? undefined : (row as "explore" | "reveal" | "all");
      assert.deepEqual(
        kinds.map((k) => newScenePreset(setting, k)),
        [...want],
        row,
      );
    }
    assert.deepEqual(kinds.map((k) => stepsDown("explore", k)), [false, false, true, false]);
    assert.equal(stepsDown(undefined, "map"), false);
    assert.equal(stepsDown("reveal", "map"), false);
  });

  test("a preset sets fog and party vision on what each kind makes, and leaves its walls and movement", () => {
    const mat = matScene({ id: "m", name: "Mat", w: 10, h: 10 });
    const explore = withPlayersSee(mat, { preset: "explore" });
    valid(explore);
    assert.deepEqual([explore.fogEnabled, explore.vision], [true, { on: true, light: "bright" }]);
    assert.equal(explore.blockMovement, true);
    const state = apply(room(), { t: "scene.create", scene: explore });
    assert.equal(state.scenes.m!.fogEnabled, true);
    assert.equal(state.scenes.m!.vision?.on, true);
    // Reveal by hand and Everything send no vision, as a new scene always did, and say the fog either way.
    const { scene: map } = mapScene({ id: "s", name: "Cave", asset: { id: "a", width: 900, height: 600 } });
    assert.deepEqual(withPlayersSee(map, { preset: "reveal" }), { ...map, fogEnabled: true });
    assert.deepEqual(withPlayersSee(map, { preset: "all" }), { ...map, fogEnabled: false });
    assert.equal(apply(room(), { t: "scene.create", scene: withPlayersSee(map, { preset: "all" }) }).scenes.s!.fogEnabled, false, "a map's own fog default is overridden");
    // An import keeps its light, under any preset.
    assert.deepEqual(playersSeeFields({ preset: "reveal" }, "dim"), { fogEnabled: true, vision: { on: false, light: "dim" } });
    assert.deepEqual(playersSeeFields({ preset: "explore" }, "dark"), { fogEnabled: true, vision: { on: true, light: "dark" } });
  });

  test("Like copies fog, party vision with its light and Sight, and movement, and keeps the kind's automatic walls", () => {
    const crypt = { fogEnabled: true, vision: { on: true, light: "dark" as const, perPlayer: true as const }, blockMovement: false };
    const { scene: map } = mapScene({ id: "s", name: "Cave", asset: { id: "a", width: 900, height: 600 } });
    const like = withPlayersSee(map, { like: crypt });
    valid(like);
    assert.deepEqual([like.fogEnabled, like.vision, like.blockMovement, like.autoWalls], [true, { on: true, light: "dark", perPlayer: true }, false, "floor"]);
    const made = apply(room(), { t: "scene.create", scene: like });
    assert.equal(made.scenes.s!.vision?.perPlayer, true);
    assert.equal(made.holders.s, undefined, "a per-player copy starts with no holder list");
    const builder = withPlayersSee(builderScene({ id: "b", name: "Crypt", w: 10, h: 10 }), { like: crypt });
    assert.equal("autoWalls" in builder, false, "a builder keeps the rule of every painted cell");
    // A scene from before vision copies as one with none, and a scene that stops no moves as one that stops none.
    assert.deepEqual(playersSeeFields({ like: { fogEnabled: false } }), { fogEnabled: false, blockMovement: false });
    // The import's own light pick stands over the copy's.
    assert.deepEqual(playersSeeFields({ like: crypt }, "bright").vision, { on: true, light: "bright", perPlayer: true });
    assert.deepEqual(playersSeeFields({ like: { fogEnabled: true } }, "dim").vision, { on: false, light: "dim" });
  });

  test("Like with the scene on screen gone makes the kind's start instead", () => {
    const crypt = { fogEnabled: true, vision: { on: true, light: "dark" as const } };
    assert.deepEqual(newScenePick("like", crypt, "explore", "map"), { like: crypt });
    assert.deepEqual(newScenePick("like", undefined, "explore", "map"), { preset: "reveal" });
    assert.deepEqual(newScenePick("all", crypt, "explore", "map"), { preset: "all" });
  });

  test("Like holds its scene by id through an upload, and reads it as the scene is made (MS1-ASTRA-02)", () => {
    const crypt = scene("crypt", { name: "Crypt", fogEnabled: true, vision: { on: true, light: "dark" }, blockMovement: true });
    const intent = newSceneIntent("like", crypt);
    assert.deepEqual(intent, { value: "like", like: { id: "crypt", name: "Crypt" } });
    assert.deepEqual(newSceneIntent("reveal", crypt), { value: "reveal" }, "a preset holds no scene");
    assert.deepEqual(newSceneIntent("like", undefined), { value: "like" });
    // Crypt changed while the map uploaded: the new scene copies it as it is now.
    const changed = room({ scenes: { crypt: { ...crypt, fogEnabled: false, vision: { on: true, light: "bright", perPlayer: true }, blockMovement: false } } });
    const now = pickNow(intent, changed, "map");
    assert.equal(now.gone, null);
    assert.deepEqual(playersSeeFields(now.pick), { fogEnabled: false, vision: { on: true, light: "bright", perPlayer: true }, blockMovement: false });
    // Crypt deleted meanwhile: the kind's start under the room's choice as it is now, said in words.
    const deleted = room({ scenes: {} });
    deleted.meta = { ...deleted.meta, settings: { ...deleted.meta.settings, newScenePlayers: "explore" } };
    assert.deepEqual(pickNow(intent, deleted, "map"), { pick: { preset: "reveal" }, gone: "Crypt was deleted before the new scene was made, so the new scene starts on Reveal by hand." });
    assert.deepEqual(pickNow(intent, deleted, "uvtt").pick, { preset: "explore" });
    assert.equal(likeGoneText("Crypt", "all"), "Crypt was deleted before the new scene was made, so the new scene starts on Everything.");
    // A preset is never read again.
    assert.deepEqual(pickNow({ value: "all" }, deleted, "map"), { pick: { preset: "all" }, gone: null });
  });
});

describe("a Universal VTT import's Players see", () => {
  test("an import keeps its own walls rule, grid mark and light under a preset or Like", async () => {
    const { importScene } = await import("../uvtt/batch.ts");
    const map = { assetId: "a", widthPx: 500, heightPx: 400, cellPx: 50, originPx: { x: 0, y: 0 } };
    const base = importScene({ frame: { shift: { x: 0, y: 0 }, image: { x: 0, y: 0 }, w: 10, h: 8 } }, map, { id: "u", name: "Keep", fog: true, light: "dim" });
    const explore = withPlayersSee(base, { preset: "explore" }, "dim");
    valid(explore);
    assert.deepEqual([explore.fogEnabled, explore.vision, explore.autoWalls, explore.gridFromFile], [true, { on: true, light: "dim" }, "off", true]);
    const like = withPlayersSee(base, { like: { fogEnabled: false, vision: { on: false, light: "dark" }, blockMovement: false } }, "dark");
    assert.deepEqual([like.fogEnabled, like.vision, like.autoWalls, like.blockMovement], [false, { on: false, light: "dark" }, "off", false]);
  });
});
