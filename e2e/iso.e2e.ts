import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, reopenRoom, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * The isometric view's choice (docs/design-v1-isometric-view.md 7 and 8,
 * lane ISO-5): the View button and its menu, a scene's Suggested view,
 * the keys I, Q and E, and the table display's rows. A DM on a computer,
 * Pat on a phone and a TV.
 *
 * Isometric is out of reach until the lanes that draw it are in
 * (client/features/view/store.ts isoReady), so every page here but one
 * is opened as an end-to-end test may open it: with the flag that makes a
 * page offer it set before the app's first script
 * (client/features/view/choice.ts isoOffered). The one plain page checks
 * that nothing of it shows without the flag.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus five, as
 * size.e2e.ts does, since the runs never overlap. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 5;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-iso-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script, as only a test sets it. */
const OFFER = "globalThis.__rvttIsoTest = true;";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let pat: Page;
let tv: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat"), tv: new ConsoleWatch("tv") };

const run = {
  roomId: "",
  roomName: `E2E iso ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  secondId: randomUUID(),
};

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

const viewButton = (page: Page) => page.getByRole("button", { name: /^View: / });
const viewMenu = (page: Page) => page.getByRole("dialog", { name: "View" });

/** What this browser keeps for the room under `key`, parsed. */
async function stored(page: Page, key: string): Promise<unknown> {
  const raw = await page.evaluate((k) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(k), key);
  return raw === null ? null : JSON.parse(raw);
}

/** The board's view as the View button names it, and the turn its icon shows: the flip of the diamond (pages/RoomChrome.tsx ISO_FLIP). */
async function shownView(page: Page): Promise<string> {
  const button = viewButton(page);
  const name = (await button.getAttribute("aria-label")) ?? "";
  const flip = await button.locator("svg").evaluate((el) => (el as unknown as { style: { transform: string } }).style.transform);
  const turn = { "": 0, "scaleY(-1)": 1, "scale(-1, -1)": 2, "scaleX(-1)": 3 }[flip];
  return name === "View: Isometric" ? `isometric ${turn}` : name === "View: Top-down" ? `top-down${flip ? ` ${flip}` : ""}` : name;
}

async function untilShown(page: Page, want: string): Promise<void> {
  let seen = "";
  try {
    await waitFor(`the board in ${want}`, async () => ((seen = await shownView(page)) === want ? true : null));
  } catch (err) {
    throw new Error(`${(err as Error).message}: showed ${seen}`);
  }
}

/** The words the elements an element's aria-describedby names hold. */
function description(el: Locator): Promise<string> {
  return el.evaluate((node) => {
    const el = node as unknown as { getAttribute(name: string): string | null; ownerDocument: { getElementById(id: string): { textContent: string | null } | null } };
    return (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id: string) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
  });
}

/** Keys go to the page, not to a tab or button that kept focus. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
}

/** The polite status's region outside the menu, once it says `words`. */
async function said(page: Page, words: string): Promise<void> {
  await page.locator("[data-rvtt-view-status]").filter({ hasText: words }).first().waitFor({ state: "attached" });
}

async function openMenu(page: Page, touch: boolean): Promise<Locator> {
  if (touch) await viewButton(page).tap();
  else await viewButton(page).click();
  const menu = viewMenu(page);
  await menu.waitFor();
  await onCheckedRadio(page, menu);
  return menu;
}

/**
 * Any open of the menu, a tap and a click too, puts focus on the checked
 * radio, and after a pointer draws no ring (design 8, D-261026-12).
 */
async function onCheckedRadio(page: Page, menu: Locator): Promise<void> {
  const checked = menu.locator("input[type=radio]:checked");
  await waitFor("focus on the checked radio", () => checked.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement || null));
  const ring = await checked.evaluate((el) => {
    const label = (el as unknown as { parentElement: unknown }).parentElement;
    return (globalThis as unknown as { getComputedStyle(e: unknown): { outlineStyle: string } }).getComputedStyle(label).outlineStyle;
  });
  assert.equal(ring, "none", "no ring after a pointer");
}

async function closeMenu(page: Page, touch: boolean): Promise<void> {
  const menu = viewMenu(page);
  if (touch) await menu.getByRole("button", { name: /^Close/ }).tap();
  else await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

async function suggest(view: "Top-down" | "Isometric"): Promise<void> {
  await openSideTab(dm, "Scenes");
  const group = dm.getByRole("tabpanel", { name: "Scenes" }).getByRole("radiogroup", { name: "Suggested view" });
  await group.getByRole("radio", { name: view }).check();
}

describe("raccoon-vtt isometric view: the choice", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const c of [dmContext, patContext]) await c.addInitScript(OFFER);
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("ISO-1. the DM's room with a second scene, Pat on a phone, and a page without the flag shows nothing of the choice", async () => {
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
    await ops.send({ t: "scene.create", scene: { id: run.secondId, name: "The crypt", bounds: { w: 20, h: 14 }, fogEnabled: false } });
    await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state);
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();

    // The same DM in a browser no test flagged, as every device is until Isometric is ready.
    const plainContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await dmContext.storageState() });
    try {
      const plain = await plainContext.newPage();
      const plainConsole = new ConsoleWatch("plain");
      plainConsole.attach(plain);
      await plain.goto(`${server.origin}/r/${run.roomId}`);
      await plain.getByRole("button", { name: "Fit the map to the screen" }).waitFor();
      assert.equal(await viewButton(plain).count(), 0, "no View button");
      await openSideTab(plain, "Scenes");
      await plain.getByRole("tabpanel", { name: "Scenes" }).getByText("Starting view").waitFor();
      assert.equal(await plain.getByRole("radiogroup", { name: "Suggested view" }).count(), 0, "no Suggested view");
      await blur(plain);
      await plain.keyboard.press("i");
      await plain.keyboard.press("e");
      await plain.waitForTimeout(300);
      assert.equal(await stored(plain, `rvtt.view.${run.roomId}`), null, "I stored no pick");
      assert.equal(await plain.locator("[data-toast]").filter({ hasText: /isometric|top-down/i }).count(), 0, "E said nothing");
      await plain.keyboard.press("?");
      const sheet = plain.getByRole("dialog", { name: /shortcuts/i });
      await sheet.waitFor();
      assert.equal(await sheet.getByText("Switch between top-down and isometric").count(), 0, "the sheet has no I");
      assert.deepEqual(plainConsole.errors, []);
    } finally {
      await plainContext.close();
    }
  });

  test("ISO-2. Pat's page follows the scene: Top-down, then Isometric as soon as the DM suggests it, then Top-down again", async () => {
    await untilShown(pat, "top-down");
    let menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene", checked: true }).waitFor();
    await menu.getByText("This scene suggests Top-down.").waitFor();
    assert.equal(await menu.getByRole("button", { name: "Turn right", exact: true }).count(), 0, "no turns in Top-down");
    await shots.take(pat, "iso-pat-menu-top-down");
    await closeMenu(pat, true);

    await suggest("Isometric");
    await untilShown(pat, "isometric 0");
    await said(pat, "Isometric view.");
    menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene", checked: true }).waitFor();
    await menu.getByText("This scene suggests Isometric.").waitFor();
    await shots.take(pat, "iso-pat-menu-isometric");
    await closeMenu(pat, true);
    assert.deepEqual(await stored(pat, `rvtt.view.${run.roomId}`), null, "following stores nothing");

    await suggest("Top-down");
    await untilShown(pat, "top-down");
    await said(pat, "Top-down view.");
  });

  test("ISO-3. a turn holds per scene, survives a reload, and never stops Pat following the scene", async () => {
    await suggest("Isometric");
    await untilShown(pat, "isometric 0");
    let menu = await openMenu(pat, true);
    await menu.getByRole("button", { name: "Turn right", exact: true }).tap();
    await menu.locator("[data-rvtt-view-status]").filter({ hasText: "Turned right. The map's top edge faces down and to the right." }).waitFor({ state: "attached" });
    await closeMenu(pat, true);
    await untilShown(pat, "isometric 1");
    assert.deepEqual(await stored(pat, `rvtt.view.${run.roomId}`), { v: 1, turns: { [run.sceneId]: 1 } }, "a turn alone is no pick");

    await reopenRoom(pat);
    await untilShown(pat, "isometric 1");
    menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene", checked: true }).waitFor();
    await closeMenu(pat, true);

    // The crypt suggests Isometric too, and has a turn of its own.
    await ops.send({ t: "scene.update", sceneId: run.secondId, patch: { suggestedView: "isometric" } });
    await ops.send({ t: "room.setPlayerScene", sceneId: run.secondId });
    await untilShown(pat, "isometric 0");
    menu = await openMenu(pat, true);
    await menu.getByRole("button", { name: "Turn left", exact: true }).tap();
    await closeMenu(pat, true);
    await untilShown(pat, "isometric 3");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await untilShown(pat, "isometric 1");
    assert.deepEqual(await stored(pat, `rvtt.view.${run.roomId}`), { v: 1, turns: { [run.sceneId]: 1, [run.secondId]: 3 } });

    await suggest("Top-down");
    await untilShown(pat, "top-down");
  });

  test("ISO-4. Pat's pick holds for the whole room, every scene, across a reload, until Follow the scene again", async () => {
    await suggest("Isometric");
    await untilShown(pat, "isometric 1");
    let menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Top-down" }).check();
    await closeMenu(pat, true);
    await untilShown(pat, "top-down");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.secondId });
    await waitFor("Pat on the crypt", () => (patSocket.state?.meta.playerSceneId === run.secondId ? true : null));
    await pat.waitForTimeout(300);
    await untilShown(pat, "top-down");
    await reopenRoom(pat);
    await untilShown(pat, "top-down");
    assert.equal((await stored(pat, `rvtt.view.${run.roomId}`) as { pick?: string }).pick, "topDown");

    menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene" }).check();
    await menu.locator("[data-rvtt-view-status]").filter({ hasText: "Following the scene: isometric." }).waitFor({ state: "attached" });
    await closeMenu(pat, true);
    await untilShown(pat, "isometric 3");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await untilShown(pat, "isometric 1");
    await suggest("Top-down");
    await untilShown(pat, "top-down");
  });

  test("ISO-5. the DM's keys: I and E, the builder showing Top-down with its line, Isometric back with Select, and Q in Top-down saying why", async () => {
    await dm.bringToFront();
    await untilShown(dm, "top-down");
    await blur(dm);
    await dm.keyboard.press("i");
    await untilShown(dm, "isometric 0");
    await said(dm, "Isometric view.");
    await dm.keyboard.press("e");
    await untilShown(dm, "isometric 1");
    await said(dm, "Turned right. The map's top edge faces down and to the right.");

    await dm.keyboard.press("b");
    await untilShown(dm, "top-down");
    await said(dm, "The map builder works top-down. Isometric comes back when you switch tools.");
    const menu = await openMenu(dm, false);
    await menu.getByRole("radio", { name: "Isometric", checked: true }).waitFor();
    await menu.getByText("The map builder works top-down. Isometric comes back when you switch tools.").waitFor();
    assert.equal(await menu.getByRole("button", { name: "Turn right", exact: true }).count(), 0, "no turns while the builder shows Top-down");
    await shots.take(dm, "iso-dm-menu-builder");
    await closeMenu(dm, false);
    await dm.keyboard.press("e");
    await dm.locator("[data-toast]").filter({ hasText: "The map builder works top-down. Isometric comes back when you switch tools." }).first().waitFor();
    await dm.keyboard.press("v");
    await untilShown(dm, "isometric 1");
    await said(dm, "Isometric view.");

    await dm.keyboard.press("q");
    await untilShown(dm, "isometric 0");
    await dm.keyboard.press("i");
    await untilShown(dm, "top-down");
    await dm.keyboard.press("q");
    await dm.locator("[data-toast]").filter({ hasText: "Turning needs the isometric view." }).first().waitFor();
    assert.deepEqual(await stored(dm, `rvtt.view.${run.roomId}`), { v: 1, pick: "topDown", turns: { [run.sceneId]: 0 } });

    // A Top-down pick keeps Top-down after the builder, so the menu promises no Isometric back (ISO5-ASTRA-03).
    await dm.keyboard.press("b");
    const flat = await openMenu(dm, false);
    await flat.getByRole("radio", { name: "Top-down", checked: true }).waitFor();
    assert.equal(await flat.getByText(/Isometric comes back/).count(), 0, "no promise of Isometric");
    await closeMenu(dm, false);
    await dm.keyboard.press("v");
  });

  test("ISO-6. the View button by keyboard: focus on the checked radio, the arrows choose, Tab reaches the turns, Escape goes back to the button", async () => {
    await viewButton(dm).focus();
    await dm.keyboard.press("Enter");
    const menu = viewMenu(dm);
    await menu.waitFor();
    await waitFor("focus on Top-down", () => dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { value?: string } | null } }).document.activeElement?.value === "topDown" || null));
    await dm.keyboard.press("ArrowDown");
    await untilShown(dm, "isometric 0");
    await menu.getByRole("button", { name: "Turn left", exact: true }).waitFor();
    // The popover keeps the size it opened with, and kept the turns' room, so they show without a scroll.
    for (const name of ["Turn left", "Turn right"]) assert.ok(await wholeInReach(menu.getByRole("button", { name, exact: true })), `${name} shows whole`);
    // Named by their words, with what turns in the description (D-261026-11).
    for (const [name, says] of [
      ["Turn left", "Turn the map left"],
      ["Turn right", "Turn the map right"],
    ] as const) {
      assert.ok((await description(menu.getByRole("button", { name, exact: true }))).includes(says), `${name}'s description`);
    }
    await dm.keyboard.press("Tab");
    await waitFor("focus on Turn left", () => menu.getByRole("button", { name: "Turn left", exact: true }).evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement || null));
    await dm.keyboard.press("Enter");
    await untilShown(dm, "isometric 3");
    await shots.take(dm, "iso-dm-menu-isometric");
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await waitFor("focus back on the View button", () => viewButton(dm).evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement || null));

    await dm.keyboard.press("?");
    const sheet = dm.getByRole("dialog", { name: /shortcuts/i });
    await sheet.waitFor();
    for (const words of ["Switch between top-down and isometric", "Turn the isometric view left", "Turn the isometric view right"]) await sheet.getByText(words, { exact: true }).waitFor();
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("ISO-7. the table display picks its own view, apart from a member's pick in the same browser, and its rows sit within 1 px at each size", async () => {
    tvContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await tvContext.addInitScript(OFFER);
    tv = await tvContext.newPage();
    consoles.tv.attach(tv);
    // A member's pick in this browser, which the display must not read.
    await tv.goto(`${server.origin}/`);
    await tv.evaluate((k) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(k, '{"v":1,"pick":"isometric","turns":{}}'), `rvtt.view.${run.roomId}`);
    const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
    assert.equal(res.status(), 201, await res.text());
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(((await res.json()) as { code: string }).code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await tv.locator(".konvajs-content").first().waitFor();

    const openTvMenu = async () => {
      const size = tv.viewportSize()!;
      await tv.mouse.click(size.width / 2, size.height / 2);
      const menu = tv.getByRole("menu", { name: "Table display" });
      await menu.waitFor();
      return menu;
    };
    let menu = await openTvMenu();
    const view = menu.getByRole("group", { name: "View" });
    await view.getByRole("menuitemradio", { name: "Follow the scene", checked: true }).waitFor();
    await menu.getByText("This scene suggests Top-down.").waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: "Turn right", exact: true }).count(), 0, "the display follows its Top-down scene");
    await view.getByRole("menuitemradio", { name: "Isometric" }).click();
    await menu.getByRole("menuitem", { name: "Turn right", exact: true }).click();
    await shots.take(tv, "iso-display-menu");
    assert.deepEqual(await stored(tv, `rvtt.displayView.${run.roomId}`), { v: 1, pick: "isometric", turns: { [run.sceneId]: 1 } });
    assert.deepEqual(await stored(tv, `rvtt.view.${run.roomId}`), { v: 1, pick: "isometric", turns: {} }, "the member's pick untouched");
    await view.getByRole("menuitemradio", { name: "Top-down" }).click();
    assert.equal((await stored(tv, `rvtt.view.${run.roomId}`) as { pick: string }).pick, "isometric", "the display's Top-down is its own");

    await tv.reload();
    await tv.locator(".konvajs-content").first().waitFor();
    menu = await openTvMenu();
    await menu.getByRole("group", { name: "View" }).getByRole("menuitemradio", { name: "Top-down", checked: true }).waitFor();
    await menu.getByRole("group", { name: "View" }).getByRole("menuitemradio", { name: "Isometric" }).click();

    const lines: string[] = [];
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      for (const scale of [1, 1.3]) {
        await tv.setViewportSize(size);
        await tv.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.displayUiScale", String(s)), scale);
        await tv.reload();
        await tv.locator(".konvajs-content").first().waitFor();
        menu = await openTvMenu();
        await menu.getByRole("menuitem", { name: "Turn left", exact: true }).waitFor();
        const at = `display ${size.width}x${size.height}${scale === 1 ? "" : "-130"}`;
        const found = alignmentLines(await measureAlignment(menu.getByRole("group", { name: "View" })), at);
        // "Top-down" on one line, never broken at its hyphen (ISO5-OPUS-5).
        for (const n of await menu.locator("[data-view-name]").evaluateAll((els) => els.map((el) => (el as unknown as { getClientRects(): { length: number } }).getClientRects().length))) {
          if (n !== 1) found.push(`${at}: the view's name in the help drawn over ${n} lines`);
        }
        lines.push(...found);
        if (found.length > 0) await shots.take(tv, `iso-display-${size.width}-${Math.round(scale * 100)}`);
        const box = await menu.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= size.width + 0.5 && box.y >= 0 && box.y + box.height <= size.height + 0.5, `${at}: the menu runs off the screen: ${JSON.stringify(box)}`);
        // Its last control still takes a tap, scrolled to where the menu is taller than the screen.
        const leave = menu.getByRole("menuitem", { name: "Leave" });
        await leave.scrollIntoViewIfNeeded();
        assert.ok(await wholeInReach(leave), `${at}: Leave is out of reach`);
        const frame = await menu.boundingBox();
        const last = await leave.boundingBox();
        assert.ok(frame && last && last.y + last.height <= frame.y + frame.height + 0.5, `${at}: Leave spills past the menu's frame: ${JSON.stringify([frame, last])}`);
      }
    }
    assert.deepEqual(lines, [], "the display's View rows");
  });

  test("ISO-8. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s page`);
  });
});
