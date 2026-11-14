import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { dragCells, openSideTab, sleep, tapCell, waitFor } from "../../e2e/harness.ts";
import type { RoomState } from "../../shared/model.ts";
import { applyChanges, type ProjectedState } from "../../shared/project.ts";
import {
  APP_NAME,
  DATA_DIR_ENV,
  DATA_LAYOUT,
  LOG_FILES,
  RESOURCES,
  RUNTIME_DIR,
  SHELL_ARGS,
  SUPERVISOR_ARGS,
  SUPERVISOR_ENTRY,
  SupervisorToShell,
  errorText,
  parseHeadlessLine,
  serverBinaryName,
  type Command,
  type Platform,
  type SupervisorStatus,
} from "../contract.ts";
import { defaultOut } from "./stage.ts";

/**
 * The desktop app's smoke tests (docs/design/design-v1-local-app.md, 11.3),
 * which desktop.yml's build jobs run on each target's own runner:
 *
 *   node desktop/scripts/smoke.ts headless [--stage <dir>] [--runtime <dir>]
 *   node desktop/scripts/smoke.ts windows <setup.exe>
 *   node desktop/scripts/smoke.ts macos <dmg>
 *   node desktop/scripts/smoke.ts linux <deb> <AppImage>
 *
 * `headless` runs the staged supervisor (desktop/scripts/stage.ts) on the
 * fetched Node and PostgreSQL (desktop/scripts/fetch-runtime.ts), headless,
 * driving it over the IPC channel the shell uses. Its data folder's name
 * has a space, a cp1252 letter and a letter outside the runner's code
 * page, and something already listens on 5432. In Chromium a DM makes a
 * room on this computer, and a player at its private IPv4 address joins
 * and plays over plain HTTP. Then in WebKit the DM opens the DM link at
 * that address, as on a tablet, and a second player does the same. One
 * browser runs at a time. Around that: the Host, Origin and host-only
 * refusals, a backup, a quit and a start, a second supervisor on another
 * path to the same folder, a restore, and a restore cut off by the
 * supervisor's death between its two renames. It needs Playwright's Chromium and WebKit (`pnpm exec playwright-core
 * install chromium webkit`) and players able to join, so on Windows a
 * private network. It runs on a development computer too, and binds the
 * app server to every address while it runs.
 *
 * The other three install and run the packaged app as a DM would. `macos`
 * copies the app out of its DMG into a temp folder and runs it there.
 * `windows` and `linux` install it for every user, change the firewall or
 * a kernel setting, so they refuse to run outside CI.
 *
 * Each run copies its data folders' logs to `$RUNNER_TEMP/smoke-logs`
 * (desktop.yml keeps them when a smoke test fails): the supervisor's,
 * PostgreSQL's, the app server's and the shell's. `headless` adds
 * everything each supervisor printed, under printed/.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEMP = process.env.RUNNER_TEMP || tmpdir();
const LOGS = path.join(TEMP, "smoke-logs");
const PLATFORM = process.platform as Platform;

/** A space, é (cp1252) and Ж (no Western code page), which every path the app builds must survive. */
const AWKWARD_FOLDER = `${APP_NAME} Tést Жук`;

class SmokeError extends Error {}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new SmokeError(message);
}

