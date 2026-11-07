import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, readCamera, reopenRoom, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { assetRow, chooseStarterWork, starterWork } from "./starterPick.ts";

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

/** The QOL pass's tokens (docs/design/design-v1-qol.md 3, Q3, Q7 and Q13): four Goblin Warriors in a row, the fourth hidden, and Snik, a fifth by its block, renamed. */
const qe = {
  warriors: [1, 2, 3, 4].map((number) => ({ id: randomUUID(), name: "Goblin Warrior", number, x: 1 + number * 2, y: 2 })),
  snik: { id: randomUUID(), name: "Snik", x: 3, y: 5 },
};

/** Clicks a token on the map and waits for its bar. */
async function clickToken(t: { x: number; y: number }, name: string): Promise<Locator> {
  const p = await pagePoint(dm, run.bounds, { x: t.x + 0.5, y: t.y + 0.5 });
  await dm.mouse.click(p.x, p.y);
  const bar = dm.getByRole("dialog", { name: `${name} actions` });
  await bar.waitFor();
  return bar;
}

/** The focused element's name, value and caret, whether it is a field, and the group it stands in. */
function activeField(page: Page): Promise<{ label: string; value: string | null; caret: number | null; inField: boolean; group: string | null }> {
  return page.evaluate(() => {
    type El = { tagName: string; value?: string; selectionStart?: number | null; textContent: string | null; getAttribute(n: string): string | null; closest(s: string): El | null };
    const el = (globalThis as unknown as { document: { activeElement: El | null } }).document.activeElement;
    if (!el) return { label: "", value: null, caret: null, inField: false, group: null };
    const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    return {
      label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(),
      value: field ? (el.value ?? "") : null,
      caret: field ? (el.selectionStart ?? null) : null,
      inField: field,
      group: el.closest('[role="group"]')?.getAttribute("aria-label") ?? null,
    };
  });
}

function hp(tokenId: string): number {
  const t = dmSocket.state?.tokens[tokenId];
  assert.ok(t && "inline" in t.actor, `no token ${tokenId}`);
  return t.actor.inline.hp.cur;
}

function effects(tokenId: string): string[] {
  const t = dmSocket.state?.tokens[tokenId];
  return t && "inline" in t.actor ? t.actor.inline.effects.map((e) => e.key) : [];
}

