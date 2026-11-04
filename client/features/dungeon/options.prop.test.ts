import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { planDungeon } from "./plan.ts";
import { Stream } from "./random.ts";
import { CROCKFORD, newSeed, versionChar, type Seed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, defaultRooms, HEIGHT_PRESETS, HEIGHTS_MAX, HEIGHTS_STEP, raisedCount, roomCap, SIZE_SIDES, TRAP_PRESETS, TRAPS_MAX, trapCount } from "./settings.ts";

/*
 * Heights and Traps are sliders (D-261102-832): what a DM sets is what the
 * dungeon shows, near enough, at every Size. Never more than the slider
 * asks, and over a fixed set of dungeons per Size, close to it.
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

describe("Heights and Traps follow their sliders", () => {
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
        // A run needs 3 or 4 squares of rock out from each of its room's doorways. Small packs its rooms 4 apart, so about one room in four there has no room for its stairs, and Most reaches 3 of its 4.
        const floor = size === "small" ? 0.7 : 0.9;
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

  test("Heights moves only the heights: every mark keeps the same seed's floors and locks wherever it keeps the same doorways", () => {
    for (const seed of seeds(78, 20)) {
      const plans = Object.values(HEIGHT_PRESETS).map((heights) => planDungeon({ ...DEFAULT_SETTINGS, heights }, seed));
      const doors = (i: number) => plans[i]!.board.doorways.filter((d) => !d.removed).length;
      const look = (i: number) => [plans[i]!.plan.rooms.map((r) => r.floor), plans[i]!.plan.doors.filter((d) => d.state === "locked").length];
      for (let i = 1; i < plans.length; i++) if (doors(i) === doors(0) && plans[i]!.plan.rooms.length === plans[0]!.plan.rooms.length) assert.deepEqual(look(i), look(0), `mark ${i}`);
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
