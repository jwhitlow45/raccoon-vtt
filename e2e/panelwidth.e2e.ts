import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, pickOption, pickTool, readCamera, reopenRoom, Shots, SocketWatch, startServer, Touches, touchSwipe, waitFor, type Server } from "./harness.ts";

/**
 * A side panel that resizes, and a sheet a mouse can grow and shrink
 * (docs/design/design-v1-panel-size.md 4, 5, 8 and 9), on the real server
 * serving the production build. Each half builds its own room.
 *
 * The side panel's half (PS-A, steps pa-0 to pa-10, the design's pw
 * cases): the drag and its release, Escape, S and the slop, Reset width and
 * the double-click, the keys, the bounds at each window and interface size,
 * the top bar giving way by its own width, the map's controls keeping their
 * presses at its right edge, a finger on a touch tablet, and the panel's
 * rows measured at 360 and at the cap.
 *
 * The sheet's half (PS-B, steps 0 and sm-1 to sm-6): where any pointer is
 * fine, a sheet that swipes shows Up and Down beside its grabber, which step
 * it between its stands with the slide a release plays, and a mouse drags
 * the strip around the grabber through the same machine a finger swipes
 * with. One press owns the sheet at a time, a finger's or a mouse's. A
 * phone's finger sees none of it. Chromium's touch emulation reports a
 * coarse pointer only, so the touch laptop (sm-6) stubs `matchMedia` for
 * `(any-pointer: fine)` in an init script.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus fifty-two, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 52;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-panelwidth-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;

// The side panel's half (PS-A).

const KEY = "rvtt.sidePanelWidth";
const DESK = { width: 1440, height: 900 };

let wideDmContext: BrowserContext;
let widePatContext: BrowserContext;
let wideDm: Page;
let widePat: Page;
let wideOps: OpSocket;
const wideDmSocket = new SocketWatch("edge dm");
const widePatSocket = new SocketWatch("edge pat");
const wideDmConsole = new ConsoleWatch("edge dm");
const widePatConsole = new ConsoleWatch("edge pat");

const wideRun = {
  roomId: "",
  roomName: `E2E panel edge ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  password: "",
  thornChar: randomUUID(),
  thorn: randomUUID(),
  goblins: Array.from({ length: 6 }, () => randomUUID()),
  phases: [randomUUID(), randomUUID()],
};

function fighter(hp: number, extra: Record<string, unknown> = {}) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...extra };
}

function picture(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 500, height: 400, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

/** Runs code in the page and hands back what it returns. */
function js<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(() => { ${body} })()`) as Promise<T>;
}

const edge = (page: Page) => page.getByRole("separator", { name: "Side panel width" });
const aside = (page: Page) => page.locator('aside:has([role="tablist"][aria-label="Panels"])');
const resetWidth = (page: Page) => aside(page).getByRole("button", { name: "Reset width", exact: true });
const topBar = (page: Page) => page.locator("header[data-rvtt-topbar]");

/** What this device stores, as the page reads it. */
const stored = (page: Page) => js<string | null>(page, `return localStorage.getItem(${JSON.stringify(KEY)});`);

/** The panel's drawn width in layout px, from the aside's box and the interface size's zoom, to the nearest px the page's own rounding of the zoomed box allows. */
async function drawn(page: Page): Promise<number> {
  return js<number>(page, `const a = document.querySelector("aside"); const z = a.currentCSSZoom || 1; return Math.round(a.getBoundingClientRect().width / z);`);
}

async function valueNow(page: Page): Promise<{ now: number; max: number; min: number; text: string | null }> {
  const e = edge(page);
  return { now: Number(await e.getAttribute("aria-valuenow")), max: Number(await e.getAttribute("aria-valuemax")), min: Number(await e.getAttribute("aria-valuemin")), text: await e.getAttribute("aria-valuetext") };
}

/** Reloads at an interface size, with what this device stores of the width and the theme, and waits for the room and its side panel. */
async function reloadAt(page: Page, opts: { scale?: number; width?: string | null; theme?: "dark" | "light" } = {}): Promise<void> {
  await page.evaluate(
    ({ scale, width, theme, key }) => {
      const store = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } }).localStorage;
      store.setItem("rvtt.uiScale", String(scale));
      store.setItem("rvtt.theme", theme);
      store.removeItem("rvtt.sidePanel");
      if (width === undefined) return;
      if (width === null) store.removeItem(key);
      else store.setItem(key, width);
    },
    { scale: opts.scale ?? 1, width: opts.width, theme: opts.theme ?? "dark", key: KEY },
  );
  await reopenRoom(page);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
  await page.waitForTimeout(300);
}

async function size(page: Page, s: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(s);
  await page.waitForTimeout(250);
}

/** The edge's press point: on its strip at a third of the aside's height, clear of the grip and of the map's bars. */
async function edgePoint(page: Page): Promise<{ x: number; y: number }> {
  const box = (await edge(page).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 3 };
}

/** Presses the edge with the mouse and moves it `dx` screen px in `steps` moves. The caller releases, or not. */
async function pressAndMove(page: Page, dx: number, steps = 10): Promise<{ x: number; y: number }> {
  const at = await edgePoint(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + dx, at.y, { steps });
  return at;
}

async function dragEdge(page: Page, dx: number, steps = 10): Promise<void> {
  await pressAndMove(page, dx, steps);
  await page.mouse.up();
  await page.waitForTimeout(100);
}

/** The world point at the middle of the map's canvas. */
async function mapCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".konvajs-content").first().boundingBox())!;
  const cam = (await readCamera(page))!;
  return { x: (box.width / 2 - cam.x) / cam.scale, y: (box.height / 2 - cam.y) / cam.scale };
}

/** What the DM's top bar holds now, among the parts that give way: the clock's chip, the DM chip's name, Full screen and the Phase menu. */
async function barParts(page: Page): Promise<string[]> {
  const bar = topBar(page);
  const parts: string[] = [];
  if ((await bar.locator("button", { hasText: /^Day \d/ }).count()) > 0) parts.push("clock");
  if ((await bar.getByText("DM", { exact: true }).count()) > 0) parts.push("dm-name");
  if ((await bar.getByRole("button", { name: "Full screen", exact: true }).count()) > 0) parts.push("fullscreen");
  if ((await bar.getByLabel("Map phase").count()) > 0) parts.push("phase");
  return parts;
}

/** Whether a player's chip shows only its dot, the you menu's round button. */
async function chipIsDot(page: Page): Promise<boolean> {
  return (await topBar(page).locator('[data-chip="you"][data-chip-form="dot"]').count()) > 0;
}

/** What takes a press at a point: the edge, or the tag and role of what does. */
function pressedAt(page: Page, p: { x: number; y: number }): Promise<string> {
  return js<string>(page, `const el = document.elementFromPoint(${p.x}, ${p.y}); if (!el) return "none"; if (el.closest("[data-panel-edge]")) return "edge"; const ctl = el.closest("button, [role=button], select, nav, header, [role=dialog]"); return ctl ? ctl.tagName.toLowerCase() + ":" + (ctl.getAttribute("aria-label") ?? ctl.getAttribute("role") ?? "") : el.tagName.toLowerCase();`);
}

// The sheet's half (PS-B).

let dmContext: BrowserContext;
let dm: Page;
let playerContext: BrowserContext;
let player: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E panel width ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thorn: { id: randomUUID(), characterId: randomUUID() },
  label: randomUUID(),
  bounds: { w: 30, h: 20 },
};

type Pt = { x: number; y: number };
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
type El = {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Rect;
  style: Record<string, string>;
  textContent: string | null;
  closest(s: string): El | null;
  querySelector(s: string): El | null;
};
type Win = {
  document: { activeElement: El | null; querySelector(s: string): El | null };
  getSelection(): { toString(): string; removeAllRanges(): void } | null;
  getComputedStyle(el: El): Record<string, string>;
  matchMedia(q: string): { matches: boolean };
  requestAnimationFrame(fn: () => void): void;
  addEventListener(type: string, fn: (e: unknown) => void, capture: boolean): void;
  removeEventListener(type: string, fn: (e: unknown) => void, capture: boolean): void;
  localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void };
};

function actor(hp = 7) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30 }, initBonus: 2, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Loads the room at a size and interface size, in a theme, with no side panel stored. */
async function setUp(page: Page, view: { width: number; height: number; scale?: number; theme?: "dark" | "light" }): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  // Storage is the origin's: a fresh page has none until it has loaded one of the app's.
  if (!page.url().startsWith(server.origin)) await page.goto(`${server.origin}/`);
  await page.evaluate(
    ({ s, t }) => {
      const g = globalThis as unknown as Win;
      g.localStorage.setItem("rvtt.uiScale", String(s));
      g.localStorage.setItem("rvtt.theme", t);
    },
    { s: view.scale ?? 1, t: view.theme ?? "dark" },
  );
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

function sheetOf(page: Page, name: string): Locator {
  return page.locator(`dialog[data-rvtt-sheet][aria-label="${name}"]`);
}

/** Opens a panel as a sheet from the list of panels, with a mouse, and returns its dialog. */
async function openPanel(page: Page, name: string): Promise<Locator> {
  await page.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name, exact: true }).click();
  await page.locator(`section[aria-label="${name}"]`).waitFor();
  const sheet = sheetOf(page, name);
  await steadyRect(sheet);
  return sheet;
}

const upOf = (surface: Locator) => surface.locator('[data-sheet-step="up"]');
const downOf = (surface: Locator) => surface.locator('[data-sheet-step="down"]');
const bandOf = (surface: Locator) => surface.locator("[data-sheet-drag-band]");

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

/** Waits until a slide is over: the surface gone, or at rest with no transform. */
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

const isFull = async (sheet: Locator) => (await sheet.getAttribute("aria-modal")) === "true";

/** What has focus: its step side, or its name. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as Win).document.activeElement;
    return a?.getAttribute("data-sheet-step") ?? a?.getAttribute("aria-label") ?? "";
  });
}

/**
 * Presses `button` with the mouse and reads `surface`'s top in the first
 * frames after it, and the place its slide is headed (`data-sheet-swipe-to`).
 * A step with no jump starts its slide where the surface stood.
 */
async function pressAndWatch(button: Locator, surface: Locator): Promise<{ tops: number[]; to: string | null }> {
  const marker = `psb${Math.random().toString(36).slice(2, 8)}`;
  await surface.evaluate((el, key) => {
    const g = globalThis as unknown as Win & Record<string, unknown>;
    const out: { tops: number[]; to: string | null } = { tops: [], to: null };
    g[key] = out;
    const onClick = () => {
      g.removeEventListener("click", onClick, true);
      const frame = (n: number) =>
        g.requestAnimationFrame(() => {
          const node = el as unknown as El;
          out.to ??= node.getAttribute("data-sheet-swipe-to");
          out.tops.push(node.getBoundingClientRect().top);
          if (n > 1) frame(n - 1);
        });
      frame(4);
    };
    g.addEventListener("click", onClick, true);
  }, marker);
  await button.click();
  await sleep(120);
  return button.page().evaluate((key) => (globalThis as unknown as Record<string, { tops: number[]; to: string | null }>)[key]!, marker);
}

/** The grabber's strip as drawn: each part's box, in the page's px. */
type Strip = { header: Rect; grabber: Rect; band: Rect; up: Rect | null; down: Rect; upPill: Rect | null; downPill: Rect; close: Rect | null };

function stripOf(surface: Locator): Promise<Strip> {
  return surface.evaluate((el) => {
    const root = el as unknown as El;
    const r = (sel: string) => root.querySelector(sel)?.getBoundingClientRect() ?? null;
    const header = root.querySelector("[data-sheet-grab]")!;
    const close = header.querySelector('button[aria-label^="Close"]');
    return {
      header: header.getBoundingClientRect(),
      grabber: r("[data-sheet-grabber]")!,
      band: r("[data-sheet-drag-band]")!,
      up: r('[data-sheet-step="up"]'),
      down: r('[data-sheet-step="down"]')!,
      upPill: r('[data-sheet-step="up"] > [data-pill]'),
      downPill: r('[data-sheet-step="down"] > [data-pill]')!,
      close: close?.getBoundingClientRect() ?? null,
    };
  });
}

const mid = (r: Rect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

function near(actual: number, expected: number, what: string, within = 0.6): void {
  assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual}, not ${expected}`);
}

