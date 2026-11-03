import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { MapPhase, MapVideo, RoomState, SceneMap, VideoFacts } from "#shared/model.ts";
import { VIDEO_MISSING, VIDEO_OFF, VIDEO_SHAPE } from "#shared/permissions.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import type { AssetFactRow } from "./persistence.ts";
import { scopeActor, scopeFixture, scopeObserver, until, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * Animated maps in the room actor (docs/design/design-v1-animated-maps.md
 * 9.2): a video's facts come from its row, never the client, the switch's
 * permission dep refuses new videos while it is off, and every socket a
 * player's projection reaches (a player, a table display, the DM's View as
 * a player) holds only the showing phase's video.
 */

type Event = Extract<ServerMessage, { t: "ev" }>;

const ROOM = "UNDOSCOPE";
const STILL = uuidv7();
const NIGHT_STILL = uuidv7();
const FIRE_STILL = uuidv7();
const DAY = uuidv7();
const NIGHT = uuidv7();
const FRESH = uuidv7();
const BROKEN = uuidv7();
const ELSEWHERE = uuidv7();

const ROW_FACTS: Record<string, Omit<VideoFacts, "widthPx" | "heightPx" | "container">> = {
  [DAY]: { video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 6_000 },
  [NIGHT]: { video: "avc1.640028", audio: "mp4a.40.2", audioChannels: 2, audioHz: 48_000, fps: 24, durationMs: 60_000, kbps: 8_000 },
  [FRESH]: { video: "av01.0.08M.08", fps: 60, durationMs: 10_000, kbps: 12_000 },
};

function rows(): AssetFactRow[] {
  const still = (id: string): AssetFactRow => ({ id, room_id: ROOM, kind: "map", width: 1920, height: 1080, uploaders: null, media: null, video: null });
  const video = (id: string, media: string): AssetFactRow => ({ id, room_id: ROOM, kind: "video", width: 1920, height: 1080, uploaders: null, media, video: ROW_FACTS[id] });
  return [
    still(STILL),
    still(NIGHT_STILL),
    still(FIRE_STILL),
    video(DAY, "webm"),
    video(NIGHT, "mp4"),
    video(FRESH, "webm"),
    // A video row whose facts did not check: it fills nothing and is refused.
    { ...video(BROKEN, "webm"), video: { video: "vp9", fps: 999 } },
    { ...video(ELSEWHERE, "webm"), room_id: "ANOTHER", video: ROW_FACTS[DAY] },
  ];
}

/** What a client may send: the id with placeholder facts the server must overwrite. */
function sent(assetId: string): MapVideo {
  return { assetId, widthPx: 1920, heightPx: 1080, container: "mp4", video: "vp8", fps: 1, durationMs: 1_000, kbps: 1 };
}

function real(assetId: string): MapVideo {
  const media = assetId === NIGHT ? "mp4" : "webm";
  return { assetId, widthPx: 1920, heightPx: 1080, container: media, ...ROW_FACTS[assetId]! };
}

const MAP: SceneMap = { assetId: STILL, widthPx: 1920, heightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } };

function phase(id: string, assetId: string, video?: MapVideo): MapPhase {
  return { id, name: `Phase ${id}`, assetId, widthPx: 1920, heightPx: 1080, ...(video ? { video } : {}) };
}

/** The fixture's room with the players' scene an animated map of two video phases and a still one, the day showing. */
function animated(): ReturnType<typeof scopeFixture> {
  const f = scopeFixture();
  const s = f.state.scenes[f.sceneId]!;
  f.state.scenes[f.sceneId] = { ...s, map: { ...MAP, video: real(DAY) }, phases: [phase("p1", STILL, real(DAY)), phase("p2", NIGHT_STILL, real(NIGHT)), phase("p3", FIRE_STILL)], phaseId: "p1", phaseGrid: { refWidthPx: 1920, refHeightPx: 1080, cellPx: 64, originPx: { x: 0, y: 0 } } };
  return f;
}

async function actorFor(t: TestContext, state: RoomState, animatedMaps: boolean) {
  const h = await scopeActor(t, state, { animatedMaps });
  h.db.assetRows = rows();
  return h;
}

function rejection(event: Event, n: number): string | undefined {
  const r = event.rejects?.find((x) => x.n === n);
  return r && `${r.code}: ${r.message}`;
}

async function refusedWith(client: ScopeClient, op: unknown): Promise<string | undefined> {
  const event = await client.send(op);
  return rejection(event, client.n);
}

/** The op the actor last stored, as replay will read it. */
function lastStored(h: Awaited<ReturnType<typeof actorFor>>): Record<string, unknown> | undefined {
  return h.db.stored.at(-1) as Record<string, unknown> | undefined;
}

