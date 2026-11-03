import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapVideo } from "#shared/model.ts";
import { RoomScope, RoomScopeProvider } from "../../state/scope.ts";
import { setAnimatedMaps, setLowPower } from "../device/settings.ts";
import { decodable, decodableKey, forgetCapabilitiesForTests } from "./capabilities.ts";
import { boardVideoSlot, MOVING, resetServerAnimatedMapsForTests, serverAnimatedMaps, stillFor, type Playback } from "./status.ts";
import { useVideoPlayback, videoPlayback, type DeviceInput } from "./useVideoPlayback.ts";

/*
 * What a device does with a video the board is not playing, as the Map
 * image row and the Library viewer read it (docs/design/design-v1-animated-maps.md
 * 4.2 and 4.6): judged from the device's inputs as they are on each render,
 * with no board needed, so a change of any of them judges again
 * (AMBUILD-ASTRA-05, AM-R1-03).
 */

const VIDEO: MapVideo = { assetId: "loop", widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 4000 };
const UHD: MapVideo = { ...VIDEO, assetId: "uhd", widthPx: 3840, heightPx: 2160 };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetServerAnimatedMapsForTests();
  forgetCapabilitiesForTests();
  setLowPower(false);
  setAnimatedMaps("moving");
});

/** The server's config, answered as GET /api/config would. */
async function serverSays(on: boolean): Promise<void> {
  globalThis.fetch = (async () => new Response(JSON.stringify({ animatedMaps: on }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  await serverAnimatedMaps();
}

/** What the hook gives for `video` in one render, in a Room whose board shows `board`, or in no Room at all. */
function rendered(video: MapVideo, board?: { assetId: string; playback: Playback } | null): Playback | null {
  let out: Playback | null = null;
  const Probe = () => {
    out = useVideoPlayback(video);
    return null;
  };
  if (board === undefined) renderToStaticMarkup(createElement(Probe));
  else {
    const scope = new RoomScope();
    scope.get(boardVideoSlot).set(board);
    renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: createElement(Probe) }));
  }
  return out;
}

describe("a video the board is not playing", () => {
  test("waits for the server's answer and the browser's, with no board mounted, then moves (AM-R1-03)", async () => {
    assert.equal(rendered(VIDEO), null, "the server has not answered");
    await serverSays(true);
    assert.equal(rendered(VIDEO), null, "the browser has not answered");
    await decodable(VIDEO, false, { canPlayType: () => "probably" });
    assert.deepEqual(rendered(VIDEO), MOVING);
  });

  test("judges again when Low power or Animated maps changes while it shows (AMBUILD-ASTRA-05)", async () => {
    await serverSays(true);
    await decodable(VIDEO, false, { canPlayType: () => "probably" });
    assert.deepEqual(rendered(VIDEO), MOVING);
    setLowPower(true);
    assert.deepEqual(rendered(VIDEO), stillFor("lowPower"));
    setLowPower(false);
    setAnimatedMaps("still");
    assert.deepEqual(rendered(VIDEO), stillFor("setting"));
    setAnimatedMaps("moving");
    assert.deepEqual(rendered(VIDEO), MOVING);
  });

  test("a server that says off, or the device's own choices, need no answer from the browser", async () => {
    await serverSays(false);
    assert.deepEqual(rendered(VIDEO), stillFor("serverOff"));
    resetServerAnimatedMapsForTests();
    await serverSays(true);
    setLowPower(true);
    assert.deepEqual(rendered(VIDEO), stillFor("lowPower"));
  });

  test("the browser's answer is kept per file and question, apart from the judgment", async () => {
    await serverSays(true);
    await decodable(UHD, false, { canPlayType: () => "" });
    assert.deepEqual(rendered(UHD), stillFor("codec"));
    assert.notEqual(decodableKey(VIDEO, false), decodableKey(VIDEO, true), "Phone size asks its own question");
  });

  test("the board's own status speaks for the video it shows", async () => {
    await serverSays(true);
    assert.deepEqual(rendered(VIDEO, { assetId: "loop", playback: stillFor("notStarted") }), stillFor("notStarted"));
    assert.equal(rendered(VIDEO, { assetId: "other", playback: MOVING }), null, "another video waits for the browser");
  });
});

describe("the judgment from what the hook read", () => {
  const device: DeviceInput = { server: true, setting: "moving", lowPower: false, reducedMotion: false, variant: "full", steppedDown: null };

  test("reduced motion, the step-down and Phone size each say Still, in the rule's order", () => {
    assert.deepEqual(videoPlayback(VIDEO, null, { ...device, reducedMotion: true }, null), stillFor("reducedMotion"));
    assert.deepEqual(videoPlayback(VIDEO, null, { ...device, steppedDown: "slowing" }, "smooth"), stillFor("slowing"));
    assert.equal(videoPlayback(UHD, null, { ...device, variant: "mobile" }, null), null, "the format's answer comes first");
    assert.deepEqual(videoPlayback(UHD, null, { ...device, variant: "mobile" }, "smooth"), stillFor("phoneSize"));
    assert.deepEqual(videoPlayback(VIDEO, null, { ...device, server: null }, "smooth"), null);
  });
});
