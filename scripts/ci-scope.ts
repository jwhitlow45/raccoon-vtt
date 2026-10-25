import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * What a CI run must check, from what its push changes (.github/workflows/ci.yml):
 *
 *   node scripts/ci-scope.ts
 *
 * A push to a branch other than main that changes only docs, against its
 * merge base with main, is docs-only. Its run checks the typecheck, the
 * unit tests, the build and e2e/guide.e2e.ts, which draws the DM guide
 * from docs/, and still ends green, so the deploy gate takes it. Every
 * other run checks everything, and so does any case this cannot read: a
 * run started by hand, a push to main, a branch with nothing of its own
 * against main, or a git command that fails.
 *
 * It reads GITHUB_EVENT_NAME and GITHUB_REF, and needs origin/main and
 * the history back to the merge base, as a checkout with fetch-depth 0
 * gives. It writes `docs-only` and `shards`, the e2e matrix, to
 * GITHUB_OUTPUT, and says why in the log.
 */

/** The e2e shards of a full run (.github/workflows/ci.yml, the e2e job). */
export const SHARDS = 14;

/**
 * Whether a changed path is a doc: anything under docs/, which holds the
 * design notes, the DM guide and its pictures, and a Markdown file outside
 * the code's folders. A Markdown file under client/, server/ or shared/
 * may be part of the app, as shared/srd/NOTICE.md is in the About panel.
 */
export function isDoc(file: string): boolean {
  if (file.startsWith("docs/")) return true;
  return file.endsWith(".md") && !/^(client|server|shared)\//.test(file);
}

export type Scope = { docsOnly: boolean; why: string };

/** The scope of a run, from its event, its ref, and the files it changes against its merge base with main, or null where git could not say. */
export function scopeOf(event: string, ref: string, changed: readonly string[] | null): Scope {
  if (event !== "push") return { docsOnly: false, why: `a ${event} run checks everything` };
  if (ref === "refs/heads/main") return { docsOnly: false, why: "a push to main checks everything" };
  if (changed === null) return { docsOnly: false, why: "git could not list what the push changes against main, so everything is checked" };
  if (changed.length === 0) return { docsOnly: false, why: "the push changes nothing against main, so everything is checked" };
  const code = changed.filter((f) => !isDoc(f));
  if (code.length > 0) return { docsOnly: false, why: `the push changes ${code.length} ${code.length === 1 ? "file" : "files"} that are not docs, such as ${code[0]}` };
  return { docsOnly: true, why: `the push changes only docs, ${changed.length} ${changed.length === 1 ? "file" : "files"} against main` };
}

/**
 * The files HEAD changes against its merge base with origin/main, each
 * path on both sides of a rename, or null when git fails.
 */
export function changedFiles(cwd: string): string[] | null {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const base = git("merge-base", "origin/main", "HEAD").trim();
    return git("diff", "--name-only", "--no-renames", "-z", base, "HEAD").split("\0").filter(Boolean);
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
