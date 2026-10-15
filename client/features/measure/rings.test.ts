import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pointDistanceFt, tokenCellBox, boxDistanceFt, pointCellBox } from "#shared/rules/distance.ts";
import type { FootprintToken } from "#shared/rules/footprint.ts";
import { cellInRange, ringShape, ringsText } from "./rings.ts";
import type { DistanceRules } from "./ruler.ts";

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
  for (let y = 0; y < scene.h; y++) for (let x = 0; x < scene.w; x++) if (cellInRange(token, x, y, ft, rules)) out.add(`${x - token.x},${y - token.y}`);
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
      const ruler = boxDistanceFt(tokenCellBox(large, 5), pointCellBox({ x, y }, 5), five);
      assert.equal(cellInRange(large, x, y, 15, five), ruler <= 15, `${x},${y}`);
    }
    assert.equal(pointDistanceFt({ x: 10, y: 10 }, { x: 12, y: 10 }, five), 10);
  });

  test("a flier's ring counts its height, and is gone when the ground is out of reach", () => {
    assert.equal(cells(tok({ elevation: 20 }), 30, five).size, 13 * 13, "five: height within range leaves the square");
    assert.ok(cells(tok({ elevation: 20 }), 30, euclid).size < cells(tok(), 30, euclid).size, "true distance: the ground circle shrinks");
    assert.equal(cells(tok({ elevation: 40 }), 30, five).size, 0);
    assert.deepEqual(ringShape(tok({ elevation: 40 }), 30, five, scene), { segments: [], label: null });
  });

  test("the outline runs along the ring's edge, merged into straight runs, with the label on top", () => {
    const shape = ringShape(tok(), 10, five, scene);
    assert.deepEqual(shape.segments, [8, 8, 13, 8, 8, 13, 13, 13, 8, 8, 8, 13, 13, 8, 13, 13]);
    assert.deepEqual(shape.label, { x: 10.5, y: 8, below: false });
  });

  test("the scene's edge cuts a ring without drawing along it", () => {
    const shape = ringShape(tok({ x: 0, y: 0 }), 10, five, scene);
    assert.deepEqual(shape.segments, [0, 3, 3, 3, 3, 0, 3, 3]);
    assert.deepEqual(shape.label, { x: 0.5, y: 3, below: true }, "the top of the ring is off the scene, so the label goes under");
    assert.equal(ringShape(tok({ x: 0, y: 0 }), 200, five, scene).label, null, "a ring larger than the scene has no edge to label");
  });

  test("the menu's summary", () => {
    assert.equal(ringsText([]), "None");
    assert.equal(ringsText([30, 60, 120]), "30/60/120 ft");
  });
});
