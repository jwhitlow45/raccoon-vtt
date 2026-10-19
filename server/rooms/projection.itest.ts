import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { CastAsk, CustomMonster, Handout, HandoutPage } from "#shared/model.ts";
import { PLAYED_WITH_OTHERS } from "#shared/permissions.ts";
import { blockOf, character as testCharacter, companionBlock, customMonster, drawing } from "#shared/testutil.ts";
import type { ProjectedState, ProjectedToken } from "#shared/project.ts";
import type { Change, Op } from "#shared/protocol.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * What players may receive (design 7.3, 7.6 and 13.4): hidden tokens, the
 * ephemeral channel's scene scope and fog checks, preview cancels, and a
 * DM's scene switch.
 */
const actor = {
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
  dmNotes: "the goblin fears fire",
};

function tokenOp(sceneId: string, overrides: Record<string, unknown> = {}): { op: Op; id: string } {
  const id = uuidv7();
  return {
    id,
    op: { t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: { inline: actor }, ...overrides } } as Op,
  };
}

function playerScene(snap: { state: unknown }): string {
  return (snap.state as ProjectedState).meta.playerSceneId ?? "";
}

function tokenIn(changes: Change[], id: string): Change | undefined {
  return changes.find((c) => c.key === `token:${id}`);
}

async function setup(t: Engine, name: string): Promise<{ roomId: string; dm: Socket; player: Socket; sceneId: string; playerMemberId: string }> {
  const dmClient = t.client();
  const { roomId } = await dmClient.createRoom(name);
  const playerClient = t.client();
  const playerMemberId = await playerClient.join(roomId, "Pip");
  const dm = await t.connect(roomId, dmClient);
  const player = await t.connect(roomId, playerClient);
  const snap = await dm.snapshot("dm1");
  await player.snapshot("p1");
  return { roomId, dm, player, sceneId: playerScene(snap), playerMemberId };
}

