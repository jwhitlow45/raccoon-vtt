import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AssetError } from "../errors.ts";
import { Budget, BufferSource, EditIntoMediaError, Edits, FileWindow, Tally, WINDOW_BYTES } from "./window.ts";

/** The header check's reads and edits (docs/design/design-v1-animated-maps.md 10). */

const badVideo = (err: unknown) => err instanceof AssetError && err.code === "bad_video";

test("no edit may reach into the media data, whatever the parser asked for", () => {
  const edits = new Edits();
  edits.protect(10, 20);
  edits.zero(0, 10);
  edits.put(20, Buffer.from([1, 2]));
  assert.deepEqual([...edits.applyTo(Buffer.alloc(30, 9)).subarray(8, 23)], [0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 1, 2, 9]);
  edits.zero(19, 21);
  assert.throws(() => edits.applyTo(Buffer.alloc(30)), EditIntoMediaError);
  const put = new Edits();
  put.protect(10, 20);
  put.put(8, Buffer.from([1, 2, 3]));
  assert.throws(() => put.applyTo(Buffer.alloc(30)), EditIntoMediaError);
});

test("edits land in a file in place, zeroes first, keeping its length", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rvtt-window-"));
  try {
    const path = join(dir, "v");
    await writeFile(path, Buffer.alloc(WINDOW_BYTES * 2 + 5, 7));
    const edits = new Edits();
    edits.zero(3, WINDOW_BYTES * 2);
    edits.put(3, Buffer.from([0xec, 0x81]));
    await edits.applyToFile(path);
    const after = await readFile(path);
    assert.equal(after.length, WINDOW_BYTES * 2 + 5);
    assert.deepEqual([...after.subarray(0, 6)], [7, 7, 7, 0xec, 0x81, 0]);
    assert.ok(after.subarray(5, WINDOW_BYTES * 2).every((b) => b === 0));
    assert.ok(after.subarray(WINDOW_BYTES * 2).every((b) => b === 7));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a read past the end, or longer than a window, is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rvtt-window-"));
  try {
    const path = join(dir, "v");
    await writeFile(path, Buffer.alloc(WINDOW_BYTES + 100, 1));
    const window = await FileWindow.open(path, new Budget());
    try {
      assert.equal((await window.read(WINDOW_BYTES, 100)).length, 100);
      await assert.rejects(window.read(WINDOW_BYTES, 101), badVideo);
      await assert.rejects(window.read(-1, 1), badVideo);
      await assert.rejects(window.read(0, WINDOW_BYTES + 1), /one window/);
      assert.equal((await window.readAll(0, WINDOW_BYTES + 100)).length, WINDOW_BYTES + 100);
    } finally {
      await window.close();
    }
    await assert.rejects(new BufferSource(Buffer.alloc(4)).read(2, 3), badVideo);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a spent budget and a count past its cap refuse with their codes", () => {
  let now = 0;
  const budget = new Budget(5_000, () => now);
  budget.check();
  now = 5_001;
  assert.throws(() => budget.check(), badVideo);
  const frames = new Tally(2, "video_fps");
  frames.add(2);
  assert.throws(() => frames.add(), (err: unknown) => err instanceof AssetError && err.code === "video_fps");
});
