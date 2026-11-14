import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import type { ServerToSupervisor } from "../../desktop/contract.ts";
import { buildApp } from "../app.ts";
import { childEnv, TEST_DATABASE_URL } from "../auth/testing.ts";
import { loadConfig, type Config } from "../config.ts";
import { applySchema } from "../db.ts";
import { Socket } from "../rooms/testing.ts";
import { dropForeignPeer } from "./guard.ts";
import type { LocalNetwork } from "./network.ts";

/**
 * The desktop app's server, whole (docs/design/design-v1-local-app.md 4 and
 * 6): the Host check, the peer filter, the Origin set over plain HTTP, the
 * host-only creation and import, `/api/config`'s local part, the cookies and
 * headers, a hosted server answering as before, and the supervisor's IPC
 * channel on a real child process.
 *
 * Other devices are `inject` requests with a `remoteAddress`, and this
 * computer's network addresses are given to the app, so no test depends on
 * the machine's own network. 10.0.0.5 is this computer's address on its
 * network, and 10.0.0.20 a player's phone.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OWN = "10.0.0.5";
const PHONE = "10.0.0.20";
const PASSWORD = "owlbear-druid-wand";
const KEY = randomBytes(32).toString("base64");
const userAgent = `raccoon-local-itest/${randomBytes(6).toString("hex")}`;

let pool: pg.Pool;
let assetDir: string;
let startedAt: Date;
const rooms: string[] = [];
const apps: FastifyInstance[] = [];

before(async () => {
  pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  await applySchema(pool);
  startedAt = (await pool.query<{ now: Date }>("select now()")).rows[0]!.now;
  assetDir = await mkdtemp(join(tmpdir(), "rvtt-local-"));
});

after(async () => {
  for (const app of apps) await app.close();
  await pool.query("delete from rooms where id = any($1::text[])", [rooms]);
  await pool.query("delete from sessions where user_agent = $1", [userAgent]);
  // These addresses are this file's own: every other integration test counts against random IPv6 ones.
  await pool.query("delete from rate_events where at >= $1 and (position($2 in key) > 0 or position($3 in key) > 0 or position('127.0.0.1' in key) > 0 or key = 'create:site')", [startedAt, OWN, PHONE]);
  await pool.end();
  await rm(assetDir, { recursive: true, force: true });
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

const localEnv = (host: string, port: number): Record<string, string> => ({
  NODE_ENV: "production",
  RACCOON_MODE: "local",
  DATABASE_URL: TEST_DATABASE_URL,
  ROOM_SECRET_KEY: KEY,
  HOST: host,
  PORT: String(port),
  ASSET_DIR: assetDir,
  ROOMS_PER_DAY: "1000000",
  ROOMS_PER_IP_PER_DAY: "1000",
});

/** The logger is all NODE_ENV still decides once the config is loaded, so a test app stays quiet as production otherwise. */
const quiet = (config: Config): Config => ({ ...config, NODE_ENV: "test" });

type Local = { app: FastifyInstance; port: number; config: Config };

async function startLocal(host: "127.0.0.1" | "0.0.0.0", opts: { listen?: boolean } = {}): Promise<Local> {
  const port = await freePort();
  const config = quiet(loadConfig(localEnv(host, port)));
  const network: LocalNetwork = { localAddresses: () => [OWN], primaryAddress: async () => OWN };
  const app = await buildApp({ config, pool, network });
  apps.push(app);
  // Bound to loopback only: a test's other devices are injected.
  if (opts.listen) await app.listen({ port, host: "127.0.0.1" });
  else await app.ready();
  return { app, port, config };
}

type Request = { method?: InjectOptions["method"]; url: string; from?: string; host?: string; origin?: string; headers?: Record<string, string>; body?: unknown; payload?: InjectOptions["payload"] };

