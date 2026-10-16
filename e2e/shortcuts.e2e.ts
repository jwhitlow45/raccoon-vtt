import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The shortcut sheet (docs/design-v1-dm-tools.md 3.14): on a desktop it
 * shows the keys and what the mouse does, on a phone the keys and what
 * touch does, each for the viewer's role. The DM opens it with `?` on a
 * computer, and a player from Menu, This device, on a phone.
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

/** What the sheet's rows in one section say you do: the text of each row's heading cell. */
function inputs(section: Locator): Promise<string[]> {
  return section.locator("th").allTextContents();
}

/** The sheet's section headings, in order. */
function headings(sheet: Locator): Promise<string[]> {
  return sheet.locator("section h3").allTextContents();
}

describe("raccoon-vtt shortcut sheet on a desktop and a phone", { timeout: 120_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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

  test("2. on a computer, ? shows the DM's keys and what the mouse does, and nothing for touch", async () => {
    await dm.keyboard.press("?");
    const sheet = dm.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    const titles = await headings(sheet);
    assert.deepEqual(titles.slice(0, 2), ["Keys", "Mouse"], titles.join(", "));
    assert.ok(!titles.includes("Touch"), titles.join(", "));
    for (const surface of ["Side panel tabs", "Handout viewer", "Token action bar", "Initiative", "Label, pin and light panes", "Windows"]) {
      assert.ok(titles.includes(surface), `${surface} in ${titles.join(", ")}`);
    }

    const keys = await inputs(sheet.getByRole("region", { name: "Keys" }));
    for (const k of ["Ctrl+Z", "T", "H", "/", "?", "Escape"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
    const mouse = await inputs(sheet.getByRole("region", { name: "Mouse" }));
    for (const m of ["Shift or Ctrl+click a token (Cmd on a Mac)", "Shift or Ctrl+drag on empty map (Cmd on a Mac)", "Space+drag", "Click a map label", "Drag a corner of the box"]) {
      assert.ok(mouse.includes(m), `${m} in the DM's Mouse`);
    }
    assert.ok(!mouse.includes("Tap a token"), "a mouse clicks");
    const initiative = await inputs(sheet.getByRole("region", { name: "Initiative" }));
    assert.ok(initiative.includes("Drag a row's grip"), "the DM reorders ties");
    await shots.take(dm, "shortcuts-dm-computer");
    await sheet.evaluate((el) => el.querySelector("section:nth-of-type(2)")?.scrollIntoView());
    await shots.take(dm, "shortcuts-dm-computer-mouse");
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("3. on a phone, Menu, This device shows a player's keys and what touch does, and nothing for the mouse or the DM", async () => {
    await player.locator('button[title="Panels"]').click();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    await player.getByRole("button", { name: /^This device/ }).click();
    await player.getByRole("button", { name: "Show the shortcuts" }).click();
    const sheet = player.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    const titles = await headings(sheet);
    assert.deepEqual(titles.slice(0, 2), ["Keys", "Touch"], titles.join(", "));
    assert.ok(!titles.includes("Mouse"), titles.join(", "));
    assert.ok(!titles.includes("Label, pin and light panes"), "the panes are the DM's");
    assert.ok(!titles.includes("Toolbar"), "the toolbar's only row is the wheel's");

    const keys = await inputs(sheet.getByRole("region", { name: "Keys" }));
    for (const k of ["Ctrl+Z", "V", "N", "Escape"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
    for (const k of ["T", "H", "/"]) assert.ok(!keys.includes(k), `the DM's ${k} is not a player's`);
    const touch = await inputs(sheet.getByRole("region", { name: "Touch" }));
    for (const t of ["Tap a token", "Pinch", "Drag with two fingers", "Double tap the map", "Android's Back button"]) assert.ok(touch.includes(t), `${t} in the player's Touch`);
    for (const t of ["Tap a map label", "Drag a corner of the box", "Click a token"]) assert.ok(!touch.includes(t), `${t} is not in the player's Touch`);
    assert.deepEqual(await inputs(sheet.getByRole("region", { name: "Initiative" })), ["Enter", "Escape"], "only the DM reorders ties");
    const viewer = await inputs(sheet.getByRole("region", { name: "Handout viewer" }));
    assert.ok(viewer.includes("Pinch") && viewer.includes("Double tap") && !viewer.includes("Wheel"), viewer.join(", "));
    await shots.take(player, "shortcuts-player-phone");
    await sheet.evaluate((el) => el.querySelector("section:nth-of-type(2)")?.scrollIntoView());
    await shots.take(player, "shortcuts-player-phone-touch");
    await player.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("4. neither page logged an error", () => {
    assert.deepEqual(dmConsole.errors, [], "the DM's console");
    assert.deepEqual(playerConsole.errors, [], "the player's console");
  });
});
