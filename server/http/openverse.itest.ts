import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { MockAgent } from "undici";
import type { ImageCredit } from "#shared/protocol.ts";
import type { OpenverseHttp, OpenverseRequest, OpenverseResponse } from "../assets/openverse.ts";
import type { HttpJson } from "../assets/serpapi.ts";
import { FakeAuth, buildAssetApp, dropRooms, makeRoom, testConfig, testPool } from "../assets/testApp.ts";
import { solid, tempDir } from "../assets/testImages.ts";

/**
 * Openverse as the second image search, and the credit an image from it
 * keeps (docs/design-v1-dm-tools.md 3.13). Openverse and SerpApi are local
 * fakes. Each app runs Openverse on a day of its own, long past, so the
 * server-wide day budget it counts is this test's alone.
 */

const SERPAPI_KEY = "test-serpapi-key-never-leaves";
const CLIENT_SECRET = "test-openverse-secret-never-leaves";
const run = `${process.pid}-${Date.now()}`;

let pool: pg.Pool;
let dir: string;
let cleanupDir: () => Promise<void>;
const auth = new FakeAuth();
const rooms: string[] = [];
const apps: FastifyInstance[] = [];
const ips: string[] = [];
const days: string[] = [];

before(async () => {
  pool = await testPool();
  ({ dir, cleanup: cleanupDir } = await tempDir());
});

after(async () => {
  for (const app of apps) await app.close();
  await pool.query(`delete from search_cache where q like $1`, [`%${run}%`]);
  await pool.query(`delete from search_usage where bucket like any($1)`, [
    [...days.map((d) => `ov:%:${d}`), ...rooms.map((r) => `r:${r}:%`), ...ips.map((ip) => `ip:${ip}:%`)],
  ]);
  await dropRooms(pool, rooms);
  await pool.end();
  await cleanupDir();
});

let dayCounter = 0;
/** A clock on a day no other test or run uses, starting at noon UTC. */
function freshDay(): { now: () => number; day: string } {
  const start = Date.UTC(2001, 0, 1, 12) + ((process.pid % 2000) * 50 + dayCounter++) * 86_400_000;
  const day = new Date(start).toISOString().slice(0, 10);
  days.push(day);
  return { now: () => start, day };
}

type OpenverseItem = Record<string, unknown> & { id: string; url: string; thumbnail: string };

function openverseItem(i: number, over: Partial<OpenverseItem> = {}): OpenverseItem {
  const id = randomUUID();
  return {
    id,
    title: `Goblin ${i}`,
    foreign_landing_url: `https://www.flickr.com/photos/someone/${id}`,
    url: `https://images.example/${id}.jpg`,
    creator: "Someone",
    license: "by-sa",
    license_version: "2.0",
    attribution: `"Goblin ${i}" by Someone is licensed under CC BY-SA 2.0.`,
    mature: false,
    width: 800,
    height: 600,
    thumbnail: `https://api.openverse.org/v1/images/${id}/thumb/`,
    ...over,
  };
}

/** A stand-in for api.openverse.org: searches and, when registered, the token. */
function fakeOpenverse(behavior: { status?: number; retryAfter?: string; items?: (q: string) => OpenverseItem[] } = {}) {
  const calls = { search: [] as string[], token: 0, authorization: [] as Array<string | undefined> };
  const http: OpenverseHttp = async (req: OpenverseRequest): Promise<OpenverseResponse> => {
    const url = new URL(req.url);
    assert.equal(url.hostname, "api.openverse.org");
    if (url.pathname === "/v1/auth_tokens/token/") {
      calls.token++;
      assert.equal(req.form?.client_secret, CLIENT_SECRET);
      return { status: 200, body: { access_token: `token-${run}`, expires_in: 36_000, token_type: "Bearer", scope: "read write" } };
    }
    assert.equal(url.pathname, "/v1/images/");
    const q = url.searchParams.get("q") ?? "";
    calls.search.push(q);
    calls.authorization.push(req.headers?.authorization);
    if (behavior.status && behavior.status !== 200) return { status: behavior.status, retryAfter: behavior.retryAfter, body: { detail: "nope" } };
    const pageSize = Number(url.searchParams.get("page_size"));
    const items = behavior.items?.(q) ?? Array.from({ length: 60 }, (_, i) => openverseItem(i));
    return { status: 200, body: { result_count: items.length, page_count: 1, page_size: pageSize, page: 1, results: items.slice(0, pageSize) } };
  };
  return { http, calls };
}

