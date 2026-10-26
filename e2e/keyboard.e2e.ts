import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { barControl, ConsoleWatch, OpSocket, pickTool, Shots, SocketWatch, startServer, tapCell, touchSwipe, waitFor, type Server } from "./harness.ts";

/**
 * A field in a phone's sheet stays in view over the on-screen keyboard
 * (lib/keyboardInset.ts, components/Sheet.tsx). Playwright opens no soft
 * keyboard, so Pat's phone gets a fake `visualViewport` before the page
 * loads, which a step shrinks as iOS Safari's keyboard shrinks the real
 * one: the layout keeps its height and only the visible area loses its
 * foot. At 390 x 844 and 320 x 568, at 100% and 130%:
 * - Use… on Lay on Hands in Thorn's Token sheet opens its amount field,
 *   and with the visible area 300 px shorter (216 on the small phone, an
 *   iPhone SE's number pad) the sheet's foot stands on the keyboard and
 *   the field and Spend show whole, on the small phone over a keyboard of
 *   300 px too, where the sheet takes the visible area's height.
 * - The keyboard closing brings the sheet back to its height.
 * - The same for the Hit Points section's HP change field and Apply.
 * - A browser that resizes the page itself for its keyboard: on the page
 *   made as much shorter the field keeps focus and shows with Spend, and
 *   a page shorter than wide leaves the room upright (layout.ts).
 * - A scroll of Pat's own while he types, by the wheel or a finger, is
 *   kept when the keyboard changes height.
 * - Safari panning the page down to show a low field: the sheet and the
 *   token bar stand at the visible area's foot, their controls whole.
 * - Over the keyboard, whole, on top and unclipped: Lay on Hands' field and
 *   Spend in the token bar's Uses drawer, the bar's HP entry and Apply,
 *   and Add a class resource's Name with Add, a dialog's sheet.
 * - A tap on Spend with the keyboard up spends, the sheet staying on the
 *   keyboard until it closes.
 * - Then in a fight, on Thorn's turn, the alerts fold into the dock on the
 *   sheet's top edge, which rides the raised sheet or joins its header.
 * - In the fight on the small phone at 130%, with the number pad and with
 *   a 300 px keyboard, and on a phone held sideways at 130%, over the
 *   visual viewport and with the page itself resized, each field over the
 *   keyboard with its buttons and the dock, whole and taking a tap: the
 *   Token sheet's, which takes the visible area's height sideways, the
 *   token bar's, a dialog's, the roll card's (upright), and the Area tool's
 *   Spell field in its row with the spells it finds, and in the Shape
 *   popover, where a scroll of Pat's own stays.
 * The raised sheet's row, entry and dock are measured with the alignment
 * check at each size.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus thirteen, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 13;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-keyboard-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let patCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E keyboard ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  patId: "",
  thorn: randomUUID(),
  thornToken: randomUUID(),
  goblin: randomUUID(),
};

/** A phone and its keyboard. `native` opens the keyboard as a browser that resizes the page itself does: the page is made shorter, not only the visual viewport. */
type View = { width: number; height: number; scale: number; keyboard: number; native?: boolean };
const VIEWS: View[] = [
  { width: 390, height: 844, scale: 1, keyboard: 300 },
  { width: 390, height: 844, scale: 1.3, keyboard: 300 },
  { width: 320, height: 568, scale: 1, keyboard: 216 },
  { width: 320, height: 568, scale: 1.3, keyboard: 216 },
];
/**
 * Where the reviews found the gaps: the smallest phone at 130% in a fight,
 * with an iPhone SE's number pad and with a 300 px keyboard, and a phone
 * held sideways at 130% with the number pad, over the visual viewport and
 * with the page resized.
 */
const LIFT: View[] = [
  { width: 320, height: 568, scale: 1.3, keyboard: 216 },
  { width: 320, height: 568, scale: 1.3, keyboard: 300 },
  { width: 844, height: 390, scale: 1.3, keyboard: 216 },
  { width: 844, height: 390, scale: 1.3, keyboard: 216, native: true },
];
/** The keyboard a view's steps take unless they say otherwise: an iPhone's on a tall phone, an iPhone SE's number pad on a short or sideways one. */
const usualKeyboard = (v: View) => (v.height >= 800 ? 300 : 216);
const viewName = (v: View) => `${v.width} x ${v.height} at ${Math.round(v.scale * 100)}%${v.keyboard !== usualKeyboard(v) ? ` over a ${v.keyboard} px keyboard` : ""}${v.native ? " with the page resized" : ""}`;

type Box = { top: number; bottom: number; left: number; right: number };
/** The page-side shapes the fake viewport and the checks use, as e2e code has no DOM types. */
type KeyboardWindow = { innerHeight: number; rvttKeyboard(height: number | null, top?: number): void; visualViewport: { offsetTop: number; height: number } };

/**
 * A visual viewport the test sizes, installed before the page's own script
 * runs. Its height follows the window's until rvttKeyboard sets one, and
 * each change fires `resize`, as the real one does when a keyboard opens.
 * A `top` pans it down the page as Safari does to show a low field, which
 * fires `scroll`: the page's boxes keep their places, and what is above
 * `top` is out of sight.
 */
function fakeViewport(): void {
  const w = globalThis as unknown as { innerHeight: number; innerWidth: number; rvttKeyboard?: (height: number | null, top?: number) => void };
  const viewport = new EventTarget();
  let height: number | null = null;
  let offsetTop = 0;
  const read = (get: () => number) => ({ get, configurable: true });
  Object.defineProperties(viewport, {
    height: read(() => height ?? w.innerHeight),
    width: read(() => w.innerWidth),
    offsetTop: read(() => offsetTop),
    offsetLeft: read(() => 0),
    pageTop: read(() => offsetTop),
    pageLeft: read(() => 0),
    scale: read(() => 1),
  });
  Object.defineProperty(globalThis, "visualViewport", { configurable: true, get: () => viewport });
  w.rvttKeyboard = (h, top = 0) => {
    const resized = h !== height;
    const panned = top !== offsetTop;
    height = h;
    offsetTop = h === null ? 0 : top;
    if (resized) viewport.dispatchEvent(new Event("resize"));
    if (panned) viewport.dispatchEvent(new Event("scroll"));
  };
}

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** When Pat's page sent each request the server's per-session limit counts (server/auth/ratelimit.ts), for setUp's pace. */
const patRequests: number[] = [];
/** Under the server's 600 requests a minute per session, with room for what a step sends after its load. */
const REQUESTS_PER_MINUTE = 400;

