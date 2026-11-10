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
import { clampSettings, DEFAULT_SETTINGS, type DungeonSettings, type GridKind } from "./settings.ts";
import { wingSetup } from "./wing.ts";

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
 * Any wing keeps to the area the DM dragged (LP37-A-WING-2), its stub to
 * the box spanning the area and the join's approach. The room is small
 * and the area wider than it, so a stub let loose across the open ground
 * could run round the room, as one did on hexes. That took about one plan
 * in a hundred, so the plans that did it stand as cases of their own
 * beside the properties.
 */
const RING = { x: 30, y: 30, w: 5, h: 5 };
type Rect = { x: number; y: number; w: number; h: number };
type Choices = Partial<DungeonSettings>;
const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** A 60 by 60 scene holding the ring and any `more` rooms, in lattice keys: painted on squares, walled all round on hexes. */
function ringScene(grid: GridKind, more: readonly Rect[] = []): RoomState {
  const rooms = [RING, ...more];
  if (grid === "squares") {
    const cells = rooms.flatMap((r) => Array.from({ length: r.w * r.h }, (_, i) => `${r.x + (i % r.w)},${r.y + Math.floor(i / r.w)}`));
    const landed = landAll(scratchRoom(), [{ t: "scene.create", scene: builderScene({ id: S, name: "Ring", w: 60, h: 60 }) }, { t: "build.paint", sceneId: S, terrain: "stone", cells }]);
    if (!landed.ok) throw new Error(landed.why);
    return landed.room;
  }
  const L = latticeFor(grid, { w: 60, h: 60 });
  const space = new Int32Array(L.W * L.H).fill(NO_SPACE);
  rooms.forEach((r, n) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) space[y * L.W + x] = n;
  });
  const old = hexWalls({ lattice: L, space, doorways: [], far: new Set(), wayIn: [] }).walls;
  const landed = landAll(scratchRoom(), [
    { t: "scene.create", scene: builderScene({ id: S, name: "Ring", w: 60, h: 60, gridShape: grid }) },
    { t: "build.walls", sceneId: S, put: old.map((w, i) => ({ id: `ow${String(i).padStart(10, "0")}`, a: w.a, b: w.b, f: { kind: "wall" } })) },
  ]);
  if (!landed.ok) throw new Error(landed.why);
  return landed.room;
}

/**
 * A wing on the ring's north wall, `along` keys in (on hexes its side
 * `dir`), with its area given in lattice keys: the plan, and what it takes
 * on the lattice, its painted squares or its hexes and its traps' keys
 * (a wire by its middle, since its ends lie on the walls it spans), with
 * the join's approach. Null where the planner says why it cannot.
 */
function ringWing(state: RoomState, grid: GridKind, lattice: Rect, choices: Choices, seed: Seed, along: number, dir: number) {
  const L = latticeFor(grid, { w: 60, h: 60 });
  const columns = grid === "hexColumns";
  const s = grid === "squares" ? clampSettings({ ...DEFAULT_SETTINGS, ...choices, heights: 75 }) : clampSettings({ ...DEFAULT_SETTINGS, ...choices, wide: false, heights: 75 }, grid);
  let join: WingBase["join"];
  if (grid === "squares") {
    const x = RING.x + along;
    join = { grid: "squares", edges: (s.wide ? [x, x + 1] : [x]).map((xx) => ({ key: `${xx},${RING.y},n`, feature: null, ground: 0 })) };
  } else {
    const key = endsKey(...hexSide(L, RING.y * L.W + RING.x + along, dir));
    const chunk = Object.values(state.buildChunks).find((c) => c?.walls?.some((w) => endsKey(w.a, w.b) === key))!;
    const wall = chunk.walls!.find((w) => endsKey(w.a, w.b) === key)!;
    join = { grid: "hex", walls: [{ cx: chunk.cx, cy: chunk.cy, id: wall.id, a: wall.a, b: wall.b, f: wall.f }], ground: 0 };
  }
  const area = columns ? { x: lattice.y, y: lattice.x, w: lattice.h, h: lattice.w } : lattice;
  const base = { scene: state.scenes[S]!, state, area, join, hash: "prop-wing" };
  const p = planFitted(s, seed, { feetPerCell: 5 }, { wing: base });
  if (p.wing?.problem) {
    assert.ok(["noWay", "noRooms", "full"].includes(p.wing.problem), p.wing.problem);
    return null;
  }
  // Scene keys to lattice keys: mirrored on Hex columns.
  const lat = ([a, b]: readonly [number, number]): [number, number] => (columns ? [b, a] : [a, b]);
  const keyAt = (wx: number, wy: number): [number, number] => (grid === "squares" ? [Math.floor(wx), Math.floor(wy)] : ((h) => [h.col, h.row] as [number, number])(hexAt(hexGridOf(grid), { x: wx, y: wy })));
  const cells: [number, number][] = [];
  if (grid === "squares") for (const c of Object.values(p.plan.paint).flat()) cells.push(c!.split(",").map(Number) as [number, number]);
  else for (let c = 0; c < p.space.length; c++) if (p.space[c] !== NO_SPACE) cells.push([c % L.W, Math.floor(c / L.W)]);
  const traps = p.plan.traps.flatMap((tr) => {
    const z = tr.zone;
    if ("wire" in z) return [lat(keyAt((z.wire.a[0] + z.wire.b[0]) / 2, (z.wire.a[1] + z.wire.b[1]) / 2))];
    return ("cells" in z ? z.cells : []).flatMap((r) => Array.from({ length: r.w * r.h }, (_, i) => lat([r.x + (i % r.w), r.y + Math.floor(i / r.w)])));
  });
  const approach = wingSetup(base, s).approach.map((k): [number, number] => [k % L.W, Math.floor(k / L.W)]);
  return { p, cells, traps, approach };
}

