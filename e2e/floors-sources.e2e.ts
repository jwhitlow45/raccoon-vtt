import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import type { RoomState, Scene } from "#shared/model.ts";
import { floorRoot } from "../client/features/floors/ids.ts";
import { uvttFile } from "../client/features/uvtt/synthetic.ts";
import { ConsoleWatch, OpSocket, openSceneGroup, openSideTab, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { undoSetup } from "./helpers/undoScope.ts";

/**
 * Several floors, phase 3: a floor from a Universal VTT file or a generated
 * dungeon (docs/design/design-v1-floors.md phase 3, 3.5 to 3.7, lane FL3-C),
 * in a room made as a DM makes one.
 *
 * - FL3S-1: on a computer, Map's VTT file makes Add a floor above open the
 *   file picker, and the import dialog aimed at the floor names it from a
 *   long file name cut to 40 characters, offers Like Ground floor and starts
 *   a lit map dark under party vision. Add the floor makes the floor at the
 *   file's size with its walls and lights, shows it, opens its page on the
 *   name, and one Undo setup takes it all back.
 * - FL3S-2: on a phone, Map's Dungeon makes Add a floor below open Generate a
 *   dungeon below Ground floor on Custom at the floor's size, clamped. Make
 *   the floor makes "Dungeon" with its automatic walls and its key page
 *   titled from the stored name, leaves the remembered size alone, and one
 *   Undo setup takes the floor and its key back together.
 * - FL3S-3: on a phone a file too big for it says so in an alert under the
 *   adds, and opens nothing.
 * - FL3S-4: on a hex scene VTT file and Dungeon are off, each with its reason.
 * - FL3S-5: the Floors group with each pick, the import dialog on a floor
 *   and Generate a dungeon on a floor, within 1 px at 1440 x 900, 390 x 844
 *   and 320 x 568, at 100% and 130%.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-eight. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 68;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-sources-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 20, h: 14 };
/** The file's map: 12 by 9 squares of 50 px, the long name Dungeondraft might write. */
const FILE = { name: "The_Sunken_Temple_of_the_Serpent_Lord_Level_2.dd2vtt", floor: "The Sunken Temple of the Serpent Lord Le", cols: 12, rows: 9, ppg: 50 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let phoneContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles: ConsoleWatch[] = [];

const run = { roomId: "", roomName: "The Sunken Keep", matId: "", towerId: randomUUID(), hiveId: randomUUID(), file: "", bigFile: "" };

function state(): RoomState {
  return dmSocket.state as RoomState;
}

/** Tower's floors, bottom first: every floor of a scene carries the scene's name. */
function towerFloors(): Scene[] {
  return Object.values(state().scenes)
    .filter((s): s is Scene => s !== undefined && s.name === "Tower")
    .sort((a, b) => (a.floor?.level ?? 0) - (b.floor?.level ?? 0));
}

function floorNamed(name: string): Scene | undefined {
  return towerFloors().find((s) => s.floor?.name === name);
}

/** The Scenes panel: a side tab from 900 px of layout, else the Panels sheet's Scenes. */
async function scenesPanel(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.isVisible())) {
    await openSideTab(page, "Scenes");
    return page.getByRole("tabpanel", { name: sideTabName("Scenes") });
  }
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]');
  if ((await sheet.count()) > 0 && (await sheet.isVisible())) return sheet;
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Scenes/ }).click();
  await sheet.waitFor();
  return sheet;
}

/** Shows the DM a scene from the Scenes panel's list, as a new page opens on the room's own scene. */
async function showScene(page: Page, name: string): Promise<void> {
  await (await scenesPanel(page)).getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
  try {
    await waitFor(`${name} on screen`, async () => ((await (await scenesPanel(page)).getByRole("textbox", { name: "Scene name", exact: true }).inputValue()) === name ? true : null));
  } catch (err) {
    await shots.take(page, `debug-show-${name}`);
    throw err;
  }
}

/** The Floors group, open, back on its list when a floor's page was left open. */
async function floorsGroup(page: Page): Promise<Locator> {
  const group = await openSceneGroup(await scenesPanel(page), "Floors");
  const back = page.locator(floorRoot("page")).getByRole("button", { name: "Back to Floors" });
  if ((await back.count()) > 0) await back.click();
  await group.getByRole("radiogroup", { name: "Map" }).waitFor();
  return group;
}

