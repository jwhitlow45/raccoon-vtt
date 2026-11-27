import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { AssetError } from "./errors.ts";
import { ProcessingQueue, configureSharp, modelSheetFits, processImage, sniffImage } from "./process.ts";
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

/** A sheet of 8 square frames on a clear ground, each with an opaque figure in its middle, made from `create` alone. */
function modelSheet(width: number) {
  const frame = width / 4;
  const figures = Array.from({ length: 8 }, (_, i) => ({
    input: { create: { width: frame / 2, height: (frame * 3) / 4, channels: 4 as const, background: { r: 20 * i, g: 120, b: 200, alpha: 1 } } },
    left: (i % 4) * frame + frame / 4,
    top: Math.floor(i / 4) * frame + frame / 8,
  }));
  return sharp({ create: { width, height: width / 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(figures);
}

/** A clear image of any size, for the shapes a sheet may not have. */
const clear = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });

describe("a 3D model's sheet (docs/design/design-v1-token-models.md 4.3)", () => {
  test("a 2048 wide sheet keeps its size, with mobile and thumbnail copies of 1024 and 512, each WebP at quality 82 with its alpha", async () => {
    const src = await writeImage(dir, "sheet.png", await modelSheet(2048).png().toBuffer());
    const variants = await processImage(src, "model", dir);
    assert.deepEqual(dims(variants), { full: [2048, 1024], mobile: [1024, 512], thumb: [512, 256] });
    for (const v of variants) {
      const bytes = await readFile(v.path);
      const expected = await sharp(src, { limitInputPixels: 100_000_000, failOn: "warning" })
        .autoOrient()
        .resize({ width: v.width, height: v.width, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      assert.ok(bytes.equals(expected), `${v.name}: the pipeline's quality 82 WebP`);
      assert.equal((await sharp(v.path).metadata()).hasAlpha, true, v.name);
      const { data, info } = await sharp(v.path).raw().toBuffer({ resolveWithObject: true });
      const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
      const frame = info.width / 4;
      assert.equal(alphaAt(1, 1), 0, `${v.name}: the clear ground stays clear`);
      assert.equal(alphaAt(Math.floor(frame / 2), Math.floor(frame / 2)), 255, `${v.name}: the figure stays opaque`);
      assert.equal(alphaAt(Math.floor(frame * 3.5), Math.floor(frame * 1.5)), 255, `${v.name}: the last frame's figure`);
    }
  });

  test("1024 and 512 wide sheets are taken as they are, never enlarged", async () => {
    const mid = await writeImage(dir, "sheet-1024.png", await modelSheet(1024).png().toBuffer());
    assert.deepEqual(dims(await processImage(mid, "model", dir)), { full: [1024, 512], mobile: [1024, 512], thumb: [512, 256] });
    const small = await writeImage(dir, "sheet-512.webp", await modelSheet(512).webp().toBuffer());
    assert.deepEqual(dims(await processImage(small, "model", dir)), { full: [512, 256], mobile: [512, 256], thumb: [512, 256] });
  });

  test("any other shape is 422 bad_model_sheet, before a variant is made", async () => {
    for (const [width, height] of [
      [2000, 1000],
      [1536, 512],
      [2048, 1025],
      [2048, 2048],
      [1024, 2048],
      [4096, 2048],
      [256, 128],
      [768, 384],
    ] as const) {
      const src = await writeImage(dir, `bad-${width}x${height}.png`, await clear(width, height).png().toBuffer());
      await assert.rejects(processImage(src, "model", dir), rejectsWith(422, "bad_model_sheet"), `${width} x ${height}`);
    }
  });

  test("the shape is read as drawn: a sheet an EXIF tag turns on its side is refused, and one it turns upright is taken", async () => {
    // Stored 2048 x 1024 with orientation 6 (turned 90 degrees clockwise), so it draws 1024 x 2048.
    const sideways = await writeImage(dir, "sideways.jpg", await solid(2048, 1024).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    await assert.rejects(processImage(sideways, "model", dir), rejectsWith(422, "bad_model_sheet"));
    const upright = await writeImage(dir, "upright.jpg", await solid(1024, 2048).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    assert.deepEqual(dims(await processImage(upright, "model", dir)), { full: [2048, 1024], mobile: [1024, 512], thumb: [512, 256] });
  });

  test("an image that cannot be read is bad_image as before, and other kinds take any shape", async () => {
    const png = await modelSheet(512).png().toBuffer();
    const garbage = await writeImage(dir, "sheet-garbage.png", Buffer.concat([png.subarray(0, 40), Buffer.alloc(500, 7)]));
    await assert.rejects(processImage(garbage, "model", dir), rejectsWith(422, "bad_image"));
    const odd = await writeImage(dir, "odd-token.png", await clear(2000, 1000).png().toBuffer());
    assert.deepEqual(dims(await processImage(odd, "token", dir)), { full: [512, 256], thumb: [128, 64] });
  });

  test("modelSheetFits takes exactly 2:1 at 512, 1024 and 2048 wide", () => {
    assert.deepEqual([512, 1024, 2048].map((w) => modelSheetFits(w, w / 2)), [true, true, true]);
    for (const [w, h] of [
      [2048, 1023],
      [2047, 1024],
      [1024, 1024],
      [256, 128],
      [4096, 2048],
      [0, 0],
      [Number.NaN, Number.NaN],
    ]) {
      assert.equal(modelSheetFits(w!, h!), false, `${w} x ${h}`);
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
