import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "../model.ts";
import { DM } from "../testutil.ts";
import { placedOnHex } from "./footprint.ts";
import type { Hex } from "./hex.ts";
import { findRouteOn, HexWalkWorld, routeWorld } from "./hexWalk.ts";
import { planMove } from "./moveLeg.ts";
import { legStop, ownWalk } from "./movement.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "./hexWalls.testkit.ts";
import type { WalkRoute } from "./walk.ts";
import { groupWalkWorld } from "./walkWorld.ts";

/**
 * A creature dragged on a hex scene (docs/design-v1-attach.md 4.2 on
 * docs/design-v1-hex-grids.md phase H2): where walls stop moves, the way
 * a drag finds for its holder is one the creature it drags beside it fits
 * through too, and the server's test of the dragged creature's legs
 * (permissions.ts draggedWalls) takes every route found.
 */

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const W = 20;
  const H = 14;
  const bounds = g.orient === "rows" ? { w: W, h: H } : { w: H, h: W };

  /** Thorn at 4,6 drags a goblin of `size` on the hex beside him, across a wall of rock at 9 with a gap at `gap`. */
  function hall(gap: (across: number) => boolean, size: Token["size"] = "medium"): RoomState {
    const rock = (h: Hex) => (g.orient === "rows" ? h.col === 9 && !gap(h.row) : h.row === 9 && !gap(h.col));
    const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, rock));
    s.tokens.thorn = onHex(g, "thorn", "medium", at(4, 6), { name: "Thorn" });
    s.tokens.gob = onHex(g, "gob", size, at(4, 7), { name: "Goblin", attached: { to: "thorn", kind: "drag" } });
    return s;
  }

  const thornIn = (s: RoomState) => ownWalk(s.tokens.thorn! as Token);

  /** Whether the server's leg test takes every leg of the goblin's walk beside Thorn's route. */
  function goblinFollows(s: RoomState, route: WalkRoute): boolean {
    const end = route.points[route.points.length - 1]!;
    const moved = planMove({ t: "token.move", tokenId: "thorn", x: end.x, y: end.y, route: route.pieces.map(([x, y, extra, swim]) => [x, y, extra, swim]) }, s, DM, {}).find((m) => m.tokenId === "gob")!;
    for (let i = 1; i < moved.route.length; i++) if (legStop(s, moved.trace[i - 1]!, moved.route[i]!) !== null) return false;
    return true;
  }

  describe(`${name}: dragging beside the holder`, () => {
    test("a gap two hexes wide takes them both: the way found goes through it, and the server's test of the goblin's legs takes it", () => {
      const s = hall((across) => across === 8 || across === 9);
      const to = placedOnHex(g, s.tokens.thorn!, at(14, 6));
      const world = groupWalkWorld(s, thornIn(s), { role: "dm" });
      assert.equal(world.input.towed?.length, 1);
      const route = findRouteOn(world.input, to);
      assert.ok(route && route !== "none", "a way through");
      assert.equal(goblinFollows(s, route), true);
    });

    test("a gap of one hex lets Thorn through alone, and the drag finds no way, naming the goblin", () => {
      // A Tiny goblin costs no extra foot, so only the goblin's own leg keeps the plain drop from being the way.
      for (const size of ["medium", "tiny"] as const) checkOneGap(size);
    });

    function checkOneGap(size: Token["size"]): void {
      const s = hall((across) => across === 6, size);
      const to = placedOnHex(g, s.tokens.thorn!, at(14, 6));
      const world = groupWalkWorld(s, thornIn(s), { role: "dm" });
      assert.equal(findRouteOn(world.input, to), "none");
      const { towed: _towed, ...alone } = world.input;
      const own = findRouteOn(alone, to);
      // Straight through the gap: the plain drop is Thorn's own way, which the goblin beside him cannot walk.
      const points = own === null ? [thornIn(s), to] : own === "none" ? assert.fail("Thorn alone has a way") : own.points;
      const hexWorld = routeWorld(world.input);
      assert.ok(hexWorld instanceof HexWalkWorld);
      assert.equal(hexWorld.towedFollow(to), false);
      assert.equal(hexWorld.cannotFollow(points), "gob");
    }

    test("on open ground the way is the straight line, one piece at the drag's extra foot, and the goblin follows it", () => {
      const s = hall(() => true);
      const to = placedOnHex(g, s.tokens.thorn!, at(14, 6));
      const world = groupWalkWorld(s, thornIn(s), { role: "dm" });
      const route = findRouteOn(world.input, to);
      assert.ok(route && route !== "none");
      assert.deepEqual(route.pieces, [[to.x, to.y, 1, 0]]);
      assert.equal(goblinFollows(s, route), true);
      const hexWorld = routeWorld(world.input) as HexWalkWorld;
      assert.equal(hexWorld.towedFollow(to), true);
      assert.equal(hexWorld.cannotFollow([thornIn(s), to]), null);
    });
  });
}
