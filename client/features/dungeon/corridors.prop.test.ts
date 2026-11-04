import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { facingSides } from "./layout.ts";
import { planDungeon, type Planned } from "./plan.ts";
import { planProblems } from "./plan.testkit.ts";
import { Stream } from "./random.ts";
import { CROCKFORD, newSeed, versionChar, type Seed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, defaultRooms, roomCap, SIZE_SIDES, type CorridorStyle, type DungeonSettings } from "./settings.ts";

/*
 * The corridor styles look different at every size (D-261102-830): what a
 * player sees of a corridor is how often it turns and how far it wanders
 * from the shortest way, so each style's character and the gaps between
 * them are held over a fixed set of dungeons per Size, with the same seed
 * in every style so only the style changes.
 */

const STYLES: readonly CorridorStyle[] = ["straight", "bending", "winding"];
const SIZES = ["small", "medium", "large"] as const;
/** Dungeons per Size and style: enough that one odd map moves a share by about 3%. */
const SAMPLE = 30;

function seeds(label: number, n: number): Seed[] {
  const key = new Uint8Array(32);
  key[0] = label;
  const stream = new Stream(key, new Uint8Array(12));
  return Array.from({ length: n }, () => newSeed((b) => b.forEach((_, i) => (b[i] = stream.below(256)))));
}

type Shape = { turns: number; detour: number; rooms: number };

/** A dungeon's corridors as a player walks them: turns per corridor, and squares walked over the shortest way's. And the rooms it kept. */
function corridorShape(p: Planned): Shape {
  const W = p.plan.w;
  let turns = 0;
  let steps = 0;
  let shortest = 0;
  let n = 0;
  for (const chain of p.ways) {
    if (!chain || chain.length < 2) continue;
    n++;
    for (let i = 2; i < chain.length; i++) if (chain[i]! - chain[i - 1]! !== chain[i - 1]! - chain[i - 2]!) turns++;
    steps += chain.length - 1;
    const a = chain[0]!;
    const b = chain.at(-1)!;
    shortest += Math.abs((a % W) - (b % W)) + Math.abs(Math.floor(a / W) - Math.floor(b / W));
  }
  return { turns: n ? turns / n : 0, detour: shortest ? steps / shortest : 1, rooms: p.plan.rooms.length };
}

const quantile = (xs: readonly number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]!;
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Each style's shapes over the sample at one Size and width, the seeds shared. */
function sample(size: (typeof SIZES)[number], wide: boolean, label: number): Record<CorridorStyle, Shape[]> {
  const side = SIZE_SIDES[size];
  const list = seeds(label, SAMPLE);
  const out = {} as Record<CorridorStyle, Shape[]>;
  for (const corridors of STYLES) out[corridors] = list.map((seed) => corridorShape(planDungeon({ ...DEFAULT_SETTINGS, w: side, h: side, rooms: defaultRooms(size, side, side), corridors, wide }, seed)));
  return out;
}

/** A style never costs a room: a link its doorways or waypoints cannot join is tried again the plain way, so each style keeps at least Straight's rooms over the sample. */
function keepsRooms(s: Record<CorridorStyle, Shape[]>, where: string): void {
  const kept = (style: CorridorStyle) => s[style].reduce((n, m) => n + m.rooms, 0);
  for (const style of STYLES) assert.ok(kept(style) >= kept("straight"), `${where}: ${style} kept ${kept(style)} rooms, Straight ${kept("straight")}`);
}

/** How many seeds' dungeons turn more in style `hi` than in style `lo`. */
const ahead = (s: Record<CorridorStyle, { turns: number }[]>, lo: CorridorStyle, hi: CorridorStyle) => s[hi].filter((m, i) => m.turns > s[lo][i]!.turns).length;

