import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AssetKind, Variant } from "./kinds.ts";
import { KeyedMutex } from "./locks.ts";
import { purgeTrash, storedVideo, toView, trashDay, trashPath, variantFileName, variantPath, videoFactsOf } from "./store.ts";
import { tempDir } from "./testImages.ts";

const SHA = "ab" + "0123456789abcdef".repeat(3) + "0123456789abcd";

describe("file naming", () => {
  test("files are named by content, kind, variant and pipeline under a two-character folder", () => {
    assert.equal(SHA.length, 64);
    assert.equal(variantFileName(SHA, "map", "mobile", 1), `${SHA}-map-mobile-v1.webp`);
    assert.equal(variantPath("/data/assets", SHA, "token", "thumb", 3), join("/data/assets", "ab", `${SHA}-token-thumb-v3.webp`));
  });

  test("the same bytes as a map and as a token give different files", () => {
    assert.notEqual(variantFileName(SHA, "map", "full", 1), variantFileName(SHA, "token", "full", 1));
  });

  test("a video keeps its real extension, from its row's container, and an image never takes one (D-261102-454)", () => {
    assert.equal(variantFileName(SHA, "video", "full", 1, "webm"), `${SHA}-video-full-v1.webm`);
    assert.equal(variantFileName(SHA, "video", "full", 2, "mp4"), `${SHA}-video-full-v2.mp4`);
    assert.equal(trashPath("/data/assets", new Date("2026-11-02T12:00:00Z"), SHA, "video", "full", 1, "mp4"), join("/data/assets", "trash", "2026-11-02", "ab", `${SHA}-video-full-v1.mp4`));
    assert.throws(() => variantFileName(SHA, "video", "full", 1));
    assert.throws(() => variantFileName(SHA, "video", "full", 1, "mov" as "mp4"));
    assert.throws(() => variantFileName(SHA, "map", "full", 1, "webm"));
  });

  test("anything that is not a clean part is refused before it becomes a path", () => {
    assert.throws(() => variantFileName("../../etc/passwd", "map", "full", 1));
    assert.throws(() => variantFileName(SHA.toUpperCase(), "map", "full", 1));
    assert.throws(() => variantFileName(SHA, "map/../x" as AssetKind, "full", 1));
    assert.throws(() => variantFileName(SHA, "map", "original" as Variant, 1));
    assert.throws(() => variantFileName(SHA, "map", "full", 0));
    assert.throws(() => variantFileName(SHA, "map", "full", 1.5));
  });
});

describe("a video row's facts", () => {
  const facts = { widthPx: 640, heightPx: 360, container: "webm" as const, video: "vp09.00.21.08", audio: "opus", fps: 30, durationMs: 2001, kbps: 11, audioChannels: 2, audioHz: 48000 };

  test("the row keeps them without the size and container, and gives them back whole", () => {
    const row = { id: "x", kind: "video" as const, width: 640, height: 360, variants: ["full" as const], media: "webm" as const, video: storedVideo(facts) };
    assert.deepEqual(row.video, { video: "vp09.00.21.08", audio: "opus", fps: 30, durationMs: 2001, kbps: 11, audioChannels: 2, audioHz: 48000 });
    assert.deepEqual(videoFactsOf(row), facts);
    assert.deepEqual(toView(row).video, facts);
  });

  test("a turned, mirrored and stretched video's row keeps how to draw it, and gives it back (docs/design/design-v1-video-turns.md 6.1)", () => {
    const turned = { ...facts, turn: 90 as const, mirror: true as const, displayWidthPx: 853 };
    const row = { id: "x", kind: "video" as const, width: 640, height: 360, variants: ["full" as const], media: "webm" as const, video: storedVideo(turned) };
    assert.deepEqual(row.video, { video: "vp09.00.21.08", audio: "opus", fps: 30, durationMs: 2001, kbps: 11, audioChannels: 2, audioHz: 48000, turn: 90, mirror: true, displayWidthPx: 853 });
    assert.deepEqual(videoFactsOf(row), turned);
    assert.deepEqual(toView(row).video, turned);
    // Each field only as the protocol takes it.
    for (const bad of [{ turn: 45 }, { turn: 0 }, { mirror: false }, { displayWidthPx: 853.5 }, { displayWidthPx: 255 }, { displayWidthPx: 4097 }]) {
      assert.equal(videoFactsOf({ ...row, video: { ...row.video, ...bad } }), undefined, JSON.stringify(bad));
    }
  });

  test("an image row, or a video row whose columns do not read, gives none", () => {
    assert.equal(videoFactsOf({ kind: "map", width: 1, height: 1, media: null, video: null }), undefined);
    assert.equal(videoFactsOf({ kind: "video", width: 1, height: 1, media: "webm", video: { video: "vp8", fps: 30, durationMs: 1000, kbps: 1, note: "x" } }), undefined);
    assert.equal(videoFactsOf({ kind: "video", width: 1, height: 1, media: "avi" as "webm", video: storedVideo(facts) }), undefined);
  });
});

describe("KeyedMutex", () => {
  test("serializes sections on one key and runs other keys freely", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const section = (key: string, name: string, ms: number) =>
      mutex.run(key, async () => {
        log.push(`${name}+`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}-`);
      });
    await Promise.all([section("a", "a1", 20), section("a", "a2", 1), section("b", "b1", 1)]);
    assert.deepEqual(log.indexOf("a1-") < log.indexOf("a2+"), true);
    assert.ok(log.indexOf("b1-") < log.indexOf("a1-"));
    assert.equal(mutex.activeKeys, 0);
  });

  test("a failing section releases the lock", async () => {
    const mutex = new KeyedMutex();
    await assert.rejects(mutex.run("k", async () => Promise.reject(new Error("boom"))));
    assert.equal(await mutex.run("k", async () => "next"), "next");
  });
});

describe("the trash", () => {
  test("a deleted file keeps its own path below its UTC day", () => {
    assert.equal(trashDay(new Date("2026-10-14T23:30:00-05:00")), "2026-10-15");
    assert.equal(
      trashPath("/data/assets", new Date("2026-10-14T12:00:00Z"), SHA, "token", "full", 1),
      join("/data/assets", "trash", "2026-10-14", "ab", `${SHA}-token-full-v1.webp`),
    );
  });

  test("a day is purged only once its last moment is 48 hours past, and nothing else in the trash is touched", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      for (const day of ["2026-10-10", "2026-10-11", "2026-10-12", "notes"]) {
        await mkdir(join(dir, "trash", day, "ab"), { recursive: true });
        await writeFile(join(dir, "trash", day, "ab", "f.webp"), "x");
      }
      await writeFile(join(dir, "trash", "readme.txt"), "x");
      // 2026-10-11 ends at 2026-10-12T00:00Z, so it goes at 2026-10-14T00:00Z and not a moment before.
      assert.deepEqual(await purgeTrash(dir, Date.parse("2026-10-13T23:59:59Z")), ["2026-10-10"]);
      assert.deepEqual(await purgeTrash(dir, Date.parse("2026-10-14T00:00:00Z")), ["2026-10-11"]);
      assert.deepEqual((await readdir(join(dir, "trash"))).sort(), ["2026-10-12", "notes", "readme.txt"]);
      assert.deepEqual(await purgeTrash(join(dir, "missing")), []);
    } finally {
      await cleanup();
    }
  });
});
