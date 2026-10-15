import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MockAgent } from "undici";
import type { RoomState } from "#shared/model.ts";
import { ipKey } from "../auth/ipKey.ts";
import { sha256 } from "../auth/tokens.ts";
import { startTestApp, type TestApp } from "../auth/testing.ts";
import { setTurnstileDispatcherForTests } from "../auth/turnstile.ts";

describe("rooms", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test("creating a room makes the caller its DM, with a fresh cookie", async () => {
    const dm = t.client();
    const res = await dm.post("/api/rooms", {
      name: "Curse of the Raccoon",
      playerPassword: "owlbear-druid-wand",
      dmName: "Jo",
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ roomId: string; dmLink: string }>();
    t.track(body.roomId);
    assert.match(body.roomId, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    const key = body.dmLink.split("#dm=")[1] ?? "";
    assert.equal(body.dmLink, `/r/${body.roomId.slice(0, 4)}-${body.roomId.slice(4)}#dm=${key}`);
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);

    const cookie = res.cookies.find((c) => c.name === "rvtt");
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Strict");
    assert.equal(cookie.path, "/");
    assert.equal(cookie.maxAge, 15552000);
    assert.equal(cookie.secure, undefined);

    const { rows } = await t.pool.query(
      "select name, player_pw_hash, player_epoch, dm_key_hash, dm_epoch, created_ip from rooms where id = $1",
      [body.roomId],
    );
    const room = rows[0];
    assert.equal(room.name, "Curse of the Raccoon");
    assert.match(room.player_pw_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(room.player_epoch, 1);
    assert.equal(room.dm_epoch, 1);
    assert.deepEqual(room.dm_key_hash, sha256(key));
    assert.equal(room.created_ip, ipKey(dm.ip));

    const snap = await t.pool.query<{ seq: string; state: RoomState }>(
      "select seq, state from room_snapshots where room_id = $1",
      [body.roomId],
    );
    const state = snap.rows[0]?.state;
    assert.ok(state);
    assert.equal(snap.rows[0]?.seq, "0");
    assert.equal(state.meta.name, "Curse of the Raccoon");
    const members = Object.values(state.members);
    assert.equal(members.length, 1);
    assert.equal(members[0]?.name, "Jo");
    assert.equal(members[0]?.kind, "dm");
    assert.equal(Object.keys(state.scenes).length, 1);

    const me = await dm.me(body.roomId);
    assert.equal(me.status, 200);
    assert.equal(me.role, "dm");
    assert.equal(me.memberId, members[0]?.id);
  });

  test("weak and common passwords are refused", async () => {
    const c = t.client();
    for (const [password, reason] of [
      ["short", "too_short"],
      ["password1", "too_common"],
      ["Baseball1", "too_common"],
    ] as const) {
      const res = await c.post("/api/rooms", { name: "R", playerPassword: password, dmName: "DM" });
      assert.equal(res.statusCode, 400, password);
      assert.deepEqual(res.json(), { error: "weak_password", reason });
    }
  });

  test("invalid bodies are refused", async () => {
    const c = t.client();
    for (const body of [
      {},
      { name: "", playerPassword: "owlbear-druid-wand", dmName: "DM" },
      { name: "R", dmName: "x".repeat(81), playerPassword: "owlbear-druid-wand" },
    ]) {
      const res = await c.post("/api/rooms", body);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ error: string }>().error, "invalid_body");
    }
  });

  test("an existing session keeps its cookie and gains the new DM grant", async () => {
    const dm = t.client();
    const first = await dm.createRoom("First");
    const token = dm.token;
    const res = await dm.post("/api/rooms", { name: "Second", playerPassword: "owlbear-druid-wand", dmName: "DM" });
    assert.equal(res.statusCode, 201);
    const second = res.json<{ roomId: string }>().roomId;
    t.track(second);
    assert.equal(res.cookies.length, 0);
    assert.equal(dm.token, token);
    assert.equal((await dm.me(first.roomId)).role, "dm");
    assert.equal((await dm.me(second)).role, "dm");
  });

  test("GET room returns the name only, for either id form", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Lost Mine");
    const anon = t.client();
    for (const id of [roomId, `${roomId.slice(0, 4)}-${roomId.slice(4)}`, roomId.toLowerCase()]) {
      const res = await anon.get(`/api/rooms/${id}`);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { roomId, name: "Lost Mine" });
    }
    assert.equal((await anon.get("/api/rooms/ZZZZZZZZ")).statusCode, 404);
    assert.equal((await anon.get("/api/rooms/not-an-id")).statusCode, 404);
  });

  test("me needs a grant", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const stranger = t.client();
    assert.equal((await stranger.me(roomId)).status, 403);
  });

  test("me names the room, for the Home page's list of this device's rooms", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Tuesday night");
    const res = await dm.get(`/api/rooms/${roomId}/me`);
    assert.equal(res.json<{ roomName: string }>().roomName, "Tuesday night");
  });

  test("deleting a room needs a DM grant and its name typed", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Delete Me");
    const player = t.client();
    await player.join(roomId);

    assert.equal((await player.delete(`/api/rooms/${roomId}`, { name: "Delete Me" })).statusCode, 403);
    const wrong = await dm.delete(`/api/rooms/${roomId}`, { name: "Delete You" });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json<{ error: string }>().error, "name_mismatch");

    const ok = await dm.delete(`/api/rooms/${roomId}`, { name: " Delete Me " });
    assert.equal(ok.statusCode, 204);
    assert.equal((await dm.get(`/api/rooms/${roomId}`)).statusCode, 404);
    assert.ok(t.gateway.closed.some((c) => c.roomId === roomId && "all" in c.filter && c.code === 4009));
    const grants = await t.pool.query("select 1 from grants where room_id = $1", [roomId]);
    assert.equal(grants.rowCount, 0);
  });

  test("changing the password signs out every player, not the DM", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const player = t.client();
    await player.join(roomId);
    const waiting = t.client();
    const ticketRes = await waiting.post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" });
    const { ticket } = ticketRes.json<{ ticket: string }>();

    assert.equal((await player.post(`/api/rooms/${roomId}/password`, { password: "wyvern-staff-rune" })).statusCode, 403);
    const weak = await dm.post(`/api/rooms/${roomId}/password`, { password: "password" });
    assert.equal(weak.statusCode, 400);
    const res = await dm.post(`/api/rooms/${roomId}/password`, { password: "wyvern-staff-rune" });
    assert.equal(res.statusCode, 204);

    assert.equal((await player.me(roomId)).status, 403);
    assert.equal((await dm.me(roomId)).role, "dm");
    assert.ok(
      t.gateway.closed.some(
        (c) => c.roomId === roomId && c.code === 4001 && "sessionIds" in c.filter && c.filter.sessionIds.length === 1,
      ),
    );
    const done = await waiting.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Late", color: "#123456" });
    assert.equal(done.statusCode, 403);

    assert.equal((await t.client().post(`/api/rooms/${roomId}/join`, { password: "owlbear-druid-wand" })).statusCode, 403);
    await player.join(roomId, "Player", "wyvern-staff-rune");
    assert.equal((await player.me(roomId)).role, "player");
  });

  test("the session's expiry slides at most once a day, with the cookie re-sent", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    const quiet = await dm.get(`/api/rooms/${roomId}/me`);
    assert.equal(quiet.cookies.length, 0);

    const { rows } = await t.pool.query<{ session_id: string }>("select session_id from grants where room_id = $1", [roomId]);
    const sessionId = rows[0]?.session_id;
    await t.pool.query(
      "update sessions set expires_at = now() + interval '170 days', last_seen_at = now() - interval '10 days' where id = $1",
      [sessionId],
    );
    const slid = await dm.get(`/api/rooms/${roomId}/me`);
    assert.equal(slid.statusCode, 200);
    const cookie = slid.cookies.find((c) => c.name === "rvtt");
    assert.equal(cookie?.maxAge, 15552000);
    const after = await t.pool.query<{ days: number }>(
      "select extract(epoch from expires_at - now()) / 86400 as days from sessions where id = $1",
      [sessionId],
    );
    assert.ok((after.rows[0]?.days ?? 0) > 179.9);
    assert.equal((await dm.get(`/api/rooms/${roomId}/me`)).cookies.length, 0);
  });

  test("an expired session is no session", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom();
    await t.pool.query(
      "update sessions set expires_at = now() - interval '1 second' where id = (select session_id from grants where room_id = $1)",
      [roomId],
    );
    assert.equal((await dm.me(roomId)).status, 403);
  });
});

