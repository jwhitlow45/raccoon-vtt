import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { uuidv7 } from "#shared/ids.ts";
import type { Character } from "#shared/model.ts";
import { modulesFor, type ModuleId } from "../client/features/modules/registry.ts";
import { ConsoleWatch, openSideTab, OpSocket, pickTool, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Parts of the app hidden on this device (docs/design/design-v1-features.md):
 * the Features page in Menu, This device, and the ways back where each part
 * lived, on a phone held upright and on a computer (ft-1), every part's
 * probes in the toolbar, the top bar, the side panel's tabs and This device
 * gone once hidden and back from the search (ft-2), keys and an active
 * tool (ft-3), no op as the switches and presets change (ft-4), the
 * player's Short Rest and D&D Beyond re-sync sending the same ops with the
 * slot parts hidden as shown (ft-4f, ft-4h), the Classes sheet closing once
 * both slot parts hide (ftd-1), Reset all
 * and a second window (ft-8), "view as a player" showing every part
 * (ft-9) and the search's Show results (ft-10). The surfaces gated inside
 * their own files (the creature homes, scene settings, the DM panel, the
 * throw, hold to ping) are read by the parts markup test
 * (client/features/modules/parts.markup.test.ts) and their own unit tests.
 *
 * It runs on its own port: E2E_PORT plus forty-one.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 41;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";
/** The few shots for the owner, new files only, never over one already there. */
const OWNER_SHOTS = process.env.E2E_OWNER_SHOTS ?? "";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-features-"));
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

const run = { roomId: "", roomName: `E2E features ${new Date().toISOString().slice(0, 19)}`, password: "", thorn: uuidv7() };
/** The DM's own socket for the slot steps' setup, which is no device's choice. */
let ops: OpSocket | null = null;

/** The e2e files compile without the DOM library, so the page's globals are typed by hand. */
type Win = {
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  dispatchEvent(e: unknown): void;
  StorageEvent: new (type: string, init: { key: string; newValue: string | null }) => unknown;
  document: { activeElement: { textContent: string | null; getAttribute(n: string): string | null; closest(s: string): unknown } | null };
};

type Choices = { dm?: Partial<Record<ModuleId, boolean>>; player?: Partial<Record<ModuleId, boolean>> } | null;

/** Writes this device's choices as another window of the app does, so the page hears them by its storage event (features/modules/store.ts). */
async function setChoices(page: Page, choices: Choices): Promise<void> {
  const value = choices === null ? null : JSON.stringify({ v: 1, dm: choices.dm ?? {}, player: choices.player ?? {} });
  await page.evaluate((v) => {
    const w = globalThis as unknown as Win;
    if (v === null) w.localStorage.removeItem("rvtt.features");
    else w.localStorage.setItem("rvtt.features", v);
    w.dispatchEvent(new w.StorageEvent("storage", { key: "rvtt.features", newValue: v }));
  }, value);
}

function storedChoices(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as Win).localStorage.getItem("rvtt.features"));
}

/** The ops a page sent since `from`. */
function opsSince(watch: SocketWatch, from: number): string[] {
  return watch.sent.slice(from).filter((f) => f.startsWith('{"t":"op"'));
}

const toolbar = (page: Page) => page.locator('nav[aria-label="Tools"]');
const hiddenTools = (page: Page) => toolbar(page).getByRole("button", { name: /^Hidden tools, \d+$/ });

/** The Menu on a computer's side panel, or a phone's sheet from Panels. */
async function openMenu(page: Page, phone: boolean): Promise<Locator> {
  if (!phone) {
    await openSideTab(page, "Menu");
    return page.getByRole("tabpanel", { name: sideTabName("Menu") });
  }
  const sheet = page.getByRole("dialog", { name: "Menu" });
  if (!(await sheet.isVisible())) {
    await page.locator('button[title="Panels"]').click();
    await page.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
  }
  await sheet.waitFor();
  return sheet;
}

/** Back to the Menu's first page, from This device or Features. */
async function menuTop(page: Page, menu: Locator): Promise<void> {
  for (const name of [/^Back to This device/, /^Back to Menu/]) {
    const back = page.getByRole("button", { name });
    if (await back.isVisible()) await back.click();
  }
  await menu.getByRole("button", { name: /^This device/ }).waitFor();
}

async function openThisDevice(page: Page, phone: boolean): Promise<Locator> {
  const menu = await openMenu(page, phone);
  await menuTop(page, menu);
  await menu.getByRole("button", { name: /^This device/ }).click();
  await menu.getByRole("button", { name: "Interface size", exact: true }).waitFor();
  return menu;
}

async function openFeatures(page: Page, phone: boolean): Promise<Locator> {
  const menu = await openThisDevice(page, phone);
  await menu.getByRole("button", { name: /^Features/ }).click();
  await menu.getByRole("group", { name: "Start from" }).or(menu.getByText("Start from", { exact: true })).first().waitFor();
  return menu;
}

