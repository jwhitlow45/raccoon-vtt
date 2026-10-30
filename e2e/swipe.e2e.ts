import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { GRABBER_DESIGNS, grabberRoom, type GrabberId } from "../client/components/grabberDesigns.ts";
import { barControl, ConsoleWatch, OpSocket, openSceneGroup, pagePoint, pickOption, pickTool, readCamera, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Swipe a phone's bottom sheet down to close it, and the panel sheet up to
 * fill the screen (docs/design-v1-sheet-swipe.md section 9), on the real
 * server serving the production build, through Chromium's touch input in
 * contexts with `isMobile` and `hasTouch`. A slow drag spaces its moves by
 * 30 ms, about 0.3 px per ms, and a flick sends them back to back.
 *
 * Chromium's touch emulation is not iOS Safari: what the browser does with
 * a pan it starts itself is the part this run cannot prove (13).
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus eighteen, which it shares
 * with the areas run (areas.e2e.ts), since the runs go one after another.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 18;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-swipe-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let playerContext: BrowserContext;
let player: Page;
let playerCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E swipe ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thorn: { id: randomUUID(), characterId: randomUUID(), x: 4, y: 3 },
  goblins: [randomUUID(), randomUUID()],
  entries: { thorn: randomUUID(), goblins: [randomUUID(), randomUUID()] },
  bounds: { w: 30, h: 20 },
  labels: [randomUUID(), randomUUID()],
  pages: [randomUUID(), randomUUID(), randomUUID()],
  pin: randomUUID(),
};

type Pt = { x: number; y: number };
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
type El = {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): Rect;
  style: Record<string, string>;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  querySelector(s: string): El | null;
  closest(s: string): El | null;
};
type Doc = { querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; activeElement: El | null };
type Win = { document: Doc; innerHeight: number; innerWidth: number; history: { state: unknown }; getComputedStyle(el: El): Record<string, string> };

function actor(hp = 20) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** Sets the window and the interface size, then loads the room again. */
async function setUp(page: Page, view: { width: number; height: number; scale: number }): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await page.waitForTimeout(300);
    }
  }
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

let nextXCardAt = 0;

/** A dismissed card cannot reopen from a tap merged into its room's previous 10 s window. */
async function showXCard(): Promise<Locator> {
  const wait = nextXCardAt - performance.now();
  if (wait > 0) await sleep(Math.ceil(wait));
  const since = dmSocket.received.length;
  const sent = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
  assert.ok(sent.ok(), `the X-card answered ${sent.status()}`);
  // Start after the response, so the server's merge window has certainly ended before the next tap.
  nextXCardAt = performance.now() + 10_000;
  await waitFor("the X-card signal on the DM's room socket", () => dmSocket.received.slice(since).some((text) => (JSON.parse(text) as { t?: string }).t === "xcard") || null);
  const card = dm.getByRole("dialog", { name: "X-card", exact: true }).locator("section").first();
  await card.waitFor();
  return card;
}

function panelsButton(page: Page): Locator {
  return page.locator('nav[aria-label="Tools"] button[title="Panels"]');
}

/** Opens a panel as a sheet from the list of panels, and returns its dialog. */
async function openPanel(page: Page, name: string): Promise<Locator> {
  await panelsButton(page).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name, exact: true }).click();
  await page.locator(`section[aria-label="${name}"]`).waitFor();
  return sheetOf(page, name);
}

function sheetOf(page: Page, name: string): Locator {
  return page.locator(`dialog[data-rvtt-sheet][aria-label="${name}"]`);
}

async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height };
}

/** A box once it has held still for 300 ms: a panel loads its code and its content after its sheet opens. */
async function steadyRect(locator: Locator): Promise<Rect> {
  let last = await rectOf(locator);
  let still = 0;
  for (let i = 0; i < 60 && still < 300; i++) {
    await sleep(50);
    const next = await rectOf(locator);
    still = Math.abs(next.top - last.top) < 0.5 && Math.abs(next.bottom - last.bottom) < 0.5 ? still + 50 : 0;
    last = next;
  }
  return last;
}

/** The sheet's header as a point to press: its middle, clear of its buttons. */
async function headerPoint(sheet: Locator): Promise<Pt> {
  const r = await rectOf(sheet.locator("[data-sheet-grab]").first());
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A point in the sheet's body, `down` px below its top. */
async function bodyPoint(sheet: Locator, down = 40): Promise<Pt> {
  const r = await rectOf(sheet.locator("[data-pane-body]").first());
  return { x: r.left + r.width / 2, y: r.top + down };
}

const fingersDown = new Set<Finger>();

/**
 * One finger through the browser's touch input, as a phone sends it. Each
 * event carries its own time, since the page reads a flick from the
 * events' times and a dispatch through the protocol waits for the page's
 * answer to each move, which can take longer than a real finger's.
 */
class Finger {
  private at: Pt = { x: 0, y: 0 };
  /** The time of the last event sent, in seconds since the epoch. */
  private clock = 0;
  private readonly cdp: CDPSession;
  private readonly page: Page;
  constructor(cdp: CDPSession, page: Page) {
    this.cdp = cdp;
    this.page = page;
  }

  private stamp(afterMs: number): number {
    this.clock = Math.max(this.clock + afterMs / 1000, Date.now() / 1000 - 5);
    return this.clock;
  }

  async down(p: Pt): Promise<void> {
    this.at = p;
    this.clock = Date.now() / 1000;
    fingersDown.add(this);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y, id: 1 }], timestamp: this.clock });
  }

  /** Moves by `dy` (and `dx`) in steps of `step` px, `every` ms apart: 30 for a slow drag, 2 for a flick. */
  async drag(dy: number, opts: { dx?: number; step?: number; every?: number } = {}): Promise<void> {
    const step = opts.step ?? 10;
    const every = opts.every ?? 30;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dy), Math.abs(opts.dx ?? 0)) / step));
    const from = this.at;
    for (let i = 1; i <= n; i++) {
      if (every >= 10) await sleep(every);
      await this.moveTo({ x: from.x + ((opts.dx ?? 0) * i) / n, y: from.y + (dy * i) / n }, every);
    }
  }

  async moveTo(p: Pt, afterMs = 30): Promise<void> {
    this.at = p;
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x, y: p.y, id: 1 }], timestamp: this.stamp(afterMs) });
  }

  /** Rests still for `ms`, as the page's clock sees it. */
  async rest(ms: number): Promise<void> {
    await sleep(ms);
    this.stamp(ms);
  }

  /** A second finger lands at `p` and lifts, while this one stays down. */
  async second(p: Pt): Promise<void> {
    const me = { x: this.at.x, y: this.at.y, id: 1 };
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [me, { x: p.x, y: p.y, id: 2 }], timestamp: this.stamp(30) });
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [me], timestamp: this.stamp(30) });
  }

  /** Lifts, and waits until the page has heard it: the protocol's answer can come before the page has run its listeners. */
  async up(afterMs = 2): Promise<void> {
    const before = await lifts(this.page);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: this.stamp(afterMs) });
    fingersDown.delete(this);
    await waitFor("the page to hear the lift", async () => (await lifts(this.page)) > before || null, 3_000);
  }

  /** A failed assertion must not leave a touch held across the next test's navigation. */
  async cancel(): Promise<void> {
    try {
      await this.cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    } catch {
      // A closed page or session must not hide the test's original failure.
    } finally {
      fingersDown.delete(this);
    }
  }
}

/** Counts the lifts the page hears, from its window, before any listener of its own. */
function countLifts(): void {
  const g = globalThis as unknown as { __lifts: number; addEventListener(type: string, fn: () => void, opts: unknown): void };
  g.__lifts = 0;
  g.addEventListener("touchend", () => g.__lifts++, { capture: true, passive: true });
}

function lifts(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { __lifts?: number }).__lifts ?? 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A whole swipe: down at `from`, `dy` in 10 px steps (slow: 30 ms apart, flick: 2 ms), then up. */
async function swipe(cdp: CDPSession, from: Pt, dy: number, opts: { flick?: boolean; dx?: number; hold?: number } = {}, page: Page = dm): Promise<void> {
  const f = new Finger(cdp, page);
  await f.down(from);
  if (opts.hold) await f.rest(opts.hold);
  await f.drag(dy, { every: opts.flick ? 2 : 30, dx: opts.dx });
  await f.up();
}

/** The element's transform now, "" at rest. */
function transformOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => (el as unknown as El).style.transform ?? "");
}

/** Waits until a slide is over: the surface gone, or at rest with no transform. One read of the page, since the surface can go between two. */
async function settled(surface: Locator): Promise<"gone" | "rest"> {
  return waitFor(
    "the surface to settle",
    async () => {
      const shown = await surface.evaluateAll((els) =>
        els.filter((el) => (el as unknown as { getClientRects(): ArrayLike<unknown> }).getClientRects().length > 0).map((el) => (el as unknown as El).style.transform ?? ""),
      );
      if (shown.length === 0) return "gone" as const;
      return shown[0] === "" ? ("rest" as const) : null;
    },
    3_000,
  );
}

/*
 * A slow release settles on the nearest stand (docs/design-v1-sheet-swipe.md
 * 4.4): closed past half the way to fully off screen, full past half the way
 * up, never for less than one touch target. `off` is how far below its
 * normal top a surface is fully off screen: its height and what rides it.
 * The finger travels the slop (8 px down, 16 up) before the surface moves.
 */
function closePast(off: number, scale = 1): number {
  return 8 + Math.max(off / 2, 44 * scale) + 20;
}

/** Past a quarter of the way, short of half: a slow release there springs back. */
function closeShort(off: number, scale = 1): number {
  return 8 + Math.max(off / 2, 44 * scale) - 20;
}

/** Half the way between normal and full, `up` the normal top's distance from the screen's top: the step either way. */
function stepOf(up: number, scale = 1): number {
  return Math.max(up / 2, 44 * scale);
}

/** From full screen down past the normal top by half the way to the screen's foot, where the full sheet is fully off screen. */
function longFromFull(up: number, screen: number): number {
  return 8 + up + (screen - up) / 2 + 20;
}

/** The middle of an element, as a point to press. */
async function middleOf(locator: Locator): Promise<Pt> {
  const r = await rectOf(locator);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A sheet's body: how far it is scrolled. */
function bodyScroll(sheet: Locator): Promise<number> {
  return sheet.locator("[data-pane-body]").first().evaluate((el) => (el as unknown as El).scrollTop);
}

/** The toolbar's top edge on screen. */
async function toolbarTop(page: Page): Promise<number> {
  return (await rectOf(page.locator('nav[aria-label="Tools"]'))).top;
}

/** A point on the map above the sheet, clear of the bars, where a second finger lands. */
function mapPoint(): Pt {
  return { x: 40, y: 110 };
}

/** Records every move that reaches the page, and whether the page cancelled it, from a listener on the window that runs after the page's own. */
async function recordMoves(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __moves: boolean[]; __record?: boolean; addEventListener(t: string, fn: (e: { defaultPrevented: boolean }) => void, o: unknown): void };
    g.__moves = [];
    if (g.__record) return;
    g.__record = true;
    g.addEventListener("touchmove", (e) => g.__moves.push(e.defaultPrevented), { passive: true });
  });
}

function recordedMoves(page: Page): Promise<boolean[]> {
  return page.evaluate(() => (globalThis as unknown as { __moves: boolean[] }).__moves);
}

/** Counts the clicks an element hears from now on. */
async function countClicks(locator: Locator): Promise<() => Promise<number>> {
  const key = `__clicks${Math.random().toString(36).slice(2, 8)}`;
  await locator.evaluate((el, k) => {
    const g = globalThis as unknown as Record<string, number>;
    g[k] = 0;
    (el as unknown as { addEventListener(t: string, fn: () => void): void }).addEventListener("click", () => g[k]!++);
  }, key);
  return () => locator.page().evaluate((k) => (globalThis as unknown as Record<string, number>)[k] ?? 0, key);
}

/** A tap through the touch input with a few px of jitter on the way, as a thumb makes. */
async function jitterTap(cdp: CDPSession, page: Page, at: Pt, dys: readonly number[]): Promise<void> {
  const f = new Finger(cdp, page);
  await f.down(at);
  for (const dy of dys) await f.moveTo({ x: at.x, y: at.y + dy }, 16);
  await f.up(16);
}

