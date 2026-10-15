import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import yauzl from "yauzl";
import { playerLink, readPlayerFragment } from "#shared/playerLink.ts";
import { ipKey } from "../auth/ipKey.ts";
import { startTestApp, type TestApp } from "../auth/testing.ts";
import { startEngine, TEST_DATABASE_URL, type Engine, type Socket, type TestClient } from "../rooms/testing.ts";

/**
 * The player link a DM can show at any time (design 10.2, decided in
 * section 17): the stored copy of the password, who may read it, and the
 * places it must never reach.
 */
const PASSWORD = "lantern-griffon-quill";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function linkOf(client: TestClient, roomId: string): Promise<{ status: number; link: string | null; cache?: string }> {
  const res = await client.get(`/api/rooms/${roomId}/player-link`);
  if (res.statusCode !== 200) return { status: res.statusCode, link: null };
  return { status: 200, link: res.json<{ playerLink: string | null }>().playerLink, cache: String(res.headers["cache-control"]) };
}

async function sealedOf(pool: pg.Pool, roomId: string): Promise<Buffer | null> {
  const { rows } = await pool.query<{ player_pw_sealed: Buffer | null }>("select player_pw_sealed from rooms where id = $1", [roomId]);
  return rows[0]?.player_pw_sealed ?? null;
}

/** Every form the secret could take in text: the password itself, and the sealed bytes as hex, base64 and base64url. */
function secretForms(password: string, sealed: Buffer): string[] {
  return [password, encodeURIComponent(password), sealed.toString("hex"), sealed.toString("base64"), sealed.toString("base64url")];
}

function assertNoSecret(text: string, forms: string[], where: string): void {
  for (const form of forms) assert.ok(!text.includes(form), `${where} holds ${form === forms[0] ? "the password" : "the sealed password"}`);
}

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

