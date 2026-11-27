import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import fc from "fast-check";
import { MODEL_LIMITS } from "#shared/limits.ts";
import { runSettings } from "#shared/propertyTestutil.ts";
import { drawModel, endModelWorker, type DrawnSheet } from "./client.ts";
import { MODEL_WORDS, type FromModelWorker, type ToModelWorker } from "./mesh.ts";

/**
 * The page's side of the model worker (client.ts) over many random
 * sequences of requests, cancels, answers, late and stray answers, crashes,
 * the watchdog and closing. It juggles all of them, so its invariants are
 * held over every order, on a fake worker and a fake clock:
 *
 * - SETTLED: every request ends, once, in its sheet, a refusal's words or an AbortError.
 * - OWN: a sheet is the one drawn for that request's file and options.
 * - HELD: a request sent without its file goes to a worker that read that file.
 * - ONE: a worker never has two requests at once, and an ended worker is never sent one.
 * - QUIET: no stage note after a request ends, and no watchdog left once all have ended.
 * - PROGRESS: a request still open is the one the live worker runs, or the one newest behind it.
 */

type Listener = (e: { data?: unknown }) => void;

class FakeWorker {
  static all: FakeWorker[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly inbox: ToModelWorker[] = [];
  terminated = false;
  /** The file this worker has read, as the real one keeps its mesh. */
  held: File | null = null;
  /** The request it is working on. */
  open: ToModelWorker | null = null;
  readonly faults: string[] = [];

  constructor() {
    FakeWorker.all.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(message: ToModelWorker): void {
    if (this.terminated) this.faults.push("ONE: a message to an ended worker");
    if (this.open) this.faults.push("ONE: a second request while one runs");
    if (!message.file && !this.held) this.faults.push("HELD: options sent to a worker holding no file");
    this.inbox.push(message);
    this.open = message;
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  /** Answers its open request as the real worker would: notes on the way, then a sheet or a refusal. */
  answer(outcome: "drawn" | "refused", stages: number): void {
    const m = this.open;
    if (!m || this.terminated) return;
    this.open = null;
    if (m.file) {
      this.emit("message", { t: "stage", id: m.id, stage: "reading" } satisfies FromModelWorker);
      this.held = m.file;
    }
    for (let s = 0; s < stages; s++) this.emit("message", { t: "stage", id: m.id, stage: "drawing" } satisfies FromModelWorker);
    if (outcome === "refused") {
      if (m.file) this.held = null;
      this.emit("message", { t: "refused", id: m.id, message: `refused ${m.id}` } satisfies FromModelWorker);
      return;
    }
    const sheet: FromModelWorker = { t: "drawn", id: m.id, sheet: new Blob(), front: new Blob(), meta: { side: 1, anchorY: 0.5, boxes: [] }, maxSize: m.options.size, colorable: true, notes: [this.held!.name] };
    this.emit("message", sheet);
  }
}

/** A clock the test moves: timers fire only when it is told to. */
class FakeClock {
  now = 0;
  timers = new Map<number, { at: number; run: () => void }>();
  #next = 1;
  set = (run: () => void, ms: number) => {
    const id = this.#next++;
    this.timers.set(id, { at: this.now + ms, run });
    return id;
  };
  clear = (id: number) => void this.timers.delete(id);
  tick(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > this.now || !this.timers.has(id)) continue;
      this.timers.delete(id);
      t.run();
    }
  }
}

const saved = { Worker: globalThis.Worker, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
let clock: FakeClock;

beforeEach(() => {
  FakeWorker.all = [];
  clock = new FakeClock();
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  (globalThis as Record<string, unknown>).setTimeout = clock.set;
  (globalThis as Record<string, unknown>).clearTimeout = clock.clear;
});

afterEach(() => {
  endModelWorker();
  Object.assign(globalThis, saved);
});

const files = [new File(["a"], "a.stl"), new File(["b"], "b.glb"), new File(["c"], "c.obj")];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const live = () => FakeWorker.all.filter((w) => !w.terminated).at(-1);

/** How a call ended: its error, or null while it runs or when it drew. */
function errorOf(c: Call): Error | null {
  return c.outcome && "err" in c.outcome ? c.outcome.err : null;
}

type Call = { file: File; size: number; controller: AbortController; outcome: { sheet: DrawnSheet } | { err: Error } | null; settles: number; stagesAfter: number };

function call(file: File, size: number, withSignal: boolean, calls: Call[]): Call {
  const controller = new AbortController();
  const c: Call = { file, size, controller, outcome: null, settles: 0, stagesAfter: 0 };
  calls.push(c);
  drawModel(file, { color: "stone", up: 0, front: 0, size, device: "computer", signal: withSignal ? controller.signal : undefined, onStage: () => c.outcome && c.stagesAfter++ }).then(
    (sheet) => {
      c.settles++;
      c.outcome = { sheet };
    },
    (err: Error) => {
      c.settles++;
      c.outcome = { err };
    },
  );
  return c;
}

type Step =
  | { t: "call"; file: number; signal: boolean }
  | { t: "abort"; which: number }
  | { t: "answer"; outcome: "drawn" | "refused"; stages: number }
  | { t: "stray"; worker: number; id: number }
  | { t: "crash" }
  | { t: "tick"; ms: number }
  | { t: "end" };

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("call" as const), file: fc.integer({ min: 0, max: 2 }), signal: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("abort" as const), which: fc.nat({ max: 30 }) }) },
  { weight: 6, arbitrary: fc.record({ t: fc.constant("answer" as const), outcome: fc.constantFrom("drawn" as const, "drawn" as const, "refused" as const), stages: fc.integer({ min: 0, max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("stray" as const), worker: fc.nat({ max: 10 }), id: fc.integer({ min: -2, max: 40 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("crash" as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("tick" as const), ms: fc.constantFrom(1, 5_000, 19_999, 20_000, 25_000) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("end" as const) }) },
);

async function play(steps: readonly Step[]): Promise<Call[]> {
  const calls: Call[] = [];
  let size = 1000;
  for (const s of steps) {
    if (s.t === "call") call(files[s.file]!, size++, s.signal, calls);
    else if (s.t === "abort") calls[s.which % Math.max(1, calls.length)]?.controller.abort();
    else if (s.t === "answer") live()?.answer(s.outcome, s.stages);
    else if (s.t === "stray") {
      // A late answer from an ended worker, or one from the live worker for a request it is not on, with an id some request had, or the next.
      const w = FakeWorker.all[s.worker % Math.max(1, FakeWorker.all.length)];
      const ids = FakeWorker.all.flatMap((x) => x.inbox.map((m) => m.id));
      const id = ids.length > 0 ? ids[Math.abs(s.id) % ids.length]! + (s.id % 3 === 0 ? 1 : 0) : s.id;
      if (w && (w.terminated || w.open?.id !== id)) w.emit("message", { t: "drawn", id, sheet: new Blob(), front: new Blob(), meta: { side: 1, anchorY: 0.5, boxes: [] }, maxSize: -1, colorable: true, notes: ["stray"] });
    }
    else if (s.t === "crash") live()?.emit("error");
    else if (s.t === "tick") clock.tick(s.ms);
    else endModelWorker();
    await flush();
    for (const w of FakeWorker.all) if (w.open && !w.terminated && clock.timers.size === 0) assert.fail("ONE: a request runs with no watchdog");
    // PROGRESS: a request still open is the one the live worker runs, or the one waiting behind it.
    const open = calls.filter((c) => c.settles === 0);
    if (open.length > 0) assert.ok(live()?.open, `PROGRESS: ${open.length} requests wait on no worker`);
    assert.ok(open.length <= 2, `PROGRESS: ${open.length} requests open at once`);
  }
  endModelWorker();
  await flush();
  return calls;
}

function check(calls: Call[], refusals: (message: string) => boolean): void {
  for (const w of FakeWorker.all) assert.deepEqual(w.faults, []);
  calls.forEach((c, i) => {
    assert.equal(c.settles, 1, `SETTLED: call ${i} ended ${c.settles} times`);
    assert.equal(c.stagesAfter, 0, `QUIET: call ${i} heard a stage after it ended`);
    const outcome = c.outcome!;
    if ("sheet" in outcome) {
      assert.equal(outcome.sheet.maxSize, c.size, `OWN: call ${i} got another request's sheet`);
      assert.deepEqual(outcome.sheet.notes, [c.file.name], `OWN: call ${i} drawn from another file`);
    } else {
      const err = outcome.err;
      assert.ok(err.name === "AbortError" || refusals(err.message), `SETTLED: call ${i} ended in ${err.name}: ${err.message}`);
    }
  });
  assert.equal(clock.timers.size, 0, "QUIET: a watchdog left running");
}

const { seed, runs } = runSettings(process.env);

const known = (message: string) => message === MODEL_WORDS.crashed || message === MODEL_WORDS.tooLong || /^refused \d+$/.test(message);

describe("the model worker's page side", () => {
  test("holds every invariant over random sequences of requests, cancels, answers, crashes, the watchdog and closing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 40 }), async (steps) => {
        endModelWorker();
        FakeWorker.all = [];
        clock = new FakeClock();
        (globalThis as Record<string, unknown>).setTimeout = clock.set;
        (globalThis as Record<string, unknown>).clearTimeout = clock.clear;
        check(await play(steps), known);
      }),
      { seed, numRuns: runs ?? 300 },
    );
  });

  test("a second request for the same file waits without reading again, and only the newest waits", async () => {
    const calls: Call[] = [];
    call(files[0]!, 1, false, calls);
    call(files[0]!, 2, false, calls);
    call(files[0]!, 3, false, calls);
    await flush();
    assert.equal(errorOf(calls[1]!)?.name, "AbortError");
    const w = live()!;
    w.answer("drawn", 1);
    await flush();
    assert.equal(w.inbox.length, 2);
    assert.equal(w.inbox[1]!.file, null, "the newest draws from what was read");
    assert.equal(w.inbox[1]!.options.size, 3);
    w.answer("drawn", 1);
    await flush();
    assert.deepEqual(calls.map((c) => c.outcome && "sheet" in c.outcome && c.outcome.sheet.maxSize), [1, false, 3]);
    assert.equal(FakeWorker.all.length, 1);
  });

  test("a request for another file ends the worker at once and reads the new file in a new one", async () => {
    const calls: Call[] = [];
    call(files[0]!, 1, false, calls);
    const first = live()!;
    call(files[1]!, 2, false, calls);
    await flush();
    assert.ok(first.terminated);
    assert.equal(errorOf(calls[0]!)?.name, "AbortError");
    assert.equal(live()!.inbox[0]!.file, files[1]);
  });

  test("Cancel ends the worker at once, and the next request reads its file again", async () => {
    const calls: Call[] = [];
    const c = call(files[0]!, 1, true, calls);
    live()!.answer("drawn", 0);
    await flush();
    call(files[0]!, 2, true, calls).controller.abort();
    await flush();
    assert.ok(FakeWorker.all[0]!.terminated);
    call(files[0]!, 3, false, calls);
    assert.equal(live()!.inbox[0]!.file, files[0], "a new worker gets the file again");
    void c;
  });

  test("the watchdog ends a run at 20 seconds in the design's words", async () => {
    const calls: Call[] = [];
    call(files[0]!, 1, false, calls);
    clock.tick(MODEL_LIMITS.drawMs - 1);
    await flush();
    assert.equal(calls[0]!.outcome, null);
    clock.tick(1);
    await flush();
    assert.equal(errorOf(calls[0]!)?.message, "Drawing the model took too long on this device. Try a smaller file, or add it from a computer.");
    assert.ok(FakeWorker.all[0]!.terminated);
  });

  test("a worker that dies ends its request with the crash words", async () => {
    const calls: Call[] = [];
    call(files[0]!, 1, false, calls);
    live()!.emit("error");
    await flush();
    assert.equal(errorOf(calls[0]!)?.message, MODEL_WORDS.crashed);
  });

  test("a refused read leaves the worker holding no file, so the next request sends it again", async () => {
    const calls: Call[] = [];
    call(files[0]!, 1, false, calls);
    live()!.answer("refused", 0);
    await flush();
    call(files[0]!, 2, false, calls);
    assert.equal(live()!.inbox[1]!.file, files[0]);
  });

  test("a signal already aborted ends the request before it starts", async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(drawModel(files[0]!, { color: "stone", up: 0, front: 0, size: 100, signal: controller.signal }), { name: "AbortError" });
    assert.equal(FakeWorker.all.length, 0);
    void calls;
  });
});

