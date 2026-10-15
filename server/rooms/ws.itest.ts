import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { sha256 } from "../auth/tokens.ts";
import { failCommits, startEngine, type Engine } from "./testing.ts";

/**
 * The WebSocket flows of design section 18, against the real server on an
 * ephemeral port and the development Postgres.
 */
function tokenOp(sceneId: string, overrides: Record<string, unknown> = {}): Op {
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
      ...overrides,
    },
  } as Op;
}

function sceneOf(state: ProjectedState): string {
  return state.meta.playerSceneId ?? Object.keys(state.scenes)[0] ?? "";
}

describe("websocket: hello, ops and acks", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { actor: { batchMs: 20 } } });
  });
  after(() => t.close());

  test("hello gets a snapshot, an op is acked by the batch ev that carries its change", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Sync");
    const s = await t.connect(roomId, dm);
    const snap = await s.snapshot("c1");
    assert.equal(snap.seq, 0);
    assert.equal(snap.watermark, 0);
    assert.equal(snap.you.role, "dm");
    const state = snap.state as ProjectedState;
    assert.equal(Object.keys(state.scenes).length, 1);
    assert.equal((await s.next("presence")).online.length, 1);

    const op = tokenOp(sceneOf(state));
    const n = s.op(op);
    const ev = await s.next("ev");
    assert.deepEqual(ev.acks, [n]);
    assert.equal(ev.seq, 1);
    const upsert = ev.changes.find((c) => c.key === `token:${(op as { token: { id: string } }).token.id}`);
    assert.ok(upsert && "value" in upsert);

    const { rows } = await t.pool.query("select seq, op from room_ops where room_id = $1 order by seq", [roomId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op.t, "token.create");
    const wm = await t.pool.query<{ n: string }>("select n::text from client_watermarks where room_id = $1 and client_id = 'c1'", [roomId]);
    assert.equal(wm.rows[0]?.n, "1");
    s.close();
  });

  test("several relative ops from one client in one batch are applied once each, in one ev", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Damage");
    const s = await t.connect(roomId, dm);
    const snap = await s.snapshot("c1");
    const op = tokenOp(sceneOf(snap.state as ProjectedState), { actor: { inline: { ...(tokenOp("x") as { token: { actor: { inline: object } } }).token.actor.inline, hp: { cur: 30, max: 30, temp: 0 } } } });
    const tokenId = (op as { token: { id: string } }).token.id;
    await s.apply(op);
    const ns = [1, 2, 3].map(() => s.op({ t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 7 } }));
    const ev = await s.next("ev", (m) => (m.acks?.length ?? 0) > 0);
    assert.deepEqual(ev.acks, ns);
    const change = ev.changes.find((c) => c.key === `token:${tokenId}`);
    assert.ok(change && "value" in change);
    assert.equal((change.value as { actor: { inline: { hp: { cur: number } } } }).actor.inline.hp.cur, 9);
    s.close();
  });

  test("a malformed op is refused with invalid only when it is next in sequence, and the refusal is durable first", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Refusals");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    // n = 2 before n = 1: a gap, whatever the payload. It cannot consume n = 2.
    s.send({ t: "op", n: 2, op: { t: "nonsense" } });
    const gap = await s.next("retry");
    assert.deepEqual(gap, { t: "retry", n: 2, code: "gap" });
    s.send({ t: "op", n: 1, op: { t: "nonsense" } });
    const ev = await s.next("ev", (m) => (m.rejects?.length ?? 0) > 0);
    assert.equal(ev.rejects?.[0]?.n, 1);
    assert.equal(ev.rejects?.[0]?.code, "invalid");
    const wm = await t.pool.query<{ n: string }>("select n::text from client_watermarks where room_id = $1 and client_id = 'c1'", [roomId]);
    assert.equal(wm.rows[0]?.n, "1");
    // The op after it continues at 2.
    s.n = 1;
    const n = s.op({ t: "log.chat", text: "hi" });
    assert.equal(n, 2);
    const ok = await s.next("ev", (m) => m.acks?.includes(2) ?? false);
    assert.ok(ok.changes.some((c) => c.key.startsWith("log:")));
    s.close();
  });

  test("a duplicate of a committed op is acked at once with an empty ev", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Dup");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const n = s.op({ t: "log.chat", text: "once" });
    await s.next("ev", (m) => m.acks?.includes(n) ?? false);
    s.op({ t: "log.chat", text: "once" }, n);
    const again = await s.next("ev");
    assert.deepEqual(again, { t: "ev", seq: 1, changes: [], acks: [n] });
    const { rows } = await t.pool.query("select count(*)::int as n from room_ops where room_id = $1", [roomId]);
    assert.equal(rows[0].n, 1);
    s.close();
  });

  test("a bad envelope, a message before hello or a second hello closes the socket with 4003", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Strict");
    const early = await t.connect(roomId, dm);
    early.send({ t: "op", n: 1, op: { t: "log.chat", text: "x" } });
    assert.equal((await early.waitClosed()).code, 4003);
    const twice = await t.connect(roomId, dm);
    await twice.snapshot("c1");
    twice.hello("c1");
    assert.equal((await twice.waitClosed()).code, 4003);
    const junk = await t.connect(roomId, dm);
    await junk.snapshot("c2");
    junk.send({ t: "op", n: 0, op: {} });
    assert.equal((await junk.waitClosed()).code, 4003);
    const binary = await t.connect(roomId, dm);
    await binary.snapshot("c3");
    binary.sendRaw(Buffer.from([1, 2, 3]));
    assert.equal((await binary.waitClosed()).code, 4003);
  });

  test("the upgrade needs the exact origin, a session and a grant", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Upgrade");
    const stranger = t.client();
    await assert.rejects(t.connect(roomId, stranger), /403/);
    await assert.rejects(t.connect("ZZZZZZZZ", dm), /403|404/);
    const { Socket } = await import("./testing.ts");
    await assert.rejects(Socket.open(`${t.url}/ws?room=${roomId}`, { origin: "https://evil.example", cookie: `rvtt=${dm.token}` }), /403/);
  });

  test("the DM devices list shows a device online while its socket is open, and stamps when it was last seen as it closes", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Devices");
    const hash = sha256(dm.token ?? "");
    const devices = async () => (await dm.get(`/api/rooms/${roomId}/dm/devices`)).json<{ devices: Array<{ online: boolean }> }>().devices;
    assert.equal((await devices())[0]?.online, false);
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    assert.equal((await devices())[0]?.online, true);
    // Read straight from the table: an HTTP request would stamp the session itself.
    await t.pool.query("update sessions set last_seen_at = now() - interval '1 hour' where token_hash = $1", [hash]);
    const fresh = async () =>
      (await t.pool.query<{ fresh: boolean }>("select last_seen_at > now() - interval '1 minute' as fresh from sessions where token_hash = $1", [hash])).rows[0]?.fresh;
    assert.equal(await fresh(), false);
    s.close();
    for (let i = 0; i < 100 && !(await fresh()); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(await fresh(), true, "last seen is the moment the socket closed");
    assert.equal((await devices())[0]?.online, false);
  });

  test("app-level ping is answered", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Ping");
    const s = await t.connect(roomId, dm);
    s.send({ t: "ping", k: 7 });
    assert.deepEqual(await s.next("pong"), { t: "pong", k: 7 });
    s.close();
  });
});

