import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { autoAt, chunksOf, edge, fogRoom, knownAt, lift, paint } from "./discoveryTestutil.ts";
import { chunkKey, keys } from "./keys.ts";
import { DOOR_COVER_OP_VERSION, DOOR_COVER_SNAPSHOT_VERSION, migrateOp, migrateSnapshot, OP_VERSION, opMigrations, runMigrations, SNAPSHOT_VERSION, snapshotMigrations, writesDoorCover } from "./migrate.ts";

/** The op and snapshot versions just before covers. */
const OP_BEFORE = DOOR_COVER_OP_VERSION - 1;
const SNAPSHOT_BEFORE = DOOR_COVER_SNAPSHOT_VERSION - 1;
import type { AutoWalls, DoorCover, EdgeFeature, RoomState } from "./model.ts";
import { privateFieldsIn } from "./privateFields.ts";
import { projectChunkForPlayer, projectState, shownEdge, stableStringify } from "./project.ts";
import { memorySchemas, opSchema, type Op } from "./protocol.ts";
import { canApply } from "./permissions.ts";
import { applyOp } from "./reducer.ts";
import { guardMatches } from "./reducer/misc.ts";
import { guardHash } from "./reducer/tx.ts";
import { COVER_REACH, coverOfLine } from "./rules/autoWalls.ts";
import { HIDDEN_DOOR, twins, withoutRevs } from "./secretDoorTestutil.ts";
import { DM, P1, apply, env, room } from "./testutil.ts";

/**
 * Secret door covers (docs/design/design-v1-maps-vision.md 2.1, SB1 to SB6):
 * the cover `build.edge` writes and what keeps it, the look a hidden door
 * reaches players as, by its cover, its two real cells and the scene's rule
 * alone, the fog-off projection, the cases the twin test's precondition
 * leaves out, and doors from before covers. The twin test through the room
 * actor is server/rooms/secretDoor.random.test.ts.
 */

const door = (cover?: DoorCover, found = false): EdgeFeature => ({ kind: "door", state: "closed", secret: true, discovered: found, ...(cover ? { cover } : {}) });
const WALL: EdgeFeature = { kind: "wall" };

/** A room whose scene s1 has the rule given, a stone room from 2, 2 to 7, 7 and a lone stone square at 9, 4. */
function walled(rule: AutoWalls = "all"): RoomState {
  const state = fogRoom({ bounds: { w: 40, h: 24 }, scene: { autoWalls: rule } });
  paint(state, { x: 2, y: 2, w: 6, h: 6 });
  return state;
}

function edgeOf(state: RoomState, key: string): EdgeFeature | undefined {
  const [x, y] = key.split(",").map(Number) as [number, number];
  return state.buildChunks[chunkKey("s1", Math.floor(x / 16), Math.floor(y / 16))]?.edges[key];
}

function build(state: RoomState, edges: { key: string; feature: EdgeFeature | null }[], opVersion?: number): RoomState {
  const result = applyOp(state, { t: "build.edge", sceneId: "s1", edges }, DM, { ...env(5), ...(opVersion === undefined ? {} : { opVersion }) });
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.state;
}