function step(text: string): void {
  console.log(`- ${text}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A file's last lines, or "" when it can't be read. */
function logTail(file: string, lines: number): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Copies a data folder's logs where desktop.yml keeps them, under a name for the run. */
function keepLogs(data: string, label: string): void {
  const logs = path.join(data, DATA_LAYOUT.logs);
  if (!existsSync(logs)) return;
  mkdirSync(LOGS, { recursive: true });
  cpSync(logs, path.join(LOGS, label), { recursive: true });
}

// ---------------------------------------------------------------------------
// The network

/** A port nothing listens on now, on any address. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Something listening on 5432, as a PostgreSQL the DM runs already would. Null when something already does. */
function hold5432(): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", () => resolve(null));
    server.listen(5432, "127.0.0.1", () => resolve(server));
  });
}

function refused(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

type Answer = { status: number; body: string };

/**
 * One request by address and port, with the Host header given apart, so a
 * test can name any host. With `declaredBytes` it sends the headers of a
 * body that size and none of the body: an answer then shows the server
 * refused before reading it.
 */
function request(address: string, port: number, opts: { method?: string; path: string; headers: Record<string, string>; body?: string; declaredBytes?: number }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers = { ...opts.headers };
    if (opts.declaredBytes !== undefined) headers["content-length"] = String(opts.declaredBytes);
    else if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
    const req = http.request({ host: address, port, method: opts.method ?? "GET", path: opts.path, headers, setHost: false, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(10_000, () => req.destroy(new SmokeError(`${opts.method ?? "GET"} ${opts.path} got no answer in 10 s`)));
    req.on("error", reject);
    if (opts.declaredBytes !== undefined) req.flushHeaders();
    else req.end(opts.body);
  });
}

const errorCode = (a: Answer) => {
  try {
    return (JSON.parse(a.body) as { error?: string }).error;
  } catch {
    return undefined;
  }
};

/** Design 6: a foreign Host, a foreign or null Origin, and room creation or import from another device, each refused. */
async function refusals(port: number, lan: URL): Promise<void> {
  const local = `localhost:${port}`;
  const foreignHost = await request("127.0.0.1", port, { path: "/healthz", headers: { host: `evil.example:${port}` } });
  check(foreignHost.status === 421 && foreignHost.body === "", `a foreign Host got ${foreignHost.status} ${foreignHost.body}, not 421 with no body`);
  step("a foreign Host gets 421");

  // A join, which any device may post, so only the Origin can refuse it.
  const join = "/api/rooms/00000000/join";
  for (const origin of ["http://evil.example", "null"]) {
    const a = await request(lan.hostname, port, { method: "POST", path: join, headers: { host: lan.host, origin, "content-type": "application/json" }, body: "{}" });
    check(a.status === 403 && errorCode(a) === "cross_origin", `Origin ${origin} got ${a.status} ${a.body}, not 403 cross_origin`);
  }
  const fromHere = await request("127.0.0.1", port, { method: "POST", path: join, headers: { host: local, origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
  check(fromHere.status === 403 && errorCode(fromHere) === "cross_origin", `a foreign Origin on this computer got ${fromHere.status}`);
  step("a foreign Origin and Origin: null get 403 cross_origin");

  // 50 MB declared and none of it sent: only a refusal before the body can answer.
  for (const [route, type] of [["/api/rooms", "application/json"], ["/api/rooms/import", "multipart/form-data; boundary=smoke"]] as const) {
    const a = await request(lan.hostname, port, { method: "POST", path: route, headers: { host: lan.host, origin: lan.origin, "content-type": type }, declaredBytes: 50_000_000 });
    check(a.status === 403 && errorCode(a) === "host_only", `${route} from ${lan.host} got ${a.status} ${a.body}, not 403 host_only`);
  }
  step(`room creation and import from ${lan.hostname} get 403 host_only before the body`);
}

// ---------------------------------------------------------------------------
// The supervisor, driven as the shell drives it

type Outcome = { ok: true; value: unknown } | { ok: false; failure: unknown };

class Supervisor {
  readonly child: ChildProcess;
  status: SupervisorStatus | null = null;
  readonly lines: string[] = [];
  readonly exit: Promise<number | null>;
  private nextId = 1;
  private readonly answers = new Map<number, (outcome: Outcome) => void>();

  readonly label: string;
  readonly data: string;

  constructor(label: string, data: string, opts: { node: string; stage: string; postgres: string; port: number; env?: Record<string, string> }) {
    this.label = label;
    this.data = data;
    const args = [path.join(opts.stage, SUPERVISOR_ENTRY), SUPERVISOR_ARGS.headless, SUPERVISOR_ARGS.data, data, SUPERVISOR_ARGS.port, String(opts.port), SUPERVISOR_ARGS.network, "on", SUPERVISOR_ARGS.postgres, opts.postgres];
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    delete env.NODE_OPTIONS;
    delete env[DATA_DIR_ENV];
    this.child = spawn(opts.node, args, { cwd: opts.stage, env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    for (const stream of [this.child.stdout!, this.child.stderr!]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop() ?? "";
        for (const line of parts) this.keep(line);
      });
    }
    this.child.on("message", (raw) => {
      const msg = SupervisorToShell.safeParse(raw);
      if (!msg.success) return;
      if (msg.data.type === "status") this.status = msg.data.status;
      else this.answers.get(msg.data.id)?.(msg.data.outcome as Outcome);
    });
    this.exit = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
  }

  /** A headless supervisor prints each status as a line too, which also tells a supervisor's state when it exits before its IPC message arrives. */
  private keep(line: string): void {
    const status = parseHeadlessLine(line);
    if (status) this.status = status;
    this.lines.push(line);
    if (this.lines.length > 2000) this.lines.shift();
  }

  /**
   * What went wrong, for an error: the status's state, step and words, the
   * last lines the supervisor printed that are not statuses, and the end
   * of its supervisor.log, which names each part of a start as it begins.
   */
  explain(): string {
    const error = this.status?.error ? errorText(this.status.error, this.status.appVersion, PLATFORM) : "no error reported";
    const step = this.status?.step ? `, step ${this.status.step}` : "";
    const printed = this.lines.filter((l) => !l.startsWith("{")).slice(-20).join("\n");
    const log = logTail(path.join(this.data, DATA_LAYOUT.logs, LOG_FILES.supervisor), 15);
    return `${this.label}: state ${this.status?.state ?? "none"}${step}, ${error}${printed ? `\n${printed}` : ""}${log ? `\nsupervisor.log ends:\n${log}` : ""}`;
  }

  /** Everything it printed, statuses included, beside the logs desktop.yml keeps. */
  keepPrinted(): void {
    const dir = path.join(LOGS, "headless", "printed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${this.label}.log`), `${this.lines.join("\n")}\n`);
  }

  async send(command: Command, timeoutMs = 300_000): Promise<unknown> {
    const id = this.nextId++;
    const answer = new Promise<Outcome>((resolve) => this.answers.set(id, resolve));
    this.child.send({ type: "command", id, command });
    const outcome = await Promise.race([answer, sleep(timeoutMs).then(() => null)]);
    this.answers.delete(id);
    check(outcome, `${command.type} got no answer in ${timeoutMs / 1000} s. ${this.explain()}`);
    check(outcome.ok, `${command.type} failed: ${JSON.stringify(outcome.ok ? null : outcome.failure)}. ${this.explain()}`);
    return outcome.value;
  }

  /** Waits for a status `ok` accepts. An error, or an exit, ends the wait at once. */
  async until(what: string, ok: (s: SupervisorStatus) => boolean, timeoutMs = 240_000): Promise<SupervisorStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = this.status;
      if (s && ok(s)) return s;
      check(!(s?.state === "error"), `${this.label} stopped with an error while waiting for ${what}. ${this.explain()}`);
      check(this.child.exitCode === null && this.child.signalCode === null, `${this.label} exited while waiting for ${what}. ${this.explain()}`);
      check(Date.now() < deadline, `${this.label} did not reach ${what} in ${timeoutMs / 1000} s. ${this.explain()}`);
      await sleep(100);
    }
  }

  /** The postmaster's pid while PostgreSQL runs, from the cluster's postmaster.pid. */
  postgresPid(): number | null {
    try {
      const pid = Number(readFileSync(path.join(this.data, DATA_LAYOUT.postgres, "postmaster.pid"), "utf8").split("\n")[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /** Quit as the shell's Quit does, and check that nothing is left: the supervisor, PostgreSQL and the app server's port. */
  async quit(port: number): Promise<void> {
    const postgres = this.postgresPid();
    await this.send({ type: "stop" }, 120_000);
    const code = await Promise.race([this.exit, sleep(60_000).then(() => "late" as const)]);
    check(code === 0, `${this.label} exited with ${code} after stop. ${this.explain()}`);
    if (postgres !== null) await waitFor(`PostgreSQL (pid ${postgres}) to end`, () => !alive(postgres), 30_000);
    check(!existsSync(path.join(this.data, DATA_LAYOUT.postgres, "postmaster.pid")), `${this.label} left postmaster.pid behind`);
    check(await refused(port), `something still answers on port ${port} after the quit`);
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Play, in browsers

/**
 * The room as one page holds it, from its room socket: the snapshot, then
 * each change. e2e/harness.ts's SocketWatch reads the handshake through
 * Chromium's DevTools protocol as well, which WebKit lacks, so this keeps
 * to Playwright's own WebSocket events.
 */
class RoomWatch {
  state: RoomState | null = null;
  you: { memberId: string; role: "dm" | "player" } | null = null;

  attach(page: Page): void {
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws?room=") || /[?&]as=/.test(ws.url())) return;
      ws.on("framereceived", ({ payload }) => this.receive(typeof payload === "string" ? payload : payload.toString("utf8")));
    });
  }

  private receive(text: string): void {
    let msg: { t?: string; state?: unknown; you?: unknown; changes?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (msg.t === "snapshot") {
      this.state = msg.state as RoomState;
      this.you = msg.you as RoomWatch["you"];
    } else if (msg.t === "ev" && this.state) {
      this.state = applyChanges(this.state as unknown as ProjectedState, msg.changes as never) as unknown as RoomState;
    }
  }

  token(name: string) {
    return Object.values(this.state?.tokens ?? {}).find((t) => t?.name === name);
  }
}

/** The room the browsers made, and the DM's session cookie, which the checks after play send without a browser. */
type Game = { roomId: string; roomName: string; assets: string[]; dmCookie: string };

/** The battle mat a new room starts on (shared/initial.ts). */
const MAT = { w: 30, h: 20 };
const PASSWORD = "copper lantern meadow";
const DM_NAME = "Dana the DM";

async function tokenPng(): Promise<Buffer> {
  return sharp({ create: { width: 96, height: 96, channels: 3, background: "#7a5230" } }).png().toBuffer();
}

/** A page in a new context of its own, its room socket followed. */
async function open(browser: Browser): Promise<{ context: BrowserContext; page: Page; watch: RoomWatch }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const watch = new RoomWatch();
  watch.attach(page);
  return { context, page, watch };
}

/**
 * One player's turn in one browser: they join at the LAN address, the DM
 * gives them a character on the battle mat (as smoke.e2e.ts does), and they
 * move it, upload an image and copy the room's join link. Returns the
 * image's ID.
 */
async function playerTurn(engine: string, browser: Browser, dm: { page: Page; watch: RoomWatch }, lan: URL, roomId: string, p: { name: string; from: { x: number; y: number }; to: { x: number; y: number } }): Promise<string> {
  const { context, page, watch } = await open(browser);
  try {
    await page.goto(`${lan.origin}/r/${roomId}`);
    await page.getByLabel("Player password").fill(PASSWORD);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Your name").fill(p.name);
    await page.getByRole("button", { name: "Join", exact: true }).click();
    await waitFor(`${p.name}'s snapshot in ${engine}`, () => watch.state, 30_000);
    check(watch.you?.role === "player", `${p.name} joined in ${engine} as ${watch.you?.role}`);
    step(`${p.name} joined in ${engine} at ${lan.origin}`);

    await openSideTab(dm.page, "Characters");
    await dm.page.getByRole("button", { name: "New character" }).click();
    await dm.page.getByLabel("Name", { exact: true }).fill(`${p.name}'s hero`);
    await dm.page.getByLabel(p.name, { exact: true }).check();
    await dm.page.getByRole("button", { name: "Create and place" }).click();
    await tapCell(dm.page, MAT, p.from);
    await waitFor(`${p.name}'s token in ${engine}`, () => watch.token(`${p.name}'s hero`), 30_000);
    await dragCells(page, MAT, p.from, p.to);
    await waitFor(`${p.name}'s move at the DM`, () => {
      const t = dm.watch.token(`${p.name}'s hero`);
      return t && t.x === p.to.x && t.y === p.to.y;
    }, 30_000);
    step(`${p.name} moved their token in ${engine}`);

    // Through the page's own fetch, so the Origin and referrer are the browser's.
    const png = [...(await tokenPng())];
    const upload = await page.evaluate(
      async ({ url, bytes }) => {
        const res = await fetch(url, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array(bytes), credentials: "same-origin", mode: "same-origin" });
        return { status: res.status, body: await res.text() };
      },
      { url: `/api/rooms/${roomId}/assets?kind=token&name=smoke.png`, bytes: png },
    );
    check(upload.status === 200, `${p.name}'s upload in ${engine} got ${upload.status} ${upload.body}`);
    step(`${p.name} uploaded an image in ${engine}`);

    // Copy on an insecure origin copies, or selects the link for the device's own Copy (design 5).
    await openSideTab(page, "Menu");
    await page.getByRole("navigation", { name: "Room menu" }).getByRole("button", { name: /^Copy/ }).click();
    await waitFor(`${p.name}'s copy in ${engine}`, async () => (await page.getByRole("button", { name: /^Copied/ }).count()) + (await page.getByText("Selected. Use your device's Copy.").count()) > 0, 10_000);
    step(`${p.name} copied the join link in ${engine}`);
    return (JSON.parse(upload.body) as { id: string }).id;
  } finally {
    await context.close();
  }
}

/**
 * The DM makes a room on this computer in Chromium, and a player joins and
 * plays in it. Then, in WebKit, the DM opens the DM link at the LAN
 * address, as on a tablet, and a second player plays. One browser runs at a
 * time.
 */
async function play(local: string, lan: URL): Promise<Game> {
  const roomName = `Smoke ${new Date().toISOString().slice(0, 19)}`;
  const assets: string[] = [];
  let roomId = "";
  let dmLink = "";
  let dmCookie = "";

  const chrome = await chromium.launch();
  try {
    const dm = await open(chrome);
    await dm.page.goto(`${local}/`);
    await dm.page.getByLabel("Room name").fill(roomName);
    await dm.page.getByLabel("Your name").fill(DM_NAME);
    await dm.page.getByLabel("Player password").fill(PASSWORD);
    await dm.page.getByRole("button", { name: "Create room" }).click();
    await dm.page.getByRole("heading", { name: "Save your DM link" }).waitFor();
    dmLink = (await dm.page.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(dmLink);
    check(match, `the DM link looks wrong: ${dmLink}`);
    // A link made for another device names this computer's network address (design 5).
    check(new URL(dmLink).origin === lan.origin, `the DM link names ${new URL(dmLink).origin}, not ${lan.origin}`);
    roomId = match[1]!.replace("-", "");
    await dm.page.getByLabel("I saved my DM link").check();
    await dm.page.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dm.watch.state, 30_000);
    step(`the DM made room ${roomId} at ${local}, and its links name ${lan.origin}`);
    dmCookie = (await dm.context.cookies(local)).map((c) => `${c.name}=${c.value}`).join("; ");
    check(dmCookie, "the DM's browser holds no session cookie for this computer");
    assets.push(await playerTurn("chromium", chrome, dm, lan, roomId, { name: "Pat", from: { x: 2, y: 3 }, to: { x: 3, y: 5 } }));
  } finally {
    await chrome.close();
  }

  const safari = await webkit.launch();
  try {
    const dm = await open(safari);
    await dm.page.goto(dmLink);
    // A new device for the same DM picks who it is (smoke.e2e.ts, 1b).
    await dm.page.getByRole("button", { name: new RegExp(DM_NAME) }).click();
    await waitFor("the DM's snapshot in WebKit", () => dm.watch.state, 30_000);
    check(dm.watch.you?.role === "dm", `the DM link signed WebKit in as ${dm.watch.you?.role}`);
    step(`the DM link signed the DM in on WebKit at ${lan.origin}`);
    assets.push(await playerTurn("webkit", safari, dm, lan, roomId, { name: "Wren", from: { x: 8, y: 3 }, to: { x: 9, y: 5 } }));
  } finally {
    await safari.close();
  }
  return { roomId, roomName, assets, dmCookie };
}

/** A request on this computer as the DM's browser would send it. */
function asDm(game: Game, port: number, opts: { method?: string; path: string; body?: string }): Promise<Answer> {
  const headers: Record<string, string> = { host: `localhost:${port}`, cookie: game.dmCookie };
  if (opts.body !== undefined) Object.assign(headers, { origin: `http://localhost:${port}`, "content-type": "application/json" });
  return request("127.0.0.1", port, { ...opts, headers });
}

/** The room answers by its ID, and every image uploaded in it reads back whole. */
async function roomIsWhole(game: Game, port: number, when: string): Promise<void> {
  const room = await asDm(game, port, { path: `/api/rooms/${game.roomId}` });
  check(room.status === 200, `${when}: room ${game.roomId} answered ${room.status}`);
  check((JSON.parse(room.body) as { name?: string }).name === game.roomName, `${when}: room ${game.roomId} has another name`);
  for (const id of game.assets) {
    const image = await asDm(game, port, { path: `/api/assets/${id}/full` });
    check(image.status === 200 && image.body.length > 0, `${when}: image ${id} answered ${image.status}`);
  }
}

/** After a failure, a PostgreSQL a killed supervisor left running, stopped as the next start would, so a development computer keeps no stray server. */
function stopLeftPostgres(data: string, postgres: string): void {
  const cluster = path.join(data, DATA_LAYOUT.postgres);
  if (!existsSync(path.join(cluster, "postmaster.pid"))) return;
  const pgCtl = path.join(postgres, "bin", PLATFORM === "win32" ? "pg_ctl.exe" : "pg_ctl");
  spawnSync(pgCtl, ["stop", "-D", cluster, "-m", "fast", "-w", "-t", "60"], { stdio: "ignore", windowsHide: true });
}

// ---------------------------------------------------------------------------
// headless

async function headless(argv: readonly string[]): Promise<void> {
  const option = (name: string) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const stage = path.resolve(option("--stage") ?? defaultOut());
  const runtime = path.resolve(option("--runtime") ?? path.join(ROOT, RUNTIME_DIR));
  const node = path.join(runtime, RESOURCES.node, serverBinaryName(PLATFORM));
  const postgres = path.join(runtime, RESOURCES.postgres);
  for (const [what, p] of [["the staged supervisor", path.join(stage, SUPERVISOR_ENTRY)], ["the bundled Node", node], ["the bundled PostgreSQL", postgres]] as const) {
    check(existsSync(p), `${what} is not at ${p}. Run desktop/scripts/fetch-runtime.ts, pnpm build and desktop/scripts/stage.ts first.`);
  }

  const base = mkdtempSync(path.join(TEMP, "raccoonvtt-smoke-"));
  const data = path.join(base, AWKWARD_FOLDER, "data");
  mkdirSync(path.dirname(data), { recursive: true });
  const blocker = await hold5432();
  step(blocker ? "holding 5432, as a PostgreSQL of the DM's own would" : "5432 is taken already, as a PostgreSQL of the DM's own would take it");
  const port = await freePort();
  const local = `http://localhost:${port}`;
  const start = (label: string, folder = data, env?: Record<string, string>) => new Supervisor(label, folder, { node, stage, postgres, port, env });
  const running = new Set<Supervisor>();
  const all: Supervisor[] = [];
  const started = (s: Supervisor) => (running.add(s), all.push(s), s);

  try {
    let sup = started(start("first start"));
    const first = await sup.until("running", (s) => s.state === "running");
    check(first.host === "0.0.0.0" && first.shareOrigin, `players cannot join: network ${first.network}, host ${first.host}. ${sup.explain()}`);
    const lan = new URL(first.shareOrigin);
    step(`running at ${local}, and players join at ${lan.origin}, with data in ${data}`);

    await refusals(port, lan);

    const game = await play(local, lan);
    await roomIsWhole(game, port, "after play");

    await sup.send({ type: "backupNow" });
    // The first start's daily backup may be listed too (design 8.2).
    const { backups } = (await sup.send({ type: "listBackups" })) as { backups: { name: string; kind: string; readable: boolean }[] };
    const manual = backups.filter((b) => b.kind === "manual");
    check(manual.length === 1 && manual[0]!.readable, `listBackups after Back up now: ${JSON.stringify(backups)}`);
    const backup = manual[0]!.name;
    step(`backed up as ${backup}, beside ${backups.length - 1} other`);

    // A room made after the backup, which the restore must take away.
    const later = await asDm(game, port, { method: "POST", path: "/api/rooms", body: JSON.stringify({ name: "Made after the backup", dmName: "Dana", playerPassword: PASSWORD }) });
    check(later.status === 201, `a second room got ${later.status} ${later.body}`);
    const laterId = (JSON.parse(later.body) as { roomId: string }).roomId;

    await sup.quit(port);
    running.delete(sup);
    step("quit with nothing left running");

    sup = started(start("second start"));
    await sup.until("running", (s) => s.state === "running");
    await roomIsWhole(game, port, "after a quit and a start");
    check((await asDm(game, port, { path: `/api/rooms/${laterId}` })).status === 200, "the room made after the backup is gone before the restore");
    step("started again with the room and its images");

    // Another supervisor on the same folder by another path is refused, and the game keeps answering.
    const alias = path.join(base, "same data");
    symlinkSync(data, alias, PLATFORM === "win32" ? "junction" : "dir");
    const second = started(start("a second supervisor", alias));
    await waitFor("the second supervisor's refusal", () => second.status?.state === "error" || second.child.exitCode !== null || second.child.signalCode !== null, 60_000);
    check(second.status?.error?.kind === "alreadyRunning", `a second supervisor at ${alias} was not refused as already running. ${second.explain()}`);
    second.kill();
    running.delete(second);
    await roomIsWhole(game, port, "beside a refused second supervisor");
    step("a second supervisor on another path to the folder is refused, and the game keeps answering");

    await sup.send({ type: "restore", backup });
    await sup.until("the restore's end", (s) => s.state === "running" && s.notice?.kind === "restored", 300_000);
    await roomIsWhole(game, port, "after a restore");
    check((await asDm(game, port, { path: `/api/rooms/${laterId}` })).status === 404, "the room made after the backup is still there after its restore");
    step("restored the backup");

    // A restore cut off between its two renames, the moment no database is
    // named raccoon: the supervisor kills itself there, as the restore
    // tests do (desktop/runtime/main.ts, RESTORE_TEST_CRASH_AT). The next
    // start finishes it (design 8.3).
    await sup.quit(port);
    running.delete(sup);
    sup = started(start("a start that dies in a restore", data, { RESTORE_TEST_CRASH_AT: "renamedLive" }));
    await sup.until("running", (s) => s.state === "running");
    sup.child.send({ type: "command", id: 1, command: { type: "restore", backup } satisfies Command });
    const died = await Promise.race([sup.exit.then(() => sup.child.signalCode ?? sup.child.exitCode), sleep(300_000).then(() => "late" as const)]);
    check(died !== "late" && died !== 0, `the supervisor did not die in the restore, as RESTORE_TEST_CRASH_AT asks: ${died}. ${sup.explain()}`);
    running.delete(sup);
    step(`the supervisor died between the restore's two renames (${died})`);
    sup = started(start("start after a killed restore"));
    const after = await sup.until("running", (s) => s.state === "running", 300_000);
    check(after.notice?.kind === "restoreFinished" || after.notice?.kind === "restoreInterrupted", `the start after a killed restore gave no notice of it: ${JSON.stringify(after.notice)}`);
    await roomIsWhole(game, port, "after a killed restore");
    step(`the next start ${after.notice?.kind === "restoreFinished" ? "finished" : "undid"} the restore, with the room and its images whole`);

    await sup.quit(port);
    running.delete(sup);
    step("quit with nothing left running");
  } finally {
    for (const s of running) s.kill();
    stopLeftPostgres(data, postgres);
    blocker?.close();
    keepLogs(data, "headless");
    for (const s of all) s.keepPrinted();
  }
}

// ---------------------------------------------------------------------------
// The packaged app

function requireCi(what: string): void {
  check(process.env.CI === "true", `${what} installs the app for every user and changes the system, so it runs only in CI (CI=true).`);
}

/** Runs a program to its end, failing on a nonzero exit, and returns what it printed. */
function run(cmd: string, args: readonly string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): { status: number | null; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeoutMs ?? 600_000, env: opts.env ?? process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!opts.allowFail) check(r.status === 0, `${path.basename(cmd)} ${args.join(" ")} ended with ${r.status ?? r.signal ?? r.error?.message}:\n${out.slice(-4000)}`);
  return { status: r.status, out };
}

/** The packaged app with `--smoke`: no browser, and exit code 0 once the supervisor reports running. */
function appSmoke(exe: string, data: string, label: string, wrap: readonly string[] = []): void {
  const env: NodeJS.ProcessEnv = { ...process.env, [DATA_DIR_ENV]: data };
  delete env.NODE_OPTIONS;
  const [cmd, ...pre] = wrap.length > 0 ? wrap : [exe];
  const r = run(cmd!, wrap.length > 0 ? [...pre, exe, SHELL_ARGS.smoke] : [SHELL_ARGS.smoke], { timeoutMs: 300_000, env, allowFail: true });
  keepLogs(data, label);
  check(r.status === 0, `${label}: ${path.basename(exe)} ${SHELL_ARGS.smoke} ended with ${r.status}:\n${r.out.slice(-4000)}`);
  step(`${label}: ${SHELL_ARGS.smoke} reached running and quit`);
}

const POWERSHELL = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function powershell(script: string): string {
  return run(POWERSHELL(), ["-NoProfile", "-NonInteractive", "-Command", script]).out.trim();
}

/** Every process whose program lies under `dir`, as `name pid` lines. */
function processesUnder(dir: string): string[] {
  const out = powershell(`Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${dir.replaceAll("'", "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "$($_.ProcessName) $($_.Id)" }`);
  return out.split(/\r?\n/).filter(Boolean);
}

function firewallRules(): string[] {
  const r = run("netsh", ["advfirewall", "firewall", "show", "rule", `name=${APP_NAME}`, "verbose"], { allowFail: true });
  return r.out.split(/\r?\n/).filter((l) => /^Rule Name:/.test(l));
}

/** Whether postgres.log's last lines say PostgreSQL shut down cleanly. */
function cleanShutdown(data: string): boolean {
  const log = path.join(data, DATA_LAYOUT.logs, "postgres.log");
  return existsSync(log) && /database system is shut down/.test(readFileSync(log, "utf8").split("\n").slice(-20).join("\n"));
}

async function healthy(port: number, timeoutMs: number): Promise<void> {
  await waitFor(`the app server on port ${port}`, async () => {
    try {
      return (await request("127.0.0.1", port, { path: "/healthz", headers: { host: `localhost:${port}` } })).status === 200;
    } catch {
      return false;
    }
  }, timeoutMs);
}

/** The port the app saved on its first start (design 7). */
async function savedPort(data: string): Promise<number> {
  return waitFor("the saved port", () => {
    try {
      const port = (JSON.parse(readFileSync(path.join(data, DATA_LAYOUT.settings), "utf8")) as { port?: number }).port;
      return typeof port === "number" ? port : null;
    } catch {
      return null;
    }
  }, 240_000);
}

async function windows(setup: string): Promise<void> {
  requireCi("The Windows smoke test");
  check(PLATFORM === "win32", "The Windows smoke test runs on Windows");
  const installDir = path.join(process.env.ProgramFiles ?? "C:\\Program Files", APP_NAME);
  const exe = path.join(installDir, `${APP_NAME}.exe`);
  const data = path.join(process.env.LOCALAPPDATA ?? "", APP_NAME, "data");
  const serverExe = path.join(installDir, "resources", RESOURCES.node, serverBinaryName("win32"));
  // No browser opens on a runner: the setting a DM would turn off.
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, DATA_LAYOUT.settings), JSON.stringify({ openBrowser: false }));

  const install = () => run(setup, ["/S"], { timeoutMs: 600_000 });
  const oneRule = () => {
    const rules = firewallRules();
    check(rules.length === 1, `the firewall has ${rules.length} rules named ${APP_NAME}, not 1`);
    const shown = run("netsh", ["advfirewall", "firewall", "show", "rule", `name=${APP_NAME}`, "verbose"]).out;
    check(shown.toLowerCase().includes(serverExe.toLowerCase()), `the firewall rule does not name ${serverExe}:\n${shown}`);
    check(/Profiles:\s+Private/i.test(shown), `the firewall rule is not for private networks only:\n${shown}`);
  };
  const startApp = async (): Promise<ChildProcess> => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[DATA_DIR_ENV];
    const child = spawn(exe, [], { detached: true, stdio: "ignore", env });
    child.unref();
    await healthy(await savedPort(data), 240_000);
    return child;
  };
  const nothingLeft = async (what: string) => {
    await waitFor(`no process under ${installDir} ${what}`, () => processesUnder(installDir).length === 0, 30_000).catch(() => {
      throw new SmokeError(`${what}, these are left under ${installDir}: ${processesUnder(installDir).join(", ")}`);
    });
  };

  try {
    install();
    check(existsSync(exe), `the installer put no ${exe}`);
    oneRule();
    step("installed for every user, with one firewall rule for private networks");

    let app = await startApp();
    // The Visual C++ runtime PostgreSQL loads is the copy beside it, never one from System32 (D-261113-103).
    const loaded = powershell(
      "Get-Process postgres -ErrorAction SilentlyContinue | ForEach-Object { $_.Modules } | Where-Object { $_.ModuleName -in 'VCRUNTIME140.dll','VCRUNTIME140_1.dll','MSVCP140.dll' } | ForEach-Object { $_.FileName } | Sort-Object -Unique",
    ).split(/\r?\n/).filter(Boolean);
    const bin = path.join(installDir, "resources", RESOURCES.postgres, "bin").toLowerCase();
    check(loaded.some((f) => /\\vcruntime140\.dll$/i.test(f)), `postgres.exe loaded no VCRUNTIME140.dll: ${loaded.join(", ")}`);
    check(loaded.every((f) => f.toLowerCase().startsWith(bin)), `postgres.exe loaded the Visual C++ runtime from elsewhere: ${loaded.join(", ")}`);
    step(`PostgreSQL loads ${loaded.map((f) => path.basename(f)).join(", ")} from the app's own folder`);

    install();
    await nothingLeft("after installing over the running app");
    check(cleanShutdown(data), "installing over the running app did not shut PostgreSQL down cleanly");
    oneRule();
    step("installing again over the running app quit it cleanly and kept one firewall rule");

    app = await startApp();
    run("taskkill", ["/F", "/PID", String(app.pid)]);
    await nothingLeft("after taskkill /F of the shell");
    check(cleanShutdown(data), "after taskkill /F of the shell, PostgreSQL did not shut down cleanly");
    step("taskkill /F of the shell: the supervisor stopped the server and PostgreSQL cleanly within 30 s");

    const startedAt = Date.now();
    run(exe, [SHELL_ARGS.quit], { timeoutMs: 30_000 });
    check(Date.now() - startedAt < 15_000, `${SHELL_ARGS.quit} with nothing running took ${Math.round((Date.now() - startedAt) / 1000)} s`);
    await nothingLeft(`after ${SHELL_ARGS.quit} with nothing running`);
    step(`${SHELL_ARGS.quit} with nothing running exits at once and starts nothing`);

    await startApp();
    const uninstaller = readdirSync(installDir).find((f) => /^Uninstall .*\.exe$/i.test(f));
    check(uninstaller, `no uninstaller in ${installDir}`);
    run(path.join(installDir, uninstaller), ["/S"], { timeoutMs: 600_000 });
    // NSIS's uninstaller copies itself away and goes on from there.
    await waitFor("the uninstall to remove the app", () => !existsSync(exe), 300_000);
    await nothingLeft("after uninstalling the running app");
    check(firewallRules().length === 0, "the uninstaller left the firewall rule");
    check(existsSync(path.join(data, DATA_LAYOUT.postgres)), "the uninstaller removed the data folder");
    step("uninstalling the running app quit it, removed the rule and kept the data");
  } finally {
    keepLogs(data, "windows");
  }
}

