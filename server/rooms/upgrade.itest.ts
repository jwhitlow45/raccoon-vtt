import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { OP_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { loadRoom } from "./persistence.ts";
import { startEngine, type Engine } from "./testing.ts";

/**
 * The map discovery upgrade over a room Postgres stored before it
 * (docs/design-v1-map-discovery.md 5.5, ASTRA-31, section 10's S3 row): a
 * version 26 snapshot and version 25 ops that make scene S3, move the
 * players there, explore it and move them away. Then the same with newer
 * ops after, made through a socket. Then a reload after the snapshot the
 * clean unload writes. S3 is marked at the step in the first two, and the
 * third never runs it again.
 */

const S3 = { id: "0199f0a0-0000-7000-8000-000000000003", name: "Crypt", bounds: { w: 32, h: 32 }, fogEnabled: true, vision: { on: true, light: "dark" as const } };
const S4 = { id: "0199f0a0-0000-7000-8000-000000000004", name: "Hall", bounds: { w: 20, h: 20 }, fogEnabled: true, vision: { on: true, light: "dim" as const } };
const bits = Object.values(rasterizeFogOps({}, S3.id, S3.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }]))[0]!.bits;
const marks = (state: RoomState) => Object.fromEntries(Object.entries(state.playedScenes ?? {}).map(([id, m]) => [id, m.rev]));

describe("the map discovery upgrade over a stored room (ASTRA-31)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("marks S3 at the step over old ops alone and below newer ones, and never runs it again after a snapshot", async () => {
    const owner = t.client();
    const { roomId } = await owner.createRoom("Before discovery");
    const s = await t.connect(roomId, owner);
    const mat = ((await s.snapshot("c1")).state as ProjectedState).meta.playerSceneId!;
    s.close();
    await s.waitClosed();
    await t.manager.unload(roomId);

    // The room as a build before map discovery stored it: a version 26 snapshot, and version 25 ops after it.
    const stored = await t.pool.query<{ seq: string; state: RoomState }>("select seq::text, state from room_snapshots where room_id = $1", [roomId]);
    const { memory: _m, memoryBy: _b, playedScenes: _p, memoryShared: _s, ...v26 } = stored.rows[0]!.state;
    const base = Number(stored.rows[0]!.seq);
    await t.pool.query("update room_snapshots set state = $2::jsonb, schema_version = 26 where room_id = $1", [roomId, JSON.stringify(v26)]);
    const dmId = Object.values(v26.members).find((m) => m.kind === "dm")!.id;
    const old: Op[] = [
      { t: "scene.create", scene: S3 },
      { t: "room.setPlayerScene", sceneId: S3.id },
      { t: "sys.explore", sceneId: S3.id, tiles: [{ tx: 0, ty: 0, bits }] },
      { t: "room.setPlayerScene", sceneId: mat },
    ];
    for (const [i, op] of old.entries()) {
      await t.pool.query(
        `insert into room_ops (room_id, seq, at, actor_member_id, actor_role, op, op_version)
         values ($1, $2, now(), $3, 'dm', $4::jsonb, 25)`,
        [roomId, base + 1 + i, dmId, JSON.stringify(op)],
      );
    }

    // First: the old snapshot and old ops alone. Every scene there was is marked by the step, at rev 0.
    const first = await loadRoom(t.pool, roomId);
    assert.ok(first && !first.replayFailed);
    assert.deepEqual(marks(first.state), { [mat]: 0, [S3.id]: 0 });
    assert.deepEqual(Object.keys(first.state.memoryShared ?? {}), [S3.id]);
    assert.equal(Object.keys(first.state.exploredTiles).length, 1, "the old explore replayed");

    // Second: the room loads through the engine, a DM makes S4 on top, and the actor goes before any snapshot.
    const back = await t.connect(roomId, owner);
    await back.snapshot("c2");
    assert.equal((await back.apply({ t: "scene.create", scene: S4 })).rejects, undefined);
    const newest = await t.pool.query<{ op_version: number }>("select op_version from room_ops where room_id = $1 order by seq desc limit 1", [roomId]);
    assert.equal(newest.rows[0]?.op_version, OP_VERSION);
    await t.manager.unload(roomId, 1011, false);
    await back.waitClosed();
    const second = await loadRoom(t.pool, roomId);
    assert.ok(second && !second.replayFailed && second.state.scenes[S4.id]);
    // S4 came after the step and was never the players' scene, so the step that ran before its op left it unmarked.
    assert.deepEqual(marks(second.state), { [mat]: 0, [S3.id]: 0 });

    // Third: a clean unload writes a snapshot holding the step's result, and a reload from it never runs the step again.
    const again = await t.connect(roomId, owner);
    await again.snapshot("c3");
    again.close();
    await again.waitClosed();
    await t.manager.unload(roomId);
    const written = await t.pool.query<{ state: RoomState; schema_version: number }>("select state, schema_version from room_snapshots where room_id = $1", [roomId]);
    assert.equal(written.rows[0]?.schema_version, SNAPSHOT_VERSION);
    assert.deepEqual(marks(written.rows[0]!.state), { [mat]: 0, [S3.id]: 0 });
    const third = await loadRoom(t.pool, roomId);
    assert.ok(third && !third.replayFailed);
    assert.deepEqual(marks(third.state), { [mat]: 0, [S3.id]: 0 });
    assert.equal(third.state.memoryShared?.[S4.id], undefined, "a scene made since shares nothing");
  });
});
