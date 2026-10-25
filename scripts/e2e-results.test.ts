import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { rerunSkips, skipPattern, summaryCount, type TestResult } from "./e2e-shard-plan.ts";

const REPORTER = fileURLToPath(new URL("./e2e-results.ts", import.meta.url));

/**
 * A file shaped like an e2e file: a room its first test builds, which the
 * later tests need, a test in a nested suite, a name with marks a pattern
 * must escape, and a test that fails while FLAKE is set.
 */
const FILE = `
import assert from "node:assert/strict";
import { describe, test } from "node:test";
let room = null;
describe("raccoon-vtt: a room (docs/x.md)", () => {
  test("0. the room", () => { room = "built"; console.log("RAN 0"); });
  test("1. a step [1 px] at 100%", () => { assert.equal(room, "built"); console.log("RAN 1"); });
  describe("inner: steps", () => {
    test("2. a flaky step", () => { assert.equal(room, "built"); console.log("RAN 2"); assert.ok(!process.env.FLAKE, "flaked"); });
    test("3. a step after it", () => { console.log("RAN 3"); });
  });
  test("4. the last step", () => { console.log("RAN 4"); });
});
`;

describe("the results reporter and the rerun it allows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-results-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "room.test.ts"), FILE);

  /**
   * Runs the file as the shard does, with both reporters, and gives what it
   * printed and the results it wrote. The child gets no NODE_TEST_CONTEXT,
   * as under the shard's plain node process: with this runner's own, it
   * would send its results here rather than to its reporters.
   */
  function run(label: string, args: string[], env: Record<string, string> = {}): { out: string; results: TestResult[] } {
    const results = path.join(dir, `${label}.jsonl`);
    const { NODE_TEST_CONTEXT: _, ...outside } = process.env;
    let out: string;
    try {
      out = execFileSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", "--test-reporter-destination=stdout", `--test-reporter=${REPORTER}`, `--test-reporter-destination=${results}`, ...args, "room.test.ts"], { cwd: dir, encoding: "utf8", env: { ...outside, ...env } });
    } catch (err) {
      out = (err as { stdout: string }).stdout;
    }
    const lines = readFileSync(results, "utf8").split("\n").filter(Boolean);
    return { out, results: lines.map((l) => JSON.parse(l) as TestResult) };
  }

  test("each test's result comes in the order the tests ran, by its suites' names and its own", () => {
    const { results } = run("first", [], { FLAKE: "1" });
    assert.deepEqual(results, [
      { full: "raccoon-vtt: a room (docs/x.md) 0. the room", ok: true },
      { full: "raccoon-vtt: a room (docs/x.md) 1. a step [1 px] at 100%", ok: true },
      { full: "raccoon-vtt: a room (docs/x.md) inner: steps 2. a flaky step", ok: false },
      { full: "raccoon-vtt: a room (docs/x.md) inner: steps 3. a step after it", ok: true },
      { full: "raccoon-vtt: a room (docs/x.md) 4. the last step", ok: true },
    ]);
  });

  test("the rerun runs every test up to the failure, the room's among them, and leaves out the passes after it", () => {
    const first = run("flaky", [], { FLAKE: "1" });
    const skips = rerunSkips(first.results, summaryCount(first.out, "tests"));
    assert.equal(skips.length, 2);
    const again = run("rerun", skips.map((s) => `--test-skip-pattern=${skipPattern(s)}`));
    assert.deepEqual([...again.out.matchAll(/^RAN (\d)$/gm)].map((m) => m[1]), ["0", "1", "2"]);
    assert.equal(summaryCount(again.out, "tests"), 3);
    assert.equal(summaryCount(again.out, "fail"), 0);
  });
});
