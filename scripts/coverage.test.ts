import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { SourceMapPayload } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  TEST_SUPPORT_DIRS,
  TEST_SUPPORT_FILES,
  addBrowser,
  addUnloaded,
  browserCoverage,
  browserCovered,
  formatReport,
  isTestSupport,
  listShipped,
  main,
  mappedLines,
  markRan,
  mergeLcov,
  ranIntervals,
  readBrowserRuns,
  sumByArea,
  type BrowserRun,
} from "./coverage.ts";

const record = (file: string, hits: Record<number, number>) =>
  `SF:/repo/${file}\n${Object.entries(hits).map(([n, h]) => `DA:${n},${h}`).join("\n")}\nend_of_record\n`;

test("a line counts as covered when any test file hit it", () => {
  const unit = record("shared/a.ts", { 1: 1, 2: 0, 3: 0 });
  const int = record("shared/a.ts", { 1: 0, 2: 4, 3: 0 });
  const totals = sumByArea(mergeLcov([unit, int], "/repo")).get("shared")!;
  assert.deepEqual(totals, { found: 3, hit: 2 });
});

test("records for one file in one report are merged, not added", () => {
  const twice = record("client/a.ts", { 1: 1, 2: 0 }) + record("client/a.ts", { 1: 0, 2: 0 });
  assert.deepEqual(sumByArea(mergeLcov([twice], "/repo")).get("client"), { found: 2, hit: 1 });
});

test("scripts are reported but left out of the shipped figure", () => {
  const lcov = record("server/a.ts", { 1: 1, 2: 1 }) + record("scripts/b.ts", { 1: 0, 2: 0 }) + record("e2e/c.ts", { 1: 0 });
  const report = formatReport(sumByArea(mergeLcov([lcov], "/repo")));
  assert.match(report, /scripts\s+0\.0%\s+\(0\/2 lines\)/);
  assert.match(report, /Shipped code \(server, shared, client\): 100\.0%\s+\(2\/2 lines\)/);
});

test("a shipped file no test loaded counts every line at zero, as Node counts a loaded one", () => {
  const files = mergeLcov([record("server/a.ts", { 1: 1, 2: 1 })], "/repo");
  const sources: Record<string, string> = { "server/b.ts": "// note\n\nexport const b = 1;\n", "client/c.tsx": "x" };
  addUnloaded(files, ["server/a.ts", "server/b.ts", "client/c.tsx"], (file) => sources[file] ?? assert.fail(file));
  const byArea = sumByArea(files);
  assert.deepEqual(byArea.get("server"), { found: 5, hit: 2 });
  assert.deepEqual(byArea.get("client"), { found: 1, hit: 0 });
});

test("an empty unloaded file adds no lines", () => {
  const files = new Map<string, Map<string, boolean>>();
  addUnloaded(files, ["shared/e.ts"], () => "");
  assert.deepEqual(sumByArea(files).get("shared"), { found: 0, hit: 0 });
});

test("test helpers and tests are excluded, loaded or not", () => {
  const lcov = record("shared/testutil.ts", { 1: 1, 2: 1 }) + record("client/components/testing/register.ts", { 1: 1 }) + record("server/a.test.ts", { 1: 1 }) + record("server/real.ts", { 1: 0 });
  const files = mergeLcov([lcov], "/repo");
  addUnloaded(files, listShipped(["shared/testutil.ts", "client/dev/DevRoom.tsx", "server/rooms/testing.ts", "client/types.d.ts", "server/x.itest.ts", "shared/real.ts"]), () => "a\nb\n");
  assert.deepEqual(sumByArea(files).get("shared"), { found: 2, hit: 0 });
  assert.deepEqual(sumByArea(files).get("server"), { found: 1, hit: 0 });
  assert.deepEqual(sumByArea(files).get("client"), { found: 0, hit: 0 });
});

test("only source in the shipped areas is listed", () => {
  const listed = listShipped(["server/a.ts", "client/b.tsx", "shared/c.json", "client/globals.css", "scripts/d.ts", "e2e/e.ts"]);
  assert.deepEqual(listed, ["server/a.ts", "client/b.tsx"]);
});

