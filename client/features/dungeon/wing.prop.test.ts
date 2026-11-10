import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { AutoWalls, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { FLOOR_TERRAINS } from "#shared/rules/autoWalls.ts";
import { hexAt } from "#shared/rules/hex.ts";
import { builderScene } from "../scenes/create.ts";
import { endsKey, hexSide, hexWalls, NO_SPACE } from "./hexWalls.ts";
import { hexGridOf, latticeFor } from "./lattice.ts";
import { planFitted, type WingBase } from "./plan.ts";
import { landAll, scratchRoom } from "./scratch.ts";
import { CROCKFORD, versionChar, type Seed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, type DungeonSettings } from "./settings.ts";

/*
 * Any wing (phase 3, 3.2 to 3.4): on squares it paints only open ground,
 * kept its margin from the scene but at the join, and on a "floor" scene
 * paints floor terrain alone and stays flat, so every edge of it is walled
 * or a door. On hexes its walls and the scene's bound every hex of it,
 * none doubled, and every hex of it is reached through the join.
 */

const S = "s";
const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));
const choiceArb = fc.record({
  rooms: fc.integer({ min: 2, max: 8 }),
  density: fc.constantFrom("sparse", "normal", "dense"),
  corridors: fc.constantFrom("straight", "bending", "winding"),
  wide: fc.boolean(),
  theme: fc.constantFrom("dungeon", "crypt", "cave", "mine", "sewer"),
  traps: fc.constantFrom(0, 6),
  dressing: fc.constantFrom("none", "full"),
} as const);
const ROOM = { x: 8, y: 14, w: 10, h: 10 };
const AREA = { x: 28, y: 2, w: 40, h: 46 };

function squareScene(rule: AutoWalls): RoomState {
  const cells: string[] = [];
  for (let y = ROOM.y; y < ROOM.y + ROOM.h; y++) for (let x = ROOM.x; x < ROOM.x + ROOM.w; x++) cells.push(`${x},${y}`);
  const landed = landAll(scratchRoom(), [{ t: "scene.create", scene: { ...builderScene({ id: S, name: "Old", w: 70, h: 50 }), autoWalls: rule } }, { t: "build.paint", sceneId: S, terrain: "stone", cells }]);
  if (!landed.ok) throw new Error(landed.why);
  return landed.room;
}

const SCENES = { all: squareScene("all"), floor: squareScene("floor") };

function wing(state: RoomState, join: WingBase["join"], s: DungeonSettings, seed: Seed) {
  const base = { scene: state.scenes[S]!, state, area: AREA, join };
  return planFitted(s, seed, { feetPerCell: 5 }, { wing: { ...base, hash: "prop-wing" } });
}

describe("any square wing", () => {
  test("paints only open ground at its margin from the scene, joined at the join alone, and on a \"floor\" scene paints floor alone and stays flat", () => {
    holds(
      fc.property(fc.constantFrom("all" as const, "floor" as const), choiceArb, seedArb, (rule, choices, seed) => {
        const s = clampSettings({ ...DEFAULT_SETTINGS, ...choices, heights: 75 });
        const x = ROOM.x + ROOM.w;
        const y = ROOM.y + 4;
        const edges = (s.wide ? [y, y + 1] : [y]).map((yy) => ({ key: `${x},${yy},w`, feature: null, ground: 0 }));
        const p = wing(SCENES[rule], { grid: "squares", edges }, s, seed);
        if (p.wing?.problem) {
          assert.ok(["noWay", "noRooms", "full"].includes(p.wing.problem), p.wing.problem);
          return;
        }
        const margin = s.wide ? 3 : 2;
        const outside = new Set(edges.map((e) => `${x},${Number(e.key.split(",")[1])}`));
        for (const [terrain, cells] of Object.entries(p.plan.paint)) {
          if (rule === "floor") assert.ok(FLOOR_TERRAINS.has(terrain as never), `${terrain} on a "floor" scene`);
          for (const c of cells) {
            const [cx, cy] = c.split(",").map(Number) as [number, number];
            assert.ok(!(cx >= ROOM.x && cx < ROOM.x + ROOM.w && cy >= ROOM.y && cy < ROOM.y + ROOM.h), "never over the room");
            // Off the room by its margin, but along the join's approach.
            const gap = Math.max(cx < ROOM.x ? ROOM.x - cx : cx - (ROOM.x + ROOM.w - 1), cy < ROOM.y ? ROOM.y - cy : cy >= ROOM.y + ROOM.h ? cy - (ROOM.y + ROOM.h - 1) : 0);
            const onApproach = cy >= y && cy < y + (s.wide ? 2 : 1) && cx >= x && cx <= x + 6;
            assert.ok(gap > margin || onApproach || outside.has(c), `${c} keeps its margin`);
          }
        }
        if (rule === "floor") {
          assert.ok(p.plan.rooms.every((r) => r.ground === 0), "flat rooms");
          assert.ok(p.plan.heights.every((h) => h.ft === 5 || h.ft === -10), "only daises and pits");
        }
        assert.ok(edges.every((e) => p.plan.doors.some((d) => d.edge === e.key && d.state === "closed")), "the join becomes a closed door");
      }),
      30,
    );
  });
});

