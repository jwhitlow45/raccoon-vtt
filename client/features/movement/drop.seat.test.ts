import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "#shared/discoveryTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { OpOf } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { planMove } from "#shared/rules/moveLeg.ts";
import { occupiedHexes } from "#shared/rules/footprint.ts";
import { hexKey, hexNeighbors, type Hex } from "#shared/rules/hex.ts";
import { findRouteOn } from "#shared/rules/hexWalk.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, sideWall, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { hexStandPlace, ownWalk } from "#shared/rules/movement.ts";
import { routePoints, seatShift } from "#shared/rules/route.ts";
import { groupWalkWorld } from "#shared/rules/walkWorld.ts";
import { apply, DM, env, P1, room, scene, token } from "#shared/testutil.ts";
import { cutForWalkers, moveOpsOf, planOne, walkersStop } from "./drop.ts";
import { seenRoom } from "./testing.ts";

/**
 * A rider on a squeezing mount moves seat (D-261029-52, D-261029-53), and
 * what the rider drags moves with it, so the device's route search and its
 * cut for the creatures a drag takes along read each of them where the
 * server's move puts it (moveLeg.ts planMove), never at its offset from the
 * mount (review DP34-ASTRA-01). The player owns all three, so the walls
 * stop each of them.
 */

