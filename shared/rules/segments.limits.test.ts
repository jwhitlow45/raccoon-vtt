import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, FreeWall, RoomState } from "../model.ts";
import { applyOp } from "../reducer.ts";
import { AT, P1, room, scene } from "../testutil.ts";
import { sightPieces, sightPiecesCheck } from "../visionLimits.ts";
import { sceneWalls, splitCheck } from "./walls.ts";

/** A scene whose free walls cross a door, and an edge door on the grid, with vision on and players moving doors. */
function doors(state: "open" | "closed" | "locked"): RoomState {
  const wall = (id: string, a: [number, number], b: [number, number], f: FreeWall["f"] = { kind: "wall" }): FreeWall => ({ id: id.padEnd(12, "0"), a, b, f });
  const chunk: BuildChunk = {
    sceneId: "s1",
    cx: 0,
    cy: 0,
    rev: 0,
    cells: {},
    edges: { "3,2,w": { kind: "door", state, secret: false, discovered: false } },
    walls: [
      wall("a", [1, 1], [6, 6]),
      wall("b", [1, 6], [6, 1], { kind: "door", state, secret: false, discovered: false }),
      wall("c", [2, 1], [2, 7]),
      wall("d", [5, 1], [5, 7], { kind: "door", state, secret: true, discovered: true }),
    ],
  };
  return room({ scenes: { s1: scene("s1", { vision: { on: true, light: "bright" } }), s2: scene("s2", { order: 1 }) }, buildChunks: { "s1:0,0": chunk } });
}

describe("doors and the wall caps", () => {
  test("the split's count and the sight pieces read every door alike, so a player's door never meets either cap", () => {
    const counts = (state: RoomState) => {
      const s = state.scenes.s1!;
      const count = sceneWalls(s, state.buildChunks).count;
      return { pairs: count.pairs, pieces: count.pieces, sight: sightPieces(state, "s1") };
    };
    const closed = counts(doors("closed"));
    for (const state of ["open", "locked"] as const) assert.deepEqual(counts(doors(state)), closed, state);
    const before = doors("closed");
    for (const op of [
      { t: "door.set", sceneId: "s1", door: { cx: 0, cy: 0, id: "b".padEnd(12, "0") }, state: "open" },
      { t: "door.set", sceneId: "s1", door: { edge: "3,2,w" }, state: "open" },
    ] as const) {
      const r = applyOp(before, op, P1, { seq: 9, at: AT });
      assert.ok(r.ok, r.ok ? "" : r.message);
      assert.deepEqual(counts(r.state), closed, op.door.toString());
      assert.deepEqual(splitCheck(r.state, "s1"), { ok: true });
      assert.deepEqual(sightPiecesCheck(r.state, "s1", before), { ok: true });
    }
  });
});
