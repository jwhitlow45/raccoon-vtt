import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_GRID, guessCellPx, mapScene } from "../scenes/create.ts";
import { starterMapScene } from "./mapScene.ts";

const ROW = { id: "asset-1", width: 4096, height: 3072 };
const inked = { name: "Crypt of the Lich", width: 4096, gridColor: "#1A1A1A", grid: { cellPx: 70, originPx: { x: 20, y: 35 }, feetPerCell: 10 } };

describe("a scene from a starter map", () => {
  test("starts on the map's measured grid, sized to its whole squares, so it needs no alignment", () => {
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked });
    assert.equal(made.aligned, true);
    assert.deepEqual(made.scene.map, { assetId: "asset-1", widthPx: 4096, heightPx: 3072, cellPx: 70, originPx: { x: 20, y: 35 } });
    // From the first line at (20, 35): 58 whole squares across and 43 down.
    assert.deepEqual(made.scene.bounds, { w: 58, h: 43 });
    assert.equal(made.feetPerCell, 10);
  });

  test("takes the grid's origin by the rule a found grid's goes by: past a whole square it folds back, and a hair from the edge is the edge", () => {
    const far = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, grid: { cellPx: 70, originPx: { x: 90, y: 2 } } } });
    assert.deepEqual(far.scene.map?.originPx, { x: 20, y: 0 });
    assert.equal(far.aligned, true);
  });

  test("with a measured square and no origin starts at that size, still for the DM to line up", () => {
    const none = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, grid: { cellPx: 64 } } });
    assert.equal(none.aligned, false);
    assert.deepEqual(none.scene.map?.originPx, { x: 0, y: 0 });
    assert.equal(none.scene.map?.cellPx, 64);
    assert.deepEqual(none.scene.bounds, { w: 64, h: 48 });
    assert.equal(none.feetPerCell, null);
  });

  test("paints a paper map's grid in the catalog's color, keeping the rest of the app's grid", () => {
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked });
    assert.deepEqual(made.scene.grid, { ...DEFAULT_GRID, color: "#1a1a1a" });
    const painted = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, gridColor: undefined } });
    assert.deepEqual(painted.scene.grid, DEFAULT_GRID);
    const odd = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, gridColor: "red" } });
    assert.deepEqual(odd.scene.grid, DEFAULT_GRID, "a color the scene would refuse is left out");
  });

  test("without a measured grid starts on the upload's guess, for the DM to line up", () => {
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: { name: "Index card 3", width: 4096, gridColor: "#222222" } });
    assert.equal(made.aligned, false);
    const upload = mapScene({ id: "s1", name: "Index card 3", asset: ROW }).scene;
    assert.equal(made.scene.map?.cellPx, guessCellPx(4096, 3072));
    assert.deepEqual(made.scene.bounds, upload.bounds);
    assert.deepEqual(made.scene.map, upload.map);
    assert.equal(made.scene.grid?.color, "#222222");
  });

  test("a grid the protocol would refuse counts as none", () => {
    const tiny = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, grid: { cellPx: 0.5 } } });
    assert.equal(tiny.aligned, false);
    assert.equal(tiny.scene.map?.cellPx, guessCellPx(4096, 3072));
  });

  test("scales the grid with the room's copy should the server store it at another size", () => {
    const made = starterMapScene({ id: "s1", name: "", asset: { id: "asset-2", width: 2048, height: 1536 }, work: inked });
    assert.deepEqual(made.scene.map, { assetId: "asset-2", widthPx: 2048, heightPx: 1536, cellPx: 35, originPx: { x: 10, y: 17.5 } });
  });

  test("is named by the DM's name when typed, else the work's, and is the map scene an upload makes otherwise", () => {
    assert.equal(starterMapScene({ id: "s1", name: "  Lich's lair ", asset: ROW, work: inked }).scene.name, "Lich's lair");
    const made = starterMapScene({ id: "s1", name: " ", asset: ROW, work: inked }).scene;
    assert.equal(made.name, "Crypt of the Lich");
    const upload = mapScene({ id: "s1", name: "x", asset: ROW }).scene;
    assert.equal(made.id, "s1");
    assert.equal(made.background, upload.background);
    assert.equal(made.autoWalls, "floor");
    assert.equal(made.blockMovement, true);
  });
});