/** A part's switch on the Features page, its group unfolded first. */
async function partSwitch(menu: Locator, group: string, name: string): Promise<Locator> {
  const sw = menu.getByRole("switch", { name, exact: true });
  if (!(await sw.isVisible())) {
    const fold = menu.locator("[data-group-fold]").filter({ has: menu.page().locator("[data-group-name]", { hasText: new RegExp(`^${group}$`) }) });
    if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  }
  await sw.waitFor();
  return sw;
}

async function closeSheets(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const open = page.locator("dialog[open]");
    if ((await open.count()) === 0) return;
    await page.keyboard.press("Escape");
  }
}

/** What has focus: its words and its part mark, the nearest one around it. */
function focusOf(page: Page): Promise<{ text: string; part: string | null } | null> {
  return page.evaluate(() => {
    const el = (globalThis as unknown as Win).document.activeElement as unknown as { textContent: string | null; closest(s: string): { getAttribute(n: string): string | null } | null } | null;
    if (!el) return null;
    return { text: (el.textContent ?? "").trim(), part: el.closest("[data-part]")?.getAttribute("data-part") ?? null };
  });
}

/** A shot for review, a new file in E2E_OWNER_SHOTS, never written over one already there. */
async function ownerShot(page: Page, name: string): Promise<void> {
  if (OWNER_SHOTS === "") return;
  const dir = OWNER_SHOTS;
  mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${name}.png`);
  for (let n = 2; existsSync(file); n++) file = path.join(dir, `${name}-${n}.png`);
  await page.screenshot({ path: file });
}

/**
 * An op frame as the twin compares it (docs/design/design-v1-features.md 14,
 * ft-4): the op alone, its frame number and tags left out and every id
 * written as <id>, so two runs of one script read the same.
 */
function opShape(frame: string): unknown {
  const strip = (v: unknown): unknown => {
    if (typeof v === "string") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? "<id>" : v;
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "tag").map(([k, x]) => [k, strip(x)]));
    return v;
  };
  return strip((JSON.parse(frame) as { op: unknown }).op);
}

/** Run H's choices for the player (D-261127-398): every part hidden but Areas and D&D Beyond. */
const RUN_H: Choices = { player: Object.fromEntries(modulesFor("player").filter((m) => m.id !== "areas" && m.id !== "ddb").map((m) => [m.id, false])) };

function thorn(): Character | undefined {
  return dmSocket.state?.characters[run.thorn];
}

/** Thorn's page in the player's Characters sheet: Pat plays him alone, so the sheet lands there. */
async function thornsPage(): Promise<Locator> {
  await closeSheets(player);
  const sheet = player.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  if (!(await sheet.isVisible())) {
    await player.locator('button[title="Panels"]').click();
    await player.getByRole("list", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
  }
  await sheet.waitFor();
  const heading = sheet.locator("[data-creature-heading]").filter({ hasText: "Thorn" });
  const opener = sheet.locator(`[data-opener="character:${run.thorn}"]`);
  await heading.or(opener).first().waitFor();
  if ((await heading.count()) === 0) await opener.click();
  await heading.waitFor();
  return sheet;
}

function section(scope: Locator, title: string): Locator {
  return scope.locator(`xpath=.//section[*[self::h3 or self::h4][normalize-space()="${title}"]]`);
}

/** A group of a page, unfolded. */
async function openGroup(scope: Locator, name: string): Promise<Locator> {
  const group = scope.locator("[data-panel-group]").filter({ has: scope.page().locator("[data-group-name]", { hasText: new RegExp(`^${name}$`) }) }).last();
  const fold = group.locator("[data-group-fold]").first();
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  return group;
}

/** Thorn hurt to 10 of 30 HP with every Hit Point Die there, as each run starts. */
async function hurtThorn(): Promise<void> {
  await ops!.send({ t: "actor.rest", target: { characterId: run.thorn }, kind: "long" });
  await ops!.send({ t: "actor.hp", target: { characterId: run.thorn }, change: { kind: "damage", amount: 20 } });
  await waitFor("Thorn at 10 HP, every die there", () => (thorn()?.actor.hp.cur === 10 && thorn()?.spent === undefined ? true : null));
}

/** Step f's script: a Short Rest, one d10 rolled with Constitution 2, then Finish. The ops it sent. */
async function shortRest(): Promise<unknown[]> {
  const rest = section(await thornsPage(), "Rest");
  await rest.getByRole("radio", { name: "Short Rest" }).check();
  await rest.getByRole("textbox", { name: "Constitution modifier" }).fill("2");
  const from = playerSocket.sent.length;
  await rest.getByRole("button", { name: "Roll a d10 Hit Point Die plus 2, 3 of 3 left" }).tap();
  await waitFor("the die spent", () => (thorn()?.spent?.dice?.d10 === 1 ? true : null));
  await rest.getByRole("button", { name: "Finish the Short Rest" }).tap();
  const sent = await waitFor("the rest sent", () => {
    const frames = opsSince(playerSocket, from);
    return frames.some((f) => f.includes('"t":"actor.rest"')) ? frames : null;
  });
  return sent.map(opShape);
}

