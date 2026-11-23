import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { createInitialState } from "#shared/initial.ts";
import { member, rng } from "#shared/testutil.ts";
import { ReceiptLines } from "./logHistory.ts";
import { ScanBusyError, ScanCancelledError } from "./logScanBudget.ts";

const viewer = { memberId: "p1", role: "player" as const };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function rig(live = true) {
  const state = createInitialState({ roomName: "Receipts", dm: member("dm1", "dm") });
  state.members.p1 = member("p1");
  const line = { id: "2:0", at: "", kind: "chat" as const, text: "held" };
  state.log = live ? [{ ...line, id: "1:0" }, line] : [];
  const clients: Client[] = [];
  let active = 0;
  class Client extends EventEmitter {
    releases = 0;
    destroyed = false;
    sql = 0;
    async query(config: { text: string }) {
      assert.equal(this.releases, 0, "no SQL after release");
      this.sql++;
      if (config.text.includes("from roll_receipts")) return { rows: [{ part: 0, state: "committed", seq: "2", code: null, message: null, at: new Date(0) }] };
      return { rows: [{ entry: line }] };
    }
    release(destroy?: boolean) {
      assert.equal(++this.releases, 1, "release once");
      this.destroyed = destroy ?? false;
      active--;
    }
  }
  const lines = new ReceiptLines({ pool: { connect: async () => { const c = new Client(); clients.push(c); active++; return c; } } as never, cancel: async () => undefined });
  return { state, line, lines, clients, active: () => active };
}

for (const live of [true, false]) test(`a lookup reads its rows on one connection, and the archive on a second only for lines the view lacks, live=${live}`, async () => {
  const r = rig(live);
  const found = await r.lines.lookup("ROOM", viewer, "tag", new AbortController().signal, { state: r.state, through: 2 }, 1_000);
  assert.deepEqual(found.rows.map((row) => row.seq), [2]);
  assert.deepEqual(found.lines.get(2), [r.line]);
  assert.equal(r.clients.length, live ? 1 : 2, "all-live lookup needs no second checkout");
  assert.equal(r.active(), 0);
});

test("a committed receipt past the view's through answers busy before any archive read", async () => {
  const r = rig(false);
  await assert.rejects(r.lines.lookup("ROOM", viewer, "tag", new AbortController().signal, { state: r.state, through: 1 }, 1_000), ScanBusyError);
  assert.equal(r.clients.length, 1, "only the rows were read");
  assert.equal(r.active(), 0);
});

test("random abort sequences release once and send no SQL after cancellation", async () => {
  const random = rng(4101);
  const modes = new Set<number>();
  for (let i = 0; i < 120; i++) {
    const r = rig(random() < 0.5);
    const mode = Math.floor(random() * 3);
    modes.add(mode);
    const abort = new AbortController();
    if (mode === 0) abort.abort();
    const pending = r.lines.lookup("ROOM", viewer, "tag", abort.signal, { state: r.state, through: 2 }, 1_000);
    const outcome = pending.then(() => "ok", (e: unknown) => { assert.ok(e instanceof ScanCancelledError); return "cancelled"; });
    if (mode === 1) abort.abort();
    assert.equal(await outcome, mode === 2 ? "ok" : "cancelled", `sequence ${i}`);
    await tick();
    assert.equal(r.active(), 0, `sequence ${i}: no held connection`);
    for (const c of r.clients) assert.equal(c.releases, 1);
  }
  assert.equal(modes.size, 3);
});

