import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, readCamera, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * A DM at a computer with a keyboard, after the design pass's live play:
 *
 * - The side panel's tabs are one Tab stop. Left and Right on a focused
 *   tab switch tabs and reach More without choosing, Home and End go to
 *   the ends, and a selected token stays where it is. A panel picked from
 *   More by keyboard while it shows a subpage, such as a journal page,
 *   leaves focus on More, so the next arrow still moves along the tabs.
 * - A dialog with a field that focuses itself (a new journal page's
 *   title, a pasted stat block) keeps that field focused, and closing it
 *   gives focus back to the button that opened it, not to the page.
 * - Closing the map import dialog gives focus back to its file picker,
 *   which was disabled while the dialog was open.
 * - A scene menu that moves to another step keeps focus in its dialog.
 * - The side panel's tab panel is named by its chosen tab.
 * - The question an editor asks before it throws away changes is an
 *   alert, read out as it appears.
 * - A part of a panel that opens in place, such as the X-card's card or
 *   Export as image, takes focus, and its Cancel gives it back to the
 *   button that opened it. The token bar's Details focuses the token's
 *   panel's tab, and a click on the panel's blank space leaves Space free
 *   to pan the map.
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

  test("2. Left and Right on a focused panel tab switch tabs and reach More without choosing, Home and End go to the ends, and a selected token stays put", async () => {
    const p = await pagePoint(dm, run.bounds, { x: run.goblin.x + 0.5, y: run.goblin.y + 0.5 });
    await dm.mouse.click(p.x, p.y);
    await dm.getByRole("dialog", { name: "Goblin actions" }).waitFor();
    const list = dm.getByRole("tablist", { name: "Panels" });
    const more = list.locator('[role="tab"][aria-haspopup="menu"]');
    const isFocused = (target: Locator) => target.evaluate((el) => el === el.ownerDocument.activeElement);
    const oneStop = async () => assert.equal(await list.locator('[role="tab"][tabindex="0"]').count(), 1, "the row is one Tab stop");
    // On a tab: focused and chosen. On More: focused, choosing nothing, the tab chosen before still chosen.
    const on = async (name: string) => {
      const tab = list.getByRole("tab", { name: sideTabName(name) });
      assert.ok(await isFocused(tab), `focus is on ${name}: ${JSON.stringify(await focused(dm))}`);
      assert.equal(await tab.getAttribute("aria-selected"), "true", `${name} is chosen`);
      await oneStop();
    };
    const onMore = async (chosen: string) => {
      assert.ok(await isFocused(more), `focus is on More: ${JSON.stringify(await focused(dm))}`);
      assert.equal(await more.getAttribute("aria-selected"), "false", "More chooses nothing");
      assert.equal(await list.getByRole("tab", { name: sideTabName(chosen) }).getAttribute("aria-selected"), "true", `${chosen} stays chosen`);
      assert.equal(await dm.getByRole("menu").count(), 0, "and opens nothing");
    };

    await list.getByRole("tab", { name: sideTabName("Log") }).focus();
    await dm.keyboard.press("ArrowLeft");
    await on("Initiative");
    await dm.keyboard.press("ArrowRight");
    await on("Log");
    await dm.keyboard.press("ArrowRight");
    await onMore("Log");
    await dm.keyboard.press("ArrowRight");
    await on("Token");
    await dm.keyboard.press("ArrowLeft");
    await onMore("Token");
    await dm.keyboard.press("Home");
    await on("Token");
    await dm.keyboard.press("End");
    await onMore("Token");
    await dm.keyboard.press("Home");
    await dm.keyboard.press("PageDown");
    await dm.keyboard.press("ArrowUp");
    // Nothing comes back to wait for when nothing moves, so this gives a stray move time to reach the DM's view.
    await dm.waitForTimeout(500);
    assert.deepEqual(goblin(), { x: run.goblin.x, y: run.goblin.y, elevation: 0 }, "the goblin stayed where it was");
    await dm.keyboard.press("Escape");
  });

  test("3. a dialog keeps its own field focused and gives focus back to its opener on close", async () => {
    await openSideTab(dm, "Journal");
    // The side panel's tab panel is named by its chosen tab.
    const newPage = dm.getByRole("tabpanel", { name: "Journal" }).getByRole("button", { name: "New page" });
    await newPage.focus();
    await dm.keyboard.press("Enter");
    await dm.getByRole("dialog", { name: "New page" }).waitFor();
    await waitFor("the title field focused", async () => (await focused(dm)).name === "Title");
    await dm.keyboard.press("Escape");
    await dm.getByRole("dialog", { name: "New page" }).waitFor({ state: "detached" });
    assert.deepEqual(await focused(dm), { tag: "button", role: null, name: "New page" }, "Escape gives focus back to New page");

    await openSideTab(dm, "Monsters");
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

  test("4. picking from More by keyboard a panel that shows a journal page keeps focus on More, and the selected token stays put", async () => {
    await ops.send({ t: "journal.create", page: { id: randomUUID(), title: "Lore", access: "all", blocks: [{ id: randomUUID().replace(/-/g, "").slice(0, 12), text: "The citadel fell." }] } });
    await openSideTab(dm, "Journal");
    await dm.getByRole("tabpanel", { name: sideTabName("Journal") }).getByRole("button", { name: /^Lore/ }).click();
    await dm.getByRole("heading", { name: "Lore" }).waitFor();
    assert.deepEqual(await focused(dm), { tag: "h2", role: null, name: "Lore" }, "a page opened from its row still takes focus to its title");
    const at = goblin();
    assert.ok(at);
    const p = await pagePoint(dm, run.bounds, { x: at.x + 0.5, y: at.y + 0.5 });
    await dm.mouse.click(p.x, p.y);
    await dm.getByRole("dialog", { name: "Goblin actions" }).waitFor();

    const list = dm.getByRole("tablist", { name: "Panels" });
    const more = list.locator('[role="tab"][aria-haspopup="menu"]');
    const isFocused = (target: Locator) => target.evaluate((el) => el === el.ownerDocument.activeElement);
    const log = list.getByRole("tab", { name: sideTabName("Log") });
    await log.click();
    await dm.keyboard.press("ArrowRight");
    assert.ok(await isFocused(more), "Right from Log reaches More");
    await dm.keyboard.press("Enter");
    const item = dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemradio", { name: sideTabName("Journal") });
    await waitFor("focus on Journal in More's list", async () => ((await isFocused(item)) ? true : null));
    await dm.keyboard.press("Enter");
    await dm.getByRole("heading", { name: "Lore" }).waitFor();
    assert.ok(await isFocused(more), `choosing Journal left focus on More, not on the page's title: ${JSON.stringify(await focused(dm))}`);
    assert.equal(await more.getAttribute("aria-selected"), "true");
    assert.ok(await list.getByRole("tab", { name: sideTabName("Journal"), selected: true }).isVisible(), "More is named by the Journal");
    await dm.keyboard.press("ArrowLeft");
    assert.ok(await isFocused(log), "the next arrow moved along the tabs");
    assert.equal(await log.getAttribute("aria-selected"), "true");
    // Nothing comes back to wait for when nothing moves, so this gives a stray move time to reach the DM's view.
    await dm.waitForTimeout(500);
    assert.deepEqual(goblin(), at, "the goblin stayed where it was");

    await dm.keyboard.press("Escape");
    await openSideTab(dm, "Journal");
    await dm.getByRole("button", { name: "Back to Journal" }).click();
    await dm.getByRole("tabpanel", { name: sideTabName("Journal") }).getByRole("button", { name: "New page" }).waitFor();
  });

  test("5. closing the map import dialog gives focus back to its file picker", async () => {
    const file = path.join(work, "Desk_keep.dd2vtt");
    await writeUvtt(file);
    await openSideTab(dm, "Scenes");
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

  test("6. a scene menu's steps keep focus in the dialog, on the step it shows", async () => {
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

  test("7. the monster editor's question before it throws away a paste is read out, so a second Escape never discards unheard (LPD-DESK-8)", async () => {
    await openSideTab(dm, "Monsters");
    await dm.getByRole("tabpanel").getByRole("button", { name: "Paste a stat block" }).click();
    const editor = dm.getByRole("dialog", { name: "New monster" });
    await editor.waitFor();
    await waitFor("the paste box focused", async () => (await focused(dm)).tag === "textarea");
    await dm.keyboard.type("Goblin");
    await dm.keyboard.press("Escape");
    await editor.getByRole("alert").filter({ hasText: "Throw away your changes?" }).waitFor();
    await dm.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });
  });

  test("8. a part that opens in place takes focus, and its Cancel gives focus back to its button (LPD-DESK-7)", async () => {
    const panel = dm.getByRole("tabpanel");
    const section = (heading: string) => panel.locator("section").filter({ has: dm.getByRole("heading", { name: heading, exact: true }) }).last();

    // Menu's X-card opens at its words, never at the X that sends it.
    await openSideTab(dm, "Menu");
    await panel.getByRole("button", { name: /^X-card/ }).focus();
    await dm.keyboard.press("Enter");
    await waitFor("the X-card's words focused", async () => {
      const f = await focused(dm);
      return f.tag === "p" && f.name.startsWith("Tap the X");
    });
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await waitFor("the X-card button focused again", async () => (await focused(dm)).name.startsWith("X-card"));

    // The DM panel's handout form opens at its first field, and Show gives focus back to its button.
    await openSideTab(dm, "DM");
    await panel.getByRole("button", { name: "Show a handout" }).click();
    await waitFor("the handout form's first field focused", async () => (await focused(dm)).name === "From the library");
    const image = path.join(work, "letter.png");
    await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 230, g: 220, b: 190 } } }).png().toFile(image);
    await panel.getByLabel("Upload a file").setInputFiles(image);
    await panel.getByRole("button", { name: "Change" }).waitFor();
    await panel.getByLabel("Title").fill("A letter");
    await panel.getByRole("button", { name: "Show", exact: true }).click();
    await waitFor("the handout in the DM's state", () => Object.values(dmSocket.state?.handouts ?? {}).length > 0 || null);
    await waitFor("Show a handout focused again", async () => (await focused(dm)).name === "Show a handout");

    // On the players' scene the map image's picker comes after a warning, which it names as its description.
    await openSideTab(dm, "Scenes");
    await section("This scene").getByRole("button", { name: "Add a map image" }).click();
    await waitFor("the image picker focused", async () => {
      const f = await focused(dm);
      return f.tag === "input" && f.name === "Choose the image";
    });
    const described = await dm.evaluate(() => {
      const doc = (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null; getElementById(id: string): { textContent: string | null } | null } }).document;
      const id = doc.activeElement?.getAttribute("aria-describedby") ?? "";
      return doc.getElementById(id)?.textContent ?? "";
    });
    assert.match(described, /^The players are on this scene\./);
    await dm.keyboard.press("Tab");
    assert.equal((await focused(dm)).name, "Cancel", "Tab goes from the picker to its Cancel");
    await dm.keyboard.press("Enter");
    await waitFor("Add a map image focused again", async () => (await focused(dm)).name === "Add a map image");

    // Export as image opens at its first choice, the scale chosen, and Close gives focus back.
    const exporting = section("Export as image");
    await exporting.getByRole("button", { name: "Export as image" }).click();
    await waitFor("the chosen pixels per square focused", () =>
      dm.evaluate(() => {
        const a = (globalThis as unknown as { document: { activeElement: { checked?: boolean; closest(s: string): { getAttribute(n: string): string | null } | null } | null } }).document.activeElement;
        return a?.checked === true && a.closest('[role="radiogroup"]')?.getAttribute("aria-label") === "Pixels per square";
      }),
    );
    await exporting.getByRole("button", { name: "Close", exact: true }).click();
    await waitFor("Export as image focused again", async () => (await focused(dm)).name === "Export as image");
    await shots.take(dm, "desk-export-closed-focus");

    // The token bar's Details opens the token's panel with focus on its chosen tab, "Token, tab, selected" (P3R-2).
    const p = await pagePoint(dm, run.bounds, { x: goblin()!.x + 0.5, y: goblin()!.y + 0.5 });
    await dm.mouse.click(p.x, p.y);
    const bar = dm.getByRole("dialog", { name: "Goblin actions" });
    await bar.getByRole("button", { name: "Details" }).click();
    await bar.waitFor({ state: "detached" });
    await waitFor("the Token tab focused", async () => {
      const f = await focused(dm);
      return f.role === "tab" && f.name === "Token";
    });
    assert.equal(await dm.getByRole("tab", { name: "Token", exact: true }).getAttribute("aria-selected"), "true");

    // A click on the panel's blank space leaves focus on the page, so Space still holds the map for a drag (P3R-2).
    const tokenPanel = dm.getByRole("tabpanel", { name: "Token" });
    const box = await tokenPanel.boundingBox();
    assert.ok(box, "the Token panel is not on screen");
    await dm.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
    assert.equal((await focused(dm)).tag, "body", "a click on the panel's blank space took focus");
    const camBefore = await readCamera(dm);
    const mid = await pagePoint(dm, run.bounds, { x: 2, y: 2 });
    await dm.keyboard.down("Space");
    await dm.mouse.move(mid.x, mid.y);
    await dm.mouse.down();
    await dm.mouse.move(mid.x + 60, mid.y + 40, { steps: 6 });
    await dm.mouse.up();
    await dm.keyboard.up("Space");
    const camAfter = await readCamera(dm);
    assert.ok(camBefore && camAfter && (camAfter.x !== camBefore.x || camAfter.y !== camBefore.y), `Space and a drag did not move the map: ${JSON.stringify({ camBefore, camAfter })}`);
    await dm.keyboard.press("Escape");
  });

  test("9. no page errors along the way", () => {
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