/** The page point of a map cell's middle, from the camera Konva holds. */
async function cellPoint(page: Page, cell: { x: number; y: number }): Promise<Pt> {
  return pagePoint(page, run.bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
}

/** A tap through the touch input. */
async function touchTap(cdp: CDPSession, page: Page, at: Pt): Promise<void> {
  const f = new Finger(cdp, page);
  await f.down(at);
  await f.up(40);
}

describe("raccoon-vtt: swipe a phone's bottom sheet", { timeout: 1_500_000 }, () => {
  afterEach(async () => {
    for (const finger of fingersDown) await finger.cancel();
  });

  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    const phone = { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    dmContext = await browser.newContext(phone);
    await dmContext.addInitScript(countLifts);
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
    playerContext = await browser.newContext(phone);
    await playerContext.addInitScript(countLifts);
    player = await playerContext.newPage();
    playerConsole.attach(player);
    await playerSocket.attach(playerContext, player);
    playerCdp = await playerContext.newCDPSession(player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    if (run.roomId && dmContext) {
      try {
        const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
        if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("0. a DM's room on a phone, with Pat's Thorn, two goblins, two labels, two pages called Notes and a pin to the second", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: run.thorn.x, y: run.thorn.y, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    for (const [i, id] of run.goblins.entries()) await ops.send(token(id, { kind: "monster", name: `Goblin ${i + 1}`, x: 6 + i, y: 3, disposition: "hostile", actor: { inline: actor() } }));
    for (const [i, id] of run.labels.entries()) await ops.send({ t: "build.label", sceneId: run.sceneId, labelId: id, label: { x: 3.5 + 4 * i, y: 6.5, text: `Gate ${i + 1}`, size: 1 } });
    // Two pages with one title, the second behind a pin, and the first with a table wider than a phone.
    const table = ["| Name | Strength | Dexterity | Constitution | Intelligence | Wisdom | Charisma |", "|---|---|---|---|---|---|---|", "| Goblin of the Long Road | 8 | 14 | 10 | 10 | 8 | 8 |"].join("\n");
    await ops.send({ t: "journal.create", page: { id: run.pages[0], title: "Notes", access: "all", blocks: [{ id: "notesblock01", text: "The first page." }] } });
    await ops.send({ t: "journal.create", page: { id: run.pages[1], title: "Notes", access: "all", blocks: [{ id: "notesblock02", text: "The second page." }] } });
    await ops.send({ t: "journal.create", page: { id: run.pages[2], title: "Stats", access: "all", blocks: [{ id: "statsblock01", text: table }] } });
    await ops.send({ t: "pin.put", pin: { id: run.pin, sceneId: run.sceneId, x: 10.5, y: 3.5, color: "#f7df00", label: "Well", pageId: run.pages[1], visibility: "all" } });
    await waitFor("the room's parts in the DM's view", () => (run.goblins.every((id) => dmSocket.state?.tokens[id]) && dmSocket.state?.pins[run.pin] ? true : null));
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("1. the panel sheet: a slow header drag past half closes it as Close does, past a quarter but short of half springs back", async () => {
    for (const view of [
      { width: 375, height: 667, scale: 1 },
      { width: 375, height: 667, scale: 1.3 },
      { width: 390, height: 844, scale: 1 },
      { width: 390, height: 844, scale: 1.3 },
      { width: 768, height: 1024, scale: 1 },
    ]) {
      const where = `${view.width} x ${view.height} at ${view.scale * 100}%`;
      await setUp(dm, view);
      const sheet = await openPanel(dm, "Log");
      const before = await steadyRect(sheet);
      const from = await headerPoint(sheet);
      if (view.width === 375) {
        // Held mid-drag, for the screenshots: the sheet follows the finger down.
        const held = new Finger(dmCdp, dm);
        await held.down(from);
        await held.drag(80);
        await waitFor(`${where}: the drag to show`, async () => ((await transformOf(sheet)) !== "" ? true : null), 3_000);
        await shots.take(dm, `swipe-mid-drag-${view.width}x${view.height}-${view.scale * 100}`);
        await held.drag(-80);
        await held.up();
        assert.equal(await settled(sheet), "rest");
      }
      // Past a quarter, short of half: springs back, and at rest no transform is left.
      assert.ok(closeShort(before.height, view.scale) - 8 > before.height / 4);
      await swipe(dmCdp, from, closeShort(before.height, view.scale));
      assert.equal(await settled(sheet), "rest", `${where}: a slow drag short of half closed the sheet`);
      assert.deepEqual(await rectOf(sheet), before, `${where}: the sheet is not back in its place`);
      const overlay = await dm.evaluate(() => (globalThis as unknown as Win).history.state);
      // Past half: closes after its slide, with the Back entry gone as after Close.
      await swipe(dmCdp, from, closePast(before.height, view.scale));
      assert.equal(await settled(sheet), "gone", `${where}: a slow drag past half left the sheet open`);
      const state = await dm.evaluate(() => (globalThis as unknown as Win).history.state);
      assert.notDeepEqual(state, overlay, `${where}: the overlay's Back entry is still there`);
      const inClosed = await dm.evaluate(() => (globalThis as unknown as Win).document.activeElement?.closest("dialog") != null);
      assert.equal(inClosed, false, `${where}: focus stayed in a closed sheet`);
    }
  });

  test("2. content at its top: a slow drag past the distance and a flick close it, scrolled content scrolls, and a drag up scrolls", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const button = (sheet: Locator) => sheet.getByRole("button", { name: "Paste a stat block" });
    let sheet = await openPanel(dm, "Monsters");
    const rest = await steadyRect(sheet);
    await swipe(dmCdp, await middleOf(button(sheet)), closePast(rest.height));
    assert.equal(await settled(sheet), "gone", "a slow content drag past half");
    sheet = await openPanel(dm, "Monsters");
    await steadyRect(sheet);
    await swipe(dmCdp, await middleOf(button(sheet)), 60, { flick: true });
    assert.equal(await settled(sheet), "gone", "a flick in content at its top");
    // Scrolled: a drag down scrolls the list back and the sheet stays.
    sheet = await openPanel(dm, "Monsters");
    await steadyRect(sheet);
    await sheet.locator("[data-pane-body]").first().evaluate((el) => ((el as unknown as El).scrollTop = 400));
    const body = await rectOf(sheet.locator("[data-pane-body]").first());
    await swipe(dmCdp, { x: body.left + body.width / 2, y: body.top + 60 }, 160);
    assert.equal(await settled(sheet), "rest");
    assert.ok((await bodyScroll(sheet)) < 400, "the scrolled list did not scroll back");
    assert.deepEqual(await rectOf(sheet), rest, "the sheet moved while its content scrolled");
    // At its top, a drag up scrolls the content.
    await sheet.locator("[data-pane-body]").first().evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await swipe(dmCdp, { x: body.left + body.width / 2, y: body.top + 200 }, -120);
    assert.equal(await settled(sheet), "rest");
    assert.ok((await bodyScroll(sheet)) > 0, "a drag up at the top did not scroll the content");
    assert.deepEqual(await rectOf(sheet), rest);
    await sheet.getByRole("button", { name: "Close Monsters" }).click();
    // The Panels list closes the same way.
    await panelsButton(dm).click();
    const list = sheetOf(dm, "Panels");
    const r = await steadyRect(list);
    await swipe(dmCdp, await headerPoint(list), closePast(r.height));
    assert.equal(await settled(list), "gone", "the Panels list stayed");
  });

  test("3. taps stay the browser's: 2, 4 and 6 px of jitter cancel no move, and Close and a checkbox each act once", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    await recordMoves(dm);
    let sheet = await openPanel(dm, "Log");
    await steadyRect(sheet);
    const close = sheet.getByRole("button", { name: "Close Log" });
    const closes = await countClicks(close);
    await jitterTap(dmCdp, dm, await middleOf(close), [2, 4, 6]);
    assert.equal(await settled(sheet), "gone", "Close did not close");
    assert.equal(await closes(), 1);
    assert.ok((await recordedMoves(dm)).every((cancelled) => !cancelled), "a move inside the slop was cancelled");
    sheet = await openPanel(dm, "Log");
    await steadyRect(sheet);
    await recordMoves(dm);
    const box = sheet.locator('input[type="checkbox"]').first();
    const was = await box.isChecked();
    const clicks = await countClicks(box);
    await jitterTap(dmCdp, dm, await middleOf(box), [2, 4, 6]);
    await waitFor("the checkbox to flip", async () => (await box.isChecked()) !== was || null, 3_000);
    assert.equal(await clicks(), 1, "the checkbox heard more or less than one click");
    assert.ok((await recordedMoves(dm)).every((cancelled) => !cancelled));
    await jitterTap(dmCdp, dm, await middleOf(box), []);
    await waitFor("the checkbox back", async () => (await box.isChecked()) === was || null, 3_000);
    await sheet.getByRole("button", { name: "Close Log" }).click();
  });

  test("4. what owns its touches keeps them: a sideways table, the tracker's handle, a slider, and a focused field", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    // A Markdown table scrolls sideways under a sideways drag, and the sheet stays.
    let sheet = await openPanel(dm, "Journal");
    const toList = sheet.getByRole("button", { name: /^Back to Journal/ });
    if ((await toList.count()) > 0) await toList.click();
    await sheet.getByRole("button", { name: /^Stats/ }).first().click();
    const table = sheet.locator("table").first();
    await table.waitFor();
    const rest = await steadyRect(sheet);
    const start = await middleOf(table);
    // The table's own row scrolls, and nothing above it does.
    const sideways = () => table.evaluate((el) => {
      const lefts: number[] = [];
      for (let e = (el as unknown as { parentElement: unknown }).parentElement as { scrollLeft: number; parentElement: unknown } | null; e; e = e.parentElement as typeof e) lefts.push(e.scrollLeft);
      return lefts;
    });
    await swipe(dmCdp, start, 4, { dx: -160 });
    assert.equal(await settled(sheet), "rest");
    const lefts = await sideways();
    assert.ok(lefts[0]! > 0 && lefts.slice(1).every((l) => l === 0), `the table's own row did not scroll sideways alone: ${lefts.join(", ")}`);
    assert.deepEqual(await rectOf(sheet), rest);
    await sheet.getByRole("button", { name: "Close Journal" }).click();

    // The tracker's handle reorders tied rows, and the sheet stays.
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.entries.goblins[0], tokenId: run.goblins[0], value: 12 },
        { id: run.entries.goblins[1], tokenId: run.goblins[1], value: 12 },
        { id: run.entries.thorn, tokenId: run.thorn.id, value: 5 },
      ],
    });
    sheet = await openPanel(dm, "Initiative");
    const handle = sheet.getByRole("button", { name: /^Drag to reorder .* within its tie$/ }).first();
    await handle.waitFor();
    await steadyRect(sheet);
    const order = () => dmSocket.state?.encounter?.entries.map((e) => e.id) ?? [];
    const before = order();
    const from = await middleOf(handle);
    const f = new Finger(dmCdp, dm);
    await f.down(from);
    await f.rest(60);
    await f.drag(80, { step: 8, every: 30 });
    await f.up();
    await waitFor("the tied goblins to swap", () => (order()[0] === before[1] && order()[1] === before[0] ? true : null), 5_000);
    assert.equal(await settled(sheet), "rest", "the sheet moved under the handle");
    await sheet.getByRole("button", { name: "Close Initiative" }).click();
    await ops.send({ t: "encounter.end" });

    // The Scenes panel's slider moves under a sideways drag. The grid's sliders and the scene's size sit in groups a phone starts folded.
    sheet = await openPanel(dm, "Scenes");
    await openSceneGroup(sheet, "Map image and grid");
    await openSceneGroup(sheet, "Size and view");
    await steadyRect(sheet);
    const slider = sheet.locator('input[type="range"]').first();
    await slider.scrollIntoViewIfNeeded();
    const value = await slider.inputValue();
    const r = await rectOf(slider);
    await swipe(dmCdp, { x: r.left + r.width * 0.2, y: r.top + r.height / 2 }, 0, { dx: r.width * 0.5 });
    await waitFor("the slider to move", async () => ((await slider.inputValue()) !== value ? true : null), 3_000);
    assert.equal(await settled(sheet), "rest");
    // A focused field that saves on blur, changed: a header drag springs back. Put back as it was, it closes.
    const across = sheet.getByLabel("Squares across");
    await across.scrollIntoViewIfNeeded();
    const was = await across.inputValue();
    await across.focus();
    await dm.keyboard.press("End");
    await dm.keyboard.type("5");
    const h = await steadyRect(sheet);
    await swipe(dmCdp, await headerPoint(sheet), closePast(h.height));
    assert.equal(await settled(sheet), "rest", "a changed field let the swipe close the sheet");
    assert.equal(await across.inputValue(), `${was}5`, "the typed value was lost");
    await across.fill(was);
    await across.blur();
    await sheet.getByRole("button", { name: "Close Scenes" }).click();

    // A focused field with nothing typed: a content drag is the browser's, a header drag closes.
    sheet = await openPanel(dm, "Log");
    const log = await steadyRect(sheet);
    const message = sheet.getByLabel("Message");
    await message.focus();
    await swipe(dmCdp, await middleOf(sheet.getByRole("button", { name: "Export" })), closePast(log.height));
    assert.equal(await settled(sheet), "rest", "a content drag moved the sheet while a field took typing");
    await swipe(dmCdp, await headerPoint(sheet), closePast(log.height));
    assert.equal(await settled(sheet), "gone", "a header drag with nothing typed left the sheet open");
  });

  test("5. a second finger on the map while the first rests past the distance springs it back, and a held press is never a swipe", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    let sheet = await openPanel(dm, "Log");
    const rest = await steadyRect(sheet);
    const f = new Finger(dmCdp, dm);
    await f.down(await headerPoint(sheet));
    await f.drag(closePast(rest.height) + 20);
    await f.rest(100);
    assert.notEqual(await sheet.getAttribute("data-sheet-held"), null, "FU39-B: the first finger holds the sheet");
    await f.second(mapPoint());
    await waitFor("FU39-B: the second finger to release the sheet", async () => ((await sheet.getAttribute("data-sheet-held")) === null ? true : null), 3_000);
    assert.equal(await sheet.getAttribute("data-sheet-held"), null, "FU39-B: the second finger releases the glow before the first finger lifts");
    await f.up(100);
    assert.equal(await settled(sheet), "rest", "a second finger did not cancel the swipe");
    assert.deepEqual(await rectOf(sheet), rest);
    await sheet.getByRole("button", { name: "Close Log" }).click();
    sheet = await openPanel(dm, "Monsters");
    const monsters = await steadyRect(sheet);
    await swipe(dmCdp, await middleOf(sheet.getByRole("button", { name: "Paste a stat block" })), closePast(monsters.height) + 20, { hold: 500 });
    assert.equal(await settled(sheet), "rest", "a held press swiped the sheet");
    assert.deepEqual(await rectOf(sheet), monsters);
    await sheet.getByRole("button", { name: "Close Monsters" }).click();
  });

  test("6. unsaved input springs back with what was typed kept, and with nothing typed each closes", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const far = (r: Rect) => closePast(r.height) + 10;
    // A half-typed Log message, blurred.
    let sheet = await openPanel(dm, "Log");
    let r = await steadyRect(sheet);
    await sheet.getByLabel("Message").fill("half a thought");
    await sheet.getByLabel("Message").blur();
    await swipe(dmCdp, await headerPoint(sheet), far(r));
    assert.equal(await settled(sheet), "rest", "a half-typed message let the sheet close");
    assert.equal(await sheet.getByLabel("Message").inputValue(), "half a thought");
    await sheet.getByLabel("Message").fill("");
    await sheet.getByLabel("Message").blur();
    await swipe(dmCdp, await headerPoint(sheet), far(r));
    assert.equal(await settled(sheet), "gone", "an empty composer kept the sheet open");

    // A typed dice formula, blurred: only Roll sends it.
    sheet = await openPanel(dm, "Dice");
    r = await steadyRect(sheet);
    const formula = sheet.getByLabel("Dice formula", { exact: true });
    await formula.fill("2d6+3");
    await formula.blur();
    await swipe(dmCdp, await headerPoint(sheet), far(r));
    assert.equal(await settled(sheet), "rest", "a typed formula let the sheet close");
    assert.equal(await formula.inputValue(), "2d6+3");
    await formula.fill("");
    await formula.blur();
    await swipe(dmCdp, await headerPoint(sheet), far(r));
    assert.equal(await settled(sheet), "gone", "an empty formula field kept the sheet open");

    // A changed encounter: springs back, and its Back still asks.
    sheet = await openPanel(dm, "Encounters");
    await sheet.getByRole("button", { name: "New encounter" }).click();
    const name = sheet.getByLabel("Encounter name");
    await name.fill("Ambush");
    await name.blur();
    r = await steadyRect(sheet);
    await swipe(dmCdp, await headerPoint(sheet), far(r));
    assert.equal(await settled(sheet), "rest", "a changed encounter let the sheet close");
    assert.equal(await name.inputValue(), "Ambush");
    await sheet.getByRole("button", { name: /^Back to Encounters/ }).click();
    await sheet.getByRole("button", { name: "Discard changes?" }).waitFor();
    await sheet.getByRole("button", { name: "Discard changes?" }).click();
    await sheet.getByRole("button", { name: "New encounter" }).click();
    await name.waitFor();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "gone", "an untouched new encounter kept the sheet open");

    // A companion being added, a field changed and blurred.
    sheet = await openPanel(dm, "Characters");
    await sheet.getByRole("button", { name: /Thorn/ }).first().click();
    const add = sheet.getByRole("button", { name: /^Add a companion/ }).first();
    await add.scrollIntoViewIfNeeded();
    await add.click();
    const companion = sheet.getByLabel("Name", { exact: true }).first();
    await companion.waitFor();
    await companion.fill("Ash the wolf");
    await companion.blur();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "rest", "a companion being added let the sheet close");
    assert.equal(await companion.inputValue(), "Ash the wolf");
    // Typed, Cancel asks before it throws the name away (docs/design-v1-look-pass.md 3.1).
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.getByRole("button", { name: "Discard changes?" }).last().click();
    await add.click();
    await companion.waitFor();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "gone", "an untouched companion form kept the sheet open");

    // Request a roll with its DC typed, asked of the party, since Roll took its place on the DM's single bar (docs/design-v1-roll-options.md 4.5).
    // The party's Ask is in its dock where that shows, else in the Party panel, whose place the request's sheet takes on a phone.
    const askParty = async () => {
      const shown = dm.getByRole("button", { name: "Ask the party" }).filter({ visible: true });
      if ((await shown.count()) === 0) {
        await panelsButton(dm).click();
        await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Party", exact: true }).click();
      }
      await shown.first().click();
    };
    await askParty();
    let ask = dm.getByRole("dialog", { name: "Request a roll" }).locator("section").first();
    await ask.waitFor();
    await ask.getByLabel(/^DC/).fill("13");
    await ask.getByLabel(/^DC/).blur();
    await swipe(dmCdp, await headerPoint(ask), far(await steadyRect(ask)));
    assert.equal(await settled(ask), "rest", "a changed request let the sheet close");
    assert.equal(await ask.getByLabel(/^DC/).inputValue(), "13");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await askParty();
    ask = dm.getByRole("dialog", { name: "Request a roll" }).locator("section").first();
    await ask.waitFor();
    await swipe(dmCdp, await headerPoint(ask), far(await steadyRect(ask)));
    assert.equal(await settled(ask), "gone", "an untouched request kept its sheet open");

    // A typed label.
    const pane = await openLabel(0);
    await pane.getByLabel("Label text").fill("Gate of bones");
    await pane.getByLabel("Label text").blur();
    await swipe(dmCdp, await headerPoint(pane), far(await steadyRect(pane)));
    assert.equal(await settled(pane), "rest", "a typed label let its pane close");
    assert.equal(await pane.getByLabel("Label text").inputValue(), "Gate of bones");
    await pane.getByLabel("Label text").fill("Gate 1");
    await pane.getByLabel("Label text").blur();
    await swipe(dmCdp, await headerPoint(pane), far(await steadyRect(pane)));
    assert.equal(await settled(pane), "gone", "an unchanged label kept its pane open");
    await pickTool(dm, "Select");

    // A select-only draft: Make a companion's Belongs to, on a goblin's Token panel.
    await touchTap(dmCdp, dm, await cellPoint(dm, { x: 6, y: 3 }));
    await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
    sheet = await openPanel(dm, "Token");
    const settings = sheet.getByRole("button", { name: /^Token settings/ });
    if ((await settings.getAttribute("aria-expanded")) === "false") await settings.click();
    const make = sheet.getByRole("button", { name: "Make a companion" });
    await make.scrollIntoViewIfNeeded();
    await make.click();
    const belongs = sheet.getByLabel("Belongs to");
    await belongs.selectOption({ label: "Thorn" });
    await belongs.blur();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "rest", "a companion's owner chosen let the sheet close");
    assert.equal(await belongs.locator("option:checked").textContent(), "Thorn");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "gone", "the companion form put away kept the sheet open");

    // A blurred text draft: a player password typed over the suggestion. A new suggestion is a new start.
    sheet = await openPanel(dm, "Menu");
    await sheet.getByRole("button", { name: /^Members/ }).click();
    const password = sheet.getByLabel("New player password");
    await password.waitFor();
    await password.fill("a password typed here");
    await password.blur();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "rest", "a typed password let the sheet close");
    assert.equal(await password.inputValue(), "a password typed here");
    await sheet.getByRole("button", { name: "Suggest another password" }).click();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "gone", "a fresh suggestion kept the sheet open");
  });

  test("lp1-swipe-a. a number typed into New character or Add a companion and still focused springs a header swipe back, with the number kept", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const far = (r: Rect) => closePast(r.height) + 10;
    const sheet = await openPanel(dm, "Characters");
    const asks = sheet.getByRole("button", { name: "Discard changes?" });
    // New character: Max HP typed, never blurred, so only the field holds it.
    await sheet.getByRole("button", { name: "New character", exact: true }).click();
    const maxHp = sheet.getByLabel("Max HP", { exact: true });
    await maxHp.fill("20");
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "rest", "a number being typed let the sheet close");
    assert.equal(await maxHp.inputValue(), "20", "the number typed was lost");
    await sheet.getByRole("button", { name: "Back to Characters" }).click();
    await asks.first().click();
    // Add a companion: HP typed, never blurred.
    await sheet.getByRole("button", { name: /Thorn/ }).first().click();
    const add = sheet.getByRole("button", { name: /^Add a companion/ }).first();
    await add.scrollIntoViewIfNeeded();
    await add.click();
    const hp = sheet.getByLabel("HP", { exact: true });
    await hp.fill("7");
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "rest", "a companion's HP being typed let the sheet close");
    assert.equal(await hp.inputValue(), "7", "the HP typed was lost");
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await asks.last().click();
    await add.waitFor();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "gone", "Thorn's page with nothing typed kept the sheet open");
  });

  test("7. a dialog sheet over a panel closes alone, the X-card dismisses, and from 600 px a dialog's card does not swipe", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const sheet = await openPanel(dm, "Monsters");
    await steadyRect(sheet);
    const opener = sheet.getByRole("button", { name: "Filters" });
    await opener.click();
    const filters = dm.getByRole("dialog", { name: "Monster filters" }).locator("section").first();
    await filters.waitFor();
    await swipe(dmCdp, await headerPoint(filters), closePast((await steadyRect(filters)).height));
    assert.equal(await settled(filters), "gone", "the filters stayed");
    assert.ok(await sheet.isVisible(), "the Monsters panel closed with its filters");
    await waitFor("focus back on Filters", async () => (await opener.evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El))) || null, 3_000);
    await sheet.getByRole("button", { name: "Close Monsters" }).click();

    // The X-card, which has no header: a drag down on the card dismisses it.
    const card = await showXCard();
    const c = await steadyRect(card);
    await swipe(dmCdp, { x: c.left + c.width / 2, y: c.top + 30 }, closePast(c.height));
    assert.equal(await settled(card), "gone", "the X-card stayed");

    // At 768 x 1024 a dialog is a card in the middle, and a drag on it does nothing.
    await setUp(dm, { width: 768, height: 1024, scale: 1 });
    const wide = await openPanel(dm, "Monsters");
    await wide.getByRole("button", { name: "Filters" }).click();
    const middle = dm.getByRole("dialog", { name: "Monster filters" }).locator("section").first();
    await middle.waitFor();
    const m = await steadyRect(middle);
    assert.equal(await middle.locator("[data-sheet-grab]").count(), 0, "a card in the middle has a grab area");
    await swipe(dmCdp, await middleOf(middle.locator("header").first()), 200);
    assert.equal(await settled(middle), "rest");
    assert.deepEqual(await rectOf(middle), m, "a card in the middle moved");
    await middle.getByRole("button", { name: /^Close/ }).click();
  });

  test("8. sideways at 844 x 390 and in the very short mode at 480 x 320 a header drag does nothing", async () => {
    for (const view of [
      { width: 844, height: 390, scale: 1 },
      { width: 480, height: 320, scale: 1.3 },
    ]) {
      await setUp(dm, view);
      const sheet = await openPanel(dm, "Log");
      const rest = await steadyRect(sheet);
      assert.equal(await sheet.locator("[data-sheet-grab]").count(), 0, `${view.width} x ${view.height}: a sheet that does not swipe has a grab area`);
      await swipe(dmCdp, await middleOf(sheet.locator("header").first()), 150);
      assert.equal(await settled(sheet), "rest", `${view.width} x ${view.height}: a sideways sheet closed`);
      assert.deepEqual(await rectOf(sheet), rest);
      await sheet.getByRole("button", { name: "Close Log" }).click();
    }
  });

  test("9. the dock rides the sheet and its slide ends under the toolbar, and a roll card on Multi-select's bar slides past the screen's foot and folds with its total kept", async () => {
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.entries.goblins[0], tokenId: run.goblins[0], value: 18 },
        { id: run.entries.thorn, tokenId: run.thorn.id, value: 15 },
      ],
    });
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    await touchTap(dmCdp, dm, await cellPoint(dm, { x: 6, y: 3 }));
    await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
    const sheet = await openPanel(dm, "Log");
    const dock = dm.locator("[data-rvtt-dock]");
    await dock.waitFor();
    const rest = await steadyRect(sheet);
    const dockRest = await rectOf(dock);
    const f = new Finger(dmCdp, dm);
    await f.down(await headerPoint(sheet));
    await f.drag(60);
    await waitFor("the drag to show", async () => ((await transformOf(sheet)) !== "" ? true : null), 3_000);
    const held = { sheet: await rectOf(sheet), dock: await rectOf(dock) };
    assert.ok(Math.abs(held.sheet.top - rest.top - (held.dock.top - dockRest.top)) < 1, `the dock did not ride the sheet: ${JSON.stringify({ rest, dockRest, held })}`);
    assert.ok(held.sheet.top > rest.top + 20);
    // Fully off screen once the dock above the sheet is too.
    await f.drag(closePast(rest.bottom - dockRest.top) - 60);
    await f.up();
    const to = Number(await sheet.getAttribute("data-sheet-swipe-to"));
    const foot = await toolbarTop(dm);
    assert.ok(rest.top + to >= foot - 0.5 && dockRest.top + to >= foot - 0.5, `the slide ends with the sheet or the dock above the toolbar: ${JSON.stringify({ to, rest, dockRest, foot })}`);
    assert.equal(await settled(sheet), "gone");
    await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor({ state: "visible" });
    await shots.take(dm, "swipe-dock-after-close");

    // The roll card standing on Multi-select's bar, a total typed.
    await setUp(player, { width: 375, height: 667, scale: 1 });
    await touchTap(playerCdp, player, await cellPoint(player, run.thorn));
    // Thorn's strip has no room for Multi-select after his HP entry, so it is behind Expand.
    await (await barControl(player.getByRole("dialog", { name: "Thorn actions" }), "Multi-select")).tap();
    const request = randomUUID();
    await ops.send({ t: "roll.ask", request: { id: request, test: { kind: "save", choices: [{ ability: "con" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    const card = player.getByRole("dialog", { name: "The DM asks for a roll" });
    // With its roll row the card no longer fits over Thorn's bar, so it starts folded behind Roll asked, whose tap brings it up on Multi-select's bar (docs/design-v1-roll-request.md 5.7).
    const asked = player.getByRole("button", { name: /^Roll asked/ });
    await asked.or(card).first().waitFor();
    if (await card.isHidden()) await asked.tap();
    await card.waitFor();
    const total = card.getByRole("textbox").first();
    await total.fill("14");
    await total.blur();
    const cardRest = await steadyRect(card);
    await player.getByRole("toolbar", { name: /options$/ }).first().waitFor();
    assert.ok(cardRest.bottom < (await toolbarTop(player)) - 20, `the card does not stand on Multi-select's bar: ${JSON.stringify(cardRest)}`);
    const g = new Finger(playerCdp, player);
    await g.down(await headerPoint(card));
    // Drawn over everything, it is fully off screen at the screen's foot.
    await g.drag(closePast((await player.evaluate(() => (globalThis as unknown as Win).innerHeight)) - cardRest.top));
    await g.up();
    const slide = Number(await card.getAttribute("data-sheet-swipe-to"));
    const screen = await player.evaluate(() => (globalThis as unknown as Win).innerHeight);
    assert.ok(cardRest.top + slide >= screen - 0.5, `the card's slide stops above the screen's foot: ${JSON.stringify({ cardRest, slide, screen })}`);
    assert.equal(await settled(card), "gone", "the card did not fold");
    const chip = player.getByRole("button", { name: /^CON save/ }).first();
    await chip.waitFor();
    await chip.click();
    await card.waitFor();
    assert.equal(await card.getByRole("textbox").first().inputValue(), "14", "the total typed was lost");
    await shots.take(player, "swipe-roll-card-back");
    await ops.send({ t: "roll.close", rollIds: [request] });
    await ops.send({ t: "encounter.end" });
  });

  test("10. the label pane swipes by its header on a phone and beside the side panel, a pane or a page that replaces the closing one stays, and a rename mid-drag still closes", async () => {
    for (const view of [
      { width: 375, height: 667, scale: 1 },
      { width: 940, height: 800, scale: 1 },
    ]) {
      await setUp(dm, view);
      if (view.width > 900) await dm.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.sidePanel", "shown"));
      const pane = await openLabel(0);
      const r = await steadyRect(pane);
      await swipe(dmCdp, await headerPoint(pane), closePast(r.height));
      assert.equal(await settled(pane), "gone", `${view.width} x ${view.height}: the label pane stayed`);
    }
    // A second label tapped during the closing slide: its pane stays open.
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const first = await openLabel(0);
    const r = await steadyRect(first);
    const second = await cellPoint(dm, { x: 7, y: 6 });
    await swipe(dmCdp, await headerPoint(first), closePast(r.height));
    await touchTap(dmCdp, dm, second);
    await dm.getByRole("dialog", { name: "Edit label" }).getByLabel("Label text").and(dm.locator('[value="Gate 2"]')).waitFor();
    await sleep(400);
    assert.equal(await dm.getByRole("dialog", { name: "Edit label" }).getByLabel("Label text").inputValue(), "Gate 2", "the second label's pane closed with the first's slide");
    await dm.getByRole("dialog", { name: "Edit label" }).getByRole("button", { name: "Close without saving" }).click();
    await pickTool(dm, "Select");

    // A journal page swiped closed, and the other page called Notes opened from its pin during the slide: the new page stays.
    let sheet = await openPanel(dm, "Journal");
    await openNotes(sheet, "The first page.");
    const page = await steadyRect(sheet);
    const pin = await pagePoint(dm, run.bounds, { x: 10.5, y: 3.5 });
    await swipe(dmCdp, await headerPoint(sheet), closePast(page.height));
    await touchTap(dmCdp, dm, { x: pin.x, y: pin.y - 14 });
    await sheet.getByText("The second page.").waitFor();
    await sleep(400);
    assert.ok(await sheet.isVisible(), "the page the pin opened closed with the first page's slide");
    await sheet.getByRole("button", { name: "Close Journal" }).click();

    // The same page renamed from another device mid-drag: the drag closes it as usual.
    sheet = await openPanel(dm, "Journal");
    await openNotes(sheet, "The first page.");
    const opened = await steadyRect(sheet);
    const f = new Finger(dmCdp, dm);
    await f.down(await headerPoint(sheet));
    await f.drag(40);
    await ops.send({ t: "journal.update", pageId: run.pages[0], patch: { title: "Old notes" } });
    await sheet.getByRole("heading", { name: "Old notes" }).waitFor();
    await f.drag(closePast(opened.height) - 40);
    await f.up();
    assert.equal(await settled(sheet), "gone", "a rename mid-drag kept the page open");
    await ops.send({ t: "journal.update", pageId: run.pages[0], patch: { title: "Notes" } });
  });

  test("11. with reduced motion the sheet is gone within a frame of the lift", async () => {
    await dm.emulateMedia({ reducedMotion: "reduce" });
    try {
      await setUp(dm, { width: 375, height: 667, scale: 1 });
      const sheet = await openPanel(dm, "Log");
      const r = await steadyRect(sheet);
      await swipe(dmCdp, await headerPoint(sheet), closePast(r.height));
      await dm.evaluate(() => new Promise((resolve) => (globalThis as unknown as { requestAnimationFrame(fn: () => void): void }).requestAnimationFrame(() => resolve(null))));
      assert.equal(await sheet.count(), 0, "the sheet still showed a frame after the lift");
    } finally {
      await dm.emulateMedia({ reducedMotion: "no-preference" });
    }
  });

  test("12. full screen: a header drag up past a quarter fills the screen, and from there a short swipe down steps down, a long one or a flick closes", async () => {
    for (const view of [
      { width: 375, height: 667, scale: 1 },
      { width: 375, height: 667, scale: 1.3 },
      { width: 390, height: 844, scale: 1 },
      { width: 390, height: 844, scale: 1.3 },
    ]) {
      const where = `${view.width} x ${view.height} at ${view.scale * 100}%`;
      await setUp(dm, view);
      let sheet = await openPanel(dm, "Log");
      const normal = await steadyRect(sheet);
      const up = normal.top;
      const step = stepOf(up, view.scale);
      const fullScreen = sheet.getByRole("button", { name: "Expand sheet" });
      assert.equal(await fullScreen.getAttribute("aria-pressed"), "false");
      // Short of half the way up: back to normal.
      await swipe(dmCdp, await headerPoint(sheet), -(16 + step - 12));
      assert.equal(await settled(sheet), "rest");
      assert.deepEqual(await rectOf(sheet), normal, `${where}: a short drag up moved the sheet`);
      // Past it: the whole screen, modal, the room behind inert.
      await swipe(dmCdp, await headerPoint(sheet), -(16 + step + 12));
      await waitFor(`${where}: the sheet to fill the screen`, async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
      assert.equal(await settled(sheet), "rest");
      const filled = await rectOf(sheet);
      assert.deepEqual([filled.top, filled.height], [0, view.height], `${where}: the full sheet does not span the screen`);
      assert.equal(await fullScreen.getAttribute("aria-pressed"), "true");
      assert.equal(await sheet.evaluate((el) => (el as unknown as { matches(s: string): boolean }).matches(":modal")), true, `${where}: the full sheet is not modal, so the room behind is not inert`);
      await shots.take(dm, `swipe-full-${view.width}x${view.height}-${view.scale * 100}`);
      // A short swipe down: the normal height.
      await swipe(dmCdp, await headerPoint(sheet), 8 + step + 12);
      await waitFor(`${where}: the sheet to step down`, async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
      assert.equal(await settled(sheet), "rest");
      assert.deepEqual(await steadyRect(sheet), normal, `${where}: stepped down to another height`);
      // Up again, then a long swipe down closes it.
      await swipe(dmCdp, await headerPoint(sheet), -(16 + step + 12));
      await waitFor(`${where}: full again`, async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
      await settled(sheet);
      // A slow drag well past normal, short of halfway to closed, settles at normal.
      await swipe(dmCdp, await headerPoint(sheet), longFromFull(up, view.height) - 60);
      await waitFor(`${where}: the slow drag to settle at normal`, async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
      assert.equal(await settled(sheet), "rest", `${where}: a slow drag short of half from full closed the sheet`);
      assert.deepEqual(await steadyRect(sheet), normal);
      await swipe(dmCdp, await headerPoint(sheet), -(16 + step + 12));
      await waitFor(`${where}: full again`, async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
      await settled(sheet);
      await swipe(dmCdp, await headerPoint(sheet), longFromFull(up, view.height));
      assert.equal(await settled(sheet), "gone", `${where}: a long swipe from full left it open`);
      // Opened again: its normal height. Then up, and a flick down closes it.
      sheet = await openPanel(dm, "Log");
      assert.deepEqual(await steadyRect(sheet), normal, `${where}: full screen was remembered`);
      await swipe(dmCdp, await headerPoint(sheet), -(16 + step + 12));
      await waitFor(`${where}: full again`, async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
      await settled(sheet);
      await swipe(dmCdp, await headerPoint(sheet), 60, { flick: true });
      assert.equal(await settled(sheet), "gone", `${where}: a flick from full left it open`);
    }
  });

  test("12b. full screen: a flick up fills it, unsaved input stops a long swipe at normal, content drags up scroll, and a turn sideways and back keeps it", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    // A flick up fills it.
    let sheet = await openPanel(dm, "Log");
    const normal = await steadyRect(sheet);
    await swipe(dmCdp, await headerPoint(sheet), -40, { flick: true });
    await waitFor("a flick up to fill the screen", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    await settled(sheet);
    // A typed Log message: a long swipe from full stops at normal.
    await sheet.getByLabel("Message").fill("still typing");
    await sheet.getByLabel("Message").blur();
    await swipe(dmCdp, await headerPoint(sheet), longFromFull(normal.top, 667) + 10);
    await waitFor("the long swipe to stop at normal", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    assert.equal(await settled(sheet), "rest");
    assert.equal(await sheet.getByLabel("Message").inputValue(), "still typing");
    await sheet.getByLabel("Message").fill("");
    await sheet.getByRole("button", { name: "Close Log" }).click();

    // Content drags up scroll, normal and full, and the sheet does not rise.
    sheet = await openPanel(dm, "Monsters");
    const monsters = await steadyRect(sheet);
    const body = await rectOf(sheet.locator("[data-pane-body]").first());
    await swipe(dmCdp, { x: body.left + body.width / 2, y: body.top + 200 }, -120);
    assert.equal(await settled(sheet), "rest");
    assert.ok((await bodyScroll(sheet)) > 0, "a content drag up did not scroll");
    assert.deepEqual(await rectOf(sheet), monsters, "a content drag up moved the sheet");
    await sheet.locator("[data-pane-body]").first().evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await swipe(dmCdp, await headerPoint(sheet), -(16 + stepOf(monsters.top) + 12));
    await waitFor("full", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    await settled(sheet);
    const fullBody = await rectOf(sheet.locator("[data-pane-body]").first());
    await swipe(dmCdp, { x: fullBody.left + fullBody.width / 2, y: fullBody.top + 300 }, -150);
    assert.equal(await settled(sheet), "rest");
    assert.ok((await bodyScroll(sheet)) > 0, "a content drag up in full screen did not scroll");
    assert.equal(await sheet.getAttribute("aria-modal"), "true");
    // A subpage opened and left keeps it full.
    await sheet.locator("[data-pane-body]").first().evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await sheet.getByRole("button", { name: /^Aboleth/ }).first().click();
    await sheet.getByRole("button", { name: /^Back to Monsters/ }).click();
    assert.equal(await sheet.getAttribute("aria-modal"), "true", "a subpage ended full screen");
    // From full, content at its top steps down under a short drag, as the header does.
    await sheet.locator("[data-pane-body]").first().evaluate((el) => ((el as unknown as El).scrollTop = 0));
    await swipe(dmCdp, await middleOf(sheet.getByRole("button", { name: "Paste a stat block" })), 8 + stepOf(monsters.top) + 12);
    await waitFor("a content drag to step down", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    await settled(sheet);
    await swipe(dmCdp, await headerPoint(sheet), -(16 + stepOf(monsters.top) + 12));
    await waitFor("full again", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    await settled(sheet);
    // Turned sideways and back: the side sheet, then full again.
    await dm.setViewportSize({ width: 667, height: 375 });
    await waitFor("the side sheet", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    await dm.setViewportSize({ width: 375, height: 667 });
    await waitFor("full again after the turn", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    const after = await steadyRect(sheet);
    assert.deepEqual([after.top, after.height], [0, 667]);
    await sheet.getByRole("button", { name: "Close Monsters" }).click();
    await sheet.waitFor({ state: "detached" });
  });

  test("12c. full screen in a fight: the dock's buttons join the header and come back after the step down, and the camera holds still", async () => {
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.entries.goblins[0], tokenId: run.goblins[0], value: 18 },
        { id: run.entries.thorn, tokenId: run.thorn.id, value: 15 },
      ],
    });
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    await touchTap(dmCdp, dm, await cellPoint(dm, { x: 6, y: 3 }));
    await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
    const sheet = await openPanel(dm, "Log");
    const dock = dm.locator("[data-rvtt-dock]");
    await dock.waitFor();
    const normal = await steadyRect(sheet);
    const camera = await readCamera(dm);
    // During a held upward drag the sheet's layout box changes once, at the claim, and never after.
    const f = new Finger(dmCdp, dm);
    await f.down(await headerPoint(sheet));
    await f.drag(-24, { step: 8 });
    await waitFor("the rise to show", async () => ((await transformOf(sheet)) !== "" ? true : null), 3_000);
    const box = () => sheet.evaluate((el) => {
      const d = el as unknown as { offsetTop: number; offsetHeight: number; offsetWidth: number };
      return `${d.offsetTop} ${d.offsetHeight} ${d.offsetWidth}`;
    });
    const boxes = [await box()];
    for (let i = 0; i < 5; i++) {
      await f.drag(-10);
      boxes.push(await box());
    }
    assert.equal(new Set(boxes).size, 1, `the sheet's layout box changed during the drag: ${boxes.join(" | ")}`);
    await f.drag(-stepOf(normal.top));
    await f.up();
    await waitFor("full", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    await settled(sheet);
    await sheet.getByRole("button", { name: /^Show Goblin 1 actions/ }).waitFor();
    assert.equal(await dock.count(), 0, "the dock stayed on the edge of a full sheet");
    await shots.take(dm, "swipe-full-fight-dock-in-header");
    await swipe(dmCdp, await headerPoint(sheet), 8 + stepOf(normal.top) + 12);
    await waitFor("the step down", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    await settled(sheet);
    await dock.waitFor();
    assert.deepEqual(await readCamera(dm), camera, "the camera moved");
    await sheet.getByRole("button", { name: "Close Log" }).click();
    await ops.send({ t: "encounter.end" });
  });

  test("12d. full screen on a tablet survives a turn past 900 px and back, a tap on Close that drifts up closes once, and the Expand sheet button does both ways by keyboard", async () => {
    for (const view of [
      { width: 834, height: 1194 },
      { width: 768, height: 1024 },
    ]) {
      await setUp(dm, { ...view, scale: 1 });
      const sheet = await openPanel(dm, "Log");
      await steadyRect(sheet);
      await sheet.getByRole("button", { name: "Expand sheet" }).focus();
      await dm.keyboard.press("Enter");
      await waitFor("full", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
      await dm.setViewportSize({ width: view.height, height: view.width });
      await dm.getByRole("tab", { name: /^Log/ }).first().waitFor();
      await dm.setViewportSize(view);
      const back = sheetOf(dm, "Log");
      await waitFor(`${view.width} x ${view.height}: full again after the turn`, async () => (await back.getAttribute("aria-modal")) === "true" || null, 5_000);
      await back.getByRole("button", { name: "Close Log" }).click();
    }
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    let sheet = await openPanel(dm, "Log");
    await steadyRect(sheet);
    const close = sheet.getByRole("button", { name: "Close Log" });
    const closes = await countClicks(close);
    await jitterTap(dmCdp, dm, await middleOf(close), [-4, -8, -12]);
    assert.equal(await settled(sheet), "gone", "a tap on Close that drifted up did not close");
    assert.equal(await closes(), 1);
    // By keyboard: Tab shows Expand sheet, Enter fills the screen, Enter again steps down, and focus stays on it.
    sheet = await openPanel(dm, "Log");
    const normal = await steadyRect(sheet);
    const button = sheet.getByRole("button", { name: "Expand sheet" });
    // By the keyboard: Shift+Tab from Back, the header's next stop, reaches it.
    await sheet.getByRole("button", { name: "All panels" }).focus();
    await dm.keyboard.press("Shift+Tab");
    assert.equal(await button.evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El)), true, "Shift+Tab from Back did not reach Expand sheet");
    assert.ok((await rectOf(button)).width >= 44, "Expand sheet does not show with keyboard focus");
    assert.ok(Math.abs((await rectOf(button)).top - (await rectOf(sheet.getByRole("button", { name: "Close Log" }))).top) < 0.5, "Expand sheet does not stand on the row it covers");
    await dm.keyboard.press("Enter");
    await waitFor("full", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await button.evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El)), true, "focus left Expand sheet");
    await dm.keyboard.press("Enter");
    await waitFor("normal", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    assert.equal(await button.evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El)), true, "focus left Expand sheet");
    assert.deepEqual(await steadyRect(sheet), normal);
    await sheet.getByRole("button", { name: "Close Log" }).click();
  });

  test("12e. a sheet filled with focus outside it lands focus on its title, and Expand sheet never draws over the title without the keyboard", async () => {
    const fullButtonHidden = (sheet: Locator) => sheet.getByRole("button", { name: "Expand sheet" }).evaluate((el) => (el as unknown as El).getBoundingClientRect().width <= 2);
    const titleFocused = (sheet: Locator) => sheet.locator("header h2").first().evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El));
    const up = async (sheet: Locator) => {
      const r = await steadyRect(sheet);
      await swipe(dmCdp, await headerPoint(sheet), -(16 + stepOf(r.top) + 12));
      await waitFor("full", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
      await settled(sheet);
      return r;
    };
    // Focus on the page, as after a tap on the map.
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    let sheet = await openPanel(dm, "Log");
    await steadyRect(sheet);
    await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur(): void } | null } }).document.activeElement?.blur());
    let normal = await up(sheet);
    assert.equal(await fullButtonHidden(sheet), true, "Expand sheet drew itself over the title of a sheet filled with focus on the page");
    assert.equal(await titleFocused(sheet), true, "focus did not land on the full sheet's title");
    await swipe(dmCdp, await headerPoint(sheet), 8 + stepOf(normal.top) + 12);
    await waitFor("the step down", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    await settled(sheet);
    assert.equal(await fullButtonHidden(sheet), true, "Expand sheet stayed over the title after the step down");
    await sheet.getByRole("button", { name: "Close Log" }).click();
    // Initiative from the turn strip, which keeps focus on the strip.
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.entries.goblins[0], tokenId: run.goblins[0], value: 18 },
        { id: run.entries.thorn, tokenId: run.thorn.id, value: 15 },
      ],
    });
    try {
      await dm.getByRole("button", { name: /^Initiative, round/ }).first().click();
      sheet = sheetOf(dm, "Initiative");
      await sheet.waitFor();
      normal = await up(sheet);
      assert.equal(await fullButtonHidden(sheet), true, "Expand sheet drew itself over the title of Initiative opened from the turn strip");
      assert.equal(await titleFocused(sheet), true, "focus did not land on Initiative's title");
      await shots.take(dm, "swipe-full-from-turn-strip");
      await swipe(dmCdp, await headerPoint(sheet), 8 + stepOf(normal.top) + 12);
      await waitFor("the step down", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
      await settled(sheet);
      assert.equal(await fullButtonHidden(sheet), true);
      await sheet.getByRole("button", { name: "Close Initiative" }).click();
    } finally {
      await ops.send({ t: "encounter.end" });
    }
  });

  test("13. a second touch during the slide reaches nothing: a checkbox does not flip, and Close and Export do nothing", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const sheet = await openPanel(dm, "Log");
    const rest = await steadyRect(sheet);
    // Records, for each touch the page hears, the control it landed on and whether the sheet was moving.
    await dm.evaluate(() => {
      type Target = { closest(s: string): { getAttribute(n: string): string | null; tagName: string } | null };
      const g = globalThis as unknown as { __touches: { on: string; moving: boolean }[]; __touchRecord?: boolean; document: Doc; addEventListener(t: string, fn: (e: { target: Target }) => void, o: unknown): void };
      g.__touches = [];
      if (g.__touchRecord) return;
      g.__touchRecord = true;
      g.addEventListener(
        "touchstart",
        (e) => {
          const control = e.target.closest("button, input");
          const dialog = g.document.querySelector('dialog[data-rvtt-sheet][aria-label="Log"]');
          g.__touches.push({ on: control ? (control.getAttribute("aria-label") ?? control.getAttribute("type") ?? control.tagName) : "", moving: (dialog?.style.transform ?? "") !== "" });
        },
        { capture: true, passive: true },
      );
    });
    // `on` is what the recorder names the control by: its aria-label, else its type.
    const midSlide = async (control: Locator, on: string, what: string) => {
      // In view, since the Log keeps its newest lines in view and may have scrolled its top controls away.
      await control.scrollIntoViewIfNeeded();
      for (let attempt = 1; attempt <= 4; attempt++) {
        await dm.evaluate(() => ((globalThis as unknown as { __touches: unknown[] }).__touches = []));
        // The slide's motion is held where it starts, so the control stands still between the read of where it is and
        // the touch, however slow the machine: it moves fastest just then, and a touch that came late landed past it, on
        // no control. The slide itself, which decides what a touch does, runs on the page's timer (lib/sheetSwipe.ts
        // SLIDE_MS), which this leaves alone.
        await dmCdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
        try {
          await swipe(dmCdp, await headerPoint(sheet), 8 + 50);
          // Where the control is now, as the sheet springs back.
          await touchTap(dmCdp, dm, await middleOf(control));
        } finally {
          await dmCdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
        }
        assert.equal(await settled(sheet), "rest", `${what}: the sheet did not come back to rest`);
        const touches = await dm.evaluate(() => (globalThis as unknown as { __touches: { on: string; moving: boolean }[] }).__touches);
        if (touches[1]?.moving) {
          assert.equal(touches[1].on, on, `${what}: the tap landed on something else`);
          return;
        }
      }
      assert.fail(`${what}: the tap never landed during the slide`);
    };
    const box = sheet.locator('input[type="checkbox"]').first();
    const was = await box.isChecked();
    // A control that acts on its press, as a stepper or a drag handle does, hears no pointerdown either.
    await box.evaluate((el) => {
      const g = globalThis as unknown as { __boxDowns: number };
      g.__boxDowns = 0;
      (el as unknown as { addEventListener(t: string, fn: () => void): void }).addEventListener("pointerdown", () => g.__boxDowns++);
    });
    const downs = () => dm.evaluate(() => (globalThis as unknown as { __boxDowns: number }).__boxDowns);
    await midSlide(box, "checkbox", "the checkbox");
    assert.equal(await box.isChecked(), was, "a checkbox flipped under a sheet in its slide");
    assert.equal(await downs(), 0, "the checkbox heard a pointerdown during the slide");
    const close = sheet.getByRole("button", { name: "Close Log" });
    await midSlide(close, "Close Log", "Close");
    assert.ok(await sheet.isVisible(), "Close acted during the slide");
    assert.deepEqual(await rectOf(sheet), rest);
    await midSlide(sheet.getByRole("button", { name: "Export" }), "button", "Export");
    await sleep(300);
    assert.equal(await dm.getByRole("dialog", { name: "Export the log" }).count(), 0, "Export opened during the slide");
    // At rest the same taps act at once.
    await box.scrollIntoViewIfNeeded();
    await jitterTap(dmCdp, dm, await middleOf(box), []);
    await waitFor("the checkbox to flip at rest", async () => (await box.isChecked()) !== was || null, 3_000);
    assert.equal(await downs(), 1);
    await jitterTap(dmCdp, dm, await middleOf(box), []);
    await close.scrollIntoViewIfNeeded();
    await jitterTap(dmCdp, dm, await middleOf(close), []);
    assert.equal(await settled(sheet), "gone", "Close at rest did not close");
  });

  test("14. a grabber tops every sheet that swipes, in its header's top space with nothing moved, and no surface that does not swipe", async () => {
    const light = randomUUID();
    await ops.send({ t: "build.lights", sceneId: run.sceneId, put: [{ id: light, x: 12.5, y: 6.5, bright: 5, dim: 5, on: true, walls: true, label: "Candle" }] });

    // The panel sheet at each phone size: one pill, the header 4 px taller than wave 6's 56 px for it, its buttons 10 px down, and Close by a tap.
    for (const view of [
      { width: 375, height: 667, scale: 1 },
      { width: 375, height: 667, scale: 1.3 },
      { width: 320, height: 568, scale: 1.3 },
      { width: 390, height: 844, scale: 1 },
    ]) {
      const where = `the Log at ${view.width} x ${view.height} at ${view.scale * 100}%`;
      await setUp(dm, view);
      const sheet = await openPanel(dm, "Log");
      await steadyRect(sheet);
      await expectGrabbers(dm, ["Log"], where);
      const fit = await checkFit(sheet, view.scale, where);
      assert.ok(Math.abs(fit.area.height - 60 * view.scale) < 0.6, `${where}: the header is ${fit.area.height} px tall`);
      assert.ok(fit.close && Math.abs(fit.close.top - fit.area.top - 10 * view.scale) < 0.6, `${where}: Close is not 10 px down: ${JSON.stringify(fit)}`);
      await shotsInBothSchemes(dm, `grabber-log-${view.width}x${view.height}-${view.scale * 100}`);
      await touchTap(dmCdp, dm, await middleOf(sheet.getByRole("button", { name: "Close Log" })));
      assert.equal(await settled(sheet), "gone", `${where}: a tap on Close did not close the sheet`);
    }

    // The Panels list, and forced colors, where the pill keeps a system color of its own.
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    await panelsButton(dm).click();
    const list = sheetOf(dm, "Panels");
    await steadyRect(list);
    await expectGrabbers(dm, ["Panels"], "the Panels list");
    await checkFit(list, 1, "the Panels list");
    await dm.emulateMedia({ forcedColors: "active" });
    try {
      const fills = await list.evaluate((el) => {
        const g = globalThis as unknown as Win;
        const pill = (el as unknown as El).querySelector("[data-sheet-grabber]");
        // Drawn in its color, `currentColor`.
        return { pill: pill ? g.getComputedStyle(pill).color : "", sheet: g.getComputedStyle(el as unknown as El).backgroundColor };
      });
      assert.ok(fills.pill !== "" && fills.pill !== fills.sheet && !/^rgba\(.*, 0\)$|^transparent$/.test(fills.pill ?? ""), `under forced colors the pill is not seen: ${JSON.stringify(fills)}`);
      await shots.take(dm, "grabber-panels-forced-colors");
    } finally {
      await dm.emulateMedia({ forcedColors: "none" });
    }
    await list.getByRole("button", { name: "Close Panels" }).click();

    // Full screen, its top corners round as at the normal height through the drag up, at rest and the step down, and in a fight with the dock riding the sheet and then in its header.
    for (const view of [
      { width: 375, height: 667, scale: 1 },
      { width: 320, height: 568, scale: 1.3 },
    ]) {
      const where = `full screen at ${view.width} x ${view.height} at ${view.scale * 100}%`;
      await setUp(dm, view);
      const sheet = await openPanel(dm, "Log");
      const corners = await sampleCorners(sheet);
      const normal = await fillScreen(sheet, view.scale, where);
      assert.deepEqual(await topCorners(sheet), ["16px", "16px"], `${where}: the full sheet's top corners are not round`);
      await expectGrabbers(dm, ["Log"], where);
      const fit = await checkFit(sheet, view.scale, where);
      assert.ok(Math.abs(fit.area.height - 60 * view.scale) < 0.6, `${where}: the header is ${fit.area.height} px tall`);
      await shotsInBothSchemes(dm, `grabber-full-${view.width}x${view.height}-${view.scale * 100}`);
      await swipe(dmCdp, await headerPoint(sheet), 8 + stepOf(normal.top, view.scale) + 12);
      await waitFor(`${where}: the sheet to step down`, async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
      assert.equal(await settled(sheet), "rest");
      assert.deepEqual(await corners(), ["16px 16px"], `${where}: the top corners squared off at some frame from the drag up to the step down`);
      await fillScreen(sheet, view.scale, where);
      await touchTap(dmCdp, dm, await middleOf(sheet.getByRole("button", { name: "Close Log" })));
      assert.equal(await settled(sheet), "gone", `${where}: a tap on Close did not close the sheet`);
    }
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: run.entries.goblins[0], tokenId: run.goblins[0], value: 18 },
        { id: run.entries.thorn, tokenId: run.thorn.id, value: 15 },
      ],
    });
    try {
      await setUp(dm, { width: 320, height: 568, scale: 1.3 });
      await touchTap(dmCdp, dm, await cellPoint(dm, { x: 6, y: 3 }));
      await dm.getByRole("dialog", { name: "Goblin 1 actions" }).waitFor();
      const sheet = await openPanel(dm, "Log");
      await steadyRect(sheet);
      await expectGrabbers(dm, ["Log"], "a fight at 320 x 568 at 130%");
      await checkFit(sheet, 1.3, "a fight at 320 x 568 at 130%");
      await shots.take(dm, "grabber-fight-dock-320x568-130");
      await fillScreen(sheet, 1.3, "a fight in full screen");
      // The dock's chip joins the header, the one place an outlined button could stand under the pill.
      await sheet.locator("header").getByRole("button", { name: /^Show Goblin 1 actions/ }).waitFor();
      await expectGrabbers(dm, ["Log"], "a fight in full screen");
      await checkFit(sheet, 1.3, "a fight in full screen");
      await shots.take(dm, "grabber-fight-full-320x568-130");
      await sheet.getByRole("button", { name: "Close Log" }).click();
    } finally {
      await ops.send({ t: "encounter.end" });
    }

    // Dialog sheets: the monster filters over the Monsters panel, each with its own pill, and the X-card, which has no header.
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const monsters = await openPanel(dm, "Monsters");
    await steadyRect(monsters);
    await monsters.getByRole("button", { name: "Filters" }).click();
    const filters = dm.getByRole("dialog", { name: "Monster filters" }).locator("section").first();
    await steadyRect(filters);
    await expectGrabbers(dm, ["Monsters", "Monster filters"], "the monster filters");
    await checkFit(filters, 1, "the monster filters");
    await shots.take(dm, "grabber-dialog-filters-375x667-100");
    await touchTap(dmCdp, dm, await middleOf(filters.getByRole("button", { name: /^Close/ })));
    assert.equal(await settled(filters), "gone", "a tap on the filters' Close did not close them");
    await monsters.getByRole("button", { name: "Close Monsters" }).click();
    const xcard = await showXCard();
    await steadyRect(xcard);
    await expectGrabbers(dm, ["X-card"], "the X-card");
    await checkFit(xcard, 1, "the X-card");
    await shots.take(dm, "grabber-xcard-375x667-100");
    await xcard.getByRole("button", { name: "Dismiss" }).click();
    const playerCard = player.getByRole("dialog", { name: "X-card" });
    if (await playerCard.isVisible()) await playerCard.getByRole("button", { name: "Dismiss" }).click();

    // From 600 px a dialog is a card in the middle, under a panel sheet that still swipes.
    await setUp(dm, { width: 768, height: 1024, scale: 1 });
    const tall = await openPanel(dm, "Monsters");
    await steadyRect(tall);
    await tall.getByRole("button", { name: "Filters" }).click();
    const card = dm.getByRole("dialog", { name: "Monster filters" }).locator("section").first();
    await steadyRect(card);
    await expectGrabbers(dm, ["Monsters"], "a dialog's card at 768 x 1024");
    await shots.take(dm, "grabber-dialog-card-768x1024-100");
    await card.getByRole("button", { name: /^Close/ }).click();
    await tall.getByRole("button", { name: "Close Monsters" }).click();

    // The label, pin and light panes as sheets: the pane's header reaches over the frame's top padding to hold the pill, its buttons 4 px lower than before (1 px border, 4 px padding, 4 px for the pill, 2 px over a 44 px button).
    for (const scale of [1, 1.3]) {
      await setUp(dm, { width: 375, height: 667, scale });
      const label = await openLabel(0);
      await checkPane(label, scale, `the label pane at ${scale * 100}%`, `grabber-label-375x667-${scale * 100}`);
      await pickTool(dm, "Select");
    }
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    await pickTool(dm, "Pin");
    const pinAt = await pagePoint(dm, run.bounds, { x: 10.5, y: 3.5 });
    await touchTap(dmCdp, dm, { x: pinAt.x, y: pinAt.y - 14 });
    await checkPane(dm.getByRole("dialog", { name: "Edit pin" }), 1, "the pin pane", "grabber-pin-375x667-100");
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Lights");
    await touchTap(dmCdp, dm, await pagePoint(dm, run.bounds, { x: 12.5, y: 6.5 }));
    await checkPane(dm.getByRole("dialog", { name: "Edit light" }), 1, "the light pane", "grabber-light-375x667-100");
    await pickTool(dm, "Select");

    // Beside the side panel the map is under 600 px, so the label pane is a sheet. On a wide map it is a card by its label.
    for (const view of [
      { width: 940, height: 800, scale: 1, sheet: true },
      { width: 1280, height: 800, scale: 1, sheet: false },
    ]) {
      const where = `the label pane at ${view.width} x ${view.height}`;
      await setUp(dm, view);
      await dm.evaluate((shown) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.sidePanel", shown ? "shown" : "hidden"), view.sheet);
      await setUp(dm, view);
      const pane = await openLabel(0);
      await steadyRect(pane);
      await expectGrabbers(dm, view.sheet ? ["Edit label"] : [], where);
      if (view.sheet) await checkFit(pane, 1, where);
      await shots.take(dm, `grabber-label-${view.width}x${view.height}`);
      await pane.getByRole("button", { name: "Close without saving" }).click();
      await pickTool(dm, "Select");
    }
    await dm.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.sidePanel"));

    // Sideways and in the very short mode nothing swipes, so nothing shows a pill, and the header keeps wave 6's 56 px.
    for (const view of [
      { width: 844, height: 390, scale: 1 },
      { width: 480, height: 320, scale: 1.3 },
    ]) {
      const where = `the Log at ${view.width} x ${view.height} at ${view.scale * 100}%`;
      await setUp(dm, view);
      const sheet = await openPanel(dm, "Log");
      await steadyRect(sheet);
      await expectGrabbers(dm, [], where);
      const header = await rectOf(sheet.locator("header").first());
      assert.ok(Math.abs(header.height - 56 * view.scale) < 0.6, `${where}: the header is ${header.height} px tall`);
      await shotsInBothSchemes(dm, `grabber-log-${view.width}x${view.height}-${view.scale * 100}`);
      await sheet.getByRole("button", { name: "Close Log" }).click();
    }

    // A player's roll card at a phone's foot has its pill. On a computer it is a card, with none.
    const request = randomUUID();
    await ops.send({ t: "roll.ask", request: { id: request, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    try {
      for (const view of [
        { width: 375, height: 667, scale: 1, sheet: true },
        { width: 375, height: 667, scale: 1.3, sheet: true },
        { width: 1280, height: 800, scale: 1, sheet: false },
      ]) {
        const where = `the roll card at ${view.width} x ${view.height} at ${view.scale * 100}%`;
        await setUp(player, view);
        const rollCard = player.getByRole("dialog", { name: "The DM asks for a roll" });
        await steadyRect(rollCard);
        await expectGrabbers(player, view.sheet ? ["The DM asks for a roll"] : [], where);
        if (view.sheet) await checkFit(rollCard, view.scale, where);
        await shotsInBothSchemes(player, `grabber-roll-card-${view.width}x${view.height}-${view.scale * 100}`);
      }
      /*
       * Where the screen is too short even for the card's question and its
       * answer row, the header stops sticking and the whole card scrolls.
       * The header still reaches over the card's top padding, so the pill
       * is on the grab area: with the total focused, where a drag on the
       * content stays the browser's, a drag that starts right on the pill
       * still puts the card off.
       */
      let unstuck = false;
      for (const height of [260, 240, 220, 200]) {
        await setUp(player, { width: 320, height, scale: 1.3 });
        const rollCard = player.getByRole("dialog", { name: "The DM asks for a roll" });
        const row = player.getByRole("button", { name: /^Roll asked/ }).first();
        await waitFor("the card or the row that stands for it", async () => ((await rollCard.isVisible()) || (await row.isVisible()) ? true : null));
        if (!(await rollCard.isVisible())) await row.tap();
        await steadyRect(rollCard);
        const position = await rollCard.locator("[data-sheet-grab]").evaluate((el) => (globalThis as unknown as Win).getComputedStyle(el as unknown as El).position);
        if (position === "sticky") continue;
        unstuck = true;
        const where = `the roll card whose header does not stick, at 320 x ${height} at 130%`;
        await rollCard
          .getByRole("textbox")
          .first()
          .evaluate((el) => (el as unknown as { focus(o: { preventScroll: boolean }): void }).focus({ preventScroll: true }));
        await rollCard.evaluate((el) => {
          (el as unknown as El).scrollTop = 0;
        });
        await expectGrabbers(player, ["The DM asks for a roll"], where);
        await checkFit(rollCard, 1.3, where);
        await shots.take(player, `grabber-roll-card-unstuck-320x${height}-130`);
        const pill = await middleOf(rollCard.locator("[data-sheet-grabber]"));
        const card = await rectOf(rollCard);
        // Drawn over everything, the card is fully off screen at the screen's foot.
        const screen = await player.evaluate(() => (globalThis as unknown as Win).innerHeight);
        await swipe(playerCdp, pill, closePast(screen - card.top, 1.3), {}, player);
        assert.equal(await settled(rollCard), "gone", `${where}: a drag from the pill with the total focused did not put the card off`);
        break;
      }
      assert.ok(unstuck, "no screen size left the roll card's header unstuck");
    } finally {
      await ops.send({ t: "roll.close", rollIds: [request] });
    }
  });

  test("grab-a. This device's Sheet handle offers the six designs, Ringed tail first and chosen, and a choice changes the open sheet's grabber and the preview at once and stays after a reload", async () => {
    try {
      await setUp(dm, { width: 375, height: 667, scale: 1 });
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.sheetHandle"));
      await setUp(dm, { width: 375, height: 667, scale: 1 });
      const menu = await openPanel(dm, "Menu");
      await menu.getByRole("button", { name: /^This device/ }).click();
      const choice = menu.getByRole("combobox", { name: "Sheet handle" });
      await choice.scrollIntoViewIfNeeded();
      assert.deepEqual(await choice.locator("option").allTextContents(), ["Ringed tail", "Bandit mask", "Paw beans", "Scroll rod", "Rune divider", "Plain pill"]);
      assert.equal(await choice.inputValue(), "tail");
      const preview = menu.getByRole("img", { name: /on a sheet$/ });
      assert.equal(await designOf(menu.locator("[data-sheet-grabber]")), "tail");
      assert.equal(await designOf(preview.locator("[data-grabber-preview]")), "tail");
      await expectGrabbers(dm, ["Menu"], "This device with its preview");
      await shots.take(dm, "grab-a-this-device-tail-375x667-100");
      // The open sheet's grabber and its header's room follow the choice at once, and so does the preview, at its real size.
      await choice.selectOption("mask");
      await waitFor("the open sheet's grabber to change", async () => ((await designOf(menu.locator("[data-sheet-grabber]"))) === "mask" ? true : null), 3_000);
      assert.equal(await designOf(preview.locator("[data-grabber-preview]")), "mask");
      assert.equal(await preview.getAttribute("aria-label"), "Bandit mask on a sheet");
      const drawn = await rectOf(preview.locator("[data-grabber-preview]"));
      assert.ok(Math.abs(drawn.width - 40) < 0.6 && Math.abs(drawn.height - 9) < 0.6, `the preview is not at its real size: ${JSON.stringify(drawn)}`);
      await expectGrabbers(dm, ["Menu"], "This device after the choice");
      const fit = await checkFit(menu, 1, "the Menu sheet with the mask", { width: 40, height: 9 });
      assert.ok(Math.abs(fit.area.height - (56 + 15 - 6)) < 0.6, `the Menu's header is ${fit.area.height} px tall with the mask`);
      assert.equal(await dm.evaluate(() => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("rvtt.sheetHandle")), "mask");
      await shots.take(dm, "grab-a-this-device-mask-375x667-100");
      await setUp(dm, { width: 375, height: 667, scale: 1 });
      const log = await openPanel(dm, "Log");
      await steadyRect(log);
      assert.equal(await designOf(log.locator("[data-sheet-grabber]")), "mask", "the choice did not stay after a reload");
      await log.getByRole("button", { name: "Close Log" }).click();
      // A stored id this version does not know reads as the ringed tail.
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.sheetHandle", "lantern"));
      await setUp(dm, { width: 375, height: 667, scale: 1 });
      const again = await openPanel(dm, "Log");
      await steadyRect(again);
      assert.equal(await designOf(again.locator("[data-sheet-grabber]")), "tail", "an unknown stored design");
      await again.getByRole("button", { name: "Close Log" }).click();
    } finally {
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.sheetHandle"));
    }
  });

  test("grab-b. each design is centered at the top of a phone's sheet, 5 px under its edge, and the header keeps the room its height needs, the mask the tallest, on a pane and the roll card too", async () => {
    const heights = new Map<GrabberId, number>();
    try {
      for (const view of [
        { width: 375, height: 667, scale: 1 },
        { width: 320, height: 568, scale: 1.3 },
      ]) {
        // Picked in This device, as a person does, rather than stored and loaded again: a reload for each design spent the DM session's snapshot budget, whose abuse rule then closed the op socket.
        await setUp(dm, view);
        for (const design of GRABBER_DESIGNS) {
          const where = `${design.name} on the Log at ${view.width} x ${view.height} at ${view.scale * 100}%`;
          await pickHandle(dm, design.id);
          const sheet = await openPanel(dm, "Log");
          await steadyRect(sheet);
          await expectGrabbers(dm, ["Log"], where);
          assert.equal(await designOf(sheet.locator("[data-sheet-grabber]")), design.id, where);
          // checkFit measures its middle against the sheet's within 1 px, and its place 5 px under the edge.
          const fit = await checkFit(sheet, view.scale, where, design);
          const room = grabberRoom(design.id);
          assert.ok(Math.abs(fit.area.height - (56 + room - 6) * view.scale) < 0.6, `${where}: the header is ${fit.area.height} px tall, not ${(56 + room - 6) * view.scale}`);
          assert.ok(fit.close && Math.abs(fit.close.top - fit.area.top - room * view.scale) < 0.6, `${where}: Close is not ${room} px down: ${JSON.stringify(fit)}`);
          if (view.scale === 1) heights.set(design.id, fit.area.height);
          await shots.take(dm, `grab-b-${design.id}-${view.width}x${view.height}-${view.scale * 100}`);
          await sheet.getByRole("button", { name: "Close Log" }).click();
        }
      }
      const tallest = [...heights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      assert.equal(tallest, "mask", `the tallest header: ${JSON.stringify([...heights])}`);
      // A pane as a sheet keeps the same room, with the mask: its close 1 + 4 + 9 + 2 px down, its buttons 9 px lower than without a grabber.
      await setUp(dm, { width: 375, height: 667, scale: 1 });
      await pickHandle(dm, "mask");
      const label = await openLabel(0);
      await steadyRect(label);
      const fit = await checkFit(label, 1, "the label pane with the mask", { width: 40, height: 9 });
      assert.ok(fit.close && Math.abs(fit.close.top - fit.surface.top - 16) < 0.6, `the label pane's close is not 16 px down with the mask: ${JSON.stringify(fit)}`);
      await shots.take(dm, "grab-b-mask-label-pane-375x667-100");
      await label.getByRole("button", { name: "Close without saving" }).click();
      await pickTool(dm, "Select");
      // A player's roll card at a phone's foot: its question and Later stand the mask's 15 px under the card's top edge.
      await player.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.sheetHandle", "mask"));
      const request = randomUUID();
      await ops.send({ t: "roll.ask", request: { id: request, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
      try {
        await setUp(player, { width: 375, height: 667, scale: 1 });
        const rollCard = player.getByRole("dialog", { name: "The DM asks for a roll" });
        await steadyRect(rollCard);
        await expectGrabbers(player, ["The DM asks for a roll"], "the roll card with the mask");
        const card = await checkFit(rollCard, 1, "the roll card with the mask", { width: 40, height: 9 });
        assert.ok(Math.abs(card.firstLine - card.area.top - 15) < 0.6, `the roll card's first line is not 15 px down with the mask: ${JSON.stringify(card)}`);
        await shots.take(player, "grab-b-mask-roll-card-375x667-100");
      } finally {
        await ops.send({ t: "roll.close", rollIds: [request] });
      }
    } finally {
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.sheetHandle"));
      await player.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.sheetHandle"));
    }
  });

  test("FU39-B: the X-card leaves room for the mask at normal and large interface sizes", async () => {
    try {
      for (const view of [
        { width: 375, height: 667, scale: 1 },
        { width: 320, height: 568, scale: 1.3 },
      ]) {
        await setUp(dm, view);
        await pickHandle(dm, "mask");
        const card = await showXCard();
        try {
          await steadyRect(card);
          await expectGrabbers(dm, ["X-card"], "FU39-B: the X-card with the mask");
          assert.equal(await designOf(card.locator("[data-sheet-grabber]")), "mask");
          await checkFit(card, view.scale, "FU39-B: the X-card with the mask", { width: 40, height: 9 });
          await shots.take(dm, `fu39-b-mask-xcard-${view.width}x${view.height}-${view.scale * 100}`);
        } finally {
          if (await card.isVisible()) await card.getByRole("button", { name: "Dismiss" }).click();
          const playerCard = player.getByRole("dialog", { name: "X-card" });
          if (await playerCard.isVisible()) await playerCard.getByRole("button", { name: "Dismiss" }).click();
        }
      }
    } finally {
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.sheetHandle"));
    }
  });

  test("fl8-hold. the grabber warms to 30% of the member's color over 300 ms, follows a drag, and a tap on Close lights nothing", async () => {
    // Pat's page, whose accent is his green, not the crest yellow.
    await setUp(player, { width: 375, height: 667, scale: 1 });
    const sheet = await openPanel(player, "Log");
    const box = await steadyRect(sheet);
    const pill = sheet.locator("[data-sheet-grabber]");
    const colors = await systemColors(player);
    // Pat's green, lifted for contrast on a dark surface (lib/accent.ts), and neither the crest yellow nor the grey at rest.
    assert.match(colors.accent, /^rgb\(\d+, \d+, \d+\)$/);
    assert.notEqual(colors.accent, "rgb(247, 223, 0)", "Pat's accent is the crest yellow");
    assert.notEqual(colors.accent, colors.rest);
    const [r = 0, gr = 0, b = 0] = (colors.accent.match(/\d+/g) ?? []).map(Number);
    assert.ok(gr > r && gr > b, `Pat's accent is not his green: ${colors.accent}`);
    assert.equal(await colorOf(pill), colors.rest, "at rest");
    const look = await pill.evaluate((el) => {
      const s = (globalThis as unknown as Win).getComputedStyle(el as unknown as El);
      return { property: s.transitionProperty ?? "", duration: s.transitionDuration ?? "" };
    });
    assert.deepEqual(look, { property: "color, transform", duration: "0.2s, 0.2s" });
    const finger = new Finger(playerCdp, player);
    await finger.down(await headerPoint(sheet));
    assert.equal(await sheet.getAttribute("data-sheet-held"), "", "the press on the header did not hold the sheet");
    const held = await mixedGrabberColor(player, 0);
    await waitFor("the held color to warm", async () => ((await colorOf(pill)) === held ? true : null), 1_000);
    const holdTransition = await grabberLook(sheet);
    assert.equal(holdTransition.property, "color");
    assert.equal(holdTransition.duration, "0.3s");
    await shots.take(player, "grab-c-held-375x667-100");
    await finger.drag(30);
    await checkPull(sheet, 22 / Math.max(box.height / 2, 44));
    await finger.up();
    assert.equal(await settled(sheet), "rest", "a short drag springs back");
    assert.equal(await sheet.getAttribute("data-sheet-held"), null);
    await expectGrabberRest(sheet);
    // Under forced colors: the system's muted text at rest, its highlight while held.
    await player.emulateMedia({ forcedColors: "active" });
    try {
      const forced = await systemColors(player);
      // The switch to forced colors fades too.
      await waitFor("the muted text at rest", async () => ((await colorOf(pill)) === forced.grayText ? true : null), 1_000);
      assert.notEqual(forced.grayText, forced.highlight);
      await finger.down(await headerPoint(sheet));
      await waitFor("the highlight while held", async () => ((await colorOf(pill)) === forced.highlight ? true : null), 1_000);
      await shots.take(player, "grab-c-held-forced-colors-375x667-100");
      await finger.up();
      await waitFor("the muted text again", async () => ((await colorOf(pill)) === forced.grayText ? true : null), 1_000);
    } finally {
      await player.emulateMedia({ forcedColors: "none" });
    }
    // A press on Close is its tap, not a hold of the sheet.
    const close = sheet.getByRole("button", { name: "Close Log" });
    await finger.down(await middleOf(close));
    await sleep(250);
    assert.equal(await sheet.getAttribute("data-sheet-held"), null, "a press on Close held the sheet");
    assert.equal(await colorOf(pill), colors.rest, "a press on Close lit the grabber");
    await finger.up(40);
    assert.equal(await settled(sheet), "gone", "the tap on Close did not close the sheet");
  });

  test("fl8-reduced. reduced motion changes the color at once and never stretches, on the pull or the release", async () => {
    await player.emulateMedia({ reducedMotion: "reduce" });
    try {
      await setUp(player, { width: 375, height: 667, scale: 1 });
      const sheet = await openPanel(player, "Log");
      const box = await steadyRect(sheet);
      const pill = sheet.locator("[data-sheet-grabber]");
      const colors = await systemColors(player);
      const duration = await pill.evaluate((el) => parseFloat((globalThis as unknown as Win).getComputedStyle(el as unknown as El).transitionDuration ?? ""));
      assert.ok(duration <= 0.00001, `the color still fades over ${duration} s`);
      const finger = new Finger(playerCdp, player);
      await finger.down(await headerPoint(sheet));
      // Read in the frame after the press: no fade to wait for.
      assert.equal(await colorAfterFrame(pill), await mixedGrabberColor(player, 0), "the held color did not come at once");
      const commit = Math.max(box.height / 2, 44);
      await finger.drag(8 + commit * 0.5);
      await checkPull(sheet, 0.5, true);
      await finger.up();
      assert.equal(await colorAfterFrame(pill), colors.rest, "the pull color did not go at once");
      await expectGrabberRest(sheet);
      await sheet.getByRole("button", { name: "Close Log" }).click();
    } finally {
      await player.emulateMedia({ reducedMotion: null });
    }
  });

  test("fl8-pull. each design fills and stretches with the sheet at 25%, 50% and 100% of the slow-release distance, down and up", async () => {
    await setUp(player, { width: 390, height: 844, scale: 1 });
    try {
      for (const design of GRABBER_DESIGNS) {
        await pickHandle(player, design.id);
        for (const direction of [1, -1]) {
          const sheet = await openPanel(player, "Log");
          const box = await steadyRect(sheet);
          const header = await headerLayout(sheet);
          const commit = Math.max((direction > 0 ? box.height : box.top) / 2, 44);
          const slop = direction > 0 ? 8 : 16;
          const finger = new Finger(playerCdp, player);
          await finger.down(await headerPoint(sheet));
          let previous = 0;
          for (const share of [0.25, 0.5, 1]) {
            const distance = direction * (slop + commit * share);
            await finger.drag(distance - previous);
            previous = distance;
            await checkPull(sheet, share);
            checkHeaderLayout(header, await headerLayout(sheet), design.id, direction < 0);
            if (share >= 0.5) await shots.take(player, `fl8-${design.id}-${direction > 0 ? "down" : "up"}-${share === 1 ? "full" : "mid"}-pull-390x844`);
          }
          // Reach full pull, then return short of the threshold. A slow lift must spring back.
          await finger.drag(direction * (slop + commit * 0.25) - previous);
          await checkPull(sheet, 0.25);
          await finger.rest(120);
          await finger.up();
          assert.equal(await settled(sheet), "rest");
          assert.equal(await sheet.getAttribute("aria-modal"), null, "the short release filled the sheet");
          await expectGrabberRest(sheet);
          await sheet.getByRole("button", { name: "Close Log" }).click();
        }
      }
    } finally {
      await player.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.sheetHandle"));
    }
  });

  test("fl8-unsaved. unsaved input caps closing pull at half, fills toward full screen and normal, and keeps the draft on release and cancel", async () => {
    await setUp(player, { width: 390, height: 844, scale: 1 });
    const sheet = await openPanel(player, "Log");
    const box = await steadyRect(sheet);
    const commit = Math.max(box.height / 2, 44);
    const message = sheet.getByLabel("Message");
    await message.fill("FL-8 unsent message");
    await message.blur();
    const finger = new Finger(playerCdp, player);
    await finger.down(await headerPoint(sheet));
    await finger.drag(8 + commit * 0.5);
    await checkPull(sheet, 0.25);
    await finger.drag(commit * 0.5);
    await checkPull(sheet, 0.5);
    await finger.drag(commit * 0.5);
    await checkPull(sheet, 0.5);
    await finger.rest(120);
    await finger.up();
    assert.equal(await settled(sheet), "rest");
    await expectGrabberRest(sheet);
    assert.equal(await message.inputValue(), "FL-8 unsent message");
    // A second finger cancels the hold and its pull even while the first remains down.
    await finger.down(await headerPoint(sheet));
    await finger.drag(8 + commit);
    await checkPull(sheet, 0.5);
    await finger.second(mapPoint());
    await expectGrabberRest(sheet);
    await finger.up();
    assert.equal(await settled(sheet), "rest");
    assert.equal(await message.inputValue(), "FL-8 unsent message");
    // A draft blocks closing, but expanding and stepping back down remain permitted.
    const normal = await steadyRect(sheet);
    const step = stepOf(normal.top);
    await finger.down(await headerPoint(sheet));
    await finger.drag(-(16 + step * 0.5));
    await checkPull(sheet, 0.5);
    await finger.drag(step * -0.55);
    await checkPull(sheet, 1);
    await finger.rest(120);
    await finger.up();
    await waitFor("FL-8: the unsaved sheet to fill the screen", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    assert.equal(await settled(sheet), "rest");
    await expectGrabberRest(sheet);
    assert.equal(await message.inputValue(), "FL-8 unsent message");
    await finger.down(await headerPoint(sheet));
    await finger.drag(8 + step * 1.05);
    await checkPull(sheet, 1);
    await finger.rest(120);
    await finger.up();
    await waitFor("FL-8: the unsaved sheet to return to normal", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    assert.equal(await settled(sheet), "rest");
    await expectGrabberRest(sheet);
    assert.equal(await message.inputValue(), "FL-8 unsent message");
    await message.fill("");
    await message.blur();
    await sheet.getByRole("button", { name: "Close Log" }).click();
  });

  // FL-14: a swipe right in a phone's panel goes back, as the Back in its header does (client/lib/backSwipe.ts).
  test("fl14-a. a slow swipe right past half a panel goes back to Panels as All panels does, with its focus, a short one springs back, and a flick goes back", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const list = dm.getByRole("region", { name: "Panels" });
    // All panels first, for where its focus lands.
    let sheet = await openPanel(dm, "Log");
    await steadyRect(sheet);
    await sheet.getByRole("button", { name: "All panels" }).click();
    await list.waitFor();
    const byButton = await focusedName(dm);
    await list.getByRole("button", { name: "Log", exact: true }).click();
    await dm.locator('section[aria-label="Log"]').waitFor();
    sheet = sheetOf(dm, "Log");
    const box = await steadyRect(sheet);
    const page = movingBody(sheet);
    const half = box.width / 2;
    // Short of half: it follows the finger, then springs back with nothing changed.
    const f = new Finger(dmCdp, dm);
    await f.down(await leftBodyPoint(sheet));
    await f.drag(0, { dx: 8 + half - 30 });
    const held = await translateXOf(page);
    assert.ok(Math.abs(held - (half - 30)) < 2, `FL-14: the page stood ${held} px right, not with the finger at ${half - 30}`);
    await shots.take(dm, "fl14-a-following");
    await f.up();
    assert.equal(await pageSettled(page), "rest");
    assert.equal(await list.count(), 0, "FL-14: a short swipe went back");
    assert.deepEqual(await rectOf(sheet), box, "FL-14: the sheet moved");
    // Past half: back to Panels, focus where All panels puts it.
    await backSwipe(dmCdp, await leftBodyPoint(sheet), 8 + half + 20);
    await list.waitFor();
    assert.equal(await sheetOf(dm, "Log").count(), 0, "FL-14: the panel stayed after its back swipe");
    assert.equal(await focusedName(dm), byButton, "FL-14: focus differs from All panels'");
    await shots.take(dm, "fl14-a-back-to-panels");
    // A flick from the header, short of half, goes back too.
    await list.getByRole("button", { name: "Log", exact: true }).click();
    await dm.locator('section[aria-label="Log"]').waitFor();
    sheet = sheetOf(dm, "Log");
    await steadyRect(sheet);
    const head = await headerPoint(sheet);
    await backSwipe(dmCdp, { x: 40, y: head.y }, 70, { flick: true });
    await list.waitFor();
    assert.equal(await sheetOf(dm, "Log").count(), 0, "FL-14: a flick from the header did not go back");
    await list.getByRole("button", { name: "Close Panels" }).click();
  });

  test("fl14-b. a vertical scroll that drifts sideways, a start in the screen's edge zone and a mouse drag never go back, and All panels still does", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const sheet = await openPanel(dm, "Scenes");
    await openSceneGroup(sheet, "Map image and grid");
    await openSceneGroup(sheet, "Size and view");
    await steadyRect(sheet);
    const body = sheet.locator("[data-pane-body]").first();
    const scrolls = await body.evaluate((el) => (el as unknown as El).scrollHeight > (el as unknown as El).clientHeight);
    assert.ok(scrolls, "FL-14: the Scenes panel did not scroll at this size");
    const page = movingBody(sheet);
    // Up with a sideways drift: a scroll, all the way.
    const from = await leftBodyPoint(sheet, 200);
    const f = new Finger(dmCdp, dm);
    await f.down(from);
    await f.drag(-160, { dx: 70 });
    assert.equal(await translateXOf(page), 0, "FL-14: a scroll moved the page sideways");
    await f.up();
    assert.ok((await bodyScroll(sheet)) > 0, "FL-14: the drag up did not scroll");
    // Up first, then far to the right: the first move locked it to the scroll.
    await f.down(await leftBodyPoint(sheet, 200));
    await f.drag(-20);
    await f.drag(0, { dx: 250 });
    await f.up();
    assert.equal(await pageSettled(page), "rest");
    // Up first on the header, where nothing pans and the sheet's own swipe waits for twice the slop, then far to the right: still locked to up and down.
    await body.evaluate((el) => {
      (el as unknown as El).scrollTop = 0;
    });
    const head = await headerPoint(sheet);
    await f.down({ x: 70, y: head.y });
    await f.drag(-12);
    await f.drag(0, { dx: 8 + (await rectOf(sheet)).width / 2 + 20 });
    await f.up();
    assert.equal(await pageSettled(page), "rest");
    assert.equal(await dm.getByRole("region", { name: "Panels" }).count(), 0, "FL-14: a swipe that started up went back");
    // Inside the system's edge zone the swipe is the browser's.
    await backSwipe(dmCdp, { x: 10, y: from.y }, 300);
    assert.equal(await pageSettled(page), "rest");
    // A mouse drag is never a swipe.
    await dm.mouse.move(40, from.y);
    await dm.mouse.down();
    await dm.mouse.move(340, from.y, { steps: 12 });
    await dm.mouse.up();
    assert.equal(await pageSettled(page), "rest");
    assert.equal(await dm.getByRole("region", { name: "Panels" }).count(), 0, "FL-14: a scroll, an edge start or a mouse drag went back");
    assert.equal(await sheet.count(), 1);
    // A slider takes a drag to the right, past the distance that would go back, and the panel stays.
    const slider = sheet.locator('input[type="range"]').first();
    await slider.scrollIntoViewIfNeeded();
    const value = await slider.inputValue();
    const r = await rectOf(slider);
    await backSwipe(dmCdp, { x: Math.max(r.left + 4, 40), y: r.top + r.height / 2 }, 8 + (await rectOf(sheet)).width / 2 + 20);
    await waitFor("FL-14: the slider to move", async () => ((await slider.inputValue()) !== value ? true : null), 3_000);
    assert.equal(await pageSettled(page), "rest");
    assert.equal(await dm.getByRole("region", { name: "Panels" }).count(), 0, "FL-14: a slider drag went back");
    // Back in the header still goes back.
    await sheet.getByRole("button", { name: "All panels" }).click();
    await dm.getByRole("region", { name: "Panels" }).waitFor();
    await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Close Panels" }).click();
  });

  test("fl14-c. the Dice panel's quick dice scroll sideways and keep the swipe while scrolled, hand it over at their left edge, and a roll's fired hold keeps its finger", async () => {
    await setUp(dm, { width: 320, height: 568, scale: 1 });
    const list = dm.getByRole("region", { name: "Panels" });
    let sheet = await openPanel(dm, "Dice");
    await steadyRect(sheet);
    // The strip's own element scrolls (components/ScrollStrip.tsx).
    const scroller = sheet.locator('[aria-label="Quick dice"]').first();
    await scroller.waitFor();
    const left = () => scroller.evaluate((el) => (el as unknown as { scrollLeft: number }).scrollLeft);
    const wide = await scroller.evaluate((el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth > (el as unknown as { clientWidth: number }).clientWidth);
    assert.ok(wide, "FL-14: the quick dice fit at 320 px, so nothing scrolls");
    const row = await rectOf(scroller);
    const y = row.top + row.height / 2;
    // A swipe left scrolls them.
    await backSwipe(dmCdp, { x: row.right - 30, y }, -160);
    await waitFor("FL-14: the quick dice to scroll", async () => ((await left()) > 0 ? true : null), 3_000);
    // Scrolled, a swipe right scrolls them back and the panel stays.
    const scrolled = await left();
    await backSwipe(dmCdp, { x: row.left + 40, y }, 60);
    await waitFor("FL-14: the quick dice to scroll back", async () => ((await left()) < scrolled ? true : null), 3_000);
    assert.equal(await list.count(), 0, "FL-14: a swipe on scrolled quick dice went back");
    await scroller.evaluate((el) => {
      (el as unknown as { scrollLeft: number }).scrollLeft = 0;
    });
    // At their left edge, a swipe right is the panel's.
    await backSwipe(dmCdp, { x: row.left + 40, y }, 8 + (await rectOf(sheet)).width / 2 + 20);
    await list.waitFor();
    assert.equal(await sheetOf(dm, "Dice").count(), 0, "FL-14: a swipe right at the quick dice' left edge did not go back");
    // A held Roll opens its one-roll menu, and the finger that held it drifts right without going back.
    await list.getByRole("button", { name: "Dice", exact: true }).click();
    await dm.locator('section[aria-label="Dice"]').waitFor();
    sheet = sheetOf(dm, "Dice");
    await steadyRect(sheet);
    await sheet.getByLabel("Dice formula").fill("1d20");
    await sheet.getByLabel("Dice formula").blur();
    const roll = sheet.getByRole("button", { name: /^Roll\b/ }).first();
    const at = await middleOf(roll);
    const f = new Finger(dmCdp, dm);
    await f.down(at);
    await f.rest(650);
    await waitFor("FL-14: the one-roll menu to open", async () => ((await dm.locator("[data-roll-mode-menu]").count()) > 0 ? true : null), 3_000);
    await f.drag(0, { dx: 200 });
    assert.equal(await translateXOf(movingBody(sheet)), 0, "FL-14: the held finger moved the page");
    await f.up();
    assert.equal(await list.count(), 0, "FL-14: a fired hold's drift went back");
    assert.equal(await sheet.count(), 1);
    await dm.keyboard.press("Escape");
    await sheet.getByLabel("Dice formula").fill("");
    await sheet.getByRole("button", { name: "Close Dice" }).click();
  });

  test("fl14-d. on a page inside a panel the swipe goes back to the panel, unsaved words spring it back, and with reduced motion it goes back within a frame", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    let sheet = await openPanel(dm, "Menu");
    await steadyRect(sheet);
    await sheet.getByRole("button", { name: /^Members/ }).first().click();
    await sheet.getByRole("heading", { name: "Members" }).waitFor();
    await backSwipe(dmCdp, await leftBodyPoint(sheet), 8 + (await rectOf(sheet)).width / 2 + 20);
    await waitFor("FL-14: Menu's first page", async () => ((await sheet.getByRole("heading", { name: "Members" }).count()) === 0 ? true : null), 3_000);
    assert.equal(await sheet.count(), 1, "FL-14: a swipe on a subpage left the panel");
    assert.equal(await dm.getByRole("region", { name: "Panels" }).count(), 0, "FL-14: a swipe on a subpage went to Panels");
    await sheet.getByRole("button", { name: "Close Menu" }).click();
    // A message typed and not sent: it springs back with the words kept.
    sheet = await openPanel(dm, "Log");
    await steadyRect(sheet);
    const message = sheet.getByLabel("Message");
    await message.fill("FL-14 unsent");
    await message.blur();
    await backSwipe(dmCdp, await leftBodyPoint(sheet), 8 + (await rectOf(sheet)).width / 2 + 60);
    assert.equal(await pageSettled(movingBody(sheet)), "rest");
    assert.equal(await sheet.count(), 1, "FL-14: unsaved words let the swipe go back");
    assert.equal(await message.inputValue(), "FL-14 unsent");
    await message.fill("");
    await message.blur();
    await sheet.getByRole("button", { name: "Close Log" }).click();
    await dm.emulateMedia({ reducedMotion: "reduce" });
    try {
      sheet = await openPanel(dm, "Log");
      await steadyRect(sheet);
      await backSwipe(dmCdp, await leftBodyPoint(sheet), 8 + (await rectOf(sheet)).width / 2 + 20);
      await dm.evaluate(() => new Promise((resolve) => (globalThis as unknown as { requestAnimationFrame(fn: () => void): void }).requestAnimationFrame(() => resolve(null))));
      assert.equal(await sheet.count(), 0, "FL-14: the panel still showed a frame after the lift");
      await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Close Panels" }).click();
    } finally {
      await dm.emulateMedia({ reducedMotion: "no-preference" });
    }
  });
});

/** A point in the sheet's body near its left side, clear of the system's edge zone, so a swipe right has the panel's width to travel. */
async function leftBodyPoint(sheet: Locator, down = 60): Promise<Pt> {
  const r = await rectOf(sheet.locator("[data-pane-body]").first());
  return { x: Math.max(r.left + 16, 40), y: r.top + down };
}

/** A whole swipe sideways: down at `from`, `dx` in 10 px steps (slow: 30 ms apart, flick: 2 ms), then up. */
async function backSwipe(cdp: CDPSession, from: Pt, dx: number, opts: { flick?: boolean } = {}, page: Page = dm): Promise<void> {
  const f = new Finger(cdp, page);
  await f.down(from);
  await f.drag(0, { dx, every: opts.flick ? 2 : 30 });
  await f.up();
}

/** What a back swipe moves: the body's box under the header (components/Sheet.tsx). */
function movingBody(sheet: Locator): Locator {
  return sheet.locator("[data-pane-body]").first().locator("xpath=..");
}

/** How far right the page stands, from its inline transform, in screen px at 100%. */
function translateXOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const m = /translateX\((-?[\d.]+)px\)/.exec((el as unknown as El).style.transform ?? "");
    return m ? Number(m[1]) : 0;
  });
}

/** Waits until a back swipe's slide is over: the page gone, or at rest with no transform. */
async function pageSettled(page: Locator): Promise<"gone" | "rest"> {
  return settled(page);
}

/** The accessible name of what has focus, as a test compares two routes to one place. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as Win).document.activeElement;
    return a ? `${a.getAttribute("aria-label") ?? ""}|${(a as unknown as { textContent: string | null }).textContent ?? ""}` : "";
  });
}

/** Picks a design in Menu, This device, as a person does, and puts the Menu away: every sheet takes it at once, with no reload. */
async function pickHandle(page: Page, id: GrabberId): Promise<void> {
  const menu = await openPanel(page, "Menu");
  const choice = menu.getByRole("combobox", { name: "Sheet handle" });
  // The Menu opens on the page it showed last.
  if (!(await choice.isVisible())) {
    const back = menu.getByRole("button", { name: /^Back to Menu/ });
    if (await back.isVisible()) await back.click();
    await menu.getByRole("button", { name: /^This device/ }).click();
  }
  await choice.selectOption(id);
  await waitFor(`the Menu's grabber to become ${id}`, async () => ((await designOf(menu.locator("[data-sheet-grabber]"))) === id ? true : null), 3_000);
  await menu.locator("header").getByRole("button", { name: /^Close/ }).click();
  assert.equal(await settled(menu), "gone", "the Menu did not close");
}

/** Which design a grabber or a preview draws. */
function designOf(locator: Locator): Promise<string | null> {
  return locator.first().getAttribute("data-grabber-design");
}

/** An element's color now, as the browser draws it. */
function colorOf(locator: Locator): Promise<string> {
  return locator.first().evaluate((el) => (globalThis as unknown as Win).getComputedStyle(el as unknown as El).color ?? "");
}

/** An element's color in the second frame from now: a normal fade would still be under way. */
function colorAfterFrame(locator: Locator): Promise<string> {
  return locator.first().evaluate(
    (el) =>
      new Promise<string>((resolve) => {
        const g = globalThis as unknown as Win & { requestAnimationFrame(fn: () => void): number };
        g.requestAnimationFrame(() => g.requestAnimationFrame(() => resolve(g.getComputedStyle(el as unknown as El).color ?? "")));
      }),
  );
}

/** The colors the grabber may take on this page: controlBorder at rest, the member's accent, and the system's muted text and highlight under forced colors. */
function systemColors(page: Page): Promise<{ rest: string; accent: string; grayText: string; highlight: string }> {
  return page.evaluate(() => {
    type Probe = { style: Record<string, string>; remove(): void };
    const g = globalThis as unknown as Win & { document: { createElement(t: string): Probe; body: { appendChild(n: Probe): void } } };
    const read = (color: string) => {
      const probe = g.document.createElement("span");
      probe.style.forcedColorAdjust = "none";
      probe.style.color = color;
      g.document.body.appendChild(probe);
      const out = g.getComputedStyle(probe as unknown as El).color ?? "";
      probe.remove();
      return out;
    };
    return { rest: read("color-mix(in srgb, #76747f 30%, #76747f)"), accent: read("var(--rvtt-accent)"), grayText: read("GrayText"), highlight: read("Highlight") };
  });
}

/** A browser-resolved mix, so rgb() versus color(srgb) serialization cannot disguise a wrong color. */
function mixedGrabberColor(page: Page, pull: number): Promise<string> {
  return page.evaluate((p) => {
    type Probe = { style: Record<string, string>; remove(): void };
    const g = globalThis as unknown as Win & { document: { createElement(t: string): Probe; body: { appendChild(n: Probe): void } } };
    const probe = g.document.createElement("span");
    probe.style.color = `color-mix(in srgb, var(--rvtt-accent) calc(30% + ${p} * 70%), #76747f)`;
    g.document.body.appendChild(probe);
    const color = g.getComputedStyle(probe as unknown as El).color ?? "";
    probe.remove();
    return color;
  }, pull);
}

function grabberLook(surface: Locator): Promise<{ color: string; matrix: number[]; pull: number; property: string; duration: string; surfaceVars: string[] }> {
  return surface.evaluate((el) => {
    const g = globalThis as unknown as Win;
    const node = el as unknown as El;
    const drawing = node.querySelector("[data-sheet-grabber]");
    if (!drawing) throw new Error("the sheet has no grabber");
    const style = g.getComputedStyle(drawing);
    const transform = style.transform ?? "";
    const matrix = transform === "none" ? [1, 0, 0, 1, 0, 0] : (transform.match(/^matrix\(([^)]+)\)$/)?.[1] ?? "").split(",").map(Number);
    const props = (drawing as unknown as { style: { getPropertyValue(name: string): string } }).style;
    const outerProps = (el as unknown as { style: { getPropertyValue(name: string): string } }).style;
    const surfaceVars = ["--rvtt-grabber-held", "--rvtt-grabber-pull", "--rvtt-grabber-stretch", "--rvtt-grabber-transition"].filter((name) => outerProps.getPropertyValue(name) !== "");
    return { color: style.color ?? "", matrix, pull: Number(props.getPropertyValue("--rvtt-grabber-pull")), property: style.transitionProperty ?? "", duration: style.transitionDuration ?? "", surfaceVars };
  });
}

