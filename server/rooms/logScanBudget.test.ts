import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LogScanBudget, ScanBusyError, ScanCancelledError, type Scan, type ScanBudgetOptions } from "./logScanBudget.ts";

/** A clock and timers that move only when told. */
class FakeClock {
  now = 0;
  #timers: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;

  options(extra: Partial<ScanBudgetOptions> = {}): Partial<ScanBudgetOptions> {
    return {
      now: () => this.now,
      setTimer: (fn, ms) => {
        const id = ++this.#id;
        this.#timers.push({ at: this.now + ms, fn, id });
        return id;
      },
      clearTimer: (id) => {
        this.#timers = this.#timers.filter((t) => t.id !== id);
      },
      ...extra,
    };
  }

  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      this.#timers = this.#timers.filter((t) => t !== due);
      due.fn();
    }
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A batch that runs until released, so a test can hold a turn. */
function holding(scan: Scan): { admitted: Promise<void>; release: () => void; done: Promise<string> } {
  let admitted!: () => void;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const at = new Promise<void>((r) => (admitted = r));
  const done = scan
    .batch(async () => {
      admitted();
      await gate;
    })
    .then(
      () => "done",
      (err: unknown) => (err instanceof ScanBusyError ? "busy" : err instanceof ScanCancelledError ? "cancelled" : String(err)),
    );
  return { admitted: at, release, done };
}

