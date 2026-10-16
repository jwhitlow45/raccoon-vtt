import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { MockAgent } from "undici";
import { PIPELINE } from "../assets/kinds.ts";
import { deleteUnreferencedFiles, roomFileKeys, variantPath } from "../assets/store.ts";
import { FakeAuth, buildAssetApp, dropRooms, makeRoom, testConfig, testPool } from "../assets/testApp.ts";
import { SVG, checkerboardPng, solid, tempDir } from "../assets/testImages.ts";
import { startEngine, type Engine, type TestClient } from "../rooms/testing.ts";
import { uuidv7 } from "#shared/ids.ts";

let pool: pg.Pool;
let dir: string;
let cleanupDir: () => Promise<void>;
let auth: FakeAuth;
let app: FastifyInstance;
const rooms: string[] = [];

let tokenPng: Buffer;
let otherPng: Buffer;

before(async () => {
  pool = await testPool();
  ({ dir, cleanup: cleanupDir } = await tempDir());
  auth = new FakeAuth();
  app = await buildAssetApp({ pool, config: testConfig(dir), auth });
  tokenPng = await solid(700, 350, "#a33").png().toBuffer();
  otherPng = await solid(300, 300, "#33a").png().toBuffer();
});

after(async () => {
  await app.close();
  await dropRooms(pool, rooms);
  await pool.end();
  await cleanupDir();
});

async function room(opts: Parameters<typeof makeRoom>[1] = {}): Promise<string> {
  const id = await makeRoom(pool, opts);
  rooms.push(id);
  return id;
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter++;
  return `t-${process.pid}-${ipCounter}`;
}

