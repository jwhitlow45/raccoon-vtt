import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, pickOption, pickTool, readCamera, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

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
 * It runs with `pnpm test:e2e` on E2E_PORT plus eighteen, the next free
 * offset after the split panel's seventeen, one file after another.
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
    await waitFor("the page to hear the lift", async () => (await lifts(this.page)) > before || null, 3_000);
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

  test("1. the panel sheet: a slow header drag past the distance closes it as Close does, short of it springs back", async () => {
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
      const distance = Math.max(before.height / 4, 44 * view.scale);
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
      // Short of it: springs back, and at rest no transform is left.
      await swipe(dmCdp, from, 8 + distance - 12);
      assert.equal(await settled(sheet), "rest", `${where}: a short drag closed the sheet`);
      assert.deepEqual(await rectOf(sheet), before, `${where}: the sheet is not back in its place`);
      const overlay = await dm.evaluate(() => (globalThis as unknown as Win).history.state);
      // Past it: closes after its slide, with the Back entry gone as after Close.
      await swipe(dmCdp, from, 8 + distance + 12);
      assert.equal(await settled(sheet), "gone", `${where}: a drag past the distance left the sheet open`);
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
    await swipe(dmCdp, await middleOf(button(sheet)), 8 + rest.height / 4 + 12);
    assert.equal(await settled(sheet), "gone", "a slow content drag past the distance");
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
    await swipe(dmCdp, await headerPoint(list), 8 + r.height / 4 + 20);
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

    // The Scenes panel's slider moves under a sideways drag.
    sheet = await openPanel(dm, "Scenes");
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
    await swipe(dmCdp, await headerPoint(sheet), 8 + Math.max(h.height / 4, 44) + 12);
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
    await swipe(dmCdp, await middleOf(sheet.getByRole("button", { name: "Export" })), 8 + log.height / 4 + 12);
    assert.equal(await settled(sheet), "rest", "a content drag moved the sheet while a field took typing");
    await swipe(dmCdp, await headerPoint(sheet), 8 + log.height / 4 + 12);
    assert.equal(await settled(sheet), "gone", "a header drag with nothing typed left the sheet open");
  });

  test("5. a second finger on the map while the first rests past the distance springs it back, and a held press is never a swipe", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    let sheet = await openPanel(dm, "Log");
    const rest = await steadyRect(sheet);
    const f = new Finger(dmCdp, dm);
    await f.down(await headerPoint(sheet));
    await f.drag(8 + rest.height / 4 + 40);
    await f.rest(100);
    await f.second(mapPoint());
    await f.up(100);
    assert.equal(await settled(sheet), "rest", "a second finger did not cancel the swipe");
    assert.deepEqual(await rectOf(sheet), rest);
    await sheet.getByRole("button", { name: "Close Log" }).click();
    sheet = await openPanel(dm, "Monsters");
    const monsters = await steadyRect(sheet);
    await swipe(dmCdp, await middleOf(sheet.getByRole("button", { name: "Paste a stat block" })), 8 + monsters.height / 4 + 40, { hold: 500 });
    assert.equal(await settled(sheet), "rest", "a held press swiped the sheet");
    assert.deepEqual(await rectOf(sheet), monsters);
    await sheet.getByRole("button", { name: "Close Monsters" }).click();
  });

  test("6. unsaved input springs back with what was typed kept, and with nothing typed each closes", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const far = (r: Rect) => 8 + Math.max(r.height / 4, 44) + 30;
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
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await add.click();
    await companion.waitFor();
    await swipe(dmCdp, await headerPoint(sheet), far(await steadyRect(sheet)));
    assert.equal(await settled(sheet), "gone", "an untouched companion form kept the sheet open");

    // Request a roll with its DC typed, over the room.
    await touchTap(dmCdp, dm, await cellPoint(dm, run.thorn));
    const bar = dm.getByRole("dialog", { name: "Thorn actions" });
    await bar.getByRole("button", { name: "Request a roll", exact: true }).click();
    let ask = dm.getByRole("dialog", { name: "Request a roll" }).locator("section").first();
    await ask.waitFor();
    await ask.getByLabel(/^DC/).fill("13");
    await ask.getByLabel(/^DC/).blur();
    await swipe(dmCdp, await headerPoint(ask), far(await steadyRect(ask)));
    assert.equal(await settled(ask), "rest", "a changed request let the sheet close");
    assert.equal(await ask.getByLabel(/^DC/).inputValue(), "13");
    await ask.getByRole("button", { name: "Cancel" }).click();
    await bar.getByRole("button", { name: "Request a roll", exact: true }).click();
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
  });

  test("7. a dialog sheet over a panel closes alone, the X-card dismisses, and from 600 px a dialog's card does not swipe", async () => {
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const sheet = await openPanel(dm, "Monsters");
    await steadyRect(sheet);
    const opener = sheet.getByRole("button", { name: "Filters" });
    await opener.click();
    const filters = dm.getByRole("dialog", { name: "Monster filters" }).locator("section").first();
    await filters.waitFor();
    await swipe(dmCdp, await headerPoint(filters), 8 + Math.max((await steadyRect(filters)).height / 4, 44) + 20);
    assert.equal(await settled(filters), "gone", "the filters stayed");
    assert.ok(await sheet.isVisible(), "the Monsters panel closed with its filters");
    await waitFor("focus back on Filters", async () => (await opener.evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El))) || null, 3_000);
    await sheet.getByRole("button", { name: "Close Monsters" }).click();

    // The X-card, which has no header: a drag down on the card dismisses it.
    const sent = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
    assert.ok(sent.ok(), `the X-card answered ${sent.status()}`);
    const card = dm.getByRole("dialog", { name: "X-card" }).locator("section").first();
    await card.waitFor();
    const c = await steadyRect(card);
    await swipe(dmCdp, { x: c.left + c.width / 2, y: c.top + 30 }, 8 + Math.max(c.height / 4, 44) + 20);
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
    await f.drag(8 + rest.height / 4 + 20);
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
    await player.getByRole("dialog", { name: "Thorn actions" }).getByRole("button", { name: "Multi-select", exact: true }).tap();
    const request = randomUUID();
    await ops.send({ t: "roll.ask", request: { id: request, test: { kind: "save", choices: [{ ability: "con" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
    const card = player.getByRole("dialog", { name: "The DM asks for a roll" });
    await card.waitFor();
    const total = card.getByRole("textbox").first();
    await total.fill("14");
    await total.blur();
    const cardRest = await steadyRect(card);
    await player.getByRole("toolbar", { name: /options$/ }).first().waitFor();
    assert.ok(cardRest.bottom < (await toolbarTop(player)) - 20, `the card does not stand on Multi-select's bar: ${JSON.stringify(cardRest)}`);
    const g = new Finger(playerCdp, player);
    await g.down(await headerPoint(card));
    await g.drag(8 + Math.max(cardRest.height / 4, 44) + 20);
    await g.up();
    const slide = Number(await card.getAttribute("data-sheet-swipe-to"));
    const screen = await player.evaluate(() => (globalThis as unknown as Win).innerHeight);
    assert.ok(cardRest.top + slide >= screen - 0.5, `the card's slide stops above the screen's foot: ${JSON.stringify({ cardRest, slide, screen })}`);
    assert.equal(await settled(card), "gone", "the card did not fold");
    const chip = player.getByRole("button", { name: /^Con save/ }).first();
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
      await swipe(dmCdp, await headerPoint(pane), 8 + Math.max(r.height / 4, 44) + 20);
      assert.equal(await settled(pane), "gone", `${view.width} x ${view.height}: the label pane stayed`);
    }
    // A second label tapped during the closing slide: its pane stays open.
    await setUp(dm, { width: 375, height: 667, scale: 1 });
    const first = await openLabel(0);
    const r = await steadyRect(first);
    const second = await cellPoint(dm, { x: 7, y: 6 });
    await swipe(dmCdp, await headerPoint(first), 8 + Math.max(r.height / 4, 44) + 20);
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
    await swipe(dmCdp, await headerPoint(sheet), 8 + page.height / 4 + 20);
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
    await f.drag(opened.height / 4 + 20);
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
      await swipe(dmCdp, await headerPoint(sheet), 8 + r.height / 4 + 20);
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
      const step = Math.max(44 * view.scale, up / 4);
      const fullScreen = sheet.getByRole("button", { name: "Full screen" });
      assert.equal(await fullScreen.getAttribute("aria-pressed"), "false");
      // Short of a quarter: back to normal.
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
      await swipe(dmCdp, await headerPoint(sheet), 8 + up + Math.max(normal.height / 4, 44 * view.scale) + 12);
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
    await swipe(dmCdp, await headerPoint(sheet), 8 + normal.top + normal.height / 4 + 40);
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
    await swipe(dmCdp, await headerPoint(sheet), -(16 + Math.max(44, monsters.top / 4) + 12));
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
    await swipe(dmCdp, await middleOf(sheet.getByRole("button", { name: "Paste a stat block" })), 8 + Math.max(44, monsters.top / 4) + 12);
    await waitFor("a content drag to step down", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    await settled(sheet);
    await swipe(dmCdp, await headerPoint(sheet), -(16 + Math.max(44, monsters.top / 4) + 12));
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
    await f.drag(-(Math.max(44, normal.top / 4)));
    await f.up();
    await waitFor("full", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    await settled(sheet);
    await sheet.getByRole("button", { name: /^Show Goblin 1 actions/ }).waitFor();
    assert.equal(await dock.count(), 0, "the dock stayed on the edge of a full sheet");
    await shots.take(dm, "swipe-full-fight-dock-in-header");
    await swipe(dmCdp, await headerPoint(sheet), 8 + Math.max(44, normal.top / 4) + 12);
    await waitFor("the step down", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    await settled(sheet);
    await dock.waitFor();
    assert.deepEqual(await readCamera(dm), camera, "the camera moved");
    await sheet.getByRole("button", { name: "Close Log" }).click();
    await ops.send({ t: "encounter.end" });
  });

  test("12d. full screen on a tablet survives a turn past 900 px and back, a tap on Close that drifts up closes once, and the Full screen button does both ways by keyboard", async () => {
    for (const view of [
      { width: 834, height: 1194 },
      { width: 768, height: 1024 },
    ]) {
      await setUp(dm, { ...view, scale: 1 });
      const sheet = await openPanel(dm, "Log");
      await steadyRect(sheet);
      await sheet.getByRole("button", { name: "Full screen" }).focus();
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
    // By keyboard: Tab shows Full screen, Enter fills the screen, Enter again steps down, and focus stays on it.
    sheet = await openPanel(dm, "Log");
    const normal = await steadyRect(sheet);
    const button = sheet.getByRole("button", { name: "Full screen" });
    await button.focus();
    assert.ok((await rectOf(button)).width >= 44, "Full screen does not show with focus");
    await dm.keyboard.press("Enter");
    await waitFor("full", async () => (await sheet.getAttribute("aria-modal")) === "true" || null, 3_000);
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await button.evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El)), true, "focus left Full screen");
    await dm.keyboard.press("Enter");
    await waitFor("normal", async () => (await sheet.getAttribute("aria-modal")) === null || null, 3_000);
    assert.equal(await button.evaluate((el) => (globalThis as unknown as Win).document.activeElement === (el as unknown as El)), true, "focus left Full screen");
    assert.deepEqual(await steadyRect(sheet), normal);
    await sheet.getByRole("button", { name: "Close Log" }).click();
  });
});

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
