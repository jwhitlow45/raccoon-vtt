import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunksOf, fogRoom, liftAllBut } from "../discoveryTestutil.ts";
import { chunkKey, keys } from "../keys.ts";
import { dependents } from "../project.ts";
import type { GridShape, RoomState, Token, TrapRig, Viewer } from "../model.ts";
import { opSchema, type Op, type RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { occupiedHexes, placedOnHex } from "../rules/footprint.ts";
import { gridOfShape, switchRefusal } from "../rules/grid.ts";
import { groundAt } from "../rules/heights.ts";
import { hexKey, sceneHexSpan, type Hex, type HexGrid } from "../rules/hex.ts";
import { withPitsCounted } from "../rules/pitCount.ts";
import { sceneWalls } from "../rules/walls.ts";
import { DM, env, P1, room, scene, token, trap as trapOf } from "../testutil.ts";

/**
 * Heights, stairs and pits on a hex scene in the reducer
 * (docs/design-v1-hex-grids.md phase H3): each write is stamped with the
 * scene's shape and drops the stamp with the last of its content
 * (HX-D14), a stair keeps to its grid's facings, a pit opens hexes and its
 * undo shuts them, the switch is refused while heights or stairs stand,
 * and the far rows and columns of the largest scenes take them.
 */

let seq = 1;
function run(state: RoomState, op: Op, who: Viewer = DM): { state: RoomState; inverse: RestoreEntry[] } {
  const r = applyOp(state, opSchema.parse(op), who, env(seq++));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return { state: r.state, inverse: r.inverse ?? [] };
}

function refusal(state: RoomState, op: Op): string {
  const r = applyOp(state, opSchema.parse(op), DM, env(seq++));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

const undo = (entries: RestoreEntry[]): Op => ({ t: "sys.restore", entries, from: "undo", deps: true });

function hexRoom(shape: GridShape = "hexRows", bounds = { w: 20, h: 14 }): RoomState {
  return room({ scenes: { s1: scene("s1", { gridShape: shape, bounds, blockMovement: true }) } });
}

function on(g: HexGrid, id: string, ref: Hex, over: Partial<Token> = {}): Token {
  const base = token(id, { name: id, x: 0, y: 0, ...over });
  return { ...base, ...placedOnHex(g, base, ref) };
}

for (const shape of ["hexRows", "hexColumns"] as const) {
  const g = gridOfShape(shape) as HexGrid;

  describe(`${shape}: heights and stairs in the reducer`, () => {
    test("a height and a stair carry the chunk's stamp, which goes with the last of them", () => {
      const painted = run(hexRoom(shape), { t: "build.height", sceneId: "s1", cells: ["3,3"], height: 10 }).state;
      assert.equal(painted.buildChunks[chunkKey("s1", 0, 0)]?.grid, shape);
      const marked = run(painted, { t: "build.stairs", sceneId: "s1", cells: ["4,3"], up: "2" }).state;
      assert.equal(marked.buildChunks[chunkKey("s1", 0, 0)]?.up?.[3 * 16 + 4], "2");
      const flat = run(marked, { t: "build.height", sceneId: "s1", cells: ["3,3"], height: 0 }).state;
      assert.equal(flat.buildChunks[chunkKey("s1", 0, 0)]?.grid, shape, "a stair still stands");
      const bare = run(flat, { t: "build.stairs", sceneId: "s1", cells: ["4,3"], up: null }).state;
      assert.equal(bare.buildChunks[chunkKey("s1", 0, 0)], undefined, "the chunk goes with the last of them, and its stamp with it");
    });

    test("a stair on hexes faces a side from 0 to 5, and one on squares a compass point", () => {
      for (const up of ["n", "e", "s", "w"] as const) assert.equal(refusal(hexRoom(shape), { t: "build.stairs", sceneId: "s1", cells: ["4,3"], up }), "a stair on hexes faces a side from 0 to 5");
      assert.equal(refusal(room(), { t: "build.stairs", sceneId: "s1", cells: ["4,3"], up: "3" }), "a stair on squares faces north, east, south or west");
      assert.ok(run(hexRoom(shape), { t: "build.stairs", sceneId: "s1", cells: ["4,3"], up: "a" }).state.buildChunks[chunkKey("s1", 0, 0)]?.up);
    });

    test("a creature standing on painted hexes rises with them, and one beside them stays", () => {
      const s = hexRoom(shape);
      s.tokens.on = on(g, "on", { col: 5, row: 5 });
      s.tokens.by = on(g, "by", { col: 8, row: 5 });
      const after = run(s, { t: "build.height", sceneId: "s1", cells: ["5,5"], height: 15 }).state;
      assert.deepEqual([after.tokens.on!.elevation, after.tokens.by!.elevation], [15, 0]);
    });

    test("the switch is refused while heights or stairs stand, naming them", () => {
      const other = gridOfShape(shape === "hexRows" ? "hexColumns" : "hexRows");
      const painted = run(hexRoom(shape), { t: "build.height", sceneId: "s1", cells: ["3,3"], height: 10 }).state;
      const words = shape === "hexRows" ? ["hex rows", "hex columns"] : ["hex columns", "hex rows"];
      assert.equal(switchRefusal(painted, painted.scenes.s1!, other), `This scene has heights on its ${words[0]}, which can't stand on ${words[1]}. Remove them to change the grid.`);
      const marked = run(hexRoom(shape), { t: "build.stairs", sceneId: "s1", cells: ["3,3"], up: "a" }).state;
      assert.match(switchRefusal(marked, marked.scenes.s1!, gridOfShape(undefined))!, /^This scene has stairs on its hexes, which can't stand on squares\./);
      assert.equal(refusal(painted, { t: "scene.update", sceneId: "s1", patch: { gridShape: "squares" } }), "This scene has heights on its hexes, which can't stand on squares. Remove them to change the grid.");
    });
  });

  describe(`${shape}: a pit on hexes`, () => {
    const pitRig = (): TrapRig => ({ ...trapOf("x").rig!, who: "any", stops: true, pit: { floor: -10 } });

    test("a walk over its hexes opens it: they take its floor under the scene's stamp, the walker falls with them, and one undo shuts it", () => {
      const s = hexRoom(shape);
      // Two hexes of the walker's line, keyed along the lattice's own run (a row on hex rows, a column on hex columns).
      const along = (k: number): Hex => (shape === "hexRows" ? { col: k, row: 4 } : { col: 4, row: k });
      const zone = shape === "hexRows" ? { x: 6, y: 4, w: 2, h: 1 } : { x: 4, y: 6, w: 1, h: 2 };
      s.traps = { pit: { ...trapOf("pit", { zone: { cells: [zone] }, rig: pitRig() }), grid: shape } };
      s.tokens.thorn = on(g, "thorn", along(2), { name: "Thorn", kind: "pc", ownerIds: ["p1"] });
      const to = placedOnHex(g, s.tokens.thorn, along(12));
      const moved = run(s, { t: "token.move", tokenId: "thorn", ...to }, P1);
      const pit = [along(6), along(7)];
      assert.deepEqual(
        pit.map((h) => groundAt(moved.state.buildChunks, "s1", h.col, h.row)),
        [-10, -10],
      );
      assert.equal(groundAt(moved.state.buildChunks, "s1", along(8).col, along(8).row), 0, "beside it the ground stays");
      assert.equal(moved.state.buildChunks[chunkKey("s1", 0, 0)]?.grid, shape);
      assert.deepEqual(placedOnHex(g, s.tokens.thorn, along(6)), { x: moved.state.tokens.thorn!.x, y: moved.state.tokens.thorn!.y }, "stopped on its first hex");
      assert.equal(moved.state.tokens.thorn!.elevation, -10, "and fell to its floor");
      const line = moved.state.trapLog.at(-1)!.data;
      assert.ok(line?.type === "trap");
      assert.deepEqual(line.did, [{ action: -1, ok: true }]);
      const shut = run(moved.state, undo(moved.inverse)).state;
      assert.deepEqual(
        pit.map((h) => groundAt(shut.buildChunks, "s1", h.col, h.row)),
        [0, 0],
      );
      assert.equal(shut.buildChunks[chunkKey("s1", 0, 0)], undefined, "the ground and its stamp go back");
      assert.deepEqual([shut.tokens.thorn!.x, shut.tokens.thorn!.elevation], [s.tokens.thorn.x, 0]);
    });

    test("a Large walker stops at its first stand wholly over the opening, all three of its hexes, and falls with them", () => {
      const s = hexRoom(shape, { w: 24, h: 16 });
      const zone = shape === "hexRows" ? { x: 6, y: 4, w: 4, h: 2 } : { x: 4, y: 6, w: 2, h: 4 };
      s.traps = { pit: { ...trapOf("pit", { zone: { cells: [zone] }, rig: pitRig() }), grid: shape } };
      const along = (k: number): Hex => (shape === "hexRows" ? { col: k, row: 4 } : { col: 4, row: k });
      s.tokens.ogre = on(g, "ogre", along(1), { name: "Ogre", size: "large" });
      const moved = run(s, { t: "token.move", tokenId: "ogre", ...placedOnHex(g, s.tokens.ogre, along(14)) }).state;
      const ogre = moved.tokens.ogre!;
      const keysIn = new Set<string>();
      for (let y = zone.y; y < zone.y + zone.h; y++) for (let x = zone.x; x < zone.x + zone.w; x++) keysIn.add(`${x},${y}`);
      assert.ok(occupiedHexes(g, ogre).every((h) => keysIn.has(hexKey(h))), "wholly over it");
      assert.equal(ogre.elevation, -10);
    });

    test("a trap only for creatures on the floor goes off under a walker on raised hexes, read by its hexes' ground", () => {
      // Row 12 (column 12) lies near world y 11, so no key of a square under the walker is a painted hex's.
      const along = (k: number): Hex => (shape === "hexRows" ? { col: k, row: 12 } : { col: 12, row: k });
      let s = hexRoom(shape);
      s = run(s, { t: "build.height", sceneId: "s1", cells: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => hexKey(along(k))), height: 10 }).state;
      const { pit: _pit, ...rig } = pitRig();
      s = { ...s, traps: { t1: { ...trapOf("t1", { zone: { cells: [shape === "hexRows" ? { x: 6, y: 4, w: 1, h: 1 } : { x: 4, y: 6, w: 1, h: 1 }] }, rig: { ...rig, floor: true } }), grid: shape } } };
      s.traps.t1!.zone = { cells: [shape === "hexRows" ? { x: 6, y: 12, w: 1, h: 1 } : { x: 12, y: 6, w: 1, h: 1 }] };
      s.tokens.thorn = on(g, "thorn", along(2), { name: "Thorn", elevation: 10 });
      const moved = run(s, { t: "token.move", tokenId: "thorn", ...placedOnHex(g, s.tokens.thorn, along(12)), elevation: 10 }).state;
      assert.deepEqual(placedOnHex(g, s.tokens.thorn, along(6)), { x: moved.tokens.thorn!.x, y: moved.tokens.thorn!.y }, "it went off where the walker stepped on");
    });

    test("its border is counted ahead: the counted ground raises every side an opened pit could, and no other", () => {
      const s = hexRoom(shape);
      // A pit of two hexes on a 10 ft platform's edge: its hexes stand at 10 and 0 now.
      const p1: Hex = { col: 6, row: 6 };
      const p2: Hex = { col: 7, row: 6 };
      let state = run(s, { t: "build.height", sceneId: "s1", cells: ["6,6", "5,6"], height: 10 }).state;
      state = { ...state, traps: { pit: { ...trapOf("pit", { zone: { cells: [{ x: 6, y: 6, w: 2, h: 1 }] }, rig: pitRig() }), grid: shape } } };
      const counted = withPitsCounted(state, "s1");
      const raisedSides = (chunks: RoomState["buildChunks"]) => {
        const walls = sceneWalls(state.scenes.s1!, chunks);
        let n = 0;
        for (let k = 0; k < walls.stored.n; k++) if (walls.stored.tags[k]! & 16) n++;
        return n;
      };
      // Every side of the two pit hexes is raised in the count (11: twelve sides, the one between them counted once), and the
      // platform hex beside them keeps its five other sides.
      assert.equal(raisedSides(counted.buildChunks), 11 + 5);
      const opened = run(state, { t: "build.height", sceneId: "s1", cells: [hexKey(p1), hexKey(p2)], height: -10 }).state;
      assert.ok(raisedSides(opened.buildChunks) <= raisedSides(counted.buildChunks));
      assert.ok(raisedSides(state.buildChunks) <= raisedSides(counted.buildChunks));
    });
  });

  describe(`${shape}: the last row and column of the largest scene`, () => {
    test("a 200 by 200 scene takes heights and stairs on its last hex keys, past where squares stop", () => {
      const s = hexRoom(shape, { w: 200, h: 200 });
      const span = sceneHexSpan(g, s.scenes.s1!.bounds);
      const last = shape === "hexRows" ? `10,${span.rows - 1}` : `${span.cols - 1},10`;
      assert.equal(shape === "hexRows" ? span.rows : span.cols, 230);
      const painted = run(s, { t: "build.height", sceneId: "s1", cells: [last], height: 20 }).state;
      const [x, y] = last.split(",").map(Number) as [number, number];
      assert.equal(groundAt(painted.buildChunks, "s1", x, y), 20);
      const key = chunkKey("s1", Math.floor(x / 16), Math.floor(y / 16));
      assert.equal(painted.buildChunks[key]?.grid, shape);
      assert.equal(Math.floor((shape === "hexRows" ? y : x) / 16), 14, "chunk 14");
      assert.ok(run(painted, { t: "build.stairs", sceneId: "s1", cells: [last], up: "5" }).state.buildChunks[key]?.up);
      const past = shape === "hexRows" ? `10,${span.rows}` : `${span.cols},10`;
      assert.equal(refusal(s, { t: "build.height", sceneId: "s1", cells: [past], height: 20 }), "cell outside the scene");
    });
  });
}

describe("hex rows: what players and the fan-out read of heights and stairs", () => {
  const g = gridOfShape("hexRows") as HexGrid;

  test("a player's chunk under fog carries a hex stair's facing, and their device's walls read it", () => {
    let state = fogRoom({ vision: true, scene: { gridShape: "hexRows" } });
    state = run(state, { t: "build.height", sceneId: "s1", cells: ["5,4"], height: 10 }).state;
    state = run(state, { t: "build.stairs", sceneId: "s1", cells: ["4,4"], up: "a" }).state;
    liftAllBut(state, "party", []);
    const chunk = chunksOf(state, P1)["0,0"]!;
    assert.equal(chunk.upDir?.[4 * 16 + 4], "0", "up toward the raised hex east of it");
    assert.equal(chunk.grid, "hexRows");
    const theirs = sceneWalls(state.scenes.s1!, { [chunkKey("s1", 0, 0)]: chunk });
    assert.equal(theirs.stairAt(4, 4), "0");
  });

  test("a height chunk's dependents count by the world box of its hexes grown 16 cells each way (HX-D22)", () => {
    const s = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 40, h: 200 } }) } });
    // Hex row 160 is chunk row 10, about 139 cells down, where squares' chunk row 10 starts at 160.
    const painted = run(s, { t: "build.height", sceneId: "s1", cells: ["4,160"], height: 10 }).state;
    painted.tokens = { above: on(g, "above", { col: 4, row: 142 }), far: on(g, "far", { col: 4, row: 100 }) };
    const deps = dependents(painted, [keys.chunk("s1", 0, 10)]);
    assert.ok(deps.includes(keys.token("above")), "16 cells above the chunk's hexes, above the square chunk's box");
    assert.ok(!deps.includes(keys.token("far")));
  });
});
