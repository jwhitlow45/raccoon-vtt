import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import pg from "pg";
import WebSocket from "ws";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import type { HistoryDirection, HistoryScope } from "#shared/undoContract.ts";
import { buildApp, type AppDeps } from "../app.ts";
import { ipKey } from "../auth/ipKey.ts";
import { TEST_DATABASE_URL, testConfig } from "../auth/testing.ts";
import { applySchema } from "../db.ts";
import type { Config } from "../config.ts";
import type { RoomManager } from "./manager.ts";

/**
 * The room engine's integration test kit: the whole app on the shared
 * development Postgres, listening on an ephemeral port so a real `ws` client
 * can drive the WebSocket endpoint, with the same cookie-carrying HTTP
 * clients as the auth tests. Rooms, sessions and limit rows written by a run
 * are deleted when it closes.
 *
 * Client IPs come from `CF-Connecting-IP`, which the app is told to trust
 * here, because every socket to 127.0.0.1 would otherwise share one address.
 */
export type EngineOptions = {
  env?: Record<string, string>;
  rooms?: AppDeps["rooms"];
  ws?: AppDeps["ws"];
  export?: AppDeps["export"];
  assets?: AppDeps["assets"];
  log?: AppDeps["log"];
};

export type Engine = {
  app: FastifyInstance;
  pool: pg.Pool;
  manager: RoomManager;
  config: Config;
  url: string;
  assetDir: string;
  client(ip?: string): TestClient;
  connect(roomId: string, client: TestClient, opts?: { ip?: string }): Promise<Socket>;
  /** A table display's socket (`as=display`), with the client's display cookie and its room cookie too, as a browser would send both. */
  connectDisplay(roomId: string, client: TestClient, opts?: { ip?: string }): Promise<Socket>;
  track(roomId: string): void;
  /** Closes the app the way a deploy does (1012, snapshots) and starts a fresh one on the same database. */
  restart(): Promise<void>;
  close(): Promise<void>;
};

export function randomIp(): string {
  const h = () => randomBytes(2).toString("hex");
  return `2001:db8:${h()}:${h()}::${h()}`;
}

