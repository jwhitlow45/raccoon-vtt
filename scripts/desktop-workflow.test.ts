import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

/*
 * .github/workflows/desktop.yml, which builds the desktop app, tests it on
 * each system, and on a release signs its installers and attaches them
 * (docs/design/design-v1-local-app.md, section 11). Its steps run as GitHub
 * runs them, with stand-ins for gh: a release run is bound to its tag, a
 * dry run never signs or uploads, macOS runs only on release and dry runs,
 * no step that runs pnpm holds a token, every file is taken from the job
 * that made it, and a release is only ever added to.
 */

const read = (file: string) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
const workflow = read("desktop.yml");

/** The jobs, in order: the keys under `jobs:`. */
const jobs = [...workflow.split("\njobs:\n")[1]!.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]!);

/** A job's YAML block, so a check cannot match another job. */
function jobBlock(name: string, text = workflow): string {
  const block = text.split(`\n  ${name}:\n`)[1];
  assert.ok(block, `no job named ${name}`);
  return block.split(/\n {2}[\w-]+:\n/)[0]!;
}

/** A step's script within `text`: the lines of its `run: |` block, or its one-line `run:`, as GitHub hands them to bash. */
function stepScript(step: string, text = workflow): string {
  const lines = text.split("\n");
  const name = lines.findIndex((l) => l.trim() === `- name: ${step}`);
  assert.ok(name >= 0, `no step named "${step}"`);
  const run = lines.findIndex((l, i) => i > name && /^ +run: /.test(l));
  const first = lines[run]!.trim();
  if (first !== "run: |") return first.slice("run: ".length);
  const indent = lines[run + 1]!.length - lines[run + 1]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n").trimEnd();
}

/** A job's steps, each as its block of YAML, in order. */
function steps(job: string): string[] {
  const block = jobBlock(job);
  const at = block.indexOf("\n    steps:\n");
  assert.ok(at >= 0, `${job} has no steps`);
  return block.slice(at + "\n    steps:\n".length).split(/\n(?= {6}- )/);
}

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoon-desktop-workflow-"));
  made.push(dir);
  return dir;
}

