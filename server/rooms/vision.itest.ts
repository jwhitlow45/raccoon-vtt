import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { applyChanges, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * Party vision over real sockets (docs/design-v1-maps-vision.md 4.3 and
 * section 6, "Sockets" and "Sizes"): what the party cannot see never
 * reaches a player socket, drags included, the explore step runs only where
 * players are and only while they can see, it replays as stored, and two
 * vision scenes keep their sight tiles apart.
 */
const inline = (senses: string) => ({
  inline: {
    hp: { cur: 12, max: 12, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 12,
    senses,
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  },
});

function tokenOp(sceneId: string, fields: Record<string, unknown>): { op: Op; id: string } {
  const id = uuidv7();
  return { id, op: { t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: inline(""), ...fields } } as Op };
}

const tokenKey = (id: string) => `token:${id}`;
const touches = (m: Extract<ServerMessage, { t: "ev" }>, key: string) => m.changes.some((c) => c.key === key);

type Table = { roomId: string; dm: Socket; player: Socket; playerClient: ReturnType<Engine["client"]>; sceneId: string; pcId: string; goblinId: string };

/**
 * A dark battle mat with party vision: the player's character with
 * darkvision 30 ft at (2, 2) and a goblin three cells east of it.
 */
async function darkTable(t: Engine, name: string): Promise<Table> {
  const dmClient = t.client();
  const { roomId } = await dmClient.createRoom(name);
  const playerClient = t.client();
  const playerId = await playerClient.join(roomId, "Pip");
  const dm = await t.connect(roomId, dmClient);
  const player = await t.connect(roomId, playerClient);
  const sceneId = ((await dm.snapshot("dm1")).state as ProjectedState).meta.playerSceneId ?? "";
  await player.snapshot("p1");
  await dm.apply({ t: "scene.update", sceneId, patch: { vision: { on: true, light: "dark" } } });
  const pc = tokenOp(sceneId, { kind: "pc", name: "Pip", disposition: "ally", ownerIds: [playerId], actor: inline("Darkvision 30 ft.") });
  await dm.apply(pc.op);
  const goblin = tokenOp(sceneId, { x: 5 });
  await dm.apply(goblin.op);
  await player.next("ev", (m) => touches(m, tokenKey(goblin.id)));
  player.received.splice(0);
  return { roomId, dm, player, playerClient, sceneId, pcId: pc.id, goblinId: goblin.id };
}

async function exploreOps(t: Engine, roomId: string): Promise<Array<{ sceneId: string }>> {
  const { rows } = await t.pool.query<{ op: { sceneId: string } }>("select op from room_ops where room_id = $1 and op->>'t' = 'sys.explore' order by seq", [roomId]);
  return rows.map((r) => r.op);
}

describe("party vision over the socket", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a monster walking out of the party's sight never reaches a player socket again until it walks back in", async () => {
    const { dm, player, goblinId } = await darkTable(t, "Dark walk");
    await dm.apply({ t: "token.move", tokenId: goblinId, x: 20, y: 2 });
    const gone = await player.next("ev", (m) => touches(m, tokenKey(goblinId)));
    assert.deepEqual(
      gone.changes.find((c) => c.key === tokenKey(goblinId)),
      { key: tokenKey(goblinId), deleted: true },
    );
    for (const x of [22, 25, 27]) await dm.apply({ t: "token.move", tokenId: goblinId, x, y: 3 });
    await dm.apply({ t: "token.update", tokenId: goblinId, patch: { name: "Snik the Sneak" } });
    assert.equal(await player.maybe("ev", (m) => touches(m, tokenKey(goblinId)), 400), null);
    assert.equal(
      player.received.some((m) => JSON.stringify(m).includes("Snik")),
      false,
    );
    await dm.apply({ t: "token.move", tokenId: goblinId, x: 4, y: 3 });
    const back = await player.next("ev", (m) => touches(m, tokenKey(goblinId)));
    const value = back.changes.find((c) => c.key === tokenKey(goblinId));
    assert.ok(value && "value" in value);
    dm.close();
    player.close();
  });

  test("a monster's drag out of sight never reaches a player, who gets a bare cancel, and no frame carries a path", async () => {
    const { dm, player, sceneId, goblinId } = await darkTable(t, "Dark drag");
    dm.send({ t: "eph", sceneId, e: { k: "dragStart", tokenId: goblinId, x: 5, y: 2 } });
    assert.equal((await player.next("eph")).e.k, "dragStart");
    dm.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: goblinId, x: 6, y: 2, path: [5, 2, 6, 2] } });
    assert.deepEqual((await player.next("eph")).e, { k: "dragMove", tokenId: goblinId, x: 6, y: 2 });
    dm.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: goblinId, x: 20, y: 2, path: [6, 2, 20, 2] } });
    assert.deepEqual((await player.next("eph")).e, { k: "dragCancel", tokenId: goblinId });
    for (const x of [21, 24, 26]) dm.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: goblinId, x, y: 2, path: [20, 2, x, 2] } });
    dm.send({ t: "eph", sceneId, e: { k: "dragEnd", tokenId: goblinId, x: 26, y: 2 } });
    assert.equal(await player.maybe("eph", () => true, 400), null);
    dm.close();
    player.close();
  });

  test("explore runs only on the player scene and never behind a blackout, and replays as stored", async () => {
    const { roomId, dm, player, sceneId, pcId } = await darkTable(t, "Dark explore");
    const ops = await exploreOps(t, roomId);
    assert.ok(ops.length > 0 && ops.every((op) => op.sceneId === sceneId));
    // A second vision scene the DM previews, with a creature lending the party sight there: nothing is explored on it.
    const crypt = uuidv7();
    await dm.apply({ t: "scene.create", scene: { id: crypt, name: "Crypt", bounds: { w: 20, h: 20 }, fogEnabled: true } } as Op);
    await dm.apply({ t: "scene.update", sceneId: crypt, patch: { vision: { on: true, light: "dark" } } });
    const ally = tokenOp(crypt, { kind: "npc", partyVision: true, actor: inline("Darkvision 60 ft.") });
    await dm.apply(ally.op);
    await dm.apply({ t: "token.move", tokenId: ally.id, x: 9, y: 9 });
    assert.ok((await exploreOps(t, roomId)).every((op) => op.sceneId === sceneId), "the DM's preview is not explored");

    await dm.apply({ t: "view.blackout", blackout: true });
    const before = (await exploreOps(t, roomId)).length;
    await dm.apply({ t: "token.move", tokenId: pcId, x: 20, y: 2 });
    assert.equal((await exploreOps(t, roomId)).length, before, "players see nothing behind a blackout");
    await dm.apply({ t: "view.blackout", blackout: false });
    assert.equal((await exploreOps(t, roomId)).length, before + 1, "lifting it explores what the party sees");

    const live = t.manager.get(roomId)!.committed.state.exploredTiles;
    assert.ok(live[`${sceneId}:1,0`], "the walk east was explored");
    dm.close();
    player.close();
    // Unloaded without a snapshot, the room loads again by replaying its ops, explores included, as stored.
    await t.manager.unload(roomId, 4010, false);
    assert.equal(t.manager.get(roomId), null);
    const reloaded = await t.manager.acquire(roomId);
    assert.equal(JSON.stringify(reloaded.committed.state.exploredTiles), JSON.stringify(live));
    assert.equal(reloaded.replayFailed, false);
  });

  test("players moved between two vision scenes with the same tile coordinates keep each scene's tiles apart", async () => {
    const { roomId, dm, player: first, playerClient, sceneId, pcId } = await darkTable(t, "Two scenes");
    first.close();
    const player = await t.connect(roomId, playerClient);
    let view = (await player.snapshot("p1b")).state as ProjectedState;
    assert.ok(`${sceneId}:0,0` in view.sight);
    const crypt = uuidv7();
    await dm.apply({ t: "scene.create", scene: { id: crypt, name: "Crypt", bounds: { w: 20, h: 20 }, fogEnabled: true } } as Op);
    await dm.apply({ t: "scene.update", sceneId: crypt, patch: { vision: { on: true, light: "dark" } } });
    await dm.apply({ t: "token.update", tokenId: pcId, patch: { sceneId: crypt } });
    await dm.apply({ t: "room.setPlayerScene", sceneId: crypt });
    await dm.apply({ t: "token.move", tokenId: pcId, x: 3, y: 3 });
    const evs = player.received.splice(0).filter((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev");
    for (const ev of evs) view = applyChanges(view, ev.changes as Change[]);
    const keys = Object.keys(view.sight);
    assert.ok(keys.length > 0);
    assert.ok(keys.every((k) => k.startsWith(`${crypt}:`)), keys.join(" "));
    assert.ok(keys.includes(`${crypt}:0,0`));
    assert.ok(!(`${sceneId}:0,0` in view.sight), "the old scene's tile at the same coordinates is gone");
    dm.close();
    player.close();
  });
});
