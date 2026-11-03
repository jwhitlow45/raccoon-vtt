import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { VideoFacts } from "#shared/model.ts";
import { ApiError, type AssetRow } from "../../lib/api.ts";
import { FirstFrameError, type FirstFrame } from "./firstFrame.ts";
import { animatedUploadText, aspectText, AnimatedUploadError, discardVideo, mapAccept, stepText, uploadAnimatedMap, type UploadDeps, type UploadStep } from "./upload.ts";
import { VIDEO_REFUSALS } from "./words.ts";

const FACTS: VideoFacts = { widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 4000 };

function videoRow(over: Partial<AssetRow> = {}): AssetRow {
  return { id: "v1", kind: "video", width: 1920, height: 1080, variants: ["full"], video: FACTS, created: true, ...over };
}

function stillRow(over: Partial<AssetRow> = {}): AssetRow {
  return { id: "s1", kind: "map", width: 1920, height: 1080, variants: ["full", "mobile", "thumb"], cellPx: 64, ...over };
}

type Call = { kind: string; name?: string; type: string };

/** The upload's world: a probe that answers a frame, and a server that answers each PUT in turn. */
function world(answers: { frame?: () => Promise<FirstFrame>; video?: () => Promise<AssetRow>; still?: () => Promise<AssetRow> } = {}) {
  const calls: Call[] = [];
  const removed: string[][] = [];
  const order: string[] = [];
  const deps: UploadDeps = {
    readFrame: async () => {
      order.push("frame");
      return answers.frame ? answers.frame() : { blob: new Blob([new Uint8Array(3)], { type: "image/webp" }), widthPx: 1920, heightPx: 1080, durationMs: 42_000 };
    },
    upload: async (_room, kind, file, options) => {
      order.push(kind);
      calls.push({ kind, name: options.name, type: file.type });
      options.onProgress?.(0.42);
      options.onProgress?.(1);
      if (kind === "video") return answers.video ? answers.video() : videoRow();
      return answers.still ? answers.still() : stillRow();
    },
    remove: async (_room, ids) => {
      removed.push(ids);
    },
  };
  return { deps, calls, removed, order };
}

const file = new File([new Uint8Array(10)], "crypt_30x20.webm", { type: "video/webm" });

async function run(w: ReturnType<typeof world>, extra: { still?: File; held?: { video: ReturnType<typeof videoRow>["video"] & { assetId: string }; created: boolean } | null; signal?: AbortSignal } = {}) {
  const steps: string[] = [];
  const result = await uploadAnimatedMap({
    roomId: "r1",
    file,
    host: null,
    signal: extra.signal ?? new AbortController().signal,
    onStep: (s: UploadStep) => steps.push(stepText(s)),
    deps: w.deps,
    ...(extra.still ? { still: extra.still } : null),
    ...(extra.held ? { held: extra.held as never } : null),
  });
  return { result, steps };
}

