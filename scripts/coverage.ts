// Statement (line) coverage of the unit and integration suites, from Node's built-in coverage,
// and with --e2e <folder> the browser tests' too, from what e2e/coverage.ts saved there.
// Needs DATABASE_URL (the integration tests use Postgres).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { SourceMap, type SourceMapPayload } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

// Shipped code is what runs in the image or the browser. scripts/ is build tooling and is
// reported on its own so it cannot hide a gap in the shipped figure.
export const SHIPPED = ["server", "shared", "client"];
export const AREAS = [...SHIPPED, "scripts"];

export type Totals = { found: number; hit: number };

// Test infrastructure is found by name first, so a helper added later is left out without
// anyone remembering to list it: any file ending in Testing, Testutil or Testkit (any case,
// with or without a dot before it), and anything under a testing/ folder.
const TEST_SUPPORT_NAME = /(testing|testutil|testkit)\.tsx?$/i;
export const TEST_SUPPORT_DIRS: readonly string[] = [
  "client/components/testing/",
  // The dev-only room, behind import.meta.env.DEV, so the production bundle drops it.
  "client/dev/",
];
// What the name rule cannot see. A stale entry fails scripts/coverage.test.ts.
export const TEST_SUPPORT_FILES: readonly string[] = [
  "server/assets/testApp.ts",
  "server/assets/testImages.ts",
  "shared/rules/testWorld.ts",
  // Imports node:assert, and only tests load it.
  "shared/differential.ts",
  // Behind import.meta.env.DEV, like client/dev/.
  "client/features/vision/devFixture.ts",
];

const TEST_FILE = /\.(test|itest|e2e)\.tsx?$/;
// Declarations only: Node never loads one and it holds no lines that run.
const DECLARATION_FILE = /\.d\.ts$/;
const SOURCE_FILE = /\.tsx?$/;

export function isTestSupport(file: string): boolean {
  return (
    TEST_FILE.test(file) ||
    DECLARATION_FILE.test(file) ||
    TEST_SUPPORT_NAME.test(file) ||
    TEST_SUPPORT_FILES.includes(file) ||
    TEST_SUPPORT_DIRS.some((dir) => file.startsWith(dir))
  );
}

// The files that count: source in an area, minus tests and test infrastructure.
export function isCounted(file: string): boolean {
  return AREAS.includes(file.split("/")[0] ?? "") && SOURCE_FILE.test(file) && !isTestSupport(file);
}

// Node's coverage report only lists files a test loaded, so a shipped file nothing imports
// would add nothing to the total and hide a gap. The tracked source list is the source of truth.
export function listShipped(tracked: string[]): string[] {
  return tracked.filter((file) => SHIPPED.includes(file.split("/")[0] ?? "") && isCounted(file));
}

// Node's lcov counts every physical line of a loaded file, blank and comment lines included.
// An unloaded file is counted the same way, so loaded and unloaded files are measured alike.
const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

export function addUnloaded(
  files: Map<string, Map<string, boolean>>,
  shipped: string[],
  read: (file: string) => string,
): void {
  for (const file of shipped) {
    if (files.has(file)) continue;
    const count = lineCount(read(file));
    const lines = new Map<string, boolean>();
    for (let no = 1; no <= count; no++) lines.set(`${file}:${no}`, false);
    files.set(file, lines);
  }
}

// Node's lcov reporter writes one record per test file, not one per source file. A line counts
// as covered when any record hit it, so the records are merged by file and line first.
export function mergeLcov(lcovs: string[], cwd: string): Map<string, Map<string, boolean>> {
  const files = new Map<string, Map<string, boolean>>();
  for (const lcov of lcovs) {
    let lines: Map<string, boolean> | null = null;
    let file = "";
    for (const row of lcov.split("\n")) {
      if (row.startsWith("SF:")) {
        file = row.slice(3).replace(`${cwd}/`, "");
        lines = files.get(file) ?? new Map();
        files.set(file, lines);
      } else if (lines !== null && row.startsWith("DA:")) {
        const [no, hits] = row.slice(3).split(",");
        const key = `${file}:${no}`;
        lines.set(key, (lines.get(key) ?? false) || Number(hits) > 0);
      }
    }
  }
  return files;
}

