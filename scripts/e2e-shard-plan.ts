/**
 * The decisions of scripts/e2e-shard.ts, apart from its processes and
 * files, so unit tests can reach them: which shard runs which file, how
 * long each run may take, what the test runner's totals say and whether a
 * file passed.
 */

export type Durations = { defaultSeconds: number; seconds: Record<string, number> };
export type Shard = { files: string[]; seconds: number };
export type Run = { ok: boolean; seconds: number; tests: number | null; passed: number | null; todo: number | null; timedOut: boolean };
/** A run the shard's time left could not hold, so it never started. */
export const NO_TIME = "no time";
/** A file's first run and its rerun. The rerun is null when none was called for. */
export type Result = { file: string; first: Run | typeof NO_TIME; rerun: Run | typeof NO_TIME | null };

/** A file's recorded time, or the default for a file not recorded yet. */
export function secondsFor(durations: Durations, file: string): number {
  return Object.hasOwn(durations.seconds, file) ? durations.seconds[file]! : durations.defaultSeconds;
}

/**
 * Every shard works this out from the same files and the same times, so
 * the shards never need to talk to each other. The longest file goes
 * first, each onto the shard with the least time so far. Ties go by name,
 * so the order the files are listed in changes nothing.
 */
export function plan(files: readonly string[], durations: Durations, count: number): Shard[] {
  const shards: Shard[] = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  const cost = (f: string) => secondsFor(durations, f);
  const longestFirst = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  for (const file of longestFirst) {
    const lightest = shards.reduce((best, s) => (s.seconds < best.seconds ? s : best));
    lightest.files.push(file);
    lightest.seconds += cost(file);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

/**
 * The recorded times are a laptop's, and CI's runners take up to about 1.3
 * times as long on some files. The time left is shared out as if each file
 * takes 1.5 times its record.
 */
export const SLOW = 1.5;

/**
 * With no deadline, a run may take 25 minutes, the laptop's limit for one
 * file, or three times the file's recorded time when that is longer. That
 * stops a hung run, such as a browser that stops answering.
 */
export function generousLimit(seconds: number): number {
  return Math.max(1500, 3 * seconds);
}

/**
 * How many seconds one run of a file may take, or null when the time left
 * cannot hold a run of the file at SLOW. `left` is the shard's time left
 * (Infinity with no deadline) and `rest` the recorded seconds of the files
 * after this one, whose time stays reserved for them. A first run gets
 * half the room when a rerun at SLOW would fit in the other half, so a run
 * that hangs still leaves its rerun the time to report. Otherwise it gets
 * the whole room, and no rerun will fit after it.
 */
export function runLimit(seconds: number, left: number, rest: number, rerunMayFollow: boolean): number | null {
  const generous = generousLimit(seconds);
  if (left === Infinity) return generous;
  const room = left - SLOW * rest;
  const needs = SLOW * seconds;
  if (room < needs) return null;
  const share = rerunMayFollow && room / 2 >= needs ? room / 2 : room;
  return Math.min(generous, Math.floor(share));
}

/** One of the totals the spec reporter ends with, read past any color codes a FORCE_COLOR adds. */
export function summaryCount(text: string, label: string): number | null {
  const m = new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(text.replace(/\x1b\[[0-9;]*m/g, ""));
  return m ? Number(m[1]) : null;
}

/** A run's line in the shard's report, such as "passed (11 tests, 1 todo) in 86 s". */
export function outcome(run: Run | typeof NO_TIME): string {
  if (run === NO_TIME) return "not run, too little of the job's time left";
  // A failed hook cancels its tests rather than failing them, so the count that means something is the passes.
  const todo = run.todo ? `, ${run.todo} todo` : "";
  const counts = run.tests === null ? "" : run.ok ? ` (${run.tests} tests${todo})` : ` (${run.passed ?? "?"} of ${run.tests} tests passed${todo})`;
  const how = run.timedOut ? "timed out" : run.ok ? "passed" : "failed";
  return `${how}${counts} in ${run.seconds} s`;
}

/** A file passes when its first run passes, or its rerun does. */
export function filePassed(r: Result): boolean {
  const ok = (run: Run | typeof NO_TIME | null) => run !== null && run !== NO_TIME && run.ok;
  return ok(r.first) || ok(r.rerun);
}

/** A file that failed and then passed on its rerun: a flaky file, or a flaky app. */
export function passedOnRerun(r: Result): boolean {
  return filePassed(r) && r.first !== NO_TIME && !r.first.ok;
}

/** Whether any rerun started, so the workflow keeps the shard's logs even when every file passed in the end. */
export function anyRerun(results: readonly Result[]): boolean {
  return results.some((r) => r.rerun !== null && r.rerun !== NO_TIME);
}
