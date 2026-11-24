import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { token } from "#shared/testutil.ts";
import type { ActorDeps } from "./actor.ts";
import { mapStepOps, memoryGrowth } from "./remember.ts";
import { ScopeClient, StoredRoomDb, storedActor } from "./undoScopeTesting.ts";

/**
 * A walk on the players' scene that needs the sight its batch leaves runs
 * the batch's explore and map steps in place and is handled in the same
 * pass (RoomActor #stepInPlace): it closes no batch, keeps its place among
 * the ops, and takes its number from when it came.
 */

const T0 = Date.parse("2026-11-10T20:00:00.000Z");
type Ev = Extract<ServerMessage, { t: "ev" }>;

async function walkRoom(t: TestContext, options: ActorDeps["options"] = {}, setup: { room?: (state: RoomState) => void; capsPending?: boolean } = {}) {
  const room = twins({ cover: "auto", explore: true }).door;
  // A creature only the DM sees, in the room the party stands in.
  room.tokens.m = token("m", { kind: "monster", name: "Lurker", visibility: "dm", x: 3, y: 8 });
  setup.room?.(room);
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(room, { capsPending: setup.capsPending ?? false });
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
    // The clock passes the walk's tick before the batch's timer fires.
    clock.now = Math.max(clock.now, Math.ceil((arrived + 1) / 20) * 20);
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

describe("which walks run the steps, and when they are put back", () => {
  /**
   * The DM's chat and DM-only move at T0 + 5, then `walk` at T0 + 15, each
   * map step's touched keys recorded. `mid` is how many steps the walk ran
   * in place, and `calls` holds those and the close's.
   */
  async function walked(t: TestContext, walk: { by: "p1" | "dm"; op: unknown }, opts: { room?: (state: RoomState) => void; capsPending?: boolean; options?: ActorDeps["options"]; mapStep?: (input: Parameters<typeof mapStepOps>[0], call: number) => void; around?: (walking: boolean) => void } = {}) {
    const calls: string[][] = [];
    const recording: typeof mapStepOps = (input) => {
      calls.push([...input.touched]);
      opts.mapStep?.(input, calls.length);
      return mapStepOps(input);
    };
    const r = await walkRoom(t, { mapStep: recording, ...opts.options }, opts);
    calls.length = 0;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const rows = r.db.rows.length;
    moveTo(t, r.clock, T0 + 5);
    send(r.dm, { t: "log.chat", text: "a DM line" });
    send(r.dm, { t: "token.move", tokenId: "m", x: 4, y: 8 });
    await flush();
    moveTo(t, r.clock, T0 + 15);
    calls.length = 0;
    const client = walk.by === "p1" ? r.p1 : r.dm;
    opts.around?.(true);
    const n = send(client, walk.op);
    await flush();
    opts.around?.(false);
    const mid = calls.length;
    moveTo(t, r.clock, T0 + 20);
    await flush();
    const answer = client.sent.find((m): m is Ev => m.t === "ev" && Boolean(m.acks?.includes(n) || m.rejects?.some((x) => x.n === n)));
    return { r, calls, mid, rows, taken: answer?.acks?.includes(n) === true, answer };
  }

  test("a DM-only creature carrying a rider players see runs the steps as it walks", async (t) => {
    const w = await walked(
      t,
      { by: "dm", op: { t: "token.move", tokenId: "m", x: 5, y: 8 } },
      {
        room: (state) => {
          state.tokens.m = { ...state.tokens.m!, size: "large" };
          state.tokens.r = token("r", { kind: "monster", name: "Rider", x: 3, y: 8, attached: { to: "m", kind: "ride" } });
        },
      },
    );
    assert.ok(w.taken);
    assert.equal(w.r.h.actor.committed.state.tokens.r?.attached?.to, "m", "the rider rode along");
    assert.equal(w.mid, 1, "the walk ran the steps in place");
  });

  test("a DM-only creature walking alone runs no steps", async (t) => {
    const w = await walked(t, { by: "dm", op: { t: "token.move", tokenId: "m", x: 5, y: 8 } });
    assert.ok(w.taken);
    assert.equal(w.mid, 0);
  });

  test("a walk out and back to its start runs the steps, and puts them back as it changes nothing shared", async (t) => {
    const w = await walked(t, { by: "p1", op: { t: "token.move", tokenId: "a", x: 4, y: 4, route: [[5, 4, 0, 0], [4, 4, 0, 0]] } });
    assert.ok(w.taken);
    assert.equal(w.mid, 1, "the steps ran in place");
    // Put back, the close's steps run over the whole batch again, the DM's move included.
    assert.ok(w.calls[1]?.includes("token:m"), JSON.stringify(w.calls));
  });

  test("a refused walk puts its steps back", async (t) => {
    const w = await walked(t, { by: "p1", op: { t: "token.move", tokenId: "b", x: 6, y: 6 } });
    assert.equal(w.taken, false);
    assert.equal(w.answer?.rejects?.[0]?.code, "forbidden");
    assert.equal(w.mid, 1);
    assert.ok(w.calls[1]?.includes("token:m"), JSON.stringify(w.calls));
    assert.deepEqual(types(w.r.db, w.rows), ["log.chat", "token.move:m"], "no step row of its own");
  });

  test("a walk that throws after its steps puts them back", async (t) => {
    let armed = false;
    const growth: typeof memoryGrowth = (...args) => {
      if (armed) {
        armed = false;
        throw new Error("scripted estimate fault");
      }
      return memoryGrowth(...args);
    };
    // The DM's walk of a creature players see: the memory estimate after its steps throws.
    const w = await walked(t, { by: "dm", op: { t: "token.move", tokenId: "a", x: 5, y: 4 } }, { options: { memoryGrowth: growth }, around: (walking) => void (armed = walking) });
    assert.equal(w.taken, false, "refused by its fault");
    assert.equal(w.mid, 1);
    assert.ok(w.calls[1]?.includes("token:m"), JSON.stringify(w.calls));
  });

  test("a walk's steps that measured every layer and were put back leave the close to measure every layer again", async (t) => {
    // The batch's other map steps throw, so the measure stays owed until the close.
    let walking = false;
    const everyLayer: boolean[] = [];
    const w = await walked(
      t,
      { by: "p1", op: { t: "token.move", tokenId: "a", x: 4, y: 4, route: [[5, 4, 0, 0], [4, 4, 0, 0]] } },
      {
        capsPending: true,
        around: (now) => void (walking = now),
        mapStep: (input) => {
          everyLayer.push(input.everyLayer === true);
          if (!walking) throw new Error("scripted map step fault");
        },
      },
    );
    assert.equal(w.mid, 1);
    assert.deepEqual(everyLayer.slice(-2), [true, true], "the steps in place, then the close, each measure every layer");
  });

  test("a room that owes its memory measure still owes it when a walk's steps measured and were put back", async (t) => {
    // Only the map step in place measures every layer. Every other throws, so nothing the room commits measured them.
    let walking = false;
    const w = await walked(
      t,
      { by: "p1", op: { t: "token.move", tokenId: "a", x: 4, y: 4, route: [[5, 4, 0, 0], [4, 4, 0, 0]] } },
      {
        capsPending: true,
        around: (now) => void (walking = now),
        mapStep: () => {
          if (!walking) throw new Error("scripted map step fault");
        },
      },
    );
    assert.equal(w.mid, 1);
    // The real clearTimeout, so the stop clears the snapshot timer the room placed before the timers were mocked.
    t.mock.timers.reset();
    await w.r.h.actor.shutdown({ code: 1012, snapshot: true });
    assert.equal(w.r.db.snapshot.capsPending, true);
  });
});
