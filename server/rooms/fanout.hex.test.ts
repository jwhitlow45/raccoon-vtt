import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Scene, Viewer } from "#shared/model.ts";
import { applyChanges, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, env, room } from "#shared/testutil.ts";
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