describe("any hex wing", () => {
  const grid = "hexRows" as const;
  const L = latticeFor(grid, { w: 70, h: 50 });
  const room = { x: 10, y: 20, w: 9, h: 7 };
  const space = new Int32Array(L.W * L.H).fill(NO_SPACE);
  for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) space[y * L.W + x] = 0;
  const old = hexWalls({ lattice: L, space, doorways: [], far: new Set(), wayIn: [] }).walls;
  const ops: ClientOp[] = [{ t: "scene.create", scene: builderScene({ id: S, name: "Old", w: 70, h: 50, gridShape: grid }) }, { t: "build.walls", sceneId: S, put: old.map((w, i) => ({ id: `ow${String(i).padStart(10, "0")}`, a: w.a, b: w.b, f: { kind: "wall" } })) }];
  const landed = landAll(scratchRoom(), ops);
  if (!landed.ok) throw new Error(landed.why);
  const state = landed.room;
  const oldKeys = new Set(old.map((w) => endsKey(w.a, w.b)));
  const k = (room.y + 3) * L.W + room.x + room.w - 1;
  const key = endsKey(...hexSide(L, k, 0));
  const chunk = Object.values(state.buildChunks).find((c) => c?.walls?.some((w) => endsKey(w.a, w.b) === key))!;
  const joinWall = chunk.walls!.find((w) => endsKey(w.a, w.b) === key)!;

  test("its walls and the scene's bound every hex of it, none doubled, and every hex of it is reached through the join", () => {
    holds(
      fc.property(choiceArb, seedArb, (choices, seed) => {
        const s = clampSettings({ ...DEFAULT_SETTINGS, ...choices, wide: false, heights: 75 }, grid);
        const p = wing(state, { grid: "hex", walls: [{ cx: chunk.cx, cy: chunk.cy, id: joinWall.id, a: joinWall.a, b: joinWall.b, f: joinWall.f }], ground: 0 }, s, seed);
        if (p.wing?.problem) {
          assert.ok(["noWay", "noRooms", "full"].includes(p.wing.problem), p.wing.problem);
          return;
        }
        const mine = new Map(p.plan.walls!.map((w) => [endsKey(w.a, w.b), w.f]));
        for (const wkey of mine.keys()) assert.ok(wkey === key || !oldKeys.has(wkey), "no wall doubled against the room");
        assert.equal(mine.get(key), "closed", "the join's wall becomes a closed leaf");
        const blocked = (a: number, dir: number) => {
          const sk = endsKey(...hexSide(L, a, dir));
          return mine.get(sk) === "wall" || (oldKeys.has(sk) && sk !== key);
        };
        for (let c = 0; c < p.space.length; c++) {
          if (p.space[c] === NO_SPACE) continue;
          for (let dir = 0; dir < 6; dir++) {
            const n = L.step(c, dir, 1);
            if (n !== null && p.space[n] !== NO_SPACE) continue;
            assert.ok(blocked(c, dir) || mine.has(endsKey(...hexSide(L, c, dir))), "every side of the wing toward anything else is walled or a door");
          }
        }
        const start = L.step(k, 0, 1)!;
        const seen = new Set([start]);
        const queue = [start];
        while (queue.length > 0) {
          const a = queue.pop()!;
          for (let dir = 0; dir < 6; dir++) {
            const n = L.step(a, dir, 1);
            if (n === null || seen.has(n) || p.space[n] === NO_SPACE || blocked(a, dir)) continue;
            seen.add(n);
            queue.push(n);
          }
        }
        for (let c = 0; c < p.space.length; c++) if (p.space[c] !== NO_SPACE) assert.ok(seen.has(c), "reached through the join");
      }),
      20,
    );
  });
});

