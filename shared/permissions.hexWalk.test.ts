import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "./model.ts";
import { canApply, HEX_STOP_OFF, NOT_A_SQUEEZE, ROUTE_OFF_HEXES, WALL_IN_THE_WAY_BACK, type PermissionDeps } from "./permissions.ts";
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

    test("a squeezed creature standing up in place where its full size does not fit is stopped, and where it fits it goes (review H2-OPUS-03)", () => {
      const { s, t } = corridorRoom();
      const inside = hexStandPlace(g, t, { size: "medium", ref: at(9, 6), squeezed: true });
      s.tokens.big = { ...t, ...inside, squeeze: true };
      assert.equal(decide({ t: "token.move", tokenId: "big", ...inside }, s), `forbidden: ${WALL_IN_THE_WAY}`);
      assert.equal(decide({ t: "token.move", tokenId: "big", ...inside, squeeze: true }, s), "ok", "staying squeezed moves nothing");
      const open = hexStandPlace(g, t, { size: "medium", ref: at(16, 3), squeezed: true });
      s.tokens.big = { ...t, ...open, squeeze: true };
      assert.equal(decide({ t: "token.move", tokenId: "big", ...open }, s), "ok", "in open ground it stands up");
      assert.equal(decide({ t: "token.move", tokenId: "big", ...inside }, s, DM), "ok", "the DM's moves are never stopped");
    });

    test("a group move into the corridor stands full size, which the walls stop: a group carries no squeeze (review H2-ASTRA-01)", () => {
      const { s, t } = corridorRoom();
      for (const ref of [at(7, 6), at(9, 6)]) {
        const inside = hexStandPlace(g, t, { size: "medium", ref, squeezed: true });
        assert.equal(decide({ t: "token.moveMany", moves: [{ tokenId: "big", ...inside }] }, s), `forbidden: ${WALL_IN_THE_WAY}`, `ref ${ref.col},${ref.row}`);
      }
      assert.equal(decide({ t: "token.moveMany", moves: [{ tokenId: "big", ...placedOnHex(g, t, at(3, 9)) }] }, s), "ok", "in open ground it goes");
    });

    /** The corridor room with the player's Large creature at its mouth and a Gargantuan beast of theirs over the corridor. */
    function withBeast(): { s: RoomState; t: Token } {
      const { s } = corridorRoom();
      const t = onHex(g, "big", "large", at(4, 6), { kind: "pc", actor: { ref: "ogre" }, ownerIds: ["p1"] });
      s.tokens.big = t;
      s.tokens.beast = onHex(g, "beast", "gargantuan", at(6, 6), { kind: "npc", ownerIds: ["p1"] });
      return { s, t };
    }

    test("a seat in the corridor is stepped onto full size, since a seat carries no squeeze", () => {
      const { s, t } = withBeast();
      const near = placedOnHex(g, t, at(4, 7));
      assert.equal(decide({ t: "token.attach", tokenId: "big", to: "beast", kind: "ride", steer: true, ...near, elevation: 0 }, s), "ok", "a seat it fits");
      const inside = hexStandPlace(g, t, { size: "medium", ref: at(7, 6), squeezed: true });
      assert.equal(decide({ t: "token.attach", tokenId: "big", to: "beast", kind: "ride", steer: true, ...inside, elevation: 0 }, s), `forbidden: ${WALL_IN_THE_WAY}`);
    });

    test("getting off into the corridor stands full size there, which the walls stop", () => {
      const { s, t } = withBeast();
      s.tokens.big = { ...t, attached: { to: "beast", kind: "ride" } };
      const inside = hexStandPlace(g, t, { size: "medium", ref: at(7, 6), squeezed: true });
      assert.equal(decide({ t: "token.detach", tokenId: "big", ...inside }, s), `forbidden: ${WALL_IN_THE_WAY}`);
      assert.equal(decide({ t: "token.detach", tokenId: "big", ...placedOnHex(g, t, at(3, 9)) }, s), "ok");
    });

    test("a redo into the corridor stands as it is put back: squeezed it goes, without the squeeze the walls stop it", () => {
      const { s, t } = corridorRoom();
      const inside = hexStandPlace(g, t, { size: "medium", ref: at(9, 6), squeezed: true });
      const redo = (value: object, routes?: Record<string, [number, number, number, 0 | 1][][]>): Op => ({ t: "sys.restore", entries: [{ key: "token:big", value: { ...t, ...value } }], from: "redo", deps: true, ...(routes ? { routes } : {}) });
      assert.equal(decide(redo({ ...inside, squeeze: true }), s), "ok");
      assert.equal(decide(redo(inside), s), `forbidden: ${WALL_IN_THE_WAY_BACK}`);
      const found = findRouteOn({ build: s, token: ownWalk(t), rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }, inside);
      assert.ok(found && found !== "none");
      const route = found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]);
      assert.equal(decide(redo({ ...inside, squeeze: true }, { big: [route] }), s), "ok", "along its route, squeezed where it ends");
      assert.equal(decide(redo(inside, { big: [route] }), s), `forbidden: ${WALL_IN_THE_WAY_BACK}`, "the route's end put back unsqueezed");
    });

    test("a redo of a creature dragged into the corridor stands it full size, since a drag carries no squeeze", () => {
      const { s, t } = withBeast();
      s.tokens.big = { ...t, attached: { to: "beast", kind: "drag" } };
      const inside = hexStandPlace(g, t, { size: "medium", ref: at(7, 6), squeezed: true });
      const op: Op = { t: "sys.restore", entries: [{ key: "token:beast", value: s.tokens.beast! }, { key: "token:big", value: { ...s.tokens.big, ...inside } }], from: "redo", deps: true };
      assert.equal(decide(op, s), `forbidden: ${WALL_IN_THE_WAY_BACK}`);
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