async function pickMap(group: Locator, label: "Blank" | "VTT file" | "Dungeon"): Promise<void> {
  const radio = group.getByRole("radio", { name: label, exact: true });
  await radio.check();
  assert.equal(await radio.isChecked(), true, label);
}

/** An add pressed in VTT file mode, which opens the file picker, answered with `file`. */
async function pickFile(page: Page, add: Locator, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await add.click();
  await (await chooser).setFiles(file);
}

/** Opens a page of the DM's room at a size and an interface size, on the players' scene, which FL3S-5 makes Tower. */
async function roomAt(context: BrowserContext, size: { width: number; height: number }, scale = 1): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.goto(server.origin);
  await page.evaluate((v) => (v === "1" ? localStorage.removeItem("rvtt.uiScale") : localStorage.setItem("rvtt.uiScale", v)), String(scale));
  await page.goto(dm.url());
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor("Tower on screen", async () => ((await (await scenesPanel(page)).getByRole("textbox", { name: "Scene name", exact: true }).inputValue()) === "Tower" ? true : null));
  return page;
}

/** The dungeon dialog's status line once a preview stands and holds still. */
async function previewDrawn(dialog: Locator): Promise<void> {
  const line = dialog.locator("footer [aria-live=polite]:not([aria-busy=true])");
  await line.waitFor({ timeout: 30_000 });
  let last = "";
  await waitFor("the status line to hold still", async () => {
    const now = (await line.innerText()).trim();
    const still = now === last && now !== "";
    last = now;
    return still ? now : null;
  });
}

