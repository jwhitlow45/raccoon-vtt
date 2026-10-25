import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Durations } from "./e2e-shard-plan.ts";

/**
 * Rewrites e2e/durations.json from the times CI runs printed, so the shard
 * plan (scripts/e2e-shard-plan.ts) balances on what the files take now:
 *
 *   node scripts/e2e-durations.ts <run id> [<run id> ...]           rewrite e2e/durations.json
 *   node scripts/e2e-durations.ts <run id> [<run id> ...] --print   print the new list and write nothing
 *
 * It reads each run's e2e shard logs through `gh`, which finds the
 * repository from the directory it runs in, or from GH_REPO (owner/name)
 * where there is no git checkout. Each shard's log ends with a line per
 * file, such as "barrest  passed (29 tests) in 906 s", which
 * scripts/e2e-shard.ts prints.
 *
 * A file's time is that of a whole run that passed, the first or its
 * rerun, and the largest over the runs given, as the list has always
 * held. A rerun that left tests out is not a whole run. A file no run
 * passed keeps its old time, and a file that no longer exists is dropped.
 * Give a few green runs of one commit or of commits close together.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIST = path.join(ROOT, "e2e/durations.json");
const USAGE = "Usage: node scripts/e2e-durations.ts <run id> [<run id> ...] [--print]";

/** A run as the shard's report line gives it. `partial` is a rerun that left tests out, whose time is not the file's. */
export type ReportedRun = { how: "passed" | "failed" | "timed out" | "not run"; seconds: number | null; partial: boolean };
export type Reported = { file: string; first: ReportedRun; rerun: ReportedRun | null };

const RUN = /^(passed|failed|timed out)(?: \(([^)]*)\))? in (\d+) s/;

function readRun(text: string): ReportedRun {
  const m = RUN.exec(text);
  if (!m) return { how: "not run", seconds: null, partial: false };
  return { how: m[1] as ReportedRun["how"], seconds: Number(m[3]), partial: /\bleft out\b/.test(m[2] ?? "") };
}

/**
 * The file lines of every shard report in a job's log: each line after
 * "shard <i> of <n>", up to the first line that is neither a file's nor
 * the warning or error the shard adds under a file's line. The log's
 * timestamps and any color codes are dropped first.
 */
export function readReport(log: string): Reported[] {
  const out: Reported[] = [];
  let inReport = false;
  for (const raw of log.split("\n")) {
    const line = raw
      .replace(/\r$/, "")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, "");
    if (/^shard \d+ of \d+$/.test(line)) {
      inReport = true;
      continue;
    }
    if (!inReport) continue;
    // A workflow command as the shard prints it (::warning), or as the job's log shows it (##[warning]).
    if (/^(::|##\[)(warning|error)/.test(line)) continue;
    const m = /^ {2}(\S+) {2,}(\S.*)$/.exec(line);
    if (!m) {
      inReport = false;
      continue;
    }
    const [first, rerun] = m[2]!.split(", then its rerun ");
    out.push({ file: m[1]!, first: readRun(first!), rerun: rerun === undefined ? null : readRun(rerun) });
  }
  return out;
}

/** The seconds of the whole run that passed, or null when neither did, or only a rerun that left tests out. */
export function passedSeconds(r: Reported): number | null {
  if (r.first.how === "passed") return r.first.seconds;
  if (r.rerun?.how === "passed" && !r.rerun.partial) return r.rerun.seconds;
  return null;
}

/**
 * The new list: for each e2e file, the largest time a run passed in, or
 * its old time when none did. Files that no longer exist leave the list,
 * and a file never recorded stays out of it, so it counts as the default.
 */
export function rewrite(old: Durations, reports: readonly Reported[], files: readonly string[]): Durations {
  const best = new Map<string, number>();
  for (const r of reports) {
    const s = passedSeconds(r);
    if (s !== null) best.set(r.file, Math.max(s, best.get(r.file) ?? 0));
  }
  const seconds: Record<string, number> = {};
  for (const f of [...files].sort()) {
    const s = best.get(f) ?? (Object.hasOwn(old.seconds, f) ? old.seconds[f] : undefined);
    if (s !== undefined) seconds[f] = s;
  }
  return { defaultSeconds: old.defaultSeconds, seconds };
}

function gh(args: string[]): string {
  return execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The reports of a run's Linux e2e shards and its macOS job. */
function runReports(runId: string): Reported[] {
  const { jobs } = JSON.parse(gh(["run", "view", runId, "--json", "jobs"])) as { jobs: { databaseId: number; name: string; conclusion: string }[] };
  const shards = jobs.filter((j) => /^e2e(?: \(\d+\)|-macos)$/.test(j.name) && j.conclusion !== "skipped");
  if (shards.length === 0) throw new Error(`run ${runId} has no e2e jobs`);
  return shards.flatMap((j) => readReport(gh(["api", `repos/{owner}/{repo}/actions/jobs/${j.databaseId}/logs`])));
}

function main(argv: readonly string[]): number {
  const print = argv.includes("--print");
  const runs = argv.filter((a) => a !== "--print");
  if (runs.length === 0 || runs.some((r) => !/^\d+$/.test(r))) {
    console.error(USAGE);
    return 2;
  }
  const old = JSON.parse(readFileSync(LIST, "utf8")) as Durations;
  const files = readdirSync(path.join(ROOT, "e2e"))
    .filter((f) => f.endsWith(".e2e.ts"))
    .map((f) => f.slice(0, -".e2e.ts".length));
  const reports = runs.flatMap(runReports);
  const next = rewrite(old, reports, files);
  for (const f of files.filter((f) => !reports.some((r) => r.file === f && passedSeconds(r) !== null))) {
    console.error(`${f}: no run passed it, so it keeps ${Object.hasOwn(old.seconds, f) ? `${old.seconds[f]} s` : "the default"}`);
  }
  const text = JSON.stringify(next, null, 2) + "\n";
  if (print) process.stdout.write(text);
  else writeFileSync(LIST, text);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