async function macos(dmg: string): Promise<void> {
  check(PLATFORM === "darwin", "The macOS smoke test runs on macOS");
  const arch = /-macos-(arm64|x64)\.dmg$/.exec(dmg)?.[1];
  check(arch, `${dmg} is not named for a macOS architecture`);
  const want = arch === "x64" ? "x86_64" : "arm64";
  const work = mkdtempSync(path.join(TEMP, "raccoonvtt-macos-"));
  const mount = path.join(work, "mount");
  const app = path.join(work, "Applications", `${APP_NAME}.app`);
  const data = path.join(work, AWKWARD_FOLDER, "data");
  mkdirSync(path.dirname(app), { recursive: true });
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
  try {
    run("ditto", [path.join(mount, `${APP_NAME}.app`), app]);
  } finally {
    run("hdiutil", ["detach", mount]);
  }
  step("copied the app out of the DMG");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  step("codesign --verify --deep --strict passes");
  const resources = path.join(app, "Contents", "Resources");
  for (const binary of [path.join(resources, RESOURCES.node, serverBinaryName("darwin")), path.join(resources, RESOURCES.postgres, "bin", "postgres")]) {
    const archs = run("lipo", ["-archs", binary]).out.trim();
    check(archs === want, `${binary} is built for ${archs}, not ${want}`);
  }
  step(`the bundled Node and PostgreSQL are ${want}`);
  appSmoke(path.join(app, "Contents", "MacOS", APP_NAME), data, "macos");
}

