import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiagonalRule, EdgeFeature, TerrainId } from "../model.ts";
import type { BuildState } from "../ruleHooks.ts";
import { legStop, type MovingToken } from "./movement.ts";
import { routeFeet, type RoutePoint } from "./route.ts";
import { CLOSED_DOOR, line, OPEN_DOOR, SECRET_DOOR, tok, world, type WorldSpec } from "./testWorld.ts";
import { findRoute, openLeg, WalkSearch, WalkWorld, type WalkCreature, type WalkInput, type WalkRoute } from "./walk.ts";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function input(build: BuildState, token: MovingToken, over: Partial<WalkInput> = {}): WalkInput {
  return { build, token, rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 }, ...over };
}

function routeOf(i: WalkInput, to: { x: number; y: number }): WalkRoute {
  const r = findRoute(i, to);
  assert.ok(r !== null && r !== "none", `a route to ${to.x}, ${to.y}`);
  return r;
}

/** Every piece passes the leg test the server runs, from the token at the piece's start with its elevation (6.1). */
function assertPiecesPass(i: WalkInput, r: WalkRoute): void {
  for (let k = 1; k < r.points.length; k++) {
    const a = r.points[k - 1]!;
    const b = r.points[k]!;
    const at = { ...i.token, x: a.x, y: a.y, elevation: a.elevation, squeeze: undefined };
    assert.equal(legStop(i.build, at, b), null, `piece ${k} from ${a.x},${a.y} to ${b.x},${b.y}`);
  }
}

/** The feet the search paid, unrounded, read back from the route's pieces by the reducer's own arithmetic. */
function pieceFeet(i: WalkInput, r: WalkRoute): number {
  return routeFeet(r.points, r.pieces.map(([, , extra, swim]) => ({ extra, swim })), i.rules, i.counter, { swimSpeed: false, step: 1 / (2 * i.rules.feetPerCell) }).cost;
}

function searched(i: WalkInput, to: { x: number; y: number }): { search: WalkSearch; cost: number } {
  const search = new WalkSearch(new WalkWorld(i));
  assert.equal(search.settle(to), "settled");
  return { search, cost: search.costTo(to)! };
}

