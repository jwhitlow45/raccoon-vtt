import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearJoinCounts } from "./e2e-join-counts.ts";
import { anyRerun, attempt, filePassed, NO_TIME, outcome, passedOnRerun, plan, runLimit, secondsFor, summaryCount, type Durations, type Result, type Run } from "./e2e-shard-plan.ts";

/**
 * One shard of the e2e run, for continuous integration, for a laptop that
 * runs several shards side by side, and as one shard for `pnpm test:e2e`
 * (README, "Continuous integration"):
 *
 *   node scripts/e2e-shard.ts <index> <count>                run shard <index> of <count>, counted from 1
 *   node scripts/e2e-shard.ts <index> <count> --list         print every shard's files and run nothing
 *   node scripts/e2e-shard.ts <index> <count> --macos-only   shard only the files of e2e/macos-only.json
 *   node scripts/e2e-shard.ts <index> <count> --deadline <unix seconds>   report by then, as a CI job's limit needs
 *
 * It needs dist/ from `pnpm build`, and reads what the e2e files read:
 * E2E_PORT, DATABASE_URL and E2E_SCREENSHOT_DIR. Each run's output is also
 * kept in test-results/e2e-logs.
 *
 * The files are placed by the time each took in e2e/durations.json
 * (scripts/e2e-shard-plan.ts). A file missing from the list counts as its
 * defaultSeconds until its time is recorded.
 *
 * A shard runs its files one after another, since they share the port
 * range and the database. A file that fails runs once more, and the shard
 * fails only when that run fails too. Both results are reported, so a file
 * that passed only on its rerun still shows as flaky.
 *
 * With a deadline, each run's limit leaves time for its rerun and for the
 * files after it, and a run the time left cannot hold is not started. So a
 * file that hangs every time still leaves the shard time to report and the
 * job time to keep its logs.
 *
 * The files in e2e/macos-only.json are left out anywhere but macOS, since
 * they are known to fail elsewhere from font metrics alone. CI runs them
 * in a macOS job of their own with --macos-only.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "Usage: node scripts/e2e-shard.ts <index> <count> [--list] [--macos-only] [--deadline <unix seconds>]   (index counted from 1)";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const LOG_DIR = path.join(ROOT, "test-results/e2e-logs");
const ACTIONS = process.env.GITHUB_ACTIONS === "true";

/** e2e/macos-only.json: each file's name, and why it runs only on macOS. */
type MacosOnly = { rule: string; files: Record<string, string> };

let current: ChildProcess | null = null;
let stopping: NodeJS.Signals | null = null;

/**
 * Each run gets a process group of its own, so a timeout or a Ctrl+C stops
 * the server and the browser it started along with it. The group no longer
 * hears the terminal's Ctrl+C, hence the forwarding here.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * A stop ends the run in progress and starts no other, and the shard still
 * reports what ran. A cancelled CI job sends SIGINT, then SIGTERM a few
 * seconds later, so a second signal kills the run outright rather than
 * wait on it, and with no run to wait on it exits.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const again = stopping !== null;
    stopping ??= signal;
    if (current) signalGroup(current, again ? "SIGKILL" : signal);
    else if (again) process.exit(stopping === "SIGINT" ? 130 : 143);
  });
}

async function runFile(file: string, label: string, limit: number): Promise<Omit<Run, "countsCleared">> {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = createWriteStream(path.join(LOG_DIR, `${label}.log`));
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL };
  if (SHOT_DIR !== "0") env.E2E_SCREENSHOT_DIR = path.resolve(SHOT_DIR, label);
  console.log(ACTIONS ? `::group::${label}` : `\n=== ${label}`);
  const started = Date.now();
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", `e2e/${file}.e2e.ts`], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  current = child;
  // A stop that came while the join counts were cleared reaches this run too.
  if (stopping) signalGroup(child, stopping);
  // The test runner's totals come last, so only the end of the output is kept for them.
  let tail = "";
  const forward = (sink: NodeJS.WriteStream) => (chunk: Buffer) => {
    log.write(chunk);
    sink.write(chunk);
    tail = (tail + chunk.toString("utf8")).slice(-16_384);
  };
  child.stdout?.on("data", forward(process.stdout));
  child.stderr?.on("data", forward(process.stderr));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`${label} is still running after ${limit} s, stopping it`);
    signalGroup(child, "SIGTERM");
    setTimeout(() => signalGroup(child, "SIGKILL"), 10_000).unref();
  }, limit * 1000);
  const code = await new Promise<number | null>((resolve) => child.once("close", (c) => resolve(c)));
  clearTimeout(timer);
  // Whatever the run left behind in its group goes too, so the next file finds its port free.
  signalGroup(child, "SIGKILL");
  current = null;
  await new Promise<void>((resolve) => log.end(resolve));
  if (ACTIONS) console.log("::endgroup::");
  return {
    ok: code === 0 && !timedOut,
    seconds: Math.round((Date.now() - started) / 1000),
    tests: summaryCount(tail, "tests"),
    passed: summaryCount(tail, "pass"),
    todo: summaryCount(tail, "todo"),
    timedOut,
  };
}

/** One attempt at a file, the join counts' cleanup and the run, within `limit` seconds (scripts/e2e-shard-plan.ts, attempt). */
function attemptFile(file: string, label: string, limit: number): Promise<Run | typeof NO_TIME> {
  return attempt(limit, {
    now: () => Date.now() / 1000,
    clear: (seconds) => clearJoinCounts(DATABASE_URL, seconds),
    run: (seconds) => runFile(file, label, seconds),
    note: (line) => console.log(ACTIONS ? `::warning title=Join counts not cleared::${label}: ${line}` : `${label}: ${line}`),
  });
}

