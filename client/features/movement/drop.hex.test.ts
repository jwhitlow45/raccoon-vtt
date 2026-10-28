import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Op } from "#shared/protocol.ts";
import { canApply } from "#shared/permissions.ts";
import { hexCenter, sceneHexes, type Hex } from "#shared/rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, sideWall, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { character, int, pick, rng } from "#shared/testutil.ts";
import { dragOf } from "./dragTesting.ts";
import { onTurn, recordedCost } from "./testing.ts";

/**
 * A player's drag on a hex scene that stops moves, as the board takes it
 * (docs/design-v1-hex-grids.md phase H2): the search's route, the drop's
 * landing held at a wall or squeezed into a narrow space, and the op it
 * sends. The server takes every op the board sends, and the drag's label
 * reads what the move records on the turn, as on squares (review MV-O-24,
 * ASTRA-18).
 */

for (const [name, g] of [["hex rows", ROWS], ["hex columns", COLUMNS]] as const) {
  const shape = g.orient === "rows" ? "hexRows" : "hexColumns";
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const W = 22;
  const H = 16;
  const bounds = g.orient === "rows" ? { w: W, h: H } : { w: H, h: W };

  describe(`${name}: a player's drag`, () => {
    test("through a one-row corridor, a Large creature walks it squeezed and stops squeezed inside it", () => {
      const solid = (h: Hex) => {
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return along >= 6 && along <= 12 && across !== 6;
      };
      const s = hexWallRoom(shape, bounds.w, bounds.h, wallsRound(g, bounds, solid));
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
      s.characters.ogre = character("ogre", { ownerIds: ["p1"] });
      s.tokens.big = onHex(g, "big", "large", at(2, 5), { kind: "pc", actor: { ref: "ogre" }, ownerIds: ["p1"] });
      const view = onTurn(s, "big");
      const inside = hexCenter(g, at(9, 6));
      const drag = dragOf(view, "player", "big", { x: inside.x - 1, y: inside.y - 1 });
      const op = drag.op as Extract<Op, { t: "token.move" }>;
      assert.ok(op && op.t === "token.move" && op.route, "a route");
      assert.equal(op.squeeze, true, "squeezed where it stops");
      assert.ok(canApply(op, { role: "player", memberId: "p1" }, view, { canUseAsset: () => true }).ok);
      assert.equal(drag.preview.read.dragFt, recordedCost(view, op, "big"), "the label reads what the move records");
    });

    test("random drops over random walls: the server takes every op, the picture ends where the drop lands, the label reads the recorded cost", () => {
      const r = rng(g.orient === "rows" ? 71 : 72);
      let routed = 0;
      for (let trial = 0; trial < 24; trial++) {
        const hexes = sceneHexes(g, { w: 14, h: 11 });
        const walls = hexes.flatMap((h) => [0, 1, 2].filter(() => r() < 0.12).map((d) => sideWall(g, h, d)));
        const s = hexWallRoom(shape, 14, 11, walls);
        s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: false };
        s.characters.c = character("c", { ownerIds: ["p1"] });
        s.tokens.mover = onHex(g, "mover", pick(r, ["medium", "large", "huge"] as const), pick(r, hexes), { kind: "pc", actor: { ref: "c" }, ownerIds: ["p1"] });
        const view = onTurn(s, "mover");
        for (let k = 0; k < 3; k++) {
          const c = hexCenter(g, pick(r, hexes));
          const raw = { x: c.x - 0.5 + (int(r, -20, 20) / 100), y: c.y - 0.5 + int(r, -20, 20) / 100 };
          const drag = dragOf(view, "player", "mover", raw);
          const op = drag.op;
          if (!op) continue;
          const label = `trial ${trial}.${k}: ${JSON.stringify(op)}`;
          const answer = canApply(op, { role: "player", memberId: "p1" }, view, { canUseAsset: () => true });
          assert.ok(answer.ok, `${label}: refused, ${answer.ok ? "" : answer.message}`);
          if (op.t !== "token.move") continue;
          if (op.route) routed++;
          assert.deepEqual(drag.preview.to, { x: op.x, y: op.y }, `${label}: the picture ends where the drop lands`);
          assert.equal(drag.preview.read.dragFt, recordedCost(view, op, "mover"), `${label}: the label reads the recorded cost`);
        }
      }
      assert.ok(routed > 8, `${routed} routed drops`);
    });
  });
}
