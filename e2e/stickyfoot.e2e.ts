import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Sticky footers sit flush on the foot of the box that scrolls them
 * (LP7-CHROME-OWNER-1): the Log's composer in the side panel, in the lower
 * of two panels, in a phone's sheet at its normal height and full screen,
 * and in the very short sheet, a group save's Apply, and a popover's
 * "Scroll for more". A sticky box keeps inside its scroller's padding, so
 * at `bottom: 0` each stood a padding's height above the edge, with what
 * scrolled showing under it.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus twenty-three, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 23;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-stickyfoot-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const dmConsole = new ConsoleWatch("dm");
const patConsole = new ConsoleWatch("pat");

const run = {
  roomId: "",
  roomName: `E2E sticky foot ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 30, h: 20 },
  goblins: [randomUUID(), randomUUID()],
};

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
/** The few DOM members these steps read in the page. The e2e files compile without the DOM's types. */
type El = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  parentElement: El | null;
  getBoundingClientRect(): Rect;
  contains(other: unknown): boolean;
  closest(s: string): El | null;
};
type Win = { document: { elementFromPoint(x: number, y: number): unknown }; getComputedStyle(el: El): { position: string; borderBottomWidth: string } };

function actor(hp: number, extra: Record<string, unknown> = {}) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...extra };
}

/**
 * With its scroller scrolled to the middle, where its box would rest on the
 * scroller's padding if it could: how far the footer's foot stands above the
 * scroller's, both read from boxes so the interface size's zoom counts
 * alike, and whether a point just above that foot lands on the footer
 * rather than on something scrolled under it.
 */
async function footAt(footer: Locator): Promise<{ gap: number; covered: boolean }> {
  return footer.evaluate((node) => {
    const el = node as unknown as El;
    const g = globalThis as unknown as Win;
    let scroller = el.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test((g.getComputedStyle(scroller) as unknown as { overflowY: string }).overflowY))) scroller = scroller.parentElement;
    if (!scroller) throw new Error("the footer has no scroller around it");
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
    // A pane's body has no border, so its box's foot is its scrollport's.
    const foot = scroller.getBoundingClientRect().bottom;
    const f = el.getBoundingClientRect();
    const hit = g.document.elementFromPoint(f.left + f.width / 2, foot - 3);
    return { gap: Math.round((foot - f.bottom) * 10) / 10, covered: hit !== null && el.contains(hit) };
  });
}

async function flush(footer: Locator, where: string): Promise<void> {
  const at = await footAt(footer);
  assert.ok(Math.abs(at.gap) <= 1, `${where}: the footer stands ${at.gap} px above its pane's foot`);
  assert.ok(at.covered, `${where}: something scrolled shows under the footer`);
}

async function setUp(page: Page, view: { width: number; height: number; scale: number }): Promise<void> {
  await page.setViewportSize({ width: view.width, height: view.height });
  // The interface size is read from this origin's storage, so the page is on the room before it is set.
  if (!page.url().startsWith(server.origin)) await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** A phone's Log sheet, from the list of panels. */
async function logSheet(page: Page): Promise<Locator> {
  await page.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Log/ }).click();
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Log"]');
  await sheet.locator("form").waitFor();
  return sheet;
}