function upload(
  target: FastifyInstance,
  roomId: string,
  who: { headers: Record<string, string> },
  kind: string,
  body: Buffer | Readable,
  extra: Record<string, string> = {},
  query = "",
) {
  return target.inject({
    method: "PUT",
    url: `/api/rooms/${roomId}/assets?kind=${kind}${query}`,
    headers: { "content-type": "image/png", "cf-connecting-ip": freshIp(), ...who.headers, ...extra },
    payload: body,
  });
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("upload", () => {
  test("a token upload makes WebP variants named by content and answers with the row", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const res = await upload(app, roomId, player, "token", tokenPng);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ["height", "id", "kind", "variants", "width"]);
    assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(body.kind, "token");
    assert.deepEqual([body.width, body.height], [512, 256]);
    assert.deepEqual(body.variants, ["full", "thumb"]);
    for (const v of ["full", "thumb"] as const) {
      const path = variantPath(join(dir), sha(tokenPng), "token", v, PIPELINE);
      assert.ok(path.includes(`/${sha(tokenPng).slice(0, 2)}/${sha(tokenPng)}-token-${v}-v${PIPELINE}.webp`));
      assert.ok(await exists(path), path);
    }
    // Nothing is left in the temp folder.
    assert.deepEqual(await readdir(join(dir, "tmp")), []);
  });

  test("identical bytes from a second member reuse the row with an identical answer", async () => {
    const roomId = await room();
    const first = auth.allow(roomId, "player");
    const second = auth.allow(roomId, "player");
    const a = await upload(app, roomId, first, "token", otherPng);
    const b = await upload(app, roomId, second, "token", otherPng);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, a.statusCode);
    assert.equal(a.body, b.body);
    const headerNames = (h: Record<string, unknown>) => Object.keys(h).filter((k) => k !== "date").sort();
    assert.deepEqual(headerNames(a.headers), headerNames(b.headers));
    const { rows } = await pool.query(`select member_id from asset_uploaders where asset_id = $1 order by member_id`, [a.json().id]);
    assert.deepEqual(rows.map((r) => r.member_id).sort(), [first.memberId, second.memberId].sort());
    // The second uploader can now read it.
    const read = await app.inject({ url: `/api/assets/${a.json().id}/full`, headers: second.headers });
    assert.equal(read.statusCode, 200);
  });

  test("concurrent identical uploads to one room end as one row with both uploaders", async () => {
    const roomId = await room();
    const first = auth.allow(roomId, "player");
    const second = auth.allow(roomId, "player");
    const bytes = await solid(321, 123, "#c0c").png().toBuffer();
    const [a, b] = await Promise.all([upload(app, roomId, first, "token", bytes), upload(app, roomId, second, "token", bytes)]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.body, b.body);
    const { rows } = await pool.query(`select count(*)::int as n from asset_uploaders where asset_id = $1`, [a.json().id]);
    assert.equal(rows[0].n, 2);
    assert.ok(await exists(variantPath(dir, sha(bytes), "token", "full", PIPELINE)));
  });

  test("players may upload tokens only, and refusals close the connection", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const dm = auth.allow(roomId, "dm");
    for (const kind of ["map", "handout"]) {
      const res = await upload(app, roomId, player, kind, otherPng);
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers.connection, "close");
    }
    assert.equal((await upload(app, roomId, dm, "handout", otherPng)).statusCode, 200);
    const nobody = await upload(app, roomId, { headers: {} }, "token", otherPng);
    assert.equal(nobody.statusCode, 403);
  });

  test("a map upload suggests cellPx from a 30x20 style name", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const map = await solid(1500, 1000).jpeg().toBuffer();
    const res = await upload(app, roomId, dm, "map", map, { "content-type": "image/jpeg" }, "&name=crypt_30x20.jpg");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().cellPx, 50);
    assert.deepEqual(res.json().variants, ["full", "mobile", "thumb"]);
  });

  test("SVG is refused by its content type and by its bytes", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    assert.equal((await upload(app, roomId, player, "token", SVG, { "content-type": "image/svg+xml" })).statusCode, 415);
    assert.equal((await upload(app, roomId, player, "token", SVG)).statusCode, 415);
    assert.equal((await upload(app, roomId, player, "token", otherPng, { "content-type": "application/json" })).statusCode, 415);
  });

  test("a corrupt image is refused with 422", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const jpg = await solid(200, 200).jpeg().toBuffer();
    const res = await upload(app, roomId, player, "token", jpg.subarray(0, jpg.length >> 1), { "content-type": "image/jpeg" });
    assert.equal(res.statusCode, 422);
    assert.deepEqual(res.json(), { error: "bad_image" });
  });

  test("a declared size over the kind's cap is refused before reading", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const res = await app.inject({
      method: "PUT",
      url: `/api/rooms/${roomId}/assets?kind=token`,
      headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024), ...player.headers },
      payload: otherPng,
    });
    assert.equal(res.statusCode, 413);
    assert.equal(res.headers.connection, "close");
  });

  test("a read-only room takes no uploads", async () => {
    const roomId = await room({ readOnly: true });
    const dm = auth.allow(roomId, "dm");
    assert.equal((await upload(app, roomId, dm, "token", otherPng)).statusCode, 409);
  });
});