async function setUp(page: Page, view: View): Promise<void> {
  // This file loads Pat's room every few seconds, which can reach the server's limit and leave a load unconnected, so it waits until the last minute's requests leave room.
  const recent = () => patRequests.filter((t) => t > Date.now() - 60_000).length;
  while (recent() > REQUESTS_PER_MINUTE) await page.waitForTimeout(1_000);
  await patCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  await page.setViewportSize({ width: view.width, height: view.height });
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

function tokenSheet(page: Page): Locator {
  return page.locator('dialog[data-rvtt-sheet][aria-label="Token"]');
}

/** Thorn's Token sheet, from the map: a tap on his token, then Details in its bar. */
async function thornsSheet(page: Page): Promise<Locator> {
  await tapCell(page, run.bounds, { x: 5, y: 5 });
  await (await barControl(page.getByRole("dialog", { name: "Thorn actions" }), "Details")).click();
  const sheet = tokenSheet(page);
  await sheet.getByRole("heading", { name: "Thorn" }).first().waitFor();
  return sheet;
}

function usesRow(sheet: Locator, name: string): Locator {
  const uses = sheet.locator('xpath=.//section[*[self::h3 or self::h4][normalize-space()="Uses"]]');
  return uses.getByRole("listitem").filter({ has: sheet.page().getByText(name, { exact: true }) });
}

/** How much of a class resource of Thorn's the DM's copy has used. */
function usedOf(id: string): number {
  return dmSocket.state?.characters[run.thorn]?.resources?.find((r) => r.id === id)?.used ?? -1;
}

async function box(target: Locator): Promise<Box> {
  const b = await target.boundingBox();
  assert.ok(b, "the element has a box");
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width };
}

const keyboard = (page: Page, height: number | null, top = 0) => page.evaluate(([h, t]) => (globalThis as unknown as KeyboardWindow).rvttKeyboard(h, t ?? 0), [height, top] as const);
const visibleBottom = (page: Page) => page.evaluate(() => {
  const w = globalThis as unknown as KeyboardWindow;
  return w.visualViewport.offsetTop + w.visualViewport.height;
});

/** Waits for the sheet's foot to stand `bottom` px from the page's top, within a pixel. */
async function footAt(sheet: Locator, bottom: number, what: string): Promise<Box> {
  let last: Box | null = null;
  await waitFor(what, async () => {
    last = await box(sheet);
    return Math.abs(last.bottom - bottom) <= 1 ? true : null;
  }, 5_000).catch(() => assert.fail(`${what}: the sheet's foot is at ${last?.bottom}, not ${bottom}`));
  return last!;
}

/** Each of `controls` stands whole inside the visible area and inside the sheet body's box. */
async function wholeInView(sheet: Locator, controls: Record<string, Locator>, what: string): Promise<void> {
  const page = sheet.page();
  const seen = await visibleBottom(page);
  const body = await box(sheet.locator("[data-pane-body]"));
  // The body scrolls after the sheet lays out for the keyboard, a frame later.
  await waitFor(`${what}: in view`, async () => {
    for (const control of Object.values(controls)) {
      const b = await box(control);
      if (b.top < Math.max(0, body.top) - 0.5 || b.bottom > Math.min(seen, body.bottom) + 0.5) return null;
    }
    return true;
  }, 5_000).catch(async () => {
    const at: string[] = [];
    for (const [name, control] of Object.entries(controls)) {
      const b = await box(control);
      at.push(`${name} ${Math.round(b.top)} to ${Math.round(b.bottom)}`);
    }
    assert.fail(`${what}: ${at.join(", ")}, the body ${Math.round(body.top)} to ${Math.round(body.bottom)}, the visible area's foot ${seen}`);
  });
}

/** Where the dock stood on the sheet's edge, rather than in its header where a short screen has no room for it (3.2.1). */
const docked = new Set<string>();

/** The dock's row, where the sheet folds the fight's alerts, stands on the sheet's top edge, and its buttons, there or in the header, show whole. */
async function dockRides(page: Page, sheet: Locator, what: string): Promise<void> {
  await liftedWhole(page, {}, `${what}, the dock`);
  const dock = page.locator("[data-rvtt-dock]");
  if ((await dock.count()) === 0) return;
  docked.add(what);
  const top = (await box(sheet)).top;
  const foot = (await box(dock)).bottom;
  assert.ok(Math.abs(foot - top) <= 1, `${what}: the dock's foot ${foot} is not on the sheet's top ${top}`);
}

/** A grey band where the keyboard would be, only for the screenshot, which shows the whole layout. */
async function shotWithKeyboard(page: Page, name: string, height: number): Promise<void> {
  // A page resized for the keyboard ends at its top: the shot shows the short page as it is.
  if (pageResized) return shots.take(page, name);
  await page.evaluate((h) => {
    const d = (globalThis as unknown as { document: { createElement(t: string): { id: string; style: { cssText: string }; textContent: string }; body: { append(n: unknown): void } } }).document;
    const band = d.createElement("div");
    band.id = "kb-fake-keyboard";
    band.textContent = "keyboard";
    band.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${h}px;background:#3a3a40;color:#aaa;font:16px sans-serif;display:flex;align-items:center;justify-content:center;z-index:2147483647;pointer-events:none`;
    d.body.append(band);
  }, height);
  await shots.take(page, name);
  await page.locator("#kb-fake-keyboard").evaluate((el) => (el as unknown as { remove(): void }).remove());
}

const sweep: string[] = [];

async function measure(page: Page, root: Locator, screen: string, keyboardHeight: number): Promise<void> {
  const lines = alignmentLines(await measureAlignment(root), screen);
  if (lines.length > 0) {
    sweep.push(...lines);
    await shotWithKeyboard(page, `kb-align-${screen.replace(/[^a-z0-9]+/gi, "-")}`, keyboardHeight);
  }
}

/** Thorn's action bar, from a tap on his token: a strip at the map's foot on a phone held upright. */
async function thornsBar(page: Page): Promise<Locator> {
  await tapCell(page, run.bounds, { x: 5, y: 5 });
  const bar = page.getByRole("dialog", { name: "Thorn actions" });
  await bar.waitFor();
  return bar;
}

/**
 * Whether `el` shows whole: inside the visual viewport, inside every box
 * around it that clips, and on top at its middle, so a tap there reaches it.
 */
