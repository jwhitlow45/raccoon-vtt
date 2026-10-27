import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState, Stamp } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerOnlyOp } from "#shared/protocol.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { loadRoom } from "../rooms/persistence.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "../rooms/testing.ts";
import { solid } from "./testImages.ts";

/**
 * Deleting an image only players remember (decision D-261026-34,
 * docs/design-v1-map-discovery.md 5.4): the library does not mark it in
 * use, and the delete drops the remembered stamps of it from the party's
 * memory and every holder's, through a stored `sys.remember`, then deletes
 * it. A live use still refuses, and a remembered stamp of it written again
 * before the deletion step refuses too, so no art a player sees is lost.
 */

const SCENE = { id: uuidv7(), name: "Crypt", bounds: { w: 20, h: 20 }, fogEnabled: true, vision: { on: true, light: "dark" as const, perPlayer: true as const } };

function bitsOver(sceneId: string): string {
  return Object.values(rasterizeFogOps({}, sceneId, SCENE.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }]))[0]!.bits;
}

const remembered = (id: string, sceneId: string, art: Stamp["art"]): Stamp & { visibility: "all" } => ({ id, rev: 0, sceneId, art, x: 1.5, y: 1.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" });

function tokenOp(sceneId: string, assetId: string): Op {
  return {
    t: "token.create",
    token: {
      id: uuidv7(),
      sceneId,
      kind: "monster",
      name: "Goblin",
      size: "medium",
      x: 2,
      y: 2,
      image: { assetId, crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
      actor: {
        inline: {
          hp: { cur: 7, max: 7, temp: 0 },
          life: "alive",
          ac: 15,
          speeds: { walk: 30 },
          initBonus: 2,
          passivePerception: 9,
          senses: "",
          effects: [],
          deathSaves: { ok: 0, fail: 0 },
          notes: "",
          dmNotes: "",
        },
      },
    },
  } as Op;
}

/** Every remembered stamp of a layer, by its art: the party's under null, each holder's under their member id. */
function rememberedArt(state: RoomState, sceneId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const chunk of [...Object.values(state.memory ?? {}), ...Object.values(state.memoryBy ?? {})]) {
    if (chunk.sceneId !== sceneId) continue;
    const layer = chunk.memberId ?? "party";
    for (const s of Object.values(chunk.stamps ?? {})) if (s) (out[layer] ??= []).push("assetId" in s.art ? s.art.assetId : s.art.key);
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

describe("deleting an image only players remember (D-261026-34)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { batchMs: 10 } } });
  });
  after(() => t.close());

  type Remembering = { roomId: string; mat: string; sceneId: string; socket: Socket; dm: TestClient; player: string; image: string; stamps: { party: string; own: string; shipped: string } };

  async function upload(dm: TestClient, roomId: string): Promise<string> {
    const bytes = await solid(64, 64, `#${randomBytes(3).toString("hex")}`).png().toBuffer();
    const res = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, bytes);
    assert.equal(res.statusCode, 200, res.body);
    return res.json<{ id: string }>().id;
  }

  /** A per-player scene whose party and one holder both remember a stamp of an image no live thing uses, and the party a shipped one too. */
  async function rememberingRoom(): Promise<Remembering> {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Remembered");
    const socket = await t.connect(roomId, dm);
    const mat = ((await socket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
    const player = await t.client().join(roomId, "Pip");
    const sceneId = uuidv7();
    assert.equal((await socket.apply({ t: "scene.create", scene: { ...SCENE, id: sceneId } })).rejects, undefined);
    // The players have been there, so the scene is played and its memory reserved: elsewhere the map step keeps none (5.5).
    for (const at of [sceneId, mat]) assert.equal((await socket.apply({ t: "room.setPlayerScene", sceneId: at })).rejects, undefined);
    const image = await upload(dm, roomId);
    const actor = await t.manager.acquire(roomId);
    const bits = bitsOver(sceneId);
    await actor.sys({ t: "sys.explore", sceneId, tiles: [{ tx: 0, ty: 0, bits }], join: [{ memberId: player, on: true }], members: [{ memberId: player, tiles: [{ tx: 0, ty: 0, bits }] }] });
    const party = uuidv7();
    const own = uuidv7();
    const shipped = uuidv7();
    await actor.sys({
      t: "sys.remember",
      sceneId,
      layers: [
        { chunks: [{ cx: 0, cy: 0, set: { cells: { "1,1": "stone" }, stamps: { [party]: remembered(party, sceneId, { assetId: image }), [shipped]: remembered(shipped, sceneId, { key: "oak-tree" }) } } }] },
        { memberId: player, chunks: [{ cx: 0, cy: 0, set: { stamps: { [own]: remembered(own, sceneId, { assetId: image }) } } }] },
      ],
    });
    assert.deepEqual(rememberedArt(actor.committed.state, sceneId), { party: [image, "oak-tree"].sort(), [player]: [image] });
    return { roomId, mat, sceneId, socket, dm, player, image, stamps: { party, own, shipped } };
  }

  const inUse = async (dm: TestClient, roomId: string, id: string) => (await dm.get(`/api/rooms/${roomId}/assets`)).json<{ assets: Array<{ id: string; inUse?: boolean }> }>().assets.find((a) => a.id === id)?.inUse;
  const rowExists = async (id: string) => ((await t.pool.query("select 1 from assets where id = $1", [id])).rowCount ?? 0) > 0;

  test("the library does not mark it in use, and the delete drops it from every memory through a stored op, then deletes it", async () => {
    const { roomId, sceneId, socket, dm, player, image } = await rememberingRoom();
    assert.equal(await inUse(dm, roomId, image), false);
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [image] });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { deleted: [image] });
    assert.equal(await rowExists(image), false);
    const state = t.manager.get(roomId)!.committed.state;
    assert.deepEqual(rememberedArt(state, sceneId), { party: ["oak-tree"] }, "the party's and the holder's remembered stamps of it are gone, and nothing else");
    assert.deepEqual(Object.values(state.memory ?? {}).find((c) => c.sceneId === sceneId)?.cells, { "1,1": "stone" });
    const { rows } = await t.pool.query<{ op: ServerOnlyOp }>("select op from room_ops where room_id = $1 and op->>'t' = 'sys.remember' order by seq desc limit 1", [roomId]);
    assert.deepEqual(rows[0]?.op.t === "sys.remember" ? rows[0].op.layers.map((l) => [l.memberId ?? null, l.chunks.map((c) => c.drop?.stamps?.length)]) : null, [
      [null, [1]],
      [player, [1]],
    ]);
    // A reload replays the stored op, so the remembered stamps stay gone.
    socket.close();
    await socket.waitClosed();
    await t.manager.unload(roomId, 1011, false);
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.deepEqual(rememberedArt(loaded.state, sceneId), { party: ["oak-tree"] });
  });

  test("a remembered stamp of it whose id now stands live with other art they never saw is remembered as absent, so that art never shows (MD3-ASTRA-3)", async () => {
    const { roomId, sceneId, socket, dm, player, image, stamps } = await rememberingRoom();
    // The DM gives the party's remembered stamp other art, out of everyone's sight: memory keeps the image.
    const { rev: _rev, sceneId: _scene, ...put } = remembered(stamps.party, sceneId, { key: "barrel" });
    assert.equal((await socket.apply({ t: "build.stamps", sceneId, put: [put] })).rejects, undefined);
    const before = t.manager.get(roomId)!.committed.state;
    assert.deepEqual(rememberedArt(before, sceneId), { party: [image, "oak-tree"].sort(), [player]: [image] }, "memory keeps what they saw");
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [image] });
    assert.equal(res.statusCode, 200, res.body);
    const state = t.manager.get(roomId)!.committed.state;
    const party = Object.values(state.memory ?? {}).find((c) => c.sceneId === sceneId)!;
    assert.ok(Object.hasOwn(party.stamps ?? {}, stamps.party) && party.stamps![stamps.party] === null, "an absence, so the live barrel does not show");
    assert.deepEqual(state.stamps[stamps.party]?.art, { key: "barrel" });
    // The holder's stamp of it stands nowhere live, so it simply goes.
    assert.deepEqual(rememberedArt(state, sceneId), { party: ["oak-tree"] });
    assert.ok(!Object.values(state.memoryBy ?? {}).some((c) => c.stamps && Object.hasOwn(c.stamps, stamps.own)));
    assert.equal(await rowExists(image), false);
  });

  test("a live use still refuses the delete, and players keep what they remember", async () => {
    const { roomId, mat, sceneId, socket, dm, player, image } = await rememberingRoom();
    assert.equal((await socket.apply(tokenOp(mat, image))).rejects, undefined);
    assert.equal(await inUse(dm, roomId, image), true);
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [image] });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "asset_in_use", inUse: [image] });
    assert.ok(await rowExists(image));
    assert.deepEqual(rememberedArt(t.manager.get(roomId)!.committed.state, sceneId), { party: [image, "oak-tree"].sort(), [player]: [image] });
  });

  for (const snapshot of [true, false]) {
    test(`a room that is not loaded is loaded to drop its memory, held ${snapshot ? "in its snapshot" : "in the ops after it"}, and the image goes`, async () => {
      const { roomId, sceneId, socket, dm, image } = await rememberingRoom();
      socket.close();
      await socket.waitClosed();
      await t.manager.unload(roomId, 1011, snapshot);
      assert.equal(t.manager.get(roomId), null);
      const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [image] });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(await rowExists(image), false);
      assert.deepEqual(rememberedArt(t.manager.get(roomId)!.committed.state, sceneId), { party: ["oak-tree"] });
    });
  }

  test("a room at its quota drops its memory too, since the drop is no edit it refuses", async () => {
    const { roomId, sceneId, socket, dm, image } = await rememberingRoom();
    socket.close();
    await socket.waitClosed();
    await t.pool.query("update rooms set read_only = true where id = $1", [roomId]);
    await t.manager.unload(roomId);
    const actor = await t.manager.acquire(roomId);
    assert.equal(actor.readOnly, true);
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [image] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await rowExists(image), false);
    assert.deepEqual(rememberedArt(actor.committed.state, sceneId), { party: ["oak-tree"] });
  });

  test("a remembered stamp of it written again before the deletion step refuses the delete, so no art a player sees goes", async () => {
    const { roomId, sceneId, dm, image } = await rememberingRoom();
    const actor = t.manager.get(roomId)!;
    const sys = actor.sys.bind(actor);
    const again = uuidv7();
    // As if the map step remembered a stamp of the image again between the drop and the deletion step.
    actor.sys = async (op) => {
      await sys(op);
      if (op.t === "sys.remember") await sys({ t: "sys.remember", sceneId, layers: [{ chunks: [{ cx: 0, cy: 0, set: { stamps: { [again]: remembered(again, sceneId, { assetId: image }) } } }] }] });
    };
    const res = await dm.post(`/api/rooms/${roomId}/assets/delete`, { ids: [image] });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "asset_in_use", inUse: [image] });
    assert.ok(await rowExists(image));
    assert.deepEqual(rememberedArt(actor.committed.state, sceneId), { party: [image, "oak-tree"].sort() });
  });
});
