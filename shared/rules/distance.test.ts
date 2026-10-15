import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CreatureSize, DiagonalRule } from "../model.ts";
import { distanceFt, pathDistanceFt, pointCellBox, pointDistanceFt, rulerDistanceFt, tokenCellBox } from "./distance.ts";
import type { FootprintToken } from "./footprint.ts";

function tok(x: number, y: number, over: Partial<FootprintToken> = {}): FootprintToken {
  return { size: "medium", x, y, elevation: 0, ...over };
}

const five = { feetPerCell: 5, diagonal: "five" } as const;
const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" } as const;
const euclid = { feetPerCell: 5, diagonal: "euclid" } as const;

describe("distanceFt between creatures", () => {
  test("adjacent creatures are 5 ft apart, overlapping ones 0", () => {
    for (const s of [five, fiveTen, euclid]) {
      assert.equal(distanceFt(tok(0, 0), tok(1, 0), s), 5);
      assert.equal(distanceFt(tok(0, 0), tok(1, 1), s), s.diagonal === "euclid" ? 7 : 5);
      assert.equal(distanceFt(tok(0, 0), tok(0, 0), s), 0);
    }
  });

  test("a tiny creature next to a medium one is 5 ft away", () => {
    assert.equal(distanceFt(tok(0, 0), tok(1, 0, { size: "tiny" }), five), 5);
    assert.equal(distanceFt(tok(0, 0), tok(1.5, 0.5, { size: "tiny" }), five), 5);
    // Two tiny creatures sharing a cell are 0 ft apart.
    assert.equal(distanceFt(tok(2, 2, { size: "tiny" }), tok(2.5, 2.5, { size: "tiny" }), five), 0);
  });

  test("large creatures count from their nearest cells", () => {
    // Large at (0,0) covers cells 0 and 1, so cell 4 is 3 steps away.
    assert.equal(distanceFt(tok(0, 0, { size: "large" }), tok(4, 0), five), 15);
    assert.equal(distanceFt(tok(0, 0, { size: "large" }), tok(2, 1), five), 5);
  });

  test("under fiveTen two diagonal steps are 15 ft, outside 10 ft reach", () => {
    assert.equal(distanceFt(tok(0, 0), tok(2, 2), fiveTen), 15);
    assert.equal(distanceFt(tok(0, 0), tok(2, 2), five), 10);
    assert.equal(distanceFt(tok(0, 0), tok(3, 3), fiveTen), 20);
    assert.equal(distanceFt(tok(0, 0), tok(4, 2), fiveTen), 25);
  });

  test("a flier 10 ft above a medium creature is 10 ft away", () => {
    const flier = tok(0, 0, { elevation: 10 });
    for (const s of [five, fiveTen, euclid]) assert.equal(distanceFt(tok(0, 0), flier, s), 10);
    // Directly adjacent in the air: one step up and one across.
    assert.equal(distanceFt(tok(0, 0), tok(1, 0, { elevation: 5 }), five), 5);
  });

  test("vertical steps nest under fiveTen and add under euclid", () => {
    // Two steps east, two south and four up.
    const high = tok(2, 2, { elevation: 20 });
    assert.equal(distanceFt(tok(0, 0), high, five), 20);
    // Horizontal 2 + floor(2/2) = 3, then with 4 vertical: 4 + floor(3/2) = 5.
    assert.equal(distanceFt(tok(0, 0), high, fiveTen), 25);
    assert.equal(distanceFt(tok(0, 0), high, euclid), Math.round(Math.hypot(2, 2, 4) * 5));
  });

  test("feet per cell scales every rule", () => {
    assert.equal(distanceFt(tok(0, 0), tok(3, 0), { feetPerCell: 10, diagonal: "five" }), 30);
    assert.equal(distanceFt(tok(0, 0), tok(0, 0, { elevation: 20 }), { feetPerCell: 10, diagonal: "five" }), 20);
  });

  test("distance is symmetric for every rule and size", () => {
    const sizes: CreatureSize[] = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"];
    const rules: DiagonalRule[] = ["five", "fiveTen", "euclid"];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 400; i++) {
      const mk = (): FootprintToken => ({
        size: sizes[Math.floor(rand() * sizes.length)]!,
        w: 0.5 + rand() * 4,
        h: 0.5 + rand() * 4,
        x: rand() * 20,
        y: rand() * 20,
        elevation: Math.floor(rand() * 60) - 20,
      });
      const a = mk();
      const b = mk();
      for (const diagonal of rules) {
        const s = { feetPerCell: 5, diagonal };
        assert.equal(distanceFt(a, b, s), distanceFt(b, a, s));
      }
    }
  });
});

describe("ruler", () => {
  test("point to point counts cells between the points", () => {
    assert.equal(pointDistanceFt({ x: 0.5, y: 0.5 }, { x: 3.5, y: 0.5 }, five), 15);
    assert.equal(pointDistanceFt({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, five), 0);
    assert.equal(pointDistanceFt({ x: 0.5, y: 0.5, z: 0 }, { x: 0.5, y: 0.5, z: 15 }, five), 15);
    assert.equal(pointDistanceFt({ x: 0.5, y: 0.5 }, { x: 3.5, y: 4.5 }, euclid), 25);
  });

  test("fiveTen carries its diagonal counter across waypoints", () => {
    const path = [
      { x: 0.5, y: 0.5 },
      { x: 1.5, y: 1.5 },
      { x: 2.5, y: 2.5 },
      { x: 3.5, y: 3.5 },
    ];
    const r = rulerDistanceFt(path, fiveTen);
    assert.deepEqual(r.legsFt, [5, 10, 5]);
    assert.equal(r.totalFt, 20);
    // The same path as one straight leg costs the same.
    assert.equal(pointDistanceFt(path[0]!, path[3]!, fiveTen), 20);
    // Under five every diagonal is 5 ft.
    assert.equal(rulerDistanceFt(path, five).totalFt, 15);
  });

  test("euclid legs are rounded and the total is their sum", () => {
    const r = rulerDistanceFt(
      [
        { x: 0.5, y: 0.5 },
        { x: 1.5, y: 1.5 },
        { x: 2.5, y: 2.5 },
      ],
      euclid,
    );
    assert.deepEqual(r.legsFt, [7, 7]);
    assert.equal(r.totalFt, 14);
  });

  test("a path may start on a token", () => {
    const start = tokenCellBox(tok(0, 0, { size: "large" }), 5);
    const r = pathDistanceFt([start, pointCellBox({ x: 5.5, y: 0.5 }, 5)], five);
    assert.equal(r.totalFt, 20);
  });
});