async function checkPull(surface: Locator, expected: number, reduced = false): Promise<void> {
  const look = await waitFor("FL-8: the sheet's pull to follow the touch", async () => {
    const value = await grabberLook(surface);
    return Math.abs(value.pull - expected) < 0.01 ? value : null;
  }, 3_000).catch(async (error: unknown) => {
    throw new Error(`FL-8: expected pull ${expected}, got ${JSON.stringify(await grabberLook(surface))}, held=${await surface.getAttribute("data-sheet-held")}, transform=${await transformOf(surface)}`, { cause: error });
  });
  assert.equal(look.color, await mixedGrabberColor(surface.page(), look.pull), `FL-8: wrong mix at pull ${look.pull}`);
  assert.equal(look.property, "none", "FL-8: a transition trails the finger");
  assert.deepEqual(look.surfaceVars, [], "FL-8: the sheet's content inherits changing grabber properties");
  const stretch = reduced ? 0 : look.pull;
  const matrix = [1 + 0.4 * stretch, 0, 0, 1 - 0.25 * stretch, 0, 0];
  assert.equal(look.matrix.length, 6, "FL-8: the drawing has no valid scale transform");
  matrix.forEach((value, i) => assert.ok(Math.abs(look.matrix[i]! - value) < 0.0001, `FL-8: wrong scale at pull ${look.pull}: ${look.matrix}`));
}

