import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { MockAgent } from "undici";
import type { RoomState } from "#shared/model.ts";
import type { JoinMode } from "#shared/protocol.ts";
import { ipKey } from "../auth/ipKey.ts";
import { loseNextCommit, randomIp, startTestApp, type TestApp, type TestClient } from "../auth/testing.ts";
import { randomToken, sha256 } from "../auth/tokens.ts";
import { setTurnstileDispatcherForTests } from "../auth/turnstile.ts";

const PASSWORD = "owlbear-druid-wand";
type List = { mode: JoinMode; challenged: boolean; requests: Array<{ id: string; name: string; color: string; askedAt: string }>; players: Array<{ id: string; name: string; color: string }> };

function kit(t: TestApp) {
  async function room(mode: JoinMode = "ask"): Promise<{ dm: TestClient; roomId: string; dmKey: string }> {
    const dm = t.client();
    const { roomId, dmKey } = await dm.createRoom();
    if (mode !== "password") await setMode(dm, roomId, mode);
    return { dm, roomId, dmKey };
  }
  async function setMode(dm: TestClient, roomId: string, mode: JoinMode): Promise<void> {
    const res = await dm.post(`/api/rooms/${roomId}/join-mode`, { mode });
    assert.equal(res.statusCode, 200, res.body);
  }
  async function asked(c: TestClient, roomId: string, name = "Quinn", color = "#3e8ef7"): Promise<string> {
    const res = await c.post(`/api/rooms/${roomId}/join-requests`, { name, color });
    assert.equal(res.statusCode, 201, res.body);
    return res.json<{ requestId: string }>().requestId;
  }
  async function list(dm: TestClient, roomId: string): Promise<List> {
    const res = await dm.get(`/api/rooms/${roomId}/join-requests`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json<List>();
  }
  const letIn = (dm: TestClient, roomId: string, id: string, as: { kind: "new" } | { kind: "member"; memberId: string } = { kind: "new" }) =>
    dm.post(`/api/rooms/${roomId}/join-requests/${id}/let-in`, { as });
  const wait = (c: TestClient, roomId: string, id: string) => c.post(`/api/rooms/${roomId}/join-requests/${id}/wait`, {});
  const error = (res: { json<T>(): T }) => res.json<{ error: string }>().error;
  async function members(roomId: string): Promise<string[]> {
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [roomId]);
    return Object.values(rows[0]?.state.members ?? {}).map((m) => m.name).sort();
  }
  async function sessionRow(token: string | undefined) {
    const { rows } = await t.pool.query<{ id: string; user_agent: string | null; days: number }>(
      "select id, user_agent, extract(epoch from expires_at - now()) / 86400 as days from sessions where token_hash = $1",
      [sha256(token ?? "")],
    );
    return rows[0];
  }
  async function askRow(token: string | undefined) {
    const { rows } = await t.pool.query<{ id: string }>("select id from ask_sessions where token_hash = $1", [sha256(token ?? "")]);
    return rows[0];
  }
  return { room, setMode, asked, list, letIn, wait, error, members, sessionRow, askRow };
}

/** Pauses the first query matching `match` on the app's pool until the returned `go` is called. */
function pauseQuery(pool: pg.Pool, match: (sql: string) => boolean): { reached: Promise<void>; go: () => void; restore: () => void } {
  const original = pool.query.bind(pool);
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  let armed = true;
  (pool as { query: unknown }).query = async (text: unknown, values?: unknown) => {
    if (armed && typeof text === "string" && match(text)) {
      armed = false;
      reach();
      await gate;
    }
    return original(text as string, values as unknown[]);
  };
  return { reached, go, restore: () => ((pool as { query: unknown }).query = original) };
}

/**
 * Pauses the first statement matching `match` on a transaction's own client
 * (pool.query's are paused by pauseQuery above) until `go` is called. Both
 * connect() forms keep working, as loseNextCommit's do.
 */
function pauseTxStatement(pool: pg.Pool, match: (sql: string) => boolean): { reached: Promise<void>; go: () => void; restore: () => void } {
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  let armed = true;
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  const patched = (cb?: (err: Error | undefined, client?: pg.PoolClient, done?: () => void) => void) => {
    const wrapped = connect().then((client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as { query: unknown }).query = (...args: unknown[]) => {
        if (armed && typeof args[0] === "string" && match(args[0])) {
          armed = false;
          reach();
          return gate.then(() => query(...args));
        }
        return query(...args);
      };
      return client;
    });
    if (cb) {
      wrapped.then((client) => cb(undefined, client, () => client.release()), (err: Error) => cb(err));
      return undefined;
    }
    return wrapped;
  };
  (pool as { connect: unknown }).connect = patched;
  return { reached, go, restore: () => ((pool as { connect: unknown }).connect = connect) };
}

/** The next grant transaction commits and loses its COMMIT's answer (testing.ts loseNextCommit). */
function loseGrantCommit(pool: pg.Pool, meanwhile: () => Promise<void>): () => void {
  return loseNextCommit(pool, (sql) => sql.includes("insert into grants"), meanwhile);
}