async function shownWhole(el: Locator): Promise<string | null> {
  return el.evaluate((node) => {
    type R = { top: number; bottom: number; left: number; right: number };
    type E = { getBoundingClientRect(): R; parentElement: E | null; contains(n: unknown): boolean };
    const g = globalThis as unknown as { visualViewport: { offsetTop: number; height: number }; getComputedStyle(e: unknown): { overflowX: string; overflowY: string }; document: { elementFromPoint(x: number, y: number): unknown } };
    const e = node as unknown as E;
    const r = e.getBoundingClientRect();
    const v = g.visualViewport;
    if (r.top < v.offsetTop - 0.5 || r.bottom > v.offsetTop + v.height + 0.5) return `outside the visible area (${Math.round(r.top)} to ${Math.round(r.bottom)}, visible to ${Math.round(v.offsetTop + v.height)})`;
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = g.getComputedStyle(p);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const b = p.getBoundingClientRect();
      if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) return `clipped by a box from ${Math.round(b.top)} to ${Math.round(b.bottom)} (${Math.round(r.top)} to ${Math.round(r.bottom)})`;
    }
    const hit = g.document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2) as { tagName?: string; getAttribute?(n: string): string | null; closest?(s: string): { getAttribute(n: string): string | null } | null } | null;
    if (hit && (hit === node || e.contains(hit))) return null;
    const over = hit?.closest?.("[aria-label]");
    return `covered at its middle by ${hit?.tagName?.toLowerCase() ?? "nothing"}${over ? ` in "${over.getAttribute("aria-label")}"` : ""}`;
  });
}

/** The dock's buttons wherever they stand: on the sheet's edge, or in its header where the edge has no room (Room.tsx dockInHeader). */
async function dockButtons(page: Page): Promise<Record<string, Locator>> {
  const found: Record<string, Locator> = {};
  const all = page.locator("[data-rvtt-dock] button, [data-rvtt-dock-action]");
  for (let i = 0; i < (await all.count()); i++) {
    const button = all.nth(i);
    if (!(await button.isVisible())) continue;
    // Under a modal dialog, such as Add a class resource over the sheet, the dock is out of reach on purpose, keyboard or not.
    const reachable = await button.evaluate((el) => {
      const node = el as unknown as { closest(s: string): unknown };
      const modal = (globalThis as unknown as { document: { querySelector(s: string): { contains(n: unknown): boolean } | null } }).document.querySelector("dialog:modal");
      return node.closest("[inert]") === null && (modal === null || modal.contains(el));
    });
    if (!reachable) continue;
    found[`the dock's ${(await button.getAttribute("aria-label")) ?? `button ${i + 1}`}`] = button;
  }
  return found;
}

/**
 * The focused field, the buttons that go with it and the dock show whole
 * over the keyboard and take a tap at their middles (shownWhole), wherever
 * the room put them: the one check every surface that lifts runs.
 */
async function liftedWhole(page: Page, controls: Record<string, Locator>, what: string): Promise<void> {
  const why: Record<string, string> = {};
  await waitFor(`${what}: in view`, async () => {
    for (const [name, control] of Object.entries({ ...controls, ...(await dockButtons(page)) })) {
      const off = await shownWhole(control);
      if (off) why[name] = off;
      else delete why[name];
    }
    return Object.keys(why).length === 0 ? true : null;
  }, 5_000).catch(async () => {
    await shots.take(page, `kb-miss-${what.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`);
    assert.fail(`${what}: ${Object.entries(why).map(([n, w]) => `${n} ${w}`).join(", ")}`);
  });
  // A dock on the sheet's edge keeps its gap under the top bars (pages/fold.ts dockFits, which counts the keyboard): where there is no room for it, its buttons are in the header.
  const dock = page.locator("[data-rvtt-dock]");
  if ((await dock.count()) > 0 && (await dock.isVisible())) {
    const row = await box(dock);
    const bars = await box(page.locator("[data-rvtt-topbar]"));
    const zoom = (row.bottom - row.top) / DOCK_PX;
    assert.ok(row.top >= bars.bottom + DOCK_GAP * zoom - 1, `${what}: the dock's top ${row.top} leaves less than its ${DOCK_GAP} px gap under the bars' foot ${bars.bottom}`);
  }
}

/** The dock's row and its gap under the top bars (pages/fold.ts), in the chrome's own px. */
const DOCK_PX = 48;
const DOCK_GAP = 8;

/**
 * Opens a keyboard `height` px tall (the view's own unless given): the
 * fake visual viewport shrinks, panned `pan` px down as Safari may, or
 * for a `native` view the page itself is made shorter.
 */
async function openKeys(page: Page, view: View, height = view.keyboard, pan = 0): Promise<void> {
  pageResized = view.native === true;
  if (view.native) return page.setViewportSize({ width: view.width, height: view.height - height });
  await keyboard(page, view.height - height, pan);
}

async function closeKeys(page: Page, view: View): Promise<void> {
  pageResized = false;
  if (view.native) return page.setViewportSize({ width: view.width, height: view.height });
  await keyboard(page, null);
}

/** Whether openKeys made the page itself shorter, for the screenshots. */
let pageResized = false;

/**
 * The keyboard opens over a field that has focus, with the page panned
 * `pan` px down as Safari may: the controls and the dock show whole above
 * it (liftedWhole), then `seen` runs, and the keyboard closes.
 */
async function overKeyboard(page: Page, view: View, controls: Record<string, Locator>, what: string, seen: () => Promise<void>, pan = 0): Promise<void> {
  try {
    await openKeys(page, view, view.keyboard, pan);
    await liftedWhole(page, controls, what);
    await seen();
  } finally {
    await closeKeys(page, view);
  }
}

/**
 * Use… on Lay on Hands, at the body's foot where a keyboard covers what
 * opens under it, then the keyboard: the sheet's foot on it, the field and
 * Spend whole in view, the dock on the sheet's edge or in its header, and
 * the sheet back at its height once the keyboard closes. Where the body is
 * too short for the field and Spend, the sheet takes the visible area's
 * height to show them (Sheet.tsx).
 */
