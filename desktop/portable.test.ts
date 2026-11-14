import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two ways desktop/ code once worked on macOS and Linux and broke on
 * Windows (design 11.1), which CI's Linux jobs never see:
 * - A file URL's `.pathname` is `/C:/...` there, which no Windows API reads
 *   as a path. `fileURLToPath` gives `C:\...`.
 * - pnpm, npm and npx are .cmd shims there, which Node starts only through
 *   a shell, so a call that names one needs `shell` for Windows.
 */
const DESKTOP = fileURLToPath(new URL(".", import.meta.url));
const SKIPPED_DIRS = new Set(["node_modules", "out", ".runtime"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
/** This file quotes both patterns as test data. */
const SELF = "portable.test.ts";

const URL_PATHNAME = /import\.meta\.url\s*\)\s*\.pathname/g;
const SHIM_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*["'](?:pnpm|npm|npx|yarn|corepack)["']/g;

/** The whole call from its opening parenthesis, by counting parentheses. */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/** What in `source` breaks on Windows, one line per finding. */
export function windowsProblems(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(URL_PATHNAME)) found.push(`a file URL's .pathname at ${m.index}`);
  for (const m of source.matchAll(SHIM_CALL)) {
    const call = callText(source, m.index + m[0].indexOf("("));
    if (!/\bshell\s*:/.test(call)) found.push(`a package manager started without a shell at ${m.index}`);
  }
  return found;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

test("the scan finds a file URL's pathname and a package manager started without a shell", () => {
  assert.equal(windowsProblems(`const DESKTOP = new URL("..", import.meta.url).pathname;`).length, 1);
  assert.equal(windowsProblems(`outDir: new URL("../out/window", import.meta.url) .pathname,`).length, 1);
  assert.equal(windowsProblems(`execFileSync("pnpm", ["exec", "vite"], { cwd: ROOT, stdio: "pipe" });`).length, 1);
  assert.equal(windowsProblems(`spawn('npx', ["tsc"])`).length, 1);
  assert.deepEqual(windowsProblems(`const DESKTOP = fileURLToPath(new URL("..", import.meta.url));`), []);
  assert.deepEqual(windowsProblems(`basename(new URL(pin.url).pathname)`), []);
  assert.deepEqual(windowsProblems(`spawnSync("pnpm", ["install"], { cwd: out, shell: process.platform === "win32" });`), []);
  assert.deepEqual(windowsProblems(`execFileSync(process.execPath, [vite, "build"]);`), []);
});

test("nothing under desktop/ reads a file URL's pathname or starts a package manager without a shell", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(DESKTOP)) {
    const rel = relative(DESKTOP, file).split(sep).join("/");
    if (rel === SELF) continue;
    for (const problem of windowsProblems(readFileSync(file, "utf8"))) offenders.push(`desktop/${rel}: ${problem}`);
  }
  assert.deepEqual(offenders, []);
});