describe("walking around walls (docs/design-v1-movement.md 4.4, 5)", () => {
  test("open ground needs no search", () => {
    const w = world({});
    assert.equal(findRoute(input(w, tok(w, { x: 2, y: 2 })), { x: 9, y: 5 }), null);
  });

  test("around a wall's corner, never a diagonal past its end", () => {
    const w = world({ w: 12, h: 12, edges: line("w", 5, 0, 6) });
    const i = input(w, tok(w, { x: 2, y: 2 }));
    const r = routeOf(i, { x: 7, y: 2 });
    assertPiecesPass(i, r);
    // Down to row 6, across under the wall's end, and back up: 4 + 1 + 4 squares.
    assert.equal(pieceFeet(i, r), 45);
    assert.ok(r.points.some((p) => p.y >= 6));
  });

  test("through an open door, and not a closed one or a secret door nobody found", () => {
    const wall = (door: EdgeFeature) => world({ edges: { ...line("w", 5, 0, 30), "5,4,w": door } });
    const open = wall(OPEN_DOOR);
    const i = input(open, tok(open, { x: 2, y: 1 }));
    const r = routeOf(i, { x: 7, y: 1 });
    assertPiecesPass(i, r);
    assert.ok(r.points.some((p) => p.y === 4));
    for (const shut of [CLOSED_DOOR, SECRET_DOOR]) {
      const w = wall(shut);
      assert.equal(findRoute(input(w, tok(w, { x: 2, y: 1 })), { x: 7, y: 1 }), "none");
    }
  });

  test("up a stair and never over a ledge", () => {
    // A 10 ft platform over x 10 to 19 and y 0 to 4, a stair one cell wide at (12, 5) pointing up north.
    const heights = Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`${10 + (k % 10)},${Math.floor(k / 10)}`, 10]));
    const w = world({ heights, marks: { "12,5": "a" } });
    const i = input(w, tok(w, { x: 5, y: 8 }));
    const r = routeOf(i, { x: 15, y: 2 });
    assertPiecesPass(i, r);
    // The step up the stair from (12, 5) to (12, 4) is in the walk.
    const up = r.points.findIndex((p, k) => k > 0 && p.elevation === 10);
    assert.ok(up > 0 && r.points[up - 1]!.elevation === 0);
    const flat = world({ heights });
    assert.equal(findRoute(input(flat, tok(flat, { x: 5, y: 8 })), { x: 15, y: 2 }), "none");
  });

  test("a squeezed creature's terrain, pits and creatures are read on its squeezed footprint", () => {
    // A 5 ft corridor between walls along x = 1 and x = 2, and a Large creature squeezed in it, its full footprint reaching over both walls.
    const edges = { ...line("w", 1, 0, 10), ...line("w", 2, 0, 10) };
    const walk = (cells: Record<string, TerrainId>, over: Partial<WalkInput> = {}) => {
      const w = world({ w: 4, h: 10, edges, cells });
      const i = input(w, tok(w, { size: "large", x: 0.5, y: 0.5, squeeze: true }), over);
      const r = findRoute(i, { x: 0.5, y: 4.5 });
      return r === null || r === "none" ? r : pieceFeet(i, r);
    };
    // 4 squares down the corridor, each paying double for the squeeze.
    assert.equal(walk({}), 40);
    // Beside the corridor at (0, 3), under the full footprint but not the squeezed one.
    assert.equal(walk({}, { areas: [{ extra: 3, cells: [{ x: 0, y: 3 }] }] }), 40, "Plant Growth beside the corridor");
    assert.equal(walk({ "0,3": "rubble" }), 40, "rubble beside the corridor");
    assert.equal(walk({ "0,3": "pit" }), 40, "a pit beside the corridor");
    const beside: WalkCreature = { x0: 0, y0: 3, x1: 1, y1: 4, lo: 0, hi: 5, way: "blocked" };
    assert.equal(walk({}, { creatures: [beside] }), 40, "a creature beside the corridor");
    // In the corridor they still count.
    assert.equal(walk({ "1,3": "pit" }), "none");
    assert.equal(walk({ "1,3": "rubble" }), 40, "rubble inside costs what the squeeze already does: difficult terrain does not stack");
  });

  test("a straight leg over a rise and down again is searched, and an even stair is not", () => {
    const stairs = (feet: number[]) => world({ w: feet.length, h: 1, heights: Object.fromEntries(feet.map((f, x) => [`${x},0`, f])), marks: Object.fromEntries(feet.map((_, x) => [`${x},0`, "a" as const])) });
    // Up 10 ft and down again: two steps of 2 squares each, the second vertical diagonal doubled under 5-10-5, and 5 by 10 ft twice under true distance, rounded to the foot.
    const over = { five: 20, fiveTen: 25, euclid: 22 };
    for (const diagonal of ["five", "fiveTen", "euclid"] as const) {
      const hump = stairs([0, 10, 0]);
      const i = input(hump, tok(hump, { x: 0, y: 0 }), { rules: { feetPerCell: 5, diagonal } });
      assert.equal(openLeg(new WalkWorld(i), { x: 2, y: 0 }), false, diagonal);
      assert.equal(pieceFeet(i, routeOf(i, { x: 2, y: 0 })), over[diagonal], diagonal);
      const step = stairs([0, 0, 10]);
      assert.equal(openLeg(new WalkWorld(input(step, tok(step, { x: 0, y: 0 }), { rules: { feetPerCell: 5, diagonal } })), { x: 2, y: 0 }), false, `a step partway, ${diagonal}`);
      const even = stairs([0, 5, 10]);
      assert.equal(findRoute(input(even, tok(even, { x: 0, y: 0 }), { rules: { feetPerCell: 5, diagonal } }), { x: 2, y: 0 }), null, `an even stair, ${diagonal}`);
    }
    // An even stair taken on the diagonal: under 5-10-5 each climbing diagonal is a piece of its own.
    const heights: Record<string, number> = {};
    const marks: Record<string, "a"> = {};
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) [heights[`${x},${y}`], marks[`${x},${y}`]] = [5 * Math.min(x, y), "a"];
    const diagonalStair = world({ w: 3, h: 3, heights, marks });
    const along = (diagonal: "five" | "fiveTen") => openLeg(new WalkWorld(input(diagonalStair, tok(diagonalStair, { x: 0, y: 0 }), { rules: { feetPerCell: 5, diagonal } })), { x: 2, y: 2 });
    assert.deepEqual([along("five"), along("fiveTen")], [true, false]);
    // Off the eight directions only level ground keeps the straight leg.
    const ramp: Record<string, number> = {};
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) [ramp[`${x},${y}`], marks[`${x},${y}`]] = [5 * x, "a"];
    const slope = world({ w: 4, h: 2, heights: ramp, marks });
    assert.equal(openLeg(new WalkWorld(input(slope, tok(slope, { x: 0, y: 0 }))), { x: 3, y: 1 }), false);
  });

  test("a Large creature through a 5 ft door and corridor, a Huge one through 10 ft and not 5", () => {
    // A wall along x = 10 with an opening of `width` squares at y 5.
    const wall = (width: number) => world({ edges: { ...line("w", 10, 0, 5), ...line("w", 10, 5 + width, 30) } });
    const five = wall(1);
    const ogre = input(five, tok(five, { size: "large", x: 5, y: 1 }));
    const r = routeOf(ogre, { x: 14, y: 1 });
    assertPiecesPass(ogre, r);
    // It squeezes through: the opening's squares cost double.
    assert.ok(r.pieces.some((p) => p[2] === 1));
    const giant = (width: number) => {
      const w = wall(width);
      return findRoute(input(w, tok(w, { size: "huge", x: 4, y: 1 })), { x: 14, y: 1 });
    };
    assert.equal(giant(1), "none");
    assert.notEqual(giant(2), "none");
    // A 5 ft corridor between two walls, 6 squares long: a Large creature pays double the whole way.
    const corridor = world({ edges: { ...line("n", 5, 3, 9), ...line("n", 6, 3, 9) } });
    const c = input(corridor, tok(corridor, { size: "large", x: 1, y: 4.5 }));
    const through = routeOf(c, { x: 9, y: 4.5 });
    assertPiecesPass(c, through);
  });

  test("around a pit for a walker, though a drop into one lands there", () => {
    const cells: Record<string, TerrainId> = {};
    for (let y = 0; y < 30; y++) if (y !== 12) cells[`6,${y}`] = "pit";
    const w = world({ cells });
    const i = input(w, tok(w, { x: 2, y: 5 }));
    const r = routeOf(i, { x: 10, y: 5 });
    assert.ok(r.points.some((p) => p.y === 12));
    // Straight into the pit is open ground: the drop lands there.
    assert.equal(findRoute(i, { x: 6, y: 5 }), null);
    // Around a wall into the pit, the walk ends there.
    const walled = world({ cells, edges: line("w", 5, 0, 12) });
    const into = routeOf(input(walled, tok(walled, { x: 2, y: 5 })), { x: 6, y: 5 });
    assert.ok(into.endsBlocked);
  });

  test("around a hostile Medium creature, through an ally, a Tiny or an Unconscious one", () => {
    const w = world({ edges: { ...line("n", 4, 0, 5), ...line("n", 4, 6, 30), ...line("n", 5, 0, 5), ...line("n", 5, 6, 30) } });
    // A gap one square wide at x = 5 between y 4 and 5, with a creature standing in it.
    const at = (way: WalkCreature["way"]): WalkCreature[] => [{ x0: 5, y0: 4, x1: 6, y1: 5, lo: 0, hi: 5, way }];
    const t = tok(w, { x: 5, y: 1 });
    assert.equal(findRoute(input(w, t, { creatures: at("blocked") }), { x: 5, y: 8 }), "none");
    for (const way of ["free", "difficult"] as const) {
      const i = input(w, t, { creatures: at(way) });
      const r = findRoute(i, { x: 5, y: 8 });
      if (way === "free") assert.equal(r, null);
      else {
        assert.ok(r && r !== "none");
        assert.equal(pieceFeet(i, r), 40);
      }
    }
    // Out in the open, the walk goes around a hostile creature rather than through it.
    const open = world({});
    const i = input(open, tok(open, { x: 2, y: 5 }), { creatures: [{ x0: 5, y0: 5, x1: 6, y1: 6, lo: 0, hi: 5, way: "blocked" }] });
    const r = routeOf(i, { x: 8, y: 5 });
    assert.ok(r.points.every((p) => !(p.x === 5 && p.y === 5)));
    assert.equal(pieceFeet(i, r), 30);
  });

  test("squeezing is charged between two walls and not beside one", () => {
    const one = world({ edges: line("n", 6, 0, 30) });
    // A Large creature walking along one wall pays nothing.
    const beside = input(one, tok(one, { size: "large", x: 1, y: 6 }));
    assert.equal(findRoute(beside, { x: 9, y: 6 }), null);
    const two = world({ edges: { ...line("n", 5, 3, 9), ...line("n", 6, 3, 9) } });
    const along = input(two, tok(two, { size: "large", x: 3.5, y: 4.5 }));
    const r = findRoute(along, { x: 7.5, y: 4.5 });
    assert.ok(r && r !== "none");
    assert.equal(pieceFeet(along, r), 40);
  });

  test("a closed door that closes changes the next search: the step answers follow the wall set", () => {
    const shut = world({ edges: { ...line("w", 5, 0, 30), "5,4,w": CLOSED_DOOR } });
    const open = { ...shut, buildChunks: Object.fromEntries(Object.entries(shut.buildChunks).map(([k, c]) => [k, { ...c, rev: 2, edges: { ...c.edges, ...(c.edges["5,4,w"] ? { "5,4,w": OPEN_DOOR } : {}) } }])) };
    assert.equal(findRoute(input(shut, tok(shut, { x: 2, y: 1 })), { x: 7, y: 1 }), "none");
    assert.notEqual(findRoute(input(open, tok(open, { x: 2, y: 1 })), { x: 7, y: 1 }), "none");
    assert.equal(findRoute(input(shut, tok(shut, { x: 2, y: 1 })), { x: 7, y: 1 }), "none");
  });
});