/** A stand-in for serpapi.com, as search.itest.ts has it. */
function fakeSerpApi(account: { left: number; thisHour: number }, behavior: { fail?: boolean } = {}) {
  const calls = { search: [] as string[] };
  const http: HttpJson = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/account.json") {
      return { status: 200, body: { plan_searches_left: account.left, this_hour_searches: account.thisHour } };
    }
    const q = u.searchParams.get("q") ?? "";
    calls.search.push(q);
    if (behavior.fail) return { status: 500, body: { error: "Internal error" } };
    return {
      status: 200,
      body: {
        images_results: Array.from({ length: 5 }, (_, i) => ({
          thumbnail: `https://serpapi.com/searches/${encodeURIComponent(q)}/images/${i}.jpeg`,
          original: `https://art.example/${i}.png`,
          title: `Result ${i}`,
          source: "art.example",
        })),
      },
    };
  };
  return { http, calls };
}

async function searchApp(opts: {
  openverse: OpenverseHttp;
  serpApi?: HttpJson;
  registered?: boolean;
  clock?: { now: () => number };
  egress?: { public: MockAgent; strict: MockAgent };
}) {
  const env: Record<string, string> = {};
  if (opts.serpApi) env.SERPAPI_KEY = SERPAPI_KEY;
  if (opts.registered) Object.assign(env, { OPENVERSE_CLIENT_ID: "test-client", OPENVERSE_CLIENT_SECRET: CLIENT_SECRET });
  const clock = opts.clock ?? freshDay();
  const app = await buildAssetApp({
    pool,
    config: testConfig(dir, env),
    auth,
    options: {
      openverse: { http: opts.openverse, now: clock.now },
      ...(opts.serpApi ? { serpApiHttp: opts.serpApi } : {}),
      ...(opts.egress
        ? {
            egress: {
              public: opts.egress.public,
              strict: opts.egress.strict,
              close: async () => {
                await opts.egress!.public.close();
                await opts.egress!.strict.close();
              },
            },
          }
        : {}),
    },
  });
  apps.push(app);
  return app;
}

async function room(): Promise<string> {
  const id = await makeRoom(pool, { ageHours: 48 });
  rooms.push(id);
  return id;
}

let ipCounter = 0;
function freshIp(): string {
  const ip = `ov-${process.pid}-${++ipCounter}`;
  ips.push(ip);
  return ip;
}

function search(app: FastifyInstance, roomId: string, who: { headers: Record<string, string> }, q: string, ip: string, source?: "openverse") {
  return app.inject({
    method: "POST",
    url: `/api/rooms/${roomId}/image-search`,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...who.headers },
    payload: JSON.stringify(source ? { q, source } : { q }),
  });
}

async function count(bucket: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(`select count from search_usage where bucket = $1`, [bucket]);
  return rows[0]?.count ?? 0;
}

async function seed(bucket: string, value: number): Promise<void> {
  await pool.query(`insert into search_usage (bucket, count) values ($1, $2) on conflict (bucket) do update set count = excluded.count`, [bucket, value]);
}