describe("a new secret door's cover from its line (coverOfLine)", () => {
  test("automatic where the real cells already wall the edge, whatever the line", () => {
    const state = walled();
    // The room's north side at y 2: stone below, rock above.
    edge(state, "3,2,n", WALL);
    edge(state, "5,2,n", WALL);
    assert.equal(coverOfLine(state.buildChunks, "s1", "all", "4,2,n"), "auto");
  });

  test("drawn where the nearest wall along the line on either side is drawn, past doors, windows and openings", () => {
    const state = walled();
    // A drawn wall across the room on x 5, west edges, with a door, a window and an opening between it and the door at 5,3.
    edge(state, "5,4,w", { kind: "door", state: "open", secret: false, discovered: false });
    edge(state, "5,5,w", { kind: "window" });
    edge(state, "5,6,w", { kind: "none" });
    edge(state, "5,7,w", WALL);
    assert.equal(coverOfLine(state.buildChunks, "s1", "all", "5,3,w"), "drawn", "south, past the door, window and opening");
    const north = walled();
    edge(north, "5,2,w", WALL);
    assert.equal(coverOfLine(north.buildChunks, "s1", "all", "5,3,w"), "drawn", "north, one edge away");
  });

  test("automatic where the nearest wall each way is automatic, even with a drawn one past it", () => {
    const state = walled();
    // A passage east from the room's east side on row 4: the side's automatic walls stand either side of its door.
    paint(state, { x: 8, y: 4, w: 2, h: 1 });
    edge(state, "8,7,w", WALL);
    assert.equal(coverOfLine(state.buildChunks, "s1", "all", "8,4,w"), "auto");
  });

  test("a drawn wall past COVER_REACH edges is not the line's", () => {
    const state = fogRoom({ bounds: { w: 60, h: 24 }, scene: { autoWalls: "all" } });
    paint(state, { x: 2, y: 4, w: 40, h: 2 });
    edge(state, `${20 + COVER_REACH + 1},5,n`, WALL);
    assert.equal(coverOfLine(state.buildChunks, "s1", "all", "20,5,n"), "auto");
    edge(state, `${20 + COVER_REACH},5,n`, WALL);
    assert.equal(coverOfLine(state.buildChunks, "s1", "all", "20,5,n"), "drawn", "and one at the reach is");
  });

  test("reads across a chunk border, and two secret doors side by side each read past the other", () => {
    const state = fogRoom({ bounds: { w: 40, h: 24 }, scene: { autoWalls: "all" } });
    paint(state, { x: 10, y: 4, w: 12, h: 2 });
    edge(state, "15,5,n", door("auto"));
    edge(state, "13,5,n", WALL);
    assert.equal(coverOfLine(state.buildChunks, "s1", "all", "16,5,n"), "drawn");
    assert.equal(coverOfLine(state.buildChunks, "s1", "all", "17,5,n"), "drawn");
  });

  test("on an \"off\" scene only drawn walls count, and with none near the cover is automatic", () => {
    const state = walled("off");
    assert.equal(coverOfLine(state.buildChunks, "s1", "off", "2,4,w"), "auto");
    edge(state, "2,6,w", WALL);
    assert.equal(coverOfLine(state.buildChunks, "s1", "off", "2,4,w"), "drawn");
  });
});