/** A request as a browser over plain HTTP sends it: no Sec-Fetch-Site, its own Origin on unsafe methods, from `from`. */
function send(local: Local, r: Request): Promise<LightMyRequestResponse> {
  const from = r.from ?? "127.0.0.1";
  const host = r.host ?? (from === "127.0.0.1" ? `localhost:${local.port}` : `${OWN}:${local.port}`);
  return local.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    remoteAddress: from,
    headers: {
      host,
      "user-agent": userAgent,
      ...(r.method && r.method !== "GET" ? { origin: r.origin ?? `http://${host}` } : {}),
      ...(r.body !== undefined ? { "content-type": "application/json" } : {}),
      ...r.headers,
    },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : r.payload !== undefined ? { payload: r.payload } : {}),
  });
}

async function createRoom(local: Local): Promise<{ roomId: string; cookie: string; res: LightMyRequestResponse }> {
  const res = await send(local, { method: "POST", url: "/api/rooms", body: { name: "Local", playerPassword: PASSWORD, dmName: "DM" } });
  assert.equal(res.statusCode, 201, res.body);
  const roomId = res.json<{ roomId: string }>().roomId;
  rooms.push(roomId);
  const cookie = res.cookies.find((c) => c.name === "rvtt");
  assert.ok(cookie, "the room cookie is rvtt");
  return { roomId, cookie: `rvtt=${cookie.value}`, res };
}

/** A body that never ends: a route that answers before reading the body still answers. */
function endless(): Readable {
  return new Readable({ read() {} });
}

async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

