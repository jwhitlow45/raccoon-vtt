import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { lift, paint, wall } from "./discoveryTestutil.ts";
import type { RoomState } from "./model.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import { SOMETHING_BLOCKS, WALL_IN_THE_WAY, canApply, touchLanding, type PermissionDeps } from "./permissions.ts";
import type { OpOf } from "./protocol.ts";
import { visionRules } from "./ruleHooks.ts";
import { placedOnHex, tokenRefHex } from "./rules/footprint.ts";
import { sceneGrid } from "./rules/grid.ts";
import { hexAt, hexKey, hexLine, hexNeighbors, type HexGrid } from "./rules/hex.ts";
import { sideWall } from "./rules/hexWalls.testkit.ts";
import { P1, member, room, token } from "./testutil.ts";

/**
 * The words of a walk stopped on hexes (docs/design-v1-map-discovery.md 6,
 * decision 11, LP24-A-HEXFIGHT-3): the stopping step is the one the hex
 * line takes from the stand the walk lands on, never a step of the square
 * lattice, so a straight leg of several hexes stopped at a wall on the side
 * of a live hex names the wall wherever along the leg the wall stands.
 */
const deps: PermissionDeps = { canUseAsset: () => true };

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

/** Thorn (p1's) on his hex of a dark hex scene with fog on and every hex revealed, a wall on the side of the `k`th hex of his line east, after it. */
function hexLeg(gridShape: "hexRows" | "hexColumns", k: number): { s: RoomState; op: OpOf<"token.move"> } {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") } });
  s.scenes.s1 = { ...s.scenes.s1!, gridShape, blockMovement: true, autoWalls: "off", fogEnabled: true, vision: { on: true, light: "dark" } };
  const g = sceneGrid(s.scenes.s1!) as HexGrid;
  const thorn = token("thorn", { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5 });
  s.tokens.thorn = { ...thorn, ...placedOnHex(g, thorn, tokenRefHex(g, thorn)) };
  s.buildChunks = {};
  paint(s, { x: 0, y: 0, w: 24, h: 16 });
  const target = hexAt(g, { x: 12.5, y: 5.5 });
  const line = hexLine(g, tokenRefHex(g, s.tokens.thorn), target);
  const near = line[k]!;
  const far = line[k + 1]!;
  const w = sideWall(g, near, hexNeighbors(g, near).findIndex((n) => hexKey(n) === hexKey(far)));
  wall(s, "cdefghijklmn", w.a, w.b);
  lift(s, "dm", { x: 0, y: 0, w: 24, h: 16 });
  return { s, op: { t: "token.move", tokenId: "thorn", ...placedOnHex(g, s.tokens.thorn, target) } };
}

describe("a straight leg of several hexes stopped by a wall on the side of a live hex", () => {
  for (const gridShape of ["hexRows", "hexColumns"] as const) {
    test(`${gridShape}: names the wall, its first step or a later one, refused in place and landed alike`, () => {
      for (const k of [1, 2, 3]) {
        const { s, op } = hexLeg(gridShape, k);
        const d = canApply(op, P1, s, deps);
        assert.equal(d.ok ? "ok" : d.message, WALL_IN_THE_WAY, `the wall after step ${k}`);
        const landed = touchLanding(op, P1, s, deps);
        assert.equal(landed?.words, WALL_IN_THE_WAY, `the wall after step ${k}`);
        assert.notEqual(landed?.words, SOMETHING_BLOCKS);
      }
    });
  }
});
