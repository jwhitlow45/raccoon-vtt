import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D-261113-087: only desktop/electron/ imports Electron's packages, so the
 * root `pnpm test` and `typecheck`, which ci.yml runs without installing
 * desktop/'s packages, never need them. desktop/build/ runs inside
 * electron-builder (afterPack.mjs flips the fuses with @electron/fuses, as
 * design 6.6 says) and desktop/e2e/ drives a packaged build, and both run
 * only where desktop/'s packages are installed.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWED = ["desktop/electron/", "desktop/build/", "desktop/e2e/"];
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".jj", ".claude", "dist", "out", ".runtime", "test-results", ".data"]);
/** This file quotes imports as test data. */
const SELF = "desktop/shell/imports.test.ts";
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

/** `import ... from "x"`, `export ... from "x"`, `import("x")`, `require("x")` and `import "x"`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function electronSpecifier(specifier: string): boolean {
  return (
    specifier === "electron" ||
    specifier.startsWith("electron/") ||
    specifier === "electron-updater" ||
    specifier.startsWith("electron-updater/") ||
    specifier.startsWith("@electron/")
  );
}

function electronImports(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((m) => m[1]!).filter(electronSpecifier);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

test("the scan sees each way of importing a module", () => {
  assert.deepEqual(electronImports(`import { app } from "electron";`), ["electron"]);
  assert.deepEqual(electronImports(`import type { BrowserWindow } from 'electron'`), ["electron"]);
  assert.deepEqual(electronImports(`export { x } from "electron-updater";`), ["electron-updater"]);
  assert.deepEqual(electronImports(`const { flipFuses } = await import("@electron/fuses");`), ["@electron/fuses"]);
  assert.deepEqual(electronImports(`const e = require( "electron/main" );`), ["electron/main"]);
  assert.deepEqual(electronImports(`import "electron";`), ["electron"]);
  assert.deepEqual(electronImports(`import { x } from "./electron.ts"; import y from "electron-is-dev-not-ours";`), []);
});

test("only desktop/electron/, desktop/build/ and desktop/e2e/ import electron, electron-updater or @electron/*", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (rel === SELF || ALLOWED.some((prefix) => rel.startsWith(prefix))) continue;
    const found = electronImports(readFileSync(file, "utf8"));
    if (found.length > 0) offenders.push(`${rel}: ${found.join(", ")}`);
  }
  assert.deepEqual(offenders, []);
});
