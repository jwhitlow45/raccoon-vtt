import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import type { MapVideo, RoomState, SceneMap } from "./model.ts";
import { canApply, VIDEO_MISSING, VIDEO_OFF, VIDEO_SHAPE, type AssetKind, type PermissionDeps } from "./permissions.ts";
import type { MapPhaseInput, Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, env, room, scene } from "./testutil.ts";

/**
 * Animated maps' permission rules (docs/design/design-v1-animated-maps.md
 * 9.2): a video must be a checked video row of the room, its still must be
 * its shape within a pixel, and while the server's switch is off no op may
 * bring in a video the room's state does not already hold.
 */

function video(assetId: string, widthPx = 1920, heightPx = 1080): MapVideo {
  return { assetId, widthPx, heightPx, container: "mp4", video: "avc1.640028", audio: "mp4a.40.2", fps: 30, durationMs: 42_000, kbps: 6_000, audioChannels: 2, audioHz: 48_000 };
}

const STILL: SceneMap = { assetId: "a-day", widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };
const ROWS: Record<string, AssetKind> = { "a-day": "map", "a-night": "map", "a-fire": "map", "a-tall": "map", "v-day": "video", "v-night": "video", "v-new": "video", "v-other": "video", "a-map-as-video": "map" };

function depsWith(overrides: Partial<PermissionDeps> = {}): PermissionDeps {
  // Lowercased, as the actor reads asset rows.
  return { canUseAsset: (_member, assetId, kind) => ROWS[assetId.toLowerCase()] === kind, restoredAssetUsable: (assetId, kind) => ROWS[assetId.toLowerCase()] === kind, ...overrides };
}

function phase(id: string, assetId: string, v?: MapVideo): MapPhaseInput {
  return { id, name: `Phase ${id}`, assetId, widthPx: 1920, heightPx: 1080, ...(v ? { video: v } : {}) };
}

/** A scene with two video phases and a still one, and a plain scene. */
function held(): RoomState {
  const state = room({ scenes: { s1: scene("s1", { map: { ...STILL, video: video("v-day") } }), s2: scene("s2") } });
  const listed = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { phases: [phase("p1", "a-day", video("v-day")), phase("p2", "a-night", video("v-night")), phase("p3", "a-fire")] } }, DM, env(1));
  assert.ok(listed.ok);
  return listed.state;
}

function decide(op: Op, state: RoomState, deps: PermissionDeps = depsWith(), who = DM): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

describe("a map's video (docs/design/design-v1-animated-maps.md 9.2)", () => {
  test("a checked video row of the room passes on every op that sets a map or a phase", () => {
    const state = held();
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("v-new") } }, state), "ok");
    assert.equal(decide({ t: "scene.create", scene: { id: "s9", name: "Crypt", bounds: { w: 30, h: 17 }, map: { ...STILL, video: video("v-new") } } }, state), "ok");
    assert.equal(decide({ t: "scene.update", sceneId: "s1", patch: { phases: [phase("p1", "a-day", video("v-new"))] } }, state), "ok");
  });

  test("a video that is not a video row of the room is refused, and a still that is not a map row stays not here", () => {
    const state = held();
    const invalid = `invalid: ${VIDEO_MISSING}`;
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("v-unknown") } }, state), invalid);
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("a-map-as-video") } }, state), invalid, "a map image named as a video");
    assert.equal(decide({ t: "scene.create", scene: { id: "s9", name: "Crypt", bounds: { w: 30, h: 17 }, map: { ...STILL, video: video("v-unknown") } } }, state), invalid);
    assert.equal(decide({ t: "scene.update", sceneId: "s1", patch: { phases: [phase("p1", "a-day", video("v-day")), phase("p2", "a-night", video("v-unknown"))] } }, state), invalid);
    // The still is checked first, as before animated maps: its own answer stays `gone`.
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, assetId: "v-new", video: video("v-new") } }, state), "gone: that is not here");
    assert.equal(decide({ t: "scene.update", sceneId: "s1", patch: { phases: [phase("p1", "missing", video("v-day"))] } }, state), "gone: that is not here");
  });

  test("the still must be the video's shape within a pixel, after scaling", () => {
    const state = held();
    const set = (still: Partial<SceneMap>, v: MapVideo) => decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, ...still, video: v } }, state);
    assert.equal(set({}, video("v-new")), "ok");
    assert.equal(set({ widthPx: 3840, heightPx: 2160 }, video("v-new")), "ok", "a larger still of the same shape");
    assert.equal(set({ heightPx: 1081 }, video("v-new")), "ok", "one pixel off");
    assert.equal(set({ heightPx: 1082 }, video("v-new")), `invalid: ${VIDEO_SHAPE}`);
    assert.equal(set({ heightPx: 1078 }, video("v-new")), `invalid: ${VIDEO_SHAPE}`);
    assert.equal(set({ assetId: "a-tall", widthPx: 1080, heightPx: 1920 }, video("v-new")), `invalid: ${VIDEO_SHAPE}`, "a still turned on its side");
    const phases = [phase("p1", "a-day", video("v-day")), { ...phase("p2", "a-night"), widthPx: 1920, heightPx: 1080, video: video("v-night", 1920, 1200) }];
    assert.equal(decide({ t: "scene.update", sceneId: "s1", patch: { phases } }, state), `invalid: ${VIDEO_SHAPE}`);
  });

  test("the still is held to the shape the video is drawn at, turned and stretched (docs/design/design-v1-video-turns.md 6.2)", () => {
    const state = held();
    const set = (still: Partial<SceneMap>, v: MapVideo) => decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, ...still, video: v } }, state);
    const tall = { assetId: "a-tall", widthPx: 1080, heightPx: 1920 };
    for (const turn of [90, 270] as const) {
      assert.equal(set(tall, { ...video("v-new"), turn }), "ok", `a portrait still for a ${turn} turn`);
      assert.equal(set(tall, { ...video("v-new"), turn, mirror: true }), "ok", `mirrored ${turn}`);
      assert.equal(set({}, { ...video("v-new"), turn }), `invalid: ${VIDEO_SHAPE}`, `a landscape still for a ${turn} turn`);
    }
    assert.equal(set({}, { ...video("v-new"), turn: 180 }), "ok", "a half turn keeps the shape");
    assert.equal(set(tall, { ...video("v-new"), turn: 180 }), `invalid: ${VIDEO_SHAPE}`);
    assert.equal(set({}, { ...video("v-new"), mirror: true }), "ok", "a mirror keeps the shape");
    const wide = { ...video("v-new", 640, 360), displayWidthPx: 853 };
    assert.equal(set({ widthPx: 853, heightPx: 360 }, wide), "ok", "a 4:3 pixel shape stretches the still's width");
    assert.equal(set({ widthPx: 640, heightPx: 360 }, wide), `invalid: ${VIDEO_SHAPE}`, "the coded shape no longer fits");
    assert.equal(set({ assetId: "a-tall", widthPx: 360, heightPx: 853 }, { ...wide, turn: 90 }), "ok", "stretched, then turned");
  });

  test("players set no map, a video's included", () => {
    assert.equal(decide({ t: "scene.setMap", sceneId: "s1", map: { ...STILL, video: video("v-new") } }, held(), depsWith(), P1).split(":")[0], "forbidden");
  });
});

