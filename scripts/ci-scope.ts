import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * What a CI run must check, from what its push changes (.github/workflows/ci.yml):
 *
 *   node scripts/ci-scope.ts
 *
 * A push to a branch other than main that changes only docs, against its
 * merge base with main, is docs-only when that merge base is main's tip.
 * Its run checks the typecheck, the unit tests, the build and
 * e2e/guide.e2e.ts, which draws the DM guide from docs/, and still ends
 * green, so the deploy gate takes it. Its code is then main's tip, which
 * reached main through a full run. An older commit of main may never have
 * had a full run of its own, as within a push of several. Every other run
 * checks everything, and so does any case this cannot read: a run started
 * by hand, a push to main, a branch behind main, a branch with nothing of
 * its own against main, or a git command that fails.
 *
 * It reads GITHUB_EVENT_NAME and GITHUB_REF, and needs origin/main and
 * the history back to the merge base, as a checkout with fetch-depth 0
 * gives. It writes `docs-only` and `shards`, the e2e matrix, to
 * GITHUB_OUTPUT, and says why in the log.
 */

/** The e2e shards of a full run (.github/workflows/ci.yml, the e2e job). */
export const SHARDS = 14;

/**
 * Whether a changed path is a doc: a Markdown file, a picture or a drawing's
 * source under docs/, which holds the design notes, the DM guide and its
 * pictures, or a Markdown file at the repository's root. Anything else may
 * reach the app or its image, as public/ ships in the bundle, scripts/ and
 * db/ go in the image, and shared/srd/NOTICE.md shows in the About panel.
 */
export function isDoc(file: string): boolean {
  return /^docs\/.+\.(md|webp|png|jpg|svg|excalidraw)$/.test(file) || /^[^/]+\.md$/.test(file);
}

export type Scope = { docsOnly: boolean; why: string };

/** What a push changes against its merge base with main, and whether that merge base is main's tip. */
export type Changes = { files: readonly string[]; onMainTip: boolean };

/** The scope of a run, from its event, its ref, and what it changes against main, or null where git could not say. */
export function scopeOf(event: string, ref: string, changed: Changes | null): Scope {
  if (event !== "push") return { docsOnly: false, why: `a ${event} run checks everything` };
  if (ref === "refs/heads/main") return { docsOnly: false, why: "a push to main checks everything" };
  if (changed === null) return { docsOnly: false, why: "git could not list what the push changes against main, so everything is checked" };
  const { files } = changed;
  if (files.length === 0) return { docsOnly: false, why: "the push changes nothing against main, so everything is checked" };
  const code = files.filter((f) => !isDoc(f));
  if (code.length > 0) return { docsOnly: false, why: `the push changes ${code.length} ${code.length === 1 ? "file" : "files"} that are not docs, such as ${code[0]}` };
  if (!changed.onMainTip) return { docsOnly: false, why: "the push changes only docs, but the branch is behind main, so everything is checked" };
  return { docsOnly: true, why: `the push changes only docs, ${files.length} ${files.length === 1 ? "file" : "files"} against main's tip` };
}

/**
 * The files HEAD changes against its merge base with origin/main, each
 * path on both sides of a rename, and whether that merge base is
 * origin/main itself. Null when git fails.
 */
export function changedFiles(cwd: string): Changes | null {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const base = git("merge-base", "origin/main", "HEAD").trim();
    const files = git("diff", "--name-only", "--no-renames", "-z", base, "HEAD").split("\0").filter(Boolean);
    return { files, onMainTip: base === git("rev-parse", "origin/main").trim() };
  } catch {
    return null;
  }
}

function main(): void {
  const scope = scopeOf(process.env.GITHUB_EVENT_NAME ?? "", process.env.GITHUB_REF ?? "", changedFiles(process.cwd()));
  const shards = scope.docsOnly ? [1] : Array.from({ length: SHARDS }, (_, i) => i + 1);
  console.log(`${scope.docsOnly ? "docs only" : "everything"}: ${scope.why}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `docs-only=${scope.docsOnly}\nshards=${JSON.stringify(shards)}\n`);
}

if (import.meta.main) main();
