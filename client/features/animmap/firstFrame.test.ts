import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MapVideo } from "#shared/model.ts";
import { VIDEO_REFUSALS } from "./words.ts";
import { FirstFrameError, fileRefusal, isVideoFile, lengthRefusal, LOW_POWER_STOPPED, NO_FIRST_FRAME, probeSizeFits, readFirstFrame, readStoredFrame, stillFileName, videoContainer, type FrameDeps, type ProbeCanvas, type ProbeVideo } from "./firstFrame.ts";
import { movie, picked } from "./mp4Boxes.testutil.ts";

/** A `<video>` the test drives: it records what the probe asks and fires events by hand. */
class FakeVideo implements ProbeVideo {
  muted = false;
  playsInline = false;
  preload = "";
  #src = "";
  currentTime = 5;
  videoWidth = 0;
  videoHeight = 0;
  duration = Number.NaN;
  log: string[] = [];
  attrs = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  frameCallbacks: (() => void)[] = [];
  playAnswer: () => Promise<void> = () => Promise.resolve();
  hasFrameCallback = true;
  removed = false;
  readonly style: Record<string, string> = {};
  get src() {
    return this.#src;
  }
  set src(v: string) {
    this.log.push(`src=${v}`);
    this.#src = v;
  }
  play() {
    this.log.push("play");
    return this.playAnswer();
  }
  pause() {
    this.log.push("pause");
  }
  load() {
    this.log.push("load");
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name === "muted") this.log.push("muted-attr");
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === "src") {
      this.#src = "";
      this.log.push("clear-src");
    }
  }
  addEventListener(type: string, listener: () => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  get requestVideoFrameCallback() {
    return this.hasFrameCallback
      ? (cb: () => void) => {
          this.frameCallbacks.push(cb);
          return this.frameCallbacks.length;
        }
      : undefined;
  }
  cancelVideoFrameCallback = () => {
    this.frameCallbacks = [];
  };
  remove() {
    this.removed = true;
  }
  fire(type: string) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }
  /** The browser has the file's size and length. */
  meta(width: number, height: number, seconds: number) {
    this.videoWidth = width;
    this.videoHeight = height;
    this.duration = seconds;
    this.fire("loadedmetadata");
  }
  listening(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

class FakeCanvas implements ProbeCanvas {
  width = 0;
  height = 0;
  drawn: { w: number; h: number } | null = null;
  /** The transform the frame was drawn under, or null for none. */
  transform: number[] | null = null;
  /** The canvas's size when the frame was drawn. */
  sizeAtDraw: { w: number; h: number } | null = null;
  asked: { type?: string; quality?: number }[] = [];
  makesWebp = true;
  getContext() {
    return {
      drawImage: (_image: never, _x: number, _y: number, w: number, h: number) => {
        this.drawn = { w, h };
        this.sizeAtDraw = { w: this.width, h: this.height };
      },
      setTransform: (...m: number[]) => {
        this.transform = m;
      },
    };
  }
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number) {
    this.asked.push({ type, quality });
    // Safari's canvas answers a WebP request with a PNG.
    const made = type === "image/webp" && !this.makesWebp ? "image/png" : (type ?? "image/png");
    queueMicrotask(() => callback(new Blob([new Uint8Array(4)], { type: made })));
  }
}