describe("intake slots", () => {
  test("with every slot taken the answer is 503 with Retry-After, and the body is never read", async () => {
    const roomId = await room();
    const pinnedRoom = await room({ pinned: true });
    const player = auth.allow(roomId, "player");
    const dm = auth.allow(pinnedRoom, "dm");
    const held = [1, 2, 3].map((i) => app.assets.slots.tryAcquire({ kind: "upload", roomId: `HOLD000${i}`, ip: `h${i}`, sessionId: `h${i}`, pinned: false }));
    try {
      let read = false;
      const body = new Readable({
        read() {
          read = true;
          this.push(otherPng);
          this.push(null);
        },
      });
      const res = await upload(app, roomId, player, "token", body);
      assert.equal(res.statusCode, 503);
      assert.ok(Number(res.headers["retry-after"]) > 0);
      assert.equal(res.headers.connection, "close");
      assert.equal(read, false);
      // The slot kept for pinned rooms is still free.
      const pinned = await upload(app, pinnedRoom, dm, "token", otherPng);
      assert.equal(pinned.statusCode, 200, pinned.body);
    } finally {
      for (const release of held) release?.();
    }
    assert.equal(app.assets.slots.inUse, 0);
  });

  test("addresses in one IPv6 /64 share the per-IP slot and the hourly per-IP budget", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const held = app.assets.slots.tryAcquire({ kind: "upload", roomId: "HOLD0IP6", ip: "2001:db8:aa:1::/64", sessionId: "other", pinned: false });
    try {
      const busy = await upload(app, roomId, player, "token", otherPng, { "cf-connecting-ip": "2001:db8:aa:1::99" });
      assert.equal(busy.statusCode, 503);
    } finally {
      held?.();
    }
    const checks = app.assets.hourlyChecks("other", "2001:db8:aa:2::/64", "OTHERRM0").slice(1, 2);
    for (let i = 0; i < 60; i++) app.assets.hourly.record(checks);
    const limited = await upload(app, roomId, auth.allow(roomId, "player"), "token", otherPng, { "cf-connecting-ip": "2001:db8:aa:2:1:2:3:4" });
    assert.equal(limited.statusCode, 429);
    const elsewhere = await upload(app, roomId, auth.allow(roomId, "player"), "token", otherPng, { "cf-connecting-ip": "2001:db8:aa:3::1" });
    assert.equal(elsewhere.statusCode, 200, elsewhere.body);
  });

  test("thumbnails have their own hourly budget, so a burst of them leaves the map budget untouched", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    // More thumbnails than the 30 uploads a session gets for maps and tokens.
    for (let i = 0; i < 31; i++) {
      const thumb = await solid(160, 90 + i, "#3a6").png().toBuffer();
      const res = await upload(app, roomId, dm, "thumb", thumb);
      assert.equal(res.statusCode, 200, `thumbnail ${i + 1}: ${res.body}`);
    }
    const map = await upload(app, roomId, dm, "map", otherPng);
    assert.equal(map.statusCode, 200, map.body);
  });

  test("the thumbnail budget still refuses past its own limit, and leaves maps alone", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const checks = app.assets.hourlyChecks(dm.sessionId, "x", roomId, "thumb");
    for (let i = 0; i < 240; i++) app.assets.hourly.record(checks);
    const thumb = await upload(app, roomId, dm, "thumb", await solid(160, 90, "#36a").png().toBuffer());
    assert.equal(thumb.statusCode, 429);
    assert.ok(Number(thumb.headers["retry-after"]) > 0);
    const map = await upload(app, roomId, dm, "map", otherPng);
    assert.equal(map.statusCode, 200, map.body);
  });

  test("handouts have their own hourly budget per session and per room, so a PDF's pages leave maps and tokens alone (docs/design-v1-pdf-handouts.md 3.7)", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    // The shared budget spent: a map is refused, and a handout still goes up.
    const shared = app.assets.hourlyChecks(dm.sessionId, "x", roomId).slice(0, 1);
    for (let i = 0; i < 30; i++) app.assets.hourly.record(shared);
    assert.equal((await upload(app, roomId, dm, "map", otherPng)).statusCode, 429);
    const page = await upload(app, roomId, dm, "handout", await solid(120, 160, "#6a3").png().toBuffer());
    assert.equal(page.statusCode, 200, page.body);
    // The handout budget spent: a handout is refused, a map still goes up.
    const other = auth.allow(roomId, "dm");
    const own = app.assets.hourlyChecks(other.sessionId, "x", roomId, "handout");
    assert.deepEqual(own.map((c) => c.limit), [250, 250]);
    for (let i = 0; i < 250; i++) app.assets.hourly.record(own.slice(0, 1));
    const refused = await upload(app, roomId, other, "handout", await solid(120, 161, "#6a3").png().toBuffer());
    assert.equal(refused.statusCode, 429);
    assert.ok(Number(refused.headers["retry-after"]) > 0);
    assert.equal((await upload(app, roomId, other, "map", await solid(300, 301, "#33a").png().toBuffer())).statusCode, 200);
    // Per room too: a fresh session in a room whose handout budget is spent is refused.
    const busy = await room();
    for (let i = 0; i < 250; i++) app.assets.hourly.record(app.assets.hourlyChecks("anyone", "x", busy, "handout").slice(1));
    assert.equal((await upload(app, busy, auth.allow(busy, "dm"), "handout", otherPng)).statusCode, 429);
  });

  test("a handout upload says whether it made the image, true for new bytes and false for bytes the room has, and a token's answer never says (docs/design-v1-pdf-handouts.md 3.9)", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    // Bytes no other test uploads, so no other room's row or file is shared with these.
    const bytes = await solid(237, 119, "#4b7").png().toBuffer();
    const first = await upload(app, roomId, dm, "handout", bytes);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(Object.keys(first.json()).sort(), ["created", "height", "id", "kind", "variants", "width"]);
    assert.equal(first.json().created, true);
    const again = await upload(app, roomId, auth.allow(roomId, "dm"), "handout", bytes);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().created, false);
    assert.equal(again.json().id, first.json().id);
    // The same bytes as a token are a row of their own, whose answer has no `created` either time.
    for (let i = 0; i < 2; i++) {
      const token = await upload(app, roomId, auth.allow(roomId, "player"), "token", bytes);
      assert.equal(token.statusCode, 200, token.body);
      assert.equal("created" in token.json(), false);
    }
    // Two identical uploads at once: exactly one made the row.
    const fresh = await solid(238, 119, "#4b8").png().toBuffer();
    const [a, b] = await Promise.all([upload(app, roomId, dm, "handout", fresh), upload(app, roomId, auth.allow(roomId, "dm"), "handout", fresh)]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.json().id, b.json().id);
    assert.deepEqual([a.json().created, b.json().created].sort(), [false, true]);
  });

  test("the hourly upload budget per session answers 429", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const checks = app.assets.hourlyChecks(player.sessionId, "x", roomId).slice(0, 1);
    for (let i = 0; i < 30; i++) app.assets.hourly.record(checks);
    const res = await upload(app, roomId, player, "token", otherPng);
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers["retry-after"]) > 0);
  });
});

