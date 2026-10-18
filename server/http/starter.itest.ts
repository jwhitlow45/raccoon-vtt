import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import yauzl from "yauzl";
import yazl from "yazl";
import type { LicenseId } from "#shared/licenses.ts";
import { STARTER_KINDS, indexWorks, starterAssetCredit, type StarterPack, type StarterUse, type StarterWork } from "#shared/starter.ts";
import { STARTER_PACKS } from "#shared/starterArt.ts";
import { STARTER_HOURLY } from "../assets/limits.ts";
import { roomStoredBytes } from "../assets/quota.ts";
import { FakeAuth, buildAssetApp, dropRooms, makeRoom, testConfig, testPool } from "../assets/testApp.ts";
import { solid, tempDir } from "../assets/testImages.ts";
import type { ExportManifest } from "../rooms/exportRoom.ts";
import { startEngine, type Engine } from "../rooms/testing.ts";

/**
 * Starter picks (docs/design-v1-starter-art.md 5 and 12.10): the route that
 * copies a shipped work into a room, its refusals, the quota it never
 * counts toward, and a pick's way through a room export and import. The
 * tests build a small catalog of their own over files they make, so they
 * never depend on the shipped packs, and one more runs against those once
 * the build has written them.
 */

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Fixture = { packs: StarterPack[]; root: string; files: Record<string, Buffer>; cleanup(): Promise<void> };

/**
 * A pack of five works over fresh bytes each run: a token and handout
 * portrait, a map with a drawn grid, a public domain handout, a work
 * whose file is not the one the catalog pins, one whose file is missing,
 * and a stamp, which a pick never copies.
 */
async function starterFixture(): Promise<Fixture> {
  const { dir, cleanup } = await tempDir("rvtt-starter-");
  const folder = join(dir, "starter", "test-pack");
  await mkdir(folder, { recursive: true });
  const color = () => `#${randomBytes(3).toString("hex")}`;
  const files: Record<string, Buffer> = {
    knight: await solid(300, 300, color()).png().toBuffer(),
    inn: await solid(1000, 800, color()).png().toBuffer(),
    scroll: await solid(400, 600, color()).png().toBuffer(),
    changed: await solid(200, 200, color()).png().toBuffer(),
  };
  for (const [name, data] of Object.entries(files)) await writeFile(join(folder, `${name}.png`), data);
  const work = (name: string, uses: StarterUse[], size: [number, number], license: LicenseId, over: Partial<StarterWork> = {}): StarterWork => ({
    key: `test-pack/${name}`,
    id: `TP-${name}`,
    name,
    category: "Tests",
    tags: [],
    uses,
    file: `/starter/test-pack/${name}.png`,
    sha256: files[name] ? sha(files[name]) : "00".repeat(32),
    width: size[0],
    height: size[1],
    bytes: files[name]?.length ?? 1,
    original: { width: size[0] * 2, height: size[1] * 2 },
    credit: { title: `The ${name}`, author: "An Artist", source: `https://example.com/${name}`, license, changes: "Resized to half its size." },
    ...over,
  });
  const pack: StarterPack = {
    id: "test-pack",
    title: "Test pack",
    author: "An Artist",
    page: "https://example.com/pack",
    wayback: "https://web.archive.org/web/2020/https://example.com/pack",
    licenses: ["CC-BY-4.0", "public-domain-dedication"],
    changes: "Resized.",
    attribution: "Art by An Artist",
    works: [
      work("knight", ["token", "handout"], [300, 300], "CC-BY-4.0"),
      work("inn", ["map"], [1000, 800], "CC-BY-4.0", { grid: { cellPx: 50, originPx: { x: 12, y: 30 } }, gridColor: "#000000" }),
      work("scroll", ["handout"], [400, 600], "public-domain-dedication"),
      work("changed", ["token"], [200, 200], "CC-BY-4.0", { sha256: sha(Buffer.from("not these bytes")) }),
      work("missing", ["token"], [64, 64], "CC-BY-4.0"),
      work("bench", ["stamp"], [128, 128], "CC0-1.0", { file: "/stamps/test-pack-bench.webp", stamp: { key: "test-pack-bench", w: 1, h: 1 } }),
    ],
  };
  return { packs: [pack], root: dir, files, cleanup };
}

