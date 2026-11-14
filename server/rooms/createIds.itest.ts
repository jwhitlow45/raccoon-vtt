import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ID_TIME_REFUSED, uuidv7 } from "#shared/ids.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { Connection } from "./connection.ts";
import { ID_TAKEN, SERVER_MEMBER } from "./createIds.ts";
import { commitBatch, loadReceipts } from "./persistence.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/*
 * The id record through the room and its table (createIds.ts): every id an
 * applied create brought has a row, written with its batch, which answers
 * `gone` to the id's reuse across a restart; a create refused after the
 * gate leaves none; a live id that is not version 7, or is dated outside the
 * clock's window, is refused with the words the device retries on; and a
 * device's ask after a reconnect reads its own member's rows alone.
 */

let t: Engine;

before(async () => {
  t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
});

after(async () => {
  await t.close();
});

type Room = { roomId: string; sceneId: string; dm: TestClient; ana: TestClient; anaId: string; bree: TestClient; breeId: string; dmSocket: Socket; anaSocket: Socket };

async function room(name: string): Promise<Room> {
  const dm = t.client();
  const { roomId } = await dm.createRoom(name);
  const ana = t.client();
  const anaId = await ana.join(roomId, "Ana");
  const bree = t.client();
  const breeId = await bree.join(roomId, "Bree");
  const dmSocket = await t.connect(roomId, dm);
  const sceneId = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
  const anaSocket = await t.connect(roomId, ana);
  await anaSocket.snapshot("ana");
  return { roomId, sceneId, dm, ana, anaId, bree, breeId, dmSocket, anaSocket };
}

function line(id: string, sceneId: string, ownerId: string) {
  return { t: "drawing.create", drawing: { id, sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId, visibility: "all" } };
}