export function sumByArea(files: Map<string, Map<string, boolean>>): Map<string, Totals> {
  const byArea = new Map<string, Totals>(AREAS.map((a) => [a, { found: 0, hit: 0 }]));
  for (const [file, lines] of files) {
    if (!isCounted(file)) continue;
    const total = byArea.get(file.split("/")[0] ?? "");
    if (total === undefined) continue;
    for (const covered of lines.values()) {
      total.found += 1;
      if (covered) total.hit += 1;
    }
  }
  return byArea;
}

const pct = (t: Totals) => (t.found === 0 ? "n/a" : `${((100 * t.hit) / t.found).toFixed(1)}%`);

export function formatReport(byArea: Map<string, Totals>, tests = "unit plus integration tests"): string {
  const rows = AREAS.map((a) => {
    const t = byArea.get(a)!;
    return `  ${a.padEnd(8)} ${pct(t).padStart(6)}  (${t.hit}/${t.found} lines)`;
  });
  const shipped: Totals = { found: 0, hit: 0 };
  for (const a of SHIPPED) {
    shipped.found += byArea.get(a)!.found;
    shipped.hit += byArea.get(a)!.hit;
  }
  return [
    `Line coverage, ${tests}:`,
    ...rows,
    `Shipped code (${SHIPPED.join(", ")}): ${pct(shipped)}  (${shipped.hit}/${shipped.found} lines)`,
  ].join("\n");
}

// The browser tests: e2e/coverage.ts saves which characters of each bundle chunk ran in
// Chrome, and the build's own source maps take those back to the lines they came from.

/** One function's ranges, as the DevTools protocol's Profiler.takePreciseCoverage reports them. */
export type V8Function = { ranges: readonly { startOffset: number; endOffset: number; count: number }[] };

/**
 * Marks in `ran` the characters of a script that ran in one coverage take. A function's
 * block ranges sit inside its function range, and an inner function's inside its parent's,
 * and the innermost range holding a character gives its count, so ranges are painted
 * outermost first. Each take counts from zero again, so takes add up and never clear.
 */
export function markRan(ran: Uint8Array, functions: readonly V8Function[]): void {
  const ranges = functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const take = new Uint8Array(ran.length);
  for (const r of ranges) take.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
  for (let i = 0; i < ran.length; i++) ran[i] = ran[i]! | take[i]!;
}

/** The runs of characters that ran, as [start, end, start, end, ...]: the form e2e/coverage.ts saves. */
export function ranIntervals(ran: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < ran.length; i++) {
    if (ran[i] !== 1) continue;
    const start = i;
    while (i < ran.length && ran[i] === 1) i++;
    out.push(start, i);
  }
  return out;
}

/** What one browser test process saved: each chunk under dist/, its length, and the runs of it that ran. */
export type BrowserRun = { scripts: Record<string, { length: number; ran: number[] }> };

/** Every saved run in `dir` together: a character ran when it ran in any page of any run. */
export function readBrowserRuns(dir: string): Map<string, Uint8Array> {
  const chunks = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const run = JSON.parse(readFileSync(join(dir, name), "utf8")) as BrowserRun;
    for (const [chunk, { length, ran }] of Object.entries(run.scripts)) {
      const chars = chunks.get(chunk) ?? new Uint8Array(length);
      if (chars.length !== length) throw new Error(`${name} saw another build of ${chunk} than an earlier run in ${dir}. Run the browser tests again into an empty folder`);
      for (let i = 0; i + 1 < ran.length; i += 2) chars.fill(1, ran[i], ran[i + 1]);
      chunks.set(chunk, chars);
    }
  }
  return chunks;
}

const sourcePath = (source: string, chunkFile: string, root: string) => relative(root, resolve(dirname(chunkFile), source)).split(sep).join("/");

// A token starts at a character that does not carry on a word, so the rest of an identifier,
// keyword or number needs no lookup. A lookup for every character took several times as long.
const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

/**
 * The original lines a chunk's source map places a token on, by file relative to `root`.
 * Given `ran`, only the tokens whose first character ran.
 */