describe("quota", () => {
  test("variants larger than the upload are reserved before the row is written, or refused", async () => {
    const quotaDir = await tempDir();
    const small = await buildAssetApp({ pool, config: testConfig(quotaDir.dir, { ROOM_QUOTA_MB: "1" }), auth });
    try {
      const roomId = await room();
      const dm = auth.allow(roomId, "dm");
      // A few KB as PNG, well over 1 MiB of WebP variants.
      const checker = await checkerboardPng(2048);
      assert.ok(checker.length < 16 * 1024);
      const res = await upload(small, roomId, dm, "map", checker);
      assert.equal(res.statusCode, 413);
      assert.deepEqual(res.json(), { error: "quota_exceeded" });
      const { rowCount } = await pool.query(`select 1 from assets where room_id = $1`, [roomId]);
      assert.equal(rowCount, 0);
      // No variant files were placed, and the temp folder is empty.
      assert.equal(await exists(variantPath(quotaDir.dir, sha(checker), "map", "full", PIPELINE)), false);
      assert.deepEqual(await readdir(join(quotaDir.dir, "tmp")), []);
      assert.equal(small.assets.quota.reservedBytes(roomId), 0);
      // A small image still fits.
      assert.equal((await upload(small, roomId, dm, "token", otherPng)).statusCode, 200);
    } finally {
      await small.close();
      await quotaDir.cleanup();
    }
  });

  test("a declared size the room cannot hold is refused before reading", async () => {
    const quotaDir = await tempDir();
    const small = await buildAssetApp({ pool, config: testConfig(quotaDir.dir, { ROOM_QUOTA_MB: "1" }), auth });
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      const res = await upload(small, roomId, player, "token", Buffer.alloc(2 * 1024 * 1024, 1));
      assert.equal(res.statusCode, 413);
      assert.equal(res.headers.connection, "close");
    } finally {
      await small.close();
      await quotaDir.cleanup();
    }
  });

  test("the free-disk guard refuses uploads", async () => {
    const fullDir = await tempDir();
    const full = await buildAssetApp({ pool, config: testConfig(fullDir.dir), auth, options: { minFreeBytes: Number.MAX_SAFE_INTEGER } });
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      const res = await upload(full, roomId, player, "token", otherPng);
      assert.equal(res.statusCode, 507);
    } finally {
      await full.close();
      await fullDir.cleanup();
    }
  });
});

