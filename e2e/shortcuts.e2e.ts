import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The shortcut sheet (docs/design-v1-dm-tools.md 3.14): the keys, then on
 * a desktop what a key or another mouse button does with a click, a drag
 * or the wheel, and on an Android phone its Back button, each for the
 * viewer's role. The DM opens it with `?` on a computer, and a player from
 * Menu, This device, on a phone.
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
    for (const surface of ["Side panel tabs", "Handout viewer", "Token action bar", "Initiative", "Token and character fields", "Label, pin and light panes", "Dialogs", "Choose an image"]) {
      assert.ok(titles.includes(surface), `${surface} in ${titles.join(", ")}`);
    }
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

    const keys = await inputs(sheet, "Keys");
    for (const k of ["Ctrl+Z", "V", "N", "Escape"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
    for (const k of ["T", "H", "/"]) assert.ok(!keys.includes(k), `the DM's ${k} is not a player's`);
    assert.deepEqual(await inputs(sheet, "Android"), ["Back button"]);
    assert.deepEqual(await inputs(sheet, "Initiative"), ["Enter", "Escape"], "only the DM types several values");
    assert.deepEqual(await inputs(sheet, "Handout viewer"), ["+, -", "0", "Arrow keys"]);
    await shots.take(player, "shortcuts-player-android");
    await sheet.getByRole("heading", { name: "Android", exact: true }).scrollIntoViewIfNeeded();
    await shots.take(player, "shortcuts-player-android-back");
    await player.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("3b. on a 320 px phone at 130%, the sheet scrolls only down: a key's note wraps under its keycap", async () => {
    await player.setViewportSize({ width: 320, height: 568 });
    await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
    await player.reload();
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
    await player.reload();
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
  });

  test("4. neither page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's console");
    assert.deepEqual(playerConsole.errors, [], "the player's console");
  });
});
