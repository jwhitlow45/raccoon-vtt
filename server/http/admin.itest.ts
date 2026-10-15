import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { LightMyRequestResponse } from "fastify";
import { MockAgent } from "undici";
import { roomStoredBytes } from "../assets/quota.ts";
import { PIPELINE } from "../assets/kinds.ts";
import { variantPath } from "../assets/store.ts";
import { solid } from "../assets/testImages.ts";
import { PasswordHasher } from "../auth/passwords.ts";
import { setTurnstileDispatcherForTests } from "../auth/turnstile.ts";
import { CLOSE } from "../rooms/connection.ts";
import { randomIp, startEngine, type Engine, type TestClient } from "../rooms/testing.ts";
import { backupWarning, type AdminRoom, type AdminStorage, type BackupRun } from "./admin.ts";

/**
 * The admin page's routes (docs/design-v1-dm-tools.md 3.18) on the real
 * server: off without ADMIN_PASSWORD_HASH, the login with its limits and
 * Turnstile, the session's cookie and its ends, the listing against the
 * quota's own numbers, pin, and delete through the DM's path.
 */

const PASSWORD = "the admin password for tests";
const run = promisify(execFile);
const hasher = new PasswordHasher();

/** A browser on the admin page: its own address and its admin cookie. */
class AdminBrowser {
  readonly ip = randomIp();
  cookie: string | undefined;
  readonly engine: () => Engine;
  constructor(engine: () => Engine) {
    this.engine = engine;
  }

