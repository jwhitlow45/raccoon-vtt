import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { apply, room, scene } from "#shared/testutil.ts";
import {
  builderScene,
  fogsWithFirstMap,
  guessCellPx,
  initialMap,
  likeGoneText,
  mapScene,
  matScene,
  nameCellPx,
  nameFromFile,
  newSceneIntent,
  newScenePick,
  newScenePreset,
  newSceneShape,
  pickNow,
  playersSeeFields,
  refitsToNamedMap,
  replaceMap,
  replacement,
  sameImageShape,
  stepsDown,
  viewFromCamera,
  withPlayersSee,
} from "./create.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { sceneHexes } from "#shared/rules/hex.ts";
import { fitBounds } from "../grid/calibrate.ts";
import { TOP_DOWN } from "../../lib/view.ts";

function valid(scene: unknown) {
  const parsed = clientOpSchema.safeParse({ t: "scene.create", scene });
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
}

describe("new scenes", () => {
  test("a file name's counts give each grid its own scale, read as that grid's cells (D-261101-190)", () => {
    // 20 x 14 named art: squares of 70 on a 1400 x 980 image, hex rows of 70 on 1435 x 869, hex columns of 70 on 1233 x 1015.
    const squares = { id: "a", width: 1400, height: 980, cellPx: 70 };
    const rows = { id: "b", width: 1435, height: 869, hexCellPx: { rows: 70 } };
    const columns = { id: "c", width: 1233, height: 1015, hexCellPx: { columns: 70 } };
    for (const [asset, gridShape, cellPx] of [[squares, undefined, 70], [rows, "hexRows", 70], [columns, "hexColumns", 70]] as const) {
      const made = mapScene({ id: "s", name: "crypt 20x14", asset, gridShape });
      valid(made.scene);
      assert.equal(made.hinted, true, `${gridShape ?? "squares"} takes the name`);
      assert.equal(made.scene.map?.cellPx, cellPx);
      assert.deepEqual(made.scene.map?.originPx, { x: 0, y: 0 });
    }
    // A reading for another grid is no scale for this one: the guess stands and Line up grid opens.
    for (const [asset, gridShape] of [[squares, "hexRows"], [squares, "hexColumns"], [rows, undefined], [rows, "hexColumns"], [columns, "hexRows"]] as const) {
      const made = mapScene({ id: "s", name: "crypt 20x14", asset, gridShape });
      assert.equal(made.hinted, false, `${gridShape ?? "squares"} reads another grid's counts`);
      assert.equal(made.scene.map?.cellPx, guessCellPx(asset.width, asset.height));
    }
    assert.equal(nameCellPx({ hexCellPx: { rows: 20000 } }, "hexRows"), undefined, "a hint outside the cell size limits is no hint");
    const old = { ...initialMap(squares).map, assetId: "old", widthPx: 700, heightPx: 700 };
    for (const previous of [undefined, old]) {
      assert.equal(replacement(previous, rows, "hexRows").map.cellPx, 70);
      assert.equal(replacement(previous, rows, "hexRows").search, false, "a name's scale on hexes is not searched");
      assert.equal(replacement(previous, squares, "hexRows").search, true);
      assert.equal(replacement(previous, squares, "hexRows").map.cellPx, guessCellPx(squares.width, squares.height));
    }
  });

  test("a hex scene from an NxM name holds all the art's rows and hexes (LP28-B-HEX-1)", () => {
    // fen_12x8.png: 875 x 505 at 70 px is 12.5 hexes wide and 8 rows tall on hex rows, and the mirror on hex columns.
    const rows = mapScene({ id: "s", name: "fen 12x8", asset: { id: "a", width: 875, height: 505, hexCellPx: { rows: 70 } }, gridShape: "hexRows" }).scene;
    valid(rows);
    assert.deepEqual(rows.bounds, { w: 13, h: 8 });
    const held = apply(room(), { t: "scene.create", scene: rows }).scenes.s!;
    const perRow = new Map<number, number>();
    for (const hex of sceneHexes({ shape: "hex", orient: "rows" }, held.bounds)) perRow.set(hex.row, (perRow.get(hex.row) ?? 0) + 1);
    assert.equal(perRow.size, 8);
    for (const row of perRow.keys()) assert.ok((perRow.get(row) ?? 0) >= 12, `row ${row} holds 12 hexes`);
    const columns = mapScene({ id: "t", name: "fen 12x8", asset: { id: "a", width: 505, height: 875, hexCellPx: { columns: 70 } }, gridShape: "hexColumns" }).scene;
    assert.deepEqual(columns.bounds, { w: 8, h: 13 });
    // Squares keep their count.
    assert.deepEqual(mapScene({ id: "u", name: "fen 12x8", asset: { id: "a", width: 840, height: 560, cellPx: 70 } }).scene.bounds, { w: 12, h: 8 });
  });

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
    // Absent reads as off, which older scenes keep (docs/design/design-v1-maps-vision.md 4.1).
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
    assert.equal(sameImageShape(old, { id: "b", width: 1220, height: 845 }), true);
    assert.equal(sameImageShape(old, { id: "c", width: 1000, height: 1000 }), false);
  });

  test("a new image keeps the grid unsearched when it is the same file, keeps it scaled and is searched when it has the old shape, and starts over otherwise (D-261029-50)", () => {
    const old = { assetId: "a", widthPx: 2440, heightPx: 1690, cellPx: 80, originPx: { x: 40, y: 50 } };
    // A room stores a file once, so the same file uploads as the same image.
    for (const shape of [undefined, "hexRows"] as const) assert.deepEqual(replacement(old, { id: "a", width: 2440, height: 1690 }, shape), { map: old, search: false, kept: null }, `the same file, ${shape ?? "squares"}`);
    // Other art of the old shape, or the old art at another size: the grid kept, scaled, and the new art searched.
    const half = { cellPx: 40, originPx: { x: 20, y: 25 } };
    assert.deepEqual(replacement(old, { id: "b", width: 1220, height: 845 }), { map: { assetId: "b", widthPx: 1220, heightPx: 845, ...half }, search: true, kept: { ...half, scale: 0.5 } });
    assert.deepEqual(replacement(old, { id: "b", width: 2440, height: 1690 }, "hexRows").kept, { cellPx: 80, originPx: { x: 40, y: 50 }, scale: 1 });
    // Art twice the size: the kept grid's errors doubled with it (D-261029-54).
    assert.equal(replacement(old, { id: "b", width: 4880, height: 3380 }).kept?.scale, 2);
    // Another shape starts over, searched, with nothing kept.
    assert.deepEqual(replacement(old, { id: "c", width: 1000, height: 1000 }), { map: replaceMap(old, { id: "c", width: 1000, height: 1000 }), search: true, kept: null });
    assert.equal(replacement(undefined, { id: "c", width: 1000, height: 1000 }).search, true, "a first image");
    // A size in the file name wins, so nothing is searched, when it reads as the scene's own cells (D-261101-190).
    assert.equal(replacement(old, { id: "c", width: 1000, height: 1000, cellPx: 50 }).search, false);
    assert.equal(replacement(old, { id: "b", width: 1220, height: 845, cellPx: 50 }).search, false);
    assert.equal(replacement(old, { id: "c", width: 1000, height: 1000, cellPx: 50 }, "hexRows").search, true, "squares' counts are no scale for hexes");
    assert.equal(replacement(old, { id: "c", width: 1000, height: 1000, hexCellPx: { columns: 50 } }, "hexColumns").search, false);
  });

  test("other art of the old shape takes its name's scale over a kept grid that disagrees, and keeps one that agrees", () => {
    // A 1435 x 869 map lined up at 35 px, then other art of that size named for 70 px hex rows.
    const old = { assetId: "a", widthPx: 1435, heightPx: 869, cellPx: 35, originPx: { x: 3, y: 4 } };
    const rows = { id: "b", width: 1435, height: 869, hexCellPx: { rows: 70 } };
    assert.deepEqual(replacement(old, rows, "hexRows"), { map: { assetId: "b", widthPx: 1435, heightPx: 869, cellPx: 70, originPx: { x: 0, y: 0 } }, search: false, kept: null });
    const squares = { id: "b", width: 1435, height: 869, cellPx: 71.75 };
    assert.equal(replacement(old, squares).map.cellPx, 71.75, "squares too");
    assert.equal(replacement(old, squares).search, false);
    // A grid lined up by hand that already has the name's scale keeps its origin.
    const byHand = { ...old, cellPx: 70.3 };
    assert.deepEqual(replacement(byHand, rows, "hexRows"), { map: { ...byHand, assetId: "b" }, search: false, kept: null });
    // The same file is the same art: the grid stands, whatever its name says.
    assert.deepEqual(replacement(old, { ...rows, id: "a" }, "hexRows"), { map: old, search: false, kept: null });
    // A name for another grid is no scale for this one: the grid is kept and searched.
    assert.equal(replacement(old, rows).map.cellPx, 35);
    assert.equal(replacement(old, rows).search, true);
  });

  test("a name's scale that restarts a grid refits the bounds fitted to the old one, and leaves bounds set by hand", () => {
    const old = { assetId: "a", widthPx: 1435, heightPx: 869, cellPx: 35, originPx: { x: 3, y: 4 } };
    const fitted = fitBounds(old);
    assert.deepEqual(fitted, { w: 40, h: 24 });
    const rows = { id: "b", width: 1435, height: 869, hexCellPx: { rows: 70 } };
    const restarted = replacement(old, rows, "hexRows").map;
    assert.equal(refitsToNamedMap(old, restarted, nameCellPx(rows, "hexRows"), fitted), true, "70 px art over a 35 px grid: the bounds were twice the cells");
    assert.equal(refitsToNamedMap(old, restarted, nameCellPx(rows, "hexRows"), { w: 12, h: 9 }), false, "bounds the DM set by hand stay");
    // Larger art at the name's scale keeps the grid in cells: the same bounds, so a refit would change nothing.
    const bigger = { id: "c", width: 2870, height: 1738, cellPx: 70 };
    const scaled = replacement(old, bigger).map;
    assert.equal(scaled.cellPx, 70);
    assert.deepEqual(fitBounds(scaled), fitted);
    assert.equal(refitsToNamedMap(old, scaled, nameCellPx(bigger), { w: 12, h: 9 }), false, "and bounds set by hand stay there too");
    assert.equal(refitsToNamedMap(undefined, restarted, 70, { w: 30, h: 20 }), true, "a first image always fits");
    // A hex scene's bounds follow its old map by the hexes' count, or by the squares' count that scenes made before the hex fit hold.
    assert.equal(refitsToNamedMap(old, restarted, nameCellPx(rows, "hexRows"), fitBounds(old, gridOfShape("hexRows")), "hexRows"), true);
    assert.equal(refitsToNamedMap(old, restarted, nameCellPx(rows, "hexRows"), fitted, "hexRows"), true, "a stored hex scene keeps following its map");
    assert.equal(refitsToNamedMap(old, restarted, nameCellPx(rows, "hexRows"), { w: 12, h: 9 }, "hexRows"), false);
    assert.equal(refitsToNamedMap(old, replacement(old, { id: "d", width: 1435, height: 869 }).map, undefined, fitted), false, "no name, no refit");
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

describe("what players see on a new scene (docs/design/design-v1-map-discovery.md 8.2)", () => {
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
    const base = importScene({ frame: { shift: { x: 0, y: 0 }, image: { x: 0, y: 0 }, w: 10, h: 8 } }, map, { id: "u", name: "Keep", light: "dim" });
    const explore = withPlayersSee(base, { preset: "explore" }, "dim");
    valid(explore);
    assert.deepEqual([explore.fogEnabled, explore.vision, explore.autoWalls, explore.gridFromFile], [true, { on: true, light: "dim" }, "off", true]);
    const like = withPlayersSee(base, { like: { fogEnabled: false, vision: { on: false, light: "dark" }, blockMovement: false } }, "dark");
    assert.deepEqual([like.fogEnabled, like.vision, like.autoWalls, like.blockMovement], [false, { on: false, light: "dark" }, "off", false]);
  });
});

