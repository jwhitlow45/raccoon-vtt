import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { z } from "zod";
import { uuidv7 } from "#shared/ids.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { character, companionBlock, customMonster, token } from "#shared/testutil.ts";
import { MAX_KEPT_REFUSALS, serverMessageSchema, type Op, type ServerMessage } from "#shared/protocol.ts";
import { TEST_DATABASE_URL } from "../auth/testing.ts";
import { sha256 } from "../auth/tokens.ts";
import { ViewBusyError, type RoomActor } from "./actor.ts";
import { failCommits, numberOf, Socket, startEngine, type Engine } from "./testing.ts";
import { MAX_PENDING_BATCHES } from "./actor.ts";

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

/**
 * Until `done` holds, within a deadline of real time that only a hang outlasts. What a test waits on is an event of the
 * server, which a loaded machine delays, so neither a sleep nor a count of turns bounds it.
 */
async function until(done: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
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
    const pin = numberOf();
    pin(snap.seq, 0, "the snapshot's number");
    assert.equal(snap.watermark, 0);
    assert.equal(snap.you.role, "dm");
    const state = snap.state as ProjectedState;
    assert.equal(Object.keys(state.scenes).length, 1);
    assert.equal((await s.next("presence")).online.length, 1);

    const op = tokenOp(sceneOf(state));
    const n = s.op(op);
    const ev = await s.next("ev");
    assert.deepEqual(ev.acks, [n]);
    pin(ev.seq, 1, "the frame's number");
    const upsert = ev.changes.find((c) => c.key === `token:${(op as { token: { id: string } }).token.id}`);
    assert.ok(upsert && "value" in upsert);

    // The party sees the new creature, so the batch's end stores the table's meeting of it after the create.
    const { rows } = await t.pool.query("select seq, op from room_ops where room_id = $1 order by seq", [roomId]);
    assert.deepEqual(rows.map((r) => r.op.t), ["token.create", "sys.meet"]);
    const wm = await t.pool.query<{ n: string }>("select n::text from client_watermarks where room_id = $1 and client_id = 'c1'", [roomId]);
    assert.equal(wm.rows[0]?.n, "1");
    s.close();
  });

  test("a hello that carries its op version gets a build frame ahead of the snapshot, and one that does not gets none", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Build");
    const asks = await t.connect(roomId, dm);
    asks.send({ t: "hello", clientId: "c1", resumeFrom: 1, opVersion: 1 });
    await asks.next("snapshot");
    // Frames of one socket arrive in order, so a build frame already here was sent ahead of the snapshot.
    assert.ok(asks.received.some((m) => m.t === "build"), "the build frame was already here when the snapshot came");
    assert.deepEqual(await asks.next("build"), { t: "build", opVersion: OP_VERSION });
    asks.close();
    const silent = await t.connect(roomId, dm);
    await silent.snapshot("c2");
    assert.equal(await silent.maybe("build"), null);
    silent.close();
  });

  test("several relative ops from one client sent together are applied once each", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Damage");
    const s = await t.connect(roomId, dm);
    const snap = await s.snapshot("c1");
    const op = tokenOp(sceneOf(snap.state as ProjectedState), { actor: { inline: { ...(tokenOp("x") as { token: { actor: { inline: object } } }).token.actor.inline, hp: { cur: 30, max: 30, temp: 0 } } } });
    const tokenId = (op as { token: { id: string } }).token.id;
    await s.apply(op);
    const ns = [1, 2, 3].map(() => s.op({ t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 7 } }));
    // The three frames can reach the room in one batch or split across batches under load, so the acks may
    // come in one ev or several. Each must still be acked exactly once, in order, and none may be applied twice.
    const acked: number[] = [];
    let hp: number | undefined;
    while (acked.length < ns.length) {
      const ev = await s.next("ev", (m) => (m.acks?.length ?? 0) > 0);
      acked.push(...(ev.acks ?? []));
      const change = ev.changes.find((c) => c.key === `token:${tokenId}`);
      assert.ok(change && "value" in change);
      hp = (change.value as { actor: { inline: { hp: { cur: number } } } }).actor.inline.hp.cur;
      assert.equal(hp, 30 - 7 * acked.length, `an ev acking ${acked.length} of the hits so far carries their HP`);
    }
    assert.deepEqual(acked, ns);
    assert.equal(hp, 9, "three hits of 7 from 30, each applied once");
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

  test("a duplicate of a committed op is acked with an empty ev", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Dup");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const n = s.op({ t: "log.chat", text: "once" });
    await s.next("ev", (m) => m.acks?.includes(n) ?? false);
    s.op({ t: "log.chat", text: "once" }, n);
    const { seq, ...again } = await s.next("ev");
    numberOf()(seq, 1, "the duplicate's frame");
    assert.deepEqual(again, { t: "ev", changes: [], acks: [n] });
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
    await until(async () => (await fresh()) === true, "last seen stamped at the moment the socket closed");
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

  test("every snapshot comes just after the server's clock, and a page on an older build drops only that frame and opens (D-261031-181)", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Clock");
    const s = await t.connect(roomId, dm);
    const frames: Array<{ t?: unknown }> = [];
    s.ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as { t?: unknown }));
    const asked = Date.now();
    await s.snapshot("c1");
    await s.next("presence");
    const clock = frames[frames.findIndex((f) => f.t === "snapshot") - 1] as { t?: unknown; at?: string } | undefined;
    assert.equal(clock?.t, "clock", "the clock frame comes just before the snapshot");
    const sent = Date.parse(clock.at!);
    assert.ok(sent >= asked && sent <= Date.now());
    // An older build's union is today's without the clock frame, since no other member changed. Its socket drops,
    // with a warning, any frame its union refuses (client/state/socket.ts).
    const members = serverMessageSchema.options.filter((schema) => schema.shape.t.value !== "clock");
    const older = z.discriminatedUnion("t", members as unknown as [(typeof members)[number], ...(typeof members)[number][]]);
    const dropped = frames.filter((frame) => !older.safeParse(frame).success).map((frame) => frame.t);
    assert.deepEqual(dropped, ["clock"]);
    assert.ok(older.safeParse(frames.find((f) => f.t === "snapshot")).success, "the older page still opens on the snapshot");
    assert.ok(frames.every((frame) => serverMessageSchema.safeParse(frame).success), "this build reads every frame");
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

  /**
   * Resolves once the room has handled its op `n`, set before the op is sent: the op is queued and taken from the queue,
   * so what it staged waits in the open batch. It resolves in the same turn of the event loop as the room takes the op,
   * so a test that awaits it goes on before any timer runs, the batch's close among them: a poll on a timer, as a sleep,
   * could let a batch boundary of the real clock pass first. A room whose drain has spent its time in the turn takes the
   * op in an immediate it sets (RoomActor #drain), and one set after it runs in the same check phase, before the next
   * timers. The deadline runs from the call, so an op that never reaches the room fails the test rather than hanging it.
   */
  async function handled(roomId: string, n: number, ms = 10_000): Promise<void> {
    const actor = t.manager.get(roomId)!;
    const own = actor.op;
    let timer: NodeJS.Timeout | undefined;
    let over = false;
    const taken = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for op ${n} to be handled`)), ms);
      const check = (): void => {
        if (over) return;
        if (actor.queueLength === 0) resolve();
        else setImmediate(check);
      };
      actor.op = async (...args: Parameters<RoomActor["op"]>) => {
        await own.apply(actor, args);
        if (args[1] === n) check();
      };
    });
    try {
      await taken;
    } finally {
      over = true;
      clearTimeout(timer);
      delete (actor as { op?: unknown }).op;
    }
  }

  test("the handled probe fails at its deadline when its op never comes, and gives the room its own op back", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Never sent");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const actor = t.manager.get(roomId)!;
    await assert.rejects(handled(roomId, 1, 300), /timed out after 300 ms waiting for op 1 to be handled/);
    assert.ok(!Object.hasOwn(actor, "op"), "the room's op is its own again");
    s.close();
  });

  test("the handled probe waits out a drain the room puts off to its next turn, and the unload still drops the refusal it staged", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Put off");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const actor = t.manager.get(roomId)!;
    const roomOp = Object.getPrototypeOf(actor).op as RoomActor["op"];
    let putOff = false;
    // The drain reads the clock as if its time in this turn were spent, so it takes the op in an immediate (RoomActor #drain).
    actor.op = (...args: Parameters<RoomActor["op"]>) => {
      const real = performance.now;
      let ahead = 0;
      performance.now = () => real.call(performance) + (ahead += 100);
      try {
        return roomOp.apply(actor, args);
      } finally {
        performance.now = real;
        putOff = actor.queueLength > 0;
      }
    };
    const staged = handled(roomId, 1);
    s.send({ t: "op", n: 1, op: { t: "nonsense" } });
    await staged;
    await t.manager.unload(roomId, 4010, false);
    assert.ok(putOff, "the room put the op off to its next turn");
    assert.equal((await s.waitClosed()).code, 4010);
    const stored = await t.pool.query("select 1 from client_watermarks where room_id = $1", [roomId]);
    assert.equal(stored.rowCount, 0, "the refusal went with its open batch");
  });

  test("a client that reconnects while its op is staged gets its snapshot at the commit, with the op settled, and a resend of it is acked at the next close with no change", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Staged");
    const a = await t.connect(roomId, dm);
    await a.snapshot("c1");
    const n = a.op({ t: "log.chat", text: "first" });
    // The batch is open for 400 ms. Reconnect as the same client meanwhile.
    const b = await t.connect(roomId, dm);
    const snap = await b.snapshot("c1", n);
    assert.equal(snap.watermark, n);
    assert.ok(JSON.stringify(snap.state).includes('"first"'), "the snapshot holds the op");
    b.op({ t: "log.chat", text: "first" }, n);
    assert.equal(await b.maybe("ev", () => true, 150), null);
    const ev = await b.next("ev", (m) => m.acks?.includes(n) ?? false);
    assert.deepEqual(ev.changes, []);
    // The newer socket's hello closed the old one, with a code a page reconnects from (design 7.6), so it never sees that client's ack.
    assert.equal((await a.waitClosed()).code, 4012);
    assert.ok(!a.received.some((m) => m.t === "ev" && m.acks?.includes(n)));
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
    const staged = handled(roomId, 1);
    s.send({ t: "op", n: 1, op: { t: "nonsense" } });
    await staged;
    // handled() resolves before any timer can close the open batch, and the unload drops the batch before one can.
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
    const staged = handled(roomId, 1);
    s.send({ t: "op", n: 1, op: { t: "nonsense" } });
    await staged;
    // handled() resolves before any timer can close the open batch, and the unload drops the batch before one can.
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
    const { seq, ...again } = await back.next("ev");
    numberOf()(seq, 3, "the duplicate's frame");
    assert.deepEqual(again, { t: "ev", changes: [], acks: [2] });
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
    // The commit fails until the test has seen the room degraded, however long a slow machine takes to look, and then lands.
    const flaky = failCommits(t.pool, Array.from({ length: 1000 }, () => "before" as const));
    let n: number;
    try {
      n = s.op({ t: "log.chat", text: "retry me" });
      await until(() => t.manager.degraded(), "the commit to retry");
      assert.deepEqual((await t.app.inject({ method: "GET", url: "/healthz" })).json(), { status: "degraded" });
    } finally {
      flaky.restore();
    }
    const ev = await s.next("ev", (m) => m.acks?.includes(n) ?? false);
    numberOf()(ev.seq, 1, "the frame's number");
    assert.equal(t.manager.degraded(), false);
    assert.equal(await s.maybe("ev", () => true, 200), null);
    const { rows } = await t.pool.query("select count(*)::int as n from room_ops where room_id = $1", [roomId]);
    assert.equal(rows[0].n, 1);
    s.close();
  });

  test("an unknown outcome is resolved by reading back: committed is published, rolled back is retried", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Unknown");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    const pin = numberOf();
    const flaky = failCommits(t.pool, ["committed"]);
    try {
      const ev = await s.apply({ t: "log.chat", text: "lost answer" });
      pin(ev.seq, 1, "the first frame");
      assert.equal(flaky.remaining(), 0);
    } finally {
      flaky.restore();
    }
    const flaky2 = failCommits(t.pool, ["rolledBack"]);
    try {
      const ev = await s.apply({ t: "log.chat", text: "dropped" });
      pin(ev.seq, 2, "the second frame");
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

  test("the queue cap answers busy once the batches closed behind a retrying commit hold the queue", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Cap");
    const s = await t.connect(roomId, dm);
    await s.snapshot("c1");
    // The commit fails until the queue has answered busy, however long a slow machine takes to fill it, and then lands.
    const flaky = failCommits(t.pool, Array.from({ length: 1000 }, () => "before" as const));
    let first: number;
    try {
      first = s.op({ t: "log.chat", text: "a" });
      // A chat a tick: each tick's batch closes behind the retrying commit, until MAX_PENDING_BATCHES wait and the queue holds.
      const ticks: number[] = [];
      for (let i = 0; i < MAX_PENDING_BATCHES + 10; i++) {
        ticks.push(s.op({ t: "log.chat", text: `tick ${i}` }));
        await new Promise((r) => setTimeout(r, 25));
      }
      const ns = [1, 2, 3, 4, 5].map(() => s.op({ t: "log.chat", text: "queued" }));
      const busy = await s.next("retry", (m) => m.code === "busy");
      // The first busy goes to an op past the queue cap, once the waiting batches hold the queue.
      assert.ok([...ticks.slice(MAX_PENDING_BATCHES - 1), ...ns].includes(busy.n ?? -1), `busy for ${busy.n}`);
    } finally {
      flaky.restore();
    }
    await s.next("ev", (m) => m.acks?.includes(first) ?? false);
    s.close();
  });
});

describe("websocket: rates", () => {
  let t: Engine;
  /** Where the sockets' budget clock stands still, or null for the real one. */
  let frozenAt: number | null = null;
  before(async () => {
    t = await startEngine({ ws: { now: () => frozenAt ?? Date.now() } });
  });
  after(() => t.close());

  test("a burst over the op rate gets busy, then gap for everything behind the refused op", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Burst");
    // The socket's clock stands still from before it opens, so however slowly a loaded runner
    // carries the 80 ops, the 60-op burst refills nothing and the 61st is the one refused (review WS-RATE-FLAKE).
    frozenAt = Date.now();
    try {
      const s = await t.connect(roomId, dm);
      await s.snapshot("c1");
      for (let i = 0; i < 80; i++) s.op({ t: "log.chat", text: `b${i}` });
      const busy = await s.next("retry", (m) => m.code === "busy");
      assert.equal(busy.n, 61);
      const gap = await s.next("retry", (m) => m.code === "gap");
      assert.equal(gap.n, 62);
      s.close();
    } finally {
      frozenAt = null;
    }
  });

  test("frames over the frame budget are dropped before parsing, and sustained abuse closes with 4008", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Frames");
    // The socket's clock stands still from before it opens, so however slowly a loaded runner carries the
    // frames, the burst refills nothing and the pongs are counted by the budget alone (FLAKE-WS-PONG).
    frozenAt = Date.now();
    try {
      const s = await t.connect(roomId, dm);
      await s.snapshot("c1");
      // 500 pings at once: the burst's 400 frames are the hello and 399 pings, and the rest are dropped unparsed, not punished.
      for (let i = 0; i < 500; i++) s.send({ t: "ping", k: i });
      const answered: number[] = [];
      for (let i = 0; i < 399; i++) answered.push((await s.next("pong")).k);
      assert.deepEqual(answered, Array.from({ length: 399 }, (_, k) => k));
      assert.equal(await s.maybe("pong", () => true, 500), null, "a pong past the burst");
      assert.equal(s.closeCode, null);
      s.close();
    } finally {
      frozenAt = null;
    }
  });
});

describe("websocket: what a frame pays is what it parses to (design 7.6)", () => {
  let t: Engine;
  let frozenAt: number | null = null;
  before(async () => {
    t = await startEngine({ ws: { now: () => frozenAt ?? Date.now() } });
  });
  after(() => t.close());

  test("previews spend their own rate, never the bytes an op needs, and a frame that names `t` twice is what it parsed to", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Kinds");
    frozenAt = Date.now();
    try {
      const s = await t.connect(roomId, dm);
      const snap = await s.snapshot("c1");
      const sceneId = sceneOf(snap.state as ProjectedState);
      // The eph burst spent whole, within the frame count's: 399 pings of the map, then a second's 101 more.
      for (let i = 0; i < 399; i++) s.send({ t: "eph", sceneId, e: { k: "ping", x: 1, y: 1 } });
      await s.reached();
      frozenAt += 1_000;
      for (let i = 0; i < 101; i++) s.send({ t: "eph", sceneId, e: { k: "ping", x: 1, y: 1 } });
      // An op that names `t` twice is an op to the parser, so it pays the bytes, which the pings left whole.
      s.sendRaw(`{"t":"eph","t":"op","n":1,"op":{"t":"log.chat","text":"twice"}}`);
      const ev = await s.next("ev", (m) => Boolean(m.acks?.includes(1)));
      assert.ok(ev);
      // And an eph that names `t` twice is an eph, which the empty bucket drops.
      const other = await t.connect(roomId, dm);
      await other.snapshot("c2");
      s.sendRaw(`{"t":"op","t":"eph","sceneId":"${sceneId}","e":{"k":"ping","x":2,"y":2}}`);
      assert.equal(await other.maybe("eph", (m) => m.e.k === "ping" && m.e.x === 2, 500), null);
      assert.equal(s.closeCode, null);
      s.close();
      other.close();
    } finally {
      frozenAt = null;
    }
  });

  test("every other message pays its bytes once parsed, past the burst it drops, and previews still go", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Bytes");
    frozenAt = Date.now();
    try {
      const s = await t.connect(roomId, dm);
      const snap = await s.snapshot("c1");
      const sceneId = sceneOf(snap.state as ProjectedState);
      const other = await t.connect(roomId, dm);
      await other.snapshot("c2");
      // 200 pings of 4 KiB, padded with spaces: the 512 KiB burst holds the hello and 127 of them.
      for (let k = 0; k < 200; k++) {
        const text = `{"t":"ping","k":${k}}`;
        s.sendRaw(text + " ".repeat(4096 - text.length));
      }
      const answered: number[] = [];
      for (let i = 0; i < 127; i++) answered.push((await s.next("pong")).k);
      assert.deepEqual(answered, Array.from({ length: 127 }, (_, k) => k));
      assert.equal(await s.maybe("pong", () => true, 500), null, "a pong past the burst");
      s.send({ t: "eph", sceneId, e: { k: "ping", x: 3, y: 3 } });
      assert.ok(await other.next("eph", (m) => m.e.k === "ping" && m.e.x === 3));
      assert.equal(s.closeCode, null);
      s.close();
      other.close();
    } finally {
      frozenAt = null;
    }
  });

  test("a flood of previews at three times the rate for 10 s closes 4008", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Flood");
    frozenAt = Date.now();
    try {
      const s = await t.connect(roomId, dm);
      const snap = await s.snapshot("c1");
      const sceneId = sceneOf(snap.state as ProjectedState);
      for (let second = 0; second < 12 && s.closeCode === null; second++) {
        for (let i = 0; i < 301; i++) s.send({ t: "eph", sceneId, e: { k: "ping", x: 1, y: 1 } });
        // The server has read the frames before the clock moves on, however slowly a loaded machine carries them.
        await s.reached();
        frozenAt += 1_000;
      }
      await s.waitClosed();
      assert.equal(s.closeCode, 4008);
    } finally {
      frozenAt = null;
    }
  });

  test("a hello that carries its op version is told the socket's preview pace after `build`, before its snapshot", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Takes");
    const s = await t.connect(roomId, dm);
    s.send({ t: "hello", clientId: "c1", resumeFrom: 1, opVersion: OP_VERSION });
    const build = await s.next("build");
    const takes = await s.next("takes");
    assert.deepEqual(takes, { t: "takes", groups: true, pace: "full" });
    await s.next("snapshot");
    assert.ok(build);
    s.close();
  });
});

describe("websocket: the largest DM snapshot on a slow device (docs/design/design-v1-companion-stat-blocks.md 3.4)", () => {
  let t: Engine;
  before(async () => {
    // A short hold, so a socket over its send-buffer limit would be closed well within the test.
    t = await startEngine({ ws: { bufferedHoldMs: 1_500 } });
  });
  after(() => t.close());

  /** Text that deflate cannot shrink much, so the snapshot fills the send buffer as a real one would. */
  const noise = (chars: number) => randomBytes(Math.ceil((chars * 3) / 4)).toString("base64").slice(0, chars);

  test("a DM snapshot of 6 MiB, 3 MiB of companion blocks on top of everything else, reaches a device that stopped reading past the hold, and its socket stays open", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Heavy");
    const first = await t.connect(roomId, dm);
    const sceneId = sceneOf((await first.snapshot("c1")).state as ProjectedState);
    first.close();
    await first.waitClosed();
    await t.manager.unload(roomId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    const state = rows[0]!.state;
    // Six characters with their 512 KiB of blocks each, the monsters' 1 MiB, and the rest of the scene's 3 MiB in tokens.
    const traits = () => Array.from({ length: 4 }, () => ({ name: "Trait", text: noise(3_700) }));
    for (let c = 0; c < 6; c++) {
      const characterId = uuidv7();
      state.characters[characterId] = character(characterId, { name: `Hero ${c}` });
      for (let b = 0; b < 32; b++) {
        const id = uuidv7();
        state.companionBlocks[id] = companionBlock(id, characterId, { traits: traits() });
      }
    }
    for (let m = 0; m < 64; m++) {
      const id = uuidv7();
      state.monsters[id] = customMonster(id, { traits: traits() });
    }
    for (let i = 0; i < 480; i++) {
      const id = uuidv7();
      state.tokens[id] = token(id, { sceneId, x: i % 40, y: Math.floor(i / 40), notes: noise(4_000) });
    }
    const blocks = serializedBytes(state.companionBlocks);
    assert.ok(blocks > 0.9 * LIMITS.companionBlocksBytes && blocks <= LIMITS.companionBlocksBytes, `${blocks} bytes of blocks`);
    await t.pool.query("update room_snapshots set state = $2::jsonb where room_id = $1", [roomId, JSON.stringify(state)]);

    const slow = await t.connect(roomId, dm);
    slow.ws.pause();
    slow.hello("c1");
    await new Promise((r) => setTimeout(r, 3_500));
    assert.equal(slow.closeCode, null, "the socket stays open while its snapshot waits in the send buffer");
    slow.ws.resume();
    const snap = await slow.next("snapshot", () => true, 30_000);
    const bytes = serializedBytes(snap);
    assert.ok(bytes > 5.5 * 1024 * 1024, `the snapshot is ${bytes} bytes`);
    assert.equal(Object.keys((snap.state as ProjectedState).companionBlocks).length, 192);
    assert.equal(slow.closeCode, null);
    slow.close();
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

describe("websocket: the joinRequests signal (docs/design/design-v1-join-requests.md 5.3)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("reaches DM sockets with a snapshot only: never a player, a table display, a View as preview, or a DM socket still waiting for its snapshot", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Knock knock");
    const player = t.client();
    const pipId = await player.join(roomId, "Pip");
    const code = (await dm.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    const tv = t.client();
    assert.equal((await tv.post("/api/display/redeem", { code })).statusCode, 200);

    const dmSocket = await t.connect(roomId, dm);
    const playerSocket = await t.connect(roomId, player);
    const displaySocket = await t.connectDisplay(roomId, tv);
    const { Socket } = await import("./testing.ts");
    const preview = await Socket.open(`${t.url}/ws?room=${roomId}&as=${encodeURIComponent(pipId)}`, {
      origin: t.config.publicOrigin,
      cookie: `rvtt=${dm.token}`,
      "cf-connecting-ip": dm.ip,
      "user-agent": "joinrequests-itest",
    });
    await dmSocket.snapshot("dm");
    await playerSocket.snapshot("player");
    await displaySocket.snapshot("display");
    await preview.snapshot("preview");
    // A second DM socket that has not said hello holds no snapshot yet.
    const early = await t.connect(roomId, dm);

    t.app.gateway.joinRequestsChanged(roomId);
    assert.ok(await dmSocket.next("joinRequests"));
    assert.equal(await playerSocket.maybe("joinRequests"), null);
    assert.equal(await displaySocket.maybe("joinRequests"), null);
    assert.equal(await preview.maybe("joinRequests"), null);
    assert.equal(await early.maybe("joinRequests"), null);
    // Apart from access: a burst of asks never makes the devices list fetch again.
    assert.equal(await dmSocket.maybe("access"), null);
    for (const s of [dmSocket, playerSocket, displaySocket, preview, early]) s.close();
  });
});

/**
 * A refusal committed while its client's socket waits on a snapshot
 * (RESYNC-REFUSAL-LOST): the batch sends that socket no ev, and the snapshot
 * settles the op with no answer, so the server keeps the refusal for that
 * socket and sends it as `refusals` just ahead of the snapshot, on each path
 * a snapshot takes: at once, delayed by the snapshot budget, or after the
 * batch a hello waits on. Each test holds the window open by holding back
 * the page's hello.
 */
describe("websocket: refusals kept for a snapshot (RESYNC-REFUSAL-LOST)", () => {
  let t: Engine;
  let budget: Engine;
  before(async () => {
    // A long batch window, so a hello can land while the refused op is still staged, on a loaded machine too.
    t = await startEngine({ rooms: { actor: { batchMs: 1_000 } } });
    // One snapshot a session for a while, so a resync's hello waits for its own.
    budget = await startEngine({ rooms: { actor: { batchMs: 20 }, snapshotBudget: { sessionCount: 1, windowMs: 2_000 } } });
  });
  after(async () => {
    await t.close();
    await budget.close();
  });

  /** Every frame a socket receives from now on, in order, whether or not a test waits on it. */
  function framesOf(s: Socket): ServerMessage[] {
    const frames: ServerMessage[] = [];
    s.ws.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerMessage));
    return frames;
  }

  async function storedAt(e: Engine, roomId: string, clientId: string): Promise<number> {
    const { rows } = await e.pool.query<{ n: string }>("select n::text from client_watermarks where room_id = $1 and client_id = $2", [roomId, clientId]);
    return Number(rows[0]?.n ?? 0);
  }

  /** Until the client's watermark is stored at `n`, as the commit of the batch that settles `n` stores it. */
  async function committed(e: Engine, roomId: string, clientId: string, n: number): Promise<void> {
    await until(async () => (await storedAt(e, roomId, clientId)) >= n, `client ${clientId} stored at ${n}`);
  }

  /** The frames just ahead of the socket's newest snapshot, and that snapshot. */
  function ahead(frames: ServerMessage[]): { before: ServerMessage[]; snapshot: Extract<ServerMessage, { t: "snapshot" }> } {
    const at = frames.findLastIndex((f) => f.t === "snapshot");
    assert.ok(at >= 0, "a snapshot came");
    return { before: frames.slice(0, at), snapshot: frames[at] as Extract<ServerMessage, { t: "snapshot" }> };
  }

  /** A chat line whose text is not a string: refused `invalid`, in words no other frame holds. */
  const BAD: Record<string, unknown> = { t: "log.chat", text: 41 };

  test("qfu2-int-1: an op refused while a DM's scene switch waits for its hello comes as refusals just ahead of the snapshot, to that socket alone", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Kept refusal");
    const player = t.client();
    const pipId = await player.join(roomId, "Pip");
    const a = await t.connect(roomId, dm);
    // Another page of the same browser: the same session, another client.
    const tab = await t.connect(roomId, dm);
    const pip = await t.connect(roomId, player);
    const view = await Socket.open(`${t.url}/ws?room=${roomId}&as=${encodeURIComponent(pipId)}`, { origin: t.config.publicOrigin, cookie: `rvtt=${dm.token}`, "cf-connecting-ip": dm.ip, "user-agent": "refusals-itest" });
    const frames = { a: framesOf(a), tab: framesOf(tab), pip: framesOf(pip), view: framesOf(view) };
    const first = await a.snapshot("c1");
    await tab.snapshot("c2");
    await pip.snapshot("p1");
    const sceneId = sceneOf(first.state as ProjectedState);

    // The other page switches too, and the view as Pip has not said hello yet: neither holds a snapshot as the batch commits.
    const n = a.op(BAD);
    a.send({ t: "scene", sceneId });
    tab.send({ t: "scene", sceneId });
    await a.next("resync");
    await tab.next("resync");
    await committed(t, roomId, "c1", n);
    assert.equal(await a.maybe("ev", () => true, 100), null, "the socket holds no snapshot, so the batch sends it nothing");
    await tab.snapshot("c2", 1, sceneId);
    await view.snapshot("v1");
    // The page still holds the op, so it resumes from it.
    a.hello("c1", n, sceneId);
    await a.next("snapshot");
    const { before, snapshot } = ahead(frames.a);
    assert.ok(snapshot.watermark >= n, "the snapshot settles the op");
    assert.deepEqual(before.slice(-2).map((f) => f.t), ["refusals", "clock"], "the refusals just ahead of the clock and the snapshot");
    const kept = before.at(-2) as Extract<ServerMessage, { t: "refusals" }>;
    assert.deepEqual(kept.rejects.map((r) => [r.n, r.code]), [[n, "invalid"]]);
    const words = kept.rejects[0]!.message;
    assert.ok(words.length > 0, "the refusal keeps its words");
    assert.ok(!before.slice(before.findLastIndex((f) => f.t === "resync")).some((f) => f.t === "ev"), "no ev between the resync and the snapshot");
    assert.ok(serverMessageSchema.safeParse(kept).success, "this build reads the frame");
    // An older build's union is today's without this frame. Its page drops the frame and opens on the snapshot, as before.
    const members = serverMessageSchema.options.filter((schema) => schema.shape.t.value !== "refusals");
    const older = z.discriminatedUnion("t", members as unknown as [(typeof members)[number], ...(typeof members)[number][]]);
    assert.ok(!older.safeParse(kept).success && older.safeParse(snapshot).success, "an older page drops only the refusals");

    // The next snapshot of the same socket brings nothing kept again, once the scene rate lets the DM switch again.
    await new Promise((r) => setTimeout(r, 2_100));
    a.send({ t: "scene", sceneId });
    await a.next("resync");
    a.hello("c1", n + 1, sceneId);
    await a.next("snapshot");
    assert.ok(!ahead(frames.a.slice(frames.a.indexOf(snapshot) + 1)).before.some((f) => f.t === "refusals"), "taken once");
    // Nothing of it reaches any other socket: the same DM's other page, the player, or the DM's view as the player.
    for (const [name, got] of Object.entries({ tab: frames.tab, pip: frames.pip, view: frames.view })) {
      assert.ok(got.some((f) => f.t === "snapshot"), `${name} is open`);
      assert.ok(!got.some((f) => f.t === "refusals" || (f.t === "ev" && f.rejects !== undefined)), `${name} takes no refusal`);
      assert.ok(!JSON.stringify(got).includes(words), `${name} never reads its words`);
    }
    for (const s of [a, tab, pip, view]) s.close();
  });

  test("qfu2-int-2: a hello on the same socket for another client takes nothing kept for the first", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Kept for its client");
    const a = await t.connect(roomId, dm);
    const first = await a.snapshot("c1");
    const sceneId = sceneOf(first.state as ProjectedState);
    const frames = framesOf(a);
    const n = a.op(BAD);
    a.send({ t: "scene", sceneId });
    await a.next("resync");
    await committed(t, roomId, "c1", n);
    a.hello("c9", 1, sceneId);
    await a.next("snapshot");
    assert.ok(!ahead(frames).before.some((f) => f.t === "refusals"));
    a.close();
  });

  test("qfu2-int-3: a hello that waits on a batch takes the batch's refusal ahead of its snapshot", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Kept for a waiting hello");
    const a = await t.connect(roomId, dm);
    const first = await a.snapshot("c1");
    const sceneId = sceneOf(first.state as ProjectedState);
    const frames = framesOf(a);
    const n = a.op(BAD);
    a.send({ t: "scene", sceneId });
    await a.next("resync");
    // The page says every op below n + 1 is settled while the batch holding n is still staged, so its hello waits on that batch.
    assert.equal(await storedAt(t, roomId, "c1"), 0, "the batch has not committed");
    a.hello("c1", n + 1, sceneId);
    const snapshot = await a.next("snapshot");
    assert.equal(snapshot.watermark, n);
    const { before } = ahead(frames);
    assert.deepEqual(before.slice(-2).map((f) => f.t), ["refusals", "clock"]);
    assert.deepEqual((before.at(-2) as Extract<ServerMessage, { t: "refusals" }>).rejects.map((r) => [r.n, r.code]), [[n, "invalid"]]);
    a.close();
  });

  test("qfu2-int-4: a snapshot the budget delays takes the refusal that committed while it waited", async () => {
    const dm = budget.client();
    const { roomId } = await dm.createRoom("Kept through a wait");
    const a = await budget.connect(roomId, dm);
    const first = await a.snapshot("c1");
    const sceneId = sceneOf(first.state as ProjectedState);
    const frames = framesOf(a);
    const n = a.op(BAD);
    a.send({ t: "scene", sceneId });
    await a.next("resync");
    a.hello("c1", n, sceneId);
    // The session spent its one snapshot, so this one waits, and the batch commits meanwhile.
    await a.next("wait");
    await committed(budget, roomId, "c1", n);
    const snapshot = await a.next("snapshot", () => true, 5_000);
    assert.ok(snapshot.watermark >= n);
    const { before } = ahead(frames);
    assert.ok(before.findIndex((f) => f.t === "wait") < before.findIndex((f) => f.t === "refusals"), "kept through the wait");
    assert.deepEqual(before.slice(-2).map((f) => f.t), ["refusals", "clock"]);
    assert.deepEqual((before.at(-2) as Extract<ServerMessage, { t: "refusals" }>).rejects.map((r) => [r.n, r.code]), [[n, "invalid"]]);
    a.close();
  });

  test("qfu2-int-5: a socket keeps its newest refusals up to the frame's cap, across the batches of its wait", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Kept to the cap");
    const a = await t.connect(roomId, dm);
    const first = await a.snapshot("c1");
    const sceneId = sceneOf(first.state as ProjectedState);
    const frames = framesOf(a);
    a.send({ t: "scene", sceneId });
    await a.next("resync");
    // A full op burst, then more once the rate has refilled, so none is answered busy.
    for (let i = 0; i < 60; i++) a.op(BAD);
    await committed(t, roomId, "c1", 60);
    await new Promise((r) => setTimeout(r, 600));
    for (let i = 0; i < 10; i++) a.op(BAD);
    await committed(t, roomId, "c1", 70);
    a.hello("c1", 1, sceneId);
    const snapshot = await a.next("snapshot");
    assert.equal(snapshot.watermark, 70);
    const kept = ahead(frames).before.findLast((f) => f.t === "refusals") as Extract<ServerMessage, { t: "refusals" }> | undefined;
    assert.deepEqual(kept?.rejects.map((r) => r.n), Array.from({ length: MAX_KEPT_REFUSALS }, (_, i) => 70 - MAX_KEPT_REFUSALS + 1 + i));
    assert.ok(serverMessageSchema.safeParse(kept).success, "a page reads it whole");
    a.close();
  });
});

describe("roster reads as of their moment", () => {
  let t: Engine;
  // The run's own connections carry its name, so a probe tells them from another run's on the shared database.
  const appName = `roster-itest-${randomBytes(6).toString("hex")}`;
  const otherName = `${appName}-other`;
  before(async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.searchParams.set("application_name", appName);
    // The test gives one actor a roster from the past. The engine's 200 ms idle unload would load the room afresh, and the
    // new actor reads the roster as it is, so the room stays loaded however long a slow machine takes.
    t = await startEngine({ env: { DATABASE_URL: url.toString() }, rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  /** Whether a connection named `name` waits on a lock of the grants table, as a grant read behind the test's lock does. */
  async function waitsOnGrants(name: string): Promise<boolean> {
    const { rows } = await t.pool.query<{ n: number }>(
      "select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.relation = 'grants'::regclass and not l.granted and a.datname = current_database() and a.application_name = $1",
      [name],
    );
    return rows[0]!.n > 0;
  }

  test("a View as upgrade reads the roster as of its arrival, before its grant read waits, and the gateway as of its call", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Roster moments");
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const actor = await t.manager.acquire(roomId);
    const given = actor.committed;
    const quin = t.client();
    const quinId = await quin.join(roomId, "Quin");
    assert.equal(t.manager.get(roomId)!.committed.state.members[quinId]?.kind, "player", "Quin is on the roster now");
    const own = actor.asOf.bind(actor);
    const asked: number[] = [];
    actor.asOf = (at: number) => {
      asked.push(at);
      return Promise.resolve({ tick: t.manager.arrivalTick(at), ...given });
    };
    const preview = (memberId: string) =>
      Socket.open(`${t.url}/ws?room=${roomId}&as=${encodeURIComponent(memberId)}`, { origin: t.config.publicOrigin, cookie: `rvtt=${dm.token}`, "cf-connecting-ip": dm.ip, "user-agent": "roster-itest" });
    try {
      const holder = await t.pool.connect();
      await holder.query("begin");
      await holder.query("lock table grants in access exclusive mode");
      const other = new pg.Client({ connectionString: TEST_DATABASE_URL, application_name: otherName });
      let otherRead: Promise<unknown> = Promise.resolve();
      let otherConnected = false;
      let sent: number;
      let upgrade: Promise<string>;
      let released: number;
      try {
        // Another run on the shared database reads grants first. Its wait must not let the lock go before the upgrade's.
        await other.connect();
        otherConnected = true;
        otherRead = other.query("select count(*) from grants").catch(() => undefined);
        await until(() => waitsOnGrants(otherName), "another run's read to wait on the lock");
        assert.equal(await waitsOnGrants(appName), false, "another run's wait is none of this run's");
        sent = Date.now();
        upgrade = preview(quinId).then(
          (s) => (s.close(), "open"),
          (err: Error) => err.message,
        );
        // The upgrade has arrived once its own grant read waits on the lock, however slow the machine.
        await until(() => waitsOnGrants(appName), "the upgrade's grant read to wait on the lock");
      } finally {
        released = Date.now();
        await holder.query("rollback");
        holder.release();
        await otherRead;
        // A client that never connected is not ended, so its connect's own error is the one the test fails with.
        if (otherConnected) await other.end();
      }
      const verdict = await upgrade;
      assert.equal(t.manager.get(roomId), actor, "the room kept the actor whose roster the test gave");
      assert.equal(verdict, "upgrade refused: 403", "Quin was no player of the roster the room gave");
      const at = asked.pop()!;
      assert.ok(at >= sent && at < released, `the arrival ${at} is before the grant read let go at ${released}`);
      const called = Date.now();
      assert.equal(await t.manager.gateway.getMember(roomId, quinId), null);
      assert.equal((await t.manager.gateway.getMember(roomId, pipId))?.name, "Pip");
      assert.ok(asked.every((x) => x >= called && x <= Date.now()), "the gateway's moment is its call's");
      actor.asOf = () => Promise.reject(new ViewBusyError("too old"));
      await assert.rejects(t.manager.gateway.getMember(roomId, pipId), (err: { status?: number; retryAfter?: number }) => err.status === 503 && err.retryAfter === 1);
    } finally {
      actor.asOf = own;
    }
    const opened = await preview(quinId);
    opened.close();
  });
});