describe("join requests: asking, waiting and a DM's answer", () => {
  let t: TestApp;
  let k: ReturnType<typeof kit>;
  before(async () => {
    t = await startTestApp({ access: { admissions: { memberMs: 300, checkoutMs: 300 } } });
    k = kit(t);
  });
  after(() => t.close());

  test("a device with no session asks, waits and is let in as someone new: one identity from ask to grant", async () => {
    const { dm, roomId } = await k.room("ask");
    const phone = t.client();
    const ask = await phone.post(`/api/rooms/${roomId}/join-requests`, { name: "Quinn", color: "#3E8EF7" });
    assert.equal(ask.statusCode, 201, ask.body);
    // The requester's answers carry only their own request's fields.
    assert.deepEqual(Object.keys(ask.json()).sort(), ["expiresAt", "requestId"]);
    const { requestId } = ask.json<{ requestId: string }>();
    const token = phone.token;
    assert.ok(token, "an ask token in the room cookie");
    const askId = (await k.askRow(token))?.id;
    assert.ok(askId, "kept in ask_sessions");
    assert.equal(await k.sessionRow(token), undefined, "never in sessions");

    const mine = await phone.get(`/api/rooms/${roomId}/join-requests/mine`);
    assert.deepEqual(Object.keys(mine.json()).sort(), ["color", "expiresAt", "name", "requestId", "state"]);
    assert.deepEqual({ ...mine.json<Record<string, unknown>>(), expiresAt: 0 }, { requestId, state: "waiting", name: "Quinn", color: "#3e8ef7", expiresAt: 0 });

    const listed = await k.list(dm, roomId);
    assert.deepEqual(listed.requests.map((r) => [r.id, r.name, r.color]), [[requestId, "Quinn", "#3e8ef7"]]);
    assert.deepEqual(Object.keys(listed.requests[0] ?? {}).sort(), ["askedAt", "color", "id", "name"], "never the address, device or token");

    const held = k.wait(phone, roomId, requestId);
    const dmToken = dm.token;
    const res = await k.letIn(dm, roomId, requestId);
    assert.equal(res.statusCode, 200, res.body);
    const memberId = res.json<{ memberId: string }>().memberId;
    const answer = await held;
    assert.equal(answer.statusCode, 200, answer.body);
    const body = answer.json<{ requestId: string; state: string; me: { roomId: string; memberId: string; role: string; member: { name: string } } }>();
    assert.deepEqual([body.requestId, body.state, body.me.roomId, body.me.memberId, body.me.role, body.me.member.name], [requestId, "in", roomId, memberId, "player", "Quinn"]);

    const session = await k.sessionRow(token);
    assert.equal(session?.id, askId, "the same id, now a session");
    assert.equal(session?.user_agent, null, "never the DM's user agent");
    assert.ok(Math.abs((session?.days ?? 0) - 180) < 0.01, "the normal 180 days");
    assert.equal(await k.askRow(token), undefined);
    assert.equal(phone.token, token, "no cookie change");
    assert.equal(dm.token, dmToken, "the DM's own session and cookie unchanged");
    assert.equal((await dm.me(roomId)).role, "dm");
    assert.deepEqual(await k.members(roomId), ["Dungeon Master", "Quinn"]);

    // The requester's own next request fills its user agent in.
    await phone.request("GET", `/api/rooms/${roomId}/me`, undefined, { "user-agent": "Requester phone" });
    assert.equal((await k.sessionRow(token))?.user_agent, "Requester phone");

    // Exact rate events for a let-in: its success and its let-in, besides the ask.
    const ip = ipKey(phone.ip);
    const { rows } = await t.pool.query<{ key: string }>("select key from rate_events where key like $1 or key like $2 order by key", [`%${ip}%`, `ok:room:${roomId}`]);
    assert.deepEqual(rows.map((r) => r.key), [`ask:${roomId}:${ip}`, `ask:ip:${ip}`, `askin:${roomId}:${ip}`, `ok:ip:${ip}`, `ok:room:${roomId}`]);
  });

  test("a let-in with no wait held and the token warm in the unknown cache: a reopened tab enters, and asking again is already_in", async () => {
    const { dm, roomId } = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    // Warm the cache with the token's miss.
    assert.equal((await phone.me(roomId)).status, 403);
    assert.equal((await k.letIn(dm, roomId, id)).statusCode, 200);
    assert.equal((await phone.me(roomId)).role, "player", "CACHE-HEALS");
    const again = await phone.post(`/api/rooms/${roomId}/join-requests`, { name: "Quinn", color: "#3e8ef7" });
    assert.equal(again.statusCode, 409);
    assert.equal(k.error(again), "already_in");
    assert.equal((await k.list(dm, roomId)).requests.length, 0);
  });

  test("an ask paused after both its lookups missed, while a let-in promotes its token, finds the session and mints no replacement", async () => {
    const { dm, roomId } = await k.room("ask");
    const other = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const token = phone.token;
    // Pause the second room's ask between its session lookup and its ask token lookup.
    const pause = pauseQuery(t.pool, (sql) => sql.startsWith("select id from ask_sessions where token_hash"));
    try {
      const ask = phone.post(`/api/rooms/${other.roomId}/join-requests`, { name: "Quinn", color: "#3e8ef7" });
      await pause.reached;
      assert.equal((await k.letIn(dm, roomId, id)).statusCode, 200);
      pause.go();
      const res = await ask;
      assert.equal(res.statusCode, 201, res.body);
    } finally {
      pause.restore();
    }
    assert.equal(phone.token, token, "NO-REPLACEMENT");
    const mine = await phone.get(`/api/rooms/${other.roomId}/join-requests/mine`);
    assert.equal(mine.statusCode, 200);
    // That request follows the session, so the second room's let-in lands on it.
    const second = mine.json<{ requestId: string }>().requestId;
    assert.equal((await k.letIn(other.dm, other.roomId, second)).statusCode, 200);
    assert.equal((await phone.me(other.roomId)).role, "player");
    assert.equal((await phone.me(roomId)).role, "player");
  });

  test("the same room: an ask paused after its lookups missed while a let-in promotes its token is already_in, with no replacement cookie", async () => {
    const { dm, roomId } = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const token = phone.token;
    const pause = pauseQuery(t.pool, (sql) => sql.startsWith("select id from ask_sessions where token_hash"));
    let res;
    try {
      const ask = phone.post(`/api/rooms/${roomId}/join-requests`, { name: "Quinn", color: "#3e8ef7" });
      await pause.reached;
      assert.equal((await k.letIn(dm, roomId, id)).statusCode, 200);
      pause.go();
      res = await ask;
    } finally {
      pause.restore();
    }
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(k.error(res), "already_in");
    assert.equal(phone.token, token, "NO-REPLACEMENT");
    assert.equal((await phone.me(roomId)).role, "player");
  });

  test("an ask from a device signed in to another room mints no token, and its grant lands on that session", async () => {
    const elsewhere = await k.room("password");
    const { dm, roomId } = await k.room("ask_only");
    const phone = t.client();
    await phone.join(elsewhere.roomId, "Quinn");
    const token = phone.token;
    const id = await k.asked(phone, roomId);
    assert.equal(phone.token, token);
    assert.equal(await k.askRow(token), undefined);
    assert.equal((await k.letIn(dm, roomId, id)).statusCode, 200);
    assert.equal((await phone.me(roomId)).role, "player");
    assert.equal((await phone.me(elsewhere.roomId)).role, "player");
  });

  test("a password join, a DM link and a new room adopt the token, and a request in another room still lets in onto that id", async () => {
    const a = await k.room("ask");
    const b = await k.room("ask");
    for (const path of ["join", "dm", "create"] as const) {
      const phone = t.client();
      const first = await k.asked(phone, a.roomId);
      const second = await k.asked(phone, b.roomId);
      const askId = (await k.askRow(phone.token))?.id;
      // A held wait first, so the unknown cache holds the token's miss.
      await phone.get(`/api/rooms/${b.roomId}/me`);
      if (path === "join") {
        await phone.join(a.roomId, "Quinn");
        assert.equal(k.error(await k.letIn(a.dm, a.roomId, first)), "request_gone", "the device got in another way");
      } else if (path === "dm") {
        assert.equal((await phone.post(`/api/rooms/${a.roomId}/dm`, { key: a.dmKey, name: "Co-DM" })).statusCode, 200);
      } else {
        await phone.createRoom("My own");
      }
      assert.equal((await k.sessionRow(phone.token))?.id, askId, `${path}: the same id`);
      const res = await k.letIn(b.dm, b.roomId, second);
      assert.equal(res.statusCode, 200, `${path}: ${res.body}`);
      assert.equal((await phone.me(b.roomId)).role, "player");
    }
  });

  test("two rooms letting in one token at once: one promotes, the other grants on the session", async () => {
    const a = await k.room("ask");
    const b = await k.room("ask");
    const phone = t.client();
    const ra = await k.asked(phone, a.roomId);
    const rb = await k.asked(phone, b.roomId);
    const [x, y] = await Promise.all([k.letIn(a.dm, a.roomId, ra), k.letIn(b.dm, b.roomId, rb)]);
    assert.deepEqual([x.statusCode, y.statusCode], [200, 200], `${x.body} ${y.body}`);
    assert.equal((await phone.me(a.roomId)).role, "player");
    assert.equal((await phone.me(b.roomId)).role, "player");
    const { rows } = await t.pool.query("select 1 from sessions where token_hash = $1", [sha256(phone.token ?? "")]);
    assert.equal(rows.length, 1);
  });

  test("an ask renewing a token while a let-in promotes it touches nothing: the session keeps its 180 days", async () => {
    const a = await k.room("ask");
    const b = await k.room("ask");
    const phone = t.client();
    const ra = await k.asked(phone, a.roomId);
    const unlock = await t.app.joinRequests.locks.acquire([`ip:${ipKey(phone.ip)}`]);
    const ask = phone.post(`/api/rooms/${b.roomId}/join-requests`, { name: "Quinn", color: "#3e8ef7" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await k.letIn(a.dm, a.roomId, ra)).statusCode, 200);
    unlock();
    assert.equal((await ask).statusCode, 201);
    assert.ok(Math.abs(((await k.sessionRow(phone.token))?.days ?? 0) - 180) < 0.01);
  });

  test("a table display paired on a device with a waiting ask gets a new display session, the ask token untouched", async () => {
    const { dm, roomId } = await k.room("ask");
    const tv = t.client();
    await k.asked(tv, roomId);
    const token = tv.token;
    const askId = (await k.askRow(token))?.id;
    const code = (await dm.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    const res = await tv.request("POST", "/api/display/redeem", { code });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await k.askRow(token))?.id, askId);
    assert.equal(await k.sessionRow(token), undefined);
  });

  test("let in as an existing player: that member's grant, no new member and no join line", async () => {
    const { dm, roomId } = await k.room("ask");
    const pipId = await t.client().join(roomId, "Pip");
    const newPhone = t.client();
    const id = await k.asked(newPhone, roomId, "Pip");
    assert.deepEqual((await k.list(dm, roomId)).players.map((p) => p.name), ["Pip"]);
    const res = await k.letIn(dm, roomId, id, { kind: "member", memberId: pipId });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await newPhone.me(roomId)).memberId, pipId);
    assert.deepEqual(await k.members(roomId), ["Dungeon Master", "Pip"]);
  });

  test("a former DM is never offered and never accepted as the carry-on pick, and the request goes back to waiting", async () => {
    const { dm, roomId, dmKey } = await k.room("ask");
    const bram = t.client();
    const claim = await bram.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Bram" });
    const bramId = claim.json<{ memberId: string }>().memberId;
    assert.equal((await dm.delete(`/api/rooms/${roomId}/dm/members/${bramId}`)).statusCode, 204);
    const id = await k.asked(t.client(), roomId, "Bram");
    assert.deepEqual((await k.list(dm, roomId)).players, []);
    const res = await k.letIn(dm, roomId, id, { kind: "member", memberId: bramId });
    assert.equal(res.statusCode, 403);
    assert.equal(k.error(res), "not_a_player");
    assert.deepEqual((await k.list(dm, roomId)).requests.map((r) => r.id), [id]);
  });

  test("a full room, or a removed carry-on member, refuses the let-in and keeps the request waiting", async () => {
    const { dm, roomId } = await k.room("ask");
    const pipId = await t.client().join(roomId, "Pip");
    const id = await k.asked(t.client(), roomId);
    assert.equal((await dm.delete(`/api/rooms/${roomId}/members/${pipId}`)).statusCode, 204);
    const removed = await k.letIn(dm, roomId, id, { kind: "member", memberId: pipId });
    assert.equal(k.error(removed), "member_removed");
    const addMember = t.gateway.addMember;
    t.gateway.addMember = async () => {
      const { RoomFullError } = await import("../rooms/gateway.ts");
      throw new RoomFullError();
    };
    try {
      const full = await k.letIn(dm, roomId, id);
      assert.equal(full.statusCode, 409);
      assert.equal(k.error(full), "room_full");
    } finally {
      t.gateway.addMember = addMember;
    }
    assert.deepEqual(await k.members(roomId), ["Dungeon Master"]);
    assert.deepEqual((await k.list(dm, roomId)).requests.map((r) => r.id), [id]);
  });

  test("a kick between a let-in's new member and its grant answers first, and the kicked device never gets in", async () => {
    const { dm, roomId } = await k.room("ask_only");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const addMember = t.gateway.addMember;
    let kicked: number | undefined;
    t.gateway.addMember = async (room, member) => {
      await addMember.call(t.gateway, room, member);
      // The DM reads "Quinn joins the room." and kicks at once, before the grant is written.
      kicked = (await dm.delete(`/api/rooms/${room}/members/${member.id}/grants`)).statusCode;
    };
    let res;
    try {
      res = await k.letIn(dm, roomId, id);
    } finally {
      t.gateway.addMember = addMember;
    }
    assert.equal(kicked, 204);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(k.error(res), "member_removed");
    assert.equal((await phone.me(roomId)).status, 403, "KICK-ORDERED: no grant landed after the kick answered");
    for (let i = 0; i < 50 && (await k.members(roomId)).length > 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await k.members(roomId), ["Dungeon Master"], "its grant was never written, so its member comes off");
    assert.deepEqual((await k.list(dm, roomId)).requests.map((r) => r.id), [id], "and the request waits for the DM again");
  });

  test("a kick while a carry-on let-in's grant is being written waits for that grant, then deletes it", async () => {
    const { dm, roomId } = await k.room("ask");
    const pipId = await t.client().join(roomId, "Pip");
    const phone = t.client();
    const id = await k.asked(phone, roomId, "Pip");
    const pause = pauseTxStatement(t.pool, (sql) => sql.includes("insert into grants"));
    const order: string[] = [];
    try {
      const letIn = k.letIn(dm, roomId, id, { kind: "member", memberId: pipId }).then((r) => (order.push("let-in"), r));
      await pause.reached;
      const kick = dm.delete(`/api/rooms/${roomId}/members/${pipId}/grants`).then((r) => (order.push("kick"), r));
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(order, [], "the kick waits on the room lock the grant holds");
      pause.go();
      const [granted, revoked] = await Promise.all([letIn, kick]);
      assert.equal(granted.statusCode, 200, granted.body);
      assert.equal(revoked.statusCode, 204, revoked.body);
    } finally {
      pause.go();
      pause.restore();
    }
    assert.equal((await phone.me(roomId)).status, 403, "KICK-ORDERED: the grant committed first and the kick deleted it");
  });

  test("a member in flight is absent from continue-as and the carry-on list, and refused as not_a_player", async () => {
    const { dm, roomId } = await k.room("ask");
    const id = await k.asked(t.client(), roomId, "Quinn");
    const other = await k.asked(t.client(), roomId, "Rook");
    const addMember = t.gateway.addMember;
    let land!: () => void;
    const landed = new Promise<void>((r) => (land = r));
    let flying: string | undefined;
    t.gateway.addMember = async (room, member) => {
      flying = member.id;
      await addMember.call(t.gateway, room, member);
      await landed;
    };
    try {
      const pending = await k.letIn(dm, roomId, id);
      assert.equal(pending.statusCode, 202, pending.body);
      assert.deepEqual(pending.json(), { memberId: flying, pending: true });
      assert.deepEqual((await k.list(dm, roomId)).players, []);
      const steal = await k.letIn(dm, roomId, other, { kind: "member", memberId: flying ?? "" });
      assert.equal(k.error(steal), "not_a_player");
      const phone = t.client();
      const step1 = await phone.post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
      assert.deepEqual(step1.json<{ players: unknown[] }>().players, []);
      const cont = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket: step1.json<{ ticket: string }>().ticket, memberId: flying });
      assert.equal(k.error(cont), "not_a_player");
    } finally {
      land();
      t.gateway.addMember = addMember;
    }
  });

  test("two DM devices letting in at once, or a let-in against a turn away: exactly one wins", async () => {
    const { dm, roomId, dmKey } = await k.room("ask");
    const coDm = t.client();
    await coDm.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Mara" });
    const id = await k.asked(t.client(), roomId);
    const [a, b] = await Promise.all([k.letIn(dm, roomId, id), k.letIn(coDm, roomId, id)]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal(k.error(a.statusCode === 409 ? a : b), "request_answered");
    const second = await k.asked(t.client(), roomId, "Rook");
    const [turned, late] = await Promise.all([coDm.post(`/api/rooms/${roomId}/join-requests/turn-away`, { ids: [second] }), k.letIn(dm, roomId, second)]);
    assert.equal(turned.statusCode, 204);
    assert.ok(late.statusCode === 200 || k.error(late) === "request_answered");
  });

  test("a wrong session, an invented token or another room's id is request_gone, and the held wait stays held", async () => {
    const { dm, roomId } = await k.room("ask");
    const other = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const held = k.wait(phone, roomId, id);
    const stranger = t.client();
    stranger.token = randomToken();
    for (const [c, r] of [[stranger, roomId], [t.client(), roomId], [phone, other.roomId]] as const) {
      assert.equal(k.error(await k.wait(c, r, id)), "request_gone");
      assert.equal(k.error(await c.delete(`/api/rooms/${r}/join-requests/${id}`)), "request_gone");
      assert.equal((await c.get(`/api/rooms/${r}/join-requests/mine`)).statusCode, 204, "nothing, and no error, for a device with no request here");
    }
    assert.equal((await k.letIn(other.dm, other.roomId, id)).statusCode, 404);
    await dm.post(`/api/rooms/${roomId}/join-requests/turn-away`, { ids: [id] });
    assert.equal((await held).json<{ state: string }>().state, "turned_away", "the original wait was never displaced");
  });

  test("cancel ends the request, and a cancelled request is gone to its own device", async () => {
    const { dm, roomId } = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const held = k.wait(phone, roomId, id);
    assert.equal((await phone.delete(`/api/rooms/${roomId}/join-requests/${id}`)).statusCode, 204);
    assert.equal(k.error(await held), "request_gone");
    assert.equal((await phone.get(`/api/rooms/${roomId}/join-requests/mine`)).statusCode, 204);
    assert.equal((await k.list(dm, roomId)).requests.length, 0);
  });

  test("players and table displays get 403 from the DM list and the answers", async () => {
    const { dm, roomId } = await k.room("ask");
    const player = t.client();
    await player.join(roomId, "Pip");
    const id = await k.asked(t.client(), roomId);
    for (const res of [
      await player.get(`/api/rooms/${roomId}/join-requests`),
      await k.letIn(player, roomId, id),
      await player.post(`/api/rooms/${roomId}/join-requests/turn-away`, { ids: [id] }),
      await player.post(`/api/rooms/${roomId}/join-mode`, { mode: "password" }),
      await t.client().get(`/api/rooms/${roomId}/join-requests`),
    ]) {
      assert.equal(res.statusCode, 403, res.body);
    }
    assert.equal((await k.list(dm, roomId)).requests.length, 1);
  });

  test("deleting the room while a request waits answers the wait request_gone", async () => {
    const { dm, roomId } = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const held = k.wait(phone, roomId, id);
    assert.equal((await dm.delete(`/api/rooms/${roomId}`, { name: "Test room" })).statusCode, 204);
    assert.equal(k.error(await held), "request_gone");
  });

  test("the pool exhausted at the grant's checkout is busy, with the member removed and the request back to waiting", async () => {
    const { dm, roomId } = await k.room("ask");
    const id = await k.asked(t.client(), roomId);
    const addMember = t.gateway.addMember;
    const held: pg.PoolClient[] = [];
    t.gateway.addMember = async (room, member) => {
      await addMember.call(t.gateway, room, member);
      // Every connection taken once the member is in, as a stalled database
      // would, and given back after the grant's 300 ms checkout bound, so the
      // undo that follows can run.
      while (held.length < 10) held.push(await t.pool.connect());
      setTimeout(() => {
        for (const c of held) c.release();
      }, 600);
    };
    let res;
    const started = Date.now();
    try {
      res = await k.letIn(dm, roomId, id);
    } finally {
      t.gateway.addMember = addMember;
    }
    assert.ok(Date.now() - started >= 300, "it waited out the checkout bound");
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(k.error(res), "busy");
    for (let i = 0; i < 50 && (await k.members(roomId)).length > 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await k.members(roomId), ["Dungeon Master"]);
    assert.deepEqual((await k.list(dm, roomId)).requests.map((r) => r.id), [id]);
  });

  test("a lost COMMIT answer with the grant committed, then a kick before the reconcile reads it: the request ends as gone and the member stays", async () => {
    const { dm, roomId } = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    // Warm the unknown cache with the token's miss.
    assert.equal((await phone.me(roomId)).status, 403);
    let kickedFor: string | undefined;
    const restore = loseGrantCommit(t.pool, async () => {
      // The kick lands before anyone reads the outcome back.
      kickedFor = (await t.pool.query<{ member_id: string }>("select member_id from grants where room_id = $1 and role = 'player'", [roomId])).rows[0]?.member_id;
      await t.pool.query("delete from grants where room_id = $1 and role = 'player'", [roomId]);
    });
    let res;
    try {
      res = await k.letIn(dm, roomId, id);
    } finally {
      restore();
    }
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((await k.list(dm, roomId)).requests.length, 0, "the request left the DM's list");
    assert.ok(kickedFor);
    assert.deepEqual(await k.members(roomId), ["Dungeon Master", "Quinn"], "UNKNOWN-ENDS: the member and anything it drew are kept");
    // The promotion committed: the cache was cleared on the unknown outcome, so the device reads as the session it now is.
    assert.equal((await k.sessionRow(phone.token))?.id !== undefined, true);
    // Authenticated as the promoted session at once, despite the warm cache:
    // a ticket check, not no_session.
    const asSession = await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket: randomToken(), name: "Quinn", color: "#112233" });
    assert.equal(k.error(asSession), "bad_ticket");
  });

  test("a lost COMMIT answer whose grant committed: the reconcile finds it, and GET /me enters at once", async () => {
    const { dm, roomId } = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    assert.equal((await phone.me(roomId)).status, 403);
    const restore = loseGrantCommit(t.pool, async () => undefined);
    let res;
    try {
      res = await k.letIn(dm, roomId, id);
    } finally {
      restore();
    }
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await phone.me(roomId)).role, "player", "CACHE-HEALS after a lost COMMIT answer");
  });
});

