import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Locator, Page } from "playwright-core";
import WebSocket from "ws";
import type { RoomState } from "#shared/model.ts";
import { applyChanges, type ProjectedState } from "#shared/project.ts";

/**
 * Plumbing for the end-to-end smoke run (design section 18, Stage 3): the
 * real server as a child process, what each browser page receives on its
 * WebSocket, its console, numbered screenshots, and map coordinates.
 */

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

export type ServerOptions = { port: number; assetDir: string; databaseUrl: string };

export type Server = {
  origin: string;
  /** Everything the process printed, for a failure message. */
  output(): string;
  alive(): boolean;
  /** SIGTERM, then wait for the graceful shutdown (design 15.4) to exit. */
  stop(): Promise<number | null>;
};

/**
 * Starts `node server/main.ts` serving dist/, the way the Docker image runs
 * it, and waits for /healthz. The creation limits are raised because every
 * run creates a room from 127.0.0.1, and the daily counts live in Postgres.
 */
export async function startServer(opts: ServerOptions): Promise<Server> {
  const origin = `http://localhost:${opts.port}`;
  const child: ChildProcess = spawn(process.execPath, ["server/main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(opts.port),
      HOST: "127.0.0.1",
      PUBLIC_ORIGIN: origin,
      DATABASE_URL: opts.databaseUrl,
      ASSET_DIR: opts.assetDir,
      ROOMS_PER_IP_PER_DAY: "1000",
      ROOMS_PER_DAY: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
  child.stderr?.on("data", (b: Buffer) => (out += b.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  let alive = true;
  void exited.then(() => (alive = false));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (!alive) throw new Error(`The server exited during startup:\n${out}`);
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/healthz`);
      if (res.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`The server did not answer /healthz within 20 s:\n${out}`);
    }
    await sleep(100);
  }

  return {
    origin,
    output: () => out,
    alive: () => alive,
    async stop() {
      if (!alive) return exited;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` returns something truthy, or fails with `what` and the last value seen. */
export async function waitFor<T>(what: string, check: () => T | Promise<T>, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await check();
    if (last) return last as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(50);
  }
}

type Json = Record<string, unknown>;

/**
 * Follows the room socket of one page the way the client store does: the
 * snapshot replaces the state, each `ev` applies its changes. So `state` is
 * exactly the `confirmed` state that page holds, which is what a player
 * could ever see. Every frame is also kept as text, to check that a secret
 * never appears in any of them.
 */
export class SocketWatch {
  state: RoomState | null = null;
  you: { memberId: string; role: "dm" | "player"; sceneId: string | null } | null = null;
  /** Every frame the page received on a room socket, as text. */
  readonly received: string[] = [];
  /** Payload sizes of every snapshot, in bytes of JSON. */
  readonly snapshotBytes: number[] = [];
  /** Response headers of each room socket's handshake, lowercased. */
  readonly handshakes: Record<string, string>[] = [];
  sockets = 0;
  closes = 0;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  async attach(context: BrowserContext, page: Page): Promise<void> {
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws?room=")) return;
      this.sockets++;
      ws.on("framereceived", ({ payload }) => this.receive(typeof payload === "string" ? payload : payload.toString("utf8")));
      ws.on("close", () => this.closes++);
    });
    // Playwright's WebSocket object has no headers, so the handshake comes
    // from the DevTools protocol: it names the negotiated extensions.
    const cdp = await context.newCDPSession(page);
    cdp.on("Network.webSocketHandshakeResponseReceived", (e) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.response.headers)) headers[k.toLowerCase()] = String(v);
      this.handshakes.push(headers);
    });
    await cdp.send("Network.enable");
  }

  private receive(text: string): void {
    this.received.push(text);
    let msg: Json;
    try {
      msg = JSON.parse(text) as Json;
    } catch {
      return;
    }
    if (msg.t === "snapshot") {
      this.snapshotBytes.push(Buffer.byteLength(text));
      this.state = msg.state as RoomState;
      this.you = msg.you as SocketWatch["you"];
    } else if (msg.t === "ev" && this.state) {
      this.state = applyChanges(this.state as unknown as ProjectedState, msg.changes as never) as unknown as RoomState;
    }
  }

  /** Whether any frame this page ever received mentions `needle`. */
  everSaw(needle: string): boolean {
    return this.received.some((f) => f.includes(needle));
  }
}

/**
 * Console errors, warnings and uncaught exceptions. A WebSocket that cannot
 * connect logs one by itself, which is expected only while the test has the
 * server down or the page offline, so those windows are marked.
 */