describe("costs along a route (4.1, 4.7, 4.8)", () => {
  test("the cheapest way around a patch of rubble, and through it when that is cheaper", () => {
    const cells: Record<string, TerrainId> = {};
    for (let y = 3; y < 6; y++) for (let x = 4; x < 7; x++) cells[`${x},${y}`] = "rubble";
    const w = world({ cells });
    const i = input(w, tok(w, { x: 1, y: 4 }));
    const r = routeOf(i, { x: 9, y: 4 });
    // Around costs 8 squares plus nothing, through 8 plus 3: around wins.
    assert.equal(pieceFeet(i, r), 40);
    const wide: Record<string, TerrainId> = {};
    for (let y = 0; y < 30; y++) wide[`5,${y}`] = "rubble";
    const ww = world({ cells: wide });
    const through = input(ww, tok(ww, { x: 2, y: 4 }));
    assert.equal(openLeg(new WalkWorld(through), { x: 8, y: 4 }), false);
    assert.equal(pieceFeet(through, routeOf(through, { x: 8, y: 4 })), 35);
  });

  test("water costs the swimming foot, marks and difficult areas cost one, Plant Growth three, the larger only", () => {
    const w = world({ w: 12, h: 3, cells: { "3,1": "water", "5,1": "difficult" }, rough: ["7,1"] });
    const i = input(w, tok(w, { x: 1, y: 1 }), { areas: [{ extra: 3, cells: [{ x: 5, y: 1 }] }, { extra: 1, cells: [{ x: 9, y: 1 }] }], creatures: [] });
    // Walls all round keep the walk on its row.
    const walled = world({ w: 12, h: 3, cells: { "3,1": "water", "5,1": "difficult" }, rough: ["7,1"], edges: { ...line("n", 1, 0, 12), ...line("n", 2, 0, 12) } });
    const j = { ...i, build: walled, token: tok(walled, { x: 1, y: 1 }) };
    const r = routeOf(j, { x: 10, y: 1 });
    const extras = r.pieces.map((p) => [p[0], p[2], p[3]]);
    assert.deepEqual(extras, [
      [2, 0, 0],
      [3, 1, 1],
      [4, 0, 0],
      [5, 3, 0],
      [6, 0, 0],
      [7, 1, 0],
      [8, 0, 0],
      [9, 1, 0],
      [10, 0, 0],
    ]);
    assert.equal(pieceFeet(j, r), 9 * 5 + 5 + 15 + 5 + 5);
    void i;
  });

  test("crawling costs one more on every step, and a flier pays no ground", () => {
    const cells: Record<string, TerrainId> = {};
    for (let x = 3; x < 6; x++) for (let y = 0; y < 30; y++) cells[`${x},${y}`] = "difficult";
    const w = world({ cells });
    const prone = input(w, tok(w, { x: 1, y: 1 }), { prone: true });
    const r = routeOf(prone, { x: 7, y: 1 });
    assert.equal(pieceFeet(prone, r), 6 * 10 + 3 * 5);
    const flier = input(w, tok(w, { x: 1, y: 1, elevation: 20 }));
    assert.equal(findRoute(flier, { x: 7, y: 1 }), null);
  });

  test("5-10-5 runs on from the counters it starts from, through difficult diagonals", () => {
    const w = world({ cells: { "2,2": "rubble" } });
    for (const h of [0, 1]) {
      const i = input(w, tok(w, { x: 1, y: 1 }), { rules: { feetPerCell: 5, diagonal: "fiveTen" }, counter: { h, v: 0 } });
      // A diagonal into rubble: 10 ft. With one diagonal carried in it would cost 20, so two straight steps, 5 + 10, win.
      assert.equal(searched(i, { x: 2, y: 2 }).cost / 2, h === 0 ? 10 : 15);
    }
  });

  test("5-10-5 on the half lattice is exact from all four horizontal residues", () => {
    const w = world({ w: 8, h: 8, cells: { "3,2": "rubble", "2,4": "difficult" } });
    for (const h of [0, 0.5, 1, 1.5]) {
      for (let k = 1; k <= 8; k++) {
        const i = input(w, tok(w, { size: "tiny", x: 1, y: 1 }), { rules: { feetPerCell: 5, diagonal: "fiveTen" }, counter: { h, v: 0 } });
        const to = { x: 1 + k / 2, y: 1 + ((k % 3) + Math.floor(k / 2)) / 2 };
        assert.equal(searched(i, to).cost, bruteCost(i, to), `from ${h}, to ${to.x}, ${to.y}`);
      }
    }
  });

  test("true distance pulls the route taut", () => {
    const w = world({ w: 20, h: 20, edges: line("w", 8, 0, 10) });
    const i = input(w, tok(w, { x: 2, y: 2 }), { rules: { feetPerCell: 5, diagonal: "euclid" } });
    const r = routeOf(i, { x: 14, y: 2 });
    assertPiecesPass(i, r);
    // Two long pieces to the wall's end and away from it, not a staircase of steps.
    assert.ok(r.pieces.length <= 4, `${r.pieces.length} pieces`);
    const feet = routeFeet(r.points, r.pieces.map(([, , e, s]) => ({ extra: e, swim: s })), i.rules, { h: 0, v: 0 }, { swimSpeed: false, step: 1 }).cost;
    assert.ok(feet < 5 * 2 * Math.hypot(6, 8.5) + 6, `${feet} ft`);
  });
});