describe("join requests: modes", () => {
  let t: TestApp;
  let k: ReturnType<typeof kit>;
  before(async () => {
    t = await startTestApp();
    k = kit(t);
  });
  after(() => t.close());

  async function hashes(roomId: string) {
    const { rows } = await t.pool.query<{ join_mode: string; player_pw_hash: string; player_pw_hash_held: string | null }>("select join_mode, player_pw_hash, player_pw_hash_held from rooms where id = $1", [roomId]);
    return rows[0];
  }

  test("With the password refuses asks, and switching to it ends every waiting request as closed", async () => {
    const { dm, roomId } = await k.room("password");
    const refused = await t.client().post(`/api/rooms/${roomId}/join-requests`, { name: "Quinn", color: "#3e8ef7" });
    assert.equal(refused.statusCode, 403);
    assert.equal(k.error(refused), "asks_off");
    assert.equal(refused.cookies.length, 0, "no token for a refused ask");
    await k.setMode(dm, roomId, "ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const held = k.wait(phone, roomId, id);
    await k.setMode(dm, roomId, "password");
    assert.equal((await held).json<{ state: string }>().state, "closed");
    assert.equal((await phone.get(`/api/rooms/${roomId}/join-requests/mine`)).json<{ state: string }>().state, "closed");
  });

  test("switching between the asking modes keeps every request, and a let-in that then fails goes back to waiting", async () => {
    const { dm, roomId } = await k.room("ask");
    const id = await k.asked(t.client(), roomId);
    await k.setMode(dm, roomId, "ask_only");
    await k.setMode(dm, roomId, "ask");
    assert.deepEqual((await k.list(dm, roomId)).requests.map((r) => r.id), [id]);
    const addMember = t.gateway.addMember;
    t.gateway.addMember = async (room, member) => {
      await addMember.call(t.gateway, room, member);
      await t.pool.query("update rooms set player_epoch = player_epoch where id = $1", [room]);
      throw new Error("actor fault");
    };
    try {
      assert.equal((await k.letIn(dm, roomId, id)).statusCode, 503);
    } finally {
      t.gateway.addMember = addMember;
    }
    assert.deepEqual((await k.list(dm, roomId)).requests.map((r) => r.id), [id]);
  });

  test("the same switch to Only by asking twice, at once from two DMs, and on a deleted room: one transition, the real hash held", async () => {
    const { dm, roomId, dmKey } = await k.room("password");
    const coDm = t.client();
    await coDm.post(`/api/rooms/${roomId}/dm`, { key: dmKey, name: "Mara" });
    const real = (await hashes(roomId))?.player_pw_hash;
    const signal = t.gateway.joinRequestsChanged;
    let signals = 0;
    t.gateway.joinRequestsChanged = () => void signals++;
    let answers;
    try {
      answers = await Promise.all([dm, coDm, dm].map((c) => c.post(`/api/rooms/${roomId}/join-mode`, { mode: "ask_only" })));
    } finally {
      t.gateway.joinRequestsChanged = signal;
    }
    for (const a of answers) assert.deepEqual(a.json(), { mode: "ask_only" });
    assert.equal(signals, 1, "one transition signals, the identical switches do not");
    assert.deepEqual(await hashes(roomId), { join_mode: "ask_only", player_pw_hash: "ask-only", player_pw_hash_held: real });
    await k.setMode(dm, roomId, "ask");
    assert.deepEqual(await hashes(roomId), { join_mode: "ask", player_pw_hash: real, player_pw_hash_held: null });
    // The password works again once out of Only by asking.
    await t.client().join(roomId, "Pip");
    assert.equal((await dm.delete(`/api/rooms/${roomId}`, { name: "Test room" })).statusCode, 204);
    assert.equal((await dm.post(`/api/rooms/${roomId}/join-mode`, { mode: "ask" })).statusCode, 403, "no grant in a deleted room");
  });

  test("entering Only by asking drops every outstanding ticket", async () => {
    const { dm, roomId } = await k.room("password");
    const phone = t.client();
    const { ticket } = (await phone.post(`/api/rooms/${roomId}/join`, { password: PASSWORD })).json<{ ticket: string }>();
    await k.setMode(dm, roomId, "ask_only");
    await k.setMode(dm, roomId, "password");
    assert.equal(k.error(await phone.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Quinn", color: "#112233" })), "bad_ticket");
  });

  test("leaving Only by asking with no held password is no_password, and nothing changes", async () => {
    const { dm, roomId } = await k.room("ask_only");
    await t.pool.query("update rooms set player_pw_hash_held = null where id = $1", [roomId]);
    const res = await dm.post(`/api/rooms/${roomId}/join-mode`, { mode: "ask" });
    assert.equal(res.statusCode, 409);
    assert.equal(k.error(res), "no_password");
    assert.equal((await hashes(roomId))?.join_mode, "ask_only");
  });
});

describe("join requests: limits and the challenge", () => {
  const TURNSTILE = { TURNSTILE_SECRET: "test-secret", TURNSTILE_SITE_KEY: "site-key" };
  let t: TestApp;
  let k: ReturnType<typeof kit>;
  let cloudflare: MockAgent;
  let cloudflareDown = false;
  before(async () => {
    t = await startTestApp({ env: TURNSTILE });
    k = kit(t);
    cloudflare = new MockAgent();
    cloudflare.disableNetConnect();
    cloudflare
      .get("https://challenges.cloudflare.com")
      .intercept({ path: "/turnstile/v0/siteverify", method: "POST" })
      .reply((opts) => (cloudflareDown ? { statusCode: 500, data: "" } : { statusCode: 200, data: { success: new URLSearchParams(String(opts.body)).get("response") === "solved" } }))
      .persist();
    setTurnstileDispatcherForTests(cloudflare);
  });
  after(async () => {
    setTurnstileDispatcherForTests(null);
    await cloudflare.close();
    await t.close();
  });

  async function room(mode: JoinMode = "ask") {
    const dm = t.client();
    const res = await dm.post("/api/rooms", { name: "Test room", playerPassword: PASSWORD, dmName: "Dungeon Master", turnstileToken: "solved" });
    const { roomId, dmLink } = res.json<{ roomId: string; dmLink: string }>();
    t.track(roomId);
    await k.setMode(dm, roomId, mode);
    return { dm, roomId, dmKey: dmLink.split("#dm=")[1] ?? "" };
  }
  const ask = (c: TestClient, roomId: string, turnstileToken?: string) =>
    c.post(`/api/rooms/${roomId}/join-requests`, { name: "Quinn", color: "#3e8ef7", ...(turnstileToken ? { turnstileToken } : {}) });
  async function seed(key: string, n: number): Promise<void> {
    await t.pool.query("insert into rate_events (key, at) select $1, now() from generate_series(1, $2)", [key, n]);
  }

  test("the 9th waiting ask from one address is asks_full with no Retry-After, and so is the 51st in a room", async () => {
    const { roomId } = await room();
    const ip = randomIp();
    for (let i = 0; i < 8; i++) assert.equal((await ask(t.client(ip), roomId)).statusCode, 201);
    const ninth = await ask(t.client(ip), roomId, "solved");
    assert.equal(ninth.statusCode, 429);
    assert.equal(k.error(ninth), "asks_full");
    assert.equal(ninth.headers["retry-after"], undefined);
    // Past the room's 20th ask of the hour each one carries a solved check.
    for (let i = 0; i < 42; i++) assert.equal((await ask(t.client(), roomId, "solved")).statusCode, 201);
    const full = await ask(t.client(), roomId, "solved");
    assert.equal(k.error(full), "asks_full");
  });

  test("the 31st ask from one address in an hour is rate_limited, and allowed after 5 let-ins", async () => {
    const { roomId } = await room();
    const ip = randomIp();
    await seed(`ask:${roomId}:${ipKey(ip)}`, 30);
    const over = await ask(t.client(ip), roomId);
    assert.equal(over.statusCode, 429);
    assert.equal(k.error(over), "rate_limited");
    assert.ok(Number(over.headers["retry-after"]) > 3000);
    await seed(`askin:${roomId}:${ipKey(ip)}`, 5);
    assert.equal((await ask(t.client(ip), roomId)).statusCode, 201);
    await seed(`ask:ip:${ipKey(ip)}`, 60);
    assert.equal(k.error(await ask(t.client(ip), roomId)), "rate_limited", "60 an hour across rooms");
  });

  test("concurrent asks spanning the room's 20th of the hour: every one admitted past it carried a solved check", async () => {
    const { dm, roomId } = await room();
    await seed(`ask:room:${roomId}`, 15);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => ask(t.client(), roomId, i % 2 === 0 ? "solved" : undefined)));
    const admitted = results.filter((r) => r.statusCode === 201).length;
    const required = results.filter((r) => k.error(r) === "turnstile_required").length;
    assert.equal(admitted + required, 12);
    // 5 places before the 20th, and the 6 that carried a token after it.
    assert.ok(admitted >= 5 && admitted <= 11, String(admitted));
    const { rows } = await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [`ask:room:${roomId}`]);
    assert.equal(rows[0]?.n, 15 + admitted);
    assert.equal((await k.list(dm, roomId)).challenged, true);
    assert.equal((await k.list(dm, roomId)).requests.length, admitted, "RESERVE: every refused ask gave its place back");
    cloudflareDown = true;
    try {
      const down = await ask(t.client(), roomId, "solved");
      assert.equal(down.statusCode, 503);
      assert.equal(k.error(down), "turnstile_unavailable");
    } finally {
      cloudflareDown = false;
    }
  });

  test("after a turn away: the same token is held, a fresh, invented or other-room token needs Turnstile, an older real session does not", async () => {
    const { dm, roomId } = await room();
    const ip = randomIp();
    // A table phone with a real session from before the hold.
    const tablePhone = t.client(ip);
    const elsewhere = await room("password");
    await tablePhone.join(elsewhere.roomId, "Pip");
    await new Promise((r) => setTimeout(r, 20));
    const phone = t.client(ip);
    const id = await k.asked(phone, roomId);
    assert.equal((await dm.post(`/api/rooms/${roomId}/join-requests/turn-away`, { ids: [id] })).statusCode, 204);

    const again = await ask(phone, roomId);
    assert.equal(again.statusCode, 429);
    assert.equal(k.error(again), "asked_recently");
    assert.ok(Math.abs(Number(again.headers["retry-after"]) - 900) <= 2);

    const fresh = t.client(ip);
    assert.equal(k.error(await ask(fresh, roomId)), "turnstile_required", "no cookie");
    const invented = t.client(ip);
    invented.token = randomToken();
    assert.equal(k.error(await ask(invented, roomId)), "turnstile_required", "an invented token");
    const otherRoom = t.client(ip);
    const third = await room();
    await k.asked(otherRoom, third.roomId);
    assert.equal(k.error(await ask(otherRoom, roomId)), "turnstile_required", "a token from another room");
    assert.equal((await ask(otherRoom, roomId, "solved")).statusCode, 201, "the other device may ask once it passes the check");
    assert.equal((await ask(tablePhone, roomId)).statusCode, 201, "a real session older than the hold needs no check");
    // The hold lives in the database too, so a restart forgets nothing.
    const { rows } = await t.pool.query("select key from rate_events where key in ($1, $2)", [`askno:${roomId}:${(await k.askRow(phone.token))?.id}`, `asknoip:${roomId}:${ipKey(ip)}`]);
    assert.equal(rows.length, 2);
  });

  test("an ask token's requests are counted by address, at 120 a minute, never as a session", async () => {
    const { roomId } = await room();
    const phone = t.client();
    await k.asked(phone, roomId);
    let limited = false;
    for (let i = 0; i < 125 && !limited; i++) limited = (await phone.get(`/api/rooms/${roomId}/join-requests/mine`)).statusCode === 429;
    assert.equal(limited, true);
  });
});

