import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import { CHUNK_CELLS, type RoomState, type Token } from "../model.ts";
import { int, pick, rng, template } from "../testutil.ts";
import { placedOnHex } from "./footprint.ts";
import { hexDistance, hexNeighbors, sceneHexes, type Hex, type HexGrid } from "./hex.ts";
import { findRouteOn, HexWalkSearch, HexWalkWorld } from "./hexWalk.ts";
import { hexRestand, hexStandPlace, legStop, onSqueezedLattice, ownWalk, type HexStand } from "./movement.ts";
import { hexRouteFeet, routePoints, routeStop } from "./route.ts";
import type { WalkCreature, WalkInput, WalkRoute } from "./walk.ts";
import { publicWorld } from "./walkWorld.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, sideWall, wallsRound } from "./hexWalls.testkit.ts";

/**
 * Routes on the six-neighbor anchor lattice (docs/design-v1-hex-grids.md
 * phase H2): the search finds the cheapest walk round walls, through
 * corridors squeezed, over difficult ground by hex keys and through slowing
 * areas, and every route it finds passes the server's check at the cost it
 * paid.
 */

const RULES = { feetPerCell: 5, diagonal: "five" as const };

function inputOf(s: RoomState, t: Token, creatures: WalkCreature[] = []): WalkInput {
  return { build: s, token: ownWalk(t), rules: RULES, seen: null, creatures, areas: [], prone: false, counter: { h: 0, v: 0 } };
}

/** What a route costs as the reducer records it (route.ts hexRouteFeet), squeezed at its end where the drop that sends it squeezes. */
function routeCost(s: RoomState, t: Token, route: WalkRoute, g: HexGrid): number {
  const points = routePoints(s.buildChunks, ownWalk(t), route.pieces, t.elevation);
  const end = points[points.length - 1]!;
  return hexRouteFeet(g, t, points, onSqueezedLattice(g, t, end), route.pieces.map(([, , extra, swim]) => ({ extra, swim })), RULES, { h: 0, v: 0 }, { swimSpeed: false }).cost;
}

