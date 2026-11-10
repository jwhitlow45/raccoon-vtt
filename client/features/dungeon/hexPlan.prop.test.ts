import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { HexStamps, latticeDistance, STAMP_DOOR_STEPS } from "./furnish.ts";
import { CORRIDOR_SPACE, endsKey, hexSide, NO_SPACE, RUN_SPACE } from "./hexWalls.ts";
import { planDungeon } from "./plan.ts";
import { CROCKFORD, versionChar, type Seed } from "./seed.ts";
import { clampSettings, roomCap, type DungeonSettings } from "./settings.ts";

/*
 * Any hex plan (phase 3, 2.2 to 2.4): its floor lies on the scene, one wall
 * or leaf per side, every side the pass must wall walled, nothing open
 * between two spaces but a doorway, a far landing and the corridors, every
 * floor hex reached from the way in, and every stamp's box in its own
 * room's hexes, more than 2 steps from any doorway.
 */

const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));
const gridArb = fc.constantFrom("hexRows" as const, "hexColumns" as const);
const settingsArb = fc.record({
  w: fc.integer({ min: 30, max: 70 }),
  h: fc.integer({ min: 30, max: 70 }),
  rooms: fc.integer({ min: 3, max: 18 }),
  density: fc.constantFrom("sparse", "normal", "dense"),
  corridors: fc.constantFrom("straight", "bending", "winding"),
  wide: fc.boolean(),
  loops: fc.boolean(),
  theme: fc.constantFrom("dungeon", "crypt", "cave", "mine", "sewer"),
  heights: fc.constantFrom(0, 25, 75),
  traps: fc.constantFrom(0, 2, 6),
  secrets: fc.constantFrom(0, 2, 6),
  lit: fc.constantFrom(0, 50, 100),
  dressing: fc.constantFrom("none", "some", "full"),
  deadEnds: fc.boolean(),
} as const);

function plan(raw: Partial<DungeonSettings>, grid: "hexRows" | "hexColumns", seed: Seed) {
  const s = clampSettings({ ...raw, rooms: Math.min(raw.rooms ?? 2, roomCap(raw.w ?? 50, raw.h ?? 50, grid)) }, grid);
  return planDungeon(s, seed, { feetPerCell: 5, grid });
}

describe("any hex plan", () => {
  test("walls every side it must, once each, opens only doorways, far landings and the way in, and every floor hex is reached", () => {
    holds(
      fc.property(settingsArb, gridArb, seedArb, (raw, grid, seed) => {
        const p = plan(raw, grid, seed);
        const L = p.lattice;
        const walls = new Map<string, string>();
        for (const w of p.plan.walls!) {
          const key = endsKey(w.a, w.b);
          assert.ok(!walls.has(key), `${key} walled twice`);
          walls.set(key, w.f);
        }
        const doorways = p.board.doorways.filter((d) => !d.removed);
        const doorSides = new Set<string>();
        for (const d of doorways) for (const i of d.inside) for (const o of d.outside) for (let dir = 0; dir < 6; dir++) if (L.step(i, dir, 1) === o) doorSides.add(endsKey(...hexSide(L, i, dir)));
        const far = new Set(doorways.flatMap((d) => d.run?.far ?? []));
        const sides = new Set<string>();
        let wayIn = 0;
        for (let k = 0; k < p.space.length; k++) {
          const sk = p.space[k]!;
          if (sk === NO_SPACE) continue;
          assert.ok(L.inMap(k % L.W, Math.floor(k / L.W)), "floor on the scene");
          for (let dir = 0; dir < 6; dir++) {
            const key = endsKey(...hexSide(L, k, dir));
            sides.add(key);
            const n = L.step(k, dir, 1);
            const sn = n === null ? NO_SPACE : p.space[n]!;
            const f = walls.get(key);
            if (n === null && f === undefined) {
              assert.ok(L.border(k, dir), "only a border side opens off the scene");
              wayIn++;
            } else if (sn === NO_SPACE) assert.ok(f !== undefined, "floor beside rock is walled");
            else if (sn === sk) assert.equal(f, undefined, "nothing inside a space");
            else if (doorSides.has(key)) assert.ok(f === undefined ? p.plan.theme === "cave" : f !== "wall", "a doorway's side is a leaf, or open on a cave");
            else if ((far.has(k) || sk === CORRIDOR_SPACE) && (far.has(n!) || sn === CORRIDOR_SPACE)) assert.equal(f, undefined, "a far landing opens to the corridors");
            else assert.equal(f, "wall", "two spaces meet at a wall");
          }
        }
        for (const [key, f] of walls) {
          assert.ok(sides.has(key), "every wall bounds a floor hex");
          if (f !== "wall") assert.ok(doorSides.has(key), "leaves stand only on doorway sides");
        }
        assert.equal(wayIn, p.trace.stubFailed ? 0 : 1, "the way in's one border side");
        // Every floor hex is reached from the entrance room through sides with no wall or a leaf.
        const start = p.space.indexOf(p.entrance);
        const seen = new Set([start]);
        const queue = [start];
        while (queue.length > 0) {
          const k = queue.pop()!;
          for (let dir = 0; dir < 6; dir++) {
            const n = L.step(k, dir, 1);
            if (n === null || seen.has(n) || p.space[n] === NO_SPACE || walls.get(endsKey(...hexSide(L, k, dir))) === "wall") continue;
            seen.add(n);
            queue.push(n);
          }
        }
        for (let k = 0; k < p.space.length; k++) if (p.space[k] !== NO_SPACE) assert.ok(seen.has(k), "every floor hex is reached");
        assert.equal(p.plan.paint && Object.keys(p.plan.paint).length, 0, "nothing painted");
        assert.equal(p.plan.doors.length, 0, "doors are leaves");
      }),
      30,
    );
  });

  test("every stamp's box lies in its own room's hexes more than 2 steps from any doorway, and every light stands on a hex of its room", () => {
    holds(
      fc.property(settingsArb, gridArb, seedArb, (raw, grid, seed) => {
        const p = plan({ ...raw, dressing: "full", lit: 100 }, grid, seed);
        const L = p.lattice;
        const stamps = new HexStamps(L);
        const insides = p.board.doorways.filter((d) => !d.removed).flatMap((d) => d.inside);
        for (const st of p.plan.stamps) {
          const hexes = stamps.touched(st);
          assert.ok(hexes.every((k) => k >= 0), `${st.key} stays on the scene`);
          const room = p.space[hexes[0]!]!;
          assert.ok(room >= 0 && room < RUN_SPACE, `${st.key} stands in a room`);
          for (const k of hexes) {
            assert.equal(p.space[k], room, `${st.key}'s box keeps to one room`);
            assert.ok(insides.every((d) => latticeDistance(L.W, k, d) > STAMP_DOOR_STEPS), `${st.key} keeps away from doorways`);
          }
        }
        for (const light of p.plan.lights) {
          let on = false;
          for (let k = 0; k < p.space.length && !on; k++) {
            const [x, y] = L.pointOf(k % L.W, Math.floor(k / L.W));
            on = x === light.x && y === light.y && p.space[k]! >= 0 && p.space[k]! < RUN_SPACE;
          }
          assert.ok(on, "a light stands on a hex of its room");
        }
      }),
      20,
    );
  });
});
