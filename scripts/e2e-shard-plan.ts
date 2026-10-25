/**
 * The decisions of scripts/e2e-shard.ts, apart from its processes and
 * files, so unit tests can reach them: which shard runs which file, how
 * long each attempt at a file may take, what the test runner's totals say
 * and whether a file passed.
 */

export type Durations = { defaultSeconds: number; seconds: Record<string, number> };
export type Shard = { files: string[]; seconds: number };
/**
 * A run of a file. `countsCleared` is false when the join counts' cleanup
 * before it timed out, and `leftOut` counts the tests a rerun left out
 * (rerunSkips).
 */
export type Run = { ok: boolean; seconds: number; tests: number | null; passed: number | null; todo: number | null; leftOut: number; timedOut: boolean; countsCleared: boolean };
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
 * The recorded times are the largest of a few CI runs, and a run can still
 * be slower. The time left is shared out as if each file takes 1.5 times its
 * record.
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

/** The longest the join counts' cleanup before a run may take, in seconds. */
export const CLEANUP_SECONDS = 10;

/** What `work` gave, or `done: false` once `ms` pass first. A rejection passes through. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What an attempt does, given from outside so a test can stand in for the database, the run and the clock. */
export type AttemptSteps = {
  /** The time, in seconds. */
  now(): number;
  /** Clears the join counts within `seconds`, and says whether it finished. */
  clear(seconds: number): Promise<boolean>;
  /** Runs the file, stopping it after `seconds`. */
  run(seconds: number): Promise<Omit<Run, "countsCleared">>;
  /** A line for the shard's log. */
  note(line: string): void;
};

/**
 * One attempt at a file, its cleanup included, by an absolute deadline
 * `limit` seconds from now. The cleanup gets CLEANUP_SECONDS at most, and
 * the run gets what is left of the deadline once the cleanup is over, so a
 * stalled cleanup cannot push the attempt past its share of the shard. A
 * cleanup that times out is noted, and the file runs anyway if a second is
 * left, since a stale count only risks the join limits.
 */
export async function attempt(limit: number, steps: AttemptSteps): Promise<Run | typeof NO_TIME> {
  const deadline = steps.now() + limit;
  const cleanup = Math.min(CLEANUP_SECONDS, limit);
  const cleared = await steps.clear(cleanup);
  if (!cleared) steps.note(`The join counts could not be cleared within ${cleanup} s, so the run starts without that and may meet the join limits`);
  const left = Math.floor(deadline - steps.now());
  if (left < 1) return NO_TIME;
  return { ...(await steps.run(left)), countsCleared: cleared };
}

/** One of the totals the spec reporter ends with, read past any color codes a FORCE_COLOR adds. */
export function summaryCount(text: string, label: string): number | null {
  const m = new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(text.replace(/\x1b\[[0-9;]*m/g, ""));
  return m ? Number(m[1]) : null;
}

/** A run's line in the shard's report, such as "passed (11 tests, 1 todo) in 86 s" or a rerun's "passed (8 tests, 3 left out) in 40 s". */
export function outcome(run: Run | typeof NO_TIME): string {
  if (run === NO_TIME) return "not run, too little of the job's time left";
  const parts: string[] = [];
  // A failed hook cancels its tests rather than failing them, so the count that means something is the passes.
  if (run.tests !== null) parts.push(run.ok ? `${run.tests} tests` : `${run.passed ?? "?"} of ${run.tests} tests passed`);
  if (run.tests !== null && run.todo) parts.push(`${run.todo} todo`);
  // scripts/e2e-durations.ts reads this, since such a run's time is not the whole file's.
  if (run.leftOut) parts.push(`${run.leftOut} left out`);
  const counts = parts.length === 0 ? "" : ` (${parts.join(", ")})`;
  const how = run.timedOut ? "timed out" : run.ok ? "passed" : "failed";
  const stale = run.countsCleared ? "" : ", join counts not cleared";
  return `${how}${counts} in ${run.seconds} s${stale}`;
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

/** A test's result as scripts/e2e-results.ts writes it: its full name, null where its suites were not seen, and whether it passed. */
export type TestResult = { full: string | null; ok: boolean };

/**
 * The tests a file's rerun leaves out, by full name: those that passed
 * after the last test that failed. A file's tests share one room and build
 * on what the tests before them left, and which earlier test sets up a
 * later one is written nowhere, so every test up to the last failure runs
 * again. Only the passes after it are known to need nothing more.
 *
 * Nothing is left out, so the whole file runs again, unless the results
 * are whole: one for each of the run's `tests`, each with its full name.
 * A run that timed out or crashed is missing results. A failed before hook
 * cancels the tests after it, which count as failed, and a failed after
 * hook fails no test, so either way nothing is left out. A name shared
 * with a test that must run again is never left out, since the pattern
 * would leave out both.
 */
export function rerunSkips(results: readonly TestResult[], tests: number | null): string[] {
  if (tests === null || results.length !== tests || results.some((r) => r.full === null)) return [];
  const last = results.findLastIndex((r) => !r.ok);
  if (last < 0) return [];
  const again = new Set(results.slice(0, last + 1).map((r) => r.full));
  return [...new Set(results.slice(last + 1).flatMap((r) => (r.full !== null && !again.has(r.full) ? [r.full] : [])))];
}

/** A --test-skip-pattern that matches this full name whole, and no other test's name or full name. */
export function skipPattern(full: string): string {
  return `^${full.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}$`;
}
