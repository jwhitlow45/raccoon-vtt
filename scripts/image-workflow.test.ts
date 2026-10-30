import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

/*
 * The image workflow's check of what Docker Hub already holds for a
 * version (.github/workflows/image.yml), run as the workflow runs it, with
 * a stand-in for docker: a version from this very commit resumes, and any
 * other is refused with all four things it compares, each as Docker Hub
 * holds it and as this run would push it (review DH1-OPUS-18). What Docker
 * Hub sends reaches the refusal escaped, so a line break in a label starts
 * no workflow command of its own (review FU33-ASTRA-01).
 */

const STEP = "What Docker Hub holds for this version";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = "https://github.com/example/raccoon-vtt";
const BOTH = "linux/amd64 linux/arm64";

/** The step's script: the lines of its `run: |` block, as GitHub hands them to bash. */
function stepScript(step = STEP): string {
  const lines = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8").split("\n");
  const name = lines.findIndex((l) => l.trim() === `- name: ${step}`);
  assert.ok(name >= 0, `no step named "${step}"`);
  const run = lines.findIndex((l, i) => i > name && l.trim() === "run: |");
  const indent = lines[run + 1]!.length - lines[run + 1]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

type Held = { revision: string; version: string; source: string; platforms: readonly string[] };

/**
 * The step run against a Docker Hub that holds `held` for 0.2.0, or that
 * answers the inspect with an error, `{ fails }`: its exit, what it
 * printed, and what it left for later steps.
 */
function check(held: Held | { fails: string }): { status: number | null; out: string; env: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoon-image-step-"));
  try {
    let image = "";
    if ("fails" in held) writeFileSync(path.join(dir, "fails.txt"), held.fails);
    else {
      const labels = { "org.opencontainers.image.revision": held.revision, "org.opencontainers.image.version": held.version, "org.opencontainers.image.source": held.source };
      image = JSON.stringify(Object.fromEntries(held.platforms.map((p) => [p, { config: { Labels: labels } }])));
    }
    writeFileSync(path.join(dir, "image.json"), image);
    // Login and logout succeed, and inspect answers with the image's platforms and labels, the index's digest, or the error.
    const fails = path.join(dir, "fails.txt");
    writeFileSync(
      path.join(dir, "docker"),
      [
        "#!/bin/bash",
        'case "$*" in',
        "  login*) cat > /dev/null ;;",
        "  logout*) ;;",
        `  *".Image"*) if [ -f "${fails}" ]; then cat "${fails}"; exit 1; fi; cat "${path.join(dir, "image.json")}" ;;`,
        '  *".Manifest"*) echo \'{"digest":"sha256:feed"}\' ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(path.join(dir, "docker"), 0o755);
    writeFileSync(path.join(dir, "step.sh"), stepScript());
    writeFileSync(path.join(dir, "env"), "");
    const run = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", path.join(dir, "step.sh")], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        IMAGE: "docker.io/example/raccoon-vtt",
        VERSION: "0.2.0",
        REVISION,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "example/raccoon-vtt",
        GITHUB_ENV: path.join(dir, "env"),
        DOCKERHUB_USERNAME: "example",
        DOCKERHUB_TOKEN: "not-a-token",
      },
    });
    return { status: run.status, out: run.stdout + run.stderr, env: readFileSync(path.join(dir, "env"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAME: Held = { revision: REVISION, version: "0.2.0", source: SOURCE, platforms: ["linux/amd64", "linux/arm64"] };

/** A value as a workflow command carries it: %, CR and LF escaped. */
const escaped = (v: string) => v.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** The workflow commands a run printed: lines starting "::". */
const commands = (out: string) => out.split("\n").filter((l) => l.startsWith("::"));
const jq = spawnSync("jq", ["--version"]).status === 0;

describe("the image workflow's check of a version Docker Hub holds already", { skip: jq ? false : "jq is not installed" }, () => {
  test("one from this commit, with both platforms, resumes", () => {
    const r = check(SAME);
    assert.equal(r.status, 0, r.out);
    assert.match(r.env, /^MODE=resume$/m);
  });

  for (const [what, held] of [
    ["revision", { ...SAME, revision: "fedcba9876543210fedcba9876543210fedcba98" }],
    ["version", { ...SAME, version: "0.1.9" }],
    ["source", { ...SAME, source: "https://github.com/someone/else" }],
    ["platforms", { ...SAME, platforms: ["linux/amd64"] }],
  ] as const) {
    test(`one whose ${what} differs is refused, naming all four as held and as this run's`, () => {
      const r = check(held);
      assert.equal(r.status, 1, r.out);
      const error = r.out.split("\n").find((l) => l.startsWith("::error::")) ?? "";
      for (const [field, have, want] of [
        ["revision", held.revision, REVISION],
        ["version", held.version, "0.2.0"],
        ["source", held.source, SOURCE],
        ["platforms", held.platforms.join(" "), BOTH],
      ] as const) {
        assert.ok(error.includes(`${field} '${have}' (this run's '${want}')`), `${field} in: ${error}`);
      }
    });
  }

  test("labels with line breaks and percent signs reach the refusal escaped, starting no command of their own", () => {
    const held: Held = { ...SAME, revision: "abc%0Adef", version: "0.2.0\r\n::warning::from the version", source: "https://example.com/x\n::warning::injected annotation\n" };
    const r = check(held);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(commands(r.out).map((l) => l.split("::")[1]), ["error"], r.out);
    const error = commands(r.out)[0]!;
    // A trailing line break is gone with the command substitution that reads the label.
    for (const [field, have] of [
      ["revision", held.revision],
      ["version", held.version],
      ["source", held.source.replace(/\n$/, "")],
    ] as const) {
      assert.ok(error.includes(`${field} '${escaped(have)}'`), `${field} in: ${error}`);
    }
  });

  test("an error from Docker Hub other than not found stops the step, its text escaped onto the one error line", () => {
    const r = check({ fails: "ERROR: 500 at 100%\n::warning::injected annotation" });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(commands(r.out), [`::error::Could not tell whether 0.2.0 is on Docker Hub: ${escaped("ERROR: 500 at 100%\n::warning::injected annotation")}`]);
  });
});

/** A job's YAML block, so permission and dependency checks cannot match another job. */
function jobBlock(name: string): string {
  const workflow = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8");
  const block = workflow.split(`\n  ${name}:\n`)[1];
  assert.ok(block, `no job named ${name}`);
  return block.split(/\n  [\w-]+:\n/)[0]!;
}

function publishRelease(state: "exists" | "missing" | "unreachable"): { status: number | null; calls: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoon-release-step-"));
  try {
    writeFileSync(path.join(dir, "gh"), `#!/bin/bash
printf '%s\\n' "$1 $2" >> "$CALLS"
if [ "$2" = view ]; then
  case "$STATE" in
    exists) exit 0 ;;
    missing) echo 'release not found' >&2; exit 1 ;;
    unreachable) echo 'connection refused' >&2; exit 1 ;;
  esac
fi
[ "$2" = create ]
`);
    chmodSync(path.join(dir, "gh"), 0o755);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepScript("Publish the GitHub Release")], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, STATE: state, CALLS: path.join(dir, "calls"), TAG: "v0.2.0", GITHUB_REPOSITORY: "example/raccoon-vtt", NOTES: "Release notes\n\nWith paragraphs." },
    });
    return { status: result.status, calls: readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("GitHub Releases follow successful image publication", () => {
  test("both jobs require a successful tag publish and notes run with a read-only token", () => {
    assert.equal(existsSync(new URL("../.github/workflows/release.yml", import.meta.url)), false);
    for (const name of ["release-notes", "release"]) {
      const block = jobBlock(name);
      assert.match(block, /needs: (?:publish|\[publish, release-notes\])/);
      assert.match(block, /if: github.event_name == 'push' && github.ref_type == 'tag' && needs.publish.result == 'success'/);
    }
    const notes = jobBlock("release-notes");
    assert.match(notes, /permissions:\n      contents: read\n/);
    assert.doesNotMatch(notes, /contents: write/);
    assert.match(notes, /github_token: \$\{\{ github.token \}\}/);
    assert.match(notes, /content: \$\{\{ steps.notes.outputs.content \}\}/);
    const release = jobBlock("release");
    assert.match(release, /needs: \[publish, release-notes\]/);
    assert.match(release, /NOTES: \$\{\{ needs.release-notes.outputs.content \}\}/);
    assert.doesNotMatch(release, /uses:/);
  });

  test("an existing Release is left unchanged", () => {
    assert.deepEqual(publishRelease("exists"), { status: 0, calls: ["release view"] });
  });

  test("a missing Release is created after checking for it", () => {
    assert.deepEqual(publishRelease("missing"), { status: 0, calls: ["release view", "release create"] });
  });

  test("a failed lookup never creates a Release", () => {
    assert.deepEqual(publishRelease("unreachable"), { status: 1, calls: ["release view"] });
  });
});