export async function startEngine(opts: EngineOptions = {}): Promise<Engine> {
  const assetDir = await mkdtemp(join(tmpdir(), "rvtt-engine-"));
  const config = testConfig({ TRUST_CF_CONNECTING_IP: "1", ASSET_DIR: assetDir, ...opts.env });
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  await applySchema(pool);
  const { rows } = await pool.query<{ now: Date }>("select now()");
  const startedAt = rows[0]?.now ?? new Date();
  const build = async (): Promise<FastifyInstance> => {
    const app = await buildApp({
      config,
      pool,
      rooms: { idleUnloadMs: 200, ...opts.rooms },
      ws: opts.ws,
      export: opts.export,
      assets: opts.assets,
      log: opts.log,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    return app;
  };
  const urlOf = (app: FastifyInstance): string => {
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `ws://127.0.0.1:${port}`;
  };
  const app = await build();
  const userAgent = `raccoon-engine-itest/${randomBytes(6).toString("hex")}`;
  const rooms = new Set<string>();
  const ips = new Set<string>();
  const sockets = new Set<Socket>();

  const engine: Engine = {
    app,
    pool,
    manager: app.rooms,
    config,
    url: urlOf(app),
    assetDir,
    client(ip = randomIp()) {
      ips.add(ip);
      return new TestClient(() => engine.app, ip, userAgent, (roomId) => rooms.add(roomId));
    },
    track: (roomId) => rooms.add(roomId),
    async connect(roomId, client, o = {}) {
      const ip = o.ip ?? client.ip;
      ips.add(ip);
      const socket = await Socket.open(`${engine.url}/ws?room=${roomId}`, {
        origin: config.publicOrigin,
        cookie: client.token ? `rvtt=${client.token}` : "",
        "cf-connecting-ip": ip,
        "user-agent": userAgent,
      });
      sockets.add(socket);
      return socket;
    },
    async connectDisplay(roomId, client, o = {}) {
      const ip = o.ip ?? client.ip;
      ips.add(ip);
      const socket = await Socket.open(`${engine.url}/ws?room=${roomId}&as=display`, {
        origin: config.publicOrigin,
        cookie: client.cookieHeader(),
        "cf-connecting-ip": ip,
        "user-agent": userAgent,
      });
      sockets.add(socket);
      return socket;
    },
    async restart() {
      await engine.app.close();
      engine.app = await build();
      engine.manager = engine.app.rooms;
      engine.url = urlOf(engine.app);
    },
    async close() {
      for (const s of sockets) s.terminate();
      await engine.app.close();
      const roomIds = [...rooms];
      const fragments = [...roomIds, ...[...ips].map(ipKey)];
      await pool.query("delete from rooms where id = any($1::text[])", [roomIds]);
      await pool.query("delete from sessions where user_agent = $1", [userAgent]);
      if (fragments.length > 0) {
        await pool.query("delete from rate_events where exists (select 1 from unnest($1::text[]) f where position(f in key) > 0)", [fragments]);
      }
      await pool.query("delete from rate_events where key = 'create:site' and at >= $1", [startedAt]);
      await pool.end();
      await rm(assetDir, { recursive: true, force: true });
    },
  };
  return engine;
}

export { TEST_DATABASE_URL };

type Body = Record<string, unknown>;

/**
 * The same cookie-carrying device as the auth tests' TestClient, resolving
 * the app on every request so it survives `restart()`.
 */
export class TestClient {
  readonly ip: string;
  token: string | undefined;
  /** A table display's session, in its own cookie (docs/design-v1-dm-tools.md 3.1). */
  displayToken: string | undefined;
  #app: () => FastifyInstance;
  #userAgent: string;
  #track: (roomId: string) => void;

  constructor(app: () => FastifyInstance, ip: string, userAgent: string, track: (roomId: string) => void) {
    this.#app = app;
    this.ip = ip;
    this.#userAgent = userAgent;
    this.#track = track;
  }

  async request(method: NonNullable<InjectOptions["method"]>, url: string, body?: Body, headers: Record<string, string> = {}, payload?: Buffer): Promise<LightMyRequestResponse> {
    const res = await this.#app().inject({
      method,
      url,
      remoteAddress: "127.0.0.1",
      headers: {
        "user-agent": this.#userAgent,
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": this.ip,
        ...(this.cookieHeader() ? { cookie: this.cookieHeader() } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { payload: JSON.stringify(body) } : payload ? { payload } : {}),
    });
    const cookie = res.cookies.find((c) => c.name === "rvtt");
    if (cookie) this.token = cookie.value;
    const display = res.cookies.find((c) => c.name === "rvtt-display");
    if (display) this.displayToken = display.value === "" ? undefined : display.value;
    return res;
  }

  /** Both cookies, as the browser holds them. */
  cookieHeader(): string {
    return [this.token ? `rvtt=${this.token}` : "", this.displayToken ? `rvtt-display=${this.displayToken}` : ""].filter(Boolean).join("; ");
  }

  get(url: string): Promise<LightMyRequestResponse> {
    return this.request("GET", url);
  }

  post(url: string, body?: Body): Promise<LightMyRequestResponse> {
    return this.request("POST", url, body);
  }

  delete(url: string, body?: Body): Promise<LightMyRequestResponse> {
    return this.request("DELETE", url, body);
  }

  async createRoom(name = "Test room", password = "owlbear-druid-wand"): Promise<{ roomId: string; dmLink: string; dmKey: string }> {
    const res = await this.post("/api/rooms", { name, playerPassword: password, dmName: "Dungeon Master" });
    if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
    const body = res.json<{ roomId: string; dmLink: string }>();
    this.#track(body.roomId);
    return { ...body, dmKey: body.dmLink.split("#dm=")[1] ?? "" };
  }

  async join(roomId: string, name = "Player", password = "owlbear-druid-wand", color = "#3e8ef7"): Promise<string> {
    const first = await this.post(`/api/rooms/${roomId}/join`, { password });
    if (first.statusCode !== 200) throw new Error(`join failed: ${first.statusCode} ${first.body}`);
    const { ticket } = first.json<{ ticket: string }>();
    const done = await this.post(`/api/rooms/${roomId}/join/complete`, { ticket, name, color });
    if (done.statusCode !== 200) throw new Error(`join/complete failed: ${done.statusCode} ${done.body}`);
    return done.json<{ memberId: string }>().memberId;
  }

  async claimDm(roomId: string, key: string, name = "Co-DM"): Promise<string> {
    const res = await this.post(`/api/rooms/${roomId}/dm`, { key, name });
    if (res.statusCode !== 200) throw new Error(`dm claim failed: ${res.statusCode} ${res.body}`);
    return res.json<{ memberId: string }>().memberId;
  }

  async me(roomId: string): Promise<{ status: number; role?: string; memberId?: string }> {
    const res = await this.get(`/api/rooms/${roomId}/me`);
    if (res.statusCode !== 200) return { status: res.statusCode };
    return { status: 200, ...res.json<{ role: string; memberId: string }>() };
  }
}

export class SocketClosed extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(code: number, reason: string) {
    super(`socket closed with ${code} ${reason}`);
    this.name = "SocketClosed";
    this.code = code;
    this.reason = reason;
  }
}