/** The strip's geometry: 44 px tall at the header's top, the grabber, Up's and Down's pills on one center line, the band the grabber's width and 4 px each side, centered on the header. */
async function checkStrip(surface: Locator, scale: number, where: string, up: boolean): Promise<void> {
  const s = await stripOf(surface);
  const line = s.header.top + 22 * scale;
  near(mid(s.grabber).y, line, `${where}: the grabber's middle`);
  near(mid(s.downPill).y, line, `${where}: Down's pill's middle`);
  near(s.down.height, 44 * scale, `${where}: Down's height`);
  near(s.down.width, 44 * scale, `${where}: Down's width`);
  near(s.downPill.width, 32 * scale, `${where}: Down's pill's width`);
  near(s.downPill.height, 24 * scale, `${where}: Down's pill's height`);
  near(s.down.top, s.header.top, `${where}: Down stands at the header's top`);
  near(s.band.width, s.grabber.width + 8 * scale, `${where}: the band`);
  near(mid(s.band).x, mid(s.header).x, `${where}: the band centered on the header`);
  near(mid(s.grabber).x, mid(s.band).x, `${where}: the grabber centered on the band`);
  near(s.down.left, s.band.right, `${where}: Down meets the band`);
  if (up) {
    assert.ok(s.up && s.upPill, `${where}: no Up`);
    near(mid(s.upPill).y, line, `${where}: Up's pill's middle`);
    near(s.up.right, s.band.left, `${where}: Up meets the band`);
  } else assert.equal(s.up, null, `${where}: an Up with no full stand`);
  // The header's row stands under the strip: its buttons start 44 px down, where the row's own 6 px begin.
  if (s.close) near(s.close.top, s.header.top + 44 * scale, `${where}: the row's Close under the strip`, 1);
}

/** No measured misalignment over 1 px in the surface's header. */
async function checkAlignment(surface: Locator, where: string): Promise<void> {
  const lines = alignmentLines(await measureAlignment(surface.locator("[data-sheet-grab]").first()), where);
  assert.deepEqual(lines, [], lines.join("\n"));
}

async function shotsInBothSchemes(page: Page, open: () => Promise<Locator>, view: { width: number; height: number }, name: string): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await setUp(page, { ...view, theme });
    const surface = await open();
    await steadyRect(surface);
    await shots.take(page, `${name}-${theme}`);
  }
}

/** Mouse moves from `from` by `dy` (and `dx`) in 10 px steps, 16 ms apart, the button held. */
async function mouseDrag(page: Page, from: Pt, dy: number, opts: { dx?: number; release?: Pt | null } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dy), Math.abs(opts.dx ?? 0)) / 10));
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(from.x + ((opts.dx ?? 0) * i) / n, from.y + (dy * i) / n);
    await sleep(16);
  }
  if (opts.release) await page.mouse.move(opts.release.x, opts.release.y, { steps: 4 });
  if (opts.release !== null) await page.mouse.up();
}

/** Counts the `pointercancel` events the page dispatches from now on, from the window. */
async function countCancels(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const g = globalThis as unknown as Win & { __cancels?: number };
    if (g.__cancels === undefined) g.addEventListener("pointercancel", () => (g.__cancels = (g.__cancels ?? 0) + 1), true);
    g.__cancels = 0;
  });
  return () => page.evaluate(() => (globalThis as unknown as { __cancels?: number }).__cancels ?? 0);
}

/** A sheet's transform now, "" at rest. */
function transformOf(locator: Locator): Promise<string> {
  return locator.evaluate((el) => (el as unknown as El).style.transform ?? "");
}

/** Gives the page a mouse beside its touch screen, as a touch laptop has: Chromium's touch emulation reports a coarse pointer only. */
function finePointerToo(): void {
  const g = globalThis as unknown as { matchMedia(q: string): unknown };
  const own = g.matchMedia.bind(globalThis);
  g.matchMedia = (q: string) => {
    if (q.replace(/\s+/g, "") !== "(any-pointer:fine)") return own(q);
    return { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true };
  };
}