async function layOnHands(view: View, fight?: "fight"): Promise<void> {
  const where = `${fight ? "in the fight " : ""}at ${viewName(view)}`;
  const tag = `${fight ? "fight-" : ""}${view.width}-${Math.round(view.scale * 100)}`;
  await setUp(pat, view);
  const sheet = await thornsSheet(pat);
  const hands = usesRow(sheet, "Lay on Hands");
  const use = hands.getByRole("button", { name: "Use Lay on Hands, 25 of 25 left" });
  await use.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "end" }));
  await use.tap();
  const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 25" });
  await field.waitFor();
  assert.equal(await field.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "the field takes focus");
  const layout = await pat.evaluate(() => (globalThis as unknown as KeyboardWindow).innerHeight);
  const normal = await footAt(sheet, layout - 60 * view.scale, "the sheet on the toolbar");
  try {
    await keyboard(pat, layout - view.keyboard);
    await footAt(sheet, layout - view.keyboard, "the sheet's foot on the keyboard");
    const spend = hands.getByRole("button", { name: "Spend", exact: true });
    await wholeInView(sheet, { field, Spend: spend }, `Lay on Hands ${where}`);
    await dockRides(pat, sheet, `Lay on Hands ${where}`);
    await measure(pat, hands, `Lay on Hands' row with its field over the keyboard ${where}`, view.keyboard);
    await measure(pat, sheet.locator("[data-creature-header]").first(), `Thorn's header in the Token sheet ${where}`, view.keyboard);
    const dock = pat.locator("[data-rvtt-dock]");
    if ((await dock.count()) > 0) await measure(pat, dock, `the dock on the raised sheet ${where}`, view.keyboard);
    await shotWithKeyboard(pat, `kb-lay-on-hands-${tag}`, view.keyboard);
    if (view.keyboard < 300) {
      await keyboard(pat, layout - 300);
      await footAt(sheet, layout - 300, "the sheet's foot on a taller keyboard");
      await wholeInView(sheet, { field, Spend: spend }, `Lay on Hands over a 300 px keyboard ${where}`);
      await dockRides(pat, sheet, `Lay on Hands over a 300 px keyboard ${where}`);
      await shotWithKeyboard(pat, `kb-lay-on-hands-300-${tag}`, 300);
    }
  } finally {
    await keyboard(pat, null);
  }
  const back = await footAt(sheet, normal.bottom, "the sheet back on the toolbar");
  assert.ok(Math.abs(back.bottom - back.top - (normal.bottom - normal.top)) <= 1, `the sheet's height is back: ${back.bottom - back.top}, was ${normal.bottom - normal.top}`);
  await hands.getByRole("button", { name: "Cancel", exact: true }).tap();
  await field.waitFor({ state: "detached" });
}

/** The Hit Points section's HP change field and its Apply, in the Token sheet layOnHands left open. */
async function hpChange(view: View): Promise<void> {
  const sheet = tokenSheet(pat);
  const hp = sheet.getByRole("textbox", { name: "HP change" });
  await hp.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "end" }));
  await hp.tap();
  const layout = await pat.evaluate(() => (globalThis as unknown as KeyboardWindow).innerHeight);
  const normal = await box(sheet);
  try {
    await keyboard(pat, layout - view.keyboard);
    await footAt(sheet, layout - view.keyboard, "the sheet's foot on the keyboard");
    const form = sheet.locator("form").filter({ has: pat.getByRole("textbox", { name: "HP change" }) });
    await wholeInView(sheet, { "HP change": hp, Apply: form.getByRole("button", { name: "Apply", exact: true }) }, `HP change at ${viewName(view)}`);
    await measure(pat, form, `the Hit Points entry over the keyboard at ${viewName(view)}`, view.keyboard);
    await shotWithKeyboard(pat, `kb-hp-change-${view.width}-${Math.round(view.scale * 100)}`, view.keyboard);
  } finally {
    await keyboard(pat, null);
  }
  await footAt(sheet, normal.bottom, "the sheet back on the toolbar");
  await hp.blur();
}

const isFocused = (el: Locator) => el.evaluate((node) => node === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement);

/**
 * In the fight: Lay on Hands' field and Spend, then the HP change and
 * Apply, in Thorn's Token sheet over the keyboard, with the dock, whole
 * and on top (liftedWhole). Where the sheet's body is too short for them,
 * as on a phone held sideways at 130%, the sheet takes the visible area's
 * height over the bars, not modal, focus kept in the field, and takes its
 * own shape again as the keyboard closes (Sheet.tsx).
 */
async function sheetLifted(view: View): Promise<void> {
  const where = `in the fight at ${viewName(view)}`;
  const sideways = view.width > view.height;
  await setUp(pat, view);
  const sheet = await thornsSheet(pat);
  const hands = usesRow(sheet, "Lay on Hands");
  const use = hands.getByRole("button", { name: "Use Lay on Hands, 25 of 25 left" });
  await use.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "end" }));
  await use.tap();
  const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 25" });
  await field.waitFor();
  const normal = await box(sheet);
  const seen = view.height - view.keyboard;
  try {
    await openKeys(pat, view);
    await liftedWhole(pat, { field, Spend: hands.getByRole("button", { name: "Spend", exact: true }) }, `Lay on Hands ${where}`);
    const raised = await box(sheet);
    assert.ok(raised.bottom <= seen + 1, `${where}: the sheet's foot ${raised.bottom} is under the keyboard's top ${seen}`);
    if (sideways) {
      // Its body there is shorter than the field's row: it takes the visible area's height, over the bars.
      assert.ok(Math.abs(raised.top) <= 1 && Math.abs(raised.bottom - seen) <= 1, `${where}: the sheet stands from ${raised.top} to ${raised.bottom}, not over the visible area, 0 to ${seen}`);
    }
    assert.equal(await isFocused(field), true, `${where}: the field keeps focus`);
    assert.equal(await sheet.evaluate((el) => (el as unknown as { matches(s: string): boolean }).matches(":modal")), false, `${where}: the sheet is not modal`);
    await measure(pat, hands, `Lay on Hands' row over the keyboard ${where}`, view.keyboard);
    await shotWithKeyboard(pat, `kb-sheet-lifted-${shotTag(view, "fight")}`, view.keyboard);
  } finally {
    await closeKeys(pat, view);
  }
  await waitFor(`${where}: the sheet in its own shape again`, async () => {
    const back = await box(sheet);
    return Math.abs(back.top - normal.top) <= 1 && Math.abs(back.bottom - normal.bottom) <= 1 ? true : null;
  }, 5_000).catch(async () => assert.fail(`${where}: the sheet stands from ${(await box(sheet)).top} to ${(await box(sheet)).bottom}, not ${normal.top} to ${normal.bottom}, once the keyboard closes`));
  assert.equal(await isFocused(field), true, `${where}: the field keeps focus as the keyboard closes`);
  await hands.getByRole("button", { name: "Cancel", exact: true }).tap();
  await field.waitFor({ state: "detached" });

  const hp = sheet.getByRole("textbox", { name: "HP change" });
  await hp.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "end" }));
  await hp.tap();
  const form = sheet.locator("form").filter({ has: pat.getByRole("textbox", { name: "HP change" }) });
  await overKeyboard(pat, view, { "HP change": hp, Apply: form.getByRole("button", { name: "Apply", exact: true }) }, `HP change ${where}`, async () => {
    await shotWithKeyboard(pat, `kb-sheet-hp-lifted-${shotTag(view, "fight")}`, view.keyboard);
  });
  if (!sideways && view.keyboard < 300) {
    // A 300 px keyboard leaves the dock no room above the raised sheet under the turn band: its buttons join the header.
    const tall = { ...view, keyboard: 300 };
    await overKeyboard(pat, tall, { "HP change": hp, Apply: form.getByRole("button", { name: "Apply", exact: true }) }, `HP change over a 300 px keyboard ${where}`, async () => {
      await shotWithKeyboard(pat, `kb-sheet-hp-lifted-300-${shotTag(view, "fight")}`, 300);
    });
  }
  await hp.blur();
}

