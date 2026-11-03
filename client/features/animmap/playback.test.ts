import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { MapVideo } from "#shared/model.ts";
import { askBrowser, decodable, decodingConfig, forgetCapabilitiesForTests, playType, type DecodingConfig } from "./capabilities.ts";
import { playback, sizeProblem, type PlaybackInput } from "./playback.ts";
import { MOVING, stillFor } from "./status.ts";

/*
 * When a device plays a video map (docs/design/design-v1-animated-maps.md
 * 5.3): every rule and its reason, and Media Capabilities asked one codec
 * per track.
 */

const HD: MapVideo = { assetId: "v1", widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 4_000 };
const UHD: MapVideo = { ...HD, assetId: "v2", widthPx: 3840, heightPx: 2160 };
const FAST: MapVideo = { ...HD, assetId: "v3", fps: 60 };
const SOUND: MapVideo = { ...HD, assetId: "v4", container: "mp4", video: "avc1.640028", audio: "mp4a.40.2", audioChannels: 2, audioHz: 48_000 };

const PLAYS: PlaybackInput = { server: true, setting: "moving", lowPower: false, reducedMotion: false, variant: "full", decodable: "smooth", steppedDown: null };

describe("the playback rule", () => {
  test("a device with nothing against it plays", () => {
    assert.deepEqual(playback(HD, PLAYS), MOVING);
  });

  test("rule 1: the server's switch, the choice, Low power and reduced motion, in that order", () => {
    assert.deepEqual(playback(HD, { ...PLAYS, server: false, setting: "still", lowPower: true }), stillFor("serverOff"));
    assert.deepEqual(playback(HD, { ...PLAYS, setting: "still", lowPower: true }), stillFor("setting"));
    assert.deepEqual(playback(HD, { ...PLAYS, lowPower: true, reducedMotion: true }), stillFor("lowPower"));
    assert.deepEqual(playback(HD, { ...PLAYS, reducedMotion: true }), stillFor("reducedMotion"));
  });

  test("rule 2: what the browser says of the file", () => {
    assert.deepEqual(playback(HD, { ...PLAYS, decodable: "codec" }), stillFor("codec"));
    assert.deepEqual(playback(HD, { ...PLAYS, decodable: "notSmooth" }), stillFor("notSmooth"));
  });

  test("rule 3: Phone size plays up to 1920 x 1080, either way up, at a peak of 31 frames in a second", () => {
    const phone = { ...PLAYS, variant: "mobile" as const };
    assert.deepEqual(playback(HD, phone), MOVING);
    assert.deepEqual(playback({ ...HD, widthPx: 1080, heightPx: 1920 }, phone), MOVING, "portrait the other way round");
    assert.deepEqual(playback({ ...HD, fps: 31 }, phone), MOVING, "a nominal 30 fps passes");
    assert.deepEqual(playback(UHD, phone), stillFor("phoneSize"));
    assert.deepEqual(playback(FAST, phone), stillFor("phoneSize"));
    assert.deepEqual(playback({ ...HD, fps: 32 }, phone), stillFor("phoneSize"));
    assert.deepEqual(playback(UHD, PLAYS), MOVING, "Full size plays 4K");
    assert.deepEqual(playback(FAST, PLAYS), MOVING, "Full size plays 60 fps");
  });

  test("rule 4: the step-down, the real size, a failed load, what the board shows and the browser's start", () => {
    assert.deepEqual(playback(HD, { ...PLAYS, steppedDown: "slowing" }), stillFor("slowing"));
    assert.deepEqual(playback(HD, { ...PLAYS, steppedDown: "slowingOrSaving" }), stillFor("slowingOrSaving"));
    assert.deepEqual(playback(HD, { ...PLAYS, variant: "mobile", realSize: { widthPx: 2560, heightPx: 1440 } }), stillFor("phoneSize"), "a stream that grew past the rule mid-file");
    assert.deepEqual(playback(HD, { ...PLAYS, realSize: { widthPx: 2560, heightPx: 1440 } }), MOVING, "Full size takes it");
    assert.deepEqual(playback(HD, { ...PLAYS, loadFailed: true }), stillFor("loadFailed"));
    assert.deepEqual(playback(HD, { ...PLAYS, stillView: true }), stillFor("stillView"));
    assert.deepEqual(playback(HD, { ...PLAYS, notStarted: true }), stillFor("notStarted"));
  });

  test("the real size holds to the server's caps on any device", () => {
    assert.equal(sizeProblem({ widthPx: 4097, heightPx: 256 }, 30, "full"), "notSmooth");
    assert.equal(sizeProblem({ widthPx: 4096, heightPx: 2160 }, 30, "full"), "notSmooth", "past 8.3 megapixels");
    assert.equal(sizeProblem({ widthPx: 3840, heightPx: 2160 }, 30, "full"), null);
    assert.equal(sizeProblem({ widthPx: 1920, heightPx: 1088 }, 30, "mobile"), "phoneSize");
  });
});

