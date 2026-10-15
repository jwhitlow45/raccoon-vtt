import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Fastify from "fastify";
import pg from "pg";
import { uuidv7 } from "#shared/ids.ts";
import { setupAuth } from "../auth/plugin.ts";
import { testConfig, randomIp } from "../auth/testing.ts";
import { applySchema } from "../db.ts";
import { DirectGateway } from "../rooms/gateway.ts";
import { startEngine, type Engine } from "../rooms/testing.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { registerRoomRoutes } from "./rooms.ts";
import { registerSecurity } from "./security.ts";
import { registerXCardRoutes } from "./xcard.ts";

/**
 * The X-card (docs/design-v1-dm-tools.md 3.11): the route, its broadcast to
 * every socket of the room, and that nothing about a tap is written or sent
 * back that could name who tapped it.
 */

async function counts(t: Engine, roomId: string): Promise<Record<string, number>> {
  const { rows } = await t.pool.query<{ ops: number; log: number; rate: number }>(
    `select (select count(*)::int from room_ops where room_id = $1) as ops,
       (select count(*)::int from room_log where room_id = $1) as log,
       (select count(*)::int from rate_events) as rate`,
    [roomId],
  );
  return rows[0]!;
}

describe("the X-card", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("reaches every socket on every scene, behind a blackout and on a display, and writes nothing", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Safety");
    const dmSocket = await t.connect(roomId, dm);
    await dmSocket.snapshot("dm");
    const prep = uuidv7();
    await dmSocket.apply({ t: "scene.create", scene: { id: prep, name: "Prep", bounds: { w: 10, h: 10 } } });
    const elsewhere = await t.connect(roomId, dm);
    await elsewhere.snapshot("dm-prep", undefined, prep);
    const player = t.client();
    await player.join(roomId, "Thorn");
    const playerSocket = await t.connect(roomId, player);
    await playerSocket.snapshot("p");
    await dmSocket.apply({ t: "view.blackout", blackout: true });
    const tv = t.client();
    const code = (await dm.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code) })).statusCode, 200);
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");

    // A player last seen a day ago, whose cookie the ordinary path would slide.
    const { rows } = await t.pool.query<{ id: string }>(
      `update sessions set last_seen_at = now() - interval '1 day', expires_at = now() + interval '10 days'
       where token_hash = sha256($1::bytea) returning id`,
      [Buffer.from(player.token!)],
    );
    const sessionId = rows[0]!.id;
    const before = await t.pool.query("select last_seen_at, expires_at from sessions where id = $1", [sessionId]);
    const was = await counts(t, roomId);

    const res = await player.post(`/api/rooms/${roomId}/xcard`);
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["set-cookie"], undefined);
    for (const socket of [dmSocket, elsewhere, playerSocket, display]) {
      const card = await socket.next("xcard");
      assert.deepEqual(Object.keys(card).sort(), ["at", "t"]);
      assert.ok(Math.abs(Date.parse(card.at) - Date.now()) < 5_000);
    }
    assert.deepEqual(await counts(t, roomId), was);
    const now = await t.pool.query("select last_seen_at, expires_at from sessions where id = $1", [sessionId]);
    assert.deepEqual(now.rows, before.rows);
  });

  test("needs a grant and the CSRF rule, refuses a display, and merges taps within 10 s", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Refusals");
    const dmSocket = await t.connect(roomId, dm);
    await dmSocket.snapshot("dm");
    assert.equal((await t.client().post(`/api/rooms/${roomId}/xcard`)).statusCode, 401);
    const stranger = t.client();
    await stranger.join((await t.client().createRoom("Elsewhere")).roomId, "Visitor");
    assert.equal((await stranger.post(`/api/rooms/${roomId}/xcard`)).statusCode, 403);
    const crossSite = await dm.request("POST", `/api/rooms/${roomId}/xcard`, undefined, { "sec-fetch-site": "cross-site" });
    assert.equal(crossSite.statusCode, 403);

    const tv = t.client();
    const code = (await dm.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    await tv.post("/api/display/redeem", { code });
    assert.equal((await tv.post(`/api/rooms/${roomId}/xcard`)).statusCode, 401, "a display cookie is no room session");
    const swapped = t.client();
    swapped.token = tv.displayToken;
    assert.equal((await swapped.post(`/api/rooms/${roomId}/xcard`)).statusCode, 401, "nor under the room cookie's name");
    assert.equal(await dmSocket.maybe("xcard"), null);

    assert.equal((await dm.post(`/api/rooms/${roomId}/xcard`)).statusCode, 204);
    assert.equal((await dm.post(`/api/rooms/${roomId}/xcard`)).statusCode, 204);
    await dmSocket.next("xcard");
    assert.equal(await dmSocket.maybe("xcard"), null, "the second tap merged into the first card");
  });

  test("one session sends at most 6 an hour, and the 7th is a bare 429", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Limit");
    for (let i = 0; i < 6; i++) assert.equal((await dm.post(`/api/rooms/${roomId}/xcard`)).statusCode, 204);
    const over = await dm.post(`/api/rooms/${roomId}/xcard`);
    assert.equal(over.statusCode, 429);
    assert.equal(over.body, "");
    assert.equal(over.headers["retry-after"], undefined);
    // Another device at the table is not held back.
    const player = t.client(dm.ip);
    await player.join(roomId, "Thorn");
    assert.equal((await player.post(`/api/rooms/${roomId}/xcard`)).statusCode, 204);
  });
});

test("the X-card route writes no request log line", async () => {
  const config = testConfig();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4 });
  await applySchema(pool);
  const lines: string[] = [];
  const app = Fastify({ logger: { level: "trace", stream: { write: (line: string) => void lines.push(line) } } });
  app.decorate("config", config);
  app.decorate("pool", pool);
  registerSecurity(app, config);
  const kit = await setupAuth(app, { config, pool, gateway: new DirectGateway(pool) });
  await registerRoomRoutes(app, kit);
  await registerXCardRoutes(app, kit, { manager: { get: () => null } });
  await app.ready();
  const headers = { "sec-fetch-site": "same-origin", "content-type": "application/json", "user-agent": "raccoon-xcard-log-itest" };
  const ip = randomIp();
  let roomId = "";
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      remoteAddress: ip,
      headers,
      payload: JSON.stringify({ name: "Logged", playerPassword: "owlbear-druid-wand", dmName: "DM" }),
    });
    assert.equal(created.statusCode, 201, created.body);
    roomId = created.json<{ roomId: string }>().roomId;
    const cookie = created.cookies.find((c) => c.name === "rvtt")!.value;
    assert.ok(lines.some((l) => l.includes("/api/rooms")), "other routes do log their requests");
    lines.length = 0;
    const { "content-type": _json, ...bare } = headers;
    const res = await app.inject({ method: "POST", url: `/api/rooms/${roomId}/xcard`, remoteAddress: ip, headers: { ...bare, cookie: `rvtt=${cookie}` } });
    assert.equal(res.statusCode, 204);
    assert.deepEqual(lines, []);
  } finally {
    await app.close();
    if (roomId) await pool.query("delete from rooms where id = $1", [roomId]);
    await pool.query("delete from sessions where user_agent = 'raccoon-xcard-log-itest'");
    await pool.query("delete from rate_events where position($1 in key) > 0", [ip.split("::")[0]!]);
    await pool.end();
  }
});
