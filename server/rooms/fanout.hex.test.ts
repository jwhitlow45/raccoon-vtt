import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey, wallChunk } from "#shared/keys.ts";
import type { FreeWall, RoomState, Scene, Viewer } from "#shared/model.ts";
import { applyChanges, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { clipFootprint, sightClipOf } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, P1, P2, env, reveal, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot, publishBatch } from "./fanout.ts";

/**
 * A hex scene through the server's own fan-out (docs/design-v1-hex-grids.md
 * section 7): a player's and a table display's snapshot carry the scene's
 * shape, and so does the scene change a switch sends them.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

function open(state: RoomState, who: Viewer): { conn: Connection; view: ProjectedState; inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "HEXFAN00", memberId: who.memberId, role: who.role }, "203.0.113.4");
  conn.sceneId = "s1";
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, view: snapshot.message.state as ProjectedState, inbox };
}

describe("a hex scene through the fan-out", () => {
  test("players' snapshots and scene changes carry its shape", () => {
    let state = room({ scenes: { s1: { ...room().scenes.s1!, gridShape: "hexRows" }, s2: room().scenes.s2! } });
    const viewers = [open(state, P1), open(state, DISPLAY)];
    for (const v of viewers) assert.equal(v.view.scenes.s1!.gridShape, "hexRows", `${v.conn.memberId}'s snapshot`);
    let seq = 1;
    for (const shape of ["hexColumns", "squares"] as const) {
      const before = state;
      const r = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { gridShape: shape } }, DM, env(++seq));
      assert.ok(r.ok);
      state = r.state;
      publishBatch({ seq, before, after: state, touched: r.touched, global: r.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
      for (const v of viewers) {
        const changes = v.inbox.splice(0).flatMap((msg) => (msg.t === "ev" ? (msg.changes as Change[]) : []));
        const scene = changes.find((c) => c.key === "scene:s1");
        assert.ok(scene && "value" in scene, `${v.conn.memberId} hears of the scene`);
        assert.equal((scene.value as Scene).gridShape, shape === "squares" ? undefined : shape);
        v.view = applyChanges(v.view, changes);
        assert.equal(stableStringify(v.view), stableStringify(projectState(state, v.conn.viewer, { sceneId: "s1" })), "the copy is a fresh projection");
      }
    }
  });
});

describe("a wall change on a hex scene through the fan-out (HX-D22)", () => {
  test("vision off, fog unchanged: a door closing through a goblin's hex takes the goblin from players without it moving", () => {
    const g = gridOfShape("hexRows") as HexGrid;
    let state = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", fogEnabled: true }), s2: scene("s2", { order: 1 }) } });
    const door: FreeWall = { id: "f00000000001", a: [5.4375, 0], b: [5.4375, 3], f: { kind: "door", state: "open", secret: false, discovered: false } };
    const { cx, cy } = wallChunk(door);
    state.buildChunks[chunkKey("s1", cx, cy)] = { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {}, walls: [door] };
    state.tokens.gob = token("gob", { x: 5.49, y: 0.2 });
    // Shut, the door would leave these 7 sub-cells of its hex beyond it: reveal only them.
    const shut = { ...door, f: { ...door.f, state: "closed" as const } };
    const clip = sightClipOf(sceneWalls(state.scenes.s1!, { [chunkKey("s1", cx, cy)]: { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {}, walls: [shut] } }));
    const { subs, keep } = clipFootprint(g, state.tokens.gob, clip);
    const behind = subs.filter((_, i) => keep?.[i] !== 1);
    assert.equal(behind.length, 7);
    for (const [sx, sy] of behind) reveal(state, "s1", { x: sx / 4, y: sy / 4, w: 0.25, h: 0.25 });
    const viewers = [open(state, P1), open(state, P2)];
    for (const v of viewers) assert.ok(v.view.tokens.gob, `${v.conn.memberId} sees the goblin past the open door`);
    const before = state;
    const r = applyOp(state, { t: "door.set", sceneId: "s1", door: { cx, cy, id: door.id }, state: "closed" }, DM, env(50));
    assert.ok(r.ok);
    state = r.state;
    assert.equal(r.global, false, "a wall change is no global change");
    assert.deepEqual(state.tokens.gob, before.tokens.gob, "the goblin did not move");
    publishBatch({ seq: 50, before, after: state, touched: r.touched, global: r.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
    for (const v of viewers) {
      const changes = v.inbox.splice(0).flatMap((msg) => (msg.t === "ev" ? (msg.changes as Change[]) : []));
      assert.ok(changes.some((c) => c.key === "token:gob"), `${v.conn.memberId} hears of the goblin`);
      v.view = applyChanges(v.view, changes);
      assert.equal(v.view.tokens.gob, undefined, `${v.conn.memberId} loses it`);
      assert.equal(stableStringify(v.view), stableStringify(projectState(state, v.conn.viewer, { sceneId: "s1" })), "the copy is a fresh projection");
    }
  });
});
