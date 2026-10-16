import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import type { AssetKind } from "../assets/kinds.ts";
import { variantPath } from "../assets/store.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { ipKey } from "../auth/ipKey.ts";
import { startEngine, type Engine, type TestClient } from "../rooms/testing.ts";

/**
 * Table displays (docs/design-v1-dm-tools.md 3.1) against the real server:
 * codes, display sessions and their cookie, the display socket, its
 * lifetime, and its image route.
 */

const PASSWORD = "owlbear-druid-wand";

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

/** Mints a code as the DM device. */
async function mint(dm: TestClient, roomId: string): Promise<string> {
  const res = await dm.post(`/api/rooms/${roomId}/display/code`);
  assert.equal(res.statusCode, 201, res.body);
  return res.json<{ code: string }>().code;
}

/** A fresh device that redeems a code and becomes a table display. */
async function pairDisplay(t: Engine, dm: TestClient, roomId: string, ip?: string): Promise<TestClient> {
  const tv = t.client(ip);
  const res = await tv.post("/api/display/redeem", { code: formatDisplayCode(await mint(dm, roomId)) });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { roomId });
  assert.ok(tv.displayToken);
  assert.equal(tv.token, undefined, "redeeming never makes a room session");
  return tv;
}

async function displayMember(t: Engine, tv: TestClient, roomId: string): Promise<string> {
  const res = await tv.get(`/api/rooms/${roomId}/display/me`);
  assert.equal(res.statusCode, 200, res.body);
  return res.json<{ memberId: string }>().memberId;
}

async function displaySessionId(t: Engine, memberId: string): Promise<string> {
  const { rows } = await t.pool.query<{ session_id: string }>("select session_id from grants where member_id = $1", [memberId]);
  return rows[0]!.session_id;
}

async function expiresIn(t: Engine, sessionId: string): Promise<number> {
  const { rows } = await t.pool.query<{ s: number }>("select extract(epoch from expires_at - now())::float8 as s from sessions where id = $1", [sessionId]);
  return rows[0]?.s ?? Number.NaN;
}

const DAY = 24 * 3600;

/**
 * Holds the first transaction statement that matches `pattern` until
 * released, so a test can run another request at exactly that point.
 * Only transactions take clients through the promise form of `connect`.
 */
function stallStatement(pool: pg.Pool, pattern: RegExp): { reached: Promise<void>; release: () => void; restore: () => void } {
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const seen = new Promise<void>((resolve) => (reached = resolve));
  let fired = false;
  (pool as { connect: unknown }).connect = (cb?: unknown) => {
    if (typeof cb === "function") return (connect as (cb: unknown) => void)(cb);
    return connect().then((client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== "query") return Reflect.get(target, prop, receiver);
          return async (...args: unknown[]) => {
            if (!fired && typeof args[0] === "string" && pattern.test(args[0])) {
              fired = true;
              reached();
              await gate;
            }
            return query(...args);
          };
        },
      });
    });
  };
  return { reached: seen, release, restore: () => ((pool as { connect: unknown }).connect = connect) };
}

