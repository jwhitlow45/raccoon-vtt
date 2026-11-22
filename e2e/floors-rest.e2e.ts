import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState, Scene } from "#shared/model.ts";
import { uvttFile } from "../client/features/uvtt/synthetic.ts";
import { ConsoleWatch, OpSocket, openSceneGroup, openSideTab, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { undoSetup } from "./helpers/undoScope.ts";

/**
 * Several floors, phase 4's rest (docs/design/design-v1-floors.md phase 4,
 * 9.3 to 9.5), in a room made as a DM makes one, with Tower's Ground floor,
 * Upper floor and Attic, players on Ground with the Attic shown to them:
 *
 * - FL4R-1: Export as image's Floors picks Every floor. The DM view makes
 *   one zip of each floor's picture, naming each step, and the player view
 *   one of only the floors players reached, numbered without a gap.
 * - FL4R-2: the tracker's New fight picks Every floor: everyone on every
 *   floor, and those players can see, each judged on its own floor, start a
 *   fight across the floors.
 * - FL4R-3: New scene's file picker takes three files and opens New scene
 *   from 3 files, lowest floor first by name with numbers as numbers. Move
 *   up and Move down keep focus, too many files are refused before any
 *   upload, a damaged file and a failed upload stop with nothing sent, and
 *   Make the scene makes one scene of three floors with every wall, which
 *   one Undo setup takes back.
 * - FL4R-4: the export with Every floor, New fight with its floors and the
 *   several-files dialog, within 1 px at 1440 x 900, 390 x 844 and
 *   320 x 568, at 100% and 130%.
 *
 * Line up (4B-3) is floors-links-build's. It runs with `pnpm test:e2e` on
 * E2E_PORT plus seventy-three. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 73;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-rest-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** The files of a crypt of three levels, picked out of order: 12 by 9 squares of 50 px each. */
const LEVELS = ["Crypt_Level_10.dd2vtt", "Crypt_Level_2.dd2vtt", "Crypt_Level_1.dd2vtt"];

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles: ConsoleWatch[] = [];

const run = {
  roomId: "",
  roomName: "The Leaning Tower",
  ground: "",
  upper: uuidv7(),
  attic: uuidv7(),
  files: [] as string[],
  nine: [] as string[],
  broken: "",
};

function state(): RoomState {
  return dmSocket.state as RoomState;
}

function floorsNamed(name: string): Scene[] {
  return Object.values(state().scenes)
    .filter((s): s is Scene => s !== undefined && s.name === name && s.floor !== undefined)
    .sort((a, b) => (a.floor?.level ?? 0) - (b.floor?.level ?? 0));
}

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30 }, initBonus: 1, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** A panel by its title: a side tab from 900 px of layout, else the Panels sheet's. */
async function panel(page: Page, title: string): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.isVisible())) {
    await openSideTab(page, title);
    return page.getByRole("tabpanel", { name: sideTabName(title) });
  }
  const sheet = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  if ((await sheet.count()) > 0 && (await sheet.isVisible())) return sheet;
  // Another panel's sheet covers the bars, so it closes first.
  const other = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true }).first();
  if ((await other.count()) > 0) {
    await other.getByRole("button", { name: /^Close / }).filter({ visible: true }).first().click();
    await other.waitFor({ state: "hidden" });
  }
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await sheet.waitFor();
  return sheet;
}

/** The scene settings' Export section, opened. */
async function exportSection(page: Page): Promise<Locator> {
  const scenes = await panel(page, "Scenes");
  const section = scenes.locator("section").filter({ has: page.getByRole("heading", { name: "Export", exact: true }) }).last();
  const open = section.getByRole("button", { name: "Export as image", exact: true });
  const floors = section.getByRole("radiogroup", { name: "Floors", exact: true });
  // The settings draw a moment after the panel, folded or left open from before.
  await open.or(floors).first().waitFor();
  if ((await open.count()) > 0) await open.click();
  await floors.waitFor();
  return section;
}

/** The tracker's New fight, while no fight runs. */
async function newFight(page: Page): Promise<Locator> {
  const tracker = await panel(page, "Initiative");
  const section = tracker.locator("section").filter({ has: page.locator('[data-search="tracker.new-fight"]') }).last();
  await section.getByRole("radiogroup", { name: "Floors", exact: true }).waitFor();
  return section;
}

