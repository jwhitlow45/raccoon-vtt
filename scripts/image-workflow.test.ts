import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

/*
 * The image workflow's check of what Docker Hub already holds for a
 * version (.github/workflows/image.yml), run as the workflow runs it, with
 * a stand-in for docker: a version from this very commit resumes, and any
 * other is refused with all four things it compares, each as Docker Hub
 * holds it and as this run would push it (review DH1-OPUS-18).
 */

const STEP = "What Docker Hub holds for this version";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = "https://github.com/example/raccoon-vtt";
const BOTH = "linux/amd64 linux/arm64";

/** The step's script: the lines of its `run: |` block, as GitHub hands them to bash. */
function stepScript(): string {
  const lines = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8").split("\n");
  const name = lines.findIndex((l) => l.trim() === `- name: ${STEP}`);
  assert.ok(name >= 0, `no step named "${STEP}"`);
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

/** The step run against a Docker Hub that holds `held` for 0.2.0: its exit, what it printed, and what it left for later steps. */
function check(held: Held): { status: number | null; out: string; env: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoon-image-step-"));
  try {
    const labels = { "org.opencontainers.image.revision": held.revision, "org.opencontainers.image.version": held.version, "org.opencontainers.image.source": held.source };
    const image = Object.fromEntries(held.platforms.map((p) => [p, { config: { Labels: labels } }]));
    writeFileSync(path.join(dir, "image.json"), JSON.stringify(image));
    // Login and logout succeed, and inspect answers with the image's platforms and labels, or the index's digest.
    writeFileSync(
      path.join(dir, "docker"),
      ["#!/bin/bash", 'case "$*" in', '  login*) cat > /dev/null ;;', '  logout*) ;;', `  *".Image"*) cat "${path.join(dir, "image.json")}" ;;`, '  *".Manifest"*) echo \'{"digest":"sha256:feed"}\' ;;', "esac", ""].join("\n"),
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
});