describe("join requests: shutdown", () => {
  test("closing with a held wait ends in under a second, a disconnected wait leaves nothing behind, and closing twice is fine", async () => {
    const t = await startTestApp();
    const k = kit(t);
    const { roomId } = await k.room("ask");
    const phone = t.client();
    const id = await k.asked(phone, roomId);
    const second = t.client();
    const secondId = await k.asked(second, roomId);
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    const address = t.app.server.address();
    assert.ok(address && typeof address === "object");
    const url = (rid: string) => `http://127.0.0.1:${address.port}/api/rooms/${roomId}/join-requests/${rid}/wait`;
    const headers = { "content-type": "application/json", "sec-fetch-site": "same-origin", origin: t.config.publicOrigin };
    // One wait the page abandons, one still held at shutdown.
    const gone = new AbortController();
    const abandoned = fetch(url(secondId), { method: "POST", body: "{}", headers: { ...headers, cookie: `rvtt=${second.token}` }, signal: gone.signal }).catch(() => null);
    const held = fetch(url(id), { method: "POST", body: "{}", headers: { ...headers, cookie: `rvtt=${phone.token}` } });
    await new Promise((r) => setTimeout(r, 100));
    gone.abort();
    await abandoned;
    const started = Date.now();
    await t.app.close();
    const answer = await held;
    assert.ok(Date.now() - started < 1000, `closed in ${Date.now() - started} ms`);
    assert.deepEqual(await answer.json(), { requestId: id, state: "waiting" });
    await t.app.close();
    await t.close();
  });
});

