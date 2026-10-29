import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FreeWall, GridShape, RoomState, StairMark, Token } from "../model.ts";
import { chunkKey, wallChunk } from "../keys.ts";
import type { Op } from "../protocol.ts";
import { actor, apply, DM, room, scene, token } from "../testutil.ts";
import { placedOnHex } from "./footprint.ts";
import { cornerAt, hexCenter, hexCorners, hexKey, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { facingsOf, footprintGround, heightsGrid, oppositeFacing, stepper } from "./heights.ts";
import { findRouteOn, HexWalkWorld } from "./hexWalk.ts";
import { planMove } from "./moveLeg.ts";
import { landedElevation, legStop, ownWalk } from "./movement.ts";
import { hexRouteFeet, routePoints } from "./route.ts";
import { coldPartySight, type VisionWorld } from "./vision.ts";
import type { WalkInput, WalkRoute } from "./walk.ts";
import { SIGHT } from "./segments.ts";
import { LEDGE, RAISED, sceneWalls } from "./walls.ts";
import { COLUMNS, ROWS } from "./hexWalls.testkit.ts";
import { groupWalkWorld } from "./walkWorld.ts";

/**
 * Heights, ledges and stairs on hexes (docs/design-v1-hex-grids.md phase
 * H3): a stair faces one of a hex's six sides, ground that differs across
 * a side raises it as a ledge unless a stair runs through it, and walking,
 * flying, a stair's climb and a light's height read them as on squares.
 */

/** A hex scene `s1` of `w` by `h` cells whose moves walls and ledges stop, with heights and stair marks painted through the reducer. */
function raised(g: HexGrid, heights: [Hex, number][], stairs: [Hex, StairMark][] = [], bounds = { w: 20, h: 14 }): RoomState {
  const shape: GridShape = g.orient === "rows" ? "hexRows" : "hexColumns";
  let s = room({ scenes: { s1: scene("s1", { gridShape: shape, bounds, blockMovement: true }) } });
  for (const [h, height] of heights) s = apply(s, { t: "build.height", sceneId: "s1", cells: [hexKey(h)], height } as Op);
  for (const [h, up] of stairs) s = apply(s, { t: "build.stairs", sceneId: "s1", cells: [hexKey(h)], up } as Op);
  return s;
}

function on(g: HexGrid, id: string, ref: Hex, over: Partial<Token> = {}): Token {
  const base = token(id, { sceneId: "s1", size: "medium", x: 0, y: 0, ...over });
  return { ...base, ...placedOnHex(g, base, ref) };
}

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  const H: Hex = { col: 6, row: 6 };
  const near = (h: Hex, d: number) => hexNeighbors(g, h)[d]!;

  describe(`${name}: six facings`, () => {
    test("a facing names a side in hexNeighbors' order, on either parity, and the facing across is three on", () => {
      const step = stepper(g);
      for (const h of [H, { col: 6, row: 7 }, { col: 7, row: 6 }, { col: 7, row: 7 }]) {
        for (let d = 0; d < 6; d++) {
          const n = near(h, d);
          assert.deepEqual(step(h.col, h.row, d), [n.col, n.row], `${hexKey(h)} facing ${d}`);
          assert.equal(oppositeFacing(g, d), (d + 3) % 6);
        }
      }
      assert.deepEqual(facingsOf(g), ["0", "1", "2", "3", "4", "5"]);
    });

    test("facing 0 runs east on rows and south on columns, and facing 2 turns the other way: a mirror, not a turn", () => {
      const c = hexCenter(g, H);
      const zero = hexCenter(g, near(H, 0));
      const two = hexCenter(g, near(H, 2));
      if (g.orient === "rows") {
        assert.ok(zero.x > c.x && zero.y === c.y, "east");
        assert.ok(two.x < c.x && two.y > c.y, "south-west");
      } else {
        assert.ok(zero.y > c.y && zero.x === c.x, "south");
        assert.ok(two.x > c.x && two.y < c.y, "north-east");
      }
    });

    test("a stair by the rule points up toward its one higher neighbor, toward each of six sides", () => {
      for (let d = 0; d < 6; d++) {
        const s = raised(g, [[near(H, d), 10]], [[H, "a"]]);
        assert.equal(sceneWalls(s.scenes.s1!, s.buildChunks).stairAt(H.col, H.row), String(d), `toward ${d}`);
      }
    });

    test("a facing set by hand wins, and a flight passes its facing down its own line only", () => {
      const s = raised(g, [[near(H, 4), 10]], [[H, "1"]]);
      assert.equal(sceneWalls(s.scenes.s1!, s.buildChunks).stairAt(H.col, H.row), "1");
      const b = near(H, 1);
      const c = near(b, 1);
      const beside = near(H, 0);
      const flight = raised(g, [], [
        [H, "a"],
        [b, "a"],
        [c, "1"],
        [beside, "a"],
      ]);
      const walls = sceneWalls(flight.scenes.s1!, flight.buildChunks);
      assert.deepEqual([walls.stairAt(H.col, H.row), walls.stairAt(b.col, b.row), walls.stairAt(c.col, c.row)], ["1", "1", "1"]);
      assert.equal(walls.stairAt(beside.col, beside.row), null, "beside the flight, not on its line");
    });
  });

  describe(`${name}: ledges on a hex's six sides`, () => {
    test("a raised hex raises its six sides, each between its own two corners, topped by its ground", () => {
      const s = raised(g, [[H, 10]]);
      const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
      const corners = hexCorners(g, H).map((c) => cornerAt(g, c));
      const found: string[] = [];
      for (let k = 0; k < walls.stored.n; k++) {
        if (!(walls.stored.tags[k]! & RAISED)) continue;
        assert.ok(walls.stored.tags[k]! & LEDGE);
        assert.equal(walls.storedTops[k], 10);
        found.push(Array.from(walls.stored.xy.subarray(4 * k, 4 * k + 4)).join(","));
      }
      const sides = [0, 1, 2, 3, 4, 5].map((d) => {
        const a = corners[(d + 1) % 6]!;
        const b = corners[(d + 2) % 6]!;
        return [`${a.x},${a.y},${b.x},${b.y}`, `${b.x},${b.y},${a.x},${a.y}`];
      });
      assert.equal(found.length, 6);
      for (const [one, other] of sides) assert.ok(found.includes(one!) || found.includes(other!), `side ${one}`);
      // Sight from an eye below the top meets all six, its split pieces topped as their sides are, and none from above.
      assert.equal(walls.sight(5).pieces.length, 6 * 4);
      assert.equal(walls.sight(10).pieces.length, 0);
    });

    test("a stair connects its up side and its down side, and leaves its other four sides ledges", () => {
      for (let d = 0; d < 6; d++) {
        const below = near(H, d);
        // The stair below the raised hex faces it, across its own side toward the hex.
        const s = raised(g, [[H, 10]], [[below, String(oppositeFacing(g, d)) as StairMark]]);
        const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
        let ledges = 0;
        let connected = 0;
        for (let k = 0; k < walls.stored.n; k++) {
          const tags = walls.stored.tags[k]!;
          if (!(tags & RAISED)) continue;
          if (tags & LEDGE) ledges++;
          else connected++;
        }
        assert.deepEqual([ledges, connected], [5, 1], `stair toward ${d}`);
        assert.equal(walls.stored.n, 6, "a hex scene's stair mark raises no wall round it, as no hex scene has walls on grid lines");
        assert.deepEqual(walls.edges, [], "nor draws one");
      }
    });
  });

  describe(`${name}: walking, climbing and falling read the ledges`, () => {
    const leg = (s: RoomState, t: Token, to: Hex, elevation: number) => legStop(s, ownWalk(t), { ...placedOnHex(g, t, to), elevation })?.blocker ?? null;

    test("a walker is stopped at a ledge going up or down, on every side, and a stair lets it climb", () => {
      for (let d = 0; d < 6; d++) {
        const below = near(H, d);
        const s = raised(g, [[H, 10]]);
        assert.equal(leg(s, on(g, "w", below), H, 10), "ledge", `up from side ${d}`);
        assert.equal(leg(s, on(g, "w", H, { elevation: 10 }), below, 0), "ledge", `down off side ${d}`);
        const stair = raised(g, [[H, 10]], [[below, String(oppositeFacing(g, d)) as StairMark]]);
        assert.equal(leg(stair, on(g, "w", below), H, 10), null, `up the stair on side ${d}`);
        // A stair halfway up connects its down side too: from the floor onto it, and from it onto the top.
        const floor = near(below, d);
        const half = raised(g, [[H, 10], [below, 5]], [[below, String(oppositeFacing(g, d)) as StairMark]]);
        assert.equal(leg(half, on(g, "w", floor), below, 5), null, `onto the stair from below on side ${d}`);
        assert.equal(leg(half, on(g, "w", below, { elevation: 5 }), H, 10), null);
        assert.equal(leg(half, on(g, "w", near(below, (d + 1) % 6)), below, 5), "ledge", "and its sides stay ledges");
      }
    });

    test("a flier passes ledges below the lower of its heights, and a creature inside the ground passes them all", () => {
      const s = raised(g, [[H, 10]]);
      const below = near(H, 3);
      assert.equal(leg(s, on(g, "f", below, { elevation: 15 }), H, 15), null);
      assert.equal(leg(s, on(g, "f", below, { elevation: 15 }), H, 5), "ledge", "coming down to 5 ft on the way");
      assert.equal(leg(s, on(g, "f", below, { elevation: 5 }), H, 15), "ledge");
      assert.equal(leg(s, on(g, "b", below, { elevation: -5 }), H, -5), null);
      assert.equal(leg(s, on(g, "b", H, { elevation: 5 }), below, 5), null, "5 ft down inside the raised hex's ground");
    });

    test("a creature on the ground lands on the ground of the hexes it takes, the highest under a Large one", () => {
      const s = raised(g, [[H, 10], [near(H, 1), 15]]);
      const walker = on(g, "w", near(H, 3));
      assert.equal(landedElevation(s.buildChunks, walker, placedOnHex(g, walker, H)), 10);
      assert.equal(heightsGrid(s.buildChunks, "s1"), g);
      const large = on(g, "l", H, { size: "large" });
      assert.equal(footprintGround(s.buildChunks, large), 15, "its three hexes include the 15 ft one");
    });

    test("a stair's climb counts each piece's rise by the room's rule, the walk standing on the ground all the way", () => {
      // Floor, a stair at the floor's height facing the raised hex, the raised hex, and raised ground past it, in one line.
      const a = near(H, 3);
      const stair = H;
      const top = near(H, 0);
      const past = near(top, 0);
      const s = raised(g, [[top, 10], [past, 10]], [[stair, "0"]]);
      const t = on(g, "w", a);
      for (const [diagonal, feet] of [
        ["five", 20],
        ["euclid", 21],
      ] as const) {
        const rules = { feetPerCell: 5, diagonal };
        const input: WalkInput = { build: s, token: ownWalk(t), rules, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
        const found = findRouteOn(input, placedOnHex(g, t, past));
        assert.ok(found && found !== "none", "the straight leg climbs unevenly, so the search walks it");
        const route: WalkRoute = found;
        // The drop lands on the ground where it ends, as the client puts in the op.
        const points = routePoints(s.buildChunks, ownWalk(t), route.pieces, landedElevation(s.buildChunks, t, placedOnHex(g, t, past)));
        assert.deepEqual(
          points.map((p) => p.elevation),
          [0, 0, 10, 10],
        );
        const cost = hexRouteFeet(g, t, points, false, route.pieces.map(([, , extra, swim]) => ({ extra, swim })), rules, { h: 0, v: 0 }, { swimSpeed: false });
        assert.equal(cost.moved, feet, diagonal);
        assert.equal(new HexWalkWorld(input).stepLength({ size: "medium", ref: stair, squeezed: false }, { size: "medium", ref: top, squeezed: false }), diagonal === "five" ? 2 : Math.hypot(1, 2));
      }
    });
  });

  describe(`${name}: the search counts climbs by the 5-10-5 counter`, () => {
    // Built on hex rows and mirrored onto columns, whose keys and bounds swap.
    const m = (h: Hex): Hex => (g.orient === "rows" ? h : { col: h.row, row: h.col });
    const fiveTen = { feetPerCell: 5, diagonal: "fiveTen" } as const;
    function walk(s: RoomState, from: Hex, to: Hex, counter: { h: number; v: number }) {
      const t = on(g, "w", from);
      const input: WalkInput = { build: s, token: ownWalk(t), rules: fiveTen, seen: null, creatures: [], areas: [], prone: false, counter };
      const found = findRouteOn(input, placedOnHex(g, t, to));
      assert.ok(found && found !== "none", "the straight leg is not open, so the search walks it");
      const points = routePoints(s.buildChunks, ownWalk(t), found.pieces, landedElevation(s.buildChunks, t, placedOnHex(g, t, to)));
      const charged = hexRouteFeet(g, t, points, false, found.pieces.map(([, , extra, swim]) => ({ extra, swim })), fiveTen, { ...counter }, { swimSpeed: false });
      return { points, cost: charged.cost };
    }

    test("two bumps of 5 ft cost 30 ft straight over them, so the search walks the 25 ft way round", () => {
      const s = raised(g, [[m({ col: 4, row: 4 }), 5], [m({ col: 6, row: 4 }), 5]], [[m({ col: 4, row: 4 }), "0"], [m({ col: 6, row: 4 }), "0"]]);
      const { points, cost } = walk(s, m({ col: 3, row: 4 }), m({ col: 7, row: 4 }), { h: 0, v: 0 });
      assert.equal(cost, 25);
      assert.ok(points.every((p) => p.elevation === 0), "never on a bump");
    });

    test("a walk's counter carries in: one climb onto difficult ground is cheaper straight from an even count, round from an odd one", () => {
      // Hexes 4, 5 and 6 of row 4 are 5 ft up, hex 4 difficult: straight climbs onto it, the way round climbs onto 5 or 6.
      const up = [4, 5, 6].map((col) => m({ col, row: 4 }));
      let s = room({ scenes: { s1: scene("s1", { gridShape: g.orient === "rows" ? "hexRows" : "hexColumns", bounds: { w: 20, h: 14 } }) } });
      s = apply(s, { t: "build.height", sceneId: "s1", cells: up.map(hexKey), height: 5 } as Op);
      s = apply(s, { t: "build.rough", sceneId: "s1", cells: [hexKey(up[0]!)], on: true } as Op);
      const from = m({ col: 3, row: 4 });
      const at = placedOnHex(g, on(g, "w", from), up[0]!);
      const onDifficult = (points: readonly { x: number; y: number }[]) => points.some((p) => p.x === at.x && p.y === at.y);
      const even = walk(s, from, up[2]!, { h: 0, v: 0 });
      assert.ok(onDifficult(even.points), "straight: 10 ft onto the difficult hex and 10 ft on, no dearer than round and with no turn");
      assert.equal(even.cost, 20);
      const odd = walk(s, from, up[2]!, { h: 0, v: 1 });
      assert.ok(!onDifficult(odd.points), "round: the climb costs 10 ft, doubled on difficult ground");
      assert.equal(odd.cost, 25);
    });
  });

  describe(`${name}: a creature dragged beside a flier walks on its own ground`, () => {
    // Built on hex rows and mirrored onto columns, whose keys and bounds swap.
    const m = (h: Hex): Hex => (g.orient === "rows" ? h : { col: h.row, row: h.col });

    /** Whether the server's leg test (permissions.ts draggedWalls) takes every leg of the goblin's walk beside Thorn's, the plain drop where `route` is null. */
    function goblinFollows(s: RoomState, to: { x: number; y: number }, route: WalkRoute | null): boolean {
      const op: Op = { t: "token.move", tokenId: "thorn", x: to.x, y: to.y, ...(route ? { route: route.pieces.map(([x, y, extra, swim]) => [x, y, extra, swim] as [number, number, number, 0 | 1]) } : {}) };
      const moved = planMove(op, s, DM, {}).find((mv) => mv.tokenId === "gob")!;
      for (let i = 1; i < moved.route.length; i++) if (legStop(s, moved.trace[i - 1]!, moved.route[i]!) !== null) return false;
      return true;
    }

    test("Thorn flying at 10 ft passes over a 5 ft hex, and the way found keeps the goblin on the ground beside him off its ledges", () => {
      const s = raised(g, [[m({ col: 5, row: 4 }), 5]]);
      // A new collection, as the reducer writes one: the rules keep what they read of the tokens by the collection.
      const thorn = on(g, "thorn", m({ col: 4, row: 4 }), { name: "Thorn", elevation: 10 });
      s.tokens = { ...s.tokens, thorn, gob: on(g, "gob", m({ col: 3, row: 4 }), { name: "Goblin", attached: { to: "thorn", kind: "drag" } }) };
      const world = groupWalkWorld(s, ownWalk(thorn), { role: "dm" });
      assert.equal(world.input.towed?.length, 1);
      const to = placedOnHex(g, thorn, m({ col: 7, row: 4 }));
      const found = findRouteOn(world.input, to);
      assert.notEqual(found, null, "the straight line takes the goblin over the raised hex, so it is no way");
      assert.ok(found && found !== "none", "a way round it");
      assert.equal(goblinFollows(s, to, found), true);
    });
  });

  describe(`${name}: a raised side cut near a rounded corner keeps its top`, () => {
    test("a window across hex 1,0's sides by its corners leaves every piece of them raised 10 ft, so an eye at 5 ft is stopped all along them", () => {
      // Built on hex rows and mirrored onto columns: x and y swap.
      const xy = (x: number, y: number): [number, number] => (g.orient === "rows" ? [x, y] : [y, x]);
      const s = raised(g, [[g.orient === "rows" ? { col: 1, row: 0 } : { col: 0, row: 1 }, 10]]);
      const window: FreeWall = { id: "w1", a: xy(1, 0.28125), b: xy(5, 0.296875), f: { kind: "window" } };
      const { cx, cy } = wallChunk(window);
      const key = chunkKey("s1", cx, cy);
      const chunk = s.buildChunks[key] ?? { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {} };
      s.buildChunks = { ...s.buildChunks, [key]: { ...chunk, walls: [...(chunk.walls ?? []), window] } };
      const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
      const length = (xy: Float64Array, keep: (k: number) => boolean = () => true) => {
        let sum = 0;
        for (let k = 0; 4 * k < xy.length; k++) if (keep(k)) sum += Math.hypot(xy[4 * k + 2]! - xy[4 * k]!, xy[4 * k + 3]! - xy[4 * k + 1]!);
        return sum;
      };
      const p = walls.pieces;
      const cut = length(p.xy, (k) => (p.tags[k]! & RAISED) !== 0);
      assert.ok(p.n > walls.stored.n, "the window cuts the raised sides");
      assert.ok(cut > 0);
      // Every raised side here tops out at 10 ft, and the window lets sight through: the eye's set is exactly the raised pieces.
      assert.ok(Math.abs(length(walls.sight(5).pieces) - length(p.xy, (k) => (p.tags[k]! & (RAISED | SIGHT)) !== 0)) < 1e-9);
      assert.ok(Math.abs(length(walls.sight(5).pieces) - cut) < 1e-9);
    });
  });

  describe(`${name}: a raised side below the floor keeps its own top (H3-ASTRA-06)`, () => {
    test("the side between hexes sunk 20 ft and 10 ft tops out at -10 ft: it stops an eye below that, never one at or above it", () => {
      const deep = H;
      const shallow = near(H, 0);
      const s = raised(g, [[deep, -20], [shallow, -10]]);
      const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
      // The side of `deep` toward `shallow`, between its corners 1 and 2, and a side of `shallow` toward the floor at 0.
      const side = (h: Hex, d: number) => {
        const cs = hexCorners(g, h).map((c) => cornerAt(g, c));
        return [cs[(d + 1) % 6]!, cs[(d + 2) % 6]!];
      };
      const blocks = (eye: number, [a, b]: { x: number; y: number }[]) => {
        const xy = walls.sight(eye).pieces;
        for (let k = 0; 4 * k < xy.length; k++) {
          const [px, py, qx, qy] = [xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!];
          if ((px === a!.x && py === a!.y && qx === b!.x && qy === b!.y) || (px === b!.x && py === b!.y && qx === a!.x && qy === a!.y)) return true;
        }
        return false;
      };
      const shared = side(deep, 0);
      assert.equal(blocks(-15, shared), true, "an eye below its top");
      assert.equal(blocks(-10, shared), false, "an eye at its top sees over it");
      assert.equal(blocks(-5, shared), false, "an eye above it");
      assert.equal(blocks(-5, side(shallow, 0)), true, "the side up to the floor still stops an eye below 0");
    });
  });

  describe(`${name}: a light stands on the hex under it`, () => {
    test("a lamp on a raised hex lights the floor past a lower ridge, as its eye 5 ft over that hex sees over it", () => {
      // Built on hex rows and mirrored onto columns: their keys, centers and bounds swap.
      const m = (h: Hex): Hex => (g.orient === "rows" ? h : { col: h.row, row: h.col });
      const lamp = m({ col: 10, row: 12 });
      const ridge = [9, 10, 11, 12, 13, 14, 15].map((row) => m({ col: 13, row }));
      const bounds = g.orient === "rows" ? { w: 32, h: 24 } : { w: 24, h: 32 };
      const s = raised(g, [[lamp, 20], ...ridge.map((h) => [h, 10] as [Hex, number])], [], bounds);
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true, vision: { on: true, light: "dark" } };
      const c = hexCenter(g, lamp);
      // The square under the lamp's center is another hex, at the floor, so a lamp read by squares stands 5 ft over the floor.
      assert.equal(footprintGround(s.buildChunks, { sceneId: "s1", size: "tiny", x: Math.floor(c.x), y: Math.floor(c.y) }) === 20, false);
      s.lights.l1 = { id: "l1", rev: 0, sceneId: "s1", x: c.x, y: c.y, bright: 40, dim: 0, on: true, walls: true };
      s.tokens.pc = on(g, "pc", m({ col: 18, row: 12 }), { kind: "pc", ownerIds: ["p1"], actor: { inline: actor({ senses: "" }) } });
      const target = on(g, "t", m({ col: 16, row: 12 }));
      const world: VisionWorld = { walls: sceneWalls };
      assert.equal(coldPartySight(s, "s1", world).seesToken(target, g), true);
      const low = { ...s, buildChunks: raised(g, ridge.map((h) => [h, 10] as [Hex, number]), [], bounds).buildChunks };
      assert.equal(coldPartySight(low, "s1", world).seesToken(target, g), false, "a lamp on the floor does not light past the ridge");
    });
  });
}
