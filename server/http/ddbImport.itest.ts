import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { MockAgent } from "undici";
import { FakeAuth, randomRoomId, testConfig } from "../assets/testApp.ts";
import { tempDir } from "../assets/testImages.ts";
import { registerDdbImportRoutes, type DdbImportOptions } from "./ddbImport.ts";
import { registerSecurity } from "./security.ts";

/**
 * The D&D Beyond import route (docs/design-v1-pc-stats.md 6.3) against a
 * fake of D&D Beyond's character service, with no network: CSRF, the
 * grant, the one address built from the digits, no redirect followed, the
 * 5 MiB cap, the time limit, each answer's code, the budgets, the slots
 * and that every end gives them back.
 */

const HOST = "https://character-service.dndbeyond.com";
const PATH = (id: string) => `/character/v5/character/${id}`;

/** An invented character in D&D Beyond's shape, with only the fields the reader reads. */
function character(id = 12345678): object {
  return {
    id: 0,
    success: true,
    message: "",
    data: {
      id,
      name: "Wren Ashdown",
      stats: [12, 16, 14, 10, 13, 8].map((value, i) => ({ id: i + 1, value })),
      bonusStats: [],
      overrideStats: [],
      baseHitPoints: 40,
      classes: [{ level: 5, definition: { name: "Rogue" }, classFeatures: [] }],
      modifiers: { class: [{ type: "proficiency", subType: "dexterity-saving-throws", fixedValue: null, value: null }] },
      inventory: [],
      race: { weightSpeeds: { normal: { walk: 30 } } },
    },
  };
}

let dir: string;
let cleanup: () => Promise<void>;
const apps: FastifyInstance[] = [];

before(async () => {
  ({ dir, cleanup } = await tempDir());
});

after(async () => {
  for (const app of apps) await app.close();
  await cleanup();
});

async function setup(over: Partial<DdbImportOptions> = {}) {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const auth = new FakeAuth();
  const config = testConfig(dir);
  const app = Fastify({ logger: false });
  app.decorate("config", config);
  app.decorate("auth", auth);
  registerSecurity(app, config);
  await registerDdbImportRoutes(app, { dispatcher: mock, timeoutMs: 400, ...over });
  await app.ready();
  apps.push(app);
  const roomId = randomRoomId();
  const member = auth.allow(roomId, "player");
  const post = (link: string, opts: { session?: Record<string, string>; room?: string; ip?: string; site?: string } = {}) =>
    app.inject({
      method: "POST",
      url: `/api/rooms/${opts.room ?? roomId}/ddb-import`,
      headers: { "content-type": "application/json", "sec-fetch-site": opts.site ?? "same-origin", "cf-connecting-ip": opts.ip ?? "203.0.113.7", ...(opts.session ?? member.headers) },
      payload: JSON.stringify({ link }),
    });
  return { app, mock, auth, roomId, member, post, service: mock.get(HOST) };
}

