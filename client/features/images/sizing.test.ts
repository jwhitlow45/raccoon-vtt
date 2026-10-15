import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { api } from "../../lib/api.ts";
import { imageErrorMessage, isQuotaError } from "./errors.ts";
import { TOKEN_UPLOAD_MAX_PX, fitWithin, outputType, smaller } from "./sizing.ts";
import { isThumbnailUrl } from "#shared/searchThumbnails.ts";
import { checkImageFile, checkImageUrl, PickError } from "./upload.ts";

describe("downscale size math", () => {
  test("the long side becomes 1024 and the aspect ratio holds", () => {
    assert.deepEqual(fitWithin(4032, 3024, TOKEN_UPLOAD_MAX_PX), { width: 1024, height: 768 });
    assert.deepEqual(fitWithin(3024, 4032, TOKEN_UPLOAD_MAX_PX), { width: 768, height: 1024 });
    assert.deepEqual(fitWithin(5000, 5000, TOKEN_UPLOAD_MAX_PX), { width: 1024, height: 1024 });
  });

  test("an image that already fits is left alone, never enlarged", () => {
    assert.equal(fitWithin(1024, 600, TOKEN_UPLOAD_MAX_PX), null);
    assert.equal(fitWithin(300, 300, TOKEN_UPLOAD_MAX_PX), null);
  });

  test("extreme shapes keep at least one pixel", () => {
    assert.deepEqual(fitWithin(100_000, 10, TOKEN_UPLOAD_MAX_PX), { width: 1024, height: 1 });
    assert.deepEqual(fitWithin(1025, 1, TOKEN_UPLOAD_MAX_PX), { width: 1024, height: 1 });
  });

  test("unreadable sizes do nothing", () => {
    assert.equal(fitWithin(0, 100, 1024), null);
    assert.equal(fitWithin(Number.NaN, 2000, 1024), null);
    assert.equal(fitWithin(2000, Number.POSITIVE_INFINITY, 1024), null);
  });

  test("photos stay JPEG, anything that may have alpha asks for WebP", () => {
    assert.equal(outputType("image/jpeg"), "image/jpeg");
    assert.equal(outputType("image/png"), "image/webp");
    assert.equal(outputType("image/webp"), "image/webp");
    assert.equal(outputType("image/gif"), "image/webp");
  });

  test("the smaller file wins", () => {
    assert.equal(smaller({ size: 10 }, { size: 5 }).size, 5);
    assert.equal(smaller({ size: 10 }, { size: 50 }).size, 10);
    assert.equal(smaller({ size: 10 }, null).size, 10);
    assert.equal(smaller({ size: 10 }, { size: 0 }).size, 10);
  });
});

describe("what the picker accepts", () => {
  test("images only, and never SVG", () => {
    checkImageFile(new Blob(["x"], { type: "image/png" }));
    assert.throws(() => checkImageFile(new Blob(["x"], { type: "image/svg+xml" })), PickError);
    assert.throws(() => checkImageFile(new Blob(["x"], { type: "text/plain" })), PickError);
  });

  test("https links only", () => {
    assert.equal(checkImageUrl(" https://example.com/goblin.png "), "https://example.com/goblin.png");
    assert.throws(() => checkImageUrl("http://example.com/a.png"), /https/);
    assert.throws(() => checkImageUrl("goblin.png"), /https/);
    assert.throws(() => checkImageUrl(`https://example.com/${"a".repeat(3000)}`), /too long/);
  });

  test("thumbnails only from the search thumbnail hosts", () => {
    assert.equal(isThumbnailUrl("https://serpapi.com/searches/abc/images/1.jpeg"), true);
    assert.equal(isThumbnailUrl("https://encrypted-tbn0.gstatic.com/images?q=tbn:abc"), true);
    assert.equal(isThumbnailUrl("https://encrypted-tbn9.gstatic.com/images?q=tbn:abc"), false);
    assert.equal(isThumbnailUrl("https://www.gstatic.com/images?q=tbn:abc"), false);
    assert.equal(isThumbnailUrl("https://evil.example/serpapi.com.jpeg"), false);
    assert.equal(isThumbnailUrl("http://serpapi.com/a.jpeg"), false);
    assert.equal(isThumbnailUrl("nonsense"), false);
  });
});

describe("refusals in plain words", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  test("each search quota names itself and points at the other ways", async () => {
    for (const [code, words] of [
      ["quota_member", /your 20 image searches in this room/i],
      ["quota_room", /this room/i],
      ["quota_ip", /this network/i],
      ["quota_global", /server's image searches/i],
    ] as const) {
      answer(429, { error: code });
      const err = await api.imageSearch("ABCD2345", "goblin").catch((e: unknown) => e);
      assert.equal(isQuotaError(err), true, code);
      assert.match(imageErrorMessage(err), words);
      assert.match(imageErrorMessage(err), /upload, paste or use an image link/);
    }
  });

  test("upload refusals", async () => {
    answer(413, { error: "too_large" });
    const err = await api.uploadAsset("ABCD2345", "token", new Blob(["x"], { type: "image/png" })).catch((e: unknown) => e);
    assert.match(imageErrorMessage(err), /up to 10 MB/);
    assert.equal(isQuotaError(err), false);
  });

  test("an unknown code falls back to the status's own words", async () => {
    answer(400, { error: "something_new" });
    const err = await api.importAsset("ABCD2345", { url: "https://example.com/a.png", kind: "token" }).catch((e: unknown) => e);
    assert.equal(imageErrorMessage(err), "That request was not valid.");
  });
});