let pool: pg.Pool;
let dir: string;
let cleanupDir: () => Promise<void>;
let fixture: Fixture;
let auth: FakeAuth;
let app: FastifyInstance;
const rooms: string[] = [];

before(async () => {
  pool = await testPool();
  ({ dir, cleanup: cleanupDir } = await tempDir());
  fixture = await starterFixture();
  auth = new FakeAuth();
  app = await buildAssetApp({ pool, config: testConfig(dir), auth, options: { starter: { packs: fixture.packs, root: fixture.root } } });
});

after(async () => {
  await app.close();
  await dropRooms(pool, rooms);
  await pool.end();
  await cleanupDir();
  await fixture.cleanup();
});

async function room(opts: Parameters<typeof makeRoom>[1] = {}): Promise<string> {
  const id = await makeRoom(pool, opts);
  rooms.push(id);
  return id;
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter++;
  return `starter-${process.pid}-${ipCounter}`;
}

function pick(target: FastifyInstance, roomId: string, who: { headers: Record<string, string> }, body: unknown) {
  return target.inject({
    method: "POST",
    url: `/api/rooms/${roomId}/assets/starter`,
    headers: { "content-type": "application/json", "cf-connecting-ip": freshIp(), ...who.headers },
    payload: JSON.stringify(body),
  });
}

function found(key: string) {
  const work = indexWorks(fixture.packs).get(key);
  assert.ok(work, key);
  return work;
}

async function rowsOf(roomId: string) {
  const { rows } = await pool.query<{ id: string; kind: string; starter: string | null; credit: unknown; sha256: Buffer }>(
    "select id, kind, starter, credit, sha256 from assets where room_id = $1 order by created_at, id",
    [roomId],
  );
  return rows;
}