describe("creation limits", () => {
  test("5 rooms per IP per day", async () => {
    const t = await startTestApp({ env: { ROOMS_PER_IP_PER_DAY: "5" } });
    try {
      const c = t.client();
      for (let i = 0; i < 5; i++) await c.createRoom(`Room ${i}`);
      const res = await c.post("/api/rooms", { name: "Sixth", playerPassword: "owlbear-druid-wand", dmName: "DM" });
      assert.equal(res.statusCode, 429);
      assert.equal(res.json<{ error: string }>().error, "rate_limited");
      assert.ok(Number(res.headers["retry-after"]) > 0);
      // Another IP is unaffected.
      await t.client().createRoom("Elsewhere");
    } finally {
      await t.close();
    }
  });

  test("the site-wide daily cap holds across IPs", async () => {
    const probe = await startTestApp();
    const { rows } = await probe.pool.query<{ n: number }>(
      "select count(*)::int as n from rate_events where key = 'create:site' and at > now() - interval '1 day'",
    );
    await probe.close();
    const t = await startTestApp({ env: { ROOMS_PER_DAY: String((rows[0]?.n ?? 0) + 2) } });
    try {
      await t.client().createRoom("One");
      await t.client().createRoom("Two");
      const res = await t.client().post("/api/rooms", { name: "Three", playerPassword: "owlbear-druid-wand", dmName: "DM" });
      assert.equal(res.statusCode, 429);
    } finally {
      await t.close();
    }
  });

  test("concurrent creations cannot overshoot the per-IP limit", async () => {
    const t = await startTestApp({ env: { ROOMS_PER_IP_PER_DAY: "2" } });
    try {
      const c = t.client();
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          c.post("/api/rooms", { name: `Race ${i}`, playerPassword: "owlbear-druid-wand", dmName: "DM" }),
        ),
      );
      for (const res of results) if (res.statusCode === 201) t.track(res.json<{ roomId: string }>().roomId);
      assert.equal(results.filter((r) => r.statusCode === 201).length, 2);
      assert.equal(results.filter((r) => r.statusCode === 429).length, 2);
    } finally {
      await t.close();
    }
  });
});

