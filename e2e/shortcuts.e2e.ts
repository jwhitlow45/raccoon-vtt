import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, openSideTab, pagePoint, pickOption, pickTool, pressOption, reopenRoom, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The shortcut sheet (docs/design-v1-dm-tools.md 3.14): the keys, then on
 * a desktop what a key or another mouse button does with a click, a drag
 * or the wheel, on every device the drags of attached tokens, and on an
 * Android phone its Back button, each for the viewer's role. The DM opens it with `?` on a computer, and a player from
 * Menu, This device, on a phone. Full screen (lib/fullscreen.ts) rides
 * along: the top bar's button, its key and its Menu switch on a computer,
 * and the switch alone on a phone. On the computer, the DM moves Fog's
 * key from the sheet, swaps it with Ruler's and resets them all
 * (state/keyBindings.ts). In a 390 px window at 130%, Change and Reset
 * keep clear of every row's words. Then a second press of a tool's key
 * moves through its main choice (docs/design-v1-tool-cycle.md 8), on the
 * computer and on the phone with a keyboard.
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
    cycle.ops?.close();
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
    assert.deepEqual(titles.slice(0, 3), ["Keys", "Mouse with keys", "Mouse and touch"], titles.join(", "));
    assert.ok(!titles.includes("Android"), titles.join(", "));
    for (const surface of ["Side panel tabs", "Handout viewer", "Token window", "Initiative", "Roll requests", "Token and character fields", "Label, pin and light panes", "Dialogs", "Adding an image"]) {
      assert.ok(titles.includes(surface), `${surface} in ${titles.join(", ")}`);
    }
    // Request a roll's fields send it (docs/design-v1-roll-request.md 8).
    assert.deepEqual(await inputs(sheet, "Roll requests"), ["Enter"]);
    assert.equal(await sheet.getByRole("region").count(), 0, "headings, not landmarks");

    const keys = await inputs(sheet, "Keys");
    for (const k of ["Ctrl+Z", "T", "H", "/", "?", "Escape", "Ctrl+V (Cmd+V on a Mac)"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
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
    // A phone drags with a finger, so the drags of attached tokens show there too (docs/design-v1-attach.md 4.6).
    assert.deepEqual(titles.slice(0, 3), ["Keys", "Mouse and touch", "Android"], titles.join(", "));
    assert.ok(!titles.includes("Mouse with keys"), titles.join(", "));
    assert.ok(!titles.includes("Label, pin and light panes"), "the panes are the DM's");
    // A player's roll card: Enter sends a typed total, or rolls from the Bonus or Extra dice field (docs/design-v1-roll-request.md 8).
    assert.deepEqual(await inputs(sheet, "Roll requests"), ["Enter", "Enter"]);

    const keys = await inputs(sheet, "Keys");
    for (const k of ["Ctrl+Z", "V", "N", "Escape"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
    for (const k of ["T", "H", "/", "Ctrl+V (Cmd+V on a Mac)"]) assert.ok(!keys.includes(k), `the DM's ${k} is not a player's`);
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
    const paste = sheet.getByRole("heading", { name: "Adding an image", exact: true });
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

  // ------------------------------------------------ the tool cycle (docs/design-v1-tool-cycle.md 8)

  /** The tool's own options row, by its tool's name. */
  const optionsOf = (page: Page, tool: string) => page.getByRole("toolbar", { name: `${tool} options` });
  const toolButton = (page: Page, name: string) => page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name, exact: true });
  const voice = (page: Page) => page.locator("[data-rvtt-tool-status]");
  const said = async (page: Page) => ((await voice(page).textContent()) ?? "").trim();
  /** Marks what the status holds now, so `saidNothing` can tell that no press since said anything, even words that repeat. */
  const markSaid = (page: Page) => voice(page).locator("span").evaluate((el) => el.setAttribute("data-old", ""));
  const saidNothing = async (page: Page) => (await voice(page).locator("span[data-old]").count()) === 1;
  const saidNow = async (page: Page, words: string) => waitFor(`the status to say "${words}"`, async () => ((await voice(page).locator("span:not([data-old])").count()) === 1 && (await said(page)) === words ? true : null));
  /** A key with focus off any field, so it reaches the room. */
  const keyOn = async (page: Page, key: string) => {
    await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  };
  const chipShows = (page: Page, tool: string, group: string, value: string) =>
    waitFor(`${tool}'s ${group} to show ${value}`, async () => ((await optionsOf(page, tool).getByRole("button", { name: new RegExp(`^${group}: ${value}( |$)`) }).count()) > 0 ? true : null));
  const checked = (page: Page, tool: string, option: string) =>
    waitFor(`${tool}'s ${option} to be checked`, async () => ((await optionsOf(page, tool).getByRole("radio", { name: option, exact: true }).first().isChecked()) ? true : null));
  const cycle = { sceneId: "", bounds: { w: 0, h: 0 }, ops: null as OpSocket | null };
  const clickCell = async (page: Page, cell: { x: number; y: number }) => {
    const p = await pagePoint(page, cycle.bounds, { x: cell.x + 0.5, y: cell.y + 0.5 });
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(150);
  };
  /** The newest `aoe` frame the player's page received: an area preview the DM shares. */
  const lastAoe = () => {
    for (let i = playerSocket.received.length - 1; i >= 0; i--) {
      const frame = JSON.parse(playerSocket.received[i]!) as { t?: string; e?: { k?: string; shape?: string; size?: number; origin?: { x: number; y: number } } };
      if (frame.e?.k === "aoe") return frame.e;
    }
    return null;
  };

  test("tc-a. on a computer, A with another tool picks Area as it was, and again moves its shape: on, back with Shift, once while held, shown from a tuck, a plain area at its own size and point, Fireball held, and a trap's area saved with its new shape", async () => {
    cycle.sceneId = dmSocket.state!.meta.playerSceneId!;
    cycle.bounds = dmSocket.state!.scenes[cycle.sceneId]!.bounds;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    cycle.ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await keyOn(dm, "r");
    await markSaid(dm);
    await keyOn(dm, "a");
    await chipShows(dm, "Area", "Shape", "Cone");
    assert.ok(await saidNothing(dm), "picking the tool says nothing");

    await keyOn(dm, "a");
    await chipShows(dm, "Area", "Shape", "Sphere");
    await saidNow(dm, "Area: Sphere");
    await shots.take(dm, "tc-a-dm-sphere");
    await keyOn(dm, "Shift+A");
    await chipShows(dm, "Area", "Shape", "Cone");
    await keyOn(dm, "Shift+A");
    await chipShows(dm, "Area", "Shape", "Emanation");
    await saidNow(dm, "Area: Emanation");

    // Held down, a key moves once: its repeats do nothing.
    await dm.keyboard.down("a");
    await dm.keyboard.down("a");
    await dm.keyboard.down("a");
    await dm.keyboard.up("a");
    await dm.waitForTimeout(150);
    await chipShows(dm, "Area", "Shape", "Cone");

    // Tucked by a tap, A shows the row and moves in one press.
    await toolButton(dm, "Area").click();
    await waitFor("Area's options tucked", async () => ((await dm.locator('[role="toolbar"][data-rvtt-arrangement]').getAttribute("data-rvtt-tucked")) === "" ? true : null));
    await keyOn(dm, "a");
    await waitFor("Area's options shown", async () => ((await dm.locator('[role="toolbar"][data-rvtt-arrangement]').getAttribute("data-rvtt-tucked")) === null ? true : null));
    await chipShows(dm, "Area", "Shape", "Sphere");

    // A plain area being placed takes the next shape at that shape's own size, at the same point, and players see it change.
    await keyOn(dm, "Shift+A");
    await chipShows(dm, "Area", "Shape", "Cone");
    await clickCell(dm, { x: 10, y: 8 });
    await optionsOf(dm, "Area").getByRole("button", { name: "Place", exact: true }).waitFor();
    await pressOption(dm, "Area", "Shared");
    const cone = await waitFor("the shared cone", () => (lastAoe()?.shape === "cone" ? lastAoe() : null));
    await keyOn(dm, "a");
    const sphere = await waitFor("the shared sphere", () => (lastAoe()?.shape === "sphere" ? lastAoe() : null));
    assert.equal(sphere.size, 20, "a sphere's own size");
    assert.deepEqual([sphere.origin?.x, sphere.origin?.y], [cone.origin?.x, cone.origin?.y], "at the same point");
    await optionsOf(dm, "Area").getByText("20 ft Sphere").first().waitFor();
    await optionsOf(dm, "Area").getByRole("button", { name: "Cancel", exact: true }).click();
    await optionsOf(dm, "Area").getByRole("button", { name: "Place", exact: true }).waitFor({ state: "detached" });

    // Fireball's area, tucked: A shows the row, keeps the spell and says why.
    const spell = optionsOf(dm, "Area").locator("[data-options-row]").getByRole("combobox", { name: "Spell" });
    await spell.fill("Fireball");
    await spell.press("Enter");
    await optionsOf(dm, "Area").getByRole("button", { name: "Cancel", exact: true }).waitFor();
    await toolButton(dm, "Area").click();
    await markSaid(dm);
    await keyOn(dm, "a");
    await saidNow(dm, "The spell sets the shape. Cancel to pick another.");
    await chipShows(dm, "Area", "Shape", "Sphere");
    assert.equal(await dm.locator('[role="toolbar"][data-rvtt-arrangement]').getAttribute("data-rvtt-tucked"), null, "the row shows");
    // Placed, its line names the spell it kept.
    await clickCell(dm, { x: 14, y: 8 });
    await optionsOf(dm, "Area").getByText("Fireball").first().waitFor();
    await shots.take(dm, "tc-a-dm-fireball-held");
    await optionsOf(dm, "Area").getByRole("button", { name: "Cancel", exact: true }).click();

    // A trap's area takes the next shape, and Save still puts it into the trap.
    const trapId = randomUUID();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    await cycle.ops.send({ t: "trap.create", trap: { id: trapId, sceneId: cycle.sceneId, name: "Cycle Pit", zone: { cells: [{ x: 4, y: 4, w: 1, h: 1 }] }, rig } });
    await waitFor("the trap in the DM's view", () => dmSocket.state?.traps[trapId]);
    await pickTool(dm, "Trap");
    await clickCell(dm, { x: 4, y: 4 });
    const pane = dm.getByRole("dialog", { name: "Edit trap" });
    await pane.waitFor();
    const fold = pane.getByRole("button", { name: "Hits", exact: true });
    if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
    await pane.getByRole("radiogroup", { name: "Hits" }).getByRole("radio", { name: "Everyone in an area" }).click();
    await pane.getByRole("button", { name: "Place the area", exact: true }).click();
    await optionsOf(dm, "Area").waitFor();
    await clickCell(dm, { x: 12, y: 6 });
    const before = (await optionsOf(dm, "Area").getByRole("button", { name: /^Shape: / }).first().getAttribute("aria-label")) ?? "";
    await keyOn(dm, "a");
    await waitFor("the trap's area on its next shape", async () => (((await optionsOf(dm, "Area").getByRole("button", { name: /^Shape: / }).first().getAttribute("aria-label")) ?? before) !== before ? true : null));
    const shapeNow = /^Shape: (\w+)/.exec((await optionsOf(dm, "Area").getByRole("button", { name: /^Shape: / }).first().getAttribute("aria-label")) ?? "")?.[1]?.toLowerCase();
    await optionsOf(dm, "Area").getByRole("button", { name: "Save to trap", exact: true }).click();
    await waitFor("the trap hits the area of the new shape", () => {
      const hits = dmSocket.state?.traps[trapId]?.rig?.hits as { area?: { shape?: string } } | string | undefined;
      return typeof hits === "object" && hits.area?.shape === shapeNow ? true : null;
    });
    await pane.waitFor();
    await pane.getByRole("button", { name: "Done", exact: true }).click();
    await pane.waitFor({ state: "detached" });
    await keyOn(dm, "v");
  });

  test("tc-b. on a computer, D moves Draw's drawing tool through Eraser and back to Pen, holds a shape with corners and text waiting, leaves a stroke being drawn as it is, and A types into the spell field", async () => {
    await keyOn(dm, "d");
    await chipShows(dm, "Draw", "Drawing tool", "Pen");
    for (const mode of ["Line", "Arrow", "Box", "Circle", "Shape", "Text", "Eraser", "Pen"]) {
      await keyOn(dm, "d");
      await chipShows(dm, "Draw", "Drawing tool", mode);
      await saidNow(dm, `Draw: ${mode}`);
    }

    // A shape with two corners holds, and so does text waiting for its words, with focus on its Cancel.
    for (let i = 0; i < 5; i++) await keyOn(dm, "d");
    await chipShows(dm, "Draw", "Drawing tool", "Shape");
    await clickCell(dm, { x: 6, y: 6 });
    await clickCell(dm, { x: 9, y: 6 });
    await optionsOf(dm, "Draw").getByRole("button", { name: "Finish", exact: true }).waitFor();
    await markSaid(dm);
    await keyOn(dm, "d");
    await saidNow(dm, "Finish or cancel the shape first.");
    await chipShows(dm, "Draw", "Drawing tool", "Shape");
    await optionsOf(dm, "Draw").getByRole("button", { name: "Undo corner", exact: true }).waitFor();
    await shots.take(dm, "tc-b-dm-shape-held");
    await optionsOf(dm, "Draw").getByRole("button", { name: "Cancel", exact: true }).click();
    await keyOn(dm, "d");
    await chipShows(dm, "Draw", "Drawing tool", "Text");
    await clickCell(dm, { x: 7, y: 9 });
    const text = optionsOf(dm, "Draw").getByRole("textbox", { name: "Text" });
    await text.waitFor();
    await text.fill("Here be");
    const cancel = optionsOf(dm, "Draw").getByRole("button", { name: "Cancel", exact: true });
    await cancel.focus();
    await markSaid(dm);
    await dm.keyboard.press("d");
    await saidNow(dm, "Add or cancel the text first.");
    assert.equal(await text.inputValue(), "Here be", "the text kept");
    await chipShows(dm, "Draw", "Drawing tool", "Text");
    await cancel.click();

    // During a mouse drag, D moves nothing: the stroke goes on as Pen.
    await keyOn(dm, "d");
    await keyOn(dm, "d");
    await chipShows(dm, "Draw", "Drawing tool", "Pen");
    const strokes = () => Object.values(dmSocket.state?.drawings ?? {}).filter((d) => d?.kind === "free").length;
    const had = strokes();
    const a = await pagePoint(dm, cycle.bounds, { x: 14.5, y: 4.5 });
    const b = await pagePoint(dm, cycle.bounds, { x: 18.5, y: 7.5 });
    await markSaid(dm);
    await dm.mouse.move(a.x, a.y);
    await dm.mouse.down();
    await dm.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
    await dm.keyboard.press("d");
    await dm.mouse.move(b.x, b.y, { steps: 5 });
    await dm.mouse.up();
    await waitFor("the stroke drawn as Pen", () => (strokes() > had ? true : null));
    await chipShows(dm, "Draw", "Drawing tool", "Pen");
    assert.ok(await saidNothing(dm), "a press during a drag says nothing");

    // A typed in the spell field is a letter of the spell.
    await keyOn(dm, "a");
    const shapeBefore = await optionsOf(dm, "Area").getByRole("button", { name: /^Shape: / }).first().getAttribute("aria-label");
    const spell = optionsOf(dm, "Area").locator("[data-options-row]").getByRole("combobox", { name: "Spell" });
    await spell.click();
    await dm.keyboard.press("a");
    assert.equal(await spell.inputValue(), "a");
    assert.equal(await optionsOf(dm, "Area").getByRole("button", { name: /^Shape: / }).first().getAttribute("aria-label"), shapeBefore);
    await spell.fill("");
    await keyOn(dm, "v");
  });

  test("tc-c. on a computer, F moves Fog's Clear or add fog and keeps a polygon's corners and the line, R moves the Ruler's Measure and a reload keeps it, T moves Add token's blank kind and leaves three goblins waiting, and V, P, M and G only show their options", async () => {
    await cycle.ops!.send({ t: "scene.update", sceneId: cycle.sceneId, patch: { fogEnabled: true } });
    await waitFor("fog on", () => (dmSocket.state?.scenes[cycle.sceneId]?.fogEnabled ? true : null));
    await keyOn(dm, "f");
    await checked(dm, "Fog", "Clear fog");
    await pickOption(dm, "Fog", "Shape", "Polygon");
    await clickCell(dm, { x: 3, y: 3 });
    await clickCell(dm, { x: 6, y: 3 });
    const line = async () => ((await optionsOf(dm, "Fog").locator("[data-options-line]").first().textContent()) ?? "").trim();
    const lineBefore = await line();
    await keyOn(dm, "f");
    await checked(dm, "Fog", "Add fog");
    await saidNow(dm, "Fog: Add fog");
    assert.equal(await line(), lineBefore, "the line as it was");
    await keyOn(dm, "f");
    await checked(dm, "Fog", "Clear fog");
    assert.equal(await optionsOf(dm, "Fog").getByRole("button", { name: "Undo corner", exact: true }).isEnabled(), true, "the corners kept");
    await optionsOf(dm, "Fog").getByRole("button", { name: "Undo corner", exact: true }).click();
    await optionsOf(dm, "Fog").getByRole("button", { name: "Undo corner", exact: true }).click();
    await pickOption(dm, "Fog", "Shape", "Rectangle");

    // R, R: Walking, kept on this device through a reload, then Straight again.
    await keyOn(dm, "r");
    await keyOn(dm, "r");
    await saidNow(dm, "Ruler: Walking");
    assert.equal(await dm.evaluate(() => localStorage.getItem("rvtt.ruler.measure")), "walking");
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await keyOn(dm, "v");
    await keyOn(dm, "r");
    await checked(dm, "Ruler", "Walking");
    await keyOn(dm, "r");
    await checked(dm, "Ruler", "Straight");

    // T, T: Blank NPC. With three goblins waiting, T leaves them waiting.
    await keyOn(dm, "t");
    await chipShows(dm, "Add token", "Blank token kind", "Blank monster");
    await keyOn(dm, "t");
    await chipShows(dm, "Add token", "Blank token kind", "Blank NPC");
    await saidNow(dm, "Add token: Blank NPC");
    await openSideTab(dm, "Monsters");
    await dm.getByRole("tabpanel").getByRole("searchbox", { name: "Search monsters" }).fill("goblin");
    await dm.getByRole("tabpanel").getByRole("button", { name: /^Goblin/ }).first().click();
    for (let i = 0; i < 2; i++) await dm.getByRole("tabpanel").getByRole("button", { name: "How many plus 1", exact: true }).click();
    await dm.getByRole("tabpanel").getByRole("button", { name: "Place 3 on the map", exact: true }).click();
    const waiting = optionsOf(dm, "Add token").getByText(/Tap the map to place 3 × Goblin/);
    await waiting.first().waitFor();
    await markSaid(dm);
    await keyOn(dm, "t");
    await waiting.first().waitFor();
    assert.ok(await saidNothing(dm), "nothing said with goblins waiting");
    await optionsOf(dm, "Add token").getByRole("button", { name: "Cancel", exact: true }).click();

    // V, P, M and G have no main choice: pressed again they only show their tucked options.
    for (const [key, name] of [["v", "Select"], ["p", "Ping"], ["m", "Pin"], ["g", "Line up grid"]] as const) {
      await keyOn(dm, key);
      if (key === "v") await optionsOf(dm, "Select").waitFor({ state: "detached" }).catch(() => undefined);
      else {
        await toolButton(dm, name).click();
        await waitFor(`${name}'s options tucked`, async () => ((await dm.locator('[role="toolbar"][data-rvtt-arrangement]').getAttribute("data-rvtt-tucked")) === "" ? true : null));
      }
      await markSaid(dm);
      await keyOn(dm, key);
      if (key !== "v") await waitFor(`${name}'s options shown`, async () => ((await dm.locator('[role="toolbar"][data-rvtt-arrangement]').getAttribute("data-rvtt-tucked")) === null ? true : null));
      assert.ok(await saidNothing(dm), `${name}: nothing said`);
    }
    await keyOn(dm, "v");
  });

  test("tc-c2. on the player's phone with a keyboard, R moves the Ruler's Measure to Walking and says so, and with a panel's sheet over the options A moves Area's shape, says so, and the row shows it once the sheet closes (TC-ASTRA-04)", async () => {
    await keyOn(player, "v");
    await keyOn(player, "r");
    // Test 3 left Menu's sheet open over the options.
    for (let i = 0; i < 3 && (await player.locator('[role="toolbar"][data-rvtt-arrangement]').count()) === 0; i++) await keyOn(player, "Escape");
    await optionsOf(player, "Ruler").waitFor();
    await markSaid(player);
    await keyOn(player, "r");
    await saidNow(player, "Ruler: Walking");
    assert.equal(await player.evaluate(() => localStorage.getItem("rvtt.ruler.measure")), "walking");
    await keyOn(player, "r");
    await saidNow(player, "Ruler: Straight");

    await keyOn(player, "a");
    await chipShows(player, "Area", "Shape", "Cone");
    await player.locator('button[title="Panels"]').click();
    await waitFor("a panel's sheet over the options", async () => ((await player.locator('[role="toolbar"][data-rvtt-arrangement]').count()) === 0 ? true : null));
    assert.equal(await player.locator('[aria-modal="true"]').count(), 0, "the sheet is not modal");
    await markSaid(player);
    await keyOn(player, "a");
    await saidNow(player, "Area: Sphere");
    await shots.take(player, "tc-c2-player-sheet-area-sphere");
    await keyOn(player, "Escape");
    await chipShows(player, "Area", "Shape", "Sphere");
    await keyOn(player, "v");
  });

  test("tc-d. on a computer, D with Draw's Stroke pop-up open closes it and moves to Line, Area moved to K moves with K and not A, and the sheet's Toolbar row says what the key does", async () => {
    await keyOn(dm, "d");
    await chipShows(dm, "Draw", "Drawing tool", "Pen");
    await optionsOf(dm, "Draw").getByRole("button", { name: /^Stroke: / }).click();
    const stroke = dm.getByRole("dialog", { name: "Stroke" });
    await stroke.waitFor();
    await stroke.getByRole("radio", { name: "Thick", exact: true }).focus();
    await dm.keyboard.press("d");
    await stroke.waitFor({ state: "detached" });
    await chipShows(dm, "Draw", "Drawing tool", "Line");
    await keyOn(dm, "Shift+D");
    await chipShows(dm, "Draw", "Drawing tool", "Pen");

    await dm.keyboard.press("?");
    let sheet = dm.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    const row = sheet.getByRole("heading", { name: "Toolbar", exact: true }).locator("xpath=ancestor::section[1]").locator("tr", { hasText: "The tool's key" });
    const words = ((await row.locator("td").first().textContent()) ?? "").trim();
    assert.ok(words.startsWith("Show its hidden options and go to its next main choice, such as Area's next shape. With Shift on a letter key, the one before. It never hides them"), words);
    await sheet.getByRole("button", { name: "Change the key for Area", exact: true }).click();
    await dm.keyboard.press("k");
    await sheet.getByRole("button", { name: "Reset the key for Area", exact: true }).waitFor();
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await keyOn(dm, "k");
    await chipShows(dm, "Area", "Shape", "Cone");
    await keyOn(dm, "k");
    await chipShows(dm, "Area", "Shape", "Sphere");
    await saidNow(dm, "Area: Sphere");
    await markSaid(dm);
    await keyOn(dm, "a");
    await chipShows(dm, "Area", "Shape", "Sphere");
    assert.ok(await saidNothing(dm), "A does nothing");
    await keyOn(dm, "Shift+K");
    await chipShows(dm, "Area", "Shape", "Cone");
    await dm.keyboard.press("?");
    sheet = dm.getByRole("dialog", { name: "Shortcuts" });
    await sheet.getByRole("button", { name: "Reset the key for Area", exact: true }).click();
    await sheet.getByRole("button", { name: "Reset the key for Area", exact: true }).waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await keyOn(dm, "v");
  });

  test("tc-e. on a computer, F while Fog's options still load moves the choice, and the row arrives showing Add fog", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await dm.route("**/assets/Options-*.js", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (body.includes("Clear or add fog")) await held;
      await route.fulfill({ response, body });
    });
    try {
      await reopenRoom(dm);
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      await keyOn(dm, "v");
      await keyOn(dm, "f");
      await dm.getByText("Loading the options…").first().waitFor();
      await keyOn(dm, "f");
      await saidNow(dm, "Fog: Add fog");
      release();
      await checked(dm, "Fog", "Add fog");
      await keyOn(dm, "f");
      await checked(dm, "Fog", "Clear fog");
    } finally {
      release();
      await dm.unroute("**/assets/Options-*.js");
    }
    await keyOn(dm, "v");
  });

  test("tc-f. on a computer, B moves the builder's mode through all eleven and back to Brush, Shift+B goes to Stamp, focus on Terrain goes to the row's neighbor, and a shape room with corners and an open label pane hold", async () => {
    await keyOn(dm, "b");
    await chipShows(dm, "Map builder", "Builder mode", "Brush");
    for (const mode of ["Rectangle room", "Shape room", "Erase", "Erase area", "Walls and doors", "Heights and stairs", "Difficult ground", "Label", "Lights", "Stamp", "Brush"]) {
      await keyOn(dm, "b");
      await chipShows(dm, "Map builder", "Builder mode", mode);
      await saidNow(dm, `Map builder: ${mode}`);
    }
    await keyOn(dm, "Shift+B");
    await chipShows(dm, "Map builder", "Builder mode", "Stamp");
    await keyOn(dm, "b");
    await chipShows(dm, "Map builder", "Builder mode", "Brush");

    // Shape room to Erase with Terrain focused: Erase has no Terrain, so focus goes to the row's neighbor, never the page.
    await keyOn(dm, "b");
    await keyOn(dm, "b");
    await chipShows(dm, "Map builder", "Builder mode", "Shape room");
    await optionsOf(dm, "Map builder").getByRole("button", { name: /^Terrain: / }).focus();
    await dm.keyboard.press("b");
    await chipShows(dm, "Map builder", "Builder mode", "Erase");
    const focus = await dm.evaluate(() => {
      const doc = (globalThis as unknown as { document: { activeElement: { tagName: string; closest(s: string): unknown } | null; body: unknown } }).document;
      const el = doc.activeElement;
      return { body: el === doc.body || el === null, inRow: el?.closest('[role="toolbar"][data-rvtt-arrangement]') != null };
    });
    assert.deepEqual(focus, { body: false, inRow: true }, "focus on the row's neighbor");

    // A shape room with two corners holds.
    await keyOn(dm, "Shift+B");
    await chipShows(dm, "Map builder", "Builder mode", "Shape room");
    await clickCell(dm, { x: 3, y: 10 });
    await clickCell(dm, { x: 6, y: 10 });
    await optionsOf(dm, "Map builder").getByRole("button", { name: "Cancel", exact: true }).waitFor();
    await markSaid(dm);
    await keyOn(dm, "b");
    await saidNow(dm, "Close or cancel the room first.");
    await chipShows(dm, "Map builder", "Builder mode", "Shape room");
    await optionsOf(dm, "Map builder").getByRole("button", { name: "Cancel", exact: true }).waitFor();
    await optionsOf(dm, "Map builder").getByRole("button", { name: "Cancel", exact: true }).click();

    // A label's pane open, focus on its size choice: the pane and its words stay.
    await pickOption(dm, "Map builder", "Builder mode", "Label");
    await optionsOf(dm, "Map builder").getByRole("textbox", { name: "Label text" }).fill("Crypt");
    await clickCell(dm, { x: 20, y: 10 });
    await waitFor("the label made", () => Object.values(dmSocket.state?.labels ?? {}).find((l) => l?.text === "Crypt"));
    await clickCell(dm, { x: 20, y: 10 });
    const pane = dm.getByRole("dialog", { name: "Edit label" });
    await pane.waitFor();
    await pane.getByLabel("Label text").fill("Crypt of bones");
    await pane.getByRole("radio").first().focus();
    await markSaid(dm);
    await dm.keyboard.press("b");
    await saidNow(dm, "Finish or close the label first.");
    await chipShows(dm, "Map builder", "Builder mode", "Label");
    assert.equal(await pane.getByLabel("Label text").inputValue(), "Crypt of bones", "the pane and its words kept");
    await shots.take(dm, "tc-f-dm-label-held");
    await pane.getByLabel("Label text").blur();
    await keyOn(dm, "Escape");
    await pane.waitFor({ state: "detached" });
    await pickOption(dm, "Map builder", "Builder mode", "Brush");
    await keyOn(dm, "v");
  });

  test("tc-x. on a computer, X twice from another tool goes to Trip wire with its hint, and X with a trap's pane open moves nothing and says nothing", async () => {
    await keyOn(dm, "v");
    await keyOn(dm, "x");
    await checked(dm, "Trap", "Squares");
    await keyOn(dm, "x");
    await checked(dm, "Trap", "Trip wire");
    await saidNow(dm, "Trap: Trip wire");
    await optionsOf(dm, "Trap").getByText("Drag from one end of the trip wire to the other.").first().waitFor();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", save: { ability: "dex", dc: 12, onPass: "half" }, damage: [{ formula: "1d4", type: "piercing" }], actions: [], find: [], notice: false };
    const trapId = randomUUID();
    await cycle.ops!.send({ t: "trap.create", trap: { id: trapId, sceneId: cycle.sceneId, name: "Cycle Snare", zone: { cells: [{ x: 22, y: 3, w: 1, h: 1 }] }, rig } });
    await waitFor("the snare in the DM's view", () => dmSocket.state?.traps[trapId]);
    await clickCell(dm, { x: 22, y: 3 });
    const pane = dm.getByRole("dialog", { name: "Edit trap" });
    await pane.waitFor();
    await markSaid(dm);
    await keyOn(dm, "x");
    assert.ok(await saidNothing(dm), "nothing said with the pane open");
    await pane.getByRole("button", { name: "Done", exact: true }).click();
    await pane.waitFor({ state: "detached" });
    await checked(dm, "Trap", "Trip wire");
    await keyOn(dm, "Shift+X");
    await checked(dm, "Trap", "Squares");
    await keyOn(dm, "v");
  });

  test("4. neither page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's console");
    assert.deepEqual(playerConsole.errors, [], "the player's console");
  });
});
