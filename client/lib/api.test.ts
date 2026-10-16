import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { api, ApiError, parseRetryAfter, retryOn503, toApiError, UploadQueue } from "./api.ts";

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

describe("the device's upload queue (docs/design-v1-pdf-handouts.md 4.1.4)", () => {
  /** Work that finishes when the test says, recording when it started. */
  function gate(log: string[], name: string) {
    let open!: () => void;
    const done = new Promise<void>((resolve) => (open = resolve));
    return {
      open: () => open(),
      work: async () => {
        log.push(`start ${name}`);
        await done;
        log.push(`end ${name}`);
        return name;
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("one upload at a time, and an image picked meanwhile goes before the PDF's next page", async () => {
    const queue = new UploadQueue();
    const log: string[] = [];
    const page1 = gate(log, "page 1");
    const page2 = gate(log, "page 2");
    const image = gate(log, "image");
    const results = [queue.run(page1.work, { background: true }), queue.run(page2.work, { background: true }), queue.run(image.work)];
    await settle();
    assert.deepEqual(log, ["start page 1"]);
    page1.open();
    await settle();
    assert.deepEqual(log, ["start page 1", "end page 1", "start image"]);
    image.open();
    await settle();
    page2.open();
    assert.deepEqual(await Promise.all(results), ["page 1", "page 2", "image"]);
    assert.deepEqual(log, ["start page 1", "end page 1", "start image", "end image", "start page 2", "end page 2"]);
  });

  test("an upload aborted while it waits is taken out and rejects at once, never sent, an image's or a page's alike", async () => {
    const queue = new UploadQueue();
    const log: string[] = [];
    const running = gate(log, "running");
    const first = queue.run(running.work, { background: true });
    for (const background of [false, true]) {
      const abort = new AbortController();
      const waiting = queue.run(async () => log.push("sent"), { background, signal: abort.signal });
      await settle();
      assert.equal(queue.waiting, 1);
      abort.abort(new Error("cancelled"));
      await assert.rejects(waiting, /cancelled/);
      assert.equal(queue.waiting, 0, "out of the queue at once, while another upload still runs");
    }
    running.open();
    await first;
    assert.deepEqual(log, ["start running", "end running"]);
    // One aborted before it is even queued is never queued.
    const early = new AbortController();
    early.abort(new Error("already"));
    await assert.rejects(queue.run(async () => log.push("sent"), { signal: early.signal }), /already/);
    assert.equal(queue.waiting, 0);
  });

  test("a failed upload hands the queue on", async () => {
    const queue = new UploadQueue();
    await assert.rejects(queue.run(async () => Promise.reject(new Error("offline"))), /offline/);
    assert.equal(await queue.run(async () => "next"), "next");
  });

  test("api.uploadAsset runs through it, says when a request is on its way, and never sends one aborted while it waits", async () => {
    const original = globalThis.fetch;
    const sent: string[] = [];
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    globalThis.fetch = (async (url: string) => {
      sent.push(String(url));
      await answered;
      return new Response(JSON.stringify({ id: "a1", kind: "handout", width: 1, height: 1, variants: ["full"], created: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const sending: boolean[] = [];
      const page = api.uploadAsset("ABCD2345", "handout", new Blob(["x"], { type: "image/webp" }), { background: true, onSending: (s) => sending.push(s) });
      const abort = new AbortController();
      const image = api.uploadAsset("ABCD2345", "handout", new Blob(["y"], { type: "image/png" }), { signal: abort.signal });
      await settle();
      assert.deepEqual(sending, [true]);
      abort.abort(new Error("closed"));
      await assert.rejects(image, /closed/);
      answer();
      assert.equal((await page).created, true);
      assert.deepEqual(sending, [true, false]);
      assert.equal(sent.length, 1, "the image aborted while it waited was never sent");
    } finally {
      globalThis.fetch = original;
    }
  });
});
