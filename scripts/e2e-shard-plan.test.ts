import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anyRerun, attempt, CLEANUP_SECONDS, filePassed, generousLimit, NO_TIME, outcome, passedOnRerun, plan, runLimit, secondsFor, SLOW, summaryCount, withTimeout, type AttemptSteps, type Durations, type Result, type Run } from "./e2e-shard-plan.ts";

const durations: Durations = { defaultSeconds: 60, seconds: { swipe: 284, reach: 179, bardock: 169, layout: 124, pdf: 69, dice: 12, kit: 4 } };
const files = ["dice", "kit", "layout", "pdf", "reach", "swipe", "bardock", "brandnew"];

function run(over: Partial<Run> = {}): Run {
  return { ok: true, seconds: 30, tests: 10, passed: 10, todo: 0, timedOut: false, countsCleared: true, ...over };
}

describe("the shard plan", () => {
  test("a file not recorded yet counts as the default", () => {
    assert.equal(secondsFor(durations, "pdf"), 69);
    assert.equal(secondsFor(durations, "brandnew"), 60);
    assert.equal(secondsFor(durations, "constructor"), 60, "a name on Object's prototype is not a record");
  });

  test("every file lands on exactly one shard, at any shard count", () => {
    for (let count = 1; count <= 10; count++) {
      const shards = plan(files, durations, count);
      assert.equal(shards.length, count);
      assert.deepEqual(shards.flatMap((s) => s.files).sort(), [...files].sort(), `${count} shards`);
      for (const s of shards) assert.equal(s.seconds, s.files.reduce((sum, f) => sum + secondsFor(durations, f), 0));
    }
  });

  test("the longest file goes first, onto the lightest shard", () => {
    const shards = plan(files, durations, 3);
    assert.deepEqual(
      shards.map((s) => s.files),
      [["dice", "swipe"], ["brandnew", "pdf", "reach"], ["bardock", "kit", "layout"]],
    );
  });

  test("ties go by name, so the order the files are listed in changes nothing", () => {
    const even: Durations = { defaultSeconds: 10, seconds: {} };
    const names = ["delta", "alpha", "charlie", "bravo", "echo"];
    const once = plan(names, even, 2);
    assert.deepEqual(once.map((s) => s.files), [["alpha", "charlie", "echo"], ["bravo", "delta"]]);
    assert.deepEqual(plan([...names].reverse(), even, 2), once);
    assert.deepEqual(plan(files, durations, 4), plan([...files].reverse(), durations, 4));
  });

  test("more shards than files leaves the extra shards empty", () => {
    const shards = plan(["pdf", "kit"], durations, 4);
    assert.deepEqual(shards.map((s) => s.files.length), [1, 1, 0, 0]);
  });
});

