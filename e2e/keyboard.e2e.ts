import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { barControl, ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, tapCell, touchSwipe, waitFor, type Server } from "./harness.ts";

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
 *   the field and Spend show whole. On the small phone a keyboard of 300
 *   px leaves room for the field alone, and the field still shows.
 * - The keyboard closing brings the sheet back to its height.
 * - The same for the Hit Points section's HP change field and Apply.
 * - Android Chrome resizes the page itself for its keyboard (index.html's
 *   interactive-widget=resizes-content): on the page made as much shorter
 *   the field keeps focus and shows with Spend.
 * - A scroll of Pat's own while he types, by the wheel or a finger, is
 *   kept when the keyboard changes height.
 * - Over the keyboard, whole, on top and unclipped: Lay on Hands' field and
 *   Spend in the token bar's Uses drawer, the bar's HP entry and Apply,
 *   and Add a class resource's Name with Add, a dialog's sheet.
 * - Then in a fight, on Thorn's turn, the alerts fold into the dock on the
 *   sheet's top edge, which rides the raised sheet. The small phone at 130%
 *   has room under the turn band for the field alone.
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

type View = { width: number; height: number; scale: number; keyboard: number };
const VIEWS: View[] = [
  { width: 390, height: 844, scale: 1, keyboard: 300 },
  { width: 390, height: 844, scale: 1.3, keyboard: 300 },
  { width: 320, height: 568, scale: 1, keyboard: 216 },
  { width: 320, height: 568, scale: 1.3, keyboard: 216 },
];
const viewName = (v: View) => `${v.width} x ${v.height} at ${Math.round(v.scale * 100)}%`;

type Box = { top: number; bottom: number; left: number; right: number };
/** The page-side shapes the fake viewport and the checks use, as e2e code has no DOM types. */
type KeyboardWindow = { innerHeight: number; rvttKeyboard(height: number | null): void; visualViewport: { offsetTop: number; height: number } };

/**
 * A visual viewport the test sizes, installed before the page's own script
 * runs. Its height follows the window's until rvttKeyboard sets one, and
 * each change fires `resize`, as the real one does when a keyboard opens.
 */
function fakeViewport(): void {
  const w = globalThis as unknown as { innerHeight: number; innerWidth: number; rvttKeyboard?: (height: number | null) => void };
  const viewport = new EventTarget();
  let height: number | null = null;
  const read = (get: () => number) => ({ get, configurable: true });
  Object.defineProperties(viewport, {
    height: read(() => height ?? w.innerHeight),
    width: read(() => w.innerWidth),
    offsetTop: read(() => 0),
    offsetLeft: read(() => 0),
    pageTop: read(() => 0),
    pageLeft: read(() => 0),
    scale: read(() => 1),
  });
  Object.defineProperty(globalThis, "visualViewport", { configurable: true, get: () => viewport });
  w.rvttKeyboard = (h) => {
    height = h;
    viewport.dispatchEvent(new Event("resize"));
  };
}

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 1, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

async function setUp(page: Page, view: View): Promise<void> {
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

async function box(target: Locator): Promise<Box> {
  const b = await target.boundingBox();
  assert.ok(b, "the element has a box");
  return { top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width };
}

const keyboard = (page: Page, height: number | null) => page.evaluate((h) => (globalThis as unknown as KeyboardWindow).rvttKeyboard(h), height);
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

/** The dock's row, where the sheet folds the fight's alerts, stands on the sheet's top edge. */
async function dockRides(page: Page, sheet: Locator, what: string): Promise<void> {
  const dock = page.locator("[data-rvtt-dock]");
  if ((await dock.count()) === 0) return;
  docked.add(what);
  const top = (await box(sheet)).top;
  const foot = (await box(dock)).bottom;
  assert.ok(Math.abs(foot - top) <= 1, `${what}: the dock's foot ${foot} is not on the sheet's top ${top}`);
}

/** A grey band where the keyboard would be, only for the screenshot, which shows the whole layout. */
async function shotWithKeyboard(page: Page, name: string, height: number): Promise<void> {
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
    const hit = g.document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return hit && (hit === node || e.contains(hit)) ? null : "covered at its middle";
  });
}

/**
 * The keyboard opens over a field that has focus: each of `controls`
 * shows whole above it (shownWhole), then `seen` runs, and the keyboard
 * closes.
 */
async function overKeyboard(page: Page, view: View, controls: Record<string, Locator>, what: string, seen: () => Promise<void>): Promise<void> {
  const layout = await page.evaluate(() => (globalThis as unknown as KeyboardWindow).innerHeight);
  try {
    await keyboard(page, layout - view.keyboard);
    const why: Record<string, string> = {};
    await waitFor(`${what}: in view`, async () => {
      for (const [name, control] of Object.entries(controls)) {
        const off = await shownWhole(control);
        if (off) why[name] = off;
        else delete why[name];
      }
      return Object.keys(why).length === 0 ? true : null;
    }, 5_000).catch(() => assert.fail(`${what}: ${Object.entries(why).map(([n, w]) => `${n} ${w}`).join(", ")}`));
    await seen();
  } finally {
    await keyboard(page, null);
  }
}

/**
 * Use… on Lay on Hands, at the body's foot where a keyboard covers what
 * opens under it, then the keyboard: the sheet's foot on it, the field and
 * `shows` whole in view, the dock on the sheet's edge, and the sheet back
 * at its height once the keyboard closes.
 */
