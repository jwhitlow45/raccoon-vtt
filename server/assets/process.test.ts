import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { AssetError } from "./errors.ts";
import { ProcessingQueue, configureSharp, processImage, sniffImage } from "./process.ts";
import { SVG, checkerboardPng, hugeHeaderPng, solid, tempDir, withPngChunk, writeImage } from "./testImages.ts";

let dir: string;
let cleanup: () => Promise<void>;

before(async () => {
  ({ dir, cleanup } = await tempDir());
  configureSharp();
});
after(() => cleanup());

function rejectsWith(status: number, code: string) {
  return (err: unknown) => err instanceof AssetError && err.status === status && err.code === code;
}

function dims(variants: Array<{ name: string; width: number; height: number }>) {
  return Object.fromEntries(variants.map((v) => [v.name, [v.width, v.height]]));
}

describe("processImage variants", () => {
  test("a large map gets full, mobile and thumb within 8192, 4096 and 512", async () => {
    const src = await writeImage(dir, "map.jpg", await solid(9000, 4500).jpeg().toBuffer());
    const variants = await processImage(src, "map", dir);
    assert.deepEqual(dims(variants), { full: [8192, 4096], mobile: [4096, 2048], thumb: [512, 256] });
    for (const v of variants) {
      const head = await readFile(v.path);
      assert.equal(head.subarray(0, 4).toString("latin1"), "RIFF");
      assert.equal(head.subarray(8, 12).toString("latin1"), "WEBP");
      assert.equal(v.bytes, head.length);
    }
  });

  test("a token gets full within 512 and thumb within 128", async () => {
    const src = await writeImage(dir, "token.png", await solid(1000, 500).png().toBuffer());
    assert.deepEqual(dims(await processImage(src, "token", dir)), { full: [512, 256], thumb: [128, 64] });
  });

  test("a handout gets full within 2048 and thumb within 512, never enlarged", async () => {
    const big = await writeImage(dir, "handout.webp", await solid(3000, 1500).webp().toBuffer());
    assert.deepEqual(dims(await processImage(big, "handout", dir)), { full: [2048, 1024], thumb: [512, 256] });
    const small = await writeImage(dir, "small.png", await solid(300, 200).png().toBuffer());
    assert.deepEqual(dims(await processImage(small, "handout", dir)), { full: [300, 200], thumb: [300, 200] });
  });

  test("a scene thumbnail gets only full, within 320", async () => {
    const src = await writeImage(dir, "scene.webp", await solid(640, 400).webp().toBuffer());
    assert.deepEqual(dims(await processImage(src, "thumb", dir)), { full: [320, 200] });
  });

  test("GIF and AVIF are accepted", async () => {
    const gif = await writeImage(dir, "a.gif", await solid(64, 32).gif().toBuffer());
    const avif = await writeImage(dir, "a.avif", await solid(64, 32).avif().toBuffer());
    assert.equal(await sniffImage(gif), "gif");
    assert.equal(await sniffImage(avif), "avif");
    assert.deepEqual(dims(await processImage(gif, "token", dir)), { full: [64, 32], thumb: [64, 32] });
    assert.deepEqual(dims(await processImage(avif, "token", dir)), { full: [64, 32], thumb: [64, 32] });
  });

  test("EXIF orientation is applied before resizing", async () => {
    // Stored 40 x 20 with orientation 6 (rotate 90 degrees clockwise), so it displays 20 x 40.
    const src = await writeImage(dir, "phone.jpg", await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    assert.deepEqual(dims(await processImage(src, "token", dir)), { full: [20, 40], thumb: [20, 40] });
  });

  test("metadata such as EXIF is not carried into the output", async () => {
    const src = await writeImage(
      dir,
      "exif.jpg",
      await solid(40, 20).jpeg().withExif({ IFD0: { Copyright: "SECRET-EXIF-MARKER" } }).toBuffer(),
    );
    assert.ok((await readFile(src)).includes("SECRET-EXIF-MARKER"));
    for (const v of await processImage(src, "token", dir)) {
      assert.ok(!(await readFile(v.path)).includes("SECRET-EXIF-MARKER"));
    }
  });
});

describe("refusals", () => {
  test("SVG is refused by the magic-byte check and by sharp itself", async () => {
    const src = await writeImage(dir, "x.svg", SVG);
    await assert.rejects(sniffImage(src), rejectsWith(415, "unsupported_type"));
    await assert.rejects(processImage(src, "token", dir), rejectsWith(422, "bad_image"));
  });

  test("a format outside the five, such as TIFF, is refused by both layers", async () => {
    const src = await writeImage(dir, "x.tiff", await solid(32, 32).tiff().toBuffer());
    await assert.rejects(sniffImage(src), rejectsWith(415, "unsupported_type"));
    await assert.rejects(processImage(src, "token", dir), rejectsWith(422, "bad_image"));
  });

  test("a truncated JPEG is refused instead of half-decoded", async () => {
    const jpg = await solid(256, 256).jpeg().toBuffer();
    const src = await writeImage(dir, "cut.jpg", jpg.subarray(0, jpg.length >> 1));
    assert.equal(await sniffImage(src), "jpg");
    await assert.rejects(processImage(src, "token", dir), rejectsWith(422, "bad_image"));
  });

  test("a PNG header followed by garbage is refused", async () => {
    const png = await solid(256, 256).png().toBuffer();
    const src = await writeImage(dir, "garbage.png", Buffer.concat([png.subarray(0, 40), Buffer.alloc(500, 7)]));
    assert.equal(await sniffImage(src), "png");
    await assert.rejects(processImage(src, "token", dir), rejectsWith(422, "bad_image"));
  });

  test("an image over 100 million pixels is refused before decoding", async () => {
    const src = await writeImage(dir, "bomb.png", hugeHeaderPng(20_000, 20_000));
    await assert.rejects(processImage(src, "map", dir), (err: unknown) => {
      return rejectsWith(422, "bad_image")(err) && /pixel limit/.test(String((err as Error).cause));
    });
  });

  test("only file input is decoded: buffer loaders stay blocked", async () => {
    const png = await solid(8, 8).png().toBuffer();
    await assert.rejects(sharp(png).metadata(), /unsupported image format/);
  });

  test("an HTML page is not an image", async () => {
    const src = await writeImage(dir, "page.png", Buffer.from("<!doctype html><script>alert(1)</script>"));
    await assert.rejects(sniffImage(src), rejectsWith(415, "unsupported_type"));
  });
});

describe("polyglots", () => {
  test("markup hidden in a PNG text chunk and after IEND does not survive re-encoding", async () => {
    const payload = Buffer.from("<html><script>alert(document.cookie)</script></html>");
    const png = await solid(64, 32).png().toBuffer();
    const poly = Buffer.concat([withPngChunk(png, "tEXt", Buffer.concat([Buffer.from("Comment\0"), payload])), payload]);
    const src = await writeImage(dir, "poly.png", poly);
    assert.equal(await sniffImage(src), "png");
    const variants = await processImage(src, "token", dir);
    for (const v of variants) {
      const out = await readFile(v.path);
      assert.ok(!out.includes("<script>"));
      assert.equal(out.subarray(8, 12).toString("latin1"), "WEBP");
    }
  });

  test("variants can be much larger than the upload", async () => {
    const png = await checkerboardPng(1024);
    const src = await writeImage(dir, "checker.png", png);
    const variants = await processImage(src, "map", dir);
    const total = variants.reduce((sum, v) => sum + v.bytes, 0);
    assert.ok(total > png.length * 10, `variants ${total} vs upload ${png.length}`);
  });
});

describe("ProcessingQueue", () => {
  test("runs one job at a time in order", async () => {
    const queue = new ProcessingQueue(8);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (n: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      running--;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4].map((n) => queue.run(job(n))));
    assert.deepEqual(results, [1, 2, 3, 4]);
    assert.deepEqual(order, [1, 2, 3, 4]);
    assert.equal(peak, 1);
  });

  test("answers 503 with Retry-After beyond its size", async () => {
    const queue = new ProcessingQueue(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = queue.run(() => gate);
    const second = queue.run(async () => undefined);
    await assert.rejects(queue.run(async () => undefined), (err: unknown) => {
      return err instanceof AssetError && err.status === 503 && err.retryAfter !== undefined;
    });
    release();
    await Promise.all([first, second]);
    assert.equal(queue.size, 0);
  });

  test("live jobs go ahead of queued background jobs", async () => {
    const queue = new ProcessingQueue(8);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const head = queue.run(() => gate);
    const bg1 = queue.run(async () => void order.push("bg1"), { background: true });
    const bg2 = queue.run(async () => void order.push("bg2"), { background: true });
    const live = queue.run(async () => void order.push("live"));
    release();
    await Promise.all([head, bg1, bg2, live]);
    assert.deepEqual(order, ["live", "bg1", "bg2"]);
  });

  test("a failed job does not stall the queue", async () => {
    const queue = new ProcessingQueue(8);
    const failing = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => "ok");
    await assert.rejects(failing, /boom/);
    assert.equal(await next, "ok");
  });
});