describe("local mode: Host", () => {
  test("a Host this computer does not answer to gets 421 with no body, before anything else", async () => {
    const local = await startLocal("0.0.0.0");
    for (const host of [`evil.example:${local.port}`, "evil.example", `localhost:${local.port + 1}`, `${PHONE}:${local.port}`, `localhost.:${local.port}`]) {
      const res = await send(local, { url: "/healthz", host });
      assert.equal(res.statusCode, 421, host);
      assert.equal(res.body, "", host);
      // Turned away before the security headers, the CSRF check and the routes.
      assert.equal(res.headers["content-security-policy"], undefined, host);
    }
    for (const host of [`localhost:${local.port}`, `127.0.0.1:${local.port}`, `${OWN}:${local.port}`, `LOCALHOST:${local.port}`]) {
      assert.equal((await send(local, { url: "/healthz", host })).statusCode, 200, host);
    }
  });

  test("with only this computer allowed, its network address is not a host it answers to", async () => {
    const local = await startLocal("127.0.0.1");
    assert.equal((await send(local, { url: "/healthz", host: `${OWN}:${local.port}` })).statusCode, 421);
    assert.equal((await send(local, { url: "/healthz", host: `127.0.0.1:${local.port}` })).statusCode, 200);
  });

  test("a request with no Host, and a WebSocket upgrade naming another, are refused on a real socket, which the server then closes", async () => {
    const local = await startLocal("0.0.0.0", { listen: true });
    /** Sends raw bytes and keeps the socket open from this side, so only the server can close it. */
    const exchange = (request: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = connect(local.port, "127.0.0.1", () => socket.write(request));
        let text = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`the server kept the socket open after: ${text}`));
        }, 3_000);
        socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
        socket.on("close", () => {
          clearTimeout(timer);
          resolve(text);
        });
        socket.on("error", reject);
      });
    assert.match(await exchange("GET /healthz HTTP/1.0\r\n\r\n"), /^HTTP\/1\.[01] 421 /);
    const { roomId, cookie } = await createRoom(local);
    const upgrade = [
      `GET /ws?room=${roomId} HTTP/1.1`,
      `Host: evil.example:${local.port}`,
      `Origin: http://evil.example:${local.port}`,
      `Cookie: ${cookie}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "",
      "",
    ].join("\r\n");
    assert.match(await exchange(upgrade), /^HTTP\/1\.1 421 /);
  });
});

describe("local mode: peers", () => {
  test("the peer filter is the first connection listener, so a socket from outside closes before HTTP reads it", async () => {
    const local = await startLocal("0.0.0.0");
    const first = local.app.server.listeners("connection")[0] as (socket: { remoteAddress?: string; destroy(): unknown }) => void;
    assert.equal(first, dropForeignPeer);
    const destroyed: string[] = [];
    for (const remoteAddress of ["203.0.113.9", "100.64.0.1", "169.254.1.1", PHONE, "127.0.0.1"]) {
      first({ remoteAddress, destroy: () => destroyed.push(remoteAddress) });
    }
    assert.deepEqual(destroyed, ["203.0.113.9", "100.64.0.1", "169.254.1.1"]);
  });
});

describe("local mode: Origin", () => {
  test("an unsafe request from another site, or with `Origin: null`, is refused, and one from any of the app's own origins passes", async () => {
    const local = await startLocal("0.0.0.0");
    const { roomId } = await createRoom(local);
    const join = (origin: string, from = PHONE, headers: Record<string, string> = {}) =>
      send(local, { method: "POST", url: `/api/rooms/${roomId}/join`, from, origin, body: { password: "not-the-password-at-all" }, headers });
    for (const origin of ["http://evil.example", "null", `https://localhost:${local.port}`, `http://${PHONE}:${local.port}`]) {
      const res = await join(origin);
      assert.equal(res.statusCode, 403, origin);
      assert.equal(res.json<{ error: string }>().error, "cross_origin", origin);
    }
    for (const origin of [`http://${OWN}:${local.port}`, `http://localhost:${local.port}`, `http://127.0.0.1:${local.port}`]) {
      const res = await join(origin);
      assert.notEqual(res.json<{ error?: string }>().error, "cross_origin", origin);
    }
    // Sec-Fetch-Site, when a browser sends one, still decides first.
    const crossSite = await join(`http://${OWN}:${local.port}`, PHONE, { "sec-fetch-site": "cross-site" });
    assert.equal(crossSite.json<{ error: string }>().error, "cross_origin");
  });

  test("a WebSocket opens from the network address's page, and not from another origin", async () => {
    const local = await startLocal("0.0.0.0", { listen: true });
    const { roomId, cookie } = await createRoom(local);
    const url = `ws://127.0.0.1:${local.port}/ws?room=${roomId}`;
    for (const origin of ["http://evil.example", "null", `https://${OWN}:${local.port}`]) {
      await assert.rejects(Socket.open(url, { origin, cookie }), /upgrade refused: 403/, origin);
    }
    const socket = await Socket.open(url, { origin: `http://${OWN}:${local.port}`, cookie });
    try {
      // The DM's own tab on this computer is no other device.
      assert.deepEqual(local.app.openSockets(), { total: 1, remoteDevices: 0 });
    } finally {
      socket.ws.terminate();
      await socket.closed;
    }
  });
});

describe("local mode: only the host computer makes rooms (D-261113-081)", () => {
  test("creation from any other device, this computer's network address included, is host_only before the body", async () => {
    const local = await startLocal("0.0.0.0");
    for (const from of [PHONE, OWN]) {
      const res = await within(
        send(local, { method: "POST", url: "/api/rooms", from, payload: endless(), headers: { "content-type": "application/json", "content-length": "60000" } }),
        5_000,
        `creation from ${from}`,
      );
      assert.equal(res.statusCode, 403, from);
      assert.equal(res.json<{ error: string }>().error, "host_only", from);
    }
    // Refused ahead of the body's own checks too: an oversized body is not a 413.
    const big = await send(local, { method: "POST", url: "/api/rooms", from: PHONE, headers: { "content-type": "application/json" }, payload: "x".repeat(100_000) });
    assert.equal(big.json<{ error: string }>().error, "host_only");
    await createRoom(local);
  });

  test("import from any other device is host_only before the form, the limits and the body, and closes the connection", async () => {
    const local = await startLocal("0.0.0.0");
    for (const from of [PHONE, OWN]) {
      const res = await within(
        send(local, { method: "POST", url: "/api/rooms/import", from, payload: endless(), headers: { "content-type": "application/zip", "content-length": "90000000" } }),
        5_000,
        `import from ${from}`,
      );
      assert.equal(res.statusCode, 403, from);
      assert.equal(res.json<{ error: string }>().error, "host_only", from);
      assert.equal(res.headers.connection, "close", from);
    }
    // Neither a missing form nor a body type the route never takes is reached.
    const plain = await send(local, { method: "POST", url: "/api/rooms/import", from: PHONE, headers: { "content-type": "text/plain" }, payload: "x" });
    assert.equal(plain.json<{ error: string }>().error, "host_only");
    // From the host computer the route goes on to its own checks: here, the missing form.
    const own = await send(local, { method: "POST", url: "/api/rooms/import", headers: { "content-type": "application/zip" }, payload: Buffer.from("PK") });
    assert.equal(own.statusCode, 400);
    assert.equal(own.json<{ error: string }>().error, "invalid_form");
  });
});