describe("build.edge writes the cover (SB1)", () => {
  test("a hidden secret door takes its line's cover, automatic in an automatic line and drawn in a drawn one", () => {
    const state = walled();
    edge(state, "5,3,w", WALL);
    const after = build(state, [
      { key: "4,2,n", feature: door() },
      { key: "5,4,w", feature: door() },
    ]);
    assert.equal((edgeOf(after, "4,2,n") as { cover?: string }).cover, "auto");
    assert.equal((edgeOf(after, "5,4,w") as { cover?: string }).cover, "drawn");
  });

  test("the op's own cover wins, then the cover of the door it replaces, so hiding a found door again keeps it", () => {
    const state = walled();
    edge(state, "5,3,w", WALL);
    let after = build(state, [{ key: "5,4,w", feature: door("auto") }]);
    assert.equal((edgeOf(after, "5,4,w") as { cover?: string }).cover, "auto", "the op's own, not the drawn line's");
    after = build(after, [{ key: "5,4,w", feature: door(undefined, true) }]);
    assert.equal((edgeOf(after, "5,4,w") as { cover?: string }).cover, "auto", "a found door keeps the cover of the door it replaces");
    after = build(after, [{ key: "5,4,w", feature: { kind: "door", state: "open", secret: true, discovered: true } }]);
    after = build(after, [{ key: "5,4,w", feature: door() }]);
    assert.equal((edgeOf(after, "5,4,w") as { cover?: string }).cover, "auto", "hidden again with the tool");
  });

  test("a plain door, a found secret door with no cover anywhere, and every other feature carry none", () => {
    const state = walled();
    const after = build(state, [
      { key: "4,2,n", feature: { kind: "door", state: "closed", secret: false, discovered: false, cover: "auto" } },
      { key: "5,2,n", feature: door(undefined, true) },
    ]);
    assert.deepEqual(edgeOf(after, "4,2,n"), { kind: "door", state: "closed", secret: false, discovered: false });
    assert.deepEqual(edgeOf(after, "5,2,n"), door(undefined, true));
  });

  test("a door drawn in one op with the walls of its line takes their kind", () => {
    const after = build(walled(), [
      { key: "5,3,w", feature: WALL },
      { key: "5,4,w", feature: door() },
      { key: "5,5,w", feature: WALL },
    ]);
    assert.equal((edgeOf(after, "5,4,w") as { cover?: string }).cover, "drawn");
  });

  test("an op stored below the step writes none, so a door it made keeps the look it had (writesDoorCover)", () => {
    assert.equal(writesDoorCover(undefined), true);
    assert.equal(writesDoorCover(OP_VERSION), true);
    assert.equal(writesDoorCover(OP_BEFORE), false);
    const after = build(walled(), [{ key: "4,2,n", feature: door() }], OP_BEFORE);
    assert.deepEqual(edgeOf(after, "4,2,n"), door());
  });

  test("an old door redrawn with the tool takes a cover by its line", () => {
    const state = walled();
    edge(state, "4,2,n", door());
    const after = build(state, [{ key: "4,2,n", feature: door() }]);
    assert.equal((edgeOf(after, "4,2,n") as { cover?: string }).cover, "auto");
  });

  test("Open, Close, Lock, Mark found and Hide keep the cover (doorSet)", () => {
    let state = walled();
    edge(state, "5,4,w", door("drawn"));
    const steps: Op[] = [
      { t: "door.set", sceneId: "s1", door: { edge: "5,4,w" }, state: "closed", found: true },
      { t: "door.set", sceneId: "s1", door: { edge: "5,4,w" }, state: "open" },
      { t: "door.set", sceneId: "s1", door: { edge: "5,4,w" }, state: "locked" },
      { t: "door.set", sceneId: "s1", door: { edge: "5,4,w" }, state: "closed", found: false },
    ];
    for (const op of steps) {
      state = apply(state, op);
      assert.equal((edgeOf(state, "5,4,w") as { cover?: string }).cover, "drawn", JSON.stringify(op));
    }
  });
});