/*
 * Any wing keeps to the area the DM dragged (LP37-A-WING-2): with the area
 * holding the join's approach, as it does when dragged out from the wall,
 * no room, corridor, stub or trap of the wing lies outside it. The room is
 * small and the area wider than it, so a stub let loose across the open
 * ground could run round the room, as one did on hexes. That took about
 * one plan in a hundred here, so the plans that did it stand as cases of
 * their own beside the property.
 */
describe("any wing whose area holds its approach", () => {
  const ring = { x: 30, y: 30, w: 5, h: 5 };
  const lattice = { x: 23, y: 10, w: 19, h: 20 };
  type Choices = Partial<DungeonSettings>;
  const inRect = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  /** Every trap's zone cells as scene keys, and for a wire the key of its middle, since its ends lie on the walls it spans. */
  const zoneCells = (p: ReturnType<typeof planFitted>, keyAt: (x: number, y: number) => readonly [number, number]): (readonly [number, number])[] =>
    p.plan.traps.flatMap((t) => {
      const z = t.zone;
      if ("wire" in z) return [keyAt((z.wire.a[0] + z.wire.b[0]) / 2, (z.wire.a[1] + z.wire.b[1]) / 2)];
      return ("cells" in z ? z.cells : []).flatMap((r) => Array.from({ length: r.w * r.h }, (_, i) => [r.x + (i % r.w), r.y + Math.floor(i / r.w)] as const));
    });
  const planned = (p: ReturnType<typeof planFitted>): boolean => {
    if (!p.wing?.problem) return true;
    assert.ok(["noWay", "noRooms", "full"].includes(p.wing.problem), p.wing.problem);
    return false;
  };

  /** A squares wing joined on the room's north wall `along` squares in, checked. */
  const squares = (() => {
    const cells: string[] = [];
    for (let y = ring.y; y < ring.y + ring.h; y++) for (let x = ring.x; x < ring.x + ring.w; x++) cells.push(`${x},${y}`);
    const landed = landAll(scratchRoom(), [{ t: "scene.create", scene: builderScene({ id: S, name: "Ring", w: 60, h: 60 }) }, { t: "build.paint", sceneId: S, terrain: "stone", cells }]);
    if (!landed.ok) throw new Error(landed.why);
    const state = landed.room;
    return (choices: Choices, seed: Seed, along: number): boolean => {
      const s = clampSettings({ ...DEFAULT_SETTINGS, ...choices, heights: 75 });
      const x = ring.x + along;
      const edges = (s.wide ? [x, x + 1] : [x]).map((xx) => ({ key: `${xx},${ring.y},n`, feature: null, ground: 0 }));
      const p = planFitted(s, seed, { feetPerCell: 5 }, { wing: { scene: state.scenes[S]!, state, area: lattice, join: { grid: "squares", edges }, hash: "prop-wing" } });
      if (!planned(p)) return false;
      for (const c of Object.values(p.plan.paint).flat()) {
        const [cx, cy] = c!.split(",").map(Number) as [number, number];
        assert.ok(inRect(lattice, cx, cy), `${c} painted outside the area`);
      }
      for (const [cx, cy] of zoneCells(p, (wx, wy) => [Math.floor(wx), Math.floor(wy)])) assert.ok(inRect(lattice, cx, cy), `a trap at ${cx},${cy} outside the area`);
      return true;
    };
  })();

  /** A hex wing joined on side `dir` of the room's top row hex `along` in, checked. */
  const hexes = (grid: "hexRows" | "hexColumns") => {
    const L = latticeFor(grid, { w: 60, h: 60 });
    const g = hexGridOf(grid);
    const space = new Int32Array(L.W * L.H).fill(NO_SPACE);
    for (let y = ring.y; y < ring.y + ring.h; y++) for (let x = ring.x; x < ring.x + ring.w; x++) space[y * L.W + x] = 0;
    const old = hexWalls({ lattice: L, space, doorways: [], far: new Set(), wayIn: [] }).walls;
    const landed = landAll(scratchRoom(), [
      { t: "scene.create", scene: builderScene({ id: S, name: "Ring", w: 60, h: 60, gridShape: grid }) },
      { t: "build.walls", sceneId: S, put: old.map((w, i) => ({ id: `ow${String(i).padStart(10, "0")}`, a: w.a, b: w.b, f: { kind: "wall" } })) },
    ]);
    if (!landed.ok) throw new Error(landed.why);
    const state = landed.room;
    const area = grid === "hexColumns" ? { x: lattice.y, y: lattice.x, w: lattice.h, h: lattice.w } : lattice;
    return (choices: Choices, seed: Seed, along: number, dir: number): boolean => {
      const s = clampSettings({ ...DEFAULT_SETTINGS, ...choices, wide: false, heights: 75 }, grid);
      const key = endsKey(...hexSide(L, ring.y * L.W + ring.x + along, dir));
      const chunk = Object.values(state.buildChunks).find((c) => c?.walls?.some((w) => endsKey(w.a, w.b) === key))!;
      const wall = chunk.walls!.find((w) => endsKey(w.a, w.b) === key)!;
      const p = planFitted(s, seed, { feetPerCell: 5 }, { wing: { scene: state.scenes[S]!, state, area, join: { grid: "hex", walls: [{ cx: chunk.cx, cy: chunk.cy, id: wall.id, a: wall.a, b: wall.b, f: wall.f }], ground: 0 }, hash: "prop-wing" } });
      if (!planned(p)) return false;
      for (let c = 0; c < p.space.length; c++) {
        if (p.space[c] === NO_SPACE) continue;
        assert.ok(inRect(lattice, c % L.W, Math.floor(c / L.W)), `lattice hex ${c % L.W},${Math.floor(c / L.W)} outside the area`);
      }
      for (const [cx, cy] of zoneCells(p, (wx, wy) => ((h) => [h.col, h.row] as const)(hexAt(g, { x: wx, y: wy })))) assert.ok(inRect(area, cx, cy), `a trap at ${cx},${cy} outside the area`);
      return true;
    };
  };

  test("on squares, every cell it paints and every trap lies in the area", () => {
    // A plan whose stub ran round the room's west side when it could cross all the open ground, and plans inside the area now.
    assert.ok(squares({ rooms: 3, density: "dense", corridors: "straight", traps: 0, dressing: "none" }, "90AAMREYKGPSESDG", 3));
    holds(
      fc.property(choiceArb, seedArb, fc.integer({ min: 0, max: ring.w - 2 }), (choices, seed, along) => void squares(choices, seed, along)),
      25,
    );
  });

  for (const grid of ["hexRows", "hexColumns"] as const) {
    test(`on ${grid}, every hex of it and every trap lies in the area`, () => {
      const check = hexes(grid);
      // A plan whose stub ran round the room when it could cross all the open ground, as on Hex ring in live play, and plans inside the area now.
      assert.ok(check({ rooms: 2, density: "dense", corridors: "straight", traps: 0, dressing: "none" }, "9H9XQHBW9JPEDMSF", 2, 4));
      holds(
        fc.property(choiceArb, seedArb, fc.integer({ min: 0, max: ring.w - 1 }), fc.constantFrom(4, 5), (choices, seed, along, dir) => void check(choices, seed, along, dir)),
        25,
      );
    });
  }
});
