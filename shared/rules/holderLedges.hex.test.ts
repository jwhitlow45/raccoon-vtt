import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, wallChunk } from "../keys.ts";
import type { FreeWall, GridShape, RoomState, Token } from "../model.ts";
import type { Op } from "../protocol.ts";
import { apply, chance, DM, int, pick, rng, room, scene, token } from "../testutil.ts";
import { walkerFor } from "./attach.ts";
import { footprintRect, occupiedHexes, placedOnHex } from "./footprint.ts";
import { SQUARES } from "./grid.ts";
import { hexInScene, hexKey, hexLine, hexNeighbors, sceneHexes, type Hex, type HexGrid } from "./hex.ts";
import { HexWalkSearch, HexWalkWorld, findRouteOn, routeLegCheck } from "./hexWalk.ts";
import { COLUMNS, ROWS, sideWall } from "./hexWalls.testkit.ts";
import { legStop, type Walker } from "./movement.ts";
import { routeStop } from "./route.ts";
import { planTrapMove, type TrapRoom } from "./traps.ts";
import type { WalkInput } from "./walk.ts";

/**
 * A walk off a holder on hexes crosses the raised sides between two of the
 * holder's hexes until it first stands clear of them, as a walk off a
 * holder on squares crosses the ledges inside its footprint (HX8-RIDER-LEDGE,
 * D-261029-170): so a rider gets off a mount that straddles two heights,
 * on the server's leg test, on the device's route search and in a trap's
 * stop, and an op stored before version 32 replays by the old rule, where
 * every such side stopped her.
 */

const RULES = { feetPerCell: 5, diagonal: "five" as const };
const ALL = () => true;

function shapeOf(g: HexGrid): GridShape {
  return g.orient === "rows" ? "hexRows" : "hexColumns";
}

function on(g: HexGrid, id: string, size: Token["size"], ref: Hex, over: Partial<Token> = {}): Token {
  const base = token(id, { sceneId: "s1", name: id, size, x: 0, y: 0, ...over });
  return { ...base, ...placedOnHex(g, base, ref) };
}

/** A hex scene whose walls and ledges stop moves, with ground painted through the reducer. */
function raised(g: HexGrid, heights: readonly [Hex, number][]): RoomState {
  let s = room({ scenes: { s1: scene("s1", { gridShape: shapeOf(g), bounds: { w: 20, h: 14 }, blockMovement: true }) } });
  for (const [h, height] of heights) s = apply(s, { t: "build.height", sceneId: "s1", cells: [hexKey(h)], height } as Op);
  return s;
}

/**
 * A Large warhorse whose reference hex is raised 10 ft above its other two
 * hexes, and Bree riding it on the raised hex. `low` is one of the low two,
 * `off` the hex beyond it straight from Bree's, outside the horse, and
 * `cliff` a hex beside Bree's outside the horse, below her.
 */
function straddling(g: HexGrid): { s: RoomState; bree: Token; low: Hex; off: Hex; cliff: Hex } {
  const horseAt: Hex = { col: 8, row: 6 };
  const probe = on(g, "horse", "large", horseAt);
  const hexes = occupiedHexes(g, probe);
  const high = hexes[0]!;
  const low = hexes[1]!;
  const s = raised(g, [[high, 10]]);
  s.tokens.horse = { ...probe, kind: "npc", elevation: 10 };
  const bree = on(g, "bree", "medium", high, { kind: "pc", elevation: 10, ownerIds: ["p1"], attached: { to: "horse", kind: "ride" } });
  s.tokens.bree = bree;
  const d = hexNeighbors(g, high).findIndex((n) => n.col === low.col && n.row === low.row);
  const off = hexNeighbors(g, low)[d]!;
  const held = new Set(hexes.map(hexKey));
  assert.ok(!held.has(hexKey(off)), "the hex beyond the low one is off the horse");
  const cliff = hexNeighbors(g, high).find((n) => !held.has(hexKey(n)))!;
  return { s, bree, low, off, cliff };
}

/** Adds free walls to the scene's chunks (hexWalls.testkit.ts hexWallRoom). */
function walled(s: RoomState, walls: readonly FreeWall[]): void {
  for (const wall of walls) {
    const { cx, cy } = wallChunk(wall);
    const key = chunkKey("s1", cx, cy);
    const chunk = s.buildChunks[key] ?? { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {} };
    s.buildChunks[key] = { ...chunk, walls: [...(chunk.walls ?? []), wall] };
  }
}

