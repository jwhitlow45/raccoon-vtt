import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { isSealedShape, sealedTime, uuidv7 } from "#shared/ids.ts";
import { OP_VERSION, SEALED_IDS_SNAPSHOT_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectArchivedLog, projectState } from "#shared/project.ts";
import { RoomIdKeys } from "./idKeys.ts";
import { startEngine, type Engine } from "./testing.ts";

/**
 * A room's first load on this build over Postgres (reid.ts): a load whose
 * replay fails at its tail renames and stores nothing, and once the tail is
 * repaired the next load renames what no player holds or reads, in the
 * state, the archive and the receipts, in one transaction with the
 * snapshot at today's version, from which the room replays the same.
 */
describe("the first load's new ids over a stored room (C31)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("a failed tail renames and stores nothing, and the repaired room's next load renames all, its archive and receipts with it, and replays from its snapshot the same", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Old ids");
    const p1Id = await t.client().join(roomId, "Ayla");
    const dm = await t.connect(roomId, owner);
    const first = (await dm.snapshot("dm")).state as RoomState;
    const mat = first.meta.playerSceneId!;
    const seen = uuidv7();
    const dmGoblin = uuidv7();
    const inline = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    const base = { sceneId: mat, kind: "monster", name: "Goblin", size: "medium", x: 4, y: 4, actor: { inline } };
    assert.equal((await dm.apply({ t: "token.create", token: { ...base, id: seen } })).rejects, undefined);
    assert.equal((await dm.apply({ t: "token.create", token: { ...base, id: dmGoblin, x: 8, visibility: "dm" } })).rejects, undefined);
    assert.equal((await dm.apply({ t: "actor.hp", target: { tokenId: dmGoblin }, change: { kind: "damage", amount: 3 } })).rejects, undefined);
    dm.close();
    await dm.waitClosed();
    await t.manager.unload(roomId);

    // A former DM whose id the room's state no longer holds, named in a line of the DM's.
    const former = uuidv7();
    await t.pool.query("insert into room_dm_members (room_id, member_id) values ($1, $2)", [roomId, former]);
    await t.pool.query("insert into room_log (room_id, id, at, entry) values ($1, '1:900009', now(), $2::jsonb)", [roomId, JSON.stringify({ id: "1:900009", at: new Date().toISOString(), kind: "event", data: { type: "member", memberId: former, action: "undm" } })]);
    const rows = async () => (await t.pool.query<{ id: string; entry: LogEntry }>("select id, entry from room_log where room_id = $1 order by id", [roomId])).rows;
    const archived = await rows();
    assert.ok(JSON.stringify(archived).includes(dmGoblin), "the DM's line names the DM's Goblin");
    // A damage roll's receipt that names an ask the room renames.
    await t.pool.query("insert into roll_receipts (room_id, member_id, tag, part, state, seq, at, ask) values ($1, $2, $3, 0, 'committed', 1, now(), $4)", [roomId, p1Id, uuidv7(), dmGoblin]);
    // As a build before version 8 ids left it.
    await t.pool.query("update room_snapshots set schema_version = $2 where room_id = $1", [roomId, SEALED_IDS_SNAPSHOT_VERSION - 1]);
    const snap = (await t.pool.query<{ seq: string; state: RoomState; schema_version: number }>("select seq::text, state, schema_version from room_snapshots where room_id = $1", [roomId])).rows[0]!;
    const pub = Number((await t.pool.query<{ pub: string }>("select pub::text from rooms where id = $1", [roomId])).rows[0]!.pub);
    const dmId = Object.values(snap.state.members).find((m) => m.kind === "dm")!.id;
    await t.pool.query(
      "insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version, pub) values ($1, $2, now(), $3, 'dm', $4::jsonb, $5, $6)",
      [roomId, Number(snap.seq) + 1, dmId, JSON.stringify({ t: "token.update", tokenId: "no-such-token", patch: { x: 1 } }), OP_VERSION, pub + 1],
    );

    // The tail fails: the room is served read-only, as it was, and nothing is stored.
    const broken = await t.manager.acquire(roomId);
    assert.equal(broken.replayFailed, true);
    assert.ok(broken.committed.state.tokens[dmGoblin], "nothing renamed");
    await t.manager.unload(roomId, undefined, false);
    const still = (await t.pool.query<{ schema_version: number }>("select schema_version from room_snapshots where room_id = $1", [roomId])).rows[0]!;
    assert.equal(still.schema_version, SEALED_IDS_SNAPSHOT_VERSION - 1, "no snapshot stored");
    assert.deepEqual(await rows(), archived, "the archive as it was");

    // Repaired, the next load renames the whole room.
    await t.pool.query("delete from room_ops where room_id = $1 and seq = $2", [roomId, Number(snap.seq) + 1]);
    const actor = await t.manager.acquire(roomId);
    assert.equal(actor.replayFailed, false);
    const renamed = actor.committed.state;
    const p1: Viewer = { memberId: p1Id, role: "player" };
    assert.ok(renamed.tokens[seen], "P1's Goblin keeps its id");
    assert.equal(renamed.tokens[dmGoblin], undefined);
    const fresh = Object.keys(renamed.tokens).find((id) => renamed.tokens[id]!.x === 8)!;
    assert.ok(isSealedShape(fresh));
    assert.notEqual(sealedTime(new RoomIdKeys(t.config.roomSecretKey, roomId).server.key, fresh), null, "sealed under the room's server key");
    assert.equal(JSON.stringify(projectState(renamed, p1, { sceneId: null })), JSON.stringify(projectState(snap.state, p1, { sceneId: null })), "P1's copy, byte for byte");
    const now = await rows();
    assert.equal(JSON.stringify(projectArchivedLog(renamed, now.map((r) => r.entry), p1, { sceneId: null })), JSON.stringify(projectArchivedLog(snap.state, archived.map((r) => r.entry), p1, { sceneId: null })), "P1's log page, byte for byte");
    assert.ok(!JSON.stringify(now).includes(dmGoblin) && JSON.stringify(now).includes(fresh), "the archive names the new id");
    assert.ok(JSON.stringify(now).includes(former), "a member id another table names keeps its own");
    const asks = (await t.pool.query<{ ask: string | null }>("select ask from roll_receipts where room_id = $1 and ask is not null", [roomId])).rows.map((r) => r.ask);
    assert.deepEqual(asks, [fresh], "the receipt's ask follows it");
    const stored = (await t.pool.query<{ seq: string; schema_version: number; state: RoomState }>("select seq::text, schema_version, state from room_snapshots where room_id = $1", [roomId])).rows[0]!;
    assert.deepEqual([stored.schema_version, stored.seq], [SNAPSHOT_VERSION, snap.seq]);
    assert.deepEqual(stored.state, renamed);
    const ids = (await t.pool.query<{ id: string }>("select id from room_ids where room_id = $1", [roomId])).rows.map((r) => r.id);
    assert.ok(ids.includes(dmGoblin), "the gate's rows stay as they were");

    // Loaded again, it replays from that snapshot the same and renames nothing more.
    await t.manager.unload(roomId, undefined, false);
    const again = await t.manager.acquire(roomId);
    assert.deepEqual(again.committed.state, renamed);
    await t.manager.unload(roomId, undefined, false);
  });
});