describe("the DM's player link", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a DM reads it at any time, uncached, and it joins", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Lantern", PASSWORD);
    const got = await linkOf(dm, roomId);
    assert.equal(got.status, 200);
    assert.equal(got.link, playerLink(roomId, PASSWORD));
    assert.equal(got.cache, "no-store");
    const fromLink = readPlayerFragment(got.link!.slice(got.link!.indexOf("#")))?.password ?? "";
    await t.client().join(roomId, "Linked", fromLink);
  });

  test("players, another room's DM and a device with no session are refused", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Guarded", PASSWORD);
    const player = t.client();
    await player.join(roomId, "Pip", PASSWORD);
    const asPlayer = await player.get(`/api/rooms/${roomId}/player-link`);
    assert.equal(asPlayer.statusCode, 403);
    assert.deepEqual(asPlayer.json(), { error: "dm_only" });

    const otherDm = t.client();
    await otherDm.createRoom("Elsewhere", "other-room-pass");
    const other = await otherDm.get(`/api/rooms/${roomId}/player-link`);
    assert.equal(other.statusCode, 403);
    assert.deepEqual(other.json(), { error: "no_access" });

    assert.equal((await t.client().get(`/api/rooms/${roomId}/player-link`)).statusCode, 403);
  });

  test("changing the password stores the new one, under the new epoch", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Changing", PASSWORD);
    const before = await sealedOf(t.pool, roomId);
    const res = await dm.post(`/api/rooms/${roomId}/password`, { password: "basilisk-tavern-harp" });
    assert.equal(res.statusCode, 204, res.body);
    assert.equal((await linkOf(dm, roomId)).link, playerLink(roomId, "basilisk-tavern-harp"));
    assert.notDeepEqual(await sealedOf(t.pool, roomId), before);
  });

  test("a password change tells every DM socket, so a menu showing the old link asks again", async () => {
    const dm = t.client();
    const { roomId, dmKey } = await dm.createRoom("Signalled", PASSWORD);
    const coDm = t.client();
    await coDm.claimDm(roomId, dmKey);
    const player = t.client();
    await player.join(roomId, "Pip", PASSWORD);
    const sockets = await Promise.all([dm, coDm, player].map((c) => t.connect(roomId, c)));
    for (const [i, socket] of sockets.entries()) await socket.snapshot(`signal-${i}`);
    const [dmSocket, coDmSocket, playerSocket] = sockets as [Socket, Socket, Socket];

    assert.equal((await dm.post(`/api/rooms/${roomId}/password`, { password: "basilisk-tavern-harp" })).statusCode, 204);
    await dmSocket.next("access");
    await coDmSocket.next("access");
    // The player is signed out by the change, and never told anything about access.
    await playerSocket.waitClosed();
    assert.equal(playerSocket.received.some((m) => m.t === "access"), false);
  });

  test("an import stores the password its form set", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Exported", PASSWORD);
    const zip = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(zip.statusCode, 200, zip.body);
    const importer = t.client();
    const form = Buffer.from(JSON.stringify({ playerPassword: "kraken-lute-ember", dmName: "Importer" })).toString("base64url");
    const res = await importer.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": form }, zip.rawPayload);
    assert.equal(res.statusCode, 201, res.body);
    const imported = res.json<{ roomId: string }>().roomId;
    t.track(imported);
    assert.equal((await linkOf(importer, imported)).link, playerLink(imported, "kraken-lute-ember"));
  });

  test("a room from before the stored copy answers null, and so does a changed server key, without failing", async () => {
    const dm = t.client();
    const { roomId } = await dm.createRoom("Older", PASSWORD);
    const sealed = await sealedOf(t.pool, roomId);
    assert.ok(sealed);

    // The same database, served with another ROOM_SECRET_KEY.
    const rotated: TestApp = await startTestApp({ env: { ROOM_SECRET_KEY: randomBytes(32).toString("base64") } });
    try {
      const sameDevice = rotated.client(dm.ip);
      sameDevice.token = dm.token;
      const res = await sameDevice.get(`/api/rooms/${roomId}/player-link`);
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json(), { playerLink: null });
      // Joining still works: the hash, not the sealed copy, checks the password.
      await rotated.client().join(roomId, "Still", PASSWORD);
    } finally {
      await rotated.close();
    }

    await t.pool.query("update rooms set player_pw_sealed = null where id = $1", [roomId]);
    assert.deepEqual(await linkOf(dm, roomId), { status: 200, link: null, cache: "no-store" });
  });

  test("the password and its sealed copy reach no snapshot, projection, export or other answer", async () => {
    const dm = t.client();
    const created = await dm.post("/api/rooms", { name: "Leakproof", playerPassword: PASSWORD, dmName: "DM" });
    assert.equal(created.statusCode, 201);
    const { roomId } = created.json<{ roomId: string }>();
    t.track(roomId);
    const sealed = await sealedOf(t.pool, roomId);
    assert.ok(sealed);
    const forms = secretForms(PASSWORD, sealed);
    const seen: Array<[string, string]> = [["create answer", created.body]];

    const player = t.client();
    const joined = await player.post(`/api/rooms/${roomId}/join`, { password: PASSWORD });
    seen.push(["join answer", joined.body]);
    const ticket = joined.json<{ ticket: string }>().ticket;
    seen.push(["join complete", (await player.post(`/api/rooms/${roomId}/join/complete`, { ticket, name: "Pip", color: "#3e8ef7" })).body]);
    seen.push(["room", (await player.get(`/api/rooms/${roomId}`)).body]);
    seen.push(["dm me", (await dm.get(`/api/rooms/${roomId}/me`)).body]);
    seen.push(["player me", (await player.get(`/api/rooms/${roomId}/me`)).body]);
    seen.push(["devices", (await dm.get(`/api/rooms/${roomId}/dm/devices`)).body]);
    seen.push(["log", (await dm.get(`/api/rooms/${roomId}/log`)).body]);

    const dmSocket = await t.connect(roomId, dm);
    seen.push(["dm snapshot", JSON.stringify(await dmSocket.snapshot("dm"))]);
    const playerSocket = await t.connect(roomId, player);
    seen.push(["player snapshot", JSON.stringify(await playerSocket.snapshot("p"))]);
    seen.push(["dm socket", JSON.stringify(dmSocket.received)]);
    seen.push(["player socket", JSON.stringify(playerSocket.received)]);

    const exported = await dm.get(`/api/rooms/${roomId}/export`);
    assert.equal(exported.statusCode, 200);
    for (const [name, data] of await unzip(exported.rawPayload)) seen.push([`export ${name}`, data.toString("latin1")]);

    const stored = await t.pool.query<{ state: unknown }>("select state from room_snapshots where room_id = $1", [roomId]);
    seen.push(["stored state", JSON.stringify(stored.rows)]);
    const ops = await t.pool.query("select op from room_ops where room_id = $1", [roomId]);
    seen.push(["stored ops", JSON.stringify(ops.rows)]);

    for (const [where, text] of seen) assertNoSecret(text, forms, where);
  });
});