export class ConsoleWatch {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  expectSocketFailures = false;
  /** Errors expected at this point of the run, each with its reason at the place it is set. */
  allow: RegExp[] = [];
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  attach(page: Page): void {
    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const text = msg.text();
      const line = `${text} (${msg.location().url})`;
      if (this.expectSocketFailures && /WebSocket connection to .* failed|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED/.test(text)) return;
      if (this.allow.some((re) => re.test(line))) return;
      (type === "error" ? this.errors : this.warnings).push(line);
    });
    // Some page errors arrive with an empty stack, which `??` keeps, and the
    // log read "uncaught: " with nothing after it.
    page.on("pageerror", (err) => this.errors.push(`uncaught: ${err.stack || err.message || String(err)}`));
  }
}

/**
 * Picks an option of a tool's choice wherever the row put it
 * (docs/design-v1-tool-options.md 14): through its chip's popover, which a
 * pick closes, in the row as a choice of its own, or behind ⋯, which it
 * closes after. `group` is the choice's name ("Drawing tool", "Shape"), and
 * `option` the option's.
 */
export async function pickOption(page: Page, tool: string, group: string, option: string): Promise<void> {
  const bar = page.getByRole("toolbar", { name: `${tool} options` });
  const chip = bar.getByRole("button", { name: new RegExp(`^${group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`) });
  const inRow = bar.locator("[data-options-row]").getByRole("radiogroup", { name: group }).getByRole("radio", { name: option, exact: true });
  // A tool that loads its options on first use draws its row a moment after it is picked, and the row settles once measured.
  const deadline = Date.now() + 5_000;
  for (;;) {
    if ((await chip.count()) > 0 && (await chip.first().isVisible())) {
      await chip.first().click();
      const popover = page.getByRole("dialog", { name: group });
      await popover.getByRole("radio", { name: option, exact: true }).click();
      await popover.waitFor({ state: "detached" });
      return;
    }
    if ((await inRow.count()) > 0 && (await inRow.first().isVisible())) {
      await inRow.first().click();
      return;
    }
    if (Date.now() > deadline) break;
    await sleep(100);
  }
  await bar.getByRole("button", { name: "More options" }).click();
  const more = page.getByRole("dialog", { name: `More ${tool} options` });
  await more.getByRole("radiogroup", { name: group }).getByRole("radio", { name: option, exact: true }).click();
  await page.keyboard.press("Escape");
  await more.waitFor({ state: "detached" });
}

/** Presses a button among a tool's options, in the row where it fits, else behind ⋯, which it then closes. */
export async function pressOption(page: Page, tool: string, name: string): Promise<void> {
  const bar = page.getByRole("toolbar", { name: `${tool} options` });
  const own = bar.locator("[data-options-row]").getByRole("button", { name, exact: true });
  // A row that just changed, as when a tap selects a stamp, settles once measured.
  const deadline = Date.now() + 2_000;
  for (;;) {
    if ((await own.count()) > 0 && (await own.first().isVisible())) {
      await own.first().click();
      return;
    }
    if (Date.now() > deadline) break;
    await sleep(100);
  }
  await bar.getByRole("button", { name: "More options" }).click();
  const more = page.getByRole("dialog", { name: `More ${tool} options` });
  await more.getByRole("button", { name, exact: true }).click();
  if (await more.isVisible()) await page.keyboard.press("Escape");
  await more.waitFor({ state: "detached" });
}

/**
 * Makes a tool active whatever the toolbar shows (docs/design-v1-tool-options.md
 * 5): its own button, else its tile behind Setup on a phone, else, in the
 * pair, the Tools menu the last tool opens. A tool already active is left
 * as it is, since picking it again would hide its options.
 */
export async function pickTool(page: Page, label: string, within?: Locator): Promise<void> {
  // A preview such as "Viewing as Pat" draws a second toolbar of its own.
  const nav = (within ?? page).locator('nav[aria-label="Tools"]');
  const own = nav.getByRole("button", { name: label, exact: true });
  if ((await own.count()) > 0 && (await own.first().isVisible())) {
    if ((await own.first().getAttribute("data-active")) !== "true") await own.first().click();
    return;
  }
  const setup = nav.getByRole("button", { name: /^Setup tools/ });
  if ((await setup.count()) > 0 && (await setup.first().isVisible())) {
    if ((await setup.first().getAttribute("aria-label")) === `Setup tools: ${label}`) return;
    await setup.first().click();
    await page.getByRole("menu", { name: "Setup tools" }).getByRole("menuitemradio", { name: label, exact: true }).click();
    return;
  }
  // The pair: its second button opens Tools once its own tool is active.
  const second = nav.locator("button[data-active]").nth(1);
  if ((await second.getAttribute("data-active")) !== "true") await second.click();
  await second.click();
  await page.getByRole("menu", { name: "Tools" }).getByRole("menuitemradio", { name: label, exact: true }).click();
}

/** Numbered screenshots that never overwrite an earlier run's. */
export class Shots {
  private next: number | null = null;
  readonly taken: string[] = [];
  readonly dir: string | null;

