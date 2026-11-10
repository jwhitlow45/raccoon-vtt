import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Stamp, Viewer } from "#shared/model.ts";
import { applyChanges, projectState, rankedStamp, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, P1, env, room } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { buildSnapshot, newStampTable, publishBatch, rankStamps, stampRanksOf } from "./fanout.ts";

/**
 * A player's stamps through the server's fan-out: each connection keeps
 * the stamps its copy holds and ranks them itself, so the `z` it holds is
 * always its place among them, as a fresh snapshot would give it.
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

type Socket = { conn: Connection; view: ProjectedState; inbox: ServerMessage[] };

function open(state: RoomState, who: Viewer, n = 0): Socket {
  const inbox: ServerMessage[] = [];
  const raw = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(raw as never, { sessionId: `s-${who.memberId}-${n}`, roomId: "STAMPRNK", memberId: who.memberId, role: who.role }, "203.0.113.5");
  conn.sceneId = "s1";
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, view: snapshot.message.state as ProjectedState, inbox };
}

function stamp(id: string, z: number, more: Partial<Stamp> = {}): Stamp {
  return { id, rev: 0, sceneId: "s1", art: { key: "chest" }, x: 3.5, y: 3.5, w: 1, h: 1, rotation: 0, z, visibility: "all", ...more };
}

function input(st: Stamp): Omit<Stamp, "rev" | "sceneId"> {
  const { rev: _rev, sceneId: _scene, ...rest } = st;
  return rest;
}

let seq = 10;

/** Applies the DM's op and publishes its batch to the sockets, which apply what they are sent. Returns each socket's changes. */
function run(state: RoomState, op: Op, sockets: readonly Socket[]): { state: RoomState; changes: Change[][] } {
  const r = applyOp(state, op, DM, env(++seq));
  assert.ok(r.ok, r.ok ? "" : r.message);
  publishBatch({ pub: seq, before: state, after: r.state, touched: r.touched, global: r.global, acks: new Map(), rejects: new Map(), restored: new Map() }, sockets.map((s) => s.conn), () => undefined);
  const changes = sockets.map((s) => {
    const mine = s.inbox.splice(0).flatMap((msg) => (msg.t === "ev" ? (msg.changes as Change[]) : []));
    if (!s.conn.closed) s.view = applyChanges(s.view, mine);
    return mine;
  });
  return { state: r.state, changes };
}

/** Each stamp's rank in a socket's copy, by id. */
function zs(view: ProjectedState): Record<string, number> {
  return Object.fromEntries(Object.values(view.stamps).map((st) => [st.id, st.z]));
}

function fresh(state: RoomState, s: Socket): void {
  assert.equal(stableStringify(s.view), stableStringify(projectState(state, s.conn.viewer, { sceneId: "s1" })), `${s.conn.memberId}'s copy is a fresh snapshot`);
  const ranks = stampRanksOf(s.conn)!;
  assert.deepEqual(Object.fromEntries([...ranks].sort()), Object.fromEntries(Object.entries(zs(s.view)).sort()), `${s.conn.memberId}'s table holds its copy's ranks`);
}

const stampKeys = (changes: Change[]) => changes.filter((c) => c.key.startsWith("stamp:"));