describe("websocket: reconnects and watermarks", () => {
  let t: Engine;
  before(async () => {
    // A long batch window makes "still staged" a state a test can land in.
    t = await startEngine({ rooms: { actor: { batchMs: 400 } } });
  });
  after(() => t.close());

  test("a duplicate of a staged op is acked only after the commit, on the client's new socket", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Staged");
    const a = await t.connect(roomId, dm);
    await a.snapshot("c1");
    const n = a.op({ t: "log.chat", text: "first" });
    // The batch is open for 400 ms. Reconnect as the same client meanwhile.
    const b = await t.connect(roomId, dm);
    const snap = await b.snapshot("c1", n);
    assert.equal(snap.watermark, 0);
    b.op({ t: "log.chat", text: "first" }, n);
    assert.equal(await b.maybe("ev", () => true, 150), null);
    const ev = await b.next("ev", (m) => m.acks?.includes(n) ?? false);
    assert.ok(ev.changes.some((c) => c.key.startsWith("log:")));
    // The old socket sees the change but never that client's ack.
    const old = await a.next("ev");
    assert.equal(old.acks, undefined);
    const { rows } = await t.pool.query("select count(*)::int as n from room_ops where room_id = $1", [roomId]);
    assert.equal(rows[0].n, 1);
    a.close();
    b.close();
  });

  test("resumeFrom raises the watermark through a batch, so a client stranded by an uncommitted refusal is never stuck", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Stranded");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    // The refusal is staged but the batch never commits: the room dies first.
    s.send({ t: "op", n: 1, op: { t: "nonsense" } });
    await new Promise((r) => setTimeout(r, 50));
    await t.manager.unload(roomId, 4010, false);
    assert.equal((await s.waitClosed()).code, 4010);
    const stored = await t.pool.query("select 1 from client_watermarks where room_id = $1", [roomId]);
    assert.equal(stored.rowCount, 0);

    // The client dropped the op and tells the server 1 is settled.
    const again = await t.connect(roomId, dm);
    const snap = await again.snapshot("c1", 2);
    assert.equal(snap.watermark, 1);
    const wm = await t.pool.query<{ n: string }>("select n::text from client_watermarks where room_id = $1 and client_id = 'c1'", [roomId]);
    assert.equal(wm.rows[0]?.n, "1");
    again.n = 1;
    const n = again.op({ t: "log.chat", text: "after" });
    assert.equal(n, 2);
    await again.next("ev", (m) => m.acks?.includes(2) ?? false);
    again.close();
  });

  test("a client that still holds the refused op resends it and gets the refusal", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Resend");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    s.send({ t: "op", n: 1, op: { t: "nonsense" } });
    await new Promise((r) => setTimeout(r, 50));
    await t.manager.unload(roomId, 4010, false);
    await s.waitClosed();
    const again = await t.connect(roomId, dm);
    const snap = await again.snapshot("c1", 1);
    assert.equal(snap.watermark, 0);
    again.send({ t: "op", n: 1, op: { t: "nonsense" } });
    const ev = await again.next("ev", (m) => (m.rejects?.length ?? 0) > 0);
    assert.equal(ev.rejects?.[0]?.n, 1);
    again.close();
  });

  test("watermark dedupe after a long suspension: the room unloaded and reloaded in between", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Suspend");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    for (let i = 0; i < 3; i++) await s.apply({ t: "log.chat", text: `m${i}` });
    s.close();
    await s.waitClosed();
    await t.manager.unload(roomId);
    assert.equal(t.manager.get(roomId), null);

    const back = await t.connect(roomId, dm);
    // The phone still thinks 2 and 3 are pending.
    const snap = await back.snapshot("c1", 2);
    assert.equal(snap.watermark, 3);
    assert.equal((snap.state as ProjectedState).log.length, 3);
    back.op({ t: "log.chat", text: "m1" }, 2);
    assert.deepEqual(await back.next("ev"), { t: "ev", seq: 3, changes: [], acks: [2] });
    back.n = 3;
    await back.apply({ t: "log.chat", text: "m3" });
    const { rows } = await t.pool.query("select count(*)::int as n from room_ops where room_id = $1", [roomId]);
    assert.equal(rows[0].n, 4);
    back.close();
  });
});