function harness() {
  const video = new FakeVideo();
  const canvas = new FakeCanvas();
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const urls = { made: [] as string[], revoked: [] as string[] };
  let attached = 0;
  const deps: FrameDeps = {
    makeVideo: () => video,
    attach: () => void attached++,
    makeCanvas: () => canvas,
    url: () => {
      const url = `blob:test/${urls.made.length + 1}`;
      urls.made.push(url);
      return url;
    },
    revoke: (url) => void urls.revoked.push(url),
    setTimeout: (run, ms) => {
      const t = { run, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return { video, canvas, timers, urls, deps, attached: () => attached };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const webm = (size = 1000) => new File([new Uint8Array(size)], "crypt_30x20.webm", { type: "video/webm" });

/** The probe let go of everything: no source, no listener, no URL, no timer, out of the form. */
function assertReleased(h: ReturnType<typeof harness>) {
  assert.equal(h.video.src, "", "the src is cleared");
  assert.ok(h.video.log.lastIndexOf("clear-src") < h.video.log.lastIndexOf("load"), "load() follows the clear, which drops the decoder's frames");
  assert.equal(h.video.removed, true, "the probe leaves the form");
  assert.deepEqual(h.urls.revoked, h.urls.made, "the blob URL is revoked");
  assert.equal(h.video.listening(), 0, "no listener is left");
  assert.ok(h.timers.every((t) => t.cleared), "the timeout is cleared");
}

describe("the first frame (docs/design/design-v1-animated-maps.md 4.1)", () => {
  for (const winner of ["frame callback", "seeked", "loadeddata"] as const) {
    test(`plays, pauses, seeks to 0 and draws at the first of the three, here ${winner}, then lets go of everything`, async () => {
      const h = harness();
      const done = readFirstFrame(webm(), { host: null, deps: h.deps });
      h.video.meta(1920, 1080, 42.4);
      await flush();
      assert.deepEqual(h.video.log.slice(0, 4), ["muted-attr", "src=blob:test/1", "play", "pause"], "muted before the source, then play and pause");
      assert.equal(h.video.muted, true);
      assert.equal(h.video.playsInline, true);
      assert.equal(h.video.attrs.get("aria-hidden"), "true");
      assert.equal(h.video.attrs.has("style"), false, "no style attribute, which the CSP refuses");
      assert.equal(h.video.style.width, "1px");
      assert.equal(h.attached(), 1);
      assert.equal(h.video.currentTime, 0, "seeks to 0");
      if (winner === "frame callback") h.video.frameCallbacks[0]!();
      else h.video.fire(winner);
      // The others arriving after must not draw again.
      h.video.fire("seeked");
      h.video.fire("loadeddata");
      const frame = (await done)!;
      assert.equal(h.video.attrs.has("data-animmap-probe"), true, "the e2e steps find the probe by it");
      assert.equal(h.canvas.transform, null, "the local frame is drawn as the browser shows it");
      assert.equal(frame.widthPx, 1920);
      assert.equal(frame.heightPx, 1080);
      assert.equal(frame.durationMs, 42_400);
      assert.equal(frame.blob.type, "image/webp");
      assert.deepEqual(h.canvas.drawn, { w: 1920, h: 1080 }, "drawn at the video's own size");
      assert.deepEqual(h.canvas.asked, [{ type: "image/webp", quality: 0.92 }]);
      assertReleased(h);
    });
  }

  test("a loadeddata that came during play() is not taken for frame 0: the wait starts at the seek", async () => {
    const h = harness();
    h.video.hasFrameCallback = false;
    let resolvePlay!: () => void;
    h.video.playAnswer = () => new Promise<void>((r) => (resolvePlay = r));
    const done = readFirstFrame(webm(), { host: null, deps: h.deps });
    h.video.meta(640, 360, 2);
    h.video.fire("loadeddata");
    assert.equal(h.canvas.drawn, null);
    resolvePlay();
    await flush();
    h.video.fire("seeked");
    await done;
    assert.deepEqual(h.canvas.drawn, { w: 640, h: 360 });
  });

  test("where the canvas cannot make WebP, as Safari's, the still is JPEG at 0.92", async () => {
    const h = harness();
    h.canvas.makesWebp = false;
    const done = readFirstFrame(webm(), { host: null, deps: h.deps });
    h.video.meta(640, 360, 2);
    await flush();
    h.video.fire("seeked");
    const frame = (await done)!;
    assert.equal(frame.blob.type, "image/jpeg");
    assert.deepEqual(h.canvas.asked, [
      { type: "image/webp", quality: 0.92 },
      { type: "image/jpeg", quality: 0.92 },
    ]);
  });

  test("Low Power Mode refusing play() says so, and lets go of everything", async () => {
    const h = harness();
    h.video.playAnswer = () => Promise.reject(new DOMException("no", "NotAllowedError"));
    const err = await readFirstFrame(webm(), { host: null, deps: h.deps }).catch((e: unknown) => e);
    assert.ok(err instanceof FirstFrameError);
    assert.deepEqual(err.failure, { kind: "lowPower" });
    assert.equal(err.message, LOW_POWER_STOPPED);
    assertReleased(h);
  });

  test("a file this device cannot decode, by a refused play(), an error event or 20 s with no frame, gives no frame, so the upload goes on (docs/design/design-v1-video-turns.md 8 step 1)", async () => {
    for (const how of ["play", "error", "timeout"] as const) {
      const h = harness();
      if (how === "play") h.video.playAnswer = () => Promise.reject(new DOMException("no", "NotSupportedError"));
      else h.video.playAnswer = () => new Promise(() => undefined);
      const done = readFirstFrame(webm(), { host: null, deps: h.deps });
      if (how === "error") h.video.fire("error");
      if (how === "timeout") {
        assert.equal(h.timers[0]!.ms, 20_000);
        h.timers[0]!.run();
      }
      assert.equal(await done, null, how);
      assert.equal(h.canvas.drawn, null, `${how}: no canvas`);
      assertReleased(h);
    }
  });

  test("a cancel stops it with the signal's reason, and lets go of everything", async () => {
    const h = harness();
    h.video.playAnswer = () => new Promise(() => undefined);
    const abort = new AbortController();
    const done = readFirstFrame(webm(), { host: null, deps: h.deps, signal: abort.signal }).catch((e: unknown) => e);
    abort.abort();
    const err = await done;
    assert.ok(err instanceof DOMException && err.name === "AbortError");
    assertReleased(h);
  });

  test("a length the server would refuse is refused at once, in 4.5's words", async () => {
    const cases: [number, number, number, string][] = [
      [1920, 1080, 0.5, "video_length"],
      [1920, 1080, 601, "video_length"],
      [1920, 1080, Number.POSITIVE_INFINITY, "video_unfinished"],
      // A length refusal comes first, whatever the size.
      [5120, 2880, 601, "video_length"],
    ];
    for (const [w, h, s, code] of cases) {
      const run = harness();
      const done = readFirstFrame(webm(), { host: null, deps: run.deps }).catch((e: unknown) => e);
      run.video.meta(w, h, s);
      const err = await done;
      assert.ok(err instanceof FirstFrameError, `${w}x${h} ${s}s`);
      assert.deepEqual(err.failure, { kind: "refused", text: VIDEO_REFUSALS[code as keyof typeof VIDEO_REFUSALS] });
      assertReleased(run);
    }
    assert.equal(lengthRefusal(600), null, "the caps themselves pass");
    assert.equal(lengthRefusal(1), null);
  });

  test("a size past the caps makes no canvas and no frame, so the upload goes on: a WebM may declare 5120 x 2880 for 2560 x 1440 (docs/design/design-v1-video-turns.md 8 step 1)", async () => {
    for (const [w, h] of [
      [5120, 2880],
      [4097, 2160],
      [4000, 2160],
      [255, 400],
    ] as const) {
      for (const at of ["loadedmetadata", "frame"] as const) {
        const run = harness();
        const done = readFirstFrame(webm(), { host: null, deps: run.deps });
        if (at === "loadedmetadata") run.video.meta(w, h, 10);
        else {
          // The frame came before the size was read.
          await flush();
          run.video.videoWidth = w;
          run.video.videoHeight = h;
          run.video.duration = 10;
          run.video.fire("seeked");
        }
        assert.equal(await done, null, `${w}x${h} at ${at}`);
        assert.equal(run.canvas.drawn, null, `${w}x${h} at ${at}: no canvas`);
        assertReleased(run);
      }
    }
    assert.equal(probeSizeFits(3840, 2160), true, "the caps themselves pass");
    assert.equal(probeSizeFits(256, 256), true);
    assert.equal(probeSizeFits(4096, 2160), false, "past 8.3 megapixels");
  });

  test("a type that is not WebM, MP4 or MOV, or a file over 64 MB, is refused before any probe", async () => {
    const avi = new File([new Uint8Array(1)], "map.avi", { type: "video/x-msvideo" });
    assert.equal(fileRefusal(avi)?.message, VIDEO_REFUSALS.video_type);
    assert.equal(VIDEO_REFUSALS.video_type, "That video isn't WebM, MP4 or MOV.");
    const big = { name: "map.mp4", type: "video/mp4", size: 64 * 1024 * 1024 + 1 };
    assert.equal(fileRefusal(big)?.message, VIDEO_REFUSALS.too_large);
    assert.equal(fileRefusal({ name: "map.mp4", type: "video/mp4", size: 64 * 1024 * 1024 }), null);
    assert.equal(fileRefusal({ name: "IMG_0042.MOV", type: "video/quicktime", size: 1000 }), null, "an iPhone's MOV goes on to the server's check");
    const h = harness();
    await assert.rejects(readFirstFrame(avi, { host: null, deps: h.deps }), FirstFrameError);
    assert.equal(h.urls.made.length, 0, "no URL was made");
  });

  test("an iPhone's HEVC MOV with its moov last is refused in the server's words before any URL or probe, and its H.264 twin goes on to the probe (AMROT-O-06)", async () => {
    const MiB = 1024 * 1024;
    const h = harness();
    let settled = false;
    const refused = readFirstFrame(picked(movie({ brand: "qt  ", entry: "hvc1", moovLast: true, media: 3 * MiB })), { host: null, deps: h.deps })
      .catch((e: unknown) => e)
      .finally(() => (settled = true));
    for (let i = 0; i < 200 && !settled && h.attached() === 0; i++) await flush();
    // A scan that missed it leaves the fake probe waiting for ever, so it is ended here and the test fails rather than hangs.
    if (!settled) h.video.fire("error");
    const err = await refused;
    assert.ok(err instanceof FirstFrameError && err.failure.kind === "refused", String(err));
    assert.equal(err.message, VIDEO_REFUSALS.video_hevc);
    assert.equal(h.urls.made.length, 0, "no URL was made");
    assert.equal(h.attached(), 0, "no probe opened it");

    const g = harness();
    const done = readFirstFrame(picked(movie({ brand: "qt  ", entry: "avc1", moovLast: true, media: 3 * MiB })), { host: null, deps: g.deps });
    for (let i = 0; i < 200 && g.attached() === 0; i++) await flush();
    assert.equal(g.attached(), 1, "the probe opened the H.264 file");
    g.video.meta(640, 360, 2);
    await flush();
    g.video.fire("seeked");
    assert.equal((await done)?.widthPx, 640);
    assertReleased(g);
  });

  test("a cancel during the HEVC scan wins over its refusal", async () => {
    const abort = new AbortController();
    const h = harness();
    const done = readFirstFrame(picked(movie({ entry: "hvc1" }), "mp4"), { host: null, deps: h.deps, signal: abort.signal }).catch((e: unknown) => e);
    const reason = new Error("cancelled");
    abort.abort(reason);
    assert.equal(await done, reason);
    assert.equal(h.urls.made.length, 0);
  });

  test("a picked file is a video by its type, or by its name when it came with no type, and a MOV is an MP4 (docs/design/design-v1-video-turns.md 4.5)", () => {
    assert.equal(videoContainer({ type: "video/webm", name: "x" }), "webm");
    assert.equal(videoContainer({ type: "", name: "Loop.MP4" }), "mp4");
    assert.equal(videoContainer({ type: "application/octet-stream", name: "loop.m4v" }), "mp4");
    assert.equal(videoContainer({ type: "image/png", name: "loop.webm" }), null);
    assert.equal(videoContainer({ type: "video/quicktime", name: "IMG_0042.MOV" }), "mp4");
    assert.equal(videoContainer({ type: "", name: "IMG_0042.MOV" }), "mp4", "a MOV from cloud storage with no type");
    assert.equal(videoContainer({ type: "video/x-msvideo", name: "a.mov" }), null, "a type that says otherwise wins over the name");
    assert.equal(isVideoFile({ type: "video/quicktime", name: "a.mov" }), true);
    assert.equal(isVideoFile({ type: "video/x-msvideo", name: "a.avi" }), true, "an AVI is a video, which the device refuses in its words");
    assert.equal(isVideoFile({ type: "image/webp", name: "a.webp" }), false);
    assert.equal(stillFileName("crypt_30x20.webm", "image/webp"), "crypt_30x20.webp");
    assert.equal(stillFileName("crypt.mp4", "image/jpeg"), "crypt.jpg");
  });
});

describe("the stored copy's first frame (docs/design/design-v1-video-turns.md 8 step 4)", () => {
  const STORED: MapVideo = { assetId: "v1", widthPx: 1920, heightPx: 1080, container: "mp4", video: "avc1.640028", fps: 30, durationMs: 42_000, kbps: 4000 };

  test("draws the plain frame turned into a canvas of the drawn size, filling it whatever size the browser read, and keeps the asset's address", async () => {
    const cases: [Partial<MapVideo>, [number, number], number[] | null, [number, number]][] = [
      [{ turn: 90 }, [1080, 1920], [0, 1, -1, 0, 1080, 0], [1920, 1080]],
      [{ turn: 270, mirror: true }, [1080, 1920], [0, -1, -1, 0, 1080, 1920], [1920, 1080]],
      [{ displayWidthPx: 2560 }, [2560, 1080], [1, 0, 0, 1, 0, 0], [2560, 1080]],
      [{ turn: 180 }, [1920, 1080], [-1, 0, 0, -1, 1920, 1080], [1920, 1080]],
    ];
    for (const [facts, size, matrix, box] of cases) {
      const h = harness();
      const done = readStoredFrame("/api/assets/v1/full", { ...STORED, ...facts }, { host: null, deps: h.deps });
      // Gecko may read a stretched file at another width: the frame fills the canvas anyway.
      h.video.meta(1919, 1080, 42);
      await flush();
      assert.deepEqual(h.video.log.slice(0, 4), ["muted-attr", "src=/api/assets/v1/full", "play", "pause"]);
      h.video.fire("seeked");
      const frame = await done;
      const what = JSON.stringify(facts);
      assert.deepEqual([frame.widthPx, frame.heightPx], size, what);
      assert.deepEqual(h.canvas.sizeAtDraw, { w: size[0], h: size[1] }, what);
      assert.deepEqual(h.canvas.transform, matrix, what);
      assert.deepEqual(h.canvas.drawn, { w: box[0], h: box[1] }, `${what}: the frame fills its box before the turn`);
      assert.equal(frame.durationMs, 42_000, "the server's length");
      assert.equal(h.urls.made.length, 0, "no blob URL");
      assert.deepEqual(h.urls.revoked, [], "nothing to revoke");
      assert.equal(h.video.src, "");
      assert.equal(h.video.removed, true);
      assert.equal(h.video.listening(), 0);
    }
  });

  test("judges no size or length, which the server checked", async () => {
    const h = harness();
    const done = readStoredFrame("/api/assets/v1/full", { ...STORED, displayWidthPx: 2560 }, { host: null, deps: h.deps });
    h.video.meta(5120, 2880, Number.POSITIVE_INFINITY);
    await flush();
    h.video.fire("seeked");
    const frame = await done;
    assert.deepEqual([frame.widthPx, frame.heightPx], [2560, 1080]);
  });

  test("a stored copy this device cannot read, by a refused play(), an error or the 20 s timeout, fails as unreadable, and Low Power Mode says so, each letting go of everything", async () => {
    for (const how of ["play", "error", "timeout", "lowPower"] as const) {
      const h = harness();
      if (how === "play") h.video.playAnswer = () => Promise.reject(new DOMException("no", "NotSupportedError"));
      else if (how === "lowPower") h.video.playAnswer = () => Promise.reject(new DOMException("no", "NotAllowedError"));
      else h.video.playAnswer = () => new Promise(() => undefined);
      const done = readStoredFrame("/api/assets/v1/full", { ...STORED, turn: 90 }, { host: null, deps: h.deps }).catch((e: unknown) => e);
      if (how === "error") h.video.fire("error");
      if (how === "timeout") h.timers[0]!.run();
      const err = await done;
      assert.ok(err instanceof FirstFrameError, how);
      assert.deepEqual(err.failure, { kind: how === "lowPower" ? "lowPower" : "unreadable" }, how);
      assert.equal(err.message, how === "lowPower" ? LOW_POWER_STOPPED : NO_FIRST_FRAME);
      assert.equal(h.video.src, "", `${how}: the src is cleared`);
      assert.equal(h.video.removed, true);
      assert.equal(h.video.listening(), 0);
      assert.ok(h.timers.every((t) => t.cleared));
    }
  });

  test("a cancel stops it with the signal's reason", async () => {
    const h = harness();
    h.video.playAnswer = () => new Promise(() => undefined);
    const abort = new AbortController();
    const done = readStoredFrame("/api/assets/v1/full", STORED, { host: null, deps: h.deps, signal: abort.signal }).catch((e: unknown) => e);
    abort.abort();
    const err = await done;
    assert.ok(err instanceof DOMException && err.name === "AbortError");
    assert.equal(h.video.src, "");
    const before = new AbortController();
    before.abort();
    await assert.rejects(readStoredFrame("/x", STORED, { host: null, deps: harness().deps, signal: before.signal }), (e: unknown) => e instanceof DOMException && e.name === "AbortError");
  });
});