describe("the look of a hidden secret door (SB2, SB4, SB5)", () => {
  /** The lone door at 7,4 on the room's east side, rock beyond, and one between two floors at 4,4. */
  function looks(cover: DoorCover | undefined, rule: AutoWalls): { outer: unknown; inner: unknown } {
    const state = walled(rule);
    edge(state, "8,4,w", door(cover));
    edge(state, "4,4,w", door(cover));
    return { outer: shownEdge(state.buildChunks, "s1", rule, "8,4,w"), inner: shownEdge(state.buildChunks, "s1", rule, "4,4,w") };
  }

  test("a drawn cover is a drawn wall under every rule, on a real automatic edge or between two floors", () => {
    for (const rule of ["all", "floor", "off"] as const) assert.deepEqual(looks("drawn", rule), { outer: WALL, inner: WALL }, rule);
  });

  test("an automatic cover is the automatic wall on every edge outside \"off\" scenes, and a drawn wall on them", () => {
    assert.deepEqual(looks("auto", "all"), { outer: "auto", inner: "auto" });
    assert.deepEqual(looks("auto", "floor"), { outer: "auto", inner: "auto" });
    assert.deepEqual(looks("auto", "off"), { outer: WALL, inner: WALL });
  });

  test("no cover keeps the look by the real cells, as before covers", () => {
    assert.deepEqual(looks(undefined, "all"), { outer: "auto", inner: WALL });
    assert.deepEqual(looks(undefined, "off"), { outer: WALL, inner: WALL });
  });

  test("a found door arrives as the door it is, a lock as closed, never with its cover, on every path (SB3, SB4)", () => {
    const state = walled();
    reveal(state);
    edge(state, "8,4,w", { kind: "door", state: "locked", secret: true, discovered: true, cover: "auto" });
    edge(state, "4,4,w", { kind: "door", state: "open", secret: true, discovered: true, cover: "drawn" });
    const plain = { kind: "door", state: "closed", secret: true, discovered: true };
    assert.deepEqual(shownEdge(state.buildChunks, "s1", "all", "8,4,w"), plain);
    assert.deepEqual(shownEdge(state.buildChunks, "s1", "all", "4,4,w"), { ...plain, state: "open" });
    const fogged = chunksOf(state, P1)["0,0"]!;
    assert.deepEqual(fogged.edges["8,4,w"], plain);
    const open = projectChunkForPlayer(state.buildChunks, state.buildChunks[chunkKey("s1", 0, 0)]!, "all")!;
    assert.deepEqual(open.edges["4,4,w"], { ...plain, state: "open" });
    for (const value of [projectState(state, P1, { sceneId: "s1" }), open]) assert.deepEqual(privateFieldsIn(value), []);
  });

  test("with fog off, the projection is the same bytes as before covers, but for a drawn cover on a real automatic edge", () => {
    const covered = walled();
    const before = walled();
    for (const [key, cover] of [["8,4,w", "auto"], ["4,4,w", "auto"], ["4,6,w", "drawn"], ["2,3,w", "drawn"]] as const) {
      edge(covered, key, door(cover));
      edge(before, key, door());
    }
    covered.scenes.s1!.fogEnabled = false;
    before.scenes.s1!.fogEnabled = false;
    const shown = (s: RoomState) => projectState(s, P1, { sceneId: "s1" }).buildChunks[chunkKey("s1", 0, 0)]!;
    // 2,3,w is the room's west side, a real automatic edge: before covers the door went, and drawn it is the wall it looks like.
    assert.deepEqual(shown(covered).edges, { ...shown(before).edges, "2,3,w": WALL });
    assert.deepEqual(shown(before).edges["2,3,w"], undefined);
  });
});

function reveal(state: RoomState, rect = { x: 0, y: 0, w: 40, h: 24 }): void {
  lift(state, "dm", rect);
}