/**
 * The real server process with its development logging (debug level, every
 * request), so the log lines are the ones a deploy would write.
 */
describe("the server's log", () => {
  let dir: string;
  let pool: pg.Pool;
  const userAgent = `raccoon-playerlink-itest/${randomBytes(6).toString("hex")}`;
  const ip = `2001:db8:${randomBytes(2).toString("hex")}::${randomBytes(2).toString("hex")}`;
  const rooms: string[] = [];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "rvtt-playerlink-"));
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  });
  after(async () => {
    await pool.query("delete from rooms where id = any($1::text[])", [rooms]);
    await pool.query("delete from sessions where user_agent = $1", [userAgent]);
    const fragments = [...rooms, ipKey(ip)];
    await pool.query("delete from rate_events where exists (select 1 from unnest($1::text[]) f where position(f in key) > 0)", [fragments]);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(port));
      });
      server.on("error", reject);
    });
  }

  test("holds neither the password nor its sealed copy", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["server/main.ts"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "development",
        DATABASE_URL: TEST_DATABASE_URL,
        HOST: "127.0.0.1",
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        ASSET_DIR: dir,
        TRUST_CF_CONNECTING_IP: "1",
        ROOMS_PER_DAY: "1000000",
        ROOMS_PER_IP_PER_DAY: "1000",
        ROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    try {
      const deadline = Date.now() + 20_000;
      while (!/listening/i.test(output)) {
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the server did not start:\n${output}`);
        await new Promise((r) => setTimeout(r, 50));
      }

      let cookie = "";
      const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
        const res = await fetch(`${origin}${path}`, {
          method,
          headers: {
            "user-agent": userAgent,
            "sec-fetch-site": "same-origin",
            "cf-connecting-ip": ip,
            ...(cookie ? { cookie } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.get("set-cookie");
        if (set) cookie = set.split(";")[0] ?? "";
        return res;
      };

      const created = await call("POST", "/api/rooms", { name: "Logged", playerPassword: PASSWORD, dmName: "DM" });
      assert.equal(created.status, 201);
      const { roomId } = (await created.json()) as { roomId: string };
      rooms.push(roomId);
      const firstSealed = await sealedOf(pool, roomId);
      assert.equal((await call("GET", `/api/rooms/${roomId}/player-link`)).status, 200);
      assert.equal((await call("POST", `/api/rooms/${roomId}/password`, { password: "basilisk-tavern-harp" })).status, 204);
      assert.equal((await call("GET", `/api/rooms/${roomId}/player-link`)).status, 200);
      // A wrong password and a refused route log too.
      await call("POST", `/api/rooms/${roomId}/join`, { password: PASSWORD });
      const secondSealed = await sealedOf(pool, roomId);
      assert.ok(firstSealed && secondSealed);

      child.kill("SIGTERM");
      await exited;
      // Not a vacuous pass: the requests above were logged.
      assert.match(output, /player-link/);
      assertNoSecret(output, secretForms(PASSWORD, firstSealed), "the log");
      assertNoSecret(output, secretForms("basilisk-tavern-harp", secondSealed), "the log");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