/** The tiles' words in a Conditions group, in order. */
function tileNames(group: Locator): Promise<string[]> {
  return group.getByRole("button").evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
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

    // At 1280 x 800 the row holds Token, Initiative, Dice and Log, each its icon alone (docs/design/design-v1-icons-2.md 3.1).
    await list.getByRole("tab", { name: sideTabName("Dice") }).focus();
    await dm.keyboard.press("ArrowLeft");
    await on("Initiative");
    await dm.keyboard.press("ArrowRight");
    await on("Dice");
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
    // The row's last tab before More: Log, the fourth of its icon tabs (docs/design/design-v1-icons-2.md 3.1).
    const last = list.getByRole("tab", { name: sideTabName("Log") });
    await last.click();
    await dm.keyboard.press("ArrowRight");
    assert.ok(await isFocused(more), "Right from the row's last tab reaches More");
    await dm.keyboard.press("Enter");
    const menu = dm.getByRole("menu", { name: "More panels" });
    const item = menu.getByRole("menuitemradio", { name: sideTabName("Journal") });
    // More's list opens on its first panel, Journal, the first after the row's. Down moves to the next and Up comes back, so the list's keys are covered.
    await waitFor("focus on Journal as More's list opens", async () => ((await isFocused(item)) ? true : null));
    await dm.keyboard.press("ArrowDown");
    await waitFor("focus on the panel after Journal", async () => ((await isFocused(menu.getByRole("menuitemradio").nth(1))) ? true : null));
    await dm.keyboard.press("ArrowUp");
    await waitFor("focus back on Journal", async () => ((await isFocused(item)) ? true : null));
    await dm.keyboard.press("Enter");
    await dm.getByRole("heading", { name: "Lore" }).waitFor();
    assert.ok(await isFocused(more), `choosing Journal left focus on More, not on the page's title: ${JSON.stringify(await focused(dm))}`);
    assert.equal(await more.getAttribute("aria-selected"), "true");
    assert.ok(await list.getByRole("tab", { name: sideTabName("Journal"), selected: true }).isVisible(), "More is named by the Journal");
    await dm.keyboard.press("ArrowLeft");
    assert.ok(await isFocused(last), "the next arrow moved along the tabs");
    assert.equal(await last.getAttribute("aria-selected"), "true");
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
    // A scene settings group is no section (components/Panel.tsx `GROUP_BOX`).
    const section = (heading: string) => panel.locator("section, [data-panel-group]").filter({ has: dm.getByRole("heading", { name: heading, exact: true }) }).last();

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
    await section("Map and grid").getByRole("button", { name: "Add a map image" }).click();
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
    // Paste an image sits beside the picker (docs/design/design-v1-paste.md 2.2), then Cancel.
    await dm.keyboard.press("Tab");
    assert.equal((await focused(dm)).name, "Paste an image", "Tab goes from the picker to its Paste an image");
    await dm.keyboard.press("Tab");
    assert.equal((await focused(dm)).name, "Cancel", "Tab goes on to its Cancel");
    await dm.keyboard.press("Enter");
    await waitFor("Add a map image focused again", async () => (await focused(dm)).name === "Add a map image");

    // Export as image opens at its first choice, the scale chosen, and Close gives focus back.
    const exporting = section("Export");
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

  test("sa-a-3. a handout from a starter pack: Use copies the picture in, the form picks it under the work's name, and Show shows it", async () => {
    const found = starterWork("handout");
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel");
    await panel.getByRole("button", { name: "Show a handout" }).click();
    await panel.getByRole("button", { name: "From starter packs" }).click();
    const dialog = dm.getByRole("dialog", { name: "Starter handouts" });
    await chooseStarterWork(dialog, found, "browse", false);
    await shots.take(dm, "sa-a-3-handout-starter");
    await dialog.getByRole("button", { name: "Use", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await panel.getByRole("button", { name: "Change" }).waitFor();
    assert.equal(await panel.getByLabel("Title").inputValue(), found.work.name);
    await panel.getByRole("button", { name: "Show", exact: true }).click();
    const shown = await waitFor("the starter handout in the DM's state", () => Object.values(dmSocket.state?.handouts ?? {}).find((h) => h?.title === found.work.name));
    const row = await assetRow(dmContext.request, server.origin, run.roomId, shown.assetId);
    assert.equal(row?.kind, "handout");
    assert.equal(row?.starter, found.work.key, "the row names the work it was copied from");
    assert.equal(row?.credit?.creator, found.work.credit.author, "the credit is the catalog's");
    await shots.take(dm, "sa-a-3-handout-shown");
    await panel.getByRole("button", { name: "Hide" }).first().click();
  });

  test("qe-1. four Goblin Warriors of the SRD's block, one hidden, and Snik, a fifth renamed, join the goblin, with this device's recent conditions forgotten", async () => {
    const hardy = { hp: { cur: 40, max: 40, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", srdId: "goblin-warrior" };
    const create = (t: { id: string; name: string; number?: number; x: number; y: number }, visibility: "all" | "dm") =>
      ops.send({
        t: "token.create",
        token: { id: t.id, sceneId: run.sceneId, size: "medium", visibility, kind: "monster", name: t.name, ...(t.number === undefined ? {} : { number: t.number }), x: t.x, y: t.y, disposition: "hostile", actor: { inline: hardy } },
      });
    for (const [i, w] of qe.warriors.entries()) await create(w, i === 3 ? "dm" : "all");
    await create(qe.snik, "all");
    await waitFor("the warriors and Snik in the DM's view", () => [...qe.warriors, qe.snik].every((t) => dmSocket.state?.tokens[t.id]) || null);
    // The device's recent conditions are read once a page loads (tokens/recentConditions.ts), so a reload starts them empty.
    await dm.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.recentConditions"));
    await reopenRoom(dm);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
  });

  test("qe-2. a digit with a token selected starts its HP change: the field takes focus with the digit and the caret after it, Enter applies it and gives focus back, and 0, + and - keep their keys", async () => {
    const w = qe.warriors[0]!;
    const bar = await clickToken(w, "Goblin Warrior 1");
    const field = bar.getByRole("textbox", { name: "HP change", exact: true });
    assert.equal(await field.inputValue(), "", "the entry starts empty");
    assert.equal((await activeField(dm)).inField, false, "nothing has focus in a field before the key");

    await dm.keyboard.press("7");
    await waitFor("the field focused with 7", async () => {
      const a = await activeField(dm);
      return a.label === "HP change" && a.value === "7" ? a : null;
    });
    assert.equal((await activeField(dm)).caret, 1, "the caret stands after the digit");
    const hpBefore = hp(w.id);
    await dm.keyboard.press("Enter");
    await waitFor("7 damage on Goblin Warrior 1", () => (hp(w.id) === hpBefore - 7 ? true : null));
    await waitFor("focus back off the field, the field empty", async () => {
      const a = await activeField(dm);
      return !a.inField && (await field.inputValue()) === "" ? true : null;
    });

    // The keys work again at once: the next digit starts a new entry, from the number pad too. The page sends it, since the browser's number pad types PageDown while Num Lock is off, and a page's own key types nothing, so the bar's own typing puts it in.
    await dm.evaluate(() => {
      const g = globalThis as unknown as { document: { body: { dispatchEvent(e: unknown): boolean } }; KeyboardEvent: new (t: string, o: Record<string, unknown>) => unknown };
      g.document.body.dispatchEvent(new g.KeyboardEvent("keydown", { key: "3", code: "Numpad3", location: 3, bubbles: true, cancelable: true }));
    });
    await waitFor("the field focused with 3 from the number pad", async () => ((await activeField(dm)).value === "3" ? true : null));
    await dm.keyboard.press("Enter");
    await waitFor("3 more damage", () => (hp(w.id) === hpBefore - 10 ? true : null));
    await waitFor("focus back off the field", async () => (!(await activeField(dm)).inField ? true : null));

    // A layout that types digits with Shift, such as AZERTY's top row: the key event names the digit and the field still takes it.
    await dm.evaluate(() => {
      const g = globalThis as unknown as { document: { body: { dispatchEvent(e: unknown): boolean } }; KeyboardEvent: new (t: string, o: Record<string, unknown>) => unknown };
      g.document.body.dispatchEvent(new g.KeyboardEvent("keydown", { key: "4", code: "Digit4", shiftKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor("the field focused with 4 from a Shift digit", async () => {
      const a = await activeField(dm);
      return a.label === "HP change" && a.value === "4" ? true : null;
    });

    // A change the entry cannot read keeps its words and focus: Enter gives focus back only once the field has emptied.
    await dm.keyboard.type("q");
    await dm.keyboard.press("Enter");
    await dm.waitForTimeout(300);
    const kept = await activeField(dm);
    assert.equal(kept.label, "HP change", `focus left the field after a change it could not read: ${JSON.stringify(kept)}`);
    assert.equal(kept.value, "4q");
    assert.equal(hp(w.id), hpBefore - 10, "nothing applied");
    await field.fill("");
    // Leaving the field ends the entry the digit started.
    await field.blur();

    // An entry started by a click keeps the field's own Enter: focus stays there after Apply.
    await field.click();
    await dm.keyboard.type("2");
    await dm.keyboard.press("Enter");
    await waitFor("2 more damage", () => (hp(w.id) === hpBefore - 12 ? true : null));
    await dm.waitForTimeout(300);
    assert.equal((await activeField(dm)).label, "HP change", "a clicked entry lost focus on Enter");

    // In a field a digit types there, as before: the HP field holds it, and no new entry starts.
    await dm.keyboard.type("5");
    assert.equal(await field.inputValue(), "5");
    await field.fill("");
    await field.blur();

    // 0 fits the map, + and - zoom, with the bar open and nothing taking the key as an HP change.
    await clickToken(w, "Goblin Warrior 1");
    const start = (await readCamera(dm))!;
    await dm.keyboard.press("+");
    await waitFor("+ zoomed in", async () => ((await readCamera(dm))!.scale > start.scale ? true : null));
    const near = (await readCamera(dm))!;
    await dm.keyboard.press("-");
    await waitFor("- zoomed out", async () => ((await readCamera(dm))!.scale < near.scale ? true : null));
    await dm.keyboard.press("+");
    await dm.keyboard.press("+");
    await waitFor("+ zoomed in again", async () => ((await readCamera(dm))!.scale > near.scale ? true : null));
    const close = (await readCamera(dm))!;
    await dm.keyboard.press("0");
    await waitFor("0 fitted the map", async () => ((await readCamera(dm))!.scale < close.scale ? true : null));
    assert.ok(!(await activeField(dm)).inField, "0, + or - put focus in a field");
    assert.equal(await field.inputValue(), "", "0, + or - typed into the HP field");
    await dm.keyboard.press("Escape");
  });

  test("qe-3. a device that moved Ruler to 1 keeps it: 1 picks the Ruler, 2 starts the HP change, and the sheet reads 2 to 9 with 1 is Ruler on this device.", async () => {
    await dm.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.keys", JSON.stringify({ v: 1, keys: { "tool:ruler": "1" } })));
    await reopenRoom(dm);
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
    try {
      const w = qe.warriors[1]!;
      await clickToken(w, "Goblin Warrior 2");
      await dm.keyboard.press("1");
      const tools = dm.getByRole("navigation", { name: "Tools" });
      const ruler = tools.getByRole("button", { name: "Ruler" }).first();
      await waitFor("1 picked the Ruler", async () => ((await ruler.getAttribute("aria-pressed")) === "true" ? true : null));
      assert.ok(!(await activeField(dm)).inField, "1 started an HP change");
      await tools.getByRole("button", { name: "Select" }).first().click();
      const bar = await clickToken(w, "Goblin Warrior 2");
      await dm.keyboard.press("2");
      await waitFor("2 started the HP change", async () => {
        const a = await activeField(dm);
        return a.label === "HP change" && a.value === "2" ? true : null;
      });
      await bar.getByRole("textbox", { name: "HP change", exact: true }).fill("");
      await bar.getByRole("textbox", { name: "HP change", exact: true }).blur();
      await dm.keyboard.press("Escape");

      await dm.keyboard.press("?");
      const sheet = dm.getByRole("dialog", { name: "Shortcuts" });
      await sheet.waitFor();
      const row = sheet.locator("tr").filter({ hasText: "Start an HP change of the selected tokens with that number" });
      const keys = ((await row.locator("th").textContent()) ?? "").replace(/\s+/g, " ").trim();
      assert.equal(keys, "2 to 9", "the HP row's keys");
      const does = ((await row.locator("td").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
      assert.ok(does.endsWith("1 is Ruler on this device."), `the HP row's note: ${does}`);
      await shots.take(dm, "qe-3-sheet-hp-row");
      await dm.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });
    } finally {
      await dm.evaluate(() => (globalThis as unknown as { localStorage: { removeItem(k: string): void } }).localStorage.removeItem("rvtt.keys"));
      await reopenRoom(dm);
      await dm.getByRole("status", { name: "Connected" }).first().waitFor();
      await dm.locator(".konvajs-content").first().waitFor();
    }
  });

  test("qe-4. C opens the bar's Conditions on their first cell and Escape closes them back on their button, for one token and a group, and Recent holds the three this device used last, newest first, fixed while open", async () => {
    const w = qe.warriors[0]!;
    const bar = await clickToken(w, "Goblin Warrior 1");
    const conditions = bar.getByRole("button", { name: "Conditions", exact: true });
    const firstCell = (want: string) =>
      waitFor(`focus on ${want}, the drawer's first cell`, async () => {
        const a = await activeField(dm);
        return a.label === want && a.group !== null ? a : null;
      });

    // No Recent yet: the first cell is the conditions' first, Blinded.
    await dm.keyboard.press("c");
    await firstCell("Blinded");
    assert.equal(await bar.getByRole("group", { name: "Recent", exact: true }).count(), 0, "a Recent row with nothing used");
    assert.equal(await conditions.getAttribute("aria-pressed"), "true");
    const grid = bar.getByRole("group", { name: "Conditions", exact: true });
    await grid.getByRole("button", { name: "Prone", exact: true }).click();
    await grid.getByRole("button", { name: "Poisoned", exact: true }).click();
    await waitFor("Prone and Poisoned on Goblin Warrior 1", () => (["prone", "poisoned"].every((k) => effects(w.id).includes(k)) ? true : null));
    // Fixed while open: nothing moves under the next tap.
    assert.equal(await bar.getByRole("group", { name: "Recent", exact: true }).count(), 0, "the Recent row changed while the drawer was open");
    await dm.keyboard.press("Escape");
    await waitFor("the drawer closed back on Conditions", async () => ((await conditions.getAttribute("aria-pressed")) === "false" && (await activeField(dm)).label === "Conditions" ? true : null));
    assert.ok(await bar.isVisible(), "Escape in the drawer closed the bar too");

    await dm.keyboard.press("c");
    await firstCell("Poisoned");
    const recent = bar.getByRole("group", { name: "Recent", exact: true });
    assert.deepEqual(await tileNames(recent), ["Poisoned", "Prone"]);
    await grid.getByRole("button", { name: "Restrained", exact: true }).click();
    await waitFor("Restrained on Goblin Warrior 1", () => (effects(w.id).includes("restrained") ? true : null));
    assert.deepEqual(await tileNames(recent), ["Poisoned", "Prone"], "the Recent row moved while open");
    await dm.keyboard.press("Escape");
    await dm.keyboard.press("c");
    await firstCell("Restrained");
    assert.deepEqual(await tileNames(bar.getByRole("group", { name: "Recent", exact: true })), ["Restrained", "Poisoned", "Prone"]);
    await shots.take(dm, "qe-4-recent-conditions");
    await dm.keyboard.press("Escape");
    assert.deepEqual(await dm.evaluate(() => JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem("rvtt.recentConditions") ?? "null")), ["restrained", "poisoned", "prone"]);

    // The same three first in the Token panel's picker: the list is this device's, not the bar's.
    await bar.getByRole("button", { name: "Details" }).click();
    const panel = dm.getByRole("tabpanel", { name: "Token" });
    const add = panel.getByRole("button", { name: "Add", exact: true }).first();
    await add.click();
    assert.deepEqual(await tileNames(panel.getByRole("group", { name: "Recent", exact: true })), ["Restrained", "Poisoned", "Prone"]);
    await panel.getByRole("button", { name: "Done", exact: true }).first().click();

    // A group's bar: C opens its grid on the first cell too.
    await clickToken(qe.warriors[1]!, "Goblin Warrior 2");
    const second = await pagePoint(dm, run.bounds, { x: qe.warriors[2]!.x + 0.5, y: qe.warriors[2]!.y + 0.5 });
    await dm.keyboard.down("Shift");
    await dm.mouse.click(second.x, second.y);
    await dm.keyboard.up("Shift");
    const group = dm.locator('[role="dialog"][data-bar-mode]');
    await group.getByText("2 selected").waitFor();
    await dm.keyboard.press("c");
    await firstCell("Restrained");
    assert.equal(await group.getByRole("button", { name: "Conditions", exact: true }).getAttribute("aria-pressed"), "true");
    await dm.keyboard.press("Escape");
    await waitFor("the group's drawer closed back on Conditions", async () => ((await activeField(dm)).label === "Conditions" ? true : null));
    await group.getByRole("button", { name: "Clear", exact: true }).click();
    await waitFor("nothing selected", async () => ((await dm.locator('[role="dialog"][data-bar-mode]').count()) === 0 ? true : null));
    // With nothing selected C does nothing.
    await dm.keyboard.press("c");
    await dm.waitForTimeout(300);
    assert.equal(await dm.getByRole("group", { name: "Conditions", exact: true }).count(), 0, "C with nothing selected opened a grid");
  });

  test("qe-5. All 4 Goblin Warriors in a warrior's bar selects the four, the hidden one too, in number order with focus on the group's frame, Save opens their group save, and a lone goblin or a renamed one has no such button", async () => {
    const bar = await clickToken(qe.warriors[2]!, "Goblin Warrior 3");
    const all = bar.getByRole("button", { name: "All 4 Goblin Warriors", exact: true });
    await all.waitFor();
    await shots.take(dm, "qe-5-all-of-a-kind");
    await all.click();
    const group = dm.locator('[role="dialog"][data-bar-mode]');
    await group.getByText("4 selected").waitFor();
    await waitFor("focus on the group's frame", () =>
      dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute("data-bar-mode") ?? null),
    );
    const names = (await group.textContent()) ?? "";
    const at = qe.warriors.map((w) => names.indexOf(`Goblin Warrior ${w.number}`));
    assert.ok(at.every((n) => n >= 0) && at.every((n, i) => i === 0 || n > at[i - 1]!), `the group names the four in number order: ${names}`);

    // The group bar's Save opens the group save page for the four, with its own ability picker.
    await group.getByRole("button", { name: "Save", exact: true }).click();
    // The page takes the side panel's Dice pane, under its own title.
    const page = dm.locator("aside").getByText("Dexterity save for 4").first();
    if (!(await page.waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
      await shots.take(dm, "qe-5-group-save-missing");
      assert.fail(`Save opened no group save page for the four: the side panel reads ${((await dm.locator("aside").first().textContent()) ?? "").slice(0, 400)}`);
    }
    await shots.take(dm, "qe-5-group-save");
    await group.getByRole("button", { name: "Clear", exact: true }).click();

    for (const [t, name] of [
      [qe.snik, "Snik"],
      [run.goblin, "Goblin"],
    ] as const) {
      const one = await clickToken(t, name);
      await one.getByRole("button", { name: "Conditions", exact: true }).waitFor();
      assert.equal(await one.getByRole("button", { name: /^All \d+ / }).count(), 0, `${name}'s bar offers All of a kind`);
      await dm.keyboard.press("Escape");
    }
  });

  test("9. no page errors along the way", () => {
    assert.deepEqual(dmConsole.errors.filter((e) => e.startsWith("uncaught")), []);
  });
});