/** New scene's Universal VTT picker, given `files` at once. */
async function pickFiles(page: Page, files: string[]): Promise<void> {
  const group = await openSceneGroup(await panel(page, "Scenes"), "New scene");
  await group.getByLabel("From a Universal VTT file", { exact: true }).setInputFiles(files);
}

/** Reads a stored zip's entries by its central directory, each entry's bytes as stored. */
function unzip(bytes: Buffer): { name: string; data: Buffer }[] {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, "a zip's end record");
  const out: { name: string; data: Buffer }[] = [];
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    assert.equal(bytes.readUInt16LE(at + 10), 0, "stored");
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const local = bytes.readUInt32LE(at + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    out.push({ name, data: bytes.subarray(start, start + size) });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return out;
}

/** A PNG's size from its header. */
function pngSize(data: Buffer): { w: number; h: number } {
  assert.equal(data.subarray(1, 4).toString("latin1"), "PNG", "a PNG");
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

/** Makes the file with the options on screen, records each busy step's words, and saves it: its name and entries. */
async function makeAndSave(page: Page, section: Locator): Promise<{ name: string; entries: { name: string; data: Buffer }[]; steps: string[] }> {
  await page.evaluate(() => {
    const w = globalThis as unknown as { __steps: string[]; __watch?: { disconnect(): void }; MutationObserver: new (f: () => void) => { observe(n: unknown, o: unknown): void; disconnect(): void }; document: { body: unknown; querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } };
    w.__watch?.disconnect();
    w.__steps = [];
    const note = () => {
      for (const b of Array.from(w.document.querySelectorAll('button[aria-busy="true"]'))) {
        const text = b.textContent?.trim() ?? "";
        if (text.startsWith("Making") && !w.__steps.includes(text)) w.__steps.push(text);
      }
    };
    const watch = new w.MutationObserver(note);
    watch.observe(w.document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    w.__watch = watch;
  });
  await section.getByRole("button", { name: "Make the file", exact: true }).click();
  const link = section.getByRole("link", { name: "Download", exact: true });
  await link.waitFor({ timeout: 60_000 });
  const steps = await page.evaluate(() => {
    const w = globalThis as unknown as { __steps: string[]; __watch?: { disconnect(): void } };
    w.__watch?.disconnect();
    return w.__steps;
  });
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const saved = path.join(work, `${uuidv7()}.zip`);
  await download.saveAs(saved);
  return { name: download.suggestedFilename(), entries: unzip(readFileSync(saved)), steps };
}

/** Opens a page of the DM's room at a size and an interface size, on the players' scene, Tower. */
async function roomAt(context: BrowserContext, size: { width: number; height: number }, scale = 1): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.goto(server.origin);
  await page.evaluate((v) => (v === "1" ? localStorage.removeItem("rvtt.uiScale") : localStorage.setItem("rvtt.uiScale", v)), String(scale));
  await page.goto(dm.url());
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  return page;
}

async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const a = (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null; textContent: string | null } | null } }).document.activeElement;
    return a?.getAttribute("aria-label") ?? a?.textContent?.trim() ?? "";
  });
}

