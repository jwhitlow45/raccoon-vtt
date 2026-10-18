import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, reopenRoom, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The shortcut sheet (docs/design-v1-dm-tools.md 3.14): the keys, then on
 * a desktop what a key or another mouse button does with a click, a drag
 * or the wheel, and on an Android phone its Back button, each for the
 * viewer's role. The DM opens it with `?` on a computer, and a player from
 * Menu, This device, on a phone. Full screen (lib/fullscreen.ts) rides
 * along: the top bar's button, its key and its Menu switch on a computer,
 * and the switch alone on a phone. On the computer, the DM moves Fog's
 * key from the sheet, swaps it with Ruler's and resets them all
 * (state/keyBindings.ts). In a 390 px window at 130%, Change and Reset
 * keep clear of every row's words.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus fourteen.
 * The other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 14;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-shortcuts-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E shortcuts ${new Date().toISOString().slice(0, 19)}`,
  password: "",
};

/** What the rows under one of the sheet's headings say you do: the text of each row's heading cell. */
function inputs(sheet: Locator, heading: string): Promise<string[]> {
  return sheet.getByRole("heading", { name: heading, exact: true }).locator("xpath=ancestor::section[1]").locator("th").allTextContents();
}

/** The sheet's section headings, in order. */
function headings(sheet: Locator): Promise<string[]> {
  return sheet.getByRole("heading", { level: 3 }).allTextContents();
}

/** The page's own full screen element's tag: "HTML" for the whole page, or null. */
function fullscreenTag(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as { document: { fullscreenElement: { tagName: string } | null } }).document.fullscreenElement?.tagName ?? null);
}

async function fullscreenIs(page: Page, on: boolean, what: string): Promise<void> {
  await waitFor(what, async () => (((await fullscreenTag(page)) === "HTML") === on ? true : null));
}

/** Whether a tap at the middle of `target` lands on it, so nothing, the page in full screen included, covers it. */
async function onTop(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const r = (el as unknown as { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }).getBoundingClientRect();
    const hit = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): unknown } }).document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (el as unknown as { contains(other: unknown): boolean }).contains(hit);
  });
}

/** Chrome on an Android phone, whose Back button the room answers. */
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

describe("raccoon-vtt shortcut sheet on a desktop and an Android phone", { timeout: 120_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ANDROID_UA });
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
    await playerSocket.attach(playerContext, player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
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

  test("1. the DM creates a room on a computer and a player joins from a phone", async () => {
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
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();

    // A new device is answered 403 by GET /me before it joins, which Chrome logs.
    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).click();
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).click();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("2. on a computer, ? shows the DM's keys, then the mouse with keys, and no Android row", async () => {
    await dm.keyboard.press("?");
    const sheet = dm.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    const titles = await headings(sheet);
    assert.deepEqual(titles.slice(0, 2), ["Keys", "Mouse with keys"], titles.join(", "));
    assert.ok(!titles.includes("Android"), titles.join(", "));
    for (const surface of ["Side panel tabs", "Handout viewer", "Token window", "Initiative", "Roll requests", "Token and character fields", "Label, pin and light panes", "Dialogs", "Choose an image"]) {
      assert.ok(titles.includes(surface), `${surface} in ${titles.join(", ")}`);
    }
    // Request a roll's fields send it (docs/design-v1-roll-request.md 8).
    assert.deepEqual(await inputs(sheet, "Roll requests"), ["Enter"]);
    assert.equal(await sheet.getByRole("region").count(), 0, "headings, not landmarks");

    const keys = await inputs(sheet, "Keys");
    for (const k of ["Ctrl+Z", "T", "H", "/", "?", "Escape"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
    assert.deepEqual(await inputs(sheet, "Mouse with keys"), [
      "Shift or Ctrl+click a token (Cmd on a Mac)",
      "Shift or Ctrl+drag on empty map (Cmd on a Mac)",
      "Right-click a token",
      "Drag with the right or middle button",
      "Space+drag",
      "Ctrl+wheel, or a pinch on a trackpad",
      "Ctrl+wheel, or a pinch on a trackpad",
    ]);
    assert.deepEqual(await inputs(sheet, "Initiative"), ["Enter", "Escape", "Enter"], "the DM types several values");
    await shots.take(dm, "shortcuts-dm-computer");
    await sheet.getByRole("heading", { name: "Mouse with keys", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(dm, "shortcuts-dm-computer-mouse");
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("3. on an Android phone, Menu, This device shows a player's keys and the Back button, and nothing for the mouse or the DM", async () => {
    await player.locator('button[title="Panels"]').click();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    await player.getByRole("button", { name: /^This device/ }).click();
    await player.getByRole("button", { name: "Show the shortcuts" }).click();
    const sheet = player.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    const titles = await headings(sheet);
    assert.deepEqual(titles.slice(0, 2), ["Keys", "Android"], titles.join(", "));
    assert.ok(!titles.includes("Mouse with keys"), titles.join(", "));
    assert.ok(!titles.includes("Label, pin and light panes"), "the panes are the DM's");
    // A player's roll card: Enter sends a typed total, or rolls from the Bonus or Extra dice field (docs/design-v1-roll-request.md 8).
    assert.deepEqual(await inputs(sheet, "Roll requests"), ["Enter", "Enter"]);

    const keys = await inputs(sheet, "Keys");
    for (const k of ["Ctrl+Z", "V", "N", "Escape"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
    for (const k of ["T", "H", "/"]) assert.ok(!keys.includes(k), `the DM's ${k} is not a player's`);
    assert.deepEqual(await inputs(sheet, "Android"), ["Back button"]);
    assert.deepEqual(await inputs(sheet, "Initiative"), ["Enter", "Escape"], "only the DM types several values");
    assert.deepEqual(await inputs(sheet, "Handout viewer"), ["+, -", "0", "Arrow keys", "Page Down, Page Up", "Space, Shift+Space", "Home, End"]);
    await shots.take(player, "shortcuts-player-android");
    await sheet.getByRole("heading", { name: "Android", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(player, "shortcuts-player-android-back");
    await player.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("3b. on a 320 px phone at 130%, the sheet scrolls only down: a key's note wraps under its keycap", async () => {
    await player.setViewportSize({ width: 320, height: 568 });
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await player.locator('button[title="Panels"]').click();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    await player.getByRole("button", { name: /^This device/ }).click();
    await player.getByRole("button", { name: "Show the shortcuts" }).click();
    const sheet = player.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    const paste = sheet.getByRole("heading", { name: "Choose an image", exact: true });
    await paste.scrollIntoViewIfNeeded();
    const wide = await sheet.evaluate((root) => {
      type El = { scrollWidth: number; clientWidth: number; tagName: string; textContent: string | null };
      const all = [root as unknown as El, ...(Array.from((root as unknown as { querySelectorAll(s: string): ArrayLike<unknown> }).querySelectorAll("*")) as El[])];
      return all.filter((el) => el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1).map((el) => `${el.tagName} ${(el.textContent ?? "").slice(0, 30)}: ${el.scrollWidth} > ${el.clientWidth}`);
    });
    assert.deepEqual(wide, [], "content wider than its box at 320 px and 130%");
    await shots.take(player, "shortcuts-player-320-130-paste");
    await player.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
    await player.setViewportSize({ width: 390, height: 844 });
    await reopenRoom(player);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("fs-a. full screen on a computer by the top bar's button, W and Menu, This device, and on a 390 px phone by the Menu alone, with sheets on top", async () => {
    const bar = dm.locator("header:has(h1)").first();
    await bar.getByRole("button", { name: "Full screen", exact: true }).click();
    await fullscreenIs(dm, true, "full screen by the top bar");
    const leave = bar.getByRole("button", { name: "Leave full screen", exact: true });
    await leave.waitFor();
    // A sheet opened in full screen shows over it, and Escape still closes it.
    await dm.keyboard.press("?");
    const sheet = dm.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    assert.equal(await onTop(sheet.getByRole("heading", { name: "Keys", exact: true })), true, "the shortcut sheet shows in full screen");
    assert.ok((await inputs(sheet, "Keys")).includes("W"), "the sheet lists W");
    await shots.take(dm, "fs-a-dm-full-screen-sheet");
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await leave.click();
    await fullscreenIs(dm, false, "out of full screen by the top bar");
    await bar.getByRole("button", { name: "Full screen", exact: true }).waitFor();

    // W, from the button that kept focus, and never while typing in a field.
    await dm.keyboard.press("w");
    await fullscreenIs(dm, true, "full screen by W");
    await leave.waitFor();
    await dm.keyboard.press("w");
    await fullscreenIs(dm, false, "out of full screen by W");
    await dm.keyboard.press("/");
    const search = dm.getByRole("searchbox", { name: "Search the scene" }).or(dm.getByRole("textbox", { name: "Search the scene" }));
    await waitFor("the outliner's search focused", () => search.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement));
    await dm.keyboard.press("w");
    assert.equal(await search.inputValue(), "w", "W typed into the field");
    assert.equal(await fullscreenTag(dm), null, "W in a field leaves full screen alone");
    await search.fill("");

    // Menu, This device: a switch named Full screen, checked while the page is in it.
    await openSideTab(dm, "Menu");
    await dm.getByRole("button", { name: /^This device/ }).click();
    const toggle = dm.getByRole("switch", { name: "Full screen" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await toggle.click();
    await fullscreenIs(dm, true, "full screen by Menu, This device");
    await waitFor("the switch on", async () => ((await toggle.getAttribute("aria-checked")) === "true" ? true : null));
    await leave.waitFor();
    await toggle.click();
    await fullscreenIs(dm, false, "out of full screen by the switch");
    await waitFor("the switch off", async () => ((await toggle.getAttribute("aria-checked")) === "false" ? true : null));

    // A phone's top bar has no room and no button for it. Its Menu has the switch, and its sheet stays over the page in full screen.
    assert.equal(await player.locator("header:has(h1)").first().getByRole("button", { name: /full screen/i }).count(), 0, "no full screen button in a 390 px top bar");
    await player.locator('button[title="Panels"]').click();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    await player.getByRole("button", { name: /^This device/ }).click();
    const phoneToggle = player.getByRole("switch", { name: "Full screen" });
    // The sheet's own hidden button fills the sheet, not the page, so it goes by a name of its own.
    const menuSheet = player.getByRole("dialog").filter({ has: phoneToggle });
    assert.equal(await menuSheet.getByRole("button", { name: "Expand sheet" }).count(), 1, "the sheet's own button is Expand sheet");
    assert.equal(await menuSheet.getByRole("button", { name: /full screen/i }).count(), 0, "one Full screen control in the sheet");
    await phoneToggle.tap();
    await fullscreenIs(player, true, "a phone in full screen by Menu, This device");
    await waitFor("the phone's switch on", async () => ((await phoneToggle.getAttribute("aria-checked")) === "true" ? true : null));
    assert.equal(await onTop(phoneToggle), true, "the Menu's sheet stays over the page in full screen");
    await shots.take(player, "fs-a-phone-full-screen-menu");
    await phoneToggle.tap();
    await fullscreenIs(player, false, "the phone out of full screen");
    await player.keyboard.press("Escape");
  });

  test("kb-a. on a computer, the DM moves Fog's key from the sheet: the old key stops, the new one picks Fog, the tooltip and the sheet say so, a reload keeps it, a swap with Ruler works, and Reset all keys gives the defaults back", async () => {
    const tools = dm.getByRole("navigation", { name: "Tools" });
    const fog = tools.getByRole("button", { name: "Fog", exact: true });
    const ruler = tools.getByRole("button", { name: "Ruler", exact: true });
    const toolIs = async (button: Locator, what: string) => waitFor(what, async () => ((await button.getAttribute("aria-pressed")) === "true" ? true : null));
    /** A tool's tooltip, which a mouse's toolbar shows in place of a native title: the one its description names. */
    const tipOf = (button: Locator) =>
      button.evaluate((el) => {
        const doc = (globalThis as unknown as { document: { getElementById(id: string): { getAttribute(name: string): string | null; textContent: string | null } | null } }).document;
        for (const id of (el.getAttribute("aria-describedby") ?? "").split(" ")) {
          const tip = doc.getElementById(id);
          if (tip?.getAttribute("role") === "tooltip") return tip.textContent;
        }
        return null;
      });
    const openSheet = async () => {
      await dm.keyboard.press("?");
      const sheet = dm.getByRole("dialog", { name: "Shortcuts" });
      await sheet.waitFor();
      return sheet;
    };
    const closeSheet = async (sheet: Locator) => {
      await dm.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
    };
    /** The key a row of the sheet shows, by the shortcut's name. */
    const keyOf = (sheet: Locator, name: string) => sheet.locator("tr", { has: dm.getByRole("button", { name: `Change the key for ${name}`, exact: true }) }).locator("th").textContent();
    const stored = () => dm.evaluate(() => localStorage.getItem("rvtt.keys"));

    await dm.keyboard.press("v");
    assert.equal(await tipOf(fog), "Fog (F)", "the tooltip names the default key");
    assert.equal(await fog.getAttribute("title"), null, "an icon alone has the shared tooltip, never a native title");
    let sheet = await openSheet();
    const change = sheet.getByRole("button", { name: "Change the key for Fog", exact: true });
    // Escape while the row waits cancels the wait and leaves the sheet open.
    await change.click();
    await sheet.locator("table").getByText("Press a key, or Escape to cancel.").waitFor();
    await dm.keyboard.press("Escape");
    await sheet.locator("table").getByText("Press a key, or Escape to cancel.").waitFor({ state: "detached" });
    assert.equal(await sheet.isVisible(), true, "Escape cancelled the wait, not the sheet");
    // A key that stays as it is is refused with its reason, and the row still waits.
    await change.click();
    await dm.keyboard.press("ArrowUp");
    await sheet.locator("table").getByText("The arrow and Page keys stay for moving and raising tokens. Press another key, or Escape to cancel.").waitFor();
    await dm.keyboard.press("k");
    await waitFor("Fog's row to show K", async () => ((await keyOf(sheet, "Fog")) === "K" ? true : null));
    await sheet.getByRole("button", { name: "Reset the key for Fog", exact: true }).waitFor();
    assert.equal(await stored(), '{"v":1,"keys":{"tool:fog":"k"}}', "only the change is kept");
    await shots.take(dm, "kb-a-dm-fog-on-k");
    await closeSheet(sheet);

    assert.equal(await tipOf(fog), "Fog (K)", "the tooltip names the new key at once");
    // It shows on hover, as every icon alone's name does, and closes the name keyboard focus showed on Ruler: one at a time (LP8-UI-8).
    await dm.keyboard.press("v");
    await ruler.focus();
    await dm.locator('[role="tooltip"]:popover-open', { hasText: /^Ruler/ }).waitFor();
    await fog.hover();
    await dm.locator('[role="tooltip"]:popover-open', { hasText: "Fog (K)" }).waitFor();
    assert.equal(await dm.locator('[role="tooltip"]:popover-open').count(), 1, "two names show at once");
    await dm.mouse.move(0, 0);
    await dm.keyboard.press("f");
    await dm.waitForTimeout(150);
    assert.equal(await fog.getAttribute("aria-pressed"), "false", "F no longer picks Fog");
    await dm.keyboard.press("k");
    await toolIs(fog, "K to pick Fog");
    await dm.keyboard.press("v");

    // A reload keeps it, on this device.
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(await tipOf(fog), "Fog (K)", "the tooltip after a reload");
    await dm.keyboard.press("k");
    await toolIs(fog, "K to pick Fog after a reload");
    await dm.keyboard.press("v");

    // Ruler's R: already taken, so the sheet offers to swap.
    sheet = await openSheet();
    assert.equal(await keyOf(sheet, "Fog"), "K", "the sheet after a reload");
    const fogChange = sheet.getByRole("button", { name: "Change the key for Fog", exact: true });
    await fogChange.click();
    await dm.keyboard.press("r");
    await sheet.locator("table").getByText("Already Ruler.").waitFor();
    // Escape there is Cancel, and the sheet stays.
    await dm.keyboard.press("Escape");
    await sheet.locator("table").getByText("Already Ruler.").waitFor({ state: "detached" });
    assert.equal(await keyOf(sheet, "Fog"), "K", "nothing changed");
    await fogChange.click();
    await dm.keyboard.press("r");
    await sheet.locator("table").getByText("Already Ruler.").waitFor();
    const swap = sheet.getByRole("button", { name: "Swap", exact: true });
    await waitFor("focus on Swap", () => swap.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement));
    await shots.take(dm, "kb-a-dm-already-ruler");
    await swap.click();
    await waitFor("Fog on R and Ruler on K", async () => ((await keyOf(sheet, "Fog")) === "R" && (await keyOf(sheet, "Ruler")) === "K" ? true : null));
    await closeSheet(sheet);
    assert.equal(await tipOf(fog), "Fog (R)");
    assert.equal(await tipOf(ruler), "Ruler (K)");
    await dm.keyboard.press("r");
    await toolIs(fog, "R to pick Fog");
    await dm.keyboard.press("k");
    await toolIs(ruler, "K to pick Ruler");
    await dm.keyboard.press("v");

    // Reset all keys asks for a second tap, then every key is its default again.
    sheet = await openSheet();
    await sheet.locator("footer").getByRole("button", { name: "Reset all keys", exact: true }).click();
    await sheet.locator("footer").getByRole("button", { name: "Tap again to reset all keys", exact: true }).click();
    await waitFor("the defaults", async () => ((await keyOf(sheet, "Fog")) === "F" && (await keyOf(sheet, "Ruler")) === "R" ? true : null));
    assert.equal(await sheet.getByRole("button", { name: /^Reset the key for/ }).count(), 0, "nothing left to reset");
    assert.equal(await stored(), '{"v":1,"keys":{}}');
    await closeSheet(sheet);
    assert.equal(await tipOf(fog), "Fog (F)");
    await dm.keyboard.press("f");
    await toolIs(fog, "F to pick Fog again");
    await dm.keyboard.press("v");

    // A touch phone with no keyboard keeps the plain list. The reload forgets the keys pressed on it in the steps before, which a page takes for a keyboard's.
    await player.reload();
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await player.locator('button[title="Panels"]').click();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    await player.getByRole("button", { name: /^This device/ }).click();
    await player.getByRole("button", { name: "Show the shortcuts" }).click();
    const phoneSheet = player.getByRole("dialog", { name: "Shortcuts" });
    await phoneSheet.waitFor();
    assert.equal(await phoneSheet.getByRole("button", { name: /^Change the key for/ }).count(), 0, "no Change on a touch phone");
    assert.equal(await phoneSheet.getByRole("button", { name: "Reset all keys" }).count(), 0);
    await phoneSheet.getByRole("button", { name: /^Close/ }).first().tap();
    await phoneSheet.waitFor({ state: "detached" });
  });

  test("gs-a. in a 390 px window at 130%, no Change or Reset in the shortcut list covers a row's words, the longest row wraps beside its Change, and nothing runs off to the side", async () => {
    await dm.setViewportSize({ width: 390, height: 844 });
    await dm.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", "1.3"));
    await reopenRoom(dm);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.keyboard.press("?");
    const sheet = dm.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    // Draw on K, so one row has Reset under its Change.
    await sheet.getByRole("button", { name: "Change the key for Draw", exact: true }).click();
    await dm.keyboard.press("k");
    await sheet.getByRole("button", { name: "Reset the key for Draw", exact: true }).waitFor();

    const layout = await sheet.evaluate((root) => {
      type Rect = { left: number; right: number; top: number; bottom: number };
      type Node = { nodeType: number; textContent: string | null; childNodes: ArrayLike<Node> };
      type El = Node & { tagName: string; querySelector(s: string): El | null; querySelectorAll(s: string): ArrayLike<El>; getBoundingClientRect(): Rect; getAttribute(n: string): string | null; scrollWidth: number; clientWidth: number };
      const doc = (globalThis as unknown as { document: { createRange(): { selectNodeContents(n: Node): void; getClientRects(): ArrayLike<Rect> } } }).document;
      const overlaps = (a: Rect, b: Rect) => a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
      // A cell's words as the boxes of their lines, so a word under a button is found however the cell wraps.
      const lines = (cell: Node): Rect[] => {
        const out: Rect[] = [];
        const walk = (n: Node) => {
          if (n.nodeType === 3 && (n.textContent ?? "").trim()) {
            const range = doc.createRange();
            range.selectNodeContents(n);
            out.push(...Array.from(range.getClientRects()));
          }
          Array.from(n.childNodes).forEach(walk);
        };
        walk(cell);
        return out;
      };
      const el = root as unknown as El;
      const covered: string[] = [];
      let longest = { words: "", lines: 0 };
      let rows = 0;
      for (const row of Array.from(el.querySelectorAll("tr"))) {
        const key = row.querySelector("th");
        const words = row.querySelector("td");
        const buttons = Array.from(row.querySelectorAll("button"));
        if (!key || !words || buttons.length === 0) continue;
        rows++;
        const boxes = [...lines(key), ...lines(words)];
        for (const button of buttons) {
          for (const box of boxes) if (overlaps(button.getBoundingClientRect(), box)) covered.push(`${button.getAttribute("aria-label")} over "${(words.textContent ?? "").trim()}"`);
        }
        const text = (words.textContent ?? "").trim();
        if (text.length > longest.words.length) longest = { words: text, lines: new Set(lines(words).map((r) => Math.round(r.top))).size };
      }
      const wide = [el, ...Array.from(el.querySelectorAll("*"))].filter((e) => e.clientWidth > 1 && e.scrollWidth > e.clientWidth + 1).map((e) => `${e.tagName} ${e.scrollWidth} > ${e.clientWidth}`);
      return { rows, covered, longest, wide };
    });
    assert.ok(layout.rows >= 20, `only ${layout.rows} rows with Change`);
    assert.deepEqual(layout.covered, [], "a button over a row's words at 390 px and 130%");
    assert.ok(layout.longest.lines >= 2, `the longest row, "${layout.longest.words}", is on ${layout.longest.lines} line beside its Change`);
    assert.deepEqual(layout.wide, [], "content wider than its box at 390 px and 130%");
    await shots.take(dm, "gs-a-dm-390-130-top");
    await sheet.getByText(layout.longest.words, { exact: true }).scrollIntoViewIfNeeded();
    await shots.take(dm, "gs-a-dm-390-130-longest");

    await sheet.locator("footer").getByRole("button", { name: "Reset all keys", exact: true }).click();
    await sheet.locator("footer").getByRole("button", { name: "Tap again to reset all keys", exact: true }).click();
    await sheet.getByRole("button", { name: "Reset the key for Draw", exact: true }).waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await dm.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", "1"));
    await dm.setViewportSize({ width: 1280, height: 800 });
    await reopenRoom(dm);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("4. neither page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's console");
    assert.deepEqual(playerConsole.errors, [], "the player's console");
  });
});
