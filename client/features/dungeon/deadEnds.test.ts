import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deadEndCount } from "./deadEnds.ts";
import { around, paintedOf, samples, xyOf } from "./plan.samples.ts";

/*
 * Dead ends (phase 2, 5.2, D-261107-206): straight spurs 3 to 8 squares
 * long, as wide as the corridor, that end in rock a square from every room
 * and every other corridor, at 0 ft, so none ends against a room's wall.
 */

const NARROW = samples(71, 30, { w: 60, h: 60, rooms: 16 });
const WIDE = samples(72, 20, { wide: true, w: 70, h: 70, rooms: 16 });

describe("dead ends", () => {
  test("about one per four kept rooms, at least 1 and at most 10", () => {
    assert.deepEqual([1, 2, 4, 5, 6, 12, 20, 38, 40].map(deadEndCount), [1, 1, 1, 1, 2, 3, 5, 10, 10]);
  });

  test("each spur is straight, 3 to 8 squares long and as wide as the corridor, and touches nothing but its own squares and the square it grows from", () => {
    let spurs = 0;
    for (const { p, s, seed } of [...NARROW, ...WIDE]) {
      const W = p.plan.w;
      const width = s.wide ? 2 : 1;
      const painted = paintedOf(p);
      assert.ok(p.spurs.length <= deadEndCount(p.kept.length));
      for (const sp of p.spurs) {
        spurs++;
        const long = sp.cells.length / width;
        assert.ok(Number.isInteger(long) && long >= 3 && long <= 8, `${seed}: a spur ${sp.cells.length} squares`);
        const xs = sp.cells.map((k) => k % W);
        const ys = sp.cells.map((k) => Math.floor(k / W));
        const across = sp.side === "n" || sp.side === "s" ? new Set(xs).size : new Set(ys).size;
        assert.equal(across, width, `${seed}: a spur ${across} across`);
        const own = new Set(sp.cells);
        let touching = 0;
        for (const k of sp.cells) {
          const [x, y] = xyOf(k, W);
          assert.ok(painted.has(k), `${seed}: spur ${x},${y} unpainted`);
          assert.ok(!p.board.halo(k) && p.board.roomAt[k] === 0, `${seed}: spur ${x},${y} touches a room`);
          for (const n of around(k, W, p.plan.h)) {
            if (own.has(n) || !painted.has(n)) continue;
            // Its only painted neighbor outside it is the corridor it grows from, one square a lane.
            touching++;
            assert.equal(p.board.roomAt[n], 0, `${seed}: spur ${x},${y} touches a room`);
          }
        }
        assert.equal(touching, width, `${seed}: spur at ${xyOf(sp.cells[0]!, W).join(",")} touches ${touching} corridor squares`);
      }
    }
    assert.ok(spurs > 60, `${spurs} spurs`);
  });

  test("a spur stands at 0 ft, so no ledge meets it", () => {
    for (const { p } of [...NARROW, ...WIDE]) {
      const W = p.plan.w;
      const raised = new Set(p.plan.heights.flatMap((h) => h.cells));
      const stairs = new Set(p.plan.stairs.flatMap((st) => st.cells));
      for (const k of p.spurs.flatMap((sp) => sp.cells)) {
        const c = xyOf(k, W).join(",");
        assert.ok(!raised.has(c) && !stairs.has(c));
      }
    }
  });

  test("Dead ends off: no spurs", () => {
    for (const { p } of samples(73, 10, { deadEnds: false })) assert.deepEqual(p.spurs, []);
  });
});
