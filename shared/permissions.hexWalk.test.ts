import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "./model.ts";
import { canApply, HEX_STOP_OFF, NOT_A_SQUEEZE, ROUTE_OFF_HEXES, type PermissionDeps } from "./permissions.ts";
import { opSchema, type Op } from "./protocol.ts";
import { placedOnHex } from "./rules/footprint.ts";
import type { Hex } from "./rules/hex.ts";
import { findRouteOn } from "./rules/hexWalk.ts";
import { hexStandPlace, ownWalk, WALL_IN_THE_WAY } from "./rules/movement.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, sideWall, wallsRound } from "./rules/hexWalls.testkit.ts";
import { character, DM, P1 } from "./testutil.ts";

/**
 * A player's walk on a hex scene that stops moves (docs/design-v1-hex-grids.md
 * phase H2): routes and squeezes go where the hex rules let them, each stop
 * of a route on an anchor, and the walls stop what crosses them.
 */
const deps: PermissionDeps = { canUseAsset: () => true };

function decide(op: Op, state: RoomState, who = P1): string {
  const d = canApply(opSchema.parse(op), who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const W = 22;
  const H = 16;
  const bounds = g.orient === "rows" ? { w: W, h: H } : { w: H, h: W };

  /** Rock across the scene, a one-row corridor through it, and the player's Large creature west of it. */
  function corridorRoom(): { s: RoomState; t: Token } {
    const solid = (h: Hex) => {
      const along = g.orient === "rows" ? h.col : h.row;
      const across = g.orient === "rows" ? h.row : h.col;
      return along >= 6 && along <= 12 && across !== 6;
    };
    const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
    s.characters.ogre = character("ogre", { ownerIds: ["p1"] });
    const t = onHex(g, "big", "large", at(2, 5), { kind: "pc", actor: { ref: "ogre" }, ownerIds: ["p1"] });
    s.tokens.big = t;
    return { s, t };
  }

  describe(`${name}: a player's walk on hexes`, () => {
    test("the route the search finds through the corridor goes, squeezed where it ends inside it", () => {
      const { s, t } = corridorRoom();
      const inside = hexStandPlace(g, t, { size: "medium", ref: at(9, 6), squeezed: true });
      const found = findRouteOn({ build: s, token: ownWalk(t), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }, inside);
      assert.ok(found && found !== "none");
      const route = found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]);
      assert.equal(decide({ t: "token.move", tokenId: "big", ...inside, squeeze: true, route }, s), "ok");
      // The same end without its squeeze stands it full size across the corridor's walls.
      assert.equal(decide({ t: "token.move", tokenId: "big", ...inside, route }, s), `invalid: ${HEX_STOP_OFF}`);
    });

    test("a plain leg into the rock is stopped, a route stop off its anchors refused, and the DM's moves never stopped", () => {
      const { s, t } = corridorRoom();
      const rock = placedOnHex(g, t, at(9, 2));
      assert.equal(decide({ t: "token.move", tokenId: "big", ...rock }, s), `forbidden: ${WALL_IN_THE_WAY}`);
      const off = { x: rock.x + 0.2, y: rock.y };
      assert.equal(decide({ t: "token.move", tokenId: "big", ...off, route: [[off.x, off.y, 0, 0]] }, s), `invalid: ${ROUTE_OFF_HEXES}`);
      assert.equal(decide({ t: "token.move", tokenId: "big", ...rock }, s, DM), "ok");
    });

    test("a squeeze in open ground beside a wall is refused: a full footprint holding it fits there", () => {
      const s = hexWallRoom(shape, bounds.w, bounds.h, [sideWall(g, at(9, 6), 1), sideWall(g, at(9, 6), 2), sideWall(g, at(9, 6), 0)]);
      s.characters.ogre = character("ogre", { ownerIds: ["p1"] });
      const t = onHex(g, "big", "large", at(3, 3), { kind: "pc", actor: { ref: "ogre" }, ownerIds: ["p1"] });
      s.tokens.big = t;
      const beside = hexStandPlace(g, t, { size: "medium", ref: at(9, 6), squeezed: true });
      assert.equal(decide({ t: "token.move", tokenId: "big", ...beside, squeeze: true }, s), `invalid: ${NOT_A_SQUEEZE}`);
      assert.equal(decide({ t: "token.move", tokenId: "big", ...beside, squeeze: true }, s, DM), `invalid: ${NOT_A_SQUEEZE}`, "the DM's squeeze too, which marks only a real one");
    });
  });
}
