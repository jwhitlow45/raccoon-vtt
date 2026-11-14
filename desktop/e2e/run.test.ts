import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { exitCode, pick } from "./run.ts";

const files = ["window.e2e.ts", "run.ts", "run.test.ts", "shell.e2e.ts", "helpers.ts"];

test("runs every desktop e2e file in name order, or only those named", () => {
  assert.deepEqual(pick(files, []), { run: ["shell", "window"], unknown: [] });
  assert.deepEqual(pick(files, ["window"]), { run: ["window"], unknown: [] });
  assert.deepEqual(pick(files, ["window", "smoke", "run"]), { run: ["window"], unknown: ["smoke", "run"] });
});

test("passes only when a file ran and every file passed", () => {
  assert.equal(exitCode([]), 1);
  assert.equal(exitCode([{ name: "shell", status: "passed", seconds: 1 }]), 0);
  assert.equal(exitCode([{ name: "shell", status: "passed", seconds: 1 }, { name: "window", status: "failed", seconds: 1 }]), 1);
  assert.equal(exitCode([{ name: "shell", status: "timed out", seconds: 900 }]), 1);
});

test("refuses a name that is no desktop e2e file, running nothing", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./run.ts", import.meta.url)), "no-such-file"], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /No desktop e2e file is named no-such-file\./);
});
