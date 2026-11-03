import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { DungeonPreviews, type Preview, type PreviewWorker } from "./client.ts";
import { dialogScene, twoRooms } from "./handPlans.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import type { FromWorker, ToWorker } from "./worker.ts";

/** A worker the test answers by hand: what it was sent, and a way to answer, crash or see it ended. */
class FakeWorker implements PreviewWorker {
  sent: ToWorker[] = [];
  ended = false;
  #message: ((e: MessageEvent<FromWorker>) => void)[] = [];
  #error: (() => void)[] = [];
  postMessage(message: ToWorker): void {
    assert.ok(!this.ended, "nothing is sent to an ended worker");
    this.sent.push(message);
  }
  addEventListener(type: string, listener: ((e: MessageEvent<FromWorker>) => void) | (() => void)): void {
    if (type === "message") this.#message.push(listener as (e: MessageEvent<FromWorker>) => void);
    else this.#error.push(listener as () => void);
  }
  terminate(): void {
    this.ended = true;
  }
  answer(id: number, preview: Preview): void {
    for (const l of this.#message) l({ data: { t: "preview", id, preview } } as MessageEvent<FromWorker>);
  }
  crash(): void {
    for (const l of this.#error) l();
  }
}

function harness() {
  const workers: FakeWorker[] = [];
  const previews = new DungeonPreviews(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  const settled: { n: number; preview: Preview }[] = [];
  let calls = 0;
  const ask = () => {
    const n = ++calls;
    void previews.preview({ ...DEFAULT_SETTINGS, rooms: n }, "1K7QH2MXA9F3TWQ5", dialogScene(twoRooms())).then((preview) => settled.push({ n, preview }));
    return n;
  };
  return { previews, workers, settled, ask, last: () => workers.at(-1)! };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const fit = (id: number): Preview => ({ ok: false, error: id % 2 === 0 ? "fit" : "bug" });

test("DG-B: quick choice changes draw one at a time, skip the ones overtaken, and answer only the newest", async () => {
  const h = harness();
  h.ask();
  h.ask();
  h.ask();
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.last().sent.map((m) => m.settings.rooms), [1], "one drawing at a time");
  h.last().answer(1, fit(1));
  await flush();
  assert.deepEqual(h.settled, [], "an answer to an overtaken request is dropped");
  assert.deepEqual(h.last().sent.map((m) => m.settings.rooms), [1, 3], "the waiting request overtaken by a newer one is never drawn");
  h.last().answer(2, fit(2));
  await flush();
  assert.deepEqual(h.settled, [], "an answer to a request it is not drawing is ignored");
  h.last().answer(3, fit(3));
  await flush();
  assert.deepEqual(h.settled, [{ n: 3, preview: fit(3) }]);
});

test("DG-B: closing ends the worker and drops a late answer, and the next preview starts a new one", async () => {
  const h = harness();
  h.previews.warm();
  assert.equal(h.workers.length, 1, "the worker loads as the dialog opens");
  h.ask();
  const first = h.last();
  h.previews.close();
  assert.ok(first.ended);
  first.answer(1, fit(1));
  await flush();
  assert.deepEqual(h.settled, []);
  h.ask();
  assert.equal(h.workers.length, 2);
  h.last().answer(h.last().sent[0]!.id, fit(1));
  await flush();
  assert.deepEqual(h.settled, [{ n: 2, preview: fit(1) }]);
});

test("DG-B: a worker that dies answers its newest request as a bug, and a newer waiting one is drawn by a fresh worker", async () => {
  const h = harness();
  h.ask();
  h.last().crash();
  await flush();
  assert.deepEqual(h.settled, [{ n: 1, preview: { ok: false, error: "bug" } }]);
  h.ask();
  h.ask();
  const dying = h.last();
  dying.crash();
  await flush();
  assert.equal(h.settled.length, 1, "the overtaken drawing is not answered");
  assert.ok(dying.ended);
  assert.equal(h.workers.length, 3);
  assert.deepEqual(h.last().sent.map((m) => m.settings.rooms), [3]);
  h.last().answer(h.last().sent[0]!.id, fit(4));
  await flush();
  assert.deepEqual(h.settled.at(-1), { n: 3, preview: fit(4) });
});

type Step = { k: "ask" } | { k: "answer" } | { k: "stray" } | { k: "crash" } | { k: "close" };

/** An answer that names the ask it was drawn for, so a test sees which ask's answer settled which promise. */
const drawnFor = (n: number): Preview => ({ ok: true, summary: { rooms: 0, asked: n, doors: 0, locked: 0, traps: 0 } }) as unknown as Preview;

test("DG-B: under any order of asks, answers, stray answers, crashes and closes, only the newest ask settles, once, with its own answer, one drawn at a time", async () => {
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.constant<Step>({ k: "ask" }) },
    { weight: 4, arbitrary: fc.constant<Step>({ k: "answer" }) },
    { weight: 1, arbitrary: fc.constant<Step>({ k: "stray" }) },
    { weight: 1, arbitrary: fc.constant<Step>({ k: "crash" }) },
    { weight: 1, arbitrary: fc.constant<Step>({ k: "close" }) },
  );
  const runs: Step[][] = [];
  holds(fc.property(fc.array(step, { maxLength: 40 }), (steps) => void runs.push(steps)), 300);
  for (const steps of runs) {
    const h = harness();
    // Per worker, how many of its requests it has answered.
    const answered = new Map<FakeWorker, number>();
    let newest = 0;
    let closed = false;
    let seen = 0;
    const answerNext = (w: FakeWorker) => {
      const done = answered.get(w) ?? 0;
      if (done >= w.sent.length) return false;
      answered.set(w, done + 1);
      w.answer(w.sent[done]!.id, drawnFor(w.sent[done]!.settings.rooms));
      return true;
    };
    const check = () => {
      for (const s of h.settled.slice(seen)) {
        assert.equal(s.n, newest, "only the newest ask settles");
        assert.ok(!closed, "nothing settles after a close until the next ask");
        assert.ok(s.preview.ok ? s.preview.summary.asked === s.n : s.preview.error === "bug", "with its own answer, or a crash's");
      }
      seen = h.settled.length;
      for (const w of h.workers) assert.ok(w.ended || w.sent.length - (answered.get(w) ?? 0) <= 1, "at most one drawing at a time");
    };
    for (const s of steps) {
      const w = h.workers.at(-1);
      if (s.k === "ask") {
        newest = h.ask();
        closed = false;
      } else if (s.k === "close") {
        h.previews.close();
        closed = true;
      } else if (w && !w.ended) {
        if (s.k === "crash") w.crash();
        else if (s.k === "stray") w.answer(-1, drawnFor(-1));
        else answerNext(w);
      }
      await flush();
      check();
    }
    // Then the last worker answers everything it holds, and the newest ask is never left without an answer.
    for (let guard = 0; guard < 4; guard++) {
      const w = h.workers.at(-1);
      if (!w || w.ended || !answerNext(w)) break;
      await flush();
      check();
    }
    const ns = h.settled.map((s) => s.n);
    assert.equal(new Set(ns).size, ns.length, "each ask settles at most once");
    if (newest > 0 && !closed) assert.equal(ns.at(-1), newest, "the newest ask always ends in an answer");
  }
});
