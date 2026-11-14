import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs the desktop e2e files, desktop/e2e/*.e2e.ts, one after another
 * (docs/design/design-v1-local-app.md, 11.1):
 *
 *   node desktop/e2e/run.ts              every file
 *   node desktop/e2e/run.ts shell        only the named ones, without .e2e.ts
 *
 * Each file needs what it says at its top, such as the built app. On Linux
 * run this under `xvfb-run -a`, since Electron needs a display, as
 * desktop.yml's checks job does.
 *
 * Each file runs under `node --test` in a process group of its own, so a
 * file that hangs is stopped with the app and browsers it started, after
 * DESKTOP_E2E_TIMEOUT_MS (15 minutes unless set). A failed file does not
 * stop the ones after it, and the run fails when any failed, or when there
 * was no file to run, so a check that ran nothing never passes.
 */

const DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(DIR, "../..");
const SUFFIX = ".e2e.ts";

export type Outcome = { name: string; status: "passed" | "failed" | "timed out"; seconds: number };

/** The files to run: every desktop e2e file, or those named, by name without the suffix. */
export function pick(files: readonly string[], names: readonly string[]): { run: string[]; unknown: string[] } {
  const every = files.filter((f) => f.endsWith(SUFFIX)).map((f) => f.slice(0, -SUFFIX.length)).toSorted();
  if (names.length === 0) return { run: every, unknown: [] };
  return { run: every.filter((n) => names.includes(n)), unknown: names.filter((n) => !every.includes(n)) };
}

/** The run's exit code: 0 only when at least one file ran and every one passed. */
export function exitCode(outcomes: readonly Outcome[]): number {
  return outcomes.length > 0 && outcomes.every((o) => o.status === "passed") ? 0 : 1;
}

let current: ChildProcess | null = null;

/** Stops a file's whole process group: the test, and the app and browsers it started. */
function stopGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // Windows has no process groups to signal. taskkill ends the tree.
    spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group already ended.
  }
}

function runFile(name: string, timeoutMs: number): Promise<Outcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", path.join(DIR, `${name}${SUFFIX}`)], {
      cwd: ROOT,
      stdio: "inherit",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    current = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`${name}${SUFFIX} ran past ${Math.round(timeoutMs / 1000)} s. Stopping it.`);
      stopGroup(child, "SIGTERM");
      setTimeout(() => stopGroup(child, "SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      current = null;
      const seconds = Math.round((Date.now() - started) / 1000);
      resolve({ name, seconds, status: timedOut ? "timed out" : code === 0 ? "passed" : "failed" });
    });
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const { run, unknown } = pick(readdirSync(DIR), argv);
  if (unknown.length > 0) {
    console.error(`No desktop e2e file is named ${unknown.join(", ")}. The files are desktop/e2e/*${SUFFIX}.`);
    return 1;
  }
  const timeoutMs = Number(process.env.DESKTOP_E2E_TIMEOUT_MS ?? 15 * 60_000);
  const outcomes: Outcome[] = [];
  for (const name of run) {
    console.log(`\n${name}${SUFFIX}`);
    outcomes.push(await runFile(name, timeoutMs));
  }
  console.log("");
  if (outcomes.length === 0) console.error(`desktop/e2e holds no *${SUFFIX} file, so nothing ran.`);
  for (const o of outcomes) console.log(`${o.name}${SUFFIX}: ${o.status} in ${o.seconds} s`);
  return exitCode(outcomes);
}

if (import.meta.main) {
  // A Ctrl+C or a cancelled job stops the file in progress with everything it started.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (current) stopGroup(current, "SIGKILL");
      process.exit(130);
    });
  }
  process.exitCode = await main(process.argv.slice(2));
}
