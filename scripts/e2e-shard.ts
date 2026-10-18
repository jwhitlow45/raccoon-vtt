import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { anyRerun, filePassed, outcome, passedOnRerun, plan, secondsFor, summaryCount, type Durations, type Result, type Run } from "./e2e-shard-plan.ts";

/**
 * One shard of the e2e run, for continuous integration and for a laptop
 * that runs several shards side by side (README, "Continuous integration"):
 *
 *   node scripts/e2e-shard.ts <index> <count>                run shard <index> of <count>, counted from 1
 *   node scripts/e2e-shard.ts <index> <count> --list         print every shard's files and run nothing
 *   node scripts/e2e-shard.ts <index> <count> --macos-only   shard only the files of e2e/macos-only.json
 *
 * It needs dist/ from `pnpm build`, and reads what the e2e files read:
 * E2E_PORT, DATABASE_URL and E2E_SCREENSHOT_DIR. Each run's output is also
 * kept in test-results/e2e-logs.
 *
 * The files are placed by the time each took in e2e/durations.json
 * (scripts/e2e-shard-plan.ts). A file missing from the list counts as its
 * defaultSeconds until its time is recorded.
 *
 * A shard runs its files one after another, as `pnpm test:e2e` does,
 * since they share the port range and the database. A file that fails runs
 * once more, and the shard fails only when that run fails too. Both results
 * are reported, so a file that passed only on its rerun still shows as flaky.
 *
 * The files in e2e/macos-only.json are left out anywhere but macOS, since
 * they are known to fail elsewhere from font metrics alone. CI runs them
 * in a macOS job of their own with --macos-only.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "Usage: node scripts/e2e-shard.ts <index> <count> [--list] [--macos-only]   (index counted from 1)";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
const LOG_DIR = path.join(ROOT, "test-results/e2e-logs");
const ACTIONS = process.env.GITHUB_ACTIONS === "true";

/** e2e/macos-only.json: each file's name, and why it runs only on macOS. */
type MacosOnly = { rule: string; files: Record<string, string> };

/**
 * The server counts successful joins and room creations per address in
 * Postgres (server/auth/ratelimit.ts), and every e2e file joins from
 * 127.0.0.1. One file stays under the hourly limits, but a shard's files
 * together can pass them, so the counts are cleared before each run, as the
 * full check on a laptop does. A fresh database has no table until the
 * first server applies the schema, and then there is nothing to clear.
 */
async function clearJoinCounts(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    await client.query("delete from rate_events where key like 'ok:%' or key like 'create:%'");
  } catch (err) {
    if ((err as { code?: unknown }).code !== "42P01") throw new Error(`Could not clear the join counts in DATABASE_URL's database: ${(err as Error).message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * A hung run, such as a browser that stops answering, would otherwise hold
 * the shard until the job's own limit. 25 minutes is the laptop's limit for
 * one file, and a slower machine gets three times the file's recorded time
 * when that is longer.
 */
function limitSeconds(seconds: number): number {
  return Math.max(1500, 3 * seconds);
}

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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = signal;
    if (current) signalGroup(current, signal);
    else process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

async function runFile(file: string, label: string, seconds: number): Promise<Run> {
  await clearJoinCounts();
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
    console.error(`${label} is still running after ${limitSeconds(seconds)} s, stopping it`);
    signalGroup(child, "SIGTERM");
    setTimeout(() => signalGroup(child, "SIGKILL"), 10_000).unref();
  }, limitSeconds(seconds) * 1000);
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

function report(index: number, count: number, results: Result[]): void {
  const width = Math.max(...results.map((r) => r.file.length));
  console.log(`\nshard ${index} of ${count}`);
  for (const r of results) {
    const rerun = r.rerun ? `, then its rerun ${outcome(r.rerun)}` : "";
    console.log(`  ${r.file.padEnd(width)}  ${outcome(r.first)}${rerun}`);
    if (ACTIONS && passedOnRerun(r)) console.log(`::warning title=Flaky e2e file::${r.file} failed, then passed on its rerun. Its logs and screenshots are in this shard's artifact.`);
    if (ACTIONS && !filePassed(r)) console.log(`::error title=Failed e2e file::${r.file} ${r.rerun ? "failed twice" : "failed"}. Its logs and screenshots are in this shard's artifact.`);
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const rows = results.map((r) => `| ${r.file} | ${outcome(r.first)} | ${r.rerun ? outcome(r.rerun) : ""} |`);
    appendFileSync(summaryFile, [`### e2e shard ${index} of ${count}`, "", "| File | Run | Rerun |", "| --- | --- | --- |", ...rows, ""].join("\n") + "\n");
  }
  // The workflow keeps the logs and screenshots of a shard that failed, and of one that passed only through a rerun.
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendFileSync(outputFile, `reran=${anyRerun(results)}\n`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const macosOnly = args.includes("--macos-only");
  const [indexText, countText, ...extra] = args.filter((a) => a !== "--list" && a !== "--macos-only");
  const index = Number(indexText);
  const count = Number(countText);
  if (extra.length > 0 || !Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) {
    console.error(USAGE);
    return 2;
  }

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

  const results: Result[] = [];
  for (const file of mine.files) {
    const first = await runFile(file, file, cost(file));
    const rerun = first.ok || stopping ? null : await runFile(file, `${file}-rerun`, cost(file));
    results.push({ file, first, rerun });
    if (stopping) break;
  }
  report(index, count, results);
  if (stopping) return stopping === "SIGINT" ? 130 : 143;
  return results.every(filePassed) ? 0 : 1;
}

process.exitCode = await main();
