import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ID_TIME_REFUSED, idKeyFromText, sealedId, uuidv7 } from "#shared/ids.ts";
import { ID_PAGE_OLD, ID_SEAL_GRACE_MS } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op, OpType, ServerMessage } from "#shared/protocol.ts";
import { blockOf, companionBlock, customMonster } from "#shared/testutil.ts";
import { idRow, LATEST_UNTIL, recordIds } from "./createIds.ts";
import { FAR_SEALED_SINCE, startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * The change over to version 8 ids on Postgres (C11, C40, C42, C16): from
 * `server_facts.sealed_since` plus ID_SEAL_GRACE_MS, a socket that asked
 * for no id key meets ID_PAGE_OLD for a version 7 id in every field of a
 * new thing, one row per op type, while one that holds a key meets the
 * words its page retries on, the ids named, and its sealed retry lands.
 * Undo still brings a thing back under the id it had.
 */
const inline = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
const OLD_PAGE = { code: "invalid", message: ID_PAGE_OLD };

type Answer = "taken" | { code: string; message: string; ids?: string[] };
async function answer(socket: Socket, op: unknown): Promise<Answer> {
  const ev = await socket.apply(op as Op);
  const refusal = ev.rejects?.find((r) => ev.acks?.includes(r.n) !== true);
  return refusal ? { code: refusal.code, message: refusal.message ?? "", ...(refusal.ids ? { ids: refusal.ids } : {}) } : "taken";
}

describe("the change over to version 8 ids", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
  });
  after(async () => {
    await t.pool.query("update server_facts set sealed_since = $1", [FAR_SEALED_SINCE]);
    await t.close();
  });

  test("C11, C40, C42: past the grace, every new-id field refuses an unkeyed socket's version 7 id as an old page, a keyed one in its retry's words, and Undo keeps the old id", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Change over");
    const p1 = t.client();
    const p1Id = await p1.join(roomId, "Pip");
    let dm = await t.connect(roomId, owner);
    const mat = ((await dm.snapshot("dm")).state as RoomState).meta.playerSceneId!;
    // Things made before the change over, under version 7 ids.
    const goblin = uuidv7();
    const pc = uuidv7();
    const hero = uuidv7();
    const page = uuidv7();
    const token = (id: string, extra: object = {}) => ({ t: "token.create", token: { id, sceneId: mat, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: { inline }, ...extra } });
    for (const op of [
      token(goblin),
      { t: "character.create", character: { id: hero, name: "Pip", size: "medium", ownerIds: [p1Id], actor: inline } },
      token(pc, { kind: "pc", name: "Pip", x: 4, ownerIds: [p1Id], actor: { ref: hero } }),
      { t: "journal.create", page: { id: page, title: "Notes", access: "dm", blocks: [] } },
    ]) {
      assert.equal(await answer(dm, op), "taken", (op as { t: string }).t);
    }
    dm.close();
    await dm.waitClosed();
    await t.manager.unload(roomId);
    // This server first ran the build past the grace, and the room loads again after it.
    await t.pool.query("update server_facts set sealed_since = $1", [new Date(Date.now() - ID_SEAL_GRACE_MS - 60_000)]);
    dm = await t.connect(roomId, owner);
    await dm.snapshot("dm-again");
    const player = await t.connect(roomId, p1);
    await player.snapshot("p1");

    const v7 = () => uuidv7();
    const asset = "0192f0aa-0000-7000-8000-000000000001";
    const stamp = (id: string) => ({ id, art: { key: "barrel" }, x: 3, y: 3, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" });
    const rows: { t: OpType; op: () => unknown; by?: Socket; expect?: Answer }[] = [
      { t: "scene.create", op: () => ({ t: "scene.create", scene: { id: v7(), name: "Crypt", bounds: { w: 30, h: 17 } } }) },
      { t: "floorLink.put", op: () => ({ t: "floorLink.put", link: { id: v7(), pairId: v7(), sceneId: mat, to: "up", rect: { x: 9, y: 9, w: 1, h: 1 }, kind: "stairs" } }) },
      { t: "scene.duplicate", op: () => ({ t: "scene.duplicate", sceneId: mat, newSceneId: v7(), name: "Copy", include: { creatures: true, characters: true, fog: false, drawings: false } }) },
      { t: "token.create", op: () => token(v7()) },
      { t: "actor.effect.add", op: () => ({ t: "actor.effect.add", target: { tokenId: goblin }, effect: { id: v7(), key: "blessed" } }) },
      { t: "actor.effect.update", op: () => ({ t: "actor.effect.update", target: { tokenId: goblin }, effectId: v7(), patch: { hiddenFromPlayers: true }, as: v7() }) },
      { t: "character.create", op: () => ({ t: "character.create", character: { id: v7(), name: "Wren", size: "medium", ownerIds: [], actor: inline } }) },
      { t: "monster.create", op: () => ((id) => ({ t: "monster.create", monster: { id, ...blockOf(customMonster(id)) } }))(v7()) },
      { t: "companionBlock.create", op: () => ({ t: "companionBlock.create", block: (({ rev: _rev, ...block }) => block)(companionBlock(v7(), hero)) }) },
      { t: "savedEncounter.create", op: () => ({ t: "savedEncounter.create", encounter: { id: v7(), name: "Wolves", monsters: [] } }) },
      { t: "template.create", op: () => ({ t: "template.create", template: { id: v7(), sceneId: mat, shape: "sphere", size: 20, origin: { x: 5, y: 5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "dm", visibility: "all" } }) },
      { t: "drawing.create", op: () => ({ t: "drawing.create", drawing: { id: v7(), sceneId: mat, kind: "line", points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "dm", visibility: "all" } }) },
      { t: "trap.create", op: () => ({ t: "trap.create", trap: { id: v7(), sceneId: mat, name: "Pit", zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false } } }) },
      { t: "encounter.start", op: () => ({ t: "encounter.start", entries: [{ id: v7(), tokenId: goblin, value: 3 }] }) },
      { t: "encounter.add", op: () => ({ t: "encounter.add", entries: [{ id: v7(), label: "Goblin", hidden: true }] }) },
      { t: "clock.start", op: () => ({ t: "clock.start", id: v7(), at: 0, shown: false, calendar: { kind: "days" } }) },
      { t: "sound.create", op: () => ({ t: "sound.create", id: v7(), assetId: asset, name: "Tavern", use: "music", ms: 120_000 }) },
      { t: "playlist.create", op: () => ({ t: "playlist.create", id: v7(), name: "Night", sounds: [v7()], shuffle: true, repeat: "all", fade: 0 }) },
      { t: "handout.show", op: () => ({ t: "handout.show", handout: { id: v7(), assetId: asset, title: "Letter", to: "all" } }) },
      { t: "handoutDoc.create", op: () => ({ t: "handoutDoc.create", doc: { id: v7(), title: "Letter", pages: [{ assetId: asset, width: 100, height: 100 }] } }) },
      { t: "actor.effects", op: () => ({ t: "actor.effects", add: [{ target: { tokenId: goblin }, effect: { id: v7(), key: "frightened" } }] }) },
      { t: "journal.create", op: () => ({ t: "journal.create", page: { id: v7(), title: "More notes", access: "dm", blocks: [] } }) },
      { t: "roll.ask", op: () => ({ t: "roll.ask", request: { id: v7(), test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ tokenId: goblin }] } }) },
      { t: "cast.ask", by: player, op: () => ({ t: "cast.ask", cast: { id: v7(), caster: pc, sceneId: mat, spell: "Fireball", targets: [goblin] } }) },
      { t: "actor.outcome", op: () => ({ t: "actor.outcome", plan: v7(), label: "Hold Person", targets: [{ target: { tokenId: goblin }, effects: [{ id: v7(), key: "paralyzed" }] }] }) },
      { t: "build.label", op: () => ({ t: "build.label", sceneId: mat, labelId: v7(), label: { x: 1, y: 1, text: "Here", size: 1 } }) },
      { t: "build.stamps", op: () => ({ t: "build.stamps", sceneId: mat, put: [stamp(v7())] }) },
      { t: "build.lights", op: () => ({ t: "build.lights", sceneId: mat, put: [{ id: v7(), x: 1, y: 1, bright: 10, dim: 10, on: true, walls: true }] }) },
      { t: "pin.put", op: () => ({ t: "pin.put", pin: { id: v7(), sceneId: mat, x: 1, y: 1, color: "#ff0000", visibility: "all" } }) },
      { t: "character.update", op: () => ({ t: "character.update", characterId: hero, patch: { resources: [{ id: v7(), name: "Rage", max: 2, reset: "long" }] } }) },
      { t: "effect.fire", op: () => ({ t: "effect.fire", id: v7(), builtin: "click" }) },
      // A page's update names a page the room holds, which is no new thing (newIdPaths.ts).
      { t: "journal.update", op: () => ({ t: "journal.update", pageId: page, patch: { title: "Old notes" } }), expect: "taken" },
    ];
    const answers: [OpType, Answer][] = [];
    for (const row of rows) answers.push([row.t, await answer(row.by ?? dm, row.op())]);
    assert.deepEqual(answers, rows.map((row) => [row.t, row.expect ?? OLD_PAGE]));

    // C40: a thing made before the change over, deleted after it, comes back under its old id.
    assert.equal(await answer(dm, { t: "token.delete", tokenId: goblin }), "taken");
    assert.equal(await answer(dm, { t: "undo", head: (await dm.historyHead())! }), "taken");
    const back = await t.manager.acquire(roomId);
    assert.ok(back.committed.state.tokens[goblin], "the Goblin is back under its version 7 id");

    // C42: a keyed socket's version 7 stamp is refused in the words its page retries on, naming it, and lands sealed.
    const keyed = await t.connect(roomId, owner);
    keyed.send({ t: "hello", clientId: "keyed", resumeFrom: 1, sealIds: true });
    const snap = (await keyed.next("snapshot")) as Extract<ServerMessage, { t: "snapshot" }>;
    const key = idKeyFromText(snap.you.idKey!)!;
    const old = v7();
    assert.deepEqual(await answer(keyed, { t: "build.stamps", sceneId: mat, put: [stamp(old)] }), { code: "invalid", message: ID_TIME_REFUSED, ids: [old] });
    assert.deepEqual(await answer(keyed, { t: "build.stamps", sceneId: mat, put: [stamp(sealedId(key, Date.now()))] }), "taken");
    assert.deepEqual(await answer(keyed, token(old)), { code: "invalid", message: ID_TIME_REFUSED }, "a minted one is refused alike, naming none");
    for (const s of [dm, player, keyed]) s.close();
    await t.manager.unload(roomId, undefined, false);
  });

  test("C16: a row whose read time is near 2^48 is stored with its end capped at 9999-12-31", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Far ahead");
    const id = sealedId(idKeyFromText("A".repeat(43))!, 2 ** 48 - 1);
    await recordIds(t.pool, roomId, [idRow(id, "m1", Date.now(), 2 ** 48 - 1)]);
    const { rows } = await t.pool.query<{ until: Date }>("select until from room_ids where room_id = $1 and id = $2", [roomId, id]);
    assert.equal(rows[0]?.until.getTime(), LATEST_UNTIL);
  });
});