/** Thorn as D&D Beyond would send him after a level, Fighter 4, in the service's JSON shape with only the paths the reader reads (shared/ddb/read.ts). */
const THORN_DDB = {
  success: true,
  data: {
    id: 12345678,
    name: "Thorn",
    stats: [16, 12, 14, 10, 12, 8].map((value, i) => ({ id: i + 1, value })),
    bonusStats: [],
    overrideStats: [],
    baseHitPoints: 36,
    race: { weightSpeeds: { normal: { walk: 30 } } },
    classes: [{ level: 4, definition: { name: "Fighter", hitDice: 10, spellCastingAbilityId: null }, classFeatures: [] }],
    modifiers: { race: [], class: ["strength", "constitution"].map((a) => ({ type: "proficiency", subType: `${a}-saving-throws`, fixedValue: null, value: null })), background: [], feat: [], item: [], condition: [] },
    inventory: [],
    classSpells: [],
    spells: { race: [], class: [], item: [], feat: [] },
    actions: { race: [], class: [], feat: [] },
  },
};

/** A refused fetch is a failed request, which Chrome logs as an error with the request's address. */
const IMPORT_REFUSED = /Failed to load resource: the server responded with a status of 403\b.*\/ddb-import/;

/** Step h's script: Re-sync, the fetch refused, its JSON pasted, the review's Classes line ticked, then Apply. The ops it sent, then Undo puts Thorn back. */
async function resync(): Promise<unknown[]> {
  const block = await openGroup(await thornsPage(), "Stat block");
  const from = playerSocket.sent.length;
  await block.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true }).tap();
  const dialog = player.getByRole("dialog", { name: "Re-sync Thorn" });
  await dialog.getByRole("alert").getByText(/^D&D Beyond would not share that character\./).waitFor();
  await dialog.getByRole("button", { name: "Paste its JSON instead", exact: true }).tap();
  await dialog.locator("textarea").fill(JSON.stringify(THORN_DDB));
  await dialog.getByRole("button", { name: "Read it", exact: true }).tap();
  const review = player.getByRole("dialog", { name: "Re-sync review" });
  const classes = review.getByRole("checkbox", { name: "Classes: Fighter 4, now Fighter 3", exact: true });
  await classes.waitFor();
  assert.equal(await classes.isChecked(), true, "the Classes line ticked, whatever the slot parts show (D-261127-306)");
  await review.getByRole("button", { name: "Apply", exact: true }).tap();
  const done = player.getByRole("dialog", { name: "Thorn is re-synced" });
  await done.waitFor();
  await waitFor("Fighter 4 on the DM's device", () => (thorn()?.classes?.[0]?.level === 4 ? true : null));
  const sent = opsSince(playerSocket, from).map(opShape);
  await done.getByRole("button", { name: "Undo the re-sync", exact: true }).tap();
  const undone = player.getByRole("dialog", { name: "Re-sync undone" });
  await undone.getByRole("button", { name: "Done", exact: true }).tap();
  await undone.waitFor({ state: "detached" });
  await waitFor("Fighter 3 again", () => (thorn()?.classes?.[0]?.level === 3 ? true : null));
  return sent;
}

/** The DM's panels a part takes, by their side panel names. */
const PANEL_TITLES: Readonly<Record<string, string>> = { areas: "Areas", sound: "Sound", time: "Time", journal: "Journal", encounters: "Encounters", outliner: "Outliner" };