/**
 * The upward claim removes the sheet's border once, as it takes the full
 * screen's box. Compare the header with that box's content edges, and its
 * controls with the header, so only this existing shape change is allowed.
 */
function headerLayout(surface: Locator) {
  return surface.evaluate((el) => {
    const g = globalThis as unknown as Win;
    const sheet = el as unknown as El;
    const header = sheet.querySelector("header[data-sheet-grab]") as (El & { querySelectorAll(s: string): ArrayLike<El> }) | null;
    if (!header) throw new Error("the sheet has no grab header");
    const outer = sheet.getBoundingClientRect();
    const box = header.getBoundingClientRect();
    const style = g.getComputedStyle(sheet);
    const scale = Number(style.zoom) || 1;
    const px = (name: string) => parseFloat(style[name] ?? "0") * scale;
    const border = { left: px("borderLeftWidth"), right: px("borderRightWidth"), top: px("borderTopWidth") };
    const padding = { left: px("paddingLeft"), right: px("paddingRight"), top: px("paddingTop") };
    const child = (node: El) => {
      const r = node.getBoundingClientRect();
      return { name: node.getAttribute("aria-label"), left: r.left - box.left, right: box.right - r.right, top: r.top - box.top, width: r.width, height: r.height };
    };
    const title = header.querySelector("h2, h3");
    if (!title) throw new Error("the grab header has no title");
    return {
      sheetWidth: outer.width,
      border, padding,
      insetLeft: border.left + padding.left, insetRight: border.right + padding.right, insetTop: border.top + padding.top,
      left: box.left - outer.left, right: outer.right - box.right, top: box.top - outer.top,
      width: box.width, height: box.height,
      title: child(title),
      buttons: Array.from(header.querySelectorAll("button")).map(child).filter((b) => b.width > 2 && b.height > 2),
    };
  });
}