describe("a starter pick's refusals", () => {
  test("a room id of the wrong shape is a 404", async () => {
    const res = await pick(app, "not-a-room", { headers: {} }, { work: "test-pack/knight", kind: "token" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "not_found" });
  });

  test("a caller with no grant for the room is refused", async () => {
    const roomId = await room();
    auth.allow(roomId, "dm");
    const elsewhere = await room();
    const stranger = auth.allow(elsewhere, "dm");
    for (const who of [{ headers: {} }, stranger]) {
      const res = await pick(app, roomId, who, { work: "test-pack/knight", kind: "token" });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.json(), { error: "forbidden" });
    }
    assert.deepEqual(await rowsOf(roomId), []);
  });

  test("a work key of the wrong shape is a 400", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    for (const work of ["knight", "Test-Pack/knight", "test-pack/../knight", "../test-pack/knight", "test-pack/knight.png", "", 42]) {
      const res = await pick(app, roomId, dm, { work, kind: "token" });
      assert.equal(res.statusCode, 400, String(work));
      assert.deepEqual(res.json(), { error: "bad_request" });
    }
    assert.equal((await pick(app, roomId, dm, { work: "test-pack/knight", kind: "stamp" })).statusCode, 400);
    assert.equal((await pick(app, roomId, dm, { work: "test-pack/knight", kind: "thumb" })).statusCode, 400);
  });

  test("a work the catalog does not have is a 404", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const res = await pick(app, roomId, dm, { work: "test-pack/owlbear", kind: "token" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: "not_found" });
  });

  test("a kind that is not among the work's uses is a 400", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const res = await pick(app, roomId, dm, { work: "test-pack/knight", kind: "map" });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { error: "bad_request" });
    assert.deepEqual(await rowsOf(roomId), []);
  });

  test("a stamp-only work is never copied in, as any kind", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    for (const kind of STARTER_KINDS) {
      const res = await pick(app, roomId, dm, { work: "test-pack/bench", kind });
      assert.equal(res.statusCode, 400, kind);
    }
    assert.deepEqual(await rowsOf(roomId), []);
  });

  test("a player may not pick a map", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const res = await pick(app, roomId, player, { work: "test-pack/inn", kind: "map" });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: "forbidden" });
  });

  test("a player may not pick a handout", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    for (const work of ["test-pack/scroll", "test-pack/knight"]) {
      const res = await pick(app, roomId, player, { work, kind: "handout" });
      assert.equal(res.statusCode, 403, work);
    }
    assert.deepEqual(await rowsOf(roomId), []);
  });

  test("a read-only room takes no pick", async () => {
    const roomId = await room({ readOnly: true });
    const dm = auth.allow(roomId, "dm");
    const res = await pick(app, roomId, dm, { work: "test-pack/knight", kind: "token" });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: "read_only" });
  });

  test("a pick spends an hourly budget of its own, and is refused once it is spent", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const checks = app.assets.starterHourlyChecks(player.sessionId, "x", roomId).slice(0, 1);
    for (let i = 0; i < STARTER_HOURLY.session; i++) app.assets.hourly.record(checks);
    const res = await pick(app, roomId, player, { work: "test-pack/knight", kind: "token" });
    assert.equal(res.statusCode, 429);
    assert.ok(Number(res.headers["retry-after"]) > 0);
    assert.deepEqual(await rowsOf(roomId), []);
  });

  test("a pick never spends the upload budget, and with that budget spent a pick still goes", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const uploads = app.assets.hourlyChecks(player.sessionId, "x", roomId, "token").slice(0, 1);
    for (let i = 0; i < 30; i++) app.assets.hourly.record(uploads);
    const res = await pick(app, roomId, player, { work: "test-pack/knight", kind: "token" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(app.assets.hourly.retryAfter(app.assets.starterHourlyChecks(player.sessionId, "x", roomId).slice(0, 1)), 0);
  });

  test("a pick of a work the room already holds as that kind spends nothing, even with the pick budget spent", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    assert.equal((await pick(app, roomId, dm, { work: "test-pack/knight", kind: "token" })).statusCode, 200);
    // The first pick spent one, and this spends the rest of the session's budget.
    const checks = app.assets.starterHourlyChecks(dm.sessionId, "x", roomId).slice(0, 1);
    for (let i = 1; i < STARTER_HOURLY.session; i++) app.assets.hourly.record(checks);
    for (let i = 0; i < 2; i++) {
      const again = await pick(app, roomId, dm, { work: "test-pack/knight", kind: "token" });
      assert.equal(again.statusCode, 200, again.body);
    }
    // The same work as another kind makes a new image, so the spent budget refuses it.
    assert.equal((await pick(app, roomId, dm, { work: "test-pack/knight", kind: "handout" })).statusCode, 429);
    assert.equal((await rowsOf(roomId)).length, 1);
  });

  test("a pick takes an intake slot as an upload does, and is refused while none is free", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const held = [1, 2, 3].map((i) => app.assets.slots.tryAcquire({ kind: "upload", roomId: `HOLDST0${i}`, ip: `hs${i}`, sessionId: `hs${i}`, pinned: false }));
    try {
      const res = await pick(app, roomId, dm, { work: "test-pack/knight", kind: "token" });
      assert.equal(res.statusCode, 503);
      assert.ok(Number(res.headers["retry-after"]) > 0);
    } finally {
      for (const release of held) release?.();
    }
    assert.equal(app.assets.slots.inUse, 0);
  });

  test("a body with a field besides the work and the kind, such as a credit or a file, is a 400 and stores nothing", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const extras: Record<string, unknown>[] = [
      { credit: { title: "Mine", creator: "Me", license: "cc0", landingUrl: "https://example.com/me", attribution: "Mine", originalWidth: 1, originalHeight: 1 } },
      { file: "/starter/test-pack/inn.png" },
      { sha256: "ab".repeat(32) },
    ];
    for (const extra of extras) {
      const res = await pick(app, roomId, dm, { work: "test-pack/knight", kind: "token", ...extra });
      assert.equal(res.statusCode, 400, Object.keys(extra)[0]);
      assert.deepEqual(res.json(), { error: "bad_request" });
    }
    assert.deepEqual(await rowsOf(roomId), []);
  });
});