/** The cheapest walk's cost in feet by a plain search over every stand, read through the world's own step rules, or null when none reaches an end. */
function bruteCost(world: HexWalkWorld, to: { x: number; y: number }): number | null {
  const ends = new Set(world.ends(to).map((s) => world.nodeOf(s)));
  const cost = new Map<number, number>([[world.startNode, 0]]);
  const done = new Set<number>();
  for (;;) {
    let a = -1;
    for (const [n, c] of cost) if (!done.has(n) && (a < 0 || c < cost.get(a)!)) a = n;
    if (a < 0) return null;
    if (ends.has(a)) return cost.get(a)! * RULES.feetPerCell;
    done.add(a);
    const A = world.standOf(a);
    if (a !== world.startNode && world.endOnly(A)) continue;
    const relax = (b: number, c: number) => {
      if (b >= 0 && !done.has(b) && c < (cost.get(b) ?? Infinity)) cost.set(b, c);
    };
    hexNeighbors(world.g, A.ref).forEach((ref, d) => {
      const B: HexStand = { ...A, ref };
      if (world.stepOk(A, B, d, a === world.startNode)) relax(world.nodeOf(B), cost.get(a)! + 1 + world.extraOf(A, B));
    });
    if (world.small) {
      const B = hexRestand(world.input.token, A, !A.squeezed);
      if (world.restandOk(B)) relax(world.nodeOf(B), cost.get(a)!);
    }
  }
}

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  /** A scene laid out along the lattice's run: as asked on hex rows, turned on hex columns. */
  const room = (w: number, h: number, walls: Parameters<typeof hexWallRoom>[3]) => (g.orient === "rows" ? hexWallRoom(shape, w, h, walls) : hexWallRoom(shape, h, w, walls));
  const bounds = (w: number, h: number) => (g.orient === "rows" ? { w, h } : { w: h, h: w });

  describe(`${name}: the way round`, () => {
    test("round a wall: the walk bends where the straight leg is stopped, and the server takes it", () => {
      const W = 20;
      const H = 14;
      const s = room(W, H, wallsRound(g, bounds(W, H), (h) => (g.orient === "rows" ? h.col === 9 && h.row >= 2 : h.row === 9 && h.col >= 2)));
      const t = onHex(g, "m", "medium", at(4, 8));
      const to = placedOnHex(g, t, at(14, 8));
      assert.ok(legStop(s, ownWalk(t), { ...to, elevation: 0 }));
      const route = findRouteOn(inputOf(s, t), to);
      assert.ok(route && route !== "none", "a way round");
      assert.equal(routeStop(s, ownWalk(t), route.pieces, 0), null);
      assert.ok(route.pieces.length <= 4, "a few pieces, each a straight hex line");
      assert.equal(routeCost(s, t, route, g), bruteCost(new HexWalkWorld(inputOf(s, t)), to));
    });

    test("a Large creature squeezes through a one-row corridor, paying for each squeezed step", () => {
      const W = 22;
      const H = 16;
      const solid = (h: Hex) => {
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return along >= 6 && along <= 12 && across !== 6;
      };
      const s = room(W, H, wallsRound(g, bounds(W, H), solid));
      const t = onHex(g, "big", "large", at(2, 5));
      const to = placedOnHex(g, t, at(16, 6));
      const route = findRouteOn(inputOf(s, t), to);
      assert.ok(route && route !== "none");
      assert.equal(routeStop(s, ownWalk(t), route.pieces, 0), null, "the server takes every piece");
      assert.ok(route.pieces.some(([, , extra]) => extra === 1), "the corridor's steps cost one extra foot a foot");
      const cost = routeCost(s, t, route, g);
      assert.equal(cost, bruteCost(new HexWalkWorld(inputOf(s, t)), to));
      // Through the corridor's 7 hexes at least, each squeezed step paid twice.
      const plain = hexDistance(g, at(2, 5), at(16, 6)) * 5;
      assert.ok(cost >= plain + 7 * 5, `${cost} pays for the squeeze`);
    });

    test("through an open door, never a closed one", () => {
      const W = 16;
      const H = 12;
      const wallHexes = (h: Hex) => (g.orient === "rows" ? h.col === 7 : h.row === 7);
      const door = (state: "open" | "closed") => {
        const walls = wallsRound(g, bounds(W, H), wallHexes);
        // A doorway through the wall's hexes: the sides of one wall hex, as doors.
        const gap = at(7, 5);
        const kept = walls.filter((w) => !hexNeighbors(g, gap).some((_n, d) => sameWall(w, sideWall(g, gap, d))));
        return [...kept, ...hexNeighbors(g, gap).map((n, d) => (wallHexes(n) ? null : sideWall(g, gap, d, { kind: "door", state, secret: false, discovered: false }))).filter((w) => w !== null)];
      };
      const t = onHex(g, "m", "medium", at(3, 5));
      const to = placedOnHex(g, t, at(11, 5));
      const open = room(W, H, door("open"));
      const found = findRouteOn(inputOf(open, t), to);
      assert.ok(found === null || found !== "none", "the open door lets it through");
      assert.equal(findRouteOn(inputOf(room(W, H, door("closed")), t), to), "none");
    });

    test("round a hostile creature it cannot pass, through an ally's space, and difficult ground by hex keys costs", () => {
      const s = room(16, 12, []);
      s.tokens.m = onHex(g, "m", "medium", at(3, 5), { disposition: "ally", kind: "pc" });
      s.tokens.orc = onHex(g, "orc", "medium", at(6, 5), { disposition: "hostile", kind: "monster" });
      s.tokens.pal = onHex(g, "pal", "medium", at(8, 5), { disposition: "ally", kind: "pc" });
      const world = publicWorld(s, ownWalk(s.tokens.m!), { role: "dm" });
      const key = (h: Hex) => `${h.col},${h.row}`;
      assert.deepEqual(world.input.creatures.map((c) => c.hexes), [[key(at(6, 5))], [key(at(8, 5))]], "each creature by its hexes");
      const to = placedOnHex(g, s.tokens.m!, at(10, 5));
      const route = findRouteOn(world.input, to);
      assert.ok(route && route !== "none", "round the orc");
      const w = new HexWalkWorld(world.input);
      assert.equal(routeCost(s, s.tokens.m!, route, g), bruteCost(w, to));
      // Difficult ground over the whole straight way: the walk pays for it, or goes round where that is cheaper.
      const chunk = chunkKey("s1", 0, 0);
      const rough = Array.from({ length: CHUNK_CELLS * CHUNK_CELLS }, (_, k) => {
        const h = { col: k % CHUNK_CELLS, row: Math.floor(k / CHUNK_CELLS) };
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return across >= 0 && along >= 4 && along <= 5 ? "d" : ".";
      }).join("");
      s.buildChunks[chunk] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, rough, grid: shape };
      delete s.tokens.orc;
      const marked = publicWorld(s, ownWalk(s.tokens.m!), { role: "dm" });
      const across = findRouteOn(marked.input, to);
      assert.ok(across && across !== "none", "the marked strip costs, so the walk is no plain leg");
      assert.equal(routeCost(s, s.tokens.m!, across, g), 7 * 5 + 2 * 5, "seven hexes, two of them difficult");
    });

    test("an area that slows movement inside costs on hexes, by the hexes it covers", () => {
      const s = room(16, 12, []);
      s.tokens.m = onHex(g, "m", "medium", at(2, 5), { kind: "pc" });
      const c = placedOnHex(g, s.tokens.m, at(7, 5));
      s.templates.web = template("web", { sceneId: "s1", shape: "sphere", size: 5, origin: { x: c.x + 0.5, y: c.y + 0.5, z: 0 }, slows: { kind: "difficult" } });
      const world = publicWorld(s, ownWalk(s.tokens.m), { role: "dm" });
      assert.ok(world.input.areas.length === 1 && world.input.areas[0]!.cells.length > 0, "the web's hexes");
      const to = placedOnHex(g, s.tokens.m, at(12, 5));
      const route = findRouteOn(world.input, to);
      assert.ok(route && route !== "none");
      assert.equal(routeCost(s, s.tokens.m, route, g), bruteCost(new HexWalkWorld(world.input), to));
      assert.ok(routeCost(s, s.tokens.m, route, g) > 10 * 5, "the web costs more than the plain ten hexes, or the walk round it does");
      const covered = world.input.areas[0]!.cells.map(({ x, y }) => `${x},${y}`);
      assert.ok(covered.includes(`${at(7, 5).col},${at(7, 5).row}`), "the hex under the web's middle is covered");
    });
  });

  describe(`${name}: every route the search finds is the server's at the cost it paid`, () => {
    test("on random walls, ground and creatures, against a plain search", () => {
      const r = rng(g.orient === "rows" ? 31 : 32);
      const W = 13;
      const H = 10;
      let routes = 0;
      for (let trial = 0; trial < 40; trial++) {
        const walls = sceneHexes(g, { w: W, h: H }).flatMap((h) => [0, 1, 2].filter(() => r() < 0.14).map((d) => sideWall(g, h, d)));
        const s = hexWallRoom(shape, W, H, walls);
        const size = pick(r, ["medium", "large", "huge"] as const);
        const hexes = sceneHexes(g, { w: W, h: H });
        const t = onHex(g, "t", size, pick(r, hexes));
        const creatures: WalkCreature[] = Array.from({ length: int(r, 0, 3) }, () => {
          const h = pick(r, hexes);
          return { x0: 0, y0: 0, x1: 0, y1: 0, lo: 0, hi: 5, way: pick(r, ["free", "difficult", "blocked"] as const), hexes: [`${h.col},${h.row}`] };
        });
        const input = inputOf(s, t, creatures);
        for (let k = 0; k < 6; k++) {
          const to = placedOnHex(g, t, pick(r, hexes));
          const found = findRouteOn(input, to);
          const world = new HexWalkWorld(input);
          const brute = bruteCost(world, to);
          if (found === "none") {
            assert.equal(brute, null, `trial ${trial}: none, and a plain search finds none either`);
            continue;
          }
          if (found === null) {
            assert.equal(legStop(s, ownWalk(t), { ...to, elevation: 0 }), null, "the plain leg is open");
            continue;
          }
          routes++;
          assert.equal(routeStop(s, ownWalk(t), found.pieces, 0), null, `trial ${trial}: the server takes it`);
          for (const [x, y] of found.pieces) {
            const placed = [false, true].some((sq) => {
              const p = hexStandPlace(g, t, { ...world.standOf(world.nodeAt({ x, y })), squeezed: sq, size: sq && world.small ? world.small : world.full });
              return Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6;
            });
            assert.ok(placed, "each piece ends on an anchor");
          }
          assert.equal(routeCost(s, t, found, g), brute, `trial ${trial}: the cost it paid`);
          const search = new HexWalkSearch(world);
          assert.equal(search.settle(to), "settled");
        }
      }
      assert.ok(routes > 20, `${routes} routes checked`);
    });
  });
}

function sameWall(a: { a: [number, number]; b: [number, number] }, b: { a: [number, number]; b: [number, number] }): boolean {
  const same = (p: [number, number], q: [number, number]) => p[0] === q[0] && p[1] === q[1];
  return (same(a.a, b.a) && same(a.b, b.b)) || (same(a.a, b.b) && same(a.b, b.a));
}