describe("corridor styles at every size", () => {
  for (const [i, size] of SIZES.entries()) {
    test(`${size}, Narrow: Straight keeps to the shortest way with a turn or so, Bending takes a few turns, Winding many and a longer way, and for the same seed each turns more than the one before`, () => {
      const s = sample(size, false, 90 + i);
      keepsRooms(s, size);
      const turns = (style: CorridorStyle) => mean(s[style].map((m) => m.turns));
      const detour = (style: CorridorStyle) => mean(s[style].map((m) => m.detour));
      // Each style's character, on the sample's averages.
      assert.ok(turns("straight") <= 1.6 && detour("straight") <= 1.15, `Straight turns ${turns("straight")}, detour ${detour("straight")}`);
      assert.ok(turns("bending") >= 1.8 && turns("bending") <= 3.5, `Bending turns ${turns("bending")}`);
      assert.ok(turns("winding") >= 3.2 && detour("winding") >= 1.35, `Winding turns ${turns("winding")}, detour ${detour("winding")}`);
      // The same seed in each style: at most 1 in 7 dungeons out of order. Some Small maps join every room by short crossings, where any style has a couple of turns at most.
      assert.ok(ahead(s, "straight", "bending") >= SAMPLE * 0.85, `Bending ahead of Straight in ${ahead(s, "straight", "bending")} of ${SAMPLE}`);
      assert.ok(ahead(s, "bending", "winding") >= SAMPLE * 0.85, `Winding ahead of Bending in ${ahead(s, "bending", "winding")} of ${SAMPLE}`);
      // The middle halves of the styles' ranges never meet: a typical dungeon of one style is never a typical one of the next.
      for (const [lo, hi] of [["straight", "bending"], ["bending", "winding"]] as const) {
        const top = quantile(s[lo].map((m) => m.turns), 0.75);
        const bottom = quantile(s[hi].map((m) => m.turns), 0.25);
        assert.ok(top < bottom, `${lo}'s upper quarter ${top} meets ${hi}'s lower quarter ${bottom}`);
      }
    });
  }

  test("Wide: Bending and Winding turn more than Straight at every size, and Winding more than Bending, by a wide margin from Medium up", () => {
    for (const [i, size] of SIZES.entries()) {
      const s = sample(size, true, 95 + i);
      keepsRooms(s, `${size} Wide`);
      const turns = (style: CorridorStyle) => mean(s[style].map((m) => m.turns));
      assert.ok(turns("straight") <= 1.6, `${size}: Straight turns ${turns("straight")}`);
      assert.ok(turns("straight") < turns("bending") && turns("bending") < turns("winding"), `${size}: turns ${STYLES.map(turns).join(", ")}`);
      // Wide doorways need 4 squares of side, so short sides leave Bending's doorways where Straight's are more often than on Narrow.
      assert.ok(ahead(s, "straight", "bending") >= SAMPLE * 0.8, `${size}: Bending ahead of Straight in ${ahead(s, "straight", "bending")}`);
      // Two-square corridors with their walls need twice the rock to wind, and Small has little, so there Winding leads in only about 6 dungeons in 10.
      const lead = size === "small" ? 0.5 : 0.85;
      assert.ok(ahead(s, "bending", "winding") >= SAMPLE * lead, `${size}: Winding ahead of Bending in ${ahead(s, "bending", "winding")}`);
    }
  });

  test("a styled link that finds no way is tried once more from the plain doorways, on the sides facing the other room, and often goes through", () => {
    const list = seeds(99, 60);
    let replaced = 0;
    let rescued = 0;
    for (const seed of list) {
      const s = { ...DEFAULT_SETTINGS, corridors: "winding" as const, wide: true };
      const p = planDungeon(s, seed);
      assert.deepEqual(planProblems(p, s), []);
      for (const li of p.trace.replaced) {
        replaced++;
        if (!p.paths[li]) continue;
        rescued++;
        const l = p.links[li]!;
        for (const d of p.board.doorways.filter((d) => d.link === li && !d.removed)) {
          const other = p.board.rooms[d.room === l.a ? l.b : l.a]!;
          assert.ok(facingSides(p.board.rooms[d.room]!, other).includes(d.side), `link ${li} on a side facing the other room`);
        }
      }
    }
    assert.ok(replaced >= 5 && rescued >= 3, `${replaced} links tried plain, ${rescued} went through`);
  });

  test("the style moves only the corridors: every style keeps the same seed's rooms and locks, and every plan keeps the invariants", () => {
    const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));
    const settingsArb: fc.Arbitrary<DungeonSettings> = fc
      .record({
        side: fc.constantFrom(20, 30, 50, 80),
        rooms: fc.integer({ min: 2, max: 30 }),
        density: fc.constantFrom("sparse", "normal", "dense"),
        wide: fc.boolean(),
        loops: fc.boolean(),
        theme: fc.constantFrom("dungeon", "crypt"),
      } as const)
      .map(({ side, rooms, ...rest }) => clampSettings({ ...DEFAULT_SETTINGS, ...rest, w: side, h: side, rooms: Math.min(rooms, roomCap(side, side)) }));
    holds(
      fc.property(settingsArb, seedArb, (s, seed) => {
        const plans = STYLES.map((corridors) => planDungeon({ ...s, corridors }, seed));
        const rooms = plans.map((p) => p.board.rooms.map(({ x, y, w, h }) => [x, y, w, h]));
        assert.deepEqual(rooms[1], rooms[0]);
        assert.deepEqual(rooms[2], rooms[0]);
        // Doorways and waypoints draw from the corridors' own stream, so a dungeon that keeps as many doorways in each style locks as many doors.
        const kept = plans.map((p) => p.board.doorways.filter((d) => !d.removed).length);
        const locked = plans.map((p) => p.plan.doors.filter((d) => d.state === "locked").length);
        for (const i of [1, 2]) if (kept[i] === kept[0]) assert.equal(locked[i], locked[0], `${STYLES[i]} locks ${locked[i]} of ${kept[i]}, Straight ${locked[0]}`);
        plans.forEach((p, i) => assert.deepEqual(planProblems(p, { ...s, corridors: STYLES[i]! }), []));
      }),
      12,
    );
  });
});