describe("websocket: commit failures", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { actor: { batchMs: 20, retryBaseMs: 100, retryMaxMs: 200, queueCap: 3 } } });
  });
  after(() => t.close());

  test("a clean failure retries, reports degraded meanwhile, and publishes once", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Clean");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const flaky = failCommits(t.pool, ["before", "before"]);
    try {
      const n = s.op({ t: "log.chat", text: "retry me" });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(t.manager.degraded(), true);
      assert.deepEqual((await t.app.inject({ method: "GET", url: "/healthz" })).json(), { status: "degraded" });
      const ev = await s.next("ev", (m) => m.acks?.includes(n) ?? false);
      assert.equal(ev.seq, 1);
      assert.equal(flaky.remaining(), 0);
      assert.equal(t.manager.degraded(), false);
      assert.equal(await s.maybe("ev", () => true, 200), null);
      const { rows } = await t.pool.query("select count(*)::int as n from room_ops where room_id = $1", [roomId]);
      assert.equal(rows[0].n, 1);
    } finally {
      flaky.restore();
    }
    s.close();
  });

  test("an unknown outcome is resolved by reading back: committed is published, rolled back is retried", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Unknown");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const flaky = failCommits(t.pool, ["committed"]);
    try {
      const ev = await s.apply({ t: "log.chat", text: "lost answer" });
      assert.equal(ev.seq, 1);
      assert.equal(flaky.remaining(), 0);
    } finally {
      flaky.restore();
    }
    const flaky2 = failCommits(t.pool, ["rolledBack"]);
    try {
      const ev = await s.apply({ t: "log.chat", text: "dropped" });
      assert.equal(ev.seq, 2);
      assert.equal(flaky2.remaining(), 0);
    } finally {
      flaky2.restore();
    }
    const { rows } = await t.pool.query("select seq::int from room_ops where room_id = $1 order by seq", [roomId]);
    assert.deepEqual(
      rows.map((r) => r.seq),
      [1, 2],
    );
    s.close();
  });

  test("a rename reaches the rooms row with its batch, through a dropped commit, and other updates leave the name alone", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Old name");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const nameRow = async (): Promise<string | undefined> =>
      (await t.pool.query<{ name: string }>("select name from rooms where id = $1", [roomId])).rows[0]?.name;

    // The rolled back COMMIT throws the rename away with the ops, and the retry writes both.
    const flaky = failCommits(t.pool, ["rolledBack"]);
    try {
      const ev = await s.apply({ t: "room.update", name: "New name" });
      assert.equal(ev.rejects, undefined);
      assert.equal(flaky.remaining(), 0);
    } finally {
      flaky.restore();
    }
    assert.equal(await nameRow(), "New name");
    assert.equal((await dm.get(`/api/rooms/${roomId}`)).json<{ name: string }>().name, "New name");

    await s.apply({ t: "room.update", settings: { feetPerCell: 10 } });
    assert.equal(await nameRow(), "New name");

    // Deleting the room confirms against the row, so only the new name works.
    assert.equal((await dm.delete(`/api/rooms/${roomId}`, { name: "Old name" })).statusCode, 400);
    s.close();
  });

  test("a batch that holds only a watermark update survives a lost commit answer", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Watermark only");
    const flaky = failCommits(t.pool, ["committed"]);
    try {
      const s = await t.connect(roomId, dm);
      const snap = await s.snapshot("c1", 6);
      assert.equal(snap.watermark, 5);
      assert.equal(flaky.remaining(), 0);
      const wm = await t.pool.query<{ n: string }>("select n::text from client_watermarks where room_id = $1 and client_id = 'c1'", [roomId]);
      assert.equal(wm.rows[0]?.n, "5");
      s.close();
    } finally {
      flaky.restore();
    }
  });

  test("the queue cap answers busy while a commit is retrying", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Cap");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const flaky = failCommits(t.pool, ["before", "before", "before"]);
    try {
      const first = s.op({ t: "log.chat", text: "a" });
      await new Promise((r) => setTimeout(r, 40));
      const ns = [1, 2, 3, 4, 5].map(() => s.op({ t: "log.chat", text: "queued" }));
      const busy = await s.next("retry", (m) => m.code === "busy");
      assert.ok(ns.includes(busy.n ?? -1));
      await s.next("ev", (m) => m.acks?.includes(first) ?? false);
    } finally {
      flaky.restore();
    }
    s.close();
  });
});