/** The least rectangle holding a rectangle and some keys. */
function spanOf(r: Rect, keys: readonly (readonly [number, number])[]): Rect {
  const xs = [r.x, r.x + r.w - 1, ...keys.map((k) => k[0])];
  const ys = [r.y, r.y + r.h - 1, ...keys.map((k) => k[1])];
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
}

/** Asserts that every key the wing takes lies in `box`, saying which. */
function within(w: NonNullable<ReturnType<typeof ringWing>>, box: Rect, what: string): void {
  for (const [x, y] of w.cells) assert.ok(inRect(box, x, y), `${x},${y} of the wing outside ${what}`);
  for (const [x, y] of w.traps) assert.ok(inRect(box, x, y), `a trap at ${x},${y} outside ${what}`);
}

const GRIDS = ["squares", "hexRows", "hexColumns"] as const;
/** A seed whose four rooms plan on every grid with the area six rows short of the wall. */
const CROSSING_SEED = "9VSX5YVMP51P2NN0";
/** The ring's top side toward the area above it: on squares an edge `along` in, Wide taking the next, on hexes side 4 or 5 of a top row hex. */
const alongArb = (grid: GridKind) => fc.integer({ min: 0, max: RING.w - (grid === "squares" ? 2 : 1) });
const dirArb = fc.constantFrom(4, 5);

describe("any wing whose area holds its approach", () => {
  const lattice = { x: 23, y: 10, w: 19, h: 20 };
  const scenes = Object.fromEntries(GRIDS.map((g) => [g, ringScene(g)])) as Record<GridKind, RoomState>;
  // Plans whose stub ran round the room when it could cross all the open ground, as on Hex ring in live play, and plan inside the area now.
  const roundTheRoom = {
    squares: [{ rooms: 3, density: "dense", corridors: "straight", traps: 0, dressing: "none" }, "90AAMREYKGPSESDG", 3, 4],
    hexRows: [{ rooms: 2, density: "dense", corridors: "straight", traps: 0, dressing: "none" }, "9H9XQHBW9JPEDMSF", 2, 4],
    hexColumns: [{ rooms: 2, density: "dense", corridors: "straight", traps: 0, dressing: "none" }, "9H9XQHBW9JPEDMSF", 2, 4],
  } as const;

  for (const grid of GRIDS) {
    test(`on ${grid}, every square or hex of it and every trap lies in the area`, () => {
      const [choices, seed, along, dir] = roundTheRoom[grid];
      const fixed = ringWing(scenes[grid], grid, lattice, choices, seed, along, dir);
      assert.ok(fixed, "the plan that ran round the room plans");
      within(fixed, lattice, "the area");
      holds(
        fc.property(choiceArb, seedArb, alongArb(grid), dirArb, (c, seed, along, dir) => {
          const w = ringWing(scenes[grid], grid, lattice, c, seed, along, dir);
          if (w) within(w, lattice, "the area");
        }),
        25,
      );
    });
  }
});

/*
 * An area dragged short of the wall (LP37F-SONNET-1): the stub crosses the
 * ground between, and no more, so the whole wing lies in the box spanning
 * the area and the approach. Where another room's floor lies right across
 * that ground, the wing says No way rather than go round it outside the box.
 */
describe("any wing whose area stops short of the wall", () => {
  /** The area above the ring, ending `gap` rows short of its north wall. */
  const short = (gap: number): Rect => ({ x: 23, y: 10, w: 19, h: 20 - gap });
  const scenes = Object.fromEntries(GRIDS.map((g) => [g, ringScene(g)])) as Record<GridKind, RoomState>;

  for (const grid of GRIDS) {
    test(`on ${grid}, every square or hex of it and every trap lies between the area and the approach`, () => {
      holds(
        fc.property(choiceArb, seedArb, alongArb(grid), dirArb, fc.integer({ min: 2, max: 6 }), (c, seed, along, dir, gap) => {
          const area = short(gap);
          const w = ringWing(scenes[grid], grid, area, c, seed, along, dir);
          if (w) within(w, spanOf(area, w.approach), "the box of the area and the approach");
        }),
        25,
      );
    });
  }

  test("a stub crosses the rows between the area and the approach, and only those", () => {
    // Six rows short, past the approach's three, so the stub alone fills the rows between.
    const area = short(6);
    for (const grid of GRIDS) {
      const w = ringWing(scenes[grid], grid, area, { rooms: 4, density: "normal", corridors: "straight", traps: 0, dressing: "none" }, CROSSING_SEED, 2, 4);
      assert.ok(w, `${grid}: the wing plans`);
      within(w, spanOf(area, w.approach), "the box of the area and the approach");
      const taken = new Set(w.approach.map(([x, y]) => `${x},${y}`));
      assert.ok(
        w.cells.some(([x, y]) => y >= area.y + area.h && !taken.has(`${x},${y}`)),
        `${grid}: the stub crosses the rows between`,
      );
    }
  });

  test("with another room's floor right across the rows between, the wing says No way rather than go round it", () => {
    // A bar of floor right under the area, wider than the box, as a room the DM drew there, and far enough from the wall that the approach keeps its margin. Out past its ends the open ground would still reach the wall.
    const area = short(7);
    const bar = { x: 18, y: 23, w: 29, h: 1 };
    for (const grid of GRIDS) {
      const state = ringScene(grid, [bar]);
      const w = ringWing(state, grid, area, { rooms: 4, density: "normal", corridors: "straight", traps: 0, dressing: "none" }, CROSSING_SEED, 2, 4);
      if (w) within(w, spanOf(area, w.approach), "the box of the area and the approach");
      assert.equal(w, null, `${grid}: No way`);
    }
  });
});