test("test helpers are found by name, and shipped files with similar names are not", () => {
  for (const file of ["shared/testutil.ts", "shared/perPlayerTestutil.ts", "server/rooms/undoTesting.ts", "client/features/dice/abilityMenu.testing.ts", "shared/rules/hexWalls.testkit.ts", "client/features/new/testing.ts", "client/components/testing/x.ts", "shared/differential.ts", "client/dev/DevRoom.tsx"]) {
    assert.equal(isTestSupport(file), true, file);
  }
  for (const file of ["client/canvas/relief/isoTest.ts", "server/rooms/actor.ts", "shared/rules/testing-ground.ts", "client/pages/Room.tsx"]) {
    assert.equal(isTestSupport(file), false, file);
  }
});

test("every hand-listed test helper still exists", () => {
  const tracked = new Set(spawnSync("git", ["ls-files"], { encoding: "utf8" }).stdout.split("\n"));
  for (const file of TEST_SUPPORT_FILES) assert.ok(tracked.has(file), `${file} is listed but not tracked`);
  for (const dir of TEST_SUPPORT_DIRS) assert.ok([...tracked].some((f) => f.startsWith(dir)), `${dir} is listed but empty`);
});

// process.exit skips a finally block, and in a test it would end the run as a pass, so it throws.
const forbidExit = (t: TestContext) => t.mock.method(process, "exit", () => assert.fail("main must return its status, not call process.exit"));

test("the temporary directory is removed after a finished run", (t) => {
  forbidExit(t);
  let dir = "";
  const writeLcov = (lcovFile: string) => {
    dir = dirname(lcovFile);
    writeFileSync(lcovFile, record("shared/a.ts", { 1: 1 }));
    return 0;
  };
  const logged: string[] = [];
  const status = main({ runSuite: writeLcov, listTracked: () => ["shared/a.ts", "shared/b.ts"], readText: () => "x\n", cwd: "/repo", log: (t) => logged.push(t) });
  assert.equal(status, 0);
  assert.notEqual(dir, "");
  assert.equal(existsSync(dir), false);
  assert.match(logged.join("\n"), /Shipped code .*50\.0%\s+\(1\/2 lines\)/);
});

test("the temporary directory is removed when a suite fails too, and the status is returned", (t) => {
  forbidExit(t);
  let dir = "";
  const failing = (lcovFile: string) => {
    dir = dirname(lcovFile);
    writeFileSync(lcovFile, "");
    return 1;
  };
  const status = main({ runSuite: failing, listTracked: () => [], readText: () => "", cwd: "/repo", log: () => {} });
  assert.equal(status, 1);
  assert.equal(existsSync(dir), false);
});

// The browser tests' coverage (e2e/coverage.ts saves it, browserCoverage maps it to lines).

const range = (startOffset: number, endOffset: number, count: number) => ({ startOffset, endOffset, count });
const ranOf = (ran: Uint8Array) => [...ran].join("");

test("the innermost range decides whether a character ran, in whatever order V8 lists them", () => {
  // A function that ran, a branch in it that never did, and a callback inside that branch that ran
  // after a take reset the counts, as its own function.
  const fn = { ranges: [range(0, 12, 1), range(3, 9, 0)] };
  const inner = { ranges: [range(4, 6, 1)] };
  for (const functions of [[fn, inner], [inner, fn]]) {
    const ran = new Uint8Array(12);
    markRan(ran, functions);
    assert.equal(ranOf(ran), "111011000111");
  }
});

test("takes add up: a character that ran in any take stays ran", () => {
  const ran = new Uint8Array(6);
  markRan(ran, [{ ranges: [range(0, 6, 1), range(2, 4, 0)] }]);
  markRan(ran, [{ ranges: [range(0, 6, 0), range(2, 3, 1)] }]);
  assert.equal(ranOf(ran), "111011");
  assert.deepEqual(ranIntervals(ran), [0, 3, 4, 6]);
});

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "raccoon-coverage-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const saveRun = (dir: string, name: string, scripts: BrowserRun["scripts"]) => writeFileSync(join(dir, name), JSON.stringify({ scripts } satisfies BrowserRun));