/**
 * The roll card's Total and Send over the keyboard, on a roll the DM asks
 * of Thorn. Where the screen is too short for the card at the foot, as at
 * 480 x 320 at 130%, it waits as "Roll asked", whose tap summons it onto
 * the toolbar or the screen before Total takes focus.
 */
async function rollCard(view: View): Promise<void> {
  const where = `in the fight at ${viewName(view)}`;
  await setUp(pat, view);
  const id = randomUUID();
  await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 14, dcShown: true, resultShown: true, targets: [{ characterId: run.thorn }] } });
  const card = pat.getByRole("dialog", { name: "The DM asks for a roll" });
  try {
    const total = card.getByLabel("Total Thorn rolled");
    const asked = pat.getByRole("button", { name: /^Roll asked/ }).first();
    await waitFor(`the ask ${where}`, async () => ((await total.isVisible()) || (await asked.isVisible()) ? true : null));
    if (!(await total.isVisible())) {
      await asked.tap();
      await total.waitFor();
    }
    await total.tap();
    await overKeyboard(pat, view, { Total: total, Send: card.getByRole("button", { name: "Send", exact: true }) }, `the roll card ${where}`, async () => {
      assert.equal(await isFocused(total), true, `${where}: Total keeps focus`);
      await measure(pat, card, `the roll card over the keyboard ${where}`, view.keyboard);
      await shotWithKeyboard(pat, `kb-roll-card-${shotTag(view, "fight")}`, view.keyboard);
    });
  } finally {
    await ops.send({ t: "roll.close", rollIds: [id] });
  }
  await card.waitFor({ state: "detached" });
}

function areaOptions(page: Page): Locator {
  return page.getByRole("toolbar", { name: "Area options" });
}

/**
 * The Area tool's Spell field in its options row over the keyboard, and
 * the spells it finds in their popover over the row, on the row's fill.
 */
async function optionsInline(view: View): Promise<void> {
  const where = `at ${viewName(view)}`;
  await setUp(pat, view);
  await pickTool(pat, "Area");
  const row = areaOptions(pat);
  const spell = row.locator("[data-options-row]").getByRole("combobox", { name: "Spell" });
  await spell.waitFor();
  await spell.tap();
  await overKeyboard(pat, view, { Spell: spell }, `the Area's Spell field in its row ${where}`, async () => {
    await spell.pressSequentially("fire");
    const spells = pat.getByRole("dialog", { name: "Spells" });
    await spells.waitFor();
    await liftedWhole(pat, { Spell: spell, "the first spell": spells.getByRole("button").first() }, `the Spells popover over the row ${where}`);
    const shown = await box(spells);
    const field = await box(spell);
    assert.ok(shown.bottom <= field.top + 0.5, `${where}: the Spells popover (${shown.top} to ${shown.bottom}) stands over the field (${field.top})`);
    await shotWithKeyboard(pat, `kb-options-inline-${shotTag(view)}`, view.keyboard);
    await spell.fill("");
  });
  await spell.blur();
  await pickTool(pat, "Select");
}

/**
 * An area aimed, whose row of Place, Cancel and the rest sends the Spell
 * field to the Shape chip's popover: the field there over the keyboard,
 * whole, in the popover standing on the raised row. Then a scroll of Pat's
 * own in the popover, by the wheel, stays put as the keyboard changes
 * height and the popover is placed again (Popover.tsx followField).
 */
async function optionsPopover(view: View): Promise<void> {
  const where = `at ${viewName(view)}`;
  await setUp(pat, view);
  await pickTool(pat, "Area");
  await tapCell(pat, run.bounds, { x: 12, y: 9 });
  const row = areaOptions(pat);
  await row.locator('[data-options-row] > [data-rvtt-slot="place"]').waitFor();
  assert.equal(await row.locator("[data-options-row]").getByRole("combobox", { name: "Spell" }).count(), 0, `${where}: the aimed area's row has no room for Spell`);
  await row.getByRole("button", { name: /^Shape:/ }).tap();
  const popover = pat.getByRole("dialog", { name: "Shape" });
  await popover.waitFor();
  const field = popover.getByRole("textbox", { name: "Spell" });
  await field.tap();
  const scrollTop = () => popover.evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop);
  try {
    await openKeys(pat, view);
    await liftedWhole(pat, { Spell: field }, `the Spell field in the Shape popover ${where}`);
    const shown = await box(popover);
    const raised = await box(row.locator("[data-options-row]"));
    assert.ok(shown.bottom <= raised.top + 0.5, `${where}: the Shape popover (${shown.top} to ${shown.bottom}) stands on the raised row (${raised.top})`);
    await shotWithKeyboard(pat, `kb-options-popover-${shotTag(view)}`, view.keyboard);
    // Pat scrolls the popover back to its top, the field out of its view.
    const kept = await scrollTop();
    assert.ok(kept > 0, `${where}: the popover scrolled to show the field`);
    await pat.mouse.move((shown.left + shown.right) / 2, (shown.top + shown.bottom) / 2);
    // Far enough up for any zoom: the wheel's pixels are the page's, and scrollTop the zoomed popover's own.
    await pat.mouse.wheel(0, -(kept + 50) * 2);
    await waitFor("the wheel's scroll", async () => ((await scrollTop()) === 0 ? true : null), 5_000).catch(async () => assert.fail(`${where}: the popover's scrollTop is ${await scrollTop()} after the wheel, from ${kept}`));
    // The suggestions bar over the keys goes: the keyboard is 40 px shorter, and the popover is placed again.
    await openKeys(pat, view, view.keyboard - 40);
    await waitFor("the popover placed on the lower row", async () => ((await box(popover)).bottom > shown.bottom + 20 ? true : null), 5_000);
    await pat.evaluate(() => {
      const frame = (globalThis as unknown as { requestAnimationFrame(f: () => void): void }).requestAnimationFrame;
      return new Promise<void>((done) => frame(() => frame(done)));
    });
    assert.equal(await scrollTop(), 0, `${where}: the popover keeps the place Pat scrolled to`);
  } finally {
    await closeKeys(pat, view);
  }
  await pat.keyboard.press("Escape");
  await pickTool(pat, "Select");
}

