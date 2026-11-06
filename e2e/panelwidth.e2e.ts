import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, pagePoint, pickOption, pickTool, Shots, SocketWatch, startServer, Touches, waitFor, type Server } from "./harness.ts";

/**
 * A side panel that resizes, and a sheet a mouse can grow and shrink
 * (docs/design/design-v1-panel-size.md section 9), on the real server
 * serving the production build.
 *
 * The sheet's half (PS-B, steps sm-1 to sm-6): where any pointer is fine,
 * a sheet that swipes shows Up and Down beside its grabber, which step it
 * between its stands with the slide a release plays, and a mouse drags the
 * strip around the grabber through the same machine a finger swipes with.
 * One press owns the sheet at a time, a finger's or a mouse's. A phone's
 * finger sees none of it. Chromium's touch emulation reports a coarse
 * pointer only, so the touch laptop (sm-6) stubs `matchMedia` for
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

describe("raccoon-vtt: a side panel that resizes, and a sheet with a mouse", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
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

  test("PS-B sm-3. Down with unsaved input closes as Close does: the label pane's typed text is not saved", async () => {
    await setUp(dm, { width: 500, height: 900 });
    const pane = await openLabel(dm);
    await checkStrip(pane, 1, "the label pane", false);
    const field = pane.getByRole("textbox").first();
    await field.fill("Gate of the North");
    await downOf(pane).click();
    assert.equal(await settled(pane), "gone");
    await sleep(300);
    assert.equal(dmSocket.state?.labels[run.label]?.text, "Gate", "Down saved the typed text");
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