describe("an animated map's upload (docs/design/design-v1-animated-maps.md 4.1, D-261102-458)", () => {
  test("first frame, video, then still, each with its percent, and the video's name rides with the still for its scale", async () => {
    const w = world();
    const { result, steps } = await run(w);
    assert.deepEqual(w.order, ["frame", "video", "map"]);
    assert.deepEqual(steps, [
      "Reading the first frame…",
      "Uploading the video… 0%",
      "Uploading the video… 42%",
      "Uploading the video… 100%",
      "Uploading the still… 0%",
      "Uploading the still… 42%",
      "Uploading the still… 100%",
    ]);
    assert.deepEqual(w.calls, [
      { kind: "video", name: "crypt_30x20.webm", type: "video/webm" },
      { kind: "map", name: "crypt_30x20.webm", type: "image/webp" },
    ]);
    assert.deepEqual(result.asset, { id: "s1", width: 1920, height: 1080, cellPx: 64, video: { assetId: "v1", ...FACTS } });
    assert.equal(result.stillFile.name, "crypt_30x20.webp");
    assert.equal(result.created, true);
    assert.deepEqual(w.removed, []);
  });

  test("a still upload that fails deletes the video this upload made, and keeps one the room already held", async () => {
    for (const created of [true, false]) {
      const w = world({ video: async () => videoRow({ created }), still: async () => Promise.reject(new ApiError(503, "busy", undefined, null)) });
      const err = await run(w).catch((e: unknown) => e);
      assert.ok(err instanceof AnimatedUploadError);
      assert.equal(err.step, "still");
      assert.deepEqual(w.removed, created ? [["v1"]] : [], `created ${created}`);
      assert.equal(animatedUploadText(err), "busy");
    }
  });

  test("a cancel during the still's upload rejects with the signal's reason and deletes the video it made", async () => {
    const abort = new AbortController();
    const w = world({
      still: () => {
        abort.abort();
        return Promise.reject(abort.signal.reason);
      },
    });
    const err = await run(w, { signal: abort.signal }).catch((e: unknown) => e);
    assert.ok(err instanceof DOMException && err.name === "AbortError");
    assert.deepEqual(w.removed, [["v1"]]);
  });

  test("a refused video says why in 4.5's words, and nothing is left to delete", async () => {
    const w = world({ video: async () => Promise.reject(new ApiError(415, "x", "video_codec", null)) });
    const err = await run(w).catch((e: unknown) => e);
    assert.ok(err instanceof AnimatedUploadError);
    assert.equal(err.step, "video");
    assert.equal(animatedUploadText(err), VIDEO_REFUSALS.video_codec);
    assert.deepEqual(w.order, ["frame", "video"]);
    assert.deepEqual(w.removed, []);
  });

  test("a first frame this device cannot read stops before anything goes up", async () => {
    const w = world({ frame: async () => Promise.reject(new FirstFrameError({ kind: "unreadable" })) });
    const err = await run(w).catch((e: unknown) => e);
    assert.ok(err instanceof FirstFrameError);
    assert.deepEqual(w.order, ["frame"]);
  });

  test("a picked still: the video goes up first, and the still is checked against the server's facts within 1 px", async () => {
    // The server's facts say 1920 x 1080. A still of 1280 x 720 is the shape. One of 1280 x 722 is not.
    const ok = world({ still: async () => stillRow({ width: 1280, height: 720 }) });
    const picked = new File([new Uint8Array(5)], "crypt-still.jpg", { type: "image/jpeg" });
    const { result } = await run(ok, { still: picked });
    assert.deepEqual(ok.order, ["video", "map"], "no probe: the frame could not be read");
    assert.equal(result.stillFile, picked);

    const off = world({ still: async () => stillRow({ width: 1280, height: 722 }) });
    const err = await run(off, { still: picked }).catch((e: unknown) => e);
    assert.ok(err instanceof AnimatedUploadError);
    assert.equal(err.step, "shape");
    assert.equal(err.message, "That image isn't the video's shape (16:9). Pick one the same shape.");
    assert.deepEqual(off.removed, [], "the video is held for the next still");
    assert.equal(err.held?.video.assetId, "v1");

    // The next pick goes on from the held video, which does not go up again.
    const again = world({ still: async () => stillRow({ width: 1280, height: 720 }) });
    await run(again, { still: picked, held: err.held as never });
    assert.deepEqual(again.order, ["map"]);
  });

  test("a held video is deleted when the form lets it go, only if this upload made it", async () => {
    const removed: string[][] = [];
    const remove = async (_r: string, ids: string[]) => void removed.push(ids);
    await discardVideo("r1", { video: { assetId: "v1", ...FACTS }, created: false }, { remove });
    await discardVideo("r1", null, { remove });
    await discardVideo("r1", { video: { assetId: "v2", ...FACTS }, created: true }, { remove });
    assert.deepEqual(removed, [["v2"]]);
  });

  test("the words: aspect, steps and the pickers' types", () => {
    assert.equal(aspectText({ widthPx: 1920, heightPx: 1080 }), "16:9");
    assert.equal(aspectText({ widthPx: 4096, heightPx: 4096 }), "1:1");
    assert.equal(aspectText({ widthPx: 1918, heightPx: 802 }), "2.39:1");
    assert.equal(stepText({ t: "grid" }), "Looking for a grid…");
    assert.equal(mapAccept(true), "image/*,video/webm,video/mp4");
    assert.equal(mapAccept(false), "image/*");
  });
});
