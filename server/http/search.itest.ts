import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { OpenverseHttp } from "../assets/openverse.ts";
import type { HttpJson } from "../assets/serpapi.ts";
import { FakeAuth, buildAssetApp, dropRooms, makeRoom, testConfig, testPool } from "../assets/testApp.ts";
import { tempDir } from "../assets/testImages.ts";

const KEY = "test-serpapi-key-never-leaves";
const run = `${process.pid}-${Date.now()}`;

let pool: pg.Pool;
let dir: string;
let cleanupDir: () => Promise<void>;
const auth = new FakeAuth();
const rooms: string[] = [];
const apps: FastifyInstance[] = [];
const ips: string[] = [];

before(async () => {
  pool = await testPool();
  ({ dir, cleanup: cleanupDir } = await tempDir());
});

/**
 * Once SerpApi refuses for quota, Openverse answers (openverse.itest.ts).
 * Here it answers with nothing, on a day long past, so the server-wide
 * count it keeps is this file's alone.
 */
const OPENVERSE_NOW = Date.UTC(2000, 0, 1 + (process.pid % 3000), 12);
const OPENVERSE_DAY = new Date(OPENVERSE_NOW).toISOString().slice(0, 10);
const quietOpenverse: OpenverseHttp = async () => ({ status: 200, body: { results: [] } });

after(async () => {
  for (const app of apps) await app.close();
  await pool.query(`delete from search_cache where q like $1`, [`%${run}%`]);
  await pool.query(`delete from search_usage where bucket like any($1)`, [
    [...rooms.map((r) => `r:${r}:%`), ...ips.map((ip) => `ip:${ip}:%`), `ov:%:${OPENVERSE_DAY}`],
  ]);
  await dropRooms(pool, rooms);
  await pool.end();
  await cleanupDir();
});

/** A stand-in for serpapi.com: the Account API and Google Images results. */
function fakeSerpApi(account: { left: number; thisHour: number }, behavior: { fail?: boolean; empty?: boolean } = {}) {
  const calls = { account: 0, search: [] as string[] };
  const http: HttpJson = async (url) => {
    const u = new URL(url);
    assert.equal(u.hostname, "serpapi.com");
    assert.equal(u.searchParams.get("api_key"), KEY);
    if (u.pathname === "/account.json") {
      calls.account++;
      return {
        status: 200,
        body: { api_key: KEY, plan_searches_left: account.left, this_hour_searches: account.thisHour },
      };
    }
    assert.equal(u.pathname, "/search.json");
    assert.equal(u.searchParams.get("engine"), "google_images");
    assert.equal(u.searchParams.get("safe"), "active");
    const q = u.searchParams.get("q") ?? "";
    calls.search.push(q);
    if (behavior.fail) return { status: 500, body: { error: "Internal error" } };
    if (behavior.empty) return { status: 200, body: { error: "Google hasn't returned any results for this query." } };
    return {
      status: 200,
      body: {
        search_metadata: { status: "Success" },
        images_results: Array.from({ length: 60 }, (_, i) => ({
          position: i + 1,
          thumbnail: `https://serpapi.com/searches/${encodeURIComponent(q)}/images/${i}.jpeg`,
          original: `https://art.example/${i}.png`,
          title: `Result ${i}`,
          source: "art.example",
          original_width: 800,
          original_height: 600,
          link: `https://art.example/page/${i}`,
        })),
      },
    };
  };
  return { http, calls };
}

async function searchApp(http: HttpJson) {
  const app = await buildAssetApp({
    pool,
    config: testConfig(dir, { SERPAPI_KEY: KEY }),
    auth,
    options: { serpApiHttp: http, openverse: { http: quietOpenverse, now: () => OPENVERSE_NOW } },
  });
  apps.push(app);
  return app;
}

async function room(ageHours = 48): Promise<string> {
  const id = await makeRoom(pool, { ageHours });
  rooms.push(id);
  return id;
}