describe("a player's stamp ranks through the fan-out", () => {
  test("a stamp entering below two a player holds moves their ranks in the same event, in key order", () => {
    let state = room();
    state.stamps = { a: stamp("a", 5), b: stamp("b", 9, { x: 6.5 }) };
    const sockets = [open(state, P1), open(state, DISPLAY), open(state, DM)];
    assert.deepEqual(zs(sockets[0]!.view), { a: 0, b: 1 });
    const out = run(state, { t: "build.stamps", sceneId: "s1", put: [input(stamp("c", 1, { x: 9.5 }))] }, sockets);
    state = out.state;
    for (const [i, s] of sockets.slice(0, 2).entries()) {
      const sent = stampKeys(out.changes[i]!);
      assert.deepEqual(sent.map((c) => [c.key, "value" in c ? (c.value as Stamp).z : null]), [["stamp:a", 1], ["stamp:b", 2], ["stamp:c", 0]], s.conn.memberId);
      fresh(state, s);
    }
    assert.deepEqual(zs(sockets[2]!.view), { a: 5, b: 9, c: 1 }, "the DM's are stored");
  });

  test("a hidden stamp placed below them sends a player nothing, and one shown later takes its place", () => {
    let state = room();
    state.stamps = { a: stamp("a", 5), b: stamp("b", 9, { x: 6.5 }) };
    const p1 = open(state, P1);
    let out = run(state, { t: "build.stamps", sceneId: "s1", put: [input(stamp("h", 1, { visibility: "dm" }))] }, [p1]);
    state = out.state;
    assert.deepEqual(out.changes[0], []);
    out = run(state, { t: "build.stamps", sceneId: "s1", put: [input(stamp("h", 1))] }, [p1]);
    state = out.state;
    assert.deepEqual(zs(p1.view), { a: 1, b: 2, h: 0 });
    fresh(state, p1);
  });

  test("a stamp held at rank 1 of 3, moved, resized and put again unchanged, is sent at rank 1 each time it changes and not at all when it does not", () => {
    let state = room();
    state.stamps = { a: stamp("a", 2), b: stamp("b", 4, { x: 6.5 }), c: stamp("c", 8, { x: 9.5 }) };
    const p1 = open(state, P1);
    const steps: Stamp[] = [stamp("b", 4, { x: 7.5 }), stamp("b", 4, { x: 7.5, w: 2, h: 2 }), stamp("b", 4, { x: 7.5, w: 2, h: 2 })];
    for (const [i, st] of steps.entries()) {
      const out = run(state, { t: "build.stamps", sceneId: "s1", put: [input(st)] }, [p1]);
      assert.ok(out.state.stamps.b!.rev > state.stamps.b!.rev, `step ${i} writes the stamp`);
      state = out.state;
      const sent = stampKeys(out.changes[0]!);
      if (i < 2) assert.deepEqual(sent.map((c) => [c.key, "value" in c ? (c.value as Stamp).z : null]), [["stamp:b", 1]], `step ${i}`);
      else assert.deepEqual(sent, [], "the unchanged put sends nothing");
      fresh(state, p1);
    }
  });

  test("two sockets of one member keep their own tables: a stamp enters, the first socket closes, another enters", () => {
    let state = room();
    state.stamps = { a: stamp("a", 5) };
    const first = open(state, P1, 1);
    const second = open(state, P1, 2);
    state = run(state, { t: "build.stamps", sceneId: "s1", put: [input(stamp("b", 2, { x: 6.5 }))] }, [first, second]).state;
    first.conn.close(1000);
    state = run(state, { t: "build.stamps", sceneId: "s1", put: [input(stamp("c", 3, { x: 9.5 }))] }, [first, second]).state;
    assert.deepEqual(zs(second.view), { b: 0, c: 1, a: 2 });
    assert.deepEqual(Object.values(zs(second.view)).sort(), [0, 1, 2], "no two alike");
    fresh(state, second);
  });

  test("a stamp removed or moved to another scene leaves its ranks to the rest", () => {
    let state = room();
    state.stamps = { a: stamp("a", 1), b: stamp("b", 2, { x: 6.5 }), c: stamp("c", 3, { x: 9.5 }) };
    const p1 = open(state, P1);
    state = run(state, { t: "build.stamps", sceneId: "s1", remove: ["a"] }, [p1]).state;
    assert.deepEqual(zs(p1.view), { b: 0, c: 1 });
    fresh(state, p1);
    // Brought to the front, as the stamp options' Bring to front writes it.
    state = run(state, { t: "build.stamps", sceneId: "s1", put: [input(stamp("b", 4, { x: 6.5 }))] }, [p1]).state;
    assert.deepEqual(zs(p1.view), { c: 0, b: 1 });
    fresh(state, p1);
  });
});

describe("ranking one connection's candidates", () => {
  const source = (id: string, z: number) => rankedStamp(stamp(id, z), 0);

  test("a batch with no stamp among its candidates projects no stamp and hands its projection back as it was", () => {
    const table = newStampTable();
    const next = new Map<EntityKey, unknown>([[keys.log("1:0"), { id: "1:0" }]]);
    let asked = 0;
    const out = rankStamps(table, next, () => {
      asked++;
      return new Map();
    });
    assert.equal(out, next);
    assert.equal(asked, 0);
  });

  test("candidates that leave the table's order as it was project no further stamp", () => {
    const table = newStampTable();
    rankStamps(table, new Map([[keys.stamp("a"), source("a", 1)], [keys.stamp("b"), source("b", 2)], [keys.stamp("c"), source("c", 3)]]), () => new Map());
    let asked = 0;
    const out = rankStamps(table, new Map([[keys.stamp("b"), source("b", 2)]]), () => {
      asked++;
      return new Map();
    });
    assert.equal(asked, 0);
    assert.equal((out.get(keys.stamp("b")) as Stamp).z, 1, "at its rank, never 0");
  });

  test("a stamp entering below the others asks for exactly those whose rank moved", () => {
    const table = newStampTable();
    rankStamps(table, new Map([[keys.stamp("a"), source("a", 1)], [keys.stamp("b"), source("b", 5)], [keys.stamp("c"), source("c", 9)]]), () => new Map());
    const asked: EntityKey[][] = [];
    const out = rankStamps(table, new Map([[keys.stamp("d"), source("d", 3)]]), (more) => {
      asked.push(more);
      return new Map(more.map((key) => [key, source(key.slice(6), { b: 5, c: 9 }[key.slice(6)]!)]));
    });
    assert.deepEqual(asked, [[keys.stamp("b"), keys.stamp("c")]]);
    assert.deepEqual([...out].map(([key, v]) => [key, (v as Stamp).z]), [["stamp:b", 2], ["stamp:c", 3], ["stamp:d", 1]]);
  });
});