/** The tag a screenshot names a view by, with what else holds it: `fight-844x390-130`, `fight-320x568-130-kb300`, `fight-844x390-130-native`. */
const shotTag = (view: View, extra = "") =>
  `${extra ? `${extra}-` : ""}${view.width}x${view.height}-${Math.round(view.scale * 100)}${view.keyboard !== usualKeyboard(view) ? `-kb${view.keyboard}` : ""}${view.native ? "-native" : ""}`;

/** Use… on Lay on Hands in the token bar's Uses drawer: the field and Spend over the keyboard, with the page panned `pan` px. */
async function barUses(view: View, pan = 0, extra = ""): Promise<void> {
  await setUp(pat, view);
  const bar = await thornsBar(pat);
  const uses = await barControl(bar, "Uses");
  await waitFor("the Uses button ready", async () => ((await uses.isEnabled()) ? true : null));
  if ((await uses.getAttribute("aria-pressed")) !== "true") await uses.click();
  const drawer = bar.locator("[data-uses-drawer]");
  await drawer.waitFor();
  const hands = drawer.getByRole("listitem").filter({ has: pat.getByText("Lay on Hands", { exact: true }) });
  await hands.getByRole("button", { name: "Use Lay on Hands, 25 of 25 left" }).tap();
  const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 25" });
  await field.waitFor();
  const where = `${extra ? `${extra} ` : ""}at ${viewName(view)}`;
  await overKeyboard(pat, view, { field, Spend: hands.getByRole("button", { name: "Spend", exact: true }) }, `the bar's Uses drawer ${where}`, async () => {
    await measure(pat, hands, `Lay on Hands' row in the bar's Uses drawer over the keyboard ${where}`, view.keyboard);
    await shotWithKeyboard(pat, `kb-bar-uses-${shotTag(view, extra)}`, view.keyboard - pan);
  }, pan);
  await hands.getByRole("button", { name: "Cancel", exact: true }).tap();
  await field.waitFor({ state: "detached" });
}

/** The token bar's HP entry and Apply over the keyboard, with the page panned `pan` px. */
async function barHp(view: View, pan = 0, extra = ""): Promise<void> {
  await setUp(pat, view);
  const bar = await thornsBar(pat);
  const hp = (await barControl(bar, "HP change", "textbox")).first();
  await hp.tap();
  const form = bar.locator("form").filter({ has: pat.getByRole("textbox", { name: "HP change" }) }).first();
  const where = `${extra ? `${extra} ` : ""}at ${viewName(view)}`;
  await overKeyboard(pat, view, { "HP change": hp, Apply: form.getByRole("button", { name: "Apply", exact: true }) }, `the bar's HP entry ${where}`, async () => {
    await measure(pat, form, `the bar's HP entry over the keyboard ${where}`, view.keyboard);
    await shotWithKeyboard(pat, `kb-bar-hp-${shotTag(view, extra)}`, view.keyboard - pan);
  }, pan);
  await hp.blur();
}

/** A sheet dialog's field, Add a class resource's Name, over the keyboard with Add. */
async function addResource(view: View, extra = ""): Promise<void> {
  await setUp(pat, view);
  const sheet = await thornsSheet(pat);
  const add = sheet.locator('xpath=.//section[*[self::h3 or self::h4][normalize-space()="Uses"]]').getByRole("button", { name: "Add a class resource" });
  await add.scrollIntoViewIfNeeded();
  await add.tap();
  const dialog = pat.getByRole("dialog", { name: "Add a class resource", exact: true });
  await dialog.waitFor();
  await dialog.getByRole("radio", { name: "Your own" }).check();
  const name = dialog.getByRole("textbox", { name: "Name" });
  await name.tap();
  const where = `${extra ? `${extra} ` : ""}at ${viewName(view)}`;
  await overKeyboard(pat, view, { Name: name, Add: dialog.getByRole("button", { name: "Add", exact: true }) }, `Add a class resource ${where}`, async () => {
    await measure(pat, dialog.locator("section").first(), `Add a class resource over the keyboard ${where}`, view.keyboard);
    await shotWithKeyboard(pat, `kb-dialog-add-${shotTag(view, extra)}`, view.keyboard);
  });
  await dialog.getByRole("button", { name: /^Close/ }).first().click();
  await dialog.waitFor({ state: "detached" });
}

