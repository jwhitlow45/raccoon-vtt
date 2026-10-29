import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scene } from "#shared/testutil.ts";
import { fogFoldSummary, sceneGroupSummary, sceneRowDetail } from "./sceneSummary.ts";

/** What each folded group of the scene settings page says (docs/design-v1-design-pass.md 4.1). */
describe("sceneGroupSummary", () => {
  test("What players see: the preset's name and the light, with Per player when Sight is", () => {
    assert.equal(sceneGroupSummary(scene("s", { fogEnabled: true, vision: { on: true, light: "dark" } }), "players"), "Explore · Dark");
    assert.equal(sceneGroupSummary(scene("s", { fogEnabled: true }), "players"), "Reveal by hand · Bright");
    assert.equal(sceneGroupSummary(scene("s", { fogEnabled: false, vision: { on: true, light: "dim" } }), "players"), "Custom · Dim");
    assert.equal(sceneGroupSummary(scene("s", { fogEnabled: false }), "players"), "Everything · Bright");
    assert.equal(sceneGroupSummary(scene("s", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } }), "players"), "Explore · Dark · Per player");
  });

  test("Map image and grid: whether there is an image, then the grid's shape, with its pixels on an image", () => {
    const map = { assetId: "a", widthPx: 1000, heightPx: 700, cellPx: 50, originPx: { x: 0, y: 0 } };
    assert.equal(sceneGroupSummary(scene("s"), "map"), "No map image · Squares");
    assert.equal(sceneGroupSummary(scene("s", { map }), "map"), "Map image · Squares, 50 px");
    assert.equal(sceneGroupSummary(scene("s", { map, gridShape: "hexRows" }), "map"), "Map image · Hex rows, 50 px");
    assert.equal(sceneGroupSummary(scene("s", { map: { ...map, cellPx: 70.5 }, gridShape: "hexColumns" }), "map"), "Map image · Hex columns, 70.50 px");
    assert.equal(sceneGroupSummary(scene("s", { gridShape: "hexColumns" }), "map"), "No map image · Hex columns");
  });

  test("Walls and movement: whether walls block players' moves", () => {
    assert.equal(sceneGroupSummary(scene("s", { blockMovement: true }), "walls"), "Walls block moves");
    assert.equal(sceneGroupSummary(scene("s"), "walls"), "Walls do not block moves");
    assert.equal(sceneGroupSummary(scene("s", { blockMovement: false }), "walls"), "Walls do not block moves");
  });

  test("Size and view: the size in squares, or the whole hexes a hex scene holds, then Isometric when suggested", () => {
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 20, h: 14 } }), "scene"), "20 × 14 squares");
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 20, h: 14 }, suggestedView: "isometric" }), "scene"), "20 × 14 squares · Isometric");
    // 40 × 30 steps hold 40 hexes across in 34 rows, or 45 columns of 30 (shared/rules/hex.ts sceneHexSpan): a hex scene's bounds are steps, not hexes.
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 40, h: 30 }, gridShape: "hexRows" }), "scene"), "40 × 34 hexes");
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 40, h: 30 }, gridShape: "hexColumns", suggestedView: "isometric" }), "scene"), "45 × 30 hexes · Isometric");
  });

  test("Size and view: a hex scene too small to hold a whole hex says so, as its size row's help does, rather than 0 × 0 hexes (DPB-OPUS-04)", () => {
    // 1 × 1 steps hold no whole hex on either shape (shared/rules/hex.ts sceneHexSpan), and 3 × 1 none on hex rows.
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 1, h: 1 }, gridShape: "hexRows" }), "scene"), "No whole hex");
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 3, h: 1 }, gridShape: "hexRows", suggestedView: "isometric" }), "scene"), "No whole hex · Isometric");
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 1, h: 1 }, gridShape: "hexColumns" }), "scene"), "No whole hex");
    assert.equal(sceneGroupSummary(scene("s", { bounds: { w: 1, h: 2 }, gridShape: "hexRows" }), "scene"), "1 × 1 hexes");
  });
});

describe("fogFoldSummary", () => {
  test("says each switch", () => {
    assert.equal(fogFoldSummary(scene("s", { fogEnabled: true, vision: { on: true, light: "dark" } })), "Fog on · Party vision on");
    assert.equal(fogFoldSummary(scene("s")), "Fog off · Party vision off");
    assert.equal(fogFoldSummary(scene("s", { fogEnabled: true })), "Fog on · Party vision off");
  });
});

describe("sceneRowDetail", () => {
  test("the Scenes list's row says a scene's size as Size and view's summary does, on squares, hex rows and hex columns", () => {
    for (const gridShape of [undefined, "hexRows", "hexColumns"] as const) {
      const s = scene("s", { bounds: { w: 30, h: 20 }, fogEnabled: true, ...(gridShape ? { gridShape } : {}) });
      // Squares go unnamed in the row.
      assert.equal(sceneRowDetail(s), `Grid, ${sceneGroupSummary(s, "scene").replace(/ squares$/, "")}, fog on`, gridShape ?? "squares");
    }
    // 30 × 20 steps on hex rows hold 30 hexes across in 22 rows: the row counts hexes, never steps.
    assert.equal(sceneRowDetail(scene("s", { bounds: { w: 30, h: 20 }, gridShape: "hexRows" })), "Grid, 30 × 22 hexes, fog off");
    const map = { assetId: "a", widthPx: 1000, heightPx: 700, cellPx: 50, originPx: { x: 0, y: 0 } };
    assert.equal(sceneRowDetail(scene("s", { map, bounds: { w: 20, h: 14 }, suggestedView: "isometric" })), "Map, 20 × 14, fog off");
  });
});