describe("files shared between rooms", () => {
  test("deleting one room keeps files another room still uses", async () => {
    const roomA = await room();
    const roomB = await room();
    const bytes = await solid(222, 111, "#5a5").png().toBuffer();
    const a = await upload(app, roomA, auth.allow(roomA, "player"), "token", bytes);
    const b = await upload(app, roomB, auth.allow(roomB, "player"), "token", bytes);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.notEqual(a.json().id, b.json().id);
    const full = variantPath(dir, sha(bytes), "token", "full", PIPELINE);
    assert.ok(await exists(full));

    const keysA = await roomFileKeys(pool, roomA);
    await dropRooms(pool, [roomA]);
    assert.equal(await deleteUnreferencedFiles(pool, dir, keysA), 0);
    assert.ok(await exists(full));

    const keysB = await roomFileKeys(pool, roomB);
    await dropRooms(pool, [roomB]);
    assert.equal(await deleteUnreferencedFiles(pool, dir, keysB), 2);
    assert.equal(await exists(full), false);
  });
});

describe("listing and serving", () => {
  test("a DM sees every asset, a player only what they may see, and reads follow the same rule", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const alice = auth.allow(roomId, "player");
    const bob = auth.allow(roomId, "player");
    const map = (await upload(app, roomId, dm, "map", await solid(800, 600, "#123").png().toBuffer())).json();
    const aliceToken = (await upload(app, roomId, alice, "token", await solid(64, 64, "#456").png().toBuffer())).json();

    const list = async (who: { headers: Record<string, string> }) =>
      (await app.inject({ url: `/api/rooms/${roomId}/assets`, headers: who.headers })).json().assets.map((a: { id: string }) => a.id).sort();
    assert.deepEqual(await list(dm), [map.id, aliceToken.id].sort());
    assert.deepEqual(await list(alice), [aliceToken.id]);
    assert.deepEqual(await list(bob), []);
    assert.equal((await app.inject({ url: `/api/rooms/${roomId}/assets` })).statusCode, 403);

    const get = (who: { headers: Record<string, string> }, id: string, variant: string) =>
      app.inject({ url: `/api/assets/${id}/${variant}`, headers: who.headers });

    const ok = await get(alice, aliceToken.id, "thumb");
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["content-type"], "image/webp");
    assert.equal(ok.headers["cache-control"], "private, max-age=31536000, immutable");
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal(ok.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(ok.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(ok.rawPayload.subarray(8, 12).toString("latin1"), "WEBP");

    assert.equal((await get(dm, aliceToken.id, "full")).statusCode, 200);
    assert.equal((await get(dm, map.id, "mobile")).statusCode, 200);
    // A player may not read the DM's map or another player's upload.
    assert.equal((await get(alice, map.id, "full")).statusCode, 404);
    assert.equal((await get(bob, aliceToken.id, "full")).statusCode, 404);
    // A variant the row does not have, or that does not exist at all.
    assert.equal((await get(alice, aliceToken.id, "mobile")).statusCode, 404);
    assert.equal((await get(dm, map.id, "..%2F..%2Fetc%2Fpasswd")).statusCode, 404);
    assert.equal((await get(dm, "not-a-uuid", "full")).statusCode, 404);
    // A grant for another room does not open this one.
    const otherRoom = await room();
    const stranger = auth.allow(otherRoom, "dm");
    assert.equal((await get(stranger, map.id, "full")).statusCode, 404);
  });

  test("an injected visibility function replaces the default", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const player = auth.allow(roomId, "player");
    const handout = (await upload(app, roomId, dm, "handout", await solid(90, 60, "#789").png().toBuffer())).json();
    const previous = app.assets.visibleAssets.bind(app.assets);
    app.assets.setVisibleAssets(async (r, m) => (r === roomId && m === player.memberId ? new Set([handout.id]) : previous(r, m)));
    try {
      const listed = (await app.inject({ url: `/api/rooms/${roomId}/assets`, headers: player.headers })).json().assets;
      assert.deepEqual(listed.map((a: { id: string }) => a.id), [handout.id]);
      assert.equal((await app.inject({ url: `/api/assets/${handout.id}/full`, headers: player.headers })).statusCode, 200);
    } finally {
      app.assets.setVisibleAssets(previous);
    }
  });
});