describe("POST /api/rooms/:id/ddb-import", () => {
  test("a public character answers its fill, from the address built from the digits alone", async () => {
    const { post, service } = await setup();
    service.intercept({ path: PATH("12345678"), method: "GET", headers: { accept: "application/json", "accept-encoding": "identity" } }).reply(200, character());
    const res = await post("https://www.dndbeyond.com/characters/12345678/share?x=https://evil.example");
    assert.equal(res.statusCode, 200);
    const { fill } = res.json() as { fill: { name: string; level: number; stats: { saves: string[] }; actor: { sheetUrl: string } } };
    assert.equal(fill.name, "Wren Ashdown");
    assert.equal(fill.level, 5);
    assert.deepEqual(fill.stats.saves, ["dex"]);
    assert.equal(fill.actor.sheetUrl, "https://www.dndbeyond.com/characters/12345678");
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("CSRF, the grant, and a link that is not D&D Beyond's", async () => {
    const { post, auth } = await setup();
    assert.equal((await post("1", { site: "cross-site" })).statusCode, 403);
    const stranger = auth.allow(randomRoomId(), "player");
    const res = await post("1", { session: stranger.headers });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "no_access");
    const bad = await post("https://evil.example/characters/1");
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "bad_url");
    assert.equal((await post("x".repeat(301))).statusCode, 400);
  });

  test("each answer of D&D Beyond's as its code: private, not found, failed, unreadable", async () => {
    const { post, service } = await setup();
    const code = async (id: string) => (await post(id)).json().error as string;
    service.intercept({ path: PATH("1"), method: "GET" }).reply(200, { success: false, message: "x", data: null });
    assert.equal(await code("1"), "private");
    service.intercept({ path: PATH("2"), method: "GET" }).reply(403, { success: false });
    assert.equal(await code("2"), "private");
    service.intercept({ path: PATH("3"), method: "GET" }).reply(403, "<html>blocked</html>");
    assert.equal(await code("3"), "fetch_failed", "a block in front of D&D Beyond is not privacy");
    service.intercept({ path: PATH("4"), method: "GET" }).reply(404, {});
    assert.equal(await code("4"), "not_found");
    service.intercept({ path: PATH("5"), method: "GET" }).reply(200, "<html>challenge</html>");
    assert.equal(await code("5"), "fetch_failed", "a challenge page");
    service.intercept({ path: PATH("6"), method: "GET" }).reply(500, {});
    assert.equal(await code("6"), "fetch_failed");
    service.intercept({ path: PATH("7"), method: "GET" }).reply(302, "", { headers: { location: "https://evil.example/x" } });
    assert.equal(await code("7"), "fetch_failed", "no redirect is followed");
    service.intercept({ path: PATH("8"), method: "GET" }).reply(200, { success: true, data: { name: "nothing here" } });
    assert.equal(await code("8"), "unreadable");
    // No way out at all, as with the host taken off squid's list: the same one code.
    assert.equal(await code("99"), "fetch_failed");
  });

  test("a body past 5 MiB and an answer past the time limit both fail", async () => {
    const { post, service } = await setup({ maxBytes: 1024 });
    service.intercept({ path: PATH("9"), method: "GET" }).reply(200, JSON.stringify({ success: true, data: { pad: "x".repeat(4096) } }));
    assert.equal((await post("9")).json().error, "fetch_failed");
    service.intercept({ path: PATH("10"), method: "GET" }).reply(200, character()).delay(1500);
    const started = Date.now();
    assert.equal((await post("10")).json().error, "fetch_failed");
    assert.ok(Date.now() - started < 1400, "the limit, not the slow answer, ends it");
  });

  test("budgets per session, address and server, spent only when the request goes out", async () => {
    const { post, service, auth, roomId } = await setup({ budgets: { session: 2, ip: 3, server: 4 } });
    service.intercept({ path: PATH("12345678"), method: "GET" }).reply(200, character()).times(10);
    // A link refused before going out spends nothing.
    await post("https://evil.example/characters/1");
    assert.equal((await post("12345678")).statusCode, 200);
    assert.equal((await post("12345678")).statusCode, 200);
    const spent = await post("12345678");
    assert.equal(spent.statusCode, 429);
    assert.equal(spent.json().error, "quota_member");
    assert.ok(Number(spent.headers["retry-after"]) > 0);
    const other = auth.allow(roomId, "player");
    assert.equal((await post("12345678", { session: other.headers })).statusCode, 200);
    assert.equal((await post("12345678", { session: other.headers })).json().error, "quota_ip", "three from this address");
    const third = auth.allow(roomId, "player");
    assert.equal((await post("12345678", { session: third.headers, ip: "198.51.100.9" })).statusCode, 200);
    assert.equal((await post("12345678", { session: auth.allow(roomId, "dm").headers, ip: "198.51.100.10" })).json().error, "quota_global");
  });

  test("one import at a time in a room and two on the server, busy past them, and every end frees its slots", async () => {
    const { post, service, auth } = await setup({ timeoutMs: 2000 });
    service.intercept({ path: PATH("12345678"), method: "GET" }).reply(200, character()).delay(300).times(10);
    const [a, b] = await Promise.all([post("12345678"), post("12345678")]);
    const codes = [a.statusCode, b.statusCode].sort();
    assert.deepEqual(codes, [200, 429], "a second import in the room is busy");
    const busy = a.statusCode === 429 ? a : b;
    assert.equal(busy.json().error, "busy");
    assert.equal(busy.headers["retry-after"], "5");
    // Three rooms at once: the server's two slots, and the third busy.
    const roomsAt = [randomRoomId(), randomRoomId(), randomRoomId()].map((room) => ({ room, session: auth.allow(room, "player").headers }));
    const three = await Promise.all(roomsAt.map((r) => post("12345678", r)));
    assert.deepEqual(three.map((r) => r.statusCode).sort(), [200, 200, 429]);
    // Afterwards both slots are free again, after a failure as after a success.
    service.intercept({ path: PATH("13"), method: "GET" }).reply(500, {});
    await post("13");
    const again = await Promise.all(roomsAt.slice(0, 2).map((r) => post("12345678", r)));
    assert.deepEqual(again.map((r) => r.statusCode), [200, 200]);
  });

  test("a member's request closing aborts the fetch and frees both slots", async () => {
    const { app, service, member, roomId } = await setup({ timeoutMs: 5000, slots: { server: 1, room: 1 } });
    service.intercept({ path: PATH("12345678"), method: "GET" }).reply(200, character()).delay(3000);
    service.intercept({ path: PATH("12345678"), method: "GET" }).reply(200, character());
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const first = fetch(`${address}/api/rooms/${roomId}/ddb-import`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...member.headers },
      body: JSON.stringify({ link: "12345678" }),
      signal: controller.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await first;
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    const res = await fetch(`${address}/api/rooms/${roomId}/ddb-import`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...member.headers },
      body: JSON.stringify({ link: "12345678" }),
    });
    assert.equal(res.status, 200, "the one server slot is free again");
    assert.ok(Date.now() - started < 2500, "not held until the slow answer would have come");
  });
});
