import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pointDistanceFt, tokenCellBox, boxDistanceFt, pointCellBox } from "#shared/rules/distance.ts";
import type { FootprintToken } from "#shared/rules/footprint.ts";
import { cellInRange, ringShape, ringsText } from "./rings.ts";
import type { DistanceRules } from "./ruler.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexAt, hexCenter, hexDistance, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { hexAnchor, occupiedHexes, placedOnHex, tokenRefHex } from "#shared/rules/footprint.ts";

const five = { feetPerCell: 5, diagonal: "five" as const };
const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" as const };
const euclid = { feetPerCell: 5, diagonal: "euclid" as const };
const scene = { w: 40, h: 30 };

function tok(over: Partial<FootprintToken> = {}): FootprintToken {
  return { size: "medium", x: 10, y: 10, elevation: 0, ...over };
}

/** The cells a ring encloses, as "x,y" around the token, for comparing shapes. */
function cells(token: FootprintToken, ft: number, rules: DistanceRules): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) if (cellInRange(SQUARES, token, x, y, ft, rules)) out.add(`${x - token.x},${y - token.y}`);
  return out;
}

describe("range rings", () => {
  test("enclose the cells a ruler from the token reads in range, under each diagonal rule", () => {
    assert.equal(cells(tok(), 10, five).size, 25, "every diagonal 5 ft: a 5 by 5 square");
    const octagon = cells(tok(), 10, fiveTen);
    assert.equal(octagon.size, 21, "5-10-5: the square without its corners");
    assert.ok(!octagon.has("2,2") && octagon.has("2,1"));
    const circle = cells(tok(), 10, euclid);
    assert.ok(circle.has("1,1") && circle.has("2,0") && !circle.has("2,1"), "true distance: 11 ft is out");
    // The same reading as the ruler's: from the footprint's edge, so a Large creature's ring is wider.
    const large = tok({ size: "large" });
    for (const [x, y] of [[13, 10], [14, 10], [7, 7], [8, 15]] as const) {
      const ruler = boxDistanceFt(tokenCellBox(SQUARES, large, 5), pointCellBox(SQUARES, { x, y }, 5), five);
      assert.equal(cellInRange(SQUARES, large, x, y, 15, five), ruler <= 15, `${x},${y}`);
    }
    assert.equal(pointDistanceFt(SQUARES, { x: 10, y: 10 }, { x: 12, y: 10 }, five), 10);
  });

  test("a flier's ring counts its height, and is gone when the ground is out of reach", () => {
    assert.equal(cells(tok({ elevation: 20 }), 30, five).size, 13 * 13, "five: height within range leaves the square");
    assert.ok(cells(tok({ elevation: 20 }), 30, euclid).size < cells(tok(), 30, euclid).size, "true distance: the ground circle shrinks");
    assert.equal(cells(tok({ elevation: 40 }), 30, five).size, 0);
    assert.deepEqual(ringShape(SQUARES, tok({ elevation: 40 }), 30, five, scene), { segments: [], label: null });
  });

  test("the outline runs along the ring's edge, merged into straight runs, with the label on top", () => {
    const shape = ringShape(SQUARES, tok(), 10, five, scene);
    assert.deepEqual(shape.segments, [8, 8, 13, 8, 8, 13, 13, 13, 8, 8, 8, 13, 13, 8, 13, 13]);
    assert.deepEqual(shape.label, { x: 10.5, y: 8, below: false });
  });

  test("the scene's edge cuts a ring without drawing along it", () => {
    const shape = ringShape(SQUARES, tok({ x: 0, y: 0 }), 10, five, scene);
    assert.deepEqual(shape.segments, [0, 3, 3, 3, 3, 0, 3, 3]);
    assert.deepEqual(shape.label, { x: 0.5, y: 3, below: true }, "the top of the ring is off the scene, so the label goes under");
    assert.equal(ringShape(SQUARES, tok({ x: 0, y: 0 }), 200, five, scene).label, null, "a ring larger than the scene has no edge to label");
  });

  test("the menu's summary", () => {
    assert.equal(ringsText([]), "None");
    assert.equal(ringsText([30, 60, 120]), "30/60/120 ft");
  });
});

