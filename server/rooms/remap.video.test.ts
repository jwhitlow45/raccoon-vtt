import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MapVideo, RoomState, VideoFacts } from "#shared/model.ts";
import { projectState, visibleAssetIds } from "#shared/project.ts";
import { P1, room } from "#shared/testutil.ts";
import { refillMapVideos, remapState, type ImportedAsset } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * A backup's videos on import (docs/design/design-v1-animated-maps.md 9.3):
 * each follows its row's new id or goes and leaves its still, then
 * `refillMapVideos` takes every fact from the new rows, and the map always
 * shows the surviving active phase's video.
 */

function facts(overrides: Partial<VideoFacts> = {}): VideoFacts {
  return { widthPx: 1920, heightPx: 1080, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 6_000, ...overrides };
}

/** What a hand-made or older file might claim: every number unlike the row's. */
const CLAIMED: VideoFacts = { widthPx: 1920, heightPx: 1080, container: "mp4", video: "avc1.640028", fps: 24, durationMs: 9_999, kbps: 1 };
const v = (assetId: string): MapVideo => ({ assetId, ...CLAIMED });
const GRID = { refWidthPx: 1920, refHeightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };
const MAP = { assetId: "day", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };

function file(): RoomState {
  const state = room();
  state.scenes.s1 = {
    ...state.scenes.s1!,
    map: { ...MAP, video: v("v-day") },
    phases: [
      { id: "p1", name: "Day", assetId: "day", widthPx: 1920, heightPx: 1080, video: v("v-day") },
      { id: "p2", name: "Night", assetId: "night", widthPx: 1920, heightPx: 1080, video: v("v-night") },
      { id: "p3", name: "Fire", assetId: "fire", widthPx: 1920, heightPx: 1080 },
    ],
    phaseId: "p1",
    phaseGrid: GRID,
  };
  state.scenes.s2 = { ...state.scenes.s2!, map: { ...MAP, assetId: "crypt", video: v("v-crypt") } };
  return state;
}

const ROWS: [string, ImportedAsset][] = [
  ["day", { id: "day2", kind: "map" }],
  ["night", { id: "night2", kind: "map" }],
  ["fire", { id: "fire2", kind: "map" }],
  ["crypt", { id: "crypt2", kind: "map" }],
  ["v-day", { id: "v-day2", kind: "video" }],
  ["v-night", { id: "v-night2", kind: "video" }],
  ["v-crypt", { id: "v-crypt2", kind: "video" }],
];

const REAL = new Map<string, VideoFacts>([
  ["v-day2", facts()],
  ["v-night2", facts({ container: "mp4", video: "avc1.640028", audio: "mp4a.40.2", audioChannels: 2, audioHz: 48_000 })],
  ["v-crypt2", facts({ fps: 60 })],
]);

function imported(rows: [string, ImportedAsset][] = ROWS, real: ReadonlyMap<string, VideoFacts> = REAL): RoomState {
  return refillMapVideos(remapState(file(), { assets: new Map(rows) }), real);
}

describe("a backup's videos on import (docs/design/design-v1-animated-maps.md 9.3)", () => {
  test("each video takes its new id and every fact from its row, on the map and on each phase", () => {
    const state = imported();
    const [s1, s2] = Object.values(state.scenes).sort((a, b) => a.order - b.order);
    assert.deepEqual(s1!.map?.video, { assetId: "v-day2", ...facts() });
    assert.deepEqual(s1!.phases?.map((p) => p.video?.assetId), ["v-day2", "v-night2", undefined]);
    assert.deepEqual(s1!.phases?.[1]?.video, { assetId: "v-night2", ...REAL.get("v-night2")! });
    assert.deepEqual(s2!.map?.video, { assetId: "v-crypt2", ...facts({ fps: 60 }) });
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(state))).ok);
  });

  test("a video whose row did not come through, or came as another kind, leaves its still as a plain map", () => {
    const skipped = ROWS.filter(([old]) => old !== "v-day" && old !== "v-crypt").concat([["v-crypt", { id: "v-crypt2", kind: "map" }]]);
    const state = imported(skipped);
    const [s1, s2] = Object.values(state.scenes).sort((a, b) => a.order - b.order);
    assert.equal(s1!.phaseId, "p1", "the showing phase stays, as a still");
    assert.equal(s1!.map?.assetId, "day2");
    assert.equal("video" in s1!.map!, false);
    assert.deepEqual(s1!.phases?.map((p) => p.video?.assetId), [undefined, "v-night2", undefined]);
    assert.equal(s2!.map?.assetId, "crypt2");
    assert.equal("video" in s2!.map!, false);
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(state))).ok);
  });

  test("with the server's switch off the import brings no video, and every map keeps its still", () => {
    const state = imported(ROWS.filter(([, row]) => row.kind !== "video"), new Map());
    for (const scene of Object.values(state.scenes)) {
      assert.equal(scene.map?.video, undefined);
      for (const p of scene.phases ?? []) assert.equal(p.video, undefined);
    }
    assert.equal(JSON.stringify(state).includes("v-"), false);
  });

  test("when the showing phase's still did not come through, the first phase left shows, with its video on the map", () => {
    const state = imported(ROWS.filter(([old]) => old !== "day"));
    const s1 = Object.values(state.scenes).sort((a, b) => a.order - b.order)[0]!;
    assert.equal(s1.phaseId, "p2");
    assert.deepEqual(s1.map?.video, { assetId: "v-night2", ...REAL.get("v-night2")! });
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(state))).ok);
  });

  test("a row's facts that do not check, or a video its still no longer fits, are dropped like a missing row", () => {
    const real = new Map(REAL);
    real.set("v-night2", { ...facts(), fps: 500 });
    real.set("v-crypt2", facts({ widthPx: 1080, heightPx: 1920 }));
    const state = imported(ROWS, real);
    const [s1, s2] = Object.values(state.scenes).sort((a, b) => a.order - b.order);
    assert.deepEqual(s1!.phases?.map((p) => p.video?.assetId), ["v-day2", undefined, undefined]);
    assert.equal(s2!.map?.video, undefined, "a video turned on its side");
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(state))).ok);
  });

  test("a row's facts with more fields than a video holds are read for the video's fields alone", () => {
    const real = new Map([...REAL].map(([id, f]) => [id, { ...f, assetId: "other", pipeline: 1 } as VideoFacts]));
    const state = imported(ROWS, real);
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(state))).ok);
    assert.equal(JSON.stringify(state).includes("other"), false);
  });

  test("players of the imported room get only the showing phase's video", () => {
    const state = imported();
    const s1 = Object.values(state.scenes).sort((a, b) => a.order - b.order)[0]!;
    state.meta.playerSceneId = s1.id;
    const text = JSON.stringify(projectState(state, P1, { sceneId: s1.id }));
    const visible = visibleAssetIds(state, P1, { sceneId: s1.id });
    assert.ok(text.includes("v-day2") && visible.has("v-day2"));
    for (const hidden of ["v-night2", "v-crypt2"]) assert.ok(!text.includes(hidden) && !visible.has(hidden), hidden);
  });
});
