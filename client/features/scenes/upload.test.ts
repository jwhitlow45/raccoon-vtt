import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { uploadErrorText, uploadMap } from "./upload.ts";
import { ApiError } from "../../lib/api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("map upload", () => {
  test("sends the file as it is, with its name for the grid hint, and reads the hint back", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "a1", kind: "map", width: 3000, height: 2000, variants: ["full", "mobile", "thumb"], cellPx: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const bytes = new Uint8Array(5000);
    const file = new File([bytes], "crypt_30x20.jpg", { type: "image/jpeg" });
    const asset = await uploadMap("ROOM1234", file);
    assert.deepEqual(asset, { id: "a1", width: 3000, height: 2000, cellPx: 100 });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, "/api/rooms/ROOM1234/assets?kind=map&name=crypt_30x20.jpg");
    assert.equal(call.init.method, "PUT");
    // Full size: the very bytes picked, no canvas re-encode.
    assert.equal((call.init.body as Blob).size, 5000);
    assert.equal((call.init.headers as Record<string, string>)["content-type"], "image/jpeg");
  });

  test("a file with no type still goes up as an image", async () => {
    let type = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      type = (init.headers as Record<string, string>)["content-type"] ?? "";
      return new Response(JSON.stringify({ id: "a2", kind: "map", width: 10, height: 10, variants: ["full"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const asset = await uploadMap("ROOM1234", new File([new Uint8Array(10)], "map"));
    assert.equal(type, "image/jpeg");
    assert.equal(asset.cellPx, undefined);
  });

  test("refusals read as plain sentences", () => {
    assert.match(uploadErrorText(new ApiError(415, "x", "unsupported_type", null)), /not an image/);
    assert.match(uploadErrorText(new ApiError(413, "x", "too_large", null)), /32 MB/);
    assert.equal(uploadErrorText(new ApiError(403, "You do not have access to that.", undefined, null)), "You do not have access to that.");
  });
});
