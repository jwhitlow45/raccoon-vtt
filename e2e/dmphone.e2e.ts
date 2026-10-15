import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * A DM running a session from a phone, after the whole-app design pass
 * (docs/design-v1-visual.md), as the live play review found it
 * (LPD-DMPHONE): the bugs it fixed, each checked where a DM meets it.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seven, which it shares
 * with playerphone.e2e.ts, since the runs go one after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 7;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-dmphone-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");

const run = {
  roomId: "",
  roomName: `E2E DM phone ${new Date().toISOString().slice(0, 19)}`,
};

/** The few DOM parts the page functions read, typed by hand: the e2e files compile without the DOM library. */
type El = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getAttribute(name: string): string | null;
  textContent: string | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  getBoundingClientRect(): { top: number; bottom: number };
};
type Win = {
  document: { activeElement: El | null; querySelector(selector: string): El | null };
  getComputedStyle(el: El): { overflowY: string };
};

function panelsButton(page: Page): Locator {
  return page.locator('nav[aria-label="Tools"] button[title="Panels"]');
}

/** Opens a panel as a sheet from the list of panels. */
async function openPanel(page: Page, name: string): Promise<Locator> {
  await panelsButton(page).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name, exact: true }).click();
  const sheet = page.locator(`section[aria-label="${name}"]`);
  await sheet.waitFor();
  return sheet;
}

/** The sheet's scrolling body: how far it is scrolled, and where it shows on screen. */
function sheetBody(page: Page, name: string): Promise<{ top: number; height: number; scrollHeight: number; viewTop: number; viewBottom: number }> {
  return page.evaluate((name) => {
    const g = globalThis as unknown as Win;
    const sheet = g.document.querySelector(`section[aria-label="${name}"]`);
    const body = Array.from(sheet?.querySelectorAll("div") ?? []).find((el) => g.getComputedStyle(el).overflowY === "auto");
    if (!body) throw new Error(`The ${name} sheet has no scrolling body`);
    const r = body.getBoundingClientRect();
    return { top: body.scrollTop, height: body.clientHeight, scrollHeight: body.scrollHeight, viewTop: r.top, viewBottom: r.bottom };
  }, name);
}

/** Scrolls a row to the foot of its sheet's body and taps it, as a finger would after scrolling a long list. */
async function scrollAndTap(page: Page, row: Locator): Promise<void> {
  await row.evaluate((el) => (el as unknown as { scrollIntoView(o: { block: string }): void }).scrollIntoView({ block: "end" }));
  const box = await row.boundingBox();
  assert.ok(box, "the row is not on screen");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** What has focus, and where it lies on screen. */
function focused(page: Page): Promise<{ name: string; top: number; bottom: number }> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as Win).document.activeElement;
    const r = a?.getBoundingClientRect();
    return { name: (a?.getAttribute("aria-label") ?? a?.textContent ?? "").trim(), top: r?.top ?? 0, bottom: r?.bottom ?? 0 };
  });
}

/**
 * A subpage opens at its top, and Back puts the list where it was with
 * the row that opened it in view, on the row's own focus.
 */
async function assertSubpageScroll(page: Page, sheetName: string, row: Locator, back: string, rowName: RegExp): Promise<void> {
  await scrollAndTap(page, row);
  await page.getByRole("button", { name: back }).waitFor();
  const sub = await sheetBody(page, sheetName);
  assert.equal(sub.top, 0, `${sheetName}: the subpage opens scrolled ${sub.top} px down, not at its top`);
  await page.getByRole("button", { name: back }).click();
  await page.locator(`section[aria-label="${sheetName}"]`).getByRole("button", { name: rowName }).first().waitFor();
  const after = await sheetBody(page, sheetName);
  assert.ok(after.top > 0, `${sheetName}: Back left the list at its top, not where it was scrolled`);
  const f = await focused(page);
  assert.match(f.name, rowName, `${sheetName}: focus went back to "${f.name}"`);
  assert.ok(f.top >= after.viewTop - 1 && f.bottom <= after.viewBottom + 1, `${sheetName}: the row that took focus lies at ${Math.round(f.top)}-${Math.round(f.bottom)}, outside the sheet's view ${Math.round(after.viewTop)}-${Math.round(after.viewBottom)}`);
}

describe("raccoon-vtt: a DM runs the session from a phone", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      console.error(`[${dmConsole.label}] errors`, dmConsole.errors, "warnings", dmConsole.warnings);
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

  test("1. the DM makes a room on a phone, with a journal of many pages", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1} of the citadel's long history.`).join("\n\n");
    for (let i = 1; i <= 16; i++) {
      const blockId = randomUUID().replace(/-/g, "").slice(0, 12);
      await ops.send({ t: "journal.create", page: { id: randomUUID(), title: `Lore page ${String(i).padStart(2, "0")}`, access: "all", blocks: [{ id: blockId, text }] } });
    }
    await waitFor("the pages in the DM's view", () => Object.keys(dmSocket.state?.journal ?? {}).length >= 16 || null);
  });

  test("2. a stat block opened from far down the monster list starts at its top, and Back returns to the list where it was (LPD-DMPHONE-1)", async () => {
    const sheet = await openPanel(dm, "Monsters");
    const row = sheet.getByRole("button", { name: /^Goblin Boss/ }).first();
    await assertSubpageScroll(dm, "Monsters", row, "Back to Monsters", /^Goblin Boss/);
    await shots.take(dm, "dmphone-monsters-back");
    await sheet.getByRole("button", { name: "Close Monsters" }).click();
  });

  test("3. a journal page opened from down the list starts at its top, and Back returns to the list where it was (LPD-DMPHONE-1)", async () => {
    const sheet = await openPanel(dm, "Journal");
    const row = sheet.getByRole("button", { name: /^Lore page 16/ }).first();
    await assertSubpageScroll(dm, "Journal", row, "Back to Journal", /^Lore page 16/);
    await sheet.getByRole("button", { name: "Close Journal" }).click();
  });
});
