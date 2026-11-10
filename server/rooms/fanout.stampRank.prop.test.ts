import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { lift, remember } from "#shared/discoveryTestutil.ts";
import { keys, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Stamp, Viewer } from "#shared/model.ts";
import { applyChanges, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { holds } from "#shared/propertyTestutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, P2, env, room, scene } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot, publishBatch, stampRanksOf, type CommittedBatch } from "./fanout.ts";

/**
 * Over random batches of stamps placed, reordered, hidden and removed, fog
 * revealed and hidden, memory remembering and forgetting stamps, and a
 * second socket of one member opening and closing, every player socket's
 * copy, built from its snapshot and every event since, equals a fresh
 * snapshot for it after every batch: each stamp at its rank, the ranks of
 * each scene 0 to n - 1 with no two alike, and the socket's table holding
 * the same ranks.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];

type Socket = { conn: Connection; view: ProjectedState; inbox: ServerMessage[] };

let opened = 0;

function open(state: RoomState, who: Viewer): Socket {
  const inbox: ServerMessage[] = [];
  const raw = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(raw as never, { sessionId: `s-${who.memberId}-${++opened}`, roomId: "STAMPPRP", memberId: who.memberId, role: who.role }, "203.0.113.6");
  conn.sceneId = "s1";
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, view: snapshot.message.state as ProjectedState, inbox };
}

const cell = fc.integer({ min: 0, max: 19 });
const stampArb = fc.record({ id: fc.constantFrom(...IDS), z: fc.integer({ min: -3, max: 12 }), x: cell, y: cell, shown: fc.boolean(), scene: fc.constantFrom("s1", "s1", "s2") });
type Drawn = { id: string; z: number; x: number; y: number; shown: boolean; scene: string };

type Event =
  | { kind: "put"; stamp: Drawn }
  | { kind: "remove"; id: string }
  | { kind: "fog"; mode: "reveal" | "hide"; x: number; y: number; w: number; h: number }
  | { kind: "remember"; id: string; stamp: Drawn | null }
  | { kind: "socket" };

const events: fc.Arbitrary<Event> = fc.oneof(
  { weight: 5, arbitrary: stampArb.map((stamp): Event => ({ kind: "put", stamp })) },
  { weight: 2, arbitrary: fc.constantFrom(...IDS).map((id): Event => ({ kind: "remove", id })) },
  { weight: 3, arbitrary: fc.record({ mode: fc.constantFrom("reveal" as const, "hide" as const), x: cell, y: cell, w: fc.integer({ min: 1, max: 12 }), h: fc.integer({ min: 1, max: 12 }) }).map((f): Event => ({ kind: "fog", ...f })) },
  { weight: 2, arbitrary: fc.record({ id: fc.constantFrom(...IDS), stamp: fc.option(stampArb, { nil: null }) }).map((r): Event => ({ kind: "remember", id: r.id, stamp: r.stamp && { ...r.stamp, id: r.id, scene: "s1" } })) },
  { weight: 1, arbitrary: fc.constant<Event>({ kind: "socket" }) },
);

function stored(d: Drawn): Stamp {
  return { id: d.id, rev: 0, sceneId: d.scene, art: { key: "chest" }, x: d.x + 0.5, y: d.y + 0.5, w: 1, h: 1, rotation: 0, z: d.z, visibility: d.shown ? "all" : "dm" };
}

/** Scene s1 has fog and vision on, the party's explored layer over its top half, and so remembers. Scene s2 is plain. */
function start(): RoomState {
  const state = room({ scenes: { s1: scene("s1", { fogEnabled: true, bounds: { w: 20, h: 20 }, vision: { on: true, light: "bright" } }), s2: scene("s2", { order: 1, bounds: { w: 20, h: 20 } }) } });
  lift(state, "party", { x: 0, y: 0, w: 20, h: 10 });
  lift(state, "dm", { x: 0, y: 0, w: 6, h: 6 });
  return state;
}

let seq = 10;

/** The event as a batch, or null when the room refuses it or it is a socket's. */
function batchOf(state: RoomState, e: Event): CommittedBatch | null {
  const plain = (after: RoomState, touched: EntityKey[], global = false): CommittedBatch => ({ pub: ++seq, before: state, after, touched, global, acks: new Map(), rejects: new Map(), restored: new Map() });
  if (e.kind === "socket") return null;
  if (e.kind === "remember") {
    const after = { ...state };
    remember(after, null, 0, 0, { stamps: { [e.id]: e.stamp && stored(e.stamp) } });
    return plain(after, [keys.memory("s1", 0, 0)]);
  }
  let op: Op;
  if (e.kind === "put") {
    const { rev: _rev, sceneId, ...input } = stored(e.stamp);
    op = { t: "build.stamps", sceneId, put: [input] };
  } else if (e.kind === "remove") {
    const sceneId = state.stamps[e.id]?.sceneId;
    if (!sceneId) return null;
    op = { t: "build.stamps", sceneId, remove: [e.id] };
  } else op = { t: "fog.live", sceneId: "s1", ops: [{ id: `f${seq}`, mode: e.mode, shape: { kind: "rect", x: e.x, y: e.y, w: e.w, h: e.h } }] };
  const r = applyOp(state, op, DM, env(++seq));
  return r.ok ? plain(r.state, r.touched, r.global) : null;
}

function check(state: RoomState, s: Socket, where: string): void {
  const fresh = projectState(state, s.conn.viewer, { sceneId: "s1" });
  if (stableStringify(s.view) !== stableStringify(fresh)) assert.deepEqual(JSON.parse(JSON.stringify(s.view.stamps)), JSON.parse(JSON.stringify(fresh.stamps)), `${where}: ${s.conn.memberId}'s copy`);
  const byScene = new Map<string, number[]>();
  for (const st of Object.values(s.view.stamps)) byScene.set(st.sceneId, [...(byScene.get(st.sceneId) ?? []), st.z]);
  for (const [sceneId, ranks] of byScene) assert.deepEqual(ranks.sort((a, b) => a - b), ranks.map((_, i) => i), `${where}: ${s.conn.memberId}'s ranks on ${sceneId}`);
  const table = Object.fromEntries([...(stampRanksOf(s.conn) ?? [])].sort());
  assert.deepEqual(table, Object.fromEntries(Object.values(s.view.stamps).map((st) => [st.id, st.z]).sort()), `${where}: ${s.conn.memberId}'s table`);
}

describe("each player socket's stamp ranks over random batches", () => {
  test("equal a fresh snapshot's after every batch", () => {
    let batches = 0;
    let entered = 0;
    holds(
      fc.property(fc.array(events, { minLength: 5, maxLength: 40 }), (drawn) => {
        let state = start();
        const sockets = [open(state, P1), open(state, P2), open(state, DISPLAY), open(state, DM)];
        let second: Socket | null = null;
        for (const [i, e] of drawn.entries()) {
          if (e.kind === "socket") {
            if (second) {
              second.conn.close(1000);
              second = null;
            } else second = open(state, P1);
            continue;
          }
          const batch = batchOf(state, e);
          if (!batch) continue;
          const live = second ? [...sockets, second] : sockets;
          publishBatch(batch, live.map((s) => s.conn), () => undefined);
          state = batch.after;
          batches++;
          for (const s of live) {
            const changes = s.inbox.splice(0).flatMap((msg) => (msg.t === "ev" ? (msg.changes as Change[]) : []));
            entered += changes.filter((c) => c.key.startsWith("stamp:") && "value" in c).length;
            s.view = applyChanges(s.view, changes);
            if (s.conn.role !== "dm") check(state, s, `event ${i} (${e.kind})`);
          }
        }
      }),
      150,
    );
    assert.ok(batches > 1000, `only ${batches} batches`);
    assert.ok(entered > 1000, `only ${entered} stamps sent`);
  });
});