describe("raccoon-vtt: sticky footers sit on their pane's foot", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    pat = await patContext.newPage();
    patConsole.attach(pat);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
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

  test("0. a DM's room with two goblins, Pat, and a Log long enough to scroll anywhere", async () => {
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

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    for (const [i, id] of run.goblins.entries()) {
      await ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", number: i + 1, x: 6 + 2 * i, y: 4, disposition: "hostile", actor: { inline: actor(10, { srdId: "goblin-warrior" }) } } });
    }
    for (let i = 0; i < 40; i++) await ops.send({ t: "log.chat", text: `Aboleth ${i + 1} is back on their feet.` });
    await waitFor("the chat in the DM's view", () => ((dmSocket.state?.log.length ?? 0) >= 40 ? true : null));
    await setUp(pat, { width: 390, height: 844, scale: 1 });
  });

  test("1. the side panel: the Log's composer on its tab and as the lower of two panels", async () => {
    await openSideTab(dm, "Log");
    const tab = dm.getByRole("tabpanel", { name: sideTabName("Log") });
    await footAt(tab.locator("form").last());
    await shots.take(dm, "stickyfoot-side-log");
    await flush(tab.locator("form").last(), "the Log's tab");
    await openSideTab(dm, "Initiative");
    await dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]').click();
    await dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemcheckbox", { name: "Two panels" }).click();
    await dm.locator("[data-pane-bar]").getByRole("button", { name: / below$/ }).click();
    await dm.getByRole("menu", { name: "Panel below" }).getByRole("menuitemradio", { name: sideTabName("Log") }).click();
    const below = dm.getByRole("group", { name: /^Log below/ });
    await flush(below.locator("form").last(), "the Log below");
    await shots.take(dm, "stickyfoot-log-below");
  });

  test("2. a popover's Scroll for more lies on its foot", async () => {
    await dm.setViewportSize({ width: 1280, height: 560 });
    try {
      await dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]').click();
      const fade = dm.locator("[data-rvtt-popover]").getByText("Scroll for more", { exact: true });
      await fade.waitFor();
      const at = await fade.evaluate((node) => {
        const el = node as unknown as El;
        const g = globalThis as unknown as Win;
        const box = el.closest("[data-rvtt-popover]")!;
        const b = box.getBoundingClientRect();
        return Math.round((b.bottom - parseFloat(g.getComputedStyle(box).borderBottomWidth || "0") - el.getBoundingClientRect().bottom) * 10) / 10;
      });
      await shots.take(dm, "stickyfoot-popover");
      assert.ok(Math.abs(at) <= 1, `Scroll for more stands ${at} px above the popover's foot`);
    } finally {
      await dm.keyboard.press("Escape");
      await dm.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test("3. a group save's Apply in the Dice panel", async () => {
    for (const [i, id] of run.goblins.entries()) {
      const t = dmSocket.state!.tokens[id]!;
      const p = await pagePoint(dm, run.bounds, { x: t.x + 0.5, y: t.y + 0.5 });
      if (i > 0) await dm.keyboard.down("Shift");
      await dm.mouse.click(p.x, p.y);
      if (i > 0) await dm.keyboard.up("Shift");
    }
    await dm.locator('[role="dialog"][data-bar-mode]').getByRole("button", { name: "Roll", exact: true }).click();
    const dice = dm.getByRole("tabpanel", { name: sideTabName("Dice") }).or(dm.getByRole("group", { name: /^Dice below/ }));
    await dice.getByRole("button", { name: "Set up a group save" }).click();
    await dice.getByRole("radiogroup", { name: "What they roll" }).getByRole("radio", { name: "No save" }).check({ force: true });
    const damage = dice.getByLabel("Damage", { exact: true });
    await damage.fill("10");
    await damage.blur();
    await dm.setViewportSize({ width: 1280, height: 600 });
    try {
      const apply = dice.getByRole("button", { name: /^Apply/ }).first();
      await apply.waitFor();
      const foot = apply.locator("xpath=ancestor::div[contains(@style, 'sticky')][1]");
      await footAt(foot);
      await shots.take(dm, "stickyfoot-group-save");
      await flush(foot, "the group save's Apply");
    } finally {
      await dm.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test("4. a phone's sheet: the Log at its normal height and full screen, upright, at 100% and 130%", async () => {
    for (const scale of [1, 1.3]) {
      await setUp(pat, { width: 390, height: 844, scale });
      const sheet = await logSheet(pat);
      await flush(sheet.locator("form").last(), `the Log's sheet at ${scale * 100}%`);
      await sheet.getByRole("button", { name: "Full screen" }).focus();
      await pat.keyboard.press("Enter");
      await waitFor("the sheet full", async () => ((await sheet.getAttribute("aria-modal")) === "true" ? true : null));
      await flush(sheet.locator("form").last(), `the Log full screen at ${scale * 100}%`);
      await shots.take(pat, `stickyfoot-phone-full-${scale * 100}`);
    }
  });

  test("5. the very short sheet: a phone on its side at 480 x 320, 130%", async () => {
    await setUp(pat, { width: 480, height: 320, scale: 1.3 });
    const sheet = await logSheet(pat);
    assert.equal(await sheet.getAttribute("aria-modal"), "true", "the very short mode covers the screen");
    await flush(sheet.locator("form").last(), "the Log in the very short sheet");
    await shots.take(pat, "stickyfoot-very-short");
  });

  test("6. nothing went wrong in the browsers", () => {
    for (const c of [dmConsole, patConsole]) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});
