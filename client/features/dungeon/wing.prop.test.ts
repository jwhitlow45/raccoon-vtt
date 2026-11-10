import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { AutoWalls, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { FLOOR_TERRAINS } from "#shared/rules/autoWalls.ts";
import { builderScene } from "../scenes/create.ts";
import { endsKey, hexSide, hexWalls, NO_SPACE } from "./hexWalls.ts";
import { latticeFor } from "./lattice.ts";
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
