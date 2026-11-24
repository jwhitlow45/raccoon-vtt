import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { token } from "#shared/testutil.ts";
import type { HistoryMessage } from "#shared/undoContract.ts";
import { MAX_PENDING_BATCHES, RoomActor, type ActorDeps, type RoomView } from "./actor.ts";
import { SnapshotBudget } from "./budgets.ts";
import { Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { mapStepOps } from "./remember.ts";
import { ScopeClient, scopeFixture, StoredRoomDb, storedActor, until } from "./undoScopeTesting.ts";

/**
 * Commits run one at a time in tick order while the queue builds the next
 * batches on the state the last one closed with (RoomActor #pending). Each
 * test holds commits with the stored room's `beforeCommit`, on a hand
 * clock that the batch timers follow (mocked), and says when the clock
 * reads what.
 */

/** A multiple of every batch window below. */
const T0 = Date.parse("2026-11-10T20:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

type Wire = ServerMessage | HistoryMessage;
type Ev = Extract<ServerMessage, { t: "ev" }>;

/** Holds every commit that starts while it is shut, until it opens. A commit let go takes a few turns of the loop to land. */
class Gate {
  started = 0;
  #shut: { promise: Promise<void>; open: () => void } | null = null;

  shut(): void {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    this.#shut = { promise, open };
  }

  open(): void {
    this.#shut?.open();
    this.#shut = null;
  }

  async pass(): Promise<void> {
    this.started++;
    const shut = this.#shut;
    if (shut) await shut.promise;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }
}

async function gridRoom(t: TestContext, options: ActorDeps["options"] = {}) {
  const f = scopeFixture();
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = new StoredRoomDb(f.state);
  const actor = await RoomActor.load({
    pool: db.pool(),
    info: { roomId: "UNDOSCOPE", pinned: false, createdIp: null, readOnly: false },
    log: quiet,
    budget: new SnapshotBudget({}, now),
    gateway: {} as RoomGateway,
    options: { batchMs: 20, retryBaseMs: 5, retryMaxMs: 20, snapshotIdleMs: 60_000, grantRecheckMs: 60_000, now, numberClock: null, ...options },
  });
  assert.ok(actor);
  const gate = new Gate();
  t.after(() => {
    // The real clearTimeout, so the shutdown clears any timer a real commit placed.
    t.mock.timers.reset();
    gate.open();
    db.beforeCommit = undefined;
    return actor.shutdown({ code: 1012, snapshot: false });
  });
  // Opened while the clock stands and the timer is real: each hello's batch closes a window on.
  const dm = await ScopeClient.open(actor, f.dm, "dm", now);
  const p1 = await ScopeClient.open(actor, f.player, "player", now);
  db.beforeCommit = () => gate.pass();
  return { f, clock, db, actor, dm, p1, now, gate };
}

/** Lets the queue, the stored room's commits and the fan-out run, with the batch timer mocked. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Moves the hand clock to `at` and the mocked timers by as much. */
function moveTo(t: TestContext, clock: { now: number }, at: number): void {
  const by = at - clock.now;
  assert.ok(by >= 0);
  clock.now = at;
  t.mock.timers.tick(by);
}

function chat(client: ScopeClient, text: string): number {
  const n = ++client.n;
  void client.actor.op(client.conn, n, { t: "log.chat", text });
  return n;
}

function evs(sent: readonly Wire[], from = 0): Ev[] {
  return sent.slice(from).filter((m): m is Ev => m.t === "ev");
}

const texts = (state: RoomState) => state.log.map((line) => line.text);
const storedTexts = (db: StoredRoomDb) => db.rows.map((row) => (row.op as { text?: string }).text).filter((text) => text !== undefined);

/** A deletion step that records what it was handed and deletes nothing. */
function recorder() {
  const runs: Array<{ state: RoomState; seq: number }> = [];
  return {
    runs,
    run: async (state: RoomState, seq: number) => {
      runs.push({ state, seq });
      return { deleted: [] as string[], result: runs.length };
    },
  };
}

describe("the queue goes on while commits are held", () => {
  test("each tick's commands are handled at once while earlier batches wait for their commits", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.gate.shut();
    const T = T0 + 1_000;
    r.clock.now = T + 5;
    chat(r.p1, "first");
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    assert.equal(r.gate.started, 1, "the first batch's commit started and is held");
    r.clock.now = T + 25;
    chat(r.p1, "second");
    await flush();
    assert.equal(r.actor.queueLength, 0, "the second tick's chat was handled while the first commit is held");
    moveTo(t, r.clock, T + 40);
    await flush();
    assert.equal(r.gate.started, 1, "the second batch waits for the first commit");
    r.gate.open();
    await flush();
    assert.equal(r.gate.started, 2);
    const frames = evs(r.p1.sent).slice(-2);
    assert.deepEqual(frames.map((m) => [m.seq, m.acks]), [[T + 20, [r.p1.n - 1]], [T + 40, [r.p1.n]]], "published in tick order, one frame a tick");
  });

  test(`with ${MAX_PENDING_BATCHES} batches waiting, the queue holds, and the next tick's batch takes only its own tick's commands once it resumes`, async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.gate.shut();
    const T = T0 + 1_000;
    // One chat a tick, its batch closed by the timer at the tick, one batch after another left waiting.
    for (let k = 0; k < MAX_PENDING_BATCHES; k++) {
      r.clock.now = T + 20 * k + 5;
      chat(k % 2 === 0 ? r.p1 : r.dm, `tick ${k}`);
      await flush();
      assert.equal(r.actor.queueLength, 0, `the chat of tick ${k} was handled with ${k} batches waiting`);
      moveTo(t, r.clock, T + 20 * (k + 1));
      await flush();
    }
    assert.equal(r.gate.started, 1, "one commit at a time");
    const next = T + 20 * MAX_PENDING_BATCHES;
    r.clock.now = next + 5;
    const a = chat(r.p1, "next a");
    r.clock.now = next + 10;
    const b = chat(r.p1, "next b");
    r.clock.now = next + 25;
    const c = chat(r.p1, "after");
    await flush();
    assert.equal(r.actor.queueLength, 3, "the queue holds while the batches wait");
    const from = r.p1.sent.length;
    r.gate.open();
    // Each of the 25 commits takes a few turns of the loop to land.
    for (let i = 0; i < 10; i++) await flush();
    moveTo(t, r.clock, next + 40);
    await flush();
    assert.equal(r.actor.queueLength, 0);
    const frames = evs(r.p1.sent, from).filter((m) => m.acks?.some((n) => [a, b, c].includes(n)));
    assert.deepEqual(frames.map((m) => [m.seq, m.acks]), [[next + 20, [a, b]], [next + 40, [c]]], "each batch holds its own tick's chats");
    const numbers = Object.fromEntries(r.actor.committed.state.log.filter((line) => (line.text ?? "").startsWith("next") || line.text === "after").map((line) => [line.text, Number(line.id.split(":")[0])]));
    assert.deepEqual(numbers, { "next a": next + 5, "next b": next + 10, after: next + 25 }, "each numbered by when it came");
  });

  test("a resent op of a batch whose commit is held is answered again at the next batch's publish", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.gate.shut();
    const T = T0 + 1_000;
    const from = r.p1.sent.length;
    r.clock.now = T + 5;
    const n = chat(r.p1, "once");
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    // The device sends it again in the next tick, as after a lost frame.
    r.clock.now = T + 22;
    void r.actor.op(r.p1.conn, n, { t: "log.chat", text: "once" });
    await flush();
    r.gate.open();
    await flush();
    moveTo(t, r.clock, T + 40);
    await flush();
    const sent = r.p1.sent.slice(from).filter((m) => m.t === "ev" || m.t === "history");
    assert.deepEqual(
      sent.map((m) => [m.t, m.seq, m.t === "ev" ? m.acks : undefined]),
      [
        ["ev", T + 20, [n]],
        ["history", T + 20, undefined],
        ["ev", T + 40, [n]],
        ["history", T + 40, undefined],
      ],
    );
    assert.deepEqual(storedTexts(r.db).filter((text) => text === "once"), ["once"], "stored once");
  });

  test("a reader at a later tick waits for the batch being committed and answers with it, and one at an earlier tick answers at once with the view before it", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.gate.shut();
    const T = T0 + 1_000;
    const before = r.actor.committed;
    r.clock.now = T + 5;
    chat(r.p1, "in the batch");
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    let later: RoomView | null = null;
    void r.actor.asOf(T + 25).then((view) => (later = view));
    const earlier = await r.actor.asOf(T + 15);
    assert.equal(earlier.seq, before.seq, "the view before the batch");
    assert.ok(!texts(earlier.state).includes("in the batch"));
    await flush();
    assert.equal(later, null, "the later reader waits while the batch commits");
    r.gate.open();
    await flush();
    const view = later as RoomView | null;
    assert.ok(view, "answered once the batch published");
    assert.equal(view.tick, T + 20);
    assert.ok(texts(view.state).includes("in the batch"));
    assert.equal(view.seq, r.actor.committed.seq);
    // A reader that arrived before the batch still gets the view before it, though the room has committed it.
    r.clock.now = T + 30;
    const again = await r.actor.asOf(T + 15);
    assert.equal(again.seq, before.seq);
    assert.ok(!texts(again.state).includes("in the batch"));
    assert.ok(texts(r.actor.committed.state).includes("in the batch"));
  });

  test("a walk handled while an earlier batch commits runs the steps of its own batch first", async (t) => {
    const room = twins({ cover: "auto", explore: true }).door;
    // A creature only the DM sees, in the room the party stands in.
    room.tokens.m = token("m", { kind: "monster", name: "Lurker", visibility: "dm", x: 3, y: 8 });
    const clock = { now: T0 };
    const now = () => clock.now;
    let steps = 0;
    const counted: typeof mapStepOps = (input) => {
      steps++;
      return mapStepOps(input);
    };
    const db = new StoredRoomDb(room);
    t.after(() => t.mock.timers.reset());
    const h = await storedActor(t, db, { batchMs: 20, now, numberClock: null, mapStep: counted });
    const dm = await ScopeClient.open(h.actor, room.members.dm1!, "dm", now);
    const p1 = await ScopeClient.open(h.actor, room.members.p1!, "player", now);
    await dm.apply({ t: "log.chat", text: "ready" });
    const gate = new Gate();
    db.beforeCommit = () => gate.pass();
    t.after(() => gate.open());
    t.mock.timers.enable({ apis: ["setTimeout"] });
    gate.shut();
    const T = T0 + 1_000;
    clock.now = T + 5;
    chat(dm, "held");
    await flush();
    moveTo(t, clock, T + 20);
    await flush();
    assert.equal(gate.started, 1, "the first batch's commit is held");
    moveTo(t, clock, T + 25);
    void dm.actor.op(dm.conn, ++dm.n, { t: "token.move", tokenId: "m", x: 4, y: 8 });
    await flush();
    const before = steps;
    moveTo(t, clock, T + 30);
    const walk = ++p1.n;
    void p1.actor.op(p1.conn, walk, { t: "token.move", tokenId: "a", x: 5, y: 4 });
    await flush();
    assert.ok(steps > before, "the steps ran in place as the walk was handled");
    gate.open();
    await flush();
    moveTo(t, clock, T + 40);
    await flush();
    const answer = evs(p1.sent).find((m) => m.acks?.includes(walk) || m.rejects?.some((x) => x.n === walk));
    assert.deepEqual([answer?.seq, answer?.acks], [T + 40, [walk]]);
  });
});