export function mappedLines(text: string, payload: SourceMapPayload, chunkFile: string, root: string, ran?: Uint8Array): Map<string, Set<number>> {
  const map = new SourceMap(payload);
  const files = new Map<string, string>();
  const lines = new Map<string, Set<number>>();
  let offset = 0;
  const rows = text.split("\n");
  for (let line = 0; line < rows.length; line++) {
    const row = rows[line]!;
    for (let col = 0; col < row.length; col++) {
      const c = row.charCodeAt(col);
      if (c === 32 || c === 9 || c === 13) continue;
      if (col > 0 && isWordChar(c) && isWordChar(row.charCodeAt(col - 1))) continue;
      if (ran !== undefined && ran[offset + col] !== 1) continue;
      const entry = map.findEntry(line, col);
      // Before a line's first mapping the lookup answers with an earlier line's, which is not this token's.
      if (!("originalSource" in entry) || typeof entry.originalSource !== "string" || entry.generatedLine !== line) continue;
      let file = files.get(entry.originalSource);
      if (file === undefined) files.set(entry.originalSource, (file = sourcePath(entry.originalSource, chunkFile, root)));
      let set = lines.get(file);
      if (set === undefined) lines.set(file, (set = new Set()));
      set.add(entry.originalLine + 1);
    }
    offset += row.length + 1;
  }
  return lines;
}

function addLines(into: Map<string, Set<number>>, from: Map<string, Set<number>>): void {
  for (const [file, lines] of from) {
    const set = into.get(file);
    if (set === undefined) into.set(file, lines);
    else for (const no of lines) set.add(no);
  }
}

/**
 * The lines of one file the browser tests ran, by Node's rule for a file a test loaded, as near
 * as a bundle allows. A line holding code counts when code from it ran. A line with none, such as
 * a comment, a blank line, a type or an import, counts unless the nearest lines of code above and
 * below it both never ran, as inside a function no test called. `code` must come from a build that
 * keeps every module whole: a line the shipped build shook out still holds code, and counts as
 * not run rather than as a comment.
 */
export function browserCovered(lines: number, code: ReadonlySet<number>, ran: ReadonlySet<number>): Set<number> {
  const covered = new Set<number>();
  if (ran.size === 0) return covered;
  const isCode = (no: number) => code.has(no) || ran.has(no);
  // Above the first line of code and below the last there is only the module's top level, which ran.
  const below: boolean[] = [];
  let next = true;
  for (let no = lines; no >= 1; no--) {
    below[no] = next;
    if (isCode(no)) next = ran.has(no);
  }
  let above = true;
  for (let no = 1; no <= lines; no++) {
    if (isCode(no)) {
      above = ran.has(no);
      if (above) covered.add(no);
    } else if (above || below[no]) covered.add(no);
  }
  return covered;
}

/** Fails when a chunk was built from other text than the checkout holds, since its lines would not match. */
function checkSources(payload: SourceMapPayload, chunkFile: string, root: string): void {
  payload.sources.forEach((source, i) => {
    const file = sourcePath(source, chunkFile, root);
    if (!isCounted(file)) return;
    const now = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null;
    if (payload.sourcesContent[i] !== now) throw new Error(`dist/ was built from another ${file} than the checkout holds. Rebuild with pnpm build, then run the browser tests again`);
  });
}

/**
 * Every line of code in the client, by file: from a build of it that keeps every module whole
 * and unminified, into a temporary folder. dist/ is left as it is.
 */
