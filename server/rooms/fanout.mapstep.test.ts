import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, paint } from "#shared/discoveryTestutil.ts";
import type { EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { withCellVision } from "#shared/perPlayerTestutil.ts";
import { applyChanges, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, env, member, P1, P2, token } from "#shared/testutil.ts";
import { Connection, type ClientKey } from "./connection.ts";
import { exploreOp } from "./explore.ts";
import { buildSnapshot, publishBatch } from "./fanout.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { mapStepOps } from "./remember.ts";

/**
 * Players' maps through the fan-out (docs/design-v1-map-discovery.md 5.6):
 * chunks go by fog class, each sight holder alone and every other player
 * with the displays, so a holder's memory reaches no one else, memory itself
 * reaches no one, and each socket's events applied to its snapshot give its
 * fresh projection, batch by batch with the explore and the map step as the
 * actor runs them. Sight is perPlayerTestutil.ts's stub, whole cells 3 out.
 */

const SERVER: Viewer = { memberId: "server", role: "dm" };
const P3: Viewer = { memberId: "p3", role: "player" };

type Viewing = { conn: Connection; view: ProjectedState; inbox: ServerMessage[] };

function open(state: RoomState, who: Viewer, clientId: string): Viewing {
  const inbox: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}`, roomId: "FANOUT01", memberId: who.memberId, role: who.role }, "203.0.113.4");
  conn.sceneId = "s1";
  conn.clientId = clientId;
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, view: snapshot.message.state as ProjectedState, inbox };
}

/** A walled room on each side of x = 16, Ayla (p1's) in the west one and Bree (p2's) in the east, p3 owning nothing. */
function twoRooms(perPlayer: boolean): RoomState {
  const state = fogRoom({ vision: true, perPlayer, bounds: { w: 32, h: 16 }, scene: { autoWalls: "off" } });
  state.members.p3 = member("p3");
  paint(state, { x: 0, y: 0, w: 32, h: 16 });
  for (let y = 0; y < 16; y++) edge(state, `16,${y},w`, { kind: "wall" });
  state.tokens.ayla = token("ayla", { kind: "pc", ownerIds: ["p1"], x: 8, y: 8 });
  state.tokens.bree = token("bree", { kind: "pc", ownerIds: ["p2"], x: 24, y: 8 });
  if (perPlayer) state.holders = { s1: { sceneId: "s1", rev: 0, entries: [P1, P2].map((v) => ({ memberId: v.memberId, on: true })) } };
  return { ...state, memory: {}, memoryBy: {}, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memoryShared: {} };
}

/** One batch as the actor runs it, published to every viewer: the ops, the explore, the map step. */
function batch(state: RoomState, seq: number, ops: readonly (Op | { op: Op; by: Viewer })[], viewers: readonly Viewing[], blocked?: Map<ClientKey, number[]>): RoomState {
  const before = state;
  let s = state;
  const touched: EntityKey[] = [];
  let global = false;
  let n = seq * 10;
  const run = (op: Op, by: Viewer) => {
    const r = applyOp(s, op, by, env(n++));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    touched.push(...r.touched);
    if (r.global) global = true;
    s = r.state;
  };
  for (const o of ops) "op" in o ? run(o.op, o.by) : run(o, DM);
  const explore = exploreOp(s);
  if (explore) run(explore, SERVER);
  for (const op of mapStepOps({ before, after: s, touched, cap: () => MEMORY_CAP })) run(op, SERVER);
  publishBatch({ seq, before, after: s, touched, global, acks: new Map(), rejects: new Map(), restored: new Map(), ...(blocked ? { blocked } : {}) }, viewers.map((v) => v.conn), (key) => viewers.find((v) => v.conn.key === key)?.conn);
  return s;
}

const MEMORY_KEYS = /^(memory|memoryBy|playedScenes|memoryShared)\b/;

/** What a viewer's projection shows at a cell, live or remembered. */
function cellIn(view: ProjectedState, x: number, y: number): unknown {
  const chunk = Object.values(view.buildChunks ?? {}).find((c) => c.sceneId === "s1" && c.cx === Math.floor(x / 16) && c.cy === Math.floor(y / 16));
  return chunk?.cells?.[`${x},${y}`];
}

describe("players' maps by fog class through the fan-out (5.6)", () => {
  for (const perPlayer of [false, true]) {
    test(`${perPlayer ? "per player" : "whole party"}: each socket's events give its fresh projection, memory reaches no one, and an edit out of sight shows to no player`, () => {
      withCellVision(() => {
        let state = twoRooms(perPlayer);
        const viewers = [open(state, DM, "c-dm"), open(state, P1, "c-p1"), open(state, P2, "c-p2"), open(state, P3, "c-p3")];
        // Every change each viewer got before Ayla comes back.
        const frames = new Map<string, Change[]>(viewers.map((v) => [v.conn.memberId, []]));
        const steps: (readonly Op[])[] = [
          // Ayla walks east in her room and back, so the room's east part is explored and then out of her sight.
          [{ t: "token.move", tokenId: "ayla", x: 13, y: 8 }],
          [{ t: "token.move", tokenId: "ayla", x: 4, y: 8 }],
          // The DM changes it out of sight: wood, a wall and a door.
          [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["13,8", "14,8"] }],
          [{ t: "build.edge", sceneId: "s1", edges: [{ key: "13,8,n", feature: { kind: "wall" } }] }],
          // Bree walks in her room, and the DM paints where she looks.
          [{ t: "token.move", tokenId: "bree", x: 20, y: 8 }],
          [{ t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["21,8"] }],
          // Ayla comes back and sees the change.
          [{ t: "token.move", tokenId: "ayla", x: 12, y: 8 }],
        ];
        for (const [i, ops] of steps.entries()) {
          state = batch(state, i + 1, ops, viewers);
          for (const v of viewers) {
            for (const msg of v.inbox.splice(0)) {
              if (msg.t !== "ev") continue;
              if (i < steps.length - 1) frames.get(v.conn.memberId)!.push(...(msg.changes as Change[]));
              v.view = applyChanges(v.view, msg.changes as Change[]);
            }
            const fresh = projectState(state, v.conn.viewer, { sceneId: "s1" });
            assert.equal(stableStringify(v.view), stableStringify(fresh), `step ${i}, ${v.conn.memberId}`);
            assert.ok(!Object.keys(v.view).some((k) => MEMORY_KEYS.test(k) && (v.view as Record<string, unknown>)[k] !== undefined && Object.keys((v.view as Record<string, object>)[k] ?? {}).length > 0), `no memory in ${v.conn.memberId}'s copy`);
          }
          if (i === 3) {
            const [, p1] = viewers;
            assert.equal(cellIn(p1!.view, 13, 8), "stone", "Ayla's player remembers the stone");
            assert.equal(cellIn(viewers[0]!.view, 13, 8), "wood", "the DM sees the build");
          }
        }
        for (const [who, changes] of frames) {
          assert.ok(!changes.some((c) => MEMORY_KEYS.test(c.key)), `no memory key reaches ${who}`);
          if (who === "dm1") continue;
          const shown = JSON.stringify(changes);
          assert.ok(!shown.includes('"13,8":"wood"') && !shown.includes('"13,8,n"'), `no frame of ${who}'s holds the change out of sight`);
        }
        assert.equal(cellIn(viewers[1]!.view, 13, 8), "wood", "once Ayla sees it again the build replaces memory");
        // The east room is Bree's own ground on a per-player scene: Ayla's player never held it, nor p3's.
        if (perPlayer) {
          assert.equal(cellIn(viewers[1]!.view, 21, 8), undefined);
          assert.equal(cellIn(viewers[3]!.view, 13, 8), undefined, "a player without a holder's sight gets none of their memory");
        }
      });
    });
  }

  test("`blocked` reaches only the client whose walk it was", () => {
    withCellVision(() => {
      const state = twoRooms(true);
      const viewers = [open(state, DM, "c-dm"), open(state, P1, "c-p1"), open(state, P2, "c-p2")];
      batch(state, 1, [{ op: { t: "token.move", tokenId: "ayla", x: 9, y: 8 }, by: P1 }], viewers, new Map([[viewers[1]!.conn.key!, [7]]]));
      const blocked = viewers.map((v) => v.inbox.filter((m) => m.t === "ev").map((m) => (m as { blocked?: number[] }).blocked ?? null));
      assert.deepEqual(blocked, [[null], [[7]], [null]]);
    });
  });
});
