import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ProjectedState } from "#shared/project.ts";
import { solid } from "../assets/testImages.ts";
import { startEngine, type Engine, type TestClient } from "./testing.ts";

/**
 * Wave 3's server side end to end (docs/design-v1-maps-vision.md 2.5, 3.3,
 * 3.4): the `thumb` asset kind, phase sizes from the asset rows, what
 * players may read, and an export carrying stamps, lights, free walls,
 * phases and a thumbnail into a new room.
 */
async function upload(client: TestClient, roomId: string, kind: string, png: Buffer): Promise<{ id: string; width: number; height: number; statusCode: number }> {
  const res = await client.request("PUT", `/api/rooms/${roomId}/assets?kind=${kind}`, undefined, { "content-type": "image/png" }, png);
  return { ...(res.statusCode === 200 ? res.json<{ id: string; width: number; height: number }>() : { id: "", width: 0, height: 0 }), statusCode: res.statusCode };
}

describe("wave 3 maps on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a thumbnail is the DM's to upload and read, a scene names only a thumb asset, and it goes on no undo stack", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Thumbs");
    const player = t.client();
    await player.join(roomId, "Pip");
    assert.equal((await upload(player, roomId, "thumb", await solid(64, 40).png().toBuffer())).statusCode, 403);
    const thumb = await upload(dm, roomId, "thumb", await solid(640, 400).png().toBuffer());
    assert.equal(thumb.statusCode, 200);
    assert.deepEqual([thumb.width, thumb.height], [320, 200]);
    const map = await upload(dm, roomId, "map", await solid(64, 40).png().toBuffer());
    const s = await t.connect(roomId, dm);
    const sceneId = ((await s.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const p = await t.connect(roomId, player);
    await p.snapshot("p");

    assert.equal((await s.apply({ t: "scene.update", sceneId, patch: { thumb: map.id } })).rejects?.[0]?.code, "gone");
    assert.equal((await s.apply({ t: "scene.update", sceneId, patch: { name: "Crypt" } })).rejects, undefined);
    assert.equal((await s.apply({ t: "scene.update", sceneId, patch: { thumb: thumb.id } })).rejects, undefined);
    // Setup Undo takes back the rename, the step before the thumbnail, and keeps the thumbnail.
    const undone = await s.step("undo", "setup");
    assert.equal(undone.rejects, undefined);
    const scene = undone.changes.find((c) => c.key === `scene:${sceneId}`);
    assert.ok(scene && "value" in scene);
    assert.equal((scene.value as { name: string; thumb: string }).name, "Battle mat");
    assert.equal((scene.value as { thumb: string }).thumb, thumb.id);

    assert.equal((await dm.get(`/api/assets/${thumb.id}/full`)).statusCode, 200);
    assert.equal((await player.get(`/api/assets/${thumb.id}/full`)).statusCode, 404);
    p.close();
    const again = await t.connect(roomId, player);
    const seen = (await again.snapshot("p2")).state as ProjectedState;
    assert.equal("thumb" in seen.scenes[sceneId]!, false);
    again.close();
    s.close();
  });

  test("phases take their sizes from the asset rows, and players read only the active image", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Phases");
    const player = t.client();
    await player.join(roomId, "Pip");
    const day = await upload(dm, roomId, "map", await solid(400, 200).png().toBuffer());
    const fire = await upload(dm, roomId, "map", await solid(800, 400, "#a30").png().toBuffer());
    const s = await t.connect(roomId, dm);
    const sceneId = ((await s.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    await s.apply({ t: "scene.setMap", sceneId, map: { assetId: day.id, widthPx: 1, heightPx: 1, cellPx: 20, originPx: { x: 0, y: 0 } } });
    const ev = await s.apply({
      t: "scene.update",
      sceneId,
      patch: { phases: [{ id: "day", name: "Day", assetId: day.id, widthPx: 9, heightPx: 9 }, { id: "fire", name: "On fire", assetId: fire.id, widthPx: 9, heightPx: 9 }] },
    });
    assert.equal(ev.rejects, undefined);
    const stored = ev.changes.find((c) => c.key === `scene:${sceneId}`);
    assert.ok(stored && "value" in stored);
    const value = stored.value as { phases: { widthPx: number; heightPx: number }[] };
    assert.deepEqual(value.phases.map((ph) => [ph.widthPx, ph.heightPx]), [[400, 200], [800, 400]]);

    const p = await t.connect(roomId, player);
    const before = (await p.snapshot("p")).state as ProjectedState;
    assert.ok(!JSON.stringify(before).includes("On fire") && !JSON.stringify(before).includes(fire.id));
    assert.equal((await player.get(`/api/assets/${fire.id}/thumb`)).statusCode, 404);
    assert.equal((await player.get(`/api/assets/${day.id}/thumb`)).statusCode, 200);
    await s.apply({ t: "scene.setPhase", sceneId, phaseId: "fire" });
    const switched = await p.next("ev", (m) => m.changes.some((c) => c.key === `scene:${sceneId}`));
    const seen = switched.changes.find((c) => c.key === `scene:${sceneId}`);
    assert.ok(seen && "value" in seen);
    assert.deepEqual((seen.value as { map: unknown }).map, { assetId: fire.id, widthPx: 800, heightPx: 400, cellPx: 40, originPx: { x: 0, y: 0 } });
    assert.equal("phases" in (seen.value as object), false);
    assert.equal((await player.get(`/api/assets/${fire.id}/thumb`)).statusCode, 200);
    p.close();
    s.close();
  });

  test("an export carries stamps, lights, free walls, phases and a thumbnail into a new room under new ids", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Backup");
    const day = await upload(dm, roomId, "map", await solid(400, 200).png().toBuffer());
    const night = await upload(dm, roomId, "map", await solid(200, 100, "#113").png().toBuffer());
    const chair = await upload(dm, roomId, "token", await solid(64, 64, "#963").png().toBuffer());
    const thumb = await upload(dm, roomId, "thumb", await solid(320, 160).png().toBuffer());
    const s = await t.connect(roomId, dm);
    const sceneId = ((await s.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const ops = [
      { t: "scene.setMap", sceneId, map: { assetId: day.id, widthPx: 1, heightPx: 1, cellPx: 20, originPx: { x: 0, y: 0 } } },
      { t: "scene.update", sceneId, patch: { thumb: thumb.id, folder: "Act 1", autoWalls: "off", phases: [{ id: "day", name: "Day", assetId: day.id, widthPx: 1, heightPx: 1 }, { id: "night", name: "Night", assetId: night.id, widthPx: 1, heightPx: 1 }] } },
      { t: "build.walls", sceneId, put: [{ id: "abcdefabcdef", a: [1.5, 1], b: [3.25, 2.75], f: { kind: "door", state: "locked", secret: true, discovered: false } }] },
      { t: "build.stamps", sceneId, put: [{ id: uuidv7(), art: { assetId: chair.id }, x: 2, y: 2, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }, { id: uuidv7(), art: { key: "oak-tree" }, x: 4, y: 2, w: 2, h: 2, rotation: 45, z: 1, visibility: "dm" }] },
      { t: "build.lights", sceneId, put: [{ id: uuidv7(), x: 5, y: 5, bright: 20, dim: 20, on: true, walls: true, label: "Torch" }] },
    ];
    for (const op of ops) assert.equal((await s.apply(op)).rejects, undefined, op.t);
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    s.close();

    const importer = t.client();
    const imported = await importer.request("POST", "/api/rooms/import", undefined, {
      "content-type": "application/zip",
      "x-import-form": Buffer.from(JSON.stringify({ playerPassword: "wyvern-staff-rune", dmName: "Importer" })).toString("base64url"),
    }, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: newId } = imported.json<{ roomId: string }>();
    t.track(newId);
    const copy = await t.connect(newId, importer);
    const state = (await copy.snapshot("i")).state as ProjectedState;
    const scene = Object.values(state.scenes)[0]!;
    const assets = (await importer.get(`/api/rooms/${newId}/assets`)).json<{ assets: { id: string; kind: string }[] }>().assets;
    const ids = new Set(assets.map((a) => a.id));
    assert.deepEqual(assets.map((a) => a.kind).sort(), ["map", "map", "thumb", "token"]);
    assert.ok(scene.thumb && ids.has(scene.thumb) && scene.thumb !== thumb.id);
    assert.equal(scene.folder, "Act 1");
    assert.equal(scene.autoWalls, "off");
    assert.deepEqual(scene.phases?.map((ph) => [ph.name, ids.has(ph.assetId), ph.widthPx]), [["Day", true, 400], ["Night", true, 200]]);
    assert.equal(scene.map?.assetId, scene.phases?.[0]?.assetId);
    const walls = Object.values(state.buildChunks).flatMap((c) => c.walls ?? []);
    assert.deepEqual(walls.map((w) => w.id), ["abcdefabcdef"]);
    const stamps = Object.values(state.stamps);
    assert.equal(stamps.length, 2);
    for (const st of stamps) {
      assert.equal(st.sceneId, scene.id);
      if ("assetId" in st.art) assert.ok(ids.has(st.art.assetId) && st.art.assetId !== chair.id);
    }
    assert.deepEqual(Object.values(state.lights).map((l) => [l.sceneId, l.label]), [[scene.id, "Torch"]]);
    copy.close();
  });
});
