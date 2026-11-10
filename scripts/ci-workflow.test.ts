import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

/*
 * .github/workflows/ci.yml's pull request rule and its CI passed job, the
 * one check main's ruleset requires. A pull request from this repository's
 * own ci/ branch skips every job, since the push run on that commit runs
 * them. Elsewhere CI passed fails unless every job passed or was skipped by
 * the file's own design.
 */

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

/** The condition, as ci.yml writes it, for a pull request whose commit the push run tests. */
const PUSH_TESTED = "startsWith(github.head_ref, 'ci/') && github.event.pull_request.head.repo.full_name == github.repository";

/** The jobs, in order: the keys under `jobs:`. */
const jobs = [...workflow.split("\njobs:\n")[1]!.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]!);

/** A job's YAML block, so a check cannot match another job. */
function jobBlock(name: string): string {
  const block = workflow.split(`\n  ${name}:\n`)[1];
  assert.ok(block, `no job named ${name}`);
  return block.split(/\n {2}[\w-]+:\n/)[0]!;
}

/** The gate step's script: the lines of its `run: |` block, as GitHub hands them to bash. */
function gateScript(): string {
  const lines = jobBlock("ci-passed").split("\n");
  const run = lines.findIndex((l) => l.trim() === "run: |");
  assert.ok(run >= 0, "the CI passed job has no run block");
  const indent = lines[run + 1]!.length - lines[run + 1]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

type Results = { build: string; "typecheck-int": string; "int-clock": string; unit: string; e2e: string; "e2e-macos": string };

const PASSED: Results = { build: "success", "typecheck-int": "success", "int-clock": "success", unit: "success", e2e: "success", "e2e-macos": "skipped" };

/** The gate run with these job results and build outputs, as GitHub's default bash runs a step. */
function gate(results: Results, outputs: { macosFiles?: string; docsOnly?: string; pushTested?: boolean } = {}): { status: number | null; out: string } {
  const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", gateScript()], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      PUSH_TESTED: String(outputs.pushTested ?? false),
      BUILD: results.build,
      TYPECHECK_INT: results["typecheck-int"],
      INT_CLOCK: results["int-clock"],
      UNIT: results.unit,
      E2E: results.e2e,
      E2E_MACOS: results["e2e-macos"],
      MACOS_FILES: outputs.macosFiles ?? "0",
      DOCS_ONLY: outputs.docsOnly ?? "false",
    },
  });
  return { status: run.status, out: run.stdout + run.stderr };
}

describe("CI passed", () => {
  test("passes when every job passed and e2e-macos had no files to run", () => {
    const r = gate(PASSED);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /e2e-macos had nothing to run/);
  });

  test("passes when e2e-macos ran its files and passed", () => {
    assert.equal(gate({ ...PASSED, "e2e-macos": "success" }, { macosFiles: "2" }).status, 0);
  });

  test("passes a docs-only push, which skips e2e-macos even with files listed", () => {
    assert.equal(gate(PASSED, { macosFiles: "2", docsOnly: "true" }).status, 0);
  });

  test("passes a docs-only push, which skips the integration tests on the real clock, and fails any other that skips them", () => {
    assert.equal(gate({ ...PASSED, "int-clock": "skipped" }, { docsOnly: "true" }).status, 0);
    const r = gate({ ...PASSED, "int-clock": "skipped" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^::error::Not every job passed: int-clock \(skipped\)\.$/m);
  });

  test("fails when e2e-macos was skipped though it had files to run", () => {
    const r = gate(PASSED, { macosFiles: "2" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^::error::Not every job passed: e2e-macos \(skipped\)\.$/m);
  });

  test("fails a failed build and names every job it took down, e2e-macos's skip included", () => {
    const r = gate({ ...PASSED, build: "failure", "int-clock": "skipped", e2e: "skipped" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^::error::Not every job passed: build \(failure\) int-clock \(skipped\) e2e \(skipped\) e2e-macos \(skipped\)\.$/m);
  });

  for (const job of ["build", "typecheck-int", "int-clock", "unit", "e2e", "e2e-macos"] as const) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      if (job === "e2e-macos" && result === "skipped") continue;
      test(`fails when ${job} ended ${result}`, () => {
        const r = gate({ ...PASSED, [job]: result }, { macosFiles: job === "e2e-macos" ? "1" : "0" });
        assert.equal(r.status, 1, r.out);
        assert.ok(r.out.includes(` ${job} (${result})`), r.out);
      });
    }
  }

  test("passes a pull request from this repository's ci/ branch, where every job skipped", () => {
    const skipped = { build: "skipped", "typecheck-int": "skipped", "int-clock": "skipped", unit: "skipped", e2e: "skipped", "e2e-macos": "skipped" };
    const r = gate(skipped, { macosFiles: "", docsOnly: "", pushTested: true });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /push run/);
    assert.equal(gate(skipped, { macosFiles: "", docsOnly: "" }).status, 1);
  });
});

describe("ci.yml's jobs", () => {
  test("CI passed is the last job and needs every other one, whatever they ended in", () => {
    assert.equal(jobs.at(-1), "ci-passed");
    const block = jobBlock("ci-passed");
    assert.deepEqual(/\n {4}needs: \[(.+)\]\n/.exec(block)?.[1]?.split(", "), jobs.slice(0, -1));
    assert.match(block, /\n {4}if: \$\{\{ always\(\) \}\}\n/);
    assert.match(block, /\n {4}permissions: \{\}\n/);
  });

  test("CI passed reads every job's result and checks each one", () => {
    const block = jobBlock("ci-passed");
    const script = gateScript();
    for (const job of jobs.slice(0, -1)) {
      const variable = job.toUpperCase().replaceAll("-", "_");
      assert.ok(block.includes(`${variable}: \${{ needs.${job}.result }}`), `${job}'s result`);
      assert.ok(script.includes(`"${job}=$${variable}"`), `${job} in the check`);
    }
  });

  test("CI passed takes another name in a pull request the push run tests, so main's required check is only ever the push run's", () => {
    const block = `\n${jobBlock("ci-passed")}`;
    assert.ok(block.includes(`\n    name: \${{ ${PUSH_TESTED} && 'Tested by the push run' || 'CI passed' }}\n`), block);
    assert.ok(block.includes(`PUSH_TESTED: \${{ ${PUSH_TESTED} }}\n`), block);
  });

  test("the jobs that start a run skip in a pull request the push run tests, and the rest wait on the build", () => {
    assert.ok(jobBlock("build").startsWith(`    if: \${{ !(${PUSH_TESTED}) }}\n`));
    assert.ok(jobBlock("unit").startsWith(`    if: \${{ !(${PUSH_TESTED}) }}\n`));
    assert.match(jobBlock("typecheck-int"), new RegExp(`^ {4}needs: build\\n {4}if: \\$\\{\\{ !cancelled\\(\\) && !\\(${PUSH_TESTED.replace(/[()|.]/g, "\\$&")}\\) \\}\\}\\n`));
    for (const job of jobs.filter((j) => !["build", "unit", "typecheck-int", "ci-passed"].includes(j))) {
      const block = jobBlock(job);
      assert.match(block, /^ {4}needs: build\n/, `${job} needs the build`);
      assert.doesNotMatch(/^ {4}if: (.*)$/m.exec(block)?.[1] ?? "", /always\(\)|cancelled\(\)/, `${job} would run without the build`);
    }
  });
});