describe("the archive scan budget", () => {
  test("a page costs one token of a burst of ten, refilled one a second, per room and member", () => {
    const clock = new FakeClock();
    const budget = new LogScanBudget(clock.options());
    for (let i = 0; i < 10; i++) assert.equal(budget.chargePage("A", "m1"), null);
    assert.equal(budget.chargePage("A", "m1"), 1);
    assert.equal(budget.chargePage("A", "m2"), null, "another member has their own");
    assert.equal(budget.chargePage("B", "m1"), null, "and another room");
    clock.advance(1_000);
    assert.equal(budget.chargePage("A", "m1"), null);
    assert.equal(budget.chargePage("A", "m1"), 1);
  });

  test("one page at a time per member", () => {
    const budget = new LogScanBudget(new FakeClock().options());
    const done = budget.beginPage("A", "m1");
    assert.ok(done);
    assert.equal(budget.beginPage("A", "m1"), null);
    assert.ok(budget.beginPage("A", "m2"));
    done();
    done();
    assert.ok(budget.beginPage("A", "m1"));
  });

  test("each pool has two turns, a room one turn across both, and a wait over a second is busy", async () => {
    const clock = new FakeClock();
    const budget = new LogScanBudget(clock.options());
    const a = holding(budget.open({ pool: "page", roomId: "A", memberId: "m1" }));
    const b = holding(budget.open({ pool: "page", roomId: "B", memberId: "m1" }));
    await Promise.all([a.admitted, b.admitted]);
    assert.deepEqual(budget.usage.turns, { page: 2, export: 0 });
    const c = holding(budget.open({ pool: "page", roomId: "C", memberId: "m1" }));
    // Room A's export waits for room A's turn, though the export pool is idle. Room C's export goes ahead.
    const aExport = holding(budget.open({ pool: "export", roomId: "A", memberId: "m2" }));
    const cExport = holding(budget.open({ pool: "export", roomId: "D", memberId: "m2" }));
    await cExport.admitted;
    await flush();
    assert.equal(budget.usage.waiting, 2);
    clock.advance(999);
    a.release();
    await a.done;
    // A's turn went to A's export, which waited longest for that room. C still waits for a page turn.
    await aExport.admitted;
    clock.advance(1);
    assert.equal(await c.done, "busy");
    b.release();
    aExport.release();
    cExport.release();
    assert.deepEqual(await Promise.all([b.done, aExport.done, cExport.done]), ["done", "done", "done"]);
    assert.deepEqual(budget.usage.turns, { page: 0, export: 0 });
  });

  test("a room holds one lease a pool, taken only with a turn: a scan waiting for one holds no turn", async () => {
    const clock = new FakeClock();
    const budget = new LogScanBudget(clock.options());
    const first = budget.open({ pool: "page", roomId: "A", memberId: "m1" });
    await first.batch(async () => undefined);
    assert.deepEqual(budget.usage.leases, { page: 1, export: 0 });
    assert.deepEqual(budget.usage.turns, { page: 0, export: 0 }, "between batches the scan holds its lease, no turn");
    const second = holding(budget.open({ pool: "page", roomId: "A", memberId: "m2" }));
    await flush();
    assert.deepEqual(budget.usage.turns, { page: 0, export: 0 }, "the scan waiting for room A's lease holds no turn");
    // Other rooms take the pool's second lease, and the leaseholder's own batches never wait on a lease.
    const other = budget.open({ pool: "page", roomId: "B", memberId: "m1" });
    await other.batch(async () => undefined);
    await first.batch(async () => undefined);
    const third = holding(budget.open({ pool: "page", roomId: "C", memberId: "m1" }));
    await flush();
    assert.deepEqual(budget.usage.leases, { page: 2, export: 0 });
    // Leases free up as scans close, each to the room waiting on it.
    other.close();
    await third.admitted;
    first.close();
    await second.admitted;
    second.release();
    third.release();
    assert.deepEqual(await Promise.all([second.done, third.done]), ["done", "done"]);
  });

  test("rooms take turns, served longest ago first, and a continuing scan joins the back", async () => {
    const clock = new FakeClock();
    const budget = new LogScanBudget(clock.options({ turns: { page: 1, export: 1 }, leases: { page: 4, export: 4 } }));
    const order: string[] = [];
    const blocker = holding(budget.open({ pool: "page", roomId: "Z", memberId: "z" }));
    await blocker.admitted;
    const run = async (room: string, member: string, name: string, batches: number) => {
      const s = budget.open({ pool: "page", roomId: room, memberId: member });
      try {
        for (let i = 0; i < batches; i++) await s.batch(async () => void order.push(name));
      } finally {
        s.close();
      }
    };
    const all = Promise.all([run("A", "m1", "A1", 2), run("A", "m2", "A2", 2), run("B", "m1", "B1", 2)]);
    await flush();
    blocker.release();
    await all;
    // A2 waits for room A's lease, which A1 holds until it closes. Rooms alternate meanwhile.
    assert.deepEqual(order, ["A1", "B1", "A1", "B1", "A2", "A2"]);
  });

  test("within a room the member served longest ago goes first, whatever order they asked in", async () => {
    const clock = new FakeClock();
    const budget = new LogScanBudget(clock.options());
    const order: string[] = [];
    const once = async (member: string) => {
      const s = budget.open({ pool: "page", roomId: "A", memberId: member });
      try {
        await s.batch(async () => void order.push(member));
      } finally {
        s.close();
      }
    };
    await once("m3");
    const holder = budget.open({ pool: "page", roomId: "A", memberId: "m1" });
    await holder.batch(async () => undefined);
    const waiting = [once("m3"), once("m2")];
    await flush();
    holder.close();
    await Promise.all(waiting);
    assert.deepEqual(order, ["m3", "m2", "m3"]);
  });

  test("a room's own work goes before background work, and waiting is capped", async () => {
    const clock = new FakeClock();
    const budget = new LogScanBudget(clock.options({ turns: { page: 1, export: 1 }, leases: { page: 32, export: 32 } }));
    const blocker = holding(budget.open({ pool: "page", roomId: "Z", memberId: "z" }));
    await blocker.admitted;
    const order: string[] = [];
    const one = async (room: string, member: string, name: string, background = false) => {
      const s = budget.open({ pool: "page", roomId: room, memberId: member, background });
      try {
        await s.batch(async () => void order.push(name));
      } finally {
        s.close();
      }
    };
    const bg = one("A", "worker", "background", true);
    const fg = one("A", "m1", "page");
    // A second background scan for room A, and a third user scan waiting in room A, are busy at once.
    await assert.rejects(one("A", "worker2", "background 2", true), ScanBusyError);
    const fg2 = one("A", "m2", "page 2");
    await assert.rejects(one("A", "m3", "page 3"), ScanBusyError);
    // Sixteen waiting server-wide.
    const waiting: Promise<unknown>[] = [];
    for (let room = 0; waiting.length < 13; room++) waiting.push(one(`R${room}`, "m", `R${room}`));
    assert.equal(budget.usage.waiting, 16);
    await assert.rejects(one("S", "m", "S"), ScanBusyError);
    blocker.release();
    await Promise.all([bg, fg, fg2, ...waiting]);
    assert.deepEqual(
      order.filter((n) => !n.startsWith("R")),
      ["page", "page 2", "background"],
    );
  });

  test("cancelling takes a scan out of the queue at once, a room's deletion cancels its scans, and a failed batch frees its turn", async () => {
    const clock = new FakeClock();
    const budget = new LogScanBudget(clock.options({ turns: { page: 1, export: 1 } }));
    const blocker = holding(budget.open({ pool: "page", roomId: "Z", memberId: "z" }));
    await blocker.admitted;
    const abort = new AbortController();
    const queued = holding(budget.open({ pool: "page", roomId: "A", memberId: "m1", signal: abort.signal }));
    const doomed = holding(budget.open({ pool: "page", roomId: "D", memberId: "m1" }));
    await flush();
    assert.equal(budget.usage.waiting, 2);
    abort.abort();
    assert.equal(await queued.done, "cancelled");
    budget.cancelRoom("D");
    assert.equal(await doomed.done, "cancelled");
    assert.equal(budget.usage.waiting, 0);
    blocker.release();
    await blocker.done;
    const failing = budget.open({ pool: "page", roomId: "A", memberId: "m1" });
    await assert.rejects(
      failing.batch(async () => {
        throw new Error("query failed");
      }),
      /query failed/,
    );
    assert.deepEqual(budget.usage.turns, { page: 0, export: 0 });
    failing.close();
    budget.close();
    await assert.rejects(budget.open({ pool: "page", roomId: "A", memberId: "m1" }).batch(async () => undefined), ScanCancelledError);
    assert.deepEqual(budget.usage.turns, { page: 0, export: 0 });
    assert.equal(budget.usage.waiting, 0);
  });
});
