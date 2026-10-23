import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, pickOption, pickTool, reopenRoom, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * A DM running a session from a phone, after the whole-app design pass
 * (docs/design-v1-visual.md), as the live play review found it
 * (LPD-DMPHONE): the bugs it fixed, each checked where a DM meets it.
 *
 * The docked token action bar's part (docs/design-v1-bar-dock.md section 7):
 * on its side the bar and the alerts never meet (LPD-DMPHONE-3), the
 * column stays inside the window and a focused card never scrolls the room
 * (LPD-DMPHONE-4), "Viewing as Pat" covers no card and a toast never moves
 * the column (LPD-DMPHONE-9), and at 130% every bar button takes a tap
 * with a concentration check in sight.
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
let dmCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const dmConsole = new ConsoleWatch("dm");

const run = {
  roomId: "",
  roomName: `E2E DM phone ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  /** A creature concentrating on Hex, whose damage brings up a concentration check for the DM. */
  hag: "",
};

async function hurtHag(): Promise<void> {
  await ops.send({ t: "actor.hp", target: { tokenId: run.hag }, change: { kind: "damage", amount: 1 } });
}

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

/** The layout px the band's name always keeps (client/features/encounter/band.ts BAND_NAME_MIN_PX). */
const BAND_NAME_MIN_PX = 36;

type Box = { left: number; right: number };
type BandEl = { tagName: string; textContent: string | null; parentElement: BandEl | null; getAttribute(name: string): string | null; getBoundingClientRect(): Box };

/** The turn band's name, timer and Next disks as the page lays them out, and the window's width. */
function band(page: Page): Promise<{ width: number; name: Box | null; timer: Box | null; next: Box | null; timerText: string }> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { innerWidth: number; document: { querySelector(s: string): { querySelectorAll(s: string): ArrayLike<BandEl> } | null } };
    const all = Array.from(g.document.querySelector("header")?.querySelectorAll("*") ?? []);
    const box = (el: BandEl | null | undefined): Box | null => (el ? { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right } : null);
    const timer = all.find((el) => el.getAttribute("role") === "timer");
    return {
      width: g.innerWidth,
      name: box(all.find((el) => el.getAttribute("data-rvtt-strip-name") !== null)),
      timer: box(timer),
      next: box(all.find((el) => el.tagName === "SPAN" && el.textContent === "Next")?.parentElement),
      timerText: timer?.textContent ?? "",
    };
  });
}

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

type Rect = { left: number; top: number; right: number; bottom: number };

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
}

async function rectOf(locator: Locator): Promise<Rect> {
  const b = await locator.boundingBox();
  assert.ok(b, "nothing on screen to measure");
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}

/** What shows of an element: its box cut by every box around it that clips, as a stack of toasts that scrolls cuts a toast. */
function shownRect(locator: Locator): Promise<Rect> {
  return locator.evaluate((el) => {
    type Node = { parentElement: Node | null; getBoundingClientRect(): Rect };
    const g = globalThis as unknown as { getComputedStyle(n: Node): { overflowX: string; overflowY: string } };
    const own = (el as unknown as Node).getBoundingClientRect();
    let out: Rect = { left: own.left, top: own.top, right: own.right, bottom: own.bottom };
    for (let n = (el as unknown as Node).parentElement; n; n = n.parentElement) {
      const cs = g.getComputedStyle(n);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const c = n.getBoundingClientRect();
      out = { left: Math.max(out.left, c.left), top: Math.max(out.top, c.top), right: Math.min(out.right, c.right), bottom: Math.min(out.bottom, c.bottom) };
    }
    return out;
  });
}

/** The token bar's frame, whichever token or group it is for. */
function barFrame(page: Page): Locator {
  return page.locator('[role="dialog"][data-bar-mode]');
}

/** Sets the window, the safe areas and the interface size, then loads the room again. */
async function setUp(view: { width: number; height: number; scale: number; top?: number; side?: number; bottom?: number }): Promise<void> {
  await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: view.top ?? 0, bottom: view.bottom ?? 0, left: view.side ?? 0, right: view.side ?? 0 } });
  await dm.setViewportSize({ width: view.width, height: view.height });
  await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
  await reopenRoom(dm);
  await dm.getByRole("status", { name: "Connected" }).first().waitFor();
  await dm.locator(".konvajs-content").first().waitFor();
}

/**
 * The fight alerts column's cards as drawn, each clipped to the part its
 * column leaves in view, and the column's own box. The rolls' cards sit
 * in a wrapper with no box of its own, so its children count instead.
 */
function column(page: Page, within = "body"): Promise<{ cards: Rect[]; box: Rect | null; width: number; height: number }> {
  return page.evaluate((root) => {
    type Node = { tagName: string; parentElement: Node | null; getBoundingClientRect(): Rect & { width: number }; querySelectorAll(s: string): ArrayLike<Node> };
    const g = globalThis as unknown as { innerWidth: number; innerHeight: number; document: { querySelector(s: string): Node | null } };
    const cards: Rect[] = [];
    let box: Rect | null = null;
    for (const el of Array.from(g.document.querySelector(root)?.querySelectorAll('[data-alert]:not([data-alert="rolls"]), [data-alert="rolls"] > *') ?? [])) {
      let col: Node = el;
      while (col.parentElement && col.parentElement.tagName !== "HEADER") col = col.parentElement;
      const r = el.getBoundingClientRect();
      const c = col.getBoundingClientRect();
      box = { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
      const top = Math.max(r.top, c.top);
      const bottom = Math.min(r.bottom, c.bottom);
      if (r.width > 0 && bottom - top > 0.5) cards.push({ left: r.left, top, right: r.right, bottom });
    }
    return { cards, box, width: g.innerWidth, height: g.innerHeight };
  }, within);
}

/** What takes a tap at a point: "bar" when the token bar does, else the tag. */
function hit(page: Page, p: { x: number; y: number }): Promise<string | null> {
  return page.evaluate(([x, y]) => {
    type Node = { tagName: string; closest(s: string): Node | null };
    const el = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null } }).document.elementFromPoint(x, y);
    return el ? (el.closest('[role="dialog"][data-bar-mode]') ? "bar" : el.tagName) : null;
  }, [p.x, p.y] as const);
}

describe("raccoon-vtt: a DM runs the session from a phone", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    dmConsole.attach(dm);
    await dmSocket.attach(dmContext, dm);
    dmCdp = await dmContext.newCDPSession(dm);
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

  test("4. pages added from another device above the row that opened a page move it down, and Back still brings it into view", async () => {
    const sheet = await openPanel(dm, "Journal");
    await scrollAndTap(dm, sheet.getByRole("button", { name: /^Lore page 16/ }).first());
    await dm.getByRole("button", { name: "Back to Journal" }).waitFor();
    // Sorted by title, these land above every Lore page, far more than the sheet shows.
    for (let i = 1; i <= 12; i++) {
      const blockId = randomUUID().replace(/-/g, "").slice(0, 12);
      await ops.send({ t: "journal.create", page: { id: randomUUID(), title: `Added page ${String(i).padStart(2, "0")}`, access: "all", blocks: [{ id: blockId, text: "Written at the table." }] } });
    }
    await waitFor("the added pages in the DM's view", () => Object.keys(dmSocket.state?.journal ?? {}).length >= 28 || null);
    await dm.getByRole("button", { name: "Back to Journal" }).click();
    await sheet.getByRole("button", { name: /^Lore page 16/ }).first().waitFor();
    const view = await sheetBody(dm, "Journal");
    const f = await focused(dm);
    assert.match(f.name, /^Lore page 16/, `focus went back to "${f.name}"`);
    assert.ok(f.top >= view.viewTop - 1 && f.bottom <= view.viewBottom + 1, `the row that took focus lies at ${Math.round(f.top)}-${Math.round(f.bottom)}, outside the sheet's view ${Math.round(view.viewTop)}-${Math.round(view.viewBottom)}`);
    await shots.take(dm, "dmphone-journal-back-moved");
    await sheet.getByRole("button", { name: "Close Journal" }).click();
  });

  test("5. closing roll cards puts focus on the next card, then on the map, never on the page (LPD-DMPHONE-7)", async () => {
    // A character a player plays, which a request may ask. Pat joins with another device's cookies.
    const pat = await browser.newContext();
    let patId = "";
    try {
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await pat.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await pat.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      patId = ((await done.json()) as { member: { id: string } }).member.id;
    } finally {
      await pat.close();
    }
    const characterId = randomUUID();
    const actor = { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 12, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({ t: "character.create", character: { id: characterId, name: "Thorn", size: "medium", ownerIds: [patId], actor } });

    // Three requests, oldest first: a Str save, a Dex save the DM marks passed, and a Wis save.
    const ids = { str: randomUUID(), dex: randomUUID(), wis: randomUUID() };
    for (const [ability, id] of Object.entries(ids)) {
      await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability }] }, dcShown: true, resultShown: true, targets: [{ characterId }] } });
      // Each asked at a time of its own, so the newest is certain.
      await dm.waitForTimeout(20);
    }
    await ops.send({ t: "roll.answer", rollId: ids.dex, target: { characterId }, result: "pass", tag: randomUUID() });
    const card = (test: string) => dm.getByRole("group", { name: `Roll request: ${test}` });
    await card("WIS save").waitFor();

    // Close all answered stands above the cards, so focus goes to the first card left.
    await dm.getByRole("button", { name: "Close all answered (1)" }).tap();
    await card("DEX save").waitFor({ state: "detached" });
    await waitFor("the WIS save card focused", async () => (await focused(dm)).name.startsWith("WIS save"));

    // A card's Close: focus goes to the card after it.
    await dm.getByRole("button", { name: "Close the WIS save request" }).tap();
    await waitFor("the STR save card focused", async () => (await focused(dm)).name.startsWith("STR save"));
    await shots.take(dm, "dmphone-next-card-focused");

    // The last card's Close: nothing in the column is left, so the map takes focus.
    await dm.getByRole("button", { name: "Close the STR save request" }).tap();
    await card("STR save").waitFor({ state: "detached" });
    await waitFor("the map focused", async () => (await focused(dm)).name === "Map");
  });

  test("6. with the turn's time up, the band keeps a few letters of the name and its Next disks on screen, giving the disks up first (LPD-DMPHONE-2)", async () => {
    const entries = [];
    for (let i = 1; i <= 5; i++) {
      const id = randomUUID();
      await ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, kind: "monster", name: `Goblin ${i}`, x: 4 + i, y: 6, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: goblin() } } });
      entries.push({ id: randomUUID(), tokenId: id, value: 20 - i });
    }
    await ops.send({ t: "room.update", settings: { turnTimerSec: 4 } });
    await ops.send({ t: "encounter.start", entries });
    await ops.send({ t: "encounter.next" });
    const nextShown: Record<string, boolean> = {};
    for (const view of [
      { width: 390, height: 844, scale: 1 },
      { width: 390, height: 844, scale: 1.3 },
      { width: 320, height: 568, scale: 1 },
      { width: 320, height: 568, scale: 1.3 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await dm.setViewportSize({ width: view.width, height: view.height });
      await dm.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), view.scale);
      await reopenRoom(dm);
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      await waitFor(`time up in the band, ${label}`, async () => /Time’s up\s*\+/.test((await band(dm)).timerText) || null, 15_000);
      const b = await band(dm);
      assert.ok(b.name && b.timer, `${label}: the band is missing a part: ${JSON.stringify(b)}`);
      assert.ok(b.name.right - b.name.left >= BAND_NAME_MIN_PX * view.scale - 0.5, `${label}: the name keeps too little: ${JSON.stringify(b)}`);
      assert.ok(b.name.right <= b.timer.left + 0.5, `${label}: the name runs over the timer: ${JSON.stringify(b)}`);
      assert.ok(b.timer.right <= b.width + 0.5, `${label}: the timer runs off the screen: ${JSON.stringify(b)}`);
      if (b.next) assert.ok(b.next.left >= b.timer.right && b.next.right <= b.width + 0.5, `${label}: the Next disks run off the screen: ${JSON.stringify(b)}`);
      nextShown[label] = b.next !== null;
      if (view.width === 320 && view.scale === 1.3) await shots.take(dm, "dmphone-band-time-up-320-130");
    }
    assert.equal(nextShown["390 x 844 at 100%"], true, "a phone at 100% keeps its Next disks with the time up");
    assert.equal(nextShown["320 x 568 at 130%"], false, "the disks give way before the name");
    await ops.send({ t: "room.update", settings: { turnTimerSec: 0 } });
    await ops.send({ t: "encounter.end" });
    await dm.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
    await dm.setViewportSize({ width: 390, height: 844 });
    await reopenRoom(dm);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("7. the docked bar and the alerts column share the right of the map: they never meet on its side, the column stays in the window, and every bar button takes a tap at 130% (LPD-DMPHONE-3, LPD-DMPHONE-4)", async () => {
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const caster = randomUUID();
    await ops.send({ t: "token.create", token: { id: caster, sceneId: run.sceneId, kind: "monster", name: "Hag", x: 1, y: 17, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: { ...goblin(), hp: { cur: 40, max: 40, temp: 0 } } } } });
    await ops.send({ t: "actor.effect.add", target: { tokenId: caster }, effect: { id: randomUUID(), key: "concentrating", spell: "Hex" } });
    run.hag = caster;
    for (const view of [
      { width: 844, height: 390, scale: 1 },
      { width: 844, height: 390, scale: 1.3, side: 47, bottom: 21 },
      { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 },
      { width: 320, height: 480, scale: 1.3, top: 44, bottom: 34 },
      { width: 390, height: 844, scale: 1 },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(view);
      // A check comes up as the damage arrives, so a page loaded again has none until the Hag takes more.
      await hurtHag();
      await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
      // On the smallest screens the check's card covers the whole map, so the outliner picks the Hag, as a DM would there.
      const p = await pagePoint(dm, bounds, { x: 1.5, y: 17.5 });
      if ((await hit(dm, p)) === "CANVAS") {
        await dm.touchscreen.tap(p.x, p.y);
      } else {
        const outliner = await openPanel(dm, "Outliner");
        await outliner.getByLabel("Search the scene").fill("Hag");
        await outliner.getByRole("button", { name: /^Hag/ }).first().tap();
      }
      const bar = dm.getByRole("dialog", { name: "Hag actions" });
      await bar.waitFor();
      await dm.waitForTimeout(250);
      const r = await rectOf(bar);
      const col = await column(dm);
      if (view.width > view.height) for (const c of col.cards) assert.ok(!intersects(c, r), `${label}: a card meets the bar: ${JSON.stringify({ c, r })}`);
      if (view.width === 390) {
        // Upright with a check at the column's head, the bar keeps off the Hag, low on the screen (BB-6).
        const a = await pagePoint(dm, bounds, { x: 1, y: 17 });
        const b = await pagePoint(dm, bounds, { x: 2, y: 18 });
        const hag = { left: a.x, top: a.y, right: b.x, bottom: b.y };
        assert.ok(!intersects(hag, r), `${label}: the bar covers the Hag: ${JSON.stringify({ hag, r })}`);
      }
      // The check, or the summary row that stands for it, is in sight with the bar open.
      const check = dm.locator('[data-alert="concentration"]').first();
      const row = dm.getByRole("button", { name: /^Concentration save/ });
      assert.ok((await check.isVisible()) || (await row.isVisible()), `${label}: neither the check nor the summary row shows`);
      // The column's box never reaches past the window (LPD-DMPHONE-4).
      if (col.box) assert.ok(col.box.right <= col.width + 0.5 && col.box.left >= -0.5, `${label}: the column runs past the window: ${JSON.stringify(col.box)}`);
      if (view.scale === 1.3) {
        const missed: string[] = [];
        const buttons = bar.locator("button");
        for (let i = 0; i < (await buttons.count()); i++) {
          const b = buttons.nth(i);
          if (!(await b.isVisible())) continue;
          await b.scrollIntoViewIfNeeded();
          const br = await rectOf(b);
          if ((await hit(dm, { x: (br.left + br.right) / 2, y: (br.top + br.bottom) / 2 })) !== "bar") missed.push((await b.textContent()) ?? "?");
        }
        assert.deepEqual(missed, [], `${label}: bar buttons that take no tap`);
      }
      await shots.take(dm, `dmphone-bar-and-column-${view.width}x${view.height}-${Math.round(view.scale * 100)}`);
      await bar.getByRole("button", { name: "Close", exact: true }).tap();
      await bar.waitFor({ state: "detached" });
    }

    // The column's last card taking focus never scrolls the room frame.
    await setUp({ width: 844, height: 390, scale: 1 });
    await hurtHag();
    await dm.locator('[data-alert="concentration"]').first().waitFor();
    const scrolled = await dm.evaluate(() => {
      type Node = { tagName: string; parentElement: Node | null; scrollLeft: number; scrollTop: number; focus(): void; querySelectorAll(s: string): ArrayLike<Node> };
      const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Node> }; getComputedStyle(el: Node): { position: string } };
      const focusables = Array.from(g.document.querySelectorAll("[data-alert] button, [data-alert][tabindex]"));
      const last = focusables[focusables.length - 1];
      if (!last) return null;
      last.focus();
      let frame: Node | null = last;
      while (frame && g.getComputedStyle(frame).position !== "fixed") frame = frame.parentElement;
      return frame ? { left: frame.scrollLeft, top: frame.scrollTop } : null;
    });
    assert.deepEqual(scrolled, { left: 0, top: 0 }, "a focused card scrolled the room");
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  });

  test("8. Viewing as Pat covers no card, and a toast does not move the column (LPD-DMPHONE-9)", async () => {
    await setUp({ width: 390, height: 844, scale: 1 });
    await hurtHag();
    const check = dm.locator('[data-alert="concentration"]').first();
    await check.waitFor();
    const before = await rectOf(check);
    // Undo and Redo each say what they took back, in a toast.
    await dm.getByRole("button", { name: "Undo", exact: true }).tap();
    await dm.locator("[data-toast]").first().waitFor();
    await dm.waitForTimeout(150);
    const during = await rectOf(check);
    assert.ok(Math.abs(during.top - before.top) < 0.5, `a toast moved the column: ${JSON.stringify({ before, during })}`);
    await dm.getByRole("button", { name: "Redo", exact: true }).tap();

    const thorn = Object.values(dmSocket.state!.characters).find((c) => c.name === "Thorn");
    assert.ok(thorn, "Thorn is not in the room");
    const id = randomUUID();
    await ops.send({ t: "roll.ask", request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dcShown: true, resultShown: true, targets: [{ characterId: thorn.id }] } });
    await openPanel(dm, "DM");
    await dm.getByRole("button", { name: "View", exact: true }).tap();
    const preview = dm.getByRole("dialog", { name: "Viewing as Pat" });
    await preview.waitFor();
    await dm.waitForTimeout(300);
    const notice = await rectOf(preview.getByRole("status").filter({ hasText: "Viewing as Pat." }));
    for (const c of (await column(dm, 'dialog[aria-label="Viewing as Pat"]')).cards) assert.ok(!intersects(c, notice), `"Viewing as Pat" covers a card: ${JSON.stringify({ c, notice })}`);
    await shots.take(dm, "dmphone-viewing-as-pat");
    await preview.getByRole("button", { name: "Exit", exact: true }).tap();
    await preview.waitFor({ state: "detached" });
    await ops.send({ t: "roll.close", rollIds: [id] });
  });

  test("fu20b-1. at 390 x 844 a toast that shows while a check's card is up starts 8 px under the card, never over it (fu16 item 8)", async () => {
    await setUp({ width: 390, height: 844, scale: 1 });
    await hurtHag();
    const check = dm.locator('[data-alert="concentration"]').first();
    await check.waitFor();
    await dm.waitForTimeout(200);
    const card = await rectOf(check);
    // Undo says what it took back in a toast.
    await dm.getByRole("button", { name: "Undo", exact: true }).tap();
    const toast = dm.locator("[data-toast]").filter({ hasText: /^(Undid|Nothing to undo|Could not undo)/ }).first();
    await toast.waitFor();
    const t = await rectOf(toast);
    assert.ok(!intersects(t, card), `the toast covers the check: ${JSON.stringify({ t, card })}`);
    assert.ok(Math.abs(t.top - (card.bottom + 8)) < 1.5, `the toast starts at ${t.top}, not 8 px under the card's foot at ${card.bottom}`);
    assert.ok(Math.abs((await rectOf(check)).top - card.top) < 0.5, "the toast moved the column");
    await shots.take(dm, "dmphone-fu20b-toast-under-card");
    await dm.getByRole("button", { name: "Redo", exact: true }).tap();
  });

  test("9. the column stays below a lasting notice as the turn band comes and goes, which moves the notice (LPD-DMPHONE-9)", async () => {
    await setUp({ width: 390, height: 844, scale: 1 });
    // Framing a starting view from a phone shows the "Starting view" bar under the top bar, a notice that lasts.
    const scenes = await openPanel(dm, "Scenes");
    await scenes.getByRole("button", { name: "Save current view" }).tap();
    const framing = dm.getByRole("group", { name: "Starting view" });
    await framing.waitFor();
    await hurtHag();
    const check = dm.locator('[data-alert="concentration"]').first();
    await check.waitFor();
    const clear = async (label: string) => {
      await dm.waitForTimeout(300);
      const notice = await rectOf(framing);
      const card = await rectOf(check);
      assert.ok(card.top >= notice.bottom + 8 - 1, `${label}: the check runs under the notice: ${JSON.stringify({ notice, card })}`);
    };
    await clear("before the band");
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.hag, value: 12 }] });
    await dm.getByRole("button", { name: /^Initiative, round/ }).first().waitFor();
    await clear("with the band");
    await shots.take(dm, "dmphone-notice-band-column");
    await ops.send({ t: "encounter.end" });
    await dm.getByRole("button", { name: /^Initiative, round/ }).first().waitFor({ state: "detached" });
    await clear("after the band");
    await framing.getByRole("button", { name: "Cancel" }).tap();
  });

  test("10. at 480 x 320 at 130% under the Starting view notice, the summary row standing for the checks is never under the notice nor over a button, and its tap opens the alerts over the screen, where Passed answers a check and Close goes back to the row", async () => {
    const label = "480 x 320 at 130% under the Starting view notice";
    await setUp({ width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 });
    const scenes = await openPanel(dm, "Scenes");
    await scenes.getByRole("button", { name: "Save current view" }).tap();
    const framing = dm.getByRole("group", { name: "Starting view" });
    await framing.waitFor();
    // Two checks, so the alerts stay open once one is answered.
    await hurtHag();
    await hurtHag();
    await dm.locator('[data-alert="concentration"]').nth(1).waitFor({ state: "attached" });
    await dm.waitForTimeout(400);
    // The notice leaves the column no room for the check, and paints over the column, so the row must find a spot of its own.
    const row = dm.getByRole("button", { name: /^Concentration save/ });
    await shots.take(dm, "dmphone-row-under-notice-480x320");
    assert.ok(await wholeInReach(row), `${label}: the summary row is hidden or cut off`);
    const r = await rectOf(row);
    assert.ok(!intersects(r, await rectOf(framing)), `${label}: the row meets the notice`);
    for (const name of ["Cancel", "Save view"]) {
      assert.ok(await wholeInReach(framing.getByRole("button", { name, exact: true })), `${label}: the notice's ${name} takes no tap`);
    }
    // The top bar's Redo and Fit already overlap by a hair at this size, so the row is checked against each button's box rather than by hit tests.
    const bars = dm.locator("header button:visible:not([data-rvtt-backdrop])");
    for (let i = 0; i < (await bars.count()); i++) {
      const b = bars.nth(i);
      const name = (await b.getAttribute("aria-label")) ?? (await b.textContent()) ?? "?";
      if (name.startsWith("Concentration save")) continue;
      assert.ok(!intersects(r, await rectOf(b)), `${label}: the row covers ${name} in the top bar`);
    }
    // The notice leaves the column no room for a whole check either, so the row's tap opens the alerts over the screen.
    await row.tap();
    const check = dm.locator('[data-alert="concentration"]').first();
    await check.waitFor();
    await dm.waitForTimeout(300);
    await shots.take(dm, "dmphone-alerts-over-notice-480x320");
    for (const name of ["Passed", "Failed"]) {
      assert.ok(await wholeInReach(check.getByRole("button", { name, exact: true })), `${label}: ${name} is cut off or takes no tap after the row's tap`);
    }
    const alerts = dm.getByRole("dialog", { name: "Alerts" });
    assert.equal(await alerts.count(), 1, `${label}: the alerts did not open over the screen`);
    // Every sheet and dialog's header, in its one-row form: the title a heading, Close its 44 px icon, whole in reach (docs/design-v1-look-pass-2.md D7).
    const head = alerts.locator("header").first();
    assert.equal(await head.getByRole("heading", { name: "Alerts", exact: true }).count(), 1, `${label}: the alerts' header is not SheetHeader`);
    const close = head.getByRole("button", { name: "Close", exact: true });
    assert.ok(await wholeInReach(close), `${label}: the alerts' Close is out of reach`);
    const closeBox = await close.boundingBox();
    assert.ok(closeBox && Math.abs(closeBox.height - 44 * 1.3) < 1.5, `${label}: the alerts' Close is not the 44 px icon: ${JSON.stringify(closeBox)}`);
    await check.getByRole("button", { name: "Passed", exact: true }).tap();
    await waitFor(`one check left, ${label}`, async () => ((await alerts.locator('[data-alert="concentration"]').count()) === 1 ? true : null));
    // Modal: the page behind takes no focus, and Tab and Shift+Tab wrap inside.
    const inAlerts = () =>
      dm.evaluate(() => {
        const a = (globalThis as unknown as { document: { activeElement: { closest(s: string): unknown } | null } }).document.activeElement;
        return a?.closest('[aria-modal="true"]') != null;
      });
    await alerts.getByRole("button", { name: "Close", exact: true }).focus();
    for (const key of ["Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Tab", "Tab", "Tab", "Tab", "Tab"]) {
      await dm.keyboard.press(key);
      assert.equal(await inAlerts(), true, `${label}: ${key} took focus out of the alerts`);
    }
    const fit = dm.getByRole("button", { name: "Fit the map to the screen" });
    assert.equal(await fit.evaluate((el) => el.closest("[inert]") !== null), true, `${label}: Fit behind the alerts is not inert`);
    await alerts.getByRole("button", { name: "Close", exact: true }).tap();
    await alerts.waitFor({ state: "detached" });
    await waitFor(`focus back on the row, ${label}`, async () => ((await focused(dm)).name.startsWith("Concentration save") ? true : null));
    // The last check answered over the screen takes the alerts and the row with it: focus goes to the map, not to the page.
    await row.tap();
    await alerts.waitFor();
    await alerts.locator('[data-alert="concentration"]').first().getByRole("button", { name: "Passed", exact: true }).tap();
    await alerts.waitFor({ state: "detached" });
    await waitFor(`focus on the map once nothing waits, ${label}`, async () => ((await focused(dm)).name === "Map" ? true : null));
    await framing.getByRole("button", { name: "Cancel" }).tap();
  });

  test("11. at 480 x 320 at 130% with the Ruler, the summary row's tap shows the check whole, Passed and Failed taking a tap", async () => {
    const label = "480 x 320 at 130% with the Ruler";
    await setUp({ width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 });
    await dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler" }).tap();
    await dm.getByRole("toolbar", { name: "Ruler options" }).waitFor();
    await hurtHag();
    await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
    await dm.waitForTimeout(400);
    const row = dm.getByRole("button", { name: /^Concentration save/ });
    assert.ok(await wholeInReach(row), `${label}: the summary row is hidden or cut off`);
    await row.tap();
    const check = dm.locator('[data-alert="concentration"]').first();
    await check.waitFor();
    await dm.waitForTimeout(300);
    await shots.take(dm, "dmphone-check-asked-480x320");
    for (const name of ["Passed", "Failed"]) {
      assert.ok(await wholeInReach(check.getByRole("button", { name, exact: true })), `${label}: ${name} is cut off or takes no tap after the row's tap`);
    }
    await check.getByRole("button", { name: "Passed", exact: true }).tap();
  });

  test("12. at 320 x 420 at 130% with the Ruler, a check opened in the column moves over the screen when a turn band arrives and leaves the column too short for it", async () => {
    // A height where the check fits whole from the column's place down to the toolbar without the band, and not with it.
    const label = "320 x 420 at 130% with the Ruler";
    await setUp({ width: 320, height: 420, scale: 1.3, top: 44, bottom: 34 });
    await dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler" }).tap();
    await dm.getByRole("toolbar", { name: "Ruler options" }).waitFor();
    await hurtHag();
    await dm.locator('[data-alert="concentration"]').first().waitFor({ state: "attached" });
    await dm.waitForTimeout(400);
    await dm.getByRole("button", { name: /^Concentration save/ }).tap();
    const check = dm.locator('[data-alert="concentration"]').first();
    await check.waitFor();
    await dm.waitForTimeout(300);
    assert.equal(await dm.getByRole("dialog", { name: "Alerts" }).count(), 0, `${label}: the check did not open in the column, so the band has nothing to change`);
    assert.ok(await wholeInReach(check.getByRole("button", { name: "Passed", exact: true })), `${label}: Passed is cut off in the column`);
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.hag, value: 12 }] });
    await dm.getByRole("button", { name: /^Initiative, round/ }).first().waitFor();
    await dm.waitForTimeout(400);
    await shots.take(dm, "dmphone-check-band-arrives-320x420");
    assert.equal(await dm.getByRole("dialog", { name: "Alerts" }).count(), 1, `${label}: the check stayed in a column too short for it`);
    for (const name of ["Passed", "Failed"]) {
      assert.ok(await wholeInReach(check.getByRole("button", { name, exact: true })), `${label}: ${name} is cut off once the band arrives`);
    }
    await check.getByRole("button", { name: "Passed", exact: true }).tap();
    await ops.send({ t: "encounter.end" });
  });

  test("13. a check for a creature with no stat block: Roll d20 shares the row with Passed and Failed, and its tap opens a bonus field beside Adv and Dis that the roll then takes", async () => {
    // At 320 px and 130% the row keeps "d20" alone, so the card keeps the height it has without it (globals.css, rvtt-roll-word).
    for (const view of [
      { width: 320, height: 480, scale: 1.3, words: "d20" },
      { width: 390, height: 844, scale: 1, words: "Roll d20" },
    ]) {
      const label = `${view.width} x ${view.height} at ${Math.round(view.scale * 100)}%`;
      await setUp(view);
      await hurtHag();
      const check = dm.locator('[data-alert="concentration"]').first();
      await check.waitFor();
      const roll = check.getByRole("button", { name: "Roll d20", exact: true });
      assert.equal((await roll.innerText()).trim(), view.words, `${label}: Roll d20's words`);
      assert.equal(await roll.getAttribute("aria-expanded"), "false", `${label}: Roll d20 does not say it opens a field`);
      const passed = await rectOf(check.getByRole("button", { name: "Passed", exact: true }));
      assert.ok(Math.abs((await rectOf(roll)).top - passed.top) < 1, `${label}: Roll d20 wrapped under Passed`);
      assert.equal(await check.getByRole("textbox").count(), 0, `${label}: the bonus field shows before Roll d20's tap`);
      await shots.take(dm, `dmphone-check-roll-d20-${view.width}`);
      if (view.width === 320) {
        await check.getByRole("button", { name: "Passed", exact: true }).tap();
        await check.waitFor({ state: "detached" });
        continue;
      }
      await roll.tap();
      const bonus = check.getByRole("textbox", { name: "Bonus for Hag", exact: true });
      await bonus.waitFor();
      assert.equal(await bonus.evaluate((el) => el === (el.ownerDocument as unknown as { activeElement: unknown }).activeElement), true, `${label}: the bonus field did not take focus`);
      await check.getByRole("button", { name: "Advantage", exact: true }).waitFor();
      const before = (dmSocket.state?.log ?? []).length;
      await bonus.fill("3");
      await shots.take(dm, "dmphone-check-bonus-typed");
      await check.getByRole("button", { name: "Roll d20+3", exact: true }).tap();
      const rolled = await waitFor(`${label}: the hag's roll`, () => {
        for (const e of (dmSocket.state?.log ?? []).slice(before)) {
          const data = e.data as { type?: string; rolls?: { faces: number[]; total: number }[] } | undefined;
          const r = data?.type === "dice" ? data.rolls?.[0] : undefined;
          if (r) return r;
        }
        return null;
      });
      assert.deepEqual([rolled.faces.length, rolled.total - rolled.faces[0]!], [1, 3], `${label}: the roll did not take the bonus typed: ${JSON.stringify(rolled)}`);
      // The card goes as its roll decides it, leaving the notice that says how.
      await dm.getByText(`Hag rolled ${rolled.total}:`).first().waitFor();
    }
  });

  test("lp8fix-a. on a tablet and a phone held sideways, the armed Delete grows over the trash can's spot, so a second tap there deletes (LP8-UI-4, docs/design-v1-icons.md 3.1 rule 6)", async () => {
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const cell = { x: Math.floor(bounds.w / 2), y: Math.floor(bounds.h / 2) };
    for (const view of [
      { width: 820, height: 1180, scale: 1 },
      { width: 844, height: 390, scale: 1, side: 47, bottom: 21 },
    ]) {
      const label = `${view.width} x ${view.height}`;
      const id = randomUUID();
      await ops.send({ t: "token.create", token: { id, sceneId: run.sceneId, kind: "monster", name: "Zombie", x: cell.x, y: cell.y, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: goblin() } } });
      await waitFor(`${label}: the zombie in the DM's view`, () => dmSocket.state?.tokens[id] ?? null);
      await setUp(view);
      const p = await pagePoint(dm, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
      assert.equal(await hit(dm, p), "CANVAS", `${label}: the zombie is under something`);
      await dm.touchscreen.tap(p.x, p.y);
      const bar = dm.getByRole("dialog", { name: "Zombie actions" });
      await bar.waitFor();
      // Locked and Duplicate show their words on touch, which leaves their line room for the trash can and not for "Sure?".
      const trash = bar.getByRole("button", { name: "Delete", exact: true });
      await trash.scrollIntoViewIfNeeded();
      await dm.waitForTimeout(250);
      const was = await rectOf(trash);
      const spot = { x: (was.left + was.right) / 2, y: (was.top + was.bottom) / 2 };
      await dm.touchscreen.tap(spot.x, spot.y);
      const armed = bar.getByRole("button", { name: "Tap again to delete", exact: true });
      await armed.waitFor();
      const grown = await rectOf(armed);
      assert.ok(grown.left <= spot.x && spot.x <= grown.right && grown.top <= spot.y && spot.y <= grown.bottom, `${label}: the armed Delete left the trash can's spot: ${JSON.stringify({ was, grown })}`);
      const under = await dm.evaluate(([x, y]) => {
        type Node = { closest(s: string): { getAttribute(name: string): string | null } | null };
        const el = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): Node | null } }).document.elementFromPoint(x, y);
        return el?.closest("button")?.getAttribute("aria-label") ?? null;
      }, [spot.x, spot.y] as const);
      assert.equal(under, "Tap again to delete", `${label}: a second tap on the trash can's spot lands elsewhere`);
      await shots.take(dm, `dmphone-delete-armed-${view.width}x${view.height}`);
      await dm.touchscreen.tap(spot.x, spot.y);
      await waitFor(`${label}: the zombie deleted by the second tap`, () => (dmSocket.state && !dmSocket.state.tokens[id] ? true : null));
    }
    await dmCdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  });

  test("fu20b-r1-5. at 390 x 844 a trap that goes off while its pane is open docks the alerts' summary row on the pane's top edge, clear of the top bars and of the pane's header and Close: its tap closes the pane and shows the trap's card, and the pane's Close brings the cards back too (fu20b Q2)", async () => {
    await setUp({ width: 390, height: 844, scale: 1 });
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    // Left of the middle, clear of the alerts column down the right.
    const cell = { x: 3, y: Math.floor(bounds.h / 2) };
    const trapId = randomUUID();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Dart Plate", zone: { cells: [{ x: cell.x, y: cell.y, w: 1, h: 1 }] }, rig } });
    await waitFor("the trap in the DM's view", () => dmSocket.state?.traps[trapId] ?? null);
    await pickTool(dm, "Trap");
    const pane = dm.getByRole("dialog", { name: "Edit trap" });
    const openPane = async (label: string) => {
      const p = await pagePoint(dm, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
      assert.equal(await hit(dm, p), "CANVAS", `${label}: the trap is under something`);
      await dm.touchscreen.tap(p.x, p.y);
      await pane.waitFor();
      await pane.getByText("Dart Plate", { exact: true }).first().waitFor();
    };
    await openPane("first");
    await ops.send({ t: "trap.spring", trapId, tokenIds: [run.hag] });
    const cards = dm.getByRole("group", { name: "Dart Plate went off" });
    const dock = dm.locator("[data-rvtt-pane-dock]");
    const row = dock.getByRole("button", { name: /went off.*Close the pane to answer\.$/ });
    const close = pane.getByRole("button", { name: "Close", exact: true });
    const onEdge = async (label: string) => {
      await row.waitFor();
      // The row follows the pane's height once it is measured, and the pane makes room for it.
      await dm.waitForTimeout(300);
      const r = await rectOf(dock);
      const s = await rectOf(pane);
      const bars = await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }));
      assert.ok(Math.abs(r.bottom - s.top) <= 1.5, `${label}: the row (foot ${r.bottom}) is not on the pane's edge (${s.top})`);
      assert.ok(r.top >= bars.bottom - 0.5, `${label}: the row (top ${r.top}) runs under the top bars (foot ${bars.bottom})`);
      assert.ok(await wholeInReach(row), `${label}: something covers the row`);
      assert.ok(await wholeInReach(close), `${label}: the pane's Close is out of reach`);
      assert.equal(await cards.first().isVisible(), false, `${label}: a card draws over the pane`);
    };
    await onEdge("as the trap goes off");
    await shots.take(dm, "dmphone-fu20b-r1-pane-dock");
    // Its tap closes the pane, and the trap's card shows with focus in it, as the dock's row does under a panel sheet.
    await row.tap();
    await pane.waitFor({ state: "detached" });
    await cards.first().waitFor();
    await waitFor("focus in the trap's card", () =>
      dm.evaluate(() => {
        type Node = { closest(s: string): Node | null };
        const a = (globalThis as unknown as { document: { activeElement: Node | null } }).document.activeElement;
        return a?.closest('[data-alert="rolls"]') != null || null;
      }),
    );
    assert.equal(await dock.count(), 0, "the row stayed with the pane gone");
    await shots.take(dm, "dmphone-fu20b-r1-pane-dock-tapped");
    // The pane's own Close brings the cards back too.
    await openPane("again");
    await onEdge("with the trap still waiting");
    await close.tap();
    await pane.waitFor({ state: "detached" });
    await cards.first().waitFor();
    assert.equal(await dock.count(), 0, "the row stayed after Close");
    for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
    await ops.send({ t: "trap.delete", trapId });
    await waitFor("the trap gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] ? true : null));
    await pickTool(dm, "Select");
  });

  test("fu20b-r2-3. at 667 x 375 at 130%, where the row and the pane's least height do not both fit under the top bar, a trap that goes off while its pane is open docks no row there: the pane stays clear of the top bar with its Close in reach, and the alerts come back as it closes (FU20B-ASTRA-4)", async () => {
    await setUp({ width: 667, height: 375, scale: 1.3 });
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const cell = { x: 3, y: Math.floor(bounds.h / 2) };
    const trapId = randomUUID();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Loose Stone", zone: { cells: [{ x: cell.x, y: cell.y, w: 1, h: 1 }] }, rig } });
    await waitFor("the trap in the DM's view", () => dmSocket.state?.traps[trapId] ?? null);
    try {
      await pickTool(dm, "Trap");
      const pane = dm.getByRole("dialog", { name: "Edit trap" });
      const p = await pagePoint(dm, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
      assert.equal(await hit(dm, p), "CANVAS", "the trap is under something");
      await dm.touchscreen.tap(p.x, p.y);
      await pane.getByText("Loose Stone", { exact: true }).first().waitFor();
      await ops.send({ t: "trap.spring", trapId, tokenIds: [run.hag] });
      await waitFor("the springing waiting", () => ((dmSocket.state?.traps[trapId]?.rig?.due?.length ?? 0) >= 1 ? true : null));
      await dm.waitForTimeout(500);
      assert.equal(await dm.locator("[data-rvtt-pane-dock]").count(), 0, "a row docked on the pane with no room for it");
      const bars = await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }));
      const s = await rectOf(pane);
      assert.ok(s.top >= bars.bottom - 0.5, `the pane (top ${s.top}) runs under the top bar (foot ${bars.bottom})`);
      const close = pane.getByRole("button", { name: "Close", exact: true });
      assert.ok(await wholeInReach(close), "the pane's Close is out of reach");
      await shots.take(dm, "dmphone-fu20b-r2-pane-no-room");
      await close.tap();
      await pane.waitFor({ state: "detached" });
      // The column's own row or its card, whichever the room leaves.
      await dm.getByRole("button", { name: /Loose Stone went off/ }).or(dm.getByRole("group", { name: "Loose Stone went off" })).first().waitFor();
      await shots.take(dm, "dmphone-fu20b-r2-pane-no-room-closed");
    } finally {
      for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
      await ops.send({ t: "trap.delete", trapId });
      await waitFor("the trap gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] ? true : null));
      await pickTool(dm, "Select");
      await setUp({ width: 390, height: 844, scale: 1 });
    }
  });

  test("fu21b-1. at 390 x 844 a trap that goes off while its pane is open toasts 8 px under the pane's header, so the header, its Close and the alerts row on the pane's edge stay in reach (LP15-FU-8)", async () => {
    await setUp({ width: 390, height: 844, scale: 1 });
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const cell = { x: 3, y: Math.floor(bounds.h / 2) };
    const trapId = randomUUID();
    const walker = randomUUID();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Needle Plate", zone: { cells: [{ x: cell.x, y: cell.y, w: 1, h: 1 }] }, rig } });
    await ops.send({ t: "token.create", token: { id: walker, sceneId: run.sceneId, kind: "monster", name: "Scout", x: cell.x, y: cell.y - 3, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: goblin() } } });
    await waitFor("the trap and the scout in the DM's view", () => (dmSocket.state?.traps[trapId] && dmSocket.state.tokens[walker] ? true : null));
    try {
      await pickTool(dm, "Trap");
      const pane = dm.getByRole("dialog", { name: "Edit trap" });
      const p = await pagePoint(dm, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
      assert.equal(await hit(dm, p), "CANVAS", "the trap is under something");
      await dm.touchscreen.tap(p.x, p.y);
      await pane.getByText("Needle Plate", { exact: true }).first().waitFor();
      // The pane settles at its measured height before the trap goes off.
      await dm.waitForTimeout(300);
      // Not the DM's own Set it off, which toasts nothing: the scout walks onto the plate.
      await ops.send({ t: "token.move", tokenId: walker, x: cell.x, y: cell.y });
      const toast = dm.locator("[data-toast]").filter({ hasText: "Needle Plate went off: Scout." }).first();
      await toast.waitFor();
      const t = await rectOf(toast);
      const head = await rectOf(pane.locator("[data-sheet-grab]").first());
      const bars = await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }));
      assert.ok(head.top >= bars.bottom - 0.5, `the pane's header (top ${head.top}) runs under the top bars (foot ${bars.bottom})`);
      assert.ok(Math.abs(t.top - (head.bottom + 8)) < 1.5, `the toast starts at ${t.top}, not 8 px under the pane's header at ${head.bottom}`);
      assert.ok(!intersects(t, head), `the toast covers the pane's header: ${JSON.stringify({ t, head })}`);
      assert.ok(await wholeInReach(pane.getByRole("button", { name: "Close", exact: true })), "the pane's Close is out of reach");
      const row = dm.locator("[data-rvtt-pane-dock]").getByRole("button");
      if ((await row.count()) > 0) assert.ok(await wholeInReach(row.first()), "the alerts row on the pane's edge is out of reach");
      // The toast's own Save and damage takes a tap too.
      assert.ok(await wholeInReach(toast.getByRole("button", { name: "Save and damage", exact: true })), "the toast's Save and damage is out of reach");
      await shots.take(dm, "dmphone-fu21b-pane-toast");
    } finally {
      for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
      await ops.send({ t: "trap.delete", trapId });
      await ops.send({ t: "token.delete", tokenId: walker });
      await waitFor("the trap and the scout gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] && !dmSocket.state.tokens[walker] ? true : null));
      await pickTool(dm, "Select");
    }
  });

  test("fu21b-2. at 480 x 320 at 130%, where the bars leave a trap's pane less than its least height, the pane stands over the top bar with its header, Close and a toast in reach (FU20B-PANE-480)", async () => {
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const cell = { x: 3, y: Math.floor(bounds.h / 2) };
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    const made = { trapId: "", walker: "" };
    const clear = async () => {
      const { trapId, walker } = made;
      if (trapId) {
        for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
        await ops.send({ t: "trap.delete", trapId });
      }
      if (walker && dmSocket.state?.tokens[walker]) await ops.send({ t: "token.delete", tokenId: walker });
      await waitFor("the trap and the scout gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] && !dmSocket.state.tokens[walker] ? true : null));
      made.trapId = "";
      made.walker = "";
    };
    try {
      for (const view of [
        { width: 480, height: 320, scale: 1.3 },
        { width: 480, height: 320, scale: 1.3, side: 47, bottom: 21 },
      ]) {
        const label = `480 x 320 at 130%${view.side ? " with 47 px at the sides and 21 at the foot" : ""}`;
        made.trapId = randomUUID();
        made.walker = randomUUID();
        const { trapId, walker } = made;
        await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Tripwire", zone: { cells: [{ x: cell.x, y: cell.y, w: 1, h: 1 }] }, rig } });
        await ops.send({ t: "token.create", token: { id: walker, sceneId: run.sceneId, kind: "monster", name: "Scout", x: cell.x, y: cell.y - 3, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: goblin() } } });
        await waitFor("the trap and the scout in the DM's view", () => (dmSocket.state?.traps[trapId] && dmSocket.state.tokens[walker] ? true : null));
        await setUp(view);
        await pickTool(dm, "Trap");
        const pane = dm.getByRole("dialog", { name: "Edit trap" });
        const p = await pagePoint(dm, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
        await dm.touchscreen.tap(p.x, p.y);
        await pane.getByText("Tripwire", { exact: true }).first().waitFor();
        await dm.waitForTimeout(300);
        const bars = await rectOf(dm.locator("header").filter({ has: dm.locator("h1") }));
        const s = await rectOf(pane);
        const head = pane.locator("[data-sheet-grab]").first();
        const h = await rectOf(head);
        assert.ok(s.top < bars.bottom, `${label}: the pane (top ${s.top}) fits under the top bar (foot ${bars.bottom}), so this step shows nothing`);
        assert.ok(h.top >= -0.5, `${label}: the pane's header (top ${h.top}) runs off the screen`);
        assert.ok(s.bottom - s.top >= 120 * 1.3 - 1, `${label}: the pane is ${s.bottom - s.top} px, under its least height`);
        const close = pane.getByRole("button", { name: "Close", exact: true });
        assert.ok(await wholeInReach(close), `${label}: the pane's Close is out of reach`);
        assert.ok(await wholeInReach(head.locator("strong").first()), `${label}: the pane's title is covered`);
        // A toast still shows over the pane, under its header.
        await ops.send({ t: "token.move", tokenId: walker, x: cell.x, y: cell.y });
        const toast = dm.locator("[data-toast]").filter({ hasText: "Tripwire went off: Scout." }).first();
        await toast.waitFor();
        await dm.waitForTimeout(200);
        assert.ok(await wholeInReach(toast.getByRole("button", { name: "Save and damage", exact: true })), `${label}: the toast's Save and damage is covered`);
        // What shows of it: a stack too tall for its room scrolls there, its newest in view (review LP16-PT-2).
        assert.ok(!intersects(await shownRect(toast), await rectOf(head)), `${label}: the toast covers the pane's header`);
        assert.ok(await wholeInReach(close), `${label}: the toast took the pane's Close out of reach`);
        await shots.take(dm, `dmphone-fu21b-pane-480${view.side ? "-insets" : ""}`);
        await close.tap();
        await pane.waitFor({ state: "detached" });
        await pickTool(dm, "Select");
        await clear();
      }
    } finally {
      await clear();
      await setUp({ width: 390, height: 844, scale: 1 });
    }
  });

  test("fu22b-1. at 390 x 844 a whisper at the top of the notices moves under a trap pane's header as the pane opens, the same toast, never drawn anew (review FU21B-OP-7)", async () => {
    await setUp({ width: 390, height: 844, scale: 1 });
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const cell = { x: 3, y: Math.floor(bounds.h / 2) };
    const trapId = randomUUID();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Needle Plate", zone: { cells: [{ x: cell.x, y: cell.y, w: 1, h: 1 }] }, rig } });
    await waitFor("the trap in the DM's view", () => dmSocket.state?.traps[trapId] ?? null);
    try {
      await pickTool(dm, "Trap");
      await whisperFromPat("Behind you!");
      const toast = dm.locator("[data-toast]").filter({ hasText: "Behind you!" }).first();
      await toast.waitFor();
      // Marked on the element itself: a toast drawn anew is a new element, without the mark.
      const inLayer = () => toast.evaluate((el) => (el as unknown as { closest(s: string): unknown }).closest("[data-rvtt-toast-layer]") !== null);
      await toast.evaluate((el) => Object.assign(el, { fu22bMark: true }));
      assert.equal(await inLayer(), false, "the whisper did not start at the top of the notices, so this step shows nothing");
      // Said once by the toasts' one status region, and the toast itself is no live region, so moving it can say nothing (review FU22B-OP-3).
      const region = dm.locator("[data-rvtt-toast-status]");
      const said = () => region.evaluate((el) => (el.textContent ?? "").split("Behind you!").length - 1);
      await waitFor("the whisper said", async () => ((await said()) === 1 ? true : null));
      await region.locator("span").evaluate((el) => Object.assign(el, { fu22bSaid: true }));
      assert.equal(await toast.evaluate((el) => (el as unknown as { closest(s: string): unknown }).closest('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])') === null), true, "the toast is a live region of its own");
      const pane = dm.getByRole("dialog", { name: "Edit trap" });
      const p = await pagePoint(dm, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
      await dm.touchscreen.tap(p.x, p.y);
      await pane.getByText("Needle Plate", { exact: true }).first().waitFor();
      const head = pane.locator("[data-sheet-grab]").first();
      await waitFor("the whisper 8 px under the pane's header", async () => {
        const t = await rectOf(toast);
        const h = await rectOf(head);
        return Math.abs(t.top - (h.bottom + 8)) < 1.5 ? true : null;
      }, 3_000);
      assert.equal(await inLayer(), true, "the whisper is not in the toasts' layer");
      assert.equal(await toast.evaluate((el) => (el as unknown as { fu22bMark?: boolean }).fu22bMark === true), true, "the whisper was drawn anew as it moved");
      assert.equal(await said(), 1, "the whisper was said again as it moved");
      assert.equal(await region.locator("span").evaluate((el) => (el as unknown as { fu22bSaid?: boolean }).fu22bSaid === true), true, "the status region spoke again as the whisper moved");
      assert.ok(!intersects(await rectOf(toast), await rectOf(head)), "the whisper covers the pane's header");
      assert.ok(await wholeInReach(pane.getByRole("button", { name: "Close", exact: true })), "the pane's Close is out of reach");
      await shots.take(dm, "dmphone-fu22b-whisper-under-pane");
      await pane.getByRole("button", { name: "Close", exact: true }).tap();
      await pane.waitFor({ state: "detached" });
    } finally {
      await ops.send({ t: "trap.delete", trapId });
      await waitFor("the trap gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] ? true : null));
      await pickTool(dm, "Select");
    }
  });

  test("fu22b-2. at 480 x 320 at 130% with a label's pane open, a whisper and then a trap's toast run past the room above the tool's options: the whisper goes, and the trap's Save and damage stays on screen and takes a tap (review LP16-PT-2)", async () => {
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const cell = { x: 3, y: Math.floor(bounds.h / 2) };
    const spot = { x: 6, y: Math.floor(bounds.h / 2) };
    const labelId = randomUUID();
    const trapId = randomUUID();
    const walker = randomUUID();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await ops.send({ t: "build.label", sceneId: run.sceneId, labelId, label: { x: spot.x + 0.5, y: spot.y + 0.5, text: "Gate", size: 1 } });
    await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Tripwire", zone: { cells: [{ x: cell.x, y: cell.y, w: 1, h: 1 }] }, rig } });
    await ops.send({ t: "token.create", token: { id: walker, sceneId: run.sceneId, kind: "monster", name: "Scout", x: cell.x, y: cell.y - 3, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: goblin() } } });
    await waitFor("the trap and the scout in the DM's view", () => (dmSocket.state?.traps[trapId] && dmSocket.state.tokens[walker] ? true : null));
    try {
      await setUp({ width: 480, height: 320, scale: 1.3 });
      await pickTool(dm, "Map builder");
      await pickOption(dm, "Map builder", "Builder mode", "Label");
      const pane = dm.getByRole("dialog", { name: "Edit label" });
      const p = await pagePoint(dm, bounds, { x: spot.x + 0.5, y: spot.y + 0.5 });
      await dm.touchscreen.tap(p.x, p.y);
      await pane.waitFor();
      await dm.waitForTimeout(300);
      await whisperFromPat("Behind you!");
      const whisper = dm.locator("[data-toast]").filter({ hasText: "Behind you!" });
      await whisper.first().waitFor();
      await ops.send({ t: "token.move", tokenId: walker, x: cell.x, y: cell.y });
      const toast = dm.locator("[data-toast]").filter({ hasText: "Tripwire went off: Scout." }).first();
      await toast.waitFor();
      await dm.waitForTimeout(200);
      const save = toast.getByRole("button", { name: "Save and damage", exact: true });
      const b = await rectOf(save);
      const screen = await dm.evaluate(() => (globalThis as unknown as { innerHeight: number }).innerHeight);
      assert.ok(b.top >= 0 && b.bottom <= screen + 0.5, `the trap's Save and damage runs off the screen: ${JSON.stringify(b)} on a ${screen} px screen`);
      assert.ok(await wholeInReach(save), "the trap's Save and damage is covered");
      assert.equal(await whisper.count(), 0, "the whisper, logged and with no button, stayed while the trap's toast ran past its room");
      // The stack keeps above the tool's controls, scrolling where it runs past them, so Label and its field stay in reach too. Their hint line may be covered.
      const controls = await dm
        .getByRole("toolbar", { name: "Map builder options" })
        .evaluate((el) => Math.min(...Array.from((el as unknown as { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { top: number; height: number } }> }).querySelectorAll("[data-options-row] button, [data-options-row] input")).map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top)));
      const shown = await shownRect(toast);
      assert.ok(shown.bottom <= controls + 0.5, `the toast runs down to ${shown.bottom}, over the tool's controls at ${controls}`);
      await shots.take(dm, "dmphone-fu22b-trap-toast-480");
      // The room shrinks with no scroll of the stack's own: following its newest, it stays at its foot, Save and damage whole (review FU22B-ASTRA-02).
      await dm.setViewportSize({ width: 480, height: 306 });
      await dm.waitForTimeout(400);
      assert.ok(await wholeInReach(save), "with the room shrunk, the trap's Save and damage is cut");
      await save.tap();
      await toast.waitFor({ state: "detached" });
    } finally {
      for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
      await ops.send({ t: "trap.delete", trapId });
      await ops.send({ t: "token.delete", tokenId: walker });
      await ops.send({ t: "build.label", sceneId: run.sceneId, labelId, label: null });
      await waitFor("the trap and the scout gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] && !dmSocket.state.tokens[walker] ? true : null));
      await setUp({ width: 390, height: 844, scale: 1 });
      await pickTool(dm, "Select");
    }
  });

  test("fu22b-3. at 390 x 844 under a trap pane, a whisper, then the trap's toast: with the trap's Save and damage focused, the whisper's going moves nothing, and Enter on it still works (review FU22B-ASTRA-01)", async () => {
    await setUp({ width: 390, height: 844, scale: 1 });
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const cell = { x: 3, y: Math.floor(bounds.h / 2) };
    const trapId = randomUUID();
    const walker = randomUUID();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: trapId, sceneId: run.sceneId, name: "Snare", zone: { cells: [{ x: cell.x, y: cell.y, w: 1, h: 1 }] }, rig } });
    await ops.send({ t: "token.create", token: { id: walker, sceneId: run.sceneId, kind: "monster", name: "Scout", x: cell.x, y: cell.y - 3, size: "medium", visibility: "all", disposition: "hostile", actor: { inline: goblin() } } });
    await waitFor("the trap and the scout in the DM's view", () => (dmSocket.state?.traps[trapId] && dmSocket.state.tokens[walker] ? true : null));
    try {
      await pickTool(dm, "Trap");
      const pane = dm.getByRole("dialog", { name: "Edit trap" });
      const p = await pagePoint(dm, bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
      await dm.touchscreen.tap(p.x, p.y);
      await pane.getByText("Snare", { exact: true }).first().waitFor();
      await dm.waitForTimeout(300);
      await whisperFromPat("Over here!");
      const whisper = dm.locator("[data-toast]").filter({ hasText: "Over here!" });
      await whisper.waitFor();
      await ops.send({ t: "token.move", tokenId: walker, x: cell.x, y: cell.y });
      const toast = dm.locator("[data-toast]").filter({ hasText: "Snare went off: Scout." }).first();
      await toast.waitFor();
      const save = toast.getByRole("button", { name: "Save and damage", exact: true });
      await save.focus();
      const focused = () => save.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement);
      assert.equal(await focused(), true, "Save and damage did not take focus, so this step shows nothing");
      // The whisper's 5 s run out before the trap's 12 s.
      await whisper.waitFor({ state: "detached", timeout: 8_000 });
      await dm.waitForTimeout(200);
      assert.equal(await focused(), true, "Save and damage lost its focus as the whisper above it went");
      await dm.keyboard.press("Enter");
      await toast.waitFor({ state: "detached" });
      await shots.take(dm, "dmphone-fu22b-focus-kept");
    } finally {
      for (const due of dmSocket.state?.traps[trapId]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId, due: due.id });
      await ops.send({ t: "trap.delete", trapId });
      await ops.send({ t: "token.delete", tokenId: walker });
      await waitFor("the trap and the scout gone", () => (dmSocket.state && !dmSocket.state.traps[trapId] && !dmSocket.state.tokens[walker] ? true : null));
      await setUp({ width: 390, height: 844, scale: 1 });
      await pickTool(dm, "Select");
    }
  });
});

/** Pat, joined once from a device of their own, whose cookies send a whisper to the DM. */
let patCookie = "";

async function whisperFromPat(text: string): Promise<void> {
  if (!patCookie) {
    const context = await browser.newContext();
    try {
      const headers = { Origin: server.origin, "content-type": "application/json" };
      const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
      assert.ok(joined.ok(), `joining answered ${joined.status()}`);
      const { ticket } = (await joined.json()) as { ticket: string };
      const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
      assert.ok(done.ok(), `completing the join answered ${done.status()}`);
      patCookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    } finally {
      await context.close();
    }
  }
  const pat = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: patCookie });
  try {
    await pat.send({ t: "log.whisper", to: [dmSocket.you!.memberId], text });
  } finally {
    pat.close();
  }
}

function goblin() {
  return {
    hp: { cur: 7, max: 7, temp: 0 },
    life: "alive",
    ac: 15,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 9,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}