  constructor(dir: string | null) {
    this.dir = dir;
  }

  async take(page: Page, name: string): Promise<void> {
    if (!this.dir) return;
    if (this.next === null) {
      mkdirSync(this.dir, { recursive: true });
      const used = readdirSync(this.dir)
        .map((f) => /^(\d+)-/.exec(f)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);
      this.next = used.length > 0 ? Math.max(...used) + 1 : 1;
    }
    let file: string;
    do file = path.join(this.dir, `${String(this.next++).padStart(3, "0")}-${name}.png`);
    while (existsSync(file));
    await page.screenshot({ path: file });
    this.taken.push(file);
  }
}

type StageCamera = { x: number; y: number; scale: number };

/** A side panel tab's name: its title, and what its count says when it carries one, "N unread" or the DM panel's "1 upload waiting". */
export function sideTabName(title: string): RegExp {
  return new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\d+ [a-z ]+)?$`);
}

/**
 * Opens a panel in the side panel from 900 px up (docs/design-v1-panel-tabs.md
 * 11.3): nothing when it is already chosen, a click on its tab where the
 * row holds it, else More (the tab with a menu) and its item in More's
 * list. Then waits for the tab panel named by it. `page` may be a part of
 * the page, such as "view as a player"'s dialog with its own side panel.
 */
export async function openSideTab(page: Page | Locator, title: string): Promise<void> {
  const name = sideTabName(title);
  const list = page.getByRole("tablist", { name: "Panels" });
  const tab = list.getByRole("tab", { name });
  if ((await tab.count()) === 0 || (await tab.getAttribute("aria-selected")) !== "true") {
    if ((await tab.count()) > 0 && (await tab.getAttribute("aria-haspopup")) === null) await tab.click();
    else {
      await list.locator('[role="tab"][aria-haspopup="menu"]').click();
      await page.getByRole("menu", { name: "More panels" }).getByRole("menuitemradio", { name }).click();
    }
  }
  await page.getByRole("tabpanel", { name }).waitFor();
}

/** The map stage's camera, read from Konva, which puts itself on the page as a global. */
/**
 * Whether `target` shows whole and takes a tap as things stand, with
 * nothing scrolled first: a tap at its middle, and one just inside the
 * middle of each edge, lands on it. A control cut off by its card's foot
 * can still take a tap at its middle.
 */
export async function wholeInReach(target: Locator): Promise<boolean> {
  // Something hidden is not in reach, and a locator that matches nothing would wait for it.
  if ((await target.count()) === 0) return false;
  const b = await target.boundingBox();
  if (!b) return false;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const points = [
    [x, y],
    [x, b.y + 3],
    [x, b.y + b.height - 3],
    [b.x + 3, y],
    [b.x + b.width - 3, y],
  ] as const;
  return target.evaluate(
    (el, at) =>
      at.every(([px, py]) => {
        const top = el.ownerDocument.elementFromPoint(px, py);
        return top !== null && el.contains(top);
      }),
    points,
  );
}

export function readCamera(page: Page): Promise<StageCamera | null> {
  return page.evaluate(() => {
    const konva = (globalThis as unknown as { Konva?: { stages: { x(): number; y(): number; scaleX(): number }[] } }).Konva;
    const stage = konva?.stages[0];
    return stage ? { x: stage.x(), y: stage.y(), scale: stage.scaleX() } : null;
  });
}

/**
 * The page point of a world point (in cells) on a scene's canvas. A fitted
 * scene follows the bars over the map (Stage.tsx), so a tool whose options
 * just appeared, and then loaded and wrapped, can still move it. The camera
 * is read until it has held still for 300 ms.
 */
export async function pagePoint(page: Page, _bounds: { w: number; h: number }, world: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await page.locator(".konvajs-content").first().boundingBox();
  if (!box) throw new Error("The map canvas is not on the page");
  let cam = await readCamera(page);
  let still = 0;
  for (let i = 0; i < 60 && still < 6; i++) {
    await sleep(50);
    const next = await readCamera(page);
    still = cam && next && next.x === cam.x && next.y === cam.y && next.scale === cam.scale ? still + 1 : 0;
    cam = next;
  }
  if (!cam) throw new Error("The map stage has no camera");
  return { x: box.x + cam.x + world.x * cam.scale, y: box.y + cam.y + world.y * cam.scale };
}

/** Fails when something other than the map canvas would take a tap at this point, such as a sheet or a bar. */
export async function assertCanvasAt(page: Page, p: { x: number; y: number }): Promise<void> {
  const tag = await page.evaluate(
    ([x, y]) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? null,
    [p.x, p.y] as const,
  );
  if (tag !== "CANVAS") throw new Error(`Expected the map canvas at ${Math.round(p.x)},${Math.round(p.y)}, found ${tag}`);
}

/** Taps a cell's center. */
export async function tapCell(page: Page, bounds: { w: number; h: number }, cell: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
  await assertCanvasAt(page, p);
  await page.mouse.click(p.x, p.y);
}

/** Drags between two world points in small steps, the way a finger or a mouse would. */
export async function dragWorld(page: Page, bounds: { w: number; h: number }, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await pagePoint(page, bounds, from);
  const b = await pagePoint(page, bounds, to);
  await assertCanvasAt(page, a);
  await assertCanvasAt(page, b);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + (b.x - a.x) * 0.1, a.y + (b.y - a.y) * 0.1, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
}

/** Drags from one cell's center to another's. */
export async function dragCells(page: Page, bounds: { w: number; h: number }, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await dragWorld(page, bounds, { x: from.x + 0.5, y: from.y + 0.5 }, { x: to.x + 0.5, y: to.y + 0.5 });
}

export type SnapshotSize = { extensions: string; json: number; wire: number };

/**
 * Opens one more room socket as an existing browser session, says hello and
 * counts the bytes that arrive until the snapshot, with or without
 * permessage-deflate. The browser's own sockets cannot report bytes on the
 * wire, and design section 18 asks for the snapshot size both ways. The
 * count also holds a `presence` frame or two, a few dozen bytes each.
 */
export async function measureSnapshot(input: { origin: string; roomId: string; cookie: string; deflate: boolean }): Promise<SnapshotSize> {
  const url = `${input.origin.replace(/^http/, "ws")}/ws?room=${input.roomId}`;
  const ws = new WebSocket(url, { headers: { Origin: input.origin, Cookie: input.cookie }, perMessageDeflate: input.deflate });
  return new Promise<SnapshotSize>((resolve, reject) => {
    let readBefore = 0;
    let socket: { bytesRead: number } | null = null;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("No snapshot within 10 s"));
    }, 10_000);
    ws.on("upgrade", (res) => {
      socket = res.socket;
    });
    ws.on("open", () => {
      readBefore = socket?.bytesRead ?? 0;
      ws.send(JSON.stringify({ t: "hello", clientId: randomUUID(), resumeFrom: 1 }));
    });
    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if ((JSON.parse(text) as { t?: unknown }).t !== "snapshot") return;
      clearTimeout(timer);
      const size = { extensions: ws.extensions, json: Buffer.byteLength(text), wire: (socket?.bytesRead ?? 0) - readBefore };
      ws.close(1000);
      resolve(size);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * A second room socket for a browser session, which sends ops and waits for
 * each to be acknowledged. A run uses it to lay out a scene quickly (walls,
 * heights, tokens) and then drives the browsers through what it tests, so
 * the setup is not the part under test. It speaks as the session's member,
 * with its own client ID.
 */
export class OpSocket {
  private readonly ws: WebSocket;
  private next = 1;
  private readonly waiting = new Map<number, { resolve(): void; reject(err: Error): void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as {
        t?: string;
        acks?: number[];
        rejects?: { n: number; code: string; message: string }[];
        n?: number;
        code?: string;
      };
      if (msg.t === "ev") {
        for (const n of msg.acks ?? []) this.waiting.get(n)?.resolve();
        for (const r of msg.rejects ?? []) this.waiting.get(r.n)?.reject(new Error(`op ${r.n} refused: ${r.code}: ${r.message}`));
      } else if (msg.t === "retry" && msg.n !== undefined) {
        this.waiting.get(msg.n)?.reject(new Error(`op ${msg.n} asked to retry: ${msg.code}`));
      }
    });
  }

  static async open(input: { origin: string; roomId: string; cookie: string }): Promise<OpSocket> {
    const ws = new WebSocket(`${input.origin.replace(/^http/, "ws")}/ws?room=${input.roomId}`, { headers: { Origin: input.origin, Cookie: input.cookie } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No snapshot within 10 s")), 10_000);
      ws.on("open", () => ws.send(JSON.stringify({ t: "hello", clientId: randomUUID(), resumeFrom: 1 })));
      ws.on("message", function first(data) {
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        if ((JSON.parse(text) as { t?: unknown }).t !== "snapshot") return;
        clearTimeout(timer);
        ws.off("message", first);
        resolve();
      });
      ws.on("error", reject);
    });
    return new OpSocket(ws);
  }

  /** Sends one op and resolves once the server took it, or rejects with its refusal. */
  send(op: Record<string, unknown>): Promise<void> {
    const n = this.next++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`op ${n} (${String(op.t)}) got no answer within 10 s`)), 10_000);
      this.waiting.set(n, {
        resolve: () => {
          clearTimeout(timer);
          this.waiting.delete(n);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          this.waiting.delete(n);
          reject(err);
        },
      });
      this.ws.send(JSON.stringify({ t: "op", n, op }));
    });
  }

  close(): void {
    this.ws.close(1000);
  }
}