describe("projection over the socket", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a hidden token never reaches a player socket, and appears when revealed without its DM fields", async () => {
    const { dm, player, sceneId } = await setup(t, "Hidden");
    const hidden = tokenOp(sceneId, { visibility: "dm" });
    const ev = await dm.apply(hidden.op);
    assert.ok(tokenIn(ev.changes, hidden.id));
    assert.equal(await player.maybe("ev", (m) => tokenIn(m.changes, hidden.id) !== undefined, 400), null);
    // A move while hidden is still nothing for the player.
    await dm.apply({ t: "token.move", tokenId: hidden.id, x: 5, y: 5 });
    assert.equal(await player.maybe("ev", (m) => tokenIn(m.changes, hidden.id) !== undefined, 300), null);
    await dm.apply({ t: "token.update", tokenId: hidden.id, patch: { visibility: "all" } });
    const shown = await player.next("ev", (m) => tokenIn(m.changes, hidden.id) !== undefined);
    const change = tokenIn(shown.changes, hidden.id);
    assert.ok(change && "value" in change);
    const projected = change.value as ProjectedToken & { actor: { inline: Record<string, unknown> } };
    assert.equal(projected.visibility, undefined);
    assert.equal(projected.ownerIds, undefined);
    assert.equal(projected.actor.inline.dmNotes, undefined);
    assert.equal(projected.actor.inline.hp, undefined);
    assert.equal(projected.actor.inline.hpLabel, "Healthy");
    await dm.apply({ t: "token.update", tokenId: hidden.id, patch: { visibility: "dm" } });
    const gone = await player.next("ev", (m) => tokenIn(m.changes, hidden.id) !== undefined);
    assert.deepEqual(tokenIn(gone.changes, hidden.id), { key: `token:${hidden.id}`, deleted: true });
    // A player cannot act on it either, and learns nothing from the refusal.
    const refused = await player.apply({ t: "token.move", tokenId: hidden.id, x: 1, y: 1 });
    assert.equal(refused.rejects?.[0]?.code, "gone");
    dm.close();
    player.close();
  });

  test("behind a blackout players get none of the table, a reload and a reveal included, and lifting it sends it back", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Blackout");
    const playerClient = t.client();
    await playerClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const player = await t.connect(roomId, playerClient);
    const sceneId = playerScene(await dm.snapshot("dm1"));
    await player.snapshot("p1");
    // Fog on, a goblin in a revealed corner, and some floor.
    await dm.apply({ t: "scene.update", sceneId, patch: { fogEnabled: true } });
    await dm.apply({ t: "fog.live", sceneId, ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 5, h: 5 } }] });
    await dm.apply({ t: "build.paint", sceneId, terrain: "stone", cells: ["1,1"] });
    const goblin = tokenOp(sceneId, { x: 1, y: 1 });
    await dm.apply(goblin.op);
    await player.next("ev", (m) => tokenIn(m.changes, goblin.id) !== undefined);

    await dm.apply({ t: "view.blackout", blackout: true });
    const paused = await player.next("ev", (m) => m.changes.some((c) => c.key === "meta"));
    const removed = new Set(paused.changes.filter((c) => "deleted" in c).map((c) => c.key));
    for (const key of [`scene:${sceneId}`, `token:${goblin.id}`, `chunk:${sceneId}:0,0`, `fog:${sceneId}:0,0`]) assert.ok(removed.has(key), `${key} stays with the player`);
    // What came before the blackout is not the question below.
    player.received.splice(0);

    // The DM sets up the reveal behind it. The DM's own socket gets every change as usual.
    const dragon = tokenOp(sceneId, { x: 10, y: 10, name: "Ancient Red Dragon" });
    assert.ok(tokenIn((await dm.apply(dragon.op)).changes, dragon.id));
    await dm.apply({ t: "fog.live", sceneId, ops: [{ id: "f2", mode: "reveal", shape: { kind: "rect", x: 8, y: 8, w: 5, h: 5 } }] });
    await dm.apply({ t: "token.move", tokenId: goblin.id, x: 3, y: 3 });
    await dm.apply({ t: "encounter.start", entries: [{ id: "n1", tokenId: dragon.id, value: 20 }, { id: "n2", label: "Lair actions", value: 20 }] });
    dm.send({ t: "eph", sceneId, e: { k: "ping", x: 10, y: 10 } });
    assert.equal(await player.maybe("ev", () => true, 400), null);
    assert.equal(await player.maybe("eph", () => true, 300), null);

    // A reload behind the blackout shows nothing more.
    const reloaded = await t.connect(roomId, playerClient);
    const snap = await reloaded.snapshot("p1-reload");
    const state = snap.state as ProjectedState;
    assert.equal(state.meta.view.blackout, true);
    for (const scoped of [state.scenes, state.tokens, state.buildChunks, state.fogTiles, state.labels, state.templates, state.drawings, state.handouts]) {
      assert.deepEqual(scoped, {});
    }
    assert.equal(state.encounter, null);
    assert.equal(JSON.stringify(snap).includes("Ancient Red Dragon"), false);
    assert.equal(JSON.stringify(snap).includes("Lair actions"), false);

    // Lifting it sends the table as it is now, the reveal made behind the blackout included.
    await dm.apply({ t: "view.blackout", blackout: false });
    for (const socket of [player, reloaded]) {
      const back = await socket.next("ev", (m) => m.changes.some((c) => c.key === "meta"));
      const keys = new Set(back.changes.filter((c) => "value" in c).map((c) => c.key));
      for (const key of [`scene:${sceneId}`, `token:${dragon.id}`, `chunk:${sceneId}:0,0`, `fog:${sceneId}:0,0`, "encounter"]) assert.ok(keys.has(key), `${key} not back`);
      const moved = tokenIn(back.changes, goblin.id);
      assert.ok(moved && "value" in moved && (moved.value as ProjectedToken).x === 3);
    }
    for (const s of [dm, player, reloaded]) s.close();
  });

  test("a player snapshot holds no hidden token, no fog draft and no DM notes", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Snapshot");
    const dm = await t.connect(roomId, dmClient);
    const snap = await dm.snapshot("dm1");
    const sceneId = playerScene(snap);
    const hidden = tokenOp(sceneId, { visibility: "dm" });
    const shown = tokenOp(sceneId);
    await dm.apply(hidden.op);
    await dm.apply(shown.op);
    await dm.apply({ t: "fog.draft", sceneId, add: [{ id: "d1", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 2, h: 2 } }] });
    const playerClient = t.client();
    await playerClient.join(roomId, "Pip");
    const player = await t.connect(roomId, playerClient);
    const ps = (await player.snapshot("p1")).state as ProjectedState;
    assert.equal(ps.tokens[hidden.id], undefined);
    assert.ok(ps.tokens[shown.id]);
    assert.deepEqual(ps.fogDrafts, {});
    assert.equal(JSON.stringify(ps).includes("fears fire"), false);
    dm.close();
    player.close();
  });

  test("eph is scoped to the scene, and token-anchored events follow the projection", async () => {
    const { dm, player, sceneId } = await setup(t, "Eph");
    const other = uuidv7();
    await dm.apply({ t: "scene.create", scene: { id: other, name: "Prep", bounds: { w: 10, h: 10 } } });
    dm.send({ t: "eph", sceneId: other, e: { k: "ping", x: 1, y: 1 } });
    assert.equal(await player.maybe("eph", () => true, 300), null);
    dm.send({ t: "eph", sceneId, e: { k: "ping", x: 1, y: 1 } });
    const ping = await player.next("eph");
    assert.equal(ping.e.k, "ping");
    const hidden = tokenOp(sceneId, { visibility: "dm" });
    await dm.apply(hidden.op);
    dm.send({ t: "eph", sceneId, e: { k: "dragStart", tokenId: hidden.id, x: 2, y: 2 } });
    assert.equal(await player.maybe("eph", () => true, 300), null);
    dm.send({ t: "eph", sceneId, e: { k: "ruler", id: "r1", points: [{ x: 0, y: 0 }, { x: 3, y: 3, tokenId: hidden.id }], shared: true } });
    assert.equal(await player.maybe("eph", () => true, 300), null);
    dm.send({ t: "eph", sceneId, e: { k: "ruler", id: "r2", points: [{ x: 0, y: 0 }, { x: 3, y: 3 }], shared: true } });
    assert.equal((await player.next("eph")).e.k, "ruler");
    // The DM's rulers are private unless shared, and a player cannot send to a scene it is not on.
    dm.send({ t: "eph", sceneId, e: { k: "ruler", id: "r3", points: [{ x: 0, y: 0 }] } });
    assert.equal(await player.maybe("eph", () => true, 300), null);
    player.send({ t: "eph", sceneId: other, e: { k: "ping", x: 1, y: 1 } });
    assert.equal(await dm.maybe("eph", () => true, 300), null);
    dm.close();
    player.close();
  });

  test("drag frames into fog are withheld, with a bare dragCancel for a player who had the preview", async () => {
    const { dm, player, sceneId } = await setup(t, "Fog");
    await dm.apply({ t: "scene.update", sceneId, patch: { fogEnabled: true } });
    await dm.apply({ t: "fog.live", sceneId, ops: [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 6, h: 6 } }] });
    const goblin = tokenOp(sceneId, { x: 2, y: 2 });
    await dm.apply(goblin.op);
    await player.next("ev", (m) => tokenIn(m.changes, goblin.id) !== undefined);
    dm.send({ t: "eph", sceneId, e: { k: "dragStart", tokenId: goblin.id, x: 2, y: 2 } });
    assert.equal((await player.next("eph")).e.k, "dragStart");
    dm.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: goblin.id, x: 3, y: 3 } });
    assert.equal((await player.next("eph")).e.k, "dragMove");
    dm.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: goblin.id, x: 12, y: 12 } });
    const cancel = await player.next("eph");
    assert.deepEqual(cancel.e, { k: "dragCancel", tokenId: goblin.id });
    dm.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: goblin.id, x: 13, y: 13 } });
    assert.equal(await player.maybe("eph", () => true, 300), null);
    // Dropped in the fog: the token itself disappears from the player.
    await dm.apply({ t: "token.move", tokenId: goblin.id, x: 13, y: 13 });
    const withheld = await player.next("ev", (m) => tokenIn(m.changes, goblin.id) !== undefined);
    assert.deepEqual(tokenIn(withheld.changes, goblin.id), { key: `token:${goblin.id}`, deleted: true });
    dm.close();
    player.close();
  });

  test("previews are cleared on cancel and when the sender disconnects", async () => {
    const { dm, player, sceneId } = await setup(t, "Previews");
    const goblin = tokenOp(sceneId);
    await dm.apply(goblin.op);
    await player.next("ev", (m) => tokenIn(m.changes, goblin.id) !== undefined);
    dm.send({ t: "eph", sceneId, e: { k: "dragStart", tokenId: goblin.id, x: 2, y: 2 } });
    await player.next("eph", (m) => m.e.k === "dragStart");
    dm.send({ t: "eph", sceneId, e: { k: "dragCancel", tokenId: goblin.id } });
    assert.equal((await player.next("eph")).e.k, "dragCancel");
    dm.send({ t: "eph", sceneId, e: { k: "dragStart", tokenId: goblin.id, x: 2, y: 2 } });
    await player.next("eph", (m) => m.e.k === "dragStart");
    dm.send({ t: "eph", sceneId, e: { k: "ruler", id: "r1", points: [{ x: 0, y: 0 }], shared: true } });
    await player.next("eph", (m) => m.e.k === "ruler");
    dm.close();
    const kinds = [(await player.next("eph")).e.k, (await player.next("eph")).e.k].sort();
    assert.deepEqual(kinds, ["dragCancel", "rulerEnd"]);
    const presence = await player.next("presence", (m) => m.online.length === 1);
    assert.equal(presence.online.length, 1);
    player.close();
  });

  test("a DM switches scenes with scene, keeps its pending ops, and players follow the player scene by ev", async () => {
    const { dm, player, sceneId } = await setup(t, "Scenes");
    const prep = uuidv7();
    await dm.apply({ t: "scene.create", scene: { id: prep, name: "Prep", bounds: { w: 10, h: 10 } } });
    const secret = tokenOp(prep);
    await dm.apply(secret.op);
    assert.equal(await player.maybe("ev", (m) => tokenIn(m.changes, secret.id) !== undefined, 300), null);
    // An op in flight, then the switch: the ack lands after the new snapshot.
    const pending = dm.op({ t: "log.chat", text: "switching" });
    dm.send({ t: "scene", sceneId: prep });
    const resync = await dm.next("resync");
    assert.equal(resync.reason, "scene");
    const snap = await dm.snapshot("dm1", pending, prep);
    assert.equal(snap.you.sceneId, prep);
    assert.ok((snap.state as ProjectedState).tokens[secret.id]);
    if (snap.watermark < pending) {
      dm.op({ t: "log.chat", text: "switching" }, pending);
      await dm.next("ev", (m) => m.acks?.includes(pending) ?? false);
    }
    // A second scene request inside 2 s is busy.
    dm.send({ t: "scene", sceneId });
    assert.deepEqual(await dm.next("retry"), { t: "retry", code: "busy" });
    // Moving the players over brings the secret token into their view in one ev.
    await dm.apply({ t: "room.setPlayerScene", sceneId: prep });
    const moved = await player.next("ev", (m) => tokenIn(m.changes, secret.id) !== undefined);
    const scene = moved.changes.find((c) => c.key === `scene:${prep}`);
    assert.ok(scene && "value" in scene);
    assert.ok(moved.changes.some((c) => c.key === `scene:${sceneId}` && "deleted" in c));
    // A player asking for a scene is a broken client.
    player.send({ t: "scene", sceneId });
    assert.equal((await player.waitClosed()).code, 4003);
    dm.close();
  });

  test("undo and redo resolve to restores on the member's own stack", async () => {
    const { roomId, dm, player, sceneId } = await setup(t, "Undo");
    const goblin = tokenOp(sceneId);
    await dm.apply(goblin.op);
    await dm.apply({ t: "token.move", tokenId: goblin.id, x: 7, y: 7 });
    const undone = await dm.apply({ t: "undo" });
    const back = tokenIn(undone.changes, goblin.id);
    assert.ok(back && "value" in back);
    assert.equal((back.value as ProjectedToken).x, 2);
    const redone = await dm.apply({ t: "redo" });
    assert.equal((tokenIn(redone.changes, goblin.id) as { value: ProjectedToken }).value.x, 7);
    const empty = await dm.apply({ t: "redo" });
    assert.equal(empty.rejects?.[0]?.code, "invalid");
    // A player's stack holds only drawings, so the goblin move is not theirs to undo.
    const nothing = await player.apply({ t: "undo" });
    assert.equal(nothing.rejects?.[0]?.code, "invalid");
    const { rows } = await t.pool.query<{ op: { t: string } }>("select op from room_ops where room_id = $1 order by seq", [roomId]);
    assert.ok(rows.some((r) => r.op.t === "sys.restore"));
    assert.ok(!rows.some((r) => r.op.t === "undo" || r.op.t === "redo"));
    dm.close();
    player.close();
  });

  test("custom monsters reach DM sockets only, through create, edit, delete and undo", async () => {
    const dmClient = t.client();
    const { roomId, dmKey } = await dmClient.createRoom("Monsters");
    const playerClient = t.client();
    await playerClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const player = await t.connect(roomId, playerClient);
    await dm.snapshot("dm1");
    await player.snapshot("p1");
    const id = uuidv7();
    const key = `monster:${id}`;
    const secret = "It hides in the ceiling of the second cave.";
    const created = await dm.apply({ t: "monster.create", monster: { id, ...blockOf(customMonster(id)) } });
    assert.equal((created.changes.find((c) => c.key === key) as { value: CustomMonster }).value.traits[0]?.text, secret);
    const edited = await dm.apply({ t: "monster.update", monsterId: id, patch: { ac: 18 } });
    assert.equal((edited.changes.find((c) => c.key === key) as { value: CustomMonster }).value.ac, 18);
    // A player trying any of it is refused, and nothing about it reaches the player's socket.
    const refused = await player.apply({ t: "monster.update", monsterId: id, patch: { ac: 1 } });
    assert.equal(refused.rejects?.[0]?.code, "forbidden");
    assert.equal(await player.maybe("ev", (m) => m.changes.some((c) => c.key.startsWith("monster:")), 300), null);

    // A fresh DM device gets it in its snapshot, a fresh player device does not.
    const dmClient2 = t.client();
    await dmClient2.claimDm(roomId, dmKey);
    const dm2 = await t.connect(roomId, dmClient2);
    assert.equal(((await dm2.snapshot("dm2")).state as ProjectedState).monsters[id]?.ac, 18);
    const playerClient2 = t.client();
    await playerClient2.join(roomId, "Quin");
    const player2 = await t.connect(roomId, playerClient2);
    const ps = (await player2.snapshot("p2")).state as ProjectedState;
    assert.deepEqual(ps.monsters, {});
    assert.equal(JSON.stringify(ps).includes(secret), false);

    const deleted = await dm.apply({ t: "monster.delete", monsterId: id });
    assert.deepEqual(deleted.changes.find((c) => c.key === key), { key, deleted: true });
    const undone = await dm.apply({ t: "undo" });
    assert.equal((undone.changes.find((c) => c.key === key) as { value: CustomMonster }).value.ac, 18);
    assert.equal(await player.maybe("ev", (m) => m.changes.some((c) => c.key.startsWith("monster:")), 300), null);
    assert.equal(await player2.maybe("ev", (m) => m.changes.some((c) => c.key.startsWith("monster:")), 300), null);
    for (const s of [dm, dm2, player, player2]) s.close();
  });

  test("a player deletes a character they play alone, with its token, a shared one is refused with why, and it goes on no undo stack", async () => {
    const { roomId, dm, player, sceneId, playerMemberId } = await setup(t, "Delete");
    const otherId = await t.client().join(roomId, "Quin");
    const solo = uuidv7();
    const shared = uuidv7();
    const make = (id: string, ownerIds: string[]): Op => ({ t: "character.create", character: { id, name: "Bree", size: "medium", ownerIds, actor } }) as Op;
    await dm.apply(make(solo, [playerMemberId]));
    await dm.apply(make(shared, [playerMemberId, otherId]));
    const pc = tokenOp(sceneId, { kind: "pc", name: "Bree", actor: { ref: solo } });
    await dm.apply(pc.op);
    await dm.apply({ t: "encounter.start", entries: [{ id: uuidv7(), tokenId: pc.id, value: 12 }] });
    // A drawing first, so the undo after the delete shows what the player's stack still holds.
    const { rev: _rev, ...line } = drawing(uuidv7(), { sceneId, ownerId: playerMemberId });
    await player.apply({ t: "drawing.create", drawing: line });

    const refused = await player.apply({ t: "character.delete", characterId: shared });
    assert.deepEqual(refused.rejects?.map((r) => [r.code, r.message]), [["forbidden", PLAYED_WITH_OTHERS]]);

    const deleted = await player.apply({ t: "character.delete", characterId: solo });
    assert.deepEqual(deleted.rejects ?? [], []);
    assert.deepEqual(deleted.changes.find((c) => c.key === `character:${solo}`), { key: `character:${solo}`, deleted: true });
    assert.deepEqual(tokenIn(deleted.changes, pc.id), { key: `token:${pc.id}`, deleted: true });
    const seen = await dm.next("ev", (m) => tokenIn(m.changes, pc.id) !== undefined);
    assert.deepEqual(tokenIn(seen.changes, pc.id), { key: `token:${pc.id}`, deleted: true });
    const encounter = seen.changes.find((c) => c.key === "encounter") as { value: { entries: unknown[] } } | undefined;
    assert.deepEqual(encounter?.value.entries, [], "its row left the fight");
    // The DM's log says who deleted it and what went, and no player's does.
    const lineOf = (changes: Change[]) => changes.find((c) => c.key.startsWith("log:") && "value" in c && (c.value as { data?: { type?: string } }).data?.type === "characterDeleted");
    const logged = lineOf(seen.changes) as { value: { data: unknown } } | undefined;
    assert.deepEqual(logged?.value.data, { type: "characterDeleted", characterId: solo, memberId: playerMemberId, name: "Bree", tokens: 1, companions: 0, rows: 1 });
    assert.equal(lineOf(deleted.changes), undefined, "the player's own ev carries no line");

    // The undo takes back the drawing, never the delete.
    const undone = await player.apply({ t: "undo" });
    assert.deepEqual(undone.rejects ?? [], []);
    assert.deepEqual(undone.changes.find((c) => c.key === `drawing:${line.id}`), { key: `drawing:${line.id}`, deleted: true });
    assert.equal(undone.changes.some((c) => c.key === `character:${solo}` || c.key === `token:${pc.id}`), false);
    const nothing = await player.apply({ t: "undo" });
    assert.equal(nothing.rejects?.[0]?.code, "invalid");
    dm.close();
    player.close();
  });

  test("a show of 100 pages reaches the player it is shown to whole, every page with its row's size, in its event and in a reconnect's snapshot, and a document never does (docs/design-v1-pdf-handouts.md 3.4)", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Handouts");
    const playerClient = t.client();
    const playerMemberId = await playerClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const player = await t.connect(roomId, playerClient);
    await dm.snapshot("dm1");
    await player.snapshot("p1");
    // Rows written directly, since no page's file is read here, each a size of its own.
    const pages: HandoutPage[] = [];
    for (let i = 0; i < 100; i++) {
      const id = randomUUID();
      await t.pool.query(
        `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants)
         values ($1, $2, $3, 'handout', 1, $4, 2048, 10, '{full,thumb}')`,
        [id, roomId, randomBytes(32), 1000 + i],
      );
      pages.push({ assetId: id, width: 1000 + i, height: 2048 });
    }
    const docId = uuidv7();
    // The client's sizes are wrong on purpose: the rows' win.
    const sent = pages.map((p) => ({ ...p, width: 1, height: 1 }));
    assert.equal((await dm.apply({ t: "handoutDoc.create", doc: { id: docId, title: "Player's guide", pages: sent } })).rejects, undefined);
    assert.equal(await player.maybe("ev", (m) => m.changes.some((c) => c.key.startsWith("handoutDoc:")), 300), null);

    const id = uuidv7();
    const shown = await dm.apply({ t: "handout.show", handout: { id, pages: sent, title: "Player's guide", to: [playerMemberId] } });
    assert.equal(shown.rejects, undefined);
    const ev = await player.next("ev", (m) => m.changes.some((c) => c.key === `handout:${id}`));
    const handout = (ev.changes.find((c) => c.key === `handout:${id}`) as { value: Handout }).value;
    assert.equal(handout.assetId, pages[0]!.assetId);
    assert.deepEqual(handout.pages, pages);

    const again = await t.connect(roomId, playerClient);
    const snap = (await again.snapshot("p1-again")).state as ProjectedState;
    assert.deepEqual(snap.handouts[id]?.pages, pages);
    assert.deepEqual(snap.handoutDocs, {});
    assert.equal(JSON.stringify(snap).includes(docId), false);
    for (const s of [dm, player, again]) s.close();
  });

  test("a player receives their character's companion blocks and no other's, a table display none, and an owner change moves them (docs/design-v1-companion-stat-blocks.md 4.2)", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Familiars");
    const anaClient = t.client();
    const ana = await anaClient.join(roomId, "Ana");
    const cyClient = t.client();
    const cy = await cyClient.join(roomId, "Cy");
    const dm = await t.connect(roomId, dmClient);
    await dm.snapshot("dm1");
    const breeId = uuidv7();
    const cyCharId = uuidv7();
    const make = (id: string, name: string, ownerIds: string[]) => {
      const { rev: _rev, ...c } = testCharacter(id, { name, ownerIds });
      return { t: "character.create", character: c } as Op;
    };
    assert.equal((await dm.apply(make(breeId, "Bree", [ana]))).rejects, undefined);
    assert.equal((await dm.apply(make(cyCharId, "Cy", [cy]))).rejects, undefined);
    const anaSocket = await t.connect(roomId, anaClient);
    const cySocket = await t.connect(roomId, cyClient);
    await anaSocket.snapshot("ana");
    await cySocket.snapshot("cy");
    const tv = t.client();
    const code = (await dmClient.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code) })).statusCode, 200);
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");

    // Ana saves a block for Bree: it reaches Ana and the DM, and neither Cy nor the display.
    const blockId = uuidv7();
    const { rev: _rev, ...block } = companionBlock(blockId, breeId, { name: "Moth Spirit" });
    assert.equal((await anaSocket.apply({ t: "companionBlock.create", block })).rejects, undefined);
    const key = `companionBlock:${blockId}`;
    const ofKey = (m: { changes: Change[] }) => m.changes.some((c) => c.key === key);
    const toDm = await dm.next("ev", ofKey);
    assert.equal((toDm.changes.find((c) => c.key === key) as { value: { rev: number } }).value.rev, 1);
    for (const [socket, who] of [[cySocket, "Cy"], [display, "the display"]] as const) assert.equal(await socket.maybe("ev", ofKey, 300), null, who);
    const anaAgain = await t.connect(roomId, anaClient);
    const anaSnap = (await anaAgain.snapshot("ana-again")).state as ProjectedState;
    assert.equal(anaSnap.companionBlocks[blockId]?.name, "Moth Spirit");
    assert.equal(anaSnap.companionBlocks[blockId]?.rev, 0);
    const cySnap = (await (await t.connect(roomId, cyClient)).snapshot("cy-again")).state as ProjectedState;
    assert.deepEqual(cySnap.companionBlocks, {});
    assert.equal(JSON.stringify(cySnap).includes("Lantern Wings"), false);

    // The DM gives Bree to Cy: Cy's socket gets the block, Ana's loses it.
    assert.equal((await dm.apply({ t: "character.update", characterId: breeId, patch: { ownerIds: [cy] } })).rejects, undefined);
    const gained = await cySocket.next("ev", ofKey);
    assert.ok(gained.changes.some((c) => c.key === key && "value" in c));
    const lost = await anaSocket.next("ev", ofKey);
    assert.ok(lost.changes.some((c) => c.key === key && !("value" in c)));
    for (const s of [dm, anaSocket, anaAgain, cySocket, display]) s.close();
  });

  test("a player's ask for saves reaches the DM and the asker with the roll they sent first, and not another player, and sent twice it asks once (docs/design-v1-player-save-spell.md 8)", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Save spell");
    const playerClient = t.client();
    const playerMemberId = await playerClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const player = await t.connect(roomId, playerClient);
    const sceneId = playerScene(await dm.snapshot("dm1"));
    await player.snapshot("p1");
    const otherClient = t.client();
    await otherClient.join(roomId, "Quin");
    const other = await t.connect(roomId, otherClient);
    await other.snapshot("quin");
    const thornId = uuidv7();
    const { rev: _rev, ...thorn } = testCharacter(thornId, { name: "Thorn", ownerIds: [playerMemberId] });
    assert.equal((await dm.apply({ t: "character.create", character: thorn } as Op)).rejects, undefined);
    const pc = tokenOp(sceneId, { kind: "pc", name: "Thorn", actor: { ref: thornId } });
    const goblin = tokenOp(sceneId);
    for (const { op } of [pc, goblin]) assert.equal((await dm.apply(op)).rejects, undefined);

    const tag = uuidv7();
    const rolled = await player.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "8d6", label: "Fireball damage, Fire", creature: { tokenId: pc.id } }] });
    assert.equal(rolled.rejects, undefined);
    const id = uuidv7();
    const ask: Op = { t: "cast.ask", cast: { id, caster: pc.id, sceneId, spell: "Fireball", slot: 3, targets: [goblin.id], damage: { tag, parts: 1 } } };
    const key = `cast:${id}`;
    const ofKey = (m: { changes: Change[] }) => m.changes.some((c) => c.key === key);
    // The same ask twice on one socket: the second is answered from the first's receipt.
    const first = player.op(ask);
    const second = player.op(ask);
    const answered = await player.next("ev", (m) => m.acks?.includes(second) ?? false);
    assert.equal(answered.rejects, undefined);
    const toDm = await dm.next("ev", ofKey);
    const held = (toDm.changes.find((c) => c.key === key) as { value: CastAsk }).value;
    assert.deepEqual([held.by, held.caster, held.targets, held.rolled?.length, held.rolled?.[0]?.type], [playerMemberId, pc.id, [goblin.id], 1, "fire"]);
    assert.ok(first < second);
    assert.equal(await other.maybe("ev", ofKey, 300), null, "another player never learns of it");

    const again = await Promise.all([t.connect(roomId, dmClient), t.connect(roomId, playerClient), t.connect(roomId, otherClient)]);
    const [dmAgain, mineAgain, theirsAgain] = again;
    const dmSnap = (await dmAgain!.snapshot("dm-again")).state as ProjectedState;
    assert.equal(Object.keys(dmSnap.casts).length, 1, "asked once");
    assert.equal(dmSnap.log.filter((e) => e.data?.type === "cast").length, 1, "one line");
    const mine = (await mineAgain!.snapshot("p1-again")).state as ProjectedState;
    assert.equal(mine.casts[id]?.rolled?.[0]?.total, held.rolled?.[0]?.total, "the asker holds their roll");
    const theirs = (await theirsAgain!.snapshot("quin-again")).state as ProjectedState;
    assert.deepEqual(theirs.casts, {});
    assert.equal(theirs.log.some((e) => e.data?.type === "cast"), false);
    for (const s of [dm, player, other, ...again]) s.close();
  });
});