describe("what the browser can play", () => {
  afterEach(() => forgetCapabilitiesForTests());

  /** A stub of Media Capabilities that refuses a content type naming two codecs, as browsers do (AMN-1). */
  function strict(answer: { supported: boolean; smooth: boolean; powerEfficient: boolean }, seen: DecodingConfig[] = []) {
    return async (config: DecodingConfig) => {
      seen.push(config);
      for (const type of [config.video.contentType, config.audio?.contentType]) if (type && /codecs="[^"]*,/.test(type)) throw new TypeError("one codec per track");
      return answer;
    };
  }

  test("a video with sound asks one codec per configuration, the sound its own, and plays", async () => {
    const seen: DecodingConfig[] = [];
    assert.equal(await askBrowser(SOUND, false, { decodingInfo: strict({ supported: true, smooth: true, powerEfficient: true }, seen) }), "smooth");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], {
      type: "file",
      video: { contentType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, bitrate: 4_000_000, framerate: 30 },
      audio: { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: "2", bitrate: 128_000, samplerate: 48_000 },
    });
    assert.equal(decodingConfig(HD).audio, undefined, "no sound, no audio configuration");
  });

  test("unsupported is the format, not smooth is the device, and Phone size asks for power efficiency", async () => {
    assert.equal(await askBrowser(HD, false, { decodingInfo: strict({ supported: false, smooth: false, powerEfficient: false }) }), "codec");
    assert.equal(await askBrowser(HD, false, { decodingInfo: strict({ supported: true, smooth: false, powerEfficient: true }) }), "notSmooth");
    const software = strict({ supported: true, smooth: true, powerEfficient: false });
    assert.equal(await askBrowser(HD, false, { decodingInfo: software }), "smooth", "Full size plays a smooth software decoder");
    assert.equal(await askBrowser(HD, true, { decodingInfo: software }), "notSmooth", "Phone size does not");
  });

  test("without Media Capabilities, canPlayType takes both codecs in one string", async () => {
    const asked: string[] = [];
    const canPlayType = (type: string) => (asked.push(type), type.includes("vp09") ? "probably" : "");
    assert.equal(await askBrowser({ ...HD, audio: "opus" }, false, { canPlayType }), "smooth");
    assert.deepEqual(asked, ['video/webm; codecs="vp09.00.40.08,opus"']);
    assert.equal(await askBrowser({ ...HD, video: "av01.0.08M.08" }, false, { canPlayType }), "codec");
    assert.equal(await askBrowser(HD, false, { canPlayType: () => "maybe" }), "smooth");
    assert.equal(playType(HD), 'video/webm; codecs="vp09.00.40.08"');
  });

  test("a configuration the API refuses falls back to canPlayType, and a browser with neither plays nothing", async () => {
    const refuses = async () => {
      throw new TypeError("bad config");
    };
    assert.equal(await askBrowser(HD, false, { decodingInfo: refuses, canPlayType: () => "probably" }), "smooth");
    assert.equal(await askBrowser(HD, false, {}), "codec");
  });

  test("the answer is asked once a page for each file and question", async () => {
    let asks = 0;
    const env = { decodingInfo: async () => (asks++, { supported: true, smooth: true, powerEfficient: true }) };
    await decodable(HD, false, env);
    await decodable(HD, false, env);
    assert.equal(asks, 1);
    await decodable(HD, true, env);
    await decodable(UHD, false, env);
    assert.equal(asks, 3);
  });
});