describe("the test runner's totals", () => {
  const tail = ["✔ 1. a room (12ms)", "ℹ tests 11", "ℹ suites 1", "ℹ pass 10", "ℹ fail 0", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 1", "ℹ duration_ms 86000"].join("\n");

  test("each total is read from its own line", () => {
    assert.equal(summaryCount(tail, "tests"), 11);
    assert.equal(summaryCount(tail, "pass"), 10);
    assert.equal(summaryCount(tail, "todo"), 1);
  });

  test("color codes from FORCE_COLOR do not hide a total", () => {
    const colored = tail.replace(/^ℹ (\w+) (\d+)$/gm, "\x1b[34mℹ $1 $2\x1b[39m");
    assert.equal(summaryCount(colored, "tests"), 11);
    assert.equal(summaryCount(colored, "pass"), 10);
  });

  test("a total missing, as when the run was killed, reads as null, and a test's own name does not count", () => {
    assert.equal(summaryCount("✔ ℹ pass 3 times (4ms)\n", "pass"), null);
    assert.equal(summaryCount("", "tests"), null);
  });
});

describe("the report's lines", () => {
  test("passes count tests, failures count passes, and todos show either way", () => {
    assert.equal(outcome(run({ seconds: 86, tests: 11, todo: 0 })), "passed (11 tests) in 86 s");
    assert.equal(outcome(run({ seconds: 86, tests: 11, todo: 1 })), "passed (11 tests, 1 todo) in 86 s");
    assert.equal(outcome(run({ ok: false, tests: 11, passed: 9, todo: 1 })), "failed (9 of 11 tests passed, 1 todo) in 30 s");
    assert.equal(outcome(run({ ok: false, timedOut: true, tests: null, passed: null })), "timed out in 30 s");
    assert.equal(outcome(run({ countsCleared: false })), "passed (10 tests) in 30 s, join counts not cleared");
    assert.equal(outcome(NO_TIME), "not run, too little of the job's time left");
  });
});

describe("a file's verdict", () => {
  const failed = run({ ok: false, passed: 9 });
  const cases: { name: string; r: Result; passed: boolean; flaky: boolean }[] = [
    { name: "passes at once", r: { file: "a", first: run(), rerun: null }, passed: true, flaky: false },
    { name: "fails, then passes on its rerun", r: { file: "a", first: failed, rerun: run() }, passed: true, flaky: true },
    { name: "fails twice", r: { file: "a", first: failed, rerun: failed }, passed: false, flaky: false },
    { name: "fails with no time for a rerun", r: { file: "a", first: failed, rerun: NO_TIME }, passed: false, flaky: false },
    { name: "times out, then passes", r: { file: "a", first: run({ ok: false, timedOut: true }), rerun: run() }, passed: true, flaky: true },
    { name: "never starts", r: { file: "a", first: NO_TIME, rerun: null }, passed: false, flaky: false },
  ];
  for (const c of cases) {
    test(`a file that ${c.name}`, () => {
      assert.equal(filePassed(c.r), c.passed);
      assert.equal(passedOnRerun(c.r), c.flaky);
    });
  }

  test("the shard counts as rerun only when a rerun started", () => {
    assert.equal(anyRerun([cases[0]!.r]), false);
    assert.equal(anyRerun([cases[0]!.r, cases[3]!.r]), false, "a rerun ruled out by the time left");
    assert.equal(anyRerun([cases[0]!.r, cases[2]!.r]), true);
  });
});

describe("each run's time limit", () => {
  test("with no deadline, a run gets 25 minutes, or three times its record when longer", () => {
    assert.equal(runLimit(160, Infinity, 1000, true), 1500);
    assert.equal(runLimit(700, Infinity, 0, false), 2100);
    assert.equal(generousLimit(499), 1500);
  });

  test("a first run gets half the room left after the rest of the shard, so its rerun fits in the other half", () => {
    // 40 minutes left, 300 recorded seconds after this file: the room is 2400 - 450.
    assert.equal(runLimit(160, 2400, 300, true), Math.floor((2400 - SLOW * 300) / 2));
    assert.equal(runLimit(160, 2400, 300, false), 1500, "a rerun gets the whole room, up to the generous limit");
    assert.equal(runLimit(160, 1400, 300, false), 1400 - SLOW * 300);
  });

  test("a first run takes the whole room when half of it cannot hold a rerun", () => {
    // Room 300, half 150, and the file needs 1.5 x 120 = 180.
    assert.equal(runLimit(120, 300 + SLOW * 100, 100, true), 300);
  });

  test("a run the room cannot hold is not started", () => {
    assert.equal(runLimit(120, SLOW * 120 - 1, 0, true), null);
    assert.equal(runLimit(120, SLOW * 120 + SLOW * 200 - 1, 200, false), null);
    assert.equal(runLimit(120, 0, 0, false), null);
  });

  test("a file that hangs twice still leaves the rest of the shard its reserved time", () => {
    const shard = [160, 40, 100, 120];
    const deadline = 2400;
    let used = 0;
    for (const [i, seconds] of shard.entries()) {
      const rest = shard.slice(i + 1).reduce((a, b) => a + b, 0);
      if (i === 0) {
        // The first file hangs on both runs, using its whole limit each time.
        used += runLimit(seconds, deadline - used, rest, true)!;
        used += runLimit(seconds, deadline - used, rest, false)!;
        assert.ok(deadline - used >= SLOW * rest, "the hung file left the rest its time");
      } else {
        // The others take their record at SLOW.
        assert.notEqual(runLimit(seconds, deadline - used, rest, true), null, `file ${i + 1} still starts`);
        used += SLOW * seconds;
      }
    }
    assert.ok(used <= deadline);
  });
});

/**
 * An attempt's steps on a clock of its own. A stalled cleanup or a stalled
 * run takes all the time it is given, as the real ones do once their
 * timeouts fire.
 */
function fakeSteps(opts: { cleanupStalls?: boolean; runStalls?: boolean; cleanupSeconds?: number; runSeconds?: number } = {}) {
  const clock = { now: 1_000 };
  const notes: string[] = [];
  const runs: number[] = [];
  const steps: AttemptSteps = {
    now: () => clock.now,
    async clear(seconds) {
      clock.now += opts.cleanupStalls ? seconds : (opts.cleanupSeconds ?? 0.2);
      return !opts.cleanupStalls;
    },
    async run(seconds) {
      runs.push(seconds);
      const took = opts.runStalls ? seconds : Math.min(seconds, opts.runSeconds ?? 30);
      clock.now += took;
      return { ok: !opts.runStalls, seconds: took, tests: 1, passed: opts.runStalls ? 0 : 1, todo: 0, timedOut: opts.runStalls === true };
    },
    note: (line) => notes.push(line),
  };
  return { clock, notes, runs, steps };
}

describe("an attempt and the cleanup before it", () => {
  test("withTimeout gives the value, gives up on work that stalls, and passes a rejection through", async () => {
    assert.deepEqual(await withTimeout(Promise.resolve(3), 1_000), { done: true, value: 3 });
    assert.deepEqual(await withTimeout(new Promise(() => {}), 20), { done: false });
    await assert.rejects(withTimeout(Promise.reject(new Error("refused")), 1_000), /refused/);
  });

  test("the run gets what the cleanup left of the attempt's deadline", async () => {
    const f = fakeSteps({ cleanupSeconds: 2.5 });
    const result = await attempt(100, f.steps);
    assert.deepEqual(f.runs, [97]);
    assert.deepEqual(f.notes, []);
    assert.ok(result !== NO_TIME && result.countsCleared);
  });

  test("a stalled cleanup is cut off, noted, and the file still runs in the time left", async () => {
    const f = fakeSteps({ cleanupStalls: true });
    const result = await attempt(100, f.steps);
    assert.deepEqual(f.runs, [100 - CLEANUP_SECONDS]);
    assert.equal(f.notes.length, 1);
    assert.match(f.notes[0]!, /join counts could not be cleared within 10 s/);
    assert.ok(result !== NO_TIME && result.ok && !result.countsCleared);
  });

  test("a stalled cleanup and then a stalled run end at the attempt's deadline, not after it", async () => {
    const f = fakeSteps({ cleanupStalls: true, runStalls: true });
    const start = f.clock.now;
    const result = await attempt(100, f.steps);
    assert.equal(f.clock.now - start, 100);
    assert.ok(result !== NO_TIME && result.timedOut && !result.countsCleared);
  });

  test("a stalled cleanup that uses up a short attempt starts no run", async () => {
    const f = fakeSteps({ cleanupStalls: true });
    assert.equal(await attempt(8, f.steps), NO_TIME);
    assert.deepEqual(f.runs, []);
    assert.equal(f.notes.length, 1);
  });

  test("a file whose cleanup and run stall on both attempts still leaves the rest of the shard its time", async () => {
    const shard = [160, 40, 100, 120];
    const deadline = 2_400;
    const f = fakeSteps({ cleanupStalls: true, runStalls: true });
    const start = f.clock.now;
    const left = () => deadline - (f.clock.now - start);
    const rest = shard.slice(1).reduce((a, b) => a + b, 0);
    for (const rerunMayFollow of [true, false]) {
      const limit = runLimit(shard[0]!, left(), rest, rerunMayFollow);
      assert.notEqual(limit, null);
      await attempt(limit!, f.steps);
    }
    assert.ok(left() >= SLOW * rest, `${left()} s left for ${SLOW * rest} s of files`);
  });
});