describe("a starter pick", () => {
  test("copies the work in with the catalog's credit and its mark, which both listings carry", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const player = auth.allow(roomId, "player");
    const res = await pick(app, roomId, player, { work: "test-pack/knight", kind: "token" });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ["credit", "height", "id", "kind", "sha256", "starter", "variants", "width"]);
    assert.equal(body.sha256, sha(fixture.files.knight!));
    assert.equal(body.kind, "token");
    assert.equal(body.starter, "test-pack/knight");
    assert.deepEqual([body.width, body.height], [300, 300]);
    const credit = starterAssetCredit(found("test-pack/knight"));
    assert.deepEqual(body.credit, credit);
    assert.equal(credit.attribution, "Art by An Artist");
    assert.equal(credit.changes, "Resized to half its size. Converted to WebP for this room.");

    const [row] = await rowsOf(roomId);
    assert.ok(row);
    assert.equal(row.starter, "test-pack/knight");
    assert.deepEqual(row.credit, credit);
    // The bytes stored are the shipped file's, which the catalog pins.
    assert.equal(row.sha256.toString("hex"), sha(fixture.files.knight!));
    const uploaders = await pool.query<{ member_id: string }>("select member_id from asset_uploaders where asset_id = $1", [row.id]);
    assert.deepEqual(uploaders.rows.map((r) => r.member_id), [player.memberId]);

    for (const who of [dm, player]) {
      const listed = (await app.inject({ url: `/api/rooms/${roomId}/assets`, headers: who.headers })).json().assets;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].starter, "test-pack/knight");
      assert.equal(listed[0].sha256, sha(fixture.files.knight!), "a pick's file, for a client to check its catalog against");
      assert.deepEqual(listed[0].credit, credit);
    }
    // The picker reads it as it reads an upload.
    assert.equal((await app.inject({ url: `/api/assets/${body.id}/full`, headers: player.headers })).statusCode, 200);
    assert.deepEqual(await readdir(join(dir, "tmp")), []);
  });

  test("the credit stored is the catalog's, whatever a request might say, and a public domain work names its dedication", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const forged = { title: "Mine", creator: "Me", license: "cc0", landingUrl: "https://example.com/me", attribution: "Mine", originalWidth: 1, originalHeight: 1 };
    assert.equal((await pick(app, roomId, dm, { work: "test-pack/scroll", kind: "handout", credit: forged })).statusCode, 400);
    const res = await pick(app, roomId, dm, { work: "test-pack/scroll", kind: "handout" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().created, true);
    const [row] = await rowsOf(roomId);
    assert.deepEqual(row?.credit, starterAssetCredit(found("test-pack/scroll")));
    const stored = row?.credit as { license: string; licenseVersion?: string; landingUrl: string };
    assert.equal(stored.license, "public-domain");
    assert.equal(stored.licenseVersion, undefined);
    assert.equal(stored.landingUrl, "https://web.archive.org/web/2020/https://example.com/pack", "the snapshot where the dedication can be read");
  });

  test("a map answers the catalog's grid, origin and all, and is made with every map variant", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    const res = await pick(app, roomId, dm, { work: "test-pack/inn", kind: "map" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().cellPx, 50);
    assert.deepEqual(res.json().originPx, { x: 12, y: 30 });
    assert.deepEqual(res.json().variants, ["full", "mobile", "thumb"]);
    assert.deepEqual([res.json().width, res.json().height], [1000, 800]);
  });

  test("lies outside the quota: a room at its quota can still pick, and its stored bytes do not grow", async () => {
    const quotaDir = await tempDir();
    const small = await buildAssetApp({
      pool,
      config: testConfig(quotaDir.dir, { ROOM_QUOTA_MB: "1" }),
      auth,
      options: { starter: { packs: fixture.packs, root: fixture.root } },
    });
    try {
      const roomId = await room();
      const dm = auth.allow(roomId, "dm");
      // A row standing for images the room already holds, past its 1 MiB.
      await pool.query(
        `insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants) values ($1, $2, $3, 'token', 1, 1, 1, $4, '{full}')`,
        [randomUUID(), roomId, randomBytes(32), 2 * 1024 * 1024],
      );
      const before = await roomStoredBytes(pool, roomId);
      const upload = await small.inject({
        method: "PUT",
        url: `/api/rooms/${roomId}/assets?kind=token`,
        headers: { "content-type": "image/png", "cf-connecting-ip": freshIp(), ...dm.headers },
        payload: await solid(40, 40, "#123456").png().toBuffer(),
      });
      assert.equal(upload.statusCode, 413);
      for (const [work, kind] of [["test-pack/knight", "token"], ["test-pack/inn", "map"], ["test-pack/knight", "handout"]] as const) {
        const res = await pick(small, roomId, dm, { work, kind });
        assert.equal(res.statusCode, 200, `${work} ${kind}: ${res.body}`);
      }
      assert.equal(await roomStoredBytes(pool, roomId), before);
      assert.equal(small.assets.quota.reservedBytes(roomId), 0);
      const marked = (await rowsOf(roomId)).filter((r) => r.starter !== null);
      assert.equal(marked.length, 3);
    } finally {
      await small.close();
      await quotaDir.cleanup();
    }
  });

  test("a second pick of the work as the same kind reuses the row, adds the picker, and answers the same", async () => {
    const roomId = await room();
    const first = auth.allow(roomId, "player");
    const second = auth.allow(roomId, "player");
    const a = await pick(app, roomId, first, { work: "test-pack/knight", kind: "token" });
    const b = await pick(app, roomId, second, { work: "test-pack/knight", kind: "token" });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(a.body, b.body);
    const rows = await rowsOf(roomId);
    assert.equal(rows.length, 1);
    const uploaders = await pool.query<{ member_id: string }>("select member_id from asset_uploaders where asset_id = $1 order by member_id", [a.json().id]);
    assert.deepEqual(uploaders.rows.map((r) => r.member_id).sort(), [first.memberId, second.memberId].sort());
    // The same work as another kind is a row of its own.
    const dm = auth.allow(roomId, "dm");
    const handout = await pick(app, roomId, dm, { work: "test-pack/knight", kind: "handout" });
    assert.equal(handout.statusCode, 200, handout.body);
    assert.notEqual(handout.json().id, a.json().id);
    assert.equal((await rowsOf(roomId)).length, 2);
  });

  test("an upload of the same bytes the room already holds stays an upload, counted, and the pick answers as a pick", async () => {
    const roomId = await room();
    const player = auth.allow(roomId, "player");
    const upload = await app.inject({
      method: "PUT",
      url: `/api/rooms/${roomId}/assets?kind=token`,
      headers: { "content-type": "image/png", "cf-connecting-ip": freshIp(), ...player.headers },
      payload: fixture.files.knight!,
    });
    assert.equal(upload.statusCode, 200, upload.body);
    const stored = await roomStoredBytes(pool, roomId);
    const res = await pick(app, roomId, auth.allow(roomId, "player"), { work: "test-pack/knight", kind: "token" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().id, upload.json().id);
    assert.equal(res.json().starter, "test-pack/knight");
    const [row] = await rowsOf(roomId);
    assert.equal(row?.starter, null);
    // The same bytes are that work under that license, so the row gains the catalog's credit, as an Openverse pick's reuse does.
    assert.deepEqual(row?.credit, starterAssetCredit(found("test-pack/knight")));
    assert.equal(await roomStoredBytes(pool, roomId), stored);
    const listed = (await app.inject({ url: `/api/rooms/${roomId}/assets`, headers: player.headers })).json().assets;
    assert.deepEqual([listed[0].starter, listed[0].sha256], [undefined, undefined], "an upload lists no mark and no hash");
  });

  test("a shipped file that is not the catalog's is refused with a 500, and nothing is stored", async () => {
    const roomId = await room();
    const dm = auth.allow(roomId, "dm");
    for (const work of ["test-pack/changed", "test-pack/missing"]) {
      const res = await pick(app, roomId, dm, { work, kind: "token" });
      assert.equal(res.statusCode, 500, work);
      assert.deepEqual(res.json(), { error: "internal" });
    }
    assert.deepEqual(await rowsOf(roomId), []);
    assert.deepEqual(await readdir(join(dir, "tmp")), []);
    assert.equal(app.assets.slots.inUse, 0);
  });
});