function checkHeaderLayout(before: Awaited<ReturnType<typeof headerLayout>>, after: Awaited<ReturnType<typeof headerLayout>>, design: string, rising: boolean): void {
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1, `FL-8 ${design}: ${what}: ${a} versus ${b}. Before: ${JSON.stringify(before)}. After: ${JSON.stringify(after)}`);
  for (const side of ["left", "right", "top"] as const) {
    near(after.padding[side], before.padding[side], `sheet ${side} padding changed`);
    near(after.border[side], rising ? 0 : before.border[side], `sheet ${side} border changed unexpectedly`);
  }
  near(after.sheetWidth, before.sheetWidth, "sheet width changed");
  near(after.width + after.insetLeft + after.insetRight, before.width + before.insetLeft + before.insetRight, "header width changed beyond the sheet's borders and padding");
  near(after.width, after.sheetWidth - after.insetLeft - after.insetRight, "header does not fill the content width");
  near(after.left, after.insetLeft, "header moved from the content's left edge");
  near(after.right, after.insetRight, "header moved from the content's right edge");
  near(after.top, after.insetTop, "header moved from the content's top edge");
  near(after.height, before.height, "header height changed");
  for (const key of ["left", "right", "top", "height"] as const) near(after.title[key], before.title[key], `title ${key} changed`);
  assert.equal(after.buttons.length, before.buttons.length, "FL-8: the visible header buttons changed");
  before.buttons.forEach((button, i) => {
    const current = after.buttons[i]!;
    assert.equal(current.name, button.name, "FL-8: a header button changed");
    const edge = button.left < button.right ? "left" : "right";
    for (const key of [edge, "top", "width", "height"] as const) near(current[key], button[key], `${button.name} ${key} changed`);
  });
}

