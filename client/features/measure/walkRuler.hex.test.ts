import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { hexAnchor, occupiedHexes } from "#shared/rules/footprint.ts";
import { hexCenter, hexKey, type Hex } from "#shared/rules/hex.ts";
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

    test("from open ground it starts on the hex under its first stop, wherever in that hex the stop lies", () => {
      const start = at(4, 8);
      const c = hexCenter(g, start);
      for (const [dx, dy] of [[0, 0], [0.3, 0.2], [-0.3, -0.2], [0.4, -0.1], [-0.1, 0.4]] as const) {
        const m = measureWalk({ view: room(), sceneId: "s1", stops: [{ x: c.x + dx, y: c.y + dy }, hexCenter(g, at(14, 8))], viewer: { role: "player" }, everything: false })!;
        const from = m.legs[0]!.from;
        assert.deepEqual([from.x + m.size.w / 2, from.y + m.size.h / 2].map((v) => Math.round(v * 1e9) / 1e9), [c.x, c.y].map((v) => Math.round(v * 1e9) / 1e9), `offset ${dx}, ${dy}`);
      }
    });

    test("a stop on a creature off its anchor is that creature's anchor, as the straight ruler reads it on hexes", () => {
      const s = room();
      const goal = at(14, 7);
      const a = hexCenter(g, at(4, 8));
      const offsets = [-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45].flatMap((dx) => [-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45].map((dy) => [dx, dy] as const));
      for (const [dx, dy] of offsets) {
        const gob = onHex(g, "gob", "medium", goal);
        s.tokens.gob = { ...gob, x: gob.x + dx, y: gob.y + dy };
        const m = measureWalk({ view: s, sceneId: "s1", stops: [a, { x: 0, y: 0, tokenId: "gob" }], viewer: { role: "dm" }, everything: false })!;
        const end = m.legs.at(-1)!.to;
        const c = hexAnchor(g, s.tokens.gob);
        assert.deepEqual([end.x + 0.5, end.y + 0.5].map((v) => Math.round(v * 1e9) / 1e9), [c.x, c.y].map((v) => Math.round(v * 1e9) / 1e9), `offset ${dx}, ${dy}`);
      }
    });

    test("from a creature it walks the creature's own way, a Large one round the rock as well", () => {
      const s = room();
      s.tokens.ogre = onHex(g, "ogre", "large", at(4, 8));
      const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "ogre" }, hexCenter(g, at(14, 8))], viewer: { role: "dm" }, everything: false })!;
      assert.ok(m.legs[0]!.corners.length > 0);
      assert.ok(m.totalFt > 50);
    });

    test("from a rider of a Large mount through a one-hex corridor, its legs run where the rider sits, on the mount's hex (D-261029-52)", () => {
      const solid = (h: Hex) => {
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return along >= 6 && along <= 12 && across !== 6;
      };
      const wide = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };
      const s = hexWallRoom(shape, wide.w, wide.h, wallsRound(g, wide, solid));
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
      s.tokens.horse = onHex(g, "horse", "large", at(2, 5), { name: "Warhorse" });
      for (const seat of occupiedHexes(g, s.tokens.horse!)) {
        s.tokens.brom = onHex(g, "brom", "medium", seat, { name: "Brom", attached: { to: "horse", kind: "ride", steer: true } });
        const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "brom" }, hexCenter(g, at(9, 6)), hexCenter(g, at(16, 6))], viewer: { role: "dm" }, everything: true })!;
        assert.equal(m.legs.length, 2);
        const points = m.legs.flatMap((leg) => [leg.from, ...leg.corners, leg.to]);
        for (const p of points) {
          const hexes = occupiedHexes(g, { size: "medium", x: p.x, y: p.y });
          assert.ok(!hexes.some(solid), `${hexes.map(hexKey)} from seat ${hexKey(seat)}: never in the rock`);
        }
        // The first stop is in the corridor, which the rider's leg ends in, on its mount's one hex there.
        const end = occupiedHexes(g, { size: "medium", ...m.legs[0]!.to })[0]!;
        assert.ok((g.orient === "rows" ? end.row : end.col) === 6 && (g.orient === "rows" ? end.col : end.row) >= 6, `${hexKey(end)} in the corridor`);
        // The next leg is planned from where the rider sits then, as a drag from it would be, so it ends on the stop's hex from any seat.
        assert.equal(hexKey(occupiedHexes(g, { size: "medium", ...m.legs[1]!.to })[0]!), hexKey(at(16, 6)), `from seat ${hexKey(seat)}`);
      }
    });
  });
}
