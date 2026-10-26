import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OLDER_LOG_FAILED, olderLogPage } from "./olderLog.ts";

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
      const page = await olderLogPage("ABCD2345", "9:0", { sceneId: null, previewOf: "m 1" });
      assert.equal(page.as, "m 1");
      assert.deepEqual(urls, ["/api/rooms/ABCD2345/log?before=9%3A0&as=m+1"]);
    });
  });

  test("in a preview, refused when the server names no one, or someone else, as a server that ignores `as` answers", async () => {
    for (const answer of [{}, { as: "dm1" }, { as: "m 2" }]) {
      await withServer(answer, async () => {
        await assert.rejects(olderLogPage("ABCD2345", "9:0", { sceneId: null, previewOf: "m 1" }), { message: OLDER_LOG_FAILED }, JSON.stringify(answer));
      });
    }
    assert.equal(OLDER_LOG_FAILED, "Could not load older messages.");
  });

  test("a DM's own pages follow the scene on screen, ask as no one and need no answer", async () => {
    await withServer({}, async (urls) => {
      await olderLogPage("ABCD2345", "9:0", { sceneId: "s1", previewOf: null });
      assert.deepEqual(urls, ["/api/rooms/ABCD2345/log?before=9%3A0&sceneId=s1"]);
    });
  });
});
