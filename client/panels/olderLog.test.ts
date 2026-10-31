import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../lib/api.ts";
import { logPage, NEWER_LOG_FAILED, OLDER_LOG_FAILED, pageErrorText } from "./olderLog.ts";

/**
 * The Log panel's older pages (docs/design-v1-per-player-vision.md 7.4,
 * D-261026-10, review PV4-OP-1 and PV4-OP-2): in "view as a player" they
 * are asked for as that player, and refused unless the server says it
 * answered as that player, as the preview's socket refuses any other
 * snapshot.
 */

async function withServer<T>(answer: Record<string, unknown>, body: (urls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ entries: [], nextBefore: null, ...answer }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await body(urls);
  } finally {
    globalThis.fetch = original;
  }
}

describe("the Log panel's older pages", () => {
  test("in a preview, asked for as the player and taken when answered as them", async () => {
    await withServer({ as: "m 1" }, async (urls) => {
      const page = await logPage("ABCD2345", { before: "9:0" }, { sceneId: null, previewOf: "m 1" });
      assert.equal(page.as, "m 1");
      assert.deepEqual(urls, ["/api/rooms/ABCD2345/log?before=9%3A0&as=m+1"]);
    });
  });

  test("in a preview, refused when the server names no one, or someone else, as a server that ignores `as` answers", async () => {
    for (const answer of [{}, { as: "dm1" }, { as: "m 2" }]) {
      await withServer(answer, async () => {
        await assert.rejects(logPage("ABCD2345", { before: "9:0" }, { sceneId: null, previewOf: "m 1" }), { message: OLDER_LOG_FAILED }, JSON.stringify(answer));
        await assert.rejects(logPage("ABCD2345", { after: "9:0" }, { sceneId: null, previewOf: "m 1" }), { message: NEWER_LOG_FAILED }, JSON.stringify(answer));
      });
    }
    assert.equal(OLDER_LOG_FAILED, "Could not load older messages.");
  });

  test("a DM's own pages name the scene on screen, ask as no one and need no answer", async () => {
    await withServer({}, async (urls) => {
      await logPage("ABCD2345", { before: "9:0" }, { sceneId: "s1", previewOf: null });
      await logPage("ABCD2345", { after: "9:0" }, { sceneId: "s1", previewOf: null });
      await logPage("ABCD2345", {}, { sceneId: null, previewOf: null });
      assert.deepEqual(urls, ["/api/rooms/ABCD2345/log?before=9%3A0&sceneId=s1", "/api/rooms/ABCD2345/log?after=9%3A0&sceneId=s1", "/api/rooms/ABCD2345/log"]);
    });
  });

  test("a page the server finds busy waits out its Retry-After once and asks again", async () => {
    const original = globalThis.fetch;
    const answers = [429, 200];
    let asked = 0;
    globalThis.fetch = (async () => {
      asked++;
      const status = answers.shift() ?? 429;
      return status === 429
        ? new Response(JSON.stringify({ error: "busy" }), { status, headers: { "content-type": "application/json", "retry-after": "1" } })
        : new Response(JSON.stringify({ entries: [], nextBefore: null, nextAfter: null }), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    try {
      await logPage("ABCD2345", { before: "9:0" }, { sceneId: null, previewOf: null }, { sleep });
      assert.deepEqual([asked, slept], [2, [1000]]);
      // Busy twice: one retry only, then the failure.
      answers.push(429, 429, 200);
      asked = 0;
      await assert.rejects(logPage("ABCD2345", { before: "9:0" }, { sceneId: null, previewOf: null }, { sleep }), (err: unknown) => err instanceof ApiError && err.code === "busy");
      assert.equal(asked, 2);
      // Out of the hour's pages is no moment's wait: no retry.
      answers.length = 0;
      asked = 0;
      globalThis.fetch = (async () => {
        asked++;
        return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "3" } });
      }) as typeof fetch;
      await assert.rejects(logPage("ABCD2345", { before: "9:0" }, { sceneId: null, previewOf: null }, { sleep }), (err: unknown) => err instanceof ApiError && err.code === "rate_limited");
      assert.equal(asked, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("an abort during the busy wait asks no second time", async () => {
    const original = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = (async () => {
      asked++;
      return new Response(JSON.stringify({ error: "busy" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } });
    }) as typeof fetch;
    try {
      const abort = new AbortController();
      const page = logPage("ABCD2345", { before: "9:0" }, { sceneId: null, previewOf: null }, { signal: abort.signal });
      await new Promise((resolve) => setImmediate(resolve));
      abort.abort(new Error("gone"));
      await assert.rejects(page, { message: "gone" });
      assert.equal(asked, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a failed page says which way it failed, with the server's reason only when worth reading", () => {
    assert.equal(pageErrorText("older", new ApiError(429, "x", "busy", 1000)), "Could not load older messages.");
    assert.equal(pageErrorText("newer", new ApiError(0, "x", "network", null)), "Could not load newer messages. Check your connection.");
    assert.equal(pageErrorText("older", new ApiError(429, "Too many tries. Wait a little and try again.", "rate_limited", 3000)), "Could not load older messages. Too many tries. Wait a little and try again.");
    assert.equal(pageErrorText("older", new Error(OLDER_LOG_FAILED)), "Could not load older messages.");
  });
});