describe("Openverse search", () => {
  test("without SERPAPI_KEY Openverse answers, every result with its credit, and the route counts four budgets", async () => {
    const fake = fakeOpenverse();
    const clock = freshDay();
    const app = await searchApp({ openverse: fake.http, clock });
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const ip = freshIp();
    const res = await search(app, roomId, player, `Goblin ${run}`, ip);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<{ results: Array<{ credit?: ImageCredit; thumbnail: string }>; source: string }>();
    assert.equal(body.source, "openverse");
    assert.equal(body.results.length, 20);
    assert.ok(body.results.every((r) => r.credit?.license === "by-sa" && r.thumbnail.startsWith("https://api.openverse.org/v1/images/")));
    assert.deepEqual(fake.calls.search, [`goblin ${run}`]);
    assert.equal(fake.calls.token, 0);
    assert.equal(await count(`ov:m:${roomId}:${player.memberId}:${clock.day}`), 1);
    assert.equal(await count(`ov:r:${roomId}:${clock.day}`), 1);
    assert.equal(await count(`ov:ip:${ip}:${clock.day}`), 1);
    assert.equal(await count(`ov:site:${clock.day}`), 1);

    const again = await search(app, roomId, player, `goblin ${run}`, ip);
    assert.deepEqual(again.json(), body);
    assert.equal(fake.calls.search.length, 1, "the repeat came from the cache");
    assert.equal(await count(`ov:site:${clock.day}`), 1);
  });

  test("a registered server asks for 40 with its token, and neither the secret nor the token reaches an answer or the cache", async () => {
    const fake = fakeOpenverse();
    const app = await searchApp({ openverse: fake.http, registered: true });
    const roomId = await room();
    const q = `registered ${run}`;
    const res = await search(app, roomId, auth.allow(roomId, "player"), q, freshIp());
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().results.length, 40);
    assert.equal(fake.calls.token, 1);
    assert.deepEqual(fake.calls.authorization, [`Bearer token-${run}`]);
    assert.ok(!res.body.includes(CLIENT_SECRET) && !res.body.includes(`token-${run}`));
    const { rows } = await pool.query<{ results: string }>(`select results::text from search_cache where q = $1`, [`openverse:${q}`]);
    assert.ok(rows[0] && !rows[0].results.includes(CLIENT_SECRET) && !rows[0].results.includes(`token-${run}`));
  });

  test("SerpApi comes first, and Openverse answers each time SerpApi cannot", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const cases: Array<{ name: string; account: { left: number; thisHour: number }; prepare?: (roomId: string, ip: string) => Promise<void> }> = [
      { name: "the account under its floor", account: { left: 9, thisHour: 0 } },
      { name: "this hour's 45", account: { left: 200, thisHour: 45 } },
      { name: "the room's month", account: { left: 200, thisHour: 0 }, prepare: (roomId) => seed(`r:${roomId}:${month}`, 60) },
      { name: "the address's day", account: { left: 200, thisHour: 0 }, prepare: (_roomId, ip) => seed(`ip:${ip}:${day}`, 15) },
    ];
    for (const c of cases) {
      const serp = fakeSerpApi(c.account);
      const ov = fakeOpenverse();
      const app = await searchApp({ openverse: ov.http, serpApi: serp.http });
      const roomId = await room();
      const ip = freshIp();
      await c.prepare?.(roomId, ip);
      const res = await search(app, roomId, auth.allow(roomId, "player"), `fallback ${c.name} ${run}`, ip);
      assert.equal(res.statusCode, 200, `${c.name}: ${res.body}`);
      assert.equal(res.json().source, "openverse", c.name);
      assert.equal(serp.calls.search.length, 0, c.name);
      assert.equal(ov.calls.search.length, 1, c.name);
      assert.ok(!res.body.includes(SERPAPI_KEY));
    }

    const serp = fakeSerpApi({ left: 200, thisHour: 0 });
    const ov = fakeOpenverse();
    const app = await searchApp({ openverse: ov.http, serpApi: serp.http });
    const roomId = await room();
    const res = await search(app, roomId, auth.allow(roomId, "player"), `google first ${run}`, freshIp());
    assert.equal(res.json().source, "google");
    assert.equal(ov.calls.search.length, 0);
  });

  test("a failing SerpApi is not out of quota, so Openverse is not asked", async () => {
    const ov = fakeOpenverse();
    const app = await searchApp({ openverse: ov.http, serpApi: fakeSerpApi({ left: 200, thisHour: 0 }, { fail: true }).http });
    const roomId = await room();
    const res = await search(app, roomId, auth.allow(roomId, "player"), `serpapi down ${run}`, freshIp());
    assert.equal(res.statusCode, 502);
    assert.equal(ov.calls.search.length, 0);
  });

  test("Openverse on purpose skips Google, and the two sources cache apart", async () => {
    const serp = fakeSerpApi({ left: 200, thisHour: 0 });
    const ov = fakeOpenverse();
    const app = await searchApp({ openverse: ov.http, serpApi: serp.http });
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const q = `owlbear ${run}`;
    assert.equal((await search(app, roomId, player, q, freshIp(), "openverse")).json().source, "openverse");
    assert.equal(serp.calls.search.length, 0);
    assert.equal((await search(app, roomId, player, q, freshIp())).json().source, "google");
    assert.equal(serp.calls.search.length, 1, "Openverse's cached answer is not Google's");
    // Each again from its own cache.
    assert.equal((await search(app, roomId, player, q, freshIp(), "openverse")).json().source, "openverse");
    assert.equal((await search(app, roomId, player, q, freshIp())).json().source, "google");
    assert.equal(serp.calls.search.length + ov.calls.search.length, 2);
    const { rows } = await pool.query<{ q: string }>(`select q from search_cache where q = any($1) order by q`, [[q, `openverse:${q}`]]);
    assert.deepEqual(rows.map((r) => r.q), [`openverse:${q}`, q]);
  });

  test("a Google search for the words openverse:<q> never stands in for Openverse's results", async () => {
    const serp = fakeSerpApi({ left: 200, thisHour: 0 });
    const ov = fakeOpenverse();
    const app = await searchApp({ openverse: ov.http, serpApi: serp.http });
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const words = `kobold ${run}`;
    assert.equal((await search(app, roomId, player, `openverse:${words}`, freshIp())).json().source, "google");
    const res = await search(app, roomId, player, words, freshIp(), "openverse");
    const body = res.json<{ results: Array<{ credit?: unknown; thumbnail: string }> }>();
    assert.equal(ov.calls.search.length, 1, "the row Google wrote under that key was not taken as Openverse's");
    assert.ok(body.results.length > 0 && body.results.every((r) => r.credit && r.thumbnail.startsWith("https://api.openverse.org/")));
  });

  test("20 a day for a member in a room, and a refusal spends nothing", async () => {
    const ov = fakeOpenverse();
    const clock = freshDay();
    const app = await searchApp({ openverse: ov.http, clock });
    const roomId = await room();
    const otherRoom = await room();
    const memberId = `m-${randomUUID().slice(0, 8)}`;
    const player = auth.allow(roomId, "player", memberId);
    const ip = freshIp();
    await seed(`ov:m:${roomId}:${memberId}:${clock.day}`, 19);
    assert.equal((await search(app, roomId, player, `member a ${run}`, ip)).statusCode, 200);
    const refused = await search(app, roomId, player, `member b ${run}`, ip);
    assert.equal(refused.statusCode, 429);
    assert.deepEqual(refused.json(), { error: "quota_member" });
    assert.equal(await count(`ov:r:${roomId}:${clock.day}`), 1);
    assert.equal(await count(`ov:ip:${ip}:${clock.day}`), 1);
    assert.equal(await count(`ov:site:${clock.day}`), 1);
    // Someone else at the same table, on the same address, still searches, and so does this member in another room.
    assert.equal((await search(app, roomId, auth.allow(roomId, "player"), `member c ${run}`, ip)).statusCode, 200);
    assert.equal((await search(app, otherRoom, auth.allow(otherRoom, "player", memberId), `member d ${run}`, ip)).statusCode, 200);
    assert.equal(ov.calls.search.length, 3);
  });

  test("60 a day for a room, 150 for an address", async () => {
    const ov = fakeOpenverse();
    const clock = freshDay();
    const app = await searchApp({ openverse: ov.http, clock });
    const roomId = await room();
    await seed(`ov:r:${roomId}:${clock.day}`, 59);
    assert.equal((await search(app, roomId, auth.allow(roomId, "player"), `room a ${run}`, freshIp())).statusCode, 200);
    const full = await search(app, roomId, auth.allow(roomId, "player"), `room b ${run}`, freshIp());
    assert.deepEqual([full.statusCode, full.json()], [429, { error: "quota_room" }]);

    const ip = freshIp();
    const other = await room();
    await seed(`ov:ip:${ip}:${clock.day}`, 149);
    assert.equal((await search(app, other, auth.allow(other, "player"), `ip a ${run}`, ip)).statusCode, 200);
    const flood = await search(app, other, auth.allow(other, "player"), `ip b ${run}`, ip);
    assert.deepEqual([flood.statusCode, flood.json()], [429, { error: "quota_ip" }]);
  });

  test("the server's day: 150 anonymous, 5,000 registered, then quota_global until midnight UTC", async () => {
    const clock = freshDay();
    const app = await searchApp({ openverse: fakeOpenverse().http, clock });
    const roomId = await room();
    await seed(`ov:site:${clock.day}`, 149);
    assert.equal((await search(app, roomId, auth.allow(roomId, "player"), `site a ${run}`, freshIp())).statusCode, 200);
    const spent = await search(app, roomId, auth.allow(roomId, "player"), `site b ${run}`, freshIp());
    assert.deepEqual([spent.statusCode, spent.json()], [429, { error: "quota_global" }]);
    // The clock reads noon, so the day turns over in 12 hours.
    assert.equal(spent.headers["retry-after"], String(12 * 3600));

    const registeredClock = freshDay();
    const registered = await searchApp({ openverse: fakeOpenverse().http, registered: true, clock: registeredClock });
    await seed(`ov:site:${registeredClock.day}`, 4_999);
    assert.equal((await search(registered, roomId, auth.allow(roomId, "player"), `site c ${run}`, freshIp())).statusCode, 200);
    assert.equal((await search(registered, roomId, auth.allow(roomId, "player"), `site d ${run}`, freshIp())).statusCode, 429);
  });

  test("a 429 from Openverse is quota_global, and the member, room and address get their search back", async () => {
    const ov = fakeOpenverse({ status: 429 });
    const clock = freshDay();
    const app = await searchApp({ openverse: ov.http, clock });
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const ip = freshIp();
    const res = await search(app, roomId, player, `busy ${run}`, ip);
    assert.deepEqual([res.statusCode, res.json()], [429, { error: "quota_global" }]);
    assert.equal(res.headers["retry-after"], "60");
    assert.equal(await count(`ov:m:${roomId}:${player.memberId}:${clock.day}`), 0);
    assert.equal(await count(`ov:r:${roomId}:${clock.day}`), 0);
    assert.equal(await count(`ov:ip:${ip}:${clock.day}`), 0);
    assert.equal(await count(`ov:site:${clock.day}`), 1, "Openverse may have counted it");
  });

  test("a failed Openverse search is a 502 and charges no one at the table", async () => {
    const clock = freshDay();
    const app = await searchApp({ openverse: fakeOpenverse({ status: 500 }).http, clock });
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const res = await search(app, roomId, player, `broken ${run}`, freshIp());
    assert.deepEqual([res.statusCode, res.json()], [502, { error: "search_failed" }]);
    assert.equal(await count(`ov:m:${roomId}:${player.memberId}:${clock.day}`), 0);
  });

  test("members only, and the query is checked before anything is spent", async () => {
    const ov = fakeOpenverse();
    const app = await searchApp({ openverse: ov.http });
    const roomId = await room();
    assert.equal((await search(app, roomId, { headers: {} }, "goblin", freshIp())).statusCode, 403);
    assert.equal((await search(app, roomId, auth.allow(roomId, "player"), "   ", freshIp(), "openverse")).statusCode, 400);
    assert.equal(ov.calls.search.length, 0);
  });
});

