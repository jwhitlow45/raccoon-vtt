import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MapVideo, VideoFacts } from "#shared/model.ts";
import { drawnSize } from "#shared/videoGeometry.ts";
import { ApiError, type AssetRow } from "../../lib/api.ts";
import { FirstFrameError, LOW_POWER_STOPPED, NO_FIRST_FRAME, type FirstFrame } from "./firstFrame.ts";
import { animatedUploadText, aspectText, AnimatedUploadError, discardVideo, mapAccept, shapeRefusalText, stepText, uploadAnimatedMap, VideoHold, VIDEO_PICK_HELP, type UploadDeps, type UploadStep } from "./upload.ts";
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
function world(answers: { frame?: () => Promise<FirstFrame | null>; stored?: (video: MapVideo) => Promise<FirstFrame>; video?: () => Promise<AssetRow>; still?: () => Promise<AssetRow> } = {}) {
  const calls: Call[] = [];
  const removed: string[][] = [];
  const order: string[] = [];
  const deps: UploadDeps = {
    readFrame: async () => {
      order.push("frame");
      return answers.frame ? answers.frame() : { blob: new Blob([new Uint8Array(3)], { type: "image/webp" }), widthPx: 1920, heightPx: 1080, durationMs: 42_000 };
    },
    readStored: async (video) => {
      order.push(`stored ${video.assetId}`);
      return answers.stored ? answers.stored(video) : { blob: new Blob([new Uint8Array(3)], { type: "image/jpeg" }), widthPx: 1920, heightPx: 1080, durationMs: 42_000 };
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

  test("Low Power Mode stopping the probe on the picked file stops before anything goes up", async () => {
    const w = world({ frame: async () => Promise.reject(new FirstFrameError({ kind: "lowPower" })) });
    const err = await run(w).catch((e: unknown) => e);
    assert.ok(err instanceof FirstFrameError);
    assert.equal(animatedUploadText(err), LOW_POWER_STOPPED);
    assert.deepEqual(w.order, ["frame"]);
  });

  test("no local frame, as a MOV this device cannot read or a size past the caps: the video goes up and the still is read from the stored copy (docs/design/design-v1-video-turns.md 8)", async () => {
    const w = world({ frame: async () => null });
    const { result, steps } = await run(w);
    assert.deepEqual(w.order, ["frame", "video", "stored v1", "map"]);
    assert.deepEqual(steps.filter((s) => s === "Reading the first frame…").length, 2, "the busy button reads the first frame again");
    assert.ok(steps.indexOf("Reading the first frame…", 1) > steps.indexOf("Uploading the video… 100%"), steps.join(" | "));
    assert.equal(result.stillFile.name, "crypt_30x20.jpg");
    assert.deepEqual(w.removed, []);
  });

  test("a turned, mirrored or stretched video's still always comes from the stored copy, never the local frame; a plain one's from the local frame", async () => {
    for (const geometry of [{ turn: 90 as const }, { mirror: true as const }, { displayWidthPx: 2560 }, {}]) {
      const shown = drawnSize({ ...FACTS, ...geometry });
      const w = world({ video: async () => videoRow({ video: { ...FACTS, ...geometry } }), still: async () => stillRow({ width: shown.widthPx, height: shown.heightPx }) });
      await run(w);
      const plain = Object.keys(geometry).length === 0;
      assert.deepEqual(w.order, plain ? ["frame", "video", "map"] : ["frame", "video", "stored v1", "map"], JSON.stringify(geometry));
    }
  });

  test("a stored copy this device cannot read holds the video for a still the DM picks, and Low Power Mode's Try again reads it again without a second upload", async () => {
    const turned = videoRow({ width: 1920, height: 1080, video: { ...FACTS, turn: 90 } });
    for (const kind of ["unreadable", "lowPower"] as const) {
      const w = world({ video: async () => turned, stored: async () => Promise.reject(new FirstFrameError({ kind })) });
      const err = await run(w).catch((e: unknown) => e);
      assert.ok(err instanceof AnimatedUploadError, kind);
      assert.equal(err.step, "frame");
      assert.equal(animatedUploadText(err), kind === "lowPower" ? LOW_POWER_STOPPED : NO_FIRST_FRAME);
      assert.equal(err.held?.video.assetId, "v1");
      assert.deepEqual(w.removed, [], `${kind}: the video is held`);
      // Try again: the held video, no still, so only the stored copy is read again.
      const again = world({ still: async () => stillRow({ width: 1080, height: 1920 }) });
      await run(again, { held: err.held as never });
      assert.deepEqual(again.order, ["stored v1", "map"], kind);
    }
  });

  test("a cancel while the stored copy is read deletes the video this upload made", async () => {
    const abort = new AbortController();
    const w = world({
      frame: async () => null,
      stored: () => {
        abort.abort();
        return Promise.reject(abort.signal.reason);
      },
    });
    const err = await run(w, { signal: abort.signal }).catch((e: unknown) => e);
    assert.ok(err instanceof DOMException && err.name === "AbortError");
    assert.deepEqual(w.removed, [["v1"]]);
    assert.ok(!w.order.includes("map"), "no still went up");
  });

  test("a cancel as the stored copy fails to read is a cancel, not a hold: the video this upload made is deleted", async () => {
    for (const kind of ["unreadable", "lowPower"] as const) {
      const abort = new AbortController();
      const w = world({
        frame: async () => null,
        stored: () => {
          abort.abort();
          return Promise.reject(new FirstFrameError({ kind }));
        },
      });
      const err = await run(w, { signal: abort.signal }).catch((e: unknown) => e);
      assert.ok(err instanceof FirstFrameError, kind);
      assert.ok(!(err instanceof AnimatedUploadError), `${kind}: nothing held`);
      assert.deepEqual(w.removed, [["v1"]], kind);
    }
  });

  test("a form's run that a cancel races holds nothing, whatever the steps held", async () => {
    const removed: string[][] = [];
    const abort = new AbortController();
    const turned = videoRow({ video: { ...FACTS, turn: 90 } });
    const w = world({ video: async () => turned, still: async () => (abort.abort(), stillRow({ width: 500, height: 500 })) });
    const hold = new VideoHold(() => "r1", { remove: async (_r, ids) => void removed.push(ids) });
    const err = await hold.run({ roomId: "r1", file, host: null, signal: abort.signal, onStep: () => {}, deps: w.deps }).catch((e: unknown) => e);
    assert.ok(err instanceof DOMException && err.name === "AbortError", "the cancel, not the shape refusal that raced it");
    assert.equal(hold.held, null);
    assert.deepEqual(removed, [["v1"]]);
  });

  test("a MOV goes up as an MP4, the type the server checks and stores it as", async () => {
    const w = world();
    const mov = new File([new Uint8Array(10)], "IMG_0042.MOV", { type: "video/quicktime" });
    await uploadAnimatedMap({ roomId: "r1", file: mov, host: null, signal: new AbortController().signal, onStep: () => {}, deps: w.deps });
    assert.deepEqual(w.calls[0], { kind: "video", name: "IMG_0042.MOV", type: "video/mp4" });
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

  test("a picked still for a portrait video is checked against, and refused with, its shape as it shows: 9:16", async () => {
    const turned = { ...FACTS, turn: 90 as const };
    assert.equal(shapeRefusalText(turned), "That image isn't the video's shape (9:16). Pick one the same shape.");
    assert.equal(shapeRefusalText({ ...FACTS, widthPx: 1440, displayWidthPx: 1920 }), "That image isn't the video's shape (16:9). Pick one the same shape.");
    const picked = new File([new Uint8Array(5)], "still.jpg", { type: "image/jpeg" });
    const off = world({ video: async () => videoRow({ video: turned }), still: async () => stillRow({ width: 1920, height: 1080 }) });
    const err = await run(off, { still: picked }).catch((e: unknown) => e);
    assert.ok(err instanceof AnimatedUploadError && err.step === "shape");
    assert.equal(err.message, "That image isn't the video's shape (9:16). Pick one the same shape.");
    const ok = world({ video: async () => videoRow({ video: turned }), still: async () => stillRow({ width: 1080, height: 1920 }) });
    const { result } = await run(ok, { still: picked });
    assert.equal(result.asset.video.turn, 90);
  });

  test("the words: aspect, steps, the pickers' types and the help", () => {
    assert.equal(aspectText({ widthPx: 1920, heightPx: 1080 }), "16:9");
    assert.equal(aspectText({ widthPx: 4096, heightPx: 4096 }), "1:1");
    assert.equal(aspectText({ widthPx: 1918, heightPx: 802 }), "2.39:1");
    assert.equal(stepText({ t: "grid" }), "Looking for a grid…");
    assert.equal(mapAccept(true), "image/*,video/webm,video/mp4,video/quicktime,.mov");
    assert.equal(mapAccept(false), "image/*");
    assert.equal(VIDEO_PICK_HELP, "A WebM, MP4 or MOV video makes an animated map, up to 64 MB. H.264 plays on the most devices.");
  });

  test("a form's hold: kept for a still pick and a Try again of its own file, deleted on another file, a cancel or when the map takes it not", async () => {
    const removed: string[][] = [];
    const hold = new VideoHold(() => "r1", { remove: async (_r, ids) => void removed.push(ids) });
    const a = new File([new Uint8Array(1)], "a.mp4", { type: "video/mp4" });
    const b = new File([new Uint8Array(1)], "b.mp4", { type: "video/mp4" });
    const held = { video: { assetId: "v1", ...FACTS }, created: true };
    hold.hold(a, held);
    assert.equal(hold.forRun(a, true), held, "a still pick");
    assert.equal(hold.forRun(a, false), held, "Try again of the same file");
    assert.equal(hold.forRun(b, true), held, "a still pick is always for the held video");
    assert.deepEqual(removed, []);
    assert.equal(hold.forRun(b, false), null, "another file lets it go");
    await Promise.resolve();
    assert.deepEqual(removed, [["v1"]]);
    hold.hold(a, held);
    hold.taken();
    hold.release();
    await Promise.resolve();
    assert.deepEqual(removed, [["v1"]], "taken by the map, never deleted");
    hold.hold(a, { ...held, created: false });
    hold.release();
    await Promise.resolve();
    assert.deepEqual(removed, [["v1"]], "a video the room already held stays");
  });
});