/** The refusal an op met, or null when it was taken. */
async function answer(socket: Socket, op: Op | Record<string, unknown>): Promise<{ code: string; message: string } | null> {
  const n = socket.op(op);
  const ev = await socket.next("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false));
  const reject = ev.rejects?.find((r) => r.n === n);
  return reject ? { code: reject.code, message: reject.message } : null;
}

async function rows(roomId: string, id: string): Promise<{ member_id: string; until: Date; ask_until: Date; accepted_at: Date }[]> {
  const { rows } = await t.pool.query<{ member_id: string; until: Date; ask_until: Date; accepted_at: Date }>("select member_id, until, ask_until, accepted_at from room_ids where room_id = $1 and id = $2", [roomId, id]);
  return rows;
}

describe("the id record through the room", () => {
  test("a create's id has its member's row, and answers gone once its thing is deleted, across a restart", async () => {
    const r = await room("Ids gone");
    const id = uuidv7();
    assert.equal(await answer(r.anaSocket, line(id, r.sceneId, r.anaId)), null);
    const [row] = await rows(r.roomId, id);
    assert.equal(row?.member_id, r.anaId);
    assert.ok(row!.until.getTime() - row!.accepted_at.getTime() >= 30 * 60_000, "read for the clock's whole window");
    assert.equal(row!.ask_until.getTime() - row!.accepted_at.getTime(), 12 * 60 * 60_000);
    assert.equal(await answer(r.anaSocket, { t: "drawing.delete", drawingId: id }), null);
    assert.deepEqual(await answer(r.anaSocket, line(id, r.sceneId, r.anaId)), { code: "gone", message: ID_TAKEN });
    await t.restart();
    const again = await t.connect(r.roomId, r.ana);
    await again.snapshot("ana-after");
    assert.deepEqual(await answer(again, line(id, r.sceneId, r.anaId)), { code: "gone", message: ID_TAKEN }, "the table outlives the restart");
    const dm = await t.connect(r.roomId, r.dm);
    await dm.snapshot("dm-after");
    assert.deepEqual(await answer(dm, line(id, r.sceneId, (await r.dm.me(r.roomId)).memberId!)), { code: "gone", message: ID_TAKEN }, "the DM's too");
  });

  test("a create the gate passed and a permission then refused writes no row, so its id is still free", async () => {
    const r = await room("Ids refused");
    const id = uuidv7();
    const refused = await answer(r.anaSocket, line(id, r.sceneId, r.breeId));
    assert.ok(refused !== null && refused.code !== "gone", "a drawing in another member's name is refused by permissions");
    assert.deepEqual(await rows(r.roomId, id), []);
    assert.equal(await answer(r.anaSocket, line(id, r.sceneId, r.anaId)), null);
    assert.equal((await rows(r.roomId, id)).length, 1);
  });

  test("a live id that is not version 7, or is dated outside the clock's window, is refused with the words the device retries on", async () => {
    const r = await room("Ids clock");
    for (const id of [crypto.randomUUID(), uuidv7(Date.now() - 31 * 60_000), uuidv7(Date.now() + 60_000)]) {
      assert.deepEqual(await answer(r.anaSocket, line(id, r.sceneId, r.anaId)), { code: "invalid", message: ID_TIME_REFUSED }, id);
      assert.deepEqual(await rows(r.roomId, id), []);
    }
  });

  test("a device's ask reads its own member's rows: held, not held, and pending while its old socket is open", async () => {
    const r = await room("Ids ask");
    const landed = uuidv7();
    assert.equal(await answer(r.anaSocket, line(landed, r.sceneId, r.anaId)), null);
    const lost = uuidv7();
    const actor = t.manager.get(r.roomId)!;
    const device = { sessionId: uuidv7(), clientId: uuidv7() };
    const open = async (memberId: string): Promise<{ conn: Connection; sent: ServerMessage[] }> => {
      const sent: ServerMessage[] = [];
      const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
      const conn = new Connection(socket as never, { sessionId: device.sessionId, roomId: r.roomId, memberId, role: "player" }, "203.0.113.9");
      assert.ok(actor.attach(conn));
      await actor.hello(conn, { clientId: device.clientId, resumeFrom: 1 });
      return { conn, sent };
    };
    const ask = async (memberId: string, ids: string[], old?: Connection): Promise<Extract<ServerMessage, { t: "ids" }>> => {
      const { conn, sent } = await open(memberId);
      actor.ids(conn, { k: 7, ids });
      for (let i = 0; i < 400 && !sent.some((m) => m.t === "ids"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      actor.detach(conn);
      if (old) assert.equal(old.closed, false);
      const reply = sent.find((m): m is Extract<ServerMessage, { t: "ids" }> => m.t === "ids");
      assert.ok(reply, "answered");
      return reply;
    };
    assert.deepEqual(await ask(r.anaId, [landed, lost]), { t: "ids", k: 7, held: [landed], notHeld: [lost], pending: [] });
    assert.deepEqual(await ask(r.breeId, [landed]), { t: "ids", k: 7, held: [], notHeld: [landed], pending: [] }, "another member's id reads as not theirs");
    // The device's old socket is still open, so an op it sent may still come.
    const old = await open(r.anaId);
    assert.deepEqual(await ask(r.anaId, [landed, lost], old.conn), { t: "ids", k: 7, held: [], notHeld: [], pending: [landed, lost] });
    actor.detach(old.conn);
    assert.deepEqual(await ask(r.anaId, [landed, lost]), { t: "ids", k: 7, held: [landed], notHeld: [lost], pending: [] }, "final once it is gone");
  });

  test("while a batch holds an op of the member, every id answers pending, and once it commits the id is held", async () => {
    const r = await room("Ids staged");
    const actor = t.manager.get(r.roomId)!;
    const sent: ServerMessage[] = [];
    const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
    const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: r.roomId, memberId: r.anaId, role: "player" }, "203.0.113.9");
    assert.ok(actor.attach(conn));
    await actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
    for (let i = 0; i < 400 && !sent.some((m) => m.t === "snapshot"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const id = uuidv7();
    // The op and the ask share the queue's turn, so the ask finds the op's batch staged and not yet committed.
    void actor.op(conn, 1, line(id, r.sceneId, r.anaId));
    actor.ids(conn, { k: 1, ids: [id] });
    const reply = async (k: number) => {
      for (let i = 0; i < 400 && !sent.some((m) => m.t === "ids" && m.k === k); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      return sent.find((m) => m.t === "ids" && m.k === k);
    };
    assert.deepEqual(await reply(1), { t: "ids", k: 1, held: [], notHeld: [], pending: [id] });
    for (let i = 0; i < 400 && !sent.some((m) => m.t === "ev" && (m.acks ?? []).includes(1)); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    actor.ids(conn, { k: 2, ids: [id] });
    assert.deepEqual(await reply(2), { t: "ids", k: 2, held: [id], notHeld: [], pending: [] });
    actor.detach(conn);
  });

  test("a room's first load on this build gives the ids its state holds rows, the server's own", async () => {
    const r = await room("Ids seeded");
    const id = uuidv7();
    assert.equal(await answer(r.anaSocket, line(id, r.sceneId, r.anaId)), null);
    await t.restart();
    // As an older build left it: a snapshot of the format before, and no rows.
    await t.pool.query("delete from room_ids where room_id = $1", [r.roomId]);
    await t.pool.query("update room_snapshots set schema_version = 46 where room_id = $1", [r.roomId]);
    const ana = await t.connect(r.roomId, r.ana);
    await ana.snapshot("ana-after");
    assert.deepEqual((await rows(r.roomId, id)).map((row) => row.member_id), [SERVER_MEMBER]);
    assert.equal(await answer(ana, { t: "drawing.delete", drawingId: id }), null);
    assert.deepEqual(await answer(ana, line(id, r.sceneId, r.anaId)), { code: "gone", message: ID_TAKEN });
  });
});

describe("a roll's receipt taken by an ask", () => {
  test("is written with the ask's batch, after a roll settled in the same batch, and read back at load", async () => {
    const r = await room("Ids takes");
    const at = new Date().toISOString();
    const roll = { memberId: r.anaId, tag: uuidv7(), part: 0, state: "committed" as const, seq: 1, code: null, message: null, at };
    await commitBatch(t.pool, r.roomId, { ops: [], watermarks: [], receipts: [roll], takes: [{ memberId: r.anaId, tag: roll.tag, part: 0, ask: "ask-1" }] });
    const loaded = await loadReceipts(t.pool, r.roomId, new Date(Date.now() - 60_000));
    assert.equal(loaded.find((x) => x.tag === roll.tag)?.ask, "ask-1");
    // A tag used again past its day replaces its row, and the new receipt is free.
    await commitBatch(t.pool, r.roomId, { ops: [], watermarks: [], receipts: [{ ...roll, seq: 2 }] });
    const again = await loadReceipts(t.pool, r.roomId, new Date(Date.now() - 60_000));
    assert.equal(again.find((x) => x.tag === roll.tag)?.ask, undefined);
  });
});
