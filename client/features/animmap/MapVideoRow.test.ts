import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MapVideo } from "#shared/model.ts";
import { RoomScope, RoomScopeProvider } from "../../state/scope.ts";
import { boardVideoSlot, MOVING, stillFor, type Playback } from "./status.ts";

/*
 * The Map image row of an animated map (docs/design/design-v1-animated-maps.md
 * 4.2): its help, and under it this device's line, read from the board's
 * status while the board shows that video.
 */

const { MapVideoHelp, stillOnly, StillPick } = await import("./MapVideoRow.tsx");

const VIDEO: MapVideo = { assetId: "loop", widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 4000 };

function help(board: { assetId: string; playback: Playback } | null) {
  const scope = new RoomScope();
  scope.get(boardVideoSlot).set(board);
  return renderToStaticMarkup(createElement(RoomScopeProvider, { scope, children: createElement(MapVideoHelp, { video: VIDEO }) }));
}

describe("the Map image row of an animated map", () => {
  test("its help reads the size, the length and looping, then Moving while the board plays it", () => {
    const markup = help({ assetId: "loop", playback: MOVING });
    assert.match(markup, /A 1920 × 1080 px video, 0:42, looping\. Its first frame is the still\./);
    assert.match(markup, /Moving on this device\./);
  });

  test("the board's reason when it shows the still: a setup tool, Low power, a format this device cannot play", () => {
    assert.match(help({ assetId: "loop", playback: stillFor("stillView") }), /Still on this device: Isometric and the Builder, Fog, Line up grid and Trap tools show the still\./);
    assert.match(help({ assetId: "loop", playback: stillFor("lowPower") }), /Still on this device: Low power is on\./);
    assert.match(help({ assetId: "loop", playback: stillFor("codec") }), /Still on this device: this device can&#x27;t play WebM \(VP9\)\./);
  });

  test("the board on another video says nothing for this one: the line waits for the device's judgment", () => {
    const markup = help({ assetId: "other", playback: MOVING });
    assert.doesNotMatch(markup, /on this device/);
  });

  test("Use the still only keeps the still and its grid, without the video", () => {
    const map = { assetId: "still", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 3, y: 4 }, video: VIDEO };
    assert.deepEqual(stillOnly(map), { assetId: "still", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 3, y: 4 } });
  });

  test("a frame this device cannot read asks for a still image, and Low Power Mode adds Try again", () => {
    const file = new File([new Uint8Array(1)], "loop.webm", { type: "video/webm" });
    const unreadable = renderToStaticMarkup(createElement(StillPick, { pending: { file, lowPower: false, problem: null }, busy: false, onStill: () => {}, onRetry: () => {} }));
    assert.match(unreadable, /This device can&#x27;t read that video&#x27;s first frame\. Pick a still image for it, such as the one that came with the map\./);
    assert.match(unreadable, /Pick a still image/);
    assert.doesNotMatch(unreadable, /Try again/);
    const lowPower = renderToStaticMarkup(createElement(StillPick, { pending: { file, lowPower: true, problem: null }, busy: false, onStill: () => {}, onRetry: () => {} }));
    assert.match(lowPower, /Low Power Mode stopped the video from opening\. Tap Try again, or pick a still image\./);
    assert.match(lowPower, />Try again</);
    const shape = renderToStaticMarkup(createElement(StillPick, { pending: { file, lowPower: false, problem: "That image isn't the video's shape (16:9). Pick one the same shape." }, busy: false, onStill: () => {}, onRetry: () => {} }));
    assert.match(shape, /That image isn&#x27;t the video&#x27;s shape \(16:9\)\./);
  });
});