describe("a map's video in the room actor (docs/design/design-v1-animated-maps.md 9.2)", () => {
  test("the stored op carries the row's facts, whatever the client sent", async (t) => {
    const f = scopeFixture();
    const h = await actorFor(t, f.state, true);
    const dm = await h.connect(f.dm);
    await dm.apply({ t: "scene.setMap", sceneId: f.sceneId, map: { ...MAP, widthPx: 7, heightPx: 7, video: sent(FRESH) } });
    const stored = lastStored(h) as { map: SceneMap };
    assert.deepEqual(stored.map.video, real(FRESH));
    assert.deepEqual({ w: stored.map.widthPx, h: stored.map.heightPx }, { w: 1920, h: 1080 }, "the still's size from its row too");
    const phases = [phase("p1", STILL, sent(FRESH)), phase("p2", NIGHT_STILL, sent(NIGHT))];
    await dm.apply({ t: "scene.update", sceneId: f.sceneId, patch: { phases } });
    const listed = lastStored(h) as { patch: { phases: MapPhase[] } };
    assert.deepEqual(listed.patch.phases.map((p) => p.video), [real(FRESH), real(NIGHT)]);
    await dm.apply({ t: "scene.create", scene: { id: uuidv7(), name: "Crypt", bounds: { w: 30, h: 17 }, map: { ...MAP, video: sent(DAY) } } });
    assert.deepEqual((lastStored(h) as { scene: { map: SceneMap } }).scene.map.video, real(DAY));
  });

  test("a video row whose facts did not check, another room's video and a still of another shape are refused", async (t) => {
    const f = scopeFixture();
    const h = await actorFor(t, f.state, true);
    const dm = await h.connect(f.dm);
    assert.equal(await refusedWith(dm, { t: "scene.setMap", sceneId: f.sceneId, map: { ...MAP, video: sent(BROKEN) } }), `invalid: ${VIDEO_MISSING}`);
    assert.equal(await refusedWith(dm, { t: "scene.setMap", sceneId: f.sceneId, map: { ...MAP, video: sent(ELSEWHERE) } }), `invalid: ${VIDEO_MISSING}`);
    assert.equal(await refusedWith(dm, { t: "scene.setMap", sceneId: f.sceneId, map: { ...MAP, video: sent(uuidv7()) } }), `invalid: ${VIDEO_MISSING}`);
    // The client claims the video is the still's shape, and the row says otherwise.
    h.db.assetRows = rows().map((r) => (r.id === FRESH ? { ...r, width: 1080, height: 1920 } : r));
    assert.equal(await refusedWith(dm, { t: "scene.setMap", sceneId: f.sceneId, map: { ...MAP, video: sent(FRESH) } }), `invalid: ${VIDEO_SHAPE}`);
    assert.equal(h.db.stored.length, 0);
  });

  test("with the switch off a new video is refused, while edits, Use the still only and an undo of a removal pass", async (t) => {
    const f = animated();
    const h = await actorFor(t, f.state, false);
    const dm = await h.connect(f.dm);
    const s = f.state.scenes[f.sceneId]!;
    assert.equal(await refusedWith(dm, { t: "scene.setMap", sceneId: f.sceneId, map: { ...MAP, video: sent(FRESH) } }), `invalid: ${VIDEO_OFF}`);
    assert.equal(await refusedWith(dm, { t: "scene.update", sceneId: f.sceneId, patch: { phases: [...s.phases!, phase("p4", FIRE_STILL, sent(FRESH))] } }), `invalid: ${VIDEO_OFF}`);
    await dm.apply({ t: "scene.update", sceneId: f.sceneId, patch: { phases: s.phases!.map((p) => (p.id === "p2" ? { ...p, name: "Midnight" } : p)) } });
    await dm.apply({ t: "scene.update", sceneId: f.sceneId, patch: { phases: [s.phases![0]!, s.phases![2]!] } });
    // The night video's last reference is gone, so only its undo may bring it back.
    assert.equal(await refusedWith(dm, { t: "scene.update", sceneId: f.sceneId, patch: { phases: [s.phases![0]!, s.phases![1]!, s.phases![2]!] } }), `invalid: ${VIDEO_OFF}`);
    await dm.restore("setup", "undo");
    const back = lastStored(h) as { t: string; entries?: { key: string; value: { phases?: MapPhase[] } }[] };
    assert.equal(back.t, "sys.restore");
    assert.ok(JSON.stringify(back).includes(NIGHT), "the undo put the night phase's video back");
    await dm.apply({ t: "scene.setMap", sceneId: f.sceneId, map: MAP });
  });

  test("a player, a table display and the DM's View as a player hold only the showing phase's video, before and after a switch", async (t) => {
    const f = animated();
    const h = await actorFor(t, f.state, true);
    const dm = await h.connect(f.dm);
    const player = await h.connect(f.player);
    const display = await scopeObserver(h.actor, { memberId: "display:abcdefghijkl", role: "player", display: true });
    const preview = await scopeObserver(h.actor, { memberId: f.dm.id, role: "dm", previewOf: f.player.id });
    const seen = () => [player.sent, display.sent, preview.sent].map((list) => JSON.stringify(list));
    for (const text of seen()) {
      assert.ok(text.includes(DAY), "the showing phase's video reaches them");
      assert.ok(!text.includes(NIGHT), "the night phase's video never does");
    }
    assert.ok(JSON.stringify(dm.sent).includes(NIGHT), "the DM holds every phase's video");
    // A swap of the hidden phase's video sends players nothing that names it.
    const s = f.state.scenes[f.sceneId]!;
    await dm.apply({ t: "scene.update", sceneId: f.sceneId, patch: { phases: s.phases!.map((p) => (p.id === "p3" ? { ...p, video: sent(FRESH) } : p)) } });
    for (const text of seen()) assert.ok(!text.includes(FRESH) && !text.includes(NIGHT));
    const before = player.sent.length;
    await dm.apply({ t: "scene.setPhase", sceneId: f.sceneId, phaseId: "p2" });
    await until(() => (player.sent.length > before ? true : undefined), "the switch reaches the player");
    const change = JSON.stringify(player.sent.slice(before));
    assert.ok(change.includes(NIGHT) && !change.includes(DAY) && !change.includes(FRESH), "the switch hands over the night video alone");
    for (const text of seen()) assert.ok(!text.includes(FRESH), "the fire phase's new video stays the DM's");
  });
});
