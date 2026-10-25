import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { changedFiles, isDoc, scopeOf } from "./ci-scope.ts";

describe("a doc", () => {
  test("is anything under docs/, the guide's pictures among them, or a Markdown file outside the code's folders", () => {
    for (const f of ["docs/design.md", "docs/dm-guide.md", "docs/dm-guide/areas-phone.webp", "README.md", "FEATURES.md", "CREDITS.md", "e2e/fixtures/README.md", ".github/notes.md"]) assert.ok(isDoc(f), f);
  });

  test("is never code, a picture outside docs/, or Markdown the app may import", () => {
    for (const f of ["client/App.tsx", "server/main.ts", ".github/workflows/ci.yml", "e2e/guide.e2e.ts", "scripts/ci-scope.ts", "package.json", "public/icon.svg", "shared/srd/NOTICE.md", "client/notes.md", "server/x.md", "docs.md.ts", "README.mdx", "docsx/a.md.ts", "Docs/a.ts"])
      assert.ok(!isDoc(f), f);
  });
});

describe("a run's scope", () => {
  const push = (changed: readonly string[] | null) => scopeOf("push", "refs/heads/ci/x", changed);

  test("a branch's push that changes only docs is docs-only", () => {
    assert.equal(push(["docs/dm-guide.md", "docs/dm-guide/areas.webp", "FEATURES.md"]).docsOnly, true);
  });

  test("one file that is not a doc checks everything", () => {
    const s = push(["docs/dm-guide.md", "client/App.tsx"]);
    assert.equal(s.docsOnly, false);
    assert.match(s.why, /client\/App\.tsx/);
  });

  test("a push to main, a run by hand, nothing changed or git failing check everything", () => {
    assert.equal(scopeOf("push", "refs/heads/main", ["docs/design.md"]).docsOnly, false);
    assert.equal(scopeOf("workflow_dispatch", "refs/heads/ci/x", ["docs/design.md"]).docsOnly, false);
    assert.equal(push([]).docsOnly, false);
    assert.equal(push(null).docsOnly, false);
  });
});

/** A repository of its own, with git's user settings shut out so a signing or hook setting cannot change it. */
function repo(): { dir: string; git(...args: string[]): string; write(file: string, text: string): void; commit(message: string): void } {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoon-ci-scope-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  return {
    dir,
    git,
    write(file, text) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "--no-gpg-sign", "-m", message);
    },
  };
}

describe("the files a push changes, from git", () => {
  const made: string[] = [];
  after(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  /** main with a file of each kind, as origin/main, and a branch from it. */
  function start() {
    const r = repo();
    made.push(r.dir);
    r.write("client/App.tsx", "app\n");
    r.write("docs/dm-guide.md", "guide\n");
    r.commit("main");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.git("checkout", "-q", "-b", "ci/x");
    return r;
  }

  test("are the branch's own since its merge base, not main's later ones", () => {
    const r = start();
    r.write("docs/dm-guide.md", "guide, longer\n");
    r.commit("docs");
    // main moves on with code the branch does not hold.
    r.git("checkout", "-q", "main");
    r.write("client/App.tsx", "app 2\n");
    r.commit("code on main");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.git("checkout", "-q", "ci/x");
    assert.deepEqual(changedFiles(r.dir), ["docs/dm-guide.md"]);
    assert.equal(scopeOf("push", "refs/heads/ci/x", changedFiles(r.dir)).docsOnly, true);
  });

  test("name both sides of a move, so code moved under docs/ is not a doc", () => {
    const r = start();
    r.git("mv", "client/App.tsx", "docs/App.tsx");
    r.commit("move");
    assert.deepEqual(changedFiles(r.dir)?.sort(), ["client/App.tsx", "docs/App.tsx"]);
    assert.equal(scopeOf("push", "refs/heads/ci/x", changedFiles(r.dir)).docsOnly, false);
  });

  test("hold a code change made and undone along the way not at all, and a doc kept with code that stays", () => {
    const r = start();
    r.write("client/App.tsx", "changed\n");
    r.commit("code");
    r.write("client/App.tsx", "app\n");
    r.write("README.md", "readme\n");
    r.commit("code back, and a readme");
    assert.deepEqual(changedFiles(r.dir), ["README.md"]);
  });

  test("are null where there is no origin/main, so everything is checked", () => {
    const r = repo();
    made.push(r.dir);
    r.write("docs/a.md", "a\n");
    r.commit("only");
    assert.equal(changedFiles(r.dir), null);
    assert.equal(scopeOf("push", "refs/heads/ci/x", changedFiles(r.dir)).docsOnly, false);
  });
});