function input(s: RoomState, walker: Walker): WalkInput {
  return { build: s, token: walker, rules: RULES, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
}

const at = (g: HexGrid, t: Token, h: Hex) => placedOnHex(g, t, h);

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: getting off a mount that straddles a step`, () => {
    test("Bree crosses the step under the horse and walks off its low side, and op version 30 stops her at it", () => {
      const { s, bree, low, off } = straddling(g);
      const to = { ...at(g, bree, off), elevation: 0, squeeze: false };
      assert.equal(legStop(s, walkerFor(s, bree, ALL, { to }), to), null, "live");
      assert.equal(legStop(s, walkerFor(s, bree, ALL, { opVersion: 32, to }), to), null, "op 32");
      assert.equal(legStop(s, walkerFor(s, bree, ALL, { opVersion: 31, to }), to)?.blocker, "ledge", "op 31");
      // A step onto the low hex keeps her on the horse, and crosses the step too.
      const onto = { ...at(g, bree, low), elevation: 0, squeeze: false };
      assert.equal(legStop(s, walkerFor(s, bree, ALL, { to: onto }), onto), null, "onto the low hex");
    });

    test("she steps off no cliff at the horse's side, and a flat walk off it is no different", () => {
      const { s, bree, cliff } = straddling(g);
      const to = { ...at(g, bree, cliff), elevation: 0, squeeze: false };
      assert.equal(legStop(s, walkerFor(s, bree, ALL, { to }), to)?.blocker, "ledge");
    });

    test("once clear of the horse the walk meets the step again, coming back over it", () => {
      const { s, bree, low, off } = straddling(g);
      const seat = { x: bree.x, y: bree.y };
      const walker = walkerFor(s, bree, ALL);
      const route: [number, number, number, 0][] = [
        [at(g, bree, off).x, at(g, bree, off).y, 0, 0],
        [at(g, bree, low).x, at(g, bree, low).y, 0, 0],
        [seat.x, seat.y, 0, 0],
      ];
      assert.deepEqual(routeStop(s, walker, route, 10), { piece: 2, blocker: "ledge" }, "the last piece climbs back over the step past the horse");
      assert.equal(routeStop(s, walker, route.slice(0, 1), 0), null, "the first piece alone is off");
    });

    test("she is clear of the horse once she shares none of its hexes, though her box still overlaps its box", () => {
      const { s, bree } = straddling(g);
      const hexes = occupiedHexes(g, s.tokens.horse!);
      const [high, low] = [hexes[0]!, hexes[1]!];
      const held = new Set(hexes.map(hexKey));
      const box = footprintRect(SQUARES, s.tokens.horse!);
      // A hex beside both, off the horse, where a Medium box still overlaps the horse's box.
      const beside = hexNeighbors(g, high).find((n) => {
        if (held.has(hexKey(n)) || !hexNeighbors(g, low).some((m) => m.col === n.col && m.row === n.row)) return false;
        const b = footprintRect(SQUARES, { ...bree, ...at(g, bree, n) });
        return b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h;
      })!;
      assert.ok(beside, "a hex off the horse under its box");
      const seated = { ...bree, ...at(g, bree, low) };
      s.tokens.bree = seated;
      const route: [number, number, number, 0][] = [
        [at(g, bree, beside).x, at(g, bree, beside).y, 0, 0],
        [seated.x, seated.y, 0, 0],
        [at(g, bree, high).x, at(g, bree, high).y, 0, 0],
      ];
      assert.deepEqual(routeStop(s, walkerFor(s, seated, ALL), route, 10), { piece: 2, blocker: "ledge" }, "back on the low hex past the horse, the step stops her");
    });

    test("the search finds no way back onto the horse over its step once it has left it", () => {
      const { s, bree } = straddling(g);
      const hexes = occupiedHexes(g, s.tokens.horse!);
      const [high, low, other] = [hexes[0]!, hexes[1]!, hexes[2]!];
      // Walls between her low hex and the other two, so the only way up is out, round to the other low hex, and over the step.
      const toward = (a: Hex, b: Hex) => hexNeighbors(g, a).findIndex((n) => n.col === b.col && n.row === b.row);
      walled(s, [sideWall(g, low, toward(low, high)), sideWall(g, low, toward(low, other))]);
      const seated = { ...bree, ...at(g, bree, low) };
      s.tokens.bree = seated;
      const walker = walkerFor(s, seated, ALL);
      const world = new HexWalkWorld(input(s, walker));
      assert.equal(new HexWalkSearch(world).routeTo(at(g, bree, other)) !== null, true, "the other low hex, round the outside");
      assert.equal(new HexWalkSearch(new HexWalkWorld(input(s, walker))).routeTo(at(g, bree, high)), null, "no way up the step from off the horse");
    });

    test("the device's search finds the way off, a way the server takes, and none at op version 30", () => {
      const { s, bree, off } = straddling(g);
      const to = at(g, bree, off);
      const walker = walkerFor(s, bree, ALL);
      const route = new HexWalkSearch(new HexWalkWorld(input(s, walker))).routeTo(to);
      assert.ok(route, "a way off");
      assert.equal(routeStop(s, walker, route.pieces, 0), null, "the server's leg test takes every piece");
      assert.notEqual(findRouteOn(input(s, walker), to), "none");
      assert.equal(findRouteOn(input(s, walkerFor(s, bree, ALL, { opVersion: 31 })), to), "none", "op 31");
      // The straight leg's own check, before any search, reads the step as the server does: not stopped.
      const check = routeLegCheck(new HexWalkWorld(input(s, walker)), to);
      check.run(() => false);
      assert.equal(check.stopped, false, "the straight leg is not stopped");
    });

    test("a trap past the step stops her on it from op version 32, and at 31, where no spot past the step was a stand, she walks on", () => {
      const { s, bree, low, off } = straddling(g);
      const d = hexNeighbors(g, low).findIndex((n) => n.col === off.col && n.row === off.row);
      const beyond = hexNeighbors(g, off)[d]!;
      const plate = { id: "plate", rev: 0, sceneId: "s1", name: "plate", zone: { cells: [{ x: off.col, y: off.row, w: 1, h: 1 }] }, state: "armed" as const, found: false, grid: shapeOf(g), rig: { on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false } };
      const before: TrapRoom = { ...s, traps: { plate } };
      const op: Op = { t: "token.move", tokenId: "bree", ...at(g, bree, beyond), elevation: 0 };
      const stopAt = (opVersion?: number) => {
        const plan = planTrapMove(op, before, DM, opVersion === undefined ? {} : { opVersion });
        assert.deepEqual(plan.springings.map((x) => x.trap.id), ["plate"], `${opVersion}: the plate goes off`);
        const moved = plan.op as Extract<Op, { t: "token.move" }>;
        return { x: moved.x, y: moved.y };
      };
      assert.deepEqual(stopAt(), at(g, bree, off), "live: on the plate");
      assert.deepEqual(stopAt(32), at(g, bree, off), "op 32");
      assert.deepEqual(stopAt(31), at(g, bree, beyond), "op 31");
    });
  });
}

describe("a rider's walk off a mount on random steps: the search's way is the server's, and it finds one wherever the straight leg goes", () => {
  test("rows and columns, a Medium rider on a Large or Huge mount and a Large one on a Gargantuan mount, on a random seat", () => {
    const r = rng(37);
    let routes = 0;
    let straight = 0;
    for (let i = 0; i < 120; i++) {
      const g = i % 2 === 0 ? ROWS : COLUMNS;
      const size = pick(r, ["large", "huge", "gargantuan"] as const);
      const rider = size === "gargantuan" ? "large" : "medium";
      const probe = on(g, "horse", size, { col: int(r, 6, 10), row: int(r, 5, 8) });
      const hexes = occupiedHexes(g, probe);
      const held = new Set(hexes.map(hexKey));
      const near = new Map<string, Hex>();
      for (const h of hexes) for (const n of [h, ...hexNeighbors(g, h)]) near.set(hexKey(n), n);
      const heights: [Hex, number][] = [...near.values()].filter(() => chance(r, 0.5)).map((h) => [h, pick(r, [5, 10, 15])]);
      const s = raised(g, heights);
      const ground = (h: Hex) => heights.find(([k]) => k.col === h.col && k.row === h.row)?.[1] ?? 0;
      const top = Math.max(...hexes.map(ground));
      s.tokens.horse = { ...probe, kind: "npc", elevation: top };
      const seat = pick(r, hexes.filter((h) => occupiedHexes(g, on(g, "bree", rider, h)).every((k) => held.has(hexKey(k)))));
      const bree = on(g, "bree", rider, seat, { kind: "pc", elevation: top, ownerIds: ["p1"], attached: { to: "horse", kind: "ride" } });
      s.tokens.bree = bree;
      const targets = sceneHexes(g, s.scenes.s1!.bounds).filter((h) => hexLine(g, seat, h).length <= 5 && hexInScene(g, s.scenes.s1!.bounds, h));
      for (let k = 0; k < 4; k++) {
        const target = pick(r, targets);
        const to = at(g, bree, target);
        if (to.x === bree.x && to.y === bree.y) continue;
        const walker = walkerFor(s, bree, ALL, { to });
        const route = new HexWalkSearch(new HexWalkWorld(input(s, walker))).routeTo(to);
        const label = `${g.orient} ${rider} on ${size}, seat ${hexKey(seat)} to ${hexKey(target)}`;
        if (route) {
          routes++;
          const end = route.points[route.points.length - 1]!;
          assert.equal(routeStop(s, walker, route.pieces, end.elevation), null, `${label}: the server takes the way found`);
        }
        const leg = { ...to, elevation: Math.max(...occupiedHexes(g, { ...bree, ...to }).map(ground)), squeeze: false };
        if (legStop(s, walker, leg) === null) {
          straight++;
          assert.ok(route, `${label}: the straight leg goes, so the search finds a way`);
        }
      }
    }
    assert.ok(routes > 100 && straight > 50, `${routes} ways found, ${straight} straight legs allowed`);
  });
});
