import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anyRerun, filePassed, outcome, passedOnRerun, plan, secondsFor, summaryCount, type Durations, type Result, type Run } from "./e2e-shard-plan.ts";

const durations: Durations = { defaultSeconds: 60, seconds: { swipe: 284, reach: 179, bardock: 169, layout: 124, pdf: 69, dice: 12, kit: 4 } };
const files = ["dice", "kit", "layout", "pdf", "reach", "swipe", "bardock", "brandnew"];

function run(over: Partial<Run> = {}): Run {
  return { ok: true, seconds: 30, tests: 10, passed: 10, todo: 0, timedOut: false, ...over };
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
  });
});

describe("a file's verdict", () => {
  const failed = run({ ok: false, passed: 9 });
  const cases: { name: string; r: Result; passed: boolean; flaky: boolean }[] = [
    { name: "passes at once", r: { file: "a", first: run(), rerun: null }, passed: true, flaky: false },
    { name: "fails, then passes on its rerun", r: { file: "a", first: failed, rerun: run() }, passed: true, flaky: true },
    { name: "fails twice", r: { file: "a", first: failed, rerun: failed }, passed: false, flaky: false },
    { name: "times out, then passes", r: { file: "a", first: run({ ok: false, timedOut: true }), rerun: run() }, passed: true, flaky: true },
  ];
  for (const c of cases) {
    test(`a file that ${c.name}`, () => {
      assert.equal(filePassed(c.r), c.passed);
      assert.equal(passedOnRerun(c.r), c.flaky);
    });
  }

  test("the shard counts as rerun when any file reran", () => {
    assert.equal(anyRerun([cases[0]!.r]), false);
    assert.equal(anyRerun([cases[0]!.r, cases[2]!.r]), true);
  });
});