describe("the shipped catalog", () => {
  const copyable = STARTER_KINDS.flatMap((kind) => {
    const work = STARTER_PACKS.flatMap((p) => p.works).find((w) => (w.uses as readonly string[]).includes(kind));
    return work ? [{ kind, work }] : [];
  });

  test(
    "a pick of a shipped work of each kind copies the server's own file in",
    { skip: copyable.length === 0 ? "the catalog is empty until the build fills it" : false },
    async () => {
      const shippedDir = await tempDir();
      const shipped = await buildAssetApp({ pool, config: testConfig(shippedDir.dir), auth });
      try {
        const roomId = await room();
        const dm = auth.allow(roomId, "dm");
        for (const { kind, work } of copyable) {
          const res = await pick(shipped, roomId, dm, { work: work.key, kind });
          assert.equal(res.statusCode, 200, `${work.key} ${kind}: ${res.body}`);
          assert.equal(res.json().starter, work.key);
        }
        const rows = await rowsOf(roomId);
        for (const { work } of copyable) assert.ok(rows.some((r) => r.sha256.toString("hex") === work.sha256), work.key);
      } finally {
        await shipped.close();
        await shippedDir.cleanup();
      }
    },
  );
});

// ---------------------------------------------------------------- export and import

async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(buffer);
  const out = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    out.set(entry.fileName, Buffer.concat(chunks));
  }
  return out;
}