describe("URL import", () => {
  async function importApp() {
    const importDir = await tempDir();
    const publicMock = new MockAgent();
    publicMock.disableNetConnect();
    const strictMock = new MockAgent();
    strictMock.disableNetConnect();
    const imp = await buildAssetApp({
      pool,
      config: testConfig(importDir.dir),
      auth,
      options: {
        egress: {
          public: publicMock,
          strict: strictMock,
          close: async () => {
            await publicMock.close();
            await strictMock.close();
          },
        },
      },
    });
    return {
      imp,
      publicMock,
      strictMock,
      async close() {
        await imp.close();
        await importDir.cleanup();
      },
    };
  }

  const post = (target: FastifyInstance, roomId: string, who: { headers: Record<string, string> }, body: unknown) =>
    target.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/assets/import`,
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp(), ...who.headers },
      payload: JSON.stringify(body),
    });

  test("imports an image through the public egress", async () => {
    const t = await importApp();
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      t.publicMock.get("https://art.example").intercept({ path: "/goblin.png" }).reply(200, tokenPng);
      const res = await post(t.imp, roomId, player, { url: "https://art.example/goblin.png", kind: "token" });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(Object.keys(res.json()).sort(), ["height", "id", "kind", "variants", "width"]);
    } finally {
      await t.close();
    }
  });

  test("falls back to a cached serpapi.com thumbnail through the strict egress", async () => {
    const t = await importApp();
    const q = `fallback test ${process.pid} ${Date.now()}`;
    const thumbnail = `https://serpapi.com/searches/${process.pid}${Date.now()}/images/1.jpeg`;
    await pool.query(`insert into search_cache (q, results, fetched_at) values ($1, $2, now())`, [
      q,
      JSON.stringify([{ thumbnail, original: "https://hotlink.example/x.png", title: "", source: "" }]),
    ]);
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      t.publicMock.get("https://hotlink.example").intercept({ path: "/x.png" }).reply(403, "no hotlinking");
      t.strictMock.get("https://serpapi.com").intercept({ path: new URL(thumbnail).pathname }).reply(200, otherPng);
      const res = await post(t.imp, roomId, player, { url: "https://hotlink.example/x.png", fallback: thumbnail, kind: "token" });
      assert.equal(res.statusCode, 200, res.body);

      // A fallback that SerpApi never handed out is refused up front.
      const forged = await post(t.imp, roomId, player, {
        url: "https://hotlink.example/x.png",
        fallback: "https://serpapi.com/searches/forged/images/1.jpeg",
        kind: "token",
      });
      assert.equal(forged.statusCode, 400);
      assert.deepEqual(forged.json(), { error: "bad_fallback" });
    } finally {
      await pool.query(`delete from search_cache where q = $1`, [q]);
      await t.close();
    }
  });

  test("falls back to a cached Google thumbnail through the public egress", async () => {
    const t = await importApp();
    const q = `gstatic fallback ${process.pid} ${Date.now()}`;
    const thumbnail = `https://encrypted-tbn0.gstatic.com/images?q=tbn:${process.pid}${Date.now()}`;
    await pool.query(`insert into search_cache (q, results, fetched_at) values ($1, $2, now())`, [
      q,
      JSON.stringify([{ thumbnail, original: "https://hotlink.example/y.png", title: "", source: "" }]),
    ]);
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      t.publicMock.get("https://hotlink.example").intercept({ path: "/y.png" }).reply(403, "no hotlinking");
      const u = new URL(thumbnail);
      t.publicMock.get("https://encrypted-tbn0.gstatic.com").intercept({ path: u.pathname + u.search }).reply(200, otherPng);
      const res = await post(t.imp, roomId, player, { url: "https://hotlink.example/y.png", fallback: thumbnail, kind: "token" });
      assert.equal(res.statusCode, 200, res.body);

      // A Google thumbnail no search handed out is refused like any other.
      const forged = await post(t.imp, roomId, player, {
        url: "https://hotlink.example/y.png",
        fallback: "https://encrypted-tbn0.gstatic.com/images?q=tbn:forged",
        kind: "token",
      });
      assert.equal(forged.statusCode, 400);
      assert.deepEqual(forged.json(), { error: "bad_fallback" });
    } finally {
      await pool.query(`delete from search_cache where q = $1`, [q]);
      await t.close();
    }
  });

  test("SSRF-shaped URLs are refused", async () => {
    const t = await importApp();
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      for (const url of ["https://127.0.0.1/x.png", "http://art.example/x.png", "https://art.example:8443/x.png", "https://localhost/x.png"]) {
        const res = await post(t.imp, roomId, player, { url, kind: "token" });
        assert.equal(res.statusCode, 400, url);
      }
      t.publicMock.get("https://art.example").intercept({ path: "/r" }).reply(302, "", { headers: { location: "https://10.0.0.1/" } });
      const redirected = await post(t.imp, roomId, player, { url: "https://art.example/r", kind: "token" });
      assert.equal(redirected.statusCode, 422);
      assert.deepEqual(redirected.json(), { error: "fetch_failed" });
    } finally {
      await t.close();
    }
  });

  test("with all outbound fetch slots busy the answer is 503 before anything is fetched", async () => {
    const t = await importApp();
    const held = [1, 2, 3, 4].map(() => t.imp.assets.outbound.tryAcquire());
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      const res = await post(t.imp, roomId, player, { url: "https://art.example/never.png", kind: "token" });
      assert.equal(res.statusCode, 503);
      assert.ok(Number(res.headers["retry-after"]) > 0);
    } finally {
      for (const release of held) release?.();
      await t.close();
    }
  });

  test("players cannot import maps", async () => {
    const t = await importApp();
    try {
      const roomId = await room();
      const player = auth.allow(roomId, "player");
      const res = await post(t.imp, roomId, player, { url: "https://art.example/map.png", kind: "map" });
      assert.equal(res.statusCode, 403);
    } finally {
      await t.close();
    }
  });
});

