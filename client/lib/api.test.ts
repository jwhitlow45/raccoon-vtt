import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, parseRetryAfter, retryOn503, toApiError } from "./api.ts";

describe("toApiError", () => {
  test("keeps a code from the server's list and leaves any other out, status and body kept", async () => {
    const removed = await toApiError(new Response(JSON.stringify({ error: "member_removed" }), { status: 409 }));
    assert.equal(removed.code, "member_removed");
    const fastify = await toApiError(
      new Response(JSON.stringify({ statusCode: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE", error: "Unsupported Media Type", message: "Unsupported Media Type" }), { status: 415 }),
    );
    assert.equal(fastify.code, undefined);
    assert.equal(fastify.status, 415);
    assert.equal(fastify.detail.code, "FST_ERR_CTP_INVALID_MEDIA_TYPE");
  });
});

describe("parseRetryAfter", () => {
  test("seconds", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter(" 0 "), 0);
  });

  test("an HTTP date", () => {
    const now = Date.parse("2026-10-12T20:00:00Z");
    assert.equal(parseRetryAfter("Mon, 12 Oct 2026 20:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfter("Mon, 12 Oct 2026 19:59:00 GMT", now), 0);
  });

  test("missing or unreadable", () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("soon"), null);
  });
});

/** A fake clock whose sleep advances time instantly. */
function fakeTime() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const busy = (seconds: number | null) =>
  new ApiError(503, "busy", undefined, seconds === null ? null : seconds * 1000);

describe("retryOn503", () => {
  test("follows Retry-After until the server accepts", async () => {
    const time = fakeTime();
    const waiting: boolean[] = [];
    let calls = 0;
    const result = await retryOn503(
      async () => {
        calls++;
        if (calls < 3) throw busy(4);
        return "ok";
      },
      { ...time, onWaiting: (w) => waiting.push(w) },
    );
    assert.equal(result, "ok");
    assert.deepEqual(time.sleeps, [4000, 4000]);
    assert.deepEqual(waiting, [true, false]);
  });

  test("gives up rather than wait past the 60 s budget", async () => {
    const time = fakeTime();
    let calls = 0;
    await assert.rejects(
      retryOn503(async () => {
        calls++;
        throw busy(10);
      }, time),
      (err: unknown) => err instanceof ApiError && err.status === 503,
    );
    assert.equal(calls, 7);
    assert.equal(time.now(), 60_000);
  });

  test("waits a default time when Retry-After is missing", async () => {
    const time = fakeTime();
    let calls = 0;
    await retryOn503(async () => {
      if (calls++ === 0) throw busy(null);
      return 1;
    }, time);
    assert.deepEqual(time.sleeps, [2000]);
  });

  test("does not retry other errors", async () => {
    const time = fakeTime();
    let calls = 0;
    await assert.rejects(
      retryOn503(async () => {
        calls++;
        throw new ApiError(413, "too large", undefined, null);
      }, time),
    );
    assert.equal(calls, 1);
    assert.deepEqual(time.sleeps, []);
  });
});