describe("raccoon-vtt several floors, phase 4: export every floor, a fight on every floor, a scene from several files", { timeout: 1_200_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: WIDE, acceptDownloads: true });
    dm = await dmContext.newPage();
    const watch = new ConsoleWatch("dm");
    watch.attach(dm);
    consoles.push(watch);
    await dmSocket.attach(dmContext, dm);
    const p = (x: number, y: number) => ({ x, y });
    const write = async (name: string, tint: string) => {
      const image = await sharp({ create: { width: 12 * 50, height: 9 * 50, channels: 3, background: tint } }).png().toBuffer();
      const raw = uvttFile({ size: p(12, 9), ppg: 50, image: image.toString("base64"), walls: [[p(1, 1), p(11, 1), p(11, 8), p(1, 8), p(1, 1)]], portals: [{ a: p(5, 1), b: p(6, 1) }] });
      const file = path.join(work, name);
      writeFileSync(file, JSON.stringify(raw));
      return file;
    };
    run.files = [await write(LEVELS[0]!, "#4a5a48"), await write(LEVELS[1]!, "#5a4a48"), await write(LEVELS[2]!, "#484a5a")];
    for (let i = 1; i <= 9; i++) run.nine.push(await write(`Deep_${i}.dd2vtt`, "#404040"));
    run.broken = path.join(work, "Crypt_Level_2b.dd2vtt");
    writeFileSync(run.broken, JSON.stringify({ format: 0.3, nothing: true }));
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(server?.output().split("\n").slice(-40).join("\n"));
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

  test("FL4R-0. the DM's room: Tower's three floors with walls and creatures, players on Ground with the Attic shown", async () => {
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
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    run.ground = state().meta.playerSceneId!;
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower" } });
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside: run.ground, side: "above", besideName: "Ground floor", name: "Upper floor" } });
    await ops.send({ t: "scene.create", scene: { id: run.attic, name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside: run.upper, side: "above", name: "Attic" } });
    // A room of walls on each floor, so each picture has a build to draw.
    for (const [i, id] of [run.ground, run.upper, run.attic].entries()) {
      await ops.send({ t: "build.edge", sceneId: id, edges: Array.from({ length: 6 + i }, (_, x) => ({ key: `${2 + x},2,n`, feature: { kind: "wall" as const } })) });
    }
    const at = { size: "medium", disposition: "hostile" } as const;
    await ops.send({ t: "token.create", token: { id: uuidv7(), sceneId: run.ground, kind: "pc", name: "Thorn", partyVision: true, x: 4, y: 4, visibility: "all", size: "medium", disposition: "ally", actor: { inline: actor(24) } } });
    await ops.send({ t: "token.create", token: { id: uuidv7(), sceneId: run.ground, kind: "monster", name: "Goblin", x: 8, y: 4, visibility: "all", ...at, actor: { inline: actor(7) } } });
    await ops.send({ t: "token.create", token: { id: uuidv7(), sceneId: run.upper, kind: "monster", name: "Orc", x: 8, y: 6, visibility: "all", ...at, actor: { inline: actor(15) } } });
    await ops.send({ t: "token.create", token: { id: uuidv7(), sceneId: run.upper, kind: "monster", name: "Ogre", x: 12, y: 6, visibility: "dm", ...at, actor: { inline: actor(59) } } });
    await ops.send({ t: "token.create", token: { id: uuidv7(), sceneId: run.attic, kind: "monster", name: "Kobold", x: 3, y: 3, visibility: "all", ...at, actor: { inline: actor(5) } } });
    await ops.send({ t: "floor.open", sceneId: run.attic, open: true });
    await waitFor("Tower's three floors in the DM's copy", () => (floorsNamed("Tower").length === 3 && Object.keys(state().tokens).length === 5 ? true : null));
    assert.deepEqual(
      floorsNamed("Tower").map((f) => f.floor?.name),
      ["Ground floor", "Upper floor", "Attic"],
    );
    assert.equal(state().scenes[run.ground]?.fogEnabled, false, "fog off, so the player view is this device's to draw");
  });

  test("FL4R-1. Export every floor: the DM view's zip of three pictures, each step named, and the player view's of the two floors players reached", async () => {
    const section = await exportSection(dm);
    const floors = section.getByRole("radiogroup", { name: "Floors", exact: true });
    assert.equal(await floors.getByRole("radio", { name: "This floor", exact: true }).isChecked(), true, "This floor first");
    await floors.getByRole("radio", { name: "Every floor", exact: true }).check();
    await section.getByText("One .zip file with a picture of each of Tower's 3 floors.", { exact: true }).waitFor();
    await section.getByRole("radiogroup", { name: "Version", exact: true }).getByRole("radio", { name: "DM view", exact: true }).check();
    await shots.take(dm, "fl4r-1-export-every-floor-dm");

    const dmFile = await makeAndSave(dm, section);
    assert.equal(dmFile.name, "tower-30x20-70px-dm.zip");
    assert.deepEqual(
      dmFile.entries.map((e) => e.name),
      ["01-ground-floor.png", "02-upper-floor.png", "03-attic.png"],
    );
    for (const e of dmFile.entries) assert.deepEqual(pngSize(e.data), { w: 2100, h: 1400 }, e.name);
    assert.deepEqual(dmFile.steps, ["Making Ground floor (1 of 3)…", "Making Upper floor (2 of 3)…", "Making Attic (3 of 3)…"]);
    await section.getByText(/^Made tower-30x20-70px-dm\.zip: 3 floors at 70 px per square, /).waitFor();
    await shots.take(dm, "fl4r-1-export-every-floor-made");

    await section.getByRole("radiogroup", { name: "Version", exact: true }).getByRole("radio", { name: "Player view", exact: true }).check();
    await section.getByText("Players have reached 2 of Tower's 3 floors, so the file holds those.", { exact: true }).waitFor();
    await waitFor("a made file no longer matches a new version", async () => ((await section.getByRole("link", { name: "Download", exact: true }).count()) === 0 ? true : null));
    const players = await makeAndSave(dm, section);
    assert.equal(players.name, "tower-30x20-70px.zip");
    assert.deepEqual(
      players.entries.map((e) => e.name),
      ["01-ground-floor.png", "02-attic.png"],
      "numbered among the floors in the file, with no gap for Upper floor",
    );
    assert.deepEqual(players.steps, ["Making Ground floor (1 of 2)…", "Making Attic (2 of 2)…"]);
    await shots.take(dm, "fl4r-1-export-player-view");

    // This floor makes one picture, as before.
    await section.getByRole("radiogroup", { name: "Floors", exact: true }).getByRole("radio", { name: "This floor", exact: true }).check();
    await section.getByRole("button", { name: "Make image", exact: true }).waitFor();
    await section.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("FL4R-2. a fight on every floor: This floor first, then everyone on every floor and those players see, each on its own floor's rules", async () => {
    const section = await newFight(dm);
    const floors = section.getByRole("radiogroup", { name: "Floors", exact: true });
    assert.equal(await floors.getByRole("radio", { name: "This floor", exact: true }).isChecked(), true, "This floor first");
    await section.getByRole("button", { name: "Everyone here (2)", exact: true }).waitFor();
    await section.getByRole("button", { name: "Visible to players (2)", exact: true }).waitFor();
    await floors.getByRole("radio", { name: "Every floor", exact: true }).check();
    await section.getByRole("button", { name: "Everyone on every floor (5)", exact: true }).waitFor();
    // The Ogre is hidden on Upper floor.
    await section.getByRole("button", { name: "Visible to players (4)", exact: true }).waitFor();
    await shots.take(dm, "fl4r-2-new-fight-every-floor");
    const roll = section.getByRole("switch", { name: /^Roll monsters' Initiative/ });
    if ((await roll.getAttribute("aria-checked")) === "true") await roll.click();
    await section.getByRole("button", { name: "Everyone on every floor (5)", exact: true }).click();
    const rows = await waitFor("a fight across the floors", () => (state().encounter?.entries.length === 5 ? state().encounter!.entries : null));
    const scenes = new Set(rows.map((e) => state().tokens[e.tokenId!]?.sceneId));
    assert.deepEqual([...scenes].sort(), [run.ground, run.upper, run.attic].sort());
    await ops.send({ t: "encounter.end" });
    await waitFor("no fight", () => (state().encounter ? null : true));
  });

  test("FL4R-3. New scene from 3 files: lowest first by name, moves that keep focus, the refusals and file errors that send nothing, then one scene of three floors that one Undo setup takes back", async () => {
    // Too many files for one scene, refused before any upload.
    await pickFiles(dm, run.nine);
    const nine = dm.getByRole("dialog", { name: "New scene from 9 files", exact: true });
    await nine.getByText("A scene holds at most 8 floors. Pick 8 files or fewer.", { exact: true }).waitFor();
    assert.equal(await nine.getByRole("button", { name: "Make the scene", exact: true }).isDisabled(), true);
    await nine.getByRole("button", { name: "Close", exact: true }).click();
    await nine.waitFor({ state: "detached" });

    const scenesBefore = Object.keys(state().scenes).length;
    await pickFiles(dm, [...run.files, run.broken]);
    const broken = dm.getByRole("dialog", { name: "New scene from 4 files", exact: true });
    const rowNames = async (dialog: Locator) => dialog.getByRole("group").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    assert.deepEqual((await rowNames(broken)).sort(), ["Crypt_Level_1.dd2vtt", "Crypt_Level_10.dd2vtt", "Crypt_Level_2.dd2vtt", "Crypt_Level_2b.dd2vtt"]);
    await broken.getByRole("button", { name: "Make the scene", exact: true }).click();
    await broken.getByText(/^Crypt_Level_2b\.dd2vtt: /).waitFor({ timeout: 60_000 });
    await shots.take(dm, "fl4r-3-file-error");
    assert.equal(Object.keys(state().scenes).length, scenesBefore, "nothing sent");
    await broken.getByRole("button", { name: "Close", exact: true }).click();
    await broken.waitFor({ state: "detached" });

    // A failed upload of the second file sends nothing either.
    let puts = 0;
    await dm.route(/\/api\/rooms\/[^/]+\/assets\?kind=map/, async (route) => {
      if (route.request().method() === "PUT" && ++puts === 2) await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "unreadable" }) });
      else await route.continue();
    });
    consoles[0]!.allow = [/Failed to load resource: the server responded with a status of 422/];
    try {
      await pickFiles(dm, run.files);
      const failing = dm.getByRole("dialog", { name: "New scene from 3 files", exact: true });
      await failing.getByRole("button", { name: "Make the scene", exact: true }).click();
      await failing.getByText("Crypt Level 2 could not be uploaded, so no scene was made. That image could not be read. It may be damaged.", { exact: true }).waitFor({ timeout: 60_000 });
      assert.equal(Object.keys(state().scenes).length, scenesBefore, "nothing sent");
      await failing.getByRole("button", { name: "Close", exact: true }).click();
      await failing.waitFor({ state: "detached" });
    } finally {
      await dm.unroute(/\/api\/rooms\/[^/]+\/assets\?kind=map/);
      consoles[0]!.allow = [];
    }

    await pickFiles(dm, run.files);
    const dialog = dm.getByRole("dialog", { name: "New scene from 3 files", exact: true });
    await dialog.waitFor();
    assert.deepEqual(await rowNames(dialog), ["Crypt_Level_1.dd2vtt", "Crypt_Level_2.dd2vtt", "Crypt_Level_10.dd2vtt"], "lowest first, numbers as numbers");
    const floorName = (file: string) => dialog.getByRole("group", { name: file, exact: true }).getByRole("textbox", { name: "Floor name", exact: true });
    assert.deepEqual(await Promise.all(["Crypt_Level_1.dd2vtt", "Crypt_Level_2.dd2vtt", "Crypt_Level_10.dd2vtt"].map((f) => floorName(f).inputValue())), ["Crypt Level 1", "Crypt Level 2", "Crypt Level 10"]);
    const sceneName = dialog.getByRole("textbox", { name: "Scene name", exact: true });
    assert.equal(await sceneName.inputValue(), "Crypt Level 1", "the first file's name");
    assert.ok(Array.from(await sceneName.inputValue()).length <= 40, "the start value is cut to a floor name's 40 characters");
    assert.equal(await sceneName.getAttribute("maxlength"), "80", "the field takes a scene name's 80, as New scene does");
    assert.equal(await dialog.getByRole("button", { name: "Move Crypt Level 1 up", exact: true }).isDisabled(), true);

    // Move up takes the Level 10 row toward the lowest floor, and focus stays on its button.
    await dialog.getByRole("button", { name: "Move Crypt Level 10 up", exact: true }).click();
    assert.deepEqual(await rowNames(dialog), ["Crypt_Level_1.dd2vtt", "Crypt_Level_10.dd2vtt", "Crypt_Level_2.dd2vtt"]);
    await waitFor("focus on the moved row's Move up", async () => ((await focusedName(dm)) === "Move Crypt Level 10 up" ? true : null));
    await dm.keyboard.press("Enter");
    assert.deepEqual(await rowNames(dialog), ["Crypt_Level_10.dd2vtt", "Crypt_Level_1.dd2vtt", "Crypt_Level_2.dd2vtt"]);
    // At the top its Move up is off, so focus goes to its Move down.
    await waitFor("focus on Move down at the top", async () => ((await focusedName(dm)) === "Move Crypt Level 10 down" ? true : null));
    await dm.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Move Crypt Level 10 down", exact: true }).click();
    assert.deepEqual(await rowNames(dialog), ["Crypt_Level_1.dd2vtt", "Crypt_Level_2.dd2vtt", "Crypt_Level_10.dd2vtt"]);
    await floorName("Crypt_Level_1.dd2vtt").fill("Upper crypt");
    await floorName("Crypt_Level_2.dd2vtt").fill("Lower crypt");
    await floorName("Crypt_Level_10.dd2vtt").fill("Vault");
    await sceneName.fill("Crypt");
    await shots.take(dm, "fl4r-3-several-files-dialog");

    await dialog.getByRole("button", { name: "Make the scene", exact: true }).click();
    await dialog.getByText(/^(Reading|Uploading) /).first().waitFor();
    await dialog.waitFor({ state: "detached", timeout: 120_000 });
    await dm.locator("[data-toast]").filter({ hasText: "Crypt is made with 3 floors, with every wall, door and light. Undo in Setup history." }).first().waitFor();
    assert.equal(await dm.locator("[data-toast]").count(), 1, "one toast says it, not it and the setup one beside it");
    const floors = await waitFor("Crypt's three floors", () => (floorsNamed("Crypt").length === 3 ? floorsNamed("Crypt") : null), 30_000);
    assert.deepEqual(
      floors.map((f) => [f.floor?.name, f.floor?.level]),
      [
        ["Upper crypt", 0],
        ["Lower crypt", 1],
        ["Vault", 2],
      ],
    );
    for (const f of floors) {
      assert.ok(f.map?.assetId, `${f.floor?.name}'s map`);
      assert.equal(f.gridFromFile, true);
    }
    await waitFor("every floor's walls and door", () => {
      const s = state();
      return floors.every((f) => Object.values(s.buildChunks).some((c) => c?.sceneId === f.id && Object.values(c.edges).some((e) => e.kind === "door"))) ? true : null;
    });
    await waitFor("the DM on Crypt's lowest floor", () => (dmSocket.you?.sceneId === floors[0]!.id ? true : null), 30_000);
    await shots.take(dm, "fl4r-3-crypt-made");

    // One Undo setup takes the scene and every floor back.
    await undoSetup(dm);
    await waitFor("Crypt gone", () => (floorsNamed("Crypt").length === 0 ? true : null));
    assert.equal(Object.keys(state().scenes).length, scenesBefore);
  });

  test("FL4R-4. Export with Every floor, New fight with its floors and the several-files dialog, within 1 px at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const lines: string[] = [];
    for (const scale of [1, 1.3]) {
      for (const size of [WIDE, PHONE, { width: 320, height: 568 }]) {
        const at = `${size.width} x ${size.height} at ${scale * 100}%`;
        const page = await roomAt(dmContext, size, scale);
        try {
          const section = await exportSection(page);
          await section.getByRole("radiogroup", { name: "Floors", exact: true }).getByRole("radio", { name: "Every floor", exact: true }).check();
          await section.getByText("Players have reached 2 of Tower's 3 floors, so the file holds those.", { exact: true }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(section), `Export with Every floor, ${at}`));
          if (size === PHONE && scale === 1) await shots.take(page, "fl4r-4-export-phone");
          await section.getByRole("button", { name: "Close", exact: true }).click();

          const fight = await newFight(page);
          await fight.getByRole("radiogroup", { name: "Floors", exact: true }).getByRole("radio", { name: "Every floor", exact: true }).check();
          await fight.getByRole("button", { name: /^Everyone on every floor \(\d+\)$/ }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(fight), `New fight on every floor, ${at}`));
          if (size === PHONE && scale === 1) await shots.take(page, "fl4r-4-new-fight-phone");

          await pickFiles(page, run.files);
          const dialog = page.getByRole("dialog", { name: "New scene from 3 files", exact: true });
          await dialog.getByRole("textbox", { name: "Scene name", exact: true }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(dialog), `New scene from 3 files, ${at}`));
          if (size === PHONE && scale === 1) await shots.take(page, "fl4r-4-several-files-phone");
          if (size.width === 320 && scale === 1.3) await shots.take(page, "fl4r-4-several-files-320-130");
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
        } finally {
          await page.evaluate(() => localStorage.removeItem("rvtt.uiScale")).catch(() => {});
          await page.close();
        }
      }
    }
    assert.deepEqual(lines, []);
  });

  test("FL4R-5. no page logged an error", () => {
    for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