test("saved runs are merged: a character ran when any run ran it", (t) => {
  const dir = tempDir(t);
  saveRun(dir, "1.json", { "assets/a.js": { length: 6, ran: [0, 2] } });
  saveRun(dir, "2.json", { "assets/a.js": { length: 6, ran: [4, 5] }, "assets/b.js": { length: 2, ran: [] } });
  const runs = readBrowserRuns(dir);
  assert.equal(ranOf(runs.get("assets/a.js")!), "110010");
  assert.equal(ranOf(runs.get("assets/b.js")!), "00");
});

test("runs against two builds of one chunk are refused", (t) => {
  const dir = tempDir(t);
  saveRun(dir, "1.json", { "assets/a.js": { length: 6, ran: [] } });
  saveRun(dir, "2.json", { "assets/a.js": { length: 7, ran: [] } });
  assert.throws(() => readBrowserRuns(dir), /another build of assets\/a\.js/);
});

// A source map from [generated line, column, source, original line, column] rows, all from 0.
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(n: number): string {
  let rest = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    const digit = rest & 31;
    rest >>>= 5;
    out += BASE64[rest > 0 ? digit | 32 : digit];
  } while (rest > 0);
  return out;
}
function sourceMap(sources: string[], contents: string[], rows: [number, number, number, number, number][]): SourceMapPayload {
  const lines: string[][] = [];
  let [source, line, column] = [0, 0, 0];
  for (const [genLine, genColumn, src, origLine, origColumn] of rows) {
    while (lines.length <= genLine) lines.push([]);
    const segments = lines[genLine]!;
    const before = segments.length === 0 ? 0 : rows.filter((r) => r[0] === genLine && r[1] < genColumn).at(-1)![1];
    segments.push(vlq(genColumn - before) + vlq(src - source) + vlq(origLine - line) + vlq(origColumn - column));
    [source, line, column] = [src, origLine, origColumn];
  }
  return { file: "a.js", version: 3, sources, sourcesContent: contents, names: [], mappings: lines.map((l) => l.join(",")).join(";"), sourceRoot: "" };
}

test("a token counts for the original line its mapping names, only when it ran if ran is given", () => {
  const text = "go(); stop();\n  more();\nglue";
  const map = sourceMap(["../../client/a.ts"], [""], [
    [0, 0, 0, 0, 0],
    [0, 6, 0, 2, 0],
    [1, 2, 0, 4, 0],
  ]);
  const all = mappedLines(text, map, "/repo/dist/assets/a.js", "/repo");
  // "glue" has no mapping on its own line, so it is not put on line 5 with the one before it.
  assert.deepEqual([...all.get("client/a.ts")!].sort(), [1, 3, 5]);
  const ranLines = (...runs: [number, number][]) => {
    const ran = new Uint8Array(text.length);
    for (const [start, end] of runs) ran.fill(1, start, end);
    return [...(mappedLines(text, map, "/repo/dist/assets/a.js", "/repo", ran).get("client/a.ts") ?? [])].sort();
  };
  // go() and the glue ran: the glue is no line's.
  assert.deepEqual(ranLines([0, 5], [24, 28]), [1]);
  // Only the first character of more() ran, which is enough, and its offset counts every line before it.
  assert.deepEqual(ranLines([16, 17]), [5]);
});

test("a line with no code counts unless the code on both sides of it never ran", () => {
  // Lines 2, 4 and 6 hold code and only line 2 ran: line 5 sits inside code that never ran.
  const covered = browserCovered(8, new Set([2, 4, 6]), new Set([2]));
  assert.deepEqual([...covered].sort(), [1, 2, 3, 7, 8]);
  // A line the build shook out holds code all the same, and did not run.
  assert.deepEqual([...browserCovered(3, new Set([1, 2, 3]), new Set([1, 3]))].sort(), [1, 3]);
  // A line that ran counts as code even where the whole build placed none.
  assert.deepEqual([...browserCovered(3, new Set([1, 3]), new Set([2]))].sort(), [2]);
  // Above the first line of code there is only the module's top level, which ran.
  assert.deepEqual([...browserCovered(3, new Set([2]), new Set([3]))].sort(), [1, 3]);
});