function zipOf(entries: Map<string, Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries) zip.addBuffer(data, name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

describe("a starter pick in a room export and import (docs/design-v1-starter-art.md 12.10)", () => {
  let t: Engine;
  let files: Map<string, Buffer>;
  let manifest: ExportManifest;

  before(async () => {
    t = await startEngine({ assets: { starter: { packs: fixture.packs, root: fixture.root } } });
    const dm = t.client();
    const { roomId } = await dm.createRoom("Starter source");
    for (const body of [{ work: "test-pack/knight", kind: "token" }, { work: "test-pack/inn", kind: "map" }]) {
      const res = await dm.post(`/api/rooms/${roomId}/assets/starter`, body);
      assert.equal(res.statusCode, 200, res.body);
    }
    const res = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    files = await unzip(res.rawPayload);
    manifest = JSON.parse(files.get("assets.json")!.toString()) as ExportManifest;
  });
  after(() => t.close());

  /** Imports the export with its manifest's assets changed by `change`, and the zip's entries renamed by `rename`. */
  async function importWith(change: (m: ExportManifest) => unknown = (m) => m, rename: (name: string) => string = (n) => n) {
    const entries = new Map<string, Buffer>();
    for (const [name, data] of files) entries.set(rename(name), name === "assets.json" ? Buffer.from(JSON.stringify(change(structuredClone(manifest)))) : data);
    const importer = t.client();
    const res = await importer.request(
      "POST",
      "/api/rooms/import",
      undefined,
      { "content-type": "application/zip", "x-import-form": Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url") },
      await zipOf(entries),
    );
    assert.equal(res.statusCode, 201, res.body);
    const { roomId } = res.json<{ roomId: string }>();
    t.track(roomId);
    const { rows } = await t.pool.query<{ kind: string; starter: string | null; credit: unknown; sha256: Buffer; bytes: string }>(
      "select kind, starter, credit, sha256, bytes from assets where room_id = $1 order by kind",
      [roomId],
    );
    return { roomId, rows };
  }

  test("the export carries each pick's mark and credit, under manifest version 2", () => {
    assert.equal(manifest.formatVersion, 2);
    const knight = manifest.assets.find((a) => a.kind === "token");
    const inn = manifest.assets.find((a) => a.kind === "map");
    assert.equal(knight?.starter, "test-pack/knight");
    assert.deepEqual(knight?.credit, starterAssetCredit(found("test-pack/knight")));
    assert.equal(inn?.starter, "test-pack/inn");
    assert.equal(knight?.sha256, sha(fixture.files.knight!));
    // The files travel too, so the room is whole on a server without the pack.
    for (const a of manifest.assets) assert.ok(files.has(`assets/${a.sha256}-${a.kind}-full.webp`), a.kind);
  });

  test("an import keeps the mark where this server ships the work with the same bytes, copying the shipped file outside the quota", async () => {
    const { roomId, rows } = await importWith();
    assert.deepEqual(rows.map((r) => [r.kind, r.starter]), [["map", "test-pack/inn"], ["token", "test-pack/knight"]]);
    // From the shipped file: the zip holds the WebP variant, whose hash differs.
    assert.equal(rows.find((r) => r.kind === "token")?.sha256.toString("hex"), sha(fixture.files.knight!));
    assert.deepEqual(rows.find((r) => r.kind === "token")?.credit, starterAssetCredit(found("test-pack/knight")));
    const counted = await t.pool.query<{ bytes: string }>("select coalesce(sum(bytes), 0) as bytes from assets where room_id = $1 and starter is null", [roomId]);
    assert.equal(Number(counted.rows[0]?.bytes), 0);
  });

  test("a work this server does not ship imports as an ordinary upload, counted, with its credit", async () => {
    const { roomId, rows } = await importWith((m) => ({ ...m, assets: m.assets.map((a) => ({ ...a, starter: a.kind === "token" ? "test-pack/owlbear" : a.starter })) }));
    const token = rows.find((r) => r.kind === "token");
    assert.equal(token?.starter, null);
    assert.notEqual(token?.sha256.toString("hex"), sha(fixture.files.knight!));
    assert.deepEqual(token?.credit, starterAssetCredit(found("test-pack/knight")));
    assert.equal(rows.find((r) => r.kind === "map")?.starter, "test-pack/inn");
    assert.ok((await roomStoredBytes(t.pool, roomId)) >= Number(token?.bytes));
  });

  test("a work whose SHA-256 differs from this server's imports as an ordinary upload, counted", async () => {
    const other = "cd".repeat(32);
    const knight = manifest.assets.find((a) => a.kind === "token")!.sha256;
    const { roomId, rows } = await importWith(
      (m) => ({ ...m, assets: m.assets.map((a) => (a.sha256 === knight ? { ...a, sha256: other } : a)) }),
      (name) => name.replace(knight, other),
    );
    const token = rows.find((r) => r.kind === "token");
    assert.equal(token?.starter, null);
    assert.deepEqual(token?.credit, starterAssetCredit(found("test-pack/knight")));
    assert.ok((await roomStoredBytes(t.pool, roomId)) >= Number(token?.bytes));
  });

  test("an import whose images do not fit the room's quota is refused whole, and its room is removed", async () => {
    // Each zip image reserves its kind's whole size cap, which a 1 MiB quota never has room for.
    const small = await startEngine({ env: { ROOM_QUOTA_MB: "1" }, assets: { starter: { packs: fixture.packs, root: fixture.root } } });
    try {
      const entries = new Map(files);
      const v1 = { formatVersion: 1, assets: manifest.assets.map(({ starter: _starter, ...a }) => a) };
      entries.set("assets.json", Buffer.from(JSON.stringify(v1)));
      const named = async () => (await small.pool.query<{ n: string }>("select count(*) as n from rooms where name = $1", ["Starter source"])).rows[0]?.n;
      const before = await named();
      const res = await small.client().request(
        "POST",
        "/api/rooms/import",
        undefined,
        { "content-type": "application/zip", "x-import-form": Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url") },
        await zipOf(entries),
      );
      assert.equal(res.statusCode, 413, res.body);
      assert.deepEqual(res.json(), { error: "quota_exceeded" });
      assert.equal(await named(), before);
    } finally {
      await small.close();
    }
  });

  test("a version 1 manifest, which has no marks, imports every image as an upload", async () => {
    const { rows } = await importWith((m) => ({ formatVersion: 1, assets: m.assets.map(({ starter: _starter, ...a }) => a) }));
    assert.deepEqual(rows.map((r) => r.starter), [null, null]);
    assert.ok(rows.every((r) => r.credit !== null));
  });

  test("a mark that is not a work key is no mark, and the image still comes through", async () => {
    const { rows } = await importWith((m) => ({ ...m, assets: m.assets.map((a) => ({ ...a, starter: a.kind === "token" ? "../../etc/passwd" : 7 })) }));
    assert.deepEqual(rows.map((r) => r.starter), [null, null]);
    assert.equal(rows.length, 2);
  });

  test("a shipped file that changed on this server makes the import take the image from the zip, as an upload", async () => {
    const path = join(fixture.root, "starter", "test-pack", "knight.png");
    await writeFile(path, await solid(300, 300, "#010203").png().toBuffer());
    try {
      const { rows } = await importWith();
      const token = rows.find((r) => r.kind === "token");
      assert.equal(token?.starter, null);
      assert.notEqual(token?.sha256.toString("hex"), sha(fixture.files.knight!));
      assert.equal(rows.find((r) => r.kind === "map")?.starter, "test-pack/inn");
    } finally {
      await writeFile(path, fixture.files.knight!);
    }
  });
});