  async request(method: "GET" | "POST" | "DELETE", url: string, body?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.engine().app.inject({
      method,
      url,
      remoteAddress: "127.0.0.1",
      headers: {
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": this.ip,
        ...(this.cookie ? { cookie: `rvtt-admin=${this.cookie}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
    const set = res.cookies.find((c) => c.name === "rvtt-admin");
    if (set) this.cookie = set.value === "" ? undefined : set.value;
    return res;
  }

  login(password = PASSWORD, extra: Record<string, unknown> = {}) {
    return this.request("POST", "/api/admin/login", { password, ...extra });
  }
}

describe("the admin page without ADMIN_PASSWORD_HASH", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("every admin route is not found", async () => {
    const admin = new AdminBrowser(() => t);
    for (const [method, url] of [
      ["POST", "/api/admin/login"],
      ["GET", "/api/admin/storage"],
      ["GET", "/api/admin/rooms"],
      ["DELETE", "/api/admin/session"],
    ] as const) {
      const res = await admin.request(method, url, method === "POST" ? { password: PASSWORD } : undefined);
      assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
  });
});

describe("the admin page", () => {
  let t: Engine;
  let hash: string;
  before(async () => {
    hash = await hasher.hash(PASSWORD);
    t = await startEngine({ env: { ADMIN_PASSWORD_HASH: hash } });
  });
  after(async () => {
    await t.pool.query("delete from rate_events where key like 'admin:fail:%'");
    await t.pool.query("delete from admin_sessions");
    await t.close();
  });

  test("a login sets an HttpOnly, Strict admin cookie, and every answer is no-store", async () => {
    const admin = new AdminBrowser(() => t);
    const wrong = await admin.login("not the password at all");
    assert.equal(wrong.statusCode, 403);
    assert.equal(wrong.json<{ error: string }>().error, "bad_password");
    assert.equal(wrong.headers["cache-control"], "no-store");
    const res = await admin.login();
    assert.equal(res.statusCode, 204, res.body);
    const cookie = res.cookies.find((c) => c.name === "rvtt-admin");
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Strict");
    assert.equal(cookie.path, "/");
    assert.equal(cookie.maxAge, 12 * 3600);
    // Only the token's hash is kept.
    const stored = await t.pool.query("select 1 from admin_sessions where token_hash = $1", [createHash("sha256").update(cookie.value).digest()]);
    assert.equal(stored.rowCount, 1);
    const storage = await admin.request("GET", "/api/admin/storage");
    assert.equal(storage.statusCode, 200);
    assert.equal(storage.headers["cache-control"], "no-store");
  });

  test("every route refuses without the cookie, with a room session's cookie, and across sites", async () => {
    const admin = new AdminBrowser(() => t);
    const dm = t.client();
    const { roomId } = await dm.createRoom("Admin refusals");
    for (const [method, url] of [
      ["GET", "/api/admin/storage"],
      ["GET", "/api/admin/rooms"],
      ["POST", `/api/admin/rooms/${roomId}/pin`],
      ["DELETE", `/api/admin/rooms/${roomId}`],
    ] as const) {
      const body = method === "POST" ? { pinned: true } : method === "DELETE" ? { confirm: roomId } : undefined;
      assert.equal((await admin.request(method, url, body)).statusCode, 401, `${method} ${url} without a cookie`);
      // A room session, in its own cookie and in the admin cookie's name.
      const asRoom = await admin.request(method, url, body, { cookie: `rvtt=${dm.token}; rvtt-admin=${dm.token}` });
      assert.equal(asRoom.statusCode, 401, `${method} ${url} with a room session`);
    }
    assert.equal(await t.manager.setPinned(roomId, false), true);
    await admin.login();
    const cross = await admin.request("DELETE", `/api/admin/rooms/${roomId}`, { confirm: roomId }, { "sec-fetch-site": "cross-site" });
    assert.equal(cross.statusCode, 403);
    assert.equal((await dm.me(roomId)).status, 200, "the room is still there");
    const crossLogin = await new AdminBrowser(() => t).request("POST", "/api/admin/login", { password: PASSWORD }, { "sec-fetch-site": "same-site" });
    assert.equal(crossLogin.statusCode, 403);
  });

  test("five failures close the login to that address with growing waits, and leave other addresses alone", async () => {
    const admin = new AdminBrowser(() => t);
    for (let i = 0; i < 5; i++) assert.equal((await admin.login(`wrong ${i}`)).statusCode, 403);
    const blocked = await admin.login();
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0 && Number(blocked.headers["retry-after"]) <= 60);
    // A sixth failure, an hour's rows later, waits twice as long.
    await t.pool.query("update rate_events set at = at - interval '2 minutes' where key like 'admin:fail:%' and key <> 'admin:fail:site'");
    assert.equal((await admin.login("wrong 5")).statusCode, 403);
    const longer = await admin.login();
    assert.equal(longer.statusCode, 429);
    assert.ok(Number(longer.headers["retry-after"]) > 60, String(longer.headers["retry-after"]));
    assert.equal((await new AdminBrowser(() => t).login()).statusCode, 204);
  });

  test("fifty failures in an hour close the login for every address", async () => {
    await t.pool.query("insert into rate_events (key, at) select 'admin:fail:site', now() from generate_series(1, 50)");
    try {
      const res = await new AdminBrowser(() => t).login();
      assert.equal(res.statusCode, 429);
      assert.ok(Number(res.headers["retry-after"]) > 3500);
    } finally {
      await t.pool.query("delete from rate_events where key = 'admin:fail:site'");
    }
  });

  test("a session ends after 12 hours, at sign out, and when the password hash changes", async () => {
    const admin = new AdminBrowser(() => t);
    await admin.login();
    const token = admin.cookie!;
    const hashOf = createHash("sha256").update(token).digest();
    await t.pool.query("update admin_sessions set expires_at = now() - interval '1 second' where token_hash = $1", [hashOf]);
    assert.equal((await admin.request("GET", "/api/admin/rooms")).statusCode, 401);

    await admin.login();
    const signedIn = admin.cookie!;
    const out = await admin.request("DELETE", "/api/admin/session");
    assert.equal(out.statusCode, 204);
    assert.equal(admin.cookie, undefined, "the cookie is cleared");
    assert.equal((await t.pool.query("select 1 from admin_sessions where token_hash = $1", [createHash("sha256").update(signedIn).digest()])).rowCount, 0);

    await admin.login();
    const kept = admin.cookie!;
    const other = await startEngine({ env: { ADMIN_PASSWORD_HASH: await hasher.hash("a different admin password") } });
    try {
      const res = await other.app.inject({
        method: "GET",
        url: "/api/admin/rooms",
        headers: { cookie: `rvtt-admin=${kept}`, "cf-connecting-ip": admin.ip },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await other.close();
    }
    assert.equal((await admin.request("GET", "/api/admin/rooms")).statusCode, 200, "the same hash still accepts it");
  });

  test("the room listing is an allowlist whose numbers match the quota's, with loaded rooms and their sockets", async () => {
    const admin = new AdminBrowser(() => t);
    await admin.login();
    const dm = t.client();
    const { roomId, dmKey } = await dm.createRoom("Listed");
    const png = await solid(80, 80, `#${randomBytes(3).toString("hex")}`).png().toBuffer();
    const up = await dm.request("PUT", `/api/rooms/${roomId}/assets?kind=token`, undefined, { "content-type": "image/png" }, png);
    assert.equal(up.statusCode, 200);
    const socket = await t.connect(roomId, dm);
    await socket.snapshot("dm");
    const res = await admin.request("GET", "/api/admin/rooms");
    const room = res.json<{ rooms: AdminRoom[] }>().rooms.find((r) => r.id === roomId);
    assert.ok(room);
    assert.deepEqual(Object.keys(room).sort(), ["bytes", "createdAt", "id", "images", "lastActiveAt", "loaded", "name", "pinned", "readOnly", "sockets"]);
    assert.equal(room.bytes, await roomStoredBytes(t.pool, roomId));
    assert.equal(room.images, 1);
    assert.equal(room.loaded, true);
    assert.equal(room.sockets, 1);
    assert.equal(room.name, "Listed");
    assert.doesNotMatch(res.body, new RegExp(dmKey), "no DM link");
    socket.close();

    // The CLI's list-rooms prints the same size for the room, once it has unloaded and its snapshot settled.
    for (let i = 0; i < 100 && t.manager.get(roomId); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.manager.get(roomId), null);
    const settled = (await admin.request("GET", "/api/admin/rooms")).json<{ rooms: AdminRoom[] }>().rooms.find((r) => r.id === roomId)!;
    assert.equal(settled.bytes, await roomStoredBytes(t.pool, roomId));
    const cli = await run(process.execPath, ["scripts/admin.ts", "list-rooms"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: t.config.DATABASE_URL },
    });
    const line = cli.stdout.split("\n").find((l) => l.startsWith(`${roomId.slice(0, 4)}-${roomId.slice(4)} `));
    assert.ok(line, cli.stdout);
    const kib = (settled.bytes / 1024).toFixed(1);
    assert.match(line, new RegExp(` ${kib.replace(".", "\\.")} KiB  Listed$`));
  });

  test("storage counts shared files once, and shows the last backup and the last good one", async () => {
    const admin = new AdminBrowser(() => t);
    await admin.login();
    const run = (id: string, outcome: string, hoursAgo: number) =>
      t.pool.query(
        `insert into backup_runs (id, started_at, finished_at, outcome, dump, dump_bytes, images_copied)
         values ($1, now() - make_interval(hours => $2), now() - make_interval(hours => $2), $3, $4, 1234, 5)`,
        [id, hoursAgo, outcome, `raccoon-test-${id}.dump`],
      );
    const ids = [`t${randomBytes(4).toString("hex")}`, `t${randomBytes(4).toString("hex")}`];
    // Started ahead of now, so they are the newest whatever else the log holds.
    await run(ids[0]!, "good", -1);
    await run(ids[1]!, "partial", -2);
    try {
      const body = (await admin.request("GET", "/api/admin/storage")).json<AdminStorage>();
      assert.ok(body.databaseBytes > 0);
      assert.ok(body.volume && body.volume.totalBytes > 0);
      const files = await t.pool.query<{ n: number }>("select count(distinct (sha256, kind, pipeline))::int as n from assets");
      assert.equal(body.images.count, files.rows[0]!.n);
      assert.equal(body.backup.last?.id, ids[1]);
      assert.equal(body.backup.lastGood?.id, ids[0]);
      assert.match(body.backup.warning ?? "", /partial/);
    } finally {
      await t.pool.query("delete from backup_runs where id = any($1)", [ids]);
    }
  });

  test("pin reaches a loaded room at once", async () => {
    const admin = new AdminBrowser(() => t);
    await admin.login();
    const dm = t.client();
    const { roomId } = await dm.createRoom("Pinned");
    const actor = await t.manager.acquire(roomId);
    const res = await admin.request("POST", `/api/admin/rooms/${roomId}/pin`, { pinned: true });
    assert.equal(res.statusCode, 204);
    assert.equal(actor.pinned, true);
    assert.equal((await admin.request("POST", "/api/admin/rooms/ZZZZZZZZ/pin", { pinned: true })).statusCode, 404);
  });

  test("delete asks for the room ID, closes its sockets with 4009, and moves only the files no other room uses", async () => {
    const admin = new AdminBrowser(() => t);
    await admin.login();
    const a = t.client();
    const b = t.client();
    const { roomId } = await a.createRoom("Doomed");
    const { roomId: other } = await b.createRoom("Neighbor");
    const shared = await solid(90, 90, `#${randomBytes(3).toString("hex")}`).png().toBuffer();
    const own = await solid(91, 91, `#${randomBytes(3).toString("hex")}`).png().toBuffer();
    const put = (c: TestClient, room: string, bytes: Buffer) => c.request("PUT", `/api/rooms/${room}/assets?kind=token`, undefined, { "content-type": "image/png" }, bytes);
    assert.equal((await put(a, roomId, shared)).statusCode, 200);
    assert.equal((await put(a, roomId, own)).statusCode, 200);
    assert.equal((await put(b, other, shared)).statusCode, 200);
    const socket = await t.connect(roomId, a);
    await socket.snapshot("dm");

    const wrong = await admin.request("DELETE", `/api/admin/rooms/${roomId}`, { confirm: other });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json<{ error: string }>().error, "confirm_mismatch");
    const res = await admin.request("DELETE", `/api/admin/rooms/${roomId}`, { confirm: ` ${roomId.slice(0, 4).toLowerCase()}-${roomId.slice(4)} ` });
    assert.equal(res.statusCode, 204, res.body);
    assert.equal((await socket.waitClosed()).code, CLOSE.roomClosed);
    assert.equal((await a.get(`/api/rooms/${roomId}`)).statusCode, 404);
    const file = (bytes: Buffer) => variantPath(t.assetDir, createHash("sha256").update(bytes).digest("hex"), "token", "full", PIPELINE);
    const present = (p: string) => access(p).then(() => true, () => false);
    assert.equal(await present(file(shared)), true);
    assert.equal(await present(file(own)), false);
    assert.equal((await admin.request("DELETE", `/api/admin/rooms/${roomId}`, { confirm: roomId })).statusCode, 404);
  });

  test("Turnstile, when configured, guards every login", async () => {
    const turnstiled = await startEngine({ env: { ADMIN_PASSWORD_HASH: hash, TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET: "secret" } });
    const cloudflare = new MockAgent();
    cloudflare.disableNetConnect();
    cloudflare
      .get("https://challenges.cloudflare.com")
      .intercept({ path: "/turnstile/v0/siteverify", method: "POST" })
      .reply(200, (opts) => ({ success: new URLSearchParams(String(opts.body)).get("response") === "solved" }))
      .times(3);
    setTurnstileDispatcherForTests(cloudflare);
    try {
      const admin = new AdminBrowser(() => turnstiled);
      const none = await admin.login();
      assert.equal(none.statusCode, 403);
      assert.equal(none.json<{ error: string }>().error, "turnstile_failed");
      assert.equal((await admin.login(PASSWORD, { turnstileToken: "unsolved" })).statusCode, 403);
      assert.equal((await admin.login(PASSWORD, { turnstileToken: "solved" })).statusCode, 204);
    } finally {
      setTurnstileDispatcherForTests(null);
      await cloudflare.close();
      await turnstiled.close();
    }
  });
});

describe("the backup warning", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const at = (hoursAgo: number, outcome: BackupRun["outcome"]): BackupRun => ({
    id: "x",
    startedAt: new Date(now - hoursAgo * 3600_000).toISOString(),
    finishedAt: new Date(now - hoursAgo * 3600_000).toISOString(),
    outcome,
    dump: null,
    dumpBytes: null,
    imagesCopied: null,
    error: null,
  });

  test("warns with no good backup, after a run that was not good, and after 36 hours", () => {
    assert.match(backupWarning(null, null, now) ?? "", /No good backup has run yet/);
    assert.equal(backupWarning(at(2, "good"), at(2, "good"), now), null);
    assert.equal(backupWarning(at(0, "running"), at(20, "good"), now), null);
    assert.match(backupWarning(at(1, "failed"), at(20, "good"), now) ?? "", /failed/);
    assert.match(backupWarning(at(37, "good"), at(37, "good"), now) ?? "", /36 hours/);
  });
});
