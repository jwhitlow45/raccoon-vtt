import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FogOp, RoomState, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { placedOnHex } from "../rules/footprint.ts";
import { allRevealedTiles, decodeTile, isSubcellFogged } from "../rules/fog.ts";
import { gridOfShape } from "../rules/grid.ts";
import { hexKey, hexNeighbors, hexSubcells, type HexGrid } from "../rules/hex.ts";
import { env, P1, room, scene, token } from "../testutil.ts";

/**
 * Reveal room's fog on a hex scene in the reducer (docs/design-v1-hex-grids.md
 * HX-D10 and HX-D14, phase H3): a draft of hex keys carries its scene's
 * shape and drops it with the last of them, and a published or live reveal
 * opens the hexes' sub-cells, so a creature standing in one reaches players.
 */

const A: Viewer = { memberId: "dm1", role: "dm" };
const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;

let seq = 1;
function run(state: RoomState, op: Op): { state: RoomState; inverse: RestoreEntry[] } {
  const r = applyOp(state, opSchema.parse(op), A, env(seq++));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return { state: r.state, inverse: r.inverse ?? [] };
}

const undo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "undo", deps: true });

function hexRoom(shape: "hexRows" | "hexColumns" | undefined, g: HexGrid): RoomState {
  const middle = { col: 6, row: 6 };
  return room({
    scenes: { s1: scene("s1", { ...(shape ? { gridShape: shape } : {}), fogEnabled: true }) },
    tokens: {
      gob: token("gob", { size: "medium", ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, middle) }),
      far: token("far", { size: "medium", ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 12, row: 12 }) }),
    },
  });
}

const room7 = (g: HexGrid) => {
  const middle = { col: 6, row: 6 };
  return [middle, ...hexNeighbors(g, middle)].map(hexKey);
};
const cellsOp = (cells: string[], id = "f1", mode: "reveal" | "hide" = "reveal"): FogOp => ({ id, mode, shape: { kind: "cells", cells } });

/** Whether the scene's fog reveals exactly the sub-cells of these hexes. */
function revealsExactly(state: RoomState, g: HexGrid, hexes: string[]): boolean {
  const subs = hexes.flatMap((k) => hexSubcells(g, { col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) }));
  if (subs.some(([sx, sy]) => isSubcellFogged(state.fogTiles, "s1", sx, sy))) return false;
  let revealed = 0;
  for (const t of Object.values(state.fogTiles)) for (const byte of decodeTile(t.bits) ?? []) for (let b = 0; b < 8; b++) revealed += (byte >> b) & 1;
  return revealed === subs.length;
}
const rectOp: FogOp = { id: "r1", mode: "reveal", shape: { kind: "rect", x: 15, y: 1, w: 2, h: 2 } };

