import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { changedFiles, isDoc, scopeOf, type Changes } from "./ci-scope.ts";

describe("a doc", () => {
  test("is Markdown, a picture or a drawing's source under docs/, or Markdown at the root", () => {
    for (const f of ["docs/design.md", "docs/dm-guide.md", "docs/dm-guide/areas-phone.webp", "docs/a.png", "docs/a.jpg", "docs/a.svg", "docs/diagrams/a.excalidraw", "README.md", "FEATURES.md", "CREDITS.md"])
      assert.ok(isDoc(f), f);
  });

  test("is never code, a picture outside docs/, or Markdown the app may import", () => {
    for (const f of ["client/App.tsx", "server/main.ts", ".github/workflows/ci.yml", "e2e/guide.e2e.ts", "scripts/ci-scope.ts", "package.json", "public/icon.svg", "shared/srd/NOTICE.md", "client/notes.md", "server/x.md", "docs.md.ts", "README.mdx", "docsx/a.md.ts", "Docs/a.ts"])
      assert.ok(!isDoc(f), f);
  });

  test("is never Markdown in a folder that ships or tests, nor docs/ code or data", () => {
    for (const f of ["public/x.md", "scripts/x.md", "db/x.md", "e2e/x.md", "e2e/fixtures/README.md", ".github/notes.md", "docs/x.ts", "docs/x.json", "docs/dm-guide/x.tsx", "docs/x.md.ts"])
      assert.ok(!isDoc(f), f);
  });
});

describe("a run's scope", () => {
  const onTip = (files: readonly string[]) => ({ files, onMainTip: true });
  const push = (changed: Changes | null) => scopeOf("push", "refs/heads/ci/x", changed);

  test("a branch's push on main's tip that changes only docs is docs-only", () => {
    assert.equal(push(onTip(["docs/dm-guide.md", "docs/dm-guide/areas.webp", "FEATURES.md"])).docsOnly, true);
  });

  test("one file that is not a doc checks everything", () => {
    const s = push(onTip(["docs/dm-guide.md", "client/App.tsx"]));
    assert.equal(s.docsOnly, false);
    assert.match(s.why, /client\/App\.tsx/);
  });

  test("a branch behind main checks everything, and says so, though it changes only docs", () => {
    const s = push({ files: ["docs/dm-guide.md"], onMainTip: false });
    assert.equal(s.docsOnly, false);
    assert.match(s.why, /behind main/);
  });

  test("a branch behind main that changes code names the code, the first reason to check everything", () => {
    assert.match(push({ files: ["client/App.tsx"], onMainTip: false }).why, /client\/App\.tsx/);
  });

  test("a push to main, a run by hand, nothing changed or git failing check everything", () => {
    assert.equal(scopeOf("push", "refs/heads/main", onTip(["docs/design.md"])).docsOnly, false);
    assert.equal(scopeOf("workflow_dispatch", "refs/heads/ci/x", onTip(["docs/design.md"])).docsOnly, false);
    assert.equal(push(onTip([])).docsOnly, false);
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

  test("on main's tip, are the branch's own, and a docs change there is docs-only", () => {
    const r = start();
    r.write("docs/dm-guide.md", "guide, longer\n");
    r.commit("docs");
    assert.deepEqual(changedFiles(r.dir), { files: ["docs/dm-guide.md"], onMainTip: true });
    assert.equal(scopeOf("push", "refs/heads/ci/x", changedFiles(r.dir)).docsOnly, true);
  });

  test("behind main, are the branch's own since its merge base, not main's later ones, and check everything", () => {
    const r = start();
    r.write("docs/dm-guide.md", "guide, longer\n");
    r.commit("docs");
    // main moves on with code the branch does not hold.
    r.git("checkout", "-q", "main");
    r.write("client/App.tsx", "app 2\n");
    r.commit("code on main");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD");
    r.git("checkout", "-q", "ci/x");
    assert.deepEqual(changedFiles(r.dir), { files: ["docs/dm-guide.md"], onMainTip: false });
    const s = scopeOf("push", "refs/heads/ci/x", changedFiles(r.dir));
    assert.equal(s.docsOnly, false);
    assert.match(s.why, /behind main/);
  });

  test("name both sides of a move, so code moved under docs/ is not a doc", () => {
    const r = start();
    r.git("mv", "client/App.tsx", "docs/App.tsx");
    r.commit("move");
    assert.deepEqual(changedFiles(r.dir)?.files.toSorted(), ["client/App.tsx", "docs/App.tsx"]);
    assert.equal(scopeOf("push", "refs/heads/ci/x", changedFiles(r.dir)).docsOnly, false);
  });

  test("hold a code change made and undone along the way not at all, and a doc kept with code that stays", () => {
    const r = start();
    r.write("client/App.tsx", "changed\n");
    r.commit("code");
    r.write("client/App.tsx", "app\n");
    r.write("README.md", "readme\n");
    r.commit("code back, and a readme");
    assert.deepEqual(changedFiles(r.dir)?.files, ["README.md"]);
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