describe("the server's switch off (docs/design/design-v1-animated-maps.md 9.2, D-261102-510)", () => {
  const off = depsWith({ animatedMaps: false });

  test("an op bringing in a video the room holds nowhere is refused, on every op that can name one", () => {
    const state = held();
    const refused = `invalid: ${VIDEO_OFF}`;
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("v-new") } }, state, off), refused);
    assert.equal(decide({ t: "scene.create", scene: { id: "s9", name: "Crypt", bounds: { w: 30, h: 17 }, map: { ...STILL, video: video("v-new") } } }, state, off), refused);
    const list = held().scenes.s1!.phases!;
    assert.equal(decide({ t: "scene.update", sceneId: "s1", patch: { phases: [...list, phase("p4", "a-fire", video("v-new"))] } }, state, off), refused);
    // On, the same ops pass, and with no switch given (the dev fixture's local server) nothing is refused for it.
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("v-new") } }, state, depsWith({ animatedMaps: true })), "ok");
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("v-new") } }, state, depsWith()), "ok");
  });

  test("renaming, reordering, adding a still phase and removing phases on a scene with two video phases all pass", () => {
    const state = held();
    const list = state.scenes.s1!.phases!;
    const edits: MapPhaseInput[][] = [
      list.map((p) => (p.id === "p2" ? { ...p, name: "Midnight" } : p)),
      [list[2]!, list[0]!, list[1]!],
      [...list, phase("p4", "a-fire")],
      [list[0]!, list[2]!],
      [list[2]!],
    ];
    for (const phases of edits) assert.equal(decide({ t: "scene.update", sceneId: "s1", patch: { phases } }, state, off), "ok", phases.map((p) => p.id).join());
  });

  test("a video the room holds on another scene or phase may go on a map, and a copied scene keeps its videos", () => {
    const state = held();
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("v-night") } }, state, off), "ok", "a phase's video, compared room-wide");
    assert.equal(decide({ t: "scene.setMap", sceneId: "s2", map: { ...STILL, video: video("V-DAY") } }, state, off), "ok", "ids compare as the actor reads rows, lowercased");
    assert.equal(decide({ t: "scene.duplicate", sceneId: "s1", newSceneId: "s9", name: "Copy", include: { creatures: false, characters: false, fog: false, drawings: false } }, state, off), "ok");
    assert.equal(decide({ t: "scene.setMap", sceneId: "s1", map: STILL }, state, off), "ok", "Use the still only");
  });

  test("an undo that brings back a video's last reference passes as a checked restore, held only to a video row of the room", () => {
    const state = held();
    const removed = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { phases: [state.scenes.s1!.phases![2]!] } }, DM, env(2));
    assert.ok(removed.ok && removed.inverse);
    assert.equal(removed.state.scenes.s1?.phases?.some((p) => p.video), false, "no video is held now");
    const restore: Op = { t: "sys.restore", entries: removed.inverse, from: "undo", deps: true };
    assert.equal(decide(restore, removed.state, off), "ok");
    // The video's row was deleted since: the restore's own check refuses it, as it refuses a deleted image.
    const deleted = depsWith({ animatedMaps: false, restoredAssetUsable: (assetId, kind) => assetId !== "v-night" && ROWS[assetId] === kind });
    assert.equal(decide(restore, removed.state, deleted), "gone: its image was deleted since");
    // A restore names the video's kind, so a row of another kind under its id is refused too.
    const asMap = depsWith({ restoredAssetUsable: (assetId, kind) => (assetId === "v-day" ? kind === "map" : ROWS[assetId] === kind) });
    assert.equal(decide(restore, removed.state, asMap), "gone: its image was deleted since");
    // A restore entry is the whole scene: its videos are what it adds.
    assert.ok(removed.inverse.some((entry) => entry.key === keys.scene("s1")));
  });
});
