import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_GRID, guessCellPx, mapScene } from "../scenes/create.ts";
import { answeredGrid, retainedGrid, starterMapScene, type StarterGrid } from "./mapScene.ts";

const ROW = { id: "asset-1", width: 4096, height: 3072 };
const SHA = "ab".repeat(32);
const inked = { name: "Crypt of the Lich", width: 4096, sha256: SHA, gridColor: "#1A1A1A", grid: { cellPx: 70, originPx: { x: 20, y: 35 }, feetPerCell: 10 } };
const measured: StarterGrid = { cellPx: 70, originPx: { x: 20, y: 35 } };

describe("a scene from a starter map", () => {
  test("starts on the map's measured grid, sized to its whole squares, so it needs no alignment", () => {
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: measured });
    assert.equal(made.aligned, true);
    assert.deepEqual(made.scene.map, { assetId: "asset-1", widthPx: 4096, heightPx: 3072, cellPx: 70, originPx: { x: 20, y: 35 } });
    // From the first line at (20, 35): 58 whole squares across and 43 down.
    assert.deepEqual(made.scene.bounds, { w: 58, h: 43 });
    assert.equal(made.feetPerCell, 10);
  });

  test("takes the grid's origin by the rule a found grid's goes by: past a whole square it folds back, and a hair from the edge is the edge", () => {
    const far = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: { cellPx: 70, originPx: { x: 90, y: 2 } } });
    assert.deepEqual(far.scene.map?.originPx, { x: 20, y: 0 });
    assert.equal(far.aligned, true);
  });

  test("with a measured square and no origin starts at that size, still for the DM to line up", () => {
    const none = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, grid: { cellPx: 64 } }, grid: { cellPx: 64 } });
    assert.equal(none.aligned, false);
    assert.deepEqual(none.scene.map?.originPx, { x: 0, y: 0 });
    assert.equal(none.scene.map?.cellPx, 64);
    assert.deepEqual(none.scene.bounds, { w: 64, h: 48 });
    assert.equal(none.feetPerCell, null);
  });

  test("paints a paper map's grid in the catalog's color, keeping the rest of the app's grid", () => {
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: measured });
    assert.deepEqual(made.scene.grid, { ...DEFAULT_GRID, color: "#1a1a1a" });
    const painted = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, gridColor: undefined }, grid: measured });
    assert.deepEqual(painted.scene.grid, DEFAULT_GRID);
    const odd = starterMapScene({ id: "s1", name: "", asset: ROW, work: { ...inked, gridColor: "red" }, grid: measured });
    assert.deepEqual(odd.scene.grid, DEFAULT_GRID, "a color the scene would refuse is left out");
  });

  test("without a measured grid starts on the upload's guess, for the DM to line up", () => {
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: { name: "Index card 3", gridColor: "#222222" }, grid: null });
    assert.equal(made.aligned, false);
    const upload = mapScene({ id: "s1", name: "Index card 3", asset: ROW }).scene;
    assert.equal(made.scene.map?.cellPx, guessCellPx(4096, 3072));
    assert.deepEqual(made.scene.bounds, upload.bounds);
    assert.deepEqual(made.scene.map, upload.map);
    assert.equal(made.scene.grid?.color, "#222222");
  });

  test("a grid the protocol would refuse counts as none", () => {
    const tiny = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: { cellPx: 0.5, originPx: { x: 0, y: 0 } } });
    assert.equal(tiny.aligned, false);
    assert.equal(tiny.scene.map?.cellPx, guessCellPx(4096, 3072));
  });

  test("is named by the DM's name when typed, else the work's, and is the map scene an upload makes otherwise", () => {
    assert.equal(starterMapScene({ id: "s1", name: "  Lich's lair ", asset: ROW, work: inked, grid: measured }).scene.name, "Lich's lair");
    const made = starterMapScene({ id: "s1", name: " ", asset: ROW, work: inked, grid: measured }).scene;
    assert.equal(made.name, "Crypt of the Lich");
    const upload = mapScene({ id: "s1", name: "x", asset: ROW }).scene;
    assert.equal(made.id, "s1");
    assert.equal(made.background, upload.background);
    assert.equal(made.autoWalls, "floor");
    assert.equal(made.blockMovement, true);
  });
});

describe("the grid a starter map's scene starts on", () => {
  test("for a fresh pick is the one the server answers from the file it copied, never this page's catalog", () => {
    // A tab holding an older catalog: it says 70 px, while the server copied a rebuilt file measured at 35.
    const answer = { cellPx: 35, originPx: { x: 10, y: 17.5 } };
    assert.deepEqual(answeredGrid(answer), answer);
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: answeredGrid(answer) });
    assert.equal(made.scene.map?.cellPx, 35);
    assert.deepEqual(made.scene.map?.originPx, { x: 10, y: 17.5 });
    assert.equal(made.aligned, true);
  });

  test("for a fresh pick with only a square, or none, answered, leaves the DM to line it up", () => {
    assert.deepEqual(answeredGrid({ cellPx: 64 }), { cellPx: 64 });
    assert.equal(starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: answeredGrid({ cellPx: 64 }) }).aligned, false);
    assert.equal(answeredGrid({}), null);
    assert.equal(starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: answeredGrid({}) }).aligned, false);
  });

  test("for a pick the room holds is the catalog's, scaled to the room's copy, when the catalog's file is the room's", () => {
    assert.deepEqual(retainedGrid({ width: 4096, sha256: SHA }, inked), measured);
    assert.deepEqual(retainedGrid({ width: 2048, sha256: SHA.toUpperCase() }, inked), { cellPx: 35, originPx: { x: 10, y: 17.5 } });
    assert.deepEqual(retainedGrid({ width: 4096, sha256: SHA }, { ...inked, grid: { cellPx: 64 } }), { cellPx: 64 });
  });

  test("for a pick the room holds is none when its work was rebuilt since, or the row does not say its file", () => {
    // The room kept the file picked before the rebuild: this catalog's grid belongs to another file.
    const before = retainedGrid({ width: 4096, sha256: "cd".repeat(32) }, inked);
    assert.equal(before, null);
    const made = starterMapScene({ id: "s1", name: "", asset: ROW, work: inked, grid: before });
    assert.equal(made.aligned, false);
    assert.equal(made.scene.map?.cellPx, guessCellPx(4096, 3072));
    assert.equal(retainedGrid({ width: 4096 }, inked), null);
    assert.equal(retainedGrid({ width: 4096, sha256: SHA }, { ...inked, grid: undefined }), null);
  });
});
