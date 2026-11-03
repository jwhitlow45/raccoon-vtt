import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { VIDEO_REFUSALS } from "./words.ts";
import { FirstFrameError, fileRefusal, isVideoFile, LOW_POWER_STOPPED, metadataRefusal, NO_FIRST_FRAME, readFirstFrame, stillFileName, videoContainer, type FrameDeps, type ProbeCanvas, type ProbeVideo } from "./firstFrame.ts";

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
  asked: { type?: string; quality?: number }[] = [];
  makesWebp = true;
  getContext() {
    return {
      drawImage: (_image: never, _x: number, _y: number, w: number, h: number) => {
        this.drawn = { w, h };
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
      const frame = await done;
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
    const frame = await done;
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

  test("a file this device cannot decode, by a refused play() or an error event, asks for a still", async () => {
    for (const how of ["play", "error"] as const) {
      const h = harness();
      if (how === "play") h.video.playAnswer = () => Promise.reject(new DOMException("no", "NotSupportedError"));
      else h.video.playAnswer = () => new Promise(() => undefined);
      const done = readFirstFrame(webm(), { host: null, deps: h.deps }).catch((e: unknown) => e);
      if (how === "error") h.video.fire("error");
      const err = await done;
      assert.ok(err instanceof FirstFrameError, how);
      assert.deepEqual(err.failure, { kind: "unreadable" });
      assert.equal(err.message, NO_FIRST_FRAME);
      assertReleased(h);
    }
  });

  test("after 20 seconds with no frame, it gives up and lets go of everything", async () => {
    const h = harness();
    h.video.playAnswer = () => new Promise(() => undefined);
    const done = readFirstFrame(webm(), { host: null, deps: h.deps }).catch((e: unknown) => e);
    assert.equal(h.timers[0]!.ms, 20_000);
    h.timers[0]!.run();
    const err = await done;
    assert.ok(err instanceof FirstFrameError);
    assert.deepEqual(err.failure, { kind: "unreadable" });
    assertReleased(h);
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

  test("what the server would refuse is refused at once, in 4.5's words", async () => {
    const cases: [number, number, number, string][] = [
      [4097, 2160, 10, "video_size"],
      [4000, 2160, 10, "video_size"],
      [255, 400, 10, "video_size"],
      [1920, 1080, 0.5, "video_length"],
      [1920, 1080, 601, "video_length"],
      [1920, 1080, Number.POSITIVE_INFINITY, "video_unfinished"],
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
    assert.equal(metadataRefusal({ widthPx: 3840, heightPx: 2160, duration: 600 }), null, "the caps themselves pass");
    assert.equal(metadataRefusal({ widthPx: 256, heightPx: 256, duration: 1 }), null);
  });

  test("a type that is not WebM or MP4, or a file over 64 MB, is refused before any probe", async () => {
    const mov = new File([new Uint8Array(1)], "map.mov", { type: "video/quicktime" });
    assert.equal(fileRefusal(mov)?.message, VIDEO_REFUSALS.video_type);
    const big = { name: "map.mp4", type: "video/mp4", size: 64 * 1024 * 1024 + 1 };
    assert.equal(fileRefusal(big)?.message, VIDEO_REFUSALS.too_large);
    assert.equal(fileRefusal({ name: "map.mp4", type: "video/mp4", size: 64 * 1024 * 1024 }), null);
    const h = harness();
    await assert.rejects(readFirstFrame(mov, { host: null, deps: h.deps }), FirstFrameError);
    assert.equal(h.urls.made.length, 0, "no URL was made");
  });

  test("a picked file is a video by its type, or by its name when it came with no type", () => {
    assert.equal(videoContainer({ type: "video/webm", name: "x" }), "webm");
    assert.equal(videoContainer({ type: "", name: "Loop.MP4" }), "mp4");
    assert.equal(videoContainer({ type: "application/octet-stream", name: "loop.m4v" }), "mp4");
    assert.equal(videoContainer({ type: "image/png", name: "loop.webm" }), null);
    assert.equal(isVideoFile({ type: "video/quicktime", name: "a.mov" }), true, "a MOV is a video, which the server refuses in its words");
    assert.equal(isVideoFile({ type: "image/webp", name: "a.webp" }), false);
    assert.equal(stillFileName("crypt_30x20.webm", "image/webp"), "crypt_30x20.webp");
    assert.equal(stillFileName("crypt.mp4", "image/jpeg"), "crypt.jpg");
  });
});