/** A test-side WebSocket: every message is kept until a test asks for it, so nothing is lost to timing. */
export class Socket {
  readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
  #closedWith: { code: number; reason: string } | null = null;
  #n = 0;
  #history: Extract<ServerMessage, { t: "history" }> | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => {
        this.#closedWith = { code, reason: reason.toString() };
        for (const w of this.#waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new SocketClosed(code, reason.toString()));
        }
        resolve(this.#closedWith);
      });
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const i = this.#waiters.findIndex((w) => w.match(msg));
      if (i >= 0) {
        const [w] = this.#waiters.splice(i, 1);
        clearTimeout(w!.timer);
        w!.resolve(msg);
      } else {
        this.received.push(msg);
      }
    });
    ws.on("error", () => undefined);
  }

  static open(url: string, headers: Record<string, string>): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const socket = new Socket(ws);
      ws.once("open", () => resolve(socket));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
      ws.once("error", (err) => reject(err));
    });
  }

  get closeCode(): number | null {
    return this.#closedWith?.code ?? null;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  /** The next `n` for an op from this socket's client. */
  nextN(): number {
    return ++this.#n;
  }

  set n(value: number) {
    this.#n = value;
  }

  get n(): number {
    return this.#n;
  }

  op(op: Op | Record<string, unknown>, n = this.nextN()): number {
    this.send({ t: "op", n, op });
    return n;
  }

  hello(clientId: string, resumeFrom = this.#n + 1, sceneId?: string): void {
    this.send({ t: "hello", clientId, resumeFrom, ...(sceneId ? { sceneId } : {}) });
  }

  /** The next message that matches, from the backlog first, within `timeoutMs`. */
  next<T extends ServerMessage["t"]>(t: T, match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, timeoutMs = 5_000): Promise<Extract<ServerMessage, { t: T }>> {
    const matches = (m: ServerMessage): boolean => m.t === t && match(m as Extract<ServerMessage, { t: T }>);
    const i = this.received.findIndex(matches);
    if (i >= 0) return Promise.resolve(this.received.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>);
    if (this.#closedWith) return Promise.reject(new SocketClosed(this.#closedWith.code, this.#closedWith.reason));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.timer !== timer);
        reject(new Error(`no ${t} within ${timeoutMs} ms (backlog: ${this.received.map((m) => m.t).join(",") || "empty"})`));
      }, timeoutMs);
      this.#waiters.push({ match: matches, resolve: (m) => resolve(m as Extract<ServerMessage, { t: T }>), reject, timer });
    });
  }

  /** Resolves true if a matching message arrives within the window, false otherwise. Used to assert silence. */
  async maybe<T extends ServerMessage["t"]>(t: T, match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, windowMs = 300): Promise<Extract<ServerMessage, { t: T }> | null> {
    try {
      return await this.next(t, match, windowMs);
    } catch {
      return null;
    }
  }

  async snapshot(clientId: string, resumeFrom?: number, sceneId?: string): Promise<Extract<ServerMessage, { t: "snapshot" }>> {
    this.hello(clientId, resumeFrom, sceneId);
    return this.next("snapshot");
  }

  /** Sends an op and waits for the ev that acknowledges it. */
  async apply(op: Op | Record<string, unknown>): Promise<Extract<ServerMessage, { t: "ev" }>> {
    const n = this.op(op);
    return this.next("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false));
  }

  /**
   * The head a stack Undo or Redo must name, read from the newest history summary that covers
   * every op this socket sent, as the client captures it. Null when that history is empty.
   */
  async historyHead(scope: HistoryScope = "play", direction: HistoryDirection = "undo"): Promise<string | null> {
    this.#takeHistory();
    if (!this.#history || this.#history.watermark < this.#n) {
      this.#history = await this.next("history", (m) => m.watermark >= this.#n);
      this.#takeHistory();
    }
    const history = scope === "play" ? this.#history.play : this.#history.setup;
    return history?.[direction].head?.id ?? null;
  }

  /** Keeps the newest summary from the backlog, which holds them in arrival order. */
  #takeHistory(): void {
    for (let i = this.received.findIndex((m) => m.t === "history"); i >= 0; i = this.received.findIndex((m) => m.t === "history")) {
      this.#history = this.received.splice(i, 1)[0] as Extract<ServerMessage, { t: "history" }>;
    }
  }

  /**
   * Sends a stack Undo or Redo naming the current head, as the toolbar and Setup history do.
   * An empty history sends an id no step has, so the server's head check answers it.
   */
  async step(t: HistoryDirection, scope?: HistoryScope): Promise<Extract<ServerMessage, { t: "ev" }>> {
    const head = (await this.historyHead(scope, t)) ?? randomUUID();
    return this.apply({ t, head, ...(scope ? { scope } : {}) });
  }

  async waitClosed(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    const timer = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("socket did not close")), timeoutMs).unref());
    return Promise.race([this.closed, timer]);
  }

  close(code = 1000): void {
    this.ws.close(code);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

/**
 * Makes the pool's next commit fail in a chosen way, for the failure paths
 * of design 7.2:
 * - `before`: the transaction fails before COMMIT, a clean failure.
 * - `committed`: COMMIT runs and succeeds, then the answer is "lost".
 * - `rolledBack`: the connection "drops" during COMMIT without committing.
 *
 * Each failure consumes one mode from the queue, so a test can line up any sequence.
 */
export function failCommits(pool: pg.Pool, modes: Array<"before" | "committed" | "rolledBack">): { remaining: () => number; restore: () => void } {
  const queue = [...modes];
  type Connect = (cb?: (err: Error | undefined, client: pg.PoolClient | undefined, release: (err?: unknown) => void) => void) => Promise<pg.PoolClient> | void;
  const original = pool.connect.bind(pool) as Connect;
  const wrap = (client: pg.PoolClient): pg.PoolClient => {
    if (queue.length === 0) return client;
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (text: string, values?: unknown[], cb?: unknown) => {
          // Only the promise form the room engine uses is simulated. pg's own callback form passes through.
          if (typeof values === "function" || typeof cb === "function") return query(text, values, cb);
          return failingQuery(text, values);
        };
        async function failingQuery(text: string, values?: unknown[]): Promise<pg.QueryResult> {
          const mode = queue[0];
          if (mode === "before" && /^insert into room_ops|^insert into client_watermarks/i.test(text)) {
            queue.shift();
            throw Object.assign(new Error("simulated failure before commit"), { code: "ECONNRESET" });
          }
          if (/^commit$/i.test(text) && (mode === "committed" || mode === "rolledBack")) {
            queue.shift();
            await query(mode === "committed" ? "commit" : "rollback");
            throw Object.assign(new Error("simulated lost commit answer"), { code: "ECONNRESET" });
          }
          return query(text, values);
        }
      },
    });
  };
  // pg's own `pool.query` uses the callback form of connect, so both forms must keep working.
  (pool as { connect: unknown }).connect = (cb?: Parameters<Connect>[0]) => {
    if (typeof cb === "function") {
      return original((err, client, release) => cb(err, client ? wrap(client) : client, release));
    }
    return (original() as Promise<pg.PoolClient>).then(wrap);
  };
  return {
    remaining: () => queue.length,
    restore: () => {
      (pool as { connect: unknown }).connect = original;
    },
  };
}