describe("display codes and sessions", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("minting takes the DM's room cookie, and redeeming takes no cookie at all", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Displays");
    const player = t.client();
    await player.join(roomId, "Thorn");
    assert.equal((await player.post(`/api/rooms/${roomId}/display/code`)).statusCode, 403);
    assert.equal((await t.client().post(`/api/rooms/${roomId}/display/code`)).statusCode, 403);

    const minted = await dm.post(`/api/rooms/${roomId}/display/code`);
    const body = minted.json<{ code: string; link: string; expiresAt: string }>();
    assert.match(body.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
    assert.equal(body.link, `/display#code=${body.code}`);
    const minutes = (Date.parse(body.expiresAt) - Date.now()) / 60_000;
    assert.ok(minutes > 9 && minutes <= 10);

    const tv = t.client();
    // Typed with a remote: lowercase, grouped, an O for a zero.
    const typed = formatDisplayCode(body.code).toLowerCase().replaceAll("0", "o");
    const res = await tv.post("/api/display/redeem", { code: typed });
    assert.equal(res.statusCode, 200, res.body);
    const cookie = res.cookies.find((c) => c.name === "rvtt-display");
    assert.ok(cookie?.httpOnly && cookie.sameSite === "Strict" && cookie.path === "/");
    const { rows } = await t.pool.query<{ purpose: string; days: number }>(
      "select purpose, extract(epoch from expires_at - now())::float8 / 86400 as days from sessions where token_hash = sha256($1::bytea)",
      [Buffer.from(tv.displayToken!)],
    );
    assert.equal(rows[0]?.purpose, "display");
    assert.ok(rows[0]!.days > 29.9 && rows[0]!.days <= 30);

    const me = await tv.get(`/api/rooms/${roomId}/display/me`);
    assert.equal(me.statusCode, 200);
    const mine = me.json<{ roomId: string; roomName: string; role: string; memberId: string }>();
    assert.equal(mine.role, "display");
    assert.equal(mine.roomName, "Displays");
    assert.match(mine.memberId, /^display:[A-Za-z0-9_-]{12}$/);
  });

  test("a code redeems once, and an expired, used or pre-password-change code is refused", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Once");
    const other = await dm.createRoom("Other room");
    const code = await mint(dm, roomId);
    assert.equal((await t.client().post("/api/display/redeem", { code })).statusCode, 200);
    assert.equal((await t.client().post("/api/display/redeem", { code })).statusCode, 403);

    const expired = await mint(dm, roomId);
    await t.pool.query("update display_codes set expires_at = now() - interval '1 second' where token_hash = sha256($1::bytea)", [Buffer.from(expired)]);
    const refused = await t.client().post("/api/display/redeem", { code: expired });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json<{ error: string }>().error, "bad_code");

    const stale = await mint(dm, roomId);
    assert.equal((await dm.post(`/api/rooms/${roomId}/password`, { password: "griffon-lantern-moss" })).statusCode, 204);
    assert.equal((await t.client().post("/api/display/redeem", { code: stale })).statusCode, 403);

    // A code opens only its own room.
    const tv = await pairDisplay(t, dm, other.roomId);
    assert.equal((await tv.get(`/api/rooms/${roomId}/display/me`)).statusCode, 403);
    await assert.rejects(t.connectDisplay(roomId, tv), /403/);
  });

  test("at most 3 live codes, and the fifth display is refused before its code is spent", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Full");
    const codes = [await mint(dm, roomId), await mint(dm, roomId), await mint(dm, roomId)];
    const fourth = await dm.post(`/api/rooms/${roomId}/display/code`);
    assert.equal(fourth.statusCode, 429);
    assert.equal(fourth.json<{ error: string }>().error, "too_many_codes");
    for (const code of codes) assert.equal((await t.client().post("/api/display/redeem", { code })).statusCode, 200);
    const tv4 = await pairDisplay(t, dm, roomId);

    const fifth = await mint(dm, roomId);
    const res = await t.client().post("/api/display/redeem", { code: fifth });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json<{ error: string }>().error, "displays_full");
    const { rows } = await t.pool.query<{ used_at: Date | null }>("select used_at from display_codes where token_hash = sha256($1::bytea)", [Buffer.from(fifth)]);
    assert.equal(rows[0]?.used_at, null, "the code is still unspent");

    // A TV paired again keeps its own place.
    const again = await tv4.post("/api/display/redeem", { code: fifth });
    assert.equal(again.statusCode, 200, again.body);
  });

  test("a dead code on a full room is a wrong code, never a full room", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Full and dead");
    const spent = await mint(dm, roomId);
    assert.equal((await t.client().post("/api/display/redeem", { code: spent })).statusCode, 200);
    for (let i = 0; i < 3; i++) await pairDisplay(t, dm, roomId);
    const expired = await mint(dm, roomId);
    await t.pool.query("update display_codes set expires_at = now() - interval '1 second' where token_hash = sha256($1::bytea)", [Buffer.from(expired)]);
    const stale = await mint(dm, roomId);
    await t.pool.query("update display_codes set player_epoch = player_epoch - 1 where token_hash = sha256($1::bytea)", [Buffer.from(stale)]);
    const live = await mint(dm, roomId);
    const holder = t.client();
    const failures = async () =>
      (await t.pool.query<{ n: number }>("select count(*)::int as n from rate_events where key = $1", [`dfail:${ipKey(holder.ip)}`])).rows[0]!.n;
    for (const code of [spent, expired, stale]) {
      const res = await holder.post("/api/display/redeem", { code });
      assert.equal(res.statusCode, 403, code);
      assert.equal(res.json<{ error: string }>().error, "bad_code");
    }
    assert.equal(await failures(), 3, "each dead code counts as a wrong one");
    // Only a live code learns that the room is full, and that costs nothing.
    const full = await holder.post("/api/display/redeem", { code: live });
    assert.equal(full.statusCode, 409);
    assert.equal(await failures(), 3);
  });

  test("wrong codes use a bucket of their own, and joins at the same address are untouched", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Typos");
    const tv = t.client();
    for (let i = 0; i < 20; i++) {
      const res = await tv.post("/api/display/redeem", { code: i % 2 === 0 ? "AAAAAAAAAA" : "not a code" });
      assert.equal(res.statusCode, 403);
    }
    const limited = await tv.post("/api/display/redeem", { code: await mint(dm, roomId) });
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers["retry-after"]) >= 1);
    // The same address can still join the room.
    const player = t.client(tv.ip);
    await player.join(roomId, "Thorn");
  });

  test("a DM device revoked while it mints a code leaves no code that redeems, in either order", async () => {
    // The revocation lands between the minter's grant check and its transaction: the minting is refused.
    const first = t.client();
    const a = await first.createRoom("Revoked first");
    const coDm = t.client();
    await coDm.claimDm(a.roomId, a.dmKey);
    const beforeLock = stallStatement(t.pool, /^select player_epoch from rooms where id = \$1 for update$/);
    try {
      const minting = first.post(`/api/rooms/${a.roomId}/display/code`);
      await beforeLock.reached;
      assert.equal((await coDm.post(`/api/rooms/${a.roomId}/dm/replace-link`)).statusCode, 200);
      beforeLock.release();
      const refused = await minting;
      assert.equal(refused.statusCode, 403, refused.body);
      assert.equal(refused.json<{ error: string }>().error, "no_access");
    } finally {
      beforeLock.restore();
    }
    const left = await t.pool.query("select 1 from display_codes where room_id = $1", [a.roomId]);
    assert.equal(left.rowCount, 0);

    // The minter holds its grant first: the sign out waits for its commit, then takes the new code with the device.
    const second = t.client();
    const b = await second.createRoom("Minted first");
    const other = t.client();
    await other.claimDm(b.roomId, b.dmKey);
    const devices = (await second.get(`/api/rooms/${b.roomId}/dm/devices`)).json<{ devices: { sessionId: string; current: boolean }[] }>();
    const minter = devices.devices.find((d) => d.current)!.sessionId;
    const atInsert = stallStatement(t.pool, /^insert into display_codes/);
    try {
      const minting = second.post(`/api/rooms/${b.roomId}/display/code`);
      await atInsert.reached;
      let signedOut = false;
      const signing = other.delete(`/api/rooms/${b.roomId}/dm/devices/${minter}`).then((res) => {
        signedOut = true;
        return res;
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(signedOut, false, "the sign out waits for the minter's grant");
      atInsert.release();
      const minted = await minting;
      assert.equal(minted.statusCode, 201, minted.body);
      assert.equal((await signing).statusCode, 204);
      const res = await t.client().post("/api/display/redeem", { code: minted.json<{ code: string }>().code });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json<{ error: string }>().error, "bad_code");
    } finally {
      atInsert.restore();
    }
  });

  test("a TV shows one room: pairing it with another signs it out of the first", async () => {
    const dmA = t.client();
    const a = await dmA.createRoom("Room A");
    const dmB = t.client();
    const b = await dmB.createRoom("Room B");
    const dmSocket = await t.connect(a.roomId, dmA);
    await dmSocket.snapshot("dm-a");
    const tv = await pairDisplay(t, dmA, a.roomId);
    const sessionId = await displaySessionId(t, await displayMember(t, tv, a.roomId));
    const display = await t.connectDisplay(a.roomId, tv);
    await display.snapshot("tv-a");
    await dmSocket.next("presence", (m) => m.displays === 1);
    // Room A's DM devices list changes with it, so its DM devices are told.
    while (dmSocket.received.some((m) => m.t === "access")) dmSocket.received.splice(dmSocket.received.findIndex((m) => m.t === "access"), 1);

    const res = await tv.post("/api/display/redeem", { code: await mint(dmB, b.roomId) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await display.waitClosed()).code, 4001);
    assert.ok(await dmSocket.next("access"));
    assert.equal((await tv.get(`/api/rooms/${a.roomId}/display/me`)).statusCode, 403);
    assert.equal((await tv.get(`/api/rooms/${b.roomId}/display/me`)).statusCode, 200);
    const grants = await t.pool.query<{ room_id: string }>("select room_id from grants where session_id = $1", [sessionId]);
    assert.deepEqual(grants.rows.map((r) => r.room_id), [b.roomId]);
    await assert.rejects(t.connectDisplay(a.roomId, tv), /403/);
  });

  test("Leave deletes the grant and the session and clears the cookie", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Leave");
    const tv = await pairDisplay(t, dm, roomId);
    const memberId = await displayMember(t, tv, roomId);
    const sessionId = await displaySessionId(t, memberId);
    const socket = await t.connectDisplay(roomId, tv);
    await socket.snapshot("tv");
    const res = await tv.delete("/api/display/session");
    assert.equal(res.statusCode, 204);
    assert.equal(tv.displayToken, undefined);
    assert.equal((await socket.waitClosed()).code, 4001);
    const left = await t.pool.query("select 1 from sessions where id = $1 union all select 1 from grants where session_id = $1", [sessionId]);
    assert.equal(left.rowCount, 0);
  });
});

