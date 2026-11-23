import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { isUuidv7, sealedTime, uuidv7 } from "#shared/ids.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { hash12 } from "#shared/rules/pcSync.ts";
import { v7IdsIn } from "./reid.ts";
import { RoomIdKeys } from "./idKeys.ts";
import { startEngine, type Engine } from "./testing.ts";

/**
 * An imported room's ids (C6): every thing, roll, class resource and the
 * clock takes an id sealed under the new room's server key, recorded with
 * the time it was made. What each player and the table display holds then
 * keeps no version 7 id but member ids and roll tags.
 */
const inline = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

describe("an imported room's ids", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  test("C6: sealed under the new room's server key with rows at their times, and each player's copy holds no version 7 id but member ids and roll tags", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Before the copy");
    const p1 = t.client();
    const p1Id = await p1.join(roomId, "Pip");
    const dmSocket = await t.connect(roomId, dm);
    const sceneId = ((await dmSocket.snapshot("dm")).state as RoomState).meta.playerSceneId!;
    const p1Socket = await t.connect(roomId, p1);
    await p1Socket.snapshot("p1");
    const goblin = uuidv7();
    assert.equal((await dmSocket.apply({ t: "token.create", token: { id: goblin, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: { inline } } } as Op)).rejects, undefined);
    const tag = uuidv7();
    assert.equal((await p1Socket.apply({ t: "dice.roll", tag, to: "all", rolls: [{ formula: "1d20" }] } as Op)).rejects, undefined);
    dmSocket.close();
    p1Socket.close();
    await t.manager.unload(roomId);

    // Pip's character with a roll, a class resource, a sync record and a rest stamp, and a shown clock an effect ends on.
    const clock = uuidv7();
    const roll = uuidv7();
    const res = uuidv7();
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    const state = rows[0]!.state;
    const hero = uuidv7();
    state.clock = { id: clock, rev: 0, t: 1_000, shown: true, calendar: { kind: "days" } };
    state.characters[hero] = {
      id: hero, rev: 0, ownerIds: [p1Id], name: "Pip", size: "medium",
      actor: { ...inline, effects: [{ id: uuidv7(), key: "blessed", ends: { span: 600, at: 1_600, clock } }] } as never,
      stats: { ...structuredClone(EMPTY_PC_STATS), rolls: [{ id: roll, name: "Sling", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d4" }] }] } as never,
      resources: [{ id: res, name: "Rage", max: 2, used: 0, reset: "long" }],
      ddbSync: { at: "2026-10-01T12:00:00.000Z", base: { level: 3 }, rolls: { [hash12(roll)]: { k: "w:00000000000a", h: "00000000000b" } } },
      longRest: { at: 900, clock },
    };
    await t.pool.query("update room_snapshots set state = $2::jsonb where room_id = $1", [roomId, JSON.stringify(state)]);

    const res1 = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res1.statusCode, 200, res1.body);
    const importer = t.client();
    const fields = Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url");
    const started = Date.now();
    const imported = await importer.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": fields }, res1.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId: copyId } = imported.json<{ roomId: string }>();
    t.track(copyId);
    const copy = (await t.manager.acquire(copyId)).committed.state;

    const key = new RoomIdKeys(t.config.roomSecretKey, copyId).server.key;
    const bree = Object.values(copy.characters)[0]!;
    const things = [...Object.keys(copy.scenes), ...Object.keys(copy.tokens), bree.id, bree.stats!.rolls[0]!.id, bree.resources![0]!.id, copy.clock!.id];
    for (const id of things) {
      const at = sealedTime(key, id);
      assert.ok(at !== null && at >= started && at <= Date.now(), `${id} sealed under the copy's server key at the import`);
    }
    assert.deepEqual(Object.keys(bree.ddbSync!.rolls ?? {}), [hash12(bree.stats!.rolls[0]!.id)], "the sync record follows its roll");
    assert.equal(bree.longRest?.clock, copy.clock!.id, "the rest stamp names the copy's clock");
    const stored = await t.pool.query<{ id: string; until: Date }>("select id, until from room_ids where room_id = $1", [copyId]);
    const rowOf = new Map(stored.rows.map((r) => [r.id, r.until.getTime()]));
    for (const id of things) assert.ok((rowOf.get(id) ?? 0) > Date.now(), `${id} has its row, held past now`);

    const members = new Set(Object.keys(copy.members));
    const viewers: Viewer[] = [...Object.values(copy.members).flatMap((m) => (m.kind === "player" ? [{ memberId: m.id, role: "player" as const }] : [])), { memberId: "display:000000000000", role: "player" }];
    assert.ok(viewers.length >= 3, "the old DM and Pip arrive as players, and the display");
    for (const viewer of viewers) {
      const held = v7IdsIn(JSON.stringify(projectState(copy, viewer, { sceneId: null })));
      for (const id of held) assert.ok(members.has(id) || id === tag, `${viewer.memberId} holds ${id}, a member id or a roll tag`);
    }
    assert.ok([...v7IdsIn(JSON.stringify(copy))].every((id) => isUuidv7(id) && (members.has(id) || id === tag)), "nor does the room");
    await t.manager.unload(copyId, undefined, false);
  });
});
