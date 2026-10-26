import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EdgeFeature, RoomState } from "#shared/model.ts";
import { applyChanges, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { DM, P1, P2, actor, env, member, room, scene, token } from "#shared/testutil.ts";
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

  /*
   * A walled room with a dead-end alcove in its north wall (review
   * PV2-ISO-2). Both characters start on one cell in the room, which sees
   * the whole room and the whole alcove. The second steps into the alcove,
   * from where it sees less, all of it ground the first still sees: the
   * union, the DM's sight, does not change, and only that holder's does. A
   * fan-out that diffed only the union would leave their view stale.
   */
  test("a holder's sight that changes while the union does not still reaches that holder, and a player who owns nothing sees nothing", () => {
    clearVisionCache();
    const P3 = { memberId: "p3", role: "player" as const };
    let state = room();
    state.members.p3 = member("p3");
    state.scenes = { s1: scene("s1", { bounds: { w: 16, h: 16 }, vision: { on: true, light: "bright", perPlayer: true }, autoWalls: "off" }) };
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 2; x < 12; x++) {
      if (x !== 7) edges[`${x},2,n`] = { kind: "wall" };
      edges[`${x},12,n`] = { kind: "wall" };
    }
    for (let y = 2; y < 12; y++) {
      edges[`2,${y},w`] = { kind: "wall" };
      edges[`12,${y},w`] = { kind: "wall" };
    }
    for (let y = 0; y < 2; y++) {
      edges[`7,${y},w`] = { kind: "wall" };
      edges[`8,${y},w`] = { kind: "wall" };
    }
    edges["7,0,n"] = { kind: "wall" };
    state.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges } };
    state.tokens = {
      a: token("a", { kind: "pc", ownerIds: [P1.memberId], x: 7, y: 7, actor: { inline: actor() } }),
      b: token("b", { kind: "pc", ownerIds: [P2.memberId], x: 7, y: 7, actor: { inline: actor() } }),
    };
    state.holders = { s1: { sceneId: "s1", rev: 0, entries: [P1, P2].map((v) => ({ memberId: v.memberId, on: true })) } };
    const viewers = [open(state, DM), open(state, P1), open(state, P2), open(state, P3)];
    const tiles = (s: RoomState, who: string | null) => stableStringify([...(who === "union" ? visionRules.partySight(s, "s1") : visionRules.holderSight(s, "s1", who)).tiles]);
    let seq = 20;
    for (const [i, y] of [4, 1, 0, 7].entries()) {
      const before = state;
      const result = applyOp(state, { t: "token.move", tokenId: "b", x: 7, y }, DM, env(++seq));
      assert.ok(result.ok);
      state = result.state;
      assert.equal(tiles(state, "union"), tiles(before, "union"), `move ${i}: the union stays as it was`);
      if (i === 2) assert.notEqual(tiles(state, P2.memberId), tiles(state, P1.memberId), "in the alcove the second holder sees less");
      publishBatch({ seq, before, after: state, touched: result.touched, global: result.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
      for (const v of viewers) {
        for (const msg of v.inbox.splice(0)) if (msg.t === "ev") v.view = applyChanges(v.view, msg.changes as Change[]);
        const fresh = projectState(state, v.conn.viewer, { sceneId: "s1" });
        assert.equal(stableStringify(v.view), stableStringify(fresh), `move ${i}, ${v.conn.memberId}`);
      }
      assert.deepEqual(Object.keys(viewers[3]!.view.sight ?? {}), [], "the player who owns nothing has no sight of their own");
    }
  });
});
