import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { referencedAssetIds } from "#shared/referencedAssets.ts";
import { ActorClosedError } from "./actor.ts";
import { failCommits, startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * The deletion barrier (docs/design-v1-dm-tools.md 3.19), the restore check
 * for deleted images (section 2.6), and the room manager's lock and pin,
 * against the real server and Postgres. The deletion here is the shape
 * cleanup's step takes: rows the committed state does not name, in one
 * statement.
 */

function tokenOp(sceneId: string, assetId: string): Extract<Op, { t: "token.create" }> {
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
  } as Extract<Op, { t: "token.create" }>;
}

async function addAsset(pool: pg.Pool, roomId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants)
     values ($1, $2, $3, 'token', 1, 100, 100, 10, array['full'])`,
    [id, roomId, randomBytes(32)],
  );
  return id;
}

async function assetExists(pool: pg.Pool, id: string): Promise<boolean> {
  return ((await pool.query("select 1 from assets where id = $1", [id])).rowCount ?? 0) > 0;
}

/** Cleanup's statement in miniature: the requested rows the committed state does not name. */
function deleteUnused(pool: pg.Pool, roomId: string, ids: string[]) {
  return async (state: RoomState) => {
    const used = referencedAssetIds(state);
    const { rows } = await pool.query<{ id: string }>("delete from assets where room_id = $1 and id = any($2::uuid[]) returning id", [
      roomId,
      ids.filter((id) => !used.has(id)),
    ]);
    return { deleted: rows.map((r) => r.id), result: rows.length };
  };
}

/**
 * Holds every asset facts read after Postgres answered and before the actor
 * sees it, so the read is stale by the time its op reaches the queue.
 */
function stallAssetReads(pool: pg.Pool): { started: Promise<void>; release: () => void; restore: () => void } {
  const original = pool.query.bind(pool) as (...args: unknown[]) => Promise<pg.QueryResult>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const seen = new Promise<void>((resolve) => (started = resolve));
  (pool as { query: unknown }).query = async (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : "";
    const result = await original(...args);
    if (text.includes("from assets a where a.id = any")) {
      started();
      await gate;
    }
    return result;
  };
  return { started: seen, release, restore: () => ((pool as { query: unknown }).query = original) };
}

describe("the deletion barrier", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { actor: { batchMs: 10, retryBaseMs: 20, retryMaxMs: 40 } } });
  });
  after(() => t.close());

  async function room(): Promise<{ roomId: string; sceneId: string; socket: Socket; dm: ReturnType<Engine["client"]> }> {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Barrier");
    const socket = await t.connect(roomId, dm);
    const snap = await socket.snapshot("dm");
    return { roomId, sceneId: (snap.state as { meta: { playerSceneId: string } }).meta.playerSceneId, socket, dm };
  }

  test("a staged removal whose commit fails holds the step, and a shutdown that abandons it deletes nothing", async () => {
    const { roomId, sceneId, socket } = await room();
    const asset = await addAsset(t.pool, roomId);
    const create = tokenOp(sceneId, asset);
    assert.equal((await socket.apply(create)).rejects, undefined);
    const actor = t.manager.get(roomId)!;

    const failing = failCommits(t.pool, Array.from({ length: 1000 }, () => "before" as const));
    socket.op({ t: "token.delete", tokenId: create.token.id });
    while (!actor.retrying) await new Promise((r) => setTimeout(r, 10));
    let ran = false;
    const step = actor.deletionStep(async (state) => {
      ran = true;
      return deleteUnused(t.pool, roomId, [asset])(state);
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ran, false, "the step waits while the commit is retried");
    const unloading = t.manager.unload(roomId);
    await assert.rejects(step, ActorClosedError);
    await unloading;
    failing.restore();
    assert.equal(ran, false);
    assert.ok(await assetExists(t.pool, asset), "the image is kept");
  });

  test("a staged removal that commits is flushed first, and the step then sees the image unused", async () => {
    const { roomId, sceneId, socket } = await room();
    const asset = await addAsset(t.pool, roomId);
    const create = tokenOp(sceneId, asset);
    await socket.apply(create);
    const actor = t.manager.get(roomId)!;
    const failing = failCommits(t.pool, ["before", "before"]);
    socket.op({ t: "token.delete", tokenId: create.token.id });
    while (!actor.retrying) await new Promise((r) => setTimeout(r, 5));
    const deleted = await actor.deletionStep(deleteUnused(t.pool, roomId, [asset]));
    failing.restore();
    assert.equal(deleted, 1);
    assert.equal(actor.committed.state.tokens[create.token.id], undefined);
  });

  test("a stalled lookup with no room op between is answered gone, with no reference stored", async () => {
    const { roomId, sceneId, socket } = await room();
    const asset = await addAsset(t.pool, roomId);
    const actor = t.manager.get(roomId)!;
    const stall = stallAssetReads(t.pool);
    const create = tokenOp(sceneId, asset);
    const n = socket.op(create);
    await stall.started;
    stall.restore();
    assert.equal(await actor.deletionStep(deleteUnused(t.pool, roomId, [asset])), 1);
    assert.equal(actor.deletionRecordSize, 1);
    stall.release();
    const ev = await socket.next("ev", (m) => m.rejects?.some((r) => r.n === n) ?? false);
    assert.equal(ev.rejects?.[0]?.code, "gone");
    assert.equal(actor.committed.state.tokens[create.token.id], undefined);
    assert.equal(actor.deletionRecordSize, 0, "the record lets go once the lookup is done");
  });

  test("a lookup stalled past further deletions and an empty queue still finds its deletion recorded", async () => {
    const { roomId, sceneId, socket, dm } = await room();
    const asset = await addAsset(t.pool, roomId);
    const actor = t.manager.get(roomId)!;
    const stall = stallAssetReads(t.pool);
    const create = tokenOp(sceneId, asset);
    const n = socket.op(create);
    await stall.started;
    stall.restore();
    await actor.deletionStep(deleteUnused(t.pool, roomId, [asset]));
    // A socket's messages wait in order behind its stalled op, so the room's other ops come from a second device.
    const other = await t.connect(roomId, dm);
    await other.snapshot("dm-2");
    for (let i = 0; i < 3; i++) {
      const unrelated = await addAsset(t.pool, roomId);
      await actor.deletionStep(deleteUnused(t.pool, roomId, [unrelated]));
      assert.equal((await other.apply({ t: "room.update", name: `Barrier ${i}` })).rejects, undefined);
    }
    assert.equal(actor.queueLength, 0);
    assert.equal(actor.deletionRecordSize, 1);
    stall.release();
    const ev = await socket.next("ev", (m) => m.rejects?.some((r) => r.n === n) ?? false);
    assert.equal(ev.rejects?.[0]?.code, "gone");
  });

  test("the record holds no more than the ids the outstanding lookups read", async () => {
    const { roomId, sceneId, socket } = await room();
    const asset = await addAsset(t.pool, roomId);
    const actor = t.manager.get(roomId)!;
    const stall = stallAssetReads(t.pool);
    const n = socket.op(tokenOp(sceneId, asset));
    await stall.started;
    stall.restore();
    for (let i = 0; i < 10; i++) {
      const unrelated = [await addAsset(t.pool, roomId), await addAsset(t.pool, roomId)];
      assert.equal(await actor.deletionStep(deleteUnused(t.pool, roomId, unrelated)), 2);
      assert.equal(actor.deletionRecordSize, 0);
    }
    stall.release();
    const ev = await socket.next("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false));
    assert.ok(ev.acks?.includes(n), "the image it read was never deleted");
  });

  test("a step that throws at once lets the queue go on", async () => {
    const { roomId, socket } = await room();
    const actor = t.manager.get(roomId)!;
    const run = (() => {
      throw new Error("refused at once");
    }) as unknown as Parameters<typeof actor.deletionStep>[0];
    await assert.rejects(actor.deletionStep(run), /refused at once/);
    assert.equal((await socket.apply({ t: "room.update", name: "Still going" })).rejects, undefined);
  });

  test("an undo that would bring back a deleted image is refused, and one whose image remains goes through", async () => {
    const { roomId, sceneId, socket } = await room();
    const [first, second, kept] = [await addAsset(t.pool, roomId), await addAsset(t.pool, roomId), await addAsset(t.pool, roomId)];
    const create = tokenOp(sceneId, first);
    await socket.apply(create);
    const tokenId = create.token.id;
    await socket.apply({ t: "token.update", tokenId, patch: { image: { assetId: second, crop: { cx: 0.5, cy: 0.5, zoom: 1 } } } });
    const actor = t.manager.get(roomId)!;
    assert.equal(await actor.deletionStep(deleteUnused(t.pool, roomId, [first])), 1);
    const undo = await socket.apply({ t: "undo" });
    assert.equal(undo.rejects?.[0]?.code, "gone");
    assert.match(undo.rejects?.[0]?.message ?? "", /^could not undo .*: its image was deleted since$/);
    assert.equal((actor.committed.state.tokens[tokenId]?.image as { assetId: string }).assetId, second);

    await socket.apply({ t: "token.update", tokenId, patch: { image: { assetId: kept, crop: { cx: 0.5, cy: 0.5, zoom: 1 } } } });
    const ok = await socket.apply({ t: "undo" });
    assert.equal(ok.rejects, undefined);
    assert.equal((actor.committed.state.tokens[tokenId]?.image as { assetId: string }).assetId, second);
    // And redo puts the image that remains back.
    const redo = await socket.apply({ t: "redo" });
    assert.equal(redo.rejects, undefined);
    assert.equal((actor.committed.state.tokens[tokenId]?.image as { assetId: string }).assetId, kept);
  });
});

describe("the room manager's lock and pin", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a deletion step on a room not loaded holds off its load, and one on a loaded room runs on its queue", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Lock");
    await t.manager.unload(roomId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const step = t.manager.deletionStep(roomId, {
      loaded: async () => {
        throw new Error("the room was not loaded");
      },
      unloaded: async () => {
        order.push("step");
        await held;
        order.push("step done");
        return "unloaded";
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const loading = t.manager.acquire(roomId).then((actor) => {
      order.push("loaded");
      return actor;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(order, ["step"]);
    release();
    assert.equal(await step, "unloaded");
    const actor = await loading;
    assert.deepEqual(order, ["step", "step done", "loaded"]);

    const loaded = await t.manager.deletionStep(roomId, {
      loaded: async (state, seq) => ({ deleted: [], result: `loaded at ${seq} with ${Object.keys(state.members).length} member` }),
      unloaded: async () => "unloaded",
    });
    assert.equal(loaded, `loaded at ${actor.committed.seq} with 1 member`);
  });

  test("setPinned updates the row and the loaded room at once", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Pin");
    const actor = await t.manager.acquire(roomId);
    assert.equal(actor.pinned, false);
    assert.equal(await t.manager.setPinned(roomId, true), true);
    assert.equal(actor.pinned, true);
    assert.equal((await t.pool.query<{ pinned: boolean }>("select pinned from rooms where id = $1", [roomId])).rows[0]?.pinned, true);
    await t.manager.unload(roomId);
    assert.equal(await t.manager.setPinned(roomId, false), true);
    assert.equal((await t.manager.acquire(roomId)).pinned, false);
    assert.equal(await t.manager.setPinned("ZZZZZZZZ", true), false);
  });
});
