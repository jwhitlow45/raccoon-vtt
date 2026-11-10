import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { ServerMessage } from "#shared/protocol.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { token } from "#shared/testutil.ts";
import type { ActorDeps } from "./actor.ts";
import { mapStepOps } from "./remember.ts";
import { ScopeClient, StoredRoomDb, storedActor } from "./undoScopeTesting.ts";

/**
 * A walk on the players' scene that needs the sight its batch leaves runs
 * the batch's explore and map steps in place and is handled in the same
 * pass (RoomActor #stepInPlace): it closes no batch, keeps its place among
 * the ops, and takes its number from when it came.
 */

const T0 = Date.parse("2026-11-10T20:00:00.000Z");
type Ev = Extract<ServerMessage, { t: "ev" }>;

async function walkRoom(t: TestContext, options: ActorDeps["options"] = {}) {
  const room = twins({ cover: "auto", explore: true }).door;
  // A creature only the DM sees, in the room the party stands in.
  room.tokens.m = token("m", { kind: "monster", name: "Lurker", visibility: "dm", x: 3, y: 8 });
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(room);
  // Ahead of the shutdown storedActor registers, so it clears a real snapshot timer with the real clearTimeout.
  t.after(() => t.mock.timers.reset());
  const h = await storedActor(t, db, { batchMs: 20, now, numberClock: now, ...options });
  const dm = await ScopeClient.open(h.actor, room.members.dm1!, "dm", now);
  const p1 = await ScopeClient.open(h.actor, room.members.p1!, "player", now);
  // The room's first answer explores the sight it loaded with, so the steps below start from explored ground.
  await dm.apply({ t: "log.chat", text: "ready" });
  let commits = 0;
  db.beforeCommit = async () => {
    commits++;
  };
  return { db, h, dm, p1, clock, commits: () => commits };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function moveTo(t: TestContext, clock: { now: number }, at: number): void {
  const by = at - clock.now;
  clock.now = at;
  t.mock.timers.tick(by);
}

function send(client: ScopeClient, op: unknown): number {
  const n = ++client.n;
  void client.actor.op(client.conn, n, op);
  return n;
}

const types = (db: StoredRoomDb, from: number) => db.rows.slice(from).map((row) => (row.op as { t: string; tokenId?: string }).t + ((row.op as { tokenId?: string }).tokenId ? `:${(row.op as { tokenId?: string }).tokenId}` : ""));

describe("a walk that needs its batch's sight", () => {
  test("after a hidden answer in its tick, it is acked at the tick in one frame, with one commit, and numbered by when it came", async (t) => {
    const r = await walkRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const rows = r.db.rows.length;
    const from = r.p1.sent.length;
    moveTo(t, r.clock, T0 + 5);
    send(r.dm, { t: "token.move", tokenId: "m", x: 4, y: 8 });
    await flush();
    moveTo(t, r.clock, T0 + 15);
    const walk = send(r.p1, { t: "token.move", tokenId: "a", x: 5, y: 4 });
    await flush();
    assert.deepEqual(r.p1.sent.slice(from), [], "nothing reaches P1 before the tick");
    assert.equal(r.commits(), 0, "the walk committed nothing");
    moveTo(t, r.clock, T0 + 20);
    await flush();
    const frames = r.p1.sent.slice(from).filter((m): m is Ev => m.t === "ev");
    assert.deepEqual(frames.map((m) => [m.seq, m.acks]), [[T0 + 20, [walk]]]);
    assert.equal(r.commits(), 1);
    const moved = r.db.rows.slice(rows).find((row) => (row.op as { tokenId?: string }).tokenId === "a");
    assert.equal(moved?.pub, T0 + 15, "its number is its arrival's");
    const order = types(r.db, rows);
    assert.ok(order.indexOf("token.move:m") < order.indexOf("token.move:a"), order.join());
  });

  test("takes its number from the clock as it came, not after the steps it ran first", async (t) => {
    // Each map step takes 7 ms of the clock, as a long one would.
    const clock = { now: T0 };
    const slow: typeof mapStepOps = (input) => {
      clock.now += 7;
      return mapStepOps(input);
    };
    const r = await walkRoom(t, { mapStep: slow, now: () => clock.now, numberClock: () => clock.now });
    r.clock.now = clock.now;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const rows = r.db.rows.length;
    clock.now = Math.ceil(clock.now / 20) * 20 + 5;
    send(r.dm, { t: "token.move", tokenId: "m", x: 4, y: 8 });
    await flush();
    clock.now += 5;
    const arrived = clock.now;
    send(r.p1, { t: "token.move", tokenId: "a", x: 5, y: 4 });
    await flush();
    assert.ok(clock.now > arrived, "the steps ran before the walk");
    t.mock.timers.tick(20);
    await flush();
    const moved = r.db.rows.slice(rows).find((row) => (row.op as { tokenId?: string }).tokenId === "a");
    assert.equal(moved?.pub, arrived);
  });

  test("a DM's op after it that deletes the walker applies after it, and the walk is taken", async (t) => {
    const r = await walkRoom(t);
    const rows = r.db.rows.length;
    // One turn of the queue: a hidden answer, P1's walk, the DM's delete of the walker.
    send(r.dm, { t: "token.move", tokenId: "m", x: 4, y: 8 });
    const walk = send(r.p1, { t: "token.move", tokenId: "a", x: 5, y: 4 });
    const removed = await r.dm.send({ t: "token.delete", tokenId: "a" });
    assert.deepEqual(removed.rejects ?? [], []);
    const answer = r.p1.sent.find((m): m is Ev => m.t === "ev" && Boolean(m.acks?.includes(walk) || m.rejects?.some((x) => x.n === walk)));
    assert.deepEqual(answer?.acks, [walk], "the walk was taken");
    const order = types(r.db, rows);
    assert.ok(order.indexOf("token.move:a") < order.indexOf("token.delete:a"), order.join());
    assert.equal(r.h.actor.committed.state.tokens.a, undefined);
  });

  test("a hidden walk after P1's op closes no batch: P1's answer still comes at the tick", async (t) => {
    const r = await walkRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const from = r.p1.sent.length;
    moveTo(t, r.clock, T0 + 3);
    const chat = send(r.p1, { t: "log.chat", text: "hello" });
    await flush();
    moveTo(t, r.clock, T0 + 10);
    send(r.dm, { t: "token.move", tokenId: "m", x: 5, y: 8 });
    await flush();
    moveTo(t, r.clock, T0 + 19);
    await flush();
    assert.deepEqual(r.p1.sent.slice(from), [], "nothing at the hidden walk");
    moveTo(t, r.clock, T0 + 20);
    await flush();
    const frames = r.p1.sent.slice(from).filter((m): m is Ev => m.t === "ev");
    assert.deepEqual(frames.map((m) => [m.seq, m.acks]), [[T0 + 20, [chat]]]);
    assert.equal(r.commits(), 1);
  });
});
