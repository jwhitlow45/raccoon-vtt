import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { ConsoleWatch, OpSocket, pagePoint, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * A DM at a computer with a keyboard, after the design pass's live play:
 *
 * - The side panel's tabs are one Tab stop. Left and Right on a focused
 *   tab switch tabs, Home and End go to the ends, and a selected token
 *   stays where it is.
 * - A dialog with a field that focuses itself (a new journal page's
 *   title, a pasted stat block) keeps that field focused, and closing it
 *   gives focus back to the button that opened it, not to the page.
 * - Closing the map import dialog gives focus back to its file picker,
 *   which was disabled while the dialog was open.
 * - A scene menu that moves to another step keeps focus in its dialog.
 * - The side panel's tab panel is named by its chosen tab.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus six, which it shares with
 * notes.e2e.ts, since the runs go one after another. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 6;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-desk-"));
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
  roomName: `E2E desk ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  bounds: { w: 0, h: 0 },
  goblin: { id: randomUUID(), x: 0, y: 0 },
};

/** What has focus: its tag, role and name. */
function focused(page: Page): Promise<{ tag: string; role: string | null; name: string }> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { activeElement: unknown } }).document;
    const el = doc.activeElement as {
      tagName: string;
      textContent: string | null;
      labels?: ArrayLike<{ textContent: string | null }> | null;
      getAttribute(name: string): string | null;
    } | null;
    if (!el) return { tag: "", role: null, name: "" };
    const name = el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent ?? el.textContent ?? "";
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name: name.trim() };
  });
}

function goblin() {
  const t = dmSocket.state?.tokens[run.goblin.id];
  return t ? { x: t.x, y: t.y, elevation: t.elevation ?? 0 } : null;
}

/** A Universal VTT file with a 10 by 8 square map, one room and a door, as the import dialog reads it. */
async function writeUvtt(file: string): Promise<void> {
  const image = await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 150, g: 140, b: 120 } } })
    .png()
    .toBuffer();
  const content = {
    format: 0.3,
    resolution: { map_origin: { x: 0, y: 0 }, map_size: { x: 10, y: 8 }, pixels_per_grid: 50 },
    line_of_sight: [
      [
        { x: 1, y: 1 },
        { x: 9, y: 1 },
        { x: 9, y: 7 },
        { x: 1, y: 7 },
        { x: 1, y: 1 },
      ],
    ],
    objects_line_of_sight: [],
    portals: [{ position: { x: 4.5, y: 1 }, bounds: [{ x: 4, y: 1 }, { x: 5, y: 1 }], rotation: 0, closed: true, freestanding: false }],
    environment: { baked_lighting: true, ambient_light: "ffffffff" },
    lights: [],
    image: image.toString("base64"),
  };
  writeFileSync(file, JSON.stringify(content));
}

describe("raccoon-vtt: keys and focus for a DM at a computer", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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

  test("1. a DM's room with a goblin", async () => {
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
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    run.bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.goblin = { ...run.goblin, x: Math.floor(run.bounds.w / 2), y: Math.floor(run.bounds.h / 2) };
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({
      t: "token.create",
      token: { id: run.goblin.id, sceneId: run.sceneId, size: "medium", visibility: "all", kind: "monster", name: "Goblin", x: run.goblin.x, y: run.goblin.y, disposition: "hostile", actor: { inline: actor } },
    });
    await waitFor("the goblin in the DM's view", () => goblin());
  });

  test("2. Left and Right on a focused panel tab switch tabs, Home and End go to the ends, and a selected token stays put", async () => {
    const p = await pagePoint(dm, run.bounds, { x: run.goblin.x + 0.5, y: run.goblin.y + 0.5 });
    await dm.mouse.click(p.x, p.y);
    await dm.getByRole("dialog", { name: "Goblin actions" }).waitFor();
    const tabs = dm.getByRole("tablist", { name: "Panels" }).getByRole("tab");
    const names = (await tabs.allTextContents()).map((t) => t.trim());
    const log = names.findIndex((n) => n.startsWith("Log"));
    assert.ok(log > 0, `the tabs are ${names.join(", ")}`);
    const chosen = async () => {
      const f = await focused(dm);
      assert.equal(f.role, "tab", `focus left the tabs for ${JSON.stringify(f)}`);
      const selected = await tabs.evaluateAll((els) => els.map((el) => (el as unknown as { getAttribute(n: string): string | null }).getAttribute("aria-selected")));
      const stops = await tabs.evaluateAll((els) => els.filter((el) => (el as unknown as { tabIndex: number }).tabIndex === 0).length);
      assert.equal(stops, 1, "the row is one Tab stop");
      assert.equal(names[selected.indexOf("true")], f.name, "the focused tab is the chosen one");
      return f.name;
    };

    await tabs.nth(log).focus();
    await dm.keyboard.press("ArrowLeft");
    assert.equal(await chosen(), names[log - 1]);
    await dm.keyboard.press("ArrowRight");
    assert.equal(await chosen(), names[log]);
    await dm.keyboard.press("Home");
    assert.equal(await chosen(), names[0]);
    await dm.keyboard.press("ArrowLeft");
    assert.equal(await chosen(), names[names.length - 1], "Left from the first wraps to the last");
    await dm.keyboard.press("Home");
    await dm.keyboard.press("End");
    assert.equal(await chosen(), names[names.length - 1]);
    await dm.keyboard.press("PageDown");
    await dm.keyboard.press("ArrowUp");
    // Nothing comes back to wait for when nothing moves, so this gives a stray move time to reach the DM's view.
    await dm.waitForTimeout(500);
    assert.deepEqual(goblin(), { x: run.goblin.x, y: run.goblin.y, elevation: 0 }, "the goblin stayed where it was");
    await dm.keyboard.press("Escape");
  });

  test("3. a dialog keeps its own field focused and gives focus back to its opener on close", async () => {
    await dm.getByRole("tab", { name: "Journal", exact: true }).click();
    // The side panel's tab panel is named by its chosen tab.
    const newPage = dm.getByRole("tabpanel", { name: "Journal" }).getByRole("button", { name: "New page" });
    await newPage.focus();
    await dm.keyboard.press("Enter");
    await dm.getByRole("dialog", { name: "New page" }).waitFor();
    await waitFor("the title field focused", async () => (await focused(dm)).name === "Title");
    await dm.keyboard.press("Escape");
    await dm.getByRole("dialog", { name: "New page" }).waitFor({ state: "detached" });
    assert.deepEqual(await focused(dm), { tag: "button", role: null, name: "New page" }, "Escape gives focus back to New page");

    await dm.getByRole("tab", { name: "Monsters", exact: true }).click();
    const paste = dm.getByRole("tabpanel").getByRole("button", { name: "Paste a stat block" });
    await paste.focus();
    await dm.keyboard.press("Enter");
    const editor = dm.getByRole("dialog", { name: "New monster" });
    await editor.waitFor();
    await waitFor("the paste box focused", async () => (await focused(dm)).tag === "textarea");
    await shots.take(dm, "desk-paste-box-focused");
    await editor.getByRole("button", { name: "Cancel" }).click();
    await editor.waitFor({ state: "detached" });
    assert.deepEqual(await focused(dm), { tag: "button", role: null, name: "Paste a stat block" }, "Cancel gives focus back to Paste a stat block");
  });

  test("4. closing the map import dialog gives focus back to its file picker", async () => {
    const file = path.join(work, "Desk_keep.dd2vtt");
    await writeUvtt(file);
    await dm.getByRole("tab", { name: "Scenes", exact: true }).click();
    const picker = dm.getByRole("tabpanel").getByLabel("From a Universal VTT file");
    await picker.focus();
    await picker.setInputFiles(file);
    const dialog = dm.getByRole("dialog", { name: "Import a Universal VTT map" });
    await dialog.waitFor();
    await dialog.getByRole("textbox", { name: "Scene name" }).waitFor();
    await dm.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await waitFor("focus back on the file picker", async () => (await focused(dm)).name === "From a Universal VTT file", 2_000);
  });

  test("5. a scene menu's steps keep focus in the dialog, on the step it shows", async () => {
    const more = dm.getByRole("tabpanel").getByRole("button", { name: /^More for / });
    await more.focus();
    await dm.keyboard.press("Enter");
    const menu = dm.locator("dialog[open]");
    await menu.getByRole("button", { name: /^Duplicate/ }).focus();
    await dm.keyboard.press("Enter");
    await waitFor("the Duplicate step focused", async () => {
      const f = await focused(dm);
      return f.tag === "dialog" && f.name.startsWith("Duplicate ");
    });
    await menu.getByRole("button", { name: "Back to the menu" }).focus();
    await dm.keyboard.press("Enter");
    await waitFor("the menu focused again", async () => {
      const f = await focused(dm);
      return f.tag === "dialog" && !f.name.startsWith("Duplicate ");
    });
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.match((await focused(dm)).name, /^More for /, "Escape gives focus back to the scene's more button");
  });

  test("6. no page errors along the way", () => {
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