describe("a shutdown while commits are held", () => {
  test("waits for every batch, the open one closed first, and stores them all", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.gate.shut();
    const T = T0 + 1_000;
    r.clock.now = T + 5;
    chat(r.p1, "first");
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    r.clock.now = T + 25;
    chat(r.p1, "second");
    await flush();
    const down = r.actor.shutdown({ code: 1012, snapshot: false });
    r.gate.open();
    await down;
    assert.deepEqual(storedTexts(r.db).slice(-2), ["first", "second"], "both stored before the shutdown ends");
    assert.equal(r.gate.started, 2);
  });

  test("a commit that fails gives up with every batch after it, the open one too, and their ops are taken again after a reload", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stored = r.db.rows.length;
    r.db.beforeCommit = async () => {
      throw new Error("scripted commit failure");
    };
    const T = T0 + 1_000;
    const from = r.p1.sent.length;
    r.clock.now = T + 5;
    const a = chat(r.p1, "a");
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    r.clock.now = T + 25;
    chat(r.p1, "b");
    await flush();
    moveTo(t, r.clock, T + 40);
    await flush();
    r.clock.now = T + 45;
    const c = chat(r.p1, "c");
    await flush();
    assert.equal(r.actor.retrying, true);
    const down = r.actor.shutdown({ code: 1012, snapshot: false });
    // The retry's backoff ends, and the attempt after it fails with the room closed.
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(25);
      await flush();
    }
    await down;
    assert.equal(r.db.rows.length, stored, "nothing of the three batches stored");
    assert.deepEqual(evs(r.p1.sent, from).filter((m) => m.acks?.length), [], "no op answered");
    assert.ok(!texts(r.actor.committed.state).includes("a"));
    assert.equal(r.p1.conn.closedWith, 1012);
    // The device comes back to the reloaded room and sends its three ops again: each is taken.
    t.mock.timers.reset();
    r.db.beforeCommit = undefined;
    const h = await storedActor(t, r.db, { batchMs: 1 }, quiet);
    const sent: Wire[] = [];
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as Wire), close() {}, terminate() {} };
    const conn = new Connection(socket as never, { sessionId: r.p1.conn.sessionId, roomId: "UNDOSCOPE", memberId: r.f.player.id, role: "player" }, "203.0.113.9");
    h.actor.attach(conn);
    await h.actor.hello(conn, { clientId: r.p1.clientId, resumeFrom: a });
    const snapshot = await until(() => sent.find((m): m is Extract<ServerMessage, { t: "snapshot" }> => m.t === "snapshot"), "the reloaded room's snapshot");
    assert.equal(snapshot.watermark, a - 1, "the room holds none of the three");
    for (const [n, text] of [[a, "a"], [a + 1, "b"], [c, "c"]] as const) void h.actor.op(conn, n, { t: "log.chat", text });
    await until(() => (sent.some((m) => m.t === "ev" && m.acks?.includes(c)) ? true : undefined), "the resent ops answered");
    assert.deepEqual(texts(h.actor.committed.state).slice(-3), ["a", "b", "c"]);
  });
});