describe("range rings on a hex scene (docs/design-v1-hex-grids.md 4.3)", () => {
  for (const orient of ["rows", "columns"] as const) {
    const g: HexGrid = { shape: "hex", orient };
    const bounds = { w: 30, h: 30 };
    const on = (size: FootprintToken["size"], hex: { col: number; row: number }, over: Partial<FootprintToken> = {}) => tok({ size, ...placedOnHex(g, { size, x: 0, y: 0 }, hex), ...over });
    /** The ring's sides as keys, ends rounded so a side reads the same from either hex. */
    const sidesOf = (shape: { segments: number[] }) => {
      const out = new Set<string>();
      for (let i = 0; i < shape.segments.length; i += 4) {
        const a = `${shape.segments[i]!.toFixed(5)},${shape.segments[i + 1]!.toFixed(5)}`;
        const b = `${shape.segments[i + 2]!.toFixed(5)},${shape.segments[i + 3]!.toFixed(5)}`;
        out.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
      return out;
    };

    test(`${orient}: a ring runs along the hex sides round the hexes within its steps, each side once`, () => {
      const medium = on("medium", { col: 12, row: 12 });
      for (const [ft, sides] of [[5, 18], [10, 30], [30, 78]] as const) {
        const shape = ringShape(g, medium, ft, five, bounds);
        assert.equal(shape.segments.length / 4, sides, `${ft} ft: 6 (2r + 1) sides`);
        assert.equal(sidesOf(shape).size, sides, `${ft} ft: no side twice`);
      }
      // What it encloses is what a ruler from the token reads in range: the hexes within its steps.
      const ref = tokenRefHex(g, medium);
      for (const h of sceneHexes(g, bounds)) {
        const c = hexCenter(g, h);
        assert.equal(cellInRange(g, medium, c.x, c.y, 10, five), hexDistance(g, ref, h) <= 2, `${h.col},${h.row}`);
      }
    });

    test(`${orient}: a Large ring counts from all three of its hexes, a flier's shrinks by its height, and the label sits over the anchor`, () => {
      const large = on("large", { col: 12, row: 12 });
      const own = occupiedHexes(g, large);
      const inRange = sceneHexes(g, bounds).filter((h) => own.some((o) => hexDistance(g, o, h) <= 1));
      const shape = ringShape(g, large, 5, five, bounds);
      // Every side drawn lies between a hex in range and one out of it.
      const keys = new Set(inRange.map((h) => `${h.col},${h.row}`));
      for (let i = 0; i < shape.segments.length; i += 4) {
        const mid = { x: (shape.segments[i]! + shape.segments[i + 2]!) / 2, y: (shape.segments[i + 1]! + shape.segments[i + 3]!) / 2 };
        const n = { x: shape.segments[i + 3]! - shape.segments[i + 1]!, y: shape.segments[i]! - shape.segments[i + 2]! };
        const k = 1e-3 / Math.hypot(n.x, n.y);
        const one = hexAt(g, { x: mid.x + n.x * k, y: mid.y + n.y * k });
        const two = hexAt(g, { x: mid.x - n.x * k, y: mid.y - n.y * k });
        assert.notEqual(keys.has(`${one.col},${one.row}`), keys.has(`${two.col},${two.row}`), `side ${i / 4} parts in from out`);
      }
      // 15 ft up, a 10 ft ring reaches no ground.
      assert.equal(ringShape(g, { ...large, elevation: 15 }, 10, five, bounds).segments.length, 0);
      // The label hangs on the ring's top over the anchor, and below where the scene cuts the top.
      const anchor = hexAnchor(g, large);
      const label = shape.label!;
      assert.equal(label.below, false);
      assert.ok(label.y < anchor.y && Math.abs(label.x - anchor.x) <= 0.6);
      const edge = on("medium", orient === "rows" ? { col: 12, row: 0 } : { col: 0, row: 12 });
      const cut = ringShape(g, edge, 10, five, bounds).label;
      assert.equal(cut?.below, orient === "rows");
    });
  }
});