for (const [shape, g] of [
  ["hexRows", ROWS],
  ["hexColumns", COLUMNS],
] as const) {
  describe(`Reveal room's fog on ${shape}`, () => {
    test("a draft of hex keys carries the scene's shape, keeps it beside other shapes, and drops it with the last of them", () => {
      let state = run(hexRoom(shape, g), { t: "fog.draft", sceneId: "s1", add: [rectOp] }).state;
      assert.equal(state.fogDrafts.s1?.grid, undefined, "a draft of rects carries none");
      state = run(state, { t: "fog.draft", sceneId: "s1", add: [cellsOp(room7(g))] }).state;
      assert.equal(state.fogDrafts.s1?.grid, shape);
      state = run(state, { t: "fog.draft", sceneId: "s1", add: [{ ...rectOp, id: "r2" }] }).state;
      assert.equal(state.fogDrafts.s1?.grid, shape, "kept while a shape of hex keys stays");
      state = run(state, { t: "fog.draft", sceneId: "s1", remove: ["f1"] }).state;
      assert.equal(state.fogDrafts.s1?.ops.length, 2);
      assert.equal("grid" in state.fogDrafts.s1!, false, "dropped with the last of them");
    });

    test("a published reveal of the room's hexes shows the goblin standing in one, not the one outside, and its undo hides it again", () => {
      let state = run(hexRoom(shape, g), { t: "fog.draft", sceneId: "s1", add: [cellsOp(room7(g))] }).state;
      assert.equal(projectState(state, P1, { sceneId: "s1" }).tokens.gob, undefined, "a draft shows players nothing");
      const published = run(state, { t: "fog.publish", sceneId: "s1" });
      state = published.state;
      assert.equal(state.fogDrafts.s1, undefined);
      const seen = projectState(state, P1, { sceneId: "s1" }).tokens;
      assert.ok(seen.gob, "the goblin in the revealed hex");
      assert.equal(seen.far, undefined, "the one outside stays under fog");
      assert.ok(revealsExactly(state, g, room7(g)), "the room's hexes by their sub-cells, and nothing else");
      const undone = run(state, undo(published.inverse)).state;
      assert.equal(projectState(undone, P1, { sceneId: "s1" }).tokens.gob, undefined);
      assert.deepEqual(undone.fogDrafts.s1?.grid, shape, "the undo puts the stamped draft back");
    });

    test("a live reveal and a live hide of the hexes", () => {
      let state = run(hexRoom(shape, g), { t: "fog.live", sceneId: "s1", ops: [cellsOp(room7(g))] }).state;
      assert.ok(projectState(state, P1, { sceneId: "s1" }).tokens.gob);
      assert.ok(revealsExactly(state, g, room7(g)));
      state = run(state, { t: "fog.live", sceneId: "s1", ops: [cellsOp(room7(g), "f2", "hide")] }).state;
      assert.equal(projectState(state, P1, { sceneId: "s1" }).tokens.gob, undefined);
      assert.equal(Object.values(state.fogTiles).filter((t) => t.sceneId === "s1").length, 0, "nothing else was revealed");
    });

    test("a hide of the hexes makes players forget what they explored there, and only there", () => {
      const base = hexRoom(shape, g);
      for (const t of allRevealedTiles("s1", base.scenes.s1!.bounds)) base.exploredTiles[`${t.sceneId}:${t.tx},${t.ty}`] = t;
      const state = run(base, { t: "fog.live", sceneId: "s1", ops: [cellsOp(room7(g), "f2", "hide")] }).state;
      const subs = room7(g).flatMap((k) => hexSubcells(g, { col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) }));
      for (const [sx, sy] of subs) assert.equal(isSubcellFogged(state.exploredTiles, "s1", sx, sy), true, `${sx},${sy} forgotten`);
      const kept = hexSubcells(g, { col: 12, row: 12 });
      for (const [sx, sy] of kept) assert.equal(isSubcellFogged(state.exploredTiles, "s1", sx, sy), false, "the far hex still explored");
    });

    test("the shape switch is refused while the draft holds hex keys", () => {
      const state = run(hexRoom(shape, g), { t: "fog.draft", sceneId: "s1", add: [cellsOp(room7(g))] }).state;
      const r = applyOp(state, opSchema.parse({ t: "scene.update", sceneId: "s1", patch: { gridShape: shape === "hexRows" ? "hexColumns" : "hexRows" } }), A, env(seq++));
      assert.ok(!r.ok);
      assert.match(r.message, /Builder room in its fog draft/);
    });
  });
}

describe("Reveal room's fog on squares", () => {
  test("a draft of cells carries no stamp and reveals squares, as before hex grids", () => {
    const state = run(hexRoom(undefined, ROWS), { t: "fog.draft", sceneId: "s1", add: [cellsOp(["1,1"])] }).state;
    assert.equal("grid" in state.fogDrafts.s1!, false);
    assert.deepEqual(Object.keys(state.fogDrafts.s1!), ["sceneId", "rev", "ops"], "the stored form keeps its keys and their order");
  });
});
