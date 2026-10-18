import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CopyRun, IDLE, type CopyState } from "./copy.ts";

/** One request the test answers by hand. */
type Pending = { id: number; signal: AbortSignal; resolve(v: string): void; reject(e: Error): void; onWaiting(w: boolean): void; settled: boolean };

function harness() {
  const states: CopyState[] = [];
  const done: { id: number; value: string }[] = [];
  const pending: Pending[] = [];
  let next = 0;
  const run = new CopyRun(
    (s) => states.push(s),
    (err) => (err instanceof Error ? err.message : "failed"),
  );
  const tap = () => {
    const id = ++next;
    const started = run.start<string>(
      (signal, onWaiting) =>
        new Promise<string>((resolve, reject) => {
          pending.push({ id, signal, resolve, reject, onWaiting, settled: false });
        }),
      (value) => done.push({ id, value }),
    );
    return { id, started };
  };
  return { run, states, done, pending, tap };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a starter copy", () => {
  test("is busy until the answer, which it hands on once", async () => {
    const h = harness();
    assert.equal(h.tap().started, true);
    assert.deepEqual(h.run.state, { busy: true, waiting: false, error: null });
    h.pending[0]!.onWaiting(true);
    assert.equal(h.run.state.waiting, true);
    h.pending[0]!.resolve("row");
    await flush();
    assert.deepEqual(h.run.state, IDLE);
    assert.deepEqual(h.done, [{ id: 1, value: "row" }]);
  });

  test("refuses a second tap while the first is under way", () => {
    const h = harness();
    h.tap();
    assert.equal(h.tap().started, false);
    assert.equal(h.pending.length, 1);
  });

  test("says why in plain words when the server refuses, and the next tap clears it", async () => {
    const h = harness();
    h.tap();
    h.pending[0]!.reject(new Error("This room is read-only right now."));
    await flush();
    assert.deepEqual(h.run.state, { busy: false, waiting: false, error: "This room is read-only right now." });
    h.tap();
    assert.equal(h.run.state.error, null);
  });

  test("drops an answer that comes after Cancel or after the picker closed", async () => {
    const h = harness();
    h.tap();
    h.run.cancel();
    assert.equal(h.pending[0]!.signal.aborted, true);
    h.pending[0]!.resolve("late");
    await flush();
    assert.deepEqual(h.done, []);
    h.tap();
    h.run.close();
    const changes = h.states.length;
    h.pending[1]!.resolve("later");
    await flush();
    assert.deepEqual(h.done, []);
    assert.equal(h.states.length, changes, "nothing is reported once closed");
    assert.equal(h.tap().started, false, "a closed run starts nothing");
  });

  /*
   * Random taps, cancels, waits, answers, refusals and a close, in any
   * order, with answers that come late or never. The invariants:
   * - never two requests in flight at once;
   * - a tap starts a request exactly when none is in flight and the run is open;
   * - nothing is handed on from a cancelled request, after close, or twice;
   * - busy says whether a request is in flight, and waiting is only ever busy's;
   * - nothing is reported after close.
   */
  test("keeps its invariants over many random sequences", async () => {
    let seed = 20261018;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 400; round++) {
      const h = harness();
      let closed = false;
      let closedAt = -1;
      const cancelled = new Set<number>();
      for (let step = 0; step < 24; step++) {
        const live = h.pending.filter((p) => !p.settled && !p.signal.aborted);
        assert.ok(live.length <= 1, "two requests in flight");
        const roll = random();
        if (roll < 0.3) {
          const { id, started } = h.tap();
          assert.equal(started, !closed && live.length === 0, `tap ${id} started wrongly`);
        } else if (roll < 0.45) {
          for (const p of live) cancelled.add(p.id);
          h.run.cancel();
        } else if (roll < 0.55) {
          live[0]?.onWaiting(random() < 0.5);
        } else if (roll < 0.95 && h.pending.length > 0) {
          // Any request answers, the live one or one long since cancelled.
          const p = h.pending[Math.floor(random() * h.pending.length)]!;
          if (!p.settled) {
            p.settled = true;
            if (random() < 0.7) p.resolve(`row ${p.id}`);
            else p.reject(new Error(`refused ${p.id}`));
          }
        } else if (!closed) {
          for (const p of live) cancelled.add(p.id);
          h.run.close();
          closed = true;
          closedAt = h.states.length;
        }
        await flush();
        const inFlight = h.pending.filter((p) => !p.settled && !p.signal.aborted);
        assert.equal(h.run.state.busy, inFlight.length > 0, "busy does not match what is in flight");
        if (!h.run.state.busy) assert.equal(h.run.state.waiting, false, "waiting while idle");
      }
      const ids = h.done.map((d) => d.id);
      assert.equal(new Set(ids).size, ids.length, "a request handed on twice");
      for (const id of ids) assert.equal(cancelled.has(id), false, `cancelled request ${id} handed on`);
      if (closed) assert.equal(h.states.length, closedAt, "reported after close");
    }
  });
});
