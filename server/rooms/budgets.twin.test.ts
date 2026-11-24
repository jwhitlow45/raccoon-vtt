import assert from "node:assert/strict";
import { after, before, describe, mock, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { RoomActor } from "./actor.ts";
import { SnapshotBudget, type SnapshotBudgetLimits } from "./budgets.ts";
import { CLOSE, Connection } from "./connection.ts";
import type { RoomGateway } from "./gateway.ts";
import { scopeFixture, StoredRoomDb, until } from "./undoScopeTesting.ts";

/*
 * Two rooms on one server share its snapshot budget (budgets.ts
 * SnapshotBudget), and one session on one address asks both for snapshots
 * at the edge of that budget. The twins differ only in how long each
 * room's commits take: in A the DM's work in room X is held at its commit
 * while room Y's lands at once, and in B the other way round. Every frame
 * that answers one of the session's requests, a `wait` with its value or
 * a `snapshot`, comes to each socket in the same order with the same
 * values in both, and so does the abuse rule's close. The clock is a hand-moved one the rooms and the budget
 * share, and the timers are mocked ones moved with it.
 */

/** A multiple of every window below. */
const T0 = Date.parse("2026-11-10T20:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SESSION = "0199f0a0-0000-7000-8000-00000000b001";
const ADDRESS = "203.0.113.20";

// The drain's turns read the loop's clock (actor.ts DRAIN_TURN_MS), which stands still here, so a fixed flush is enough.
before(() => mock.method(performance, "now", () => 0));
after(() => mock.restoreAll());

type Twin = "A" | "B";
type Device = { conn: Connection; sent: ServerMessage[] };

/** Holds every commit that starts while it is shut, until it opens. */
class Gate {
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
    if (this.#shut) await this.#shut.promise;
  }
}

type Room = { actor: RoomActor; gate: Gate; reads: Gate; player: string; dm: Device; n: number };

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

function socketOn(room: Room | { actor: RoomActor }, grant: { sessionId: string; memberId: string; role: "dm" | "player"; previewOf?: string }, ip: string, now: () => number): Device {
  const sent: ServerMessage[] = [];
  // The room learns of a close it made as the server's socket closes, after it (ws.ts).
  const close = () => void Promise.resolve().then(() => room.actor.detach(conn));
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close, terminate: close };
  const conn = new Connection(socket as never, { ...grant, roomId: "BUDGETS" }, ip, { now });
  room.actor.attach(conn);
  return { conn, sent };
}

class World {
  readonly clock = { now: T0 };
  readonly now = () => this.clock.now;
  readonly budget: SnapshotBudget;
  x!: Room;
  y!: Room;
  /** The session's sockets, by label, in the order they were opened. */
  readonly devices = new Map<string, Device>();
  readonly #t: TestContext;
  /** The mocked timers' own time, which runs behind the clock after `hand` until the next `to`. */
  #timers = T0;

  constructor(t: TestContext, limits: Partial<SnapshotBudgetLimits>) {
    this.#t = t;
    this.budget = new SnapshotBudget(limits, this.now);
  }

  /** Both rooms, each with its DM's socket open, while the clock stands at T0 and the timers are real. */
  async load(): Promise<void> {
    this.x = await this.#room("ROOMX");
    this.y = await this.#room("ROOMY");
    this.#t.mock.timers.enable({ apis: ["setTimeout"] });
  }

  async #room(roomId: string): Promise<Room> {
    const f = scopeFixture();
    const db = new StoredRoomDb(f.state);
    // A client's watermark read waits while `reads` is shut, as one does behind other rooms' work on the shared pool.
    const reads = new Gate();
    const stored = db.pool();
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("from client_watermarks where")) await reads.pass();
        return stored.query(sql, params);
      },
      connect: () => stored.connect(),
    } as unknown as typeof stored;
    const actor = await RoomActor.load({
      pool,
      info: { roomId, pinned: false, createdIp: null, readOnly: false },
      log: quiet,
      budget: this.budget,
      gateway: {} as RoomGateway,
      options: { batchMs: 20, retryBaseMs: 5, retryMaxMs: 20, snapshotEveryMs: Number.POSITIVE_INFINITY, grantRecheckMs: 3_600_000, now: this.now, numberClock: null, standingClock: true },
    });
    assert.ok(actor);
    const gate = new Gate();
    db.beforeCommit = () => gate.pass();
    this.#t.after(() => {
      this.#t.mock.timers.reset();
      gate.open();
      reads.open();
      db.beforeCommit = undefined;
      return actor.shutdown({ code: 1012, snapshot: false });
    });
    const dm = socketOn({ actor }, { sessionId: uuidv7(), memberId: f.dm.id, role: "dm" }, "203.0.113.30", this.now);
    await actor.hello(dm.conn, { clientId: uuidv7(), resumeFrom: 1 });
    await until(() => (dm.sent.some((m) => m.t === "snapshot") ? true : undefined), `${roomId}: the DM's snapshot`);
    return { actor, gate, reads, player: f.player.id, dm, n: 0 };
  }

  /**
   * Moves the clock and the timers together to `at` ms past T0, `step` ms at
   * a time, letting the rooms work first and at each, so a hello sent before
   * it arrives with the clock where it was sent. Timers a `hand` move left
   * behind fire first, all at once, with the clock where it stands.
   */
  async to(at: number, step = 20): Promise<void> {
    await flush();
    if (this.#timers < this.clock.now) {
      this.#t.mock.timers.tick(this.clock.now - this.#timers);
      this.#timers = this.clock.now;
      await flush();
    }
    while (this.clock.now < T0 + at) {
      const next = Math.min(T0 + at, this.clock.now + step);
      this.clock.now = next;
      this.#t.mock.timers.tick(next - this.#timers);
      this.#timers = next;
      await flush();
    }
  }

  /** Moves the clock alone to `at` ms past T0, as a loop busy elsewhere does: timers due meanwhile fire late, at the next `to`. */
  async hand(at: number): Promise<void> {
    await flush();
    this.clock.now = T0 + at;
  }

  /** The DM's work in `room` from now on waits at its commit, from a chat whose commit is held, until `release`. */
  async hold(room: Room): Promise<void> {
    room.gate.shut();
    void room.actor.op(room.dm.conn, ++room.n, { t: "log.chat", text: "held" });
    await flush();
  }

  /** The room's queue from now on waits behind a deletion step, which holds until `release`. */
  async holdQueue(room: Room): Promise<void> {
    room.gate.shut();
    void room.actor.deletionStep(async () => {
      await room.gate.pass();
      return { deleted: [], result: null };
    });
    await flush();
  }

  /** The room's client watermark reads from now on wait until `releaseReads` or `release`. */
  holdReads(room: Room): void {
    room.reads.shut();
  }

  releaseReads(room: Room): void {
    room.reads.open();
  }

  release(room: Room): void {
    room.gate.open();
    room.reads.open();
  }

  /** A new socket of the session's in `room`, with its hello sent now. */
  hello(room: Room, label: string, session = SESSION, ip = ADDRESS): void {
    const device = socketOn(room, { sessionId: session, memberId: room.player, role: "player" }, ip, this.now);
    if (session === SESSION) this.devices.set(label, device);
    void room.actor.hello(device.conn, { clientId: uuidv7(), resumeFrom: 1 });
  }

  /** The session's snapshots spent at these times past T0, in some room before the script, at 1 KiB each. */
  spent(times: readonly number[]): void {
    const keys = this.budget.keys(SESSION, ADDRESS, false);
    for (const at of times) this.budget.record(keys, 1_024, T0 + at);
  }

  /** What answered each of the session's requests, by socket: each `wait` with its value, each `snapshot`, and a close. */
  answers(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [label, device] of this.devices) {
      out[label] = device.sent.flatMap((m) => (m.t === "wait" ? [`wait ${m.ms}`] : m.t === "snapshot" ? ["snapshot"] : []));
      if (device.conn.closed) out[label].push(`closed ${device.conn.closedWith}`);
    }
    return out;
  }
}

