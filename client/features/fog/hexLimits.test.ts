import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FreeWall } from "#shared/model.ts";
import { clientOpSchema, MAX_FOG_CELLS } from "#shared/protocol.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { cornerAt, hexCenter, hexCorners, hexKey, hexNeighbors, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { deriveWalls, indexBuild } from "#shared/rules/walls.ts";
import { fogOps, hexCellsOutline, hexRoomShapes } from "./shapes.ts";

const { brushTitle, shapeHint } = await import("./Options.tsx");

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };

/** A hex and its six neighbors, walled in along the 18 sides they show the rest of the scene. */
function walledSeven(g: HexGrid): { keys: string[]; walls: FreeWall[] } {
  const middle = { col: 5, row: 5 };
  const keys = [middle, ...hexNeighbors(g, middle)].map(hexKey);
  const walls: FreeWall[] = [];
  const outline = hexCellsOutline(g, keys);
  for (let i = 0; i < outline.length; i += 4) {
    walls.push({ id: `w${String(i).padStart(11, "0")}`, a: [outline[i]!, outline[i + 1]!], b: [outline[i + 2]!, outline[i + 3]!], f: { kind: "wall" } });
  }
  return { keys, walls };
}

describe("the fog tool on a hex scene (H3)", () => {
  test("Builder room's line speaks of wall lines on hexes, and of builder rooms on squares", () => {
    assert.equal(shapeHint("room", ROWS), "Tap a room closed in by wall lines.");
    assert.equal(shapeHint("room", COLUMNS), "Tap a room closed in by wall lines.");
    assert.equal(shapeHint("room", SQUARES), "Tap a room made with the map builder.");
    assert.equal(shapeHint("rect", ROWS), shapeHint("rect", SQUARES));
  });

  test("the brush width title reads the cell word", () => {
    assert.equal(brushTitle(1, SQUARES), "1 square wide");
    assert.equal(brushTitle(3, SQUARES), "3 squares wide");
    assert.equal(brushTitle(1, ROWS), "1 hex wide");
    assert.equal(brushTitle(3, ROWS), "3 hexes wide");
  });

  for (const g of [ROWS, COLUMNS]) {
    test(`on hex ${g.orient} a tap in a walled room sends its hexes as one cells shape, and a tap off the scene's hexes sends nothing`, () => {
      const { keys, walls } = walledSeven(g);
      const set = deriveWalls(indexBuild([{ sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls }]), "v", { bounds: { w: 20, h: 16 } });
      assert.equal(set.stored.n, 18, "every side a stored wall");
      const shapes = hexRoomShapes(set, g, hexCenter(g, { col: 5, row: 5 }), { w: 20, h: 16 });
      assert.equal(shapes.length, 1);
      assert.deepEqual(shapes[0]!.cells.slice().sort(), keys.slice().sort());
      assert.deepEqual(hexRoomShapes(set, g, { x: -2, y: 3 }, { w: 20, h: 16 }), []);
    });

    test(`on hex ${g.orient} a room open to the edge of the largest scene splits into ops the schema takes, each hex once`, () => {
      const bounds = { w: 200, h: 200 };
      const shapes = hexRoomShapes(deriveWalls(indexBuild([]), "v", { bounds }), g, { x: 100, y: 100 }, bounds);
      const all = sceneHexes(g, bounds);
      assert.equal(shapes.length, Math.ceil(all.length / MAX_FOG_CELLS));
      const sent = shapes.flatMap((s) => s.cells);
      assert.equal(sent.length, all.length);
      assert.equal(new Set(sent).size, all.length);
      let n = 0;
      const ops = fogOps(shapes, "reveal", () => `f${n++}`);
      assert.ok(clientOpSchema.safeParse({ t: "fog.draft", sceneId: "s1", add: ops }).success);
    });

    test(`on hex ${g.orient} a draft's hexes outline along the sides they show the rest, on the hexes' own corners`, () => {
      const corners = (key: string) => {
        const [col, row] = key.split(",").map(Number) as [number, number];
        return hexCorners(g, { col, row }).map((c) => cornerAt(g, c));
      };
      assert.equal(hexCellsOutline(g, ["4,4"]).length, 6 * 4);
      const { keys } = walledSeven(g);
      const outline = hexCellsOutline(g, keys);
      assert.equal(outline.length, 18 * 4, "the six sides around the middle hex are left out");
      const points = new Set(keys.flatMap((k) => corners(k).map((p) => `${p.x},${p.y}`)));
      for (let i = 0; i < outline.length; i += 2) assert.ok(points.has(`${outline[i]},${outline[i + 1]}`), "every end is a corner of the room's hexes");
      assert.equal(hexCellsOutline(g, ["4,4", "x"]).length, 6 * 4, "a key that names no hex draws nothing");
    });
  }
});
