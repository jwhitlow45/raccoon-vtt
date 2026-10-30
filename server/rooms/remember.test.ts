import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { autoAt, chunksOf, edge, fogRoom, knownAt, lift, paint, stairs, wall, wallsOf } from "#shared/discoveryTestutil.ts";
import { chunkKey, holderChunkKey, tileKey, type EntityKey } from "#shared/keys.ts";
import type { Label, MemoryChunk, PlayerChunk, RoomState, Stamp, Viewer } from "#shared/model.ts";
import { withCellVision } from "#shared/perPlayerTestutil.ts";
import { projectState, shownUpDir } from "#shared/project.ts";
import { serverOnlyOpSchema, type Op, type OpOf } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { decodeTile, getBit } from "#shared/rules/fog.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, env, P1, token } from "#shared/testutil.ts";
import { exploreOp } from "./explore.ts";
import { chunkCharge, MEMORY_CAP } from "./memorySize.ts";
import { forgetAllOps, layerKey, mapStepOps, memoryGrowth, type DoorTouch } from "./remember.ts";

/**
 * The map step (docs/design-v1-map-discovery.md 5.3), batch by batch as the
 * actor runs it: the batch's ops, the explore step, then the map step's
 * `sys.remember`, each applied as stored. Sight is perPlayerTestutil.ts's
 * stub, whole cells 3 out in bright light, so each case sets the ground it
 * names exactly.
 */

const SERVER: Viewer = { memberId: "server", role: "dm" };

type Batch = { state: RoomState; remember: OpOf<"sys.remember">[] };

/** One batch: the ops, the explore, the map step. */
function batch(state: RoomState, ops: readonly (Op | { op: Op; by: Viewer })[], opts: { cap?: number; capOf?: (layer: string | null) => number; doors?: DoorTouch[] } = {}): Batch {
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
  for (const o of ops) "op" in o ? run(o.op, o.by) : run(o, DM);
  const explore = exploreOp(s);
  if (explore) run(explore, SERVER);
  const remember = mapStepOps({ before, after: s, touched, doors: opts.doors, cap: (_scene, layer) => opts.capOf?.(layer) ?? opts.cap ?? MEMORY_CAP });
  for (const op of remember) {
    assert.ok(serverOnlyOpSchema.safeParse(op).success, `the step's op validates: ${JSON.stringify(serverOnlyOpSchema.safeParse(op).error?.issues[0])}`);
    run(op, SERVER);
  }
  return { state: s, remember };
}

/** A room 48 x 32 with fog and party vision on, Ayla (p1's) at (5, 5) seeing cells 2 to 8, and a painted room 2..9 x 2..9 with a door on its east side. */
function crypt(): RoomState {
  const state = fogRoom({ vision: true });
  state.tokens.ayla = token("ayla", { kind: "pc", ownerIds: ["p1"], x: 5, y: 5 });
  paint(state, { x: 2, y: 2, w: 8, h: 8 });
  edge(state, "10,5,w", { kind: "door", state: "closed", secret: false, discovered: false });
  return state;
}

const move = (x: number, y: number): Op => ({ t: "token.move", tokenId: "ayla", x, y });

function party(state: RoomState, cx = 0, cy = 0): MemoryChunk | undefined {
  return state.memory?.[chunkKey("s1", cx, cy)];
}

function cellShown(state: RoomState, x: number, y: number, viewer: Viewer = P1): string | undefined {
  return chunksOf(state, viewer)[`${Math.floor(x / 16)},${Math.floor(y / 16)}`]?.cells[`${x},${y}`];
}

/** A stair's direction on the viewer's map, "." for none. */
function upDirShown(state: RoomState, x: number, y: number, viewer: Viewer = P1): string | undefined {
  const chunk = chunksOf(state, viewer)[`${Math.floor(x / 16)},${Math.floor(y / 16)}`];
  return chunk?.upDir?.[(y % 16) * 16 + (x % 16)] ?? ".";
}

/** A stair's direction in the build as it is. */
function upDirLive(state: RoomState, x: number, y: number): string {
  return shownUpDir(sceneWalls(state.scenes.s1!, state.buildChunks), x, y);
}

function edgeShown(state: RoomState, key: string, viewer: Viewer = P1): unknown {
  const [x, y] = key.split(",").map(Number) as [number, number];
  const chunk = chunksOf(state, viewer)[`${Math.floor(x / 16)},${Math.floor(y / 16)}`];
  return chunk?.edges[key] ?? (autoAt(chunk, key) ? "auto" : null);
}

/** Ayla explores the crypt, then walks off east, out of its sight. */
function leftCrypt(): RoomState {
  return withCellVision(() => {
    let s = batch(crypt(), []).state;
    // From (5, 5) she sees 2..8: the room's east column 9 and its door stay unseen, so a step east explores them.
    s = batch(s, [move(7, 5)]).state;
    return batch(s, [move(30, 5)]).state;
  });
}