describe("who reads a handout's pages (docs/design-v1-pdf-handouts.md 3.4)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a player shown a handout of pages reads every page, a player not shown it reads none, closing it takes them back, and a document's pages are never read", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Pages");
    const socket = await t.connect(roomId, dm);
    await socket.snapshot("dm");
    const pip = t.client();
    const pipId = await pip.join(roomId, "Pip");
    const quin = t.client();
    await quin.join(roomId, "Quin");
    const up = async (color: string) => {
      const res = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=handout`, undefined, { "content-type": "image/png" }, await solid(60, 80, color).png().toBuffer());
      assert.equal(res.statusCode, 200, res.body);
      return res.json<{ id: string; width: number; height: number }>();
    };
    const pages = [await up("#a11"), await up("#1a1"), await up("#11a")];
    const kept = await up("#aa1");
    const page = (a: { id: string; width: number; height: number }) => ({ assetId: a.id, width: a.width, height: a.height });
    const ok = (ev: { rejects?: unknown[] }) => assert.equal(ev.rejects, undefined, JSON.stringify(ev.rejects));
    ok(await socket.apply({ t: "handoutDoc.create", doc: { id: uuidv7(), title: "Strange letter", pages: [...pages, kept].map(page) } }));
    const handoutId = uuidv7();
    ok(await socket.apply({ t: "handout.show", handout: { id: handoutId, pages: pages.map(page), title: "Strange letter", to: [pipId] } }));

    const read = (who: TestClient, id: string, variant = "full") => who.get(`/api/assets/${id}/${variant}`);
    for (const p of pages) {
      for (const variant of ["full", "thumb"]) {
        assert.equal((await read(pip, p.id, variant)).statusCode, 200, `Pip, ${p.id} ${variant}`);
        assert.equal((await read(quin, p.id, variant)).statusCode, 404, `Quin, ${p.id} ${variant}`);
      }
    }
    assert.equal((await read(pip, kept.id)).statusCode, 404, "a page only a document holds");
    ok(await socket.apply({ t: "handout.close", handoutId }));
    for (const p of pages) assert.equal((await read(pip, p.id)).statusCode, 404, `Pip, ${p.id} after close`);
    socket.close();
  });
});