/** A connection whose answers a test controls: pending queries fail when it is destroyed, as a real one's do. */
class Fake extends EventEmitter {
  readonly steps: string[] = [];
  hang = false;
  fail = false;
  /** Runs as a statement's answer is handed back, in the same tick. */
  answered: (() => void) | null = null;
  #pending: ((err: Error) => void)[] = [];
  query(config: { text: string }): Promise<{ rows: unknown[] }> {
    this.steps.push(config.text.trim().split(/\s+/).slice(0, 2).join(" "));
    if (this.fail) return Promise.reject(new Error("statement failed"));
    if (this.hang) return new Promise((_resolve, reject) => this.#pending.push(reject));
    this.answered?.();
    return Promise.resolve({ rows: [] });
  }
  release(destroy?: boolean): void {
    this.steps.push(destroy ? "destroy" : "release");
    if (destroy) for (const reject of this.#pending.splice(0)) reject(new Error("Connection terminated"));
  }
}

describe("a receipt lookup's connection, every step bounded and cancellable", () => {
  const viewer = { memberId: "p1", role: "player" as const };

  test("a checkout the pool does not give in time fails busy, and a connection handed over after is destroyed", async () => {
    let hand!: (c: Fake) => void;
    const lines = new ReceiptLines({ pool: { connect: () => new Promise((resolve) => (hand = resolve as never)) } as never, checkoutMs: 50 });
    const started = Date.now();
    await assert.rejects(lines.read("ROOM", [1], viewer, new AbortController().signal), ScanBusyError);
    assert.ok(Date.now() - started < 1_000);
    const late = new Fake();
    hand(late);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(late.steps, ["destroy"], "nothing runs on it");
  });

  test("a cancel during a checkout ends the wait at once", async () => {
    const abort = new AbortController();
    const lines = new ReceiptLines({ pool: { connect: () => new Promise(() => undefined) } as never, checkoutMs: 60_000 });
    const reading = lines.read("ROOM", [1], viewer, abort.signal);
    abort.abort(new Error("client went away"));
    await assert.rejects(reading, ScanCancelledError);
  });

  test("a cancel during a statement sends the backend a cancel request, then destroys the connection, with no more SQL", async () => {
    const conn = new Fake();
    conn.hang = true;
    const order: string[] = [];
    const lines = new ReceiptLines({
      pool: { connect: () => Promise.resolve(conn) } as never,
      cancel: async () => {
        order.push(`cancel after ${conn.steps.join(",")}`);
      },
    });
    const abort = new AbortController();
    const reading = lines.read("ROOM", [1, 2], viewer, abort.signal);
    await new Promise((r) => setImmediate(r));
    abort.abort(new Error("deadline"));
    await assert.rejects(reading, ScanCancelledError);
    assert.deepEqual(order, ["cancel after select entry"], "the cancel request first, before the connection goes");
    assert.deepEqual(conn.steps, ["select entry", "destroy"]);
  });

  test("a cancel that lands as a statement answers sends no more SQL, and fails the lookup even when that was its last", async () => {
    for (const seqs of [[1, 2], [1]]) {
      const conn = new Fake();
      const abort = new AbortController();
      conn.answered = () => abort.abort(new Error("client went away"));
      let cancels = 0;
      const lines = new ReceiptLines({ pool: { connect: () => Promise.resolve(conn) } as never, cancel: async () => void cancels++ });
      await assert.rejects(lines.read("ROOM", seqs, viewer, abort.signal), ScanCancelledError, `seqs ${seqs.join(",")}`);
      assert.deepEqual(conn.steps, ["select entry", "destroy"], `seqs ${seqs.join(",")}: one statement, then the drop`);
      assert.equal(cancels, 1);
    }
  });

  test("a failed statement destroys the connection after a cancel request, and a lookup that ends well returns it", async () => {
    const conn = new Fake();
    conn.fail = true;
    let cancels = 0;
    const lines = new ReceiptLines({ pool: { connect: () => Promise.resolve(conn) } as never, cancel: async () => void cancels++ });
    await assert.rejects(lines.read("ROOM", [1], viewer, new AbortController().signal), /statement failed/);
    assert.deepEqual(conn.steps, ["select entry", "destroy"]);
    assert.equal(cancels, 1);
    const good = new Fake();
    const ok = new ReceiptLines({ pool: { connect: () => Promise.resolve(good) } as never });
    assert.deepEqual([...(await ok.read("ROOM", [1, 1, 2], viewer, new AbortController().signal)).keys()], [1, 2]);
    assert.deepEqual(good.steps, ["select entry", "select entry", "release"]);
  });
});

test("random late archive checkouts are destroyed once without SQL after a cancel", async () => {
  const random = rng(4102);
  for (let i = 0; i < 80; i++) {
    const r = rig(false);
    const hand = deferred<Fake>();
    let checkouts = 0;
    const first = new Fake();
    first.query = async () => ({ rows: [{ part: 0, state: "committed", seq: "2", code: null, message: null, at: new Date(0) }] });
    const lines = new ReceiptLines({ pool: { connect: () => ++checkouts === 1 ? Promise.resolve(first) : hand.promise } as never, cancel: async () => undefined });
    const abort = new AbortController();
    const pending = lines.lookup("ROOM", viewer, "tag", abort.signal, { state: r.state, through: 2 }, 1_000);
    const outcome = pending.then(() => "ok", (e: unknown) => { assert.ok(e instanceof ScanCancelledError); return "cancelled"; });
    await tick();
    assert.equal(checkouts, 2);
    const late = new Fake();
    if (random() < 0.5) {
      abort.abort();
      assert.equal(await outcome, "cancelled");
      hand.resolve(late);
    } else {
      hand.resolve(late);
      abort.abort();
      assert.equal(await outcome, "cancelled");
    }
    await tick();
    assert.deepEqual(first.steps, ["release"], `sequence ${i}: receipt connection released once`);
    assert.deepEqual(late.steps, ["destroy"], `sequence ${i}: late connection destroyed once without SQL`);
  }
});