describe("the map step", () => {
  test("an edit out of sight on explored ground is remembered as it was, and the build shows once they see it again", () => {
    withCellVision(() => {
      const left = leftCrypt();
      assert.equal(cellShown(left, 4, 4), "stone");
      assert.equal(party(left), undefined, "nothing changed, so nothing is remembered");
      const edits: Op[] = [
        { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["4,4"] },
        { t: "build.edge", sceneId: "s1", edges: [{ key: "10,5,w", feature: null }, { key: "5,5,n", feature: { kind: "wall" } }] },
      ];
      const edited = batch(left, edits);
      assert.equal(edited.remember.length, 1);
      const memory = party(edited.state)!;
      assert.equal(memory.cells?.["4,4"], "stone");
      assert.deepEqual(memory.edges?.["10,5,w"], { kind: "door", state: "closed", secret: false, discovered: false });
      assert.equal(memory.edges?.["5,5,n"], null, "a wall that came out of their sight is absent from what they remember");
      // Their map shows the room as they left it: no frame holds the change.
      assert.equal(cellShown(edited.state, 4, 4), "stone");
      assert.deepEqual(edgeShown(edited.state, "10,5,w"), { kind: "door", state: "closed", secret: false, discovered: false });
      assert.equal(edgeShown(edited.state, "5,5,n"), null);
      // The DM sees the build as it is.
      assert.equal(projectState(edited.state, DM, { sceneId: "s1" }).buildChunks[chunkKey("s1", 0, 0)]?.cells["4,4"], "wood");
      // Back in the room, the live build replaces what they remembered, and the entries go.
      const back = batch(edited.state, [move(5, 5)]);
      assert.equal(cellShown(back.state, 4, 4), "wood");
      assert.deepEqual(edgeShown(back.state, "5,5,n"), { kind: "wall" });
      assert.equal(party(back.state)?.cells?.["4,4"], undefined);
      assert.equal(party(back.state)?.edges?.["5,5,n"], undefined);
    });
  });

  test("a stair put out of sight keeps the automatic walls they saw beside it, in its chunk and across a chunk line", () => {
    withCellVision(() => {
      const state = fogRoom({ vision: true });
      state.tokens.ayla = token("ayla", { kind: "pc", ownerIds: ["p1"], x: 14, y: 4 });
      // Floor west of 12 and east of 16: from (14, 4) Ayla sees 11 to 17, so both automatic walls, on 12,4,w and on 16,4,w in the next chunk.
      paint(state, { x: 8, y: 2, w: 4, h: 5 });
      paint(state, { x: 16, y: 2, w: 4, h: 5 });
      let s = batch(state, []).state;
      s = batch(s, [move(40, 20)]).state;
      assert.equal(edgeShown(s, "12,4,w"), "auto");
      assert.equal(edgeShown(s, "16,4,w"), "auto");
      // A stair counts as a Stairs cell, so neither edge has an automatic wall now.
      const stair = batch(s, [{ t: "build.stairs", sceneId: "s1", cells: ["12,4", "15,4"], up: "e" }]);
      assert.equal(party(stair.state)?.edges?.["12,4,w"], "auto");
      assert.equal(party(stair.state, 1, 0)?.edges?.["16,4,w"], "auto");
      assert.equal(edgeShown(stair.state, "12,4,w"), "auto");
      assert.equal(edgeShown(stair.state, "16,4,w"), "auto");
    });
  });

  test("a stair taken away out of sight, the scene's last, keeps the way it pointed on their map", () => {
    withCellVision(() => {
      const state = crypt();
      state.tokens.ayla = { ...state.tokens.ayla!, x: 3, y: 7 };
      let s = batch(state, [
        { t: "build.height", sceneId: "s1", cells: ["5,5"], height: 10 },
        { t: "build.stairs", sceneId: "s1", cells: ["5,6"], up: "a" },
      ]).state;
      const way = upDirShown(s, 5, 6);
      assert.notEqual(way, ".");
      s = batch(s, [move(30, 5)]).state;
      const gone = batch(s, [{ t: "build.stairs", sceneId: "s1", cells: ["5,6"], up: null }]).state;
      assert.equal(upDirLive(gone, 5, 6), ".");
      assert.equal(party(gone)?.up?.["5,6"], "a");
      assert.equal(party(gone)?.upDir?.["5,6"], way);
      assert.equal(upDirShown(gone, 5, 6), way);
    });
  });

  test("a Stairs cell painted before stair marks turns out of sight as they saw it", () => {
    withCellVision(() => {
      const state = crypt();
      state.tokens.ayla = { ...state.tokens.ayla!, x: 3, y: 7 };
      let s = batch(state, [
        { t: "build.height", sceneId: "s1", cells: ["5,5"], height: 10 },
        { t: "build.paint", sceneId: "s1", terrain: "stairs", cells: ["5,6"] },
      ]).state;
      const way = upDirShown(s, 5, 6);
      assert.equal(way, "n");
      s = batch(s, [move(30, 5)]).state;
      const turned = batch(s, [{ t: "build.height", sceneId: "s1", cells: ["5,5"], height: 0 }, { t: "build.height", sceneId: "s1", cells: ["5,7"], height: 10 }]).state;
      assert.notEqual(upDirLive(turned, 5, 6), way, "the build's stair turned");
      assert.equal(party(turned)?.upDir?.["5,6"], way);
      assert.equal(upDirShown(turned, 5, 6), way);
    });
  });

  test("a scene narrowed out of sight keeps the way a stair at its old border pointed, with no memory before it", () => {
    withCellVision(() => {
      const state = fogRoom({ vision: true, bounds: { w: 24, h: 16 } });
      state.tokens.ayla = token("ayla", { kind: "pc", ownerIds: ["p1"], x: 20, y: 5 });
      let s = batch(state, [
        { t: "build.height", sceneId: "s1", cells: ["23,5"], height: 10 },
        { t: "build.stairs", sceneId: "s1", cells: ["22,5"], up: "a" },
      ]).state;
      assert.equal(upDirShown(s, 22, 5), "e");
      s = batch(s, [move(2, 10)]).state;
      assert.equal(party(s, 1, 0), undefined, "nothing remembered yet");
      const narrow = batch(s, [{ t: "scene.update", sceneId: "s1", patch: { bounds: { w: 23, h: 16 } } }]);
      assert.notEqual(upDirLive(narrow.state, 22, 5), "e", "past the border the platform no longer counts");
      assert.equal(party(narrow.state, 1, 0)?.upDir?.["22,5"], "e");
      assert.equal(upDirShown(narrow.state, 22, 5), "e");
    });
  });

  test("a holder's layer is kept to its own cap, not the party's (MD3-ASTRA-4)", () => {
    withCellVision(() => {
      let s = crypt();
      s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright", perPlayer: true } };
      s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
      lift(s, { holder: "p1" }, { x: 2, y: 2, w: 3, h: 8 });
      s.tokens.ayla = { ...s.tokens.ayla!, x: 30, y: 20 };
      s = batch(s, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["3,3"] }]).state;
      // After a fold the party's share may be small while a holder keeps a whole cap.
      const kept = batch(s, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["3,4"] }], { capOf: (layer) => (layer === null ? 0 : MEMORY_CAP) });
      assert.ok(kept.remember.every((op) => op.forget === undefined), JSON.stringify(kept.remember.map((op) => op.forget)));
      assert.deepEqual(kept.state.memoryBy?.[holderChunkKey("s1", "p1", 0, 0)]?.cells, { "3,3": "stone", "3,4": "stone" });
    });
  });

  test("on a hex scene an edit out of sight is remembered by hex, and the build shows once they see it again", () => {
    withCellVision(() => {
      const state = fogRoom({ vision: true, scene: { gridShape: "hexRows" } });
      state.tokens.ayla = token("ayla", { kind: "pc", ownerIds: ["p1"], x: 5, y: 5 });
      let s = batch(state, [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["4,5", "5,5", "6,5"] }]).state;
      assert.equal(cellShown(s, 5, 5), "stone");
      s = batch(s, [move(30, 5)]).state;
      const edited = batch(s, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["5,5", "30,20"] }]);
      assert.equal(edited.remember.length, 1);
      assert.deepEqual(party(edited.state)?.cells, { "5,5": "stone" }, "the hex they saw, and nothing of one they never did");
      assert.equal(cellShown(edited.state, 5, 5), "stone");
      const back = batch(edited.state, [move(5, 5)]);
      assert.equal(cellShown(back.state, 5, 5), "wood");
      assert.equal(party(back.state)?.cells?.["5,5"], undefined);
    });
  });

  test("a door a monster opens far off stays shut on their maps", () => {
    withCellVision(() => {
      const left = leftCrypt();
      const opened = batch(left, [{ t: "door.set", sceneId: "s1", door: { edge: "10,5,w" }, state: "open" }]).state;
      assert.deepEqual(edgeShown(opened, "10,5,w"), { kind: "door", state: "closed", secret: false, discovered: false });
      assert.equal(projectState(opened, DM, { sceneId: "s1" }).buildChunks[chunkKey("s1", 0, 0)]?.edges["10,5,w"]?.kind, "door");
    });
  });

  test("nothing is remembered of an edit in sight or on ground never seen, and an undo leaves no entry", () => {
    withCellVision(() => {
      const start = batch(crypt(), []).state;
      const inSight = batch(start, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["4,4"] }]);
      assert.equal(inSight.remember.length, 0);
      assert.equal(cellShown(inSight.state, 4, 4), "wood");
      const left = leftCrypt();
      const unseen = batch(left, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["20,20"] }]);
      assert.equal(unseen.remember.length, 0, "ground never explored holds nothing to remember");
      const painted = batch(left, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["4,4"] }]).state;
      assert.equal(party(painted)?.cells?.["4,4"], "stone");
      const undone = batch(painted, [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["4,4"] }]);
      assert.equal(party(undone.state), undefined, "an entry equal to the build now drops");
      // The second edit of an element keeps what they saw, not the first edit.
      const twice = batch(painted, [{ t: "build.paint", sceneId: "s1", terrain: "grass", cells: ["4,4"] }]).state;
      assert.equal(party(twice)?.cells?.["4,4"], "stone");
    });
  });

  test("an automatic wall that appears or goes out of sight keeps its kind", () => {
    withCellVision(() => {
      const left = leftCrypt();
      assert.equal(edgeShown(left, "2,4,w"), "auto", "the room's west side is an automatic wall");
      const widened = batch(left, [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,4"] }]).state;
      assert.equal(party(widened)?.edges?.["2,4,w"], "auto");
      assert.equal(edgeShown(widened, "2,4,w"), "auto");
    });
  });

  test("a change of the automatic walls rule out of sight is remembered, with no memory before it (MD3-ASTRA-1)", () => {
    withCellVision(() => {
      const left = leftCrypt();
      assert.equal(party(left), undefined, "nothing remembered yet");
      assert.equal(edgeShown(left, "2,4,w"), "auto");
      const off = batch(left, [{ t: "scene.update", sceneId: "s1", patch: { autoWalls: "off" } }]);
      assert.equal(off.remember.length, 1, "a scene change alone runs the step");
      assert.equal(party(off.state)?.edges?.["2,4,w"], "auto");
      assert.equal(edgeShown(off.state, "2,4,w"), "auto", "their map keeps the wall they saw");
      // The DM's build has none now.
      assert.equal(projectState(off.state, DM, { sceneId: "s1" }).scenes.s1?.autoWalls, "off");
      // The ask's estimate and the fail-closed forgetting read the change too.
      const r = applyOp(left, { t: "scene.update", sceneId: "s1", patch: { autoWalls: "off" } }, DM, env(50));
      assert.ok(r.ok);
      assert.ok((memoryGrowth(left, r.state, r.touched).get(layerKey("s1", null)) ?? 0) > 0, "the estimate counts it");
      assert.deepEqual(forgetAllOps({ before: left, after: r.state, touched: r.touched }).map((o) => o.sceneId), ["s1"]);
    });
  });

  test("so is one on a played scene that is not the players' scene, where nobody looks", () => {
    withCellVision(() => {
      let s = crypt();
      s.scenes.s2 = { ...s.scenes.s1!, id: "s2", name: "Cellar", order: 1 };
      const cells: Record<string, "stone"> = {};
      for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) cells[`${x},${y}`] = "stone";
      s.buildChunks = { ...s.buildChunks, [chunkKey("s2", 0, 0)]: { sceneId: "s2", cx: 0, cy: 0, rev: 1, cells, edges: {} } };
      lift(s, "party", { x: 0, y: 0, w: 8, h: 8 }, "s2");
      s.playedScenes = { ...s.playedScenes, s2: { sceneId: "s2", rev: 0 } };
      s = batch(s, []).state;
      const off = batch(s, [{ t: "scene.update", sceneId: "s2", patch: { autoWalls: "off" } }]).state;
      assert.equal(off.memory?.[chunkKey("s2", 0, 0)]?.edges?.["2,3,w"], "auto");
    });
  });

  test("a room erased out of sight under one rule shows no outline once the rule changes (MD3-D-1)", () => {
    withCellVision(() => {
      let s = crypt();
      // The party explored the cellar, all stone, with the rule off, and is back on s1.
      s.scenes.s2 = { ...s.scenes.s1!, id: "s2", name: "Cellar", order: 1, autoWalls: "off" };
      const cells: Record<string, "stone"> = {};
      for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) cells[`${x},${y}`] = "stone";
      s.buildChunks = { ...s.buildChunks, [chunkKey("s2", 0, 0)]: { sceneId: "s2", cx: 0, cy: 0, rev: 1, cells, edges: {} } };
      lift(s, "party", { x: 0, y: 0, w: 10, h: 10 }, "s2");
      s.playedScenes = { ...s.playedScenes, s2: { sceneId: "s2", rev: 0 } };
      s = batch(s, []).state;
      s = batch(s, [{ t: "build.erase", sceneId: "s2", cells: ["4,4", "5,4", "4,5", "5,5"] }]).state;
      const all = batch(s, [{ t: "scene.update", sceneId: "s2", patch: { autoWalls: "all" } }]).state;
      const memory = all.memory?.[chunkKey("s2", 0, 0)];
      assert.equal(memory?.cells?.["4,4"], "stone");
      for (const key of ["4,4,w", "4,4,n", "6,4,w", "4,6,n"]) assert.equal(memory?.edges?.[key], null, `${key} remembered without a wall`);
      // Back in the cellar, out of sight of the hole, their map shows the stone floor they saw and no outline.
      const there = { ...all, meta: { ...all.meta, playerSceneId: "s2" } };
      const chunk = projectState(there, P1, { sceneId: "s2" }).buildChunks[chunkKey("s2", 0, 0)] as PlayerChunk | undefined;
      assert.equal(chunk?.cells["4,4"], "stone");
      for (const key of ["4,4,w", "4,4,n", "6,4,w", "4,6,n"]) assert.ok(!autoAt(chunk, key) && chunk?.edges[key] === undefined, `${key} shows no wall`);
    });
  });

  test("a free wall goes cell by cell: cells 5 to 8 of a corridor wall, taken away out of sight, stay as remembered (LK-32)", () => {
    withCellVision(() => {
      let s = crypt();
      paint(s, { x: 0, y: 12, w: 16, h: 2 });
      const w = wall(s, "corridorwall", [0, 12.5], [8, 12.5]);
      s.tokens.ayla = { ...s.tokens.ayla!, x: 4, y: 12 };
      s = batch(s, []).state;
      // Ayla walks the corridor, then stands at its west end, seeing cells 0..3 of it.
      s = batch(s, [move(8, 12)]).state;
      s = batch(s, [move(0, 12)]).state;
      const cut = batch(s, [{ t: "build.walls", sceneId: "s1", put: [{ ...w, b: [4, 12.5] }] }]).state;
      const versions = party(cut)?.walls?.corridorwall;
      assert.ok(versions, "the wall's far cells are remembered");
      assert.deepEqual(versions, [{ wall: w, cells: ["4,12", "5,12", "6,12", "7,12"] }]);
      const shown = wallsOf(cut, P1).filter((p) => p.a[1] === 12.5);
      assert.ok(shown.some((p) => Math.max(p.a[0], p.b[0]) >= 7.99), "a piece still reaches the far end");
    });
  });

  test("a stair run edited chunks away, out of sight, keeps its direction as remembered on every chunk it passes through", () => {
    withCellVision(() => {
      let s = crypt();
      // A run of stairs along row 20 from x = 2 to x = 40, over chunks 0 to 2, its east end pointing east, so the whole run does.
      const run: [number, number][] = Array.from({ length: 39 }, (_, i) => [2 + i, 20]);
      paint(s, { x: 2, y: 20, w: 39, h: 1 });
      stairs(s, run, "a");
      stairs(s, [[40, 20]], "e");
      lift(s, "party", { x: 0, y: 16, w: 48, h: 8 });
      s = batch(s, []).state;
      const upDir = (state: RoomState, x: number) => chunksOf(state, P1)[`${Math.floor(x / 16)},1`]?.upDir?.[(20 - 16) * 16 + (x % 16)];
      assert.equal(upDir(s, 3), "e", "the run points east, from its east end");
      // The DM turns the east end west, chunks away from x = 3 and out of the party's sight.
      const turned = batch(s, [{ t: "build.stairs", sceneId: "s1", cells: ["40,20"], up: "w" }]).state;
      assert.equal(party(turned, 0, 1)?.upDir?.["3,20"], "e", "the far chunk's stairs are remembered as they pointed");
      assert.equal(upDir(turned, 3), "e");
      assert.equal(upDir(turned, 40), "e", "and the end itself");
      // Once Ayla stands on the run, the live direction replaces what they remembered there.
      const seen = batch(turned, [move(4, 20)]).state;
      assert.equal(upDir(seen, 3), "w");
      assert.equal(party(seen, 0, 1)?.upDir?.["3,20"], undefined);
    });
  });

  test("a stamp the DM keeps to themselves out of sight is never remembered, alone or beside an edit the step remembers (MD3-LK-1)", () => {
    withCellVision(() => {
      const stamp = (overrides: Partial<Stamp> = {}): Stamp => ({ id: "st1", rev: 0, sceneId: "s1", art: { key: "oak-tree" }, x: 4, y: 4, w: 1, h: 1, rotation: 0, z: 0, visibility: "all", ...overrides });
      let s = crypt();
      s.stamps = { st1: stamp() };
      s = batch(s, []).state;
      s = batch(s, [move(7, 5)]).state;
      s = batch(s, [move(30, 5)]).state;
      assert.ok(projectState(s, P1, { sceneId: "s1" }).stamps.st1, "Ayla's copy shows the stamp she saw");
      const hide: Op = { t: "build.stamps", sceneId: "s1", put: [stamp({ visibility: "dm" })] };
      const alone = batch(s, [hide]);
      assert.equal(alone.state.memory?.[chunkKey("s1", 0, 0)]?.stamps?.st1, undefined);
      const hidden = applyOp(s, hide, DM, env(60));
      assert.ok(hidden.ok);
      assert.equal(memoryGrowth(s, hidden.state, hidden.touched).get(layerKey("s1", null)) ?? 0, 0, "the ask's estimate counts nothing for it");
      assert.equal(projectState(alone.state, P1, { sceneId: "s1" }).stamps.st1, undefined, "its art leaves their map");
      const beside = batch(s, [hide, { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["4,4"] }]);
      const memory = party(beside.state);
      assert.equal(memory?.cells?.["4,4"], "stone", "the paint beside it is remembered");
      assert.equal(memory?.stamps?.st1, undefined);
      assert.equal(cellShown(beside.state, 4, 4), "stone");
      // A stamp set DM-only and changed in the same breath is still never written back.
      const changed = batch(s, [{ t: "build.stamps", sceneId: "s1", put: [stamp({ visibility: "dm", x: 5 })] }]);
      assert.equal(party(changed.state)?.stamps?.st1, undefined);
    });
  });

  test("a label moved out of sight from in sight is gone from where they saw it and not shown where it went", () => {
    withCellVision(() => {
      let s = crypt();
      const label: Label = { id: "lb1", rev: 0, sceneId: "s1", x: 4, y: 8, text: "Altar", size: 1 };
      s.labels = { lb1: label };
      s = batch(s, []).state;
      s = batch(s, [move(7, 5)]).state;
      // From (5, 9) she sees 2..8 x 6..12: the label at (4, 8) is in sight, (4, 3) out of it.
      s = batch(s, [move(5, 9)]).state;
      const moved = batch(s, [{ t: "build.label", sceneId: "s1", labelId: "lb1", label: { x: 4, y: 3, text: "Altar", size: 1 } }]).state;
      assert.equal(projectState(moved, P1, { sceneId: "s1" }).labels.lb1, undefined, "remembered as absent where it went");
      assert.equal(party(moved)?.labels?.lb1, null);
    });
  });

  test("a label moved onto remembered ground from ground they never held comes back as absent (MD2-LK-8, MD1's undo case)", () => {
    withCellVision(() => {
      const left = leftCrypt();
      const made = batch(left, [{ t: "build.label", sceneId: "s1", labelId: "lb2", label: { x: 40, y: 25, text: "Trap", size: 1 } }]).state;
      assert.equal(party(made), undefined, "made where they never were");
      const moved = batch(made, [{ t: "build.label", sceneId: "s1", labelId: "lb2", label: { x: 4, y: 4, text: "Trap", size: 1 } }]).state;
      assert.equal(projectState(moved, P1, { sceneId: "s1" }).labels.lb2, undefined, "not shown live where they only remember");
      assert.equal(party(moved)?.labels?.lb2, null);
      // Taken off their ground its entry goes, and put back it is written again.
      const away = batch(moved, [{ t: "build.label", sceneId: "s1", labelId: "lb2", label: { x: 40, y: 25, text: "Trap", size: 1 } }]).state;
      assert.equal(party(away)?.labels?.lb2, undefined);
      const back = batch(away, [{ t: "build.label", sceneId: "s1", labelId: "lb2", label: { x: 4, y: 4, text: "Trap", size: 1 } }]).state;
      assert.equal(party(back)?.labels?.lb2, null);
      assert.equal(projectState(back, P1, { sceneId: "s1" }).labels.lb2, undefined);
    });
  });

  test("behind a blackout nothing is seen, so an edit where the party stands is remembered", () => {
    withCellVision(() => {
      let s = batch(crypt(), []).state;
      s = batch(s, [{ t: "view.blackout", blackout: true }]).state;
      const painted = batch(s, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["4,4"] }]).state;
      assert.equal(party(painted)?.cells?.["4,4"], "stone");
    });
  });

  test("a door a player touched drops its entries in the layers they read", () => {
    withCellVision(() => {
      const left = leftCrypt();
      const opened = batch(left, [{ t: "door.set", sceneId: "s1", door: { edge: "10,5,w" }, state: "open" }]).state;
      assert.ok(party(opened)?.edges?.["10,5,w"]);
      const touched = batch(opened, [], { doors: [{ sceneId: "s1", door: { edge: "10,5,w" }, memberId: "p1" }] }).state;
      assert.equal(party(touched)?.edges?.["10,5,w"], undefined);
      assert.deepEqual(edgeShown(touched, "10,5,w"), { kind: "door", state: "open", secret: false, discovered: false });
    });
  });

  test("past its cap a layer forgets whole fog tiles, keeping the sub-cells in its sight", () => {
    withCellVision(() => {
      let s = crypt();
      paint(s, { x: 16, y: 2, w: 8, h: 8 });
      s = batch(s, []).state;
      // Explore both tiles of the row, then stand in the first.
      s = batch(s, [move(20, 5)]).state;
      s = batch(s, [move(13, 5)]).state;
      const cells = (x0: number) => Array.from({ length: 6 }, (_, i) => `${x0 + i},3`);
      const edits: Op[] = [
        { t: "build.paint", sceneId: "s1", terrain: "wood", cells: cells(2) },
        { t: "build.paint", sceneId: "s1", terrain: "wood", cells: cells(18) },
      ];
      const roomy = batch(s, edits);
      assert.ok(party(roomy.state, 0, 0) && party(roomy.state, 1, 0), "with room, both tiles remember");
      assert.equal(roomy.remember[0]!.forget, undefined);
      // Room for the first tile's chunk of memory and not the second's.
      const first = chunkCharge(roomy.state.scenes.s1!, party(roomy.state, 0, 0)!);
      const tight = batch(s, edits, { cap: first + 10 });
      const forget = tight.remember[0]!.forget;
      assert.ok(forget && forget.length === 1, JSON.stringify(forget));
      // Tile (0, 0) fits and is kept, tile (1, 0) does not and goes, but for what Ayla sees of it now.
      assert.deepEqual(
        forget[0]!.tiles.map((t) => [t.tx, t.ty]),
        [[1, 0]],
      );
      assert.ok(forget[0]!.tiles[0]!.keep, "the sub-cells in sight stay");
      const layer = decodeTile(tight.state.exploredTiles[tileKey("s1", 1, 0)]!.bits)!;
      assert.ok(getBit(layer, 0 * 4 + 1, 5 * 4 + 1), "cell (16, 5), in sight, stays explored");
      assert.ok(!getBit(layer, 4 * 4 + 1, 3 * 4 + 1), "cell (20, 3), out of sight, is forgotten");
      assert.equal(party(tight.state, 1, 0), undefined);
      assert.ok(!knownAt(chunksOf(tight.state, P1)["1,0"], 20, 3), "an element held only through a forgotten tile leaves the projection");
      assert.equal(cellShown(tight.state, 4, 3), "stone", "the tile that fit keeps what they remember");
    });
  });

  test("where the step cannot run, the scenes the batch wrote on forget all but what is in sight, so the edit shows to no one (rule 9)", () => {
    withCellVision(() => {
      // Ayla back in the room sees 2..8 of it, and the east column 9 she explored stays out of her sight.
      const left = leftCrypt();
      const back = batch(left, [move(5, 5)]).state;
      const before = back;
      const r = applyOp(back, { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["9,5"] }, DM, env(90));
      assert.ok(r.ok);
      const ops = forgetAllOps({ before, after: r.state, touched: r.touched });
      assert.equal(ops.length, 1);
      assert.ok(serverOnlyOpSchema.safeParse(ops[0]).success);
      const done = applyOp(r.state, ops[0]!, SERVER, env(91));
      assert.ok(done.ok);
      assert.equal(cellShown(done.state, 9, 5), undefined, "the edit out of sight shows to no one");
      assert.equal(cellShown(done.state, 5, 5), "stone", "what is in sight stays");
      assert.equal(cellShown(done.state, 30, 5), undefined);
    });
  });

  test("per player, a holder's own layer remembers from their own sight, the party's from the shared sight", () => {
    withCellVision(() => {
      let s = crypt();
      s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright", perPlayer: true } };
      s.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
      // p1's own explored ground: the room's west half, which the party's layer does not hold.
      lift(s, { holder: "p1" }, { x: 2, y: 2, w: 3, h: 8 });
      s.tokens.ayla = { ...s.tokens.ayla!, x: 30, y: 20 };
      const painted = batch(s, [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["3,3"] }]).state;
      assert.equal(painted.memoryBy?.[holderChunkKey("s1", "p1", 0, 0)]?.cells?.["3,3"], "stone");
      assert.equal(party(painted), undefined, "the party never held it");
      assert.equal(cellShown(painted, 3, 3), "stone");
    });
  });
});

