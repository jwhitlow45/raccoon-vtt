import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { api, ApiError, FileCutShortError, FileTooLargeError, logExportUrl, MAX_LOG_FILE_BYTES, parseRetryAfter, retryOn503, setProgressXhrForTests, toApiError, UploadQueue, type ProgressXhr } from "./api.ts";

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

describe("the device's upload queue (docs/design/design-v1-pdf-handouts.md 4.1.4)", () => {
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

/**
 * The log's export file (docs/design/design-v1-log-history.md 4.2): read a chunk at
 * a time up to 8 MiB, cancelled past that, and an error when its body breaks
 * off, never a shorter file.
 */
describe("the log export file", () => {
  /** A response whose body sends `chunks` and then ends, or fails when `fail` is set. */
  function streamed(chunks: number[], options: { fail?: boolean } = {}) {
    const state = { cancelled: false, pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = chunks[state.pulled++];
        if (size !== undefined) controller.enqueue(new Uint8Array(size));
        else if (options.fail) controller.error(new TypeError("network error"));
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const res = new Response(body, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="crypt-log-2026-10-14.md"' } });
    return { res, state };
  }

  async function exporting<T>(res: Response, body: (urls: string[]) => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return res;
    }) as typeof fetch;
    try {
      return await body(urls);
    } finally {
      globalThis.fetch = original;
    }
  }

  test("a file of exactly 8 MiB is read whole, under the server's name, for a session by its ids", async () => {
    const mib = 1024 * 1024;
    const { res } = streamed([4 * mib, 4 * mib]);
    await exporting(res, async (urls) => {
      const file = await api.exportLog("ABCD2345", { fromId: "12:0", toId: "40:900001" }, "America/Chicago");
      assert.equal(file.blob.size, MAX_LOG_FILE_BYTES);
      assert.equal(file.fileName, "crypt-log-2026-10-14.md");
      assert.deepEqual(urls, ["/api/rooms/ABCD2345/log/export?fromId=12%3A0&toId=40%3A900001&tz=America%2FChicago"]);
    });
    assert.equal(MAX_LOG_FILE_BYTES, 8 * 1024 * 1024);
  });

  test("one byte past 8 MiB is cancelled before the rest is read, and never becomes a file", async () => {
    const { res, state } = streamed([MAX_LOG_FILE_BYTES, 1, 1024, 1024]);
    await exporting(res, async () => {
      await assert.rejects(api.exportLog("ABCD2345", {}, "UTC"), (err: unknown) => err instanceof FileTooLargeError);
    });
    assert.equal(state.cancelled, true);
    assert.ok(state.pulled <= 3, `read ${state.pulled} chunks`);
  });

  test("a body that breaks off is an error, not a shorter file", async () => {
    const { res } = streamed([1024, 1024], { fail: true });
    await exporting(res, async () => {
      await assert.rejects(api.exportLog("ABCD2345", {}, "UTC"), (err: unknown) => err instanceof FileCutShortError);
    });
  });

  test("the browser's own download asks for the same range, everything with no ids", () => {
    assert.equal(logExportUrl("ABCD2345", { fromId: "1:0", toId: "9:2" }, "UTC"), "/api/rooms/ABCD2345/log/export?fromId=1%3A0&toId=9%3A2&tz=UTC");
    assert.equal(logExportUrl("ABCD2345", {}, "Europe/Paris"), "/api/rooms/ABCD2345/log/export?tz=Europe%2FParis");
  });

  test("session pages ask before a session's first id, and the log's pages before or after an id", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ sessions: [], lines: 0, nextSessionsBefore: null, entries: [], nextBefore: null, nextAfter: null }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      await api.logSessions("ABCD2345");
      await api.logSessions("ABCD2345", { before: "120:0" });
      await api.getLog("ABCD2345", { after: "7:1" });
      assert.deepEqual(urls, ["/api/rooms/ABCD2345/log/sessions", "/api/rooms/ABCD2345/log/sessions?before=120%3A0", "/api/rooms/ABCD2345/log?after=7%3A1"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** An XHR the test answers by hand, one per request, in the order they were opened. */
class FakeXhr implements ProgressXhr {
  static made: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: Blob | null = null;
  aborted = false;
  status = 0;
  responseText = "";
  withCredentials = false;
  responseHeaders: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readonly upload: ProgressXhr["upload"] = { onprogress: null };
  constructor() {
    FakeXhr.made.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name] ?? null;
  }
  send(body: Blob) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  answer(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseHeaders = { "content-type": "application/json", ...headers };
    this.onload?.();
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe("the upload path with its percent (docs/design/design-v1-animated-maps.md 4.1, D-261102-511)", () => {
  test("reports the sent fraction, answers the row, and keeps the device's one upload queue", async () => {
    FakeXhr.made = [];
    const restore = setProgressXhrForTests(() => new FakeXhr());
    try {
      const seen: number[] = [];
      const video = new Blob([new Uint8Array(1000)], { type: "video/webm" });
      const first = api.uploadAssetWithProgress("r1", "video", video, { name: "crypt_30x20.webm", onProgress: (f) => seen.push(f) });
      // An ordinary upload asked meanwhile waits behind it: the server gives a device one intake slot.
      const originalFetch = globalThis.fetch;
      let fetched = 0;
      globalThis.fetch = (async () => {
        fetched++;
        return new Response(JSON.stringify({ id: "still", kind: "map", width: 640, height: 360, variants: ["full"] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      try {
        const second = api.uploadAsset("r1", "map", new Blob([new Uint8Array(10)], { type: "image/webp" }));
        await until(() => FakeXhr.made.length === 1, "the video's request");
        const xhr = FakeXhr.made[0]!;
        assert.equal(xhr.method, "PUT");
        assert.equal(xhr.url, "/api/rooms/r1/assets?kind=video&name=crypt_30x20.webm");
        assert.equal(xhr.headers["content-type"], "video/webm");
        assert.equal(xhr.sent, video);
        xhr.progress(420, 1000);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(fetched, 0, "the image waits while the video goes up");
        xhr.answer(200, { id: "v1", kind: "video", width: 640, height: 360, variants: ["full"], created: true });
        const row = await first;
        assert.equal(row.id, "v1");
        assert.equal(row.created, true);
        assert.deepEqual(seen, [0, 0.42, 1]);
        await second;
        assert.equal(fetched, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      restore();
    }
  });

  test("a 503 is waited out and sent again, its percent starting over, and a refusal is the same ApiError as request's", async () => {
    FakeXhr.made = [];
    const restore = setProgressXhrForTests(() => new FakeXhr());
    try {
      const waits: boolean[] = [];
      const seen: number[] = [];
      const upload = api.uploadAssetWithProgress("r1", "video", new Blob([new Uint8Array(100)], { type: "video/mp4" }), { onWaiting: (w) => waits.push(w), onProgress: (f) => seen.push(f) });
      await until(() => FakeXhr.made.length === 1, "the first try");
      FakeXhr.made[0]!.progress(50, 100);
      FakeXhr.made[0]!.answer(503, { error: "busy" }, { "retry-after": "0" });
      await until(() => FakeXhr.made.length === 2, "the second try");
      FakeXhr.made[1]!.answer(415, { error: "video_codec", message: "That video's format doesn't play in most browsers." });
      const err = await upload.then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 415);
      assert.equal(err.code, "video_codec");
      assert.deepEqual(waits, [true, false]);
      assert.deepEqual(seen, [0, 0.5, 0]);
    } finally {
      restore();
    }
  });

  test("no answer at all is network, and an abort stops the request and rejects with the signal's reason", async () => {
    FakeXhr.made = [];
    const restore = setProgressXhrForTests(() => new FakeXhr());
    try {
      const lost = api.uploadAssetWithProgress("r1", "video", new Blob([new Uint8Array(1)], { type: "video/webm" }));
      await until(() => FakeXhr.made.length === 1, "the request");
      FakeXhr.made[0]!.onerror?.();
      await assert.rejects(lost, (e: unknown) => e instanceof ApiError && e.code === "network");

      const abort = new AbortController();
      const cancelled = api.uploadAssetWithProgress("r1", "video", new Blob([new Uint8Array(1)], { type: "video/webm" }), { signal: abort.signal });
      await until(() => FakeXhr.made.length === 2, "the second request");
      abort.abort();
      await assert.rejects(cancelled, (e: unknown) => e instanceof DOMException && e.name === "AbortError");
      assert.equal(FakeXhr.made[1]!.aborted, true);
    } finally {
      restore();
    }
  });
});