describe("HTTP hardening", () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test("a cross-site or originless POST is refused", async () => {
    const c = t.client();
    const body = { name: "R", playerPassword: "owlbear-druid-wand", dmName: "DM" };
    const cases: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "", origin: "https://evil.example" },
    ];
    for (const headers of cases) {
      const res = await c.request("POST", "/api/rooms", body, headers);
      assert.equal(res.statusCode, 403, JSON.stringify(headers));
      assert.deepEqual(res.json(), { error: "cross_origin" });
    }
    const noFetchMeta = await t.app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      payload: JSON.stringify(body),
    });
    assert.equal(noFetchMeta.statusCode, 403);
    const bare = await t.app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
    assert.equal(bare.statusCode, 403);
  });

  test("the exact public origin passes without Sec-Fetch-Site", async () => {
    const c = t.client();
    const res = await t.app.inject({
      method: "POST",
      url: "/api/rooms",
      remoteAddress: c.ip,
      headers: { "content-type": "application/json", origin: t.config.publicOrigin },
      payload: JSON.stringify({ name: "Origin", playerPassword: "owlbear-druid-wand", dmName: "DM" }),
    });
    assert.equal(res.statusCode, 201);
    const { roomId } = res.json<{ roomId: string }>();
    t.track(roomId);
    // No user agent was sent, so the run's cleanup cannot find this session.
    await t.pool.query("delete from sessions where id = (select session_id from grants where room_id = $1)", [roomId]);
  });

  test("a DELETE without proof of origin is refused", async () => {
    const res = await t.app.inject({ method: "DELETE", url: "/api/rooms/ZZZZZZZZ" });
    assert.equal(res.statusCode, 403);
  });

  test("JSON bodies must be application/json", async () => {
    const c = t.client();
    const payload = JSON.stringify({ name: "R", playerPassword: "owlbear-druid-wand", dmName: "DM" });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/rooms",
        remoteAddress: c.ip,
        headers: { "sec-fetch-site": "same-origin", "content-type": type },
        payload,
      });
      assert.equal(res.statusCode, 415, type);
    }
  });

  test("security headers on every response, no CORS", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/rooms/ZZZZZZZZ", headers: { origin: "https://evil.example" } });
    assert.equal(
      res.headers["content-security-policy"],
      "default-src 'self'; img-src 'self' blob: data: https://serpapi.com https://encrypted-tbn0.gstatic.com https://encrypted-tbn1.gstatic.com https://encrypted-tbn2.gstatic.com https://encrypted-tbn3.gstatic.com https://api.openverse.org/v1/images/; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
    assert.equal(res.headers["strict-transport-security"], undefined);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    const preflight = await t.app.inject({ method: "OPTIONS", url: "/api/rooms", headers: { origin: "https://evil.example" } });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  });

  test("healthz reports a status and nothing else", async () => {
    const res = await t.app.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  test("the Turnstile site key is null when Turnstile is off", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/config" });
    assert.deepEqual(res.json(), { turnstileSiteKey: null, searchEnabled: true });
  });
});

