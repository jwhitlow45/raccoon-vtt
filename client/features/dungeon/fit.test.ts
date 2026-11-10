import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { editLayout } from "./edits.ts";
import { fitRooms, NEW_SCENE, withinAllowance } from "./fit.ts";
import { endsKey, hexSide } from "./hexWalls.ts";
import { planDungeon, planFitted, type Planned } from "./plan.ts";
import { clampSettings, DEFAULT_SETTINGS, MAX_FIT_PLANS, MAX_HEX_WALLS, type GridKind } from "./settings.ts";

/*
 * The fit (phase 3, 2.5, D-261110-175): over the wall budget a hex plan
 * asks the same seed for one room fewer, at most 12 plans, and the first
 * that fits wins, `fitted` naming the count it asked for. Edits freeze the
 * count. A Wide way in on hexes leaves by the west (D-261110-240).
 */

/** A stand-in plan that holds `walls[rooms]` walls, so the loop's order can be read without planning. */
function fake(walls: Record<number, number>, asked: number[]): (rooms: number) => Planned {
  return (rooms) => {
    asked.push(rooms);
    return { fitted: rooms, plan: { doors: [], paint: {}, walls: Array.from({ length: walls[rooms] ?? 0 }, () => ({ a: [0, 0], b: [0, 1], f: "wall" })) } } as unknown as Planned;
  };
}
const fits = (p: Planned) => withinAllowance(p.plan, NEW_SCENE);

describe("the fit", () => {
  test("one fewer at a time from the Rooms asked, the first plan that fits wins", () => {
    const asked: number[] = [];
    const got = fitRooms(18, fake({ 18: 3300, 17: 3262, 16: 3100, 15: 2980 }, asked), fits);
    assert.deepEqual(asked, [18, 17, 16]);
    assert.equal(got.planned.fitted, 16);
    assert.equal(got.failed, null);
  });

  test("a plan that fits at once is taken with no other made", () => {
    const asked: number[] = [];
    assert.equal(fitRooms(24, fake({ 24: MAX_HEX_WALLS }, asked), fits).planned.fitted, 24);
    assert.deepEqual(asked, [24], "exactly the budget fits");
  });

  test("at most 12 plans, then the past-12 failure with the last plan made", () => {
    const asked: number[] = [];
    const got = fitRooms(24, fake(Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i + 1, 4000])), asked), fits);
    assert.equal(asked.length, MAX_FIT_PLANS);
    assert.equal(got.failed, "tooMany");
    assert.equal(got.planned.fitted, 13);
  });

  test("stepping under two rooms fails as the walls fit error", () => {
    const asked: number[] = [];
    const got = fitRooms(4, fake({ 4: 4000, 3: 4000, 2: 4000 }, asked), fits);
    assert.deepEqual(asked, [4, 3, 2]);
    assert.equal(got.failed, "underTwo");
  });

  const heavy = (rooms: number, grid: GridKind = "hexRows") => clampSettings({ ...DEFAULT_SETTINGS, w: 80, h: 80, rooms, wide: true, density: "dense", corridors: "winding", heights: 75 }, grid);
  const R1 = "9000000000000005";

  test("round 1's seed: 18 asked fits and is taken, and 24 asked steps past 21 to 23 over the budget to 20", () => {
    const ctx = { feetPerCell: 5, grid: "hexRows" as const };
    const at18 = planFitted(heavy(18), R1, ctx);
    assert.equal(at18.fitted, 18);
    assert.ok(at18.plan.walls!.length <= MAX_HEX_WALLS);
    for (const rooms of [21, 22, 23]) assert.ok(planDungeon(heavy(rooms), R1, ctx).plan.walls!.length > MAX_HEX_WALLS, `${rooms} rooms are over`);
    const at24 = planFitted(heavy(24), R1, ctx);
    assert.equal(at24.fitted, 20);
    assert.equal(at24.overBudget, null);
    assert.equal(at24.plan.asked, 24, "the plan still says what was asked");
    assert.ok(at24.plan.walls!.length <= MAX_HEX_WALLS);
  });

  test("squares never step down", () => {
    const p = planFitted(clampSettings({ ...DEFAULT_SETTINGS, w: 100, h: 100, rooms: 40, wide: true, density: "dense", corridors: "winding", heights: 75 }), R1, { feetPerCell: 5 });
    assert.equal(p.fitted, 40);
  });

  test("edits at the budget's edge keep the frozen count, and a plan over it says so for the edit to be undone", () => {
    const ctx = { feetPerCell: 5, grid: "hexRows" as const };
    const s = heavy(24);
    const over = planFitted(s, R1, ctx, { edits: { layout: editLayout(s, R1, 23, null), rooms: { 0: { lit: true } } } });
    assert.equal(over.fitted, 23);
    assert.equal(over.overBudget, "edits");
    const under = planFitted(s, R1, ctx, { edits: { layout: editLayout(s, R1, 20, null), rooms: { 0: { lit: true } } } });
    assert.equal(under.fitted, 20);
    assert.equal(under.overBudget, null);
  });

  for (const grid of ["hexRows", "hexColumns"] as const) {
    test(`a Wide way in on ${grid === "hexRows" ? "Hex rows" : "Hex columns"} leaves by the west even from a room nearest the east, through its even lane`, () => {
      for (const seed of ["9000000000000001", "900000000000000A", "900000000000000E"]) {
        const p = planFitted(clampSettings({ ...DEFAULT_SETTINGS, wide: true }, grid), seed, { feetPerCell: 5, grid });
        assert.equal(p.trace.stubFailed, false, seed);
        const L = p.lattice;
        const end = p.stubPath!.filter((k) => k % L.W === 0);
        assert.ok(end.length >= 2, `${seed}: the stub reaches x 0 in both lanes`);
        const walls = new Set(p.plan.walls!.map((w) => endsKey(w.a, w.b)));
        const last = p.stubPath!.slice(-4).filter((k) => k % L.W === 0);
        const even = last.find((k) => Math.floor(k / L.W) % 2 === 0)!;
        const odd = last.find((k) => Math.floor(k / L.W) % 2 === 1)!;
        assert.ok(!walls.has(endsKey(...hexSide(L, even, 3))), `${seed}: the even lane opens off the map`);
        assert.ok(walls.has(endsKey(...hexSide(L, odd, 3))), `${seed}: the odd lane's end side is walled`);
      }
    });
  }
});