describe("raccoon-vtt several floors: a floor from a file or a dungeon", { timeout: 1_200_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: WIDE });
    dm = await dmContext.newPage();
    const watch = new ConsoleWatch("dm");
    watch.attach(dm);
    consoles.push(watch);
    await dmSocket.attach(dmContext, dm);
    // A lit map: its lights inside the map, under a night's ambient light, so it starts dark under party vision.
    const image = await sharp({ create: { width: FILE.cols * FILE.ppg, height: FILE.rows * FILE.ppg, channels: 3, background: "#6b5a48" } }).png().toBuffer();
    const p = (x: number, y: number) => ({ x, y });
    const raw = uvttFile({
      size: p(FILE.cols, FILE.rows),
      ppg: FILE.ppg,
      image: image.toString("base64"),
      walls: [[p(1, 1), p(11, 1), p(11, 8), p(1, 8), p(1, 1)]],
      portals: [{ a: p(5, 1), b: p(6, 1) }],
      lights: [{ at: p(4, 4), range: 4 }],
    });
    run.file = path.join(work, FILE.name);
    writeFileSync(run.file, JSON.stringify({ ...raw, environment: { baked_lighting: false, ambient_light: "ff202020" } }));
    // Past a phone's 40 MB, written sparse: the size check reads File.size before any byte.
    run.bigFile = path.join(work, "Huge_vault.dd2vtt");
    writeFileSync(run.bigFile, "");
    truncateSync(run.bigFile, 41 * 1024 * 1024 + 1);
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

  test("FL3S-0. the DM's room, with Tower prepared in private and a hex scene beside it", async () => {
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
    run.matId = dmSocket.state!.meta.playerSceneId!;
    // Tower walls nothing by itself, so a dungeon floor beside it is seen to keep its own automatic walls.
    await ops.send({ t: "scene.create", scene: { id: run.towerId, name: "Tower", bounds: BOUNDS, fogEnabled: false, blockMovement: false, autoWalls: "off" } });
    await ops.send({ t: "scene.create", scene: { id: run.hiveId, name: "Hive", bounds: BOUNDS, gridShape: "hexRows" } });
    const panel = await scenesPanel(dm);
    await panel.getByRole("button", { name: /^Tower(?![A-Za-z])/ }).first().click();
    await waitFor("the DM on Tower", () => dmSocket.you?.sceneId === run.towerId || null);
    phoneContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await dmContext.storageState() });
  });

  test("FL3S-1. on a computer a floor from a file: the picker, the dialog aimed at the floor, the floor at the file's size with its walls and lights, its page, and one Undo setup", async () => {
    const group = await floorsGroup(dm);
    await group.getByText("Starts empty, with the size, look, what players see and light of the floor on screen.", { exact: true }).waitFor();
    assert.equal(await group.getByRole("radio", { name: "Blank", exact: true }).isChecked(), true, "Blank when the group opens");
    await pickMap(group, "VTT file");
    await group.getByText("A map from Dungeondraft, Dungeon Alchemist, Arkenforge or DungeonFog, with its walls, doors and lights, at the file's size.", { exact: true }).waitFor();
    await shots.take(dm, "fl3s-1-map-file-computer");

    const add = group.getByRole("button", { name: "Add a floor above", exact: true });
    await pickFile(dm, add, run.file);
    const dialog = dm.getByRole("dialog", { name: "Import a floor above Ground floor", exact: true });
    await dialog.waitFor();
    const name = dialog.getByRole("textbox", { name: "Floor name", exact: true });
    await name.waitFor({ timeout: 30_000 });
    assert.equal(await name.inputValue(), FILE.floor, "the file's name cut to 40 characters");
    assert.equal(await name.getAttribute("maxlength"), "40");
    await dialog.getByRole("radio", { name: "Like Ground floor", exact: true }).waitFor();
    await dialog.getByText(/^This map brings 1 light\. The scene starts dark with party vision on/).waitFor();
    assert.equal(await dialog.getByRole("radio", { name: "Explore", exact: true }).isChecked(), true);
    assert.equal(await dialog.getByRole("radio", { name: "Dark", exact: true }).isChecked(), true);
    const create = dialog.getByRole("button", { name: "Add the floor", exact: true });
    await waitFor("Add the floor on", async () => ((await create.isEnabled()) ? true : null), 30_000);
    await shots.take(dm, "fl3s-1-import-dialog-computer");
    assert.deepEqual(alignmentLines(await measureAlignment(dialog), "FL3S-1 the import dialog on a floor at 1440"), []);

    await create.click();
    await dialog.waitFor({ state: "detached", timeout: 60_000 });
    const floor = await waitFor("the file's floor", () => floorNamed(FILE.floor) ?? null);
    const ground = floorNamed("Ground floor");
    assert.ok(ground, "the scene's one floor is named Ground floor with its first add");
    assert.deepEqual([floor.floor?.level, ground.floor?.level], [1, 0]);
    assert.ok(floor.bounds.w >= FILE.cols && floor.bounds.h >= FILE.rows, `the file's size: ${JSON.stringify(floor.bounds)}`);
    assert.notDeepEqual(floor.bounds, BOUNDS);
    assert.equal(floor.gridFromFile, true);
    assert.equal(floor.autoWalls, "off");
    assert.ok(floor.map?.assetId, "the file's map");
    assert.deepEqual([floor.fogEnabled, floor.vision?.on, floor.vision?.light, floor.vision?.byClock === true], [true, true, "dark", false]);
    // The floor is shown, with its walls, door and light, and its page opens on the name.
    await waitFor("its walls and light", () => {
      const s = state();
      const edges = Object.values(s.buildChunks).filter((c) => c?.sceneId === floor.id).reduce((n, c) => n + Object.keys(c!.edges).length, 0);
      const lights = Object.values(s.lights).filter((l) => l?.sceneId === floor.id).length;
      return edges > 0 && lights === 1 ? true : null;
    });
    const page = dm.locator(floorRoot("page"));
    await page.waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Floor name" }).inputValue(), FILE.floor);
    await shots.take(dm, "fl3s-1-floor-page");
    await page.getByRole("button", { name: "Back to Floors" }).click();
    const row = (await floorsGroup(dm)).getByRole("button", { name: new RegExp(`^${FILE.floor},`) });
    await waitFor("the file's floor on screen", async () => ((await row.getAttribute("aria-label"))?.includes(", on screen") ? true : null));

    // One Undo setup takes the floor and everything in it.
    await undoSetup(dm);
    await waitFor("the file's floor gone", () => (floorNamed(FILE.floor) === undefined ? true : null));
    assert.equal(Object.values(state().lights).filter((l) => l?.sceneId === floor.id).length, 0);
  });

  test("FL3S-1b. a change made while the import dialog is open that refuses the add stops it with the reason, and nothing is sent", async () => {
    const group = await floorsGroup(dm);
    await pickMap(group, "VTT file");
    await pickFile(dm, group.getByRole("button", { name: "Add a floor above", exact: true }), run.file);
    const dialog = dm.getByRole("dialog", { name: "Import a floor above Ground floor", exact: true });
    const create = dialog.getByRole("button", { name: "Add the floor", exact: true });
    await waitFor("Add the floor on", async () => ((await create.isEnabled()) ? true : null), 30_000);
    // A co-DM fills Tower to its 8 floors meanwhile.
    const added: string[] = [];
    while (towerFloors().length < 8) {
      const id = randomUUID();
      await ops.send({ t: "scene.create", scene: { id, name: "Tower", bounds: BOUNDS }, floor: { beside: run.towerId, side: "above" } });
      added.push(id);
      await waitFor("the co-DM's floor", () => (state().scenes[id] ? true : null));
    }
    const scenesBefore = Object.keys(state().scenes).length;
    await create.click();
    await dialog.getByText("Tower already has 8 floors, the most a scene can have.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Back", exact: true }).waitFor();
    assert.equal(Object.keys(state().scenes).length, scenesBefore, "no floor was sent");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    for (const id of added.reverse()) await ops.send({ t: "scene.delete", sceneId: id });
    await waitFor("Tower back to one floor", () => (towerFloors().length === 1 ? true : null));
  });

  test("FL3S-2. on a phone a dungeon floor: Generate a dungeon below the floor on Custom at its size, the floor named for its theme with its walls and key, and one Undo setup", async () => {
    const phone = await phoneContext.newPage();
    const watch = new ConsoleWatch("phone");
    watch.attach(phone);
    consoles.push(watch);
    try {
      await phone.goto(dm.url());
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();
      await showScene(phone, "Tower");
      const before = await phone.evaluate((room) => localStorage.getItem(`rvtt.dungeon.${room}`), run.roomId);
      const group = await floorsGroup(phone);
      await pickMap(group, "Dungeon");
      await group.getByText("Generate a dungeon for the new floor. Stairs to other floors are yours to place.", { exact: true }).waitFor();
      await shots.take(phone, "fl3s-2-map-dungeon-phone");
      await group.getByRole("button", { name: "Add a floor below", exact: true }).click();
      const dialog = phone.getByRole("dialog", { name: "Generate a dungeon below Ground floor", exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("radio", { name: "Custom", exact: true }).isChecked(), true, "Custom at the floor's size");
      // 20 by 14 squares, its short side clamped to the generator's 20.
      assert.equal(await dialog.getByRole("textbox", { name: "Across", exact: true }).inputValue(), "20");
      assert.equal(await dialog.getByRole("textbox", { name: "Down", exact: true }).inputValue(), "20");
      await previewDrawn(dialog);
      await shots.take(phone, "fl3s-2-generate-dialog-phone");
      const make = dialog.getByRole("button", { name: "Make the floor", exact: true });
      await make.click();
      await dialog.waitFor({ state: "detached", timeout: 60_000 });
      const floor = await waitFor("the dungeon's floor", () => floorNamed("Dungeon") ?? null);
      assert.deepEqual([floor.floor?.level, floorNamed("Ground floor")?.floor?.level], [0, 1], "below Ground floor");
      assert.deepEqual(floor.bounds, { w: 20, h: 20 });
      assert.equal(floor.autoWalls, "all", "its automatic walls stand beside a floor with them off");
      const key = await waitFor("the key page", () => Object.values(state().journal).find((p) => p?.title === "Tower · Dungeon key") ?? null);
      assert.equal(key.access, "dm");
      await phone.locator(floorRoot("page")).waitFor();
      const after = await phone.evaluate((room) => localStorage.getItem(`rvtt.dungeon.${room}`), run.roomId);
      const sizeOf = (raw: string | null) => (raw === null ? null : (({ size, across, down }) => ({ size, across, down }))(JSON.parse(raw) as { size: string; across: number; down: number }));
      assert.deepEqual(sizeOf(after), before === null ? { size: "medium", across: 50, down: 50 } : sizeOf(before), "the remembered size is left as it was");

      // The key page joins the floor's Undo setup step, which the same DM takes back from the computer.
      await undoSetup(dm);
      await waitFor("the dungeon's floor and key gone", () => (floorNamed("Dungeon") === undefined && !Object.values(state().journal).some((p) => p?.title === "Tower · Dungeon key") ? true : null));
    } finally {
      await phone.close();
    }
  });

  test("FL3S-3. on a phone a file too big for it says so under the adds and opens nothing", async () => {
    const phone = await phoneContext.newPage();
    try {
      await phone.goto(dm.url());
      await phone.getByRole("status", { name: "Connected" }).first().waitFor();
      await showScene(phone, "Tower");
      const group = await floorsGroup(phone);
      await pickMap(group, "VTT file");
      await pickFile(phone, group.getByRole("button", { name: "Add a floor above", exact: true }), run.bigFile);
      const alert = group.getByRole("alert");
      await alert.getByText("This file is 41 MB. On a phone, import files up to 40 MB, or import it on a computer.", { exact: true }).waitFor();
      assert.equal(await phone.getByRole("dialog", { name: /^Import a floor/ }).count(), 0);
      await shots.take(phone, "fl3s-3-too-big-phone");
      await pickMap(group, "Blank");
      assert.equal(await group.getByRole("alert").count(), 0, "a new pick clears it");
    } finally {
      await phone.close();
    }
  });

  test("FL3S-4. on a hex scene VTT file is off with its reason, and Dungeon is on (dungeon phase 3)", async () => {
    const panel = await scenesPanel(dm);
    await panel.getByRole("button", { name: /^Hive(?![A-Za-z])/ }).first().click();
    await waitFor("the DM on Hive", () => dmSocket.you?.sceneId === run.hiveId || null);
    const group = await floorsGroup(dm);
    assert.equal(await group.getByRole("radio", { name: "VTT file", exact: true }).isDisabled(), true, "VTT file");
    assert.equal(await group.getByRole("radio", { name: "Dungeon", exact: true }).isDisabled(), false, "Dungeon");
    await group.getByText("Universal VTT maps bring square walls, and Hive's floors are hexes.", { exact: true }).waitFor();
    assert.equal(await group.getByRole("button", { name: "Add a floor above", exact: true }).isEnabled(), true, "Blank still adds");
    await shots.take(dm, "fl3s-4-hex");
    await panel.getByRole("button", { name: /^Tower(?![A-Za-z])/ }).first().click();
    await waitFor("the DM on Tower", () => (state().scenes[dmSocket.you?.sceneId ?? ""]?.name === "Tower" ? true : null));
  });

  test("FL3S-5. the Floors group with each pick and both dialogs on a floor, within 1 px at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const lines: string[] = [];
    // A page opens on the players' scene, and a scene switch on each of six pages would pass the session's 4 per 10 s.
    await ops.send({ t: "room.setPlayerScene", sceneId: run.towerId });
    for (const scale of [1, 1.3]) {
      for (const size of [WIDE, PHONE, { width: 320, height: 568 }]) {
        const at = `${size.width} x ${size.height} at ${scale * 100}%`;
        const page = await roomAt(dmContext, size, scale);
        try {
          const group = await floorsGroup(page);
          for (const label of ["Blank", "VTT file", "Dungeon"] as const) {
            await pickMap(group, label);
            lines.push(...alignmentLines(await measureAlignment(group), `the Floors group with ${label}, ${at}`));
          }
          await pickMap(group, "VTT file");
          await pickFile(page, group.getByRole("button", { name: "Add a floor above", exact: true }), run.file);
          const file = page.getByRole("dialog", { name: "Import a floor above Ground floor", exact: true });
          await file.getByRole("button", { name: "Add the floor", exact: true }).waitFor({ timeout: 30_000 });
          await waitFor("Add the floor on", async () => ((await file.getByRole("button", { name: "Add the floor", exact: true }).isEnabled()) ? true : null), 30_000);
          lines.push(...alignmentLines(await measureAlignment(file), `the import dialog on a floor, ${at}`));
          if (size === PHONE && scale === 1) await shots.take(page, "fl3s-5-import-dialog-phone");
          await file.getByRole("button", { name: "Close", exact: true }).click();
          await file.waitFor({ state: "detached" });
          await pickMap(group, "Dungeon");
          await group.getByRole("button", { name: "Add a floor above", exact: true }).click();
          const dungeon = page.getByRole("dialog", { name: "Generate a dungeon above Ground floor", exact: true });
          await previewDrawn(dungeon);
          lines.push(...alignmentLines(await measureAlignment(dungeon), `Generate a dungeon on a floor, ${at}`));
          if (size === WIDE && scale === 1) await shots.take(page, "fl3s-5-generate-dialog-computer");
          await dungeon.getByRole("button", { name: "Cancel", exact: true }).click();
          await dungeon.waitFor({ state: "detached" });
        } finally {
          await page.evaluate(() => localStorage.removeItem("rvtt.uiScale")).catch(() => {});
          await page.close();
        }
      }
    }
    await ops.send({ t: "room.setPlayerScene", sceneId: run.matId });
    assert.deepEqual(lines, []);
  });

  test("FL3S-6. no page logged an error", () => {
    for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