describe("display sockets", () => {
  let t: Engine;
  before(async () => {
    // A search key, so image search reaches its grant check. The check refuses before anything is fetched.
    t = await startEngine({ rooms: { actor: { grantRecheckMs: 200 } }, env: { SERPAPI_KEY: "itest-never-used" } });
  });
  after(() => t.close());

  async function room(name: string) {
    const dm = t.client();
    const { roomId } = await dm.createRoom(name);
    const dmSocket = await t.connect(roomId, dm);
    const snap = await dmSocket.snapshot("dm");
    const sceneId = (snap.state as { meta: { playerSceneId: string } }).meta.playerSceneId;
    return { dm, roomId, dmSocket, sceneId };
  }

  test("a display's snapshot is a fresh projection for a player who owns nothing, and it is never online", async () => {
    const { dm, roomId, dmSocket, sceneId } = await room("Projection");
    const player = t.client();
    const playerId = await player.join(roomId, "Thorn");
    const owned = tokenOp(sceneId, { kind: "pc", name: "Thorn", ownerIds: [playerId] });
    await dmSocket.apply(owned);
    await dmSocket.apply(tokenOp(sceneId, { visibility: "dm", name: "Lurker" }));
    const playerSocket = await t.connect(roomId, player);
    await playerSocket.snapshot("p");

    const tv = await pairDisplay(t, dm, roomId);
    const display = await t.connectDisplay(roomId, tv);
    const snap = await display.snapshot("tv");
    assert.equal(snap.you.role, "display");
    assert.match(snap.you.memberId, /^display:/);
    const actor = t.manager.get(roomId)!;
    const fresh = projectState(actor.committed.state, { memberId: snap.you.memberId, role: "player" }, { sceneId: null });
    assert.deepEqual(snap.state, JSON.parse(JSON.stringify(fresh)));
    const tokens = Object.values((snap.state as { tokens: Record<string, { name: string; party?: true }> }).tokens);
    assert.deepEqual(tokens.map((x) => [x.name, x.party]), [["Thorn", true]]);

    const presence = await display.next("presence");
    assert.equal(presence.online.includes(snap.you.memberId), false);
    assert.equal(presence.displays, undefined, "only DM sockets get the count");
    const dmPresence = await dmSocket.next("presence", (m) => m.displays === 1);
    assert.equal(dmPresence.online.includes(snap.you.memberId), false);
    const playerPresence = await playerSocket.next("presence", (m) => m.online.length === 2);
    assert.equal(playerPresence.displays, undefined);

    // A whisper reaches its player and never the display, which is in no whisper's `to`.
    await dmSocket.apply({ t: "log.whisper", to: [playerId], text: "psst" });
    const heard = await playerSocket.next("ev", (m) => m.changes.some((c) => c.key.startsWith("log:")));
    assert.ok(heard.changes.some((c) => "value" in c && (c.value as { text?: string }).text === "psst"));
    assert.equal(await display.maybe("ev", (m) => m.changes.some((c) => c.key.startsWith("log:"))), null);
  });

  for (const [what, msg] of [
    ["an op", { t: "op", n: 1, op: { t: "token.delete", tokenId: "x" } }],
    ["an eph", { t: "eph", sceneId: "s", e: { k: "ping", x: 1, y: 1 } }],
    // A player's malformed eph is dropped quietly, but a display sends none at all.
    ["a malformed eph", { t: "eph", sceneId: "s", e: { k: "ping", x: "far" } }],
    ["a scene", { t: "scene", sceneId: "s" }],
  ] as const) {
    test(`${what} from a display closes it with 4003`, async () => {
      const { dm, roomId } = await room(`Sends ${what}`);
      const tv = await pairDisplay(t, dm, roomId);
      const display = await t.connectDisplay(roomId, tv);
      await display.snapshot("tv");
      display.send({ t: "ping", k: 1 });
      await display.next("pong");
      display.send(msg);
      assert.equal((await display.waitClosed()).code, 4003);
    });
  }

  test("a display counts for the DM once it holds a snapshot, so the view a DM device sends on the count reaches it", async () => {
    const { dm, roomId, dmSocket, sceneId } = await room("Counted");
    const tv = await pairDisplay(t, dm, roomId);
    const display = await t.connectDisplay(roomId, tv);
    // Open, but no hello yet: a view sent now would be dropped, so the DM is not told of it.
    assert.equal(await dmSocket.maybe("presence", (m) => (m.displays ?? 0) > 0), null);
    await display.snapshot("tv");
    await dmSocket.next("presence", (m) => m.displays === 1);
    // What a DM device with "Show my view on the table display" on sends when the count rises.
    dmSocket.send({ t: "eph", sceneId, e: { k: "view", x: 10, y: 8, w: 20, h: 12 } });
    const view = await display.next("eph", (m) => m.e.k === "view");
    assert.deepEqual(view.e, { k: "view", x: 10, y: 8, w: 20, h: 12 });
    display.close();
    await dmSocket.next("presence", (m) => m.displays === 0);
  });

  test("drags under fog reach no display, paths are stripped, and view goes to displays alone", async () => {
    const { dm, roomId, dmSocket, sceneId } = await room("Fog");
    await dmSocket.apply({ t: "scene.update", sceneId, patch: { fogEnabled: true } });
    const hidden = tokenOp(sceneId, { name: "Hidden goblin" }) as Extract<Op, { t: "token.create" }>;
    const shown = tokenOp(sceneId, { name: "Statue", fogExempt: true }) as Extract<Op, { t: "token.create" }>;
    await dmSocket.apply(hidden);
    await dmSocket.apply(shown);
    const player = t.client();
    await player.join(roomId, "Thorn");
    const playerSocket = await t.connect(roomId, player);
    await playerSocket.snapshot("p");
    const tv = await pairDisplay(t, dm, roomId);
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");
    const otherDm = await t.connect(roomId, dm);
    await otherDm.snapshot("dm2");

    dmSocket.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: hidden.token.id, x: 3, y: 3, path: [2, 2, 3, 3] } });
    dmSocket.send({ t: "eph", sceneId, e: { k: "dragMove", tokenId: shown.token.id, x: 4, y: 4, path: [2, 2, 4, 4] } });
    const drag = await display.next("eph", (m) => m.e.k === "dragMove");
    assert.equal(drag.e.k === "dragMove" && drag.e.tokenId, shown.token.id);
    assert.equal("path" in drag.e, false);
    assert.equal(await display.maybe("eph", (m) => m.e.k === "dragMove" && m.e.tokenId === hidden.token.id), null);

    dmSocket.send({ t: "eph", sceneId, e: { k: "view", x: 10, y: 8, w: 20, h: 12 } });
    const view = await display.next("eph", (m) => m.e.k === "view");
    assert.deepEqual(view.e, { k: "view", x: 10, y: 8, w: 20, h: 12 });
    assert.equal(await playerSocket.maybe("eph", (m) => m.e.k === "view"), null);
    assert.equal(await otherDm.maybe("eph", (m) => m.e.k === "view"), null);

    // A player's view is not the DM's camera, and reaches nobody.
    playerSocket.send({ t: "eph", sceneId, e: { k: "view", x: 1, y: 1, w: 2, h: 2 } });
    assert.equal(await display.maybe("eph", (m) => m.e.k === "view"), null);

    dmSocket.send({ t: "eph", sceneId, e: { k: "focus", x: 5, y: 5, zoom: 1 } });
    assert.ok(await display.next("eph", (m) => m.e.k === "focus"));
  });

  test("a password change closes displays with 4001, and the devices list shows and signs out a display", async () => {
    const { dm, roomId } = await room("Signed out");
    const tv = await pairDisplay(t, dm, roomId);
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");
    const devices = await dm.get(`/api/rooms/${roomId}/dm/devices`);
    const listed = devices.json<{ devices: { sessionId: string; display?: true; online: boolean }[] }>().devices;
    const row = listed.find((d) => d.display);
    assert.ok(row?.online);
    assert.equal(listed.length, 2);
    assert.equal((await dm.delete(`/api/rooms/${roomId}/dm/devices/${row.sessionId}`)).statusCode, 204);
    assert.equal((await display.waitClosed()).code, 4001);
    assert.equal((await tv.get(`/api/rooms/${roomId}/display/me`)).statusCode, 403);

    const tv2 = await pairDisplay(t, dm, roomId);
    const display2 = await t.connectDisplay(roomId, tv2);
    await display2.snapshot("tv2");
    assert.equal((await dm.post(`/api/rooms/${roomId}/password`, { password: "griffon-lantern-moss" })).statusCode, 204);
    assert.equal((await display2.waitClosed()).code, 4001);
  });

  test("an open display renews its session, and its session ends 30 days after its last socket closed", async () => {
    const { dm, roomId } = await room("Lifetime");
    const tv = await pairDisplay(t, dm, roomId);
    const memberId = await displayMember(t, tv, roomId);
    const sessionId = await displaySessionId(t, memberId);
    const a = await t.connectDisplay(roomId, tv);
    await a.snapshot("tv-a");
    const b = await t.connectDisplay(roomId, tv);
    await b.snapshot("tv-b");

    // Well inside 29 days, nothing is written.
    await t.pool.query("update sessions set expires_at = now() + interval '29 days 12 hours' where id = $1", [sessionId]);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(Math.abs((await expiresIn(t, sessionId)) - 29.5 * DAY) < 60);
    // Under 29 days away, the recheck renews it to 30, and stamps when the TV was last seen.
    await t.pool.query("update sessions set expires_at = now() + interval '2 days', last_seen_at = now() - interval '3 days' where id = $1", [sessionId]);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(Math.abs((await expiresIn(t, sessionId)) - 30 * DAY) < 60);
    const devices = (await dm.get(`/api/rooms/${roomId}/dm/devices`)).json<{ devices: { sessionId: string; lastSeenAt: string }[] }>().devices;
    const seen = devices.find((d) => d.sessionId === sessionId)!.lastSeenAt;
    assert.ok(Date.now() - Date.parse(seen) < 60_000, `last seen ${seen}`);

    // One socket closing leaves the other open, and the last one sets 30 days from its close.
    await t.pool.query("update sessions set expires_at = now() + interval '29 days 12 hours' where id = $1", [sessionId]);
    a.close();
    await a.waitClosed();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(Math.abs((await expiresIn(t, sessionId)) - 29.5 * DAY) < 60);
    b.close();
    await b.waitClosed();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(Math.abs((await expiresIn(t, sessionId)) - 30 * DAY) < 60);
  });

  test("a display whose session expired or was deleted closes with 4001, and stays expired", async () => {
    const { dm, roomId } = await room("Expired");
    const tv = await pairDisplay(t, dm, roomId);
    const sessionId = await displaySessionId(t, await displayMember(t, tv, roomId));
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");
    await t.pool.query("update sessions set expires_at = now() - interval '1 second' where id = $1", [sessionId]);
    assert.equal((await display.waitClosed()).code, 4001);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok((await expiresIn(t, sessionId)) < 0, "the close revived nothing");
    assert.equal((await tv.get(`/api/rooms/${roomId}/display/me`)).statusCode, 401);

    const tv2 = await pairDisplay(t, dm, roomId);
    const sessionId2 = await displaySessionId(t, await displayMember(t, tv2, roomId));
    const display2 = await t.connectDisplay(roomId, tv2);
    await display2.snapshot("tv2");
    await t.pool.query("delete from sessions where id = $1", [sessionId2]);
    assert.equal((await display2.waitClosed()).code, 4001);
  });

  test("cookie substitution: a display token is no room session, and a room token opens no display", async () => {
    const { dm, roomId } = await room("Substitution");
    const tv = await pairDisplay(t, dm, roomId);
    const asRoom = t.client();
    asRoom.token = tv.displayToken;
    assert.equal((await asRoom.get(`/api/rooms/${roomId}/me`)).statusCode, 403);
    assert.equal((await asRoom.get(`/api/rooms/${roomId}/assets`)).statusCode, 403);
    assert.equal((await asRoom.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, Buffer.from("x"))).statusCode, 403);
    assert.equal((await asRoom.post(`/api/rooms/${roomId}/assets/import`, { url: "https://example.com/a.png", kind: "token" })).statusCode, 403);
    assert.equal((await asRoom.post(`/api/rooms/${roomId}/image-search`, { q: "goblin" })).statusCode, 403);
    assert.equal((await asRoom.post(`/api/rooms/${roomId}/display/code`)).statusCode, 403);
    assert.equal((await asRoom.get(`/api/rooms/${roomId}/log`)).statusCode, 403);
    const joinStep = await asRoom.post(`/api/rooms/${roomId}/join/complete`, { ticket: "A".repeat(43), name: "Sneak", color: "#3e8ef7" });
    assert.equal(joinStep.statusCode, 401);
    await assert.rejects(t.connect(roomId, asRoom), /403/);

    // A room session under the display cookie's name opens no display.
    const player = t.client();
    await player.join(roomId, "Thorn");
    const asDisplay = t.client();
    asDisplay.displayToken = player.token;
    assert.equal((await asDisplay.get(`/api/rooms/${roomId}/display/me`)).statusCode, 401);
    await assert.rejects(t.connectDisplay(roomId, asDisplay), /403/);

    // A browser holding both cookies opens a DM socket and a display socket, each with its own projection.
    const both = dm;
    both.displayToken = tv.displayToken;
    const dmSocket = await t.connect(roomId, both);
    const dmSnap = await dmSocket.snapshot("dm-both");
    assert.equal(dmSnap.you.role, "dm");
    const display = await t.connectDisplay(roomId, both);
    const displaySnap = await display.snapshot("tv-both");
    assert.equal(displaySnap.you.role, "display");
    assert.notEqual(displaySnap.you.memberId, dmSnap.you.memberId);
  });
});