/**
 * Runs `script` in a world of each twin in turn, `held` the room whose work
 * waits, X in A and Y in B, and returns each twin's answers. The abuse
 * rule's window is an hour unless `limits` says otherwise, so the
 * session's requests over budget a minute apart never close its sockets.
 */
async function twins(t: TestContext, script: (w: World, held: Room) => Promise<void>, limits: Partial<SnapshotBudgetLimits> = { abuseMs: 3_600_000 }): Promise<Record<Twin, Record<string, string[]>>> {
  const out = {} as Record<Twin, Record<string, string[]>>;
  for (const twin of ["A", "B"] as const) {
    const w = new World(t, limits);
    await w.load();
    await script(w, twin === "A" ? w.x : w.y);
    out[twin] = w.answers();
    t.mock.timers.reset();
  }
  return out;
}

describe("a session at the edge of the snapshot budget in two rooms", () => {
  test("one hello in each room, 10 ms apart, while one room's commit is held: the same answers whichever room it is", async (t) => {
    const out = await twins(t, async (w, held) => {
      await w.to(100_900, 1_000);
      // Nineteen of the session's twenty: the next request fits, and the one after it waits.
      w.spent(Array.from({ length: 19 }, (_, i) => 100_000 + 50 * i));
      await w.to(101_000);
      await w.hold(held);
      await w.to(101_005, 1);
      w.hello(w.x, "x1");
      await w.to(101_015, 1);
      w.hello(w.y, "y1");
      await w.to(101_500);
      w.release(held);
      await w.to(102_000);
      // Across the oldest spend's end at 160,000 ms, one room's commit held again: a hello in X 5 ms before it, and one
      // in Y 5 ms after it.
      await w.to(159_980, 1_000);
      await w.hold(held);
      await w.to(159_995, 1);
      w.hello(w.x, "x2");
      await w.to(160_005, 1);
      w.hello(w.y, "y2");
      await w.to(160_600, 5);
      w.release(held);
      await w.to(161_000);
    });
    assert.deepEqual(out.A.x1, ["snapshot"], "the first request fits");
    assert.deepEqual([out.A.y1?.[0], out.A.y1?.length, out.A.y1?.at(-1)], ["wait 58985", 31, "snapshot"], "the next waits for the oldest spend's end");
    // Y1's request comes due at 160,000 ms and takes the place the oldest spend left. X2's, due then too, waits for the
    // next spend's end at 160,050 ms and takes it, and Y2's, due then too, waits for the one after.
    assert.deepEqual(out.A.x2, ["wait 5", "wait 50", "snapshot"]);
    assert.deepEqual(out.A.y2, ["wait 45", "wait 50", "snapshot"]);
    assert.deepEqual(out.A, out.B);
  });

  test("a commit held longer than the budget's window, past another session's spend that drops the old ones: the same answers whichever room it is", async (t) => {
    const out = await twins(t, async (w, held) => {
      await w.to(100_950, 1_000);
      // All twenty of the session's: any request in the next minute waits.
      w.spent(Array.from({ length: 20 }, (_, i) => 100_000 + 50 * i));
      await w.to(149_980, 1_000);
      await w.hold(held);
      await w.to(150_000, 1);
      w.hello(w.x, "x");
      await w.to(150_010, 1);
      w.hello(w.y, "y");
      await w.to(160_100, 10);
      // Another session's snapshot, the first spend in over a minute, has the budget drop every spend two windows old.
      await w.to(221_000, 1_000);
      w.hello(w.x, "other", "0199f0a0-0000-7000-8000-00000000b002", "203.0.113.21");
      await w.to(221_100, 10);
      await w.to(225_000, 1_000);
      w.release(held);
      await w.to(226_000);
      assert.equal(w.budget.delay(w.budget.keys(SESSION, ADDRESS, false), T0 + 150_000), 0, "the session's spends from 100,000 ms are gone");
    });
    assert.deepEqual(out.A.x, ["wait 10000", "wait 8000", "wait 6000", "wait 4000", "wait 2000", "snapshot"]);
    // Its delay ends with X's at 160,000 ms, whose request then takes the place the oldest spend left.
    assert.deepEqual(out.A.y, ["wait 9990", "wait 7990", "wait 5990", "wait 3990", "wait 1990", "wait 50", "snapshot"]);
    assert.deepEqual(out.A, out.B);
  });

  test("two fresh hellos over budget 30 s apart, one room's queue held across both: the abuse rule closes the same sockets whichever room it is", async (t) => {
    const out = await twins(
      t,
      async (w, held) => {
        await w.to(100_950, 1_000);
        w.spent(Array.from({ length: 20 }, (_, i) => 100_000 + 50 * i));
        await w.to(100_990);
        await w.holdQueue(held);
        await w.to(101_000, 1);
        w.hello(w.x, "x");
        await w.to(131_000, 1_000);
        w.hello(w.y, "y");
        await w.to(131_500);
        w.release(held);
        await w.to(160_100, 100);
      },
      { abuseMs: 30_000 },
    );
    assert.deepEqual([out.A.x?.[0], out.A.x?.at(-1)], ["wait 59000", "snapshot"], "the first starts the session's time over budget");
    assert.deepEqual(out.A.y, ["closed 4008"], "the second, 30 s on, closes the session's sockets in its room");
    assert.deepEqual(out.A, out.B);
  });

  test("a delayed request whose timer fires late, after the session spent in Y and X took a later command: the same answers whichever room's queue is held", async (t) => {
    const out = await twins(
      t,
      async (w, held) => {
        // One spend a window: the session's at T0 holds X's hello at 500 ms until 1,010 ms.
        w.spent([0]);
        await w.to(490);
        await w.holdQueue(held);
        await w.to(500, 1);
        w.hello(w.x, "x");
        await w.to(1_000);
        // The loop is busy past X's due time: Y's hello comes at 1,030 ms, and the DM in X sends a chat at 1,035 ms, before
        // the budget's timer fires.
        await w.hand(1_030);
        w.hello(w.y, "y");
        await w.hand(1_035);
        void w.x.actor.op(w.x.dm.conn, ++w.x.n, { t: "log.chat", text: "later" });
        await w.to(1_100);
        w.release(held);
        await w.to(1_500);
      },
      { sessionCount: 1, windowMs: 1_010, abuseMs: 3_600_000 },
    );
    assert.deepEqual(out.A, { x: ["wait 510", "snapshot"], y: ["wait 990"] }, "X's request takes the place at its due time, before Y's hello is read");
    assert.deepEqual(out.A, out.B);
  });

  test("a hello past the abuse rule closes the session's sockets in its room as it arrives, never one that came after it: the same whichever room's queue is held", async (t) => {
    const out = await twins(
      t,
      async (w, held) => {
        // A socket of the session's in X that fits, before the session's other rooms spend the rest of its budget.
        await w.to(99_000, 1_000);
        w.hello(w.x, "x0");
        await w.to(100_950, 1_000);
        w.spent(Array.from({ length: 20 }, (_, i) => 100_000 + 50 * i));
        await w.to(100_990);
        await w.holdQueue(held);
        // Over budget at 101 s in Y, which starts the session's time over budget, and again 30 s on in X.
        await w.to(101_000, 1);
        w.hello(w.y, "y");
        await w.to(131_000, 1_000);
        w.hello(w.x, "x1");
        // Once the budget has room again, another socket of the session's in X.
        await w.to(161_000, 1_000);
        w.hello(w.x, "x2");
        await w.to(162_000);
        w.release(held);
        await w.to(163_000);
      },
      {},
    );
    assert.deepEqual([out.A.x0, out.A.x1, out.A.x2], [["snapshot", "closed 4008"], ["closed 4008"], ["snapshot"]]);
    assert.deepEqual(out.A, out.B);
  });

  test("a hello's place in the budget is read as it arrives, however long its watermark read waits: the same whichever room's reads are held", async (t) => {
    const out = await twins(
      t,
      async (w, held) => {
        w.spent([0]);
        await w.to(1_000, 1_000);
        await w.holdQueue(held);
        w.holdReads(held);
        // A page of the session's in X 100 ms before the session's place comes free, and one in Y after then.
        await w.to(9_900, 1_000);
        w.hello(w.x, "x");
        await w.to(10_200);
        w.hello(w.y, "y");
        // The reads land while the queue is still held, so each hello joins it behind the request it answers.
        await w.to(10_500);
        w.releaseReads(held);
        await w.to(10_600);
        w.release(held);
        await w.to(21_000, 1_000);
      },
      { sessionCount: 1, windowMs: 10_000 },
    );
    assert.deepEqual([out.A.x, out.A.y], [["wait 100", "snapshot"], ["wait 9800", "wait 7800", "wait 5800", "wait 3800", "wait 1800", "snapshot"]]);
    assert.deepEqual(out.A, out.B);
  });

  test("requests of sockets a room closed count against the session's bound on requests waiting at once: the same whichever room's queue is held", async (t) => {
    const out = await twins(
      t,
      async (w, held) => {
        w.spent([0]);
        // Two previews of X's player, the session's, wait for the session's place until 10 s, which is the session's bound.
        await w.to(1_000, 1_000);
        const previews = Array.from({ length: 2 }, () => socketOn(w.x, { sessionId: SESSION, memberId: w.x.dm.conn.memberId, role: "dm", previewOf: w.x.player }, ADDRESS, w.now));
        for (const preview of previews) void w.x.actor.hello(preview.conn, { clientId: uuidv7(), resumeFrom: 1 });
        await w.to(1_020);
        await w.holdQueue(held);
        // X's player leaves the roster, which closes both previews as X publishes it: at once when X's queue is free,
        // after their requests come due when X's queue is held.
        void w.x.actor.sys({ t: "sys.memberRemove", memberId: w.x.player });
        // A page of the session's in Y while both requests still count, and another once one of them was answered.
        await w.to(5_000, 1_000);
        assert.deepEqual(previews.map((p) => p.conn.closed), [held === w.y, held === w.y]);
        w.hello(w.y, "y1");
        await w.to(10_500, 500);
        w.hello(w.y, "y2");
        await w.to(12_000);
        w.release(held);
        await w.to(31_000, 1_000);
      },
      { sessionCount: 1, windowMs: 10_000, sessionWaiting: 2 },
    );
    assert.deepEqual([out.A.y1, out.A.y2?.at(-1)], [["closed 4008"], "snapshot"]);
    assert.deepEqual(out.A, out.B);
  });

  test("a delayed request of a room that unloads still comes due: the same whether the room unloads before its due time or after", async (t) => {
    const out = await twins(
      t,
      async (w, held) => {
        w.spent([0]);
        // A page of the session's in X waits for the session's place until 10 s. X unloads at 3 s in A and at 12 s in B,
        // with no queue held in either.
        await w.to(1_000, 1_000);
        const page = socketOn(w.x, { sessionId: SESSION, memberId: w.x.player, role: "player" }, ADDRESS, w.now);
        void w.x.actor.hello(page.conn, { clientId: uuidv7(), resumeFrom: 1 });
        const unloadAt = held === w.x ? 3_000 : 12_000;
        await w.to(unloadAt, 500);
        await w.x.actor.shutdown({ code: CLOSE.evicted, snapshot: false });
        // A page of the session's in Y after the request's due time.
        await w.to(12_500, 500);
        w.hello(w.y, "y");
        await w.to(23_000, 1_000);
      },
      { sessionCount: 1, windowMs: 10_000 },
    );
    assert.deepEqual(out.A.y, ["wait 7500", "wait 5500", "wait 3500", "wait 1500", "snapshot"], "the page's request took the place at 10 s");
    assert.deepEqual(out.A, out.B);
  });

  test("a delayed request of a socket the room closes comes due as it would have: the same whichever room's queue is held", async (t) => {
    const out = await twins(
      t,
      async (w, held) => {
        w.spent([0]);
        // The session's preview of X's player, a DM's, waits for the session's place until 10 s.
        await w.to(1_000, 1_000);
        const preview = socketOn(w.x, { sessionId: SESSION, memberId: w.x.dm.conn.memberId, role: "dm", previewOf: w.x.player }, ADDRESS, w.now);
        void w.x.actor.hello(preview.conn, { clientId: uuidv7(), resumeFrom: 1 });
        await w.to(1_020);
        await w.holdQueue(held);
        // X's player leaves the roster, which closes the preview as X publishes it: at once when X's queue is free, after
        // its request comes due when X's queue is held.
        void w.x.actor.sys({ t: "sys.memberRemove", memberId: w.x.player });
        await w.to(9_000, 1_000);
        assert.equal(preview.conn.closed, held === w.y);
        // A request of the session's in Y after then.
        await w.to(10_500);
        w.hello(w.y, "y");
        await w.to(12_000);
        w.release(held);
        await w.to(21_000, 1_000);
      },
      { sessionCount: 1, windowMs: 10_000 },
    );
    assert.deepEqual(out.A.y, ["wait 9500", "wait 7500", "wait 5500", "wait 3500", "wait 1500", "snapshot"]);
    assert.deepEqual(out.A, out.B);
  });
});