/** A step run as GitHub's default bash runs it, with `tools` as stand-in commands ahead on PATH. */
function runStep(script: string, env: Record<string, string>, tools: Record<string, string> = {}, cwd?: string) {
  const dir = scratch();
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}`);
    chmodSync(path.join(dir, name), 0o755);
  }
  writeFileSync(path.join(dir, "output"), "");
  writeFileSync(path.join(dir, "calls"), "");
  const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    cwd: cwd ?? dir,
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "example/raccoon-vtt", GITHUB_OUTPUT: path.join(dir, "output"), CALLS: path.join(dir, "calls"), RUNNER_TEMP: dir, ...env },
  });
  const lines = (file: string) => readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean);
  const output = Object.fromEntries(lines("output").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { status: run.status, out: run.stdout + run.stderr, output, calls: lines("calls"), dir };
}

/** The workflow commands a run printed: lines starting "::". */
const commands = (out: string) => out.split("\n").filter((l) => l.startsWith("::"));

/** Design 11.5's assets for version 1.2.3, in the plan's order. */
const FILES = [
  "raccoon-vtt-1.2.3-windows-x64-setup.exe",
  "latest.yml",
  "raccoon-vtt-1.2.3-macos-arm64.dmg",
  "raccoon-vtt-1.2.3-macos-x64.dmg",
  "raccoon-vtt-1.2.3-linux-x86_64.AppImage",
  "raccoon-vtt_1.2.3_amd64.deb",
  "latest-linux.yml",
  "raccoon-vtt-1.2.3-linux-arm64.AppImage",
  "raccoon-vtt_1.2.3_arm64.deb",
  "latest-linux-arm64.yml",
  "raccoon-vtt-1.2.3-desktop.sha256",
];
const ASSETS = [...FILES, ...FILES.map((f) => `${f}.sigstore.json`), "raccoon-vtt-1.2.3-desktop.intoto.jsonl"];

type Target = { target: string; runner: string; files: string };
type Check = { runner: string; "report-only": boolean };

function plan(mode: string) {
  const r = runStep(stepScript("The targets and the assets"), { MODE: mode, VERSION: "1.2.3" });
  assert.equal(r.status, 0, r.out);
  return { targets: JSON.parse(r.output.targets!) as Target[], checks: JSON.parse(r.output.checks!) as Check[], assets: r.output.assets!.split(" ") };
}

describe("the kind of run", () => {
  const mode = (env: { TAG?: string; DRY_REF?: string; EVENT?: string }) =>
    runStep(stepScript("The kind of run"), { TAG: "", DRY_REF: "", EVENT: "workflow_dispatch", SHA: "abcdef0123456789abcdef0123456789abcdef01", ...env });

  test("a tag makes a release run of that tag and nothing else, called by image.yml or by hand", () => {
    for (const EVENT of ["push", "workflow_dispatch"]) {
      const r = mode({ TAG: "v1.2.3", EVENT });
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(r.output, { mode: "release", checkout: "refs/tags/v1.2.3" });
    }
  });

  test("a ref with no tag makes a dry run of that ref", () => {
    for (const ref of ["ci/local-app", "refs/heads/ci/local-app", "abcdef0123456789abcdef0123456789abcdef01", "main"]) {
      const r = mode({ DRY_REF: ref });
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(r.output, { mode: "dry", checkout: ref });
    }
  });

  test("a push to a ci/ branch makes a branch run of the pushed commit", () => {
    const r = mode({ EVENT: "push" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.output, { mode: "branch", checkout: "abcdef0123456789abcdef0123456789abcdef01" });
  });

  test("a run by hand needs exactly one of a tag and a ref", () => {
    const none = mode({});
    assert.equal(none.status, 1, none.out);
    assert.deepEqual(commands(none.out), ["::error::A run by hand needs a tag, for a release run, or a ref, for a dry run."]);
    const both = mode({ TAG: "v1.2.3", DRY_REF: "ci/x" });
    assert.equal(both.status, 1, both.out);
    assert.deepEqual(both.output, {});
  });

  for (const tag of ["1.2.3", "v1.2", "v1.2.3-rc.1", "v1.2.3 ", "main", "v1.2.3\n::warning::injected", "../v1.2.3", "v01.2.3x"]) {
    test(`refuses the tag ${JSON.stringify(tag)} on one escaped error line`, () => {
      const r = mode({ TAG: tag });
      assert.equal(r.status, 1, r.out);
      assert.deepEqual(r.output, {});
      assert.equal(commands(r.out).length, 1, r.out);
      assert.match(commands(r.out)[0]!, /^::error::The tag is '.*', not vX\.Y\.Z\.$/);
    });
  }

  for (const ref of ["-x", "ci/../main", "ci/a b", "ci/x\n::warning::injected", "ci/x;rm", "$(id)", "ci/x`id`"]) {
    test(`refuses the ref ${JSON.stringify(ref)}`, () => {
      const r = mode({ DRY_REF: ref });
      assert.equal(r.status, 1, r.out);
      assert.deepEqual(r.output, {});
      assert.equal(commands(r.out).length, 1, r.out);
    });
  }
});

describe("the commit and its version", () => {
  const source = (version: string, env: Record<string, string>) => {
    const dir = scratch();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
    return runStep(stepScript("The commit and its version"), env, { git: 'echo abcdef0123456789abcdef0123456789abcdef01' }, dir);
  };

  test("a release run refuses a tag whose package.json says another version", () => {
    assert.equal(source("1.2.3", { MODE: "release", TAG: "v1.2.3" }).status, 0);
    const r = source("1.2.4", { MODE: "release", TAG: "v1.2.3" });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(commands(r.out), ["::error::package.json at v1.2.3 says the version is 1.2.4."]);
  });

  test("names the version and the commit every later job checks out", () => {
    const r = source("1.2.3", { MODE: "dry", TAG: "" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.output, { version: "1.2.3", commit: "abcdef0123456789abcdef0123456789abcdef01" });
    assert.equal(source("1.2.3-rc.1\n::warning::x", { MODE: "dry", TAG: "" }).status, 1);
  });

  test("every job that builds or tests checks out the plan's ref and refuses any other commit", () => {
    for (const job of ["checks", "build"]) {
      const list = steps(job);
      const checkout = list.findIndex((s) => s.includes("actions/checkout@"));
      assert.match(list[checkout]!, /\n {10}persist-credentials: false\n {10}ref: \$\{\{ needs\.plan\.outputs\.checkout \}\}$/, job);
      assert.match(list[checkout + 1]!, /^ {6}- name: The commit is the plan's\n {8}env:\n {10}COMMIT: \$\{\{ needs\.plan\.outputs\.commit \}\}\n/, job);
    }
    const script = stepScript("The commit is the plan's", jobBlock("build"));
    assert.equal(script, stepScript("The commit is the plan's", jobBlock("checks")));
    const git = 'echo abcdef0123456789abcdef0123456789abcdef01';
    assert.equal(runStep(script, { COMMIT: "abcdef0123456789abcdef0123456789abcdef01" }, { git }).status, 0);
    const moved = runStep(script, { COMMIT: "1111111111111111111111111111111111111111" }, { git });
    assert.equal(moved.status, 1, moved.out);
  });

  test("the plan job checks out the ref it chose, which a release run names as refs/tags/<tag>", () => {
    assert.match(jobBlock("plan"), /- uses: actions\/checkout@[0-9a-f]{40} # \S+\n {8}with:\n {10}persist-credentials: false\n {10}ref: \$\{\{ steps\.mode\.outputs\.checkout \}\}\n/);
  });
});

describe("the targets", () => {
  test("a release or dry run builds all five targets, each on a native runner, and checks on Windows and macOS", () => {
    for (const mode of ["release", "dry"]) {
      const p = plan(mode);
      assert.deepEqual(p.targets.map((t) => [t.target, t.runner]), [
        ["windows-x64", "windows-2025-vs2026"],
        ["macos-arm64", "macos-15"],
        ["macos-x64", "macos-15-intel"],
        ["linux-x64", "ubuntu-24.04"],
        ["linux-arm64", "ubuntu-24.04-arm"],
      ]);
      assert.deepEqual(p.checks, [{ runner: "windows-2025-vs2026", "report-only": true }, { runner: "macos-15", "report-only": false }]);
    }
  });

  test("a branch run never runs on macOS: Linux x64 and Windows x64, checked on Windows and Ubuntu", () => {
    const p = plan("branch");
    assert.deepEqual(p.targets.map((t) => t.target), ["windows-x64", "linux-x64"]);
    assert.ok(p.targets.every((t) => !t.runner.startsWith("macos")));
    assert.deepEqual(p.checks.map((c) => c.runner), ["windows-2025-vs2026", "ubuntu-24.04"]);
  });

  test("no job names a macOS runner but through the plan", () => {
    for (const job of jobs) assert.doesNotMatch(jobBlock(job), /runs-on: macos/, job);
    assert.equal(/runs-on: \$\{\{ matrix\.runner \}\}/.test(jobBlock("checks")) && /runs-on: \$\{\{ matrix\.runner \}\}/.test(jobBlock("build")), true);
    assert.match(jobBlock("checks"), /\n {8}include: \$\{\{ fromJSON\(needs\.plan\.outputs\.checks\) \}\}\n/);
    assert.match(jobBlock("build"), /\n {8}include: \$\{\{ fromJSON\(needs\.plan\.outputs\.targets\) \}\}\n/);
  });

  test("the Windows checks are report-only, and the rest are a gate", () => {
    assert.match(jobBlock("checks"), /\n {4}continue-on-error: \$\{\{ matrix\.report-only \}\}\n/);
    assert.doesNotMatch(jobBlock("build"), /continue-on-error/);
  });

  test("the assets are design 11.5's names, with a signature for each file and one provenance", () => {
    assert.deepEqual(plan("release").assets, ASSETS);
    const files = plan("dry").targets.map((t) => t.files.split(" "));
    assert.deepEqual(files.flat(), FILES.slice(0, -1));
  });

  test("each target gives its digests under an output of its own, and the build job keeps every one", () => {
    const outputs = [.../\n {4}outputs:\n((?: {6}.+\n)+)/.exec(`\n${jobBlock("build")}`)![1]!.matchAll(/^ {6}([\w-]+): \$\{\{ steps\.files\.outputs\.([\w-]+) \}\}$/gm)].map((m) => [m[1], m[2]]);
    const targets = plan("release").targets.map((t) => `sha256-${t.target}`);
    assert.deepEqual(outputs, targets.map((t) => [t, t]));
    assert.match(stepScript("The files and their digests"), /echo "sha256-\$TARGET=\$\{pairs\[\*\]\}" >> "\$GITHUB_OUTPUT"/);
  });
});

describe("the files each build gives", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  test("copies the plan's files from electron-builder's desktop/out/dist and names each with its digest", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, "desktop/out/dist"), { recursive: true });
    for (const f of ["raccoon-vtt-1.2.3-windows-x64-setup.exe", "latest.yml", "other.blockmap"]) writeFileSync(path.join(dir, "desktop/out/dist", f), f);
    const r = runStep(stepScript("The files and their digests"), { TARGET: "windows-x64", FILES: "raccoon-vtt-1.2.3-windows-x64-setup.exe latest.yml" }, {}, dir);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.output, { "sha256-windows-x64": `raccoon-vtt-1.2.3-windows-x64-setup.exe=${sha("raccoon-vtt-1.2.3-windows-x64-setup.exe")} latest.yml=${sha("latest.yml")}` });
    assert.deepEqual(readdirSync(path.join(r.dir, "assets")).toSorted(), ["latest.yml", "raccoon-vtt-1.2.3-windows-x64-setup.exe"]);
  });

  test("stops when electron-builder made no such file", () => {
    const dir = scratch();
    mkdirSync(path.join(dir, "desktop/out/dist"), { recursive: true });
    writeFileSync(path.join(dir, "desktop/out/dist/latest.yml"), "x");
    const r = runStep(stepScript("The files and their digests"), { TARGET: "windows-x64", FILES: "raccoon-vtt-1.2.3-windows-x64-setup.exe latest.yml" }, {}, dir);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.output, {});
    assert.deepEqual(commands(r.out), ["::error::electron-builder made no desktop/out/dist/raccoon-vtt-1.2.3-windows-x64-setup.exe."]);
  });
});

/**
 * gh as a stand-in: `release view` prints the names in HELD, one a line, or
 * fails with VIEW_FAILS, and `release upload` succeeds. Every call is logged.
 */
const GH = `printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  "release view") if [ -n "\${VIEW_FAILS:-}" ]; then echo "$VIEW_FAILS" >&2; exit 1; fi; printf '%s' "$HELD" ;;
  "release upload") ;;
  *) exit 9 ;;