async function linux(deb: string, appImage: string): Promise<void> {
  requireCi("The Linux smoke test");
  check(PLATFORM === "linux", "The Linux smoke test runs on Linux");
  const work = mkdtempSync(path.join(TEMP, "raccoonvtt-linux-"));
  const pkg = run("dpkg-deb", ["-f", deb, "Package"]).out.trim();
  const xvfb = ["xvfb-run", "-a"];
  // A display for Electron, and FUSE 2 for the AppImage. The package lists
  // are fresh from Playwright's --with-deps install before this.
  run("sudo", ["apt-get", "install", "-y", "--no-install-recommends", "xvfb", "libfuse2t64"]);

  // As Ubuntu 24.04's desktops have it: unprivileged user namespaces only
  // for programs an AppArmor profile allows, so the deb must bring one.
  run("sudo", ["sysctl", "-w", "kernel.apparmor_restrict_unprivileged_userns=1"]);
  run("sudo", ["apt-get", "install", "-y", path.resolve(deb)]);
  // The program its menu entry starts, as a DM's desktop would start it.
  const installed = run("dpkg", ["-L", pkg]).out.split("\n").map((l) => l.trim());
  const entry = installed.find((f) => f.startsWith("/usr/share/applications/") && f.endsWith(".desktop"));
  check(entry, `the deb installed no menu entry in /usr/share/applications`);
  const exe = /^Exec="?([^"\s]+)"?/m.exec(readFileSync(entry, "utf8"))?.[1];
  check(exe && exe.startsWith(`/opt/${APP_NAME}/`) && existsSync(exe), `${entry} starts ${exe}, not a program under /opt/${APP_NAME}`);
  const profiles = readdirSync("/etc/apparmor.d").filter((f) => {
    const file = path.join("/etc/apparmor.d", f);
    return statSync(file).isFile() && readFileSync(file, "utf8").includes(`/opt/${APP_NAME}/`);
  });
  check(profiles.length > 0, `the deb installed no AppArmor profile for /opt/${APP_NAME}`);
  step(`the deb installed ${exe} and the AppArmor profile ${profiles.join(", ")}`);
  const debData = path.join(work, "deb", AWKWARD_FOLDER, "data");
  appSmoke(exe, debData, "deb", xvfb);
  run("sudo", ["apt-get", "remove", "-y", pkg]);
  check(existsSync(path.join(debData, DATA_LAYOUT.postgres)), "apt remove took the data folder");
  step("apt remove kept the data folder");

  // As the other distributions the AppImage is for have it.
  run("sudo", ["sysctl", "-w", "kernel.apparmor_restrict_unprivileged_userns=0"]);
  chmodSync(appImage, 0o755);
  appSmoke(path.resolve(appImage), path.join(work, "appimage", AWKWARD_FOLDER, "data"), "appimage", xvfb);
}

// ---------------------------------------------------------------------------

const USAGE = `Usage:
  node desktop/scripts/smoke.ts headless [--stage <dir>] [--runtime <dir>]
  node desktop/scripts/smoke.ts windows <setup.exe>
  node desktop/scripts/smoke.ts macos <dmg>
  node desktop/scripts/smoke.ts linux <deb> <AppImage>`;

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const file = (at: number) => {
    const value = rest[at];
    check(value && existsSync(value), `${value ?? "A file"} is not there.\n${USAGE}`);
    return path.resolve(value);
  };
  switch (command) {
    case "headless":
      return headless(rest);
    case "windows":
      return windows(file(0));
    case "macos":
      return macos(file(0));
    case "linux":
      return linux(file(0), file(1));
    default:
      throw new SmokeError(USAGE);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
    console.log("The smoke test passed.");
  } catch (err) {
    console.error(err instanceof SmokeError ? `The smoke test failed: ${err.message}` : err);
    process.exitCode = 1;
  }
  // A browser or a socket left open would keep the process alive.
  process.exit();
}
