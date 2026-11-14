import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES, SUPERVISOR_ENTRY } from "../contract.ts";

/**
 * Stages the app server for electron-builder, which copies it into the
 * app's resources as `app-server/` (docs/design/design-v1-local-app.md,
 * 11.2):
 *
 *   node desktop/scripts/stage.ts [--out <dir>]
 *
 * It needs `pnpm build` first, and prints the folder it made. The folder is
 * `$RUNNER_TEMP/raccoonvtt-stage/app-server`, or the same under the system's
 * temp folder off CI, unless `--out` names another, and it must be outside
 * the repository: pnpm installs there as in a folder of its own, with no
 * lockfile, workspace or node_modules above it to adopt it.
 *
 * It holds what the image's runtime stage holds (Dockerfile): package.json,
 * the lockfile and pnpm-workspace.yaml (whose overrides a frozen install
 * needs), server/, shared/, scripts/, db/ and dist/, plus the supervisor
 * (desktop/runtime/ and desktop/contract.ts). Tests, source maps and what
 * .dockerignore keeps out of the image stay out. Then `pnpm install --prod`
 * there with the hoisted linker: a plain node_modules tree, with no
 * symlinks or Windows junctions to absolute paths on the build machine,
 * which electron-builder copies as it is. A symlink left anywhere stops it.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** What is copied, from the repository's root. */
export const STAGED = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "server", "shared", "scripts", "db", "dist", "desktop/runtime", "desktop/contract.ts"] as const;

/** Written into the folder it makes, so a later run only ever empties a folder this script made. */
export const MARKER = ".raccoonvtt-stage";

/** Files pnpm writes beside node_modules that name the build machine's paths, as the Dockerfile's prod-deps stage removes them. */
const INSTALL_STATE = ["node_modules/.modules.yaml", "node_modules/.pnpm-workspace-state-v1.json"];

/** The default folder: on CI under the job's temp folder, which the runner empties. */
export function defaultOut(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.RUNNER_TEMP || tmpdir(), "raccoonvtt-stage", RESOURCES.appServer);
}

/**
 * Whether a file, by its path from the repository's root with forward
 * slashes, stays out: tests, source maps of the bundle, and the files
 * .dockerignore keeps out of any image (secrets, logs, editor litter).
 */
export function leftOut(rel: string): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  if (name.endsWith(".test.ts") || name.endsWith(".itest.ts")) return true;
  if (rel.startsWith("dist/") && name.endsWith(".map")) return true;
  if (name === "node_modules" || name === ".DS_Store" || name.endsWith(".log")) return true;
  if (name === ".env" || name.startsWith(".env.") || name === ".envrc" || name.endsWith(".pem") || name.endsWith(".key")) return true;
  return false;
}

/** Why `out` cannot hold the stage, or null when it can. */
export function outProblem(root: string, out: string, exists: (p: string) => boolean = existsSync): string | null {
  const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  if (inside(root, out) || inside(out, root)) return `${out} is inside the repository or holds it. Stage outside it, so pnpm installs there as in a folder of its own.`;
  for (let dir = path.dirname(out); ; dir = path.dirname(dir)) {
    for (const name of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "package.json", "node_modules"]) {
      if (exists(path.join(dir, name))) return `${path.join(dir, name)} is above ${out}, and pnpm or Node would read it. Stage somewhere with none above it.`;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** Every symlink under `dir`, by its path from `dir`. */
export function symlinksIn(dir: string): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) found.push(child);
      else if (entry.isDirectory()) walk(child);
    }
  };
  walk("");
  return found;
}

/** Every `node_modules/.bin` folder under `dir`, at any depth, by its path from `dir`. */
export function binFolders(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isDirectory() && e.name === ".bin" && path.basename(e.parentPath) === "node_modules")
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
}

/** Copies one entry of STAGED, file or folder, leaving out what `leftOut` names. Counts the files copied. */
export function copyStaged(root: string, out: string, rel: string): number {
  const from = path.join(root, rel);
  const info = lstatSync(from);
  // A symlink would copy as a link to the build machine's tree.
  if (info.isSymbolicLink()) throw new Error(`${rel} is a symlink. Stage only regular files and folders.`);
  if (leftOut(rel)) return 0;
  if (info.isDirectory()) {
    mkdirSync(path.join(out, rel), { recursive: true });
    let count = 0;
    for (const name of readdirSync(from).toSorted()) count += copyStaged(root, out, `${rel}/${name}`);
    return count;
  }
  if (!info.isFile()) throw new Error(`${rel} is neither a file nor a folder.`);
  mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  copyFileSync(from, path.join(out, rel));
  return 1;
}

/** Empties `out` for a new stage, refusing a folder with files that this script did not make. */
function emptyOut(out: string): void {
  if (existsSync(out)) {
    const held = readdirSync(out);
    if (held.length > 0 && !held.includes(MARKER)) throw new Error(`${out} holds files this script did not make. Empty it or pick another --out.`);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, MARKER), "Made by desktop/scripts/stage.ts. The next run empties this folder.\n");
}

function bytesIn(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

function parseOut(argv: readonly string[]): string {
  const at = argv.indexOf("--out");
  if (at === -1) return defaultOut();
  const value = argv[at + 1];
  if (!value) throw new Error("Usage: node desktop/scripts/stage.ts [--out <dir>]");
  return path.resolve(value);
}

export function stage(out: string): void {
  const problem = outProblem(ROOT, out);
  if (problem) throw new Error(problem);
  if (!existsSync(path.join(ROOT, "dist/index.html"))) throw new Error("dist/ holds no build. Run pnpm build first.");
  if (!existsSync(path.join(ROOT, SUPERVISOR_ENTRY))) throw new Error(`${SUPERVISOR_ENTRY} is missing.`);
  emptyOut(out);
  let files = 0;
  for (const rel of STAGED) files += copyStaged(ROOT, out, rel);
  console.log(`Copied ${files} files to ${out}.`);

  // Fixed arguments only. Windows runs pnpm through its .cmd shim, which
  // Node starts only through a shell.
  const install = spawnSync("pnpm", ["install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"], {
    cwd: out,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.status !== 0) throw new Error(`pnpm install in ${out} failed (${install.error?.message ?? `exit ${install.status}`}).`);
  for (const rel of INSTALL_STATE) rmSync(path.join(out, rel), { force: true });
  // Package command links, which nothing runs in the app. On macOS and
  // Linux they are symlinks.
  for (const bin of binFolders(out)) rmSync(path.join(out, bin), { recursive: true, force: true });

  const links = symlinksIn(out);
  if (links.length > 0) throw new Error(`The staged tree holds symlinks, which electron-builder would copy as links to this machine: ${links.slice(0, 10).join(", ")}${links.length > 10 ? ` and ${links.length - 10} more` : ""}.`);
  console.log(`Staged the app server in ${out}: ${(bytesIn(out) / 1024 / 1024).toFixed(1)} MB.`);
}

if (import.meta.main) {
  try {
    stage(parseOut(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
