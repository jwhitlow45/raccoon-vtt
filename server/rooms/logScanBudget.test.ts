import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rng } from "#shared/testutil.ts";
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

describe("the archive scan budget under random events", () => {
  type Tracked = { scan: Scan; abort: AbortController; state: "idle" | "waiting" | "running" | "closed"; release?: (fail: boolean) => void; settled: Promise<unknown>[] };

  test("turns, leases and waiters stay within their limits, no cancelled scan runs, and everything settles", async () => {
    // Ten rooms, so the server-wide cap on waiting scans is reached, not only the per-room ones.
    const rooms = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const members = ["m0", "m1", "m2", "m3"];
    for (let seed = 1; seed <= 100; seed++) {
      const random = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
      const clock = new FakeClock();
      const budget = new LogScanBudget(clock.options());
      const { turns, leases, maxWaiting, maxWaitingPerRoom, maxBackgroundPerRoom } = budget.options;
      const scans: Tracked[] = [];
      const running = new Set<Tracked>();
      const where = (step: number) => `seed ${seed} step ${step}`;
      const check = (step: number) => {
        for (const pool of ["page", "export"] as const) {
          const mine = [...running].filter((r) => r.scan.pool === pool);
          assert.ok(mine.length <= turns[pool], `${where(step)}: ${pool} turns`);
          assert.ok(budget.detail.leases[pool].length <= leases[pool], `${where(step)}: ${pool} leases`);
          assert.equal(new Set(budget.detail.leases[pool]).size, budget.detail.leases[pool].length, `${where(step)}: one ${pool} lease a room`);
        }
        const roomsRunning = [...running].map((r) => r.scan.roomId);
        assert.equal(new Set(roomsRunning).size, roomsRunning.length, `${where(step)}: one turn a room`);
        const counted = budget.detail.waiting.filter((w) => w.counted);
        assert.ok(counted.length <= maxWaiting, `${where(step)}: waiting`);
        for (const room of rooms) {
          assert.ok(counted.filter((w) => w.roomId === room && !w.background).length <= maxWaitingPerRoom, `${where(step)}: waiting in ${room}`);
          assert.ok(counted.filter((w) => w.roomId === room && w.background).length <= maxBackgroundPerRoom, `${where(step)}: background in ${room}`);
        }
      };
      const request = (t: Tracked) => {
        t.state = "waiting";
        const done = t.scan
          .batch(async () => {
            assert.ok(!t.scan.signal.aborted && t.state !== "closed", `seed ${seed}: a cancelled or closed scan got a turn`);
            t.state = "running";
            running.add(t);
            const fail = await new Promise<boolean>((resolve) => (t.release = resolve));
            running.delete(t);
            if (fail) throw new Error("query failed");
          })
          .then(
            () => undefined,
            (err: unknown) => {
              if (!(err instanceof ScanBusyError || err instanceof ScanCancelledError || (err instanceof Error && err.message === "query failed"))) throw err;
            },
          )
          .finally(() => {
            if (t.state !== "closed") t.state = "idle";
          });
        t.settled.push(done);
      };
      for (let step = 0; step < 200; step++) {
        const r = random();
        const live = scans.filter((s) => s.state !== "closed");
        if (r < 0.3 && live.length < 40) {
          const abort = new AbortController();
          const scan = budget.open({ pool: random() < 0.6 ? "page" : "export", roomId: pick(rooms), memberId: pick(members), background: random() < 0.1, signal: abort.signal });
          const t: Tracked = { scan, abort, state: "idle", settled: [] };
          scans.push(t);
          request(t);
        } else if (r < 0.45) {
          const idle = live.filter((s) => s.state === "idle");
          if (idle.length > 0) request(pick(idle));
        } else if (r < 0.65) {
          const busy = [...running];
          if (busy.length > 0) pick(busy).release?.(random() < 0.1);
        } else if (r < 0.72 && live.length > 0) {
          const t = pick(live);
          if (random() < 0.5) t.abort.abort(new Error("gone"));
          else t.scan.cancel(new Error("deadline"));
        } else if (r < 0.8 && live.length > 0) {
          const t = pick(live.filter((s) => s.state !== "running").concat(live.filter((s) => s.state === "running" && random() < 0.2)));
          if (t) {
            t.state = "closed";
            t.scan.close();
          }
        } else if (r < 0.83) budget.cancelRoom(pick(rooms));
        else clock.advance(Math.floor(random() * 1_500));
        await flush();
        check(step);
      }
      // Wind down: let every running batch finish, cancel and close every scan, and let the timers run out.
      budget.close();
      for (const t of running) t.release?.(false);
      for (const t of scans) {
        t.state = "closed";
        t.scan.close();
      }
      clock.advance(5_000);
      await flush();
      await Promise.all(scans.flatMap((s) => s.settled));
      assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 }, `seed ${seed}: all back`);
    }
  });
});
