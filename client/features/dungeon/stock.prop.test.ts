import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { occupiedCells, occupiedHexes } from "#shared/rules/footprint.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { MAX_LEVEL } from "#shared/srd/xp-budget.ts";
import { partyBudgets } from "../encounters/budget.ts";
import type { RoomEdit } from "./edits.ts";
import { hexGridOf } from "./lattice.ts";
import { planDungeon, planFitted } from "./plan.ts";
import { CROCKFORD, versionChar, type Seed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, isHexGrid, MAX_MONSTERS, THEMES, type GridKind } from "./settings.ts";
import { roomClaim, stockClaims, stockPlan } from "./stock.ts";
import { stockPool } from "./stockPools.ts";
import { FIRE_STATUE, HIDDEN_PIT, POISONED_NEEDLE, SPIKED_PIT } from "./trapSpots.ts";

/*
 * Stocking over any seed, grid, theme, party and room edits
 * (docs/design/design-v1-dungeon-stock.md 8): each creature inside its
 * room, on cells it may stand on at one ground, none overlapping, each room
 * within its claim, and the creatures within the capacity whenever the
 * claim check lets Make on (D-261127-282).
 */

const SRD = await loadMonsters();
const POOLS = Object.fromEntries(THEMES.map((t) => [t, stockPool(SRD, t, { srdImages: {} })]));
const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));
const editArb: fc.Arbitrary<RoomEdit> = fc.record(
  {
    monsters: fc.boolean(),
    monstersDraw: fc.integer({ min: 0, max: 20 }),
    trap: fc.constantFrom(null, HIDDEN_PIT, SPIKED_PIT, POISONED_NEEDLE, FIRE_STATUE),
    lit: fc.boolean(),
    dressing: fc.constantFrom("none", "some", "full"),
  } as const,
  { requiredKeys: [] },
);

let stocked = 0;
let hexStocked = 0;