describe("Turnstile", () => {
  test("Cloudflare is sent the visitor's own address, not the /64 the limits count", async () => {
    const t = await startTestApp({ env: { TURNSTILE_SECRET: "test-secret", TURNSTILE_SITE_KEY: "site-key" } });
    const cloudflare = new MockAgent();
    cloudflare.disableNetConnect();
    const sent: string[] = [];
    cloudflare
      .get("https://challenges.cloudflare.com")
      .intercept({ path: "/turnstile/v0/siteverify", method: "POST" })
      .reply(200, (opts) => {
        sent.push(new URLSearchParams(String(opts.body)).get("remoteip") ?? "");
        return { success: true };
      })
      .times(2);
    setTurnstileDispatcherForTests(cloudflare);
    try {
      const c = t.client("2001:db8:5:6:7:8:9:a");
      const res = await c.post("/api/rooms", { name: "R", playerPassword: "owlbear-druid-wand", dmName: "DM", turnstileToken: "solved" });
      assert.equal(res.statusCode, 201, res.body);
      t.track(res.json<{ roomId: string }>().roomId);
      assert.deepEqual(sent, ["2001:db8:5:6:7:8:9:a"]);
    } finally {
      setTurnstileDispatcherForTests(null);
      await cloudflare.close();
      await t.close();
    }
  });

  test("creation without a token is refused when a secret is set", async () => {
    const t = await startTestApp({ env: { TURNSTILE_SECRET: "test-secret", TURNSTILE_SITE_KEY: "site-key" } });
    try {
      const c = t.client();
      const res = await c.post("/api/rooms", { name: "R", playerPassword: "owlbear-druid-wand", dmName: "DM" });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json<{ error: string }>().error, "turnstile_failed");
      assert.match(String(res.headers["content-security-policy"]), /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
      assert.deepEqual((await c.get("/api/config")).json(), { turnstileSiteKey: "site-key", searchEnabled: true });
    } finally {
      await t.close();
    }
  });
});
