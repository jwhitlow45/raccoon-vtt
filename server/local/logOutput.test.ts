import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

/**
 * Each case runs a child that writes 1 MiB to its stdout pipe, more than
 * the pipe holds, then its last line, then exits through exitAfterLogs, and
 * the parent here plays the supervisor reading that pipe.
 */
const MODULE = new URL("./logOutput.ts", import.meta.url).href;

/**
 * Node makes stdout's pipe writes synchronous on Windows (lib/net.js), so a
 * child there blocks in a write while nothing reads and reaches its exit
 * only once the parent reads again. The cases of a full pipe at the exit
 * are then cases of a blocked write, which these cannot hold, so they run
 * elsewhere only.
 */
const asyncPipes = process.platform === "win32" ? "stdout's pipe writes are synchronous on Windows" : false;

type Run = { code: number | null; out: string; ms: number };

function run(flushMs: number, reader: "reading" | "slow" | "never" | "gone"): Promise<Run> {
  const script = `
    import { exitAfterLogs, localLogOutput } from ${JSON.stringify(MODULE)};
    const out = localLogOutput();
    const line = "x".repeat(1023) + "\\n";
    for (let i = 0; i < 1024; i++) out.write(line);
    out.write("the last line\\n");
    exitAfterLogs(3, ${flushMs});
  `;
  const started = Date.now();
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const stdout = child.stdout;
  if (reader === "gone") stdout.destroy();
  else {
    stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    if (reader !== "reading") stdout.pause();
    if (reader === "slow") setTimeout(() => stdout.resume(), 500);
  }
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the child did not exit in 15 s (${reader})`));
    }, 15_000);
    child.on("exit", (code) => {
      clearTimeout(guard);
      // Whatever the pipe still holds once the child has gone.
      if (reader === "never") stdout.resume();
      stdout.once("close", () => resolve({ code, out, ms: Date.now() - started }));
      if (stdout.destroyed) resolve({ code, out, ms: Date.now() - started });
    });
  });
}

test("a supervisor that reads gets every line, the last one too, before the exit", async () => {
  const r = await run(12_000, "reading");
  assert.equal(r.code, 3);
  assert.equal(r.out.length, 1024 * 1024 + "the last line\n".length);
  assert.ok(r.out.endsWith("the last line\n"));
  assert.ok(r.ms < 10_000, `${r.ms} ms`);
});

test("a supervisor slow to read gets every line, the last one too, before the exit", { skip: asyncPipes }, async () => {
  const r = await run(12_000, "slow");
  assert.equal(r.code, 3);
  assert.equal(r.out.length, 1024 * 1024 + "the last line\n".length);
  assert.ok(r.out.endsWith("the last line\n"));
  assert.ok(r.ms < 10_000, `the write's callback ended it, not the bound (${r.ms} ms)`);
});

test("a supervisor that never reads holds the exit only for the bound", { skip: asyncPipes }, async () => {
  const r = await run(300, "never");
  assert.equal(r.code, 3);
  assert.ok(r.ms < 10_000, `${r.ms} ms`);
});

test("a supervisor gone ends the wait at once", async () => {
  const r = await run(12_000, "gone");
  assert.equal(r.code, 3);
  assert.ok(r.ms < 10_000, `${r.ms} ms`);
});