async function expectGrabberRest(surface: Locator): Promise<void> {
  const colors = await systemColors(surface.page());
  await waitFor("FL-8: the color and drawing to return to rest", async () => {
    const look = await grabberLook(surface);
    return look.color === colors.rest && look.matrix.length === 6 && look.matrix.every((value, i) => Math.abs(value - [1, 0, 0, 1, 0, 0][i]!) < 0.0001) ? true : null;
  }, 1_000);
  assert.equal(await surface.getAttribute("data-sheet-held"), null);
  assert.equal((await grabberLook(surface)).pull, 0);
}

/** Opens the page called Notes that says `text`, of the two that share the title. */
async function openNotes(sheet: Locator, text: string): Promise<void> {
  // The panel opens at the page it showed last.
  const back = sheet.getByRole("button", { name: /^Back to Journal/ });
  if ((await back.count()) > 0) await back.click();
  for (const i of [0, 1]) {
    await sheet.getByRole("button", { name: /^Notes/ }).nth(i).click();
    const shown = await waitFor("a Notes page to open", async () => {
      if (await sheet.getByText("The first page.").isVisible()) return "The first page.";
      if (await sheet.getByText("The second page.").isVisible()) return "The second page.";
      return null;
    });
    if (shown === text) return;
    await sheet.getByRole("button", { name: /^Back to Journal/ }).click();
  }
  assert.fail(`no Notes page says ${text}`);
}

