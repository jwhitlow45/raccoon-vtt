import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { hexCenter, type Hex } from "#shared/rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { measureWalk } from "./walkRuler.ts";

/**
 * The walking ruler on hexes (docs/design-v1-hex-grids.md phase H2): it
 * walks the six-neighbor lattice round walls, as a drag's route does, and
 * reads every hex as one step.
 */

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const W = 20;
  const H = 14;
  const bounds = g.orient === "rows" ? { w: W, h: H } : { w: H, h: W };

  /** A wall of rock across the run at 9, open at its near end, on a scene the players have seen whole. */
  function room(): RoomState {
    const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, (h) => (g.orient === "rows" ? h.col === 9 && h.row >= 2 : h.row === 9 && h.col >= 2)));
    s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
    return s;
  }

  describe(`${name}: the walking ruler`, () => {
    test("from open ground it walks round the rock's end, longer than the straight hexes through it", () => {
      const a = hexCenter(g, at(4, 8));
      const b = hexCenter(g, at(14, 8));
      const m = measureWalk({ view: room(), sceneId: "s1", stops: [a, b], viewer: { role: "player" }, everything: false })!;
      assert.equal(m.legs.length, 1);
      assert.ok(m.legs[0]!.corners.length > 0, "it bends");
      assert.ok(m.totalFt > 50, `${m.totalFt} ft: longer than the 50 ft straight through the rock`);
      assert.equal(m.totalFt % 5, 0, "whole hexes");
    });

    test("from a creature it walks the creature's own way, a Large one round the rock as well", () => {
      const s = room();
      s.tokens.ogre = onHex(g, "ogre", "large", at(4, 8));
      const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "ogre" }, hexCenter(g, at(14, 8))], viewer: { role: "dm" }, everything: false })!;
      assert.ok(m.legs[0]!.corners.length > 0);
      assert.ok(m.totalFt > 50);
    });
  });
}
