import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { passedSeconds, readReport, rewrite, type Reported } from "./e2e-durations.ts";

/** A shard's report as a job's log holds it: a timestamp on every line, the shard's own warning under a file that reran. */
const LOG = [
  "2026-10-25T17:20:54.4100000Z ::endgroup::",
  "2026-10-25T17:20:54.4180456Z shard 2 of 13",
  "2026-10-25T17:20:54.4181635Z   alignment   failed (28 of 30 tests passed) in 558 s, then its rerun passed (30 tests) in 560 s",
  "2026-10-25T17:20:54.4204496Z ##[warning]alignment failed, then passed on its rerun. Its logs and screenshots are in this shard's artifact.",
  "2026-10-25T17:20:54.4212675Z   companions  passed (30 tests) in 89 s",
  "2026-10-25T17:20:54.4213338Z   guide       passed (6 tests, 1 todo) in 14 s, join counts not cleared",
  "2026-10-25T17:20:54.4213695Z   pcstats     failed (20 of 24 tests passed) in 48 s, then its rerun failed (20 of 24 tests passed) in 47 s",
  "2026-10-25T17:20:54.4213695Z ##[error]pcstats failed twice. Its logs and screenshots are in this shard's artifact.",
  "2026-10-25T17:20:54.4213700Z   pdf         timed out (3 of 9 tests passed) in 300 s, and no rerun, too little of the job's time left",
  "2026-10-25T17:20:54.4213710Z   size        not run, too little of the job's time left",
  "2026-10-25T17:20:54.4336003Z ##[group]Run actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "2026-10-25T17:20:54.4336433Z   name: e2e-shard-2",
].join("\n");

describe("a shard's report", () => {
  test("every file's line is read, past the warnings and errors under them, and nothing after the report", () => {
    const reported = readReport(LOG);
    assert.deepEqual(
      reported.map((r) => r.file),
      ["alignment", "companions", "guide", "pcstats", "pdf", "size"],
    );
    assert.deepEqual(reported[0], { file: "alignment", first: { how: "failed", seconds: 558 }, rerun: { how: "passed", seconds: 560 } });
    assert.deepEqual(reported[2], { file: "guide", first: { how: "passed", seconds: 14 }, rerun: null });
    assert.deepEqual(reported[4], { file: "pdf", first: { how: "timed out", seconds: 300 }, rerun: null }, "no rerun ran");
    assert.deepEqual(reported[5], { file: "size", first: { how: "not run", seconds: null }, rerun: null });
  });

  test("the shard's first line, which lists its files, starts no report", () => {
    const log = ["shard 2 of 13: alignment, companions (about 353 s)", "  alignment  passed (30 tests) in 560 s", "", "shard 2 of 13", "  companions  passed (30 tests) in 89 s"].join("\n");
    assert.deepEqual(
      readReport(log).map((r) => r.file),
      ["companions"],
    );
  });

  test("color codes and Windows line ends hide no line", () => {
    const log = "shard 1 of 1\r\n\x1b[32m  kit  passed (4 tests) in 7 s\x1b[0m\r\n";
    assert.deepEqual(readReport(log), [{ file: "kit", first: { how: "passed", seconds: 7 }, rerun: null }]);
  });
});

describe("a file's time", () => {
  const run = (how: Reported["first"]["how"], seconds: number | null) => ({ how, seconds });
  test("is the run that passed, the first or its rerun, and none when neither did", () => {
    assert.equal(passedSeconds({ file: "a", first: run("passed", 40), rerun: null }), 40);
    assert.equal(passedSeconds({ file: "a", first: run("failed", 12), rerun: run("passed", 41) }), 41);
    assert.equal(passedSeconds({ file: "a", first: run("failed", 12), rerun: run("failed", 13) }), null);
    assert.equal(passedSeconds({ file: "a", first: run("timed out", 300), rerun: run("not run", null) }), null);
  });
});

describe("the new list", () => {
  const old = { defaultSeconds: 60, seconds: { alignment: 272, barrest: 910, gone: 30, pcstats: 32 } };
  const passed = (file: string, seconds: number): Reported => ({ file, first: { how: "passed", seconds }, rerun: null });

  test("holds the largest time a run passed in, the old time where none passed, and only files that exist", () => {
    const reports: Reported[] = [passed("alignment", 585), passed("alignment", 541), passed("barrest", 300), { file: "pcstats", first: { how: "failed", seconds: 3 }, rerun: { how: "failed", seconds: 4 } }, passed("fresh", 20)];
    assert.deepEqual(rewrite(old, reports, ["pcstats", "fresh", "barrest", "alignment", "unrecorded"]), {
      defaultSeconds: 60,
      seconds: { alignment: 585, barrest: 300, fresh: 20, pcstats: 32 },
    });
  });

  test("lists its files by name, so a rewrite changes only the times that moved", () => {
    const next = rewrite(old, [passed("barrest", 300)], ["pcstats", "barrest", "alignment"]);
    assert.deepEqual(Object.keys(next.seconds), ["alignment", "barrest", "pcstats"]);
  });

  test("a name on Object's prototype is no old time", () => {
    assert.deepEqual(rewrite(old, [], ["constructor"]).seconds, {});
  });
});