describe("a deletion step behind batches that are committing", () => {
  test("waits for every batch before it to land, though none is open", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.gate.shut();
    const T = T0 + 1_000;
    r.clock.now = T + 5;
    chat(r.p1, "first");
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    r.clock.now = T + 25;
    chat(r.p1, "second");
    await flush();
    moveTo(t, r.clock, T + 40);
    await flush();
    r.clock.now = T + 45;
    const step = recorder();
    const ran = r.actor.deletionStep(step.run);
    await flush();
    assert.equal(step.runs.length, 0, "it waits while two batches wait for their commits");
    r.gate.open();
    assert.equal(await ran, 1);
    const [seen] = step.runs;
    assert.ok(seen);
    assert.deepEqual(texts(seen.state).slice(-2), ["first", "second"], "it read the room with both batches");
    assert.equal(seen.seq, r.actor.committed.seq);
  });

  test("with an op every tick, it runs once its own tick's batch lands, before any command of a later tick", async (t) => {
    const r = await gridRoom(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    r.gate.shut();
    const T = T0 + 1_000;
    r.clock.now = T + 3;
    chat(r.p1, "tick 1");
    await flush();
    r.clock.now = T + 5;
    const step = recorder();
    const ran = r.actor.deletionStep(step.run);
    await flush();
    moveTo(t, r.clock, T + 20);
    await flush();
    r.clock.now = T + 25;
    chat(r.p1, "tick 2");
    await flush();
    assert.equal(r.actor.queueLength, 1, "a later tick's command waits behind the step");
    assert.equal(step.runs.length, 0);
    r.gate.open();
    assert.equal(await ran, 1);
    const [seen] = step.runs;
    assert.ok(seen);
    assert.ok(texts(seen.state).includes("tick 1"));
    assert.ok(!texts(seen.state).includes("tick 2"), "nothing of the later tick ran before it");
    await flush();
    moveTo(t, r.clock, T + 40);
    await flush();
    assert.ok(texts(r.actor.committed.state).includes("tick 2"), "the later tick's chat follows it");
  });
});