let ipCounter = 0;
function freshIp(): string {
  const ip = `s-${process.pid}-${++ipCounter}`;
  ips.push(ip);
  return ip;
}

function search(app: FastifyInstance, roomId: string, who: { headers: Record<string, string> }, q: string, ip: string) {
  return app.inject({
    method: "POST",
    url: `/api/rooms/${roomId}/image-search`,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...who.headers },
    payload: JSON.stringify({ q }),
  });
}

/** SerpApi refused for quota, so Openverse answered in its place. */
function tookOver(res: { statusCode: number; body: string; json(): unknown }): void {
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { source: string }).source, "openverse");
}

async function usage(bucketPrefix: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(`select count from search_usage where bucket like $1`, [`${bucketPrefix}%`]);
  return rows[0]?.count ?? 0;
}

// Without SERPAPI_KEY Openverse answers, which openverse.itest.ts tests.
describe("image search", () => {
  test("members only", async () => {
    const app = await searchApp(fakeSerpApi({ left: 200, thisHour: 0 }).http);
    const roomId = await room();
    assert.equal((await search(app, roomId, { headers: {} }, "goblin", freshIp())).statusCode, 403);
  });

  test("results are trimmed to 40 safe fields, cached by normalized query, and never carry the key", async () => {
    const fake = fakeSerpApi({ left: 200, thisHour: 0 });
    const app = await searchApp(fake.http);
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const ip = freshIp();
    const q = `Goblin Archer ${run}`;

    const first = await search(app, roomId, player, `  ${q} `, ip);
    assert.equal(first.statusCode, 200, first.body);
    const results = first.json().results;
    assert.equal(results.length, 40);
    assert.deepEqual(Object.keys(results[0]).sort(), ["original", "original_height", "original_width", "source", "thumbnail", "title"]);
    assert.ok(!first.body.includes(KEY));
    assert.deepEqual(fake.calls.search, [q.toLowerCase()]);

    const again = await search(app, roomId, player, q.toUpperCase(), ip);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), first.json());
    assert.equal(fake.calls.search.length, 1, "the repeat came from the cache");
    assert.equal(await usage(`r:${roomId}:`), 1);
    assert.equal(await usage(`ip:${ip}:`), 1);

    const { rows } = await pool.query(`select results::text from search_cache where q = $1`, [q.toLowerCase()]);
    assert.ok(!rows[0].results.includes(KEY));
  });

  test("a room younger than a day gets 5 searches", async () => {
    const fake = fakeSerpApi({ left: 200, thisHour: 0 });
    const app = await searchApp(fake.http);
    const roomId = await room(1);
    const player = auth.allow(roomId, "player");
    for (let i = 0; i < 5; i++) {
      const res = await search(app, roomId, player, `young ${i} ${run}`, freshIp());
      assert.equal(res.statusCode, 200, res.body);
    }
    tookOver(await search(app, roomId, player, `young 5 ${run}`, freshIp()));
    assert.equal(fake.calls.search.length, 5);
    assert.equal(await usage(`r:${roomId}:`), 5);
  });

  test("an older room gets 60 a month", async () => {
    const fake = fakeSerpApi({ left: 500, thisHour: 0 });
    const app = await searchApp(fake.http);
    const roomId = await room();
    const month = new Date().toISOString().slice(0, 7);
    await pool.query(`insert into search_usage (bucket, count) values ($1, 59)`, [`r:${roomId}:${month}`]);
    const player = auth.allow(roomId, "player");
    assert.equal((await search(app, roomId, player, `older a ${run}`, freshIp())).json().source, "google");
    tookOver(await search(app, roomId, player, `older b ${run}`, freshIp()));
    assert.equal(fake.calls.search.length, 1);
  });

  test("an IP gets 15 a day across rooms and new sessions", async () => {
    const fake = fakeSerpApi({ left: 500, thisHour: 0 });
    const app = await searchApp(fake.http);
    const ip = freshIp();
    const roomA = await room();
    const roomB = await room();
    for (let i = 0; i < 15; i++) {
      const roomId = i % 2 ? roomA : roomB;
      const res = await search(app, roomId, auth.allow(roomId, "player"), `ip ${i} ${run}`, ip);
      assert.equal(res.statusCode, 200, res.body);
    }
    tookOver(await search(app, roomA, auth.allow(roomA, "player"), `ip 15 ${run}`, ip));
    assert.equal(fake.calls.search.length, 15);
    // The refused search did not spend the room's count either.
    assert.equal(await usage(`r:${roomA}:`), 7);
  });

  test("SerpApi's own count stops Google under 10 left and refunds the room and IP", async () => {
    const fake = fakeSerpApi({ left: 10, thisHour: 0 });
    const app = await searchApp(fake.http);
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const ip = freshIp();
    assert.equal((await search(app, roomId, player, `global a ${run}`, ip)).statusCode, 200);
    tookOver(await search(app, roomId, player, `global b ${run}`, ip));
    assert.equal(fake.calls.account, 1, "the account read is cached");
    assert.equal(fake.calls.search.length, 1);
    assert.equal(await usage(`r:${roomId}:`), 1);
    assert.equal(await usage(`ip:${ip}:`), 1);
  });

  test("45 searches this hour stops Google", async () => {
    const fake = fakeSerpApi({ left: 200, thisHour: 45 });
    const app = await searchApp(fake.http);
    const roomId = await room();
    tookOver(await search(app, roomId, auth.allow(roomId, "player"), `hourly ${run}`, freshIp()));
    assert.equal(fake.calls.search.length, 0);
  });

  test("a failed search is not charged to the room or the IP", async () => {
    const fake = fakeSerpApi({ left: 200, thisHour: 0 }, { fail: true });
    const app = await searchApp(fake.http);
    const roomId = await room();
    const ip = freshIp();
    const res = await search(app, roomId, auth.allow(roomId, "player"), `broken ${run}`, ip);
    assert.equal(res.statusCode, 502);
    assert.ok(!res.body.includes(KEY));
    assert.equal(await usage(`r:${roomId}:`), 0);
    assert.equal(await usage(`ip:${ip}:`), 0);
  });

  test("no results is an answer, and is cached", async () => {
    const fake = fakeSerpApi({ left: 200, thisHour: 0 }, { empty: true });
    const app = await searchApp(fake.http);
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const q = `qwzxv ${run}`;
    assert.deepEqual((await search(app, roomId, player, q, freshIp())).json(), { results: [], source: "google" });
    assert.deepEqual((await search(app, roomId, player, q, freshIp())).json(), { results: [], source: "google" });
    assert.equal(fake.calls.search.length, 1);
  });

  test("concurrent identical searches cost one", async () => {
    const fake = fakeSerpApi({ left: 200, thisHour: 0 });
    const app = await searchApp(fake.http);
    const roomId = await room();
    const q = `owlbear ${run}`;
    const results = await Promise.all(
      [1, 2, 3].map(() => search(app, roomId, auth.allow(roomId, "player"), q, freshIp())),
    );
    assert.ok(results.every((r) => r.statusCode === 200));
    assert.equal(fake.calls.search.length, 1);
    assert.equal(await usage(`r:${roomId}:`), 1);
  });

  test("an empty or oversized query is refused before any spending", async () => {
    const fake = fakeSerpApi({ left: 200, thisHour: 0 });
    const app = await searchApp(fake.http);
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    assert.equal((await search(app, roomId, player, "   ", freshIp())).statusCode, 400);
    assert.equal((await search(app, roomId, player, "x".repeat(150), freshIp())).statusCode, 400);
    assert.equal(fake.calls.account + fake.calls.search.length, 0);
  });
});
