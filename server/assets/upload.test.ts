import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { PassThrough, Readable } from "node:stream";
import { AssetError } from "./errors.ts";
import { tempDir } from "./testImages.ts";
import { receiveToFile, tempFile, type BodyLimits } from "./upload.ts";

let dir: string;
let cleanup: () => Promise<void>;
before(async () => ({ dir, cleanup } = await tempDir()));
after(() => cleanup());

const fast: BodyLimits = { maxBytes: 1024 * 1024, deadlineMs: 5000, minBytesPerSec: 0, graceMs: 10_000, checkEveryMs: 10 };

function refusedWith(status: number, code: string) {
  return (err: unknown) => err instanceof AssetError && err.status === status && err.code === code;
}

describe("receiveToFile", () => {
  test("writes the body and returns its size and SHA-256", async () => {
    const body = Buffer.alloc(200_000, 7);
    const path = tempFile(dir, "intake");
    const got = await receiveToFile(Readable.from([body.subarray(0, 50_000), body.subarray(50_000)]), path, fast);
    assert.equal(got.size, body.length);
    assert.deepEqual(got.sha256, createHash("sha256").update(body).digest());
    assert.deepEqual(await readFile(path), body);
  });

  test("a body over the cap is cut off with 413", async () => {
    const src = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    await assert.rejects(receiveToFile(src, tempFile(dir, "intake"), { ...fast, maxBytes: 1000 }), refusedWith(413, "too_large"));
  });

  test("a body slower than the minimum rate after the grace period is aborted", async () => {
    const src = new PassThrough();
    src.write(Buffer.alloc(10));
    const started = Date.now();
    await assert.rejects(
      receiveToFile(src, tempFile(dir, "intake"), { ...fast, minBytesPerSec: 32 * 1024, graceMs: 100 }),
      refusedWith(408, "too_slow"),
    );
    assert.ok(Date.now() - started < 1000);
  });

  test("a body that keeps a good rate but runs past its deadline is aborted", async () => {
    const src = new PassThrough();
    const timer = setInterval(() => src.write(Buffer.alloc(64 * 1024)), 5);
    try {
      await assert.rejects(
        receiveToFile(src, tempFile(dir, "intake"), { ...fast, maxBytes: 1e9, minBytesPerSec: 1, graceMs: 0, deadlineMs: 150 }),
        refusedWith(408, "too_slow"),
      );
    } finally {
      clearInterval(timer);
    }
  });

  test("an incoming request is paused, not destroyed, so the refusal can still be answered", async () => {
    const src = new PassThrough();
    src.write(Buffer.alloc(2000));
    await assert.rejects(receiveToFile(src, tempFile(dir, "intake"), { ...fast, maxBytes: 1000 }));
    assert.equal(src.destroyed, false);
    assert.equal(src.isPaused(), true);
  });

  test("a fetched body is destroyed when refused", async () => {
    const src = new PassThrough();
    src.write(Buffer.alloc(2000));
    await assert.rejects(receiveToFile(src, tempFile(dir, "fetch"), { ...fast, maxBytes: 1000 }, "destroy"));
    assert.equal(src.destroyed, true);
  });

  test("a client that disconnects mid-body is reported, not hung on", async () => {
    const src = new PassThrough();
    src.write(Buffer.alloc(100));
    setTimeout(() => src.destroy(), 10);
    await assert.rejects(receiveToFile(src, tempFile(dir, "intake"), fast), (err: unknown) => err instanceof AssetError);
  });
});