describe("entry accounting on a continuous footprint (4.1, M3)", () => {
  // The part of B outside A, rasterized finely, against each rubble square: a reference that knows nothing of cells.
  const refExtra = (a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number, rubble: readonly [number, number][]) => {
    const N = 16;
    for (let sy = 0; sy < h * N; sy++) {
      for (let sx = 0; sx < w * N; sx++) {
        const x = b.x + (sx + 0.5) / N;
        const y = b.y + (sy + 0.5) / N;
        if (x > a.x && x < a.x + w && y > a.y && y < a.y + h) continue;
        if (rubble.some(([rx, ry]) => x > rx && x < rx + 1 && y > ry && y < ry + 1)) return 1;
      }
    }
    return 0;
  };

  for (const size of ["tiny", "large"] as const) {
    for (const squares of [1, 2]) {
      test(`${size} half steps across ${squares} square${squares > 1 ? "s" : ""} of rubble in all 8 directions cost exactly double, and leaving costs nothing`, () => {
        const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const;
        for (const [ux, uy] of dirs) {
          const rubble: [number, number][] = squares === 1 ? [[10, 10]] : [[10, 10], [10 + (ux || 1), 10 + uy]];
          const cells = Object.fromEntries(rubble.map(([x, y]) => [`${x},${y}`, "rubble" as const]));
          const w = world({ w: 24, h: 24, cells });
          const fp = size === "tiny" ? 0.5 : 2;
          const start = { x: 10.5 - fp / 2 - ux * 5, y: 10.5 - fp / 2 - uy * 5 };
          const ww = new WalkWorld(input(w, tok(w, { size, ...start })));
          let paid = 0;
          let ref = 0;
          let p = start;
          let inside = false;
          for (let k = 0; k < 20; k++) {
            const q = { x: p.x + ux * 0.5, y: p.y + uy * 0.5 };
            const e = ww.extraOf(p.x, p.y, q.x, q.y, 0, -1).extra;
            assert.equal(e, refExtra(p, q, fp, fp, rubble), `${size} ${ux},${uy} step ${k}`);
            paid += e * 0.5;
            ref += refExtra(p, q, fp, fp, rubble) * 0.5;
            if (e > 0) inside = true;
            else if (inside) assert.equal(e, 0, "leaving pays nothing");
            p = q;
          }
          assert.equal(paid, ref);
          assert.ok(paid > 0);
        }
      });
    }
  }
});

