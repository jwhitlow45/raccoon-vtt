import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { RoomState } from "#shared/model.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { hexCenter, type HexGrid } from "#shared/rules/hex.ts";
import { floodHexRoom, sceneWalls } from "#shared/rules/walls.ts";
import { LEVEL_BANDS } from "#shared/srd/traps.ts";
import { builderScene } from "../scenes/create.ts";
import { NO_SPACE } from "./hexWalls.ts";
import { SCENE_PLACEHOLDER } from "./ops.ts";
import { planFitted } from "./plan.ts";
import { landAll, previewOf, scratchRoom } from "./scratch.ts";
import { newSeed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, DRESSINGS, HEIGHTS_MAX, HEIGHTS_STEP, LIT_MAX, SECRETS_MAX, TRAPS_MAX, type DungeonSettings } from "./settings.ts";

/*
 * A hex dungeon as it lands (docs/design: dungeon generator phase 3, 2.2,
 * 2.3 and 10), read from the scratch room the preview draws: every prefix
 * of its ops taken with the server's checks (the scratch room runs them as
 * it lands each), every floor hex reached from the way in once every door
 * stands open, and none of the rock, and Reveal room (`floodHexRoom`) from
 * any room with its doors shut taking that room's hexes and no hex of
 * another space, on every theme with doors.
 */

const settings: fc.Arbitrary<DungeonSettings> = fc
  .record({
    grid: fc.constantFrom("hexRows" as const, "hexColumns" as const),
    size: fc.constantFrom(30, 50, 70),
    rooms: fc.integer({ min: 2, max: 18 }),
    density: fc.constantFrom("sparse", "normal", "dense"),
    corridors: fc.constantFrom("straight", "bending", "winding"),
    wide: fc.boolean(),
    loops: fc.boolean(),
    theme: fc.constantFrom("dungeon", "crypt", "cave", "sewer", "mine"),
    heights: fc.integer({ min: 0, max: HEIGHTS_MAX / HEIGHTS_STEP }).map((n) => n * HEIGHTS_STEP),
    traps: fc.integer({ min: 0, max: TRAPS_MAX }),
    band: fc.constantFrom(...LEVEL_BANDS),
    deadEnds: fc.boolean(),
    secrets: fc.integer({ min: 0, max: SECRETS_MAX }),
    lit: fc.constantFrom(0, LIT_MAX),
    dressing: fc.constantFrom(...DRESSINGS),
  })
  .map((r) => ({ ...clampSettings({ ...DEFAULT_SETTINGS, ...r, w: r.size, h: r.size, key: true } as Partial<DungeonSettings>, r.grid), grid: r.grid }) as DungeonSettings & { grid: "hexRows" | "hexColumns" });

const seed = fc.uint8Array({ minLength: 15, maxLength: 15 }).map((bytes) => newSeed((b) => b.set(bytes)));

/** Every door standing open, a secret one too: the ops as they would stand once the party opened them all. */
function opened(room: RoomState): RoomState {
  const chunks = Object.fromEntries(
    Object.entries(room.buildChunks).map(([k, c]) => [k, c && { ...c, ...(c.walls ? { walls: c.walls.map((w) => (w.f.kind === "door" ? { ...w, f: { ...w.f, state: "open" as const, secret: false } } : w)) } : {}) }]),
  );
  return { ...room, buildChunks: chunks };
}

test("DG3: any hex plan lands whole, every floor hex reached from the way in through open doors and no rock, and each room revealed alone", () => {
  let checked = 0;
  holds(
    fc.property(settings, seed, (s, sd) => {
      const grid = (s as DungeonSettings & { grid: "hexRows" | "hexColumns" }).grid;
      const scene = builderScene({ id: "x", name: "Dungeon", w: s.w, h: s.h, gridShape: grid });
      const made = previewOf(s, sd, scene, { feetPerCell: 5, grid }, { name: "Dungeon", color: "#30a46c", feetPerCell: 5 });
      if (!made.ok) {
        assert.equal(made.error, "fit", "a plan that cannot fit is never a bug");
        return;
      }
      checked++;
      // Every prefix again, op by op, as the server takes them.
      const again = landAll(scratchRoom(), made.ops);
      assert.ok(again.ok, again.ok ? "" : again.why);
      const planned = planFitted(s, sd, { feetPerCell: 5, grid });
      const { space, lattice: L } = planned;
      const floor = new Set<string>();
      for (let k = 0; k < space.length; k++) if (space[k] !== NO_SPACE) floor.add(L.keyOf(k));
      const g = gridOfShape(grid) as HexGrid;
      const sceneNow = made.room.scenes[SCENE_PLACEHOLDER]!;
      const center = (key: string) => {
        const [col, row] = key.split(",").map(Number) as [number, number];
        return hexCenter(g, { col, row });
      };
      // The way in: a floor hex on the scene's west or east edge (north or south on columns).
      let wayIn: string | undefined;
      for (let k = 0; k < space.length && !wayIn; k++) if (space[k] !== NO_SPACE && (L.border(k, 0) || L.border(k, 3))) wayIn = L.keyOf(k);
      assert.ok(wayIn, "a way in on the edge");
      const open = opened(made.room);
      const walls = sceneWalls(sceneNow, open.buildChunks);
      const reached = floodHexRoom(walls, g, sceneNow.bounds, center(wayIn)).cells;
      for (const key of reached) assert.ok(floor.has(key), `the walk from the way in stays on floor, not ${key}`);
      for (const key of floor) assert.ok(reached.includes(key), `${key} is reached from the way in`);
      // Reveal room from each room's first hex, every door shut: exactly that room. Caves have no doors to shut.
      const shut = sceneWalls(sceneNow, made.room.buildChunks);
      for (const i of s.theme === "cave" ? [] : planned.kept) {
        const hexes = [...Array(space.length).keys()].filter((k) => space[k] === i).map((k) => L.keyOf(k));
        if (hexes.length === 0) continue;
        const room = floodHexRoom(shut, g, sceneNow.bounds, center(hexes[0]!)).cells;
        assert.deepEqual([...room].sort(), [...hexes].sort(), `Reveal room takes room ${i} alone`);
      }
    }),
    25,
  );
  assert.ok(checked >= 15, `${checked} plans landed`);
});
