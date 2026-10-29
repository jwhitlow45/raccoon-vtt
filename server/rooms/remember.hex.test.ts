import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunksOf, fogRoom, lift } from "#shared/discoveryTestutil.ts";
import { chunkKey, holderChunkKey, type EntityKey } from "#shared/keys.ts";
import type { MemoryChunk, RoomState, Viewer } from "#shared/model.ts";
import { withCellVision } from "#shared/perPlayerTestutil.ts";
import { shownUpDir } from "#shared/project.ts";
import { serverOnlyOpSchema, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { hexKey, hexNeighbors, type HexGrid } from "#shared/rules/hex.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, env, P1, token } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { mapStepOps } from "./remember.ts";

/**
 * The map step on hex scenes (docs/design-v1-hex-grids.md H3): a stair's
 * direction reads the scene's whole stair map, so an edit out of sight that
 * takes a stair away or turns it is remembered as players saw it, in the
 * party's layer and in a holder's, on hex rows and hex columns.
 */

const SERVER: Viewer = { memberId: "server", role: "dm" };

/** The batch's ops, the explore, then the map step's ops, each applied as stored. */
function batch(state: RoomState, ops: readonly Op[]): RoomState {
  const before = state;
  let s = state;
  const touched: EntityKey[] = [];
  let seq = 1;
  const run = (op: Op, by: Viewer) => {
    const r = applyOp(s, op, by, env(seq++));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    touched.push(...r.touched);
    s = r.state;
  };
  for (const op of ops) run(op, DM);
  const explore = exploreOp(s);
  if (explore) run(explore, SERVER);
  for (const op of mapStepOps({ before, after: s, touched, cap: () => MEMORY_CAP })) {
    assert.ok(serverOnlyOpSchema.safeParse(op).success);
    run(op, SERVER);
  }
  return s;
}

/** Applied as the reducer does, with no map step: the build players saw before they left. */
function built(state: RoomState, ops: readonly Op[]): RoomState {
  let s = state;
  ops.forEach((op, i) => {
    const r = applyOp(s, op, DM, env(i + 1));
    assert.ok(r.ok, r.ok ? "" : r.message);
    s = r.state;
  });
  return s;
}

const upDirShown = (state: RoomState, key: string): string => {
  const [x, y] = key.split(",").map(Number) as [number, number];
  return chunksOf(state, P1)[`${Math.floor(x / 16)},${Math.floor(y / 16)}`]?.upDir?.[(y % 16) * 16 + (x % 16)] ?? ".";
};
const upDirLive = (state: RoomState, key: string): string => {
  const [x, y] = key.split(",").map(Number) as [number, number];
  return shownUpDir(sceneWalls(state.scenes.s1!, state.buildChunks), x, y);
};

for (const shape of ["hexRows", "hexColumns"] as const) {
  for (const layer of ["party", "holder"] as const) {
    describe(`${shape}, the ${layer}'s layer`, () => {
      const g = gridOfShape(shape) as HexGrid;
      const H = { col: 5, row: 5 };
      const stair = hexKey(H);
      const up = hexKey(hexNeighbors(g, H)[0]!);
      const across = hexKey(hexNeighbors(g, H)[3]!);
      const memory = (state: RoomState): MemoryChunk | undefined =>
        layer === "party" ? state.memory?.[chunkKey("s1", 0, 0)] : state.memoryBy?.[holderChunkKey("s1", "p1", 0, 0)];

      /** A stair on hex 5,5 pointing up to its first side, seen and left: Ayla stands far off, its ground explored. */
      function left(): RoomState {
        let s = fogRoom({ vision: true, perPlayer: layer === "holder", scene: { gridShape: shape } });
        if (layer === "holder") s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
        s.tokens.ayla = token("ayla", { kind: "pc", ownerIds: ["p1"], x: 40, y: 26 });
        s = built(s, [
          { t: "build.height", sceneId: "s1", cells: [up], height: 10 },
          { t: "build.stairs", sceneId: "s1", cells: [stair], up: "a" },
        ]);
        lift(s, layer === "party" ? "party" : { holder: "p1" }, { x: 0, y: 0, w: 12, h: 12 });
        assert.equal(upDirShown(s, stair), "0");
        return s;
      }

      test("a stair taken away out of sight keeps the way it pointed on their map", () => {
        withCellVision(() => {
          const gone = batch(left(), [{ t: "build.stairs", sceneId: "s1", cells: [stair], up: null }]);
          assert.equal(upDirLive(gone, stair), ".");
          assert.equal(memory(gone)?.up?.[stair], "a");
          assert.equal(memory(gone)?.upDir?.[stair], "0");
          assert.equal(upDirShown(gone, stair), "0");
        });
      });

      test("a stair turned out of sight, its raised neighbor moved across, keeps the way it pointed on their map", () => {
        withCellVision(() => {
          const turned = batch(left(), [
            { t: "build.height", sceneId: "s1", cells: [up], height: 0 },
            { t: "build.height", sceneId: "s1", cells: [across], height: 10 },
          ]);
          assert.equal(upDirLive(turned, stair), "3", "the build's stair turned");
          assert.equal(memory(turned)?.heights?.[up], 10);
          assert.equal(memory(turned)?.upDir?.[stair], "0");
          assert.equal(upDirShown(turned, stair), "0");
        });
      });
    });
  }
}
