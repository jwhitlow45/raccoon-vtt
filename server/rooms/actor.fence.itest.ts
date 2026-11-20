import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { OP_VERSION, OPENINGS_OP_VERSION, OPENINGS_SNAPSHOT_VERSION, SNAPSHOT_VERSION, runMigrations, snapshotMigrations } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { loadRoom, snapshotJson } from "./persistence.ts";
import { failCommits, startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/*
 * The snapshot fence of openings between floors (docs/design/design-v1-floors.md
 * phase 4, 11, D-261119-088), in Postgres: a room saved at room format 47
 * stores its first batch of change format 64 with a snapshot at room format
 * 48 in the same transaction, so an older build refuses the room rather than
 * load the rows before the first op it cannot read and serve that prefix. No
 * timer is needed for it, a room stopped right after that batch already
 * holds it, and a snapshot build or a commit that fails holds the batch,
 * which is tried again and stored once with its snapshot.
 */

describe("the openings snapshot fence (D-261119-088)", () => {
  let t: Engine;
  /** Snapshot builds still to fail, which the test sets before the op that must wait for one. */
  let failingBuilds = 0;
  let builds = 0;
  before(async () => {
    t = await startEngine({
      rooms: {
        idleUnloadMs: 60_000,
        actor: {
          // No timer writes a snapshot while a test runs: the fence alone must.
          snapshotOps: 1_000,
          snapshotIdleMs: 600_000,
          retryBaseMs: 5,
          retryMaxMs: 20,
          snapshotJson: (state: RoomState) => {
            builds++;
            if (failingBuilds > 0) {
              failingBuilds--;
              throw new Error("simulated snapshot build failure");
            }
            return snapshotJson(state);
          },
        },
      },
    });
  });
  after(() => t.close());

  async function ok(socket: Socket, op: Op): Promise<Extract<ServerMessage, { t: "ev" }>> {
    const ev = await socket.apply(op);
    assert.deepEqual(ev.rejects ?? [], [], `${op.t} was refused`);
    return ev;
  }

  /**
   * A room with a second floor above its first, saved and stopped here, its
   * snapshot then marked room format 47 as a build before openings would
   * have stored it. Its ops after load are the first at change format 64.
   */
  async function savedAt47(name: string): Promise<{ roomId: string; dm: TestClient; ground: string; upper: string; base: number }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom(name);
    const s = await t.connect(roomId, dm);
    const snap = await s.snapshot("fence-setup");
    const ground = (snap.state as RoomState).meta.playerSceneId!;
    const upper = uuidv7();
    await ok(s, { t: "scene.create", scene: { id: upper, name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside: ground, side: "above" } } as Op);
    s.close();
    await s.waitClosed();
    await t.manager.unload(roomId, 1012, true);
    await t.pool.query("update room_snapshots set schema_version = $2 where room_id = $1", [roomId, OPENINGS_SNAPSHOT_VERSION - 1]);
    const { rows } = await t.pool.query<{ seq: string; above: string }>("select seq::text, (select count(*) from room_ops o where o.room_id = s.room_id and o.seq > s.seq)::text as above from room_snapshots s where room_id = $1", [roomId]);
    assert.equal(rows[0]?.above, "0", "every op so far lies under the snapshot");
    return { roomId, dm, ground, upper, base: Number(rows[0]!.seq) };
  }

  const opening = (upper: string, ground: string): Op => ({ t: "floorLink.put", link: { id: uuidv7(), pairId: uuidv7(), sceneId: upper, to: ground, rect: { x: 6, y: 6, w: 2, h: 2 }, kind: "opening" } });

  /** The room's snapshot row and its op rows past `base`, the snapshot it loaded from. */
  async function stored(roomId: string, base: number) {
    const snap = await t.pool.query<{ seq: string; schema_version: number; state: RoomState }>("select seq::text, schema_version, state from room_snapshots where room_id = $1", [roomId]);
    const ops = await t.pool.query<{ seq: string; op_version: number; t: string }>("select seq::text, op_version, op->>'t' as t from room_ops where room_id = $1 and seq > $2 order by seq", [roomId, base]);
    return { snapshot: snap.rows[0]!, ops: ops.rows };
  }

  test("the first batch at change format 64 stores its snapshot at 48 in its transaction, which an older build refuses, and a stop right after keeps it", async () => {
    const { roomId, dm, ground, upper, base } = await savedAt47("Fence");
    const s = await t.connect(roomId, dm);
    await s.snapshot("fence-1");
    const ev = await ok(s, opening(upper, ground));
    const after = await stored(roomId, base);
    assert.equal(OP_VERSION >= OPENINGS_OP_VERSION, true);
    assert.deepEqual(after.ops.map((o) => [o.t, o.op_version]), [["floorLink.put", OP_VERSION]], "one row at today's change format");
    assert.equal(after.snapshot.schema_version, SNAPSHOT_VERSION);
    assert.equal(after.snapshot.seq, after.ops[0]!.seq, "the snapshot is the batch's own, stored with it");
    assert.equal(Object.values(after.snapshot.state.floorLinks ?? {}).filter((l) => l.kind === "opening").length, 2);
    assert.throws(() => runMigrations(after.snapshot.state, after.snapshot.schema_version, OPENINGS_SNAPSHOT_VERSION - 1, snapshotMigrations), /down/, "a build before openings refuses it");
    assert.ok(ev.seq > 0);
    // Stopped at once, with no snapshot of its own: the stored room already is at 48, and loads whole.
    s.close();
    await s.waitClosed();
    await t.manager.unload(roomId, 1012, false);
    const loaded = await loadRoom(t.pool, roomId);
    assert.ok(loaded && !loaded.replayFailed);
    assert.equal(loaded.snapshotVersion, SNAPSHOT_VERSION);
    assert.equal(Object.values(loaded.state.floorLinks ?? {}).filter((l) => l.kind === "opening").length, 2);
  });

  test("a room saved at 48 commits its next batch with no snapshot", async () => {
    const { roomId, dm, ground, upper, base } = await savedAt47("Fence once");
    const s = await t.connect(roomId, dm);
    await s.snapshot("fence-2");
    await ok(s, opening(upper, ground));
    const first = await stored(roomId, base);
    await ok(s, { t: "log.chat", text: "after the fence" });
    const second = await stored(roomId, base);
    assert.equal(second.snapshot.seq, first.snapshot.seq, "the snapshot stays the fence's");
    assert.equal(second.ops.length, 2);
    s.close();
    await s.waitClosed();
  });

  test("a snapshot build that fails holds the batch, which commits with the snapshot once a build succeeds", async () => {
    const { roomId, dm, ground, upper, base } = await savedAt47("Fence build");
    const s = await t.connect(roomId, dm);
    await s.snapshot("fence-3");
    builds = 0;
    failingBuilds = 2;
    await ok(s, opening(upper, ground));
    assert.equal(failingBuilds, 0);
    assert.equal(builds, 3, "built until one succeeded");
    const after = await stored(roomId, base);
    assert.deepEqual(after.ops.map((o) => o.t), ["floorLink.put"], "stored once");
    assert.deepEqual([after.snapshot.schema_version, after.snapshot.seq], [SNAPSHOT_VERSION, after.ops[0]!.seq]);
    s.close();
    await s.waitClosed();
  });

  for (const mode of ["before", "rolledBack"] as const) {
    test(`a commit that fails ${mode === "before" ? "before COMMIT" : "at COMMIT"} is tried again with the same snapshot, stored once with its batch`, async () => {
      const { roomId, dm, ground, upper, base } = await savedAt47(`Fence ${mode}`);
      const s = await t.connect(roomId, dm);
      await s.snapshot("fence-4");
      builds = 0;
      const failing = failCommits(t.pool, [mode]);
      try {
        await ok(s, opening(upper, ground));
        assert.equal(failing.remaining(), 0, "the commit failed once");
      } finally {
        failing.restore();
      }
      assert.equal(builds, 1, "built once, sent again as built");
      const after = await stored(roomId, base);
      assert.deepEqual(after.ops.map((o) => o.t), ["floorLink.put"]);
      assert.deepEqual([after.snapshot.schema_version, after.snapshot.seq], [SNAPSHOT_VERSION, after.ops[0]!.seq]);
      s.close();
      await s.waitClosed();
    });
  }
});