function report(index: number, count: number, results: Result[]): void {
  const width = Math.max(0, ...results.map((r) => r.file.length));
  console.log(`\nshard ${index} of ${count}`);
  for (const r of results) {
    const rerun = r.rerun === null ? "" : r.rerun === NO_TIME ? ", and no rerun, too little of the job's time left" : `, then its rerun ${outcome(r.rerun)}`;
    console.log(`  ${r.file.padEnd(width)}  ${outcome(r.first)}${rerun}`);
    if (ACTIONS && passedOnRerun(r)) console.log(`::warning title=Flaky e2e file::${r.file} failed, then passed on its rerun. Its logs and screenshots are in this shard's artifact.`);
    if (ACTIONS && !filePassed(r)) console.log(`::error title=Failed e2e file::${r.file} ${r.rerun !== null && r.rerun !== NO_TIME ? "failed twice" : "failed"}. Its logs and screenshots are in this shard's artifact.`);
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const rows = results.map((r) => `| ${r.file} | ${outcome(r.first)} | ${r.rerun === null ? "" : outcome(r.rerun)} |`);
    appendFileSync(summaryFile, [`### e2e shard ${index} of ${count}`, "", "| File | Run | Rerun |", "| --- | --- | --- |", ...rows, ""].join("\n") + "\n");
  }
  // The workflow keeps the logs and screenshots of a shard that failed, and of one that passed only through a rerun.
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendFileSync(outputFile, `reran=${anyRerun(results)}\n`);
}

type Args = { index: number; count: number; list: boolean; macosOnly: boolean; deadline: number | null };

/** The arguments, or null when they make no sense. */
function parseArgs(argv: readonly string[]): Args | null {
  const rest = [...argv];
  let deadline: number | null = null;
  const at = rest.indexOf("--deadline");
  if (at !== -1) {
    deadline = Number(rest[at + 1]);
    if (!Number.isFinite(deadline)) return null;
    rest.splice(at, 2);
  }
  const list = rest.includes("--list");
  const macosOnly = rest.includes("--macos-only");
  const [indexText, countText, ...extra] = rest.filter((a) => a !== "--list" && a !== "--macos-only");
  const index = Number(indexText);
  const count = Number(countText);
  if (extra.length > 0 || !Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) return null;
  return { index, count, list, macosOnly, deadline };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  const { index, count, list, macosOnly, deadline } = args;

  const durations = JSON.parse(readFileSync(path.join(ROOT, "e2e/durations.json"), "utf8")) as Durations;
  const every = readdirSync(path.join(ROOT, "e2e"))
    .filter((f) => f.endsWith(".e2e.ts"))
    .map((f) => f.slice(0, -".e2e.ts".length));
  const onMac = (JSON.parse(readFileSync(path.join(ROOT, "e2e/macos-only.json"), "utf8")) as MacosOnly).files;
  const stale = Object.keys(onMac).filter((f) => !every.includes(f));
  if (stale.length > 0) {
    console.error(`e2e/macos-only.json names ${stale.join(", ")}, which ${stale.length === 1 ? "is not an e2e file" : "are not e2e files"}`);
    return 2;
  }
  const isMacosOnly = (f: string) => Object.hasOwn(onMac, f);
  let files = every;
  if (macosOnly) files = every.filter(isMacosOnly);
  else if (process.platform !== "darwin") {
    files = every.filter((f) => !isMacosOnly(f));
    for (const f of every.filter(isMacosOnly)) console.log(`${f} runs only on macOS (e2e/macos-only.json): ${onMac[f]}`);
  }
  const shards = plan(files, durations, count);
  const cost = (f: string) => secondsFor(durations, f);

  if (list) {
    shards.forEach((s, i) => {
      console.log(`${i + 1 === index ? "*" : " "} shard ${i + 1} of ${count}: about ${s.seconds} s`);
      for (const f of s.files) console.log(`    ${f} ${cost(f)} s${Object.hasOwn(durations.seconds, f) ? "" : " (not recorded yet)"}`);
    });
    return 0;
  }

  const mine = shards[index - 1]!;
  console.log(`shard ${index} of ${count}: ${mine.files.join(", ") || "no files"} (about ${mine.seconds} s)`);
  if (mine.files.length === 0) return 0;
  if (!existsSync(path.join(ROOT, "dist/index.html"))) {
    console.error("dist/ is missing: run `pnpm build` first");
    return 1;
  }

  const left = () => (deadline === null ? Infinity : deadline - Date.now() / 1000);
  const results: Result[] = [];
  try {
    for (const [i, file] of mine.files.entries()) {
      if (stopping) break;
      const rest = mine.files.slice(i + 1).reduce((sum, f) => sum + cost(f), 0);
      const firstLimit = runLimit(cost(file), left(), rest, true);
      const first = firstLimit === null ? NO_TIME : await attemptFile(file, file, firstLimit);
      let rerun: Result["rerun"] = null;
      if (first !== NO_TIME && !first.ok && !stopping) {
        const limit = runLimit(cost(file), left(), rest, false);
        rerun = limit === null ? NO_TIME : await attemptFile(file, `${file}-rerun`, limit);
      }
      results.push({ file, first, rerun });
    }
  } finally {
    // Also after an error, such as a database that cannot be reached, so the job's summary says how far the shard got.
    report(index, count, results);
  }
  if (stopping) return stopping === "SIGINT" ? 130 : 143;
  return results.every(filePassed) ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(err);
}
// The report is out, so the shard ends here, once its output is written.
// Nothing left behind, such as a stray timer or a socket a database never
// closed, may hold the CI step open.
for (const out of [process.stdout, process.stderr]) await new Promise<void>((resolve) => out.write("", () => resolve()));
process.exit(code);