describe("the cases outside the twin test's precondition, pinned", () => {
  test("a drawn door and a plain drawn wall stay alike when the rule goes from \"off\" to \"all\", the near square held and the far one rock (DR-ASTRA-18)", () => {
    for (const rule of ["off", "all"] as const) {
      const shown = (f: EdgeFeature) => {
        const state = walled(rule);
        reveal(state, { x: 5, y: 3, w: 3, h: 3 });
        edge(state, "8,4,w", f);
        return stableStringify(withoutRevs(chunksOf(state, P1)));
      };
      assert.equal(shown(door("drawn")), shown(WALL), rule);
    }
  });

  test("on an \"off\" scene an automatic door reaches players as a drawn wall, as one among the DM's walls (rule 4)", () => {
    const state = walled("off");
    reveal(state);
    edge(state, "4,4,w", door("auto"));
    const chunk = chunksOf(state, P1)["0,0"]!;
    assert.deepEqual(chunk.edges["4,4,w"], WALL);
    assert.ok(!autoAt(chunk, "4,4,w"));
  });

  test("R3: an automatic door beside an overlay square on a \"floor\" scene is the automatic wall, where rock beside it would be no wall", () => {
    const state = walled("floor");
    paint(state, { x: 8, y: 4, w: 1, h: 1 }, "water");
    paint(state, { x: 9, y: 4, w: 1, h: 1 });
    reveal(state, { x: 6, y: 3, w: 3, h: 3 });
    edge(state, "9,4,w", door("auto"));
    assert.ok(autoAt(chunksOf(state, P1)["0,0"], "9,4,w"));
    const rock = walled("floor");
    paint(rock, { x: 8, y: 4, w: 1, h: 1 }, "water");
    reveal(rock, { x: 6, y: 3, w: 3, h: 3 });
    assert.ok(!autoAt(chunksOf(rock, P1)["0,0"], "9,4,w"), "water beside rock has no wall under \"floor\"");
  });

  test("R1: a class that holds the far square too sees the automatic wall between two painted squares", () => {
    const state = walled();
    paint(state, { x: 8, y: 2, w: 4, h: 6 });
    edge(state, "8,4,w", door("auto"));
    reveal(state, { x: 6, y: 4, w: 4, h: 1 });
    const chunk = chunksOf(state, P1)["0,0"]!;
    assert.ok(knownAt(chunk, 7, 4) && knownAt(chunk, 8, 4) && chunk.cells["8,4"] === "stone");
    assert.ok(autoAt(chunk, "8,4,w"));
  });

  test("DR2-06: the DM erasing a near square leaves the door twin's automatic wall where the rock twin has none", () => {
    const w = twins({ cover: "auto", explore: false });
    for (const s of [w.door, w.rock]) {
      reveal(s, { x: 12, y: 4, w: 4, h: 3 });
    }
    const erase: Op = { t: "build.erase", sceneId: "s1", cells: ["15,5"] };
    const door = chunksOf(apply(w.door, erase), P1)["1,0"];
    const rock = chunksOf(apply(w.rock, erase), P1)["1,0"];
    assert.ok(autoAt(door, "16,5,w"));
    assert.ok(!autoAt(rock, "16,5,w"));
  });

  test("a player's door press on the hidden door is answered as on the twin's wall", () => {
    for (const cover of ["auto", "drawn"] as const) {
      const w = twins({ cover, explore: false });
      const press: Op = { t: "door.set", sceneId: "s1", door: { edge: "16,5,w" }, state: "open", by: "a" };
      const answers = [w.door, w.rock].map((s) => {
        s.tokens.a = { ...s.tokens.a!, x: 15, y: 5 };
        reveal(s, { x: 12, y: 4, w: 4, h: 3 });
        const d = canApply(press, P1, s, { canUseAsset: () => true });
        return d.ok ? "ok" : `${d.code}: ${d.message}`;
      });
      assert.equal(answers[0], answers[1], cover);
      assert.match(answers[0]!, /^gone/);
    }
  });

  test("twins alike for a class at the near square, live, and for each Wide doorway edge", () => {
    for (const cover of ["auto", "drawn"] as const) {
      for (const wide of [false, true]) {
        const w = twins({ cover, wide, explore: false });
        const views = [w.door, w.rock].map((s) => {
          reveal(s, { x: 10, y: 4, w: 6, h: 4 });
          return stableStringify(withoutRevs(projectState(s, P1, { sceneId: "s1" })));
        });
        assert.equal(views[0], views[1], `${cover}${wide ? ", wide" : ""}`);
      }
    }
  });
});

describe("doors from before covers (R2, D-261108-095)", () => {
  function old(): RoomState {
    const state = walled();
    paint(state, { x: 8, y: 2, w: 4, h: 6 });
    edge(state, "8,4,w", door());
    edge(state, "2,3,w", door());
    return state;
  }

  test("a snapshot from before loads with its chunks as stored, byte for byte, and its stored restores still match", () => {
    const state = old();
    const stored = structuredClone(state);
    const loaded = migrateSnapshot(stored, SNAPSHOT_BEFORE);
    assert.deepEqual(loaded.buildChunks, state.buildChunks);
    const key = keys.chunk("s1", 0, 0);
    assert.ok(guardMatches({ key, value: null, expectHash: guardHash(key, state.buildChunks[chunkKey("s1", 0, 0)]) }, loaded.buildChunks[chunkKey("s1", 0, 0)]));
    // A stored undo of a change made at the op version before covers replays against the loaded room as it applied.
    const made = applyOp(state, { t: "build.edge", sceneId: "s1", edges: [{ key: "3,2,n", feature: WALL }] }, DM, { ...env(3), opVersion: OP_BEFORE });
    assert.ok(made.ok && made.inverse);
    const undo: Op = { t: "sys.restore", entries: made.inverse, from: "undo", deps: true };
    const replay = applyOp(migrateSnapshot(structuredClone(made.state), SNAPSHOT_BEFORE), undo, DM, { ...env(4), opVersion: OP_BEFORE });
    assert.ok(replay.ok, replay.ok ? "" : replay.message);
    assert.deepEqual(withoutRevs(replay.state.buildChunks), withoutRevs(state.buildChunks));
  });

  test("a stored reveal of an old door's near square gives the look it had before covers: a wall between two floors, nothing where the rock walls it", () => {
    const state = old();
    const r = applyOp(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 12, h: 8 } }] }, DM, { ...env(3), opVersion: OP_BEFORE });
    assert.ok(r.ok);
    const chunk = chunksOf(r.state, P1)["0,0"]!;
    assert.deepEqual(chunk.edges["8,4,w"], WALL);
    assert.ok(autoAt(chunk, "2,3,w") && chunk.edges["2,3,w"] === undefined);
  });
});