/**
 * The brute-force reference: every state's cheapest cost relaxed until
 * nothing changes, over the same steps and the same per-step feet the
 * search uses, written out again here.
 */
function bruteCost(i: WalkInput, to: { x: number; y: number }): number | null {
  const world = new WalkWorld(i);
  const S = 2 * i.rules.feetPerCell;
  const L = world.L;
  const Lu = Math.round(L * S);
  const rule: DiagonalRule = i.rules.diagonal;
  const cost = new Map<string, number>();
  const start = world.startNode;
  const h0 = rule === "fiveTen" ? (((Math.round(i.counter.h * S) % (2 * S)) + 2 * S) % (2 * S)) : 0;
  const v0 = rule === "fiveTen" ? (((Math.round(i.counter.v * S) % (2 * S)) + 2 * S) % (2 * S)) : 0;
  cost.set(`${start},${h0},${v0}`, 0);
  const DX = [1, 0, -1, 0, 1, -1, -1, 1];
  const DY = [0, 1, 0, -1, 1, 1, -1, -1];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, c] of [...cost.entries()]) {
      const [a, h, v] = key.split(",").map(Number) as [number, number, number];
      const ax = world.xOf(a);
      const ay = world.yOf(a);
      const ea = world.elevationAt(a);
      if (a !== start && world.endOnly(ax, ay, ea)) continue;
      for (let d = 0; d < 8; d++) {
        const bi = (a % world.nx) + DX[d]!;
        const bj = Math.floor(a / world.nx) + DY[d]!;
        if (bi < 0 || bj < 0 || bi >= world.nx || bj >= world.ny) continue;
        const b = bj * world.nx + bi;
        const bx = world.xOf(b);
        const by = world.yOf(b);
        if (!world.seenAt(bx, by) || !world.wallsClear(a, d, b)) continue;
        const eb = world.elevationAt(b);
        const { extra } = world.extraOf(ax, ay, bx, by, eb, b);
        const Z = Math.round(Math.abs(eb - ea) * 2);
        let step: number;
        let nh = h;
        let nv = v;
        if (rule === "euclid") step = Math.hypot(L, d >= 4 ? L : 0, Math.abs(eb - ea) / i.rules.feetPerCell) * i.rules.feetPerCell;
        else if (rule === "five") step = Math.max(Lu, Z);
        else {
          const horizontal = d >= 4 ? Lu + S * (Math.floor((h + Lu) / (2 * S)) - Math.floor(h / (2 * S))) : Lu;
          if (d >= 4) nh = (h + Lu) % (2 * S);
          const vMin = Math.min(horizontal, Z);
          step = Math.max(horizontal, Z) + S * (Math.floor((v + vMin) / (2 * S)) - Math.floor(v / (2 * S)));
          nv = (v + vMin) % (2 * S);
        }
        const next = c + step * (1 + extra);
        const k = `${b},${nh},${nv}`;
        const old = cost.get(k);
        if (old === undefined || next < old - 1e-9) {
          cost.set(k, next);
          changed = true;
        }
      }
    }
  }
  const target = world.nodeAt(to);
  let best: number | null = null;
  for (const [key, c] of cost) if (Number(key.split(",")[0]) === target && (best === null || c < best)) best = c;
  return best;
}