test("a file none of whose code ran in the browser gets nothing from it", () => {
  assert.equal(browserCovered(4, new Set([2]), new Set()).size, 0);
});

function browserRoot(t: TestContext, chunk: string, source: string): string {
  const root = tempDir(t);
  mkdirSync(join(root, "dist/assets"), { recursive: true });
  mkdirSync(join(root, "client"), { recursive: true });
  mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "client/a.ts"), source);
  writeFileSync(join(root, "dist/assets/a.js"), chunk);
  const map = sourceMap(["../../client/a.ts", "../../node_modules/lib/index.js"], [source, "lib"], [
    [0, 0, 0, 1, 0],
    [0, 5, 0, 2, 0],
    [0, 10, 1, 0, 0],
  ]);
  writeFileSync(join(root, "dist/assets/a.js.map"), JSON.stringify(map));
  return root;
}

test("browser coverage maps what ran in dist/ to the checkout's lines", async (t) => {
  const root = browserRoot(t, "on();no();lib()", "// a note\non();\nno();\n");
  saveRun(join(root, "runs"), "1.json", { "assets/a.js": { length: 15, ran: [0, 5, 10, 15] } });
  const code = async () => new Map([["client/a.ts", new Set([2, 3])]]);
  const covered = await browserCoverage(join(root, "runs"), root, code);
  assert.deepEqual([...covered.keys()], ["client/a.ts"]);
  assert.deepEqual([...covered.get("client/a.ts")!].sort(), [1, 2]);
});

test("browser coverage refuses a dist/ other than the one the browser tests ran", async (t) => {
  const code = async () => new Map<string, Set<number>>();
  const root = browserRoot(t, "on();no();lib()", "// a note\non();\nno();\n");
  const runs = join(root, "runs");
  await assert.rejects(browserCoverage(runs, root, code), /holds no browser coverage/);
  saveRun(runs, "1.json", { "assets/a.js": { length: 16, ran: [] } });
  await assert.rejects(browserCoverage(runs, root, code), /dist\/assets\/a\.js is missing or changed/);
  saveRun(runs, "1.json", { "assets/a.js": { length: 15, ran: [] } });
  writeFileSync(join(root, "client/a.ts"), "// edited since the build\non();\nno();\n");
  await assert.rejects(browserCoverage(runs, root, code), /built from another client\/a\.ts/);
});

test("the browser tests' lines are added to the suites', and only to tracked lines", (t) => {
  forbidExit(t);
  const writeLcov = (lcovFile: string) => {
    writeFileSync(lcovFile, record("client/a.ts", { 1: 1, 2: 0, 3: 0 }));
    return 0;
  };
  const logged: string[] = [];
  const browser = new Map([
    ["client/a.ts", new Set([2, 9])],
    ["client/untracked.ts", new Set([1])],
  ]);
  const status = main({ runSuite: writeLcov, listTracked: () => ["client/a.ts"], readText: () => "x\n", cwd: "/repo", log: (t) => logged.push(t), browser });
  assert.equal(status, 0);
  const [suites, all] = logged;
  assert.match(suites!, /unit plus integration tests:[\s\S]*client\s+33\.3%\s+\(1\/3 lines\)/);
  assert.match(all!, /unit, integration and browser tests:[\s\S]*client\s+66\.7%\s+\(2\/3 lines\)/);
  const files = mergeLcov([record("client/a.ts", { 1: 0 })], "/repo");
  addBrowser(files, new Map([["client/a.ts", new Set([1, 2])]]));
  assert.deepEqual([...files.get("client/a.ts")!], [["client/a.ts:1", true]]);
});