describe("the grid a new scene starts on (docs/design/design-v1-hex-grids.md HX-D19)", () => {
  test("a battle mat and a map image take the room's shape, a builder scene, a starter map and an import stay squares", () => {
    assert.equal(newSceneShape("hexRows", "mat"), "hexRows");
    assert.equal(newSceneShape("hexColumns", "map"), "hexColumns");
    assert.equal(newSceneShape("hexRows", "builder"), undefined);
    assert.equal(newSceneShape("hexRows", "starter"), undefined);
    assert.equal(newSceneShape("hexRows", "uvtt"), undefined);
    assert.equal(newSceneShape(undefined, "mat"), undefined);
  });

  test("each kind sends the shape it is made on, and a square scene's op is as it was", () => {
    const mat = matScene({ id: "m", name: "", w: 30, h: 20, gridShape: "hexRows" });
    assert.equal(mat.gridShape, "hexRows");
    valid(mat);
    assert.equal(builderScene({ id: "b", name: "", w: 40, h: 30, gridShape: "hexColumns" }).gridShape, "hexColumns");
    const map = mapScene({ id: "p", name: "", asset: { id: "a", width: 2100, height: 1400 }, gridShape: "hexRows" }).scene;
    assert.equal(map.gridShape, "hexRows");
    valid(map);
    assert.equal("gridShape" in matScene({ id: "m", name: "", w: 30, h: 20 }), false);
    assert.equal("gridShape" in mapScene({ id: "p", name: "", asset: { id: "a", width: 2100, height: 1400 } }).scene, false);
  });
});

describe("an animated map's still carries its video (docs/design/design-v1-animated-maps.md 4.1 and 4.2)", () => {
  const video = { assetId: "loop", widthPx: 1920, heightPx: 1080, container: "mp4" as const, video: "avc1.640028", fps: 30, durationMs: 12_000, kbps: 6000 };
  test("a new map and a replacement of either shape keep the asset's video, and an image in its place drops it", () => {
    assert.deepEqual(initialMap({ id: "still", width: 1920, height: 1080, video }).map.video, video);
    const old = { ...initialMap({ id: "still", width: 1920, height: 1080, video }).map };
    assert.deepEqual(replaceMap(old, { id: "still2", width: 960, height: 540, video: { ...video, assetId: "loop2" } }).video?.assetId, "loop2");
    assert.deepEqual(replaceMap(old, { id: "other", width: 1000, height: 1000, video }).video, video);
    assert.equal(replaceMap(old, { id: "image", width: 1920, height: 1080 }).video, undefined);
    assert.equal(initialMap({ id: "image", width: 1920, height: 1080 }).map.video, undefined);
  });
});