describe("the search against a brute-force reference", () => {
  test("stairs of 1 ft and 3 ft rises at 5 ft and 3 ft per square, under 5-10-5", () => {
    for (const rise of [1, 3]) {
      for (const feetPerCell of [5, 3]) {
        const heights: Record<string, number> = {};
        for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) heights[`${x},${y}`] = rise * (x + (y % 3));
        const w = world({ w: 10, h: 10, heights, blockMovement: false });
        for (const size of ["medium", "tiny", "large"] as const) {
          const i = input(w, tok(w, { size, x: 0, y: 0, elevation: 0 }), { rules: { feetPerCell, diagonal: "fiveTen" } });
          const to = { x: size === "large" ? 7 : 8, y: size === "large" ? 6.5 : 7 };
          const { search, cost } = searched(i, to);
          assert.equal(cost, bruteCost(i, to), `${rise} ft rises at ${feetPerCell} ft, ${size}`);
          const r = search.routeTo(to)!;
          assert.equal(pieceFeet(i, r) * 2, cost, `pieces read back the search's feet, ${rise} ft at ${feetPerCell} ft, ${size}`);
        }
      }
    }
  });

  test("random scenes: the cost is the reference's, and every piece passes the leg test", () => {
    const rand = mulberry32(2026);
    const terrains: TerrainId[] = ["difficult", "rubble", "water", "pit", "stone"];
    for (let run = 0; run < 160; run++) {
      const W = 7 + Math.floor(rand() * 4);
      const H = 7 + Math.floor(rand() * 4);
      const edges: Record<string, EdgeFeature> = {};
      for (let k = 0; k < W * H * 0.25; k++) {
        const x = Math.floor(rand() * W);
        const y = Math.floor(rand() * H);
        const f = rand();
        edges[`${x},${y},${rand() < 0.5 ? "n" : "w"}`] = f < 0.8 ? { kind: "wall" } : f < 0.9 ? OPEN_DOOR : CLOSED_DOOR;
      }
      const cells: Record<string, TerrainId> = {};
      for (let k = 0; k < W * H * 0.2; k++) cells[`${Math.floor(rand() * W)},${Math.floor(rand() * H)}`] = terrains[Math.floor(rand() * terrains.length)]!;
      const rough = Array.from({ length: 3 }, () => `${Math.floor(rand() * W)},${Math.floor(rand() * H)}`);
      const heights: Record<string, number> = {};
      const blockMovement = rand() < 0.7;
      if (!blockMovement) for (let k = 0; k < 6; k++) heights[`${Math.floor(rand() * W)},${Math.floor(rand() * H)}`] = Math.floor(rand() * 4) * 2;
      const spec: WorldSpec = { w: W, h: H, edges, cells, rough, heights, blockMovement };
      const w = world(spec);
      const size = (["medium", "tiny", "large", "small"] as const)[Math.floor(rand() * 4)]!;
      const fp = size === "tiny" ? 0.5 : size === "large" ? 2 : 1;
      const step = size === "medium" || size === "small" ? 1 : 0.5;
      const spot = () => ({ x: Math.floor((rand() * (W - fp)) / step) * step, y: Math.floor((rand() * (H - fp)) / step) * step });
      const start = spot();
      const creatures: WalkCreature[] = [];
      for (let k = 0; k < 2; k++) {
        const c = spot();
        if (c.x === start.x && c.y === start.y) continue;
        creatures.push({ x0: c.x, y0: c.y, x1: c.x + 1, y1: c.y + 1, lo: 0, hi: 5, way: (["free", "difficult", "blocked"] as const)[Math.floor(rand() * 3)]! });
      }
      const diagonal = (["five", "fiveTen", "euclid"] as const)[Math.floor(rand() * 3)]!;
      const i = input(w, tok(w, { size, ...start }), {
        rules: { feetPerCell: [5, 3][Math.floor(rand() * 2)]!, diagonal },
        creatures,
        prone: rand() < 0.15,
        counter: { h: Math.floor(rand() * 3), v: 0 },
        areas: rand() < 0.3 ? [{ extra: rand() < 0.5 ? 1 : 3, cells: [spot(), spot()].map((p) => ({ x: Math.floor(p.x), y: Math.floor(p.y) })) }] : [],
      });
      const to = spot();
      const ref = bruteCost(i, to);
      const search = new WalkSearch(new WalkWorld(i));
      const answer = search.settle(to);
      const label = JSON.stringify({ run, size, start, to, diagonal });
      if (ref === null) {
        assert.equal(answer, "unreachable", label);
        continue;
      }
      assert.equal(answer, "settled", label);
      assert.ok(Math.abs(search.costTo(to)! - ref) < 1e-9, `${label}: ${search.costTo(to)} against ${ref}`);
      const r = search.routeTo(to)!;
      if (blockMovement) assertPiecesPass(i, r);
      if (diagonal !== "euclid") assert.equal(pieceFeet(i, r) * 2, search.costTo(to), `${label}: pieces`);
      // True distance rounds the leg once, to the nearest foot.
      else assert.ok(pieceFeet(i, r) <= search.costTo(to)! + 0.5, `${label}: taut is never longer`);
      const last = r.points[r.points.length - 1]!;
      assert.deepEqual([last.x, last.y], [to.x, to.y], label);
    }
  });
});