/** Opens the pane of the label at `index` (test 0 placed them) in the builder's Label mode, by a tap on it. */
async function openLabel(index: number): Promise<Locator> {
  await pickTool(dm, "Map builder");
  await pickOption(dm, "Map builder", "Builder mode", "Label");
  const at = await cellPoint(dm, { x: 3 + 4 * index, y: 6 });
  await touchTap(dmCdp, dm, at);
  const pane = dm.getByRole("dialog", { name: "Edit label" });
  await pane.waitFor();
  return pane;
}

/** Swipes the panel sheet up from its header until it fills the screen, as test 12 does, and returns its box at the normal height. */
async function fillScreen(sheet: Locator, scale: number, where: string): Promise<Rect> {
  const normal = await steadyRect(sheet);
  await swipe(dmCdp, await headerPoint(sheet), -(16 + stepOf(normal.top, scale) + 12));
  await waitFor(`${where}: the sheet to fill the screen`, async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
  assert.equal(await settled(sheet), "rest");
  return normal;
}

type CornerPage = { requestAnimationFrame(fn: () => void): number; getComputedStyle(el: unknown): { borderTopLeftRadius: string; borderTopRightRadius: string } };

/** The sheet's two top corner radii as the browser draws them now, in its own pixels. */
function topCorners(sheet: Locator): Promise<string[]> {
  return sheet.evaluate((el) => {
    const style = (globalThis as unknown as CornerPage).getComputedStyle(el);
    return [style.borderTopLeftRadius, style.borderTopRightRadius];
  });
}

/** Reads the sheet's top corners on every frame while it shows, from now until the returned stop, which gives each pair seen. */
async function sampleCorners(sheet: Locator): Promise<() => Promise<string[]>> {
  const key = `__corners${Math.random().toString(36).slice(2, 8)}`;
  await sheet.evaluate((el, k) => {
    const g = globalThis as unknown as CornerPage & Record<string, { seen: Set<string>; on: boolean }>;
    const state = { seen: new Set<string>(), on: true };
    g[k] = state;
    const tick = () => {
      if (!state.on) return;
      if ((el as unknown as { getClientRects(): ArrayLike<unknown> }).getClientRects().length > 0) {
        const style = g.getComputedStyle(el);
        state.seen.add(`${style.borderTopLeftRadius} ${style.borderTopRightRadius}`);
      }
      g.requestAnimationFrame(tick);
    };
    tick();
  }, key);
  return () =>
    sheet.page().evaluate((k) => {
      const state = (globalThis as unknown as Record<string, { seen: Set<string>; on: boolean }>)[k]!;
      state.on = false;
      return [...state.seen];
    }, key);
}

/**
 * Every surface that can swipe now, which the swipe marks `data-sheet-swipes`
 * while it is enabled, with the grabbers each shows, and the grabbers shown
 * on no such surface. Read from the swipe's own mark, so a grabber drawn by
 * a condition of its own would show here as a surface with none or a stray.
 */
async function expectGrabbers(page: Page, names: readonly string[], where: string): Promise<void> {
  const audit = await page.evaluate(() => {
    type Node = { getAttribute(n: string): string | null; getClientRects(): ArrayLike<unknown>; closest(s: string): Node | null; querySelectorAll(s: string): ArrayLike<Node> };
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Node> } }).document;
    const shown = (el: Node) => el.getClientRects().length > 0;
    return {
      swiping: Array.from(doc.querySelectorAll("[data-sheet-swipes]"))
        .filter(shown)
        .map((s) => ({ name: s.closest("[aria-label]")?.getAttribute("aria-label") ?? "", grabbers: Array.from(s.querySelectorAll("[data-sheet-grabber]")).filter(shown).length })),
      stray: Array.from(doc.querySelectorAll("[data-sheet-grabber]")).filter((g) => shown(g) && !g.closest("[data-sheet-swipes]")).length,
    };
  });
  assert.deepEqual(audit.swiping.map((s) => s.name).sort(), [...names].sort(), `${where}: the surfaces that swipe`);
  for (const s of audit.swiping) assert.equal(s.grabbers, 1, `${where}: ${s.name} shows ${s.grabbers} grabbers`);
  assert.equal(audit.stray, 0, `${where}: a grabber shows on a surface that does not swipe`);
}

