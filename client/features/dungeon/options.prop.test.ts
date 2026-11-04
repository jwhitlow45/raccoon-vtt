import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { planDungeon } from "./plan.ts";
import { Stream } from "./random.ts";
import { CROCKFORD, newSeed, versionChar, type Seed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, defaultRooms, HEIGHT_PRESETS, HEIGHTS_MAX, HEIGHTS_STEP, raisedCount, roomCap, SIZE_SIDES, TRAP_PRESETS, TRAPS_MAX, trapCount } from "./settings.ts";

/*
 * The options look as they say at every Size (D-261102-832, 836). Heights
 * and Traps are sliders: never more than a slider asks, and over a fixed
 * set of dungeons per Size, close to it. A Crypt shows its pillars at every
 * Density.
 */

const SIZES = ["small", "medium", "large"] as const;
const SAMPLE = 30;

function seeds(label: number, n: number): Seed[] {
  const key = new Uint8Array(32);
  key[0] = label;
  const stream = new Stream(key, new Uint8Array(12));
  return Array.from({ length: n }, () => newSeed((b) => b.forEach((_, i) => (b[i] = stream.below(256)))));
}

const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));

describe("the options look as they say", () => {
  test("a dungeon never raises more rooms than Heights asks, nor places more traps than Traps asks, and the entrance stays flat", () => {
    holds(
      fc.property(
        fc.constantFrom(20, 30, 50, 80, 100),
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 0, max: HEIGHTS_MAX / HEIGHTS_STEP }),
        fc.integer({ min: 0, max: TRAPS_MAX }),
        fc.constantFrom("straight", "bending", "winding"),
        fc.boolean(),
        seedArb,
        (side, rooms, h, traps, corridors, wide, seed) => {
          const s = clampSettings({ ...DEFAULT_SETTINGS, w: side, h: side, rooms: Math.min(rooms, roomCap(side, side)), heights: h * HEIGHTS_STEP, traps, corridors, wide });
          const p = planDungeon(s, seed).plan;
          const off = p.rooms.filter((r) => r.ground !== 0);
          assert.ok(off.length <= raisedCount(s.heights, s.rooms), `${off.length} off flat for ${s.heights}% of ${s.rooms}`);
          assert.ok(!off.some((r) => r.entrance));
          assert.ok(p.traps.length <= trapCount(s.traps, p.rooms.length));
          if (s.heights === 0) assert.equal(off.length, 0);
          if (s.traps === 0) assert.equal(p.traps.length, 0);
        },
      ),
      25,
    );
  });

  for (const [i, size] of SIZES.entries()) {
    test(`${size}: each Heights mark raises close to its share of the rooms, and each Traps mark places its count`, () => {
      const side = SIZE_SIDES[size];
      const list = seeds(70 + i, SAMPLE);
      const base = { ...DEFAULT_SETTINGS, w: side, h: side, rooms: defaultRooms(size, side, side) };
      for (const share of Object.values(HEIGHT_PRESETS)) {
        let got = 0;
        let want = 0;
        for (const seed of list) {
          const p = planDungeon({ ...base, heights: share }, seed).plan;
          got += p.rooms.filter((r) => r.ground !== 0).length;
          want += raisedCount(share, p.rooms.length);
        }
        // A run needs 3 or 4 squares of rock out from each of its room's doorways. Small packs its rooms 4 apart, so about one room in four there has no room for its stairs, and Most reaches about 3 of its 4, 2 in 3 in an unlucky sample.
        const floor = size === "small" ? 0.6 : 0.9;
        assert.ok(got >= want * floor, `${size} Heights ${share}%: ${got} of ${want} rooms off flat`);
      }
      for (const twelfths of Object.values(TRAP_PRESETS)) {
        let got = 0;
        let want = 0;
        for (const seed of list) {
          const p = planDungeon({ ...base, traps: twelfths }, seed).plan;
          got += p.traps.length;
          want += trapCount(twelfths, p.rooms.length);
        }
        // Traps keep 6 squares apart, and every size has room for Many's one per two rooms.
        assert.ok(got >= want * 0.95, `${size} Traps ${twelfths}/12: ${got} of ${want}`);
      }
    });
  }

  test("Heights keeps the floors and locks: every mark keeps the same seed's floors and locks wherever it keeps the same doorways and rooms", () => {
    for (const seed of seeds(78, 20)) {
      const plans = Object.values(HEIGHT_PRESETS).map((heights) => planDungeon({ ...DEFAULT_SETTINGS, heights }, seed));
      const doors = (i: number) => plans[i]!.board.doorways.filter((d) => !d.removed).length;
      const look = (i: number) => [plans[i]!.plan.rooms.map((r) => r.floor), plans[i]!.plan.doors.filter((d) => d.state === "locked").length];
      for (let i = 1; i < plans.length; i++) if (doors(i) === doors(0) && plans[i]!.plan.rooms.length === plans[0]!.plan.rooms.length) assert.deepEqual(look(i), look(0), `mark ${i}`);
    }
  });

  test("Theme: a Crypt has pillars in a good share of its rooms at every Density and Size, and locks more doors than a Dungeon, which has wood floors and no pillars", () => {
    for (const [i, size] of SIZES.entries()) {
      for (const density of ["sparse", "normal", "dense"] as const) {
        const side = SIZE_SIDES[size];
        const base = { ...DEFAULT_SETTINGS, w: side, h: side, rooms: defaultRooms(size, side, side), density };
        const look = { crypt: { rooms: 0, pillared: 0, doors: 0, locked: 0, wood: 0 }, dungeon: { rooms: 0, pillared: 0, doors: 0, locked: 0, wood: 0 } };
        // Small dungeons have few rooms each, so Small takes more of them for a steady share.
        for (const seed of seeds(80 + i, size === "small" ? 60 : 20)) {
          for (const theme of ["crypt", "dungeon"] as const) {
            const p = planDungeon({ ...base, theme }, seed).plan;
            const pillars = new Set(p.paint.pillar ?? []);
            const t = look[theme];
            t.rooms += p.rooms.length;
            t.pillared += p.rooms.filter((r) => [...pillars].some((c) => {
              const [x, y] = c.split(",").map(Number) as [number, number];
              return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
            })).length;
            t.doors += p.doors.length;
            t.locked += p.doors.filter((d) => d.state === "locked").length;
            t.wood += p.rooms.filter((r) => r.floor === "wood").length;
          }
        }
        // Sparse rooms are 3 to 6 squares a side and only those 5 by 5 or more take pillars, a quarter of them, less the doorways' lines: about 1 room in 7 on Small Sparse.
        assert.ok(look.crypt.pillared >= look.crypt.rooms * 0.1, `${size} ${density}: pillars in ${look.crypt.pillared} of ${look.crypt.rooms} Crypt rooms`);
        assert.ok(look.crypt.locked / look.crypt.doors > look.dungeon.locked / look.dungeon.doors, `${size} ${density}: locks`);
        assert.equal(look.dungeon.pillared, 0);
        assert.equal(look.crypt.wood, 0);
        assert.ok(look.dungeon.wood > 0, `${size} ${density}: wood`);
      }
    }
  });

  test("the marks keep their order at every size: more Heights raises more rooms, more Traps places more", () => {
    for (const [i, size] of SIZES.entries()) {
      const side = SIZE_SIDES[size];
      const list = seeds(75 + i, 12);
      const base = { ...DEFAULT_SETTINGS, w: side, h: side, rooms: defaultRooms(size, side, side) };
      const raised = Object.values(HEIGHT_PRESETS).map((heights) => list.reduce((n, seed) => n + planDungeon({ ...base, heights }, seed).plan.rooms.filter((r) => r.ground !== 0).length, 0));
      const traps = Object.values(TRAP_PRESETS).map((t) => list.reduce((n, seed) => n + planDungeon({ ...base, traps: t }, seed).plan.traps.length, 0));
      for (let k = 1; k < raised.length; k++) assert.ok(raised[k]! >= raised[k - 1]!, `${size} Heights marks ${raised.join(", ")}`);
      for (let k = 1; k < traps.length; k++) assert.ok(traps[k]! > traps[k - 1]!, `${size} Traps marks ${traps.join(", ")}`);
      assert.ok(raised.at(-1)! > raised[1]!, `${size}: Most raises more than Few`);
    }
  });
});