async function codeLines(root: string): Promise<Map<string, Set<number>>> {
  const out = mkdtempSync(join(tmpdir(), "raccoon-coverage-build-"));
  try {
    const { build } = await import("vite");
    await build({
      configFile: join(root, "vite.config.ts"),
      logLevel: "error",
      publicDir: false,
      build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { treeshake: false } },
    });
    const lines = new Map<string, Set<number>>();
    for (const name of readdirSync(out, { recursive: true, encoding: "utf8" })) {
      const file = join(out, name);
      if (!name.endsWith(".js") || !existsSync(`${file}.map`)) continue;
      addLines(lines, mappedLines(readFileSync(file, "utf8"), JSON.parse(readFileSync(`${file}.map`, "utf8")) as SourceMapPayload, file, root));
    }
    return lines;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The lines the browser tests ran in each shipped file, from the runs saved in `dir` against dist/. */
export async function browserCoverage(dir: string, root: string, code: (root: string) => Promise<Map<string, Set<number>>> = codeLines): Promise<Map<string, Set<number>>> {
  const chunks = readBrowserRuns(dir);
  if (chunks.size === 0) throw new Error(`${dir} holds no browser coverage. Run the browser tests with E2E_COVERAGE_DIR set to it first`);
  const ran = new Map<string, Set<number>>();
  for (const [chunk, chars] of chunks) {
    const file = join(root, "dist", chunk);
    const text = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (text === null || text.length !== chars.length) throw new Error(`dist/${chunk} is missing or changed since the browser tests ran. Rebuild with pnpm build, then run them again`);
    const payload = JSON.parse(readFileSync(`${file}.map`, "utf8")) as SourceMapPayload;
    checkSources(payload, file, root);
    addLines(ran, mappedLines(text, payload, file, root, chars));
  }
  const allCode = await code(root);
  const covered = new Map<string, Set<number>>();
  for (const [file, lines] of ran) {
    if (listShipped([file]).length === 0) continue;
    covered.set(file, browserCovered(lineCount(readFileSync(join(root, file), "utf8")), allCode.get(file) ?? new Set(), lines));
  }
  return covered;
}

/** The browser tests' lines added to the unit and integration ones: a line counts when either ran it. */
export function addBrowser(files: Map<string, Map<string, boolean>>, browser: Map<string, Set<number>>): void {
  for (const [file, covered] of browser) {
    const lines = files.get(file);
    if (lines === undefined) continue;
    for (const no of covered) {
      const key = `${file}:${no}`;
      if (lines.has(key)) lines.set(key, true);
    }
  }
}

export type Deps = {
  runSuite: (lcovFile: string, concurrency: string[], globs: string[]) => number;
  listTracked: () => string[];
  readText: (file: string) => string;
  cwd: string;
  log: (text: string) => void;
  /** The browser tests' lines (browserCoverage), when they are measured too. */
  browser?: Map<string, Set<number>> | null;
};

function runSuite(lcovFile: string, concurrency: string[], globs: string[]): number {
  const args = [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=server/**",
    "--test-coverage-include=shared/**",
    "--test-coverage-include=client/**",
    "--test-coverage-include=scripts/**",
    "--test-coverage-exclude=**/*.test.ts",
    "--test-coverage-exclude=**/*.itest.ts",
    ...concurrency,
    "--test-reporter=dot",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovFile}`,
    ...globs,
  ];
  return spawnSync(process.execPath, args, { stdio: "inherit", env: process.env }).status ?? 1;
}

function listTracked(): string[] {
  const run = spawnSync("git", ["ls-files", "--", ...SHIPPED], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return run.stdout.split("\n").filter((file) => file !== "");
}

const defaults: Deps = {
  runSuite,
  listTracked,
  readText: (file) => readFileSync(file, "utf8"),
  cwd: process.cwd(),
  log: console.log,
};

// Returns the exit status instead of calling process.exit, which would skip the finally and
// leave the temporary directory behind.
export function main(deps: Deps = defaults): number {
  const dir = mkdtempSync(join(tmpdir(), "raccoon-coverage-"));
  try {
    const unit = join(dir, "unit.lcov");
    const int = join(dir, "int.lcov");
    const unitStatus = deps.runSuite(unit, [], ["shared/**/*.test.ts", "server/**/*.test.ts", "client/**/*.test.ts", "scripts/**/*.test.ts"]);
    // The integration tests share one database, so they run one file at a time.
    const intStatus = deps.runSuite(int, ["--test-concurrency=1"], ["server/**/*.itest.ts"]);
    const merged = mergeLcov([readFileSync(unit, "utf8"), readFileSync(int, "utf8")], deps.cwd);
    addUnloaded(merged, listShipped(deps.listTracked()), deps.readText);
    deps.log(formatReport(sumByArea(merged)));
    if (deps.browser) {
      addBrowser(merged, deps.browser);
      deps.log(`\n${formatReport(sumByArea(merged), "unit, integration and browser tests")}`);
    }
    return unitStatus || intStatus;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const e2e = args.length === 2 && args[0] === "--e2e" ? args[1] : undefined;
  if (args.length > 0 && e2e === undefined) {
    console.error("Usage: node scripts/coverage.ts [--e2e <the folder E2E_COVERAGE_DIR named>]");
    process.exitCode = 2;
  } else if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL to a Postgres database the integration tests may use.");
    process.exitCode = 2;
  } else {
    let browser: Map<string, Set<number>> | null = null;
    try {
      // First, so a stale dist/ fails at once rather than after the suites.
      if (e2e !== undefined) browser = await browserCoverage(resolve(e2e), process.cwd());
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 2;
    }
    if (process.exitCode === undefined) process.exitCode = main({ ...defaults, browser });
  }
}