describe("the estimate for the ask (5.3)", () => {
  function assertGrowthCoversStep(before: RoomState, op: Op): void {
    const result = applyOp(before, op, DM, env(9));
    assert.ok(result.ok);
    const growth = memoryGrowth(before, result.state, result.touched);
    let after = result.state;
    for (const remember of mapStepOps({ before, after, touched: result.touched, cap: () => Infinity })) {
      const applied = applyOp(after, remember, SERVER, env(10));
      assert.ok(applied.ok);
      after = applied.state;
    }
    for (const layer of [null, "p1"] as const) {
      const charge = (state: RoomState) => Object.values(layer === null ? state.memory ?? {} : state.memoryBy ?? {})
        .filter((chunk) => chunk.sceneId === "s1" && (chunk.memberId ?? null) === layer)
        .reduce((sum, chunk) => sum + chunkCharge(state.scenes.s1!, chunk), 0);
      const actual = charge(after) - charge(before);
      assert.ok(actual > 0, `the fixture adds memory for ${layer}`);
      assert.ok((growth.get(layerKey("s1", layer)) ?? 0) >= actual, `the estimate covers ${actual} bytes for ${layer}`);
    }
  }

  test("a 2,000-cell edit outside every held layer does no detailed terrain reads", () => {
    const before = fogRoom({ vision: true, perPlayer: true, bounds: { w: 160, h: 64 } });
    before.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    lift(before, "party", { x: 1, y: 1, w: 1, h: 1 });
    lift(before, { holder: "p1" }, { x: 2, y: 2, w: 1, h: 1 });
    const cells = Array.from({ length: 2_000 }, (_, i) => `${32 + i % 100},${16 + Math.floor(i / 100)}`);
    const result = applyOp(before, { t: "build.paint", sceneId: "s1", terrain: "stone", cells }, DM, env(9));
    assert.ok(result.ok);
    let reads = 0;
    const after = { ...result.state, buildChunks: Object.fromEntries(Object.entries(result.state.buildChunks).map(([key, chunk]) => [key, {
      ...chunk,
      cells: new Proxy(chunk.cells, { get(target, property, receiver) {
        if (typeof property === "string" && Object.hasOwn(target, property)) reads++;
        return Reflect.get(target, property, receiver);
      } }),
    }])) };
    assert.equal(memoryGrowth(before, after, result.touched).size, 0);
    assert.equal(reads, 0, "unheld cells need no terrain values or automatic-wall comparisons");
  });

  test("counts every change on a layer's remembered ground, out of sight or not, and nothing elsewhere", () => {
    withCellVision(() => {
      const s = batch(crypt(), []).state;
      const op: Op = { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["4,4", "40,25"] };
      const r = applyOp(s, op, DM, env(9));
      assert.ok(r.ok);
      const growth = memoryGrowth(s, r.state, r.touched);
      // In sight now, yet counted: the estimate never reads sight, so it is never low.
      assert.ok((growth.get(JSON.stringify(["s1", null])) ?? 0) > 0);
      const far: Op = { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["40,25"] };
      const r2 = applyOp(s, far, DM, env(9));
      assert.ok(r2.ok);
      assert.equal(memoryGrowth(s, r2.state, r2.touched).size, 0, "ground no layer holds adds nothing");
    });
  });

  test("moved marks count both the old and new held boxes for every layer", () => {
    for (const field of ["label", "stamp"] as const) for (const heldX of [4, 34]) {
      const before = fogRoom({ vision: true, perPlayer: true });
      before.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
      lift(before, "party", { x: heldX, y: 4, w: 2, h: 2 });
      lift(before, { holder: "p1" }, { x: heldX, y: 4, w: 2, h: 2 });
      if (field === "label") {
        before.labels.mark12345678 = { id: "mark12345678", sceneId: "s1", rev: 0, x: 4, y: 4, text: "X", size: 1 };
        assertGrowthCoversStep(before, { t: "build.label", sceneId: "s1", labelId: "mark12345678", label: { x: 34, y: 4, text: "X", size: 1 } });
      } else {
        const stamp = { id: "mark12345678", art: { key: "barrel" }, x: 4, y: 4, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" as const };
        before.stamps[stamp.id] = { ...stamp, sceneId: "s1", rev: 0 };
        assertGrowthCoversStep(before, { t: "build.stamps", sceneId: "s1", put: [{ ...stamp, x: 34 }] });
      }
    }
  });

  test("moved walls count old and new held spans outside their midpoint chunks", () => {
    for (const heldX of [14, 30]) {
      const before = fogRoom({ vision: true, perPlayer: true });
      before.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
      lift(before, "party", { x: heldX, y: 4, w: 1, h: 1 });
      lift(before, { holder: "p1" }, { x: heldX, y: 4, w: 1, h: 1 });
      const old = wall(before, "wall12345678", [14, 4.5], [22, 4.5]);
      assertGrowthCoversStep(before, { t: "build.walls", sceneId: "s1", remove: [{ cx: 1, cy: 0, id: old.id }], put: [{ ...old, a: [30, 4.5], b: [38, 4.5] }] });
    }
  });

  test("changed explored layers invalidate an estimate without changing the build", () => {
    const before = fogRoom({ vision: true });
    const result = applyOp(before, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["4,4"] }, DM, env(9));
    assert.ok(result.ok);
    assert.equal(memoryGrowth(before, result.state, result.touched).size, 0);
    const explored = { ...result.state };
    lift(explored, "party", { x: 4, y: 4, w: 1, h: 1 });
    assert.ok((memoryGrowth(before, explored, result.touched).get(layerKey("s1", null)) ?? 0) > 0);
  });

  test("an unheld edit counts the automatic edge beside held ground in the previous chunk", () => {
    const before = fogRoom({ vision: true, perPlayer: true });
    before.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    lift(before, "party", { x: 15, y: 4, w: 1, h: 1 });
    lift(before, { holder: "p1" }, { x: 15, y: 4, w: 1, h: 1 });
    assertGrowthCoversStep(before, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["16,4"] });
  });

  test("an unheld stair edit still counts changed directions in distant held chunks", () => {
    const before = fogRoom({ vision: true, perPlayer: true });
    before.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    const run: [number, number][] = Array.from({ length: 39 }, (_, i) => [2 + i, 20]);
    paint(before, { x: 2, y: 20, w: 39, h: 1 });
    stairs(before, run, "a");
    stairs(before, [[40, 20]], "e");
    lift(before, "party", { x: 3, y: 20, w: 1, h: 1 });
    lift(before, { holder: "p1" }, { x: 3, y: 20, w: 1, h: 1 });
    assertGrowthCoversStep(before, { t: "build.stairs", sceneId: "s1", cells: ["40,20"], up: "w" });
  });
});