async function layOnHands(view: View, shows: "Spend" | "field", fight?: "fight"): Promise<void> {
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
    await wholeInView(sheet, shows === "Spend" ? { field, Spend: spend } : { field }, `Lay on Hands ${where}`);
    await dockRides(pat, sheet, `Lay on Hands ${where}`);
    await measure(pat, hands, `Lay on Hands' row with its field over the keyboard ${where}`, view.keyboard);
    await measure(pat, sheet.locator("[data-creature-header]").first(), `Thorn's header in the Token sheet ${where}`, view.keyboard);
    const dock = pat.locator("[data-rvtt-dock]");
    if ((await dock.count()) > 0) await measure(pat, dock, `the dock on the raised sheet ${where}`, view.keyboard);
    await shotWithKeyboard(pat, `kb-lay-on-hands-${tag}`, view.keyboard);
    if (view.keyboard < 300) {
      await keyboard(pat, layout - 300);
      await footAt(sheet, layout - 300, "the sheet's foot on a taller keyboard");
      await wholeInView(sheet, { field }, `Lay on Hands' field alone over a 300 px keyboard ${where}`);
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
    test(`kb-2. at ${viewName(view)}, Lay on Hands' field and Spend show over the keyboard, and the sheet comes back as it closes`, () => layOnHands(view, "Spend"));
    test(`kb-3. at ${viewName(view)}, the Hit Points section's HP change field and Apply show over the keyboard`, () => hpChange(view));
  }

  for (const view of VIEWS.filter((v) => v.scale === 1)) test(`kb-4. on Android Chrome at ${viewName(view)}, which resizes the page for the keyboard, Lay on Hands' field keeps focus and shows with Spend`, async () => {
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

  for (const view of VIEWS) {
    test(`kb-6. at ${viewName(view)}, Use… on Lay on Hands in the token bar's Uses drawer: the field and Spend show over the keyboard`, async () => {
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
      await overKeyboard(pat, view, { field, Spend: hands.getByRole("button", { name: "Spend", exact: true }) }, `the bar's Uses drawer at ${viewName(view)}`, async () => {
        await measure(pat, hands, `Lay on Hands' row in the bar's Uses drawer over the keyboard at ${viewName(view)}`, view.keyboard);
        await shotWithKeyboard(pat, `kb-bar-uses-${view.width}-${Math.round(view.scale * 100)}`, view.keyboard);
      });
      await hands.getByRole("button", { name: "Cancel", exact: true }).tap();
      await field.waitFor({ state: "detached" });
    });

    test(`kb-7. at ${viewName(view)}, the token bar's HP entry and Apply show over the keyboard`, async () => {
      await setUp(pat, view);
      const bar = await thornsBar(pat);
      const hp = (await barControl(bar, "HP change", "textbox")).first();
      await hp.tap();
      const form = bar.locator("form").filter({ has: pat.getByRole("textbox", { name: "HP change" }) }).first();
      await overKeyboard(pat, view, { "HP change": hp, Apply: form.getByRole("button", { name: "Apply", exact: true }) }, `the bar's HP entry at ${viewName(view)}`, async () => {
        await measure(pat, form, `the bar's HP entry over the keyboard at ${viewName(view)}`, view.keyboard);
        await shotWithKeyboard(pat, `kb-bar-hp-${view.width}-${Math.round(view.scale * 100)}`, view.keyboard);
      });
      await hp.blur();
    });

    test(`kb-8. at ${viewName(view)}, a sheet dialog's field, Add a class resource's Name, shows over the keyboard with Add`, async () => {
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
      await overKeyboard(pat, view, { Name: name, Add: dialog.getByRole("button", { name: "Add", exact: true }) }, `Add a class resource at ${viewName(view)}`, async () => {
        await measure(pat, dialog.locator("section").first(), `Add a class resource over the keyboard at ${viewName(view)}`, view.keyboard);
        await shotWithKeyboard(pat, `kb-dialog-add-${view.width}-${Math.round(view.scale * 100)}`, view.keyboard);
      });
      await dialog.getByRole("button", { name: /^Close/ }).first().click();
      await dialog.waitFor({ state: "detached" });
    });
  }

  test("kb-9. Thorn's turn in a fight: the alerts fold into the dock on a phone's sheet", async () => {
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
     * 100, the dock 56 and the header 56: 58 px of body, under the field with Spend wrapped below it. So there the
     * field alone shows, Spend a scroll away, as fieldScroll keeps a field before its form.
     */
    const cramped = view.width === 320 && view.scale > 1;
    const shows = cramped ? "field" : "Spend";
    test(`kb-10. in the fight at ${viewName(view)}, the dock rides the raised sheet, and Lay on Hands' ${cramped ? "field shows" : "field and Spend show"}`, () => layOnHands(view, shows, "fight"));
  }

  test("kb-11. the raised sheets line up, nothing over 1 px, and the dock rode them on the tall phone", () => {
    assert.deepEqual(sweep, []);
    for (const view of VIEWS.filter((v) => v.height === 844)) assert.ok(docked.has(`Lay on Hands in the fight at ${viewName(view)}`), `no dock on the sheet at ${viewName(view)}`);
  });

  test("kb-12. no console errors on any page", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's page");
    assert.deepEqual(patConsole.errors, [], "Pat's page");
  });
});
