import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { OpOf } from "../protocol.ts";
import { P1 } from "../testutil.ts";
import { occupiedHexes } from "./footprint.ts";
import { hexKey, type Hex, type HexGrid } from "./hex.ts";
import { findRouteOn } from "./hexWalk.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "./hexWalls.testkit.ts";
import { planMove } from "./moveLeg.ts";
import { hexStandPlace, onSqueezedLattice, ownWalk } from "./movement.ts";
import { groupWalkWorld } from "./walkWorld.ts";

/**
 * A creature its holder drags beside it on hexes walks full size, as it is
 * stored wherever it stops (FU35A-HEX-LATTICE-END, D-261029-171). Where a
 * Large holder squeezes, a Large creature dragged beside it stands on its
 * own squeezed anchors at the same points, and the leg test read it
 * squeezed there, so the server let it into a corridor one hex wide and
 * stored it full size in the rock, where the device's search found no way.
 */

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  /** Rock but for a corridor one hex wide along `across` 6, from 6 to 12 along. */
  const solid = (h: Hex) => {
    const along = g.orient === "rows" ? h.col : h.row;
    const across = g.orient === "rows" ? h.row : h.col;
    return along >= 6 && along <= 12 && across !== 6;
  };

  /** A Large warhorse west of the corridor dragging a Large ogre behind it, both P1's, or the ogre one no player sees. */
  function hall(ogre: Partial<Token> = {}): RoomState {
    const bounds = { w: 24, h: 16 };
    const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
    s.tokens.horse = onHex(g, "horse", "large", at(3, 6), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.ogre = onHex(g, "ogre", "large", at(1, 6), { name: "Ogre", kind: "npc", ownerIds: ["p1"], attached: { to: "horse", kind: "drag" }, ...ogre });
    return s;
  }

  /** The horse's walk into the corridor, squeezed, by the way it finds alone. */
  function intoCorridor(s: RoomState): OpOf<"token.move"> {
    const horse = s.tokens.horse!;
    const inside = hexStandPlace(g, horse, { size: "medium", ref: at(10, 6), squeezed: true });
    const found = findRouteOn({ ...groupWalkWorld(s, ownWalk(horse), { role: "player" }).input, towed: [] }, inside);
    assert.ok(found && found !== "none", "a way in for the horse alone");
    return { t: "token.move", tokenId: "horse", ...inside, squeeze: true, route: found.pieces.map(([x, y, extra, swim]): [number, number, number, 0 | 1] => [x, y, extra, swim]) };
  }

  describe(`${name}: a Large ogre dragged into a corridor one hex wide`, () => {
    test("the server refuses the walk the device's search finds no way for, as the ogre stands full size on its squeezed anchors", () => {
      const s = hall();
      const op = intoCorridor(s);
      const ogre = planMove(op, s, P1, {}).find((m) => m.tokenId === "ogre")!;
      assert.ok(onSqueezedLattice(g, s.tokens.ogre!, ogre.to), "the ogre's end lies on its squeezed anchors");
      const allowed = canApply(op, P1, s, { canUseAsset: () => true });
      assert.equal(allowed.ok ? "" : allowed.message, "A wall is in the way.");
      assert.equal(findRouteOn(groupWalkWorld(s, ownWalk(s.tokens.horse!), { role: "player" }).input, op), "none", "the device finds none with the ogre");
    });

    test("an ogre no player sees stops at the corridor's mouth from op version 32, and went into the rock at 31", () => {
      const s = hall({ visibility: "dm", ownerIds: [] });
      const op = intoCorridor(s);
      assert.ok(canApply(op, P1, s, { canUseAsset: () => true }).ok, "the player's walk is the horse's own");
      const end = (opVersion?: number) => {
        const ogre = planMove(op, s, P1, opVersion === undefined ? {} : { opVersion }).find((m) => m.tokenId === "ogre")!;
        return occupiedHexes(g, { ...s.tokens.ogre!, ...ogre.to });
      };
      for (const v of [undefined, 32]) assert.ok(end(v).every((h) => !solid(h)), `${v}: ${end(v).map(hexKey).join(" ")} clear of the rock`);
      assert.ok(end(31).some(solid), `31: ${end(31).map(hexKey).join(" ")} in the rock`);
    });
  });
}