describe("raccoon-vtt: a sheet's field over the phone keyboard", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await patContext.addInitScript(fakeViewport);
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    dmConsole.attach(dm);
    patConsole.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    patCdp = await patContext.newCDPSession(pat);
    pat.on("request", (r) => {
      const at = new URL(r.url());
      if (at.origin === server.origin && (at.pathname.startsWith("/api/") || at.pathname.startsWith("/ws")) && !at.pathname.startsWith("/api/assets")) patRequests.push(Date.now());
    });
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, patConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("kb-1. a DM's room with Pat's Thorn on the map, who has Lay on Hands", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    const password = await dm.getByLabel("Player password").inputValue();
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
    const joined = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(45), level: 5 } });
    await ops.send({ t: "character.update", characterId: run.thorn, patch: { resources: [{ id: "loh", name: "Lay on Hands", max: 25, reset: "long", pool: true }] } });
    await ops.send({ t: "token.create", token: { id: run.thornToken, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "pc", name: "Thorn", x: 5, y: 5, disposition: "ally", actor: { ref: run.thorn } } });
    await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", x: 9, y: 5, disposition: "hostile", actor: { inline: actor(7) } } });

    patConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await pat.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Pat's snapshot", () => patSocket.state);
    patConsole.allow = [];
  });

  for (const view of VIEWS) {
    test(`kb-2. at ${viewName(view)}, Lay on Hands' field and Spend show over the keyboard, and the sheet comes back as it closes`, () => layOnHands(view));
    test(`kb-3. at ${viewName(view)}, the Hit Points section's HP change field and Apply show over the keyboard`, () => hpChange(view));
  }

  for (const view of VIEWS.filter((v) => v.scale === 1)) test(`kb-4. in a browser that resizes the page for the keyboard at ${viewName(view)}, Lay on Hands' field keeps focus and shows with Spend, and a page shorter than wide leaves the room upright`, async () => {
    await setUp(pat, view);
    const sheet = await thornsSheet(pat);
    const hands = usesRow(sheet, "Lay on Hands");
    const use = hands.getByRole("button", { name: "Use Lay on Hands, 25 of 25 left" });
    await use.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "end" }));
    await use.tap();
    const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 25" });
    await field.waitFor();
    // The layout viewport itself shrinks, and the visual viewport with it, so no keyboard is read: the room lays out for the shorter page.
    const shorter = view.height - view.keyboard;
    try {
      await pat.setViewportSize({ width: view.width, height: shorter });
      await footAt(sheet, shorter - 60, "the sheet on the toolbar of the shorter page");
      await wholeInView(sheet, { field, Spend: hands.getByRole("button", { name: "Spend", exact: true }) }, "Lay on Hands on the shorter page");
      assert.equal(await field.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "the field keeps focus");
      await shots.take(pat, `kb-android-resized-${view.width}`);
      // A taller keyboard leaves the page shorter than it is wide: the room stays upright, its sheet across the foot, not docked on the right.
      const flat = view.width - 40;
      await pat.setViewportSize({ width: view.width, height: flat });
      await footAt(sheet, flat - 60, "the sheet on the toolbar of the page shorter than wide");
      const across = await box(sheet);
      assert.ok(across.left <= 1 && across.right >= view.width - 1, `the sheet stands from ${across.left} to ${across.right}, docked as on a phone held sideways, not across the foot`);
      assert.equal(await isFocused(field), true, "the field keeps focus on the page shorter than wide");
      await shots.take(pat, `kb-resized-flat-${view.width}`);
    } finally {
      await pat.setViewportSize({ width: view.width, height: view.height });
    }
    await footAt(sheet, view.height - 60, "the sheet back on the toolbar");
    await hands.getByRole("button", { name: "Cancel", exact: true }).tap();
    await field.waitFor({ state: "detached" });
  });

  for (const how of ["wheel", "touch"] as const) test(`kb-5. a scroll of Pat's own by ${how === "wheel" ? "the wheel" : "a finger"} while he types stays put as the keyboard changes height`, async () => {
    const view = VIEWS[0]!;
    await setUp(pat, view);
    const sheet = await thornsSheet(pat);
    const hands = usesRow(sheet, "Lay on Hands");
    const use = hands.getByRole("button", { name: "Use Lay on Hands, 25 of 25 left" });
    await use.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "end" }));
    await use.tap();
    const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 25" });
    await field.waitFor();
    const layout = await pat.evaluate(() => (globalThis as unknown as KeyboardWindow).innerHeight);
    const body = sheet.locator("[data-pane-body]");
    const scrollTop = () => body.evaluate((el) => (el as unknown as { scrollTop: number }).scrollTop);
    try {
      await keyboard(pat, layout - view.keyboard);
      await footAt(sheet, layout - view.keyboard, "the sheet's foot on the keyboard");
      await wholeInView(sheet, { field }, "Lay on Hands before the scroll");
      const at = await box(body);
      // Far enough down that the field leaves the body's top, so keeping it in view would undo the scroll.
      const x = (at.left + at.right) / 2;
      for (let i = 0; i < 4 && (await box(field)).bottom >= at.top; i++) {
        if (how === "wheel") {
          await pat.mouse.move(x, (at.top + at.bottom) / 2);
          await pat.mouse.wheel(0, (await box(field)).bottom - at.top + 20);
        } else await touchSwipe(patCdp, { x, y: at.bottom - 10 }, { x, y: at.top + 10 }, { steps: 12, everyMs: 30 });
        await waitFor("the scroll to settle", async () => {
          const a = await scrollTop();
          await pat.waitForTimeout(150);
          return a === (await scrollTop()) ? true : null;
        }, 5_000);
      }
      assert.ok((await box(field)).bottom < at.top, "the field is above the body's top");
      const mine = await scrollTop();
      // The suggestions bar over the keys goes, as iOS does once a field holds a number: the keyboard is 40 px shorter.
      await keyboard(pat, layout - view.keyboard + 40);
      await footAt(sheet, layout - view.keyboard + 40, "the sheet's foot on the shorter keyboard");
      await pat.evaluate(() => {
        const frame = (globalThis as unknown as { requestAnimationFrame(f: () => void): void }).requestAnimationFrame;
        return new Promise<void>((done) => frame(() => frame(done)));
      });
      // A body scrolled to its end can only scroll back by what it grew, which the browser does: no more than that.
      const end = await body.evaluate((el) => {
        const b = el as unknown as { scrollHeight: number; clientHeight: number };
        return b.scrollHeight - b.clientHeight;
      });
      assert.equal(Math.round(await scrollTop()), Math.round(Math.min(mine, end)), "the body keeps the place Pat scrolled to");
    } finally {
      await keyboard(pat, null);
    }
    await hands.getByRole("button", { name: "Cancel", exact: true }).tap();
    await field.waitFor({ state: "detached" });
  });

  test("kb-6. Safari pans the page down to show a low field: the sheet stands at the visible area's foot with the field and Spend whole, and the token bar's HP entry and Apply too", async () => {
    const view = VIEWS[0]!;
    const pan = 120;
    await setUp(pat, view);
    const sheet = await thornsSheet(pat);
    const hands = usesRow(sheet, "Lay on Hands");
    const use = hands.getByRole("button", { name: "Use Lay on Hands, 25 of 25 left" });
    await use.evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "end" }));
    await use.tap();
    const field = hands.getByRole("textbox", { name: "Lay on Hands to spend, up to 25" });
    await field.waitFor();
    const layout = await pat.evaluate(() => (globalThis as unknown as KeyboardWindow).innerHeight);
    try {
      await keyboard(pat, layout - view.keyboard, pan);
      await footAt(sheet, layout - view.keyboard + pan, "the sheet's foot at the panned visible area's foot");
      await liftedWhole(pat, { field, Spend: hands.getByRole("button", { name: "Spend", exact: true }) }, "Lay on Hands on the panned page");
      const top = (await box(sheet)).top;
      assert.ok(top >= pan - 0.5, `the sheet's top ${top} is panned out of sight, above ${pan}`);
      await shotWithKeyboard(pat, `kb-panned-sheet-${shotTag(view)}`, view.keyboard - pan);
    } finally {
      await keyboard(pat, null);
    }
    await hands.getByRole("button", { name: "Cancel", exact: true }).tap();
    await field.waitFor({ state: "detached" });
    await barHp(view, pan, "panned");
  });

  for (const view of VIEWS) {
    test(`kb-7. at ${viewName(view)}, Use… on Lay on Hands in the token bar's Uses drawer: the field and Spend show over the keyboard`, () => barUses(view));
    test(`kb-8. at ${viewName(view)}, the token bar's HP entry and Apply show over the keyboard`, () => barHp(view));
    test(`kb-9. at ${viewName(view)}, a sheet dialog's field, Add a class resource's Name, shows over the keyboard with Add`, () => addResource(view));
  }

  test("kb-10. a tap on Spend with the keyboard up spends, and the sheet stays on the keyboard until it closes", async () => {
    const view = VIEWS[0]!;
    await setUp(pat, view);
    const sheet = await thornsSheet(pat);
    const hands = usesRow(sheet, "Lay on Hands");
    const before = usedOf("loh");
    await hands.getByRole("button", { name: /^Use Lay on Hands, \d+ of 25 left$/ }).tap();
    const field = hands.getByRole("textbox", { name: /^Lay on Hands to spend, up to \d+$/ });
    await field.fill("3");
    const layout = await pat.evaluate(() => (globalThis as unknown as KeyboardWindow).innerHeight);
    try {
      await keyboard(pat, layout - view.keyboard);
      await footAt(sheet, layout - view.keyboard, "the sheet's foot on the keyboard");
      // The button's press takes focus from the field while the keyboard is still up: the sheet must not drop under the finger before the tap lands.
      await hands.getByRole("button", { name: "Spend", exact: true }).tap();
      await waitFor("the spend in the DM's copy", () => (usedOf("loh") === before + 3 ? true : null), 10_000).catch(() => assert.fail(`Lay on Hands used ${usedOf("loh")}, not ${before + 3}: the tap missed Spend`));
      await footAt(sheet, layout - view.keyboard, "the sheet still on the keyboard after the tap");
    } finally {
      await keyboard(pat, null);
    }
    await footAt(sheet, layout - 60 * view.scale, "the sheet back on the toolbar once the keyboard closes");
    // Lay on Hands full again, as the steps after this one find it.
    await ops.send({ t: "character.update", characterId: run.thorn, patch: { resources: [{ id: "loh", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true }] } });
    await waitFor("Lay on Hands full again", () => (usedOf("loh") === 0 ? true : null));
  });

  test("kb-11. Thorn's turn in a fight: the alerts fold into the dock on a phone's sheet", async () => {
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: "e-thorn", tokenId: run.thornToken, value: 18 },
        { id: "e-gob", tokenId: run.goblin, value: 8 },
      ],
    });
    await ops.send({ t: "encounter.next" });
    await waitFor("Thorn's turn", () => (dmSocket.state?.encounter?.activeEntryId === "e-thorn" ? true : null));
  });

  for (const view of VIEWS) {
    /*
     * The smallest phone at 130% in a fight has 271 px above the number pad, of which the bars and the turn band take
     * 100, the dock 56 and the header 56: 58 px of body, under the field with Spend wrapped below it. There the sheet
     * takes the visible area's height, the dock's buttons join its header, and the field and Spend show.
     */
    test(`kb-12. in the fight at ${viewName(view)}, the dock rides the raised sheet or joins its header, and Lay on Hands' field and Spend show`, () => layOnHands(view, "fight"));
  }

  for (const view of LIFT) {
    test(`kb-13. in the fight at ${viewName(view)}, Lay on Hands and the HP change in the Token sheet show whole over the keyboard with the dock, and take a tap`, () => sheetLifted(view));
    test(`kb-14. in the fight at ${viewName(view)}, the token bar's Uses drawer and HP entry show whole over the keyboard, and take a tap`, async () => {
      await barUses(view, 0, "fight");
      await barHp(view, 0, "fight");
    });
    test(`kb-15. in the fight at ${viewName(view)}, Add a class resource's Name and Add show whole over the keyboard`, () => addResource(view, "fight"));
    // Sideways the ask waits in the alerts column, whose card is the column's (InitiativeStrip.tsx), not the card at the foot.
    if (view.height > view.width) test(`kb-16. in the fight at ${viewName(view)}, the roll card's Total and Send show whole over the keyboard`, () => rollCard(view));
    test(`kb-17. in the fight at ${viewName(view)}, the Area's Spell field in its row and the Spells popover show whole over the keyboard`, () => optionsInline(view));
    test(`kb-18. in the fight at ${viewName(view)}, the Spell field in the Shape popover shows whole over the keyboard, and a scroll of Pat's own there is kept`, () => optionsPopover(view));
  }

  /*
   * The roll card with the page itself resized: upright over a 300 px keyboard, and at 480 x 320 at 130%, where the card
   * waits as "Roll asked" and is summoned onto the screen before Total takes focus, leaving an 80 px page.
   */
  for (const view of [
    { width: 320, height: 568, scale: 1.3, keyboard: 300, native: true },
    { width: 480, height: 320, scale: 1.3, keyboard: 216, native: true },
  ] satisfies View[]) {
    test(`kb-16. in the fight at ${viewName(view)}, the roll card's Total and Send show whole over the keyboard`, () => rollCard(view));
  }

  test("kb-19. the raised sheets line up, nothing over 1 px, and the dock rode them on the tall phone", () => {
    assert.deepEqual(sweep, []);
    for (const view of VIEWS.filter((v) => v.height === 844)) assert.ok(docked.has(`Lay on Hands in the fight at ${viewName(view)}`), `no dock on the sheet at ${viewName(view)}`);
  });

  test("kb-20. no console errors on any page", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page");
    assert.deepEqual(patConsole.errors, [], "Pat's page");
  });
});
