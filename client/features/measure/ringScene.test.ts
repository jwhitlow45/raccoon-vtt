import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import { ringScene } from "./ringScene.ts";
import { ringShape } from "./rings.ts";

describe("a ring's scene function (ISO2-RANGERING)", () => {
  test("is the same function for the same shape, so a render that keeps the shape changes nothing Konva draws", () => {
    const rules = { feetPerCell: 5, diagonal: "five" as const };
    const token = { x: 4, y: 4, size: "medium" as const, elevation: 0 };
    const shape = ringShape(SQUARES, token, 30, rules, { w: 20, h: 20 });
    assert.equal(ringScene(shape), ringScene(shape));
    assert.notEqual(ringScene(shape), ringScene(ringShape(SQUARES, { ...token, x: 5 }, 30, rules, { w: 20, h: 20 })), "a moved token's ring draws anew");
  });

  test("strokes each straight run of the ring's edge once", () => {
    const shape = { segments: [0, 0, 1, 0, 1, 0, 1, 1], label: null };
    const calls: string[] = [];
    const ctx = {
      beginPath: () => calls.push("begin"),
      moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`line ${x},${y}`),
      strokeShape: () => calls.push("stroke"),
    };
    ringScene(shape)(ctx, {});
    assert.deepEqual(calls, ["begin", "move 0,0", "line 1,0", "move 1,0", "line 1,1", "stroke"]);
  });
});
