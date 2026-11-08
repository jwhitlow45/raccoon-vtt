import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AssetError } from "../errors.ts";
import { checkVideo, checkVideoBytes } from "./check.ts";
import { webmFile, webmWithSecrets, encodeWebm, SECRETS } from "./videoTestutil.ts";

/**
 * The header check in its worker thread (D-261102-539): it answers as the
 * check in this thread does, keeps the server's event loop free while it
 * runs, is ended at its deadline, and lets a disk's error through as one
 * (AM-R1-06).
 */

const dir = await mkdtemp(join(tmpdir(), "rvtt-check-worker-"));
after(() => rm(dir, { recursive: true, force: true }));

/** The longest the main thread went without running a 5 ms timer while `run` ran. */
async function longestStall<T>(run: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; stallMs: number; ticks: number }> {
  let last = performance.now();
  let stallMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
    ticks++;
  }, 5);
  const [result] = await Promise.allSettled([run()]);
  clearInterval(timer);
  return { result, stallMs: Math.max(stallMs, performance.now() - last), ticks };
}

describe("the check in a worker thread", () => {
  test("gives the facts and zeroes the file on disk as the check in memory does", async () => {
    const bytes = encodeWebm(webmWithSecrets());
    const path = join(dir, "secrets.webm");
    await writeFile(path, bytes);
    const facts = await checkVideo(path);
    const here = await checkVideoBytes(bytes);
    assert.deepEqual(facts, here.facts);
    const stored = await readFile(path);
    assert.ok(stored.equals(here.zeroed));
    assert.equal(stored.includes(SECRETS.title), false);
  });

  test("a refusal crosses as the same AssetError", async () => {
    const path = join(dir, "short.webm");
    await writeFile(path, webmFile({ frameMs: [0, 33, 66], durationMs: 500 }));
    await assert.rejects(checkVideo(path), (err: unknown) => err instanceof AssetError && err.status === 422 && err.code === "video_length");
  });

  test("a check that never reads its budget is ended at the deadline while the main thread keeps answering", { timeout: 20_000 }, async () => {
    const path = join(dir, "stall.webm");
    await writeFile(path, webmFile());
    const started = performance.now();
    const { result, stallMs, ticks } = await longestStall(() => checkVideo(path, { budgetMs: 1_500, worker: new URL("./stallWorker.testutil.ts", import.meta.url) }));
    const took = performance.now() - started;
    assert.equal(result.status, "rejected");
    const err = (result as PromiseRejectedResult).reason;
    assert.ok(err instanceof AssetError && err.code === "bad_video", String(err));
    assert.ok(took >= 1_500 && took < 6_000, `ended after ${Math.round(took)} ms`);
    // A main thread that ran the check would stall for all of it. A busy machine may delay a timer, never by that much.
    assert.ok(ticks > 50, `the main thread ran its timer ${ticks} times`);
    assert.ok(stallMs < 600, `the main thread stalled ${Math.round(stallMs)} ms`);
  });

  test("a disk's error reaches the caller as itself, not as an unreadable video (AM-R1-06)", async () => {
    await assert.rejects(checkVideo(join(dir, "missing.webm")), (err: unknown) => !(err instanceof AssetError) && (err as NodeJS.ErrnoException).code === "ENOENT");
  });

  // Root reads and writes through a 0o000 or 0o444 mode, so these two cases cannot fail as asked (AMBUILD-OPUS-R2-01).
  test("a file the check may not open or write fails as its own error, not as an unreadable video (AM-R1-06)", { skip: process.getuid?.() === 0 }, async () => {
    // A file the sniff may not open fails inside the guard that turns a parse's errors into bad_video, and still passes as itself.
    const unreadable = join(dir, "unreadable.webm");
    await writeFile(unreadable, webmFile());
    await chmod(unreadable, 0o000);
    await assert.rejects(checkVideo(unreadable), (err: unknown) => !(err instanceof AssetError) && ["EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? ""));
    // A file the check may read but not write fails at the zeroing, after the parse passed.
    const path = join(dir, "readonly.webm");
    await writeFile(path, encodeWebm(webmWithSecrets()));
    await chmod(path, 0o444);
    await assert.rejects(checkVideo(path), (err: unknown) => !(err instanceof AssetError) && ["EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? ""));
  });
});