describe("the display image route", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  async function addAsset(roomId: string, kind: AssetKind): Promise<string> {
    const id = randomUUID();
    const sha = randomBytes(32);
    const variants = kind === "thumb" ? ["thumb"] : ["full", "mobile", "thumb"];
    await t.pool.query(
      `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants)
       values ($1, $2, $3, $4, 1, 100, 100, 10, $5)`,
      [id, roomId, sha, kind, variants],
    );
    for (const variant of variants) {
      const path = variantPath(t.assetDir, sha.toString("hex"), kind, variant as "full", 1);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `image ${id} ${variant}`);
    }
    return id;
  }

  test("serves only the display's projected visible set", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Images");
    const dmSocket = await t.connect(roomId, dm);
    const snap = await dmSocket.snapshot("dm");
    const sceneId = (snap.state as { meta: { playerSceneId: string } }).meta.playerSceneId;
    const map = await addAsset(roomId, "map");
    const face = await addAsset(roomId, "token");
    const secret = await addAsset(roomId, "token");
    const thumb = await addAsset(roomId, "thumb");
    const note = await addAsset(roomId, "handout");
    const forAll = await addAsset(roomId, "handout");
    const player = t.client();
    const playerId = await player.join(roomId, "Thorn");

    const ok = (ev: { rejects?: unknown[] }) => assert.equal(ev.rejects, undefined, JSON.stringify(ev.rejects));
    ok(await dmSocket.apply({ t: "scene.setMap", sceneId, map: { assetId: map, widthPx: 100, heightPx: 100, cellPx: 50, originPx: { x: 0, y: 0 } } }));
    ok(await dmSocket.apply(tokenOp(sceneId, { image: { assetId: face, crop: { cx: 0.5, cy: 0.5, zoom: 1 } } })));
    ok(await dmSocket.apply(tokenOp(sceneId, { visibility: "dm", image: { assetId: secret, crop: { cx: 0.5, cy: 0.5, zoom: 1 } } })));
    ok(await dmSocket.apply({ t: "scene.update", sceneId, patch: { thumb } }));
    ok(await dmSocket.apply({ t: "handout.show", handout: { id: uuidv7(), assetId: note, title: "Letter", to: [playerId] } }));
    ok(await dmSocket.apply({ t: "handout.show", handout: { id: uuidv7(), assetId: forAll, title: "Map", to: "all" } }));

    const tv = await pairDisplay(t, dm, roomId);
    const read = (id: string, variant = "full") => tv.get(`/api/rooms/${roomId}/display/assets/${id}/${variant}`);
    for (const id of [map, face, forAll]) {
      const res = await read(id);
      assert.equal(res.statusCode, 200, id);
      assert.equal(res.headers["content-type"], "image/webp");
      assert.equal(res.headers["cache-control"], "private, max-age=31536000, immutable");
      assert.equal(res.body, `image ${id} full`);
    }
    for (const id of [secret, thumb, note]) assert.equal((await read(id)).statusCode, 404, id);
    assert.equal((await read(thumb, "thumb")).statusCode, 404);
    // The display holds no room session, so the ordinary routes refuse it.
    assert.equal((await tv.get(`/api/assets/${map}/full`)).statusCode, 404);
    assert.equal((await tv.get(`/api/rooms/${roomId}/assets`)).statusCode, 403);
    // Neither the player's nor the DM's cookie reads through the display route.
    assert.equal((await player.get(`/api/rooms/${roomId}/display/assets/${map}/full`)).statusCode, 404);
    assert.equal((await dm.get(`/api/rooms/${roomId}/display/assets/${map}/full`)).statusCode, 404);
  });

  test("reads every page of a handout of pages shown to everyone, and no page of one shown to chosen players or kept in a document (docs/design-v1-pdf-handouts.md 3.4)", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Pages");
    const dmSocket = await t.connect(roomId, dm);
    await dmSocket.snapshot("dm");
    const player = t.client();
    const playerId = await player.join(roomId, "Thorn");
    const page = (assetId: string) => ({ assetId, width: 100, height: 100 });
    const forAll = [await addAsset(roomId, "handout"), await addAsset(roomId, "handout"), await addAsset(roomId, "handout")];
    const chosen = [await addAsset(roomId, "handout"), await addAsset(roomId, "handout")];
    const kept = await addAsset(roomId, "handout");
    const ok = (ev: { rejects?: unknown[] }) => assert.equal(ev.rejects, undefined, JSON.stringify(ev.rejects));
    const allId = uuidv7();
    ok(await dmSocket.apply({ t: "handout.show", handout: { id: allId, pages: forAll.map(page), title: "Strange letter", to: "all" } }));
    ok(await dmSocket.apply({ t: "handout.show", handout: { id: uuidv7(), pages: chosen.map(page), title: "Map pack", to: [playerId] } }));
    ok(await dmSocket.apply({ t: "handoutDoc.create", doc: { id: uuidv7(), title: "Kept", pages: [page(forAll[0]!), page(kept)] } }));

    const tv = await pairDisplay(t, dm, roomId);
    const read = (id: string, variant = "full") => tv.get(`/api/rooms/${roomId}/display/assets/${id}/${variant}`);
    for (const id of forAll) for (const variant of ["full", "thumb"]) assert.equal((await read(id, variant)).statusCode, 200, `${id} ${variant}`);
    for (const id of [...chosen, kept]) assert.equal((await read(id)).statusCode, 404, id);
    // Closed, its pages answer 404 too, though a document still names one of them.
    ok(await dmSocket.apply({ t: "handout.close", handoutId: allId }));
    for (const id of forAll) assert.equal((await read(id)).statusCode, 404, `${id} after close`);
    dmSocket.close();
  });
});
