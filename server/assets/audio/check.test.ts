import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SOUND_LIMITS } from "#shared/limits.ts";
import { concat, framesFor, id3v1, silentFrames, withTagFrame } from "#shared/audio/mp3Testutil.ts";
import { AssetError } from "../errors.ts";
import { checkSound, checkSoundBytes, soundFactsOf, walkInWorker } from "./check.ts";

/**
 * The server's sound check (docs/design/design-v1-sound.md 7.1, D-261102-539):
 * the walk in a worker, with its budget inside the worker and a deadline
 * that ends the worker, refusals by the walk's codes, and every other
 * failure passing through as itself.
 */

const HANG = new URL("./hangWorker.testutil.ts", import.meta.url);
const THROW = new URL("./throwWorker.testutil.ts", import.meta.url);

function refusedWith(status: number, code: string) {
  return (err: unknown) => err instanceof AssetError && err.status === status && err.code === code;
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "rvtt-sound-check-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkSound", () => {
  test("a file the walk takes gives its facts as the row keeps them", async () => {
    const path = join(dir, "ok.mp3");
    await writeFile(path, withTagFrame(silentFrames(framesFor(5_000, 48_000), { rateHz: 48_000, kbps: 96, mode: 3 })));
    // 209 frames at 48 kHz are 5,016 ms, and 77 at 44.1 kHz 2,011 ms.
    assert.deepEqual(await checkSound(path), { ms: 5016, channels: 1, kbps: 96 });
    assert.deepEqual(await checkSoundBytes(silentFrames(framesFor(2_000))), { ms: 2011, channels: 2, kbps: 128 });
  });

  test("the walk's refusals: another form is 415 sound_type, the wrong length 422 sound_length", async () => {
    await assert.rejects(checkSoundBytes(concat(silentFrames(40), id3v1())), refusedWith(415, "sound_type"));
    await assert.rejects(checkSoundBytes(silentFrames(4)), refusedWith(422, "sound_length"));
    await assert.rejects(checkSoundBytes(new TextEncoder().encode("<html>not a sound</html>")), refusedWith(415, "sound_type"));
    const empty = join(dir, "empty.mp3");
    await writeFile(empty, new Uint8Array(0));
    await assert.rejects(checkSound(empty), refusedWith(415, "sound_type"));
  });

  test("a file over 24 MiB is 413 before a byte reaches the worker", async () => {
    await assert.rejects(checkSoundBytes(new Uint8Array(SOUND_LIMITS.fileBytes + 1), { workerUrl: THROW }), refusedWith(413, "too_large"));
  });

  test("a read that fails passes through as itself, never as a refusal of the file", async () => {
    await assert.rejects(checkSound(join(dir, "missing.mp3")), (err: unknown) => !(err instanceof AssetError) && (err as NodeJS.ErrnoException).code === "ENOENT");
    await assert.rejects(checkSound(dir), (err: unknown) => !(err instanceof AssetError));
  });

  test("a walk past its budget inside the worker is busy, not a refusal of the file", async () => {
    await assert.rejects(checkSoundBytes(silentFrames(framesFor(60_000)), { budgetMs: 0 }), refusedWith(503, "busy"));
  });

  test("a worker that never answers is ended at the deadline, while the main thread keeps answering", async () => {
    let ticks = 0;
    const clock = setInterval(() => void ticks++, 10);
    const started = performance.now();
    try {
      assert.deepEqual(await walkInWorker(silentFrames(40), { workerUrl: HANG, deadlineMs: 400 }), { kind: "budget" });
    } finally {
      clearInterval(clock);
    }
    const took = performance.now() - started;
    assert.ok(took >= 390 && took < 3_000, `${took} ms`);
    // The worker's thread spun the whole time, and the main thread's timer still ran about every 10 ms.
    assert.ok(ticks >= 20, `${ticks} ticks`);
    await assert.rejects(checkSoundBytes(silentFrames(40), { workerUrl: HANG, deadlineMs: 200 }), refusedWith(503, "busy"));
  });

  test("a worker that dies is the server's own error, never sound_type", async () => {
    await assert.rejects(checkSoundBytes(silentFrames(40), { workerUrl: THROW }), (err: unknown) => !(err instanceof AssetError) && /stand-in worker failed/.test(String(err)));
  });

  test("the walked facts are held to the bounds every reader holds a row to", () => {
    const fine = { rateHz: 44_100, kbps: 128, channels: 2 as const, frames: 100, ms: 2612 };
    assert.deepEqual(soundFactsOf(fine), { ms: 2612, channels: 2, kbps: 128 });
    for (const bad of [{ ms: 199 }, { ms: SOUND_LIMITS.fileMaxMs + 1 }, { ms: 2612.5 }, { kbps: 224 }, { kbps: 100 }, { channels: 3 as never }, { rateHz: 32_000 }]) {
      assert.throws(() => soundFactsOf({ ...fine, ...bad }), refusedWith(415, "sound_type"), JSON.stringify(bad));
    }
  });
});