describe("5-10-5 residues against the reference", () => {
  /*
   * A state reached more cheaply can carry a worse 5-10-5 count: arriving
   * with an odd count, the next diagonal costs double, and into Plant Growth
   * that is 20 ft more. So the search keeps every residue it reaches, and
   * these scenes, walls and Plant Growth on a small grid, find the places a
   * search that kept only the cheapest state per square would get wrong.
   */
  test("random walled scenes with Plant Growth: a cheaper state never hides a better count", () => {
    const rand = mulberry32(55);
    for (let run = 0; run < 400; run++) {
      const W = 4 + Math.floor(rand() * 3);
      const edges: Record<string, EdgeFeature> = {};
      for (let k = 0; k < W * W * 0.3; k++) edges[`${Math.floor(rand() * W)},${Math.floor(rand() * W)},${rand() < 0.5 ? "n" : "w"}`] = { kind: "wall" };
      const cells: Record<string, TerrainId> = {};
      for (let k = 0; k < W * W * 0.2; k++) cells[`${Math.floor(rand() * W)},${Math.floor(rand() * W)}`] = "rubble";
      const growth = Array.from({ length: Math.floor(W * W * 0.25) }, () => ({ x: Math.floor(rand() * W), y: Math.floor(rand() * W) }));
      const w = world({ w: W, h: W, cells, edges });
      const spot = () => ({ x: Math.floor(rand() * W), y: Math.floor(rand() * W) });
      const i = input(w, tok(w, spot()), { rules: { feetPerCell: 5, diagonal: "fiveTen" }, counter: { h: Math.floor(rand() * 2), v: 0 }, areas: [{ extra: 3, cells: growth }] });
      const to = spot();
      const ref = bruteCost(i, to);
      const search = new WalkSearch(new WalkWorld(i));
      if (ref === null) continue;
      assert.equal(search.settle(to), "settled");
      assert.equal(search.costTo(to), ref, JSON.stringify({ run, to }));
    }
  });
});

describe("the search's cap (5.2)", () => {
  test("settled states are counted, and the search stops when asked to pause", () => {
    const w = world({ w: 60, h: 60 });
    const i = input(w, tok(w, { x: 1, y: 1 }), { rules: { feetPerCell: 5, diagonal: "fiveTen" } });
    const s = new WalkSearch(new WalkWorld(i));
    assert.equal(s.settle({ x: 58, y: 58 }, performance.now() - 1), "paused");
    assert.equal(s.settle({ x: 58, y: 58 }), "settled");
    assert.ok(s.settled > 1000);
    void ([] as RoutePoint[]);
  });
});