esac
`;

describe("a release is only ever added to", () => {
  const holds = (mode: string, held: readonly string[] | { fails: string }) =>
    runStep(stepScript("What the release holds"), { MODE: mode, TAG: "v1.2.3", ASSETS: ASSETS.join(" "), ...("fails" in held ? { VIEW_FAILS: held.fails, HELD: "" } : { HELD: held.join("\n") }) }, { gh: GH });

  test("a release with none of the desktop assets needs them all", () => {
    const r = holds("release", ["raccoon-vtt-1.2.3.tar.gz", "raccoon-vtt-1.2.3.intoto.jsonl", "latest.yml.bak"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls, ["release view v1.2.3 --repo example/raccoon-vtt --json assets --jq .assets[].name"]);
    assert.deepEqual(r.output, { needed: "true" });
  });

  test("a release with every desktop asset is left as it is, and nothing is built", () => {
    const r = holds("release", ["notes.txt", ...ASSETS]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.output, { needed: "false" });
    for (const job of ["checks", "build"]) assert.match(jobBlock(job), /^ {4}needs: plan\n {4}if: needs\.plan\.outputs\.needed == 'true'\n/, job);
  });

  for (const some of [["latest.yml"], [ASSETS[3]!, ASSETS.at(-1)!], ASSETS.slice(0, -1)]) {
    test(`a release with only ${some.length === 1 ? some[0] : `${some.length} of them`} is refused`, () => {
      const r = holds("release", some);
      assert.equal(r.status, 1, r.out);
      assert.deepEqual(r.output, {});
      assert.ok(commands(r.out)[0]!.startsWith(`::error::The GitHub Release v1.2.3 already has ${some.join(" ")}, but not every desktop asset.`), r.out);
    });
  }

  test("a release GitHub cannot show is an error, its text escaped onto the one error line", () => {
    const r = holds("release", { fails: "release not found\n::warning::injected" });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(commands(r.out), ["::error::Could not read the GitHub Release v1.2.3: release not found%0A::warning::injected"]);
  });

  test("a dry or branch run asks GitHub nothing", () => {
    for (const mode of ["dry", "branch"]) {
      const r = holds(mode, { fails: "should not be asked" });
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(r.calls, []);
      assert.deepEqual(r.output, { needed: "true" });
    }
  });

  /** The upload step, with every asset in its folder as the take step leaves them. */
  const upload = (held: readonly string[] | { fails: string }) => {
    const temp = scratch();
    mkdirSync(path.join(temp, "assets"));
    for (const a of ASSETS) writeFileSync(path.join(temp, "assets", a), a);
    return runStep(stepScript("Upload to the GitHub Release"), { RUNNER_TEMP: temp, TAG: "v1.2.3", ASSETS: ASSETS.join(" "), ...("fails" in held ? { VIEW_FAILS: held.fails, HELD: "" } : { HELD: held.join("\n") }) }, { gh: GH });
  };

  test("the upload attaches all of them to a release that has none, never replacing one", () => {
    const r = upload(["raccoon-vtt-1.2.3.tar.gz"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls.slice(1), [`release upload v1.2.3 --repo example/raccoon-vtt ${ASSETS.join(" ")}`]);
    assert.doesNotMatch(r.calls.join("\n"), /clobber/);
    assert.doesNotMatch(stepScript("Upload to the GitHub Release"), /clobber/);
  });

  test("the upload leaves a release that another run completed meanwhile, and refuses one that holds some", () => {
    const done = upload(ASSETS);
    assert.equal(done.status, 0, done.out);
    assert.deepEqual(done.calls.filter((c) => c.startsWith("release upload")), []);
    const some = upload([ASSETS[5]!]);
    assert.equal(some.status, 1, some.out);
    assert.deepEqual(some.calls.filter((c) => c.startsWith("release upload")), []);
    assert.match(some.out, /already has raccoon-vtt_1\.2\.3_amd64\.deb, but not every desktop asset/);
    const unread = upload({ fails: "connection refused" });
    assert.equal(unread.status, 1, unread.out);
    assert.deepEqual(unread.calls.filter((c) => c.startsWith("release upload")), []);
  });

  test("the plan and the upload read what the release holds the same way", () => {
    const reading = (step: string) => {
      const script = stepScript(step);
      return script.slice(script.indexOf("read -ra assets"), script.indexOf('if [ "${#present[@]}" -eq "${#assets[@]}" ]'));
    };
    assert.match(reading("What the release holds"), /gh release view "\$TAG"[\s\S]*grep -Fxq/);
    assert.equal(reading("Upload to the GitHub Release"), reading("What the release holds"));
  });
});

describe("a dry run never signs or uploads", () => {
  test("sign and upload run only for a release run, which only a tag starts", () => {
    for (const job of ["sign", "upload"]) assert.match(jobBlock(job), /\n {4}if: inputs\.tag != '' && needs\.plan\.outputs\.mode == 'release'\n/, job);
    assert.match(jobBlock("sign"), /^ {4}needs: \[plan, checks, build, checksums\]\n/);
    assert.match(jobBlock("upload"), /^ {4}needs: \[plan, build, checksums, sign\]\n/);
  });

  test("a branch run keeps nothing, and a dry run keeps its installers as the run's artifacts only", () => {
    const keep = steps("build").find((s) => s.includes("- name: Keep the files for the jobs after"))!;
    assert.match(keep, /\n {8}if: needs\.plan\.outputs\.mode != 'branch'\n/);
    assert.match(jobBlock("checksums"), /\n {4}if: needs\.plan\.outputs\.mode != 'branch'\n/);
    for (const job of ["plan", "checks", "build", "checksums", "sign"]) assert.doesNotMatch(jobBlock(job), /gh release (upload|create|edit|delete)/, job);
  });
});

describe("tokens and permissions", () => {
  test("each job holds only the permissions it uses, under none at the top", () => {
    assert.match(workflow, /\npermissions: \{\}\n/);
    const permissions = (job: string) => /\n {4}permissions:\n((?: {6}[\w-]+: \w+\n)+)/.exec(`\n${jobBlock(job)}`)?.[1]?.trim().split(/\n\s*/);
    assert.deepEqual(jobs, ["plan", "checks", "build", "checksums", "sign", "upload"]);
    assert.deepEqual(permissions("plan"), ["contents: read"]);
    assert.deepEqual(permissions("checks"), ["contents: read"]);
    assert.deepEqual(permissions("build"), ["contents: read"]);
    assert.match(jobBlock("checksums"), /\n {4}permissions: \{\}\n/);
    assert.deepEqual(permissions("sign"), ["id-token: write", "attestations: write"]);
    assert.deepEqual(permissions("upload"), ["contents: write"]);
  });

  test("no step that runs pnpm or the repository's code holds a token, and the one fetch that does runs before any install", () => {
    for (const job of ["checks", "build"]) {
      const list = steps(job);
      const token = (s: string) => /GH_TOKEN|GITHUB_TOKEN|github\.token|secrets\./.test(s);
      const withToken = list.filter(token);
      assert.equal(withToken.length, 1, `${job}: one step holds a token`);
      assert.match(withToken[0]!, /^ {6}- name: Fetch Node and PostgreSQL\n {8}env:\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node desktop\/scripts\/fetch-runtime\.ts$/, job);
      const fetch = list.indexOf(withToken[0]!);
      const firstPnpm = list.findIndex((s) => /\bpnpm\b/.test(s.replace(/^ *#.*$/gm, "")) && !s.includes("pnpm/action-setup@"));
      assert.ok(fetch < firstPnpm, `${job}: the fetch runs before pnpm`);
      assert.doesNotMatch(jobBlock(job).split("\n    steps:\n")[0]!, /GH_TOKEN|github\.token|secrets\./, `${job}: no token in the job's environment`);
    }
    for (const job of jobs) {
      for (const s of steps(job).filter((s) => s.includes("actions/checkout@"))) assert.match(s, /\n {10}persist-credentials: false\n/, job);
    }
    assert.doesNotMatch(workflow, /secrets\./);
  });

  test("only GitHub's own actions run in the plan and after the builds, and every action is pinned by its full SHA", () => {
    for (const job of ["plan", "checksums", "sign", "upload"]) {
      for (const [, uses] of jobBlock(job).matchAll(/uses: (\S+)/g)) assert.match(uses!, /^actions\/[\w-]+@[0-9a-f]{40}$/, `${job}: ${uses}`);
    }
    const pins = new Map<string, string>();
    for (const file of ["ci.yml", "release-assets.yml", "image.yml"]) {
      for (const [, action, sha] of read(file).matchAll(/uses: ([\w./-]+)@([0-9a-f]{40}) # \S+/g)) pins.set(action!, sha!);
    }
    const uses = [...workflow.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((m) => m[1]!);
    assert.ok(uses.length > 0);
    for (const line of uses) {
      const m = /^([\w./-]+)@([0-9a-f]{40}) # v\d+(\.\d+)*$/.exec(line);
      assert.ok(m, `not pinned by SHA: ${line}`);
      if (pins.has(m[1]!)) assert.equal(m[2], pins.get(m[1]!), `${m[1]} is pinned as in the other workflows`);
    }
  });

  test("the package manager never runs in the plan, or after the builds", () => {
    for (const job of ["plan", "checksums", "sign", "upload"]) assert.doesNotMatch(jobBlock(job).replace(/^ *#.*$/gm, ""), /\bpnpm\b|setup-node|\bnode (desktop|scripts)\//, job);
  });
});

describe("Windows", () => {
  test("every job that can run on Windows turns off CRLF checkouts before it checks out", () => {
    for (const job of jobs) {
      const block = jobBlock(job);
      if (!/runs-on: \$\{\{ matrix\.runner \}\}/.test(block) && !/runs-on: windows/.test(block)) continue;
      const list = steps(job);
      const checkout = list.findIndex((s) => s.includes("actions/checkout@"));
      assert.ok(checkout > 0, `${job} checks out`);
      const lf = list.findIndex((s) => /^ {6}- name: Check out with LF line endings\n {8}run: git config --global core\.autocrlf false$/.test(s));
      assert.ok(lf >= 0 && lf < checkout, `${job} sets core.autocrlf false before actions/checkout`);
    }
    assert.ok(plan("branch").checks.some((c) => c.runner.startsWith("windows")), "the check covers a job that runs on Windows");
  });

  test("bash runs every step of the jobs that run on Windows, but the network profile's", () => {
    for (const job of ["checks", "build"]) assert.match(jobBlock(job), /\n {4}defaults:\n {6}run:\n {8}shell: bash\n/, job);
    assert.match(jobBlock("build"), /- name: A private network\n {8}if: runner\.os == 'Windows'\n {8}shell: pwsh\n/);
  });
});

describe("the branch run", () => {
  test("starts on a ci/ branch push that touches the desktop app, the server or the packages, and on no other event", () => {
    const on = workflow.split("\non:\n")[1]!.split("\npermissions:")[0]!;
    assert.deepEqual([...on.matchAll(/^ {2}([\w_]+):$/gm)].map((m) => m[1]), ["workflow_call", "workflow_dispatch", "push"]);
    const push = on.split("\n  push:\n")[1]!;
    assert.match(push, /^ {4}branches: \["ci\/\*\*"\]\n {4}paths:\n/);
    assert.doesNotMatch(push, /tags:/);
    assert.deepEqual([...push.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1]), ["desktop/**", ".github/workflows/desktop.yml", "server/**", "shared/**", "db/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  });

  test("a run by hand takes a tag or a ref, and a call from another workflow a tag", () => {
    assert.match(workflow, /\n {2}workflow_call:\n {4}inputs:\n {6}tag:\n(?: {8}.+\n)* {8}required: true\n/);
    assert.match(workflow, /\n {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}.+\n)* {6}ref:\n/);
  });
});

describe("each asset comes from the job that made it", () => {
  /** The `take` and `built` helpers of a job's "Take each job's files" step. */
  const helpers = (job: string) => {
    const s = stepScript("Take each job's files", jobBlock(job));
    return s.slice(0, s.indexOf("mkdir -p"));
  };

  test("the checksums, sign and upload jobs share one way of taking files", () => {
    assert.match(helpers("checksums"), /\ntake\(\) \{\n[\s\S]*\nbuilt\(\) \{\n/);
    assert.equal(helpers("sign"), helpers("checksums"));
    assert.equal(helpers("upload"), helpers("checksums"));
    const loop = (job: string) => /\nmkdir -p "\$RUNNER_TEMP\/assets"\nfor target in [\s\S]*?\ndone/.exec(stepScript("Take each job's files", jobBlock(job)))?.[0];
    assert.ok(loop("checksums")?.includes("for target in windows-x64 macos-arm64 macos-x64 linux-x64 linux-arm64; do"));
    assert.equal(loop("sign"), loop("checksums"));
    assert.equal(loop("upload"), loop("checksums"));
    assert.deepEqual(["windows-x64", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64"], plan("release").targets.map((t) => t.target));
  });

  test("each job downloads every artifact into a folder of its own, never merged", () => {
    assert.doesNotMatch(workflow, /merge-multiple|pattern:/);
    const downloads = (job: string) => [...jobBlock(job).matchAll(/- uses: actions\/download-artifact@[0-9a-f]{40} # \S+\n {8}with:\n {10}name: (desktop-[\w-]+)\n {10}path: \$\{\{ runner\.temp \}\}\/from\/([\w-]+)\n/g)].map((m) => [m[1]!, m[2]!]);
    const builds = ["windows-x64", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64"].map((t) => [`desktop-${t}`, t]);
    assert.deepEqual(downloads("checksums"), builds);
    assert.deepEqual(downloads("sign"), [...builds, ["desktop-checksums", "checksums"]]);
    assert.deepEqual(downloads("upload"), [...builds, ["desktop-checksums", "checksums"], ["desktop-signatures", "signatures"]]);
    for (const job of ["checksums", "sign", "upload"]) {
      assert.equal(downloads(job).length, jobBlock(job).split("actions/download-artifact@").length - 1, job);
      assert.match(jobBlock(job), /\n {10}DIGESTS: \$\{\{ toJSON\(needs\.build\.outputs\) \}\}\n/, job);
    }
    for (const job of ["sign", "upload"]) assert.match(jobBlock(job), /\n {10}CHECKSUMS_SHA256: \$\{\{ needs\.checksums\.outputs\.sha256 \}\}\n/, job);
  });

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  /** The plan's targets for 1.2.3, and every build's files laid out as the downloads leave them, each holding its own name. */
  function layout() {
    const temp = scratch();
    const targets = plan("release").targets;
    const digests: Record<string, string> = {};
    for (const t of targets) {
      mkdirSync(path.join(temp, "from", t.target), { recursive: true });
      for (const f of t.files.split(" ")) writeFileSync(path.join(temp, "from", t.target, f), f);
      digests[`sha256-${t.target}`] = t.files.split(" ").map((f) => `${f}=${sha(f)}`).join(" ");
    }
    return { temp, targets, digests };
  }
  const take = (job: string, temp: string, targets: Target[], digests: Record<string, string>, extra: Record<string, string> = {}) =>
    runStep(stepScript("Take each job's files", jobBlock(job)), { RUNNER_TEMP: temp, VERSION: "1.2.3", TARGETS: JSON.stringify(targets), DIGESTS: JSON.stringify(digests), ...extra });

  test("the checksums job takes every build's files, each checked against its own job's digest", () => {
    const { temp, targets, digests } = layout();
    const r = take("checksums", temp, targets, digests);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(readdirSync(path.join(temp, "assets")).toSorted(), FILES.slice(0, -1).toSorted());
  });

  /** [what is wrong, how to lay it out or change the digests, the error] */
  const refused: [string, (l: ReturnType<typeof layout>) => void, RegExp][] = [
    ["a file another job placed beside a build's", ({ temp }) => writeFileSync(path.join(temp, "from/linux-x64/raccoon-vtt-1.2.3-windows-x64-setup.exe"), "x"), /desktop-linux-x64 artifact must hold raccoon-vtt-1\.2\.3-linux-x86_64\.AppImage raccoon-vtt_1\.2\.3_amd64\.deb latest-linux\.yml, and nothing else/],
    ["a hidden file", ({ temp }) => writeFileSync(path.join(temp, "from/macos-x64/.npmrc"), "x"), /desktop-macos-x64 artifact must hold/],
    ["a missing file", ({ temp }) => rmSync(path.join(temp, "from/linux-arm64/latest-linux-arm64.yml")), /desktop-linux-arm64 artifact must hold/],
    ["a missing artifact", ({ temp }) => rmSync(path.join(temp, "from/macos-arm64"), { recursive: true }), /desktop-macos-arm64 artifact must hold/],
    ["a file under another name", ({ temp }) => { rmSync(path.join(temp, "from/windows-x64/latest.yml")); writeFileSync(path.join(temp, "from/windows-x64/latest.yaml"), "x"); }, /desktop-windows-x64 artifact's latest\.yml is missing/],
    ["a replaced file", ({ temp }) => writeFileSync(path.join(temp, "from/linux-x64/raccoon-vtt_1.2.3_amd64.deb"), "replaced"), new RegExp(`raccoon-vtt_1\\.2\\.3_amd64\\.deb is not the file the job that made it gave: its sha256 is ${sha("replaced")}\\.`)],
    ["a build that gave no digests", ({ digests }) => delete digests["sha256-macos-x64"], /raccoon-vtt-1\.2\.3-macos-x64\.dmg is not the file the job that made it gave/],
    ["a build whose digests name another target's file", ({ digests }) => (digests["sha256-macos-x64"] = `raccoon-vtt-1.2.3-macos-arm64.dmg=${sha("raccoon-vtt-1.2.3-macos-arm64.dmg")}`), /raccoon-vtt-1\.2\.3-macos-x64\.dmg is not the file the job that made it gave/],
    ["a file that is a symlink", ({ temp }) => { rmSync(path.join(temp, "from/windows-x64/latest.yml")); symlinkSync(path.join(temp, "from/linux-x64/latest-linux.yml"), path.join(temp, "from/windows-x64/latest.yml")); }, /desktop-windows-x64 artifact's latest\.yml is missing or not a regular file/],
    ["an artifact folder that is a symlink", ({ temp }) => { rmSync(path.join(temp, "from/linux-arm64"), { recursive: true }); symlinkSync(path.join(temp, "from/linux-x64"), path.join(temp, "from/linux-arm64")); }, /desktop-linux-arm64 artifact must hold/],
  ];
  for (const [what, lay, error] of refused) {
    for (const job of ["checksums", "sign", "upload"]) {
      test(`the ${job} job refuses ${what}, on one error line`, () => {
        const l = layout();
        lay(l);
        const r = take(job, l.temp, l.targets, l.digests, { CHECKSUMS_SHA256: "", ASSETS: ASSETS.join(" ") });
        assert.equal(r.status, 1, r.out);
        assert.equal(commands(r.out).length, 1, r.out);
        assert.match(commands(r.out)[0]!, error);
      });
    }
  }

  test("sign and upload take the checksum list only as the checksums job made it", () => {
    for (const job of ["sign", "upload"]) {
      const l = layout();
      mkdirSync(path.join(l.temp, "from/checksums"));
      writeFileSync(path.join(l.temp, "from/checksums/raccoon-vtt-1.2.3-desktop.sha256"), "list\n");
      const wrong = take(job, l.temp, l.targets, l.digests, { CHECKSUMS_SHA256: sha("other\n"), ASSETS: ASSETS.join(" ") });
      assert.equal(wrong.status, 1, wrong.out);
      assert.deepEqual(commands(wrong.out), [`::error::raccoon-vtt-1.2.3-desktop.sha256 is not the file the job that made it gave: its sha256 is ${sha("list\n")}.`]);
      const none = take(job, l.temp, l.targets, l.digests, { CHECKSUMS_SHA256: "", ASSETS: ASSETS.join(" ") });
      assert.equal(none.status, 1, none.out);
    }
  });

  test("the sign job takes the builds' files and the list, and the upload job those and the signatures, exactly the release's assets", () => {
    const l = layout();
    mkdirSync(path.join(l.temp, "from/checksums"));
    writeFileSync(path.join(l.temp, "from/checksums/raccoon-vtt-1.2.3-desktop.sha256"), "list\n");
    const signed = take("sign", l.temp, l.targets, l.digests, { CHECKSUMS_SHA256: sha("list\n") });
    assert.equal(signed.status, 0, signed.out);
    assert.deepEqual(readdirSync(path.join(l.temp, "assets")).toSorted(), FILES.toSorted());

    const u = layout();
    mkdirSync(path.join(u.temp, "from/checksums"));
    writeFileSync(path.join(u.temp, "from/checksums/raccoon-vtt-1.2.3-desktop.sha256"), "list\n");
    mkdirSync(path.join(u.temp, "from/signatures"));
    for (const f of ASSETS.filter((a) => !FILES.includes(a))) writeFileSync(path.join(u.temp, "from/signatures", f), "s");
    const env = { CHECKSUMS_SHA256: sha("list\n"), ASSETS: ASSETS.join(" ") };
    const uploaded = take("upload", u.temp, u.targets, u.digests, env);
    assert.equal(uploaded.status, 0, uploaded.out);
    assert.deepEqual(readdirSync(path.join(u.temp, "assets")).toSorted(), ASSETS.toSorted());

    rmSync(path.join(u.temp, "assets"), { recursive: true });
    writeFileSync(path.join(u.temp, "from/signatures/raccoon-vtt-1.2.3-desktop.sha256"), "not a signature");
    const extra = take("upload", u.temp, u.targets, u.digests, env);
    assert.equal(extra.status, 1, extra.out);
    assert.match(commands(extra.out)[0]!, /desktop-signatures artifact must hold/);
    rmSync(path.join(u.temp, "from/signatures/raccoon-vtt-1.2.3-desktop.sha256"));
    rmSync(path.join(u.temp, "from/signatures/latest.yml.sigstore.json"));
    rmSync(path.join(u.temp, "assets"), { recursive: true });
    const missing = take("upload", u.temp, u.targets, u.digests, env);
    assert.equal(missing.status, 1, missing.out);
  });

  test("the checksum list names every build file with its SHA-256, and gives its own digest on", () => {
    const temp = scratch();
    mkdirSync(path.join(temp, "assets"));
    for (const f of FILES.slice(0, -1)) writeFileSync(path.join(temp, "assets", f), f);
    const r = runStep(stepScript("The checksum list"), { RUNNER_TEMP: temp, VERSION: "1.2.3" });
    assert.equal(r.status, 0, r.out);
    const list = readFileSync(path.join(temp, "assets/raccoon-vtt-1.2.3-desktop.sha256"), "utf8");
    assert.deepEqual(list.trim().split("\n").map((l) => l.split("  ")).toSorted((a, b) => a[1]!.localeCompare(b[1]!)), FILES.slice(0, -1).map((f) => [sha(f), f]).toSorted((a, b) => a[1]!.localeCompare(b[1]!)));
    assert.deepEqual(r.output, { sha256: sha(list) });
  });

  test("the sign job signs every taken file into a folder of its own, and attests exactly those files", () => {
    const sign = jobBlock("sign");
    assert.ok(sign.indexOf("- name: Take each job's files") < sign.indexOf("- name: Sign each file"));
    assert.match(stepScript("Sign each file"), /cd "\$RUNNER_TEMP\/assets"\nfor file in \*; do\n/);
    assert.match(stepScript("Sign each file"), /--bundle "\$RUNNER_TEMP\/signatures\/\$file\.sigstore\.json" "\$file"/);
    assert.match(sign, /\n {10}subject-path: \$\{\{ runner\.temp \}\}\/assets\/\*\n {10}predicate-type: https:\/\/slsa\.dev\/provenance\/v1\n {10}predicate-path: \$\{\{ runner\.temp \}\}\/provenance\.json\n/);
    assert.match(stepScript("The provenance as a release asset"), /"\$RUNNER_TEMP\/signatures\/raccoon-vtt-\$VERSION-desktop\.intoto\.jsonl"$/);
  });
});

describe("shared with the other release workflows", () => {
  test("Cosign is the same checksum-pinned download as image.yml's", () => {
    assert.equal(stepScript("Install Cosign"), stepScript("Install Cosign", read("image.yml")));
  });

  test("the provenance predicate is release-assets.yml's, naming this workflow as the builder", () => {
    const ours = stepScript("The provenance predicate");
    assert.ok(ours.includes(".github/workflows/desktop.yml@"));
    assert.equal(ours.replace("desktop.yml@", "release-assets.yml@"), stepScript("The provenance predicate", read("release-assets.yml")));
    assert.match(jobBlock("sign"), /\n {10}COMMIT: \$\{\{ needs\.plan\.outputs\.commit \}\}\n/);
  });
});

describe("Dependabot", () => {
  test("updates the desktop app's own packages, with the root's cooldown", () => {
    const config = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
    const entries = config.split(/\n {2}- package-ecosystem: /).slice(1);
    const desktop = entries.find((e) => e.startsWith("npm\n    directory: /desktop\n"));
    assert.ok(desktop, "an npm entry for /desktop");
    const root = entries.find((e) => e.startsWith("npm\n    directory: /\n"))!;
    const cooldown = (e: string) => /\n {4}cooldown:\n {6}default-days: (\d+)\n/.exec(e)?.[1];
    assert.equal(cooldown(desktop), cooldown(root));
    assert.equal(cooldown(desktop), "14");
  });
});

