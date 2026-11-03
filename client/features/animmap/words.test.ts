import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_ERROR_CODES } from "#shared/apiErrors.ts";
import { VIDEO_OFF, VIDEO_SHAPE } from "#shared/permissions.ts";
import { ApiError } from "../../lib/api.ts";
import { MOVING, STILL_REASONS, stillFor } from "./status.ts";
import {
  ANIMATED_MAPS_HELP,
  ANIMATED_MAPS_WORDS,
  codecName,
  deviceStillHelp,
  LOW_POWER_HELP,
  playbackLine,
  stillReasonText,
  VIDEO_REFUSALS,
  videoLength,
  videoRefusalText,
  videoRowHelp,
} from "./words.ts";

const webm = { container: "webm" as const, video: "vp09.00.40.08" };

describe("the Map image row's words (docs/design/design-v1-animated-maps.md 4.2)", () => {
  test("the help gives the size, the length and that it loops", () => {
    assert.equal(videoRowHelp({ widthPx: 1920, heightPx: 1080, durationMs: 42_000 }), "A 1920 × 1080 px video, 0:42, looping. Its first frame is the still.");
  });

  test("a length reads as minutes and seconds, rounded to the second", () => {
    assert.equal(videoLength(1_000), "0:01");
    assert.equal(videoLength(41_600), "0:42");
    assert.equal(videoLength(65_000), "1:05");
    assert.equal(videoLength(600_000), "10:00");
  });

  test("the device line says Moving, or Still and why", () => {
    assert.equal(playbackLine(MOVING), "Moving on this device.");
    assert.equal(playbackLine(stillFor("setting")), "Still on this device: Animated maps is set to Still.");
    assert.equal(playbackLine(stillFor("lowPower")), "Still on this device: Low power is on.");
    assert.equal(playbackLine(stillFor("reducedMotion")), "Still on this device: reduced motion is on.");
    assert.equal(playbackLine(stillFor("stillView")), "Still on this device: Isometric and the Builder, Fog, Line up grid and Trap tools show the still.");
    assert.equal(playbackLine(stillFor("codec"), webm), "Still on this device: this device can't play WebM (VP9).");
    assert.equal(playbackLine(stillFor("codec"), { container: "mp4", video: "avc1.64002a" }), "Still on this device: this device can't play MP4 (H.264).");
    assert.equal(playbackLine(stillFor("notSmooth")), "Still on this device: this device can't play this video smoothly or without draining its battery.");
    assert.equal(playbackLine(stillFor("phoneSize")), "Still on this device: Phone size map detail plays videos up to 1920 × 1080 at 30 frames a second.");
    assert.equal(playbackLine(stillFor("notStarted")), "Still on this device: the browser didn't start it. Tap the map to try again.");
    assert.equal(playbackLine(stillFor("slowing")), "Still on this device: the video was slowing this device, so it stays still until you reload.");
    assert.equal(
      playbackLine(stillFor("slowingOrSaving")),
      "Still on this device: the video was slowing this device, or the browser is saving power, so it stays still until you reload.",
    );
    assert.equal(playbackLine(stillFor("loadFailed")), "Still on this device: the video didn't load.");
    assert.equal(playbackLine(stillFor("serverOff")), "Still on this device: animated maps are off on this server.");
  });

  test("every reason has words, each a sentence with no em dash or semicolon", () => {
    for (const reason of STILL_REASONS) {
      const text = stillReasonText(reason, webm);
      assert.match(text, /^\S.*\.$/, reason);
      assert.doesNotMatch(text, /[\u2014;]/, reason);
    }
  });

  test("each codec family has its plain name", () => {
    assert.deepEqual(["vp8", "vp09.00.40.08", "av01.0.08M.08", "avc1.640028", "avc3.42e01e"].map(codecName), ["VP8", "VP9", "AV1", "H.264", "H.264"]);
  });
});

describe("This device and the table display (4.4)", () => {
  test("the choices and their help", () => {
    assert.deepEqual(ANIMATED_MAPS_WORDS, { moving: "Moving", still: "Still" });
    assert.deepEqual(ANIMATED_MAPS_HELP, {
      moving: "Animated maps move. Downloads each map's video, up to 64 MB.",
      still: "Shows the first frame. Downloads no video.",
    });
    assert.match(LOW_POWER_HELP, /keeps weather and animated maps still/);
  });

  test("only reasons that hold for the whole device have a line under the row", () => {
    assert.equal(deviceStillHelp("lowPower"), "Low power keeps animated maps still.");
    assert.equal(deviceStillHelp("reducedMotion"), "Reduced motion keeps animated maps still.");
    for (const reason of ["setting", "stillView", "codec", "notSmooth", "phoneSize", "notStarted", "loadFailed", "serverOff"] as const) {
      assert.equal(deviceStillHelp(reason), undefined, reason);
    }
  });
});

describe("a refused video (4.5)", () => {
  test("every video code the server can answer has words", () => {
    const videoCodes = API_ERROR_CODES.filter((code) => code.startsWith("video_") || code === "bad_video");
    assert.equal(videoCodes.length, 16);
    for (const code of videoCodes) assert.ok(VIDEO_REFUSALS[code], code);
  });

  test("the words are the design's", () => {
    const words = (code: string) => videoRefusalText(new ApiError(400, "x", code as never, null));
    assert.equal(words("video_size"), "Videos can be 256 to 4096 pixels on a side and 8.3 megapixels in all (3840 × 2160).");
    assert.equal(words("too_large"), "That video is too large. Videos can be up to 64 MB.");
    assert.equal(words("video_off"), "Animated maps are off on this server.");
    assert.equal(words("unsupported_type"), words("video_type"));
    assert.equal(words("bad_video"), "That video could not be read.");
  });

  test("anything else is left to the image words", () => {
    assert.equal(videoRefusalText(new ApiError(409, "x", "read_only", null)), undefined);
    assert.equal(videoRefusalText(new Error("boom")), undefined);
    assert.equal(videoRefusalText(new ApiError(0, "x", undefined, null)), undefined);
  });

  test("the op refusals are the permission check's own words", () => {
    assert.equal(VIDEO_SHAPE, "That still isn't the video's shape.");
    assert.equal(VIDEO_OFF, "Animated maps are off on this server.");
  });
});