describe("websocket: rates", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a burst over the op rate gets busy, then gap for everything behind the refused op", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Burst");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    for (let i = 0; i < 80; i++) s.op({ t: "log.chat", text: `b${i}` });
    const busy = await s.next("retry", (m) => m.code === "busy");
    assert.equal(busy.n, 61);
    const gap = await s.next("retry", (m) => m.code === "gap");
    assert.equal(gap.n, 62);
    s.close();
  });

  test("frames over the frame budget are dropped before parsing, and sustained abuse closes with 4008", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Frames");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    // 300 pings at once: 200 pass (the burst), the rest are dropped unparsed, not punished.
    for (let i = 0; i < 300; i++) s.send({ t: "ping", k: i });
    let pongs = 0;
    while (await s.maybe("pong", () => true, 200)) pongs++;
    // The burst plus whatever refilled while the frames were in flight.
    assert.ok(pongs >= 200 && pongs < 240, `pongs: ${pongs}`);
    assert.equal(s.closeCode, null);
    s.close();
  });
});

describe("websocket: the access signal", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a DM device added or signed out tells every DM socket, even when no member came or went, and never a player", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Devices");
    const player = t.client();
    await player.join(roomId, "Pip");
    const dmSocket = await t.connect(roomId, dm);
    const playerSocket = await t.connect(roomId, player);
    await dmSocket.snapshot("dm");
    await playerSocket.snapshot("player");
    const me = (await dm.me(roomId)).memberId!;

    // The same DM on a tablet: the member is online already, so presence says nothing new.
    const minted = await dm.post(`/api/rooms/${roomId}/dm/invite`);
    assert.equal(minted.statusCode, 201, minted.body);
    const tablet = t.client();
    const redeemed = await tablet.post(`/api/rooms/${roomId}/dm/redeem`, { token: minted.json<{ token: string }>().token, memberId: me });
    assert.equal(redeemed.statusCode, 200, redeemed.body);
    await dmSocket.next("access");

    const listed = await dm.get(`/api/rooms/${roomId}/dm/devices`);
    const other = listed.json<{ devices: { sessionId: string; current: boolean }[] }>().devices.find((d) => !d.current);
    assert.ok(other, "the tablet is listed");
    assert.equal((await dm.delete(`/api/rooms/${roomId}/dm/devices/${other.sessionId}`)).statusCode, 204);
    await dmSocket.next("access");

    assert.equal(await playerSocket.maybe("access"), null);
    dmSocket.close();
    playerSocket.close();
  });
});
