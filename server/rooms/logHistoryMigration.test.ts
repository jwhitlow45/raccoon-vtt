import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { LogHistoryMigration, type MigrationOptions, type MigrationStep } from "./logHistoryMigration.ts";
import { LogScanBudget } from "./logScanBudget.ts";

/**
 * The metadata worker's lifecycle against a scripted connection (log
 * history, server stage B): every wait it makes stops at its own cancel,
 * a cancelled connection gets a cancel request and is closed with no more
 * SQL on it, and nothing it holds is let go before the connection is. The
 * same on a real database is in logHistoryMigration.itest.ts.
 */

type Answer = { rows: unknown[] } | Error | "hang";

class FakeClient extends EventEmitter {
  readonly steps: string[];
  answer: (text: string) => Answer;
  #pending: ((err: Error) => void)[] = [];

  constructor(steps: string[], answer: (text: string) => Answer) {
    super();
    this.steps = steps;
    this.answer = answer;
  }

  query(config: { text: string }): Promise<{ rows: unknown[] }> {
    const text = config.text.replace(/\s+/g, " ").trim();
    this.steps.push(label(text));
    const a = this.answer(text);
    if (a === "hang") return new Promise((_resolve, reject) => this.#pending.push(reject));
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(a);
  }

  /** What the test notes at the close, such as the leases still held. */
  onEnd: () => string = () => "";

  end(): Promise<void> {
    const note = this.onEnd();
    this.steps.push(note ? `end (${note})` : "end");
    for (const reject of this.#pending.splice(0)) reject(new Error("Connection terminated"));
    this.emit("end");
    return Promise.resolve();
  }
}

function label(text: string): string {
  if (text.includes("indisvalid")) return "valid?";
  if (text.includes("pg_try_advisory_lock")) return "lock";
  if (text.includes("pg_advisory_unlock")) return "unlock";
  if (text.includes("seq is null limit")) return "read";
  if (text.startsWith("with done")) return "complete";
  return text.split(" ").slice(0, 2).join(" ");
}

/** Answers for a database whose index is valid and whose room has `rows` incomplete rows, read in one batch. */
function database(rows: number, over: (text: string) => Answer | undefined = () => undefined): (text: string) => Answer {
  let left = rows;
  return (text) => {
    const o = over(text);
    if (o !== undefined) return o;
    if (text.includes("indisvalid")) return { rows: [{ valid: true }] };
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (text.includes("seq is null limit")) {
      const n = Math.min(left, 500);
      left -= n;
      return { rows: Array.from({ length: n }, (_, i) => ({ id: `${i + 1}:0`, entry: { id: `${i + 1}:0`, at: "2025-01-01T00:00:00.000Z", kind: "chat", text: "x" } })) };
    }
    if (text.startsWith("with done")) return { rows: [{ completed: "1" }] };
    return { rows: [] };
  };
}

function rig(answer: (text: string) => Answer, opts: Partial<MigrationOptions> = {}, connect?: () => Promise<FakeClient>, track = false) {
  const steps: string[] = [];
  const outcomes: MigrationStep[] = [];
  const budget = opts.budget ?? new LogScanBudget();
  const clients: FakeClient[] = [];
  const made = () => {
    const c = new FakeClient(steps, answer);
    if (opts.budget || track) c.onEnd = () => `leases ${budget.usage.leases.page}`;
    return Promise.resolve(c);
  };
  const m = new LogHistoryMigration({
    connect: (connect ?? made) as never,
    budget,
    guard: () => Promise.resolve(true),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    cancel: async () => void steps.push(`cancel (leases ${budget.usage.leases.page})`),
    retryMs: 10,
    pollMs: 5,
    ...opts,
    onStep: async (step, signal) => {
      outcomes.push(step);
      await opts.onStep?.(step, signal);
    },
  });
  return { m, steps, outcomes, budget, clients };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1_000 && !check(); i++) await tick();
  assert.ok(check(), what);
}

describe("the log metadata worker", () => {
  test("a stop while it connects ends the wait at once, and a connection made after is closed with nothing run on it", async () => {
    const steps: string[] = [];
    let hand!: (c: FakeClient) => void;
    const { m } = rig(database(0), {}, () => new Promise((resolve) => (hand = resolve)));
    m.start();
    await tick();
    const stopping = Date.now();
    await m.stop();
    assert.ok(Date.now() - stopping < 500);
    const late = new FakeClient(steps, database(0));
    hand(late);
    await tick();
    assert.deepEqual(steps, ["end"]);
  });

  test("a lock another server holds is polled between waits, and a stop ends the wait without more SQL, cancel first", async () => {
    const { m, steps } = rig(database(0, (text) => (text.includes("pg_try_advisory_lock") ? { rows: [{ locked: false }] } : undefined)));
    m.start();
    await until(() => steps.filter((s) => s === "lock").length >= 3, "polled");
    await m.stop();
    const tail = steps.slice(steps.lastIndexOf("lock") + 1);
    assert.deepEqual(tail, ["cancel (leases 0)", "end"], "no unlock and no SQL after the cancel");
    assert.equal(m.ready, false);
  });

  test("a backfill batch waits behind a room's reader, holds its turn and lease only for the batch, and lets go only once the connection is closed", async () => {
    const budget = new LogScanBudget({ waitMs: 30 });
    const { m, steps, outcomes } = rig(database(700), { budget, batchRows: 500 });
    // A reader of the room holds its turn.
    const reader = budget.open({ pool: "page", roomId: "ROOM", memberId: "pip" });
    let release!: () => void;
    const holding = reader.batch(() => new Promise<void>((r) => (release = r)));
    m.start();
    await until(() => m.ready, "ready");
    m.want("ROOM");
    await until(() => steps.includes("lock"), "the room's lock");
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!steps.includes("read"), "no batch while the reader holds the room's turn, past several busy waits");
    release();
    await holding;
    reader.close();
    await until(() => outcomes.some((o) => o.kind === "room"), "the room done");
    assert.deepEqual(
      outcomes.filter((o) => o.kind !== "index"),
      [
        { kind: "batch", roomId: "ROOM", rows: 500 },
        { kind: "batch", roomId: "ROOM", rows: 200 },
        { kind: "room", roomId: "ROOM", outcome: "complete" },
      ],
    );
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
    await m.stop();
  });

  test("a statement cut by the stop gets the cancel request while the lease is held, then the close, and the turn after", async () => {
    const budget = new LogScanBudget();
    const { m, steps, outcomes } = rig(database(100, (text) => (text.startsWith("with done") ? "hang" : undefined)), { budget });
    m.start();
    await until(() => m.ready, "ready");
    m.want("ROOM");
    await until(() => steps.includes("complete"), "in the statement");
    assert.equal(budget.usage.turns.page, 1);
    await m.stop();
    const tail = steps.slice(steps.indexOf("complete") + 1);
    assert.deepEqual(tail, ["cancel (leases 1)", "end (leases 1)"], "cancel first, then the close, both with the lease still held, and no unlock");
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
    assert.deepEqual(outcomes.at(-1), { kind: "room", roomId: "ROOM", outcome: "cancelled" });
  });

  test("a failed statement closes the connection with no more SQL, and the room is taken again on its next read", async () => {
    let fail = true;
    const { m, steps, outcomes } = rig(database(10, (text) => (text.startsWith("with done") && fail ? new Error("deadlock detected") : undefined)));
    m.start();
    await until(() => m.ready, "ready");
    m.want("ROOM");
    await until(() => outcomes.some((o) => o.kind === "room"), "failed");
    assert.deepEqual(outcomes.at(-1), { kind: "room", roomId: "ROOM", outcome: "failed" });
    assert.deepEqual(steps.slice(steps.indexOf("complete") + 1, steps.indexOf("complete") + 3), ["cancel (leases 1)", "end"]);
    fail = false;
    m.want("ROOM");
    await until(() => outcomes.filter((o) => o.kind === "room").length === 2, "again");
    assert.deepEqual(outcomes.at(-1), { kind: "room", roomId: "ROOM", outcome: "complete" });
    assert.equal(steps.at(-2), "unlock", "a job that ends well gives its lock back itself");
    await m.stop();
  });

  test("a stop that lands as a batch's statement returns still closes the connection before the turn and lease go", async () => {
    const budget = new LogScanBudget();
    let stopping: Promise<void> | null = null;
    let stop!: () => Promise<void>;
    const steps: string[] = [];
    const { m, steps: seen } = rig(
      database(600, (text) => {
        if (!text.startsWith("with done") || stopping) return undefined;
        // The stop arrives in the moment the statement answers, so the batch itself ends well.
        stopping = Promise.resolve().then(() => stop());
        return { rows: [{ completed: "500" }] };
      }),
      {
        budget,
        // A cancel request takes a moment to reach the server, while the batch that has its answer unwinds.
        cancel: async () => {
          steps.push(`cancel (leases ${budget.usage.leases.page})`);
          await new Promise((r) => setTimeout(r, 20));
        },
      },
    );
    stop = () => m.stop();
    m.start();
    await until(() => m.ready, "ready");
    m.want("ROOM");
    await until(() => stopping !== null, "the statement answered");
    await stopping;
    const all = [...seen];
    const tail = all.slice(all.indexOf("complete") + 1);
    assert.deepEqual(steps, ["cancel (leases 1)"]);
    assert.deepEqual(tail, ["end (leases 1)"], "the connection closes while the lease is held");
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
  });

  test("the worker's own cancel of a deleted room stops the job's statement, as the budget's does", async () => {
    const budget = new LogScanBudget();
    const { m, steps, outcomes } = rig(database(100, (text) => (text.startsWith("with done") ? "hang" : undefined)), { budget });
    m.start();
    await until(() => m.ready, "ready");
    m.want("ROOM");
    await until(() => steps.includes("complete"), "in the statement");
    m.cancelRoom("ROOM");
    await until(() => outcomes.some((o) => o.kind === "room"), "cancelled");
    assert.deepEqual(outcomes.at(-1), { kind: "room", roomId: "ROOM", outcome: "cancelled" });
    assert.deepEqual(steps.slice(steps.indexOf("complete") + 1), ["cancel (leases 1)", "end (leases 1)"]);
    assert.deepEqual(budget.usage, { turns: { page: 0, export: 0 }, leases: { page: 0, export: 0 }, waiting: 0, scans: 0 });
    await m.stop();
  });

  test("rooms are asked for once each, up to a bound, and a deleted one leaves the queue", async () => {
    const { m } = rig(database(0, (text) => (text.includes("indisvalid") ? "hang" : undefined)), { maxWanted: 2 });
    m.start();
    for (const room of ["A", "B", "A", "C"]) m.want(room);
    assert.deepEqual(m.detail.wanted, ["A", "B"]);
    m.cancelRoom("A");
    assert.deepEqual(m.detail.wanted, ["B"]);
    await m.stop();
    m.want("D");
    assert.deepEqual(m.detail.wanted, [], "nothing after stop");
  });
});