describe("local mode: /api/config, cookies and headers", () => {
  test("the host computer may create, links name the network address, and only this computer's own address is sent home", async () => {
    const local = await startLocal("0.0.0.0");
    const base = { turnstileSiteKey: null, searchEnabled: true, animatedMaps: false, roomSound: false };
    const at = (from: string) => send(local, { url: "/api/config", from }).then((r) => r.json());
    assert.deepEqual(await at("127.0.0.1"), { ...base, local: { shareOrigin: `http://${OWN}:${local.port}`, createHere: true, hostPage: null } });
    assert.deepEqual(await at(OWN), { ...base, local: { shareOrigin: `http://${OWN}:${local.port}`, createHere: false, hostPage: `http://localhost:${local.port}/` } });
    assert.deepEqual(await at(PHONE), { ...base, local: { shareOrigin: `http://${OWN}:${local.port}`, createHere: false, hostPage: null } });
  });

  test("with players off there is no address to share", async () => {
    const local = await startLocal("127.0.0.1");
    const res = await send(local, { url: "/api/config" });
    assert.deepEqual(res.json<{ local: unknown }>().local, { shareOrigin: null, createHere: true, hostPage: null });
  });

  test("cookies are rvtt, HttpOnly, SameSite=Strict and Path=/ without Secure, and pages send same-origin referrers and no HSTS", async () => {
    const local = await startLocal("0.0.0.0");
    const { res } = await createRoom(local);
    const cookie = res.cookies.find((c) => c.name === "rvtt");
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Strict");
    assert.equal(cookie.path, "/");
    assert.notEqual(cookie.secure, true);
    assert.ok(!res.cookies.some((c) => c.name.startsWith("__Host-")));
    assert.equal(res.headers["referrer-policy"], "same-origin");
    assert.equal(res.headers["strict-transport-security"], undefined);
  });
});