describe("an Openverse image's credit", () => {
  let tokenPng: Buffer;
  let squarePng: Buffer;

  before(async () => {
    tokenPng = await solid(700, 350, "#a33").png().toBuffer();
    squarePng = await solid(300, 300, "#33a").png().toBuffer();
  });

  async function importApp() {
    const publicMock = new MockAgent();
    publicMock.disableNetConnect();
    const strictMock = new MockAgent();
    strictMock.disableNetConnect();
    const app = await searchApp({ openverse: fakeOpenverse().http, egress: { public: publicMock, strict: strictMock } });
    return { app, publicMock };
  }

  /** A cached Openverse answer, as a search stores it, with one result. */
  async function cachedResult(over: Partial<OpenverseItem> = {}) {
    const id = randomUUID();
    const result = {
      thumbnail: `https://api.openverse.org/v1/images/${id}/thumb/`,
      original: `https://images.example/${id}.png`,
      title: "Goblins and a Troll",
      source: "www.flickr.com",
      credit: {
        title: "Goblins and a Troll",
        creator: "Dunechaser",
        license: "by-nc-sa",
        licenseVersion: "2.0",
        landingUrl: `https://www.flickr.com/photos/dunechaser/${id}`,
        attribution: '"Goblins and a Troll" by Dunechaser is licensed under CC BY-NC-SA 2.0.',
      } satisfies ImageCredit,
      ...over,
    };
    await pool.query(`insert into search_cache (q, results, fetched_at) values ($1, $2, now())`, [`openverse:credit ${id} ${run}`, JSON.stringify([result])]);
    return result;
  }

  const post = (app: FastifyInstance, roomId: string, who: { headers: Record<string, string> }, body: unknown) =>
    app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/assets/import`,
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp(), ...who.headers },
      payload: JSON.stringify(body),
    });

  async function storedCredit(assetId: string): Promise<unknown> {
    const { rows } = await pool.query<{ credit: unknown }>(`select credit from assets where id = $1`, [assetId]);
    return rows[0]?.credit;
  }

  test("an original from a cached result keeps that result's credit with the size it was fetched at, in the answer and the listing", async () => {
    const t = await importApp();
    const result = await cachedResult();
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const dm = auth.allow(roomId, "dm");
    const path = new URL(result.original).pathname;
    t.publicMock.get("https://images.example").intercept({ path }).reply(200, tokenPng);
    const res = await post(t.app, roomId, player, { url: result.original, fallback: result.thumbnail, kind: "token" });
    assert.equal(res.statusCode, 200, res.body);
    const asset = res.json<{ id: string; width: number; height: number; credit: unknown }>();
    const expected = { ...result.credit, originalWidth: 700, originalHeight: 350 };
    // The token is stored at 512 wide, so the client can say it was resized.
    assert.deepEqual([asset.width, asset.height], [512, 256]);
    assert.deepEqual(asset.credit, expected);
    assert.deepEqual(await storedCredit(asset.id), expected);
    for (const who of [player, dm]) {
      const listed = (await t.app.inject({ url: `/api/rooms/${roomId}/assets`, headers: who.headers })).json<{ assets: Array<{ id: string; credit?: unknown }> }>();
      assert.deepEqual(listed.assets.find((a) => a.id === asset.id)?.credit, expected);
    }
  });

  test("the thumbnail fallback keeps the credit of the result whose thumbnail it fetched, through the public port", async () => {
    const t = await importApp();
    const result = await cachedResult();
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    t.publicMock.get("https://images.example").intercept({ path: new URL(result.original).pathname }).reply(403, "no hotlinking");
    t.publicMock.get("https://api.openverse.org").intercept({ path: new URL(result.thumbnail).pathname }).reply(200, squarePng);
    const res = await post(t.app, roomId, player, { url: result.original, fallback: result.thumbnail, kind: "token" });
    assert.equal(res.statusCode, 200, res.body);
    const asset = res.json<{ id: string; width: number; height: number }>();
    // Not resized: the stored size is the fetched one.
    assert.deepEqual([asset.width, asset.height], [300, 300]);
    assert.deepEqual(await storedCredit(asset.id), { ...result.credit, originalWidth: 300, originalHeight: 300 });

    const forged = await post(t.app, roomId, player, {
      url: result.original,
      fallback: `https://api.openverse.org/v1/images/${randomUUID()}/thumb/`,
      kind: "token",
    });
    assert.deepEqual([forged.statusCode, forged.json()], [400, { error: "bad_fallback" }]);
  });

  test("the original's size is read upright, as the pipeline turns it", async () => {
    const t = await importApp();
    const result = await cachedResult();
    const roomId = await room();
    const sideways = await solid(30, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    t.publicMock.get("https://images.example").intercept({ path: new URL(result.original).pathname }).reply(200, sideways);
    const res = await post(t.app, roomId, auth.allow(roomId, "player"), { url: result.original, kind: "token" });
    assert.equal(res.statusCode, 200, res.body);
    const asset = res.json<{ id: string; width: number; height: number }>();
    assert.deepEqual([asset.width, asset.height], [20, 30]);
    assert.deepEqual(await storedCredit(asset.id), { ...result.credit, originalWidth: 20, originalHeight: 30 });
  });

  test("a credit in the request body is never stored", async () => {
    const t = await importApp();
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const forgedCredit = { license: "cc0", landingUrl: "https://evil.example/", attribution: "Mine now", originalWidth: 1, originalHeight: 1 };
    t.publicMock.get("https://art.example").intercept({ path: "/plain.png" }).reply(200, squarePng);
    const plain = await post(t.app, roomId, player, { url: "https://art.example/plain.png", kind: "token", credit: forgedCredit });
    assert.equal(plain.statusCode, 200, plain.body);
    assert.equal(plain.json().credit, undefined);
    assert.equal(await storedCredit(plain.json().id), null);

    const result = await cachedResult();
    t.publicMock.get("https://images.example").intercept({ path: new URL(result.original).pathname }).reply(200, tokenPng);
    const picked = await post(t.app, roomId, player, { url: result.original, kind: "token", credit: forgedCredit });
    assert.deepEqual(await storedCredit(picked.json().id), { ...result.credit, originalWidth: 700, originalHeight: 350 });
  });

  test("the same image already in the room, added without a credit, takes the credit", async () => {
    const t = await importApp();
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const bytes = await solid(64, 64, "#5a5").png().toBuffer();
    const uploaded = await t.app.inject({
      method: "PUT",
      url: `/api/rooms/${roomId}/assets?kind=token`,
      headers: { "content-type": "image/png", "cf-connecting-ip": freshIp(), ...player.headers },
      payload: bytes,
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    assert.equal(uploaded.json().credit, undefined);
    assert.equal(await storedCredit(uploaded.json().id), null);

    const result = await cachedResult();
    t.publicMock.get("https://images.example").intercept({ path: new URL(result.original).pathname }).reply(200, bytes);
    const picked = await post(t.app, roomId, player, { url: result.original, kind: "token" });
    assert.equal(picked.json().id, uploaded.json().id);
    assert.deepEqual(await storedCredit(uploaded.json().id), { ...result.credit, originalWidth: 64, originalHeight: 64 });
  });

  test("a search, a pick and the listing, end to end", async () => {
    const publicMock = new MockAgent();
    publicMock.disableNetConnect();
    const strictMock = new MockAgent();
    strictMock.disableNetConnect();
    const item = openverseItem(1, { url: `https://images.example/${randomUUID()}.png` });
    const app = await searchApp({ openverse: fakeOpenverse({ items: () => [item] }).http, egress: { public: publicMock, strict: strictMock } });
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const found = await search(app, roomId, dm, `troll ${run}`, freshIp(), "openverse");
    const [first] = found.json<{ results: Array<{ original: string; thumbnail: string; credit: ImageCredit }> }>().results;
    assert.ok(first);
    publicMock.get("https://images.example").intercept({ path: new URL(item.url).pathname }).reply(200, tokenPng);
    const picked = await post(app, roomId, dm, { url: first.original, fallback: first.thumbnail, kind: "handout" });
    assert.equal(picked.statusCode, 200, picked.body);
    const listed = (await app.inject({ url: `/api/rooms/${roomId}/assets`, headers: dm.headers })).json<{ assets: Array<{ credit?: unknown }> }>();
    assert.deepEqual(listed.assets[0]?.credit, {
      title: item.title,
      creator: "Someone",
      license: "by-sa",
      licenseVersion: "2.0",
      landingUrl: item.foreign_landing_url,
      attribution: item.attribution,
      originalWidth: 700,
      originalHeight: 350,
    });
  });
});
