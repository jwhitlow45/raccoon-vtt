import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState } from "#shared/model.ts";
import { applyChanges, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { DM, P1, P2, actor, env, room, scene, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot, publishBatch } from "./fanout.ts";

/*
 * A per-player scene (docs/design-v1-per-player-vision.md 6.2): each sight
 * holder's own sight. Until the fan-out's projection classes are built
 * (section 6.9, lane PV3), no player's `ev` may carry what another player's
 * creatures see, so applying each socket's events to its snapshot must
 * still give that player's fresh projection.
 */
function twoRooms(): RoomState {
  const s = room();
  s.scenes = { s1: scene("s1", { bounds: { w: 32, h: 16 }, vision: { on: true, light: "dark", perPlayer: true }, autoWalls: "off" }) };
  const edges: Record<string, EdgeFeature> = {};
  for (let y = 0; y < 16; y++) edges[`16,${y},w`] = { kind: "wall" };
  s.buildChunks = { "s1:1,0": { sceneId: "s1", cx: 1, cy: 0, rev: 1, cells: {}, edges } };
  s.tokens = {
    a: token("a", { kind: "pc", ownerIds: [P1.memberId], x: 4, y: 8, actor: { inline: actor({ senses: "darkvision 30 ft" }) } }),
    b: token("b", { kind: "pc", ownerIds: [P2.memberId], x: 24, y: 8, actor: { inline: actor({ senses: "darkvision 30 ft" }) } }),
  };
  s.holders = { s1: { sceneId: "s1", rev: 0, entries: [P1, P2].map((v) => ({ memberId: v.memberId, on: true })) } };
  return s;
}

type Viewing = { conn: Connection; view: ProjectedState; inbox: ServerMessage[] };

function open(state: RoomState, who: typeof DM): Viewing {
  const inbox: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "FANOUT01", memberId: who.memberId, role: who.role }, "203.0.113.4");
  conn.sceneId = "s1";
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, view: snapshot.message.state as ProjectedState, inbox };
}

describe("the fan-out on a per-player scene", () => {
  test("each player's events give their own sight, never another holder's", () => {
    clearVisionCache();
    let state = twoRooms();
    const viewers = [open(state, DM), open(state, P1), open(state, P2)];
    const sightOf = (v: ProjectedState) => Object.keys(v.sight ?? {}).sort();
    assert.notDeepEqual(sightOf(projectState(state, P1, { sceneId: "s1" })), sightOf(projectState(state, P2, { sceneId: "s1" })), "the two holders see apart");
    let seq = 10;
    for (const [i, x] of [5, 6, 2, 9].entries()) {
      const before = state;
      // Each player's own character walks in turn in the dark, so both players' sight changes.
      const result = applyOp(state, { t: "token.move", tokenId: i % 2 === 0 ? "a" : "b", x: i % 2 === 0 ? x : 16 + x, y: 8 }, DM, env(++seq));
      assert.ok(result.ok);
      state = result.state;
      publishBatch({ seq, before, after: state, touched: result.touched, global: result.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
      for (const v of viewers) {
        for (const msg of v.inbox.splice(0)) if (msg.t === "ev") v.view = applyChanges(v.view, msg.changes as Change[]);
        const fresh = projectState(state, v.conn.viewer, { sceneId: "s1" });
        assert.equal(stableStringify(v.view), stableStringify(fresh), `move ${i}, ${v.conn.memberId}`);
      }
    }
  });
});
