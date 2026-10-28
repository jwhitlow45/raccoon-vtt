import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gridOfShape, SQUARES } from "#shared/rules/grid.ts";
import { sceneCellWord, shapeChoice, sizeWords, storedShape } from "./words.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ShapeRow, shapeReasons, shapeRefusal } = await import("./ShapeRow.tsx");
const { room, scene } = await import("#shared/testutil.ts");

describe("hex grid words (docs/design-v1-hex-grids.md section 8)", () => {
  test("a scene names its cell by its shape, squares by default", () => {
    assert.equal(sceneCellWord({}), "square");
    assert.equal(sceneCellWord({}, true), "squares");
    assert.equal(sceneCellWord({ gridShape: "hexRows" }), "hex");
    assert.equal(sceneCellWord({ gridShape: "hexColumns" }, true), "hexes");
  });

  test("squares are stored as no shape, and read back as Squares", () => {
    assert.equal(storedShape("squares"), undefined);
    assert.equal(storedShape("hexColumns"), "hexColumns");
    assert.equal(shapeChoice(undefined), "squares");
    assert.equal(shapeChoice("hexRows"), "hexRows");
  });

  test("the Size row reads squares on squares, and feet steps with the hexes it holds on hexes (HX-D16)", () => {
    assert.deepEqual(sizeWords(SQUARES, { w: 30, h: 20 }, 5), { name: "Size in squares", across: "Squares across", down: "Squares down", holds: null });
    assert.deepEqual(sizeWords(gridOfShape("hexRows"), { w: 30, h: 20 }, 5), { name: "Size in 5 ft steps", across: "Across", down: "Down", holds: "Holds 30 hexes across and 22 rows down." });
    assert.equal(sizeWords(gridOfShape("hexColumns"), { w: 30, h: 20 }, 10).name, "Size in 10 ft steps");
    assert.equal(sizeWords(gridOfShape("hexColumns"), { w: 20, h: 30 }, 5).holds, "Holds 22 columns across and 30 hexes down.");
    assert.equal(sizeWords(gridOfShape("hexRows"), { w: 1, h: 1 }, 5).holds, "Holds no whole hex. Make it larger.");
  });

  test("a refused choice's reason shows once, never for the chosen shape", () => {
    const why = "This scene has difficult ground on its squares, which can't stand on hexes. Remove them to change the grid.";
    assert.deepEqual(shapeReasons({ hexRows: why, hexColumns: why }, "squares"), [why]);
    assert.deepEqual(shapeReasons({ squares: "no" }, "squares"), []);
    assert.deepEqual(shapeReasons(undefined, "hexRows"), []);
  });

  test("a refused shape is off, and the group is described by its help and the reducer's words, so focus stays on the chosen radio", () => {
    const why = "This scene came with its own square grid from its file.";
    const html = renderToStaticMarkup(createElement(ShapeRow, { name: "Grid shape", help: "Help.", value: "squares", refused: { hexRows: why, hexColumns: why }, onChange: () => {} }));
    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
    assert.equal(radios.length, 3);
    assert.doesNotMatch(radios[0]!, /disabled/);
    assert.match(radios[1]!, /disabled=""/);
    assert.match(radios[2]!, /disabled=""/);
    const ids = /role="radiogroup"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1]?.split(" ") ?? [];
    const lines = ids.map((id) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]);
    assert.deepEqual(lines, ["Help.", why]);
    const free = renderToStaticMarkup(createElement(ShapeRow, { name: "Grid shape", help: "Help.", value: "hexRows", onChange: () => {} }));
    assert.doesNotMatch(free, /disabled/);
  });

  test("the choice reads the reducer's refusals: a square scene with painted ground keeps off hexes, a file's own grid keeps off hexes, and a free one goes anywhere", () => {
    const state = room({ scenes: { s1: scene("s1"), s2: scene("s2"), s3: scene("s3", { gridFromFile: true }) } });
    state.buildChunks["s1:0:0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "4,4": "dirt" }, edges: {} } as (typeof state.buildChunks)[string];
    const painted = "This scene has painted ground on its squares, which can't stand on hexes. Remove them to change the grid.";
    assert.equal(shapeRefusal(state, state.scenes.s1!, "hexRows"), painted);
    assert.equal(shapeRefusal(state, state.scenes.s1!, "hexColumns"), painted);
    assert.equal(shapeRefusal(state, state.scenes.s1!, "squares"), null);
    assert.equal(shapeRefusal(state, state.scenes.s2!, "hexColumns"), null);
    assert.equal(shapeRefusal(state, state.scenes.s3!, "hexRows"), "This scene came with its own square grid from its file.");
  });
});