describe("a hosted server answers as before", () => {
  test("no Host check, no peer filter, no host-only refusal, __Host- cookies, HSTS, no-referrer and `local: null`", async () => {
    const config = quiet(
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: TEST_DATABASE_URL,
        PUBLIC_ORIGIN: "https://vtt.example.com",
        EGRESS_STRICT_PROXY: "http://egress.invalid:3128",
        EGRESS_PUBLIC_PROXY: "http://egress.invalid:3129",
        ROOM_SECRET_KEY: KEY,
        ASSET_DIR: assetDir,
        ROOMS_PER_DAY: "1000000",
        ROOMS_PER_IP_PER_DAY: "1000",
      }),
    );
    assert.equal(config.local, false);
    const app = await buildApp({ config, pool, network: { localAddresses: () => [OWN], primaryAddress: async () => OWN } });
    apps.push(app);
    await app.ready();
    assert.ok(!app.server.listeners("connection").includes(dropForeignPeer));
    const hosted = (r: { method?: InjectOptions["method"]; url: string; host?: string; headers?: Record<string, string>; payload?: string }) =>
      app.inject({
        method: r.method ?? "GET",
        url: r.url,
        remoteAddress: PHONE,
        headers: { host: r.host ?? "vtt.example.com", "user-agent": userAgent, "sec-fetch-site": "same-origin", ...r.headers },
        ...(r.payload !== undefined ? { payload: r.payload } : {}),
      });
    const health = await hosted({ url: "/healthz", host: "evil.example" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["strict-transport-security"], "max-age=31536000");
    assert.equal(health.headers["referrer-policy"], "no-referrer");
    assert.equal((await hosted({ url: "/api/config" })).json<{ local: unknown }>().local, null);
    const created = await hosted({
      method: "POST",
      url: "/api/rooms",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hosted", playerPassword: PASSWORD, dmName: "DM" }),
    });
    assert.equal(created.statusCode, 201, created.body);
    rooms.push(created.json<{ roomId: string }>().roomId);
    const cookie = created.cookies.find((c) => c.name === "__Host-rvtt");
    assert.ok(cookie);
    assert.equal(cookie.secure, true);
    const imported = await hosted({ method: "POST", url: "/api/rooms/import", headers: { "content-type": "application/zip" }, payload: "PK" });
    assert.equal(imported.json<{ error: string }>().error, "invalid_form", "past the host-only guard, to the form");
    // Only the one public origin, as before.
    const foreign = await hosted({ method: "POST", url: "/api/rooms", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, payload: "{}" });
    assert.equal(foreign.json<{ error: string }>().error, "cross_origin");
  });
});

describe("the supervisor's channel (IPC)", () => {
  type Child = { child: ChildProcess; port: number; output: () => string; messages: ServerToSupervisor[]; exited: Promise<number | null> };

  async function startChild(): Promise<Child> {
    const port = await freePort();
    const child = spawn(process.execPath, ["server/main.ts"], { cwd: ROOT, env: childEnv(localEnv("127.0.0.1", port)), stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const messages: ServerToSupervisor[] = [];
    child.on("message", (m) => messages.push(m as ServerToSupervisor));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const deadline = Date.now() + 30_000;
    while (!/listening/i.test(output)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        child.kill("SIGKILL");
        assert.fail(`the server did not start:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { child, port, output: () => output, messages, exited };
  }

  async function until(check: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`waited ${ms} ms for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test("reports a changed socket count, and `shutdown` closes sockets with 1012 and ends the process cleanly", async () => {
    const c = await startChild();
    try {
      const res = await fetch(`http://127.0.0.1:${c.port}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${c.port}`, "user-agent": userAgent },
        body: JSON.stringify({ name: "Channel", playerPassword: PASSWORD, dmName: "DM" }),
      });
      assert.equal(res.status, 201, await res.clone().text());
      const { roomId } = (await res.json()) as { roomId: string };
      rooms.push(roomId);
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      assert.equal(c.messages.length, 0, "nothing is reported while both counts are 0");
      const socket = await Socket.open(`ws://127.0.0.1:${c.port}/ws?room=${roomId}`, { origin: `http://localhost:${c.port}`, cookie });
      await until(() => c.messages.length > 0, 12_000, "a status report");
      assert.deepEqual(c.messages, [{ type: "status", sockets: 1, remoteDevices: 0 }]);
      c.child.send({ type: "shutdown" });
      assert.equal((await socket.closed).code, 1012);
      assert.equal(await within(c.exited, 25_000, "the exit"), 0);
      assert.match(c.output(), /"signal":"shutdown"/);
    } finally {
      if (c.child.exitCode === null) c.child.kill("SIGKILL");
    }
  });

  test("the channel closing, as when the supervisor dies, runs the same graceful shutdown", async () => {
    const c = await startChild();
    try {
      c.child.disconnect();
      assert.equal(await within(c.exited, 25_000, "the exit"), 0);
      assert.match(c.output(), /"signal":"disconnect"/);
    } finally {
      if (c.child.exitCode === null) c.child.kill("SIGKILL");
    }
  });
});