test("DSTOCK-PROP: every creature stands in its room on free floor at one ground, none overlap, and Make never passes the capacity", () => {
  holds(
    fc.property(
      fc.constantFrom<GridKind>("squares", "squares", "hexRows", "hexColumns"),
      seedArb,
      fc.constantFrom(...THEMES),
      fc.array(fc.record({ count: fc.integer({ min: 1, max: 8 }), level: fc.integer({ min: 1, max: MAX_LEVEL }) }), { minLength: 1, maxLength: 3 }),
      fc.constantFrom(5, 25, 50, 100),
      fc.constantFrom("low", "moderate", "high"),
      fc.integer({ min: 0, max: 60 }),
      fc.array(fc.tuple(fc.nat(), editArb), { maxLength: 4 }),
      (grid, seed, theme, party, monsters, difficulty, tokensLeft, picks) => {
        const s = clampSettings({ ...DEFAULT_SETTINGS, w: 50, h: 50, rooms: 12, traps: 6, lit: 50, dressing: "full", theme }, grid);
        const ctx = grid === "squares" ? { feetPerCell: 5 } : { feetPerCell: 5, grid };
        const first = planFitted(s, seed, ctx);
        if (first.overBudget) return;
        const edits = Object.fromEntries(picks.map(([pick, e]) => [first.kept[pick % first.kept.length]!, e]));
        const planned = planFitted(s, seed, ctx, { edits: { layout: first.layout, rooms: edits } });
        if (planned.overBudget) return;
        const stock = { choices: { monsters, difficulty }, party, pool: POOLS[theme]!, tokensLeft };
        const done = stockPlan(planned, seed, theme, stock, edits);
        const L = planned.lattice;
        const hex = isHexGrid(planned.plan.grid) ? hexGridOf(planned.plan.grid) : null;
        const ground = new Map(planned.plan.heights.flatMap(({ ft, cells }) => cells.map((c) => [c, ft] as const)));
        const sizes = new Map(stock.pool.map((m) => [m.srdId, m]));
        const budget = partyBudgets(party)[difficulty];
        const taken = new Set<number>();
        const perRoom = new Map<number, number>();
        const xp = new Map<number, number>();
        for (const m of done.plan.monsters ?? []) {
          const block = sizes.get(m.srdId)!;
          const token = { size: block.size, x: m.x, y: m.y };
          const cells = hex
            ? occupiedHexes(hex, token).map((h) => (planned.plan.grid === "hexColumns" ? h.col * L.W + h.row : h.row * L.W + h.col))
            : occupiedCells(SQUARES, token).map((c) => c.y * L.W + c.x);
          const g = ground.get(L.keyOf(cells[0]!)) ?? 0;
          for (const k of cells) {
            assert.ok(planned.standable(m.room, k), `${block.name} in room ${m.room} on a cell it may not stand on`);
            assert.equal(ground.get(L.keyOf(k)) ?? 0, g, "one ground");
            assert.ok(!taken.has(k), "no overlap");
            taken.add(k);
          }
          perRoom.set(m.room, (perRoom.get(m.room) ?? 0) + 1);
          xp.set(m.room, (xp.get(m.room) ?? 0) + block.xp);
        }
        const byName = new Map(stock.pool.map((m) => [m.name, m]));
        for (const f of done.facts) {
          // A fight lists its leader first, and a leader is never weaker than its followers, whatever their size.
          const [first, second] = f.monsters?.lines ?? [];
          if (first && second) assert.ok(byName.get(first[0])!.xp >= byName.get(second[0])!.xp, `room ${f.n} lists ${first[0]} before ${second[0]}`);
          const claim = roomClaim(f, edits, done.perRoom);
          assert.ok((perRoom.get(f.room) ?? 0) <= claim, `room ${f.n} within its claim`);
          assert.ok((xp.get(f.room) ?? 0) <= budget, `room ${f.n} within the budget`);
          assert.equal(f.monsters?.on, claim > 0);
        }
        assert.equal(done.claims, stockClaims(done.facts, edits, done.perRoom));
        const landed = done.plan.monsters?.length ?? 0;
        if (landed > 0) {
          stocked++;
          if (hex) hexStocked++;
        }
        assert.ok(landed <= MAX_MONSTERS);
        if (done.claims <= done.capacity) assert.ok(landed <= done.capacity, `${landed} creatures past a capacity of ${done.capacity}`);
        if (!hex) {
          // On squares the plan itself says what stands where, so the test checks standable's exclusions without it.
          const off = new Set<number>();
          for (const t of planned.plan.traps) if ("cells" in t.zone) for (const r of t.zone.cells) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) off.add(y * L.W + x);
          for (const l of planned.plan.lights) off.add(Math.floor(l.y) * L.W + Math.floor(l.x));
          for (const r of planned.plan.rooms) off.add(r.pin[1] * L.W + r.pin[0]);
          for (const t of ["water", "pit", "pillar", "rubble", "difficult"] as const) for (const c of planned.plan.paint[t] ?? []) off.add(Number(c.split(",")[1]) * L.W + Number(c.split(",")[0]));
          for (const k of taken) assert.ok(!off.has(k), `a creature on a trap, light, pin or overlay at ${k % L.W},${Math.floor(k / L.W)}`);
        }
      },
    ),
    120,
  );
  assert.ok(stocked >= 20 && hexStocked >= 5, `not vacuous: ${stocked} runs stocked, ${hexStocked} on hexes`);
});

test("DSTOCK-PROP: with rooms dropped in routing, every key entry's fight is its own room's (STOCK-ASTRA-01)", () => {
  let dropped = 0;
  holds(
    // A small search budget makes routing give up on links and drop the rooms beyond them, which a full budget seldom does.
    fc.property(seedArb, fc.constantFrom(...THEMES), fc.integer({ min: 300, max: 6_000 }), (seed, theme, budget) => {
      const s = clampSettings({ ...DEFAULT_SETTINGS, w: 50, h: 50, rooms: 16, density: "dense", corridors: "winding", theme, key: true }, "squares");
      const planned = planDungeon(s, seed, { feetPerCell: 5 }, budget);
      if (planned.kept.some((i, at) => i !== at)) dropped++;
      const done = stockPlan(planned, seed, theme, { choices: { monsters: 100, difficulty: "high" }, party: [{ count: 4, level: 5 }], pool: POOLS[theme]!, tokensLeft: 500 }, null);
      for (const k of done.plan.key ?? []) {
        const fight = done.facts.find((f) => f.at === k.room)!.monsters;
        if (fight?.on && fight.lines.length > 0) assert.deepEqual(k.monsters?.lines, fight.lines, `key room ${k.n}`);
        else assert.equal(k.monsters, undefined, `key room ${k.n} holds no fight`);
      }
    }),
    30,
  );
  assert.ok(dropped >= 5, `not vacuous: ${dropped} plans dropped rooms`);
});