describe("raccoon-vtt parts hidden on this device", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    ops?.close();
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("ft-0. the DM creates a room on a computer and a player joins from a phone", async () => {
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

  test("ft-1. the Features page on a phone held upright and a computer, in line, and the ways back in the Panels list, the toolbar, Setup's menu, More, the DM menu and This device's Weather", async () => {
    // The page on a phone: its words, Start from on Everything, every group folded, and Always shown.
    let menu = await openFeatures(player, true);
    for (const words of ["Hide the parts of the app you don't use. Only this device changes. Everyone else, the game and its rules stay as they are.", "For the rooms you play in on this device.", "Every part shows.", "Find a part", "Always shown", "Reset all"]) {
      await menu.getByText(words, { exact: true }).first().waitFor();
    }
    assert.equal(await menu.getByRole("radio", { name: "Everything" }).isChecked(), true);
    assert.deepEqual(await menu.locator("[data-group-name]").allTextContents(), ["Characters", "Tools", "Panels", "Visuals", "Always shown"]);
    assert.deepEqual(alignmentLines(await measureAlignment(menu), "the Features page folded on a phone"), []);
    await shots.take(player, "ft-1-features-phone");
    await ownerShot(player, "features-phone-upright");

    // Ruler and Journal hidden from their switches: the row's value says so, and the presets give way to the viewer's own choice.
    await (await partSwitch(menu, "Tools", "Ruler")).click();
    await (await partSwitch(menu, "Panels", "Journal")).click();
    await menu.getByText("Your own choice: 2 parts hidden.").waitFor();
    assert.deepEqual(alignmentLines(await measureAlignment(menu), "the Features page with two groups open on a phone"), []);
    await player.getByRole("button", { name: /^Back to This device/ }).click();
    await menu.getByRole("button", { name: /^Features/ }).filter({ hasText: "2 hidden" }).waitFor();
    await closeSheets(player);

    // The phone's toolbar: Hidden tools after the play tools, its menu holding Show Ruler, and the Ruler gone.
    await waitFor("Hidden tools on the phone", async () => ((await hiddenTools(player).count()) === 1 ? true : null));
    assert.equal(await toolbar(player).locator('[data-part="ruler"]').count(), 0);
    assert.equal(await hiddenTools(player).getAttribute("aria-label"), "Hidden tools, 1");

    // The Panels list ends with the Hidden on this device line, and its Show brings Journal back, focused, said politely.
    await player.locator('button[title="Panels"]').click();
    const list = player.getByRole("list", { name: "Panels" });
    await list.waitFor();
    assert.equal(await list.locator('[data-part="journal"]').count(), 0);
    const line = player.getByRole("group", { name: "Hidden on this device" });
    await line.getByText("Hidden on this device:").waitFor();
    assert.deepEqual(alignmentLines(await measureAlignment(line), "the Panels list's Hidden on this device line"), []);
    await shots.take(player, "ft-1-panels-hidden-here");
    await line.getByRole("button", { name: "Show Journal" }).click();
    await waitFor("Journal shown", async () => ((await storedChoices(player)) === JSON.stringify({ v: 1, dm: {}, player: { ruler: false } }) ? true : null)).catch(async (err: unknown) => {
      throw new Error(`${String(err)}: stored ${await storedChoices(player)}, list ${await list.innerText().catch(() => "gone")}`);
    });
    await list.locator('[data-part="journal"]').waitFor();
    await waitFor("focus on Journal's tile", async () => ((await focusOf(player))?.part === "journal" ? true : null));
    await player.getByRole("status").filter({ hasText: "Journal shows again." }).waitFor({ state: "attached" });
    await closeSheets(player);

    // Hidden tools' Show brings the Ruler back to the toolbar, focused.
    await hiddenTools(player).click();
    await player.getByRole("menu", { name: "Hidden tools" }).getByRole("menuitem", { name: "Show Ruler" }).click();
    await toolbar(player).locator('[data-part="ruler"]').waitFor();
    await waitFor("focus on the Ruler", async () => ((await focusOf(player))?.part === "ruler" ? true : null));
    assert.equal(await hiddenTools(player).count(), 0, "with nothing hidden, no Hidden tools");

    // The computer: the page in the side panel, every group open, in line.
    menu = await openFeatures(dm, false);
    await menu.getByText("For your DM rooms on this device.").waitFor();
    assert.deepEqual(await menu.locator("[data-group-name]").allTextContents(), ["Characters", "Tools", "Maps", "Panels", "Visuals", "Always shown"]);
    assert.equal(await menu.getByRole("switch").count(), 23);
    assert.deepEqual(alignmentLines(await measureAlignment(menu), "the Features page on a computer"), []);
    await shots.take(dm, "ft-1-features-computer");
    await ownerShot(dm, "features-computer");

    // A need hidden: its dependent reads off and says what turning it on shows too, and turning it on shows both (D-261127-308).
    await (await partSwitch(menu, "Maps", "Map builder")).click();
    const dungeon = await partSwitch(menu, "Maps", "Dungeon generator");
    assert.equal(await dungeon.getAttribute("aria-checked"), "false");
    await menu.getByText("Turning it on shows Map builder too.").waitFor();
    assert.equal(await dungeon.isEnabled(), true, "it stays enabled");
    await dungeon.click();
    await waitFor("both shown", async () => ((await storedChoices(dm)) === JSON.stringify({ v: 1, dm: {}, player: {} }) ? true : null));
    assert.equal(await menu.getByRole("switch", { name: "Map builder", exact: true }).getAttribute("aria-checked"), "true");

    // From 900 px one Hidden tools button after the last tool holds every hidden tool, play and setup alike.
    for (const name of ["Ruler", "Map pins", "Traps"]) await (await partSwitch(menu, "Tools", name)).click();
    await waitFor("Hidden tools on the computer", async () => ((await hiddenTools(dm).getAttribute("aria-label").catch(() => null)) === "Hidden tools, 3" ? true : null));
    assert.equal(await toolbar(dm).locator("button[data-active]").last().getAttribute("aria-label"), "Hidden tools, 3", "it stands after the last tool");
    await hiddenTools(dm).click();
    assert.deepEqual(await dm.getByRole("menu", { name: "Hidden tools" }).getByRole("menuitem").allTextContents(), ["Show Ruler", "Show Map pins", "Show Traps"]);
    await dm.keyboard.press("Escape");

    // More stays while a panel part hides, even with every tab in the row, and holds its Show.
    await (await partSwitch(menu, "Panels", "Journal")).click();
    const more = dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]');
    await more.waitFor();
    await more.click();
    const moreMenu = dm.getByRole("menu", { name: "More panels" });
    await moreMenu.getByRole("menuitem", { name: "Show Journal" }).waitFor();
    await shots.take(dm, "ft-1-more-show-journal");
    await dm.keyboard.press("Escape");

    // Weather hidden: This device's Weather section keeps its heading and holds the line, in line.
    await (await partSwitch(menu, "Visuals", "Weather")).click();
    await (await partSwitch(menu, "Visuals", "Isometric view")).click();
    await dm.getByRole("button", { name: /^Back to This device/ }).click();
    const weather = menu.locator("[data-panel-group]").filter({ has: dm.locator("[data-group-name]", { hasText: /^Weather$/ }) });
    const weatherFold = weather.locator("[data-group-fold]");
    if ((await weatherFold.getAttribute("aria-expanded")) === "false") await weatherFold.click();
    const weatherLine = weather.getByRole("group", { name: "Hidden on this device" });
    await weatherLine.getByRole("button", { name: "Show Weather" }).waitFor();
    assert.equal(await menu.locator('[data-search="menu.this-device.weather.mode"]').count(), 0);
    assert.deepEqual(alignmentLines(await measureAlignment(weather), "This device's Weather with its line"), []);
    await weather.scrollIntoViewIfNeeded();
    await shots.take(dm, "ft-1-weather-hidden-here");
    await ownerShot(dm, "hidden-here-line");

    // Isometric view hidden: the top bar's View goes and the DM menu ends with its Show.
    assert.equal(await dm.locator("[data-rvtt-topbar]").getByRole("button", { name: /^View/ }).count(), 0);
    await dm.locator('[data-chip="dm"]').click();
    const dmMenu = dm.getByRole("menu", { name: "DM" });
    await dmMenu.waitFor();
    assert.equal(await dmMenu.getByRole("menuitem").last().textContent(), "Show Isometric view");
    await dmMenu.getByRole("menuitem", { name: "Show Isometric view" }).click();
    await dm.locator("[data-rvtt-topbar]").getByRole("button", { name: /^View/ }).first().waitFor();

    // A DM's phone with Traps and Pins hidden: their Show items end Setup's menu, and no Hidden tools button stands.
    await setChoices(dm, { dm: { pins: false, traps: false } });
    await dm.setViewportSize({ width: 390, height: 844 });
    try {
      await toolbar(dm).getByRole("button", { name: /^Setup tools/ }).waitFor();
      assert.equal(await hiddenTools(dm).count(), 0, "Traps and Pins are setup tools");
      await toolbar(dm).getByRole("button", { name: /^Setup tools/ }).click();
      const setup = dm.getByRole("menu", { name: "Setup tools" });
      await setup.getByRole("menuitem", { name: "Show Map pins" }).waitFor();
      assert.deepEqual((await setup.getByRole("menuitem").allTextContents()).map((t) => t.trim()), ["Show Map pins", "Show Traps"]);
      await shots.take(dm, "ft-1-setup-show-items");
      await setup.getByRole("menuitem", { name: "Show Traps" }).click();
      await waitFor("Traps back", async () => ((await storedChoices(dm)) === JSON.stringify({ v: 1, dm: { pins: false }, player: {} }) ? true : null));
    } finally {
      await dm.keyboard.press("Escape");
      await dm.setViewportSize({ width: 1440, height: 900 });
      await setChoices(dm, null);
    }
    await setChoices(player, null);
  });

  test("ft-2. each of the DM's parts: its tools, tabs, top bar parts and This device's rows show under Everything, go once it hides, and come back from the search's Show", async () => {
    const menu = await openThisDevice(dm, false);
    // The speaker stands on the bar under Everything.
    await dm.locator("[data-rvtt-topbar] [data-volume-button]").first().waitFor();
    const everything = { tools: await toolbar(dm).locator("[data-part]").evaluateAll((els) => els.map((e) => (e as unknown as { getAttribute(n: string): string }).getAttribute("data-part"))) };
    for (const part of ["ruler", "areas", "draw", "ping", "pins", "traps", "builder"]) assert.ok(everything.tools.includes(part), `${part}'s tool under Everything`);
    const anchorsNow = () => menu.locator("[data-search]").evaluateAll((els) => els.map((e) => (e as unknown as { getAttribute(n: string): string }).getAttribute("data-search")));
    const tabsNow = async () => {
      const names = await dm.getByRole("tablist", { name: "Panels" }).getByRole("tab").allTextContents();
      const more = dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]');
      if ((await more.count()) === 0) return names;
      await more.click();
      const items = await dm.getByRole("menu", { name: "More panels" }).getByRole("menuitemradio").allTextContents();
      await dm.keyboard.press("Escape");
      return [...names, ...items];
    };
    for (const m of modulesFor("dm")) {
      await setChoices(dm, { dm: { [m.id]: false } });
      const hidden = await waitFor(`${m.name} hidden`, async () => ((await storedChoices(dm))?.includes(`"${m.id}":false`) ? true : null));
      assert.ok(hidden);
      // Its tool leaves the toolbar, with a part it needs hidden its dependents' too.
      for (const c of m.claims.filter((c) => c.kind === "tool")) {
        await waitFor(`${m.name}'s ${c.id} tool gone`, async () => ((await toolbar(dm).locator(`[data-tool="${c.id}"]`).count()) === 0 ? true : null));
      }
      if (m.claims.some((c) => c.kind === "tool")) await waitFor(`${m.name} in Hidden tools`, async () => ((await hiddenTools(dm).count()) === 1 ? true : null));
      // Its panel leaves the tab row and More's list.
      for (const c of m.claims.filter((c) => c.kind === "panel")) {
        const title = PANEL_TITLES[c.id]!;
        const names = await tabsNow();
        assert.ok(!names.some((n) => n.trim().startsWith(title)), `${title} gone from ${names.join(", ")}`);
      }
      // Its top bar parts leave the bar.
      if (m.claims.some((c) => c.kind === "topBar" && c.id === "view")) assert.equal(await dm.locator("[data-rvtt-topbar]").getByRole("button", { name: /^View/ }).count(), 0);
      if (m.claims.some((c) => c.kind === "topBar" && c.id === "volume")) await waitFor("the speaker gone", async () => ((await dm.locator("[data-rvtt-topbar] [data-volume-button]").count()) === 0 ? true : null));
      // This device's rows it claims leave.
      const anchors = new Set(await anchorsNow());
      for (const c of m.claims.filter((c) => c.kind === "anchor" && c.id.startsWith("menu.this-device."))) {
        assert.ok(!anchors.has(c.id), `${c.id} still shows with ${m.name} hidden`);
      }
      assert.equal(await menu.locator(`[data-part="${m.id}"]`).count(), 0, `${m.name}'s part mark in This device`);
      // The search's one result for it, which shows it again.
      await dm.keyboard.press("Control+k");
      const sheet = dm.locator("dialog[data-search-sheet]");
      await sheet.waitFor();
      await dm.locator("[data-search-field]").fill(m.name);
      const id = `action:menu.this-device.features.${m.id.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
      const result = dm.locator(`[data-search-row="${id}"]`);
      await result.waitFor();
      assert.match((await result.innerText()).replace(/\s+/g, " "), new RegExp(`Show ${m.name}.*Menu · This device · Features.*Hidden`));
      await result.click();
      await waitFor(`${m.name} back`, async () => ((await storedChoices(dm)) === JSON.stringify({ v: 1, dm: {}, player: {} }) ? true : null));
      await closeSheets(dm);
      await openThisDevice(dm, false);
    }
    // Every tool is back.
    assert.deepEqual(await toolbar(dm).locator("[data-part]").evaluateAll((els) => els.map((e) => (e as unknown as { getAttribute(n: string): string }).getAttribute("data-part"))), everything.tools);
  });

  test("ft-3. a hidden part's key does nothing and stays reserved, the sheet leaves its row out and says so, and its active tool ends at Select", async () => {
    await closeSheets(dm);
    await pickTool(dm, "Ruler");
    assert.equal(await toolbar(dm).locator('[data-tool="ruler"]').getAttribute("data-active"), "true");
    await setChoices(dm, { dm: { ruler: false } });
    await waitFor("Select once the Ruler hides", async () => ((await toolbar(dm).locator('[data-tool="select"]').getAttribute("data-active")) === "true" ? true : null));
    // A key goes to the room from no field: focus leaves the toolbar's button for the page.
    await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
    await dm.keyboard.press("r");
    assert.equal(await toolbar(dm).locator('[data-tool="select"]').getAttribute("data-active"), "true", "R does nothing");
    await dm.keyboard.press("?");
    const sheet = dm.getByRole("dialog", { name: "Shortcuts" });
    await sheet.waitFor();
    const keysSection = sheet.getByRole("heading", { name: "Keys", exact: true }).locator("xpath=ancestor::section[1]");
    const keys = await keysSection.locator("th").allTextContents();
    assert.ok(!keys.includes("R"), `no R row in ${keys.join(", ")}`);
    assert.ok(keys.includes("F"), "Fog's F stays");
    await keysSection.getByText("Keys of parts hidden on this device are left out.").waitFor();
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await setChoices(dm, null);
    await toolbar(dm).locator('[data-tool="ruler"]').waitFor();
    assert.equal(await toolbar(dm).locator('[data-tool="select"]').getAttribute("data-active"), "true", "the Ruler ended as it hid, so showing it again does not pick it");
    // Every part shown, R is the Ruler's again, its row back and the line gone.
    await dm.keyboard.press("?");
    await sheet.waitFor();
    assert.ok((await keysSection.locator("th").allTextContents()).includes("R"));
    assert.equal(await keysSection.getByText("Keys of parts hidden on this device are left out.").count(), 0);
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await dm.keyboard.press("r");
    await waitFor("R picks the Ruler again", async () => ((await toolbar(dm).locator('[data-tool="ruler"]').getAttribute("data-active")) === "true" ? true : null));
    await dm.keyboard.press("v");
  });

  test("ft-4. no op leaves the device while every switch, both presets and Reset all change", async () => {
    const from = dmSocket.sent.length;
    const menu = await openFeatures(dm, false);
    for (const sw of await menu.getByRole("switch").all()) await sw.click();
    await menu.getByText(/^Your own choice: \d+ parts hidden\.$/).or(menu.getByRole("radio", { name: "Everything" })).first().waitFor();
    await menu.getByRole("radio", { name: "Simple" }).check();
    await menu.getByRole("radio", { name: "Everything" }).check();
    for (const sw of await menu.getByRole("switch").all()) await sw.click();
    await menu.getByRole("button", { name: "Reset all" }).click();
    await menu.getByRole("button", { name: /again to show every part, as the DM and as a player$/ }).click();
    await waitFor("every part back", async () => ((await storedChoices(dm)) === JSON.stringify({ v: 1, dm: {}, player: {} }) ? true : null));
    assert.deepEqual(opsSince(dmSocket, from), [], "a choice is this device's alone");
  });

  test("ft-4f. the player's Short Rest rolls one d10 and finishes, sending the same ops with Hit Point Dice hidden, whose card keeps its dice rows (D-261127-300)", async () => {
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const patId = playerSocket.you!.memberId;
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [patId], level: 3, actor: { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 16, speeds: { walk: 30 }, initBonus: 0, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } } });
    await ops.send({ t: "character.update", characterId: run.thorn, patch: { classes: [{ id: "fighter", level: 3 }] } });
    await waitFor("Thorn on Pat's device", () => playerSocket.state?.characters[run.thorn]?.classes ?? null);

    // Run E: every part shown.
    await hurtThorn();
    let rest = section(await thornsPage(), "Rest");
    await rest.getByText("Hit Point Dice: 3 of 3 d10", { exact: true }).waitFor();
    const shown = await shortRest();
    assert.deepEqual(
      shown.map((o) => (o as { t: string }).t),
      ["actor.hitDieRoll", "actor.rest"],
    );

    // Run H: the count line and its words go, the card's dice rows stay, and the same ops leave.
    await hurtThorn();
    await setChoices(player, RUN_H);
    rest = section(await thornsPage(), "Rest");
    await rest.getByRole("group", { name: "Hidden on this device" }).getByRole("button", { name: "Show Hit Point Dice" }).waitFor();
    assert.equal(await rest.getByText(/^Hit Point Dice: /).count(), 0, "no count line");
    await shots.take(player, "ft-4f-rest-hidden-here");
    const hidden = await shortRest();
    assert.deepEqual(hidden, shown, "the same ops with Hit Point Dice hidden");
    await setChoices(player, null);
  });

  test("ftd-1. the Classes sheet closes once both slot parts hide, and stays closed as they show again", async () => {
    const uses = section(await thornsPage(), "Uses");
    await uses.getByRole("button", { name: "Edit classes" }).tap();
    const sheet = player.getByRole("dialog", { name: "Classes", exact: true });
    await sheet.waitFor();
    await setChoices(player, { player: { spellSlots: false } });
    assert.equal(await sheet.isVisible(), true, "one slot part shown keeps it");
    await setChoices(player, { player: { spellSlots: false, hitDice: false } });
    await sheet.waitFor({ state: "detached" });
    assert.equal(await uses.locator("[data-uses-classes]").count(), 0, "the Classes line goes too");
    await setChoices(player, null);
    await uses.locator("[data-uses-classes]").waitFor();
    assert.equal(await sheet.count(), 0, "showing them again opens no sheet");
  });

  test("ft-4h. the player's D&D Beyond re-sync from pasted JSON sends the same ops with Spell slots and Hit Point Dice hidden, its Classes line ticked (D-261127-306)", async () => {
    await ops!.send({ t: "character.update", characterId: run.thorn, patch: { stats: { abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 }, saves: ["str", "con"], skills: {}, adjust: {}, defenses: {}, rolls: [] }, actor: { sheetUrl: "https://www.dndbeyond.com/characters/12345678" } } });
    await waitFor("Thorn's block on Pat's device", () => playerSocket.state?.characters[run.thorn]?.stats ?? null);
    // No request leaves for D&D Beyond: the fetch is refused here, and the JSON pasted is read on the device.
    await player.route("**/api/rooms/*/ddb-import", (route) => route.fulfill({ status: 403, json: { error: "private" } }));
    playerConsole.allow = [IMPORT_REFUSED];
    try {
      const shown = await resync();
      assert.ok(shown.some((o) => (o as { t: string }).t === "character.update"), JSON.stringify(shown));
      await setChoices(player, RUN_H);
      const hidden = await resync();
      assert.deepEqual(hidden, shown, "the same ops with Spell slots and Hit Point Dice hidden");
    } finally {
      playerConsole.allow = [];
      await player.unroute("**/api/rooms/*/ddb-import");
      await setChoices(player, null);
      await closeSheets(player);
    }
  });

  test("ft-8. Reset all shows every part for both roles, and a second window follows each choice at once, ending its active tool", async () => {
    await setChoices(dm, { dm: { journal: false }, player: { ruler: false } });
    const menu = await openFeatures(dm, false);
    await menu.getByRole("button", { name: "Reset all" }).click();
    await menu.getByRole("button", { name: /again to show every part, as the DM and as a player$/ }).click();
    await waitFor("both roles cleared", async () => ((await storedChoices(dm)) === JSON.stringify({ v: 1, dm: {}, player: {} }) ? true : null));
    const second = await dmContext.newPage();
    try {
      await second.goto(dm.url());
      await second.getByRole("status", { name: "Connected" }).first().waitFor();
      await pickTool(second, "Ruler");
      // Hidden in the first window: the second hears it by its storage event, and its Ruler ends at Select.
      await (await partSwitch(menu, "Tools", "Ruler")).click();
      await waitFor("the second window's Select", async () => ((await toolbar(second).locator('[data-tool="select"]').getAttribute("data-active")) === "true" ? true : null));
      assert.equal(await toolbar(second).locator('[data-tool="ruler"]').count(), 0);
      await (await partSwitch(menu, "Tools", "Ruler")).click();
      await toolbar(second).locator('[data-tool="ruler"]').waitFor();
    } finally {
      await second.close();
    }
  });

  test("ft-9. view as a player shows every part, whatever this device hides for players", async () => {
    await setChoices(dm, { player: { ruler: false, journal: false } });
    await closeSheets(dm);
    await dm.locator('[data-chip="dm"]').click();
    await dm.getByRole("menu", { name: "DM" }).getByRole("menuitem", { name: /View as Pat/ }).click();
    const preview = dm.getByRole("dialog", { name: /Viewing as Pat/ });
    await preview.waitFor();
    await preview.locator('nav[aria-label="Tools"] [data-tool="ruler"]').waitFor();
    assert.equal(await preview.getByRole("button", { name: /^Hidden tools/ }).count(), 0);
    // The player's Journal is offered there, in More, with no way back since nothing hides.
    await preview.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]').click();
    const more = dm.getByRole("menu", { name: "More panels" });
    await more.getByRole("menuitemradio", { name: "Journal", exact: true }).waitFor();
    assert.equal(await more.getByText("Hidden on this device").count(), 0);
    await dm.keyboard.press("Escape");
    await more.waitFor({ state: "detached" });
    await dm.keyboard.press("Escape");
    await setChoices(dm, null);
  });

  test("ft-10. the search's Show result: Shift+Enter only goes to the part's switch, Enter presses it, and a part's own entries leave the index while it hides", async () => {
    await closeSheets(dm);
    await setChoices(dm, { dm: { outliner: false } });
    await dm.keyboard.press("Control+k");
    await dm.locator("dialog[data-search-sheet]").waitFor();
    await dm.locator("[data-search-field]").fill("outliner");
    const show = dm.locator('[data-search-row="action:menu.this-device.features.outliner"]');
    await show.waitFor();
    assert.equal(await dm.locator('[data-search-row="panel:outliner"]').count(), 0, "the panel's own entry left the index");
    assert.equal(await dm.locator("[data-search-row]").first().getAttribute("data-search-row"), "action:menu.this-device.features.outliner");
    await dm.keyboard.press("Shift+Enter");
    const sw = dm.locator('[data-search="menu.this-device.features.outliner"]');
    await waitFor("focus on Outliner's switch", async () => ((await sw.evaluate((el) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === el)) ? true : null));
    assert.equal(await sw.getAttribute("aria-checked"), "false", "Shift+Enter only goes there");
    await dm.keyboard.press("Control+k");
    await dm.locator("[data-search-field]").fill("outliner");
    await show.waitFor();
    await dm.keyboard.press("Enter");
    await waitFor("Outliner shown", async () => ((await sw.getAttribute("aria-checked")) === "true" ? true : null));
    assert.equal(await storedChoices(dm), JSON.stringify({ v: 1, dm: {}, player: {} }));
  });

  test("ft-11. no page logged an error", () => {
    assert.deepEqual(dmConsole.errors, []);
    assert.deepEqual(playerConsole.errors, []);
  });
});