/** The server's move, and where it leaves the rider and what it drags. */
function served(s: RoomState, op: OpOf<"token.move">): RoomState {
  const allowed = canApply(op, P1, s, { canUseAsset: () => true });
  assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
  const r = applyOp(s, op, P1, env(1));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

/** The device's judgment of the mount's walk to `to`: its route search finds a way, and no creature it takes along cuts the walk. */
function deviceTakes(s: RoomState, to: { x: number; y: number }, squeeze: boolean): void {
  const horse = s.tokens.horse!;
  const world = groupWalkWorld(s, ownWalk(horse), { role: "player" });
  assert.ok(world.input.towed?.some((t) => t.id === "gob"), "the goblin walks with the search");
  const found = findRouteOn(world.input, to);
  assert.ok(found !== "none", "the route search finds a way in");
  const walkers = [s.tokens.gob!];
  const route = found ? found.pieces : undefined;
  const points = route ? routePoints(s.buildChunks, ownWalk(horse), route, horse.elevation) : [{ x: horse.x, y: horse.y, elevation: 0 }, { x: to.x, y: to.y, elevation: 0 }];
  assert.equal(walkersStop(s, ownWalk(horse), points, walkers, { ...(route ? { route } : {}), squeeze }), null, "no cut for the goblin");
}

/**
 * The device's cut of the mount's walk along `route` to `to` where the goblin cannot follow: the walk is cut short, and every
 * op it sends is one the server takes as it stands, ending full as a cut lands (review DP34-ASTRA-04).
 */
function cutTaken(s: RoomState, to: { x: number; y: number }, route: [number, number, number, 0 | 1][]): void {
  const horse = s.tokens.horse!;
  const plan = cutForWalkers(seenRoom(s), horse, { moves: [{ tokenId: "horse", ...to, route }], stop: null, held: [] }, [s.tokens.gob!], "walk");
  assert.ok(plan.stop, "the walk is cut where the goblin cannot follow");
  for (const op of moveOpsOf(plan.moves)) {
    const allowed = canApply(op, P1, s, { canUseAsset: () => true });
    assert.ok(allowed.ok, `${JSON.stringify(op)}: ${allowed.ok ? "" : allowed.message}`);
  }
}

describe("squares: a rider on a Large mount drags a goblin into a corridor one square wide", () => {
  function keep(): RoomState {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    const runs: [[number, number], [number, number]][] = [[[8, 0], [8, 10]], [[8, 11], [8, 20]], [[16, 0], [16, 10]], [[16, 11], [16, 20]], [[8, 10], [16, 10]], [[8, 11], [16, 11]]];
    runs.forEach(([a, b], i) => wall(s, `fu35fx${String(i).padStart(6, "0")}`, a, b));
    s.tokens.horse = token("horse", { size: "large", x: 3, y: 9, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.brom = token("brom", { x: 4, y: 10, name: "Brom", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    s.tokens.gob = token("gob", { x: 3, y: 10, name: "Goblin", ownerIds: ["p1"], attached: { to: "brom", kind: "drag" } });
    return s;
  }

  test("the server puts Brom on the mount's square and the goblin behind him, and the device's search and cut agree", () => {
    const s = keep();
    const inside = { x: 11.5, y: 9.5 };
    const after = served(s, { t: "token.move", tokenId: "horse", ...inside, squeeze: true });
    assert.deepEqual([after.tokens.brom!.x, after.tokens.brom!.y], [12, 10]);
    assert.deepEqual([after.tokens.gob!.x, after.tokens.gob!.y], [11, 10]);
    assert.equal(after.tokens.gob!.attached?.to, "brom");
    deviceTakes(s, inside, true);
  });

  test("a walk through the corridor the goblin cannot follow out of is cut where the server takes it, Brom on his own seat there", () => {
    const s = keep();
    // Brom on the mount's top left square, the goblin beside him, and a stub of wall at the corridor's far end that only the goblin meets.
    s.tokens.brom = { ...s.tokens.brom!, x: 3, y: 9 };
    s.tokens.gob = { ...s.tokens.gob!, x: 2, y: 9 };
    wall(s, "fu35fx000009", [16, 10], [16.5, 10]);
    cutTaken(s, { x: 20, y: 9 }, [[6, 9.5, 0, 0], [7.5, 9.5, 1, 0], [11.5, 9.5, 1, 0], [17, 9.5, 1, 0], [20, 9, 0, 0]]);
  });

  test("a route that stops half a square off the grid in the corridor seats Brom on the mount's square there, for the server and the device's cut alike", () => {
    const s = keep();
    // Each point past the start squeezes, the middle one off the grid, where only the walk's own pinch reads the squeeze.
    const route: [number, number, number, 0 | 1][] = [[6, 9.5, 0, 0], [7.5, 9.5, 0, 0], [9, 9.5, 0, 0], [11.5, 9.5, 0, 0]];
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 11.5, y: 9.5, squeeze: true, route };
    const at = (id: string) => planMove(op, s, P1, {}).find((m) => m.tokenId === id)!.route.map((p) => [p.x, p.y]);
    assert.deepEqual(at("brom")[3], [9.5, 10], "on the mount's square, off the grid as the mount is");
    assert.deepEqual(at("gob")[3], [8.5, 10], "behind him in the corridor");
    served(s, op);
    const horse = s.tokens.horse!;
    const points = routePoints(s.buildChunks, ownWalk(horse), route, horse.elevation);
    assert.equal(walkersStop(s, ownWalk(horse), points, [s.tokens.gob!], { route, squeeze: true }), null, "no cut for the goblin");
  });
});

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const bounds = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };

  describe(`${name}: a rider on a Large mount drags a goblin into a corridor one hex wide`, () => {
    function keep(): RoomState {
      const solid = (h: Hex) => {
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return along >= 6 && along <= 12 && across !== 6;
      };
      const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
      s.tokens.horse = onHex(g, "horse", "large", at(3, 6), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      // Brom on the mount's lower hex toward the rock's side of the corridor, the goblin he drags on the hex before his along the corridor.
      const seat = occupiedHexes(g, s.tokens.horse!).find((h) => (g.orient === "rows" ? h.row : h.col) === 7)!;
      s.tokens.brom = onHex(g, "brom", "medium", seat, { name: "Brom", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
      s.tokens.gob = onHex(g, "gob", "medium", g.orient === "rows" ? { col: seat.col - 1, row: seat.row } : { col: seat.col, row: seat.row - 1 }, { name: "Goblin", ownerIds: ["p1"], attached: { to: "brom", kind: "drag" } });
      return s as RoomState & { tokens: Record<string, Token> };
    }

    test("the server puts Brom on the mount's hex and the goblin on the corridor's hex behind him, and the device's search and cut agree", () => {
      const s = keep();
      const inside = hexStandPlace(g, s.tokens.horse!, { size: "medium", ref: at(10, 6), squeezed: true });
      const after = served(s, { t: "token.move", tokenId: "horse", ...inside, squeeze: true });
      assert.deepEqual(occupiedHexes(g, after.tokens.brom!).map(hexKey), [hexKey(at(10, 6))]);
      assert.deepEqual(occupiedHexes(g, after.tokens.gob!).map(hexKey), [hexKey(at(9, 6))]);
      assert.equal(after.tokens.gob!.attached?.to, "brom");
      deviceTakes(s, inside, true);
    });

    test("a walk through the corridor and out that the goblin cannot follow is cut where the server takes it, at a hex the mount stands on full size", () => {
      const s = keep();
      const horse = s.tokens.horse!;
      // Out past the corridor's far end, standing up there, by the way the mount alone finds, its squeezed piece split halfway.
      const out = hexStandPlace(g, horse, { size: "large", ref: at(14, 6), squeezed: false });
      const found = findRouteOn({ ...groupWalkWorld(s, ownWalk(horse), { role: "player" }).input, towed: [] }, out);
      assert.ok(found && found !== "none", "a way for the mount alone");
      const halfway = hexStandPlace(g, horse, { size: "medium", ref: at(9, 6), squeezed: true });
      const route = found.pieces.flatMap(([x, y, extra, swim]): [number, number, number, 0 | 1][] => (extra === 1 ? [[halfway.x, halfway.y, 1, 0], [x, y, 1, swim]] : [[x, y, extra, swim]]));
      assert.equal(route.length, found.pieces.length + 1, "one squeezed piece");
      cutTaken(s, out, route);
    });
  });
}

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  describe(`${name}: a rider a little off its seat drags a goblin on a walk that never squeezes`, () => {
    test("the server and the device put the goblin beside Brom on his seat, so a drop the device sends is one the server takes (review DP34-OPUS-10)", () => {
      const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
      let s = hexWallRoom(shape, 20, 20, []);
      s.tokens.horse = onHex(g, "horse", "large", { col: 6, row: 6 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const seat = occupiedHexes(g, s.tokens.horse!)[1]!;
      s.tokens.brom = onHex(g, "brom", "medium", seat, { name: "Brom", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
      s.tokens.gob = onHex(g, "gob", "medium", hexNeighbors(g, seat)[0]!, { name: "Goblin", ownerIds: ["p1"], attached: { to: "brom", kind: "drag" } });
      // Nudged a little off his seat's anchor, across the grid's rows or columns, Brom still rides and still drags the goblin.
      const [nx, ny] = g.orient === "rows" ? [0.3, 0.4] : [0.4, 0.3];
      s = apply(s, { t: "token.update", tokenId: "brom", patch: { x: s.tokens.brom!.x + nx, y: s.tokens.brom!.y + ny } }, DM);
      assert.equal(s.tokens.brom!.attached?.to, "horse");
      assert.equal(s.tokens.gob!.attached?.to, "brom");
      const horse = s.tokens.horse!;
      // Three rows or columns over, where the nudged offset falls in another hex than his seat's.
      const to = hexStandPlace(g, horse, { size: "large", ref: g.orient === "rows" ? { col: 6, row: 9 } : { col: 9, row: 6 }, squeezed: false });
      // Walls round the hex the goblin's old offset from the mount would take it to, beside the one his seat takes it to.
      const gob = s.tokens.gob!;
      const offset = occupiedHexes(g, { ...gob, x: gob.x + to.x - horse.x, y: gob.y + to.y - horse.y })[0]!;
      const by = seatShift(g, horse, (id) => s.tokens[id], "gob", to, false);
      assert.notEqual(hexKey(occupiedHexes(g, { ...gob, x: gob.x + to.x - horse.x + by.x, y: gob.y + to.y - horse.y + by.y })[0]!), hexKey(offset), "the seat and the offset part");
      for (let d = 0; d < 6; d++) s.buildChunks = hexWallRoom(shape, 20, 20, [...Object.values(s.buildChunks).flatMap((c) => c.walls ?? []), sideWall(g, offset, d)]).buildChunks;
      const view = seenRoom(s);
      const plan = cutForWalkers(view, horse, planOne(view, horse, to, "walk"), [gob], "walk");
      for (const op of moveOpsOf(plan.moves)) {
        const allowed = canApply(op, P1, s, { canUseAsset: () => true });
        assert.ok(allowed.ok, `${JSON.stringify(op)}: ${allowed.ok ? "" : allowed.message}`);
      }
    });
  });
}