describe("raccoon-vtt: a side panel that resizes, and a sheet with a mouse", { timeout: 2_100_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(server?.output().split("\n").slice(-40).join("\n"));
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  describe("the side panel that resizes from its edge", () => {
    before(async () => {
      wideDmContext = await browser.newContext({ viewport: DESK });
      widePatContext = await browser.newContext({ viewport: DESK });
      wideDm = await wideDmContext.newPage();
      widePat = await widePatContext.newPage();
      wideDmConsole.attach(wideDm);
      widePatConsole.attach(widePat);
      await wideDmSocket.attach(wideDmContext, wideDm);
      await widePatSocket.attach(widePatContext, widePat);
    });

    after(async () => {
      if (process.env.E2E_DEBUG === "1") for (const c of [wideDmConsole, widePatConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      wideOps?.close();
      if (wideRun.roomId && wideDmContext) {
        try {
          const res = await wideDmContext.request.delete(`${server.origin}/api/rooms/${wideRun.roomId}`, { headers: { Origin: server.origin }, data: { name: wideRun.roomName } });
          if (!res.ok()) console.error(`Deleting room ${wideRun.roomId} answered ${res.status()}`);
        } catch (err) {
          console.error(`Deleting room ${wideRun.roomId} failed`, err);
        }
      }
      await wideDmContext?.close();
      await widePatContext?.close();
    });

    test("pa-0. a DM's room in a fight with six goblins and Pat's Thorn, a running clock and a scene with two phases", async () => {
      await wideDm.goto(`${server.origin}/`);
      await wideDm.getByLabel("Room name").fill(wideRun.roomName);
      await wideDm.getByLabel("Your name").fill("Dana the DM");
      wideRun.password = await wideDm.getByLabel("Player password").inputValue();
      await wideDm.getByRole("button", { name: "Create room" }).click();
      await wideDm.getByRole("heading", { name: "Save your DM link" }).waitFor();
      const link = (await wideDm.locator("code").first().textContent()) ?? "";
      const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
      assert.ok(match, `DM link looks wrong: ${link}`);
      wideRun.roomId = match[1]!.replace("-", "");
      await wideDm.getByLabel("I saved my DM link").check();
      await wideDm.getByRole("button", { name: "Continue to the room" }).click();
      await waitFor("the DM's snapshot", () => wideDmSocket.state);
      wideRun.sceneId = wideDmSocket.state!.meta.playerSceneId!;

      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await widePatContext.request.post(`${server.origin}/api/rooms/${wideRun.roomId}/join`, { headers, data: { password: wideRun.password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await widePatContext.request.post(`${server.origin}/api/rooms/${wideRun.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      wideRun.patId = ((await done.json()) as { member: { id: string } }).member.id;

      const cookie = (await wideDmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
      wideOps = await OpSocket.open({ origin: server.origin, roomId: wideRun.roomId, cookie });
      await wideOps.send({ t: "character.create", character: { id: wideRun.thornChar, name: "Thorn", size: "medium", ownerIds: [wideRun.patId], actor: fighter(24) } });
      await wideOps.send({ t: "token.create", token: { id: wideRun.thorn, sceneId: wideRun.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Thorn", x: 4, y: 6, disposition: "ally", actor: { ref: wideRun.thornChar } } });
      for (const [i, id] of wideRun.goblins.entries()) {
        await wideOps.send({ t: "token.create", token: { id, sceneId: wideRun.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", number: i + 1, x: 10 + (i % 3), y: 4 + Math.floor(i / 3), disposition: "hostile", actor: { inline: fighter(10, { srdId: "goblin-warrior" }) } } });
      }
      const upload = async (rgb: [number, number, number]) => {
        const res = await wideDmContext.request.put(`${server.origin}/api/rooms/${wideRun.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: await picture(rgb) });
        assert.ok(res.ok(), `the upload answered ${res.status()}`);
        return (await res.json()) as { id: string; width: number; height: number };
      };
      const day = await upload([150, 140, 120]);
      const night = await upload([40, 50, 90]);
      await wideOps.send({ t: "scene.setMap", sceneId: wideRun.sceneId, map: { assetId: day.id, widthPx: day.width, heightPx: day.height, cellPx: 25, originPx: { x: 0, y: 0 } } });
      await wideOps.send({
        t: "scene.update",
        sceneId: wideRun.sceneId,
        patch: {
          phases: [
            { id: wideRun.phases[0], name: "Day", assetId: day.id, widthPx: day.width, heightPx: day.height },
            { id: wideRun.phases[1], name: "Night", assetId: night.id, widthPx: night.width, heightPx: night.height },
          ],
        },
      });
      await wideOps.send({ t: "clock.start", id: randomUUID(), at: 2 * 86_400 + 20 * 3600, shown: true, calendar: { kind: "days" } });
      const entries = [{ id: "e-thorn", tokenId: wideRun.thorn, value: 25 }, ...wideRun.goblins.map((tokenId, i) => ({ id: `e-g${i}`, tokenId, value: 20 - i }))];
      await wideOps.send({ t: "encounter.start", entries });
      await wideOps.send({ t: "encounter.next" });
      await waitFor("the fight, the clock and the phases in the DM's view", () => (wideDmSocket.state?.encounter?.entries.length === 7 && wideDmSocket.state.clock && wideDmSocket.state.scenes[wideRun.sceneId]?.phases?.length === 2 ? true : null));

      widePatConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
      await widePat.goto(`${server.origin}/r/${wideRun.roomId}`);
      await widePat.getByRole("status", { name: "Connected" }).first().waitFor();
      await waitFor("Pat's snapshot", () => widePatSocket.state);
      widePatConsole.allow = [];
      await reloadAt(wideDm, { width: null });
      await reloadAt(widePat, { width: null });
      await shots.take(wideDm, "pa-0-default-1440");
    });

    test("pa-1. a drag 140 px left draws 500, stored at its release, the map's center kept, and it stops at 640 and 360 in whole px (pw-1)", async () => {
      assert.equal(await drawn(wideDm), 360);
      assert.deepEqual(await valueNow(wideDm), { now: 360, max: 640, min: 360, text: "360 pixels, the default" });
      assert.equal(await resetWidth(wideDm).count(), 0, "no Reset width at the default");
      // Off the fitted view, so the camera keeps its center as on a window resize rather than refitting.
      await wideDm.keyboard.press("Equal");
      await wideDm.waitForTimeout(400);
      const center = await mapCenter(wideDm);

      // A 140 px drag in 20 steps renders the room on each move. The longest task is logged for the builder (4.4) and not asserted, since a loaded runner's timing would flake.
      await js(wideDm, `window.__longest = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longest = Math.max(window.__longest, e.duration); }).observe({ type: "longtask", buffered: false }); return 0;`);
      await pressAndMove(wideDm, -140, 20);
      assert.equal(await drawn(wideDm), 500, "it follows the pointer while held");
      assert.equal(await stored(wideDm), null, "nothing is stored while the drag is held");
      await wideDm.mouse.up();
      await wideDm.waitForTimeout(150);
      const longest = await js<number>(wideDm, "return window.__longest;");
      console.log(`pa-1: the longest task during the drag took ${longest} ms`);
      assert.equal(await stored(wideDm), "500");
      assert.deepEqual(await valueNow(wideDm), { now: 500, max: 640, min: 360, text: "500 pixels" });
      const after = await mapCenter(wideDm);
      assert.ok(Math.abs(after.x - center.x) < 1 && Math.abs(after.y - center.y) < 1, `the map's center stays: ${JSON.stringify(center)} then ${JSON.stringify(after)}`);
      const mapBox = (await wideDm.locator(".konvajs-content").first().boundingBox())!;
      assert.equal(Math.round(mapBox.width), 940, "the map's column follows");
      await shots.take(wideDm, "pa-1-drawn-500");

      await dragEdge(wideDm, -400, 12);
      assert.equal(await drawn(wideDm), 640, "it stops at the cap");
      assert.equal(await stored(wideDm), "640");
      await shots.take(wideDm, "pa-1-drawn-640");
      await dragEdge(wideDm, 500, 12);
      assert.equal(await drawn(wideDm), 360, "it stops at the least");
      assert.equal(await stored(wideDm), "", "the default stores no number");
      // An odd px count at 130% still draws and stores a whole layout px.
      await reloadAt(wideDm, { scale: 1.3, width: null });
      await dragEdge(wideDm, -97, 7);
      const w = (await valueNow(wideDm)).now;
      assert.equal(w, 360 + Math.floor(97 / 1.3), `whole layout px at 130%: ${w}`);
      assert.equal(await drawn(wideDm), w);
      assert.equal(await stored(wideDm), String(w));

      // A drag released elsewhere is stored, and a reload draws it.
      await reloadAt(wideDm, { scale: 1.3, width: undefined });
      assert.equal((await valueNow(wideDm)).now, w, "a reload draws what was stored");
      await reloadAt(wideDm, { width: null });
    });

    test("pa-2. Escape, S and a press inside the slop put the edge back and store nothing, and a drag back to its start restores (pw-2)", async () => {
      await dragEdge(wideDm, -100);
      assert.equal(await stored(wideDm), "460");
      for (const how of ["Escape", "S"]) {
        await pressAndMove(wideDm, -120);
        assert.equal(await drawn(wideDm), 580);
        await wideDm.keyboard.press(how === "S" ? "s" : "Escape");
        await wideDm.waitForTimeout(150);
        if (how === "S") {
          assert.ok(await aside(wideDm).isHidden(), "S hid the panel mid-drag");
          await wideDm.mouse.up();
          await wideDm.keyboard.press("s");
          await aside(wideDm).waitFor();
        } else await wideDm.mouse.up();
        assert.equal(await drawn(wideDm), 460, `${how} puts it back`);
        assert.equal(await stored(wideDm), "460", `${how} stores nothing`);
        // The page left the drag's page-only width: another window's change shows at once.
        await js(wideDm, `window.dispatchEvent(new StorageEvent("storage", { key: ${JSON.stringify(KEY)}, newValue: "470" })); return 0;`);
        await waitFor("another window's width", async () => ((await drawn(wideDm)) === 470 ? true : null), 3_000);
        await js(wideDm, `window.dispatchEvent(new StorageEvent("storage", { key: ${JSON.stringify(KEY)}, newValue: "460" })); return 0;`);
        await waitFor("the width back", async () => ((await drawn(wideDm)) === 460 ? true : null), 3_000);
      }
      // Inside the slop nothing moves, and nothing is written.
      await js(wideDm, `window.__writes = 0; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === ${JSON.stringify(KEY)}) window.__writes++; return set.call(this, k, v); }; return 0;`);
      await dragEdge(wideDm, -6, 3);
      assert.equal(await drawn(wideDm), 460, "a press inside the slop moves nothing");
      // A drag out and back to where it began restores.
      const at = await pressAndMove(wideDm, -80);
      assert.equal(await drawn(wideDm), 540);
      await wideDm.mouse.move(at.x, at.y, { steps: 5 });
      await wideDm.mouse.up();
      assert.equal(await drawn(wideDm), 460);
      assert.equal(await js<number>(wideDm, "return window.__writes;"), 0, "neither wrote the width");
      await js(wideDm, `window.dispatchEvent(new StorageEvent("storage", { key: ${JSON.stringify(KEY)}, newValue: "480" })); return 0;`);
      await waitFor("another window's width after a drag back", async () => ((await drawn(wideDm)) === 480 ? true : null), 3_000);
      await reloadAt(wideDm, { width: "460" });
    });

    test("pa-3. Reset width and a double-click store null, draw 360, take the button away and leave focus on the edge, a stored 640 in a 960 window included (pw-3)", async () => {
      assert.equal(await drawn(wideDm), 460);
      const reset = resetWidth(wideDm);
      await reset.waitFor();
      // Just before Hide panels in the tab row.
      const order = await aside(wideDm).locator("button[aria-label]").evaluateAll((els) => els.map((e) => (e as unknown as { getAttribute(n: string): string }).getAttribute("aria-label")));
      assert.equal(order[order.indexOf("Reset width") + 1], "Hide panels", order.join(", "));
      await shots.take(wideDm, "pa-3-reset-width");
      await reset.click();
      await waitFor("the default drawn", async () => ((await drawn(wideDm)) === 360 ? true : null), 3_000);
      assert.equal(await stored(wideDm), "");
      assert.equal(await reset.count(), 0, "the button leaves");
      assert.ok(await edge(wideDm).evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), "focus is on the edge");

      await dragEdge(wideDm, -100);
      assert.equal(await stored(wideDm), "460");
      await edge(wideDm).dblclick();
      await wideDm.waitForTimeout(150);
      assert.equal(await drawn(wideDm), 360, "a double-click puts the default back and never drags");
      assert.equal(await stored(wideDm), "");

      await size(wideDm, { width: 960, height: 900 });
      await reloadAt(wideDm, { width: "640" });
      assert.equal(await drawn(wideDm), 360, "640 waits in a 960 window");
      assert.equal(await resetWidth(wideDm).count(), 0, "no Reset width while it draws 360");
      await edge(wideDm).dblclick();
      await wideDm.waitForTimeout(150);
      assert.equal(await stored(wideDm), "", "the double-click stores null even where it draws 360");
      await size(wideDm, DESK);
      assert.equal(await drawn(wideDm), 360, "so a wider window draws 360");
    });

    test("pa-4. Left, Shift+Left, Home and End from 360 store 368, 432, null and 640, the arrows never move a token, and Left at the cap of a narrow window stores nothing (pw-4)", async () => {
      await reloadAt(wideDm, { width: null });
      // The aside's first Tab stop.
      const first = await js<string>(wideDm, `const a = document.querySelector("aside"); const f = [...a.querySelectorAll("button, [tabindex='0'], a[href], input, select, textarea")].find((e) => !e.closest("[hidden]") && e.tabIndex >= 0); return f ? (f.getAttribute("role") ?? f.tagName) + " " + (f.getAttribute("aria-label") ?? "") : "none";`);
      assert.equal(first, "separator Side panel width");
      const thornAt = { x: wideDmSocket.state!.tokens[wideRun.thorn]!.x, y: wideDmSocket.state!.tokens[wideRun.thorn]!.y };
      await edge(wideDm).focus();
      const steps: [string, string, number][] = [
        ["ArrowLeft", "368", 368],
        ["Shift+ArrowLeft", "432", 432],
        ["Home", "", 360],
        ["End", "640", 640],
        ["Shift+ArrowRight", "576", 576],
      ];
      for (const [key, raw, width] of steps) {
        await wideDm.keyboard.press(key);
        await wideDm.waitForTimeout(80);
        assert.equal(await stored(wideDm), raw, key);
        assert.equal((await valueNow(wideDm)).now, width, key);
      }
      await wideDm.waitForTimeout(300);
      assert.deepEqual({ x: wideDmSocket.state!.tokens[wideRun.thorn]!.x, y: wideDmSocket.state!.tokens[wideRun.thorn]!.y }, thornAt, "no token moved");
      await shots.take(wideDm, "pa-4-keys-focus");

      await wideDm.keyboard.press("End");
      assert.equal(await stored(wideDm), "640");
      await size(wideDm, { width: 1100, height: 900 });
      assert.deepEqual(await valueNow(wideDm), { now: 500, max: 500, min: 360, text: "500 pixels" });
      await edge(wideDm).focus();
      await wideDm.keyboard.press("ArrowLeft");
      await wideDm.keyboard.press("End");
      assert.equal(await stored(wideDm), "640", "Left and End at the cap store nothing, so 640 stays");
      await wideDm.keyboard.press("ArrowRight");
      assert.equal(await stored(wideDm), "492", "a step that changes the width stores what it draws");
      await size(wideDm, DESK);
    });

    test("pa-5. a stored 640 draws 500 at 1100, 360 at 960, sheets at 899 and 640 at 1440, 507 at 1440 at 130% and 640 at 1920 at 130%, and the DM's toolbar stays whole on a 600 px map (pw-5)", async () => {
      await reloadAt(wideDm, { width: "640" });
      const cases: [number, number, number | null][] = [
        [1100, 900, 500],
        [960, 900, 360],
        [899, 900, null],
        [1440, 900, 640],
      ];
      for (const [w, h, want] of cases) {
        await size(wideDm, { width: w, height: h });
        if (want === null) assert.equal(await aside(wideDm).count(), 0, "under 900 the sheets take over");
        else assert.equal(await drawn(wideDm), want, `${w}`);
        if (w === 1100) {
          // A 600 px map: the DM's mouse toolbar, every tool there, stays clear of the panel.
          const tools = (await wideDm.getByRole("navigation", { name: "Tools" }).locator("button").evaluateAll((els) => els.map((e) => (e as unknown as { getBoundingClientRect(): { right: number } }).getBoundingClientRect().right))) as number[];
          const panelLeft = (await aside(wideDm).boundingBox())!.x;
          assert.ok(Math.max(...tools) <= panelLeft, `the toolbar ends at ${Math.max(...tools)}, the panel starts at ${panelLeft}`);
          await shots.take(wideDm, "pa-5-1100-map-600");
        }
      }
      assert.equal(await stored(wideDm), "640", "the stored width waits through every window");
      // Today's 900 px window with a mouse, for the record: a 540 px map.
      await size(wideDm, { width: 900, height: 900 });
      const tools = (await wideDm.getByRole("navigation", { name: "Tools" }).locator("button").evaluateAll((els) => els.map((e) => (e as unknown as { getBoundingClientRect(): { right: number } }).getBoundingClientRect().right))) as number[];
      console.log(`pa-5: at 900 x 900 the DM's toolbar ends at ${Math.max(...tools)} and the panel starts at ${(await aside(wideDm).boundingBox())!.x}`);
      await shots.take(wideDm, "pa-5-900-today");

      await size(wideDm, DESK);
      await reloadAt(wideDm, { scale: 1.3, width: "640" });
      assert.equal(await drawn(wideDm), 507, "1440 at 130% caps at 507");
      assert.equal((await valueNow(wideDm)).max, 507);
      await shots.take(wideDm, "pa-5-1440-130-cap");
      await size(wideDm, { width: 1920, height: 1080 });
      assert.equal(await drawn(wideDm), 640, "1920 at 130% draws a genuine 640");
      await shots.take(wideDm, "pa-5-1920-130-640");
      await size(wideDm, DESK);
      await reloadAt(wideDm, { scale: 1, width: null });
    });

    test("pa-6. a crowded DM bar gives way as the panel widens and comes back after Reset width, a double-click and S, and a player's chip keys on the bar's width (pw-6)", async () => {
      // At 1440 the clock's chip and the DM chip's name give way at 640, in that order. At 1280, where the chip has already gone at 360, Full screen and the Phase menu go too.
      for (const view of [DESK, { width: 1280, height: 900 }]) {
        await size(wideDm, view);
        await reloadAt(wideDm, { width: null });
        const wide = await barParts(wideDm);
        if (view.width === 1440) assert.deepEqual(wide, ["clock", "dm-name", "fullscreen", "phase"], "the whole bar at 1440 and 360");
        else assert.ok(wide.includes("fullscreen") && wide.includes("phase"), `1280 at 360 keeps Full screen and the Phase menu: ${wide.join(", ")}`);
        await shots.take(wideDm, `pa-6-crowded-${view.width}-360`);
        await dragEdge(wideDm, -400, 12);
        assert.equal(await drawn(wideDm), 640);
        await wideDm.waitForTimeout(300);
        const narrow = await barParts(wideDm);
        await shots.take(wideDm, `pa-6-crowded-${view.width}-640`);
        console.log(`pa-6: at ${view.width} the bar holds ${narrow.join(", ") || "none of them"} at 640`);
        assert.ok(!narrow.includes("clock") && !narrow.includes("dm-name"), `${view.width}: the chip and the DM's name give way: ${narrow.join(", ")}`);
        assert.ok(narrow.length < wide.length);
        if (view.width === 1280) assert.ok(!narrow.includes("fullscreen") && !narrow.includes("phase"), `1280: Full screen and the Phase menu give way: ${narrow.join(", ")}`);
        await resetWidth(wideDm).click();
        await waitFor("each part back after Reset width", async () => ((await barParts(wideDm)).join(",") === wide.join(",") ? true : null), 5_000);
        // S hides the panel and the bar takes the window: each part shows. Shown again at 640, they give way again, and a double-click brings them back.
        await dragEdge(wideDm, -400, 12);
        await wideDm.keyboard.press("s");
        await aside(wideDm).waitFor({ state: "hidden" });
        await waitFor("each part with the panel hidden", async () => {
          const parts = await barParts(wideDm);
          return wide.every((p) => parts.includes(p)) ? true : null;
        }, 5_000);
        await wideDm.keyboard.press("s");
        await aside(wideDm).waitFor();
        await waitFor("the parts that give way at 640 again", async () => ((await barParts(wideDm)).length <= narrow.length ? true : null), 5_000);
        await edge(wideDm).dblclick();
        await waitFor("each part back after the double-click", async () => {
          const parts = await barParts(wideDm);
          return wide.every((p) => parts.includes(p)) ? true : null;
        }, 5_000);
      }
      await size(wideDm, DESK);

      // Pat's chip: names at 1440 with 640 drawn (a 1160 px rule), the dot at 1300 (1020), and with the panel hidden at 1000 the dot as today.
      await reloadAt(widePat, { width: "640" });
      assert.equal(await drawn(widePat), 640);
      assert.equal(await chipIsDot(widePat), false, "names at 1440 with 640 drawn");
      await size(widePat, { width: 1300, height: 900 });
      assert.equal(await drawn(widePat), 640);
      assert.equal(await chipIsDot(widePat), true, "the dot at 1300 with 640 drawn");
      await size(widePat, { width: 1000, height: 900 });
      await widePat.keyboard.press("s");
      await aside(widePat).waitFor({ state: "hidden" });
      assert.equal(await chipIsDot(widePat), true, "hidden at 1000, the dot as today");
      await widePat.keyboard.press("s");
      await size(widePat, DESK);
      await reloadAt(widePat, { width: null });
    });

    test("pa-7. at the map's right edge the top bar's end, the toolbar's end and a docked token window's band keep their presses, and only the edge's part in the panel takes them there (pw-7)", async () => {
      await size(wideDm, { width: 1100, height: 900 });
      await reloadAt(wideDm, { width: "640" });
      const panel = (await aside(wideDm).boundingBox())!;
      const bar = (await topBar(wideDm).boundingBox())!;
      const nav = (await wideDm.getByRole("navigation", { name: "Tools" }).boundingBox())!;
      // The edge's part over the map: the 8 px left of the aside's border.
      const over = [1, 4, 7].map((d) => panel.x - d);
      for (const x of over) assert.notEqual(await pressedAt(wideDm, { x, y: bar.y + bar.height / 2 }), "edge", `the top bar's end at ${x}`);
      // The toolbar's own row, where its last button stands nearest the panel.
      const lastTool = (await wideDm.getByRole("navigation", { name: "Tools" }).locator("button").last().boundingBox())!;
      console.log(`pa-7: the toolbar's last button ends ${panel.x - (lastTool.x + lastTool.width)} px from the panel`);
      for (const x of over) {
        const what = await pressedAt(wideDm, { x, y: lastTool.y + lastTool.height / 2 });
        if (x <= lastTool.x + lastTool.width) assert.notEqual(what, "edge", `the toolbar's end at ${x}`);
      }
      assert.ok(nav.width > 0);
      // Inside the panel the edge takes the press beside both bars.
      assert.equal(await pressedAt(wideDm, { x: panel.x + 2, y: panel.y + panel.height / 3 }), "edge");
      // A token window docked against the map's right edge: Thorn's, from its row in Initiative.
      await openSideTab(wideDm, "Initiative");
      await aside(wideDm).getByRole("button", { name: /Thorn/ }).first().click();
      const win = wideDm.getByRole("dialog", { name: "Thorn actions" });
      await win.waitFor();
      const box = (await win.boundingBox())!;
      console.log(`pa-7: Thorn's window ends ${panel.x - (box.x + box.width)} px from the panel`);
      for (const x of [box.x + box.width - 1, box.x + box.width - 4]) assert.notEqual(await pressedAt(wideDm, { x, y: box.y + 20 }), "edge", `the token window's band at ${x}`);
      for (const x of over) if (x < box.x + box.width) assert.notEqual(await pressedAt(wideDm, { x, y: box.y + 20 }), "edge", `the token window over the edge at ${x}`);
      await shots.take(wideDm, "pa-7-token-window");
      await wideDm.keyboard.press("Escape");
      await size(wideDm, DESK);
      await reloadAt(wideDm, { width: null });
    });

    test("pa-8. a finger on the grip of a touch-only tablet at 1180 x 820 resizes the panel (pw-8)", async () => {
      const tablet = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: false, storageState: await widePatContext.storageState() });
      try {
        const page = await tablet.newPage();
        const watch = new ConsoleWatch("tablet");
        watch.attach(page);
        await page.goto(`${server.origin}/r/${wideRun.roomId}`);
        await page.getByRole("status", { name: "Connected" }).first().waitFor();
        await reloadAt(page, { width: null });
        const coarse = await js<boolean>(page, `return matchMedia("(any-pointer: coarse)").matches;`);
        assert.ok(coarse, "the tablet reports a coarse pointer");
        const hit = page.locator("[data-edge-hit]");
        const box = (await hit.boundingBox())!;
        const panel = (await aside(page).boundingBox())!;
        assert.ok(Math.abs(box.width - 44) < 0.5 && Math.abs(box.height - 44) < 0.5, `a 44 px grip: ${box.width} x ${box.height}`);
        assert.ok(Math.abs(box.x + box.width - (panel.x + 1)) < 0.5, `none of it in the panel: it ends at ${box.x + box.width}, the panel's border at ${panel.x}`);
        const cdp: CDPSession = await tablet.newCDPSession(page);
        const from = { x: box.x + 10, y: box.y + box.height / 2 };
        assert.equal(await pressedAt(page, from), "edge", "the finger lands on the grip over the map");
        await touchSwipe(cdp, from, { x: from.x - 120, y: from.y }, { steps: 12 });
        await page.waitForTimeout(200);
        assert.equal(await drawn(page), 480);
        assert.equal(await stored(page), "480");
        await shots.take(page, "pa-8-tablet-480");
        assert.deepEqual(watch.errors, []);
      } finally {
        await tablet.close();
      }
    });

    test("pa-9. the panel's rows measure as true at the cap as at 360, dark and light, and the grip sits at the aside's middle on its border", async () => {
      // What the sweep already finds at 360 is not this lane's. At the cap nothing may be new but the tab row's intended 8 px group gap, which the spacing check learns from data-group-start (docs/design/design-v1-panel-size.md 9).
      const norm = (line: string) => line.replace(/^[^:]*: /, "").replace(/\(most start at [\d.]+\)/, "");
      const groupGap = (line: string) => / kind-gap [\d.]+ px, div\[tablist\] "Panels"/.test(line);
      const panels = ["Initiative", "Token", "DM", "Scenes", "Sound", "Time"];
      const extra: string[] = [];
      let known = 0;
      for (const theme of ["dark", "light"] as const) {
        for (const [view, scale] of [
          [DESK, 1],
          [DESK, 1.3],
          [{ width: 1920, height: 1080 }, 1.3],
        ] as const) {
          await size(wideDm, view);
          const at = (w: number) => `${theme} ${view.width}x${view.height} ${scale * 100}% at ${w}`;
          const measured = new Map<string, string[]>();
          for (const width of [null, "640"]) {
            await reloadAt(wideDm, { scale, width, theme });
            const w = await drawn(wideDm);
            for (const panel of panels) {
              await openSideTab(wideDm, panel);
              await wideDm.waitForTimeout(150);
              measured.set(`${panel} ${width}`, alignmentLines(await measureAlignment(aside(wideDm)), `${panel}, ${at(w)}`));
            }
            const grip = (await wideDm.locator("[data-edge-grip]").boundingBox())!;
            const box = (await aside(wideDm).boundingBox())!;
            assert.ok(Math.abs(grip.y + grip.height / 2 - (box.y + box.height / 2)) <= 1, `the grip at the aside's middle, ${at(w)}`);
            assert.ok(Math.abs(grip.x + grip.width / 2 - (box.x + 0.5 * scale)) <= 1, `the grip on the border, ${at(w)}`);
            if (width !== null && scale === 1) await shots.take(wideDm, `pa-9-${theme}-640`);
          }
          for (const panel of panels) {
            const base = new Set((measured.get(`${panel} null`) ?? []).map(norm));
            known += base.size;
            extra.push(...(measured.get(`${panel} 640`) ?? []).filter((l) => !base.has(norm(l)) && !groupGap(l)));
          }
        }
      }
      console.log(`pa-9: ${known} findings the sweep already makes at 360, none of them the side panel's width`);
      assert.deepEqual(extra, [], "nothing new at the cap");
      // An SRD stat block at the cap, as the design's audit asks.
      await size(wideDm, DESK);
      await reloadAt(wideDm, { width: "640" });
      await openSideTab(wideDm, "Initiative");
      const pane = wideDm.getByRole("tabpanel", { name: /^Initiative/ });
      await pane.getByRole("button", { name: /^Goblin 1 options/ }).click();
      await wideDm.getByRole("button", { name: "Stat block", exact: true }).first().click();
      await wideDm.getByText("Goblin Warrior", { exact: false }).first().waitFor();
      await wideDm.waitForTimeout(400);
      await shots.take(wideDm, "pa-9-stat-block-640");
      await reloadAt(wideDm, { width: null });
    });

    test("pa-10. no page logged an error", () => {
      assert.deepEqual(wideDmConsole.errors, []);
      assert.deepEqual(widePatConsole.errors, []);
    });
  });

  describe("the sheet with a mouse", () => {
    before(async () => {
      dmContext = await browser.newContext({ viewport: { width: 700, height: 900 } });
      dm = await dmContext.newPage();
      dmConsole.attach(dm);
      await dmSocket.attach(dmContext, dm);
      playerContext = await browser.newContext({ viewport: { width: 500, height: 900 } });
      player = await playerContext.newPage();
      playerConsole.attach(player);
      await playerSocket.attach(playerContext, player);
    });

    after(async () => {
      if (process.env.E2E_DEBUG === "1") for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      ops?.close();
      if (run.roomId && dmContext) {
        try {
          const res = await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
          if (!res.ok()) console.error(`Deleting room ${run.roomId} answered ${res.status()}`);
        } catch (err) {
          console.error(`Deleting room ${run.roomId} failed`, err);
        }
      }
      await dmContext?.close();
      await playerContext?.close();
    });

    test("0. a DM's room with Pat's Thorn on the map and a label, the DM at 700 x 900 with a mouse", async () => {
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
      await ops.send({ t: "token.create", token: { id: run.thorn.id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Thorn", x: 4, y: 3, disposition: "ally", actor: { ref: run.thorn.characterId } } });
      await ops.send({ t: "build.label", sceneId: run.sceneId, labelId: run.label, label: { x: 3.5, y: 6.5, text: "Gate", size: 1 } });
      await waitFor("the room's parts in the DM's view", () => (dmSocket.state?.tokens[run.thorn.id] && dmSocket.state?.labels[run.label] ? true : null));
      await setUp(dm, { width: 700, height: 900 });
      assert.equal(await dm.evaluate(() => (globalThis as unknown as Win).matchMedia("(any-pointer: fine)").matches), true, "a desktop context has a mouse");
    });

    test("PS-B sm-1. a phone with touch only: no arrows, Expand sheet hidden as today, the grabber 5 px down", async () => {
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      try {
        await phone.addCookies(await dmContext.cookies(server.origin));
        const page = await phone.newPage();
        await setUpOn(page, { width: 390, height: 844 });
        assert.equal(await page.evaluate(() => (globalThis as unknown as Win).matchMedia("(any-pointer: fine)").matches), false, "Chromium's touch emulation has no fine pointer");
        const sheet = await openPanelBy(page, "Log", true);
        assert.equal(await upOf(sheet).count(), 0);
        assert.equal(await downOf(sheet).count(), 0);
        assert.equal(await bandOf(sheet).count(), 0);
        const expand = sheet.getByRole("button", { name: "Expand sheet" });
        assert.equal(await expand.count(), 1, "the hidden Expand sheet");
        const box = await rectOf(expand);
        assert.ok(box.width <= 1 && box.height <= 1, `Expand sheet shows at ${box.width} x ${box.height}`);
        const header = await rectOf(sheet.locator("[data-sheet-grab]").first());
        const grabber = await rectOf(sheet.locator("[data-sheet-grabber]"));
        near(grabber.top - header.top, 5, "the grabber's place");
        near(header.height, 60, "the header's height, as today");
      } finally {
        await phone.close();
      }
    });

    test("PS-B sm-2. 700 x 900 with a mouse: Enter on Up fills the screen and keeps focus, Tab and Enter shrink it, Enter again puts it away", async () => {
      await setUp(dm, { width: 700, height: 900 });
      const sheet = await openPanel(dm, "Log");
      await checkStrip(sheet, 1, "the Log at 700 x 900", true);
      await checkAlignment(sheet, "the Log at 700 x 900");
      assert.equal(await sheet.getByRole("button", { name: "Expand sheet" }).count(), 1, "Up is Expand sheet, and the hidden one is not drawn");
      assert.equal(await upOf(sheet).getAttribute("aria-label"), "Expand sheet");
      assert.equal(await downOf(sheet).getAttribute("aria-label"), "Put away sheet");
      await shots.take(dm, "psb-log-700x900-normal");
      await upOf(sheet).focus();
      await dm.keyboard.press("Enter");
      await waitFor("the sheet to fill the screen", async () => ((await isFull(sheet)) ? true : null), 3_000);
      assert.equal(await settled(sheet), "rest");
      assert.equal(await focused(dm), "up", "focus stays on Up at full");
      assert.equal(await upOf(sheet).getAttribute("aria-disabled"), "true");
      near((await rectOf(sheet)).top, 0, "the full sheet's top", 1);
      await checkStrip(sheet, 1, "the full Log", true);
      await checkAlignment(sheet, "the full Log");
      await shots.take(dm, "psb-log-700x900-full");
      // Up does nothing at full.
      await dm.keyboard.press("Enter");
      await sleep(300);
      assert.equal(await isFull(sheet), true);
      await dm.keyboard.press("Tab");
      assert.equal(await focused(dm), "down");
      assert.equal(await downOf(sheet).getAttribute("aria-label"), "Shrink sheet");
      await dm.keyboard.press("Enter");
      await waitFor("the sheet back at its normal height", async () => ((await isFull(sheet)) ? null : true), 3_000);
      assert.equal(await settled(sheet), "rest");
      assert.equal(await focused(dm), "down", "focus stays on Down as its name changes");
      assert.equal(await downOf(sheet).getAttribute("aria-label"), "Put away sheet");
      assert.ok((await rectOf(sheet)).top > 100, "back at its normal height");
      await dm.keyboard.press("Enter");
      assert.equal(await settled(sheet), "gone");
      assert.equal(await sheet.count(), 0);
    });

    test("PS-B sm-3. Down with unsaved input does what a swipe down does: the label pane follows partway, springs back and stays with its typed text (D-261106-006)", async () => {
      await setUp(dm, { width: 500, height: 900 });
      const pane = await openLabel(dm);
      await checkStrip(pane, 1, "the label pane", false);
      const field = pane.getByRole("textbox").first();
      await field.fill("Gate of the North");
      const before = await rectOf(pane);
      const sign = await pressAndWatch(downOf(pane), pane);
      assert.ok(Math.max(...sign.tops) > before.top + 8, `the pane follows partway down as its sign (${JSON.stringify(sign.tops)} from ${before.top})`);
      assert.equal(await settled(pane), "rest");
      near((await rectOf(pane)).top, before.top, "back at its normal height", 1);
      assert.equal(await field.inputValue(), "Gate of the North", "the typed text is kept");
      await sleep(300);
      assert.equal(dmSocket.state?.labels[run.label]?.text, "Gate", "Down saved nothing");
      // The X stays the way to close without saving.
      await pane.getByRole("button", { name: /^Close/ }).first().click();
      assert.equal(await settled(pane), "gone");
      await sleep(300);
      assert.equal(dmSocket.state?.labels[run.label]?.text, "Gate", "the X saved nothing");
      await pickTool(dm, "Select");
    });

    test("PS-B sm-4. an arrow as the first press, on the panel sheet, a dialog as a sheet, a pane and the roll card: each slides from where it stands", async () => {
      await setUp(dm, { width: 500, height: 900 });
      // The panel sheet: Up, then Down from full.
      const sheet = await openPanel(dm, "Log");
      const normal = await rectOf(sheet);
      const rise = await pressAndWatch(upOf(sheet), sheet);
      assert.ok(rise.tops.length > 0, "no frame read");
      near(rise.tops[0]!, normal.top, "Up's first frame stands where the sheet stood", 6);
      assert.equal(rise.to, String(-Math.round(normal.top)), "Up slides to full");
      await waitFor("the sheet to fill the screen", async () => ((await isFull(sheet)) ? true : null), 3_000);
      assert.equal(await settled(sheet), "rest");
      const shrink = await pressAndWatch(downOf(sheet), sheet);
      near(shrink.tops[0]!, 0, "Down's first frame stands at full", 6);
      assert.equal(shrink.to, "0");
      await waitFor("the sheet back at normal", async () => ((await isFull(sheet)) ? null : true), 3_000);
      assert.equal(await settled(sheet), "rest");
      near((await rectOf(sheet)).top, normal.top, "back at its normal top", 1);

      // A dialog as a sheet: the Monsters panel's filters, at the screen's foot under 600 px.
      await sheet.getByRole("button", { name: "Close Log" }).click();
      const monsters = await openPanel(dm, "Monsters");
      await monsters.getByRole("button", { name: "Filters" }).click();
      const card = dm.getByRole("dialog", { name: "Monster filters" }).locator("section").first();
      const cardAt = await steadyRect(card);
      await checkStrip(card, 1, "the monster filters", false);
      const off = await pressAndWatch(downOf(card), card);
      near(off.tops[0]!, cardAt.top, "the dialog's first frame stands where it stood", 6);
      assert.ok(off.to !== null && Number(off.to) > 0, `the dialog slides down, to ${off.to}`);
      assert.equal(await settled(card), "gone");
      await monsters.getByRole("button", { name: "Close Monsters" }).click();

      // A pane: the label pane.
      const pane = await openLabel(dm);
      const paneAt = await steadyRect(pane);
      const put = await pressAndWatch(downOf(pane), pane);
      near(put.tops[0]!, paneAt.top, "the pane's first frame stands where it stood", 6);
      assert.ok(put.to !== null && Number(put.to) > 0);
      assert.equal(await settled(pane), "gone");
      await pickTool(dm, "Select");

      // The roll card: Put away roll folds it as Later does.
      await setUp(player, { width: 500, height: 900 });
      const request = randomUUID();
      await ops.send({ t: "roll.ask", request: { id: request, test: { kind: "save", choices: [{ ability: "dex" }] }, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn.characterId }] } });
      const roll = player.getByRole("dialog", { name: "The DM asks for a roll" });
      const asked = player.getByRole("button", { name: /^Roll asked/ }).first();
      await waitFor("the card or the row that stands for it", async () => ((await roll.isVisible()) || (await asked.isVisible()) ? true : null));
      if (!(await roll.isVisible())) await asked.click();
      const rollAt = await steadyRect(roll);
      await checkStrip(roll, 1, "the roll card", false);
      assert.equal(await downOf(roll).getAttribute("aria-label"), "Put away roll");
      const later = await pressAndWatch(downOf(roll), roll);
      near(later.tops[0]!, rollAt.top, "the roll card's first frame stands where it stood", 6);
      assert.ok(later.to !== null && Number(later.to) > 0);
      await waitFor("the card folded", async () => ((await roll.isVisible()) ? null : true), 3_000);
      // Folded into its chip as Later folds it, the request still open: a tap on the chip brings the card back.
      await player.getByRole("button", { name: /Dexterity|DEX/ }).first().click();
      await roll.waitFor();
    });

    test("PS-B sm-5. a mouse drags the band, not the title or the content: up 200 px and released off the band fills the screen", async () => {
      await setUp(dm, { width: 700, height: 900 });
      const sheet = await openPanel(dm, "Log");
      const normal = await rectOf(sheet);
      const band = mid(await rectOf(bandOf(sheet)));
      // Up 200 px, or past half the way up where the sheet stands lower: the claim takes twice the slop, 16 px.
      const rise = Math.max(200, 16 + Math.max(normal.top / 2, 44) + 12);
      await mouseDrag(dm, band, -rise, { release: { x: band.x - 200, y: band.y - rise - 20 } });
      await waitFor("the sheet to fill the screen", async () => ((await isFull(sheet)) ? true : null), 3_000);
      assert.equal(await settled(sheet), "rest");
      assert.equal(await dm.evaluate(() => (globalThis as unknown as Win).getSelection()?.toString() ?? ""), "", "a drag on the band selects nothing");
      // Down the band again, past half the way back: normal.
      const fullBand = mid(await rectOf(bandOf(sheet)));
      await mouseDrag(dm, fullBand, 8 + Math.max(normal.top / 2, 44) + 30);
      await waitFor("the sheet back at normal", async () => ((await isFull(sheet)) ? null : true), 3_000);
      assert.equal(await settled(sheet), "rest");
      // A press on the title and a move select its text, and the sheet stays.
      const h2 = await rectOf(sheet.locator("h2").first());
      const title = { x: h2.left + 9, y: h2.top + h2.height / 2 };
      await mouseDrag(dm, title, 0, { dx: 60, release: null });
      await mouseDragTo(dm, { x: title.x + 60, y: title.y + 150 });
      assert.equal(await transformOf(sheet), "", "a drag on the title moved the sheet");
      await dm.mouse.up();
      assert.notEqual(await dm.evaluate(() => (globalThis as unknown as Win).getSelection()?.toString() ?? ""), "", "the title's text selects");
      assert.equal(await settled(sheet), "rest");
      assert.equal(await sheet.count(), 1);
      await dm.evaluate(() => (globalThis as unknown as Win).getSelection()?.removeAllRanges());
      await sheet.getByRole("button", { name: "Close Log" }).click();
    });

    test("PS-B sm-6. a touch laptop: the arrows show, a touch during a mouse drag springs it back, a mouse press during a swipe is ignored, a stale tap takes nothing", async () => {
      const laptop = await browser.newContext({ viewport: { width: 700, height: 900 }, hasTouch: true });
      await laptop.addInitScript(finePointerToo);
      try {
        await laptop.addCookies(await dmContext.cookies(server.origin));
        const page = await laptop.newPage();
        await setUpOn(page, { width: 700, height: 900 });
        const cdp: CDPSession = await laptop.newCDPSession(page);
        const sheet = await openPanelBy(page, "Log", false);
        await checkStrip(sheet, 1, "the touch laptop's Log", true);
        const band = mid(await rectOf(bandOf(sheet)));
        const header = await rectOf(sheet.locator("[data-sheet-grab]").first());

        // A touch on the map during a mouse drag: the sheet springs back, and the drag moves it no more.
        await page.mouse.move(band.x, band.y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(band.x, band.y + 10 * i);
        assert.notEqual(await transformOf(sheet), "", "the mouse drag moved the sheet");
        const touches = new Touches(cdp);
        await touches.start([{ x: 40, y: 120 }]);
        await touches.end();
        assert.equal(await settled(sheet), "rest");
        for (let i = 9; i <= 40; i++) await page.mouse.move(band.x, band.y + 10 * i);
        await sleep(50);
        assert.equal(await transformOf(sheet), "", "the cancelled drag moved the sheet again");
        await page.mouse.up();
        await sleep(300);
        assert.equal(await settled(sheet), "rest");
        assert.equal(await sheet.count(), 1, "the cancelled drag closed the sheet");

        // A mouse press on the band during a touch swipe is ignored, and the swipe closes the sheet as a swipe.
        const from = { x: header.left + 60, y: header.top + 70 };
        const finger = new Touches(cdp);
        await finger.start([from]);
        for (let i = 1; i <= 4; i++) await finger.move([{ x: from.x, y: from.y + 10 * i }], 30);
        const moved = mid(await rectOf(bandOf(sheet)));
        await page.mouse.move(moved.x, moved.y);
        await page.mouse.down();
        await page.mouse.move(moved.x, moved.y - 100, { steps: 5 });
        const height = (await rectOf(sheet)).height;
        for (let i = 5; i <= Math.ceil((height * 0.6 + 60) / 10); i++) await finger.move([{ x: from.x, y: from.y + 10 * i }], 30);
        await finger.end([], 30);
        await page.mouse.up();
        assert.equal(await settled(sheet), "gone", "the touch swipe closed the sheet");

        // A touch tap on the header, then a mouse drag down past the close: it moves and closes, and no press is cancelled for the stale touch.
        const again = await openPanelBy(page, "Log", false);
        const tapAt = await rectOf(again.locator("h2").first());
        const tap = new Touches(cdp);
        await tap.start([{ x: tapAt.left + 30, y: tapAt.top + tapAt.height / 2 }]);
        await tap.end();
        await sleep(100);
        const cancels = await countCancels(page);
        const band2 = mid(await rectOf(bandOf(again)));
        const height2 = (await rectOf(again)).height;
        await mouseDrag(page, band2, height2 * 0.6 + 60);
        assert.equal(await settled(again), "gone", "the mouse drag closed the sheet");
        assert.equal(await cancels(), 0, "a pointercancel went out for the stale touch");
      } finally {
        await laptop.close();
      }
    });

    test("PS-B shots: the Log at 700 x 900 with a mouse, dark and light", async () => {
      await shotsInBothSchemes(dm, () => openPanel(dm, "Log"), { width: 700, height: 900 }, "psb-log-700x900");
      for (const scale of [1, 1.3]) {
        await setUp(dm, { width: 700, height: 900, scale });
        const sheet = await openPanel(dm, "Log");
        await checkStrip(sheet, scale, `the Log at 700 x 900 at ${scale * 100}%`, true);
        await checkAlignment(sheet, `the Log at 700 x 900 at ${scale * 100}%`);
      }
      await setUp(dm, { width: 700, height: 900 });
      assert.deepEqual(dmConsole.errors, [], "the DM's page logged errors");
      assert.deepEqual(playerConsole.errors, [], "the player's page logged errors");
    });
  });
});

/** As setUp, for a page in a context of its own, which already holds the DM's cookie. */
async function setUpOn(page: Page, view: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(view);
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Opens a panel as a sheet on a page of its own, by a tap or a click. */
async function openPanelBy(page: Page, name: string, tap: boolean): Promise<Locator> {
  const panels = page.locator('nav[aria-label="Tools"] button[title="Panels"]');
  if (tap) await panels.tap();
  else await panels.click();
  const item = page.getByRole("region", { name: "Panels" }).getByRole("button", { name, exact: true });
  if (tap) await item.tap();
  else await item.click();
  await page.locator(`section[aria-label="${name}"]`).waitFor();
  const sheet = sheetOf(page, name);
  await steadyRect(sheet);
  return sheet;
}

/** The label pane, opened by a click on its label in the map builder. */
async function openLabel(page: Page): Promise<Locator> {
  await pickTool(page, "Map builder");
  await pickOption(page, "Map builder", "Builder mode", "Label");
  const at = await pagePoint(page, run.bounds, { x: 3.5, y: 6.5 });
  await page.mouse.click(at.x, at.y);
  const pane = page.getByRole("dialog", { name: "Edit label" });
  await pane.waitFor();
  await steadyRect(pane);
  return pane;
}

/** Moves the held mouse to `to` in a few steps. */
async function mouseDragTo(page: Page, to: Pt): Promise<void> {
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await sleep(50);
}