describe("the versions and schemas (section 7)", () => {
  test("the op and snapshot steps of covers are identity steps, and an older build refuses either", () => {
    assert.ok(OP_VERSION >= DOOR_COVER_OP_VERSION && SNAPSHOT_VERSION >= DOOR_COVER_SNAPSHOT_VERSION);
    const op = { t: "build.edge", sceneId: "s1", edges: [{ key: "1,1,n", feature: { kind: "door", state: "closed", secret: true, discovered: false } }] };
    assert.equal(runMigrations(op, OP_BEFORE, DOOR_COVER_OP_VERSION, opMigrations), op);
    assert.equal(migrateOp(op, OP_BEFORE), op);
    const state = room();
    assert.equal(runMigrations(state, SNAPSHOT_BEFORE, DOOR_COVER_SNAPSHOT_VERSION, snapshotMigrations), state);
    assert.throws(() => runMigrations(op, DOOR_COVER_OP_VERSION, OP_BEFORE, opMigrations), /down/);
    assert.throws(() => runMigrations(state, DOOR_COVER_SNAPSHOT_VERSION, SNAPSHOT_BEFORE, snapshotMigrations), /down/);
  });

  test("build.edge takes a cover on a grid edge's door alone, and free walls and memory never take one", () => {
    const edgeOp = (feature: unknown) => opSchema.safeParse({ t: "build.edge", sceneId: "s1", edges: [{ key: "1,1,n", feature }] }).success;
    assert.ok(edgeOp({ ...HIDDEN_DOOR, cover: "auto" }));
    assert.ok(edgeOp({ ...HIDDEN_DOOR, cover: "drawn" }));
    assert.ok(!edgeOp({ ...HIDDEN_DOOR, cover: "maybe" }));
    assert.ok(!edgeOp({ kind: "wall", cover: "auto" }));
    const wallOp = opSchema.safeParse({ t: "build.walls", sceneId: "s1", put: [{ id: "abcdefghijkl", a: [1, 1], b: [2, 1], f: { ...HIDDEN_DOOR, cover: "auto" } }] });
    assert.ok(!wallOp.success, "a free door takes no cover");
    const found = { kind: "door", state: "closed", secret: true, discovered: true };
    assert.ok(memorySchemas.memoryEntries.safeParse({ edges: { "1,1,n": found } }).success);
    assert.ok(!memorySchemas.memoryEntries.safeParse({ edges: { "1,1,n": { ...found, cover: "auto" } } }).success, "memory holds doors as players see them");
  });

  test("the private fields walk finds a cover anywhere, so the twin and e2e walks catch one sent", () => {
    assert.deepEqual(privateFieldsIn({ t: "ev", changes: [{ key: "chunk:s1:0,0", value: { edges: { "1,1,n": { ...HIDDEN_DOOR, cover: "auto" } } } }] }), ['$.changes[0].value.edges.1,1,n.cover']);
    assert.deepEqual(privateFieldsIn({ t: "sys.remember", layers: [{ entries: { edges: { "1,1,n": { cover: "drawn" } } } }] }), ['$.layers[0].entries.edges.1,1,n.cover']);
  });
});