/**
 * The pill against the grab area it sits in (the body it sits on where the
 * surface has none, as the X-card): its box, the top of the area's first line (its
 * buttons, title and text), the area's parts with the pill and without it,
 * and what a touch at the pill's middle lands on.
 */
async function grabberFit(surface: Locator): Promise<{ pill: Rect; area: Rect; surface: Rect; firstLine: number; close: Rect | null; same: boolean; hit: string }> {
  return surface.evaluate((root) => {
    type Node = El & { contains(n: Node | null): boolean; querySelectorAll(s: string): ArrayLike<Node> };
    const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null } }).document;
    const el = root as unknown as Node;
    const pill = el.querySelector("[data-sheet-grabber]") as Node | null;
    if (!pill) throw new Error("the surface has no grabber");
    const area = (pill.closest("[data-sheet-grab]") as Node | null) ?? (pill.closest("div") as Node | null) ?? el;
    const box = (n: El): Rect => {
      const r = n.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    // The visually hidden Expand sheet button is 1 px square: no line of its own.
    const parts = () => Array.from(area.querySelectorAll("button, h2, h3, strong, p, input")).map(box).filter((r) => r.width > 2 && r.height > 2);
    const p = box(pill);
    const at = doc.elementFromPoint((p.left + p.right) / 2, (p.top + p.bottom) / 2);
    const before = JSON.stringify([box(area), ...parts()]);
    pill.style.display = "none";
    const after = JSON.stringify([box(area), ...parts()]);
    pill.style.display = "";
    const close = area.querySelector('button[aria-label^="Close"]');
    return {
      pill: p,
      area: box(area),
      surface: box(el),
      firstLine: Math.min(...parts().map((r) => r.top)),
      close: close ? box(close) : null,
      same: before === after,
      hit: at === pill ? "the pill" : at && area.contains(at) ? "area" : "elsewhere",
    };
  });
}

/**
 * The pill is its design's size at the interface size (36 x 4 for the
 * default ringed tail), centered, on a grab area
 * that starts at the surface's top edge (inside its 1 px border, or at the
 * screen's top in full screen, where the sheet has none), 5 px under that
 * edge on every surface alike, at least 1 px above its first line, moves
 * nothing, and lets a touch through to the header.
 */
async function checkFit(surface: Locator, scale: number, where: string, size = { width: 36, height: 4 }): Promise<Awaited<ReturnType<typeof grabberFit>>> {
  const fit = await grabberFit(surface);
  const say = `${where}: ${JSON.stringify(fit)}`;
  assert.ok(Math.abs(fit.pill.width - size.width * scale) < 0.6 && Math.abs(fit.pill.height - size.height * scale) < 0.6, `the pill's size, ${say}`);
  assert.ok(Math.abs((fit.pill.left + fit.pill.right) / 2 - (fit.surface.left + fit.surface.right) / 2) < 1, `the pill is off center, ${say}`);
  assert.ok(fit.area.top >= fit.surface.top - 0.5 && fit.area.top <= fit.surface.top + 1.5 * scale, `the grab area does not start at the surface's top edge, ${say}`);
  assert.ok(Math.abs(fit.pill.top - fit.area.top - 5 * scale) < 0.6, `the pill is not 5 px under the surface's top edge, ${say}`);
  assert.ok(fit.pill.bottom <= fit.firstLine - scale + 0.5, `the pill comes within 1 px of the header's buttons, title or text, ${say}`);
  assert.ok(fit.same, `the pill moves the header's title or buttons, ${say}`);
  assert.equal(fit.hit, "area", `a touch on the pill does not reach the header under it, ${say}`);
  return fit;
}

/** A label, pin or light pane as a sheet: one pill, its close 11 px down (1 px border, 4 px padding, 4 px for the pill, 2 px over a 44 px button), and closed by a tap on its close. */
async function checkPane(pane: Locator, scale: number, where: string, shot: string): Promise<void> {
  await steadyRect(pane);
  await expectGrabbers(dm, [(await pane.getAttribute("aria-label")) ?? ""], where);
  const fit = await checkFit(pane, scale, where);
  assert.ok(fit.close && Math.abs(fit.close.top - fit.surface.top - 11 * scale) < 0.6, `${where}: its close is not 11 px down: ${JSON.stringify(fit)}`);
  await shots.take(dm, shot);
  await touchTap(dmCdp, dm, await middleOf(pane.getByRole("button", { name: /^Close/ }).first()));
  assert.equal(await settled(pane), "gone", `${where}: a tap on its close did not close it`);
}

/**
 * A screenshot with the browser asking for a dark scheme and one asking
 * for light. The app draws one dark theme (a light theme is a later item,
 * docs/features.md), so the two match: the light one shows that a light
 * preference changes nothing.
 */
async function shotsInBothSchemes(page: Page, name: string): Promise<void> {
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await shots.take(page, name);
    await page.emulateMedia({ colorScheme: "light" });
    await shots.take(page, `${name}-light-scheme`);
  } finally {
    await page.emulateMedia({ colorScheme: null });
  }
}
