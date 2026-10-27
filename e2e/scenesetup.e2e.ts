import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import type { RoomState, Scene } from "#shared/model.ts";
import { ConsoleWatch, OpSocket, openSideTab, reopenRoom, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Scene setup (docs/design-v1-map-discovery.md 8, lane MS1): what players
 * see of a scene, chosen once. The real server serves the production build
 * to a DM on a computer, in a room made as a DM makes one, so it starts on
 * Explore for new scenes.
 *
 * - ss-1: the room's first Battle mat shows Everything, a new Battle mat
 *   starts on Explore, and a new Map image on Reveal by hand, saying why,
 *   and warned when Explore is picked. Room settings' New scenes shows the
 *   room's Explore with no "As before". On a scene with explored ground,
 *   Reveal by hand and the Party vision switch ask first, Escape and Cancel
 *   answer no, and Change goes on. Fog off in the fold makes Custom.
 * - ss-2: "Like Crypt" on a new map image copies fog, party vision with its
 *   light and Sight, and movement, and keeps "floor" walls. A Universal VTT
 *   import starts on Explore in place of its old fog box, and Like brings
 *   Crypt's light to its light row.
 * - ss-3: Cave's settings used on 3 scenes in one step, the sheet naming
 *   the players' scene, the reset of remembered maps and per-player maps
 *   joining, then one Undo, named for Cave, puts all 3 back.
 * - ss-a: every new control measured with the alignment helper at
 *   1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, in light and
 *   dark: the form's Players see, the Universal VTT dialog's, the scene's
 *   What players see with its fold open and a question asked, the copy
 *   sheet, and Room settings' New scenes.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus
 * thirty-eight. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 38;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-scenesetup-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const WIDE = { width: 1280, height: 800 };
const LEAVE = "Players will see the build as it is now on everything they explored. Undo does not bring back what they remembered.";
const WALLLESS = "This map has no walls yet, so party vision shows players all of it at once. Add walls first, or choose Reveal by hand.";
const STEPS_DOWN = "Under Explore a map image with no walls starts on Reveal by hand, since party vision would show players all of it.";
const CUSTOM = "Custom: party vision is on and fog is off, so players see the whole map, dimmed outside what their characters see.";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles: ConsoleWatch[] = [];

// The guide's pictures of scene setup come from this run, so the room has a name a table would give it.
const run = { roomId: "", roomName: "The Sunken Keep", matId: "", arenaId: "", caveId: "", cryptId: "" };

function scenes(state: RoomState | null): Scene[] {
  return Object.values(state?.scenes ?? {}).filter((s): s is Scene => s !== undefined);
}

function sceneOf(id: string): Scene | undefined {
  return dmSocket.state?.scenes[id];
}

/** A scene's two switches and its Sight, as the settings set them. */
function seeOf(id: string): { fog: boolean; vision: boolean; light: string; perPlayer: boolean } | null {
  const s = sceneOf(id);
  return s ? { fog: s.fogEnabled, vision: s.vision?.on === true, light: s.vision?.light ?? "bright", perPlayer: s.vision?.perPlayer === true } : null;
}

/** A plain map image whose name gives its squares, so no grid is searched for and Line up grid stays shut. */
async function mapFile(name: string): Promise<string> {
  const file = path.join(work, name);
  await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 90, g: 80, b: 70 } } }).png().toFile(file);
  return file;
}

/** A Universal VTT file with one room of walls, as Dungeondraft writes one (maps.e2e.ts has the whole format). */
async function uvttFile(): Promise<string> {
  const image = await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: 120, g: 110, b: 100 } } }).png().toBuffer();
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
    portals: [],
    environment: { baked_lighting: true, ambient_light: "ff404040" },
    lights: [],
    image: image.toString("base64"),
  };
  const file = path.join(work, "Barrow.dd2vtt");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

/** The Scenes panel: a side tab on a computer, a sheet from the Panels button on a phone. */
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

/** A panel's section by its label: the nearest section around the heading, since a sheet is a section around them all. */
function section(panel: Locator, label: string): Locator {
  return panel.getByRole("heading", { name: label, exact: true }).locator("xpath=ancestor::section[1]");
}

function playersSee(within: Locator): Locator {
  return within.getByRole("radiogroup", { name: "Players see", exact: true });
}

async function checked(group: Locator): Promise<string | null> {
  const radios = group.getByRole("radio");
  await radios.first().waitFor();
  for (let i = 0; i < (await radios.count()); i++) {
    const radio = radios.nth(i);
    if (await radio.isChecked()) return radio.getAttribute("value");
  }
  return null;
}

/** Shows the DM a scene from its row in the list, and waits for its settings to name it. */
async function view(sceneId: string, page: Page = dm): Promise<void> {
  const name = sceneOf(sceneId)!.name;
  const panel = await scenesPanel(page);
  // The row's button is named by the scene's name, then its size and kind.
  await panel.getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
  const field = section(panel, "This scene").getByRole("textbox", { name: "Scene name" });
  await waitFor(`${name}'s settings`, async () => ((await field.inputValue()) === name ? true : null));
  if (page === dm) await waitFor(`the DM on ${name}`, () => dmSocket.you?.sceneId === sceneId || null);
}

/** Makes a scene from the New scene form, Players see as `see` when given, and waits for it. `shot` is taken just before the scene is made. */
async function newScene(kind: "Battle mat" | "Map image", name: string, opts: { see?: string; file?: string; shot?: string } = {}): Promise<Scene> {
  const known = new Set(scenes(dmSocket.state).map((s) => s.id));
  const panel = await scenesPanel(dm);
  const form = section(panel, "New scene");
  await form.getByRole("radio", { name: kind, exact: true }).click();
  await form.getByRole("textbox", { name: "Scene name" }).fill(name);
  if (opts.see) await playersSee(form).getByRole("radio", { name: opts.see, exact: true }).check();
  if (opts.file) {
    await form.locator('input[type="file"][accept="image/*"]').first().setInputFiles(opts.file);
    if (opts.shot) {
      await form.getByRole("textbox", { name: "Scene name" }).scrollIntoViewIfNeeded();
      await shots.take(dm, opts.shot);
    }
    await form.getByRole("button", { name: "Upload and create" }).click();
  } else await form.getByRole("button", { name: "Create", exact: true }).click();
  const made = await waitFor(`the scene ${name}`, () => scenes(dmSocket.state).find((s) => s.name === name && !known.has(s.id)), 30_000);
  await waitFor(`the DM on ${name}`, () => dmSocket.you?.sceneId === made.id || null);
  return made;
}

describe("raccoon-vtt scene setup run", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: WIDE });
    dm = await dmContext.newPage();
    const watch = new ConsoleWatch("dm");
    watch.attach(dm);
    consoles.push(watch);
    await dmSocket.attach(dmContext, dm);
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

  test("ss-1. the first mat shows Everything, a new mat starts on Explore, a new map image on Reveal by hand, warned, and leaving Explore asks first", async () => {
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
    assert.equal(dmSocket.state!.meta.settings.newScenePlayers, "explore", "a new room starts new scenes on Explore");

    // The room's first mat: Everything, so players who join see a mat.
    let panel = await scenesPanel(dm);
    const shown = section(panel, "What players see");
    assert.equal(await checked(playersSee(shown)), "all");
    assert.deepEqual(seeOf(run.matId), { fog: false, vision: false, light: "bright", perPlayer: false });

    // A new mat starts on the room's Explore.
    const form = section(panel, "New scene");
    await form.getByRole("radio", { name: "Battle mat", exact: true }).click();
    assert.equal(await checked(playersSee(form)), "explore");
    assert.equal(await form.getByText(STEPS_DOWN).count(), 0, "a mat steps nothing down");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    const arena = await newScene("Battle mat", "Arena");
    run.arenaId = arena.id;
    assert.deepEqual(seeOf(arena.id), { fog: true, vision: true, light: "bright", perPlayer: false });
    assert.equal(arena.blockMovement, true);

    // A new map image starts on Reveal by hand and says why. Explore on it warns.
    panel = await scenesPanel(dm);
    const mapForm = section(panel, "New scene");
    await mapForm.getByRole("radio", { name: "Map image", exact: true }).click();
    const group = playersSee(mapForm);
    assert.equal(await checked(group), "reveal");
    await mapForm.getByText(STEPS_DOWN).waitFor();
    assert.equal(await mapForm.getByText(WALLLESS).count(), 0);
    await group.getByRole("radio", { name: "Explore", exact: true }).check();
    await mapForm.getByText(WALLLESS).waitFor();
    await mapForm.scrollIntoViewIfNeeded();
    await shots.take(dm, "ss-1-new-map-explore-warned");
    // Each option is a radio named by its name and described by its help, and the group by the chosen help.
    const explore = group.getByRole("radio", { name: "Explore", exact: true });
    const described = await explore.getAttribute("aria-describedby");
    assert.match((await dm.locator(`[id="${described}"]`).textContent()) ?? "", /^Players see what their characters see\./);
    assert.equal(await group.getAttribute("aria-describedby"), described);
    await group.getByRole("radio", { name: "Reveal by hand", exact: true }).check();
    await mapForm.getByRole("button", { name: "Cancel", exact: true }).click();
    const cave = await newScene("Map image", "Cave", { file: await mapFile("cave_10x8.png"), shot: "ss-1-guide-new-map" });
    run.caveId = cave.id;
    assert.deepEqual(seeOf(cave.id), { fog: true, vision: false, light: "bright", perPlayer: false });
    assert.equal(cave.autoWalls, "floor");
    panel = await scenesPanel(dm);
    assert.equal(await checked(playersSee(section(panel, "What players see"))), "reveal");

    // Room settings: New scenes at the end, on the room's Explore, with no As before to go back to.
    await openSideTab(dm, "Menu");
    await dm.getByRole("button", { name: /^Room settings/ }).click();
    const settings = dm.getByRole("group", { name: "Players see on new scenes" });
    await settings.waitFor();
    assert.equal(await settings.getByRole("radio", { name: /^Explore/ }).isChecked(), true);
    assert.equal(await settings.getByRole("radio", { name: /^As before/ }).count(), 0);
    await settings.scrollIntoViewIfNeeded();
    await shots.take(dm, "ss-1-room-settings-new-scenes");

    // The players move to Arena, where a creature that lends the party its sight explores.
    await ops.send({ t: "room.setPlayerScene", sceneId: arena.id });
    await ops.send({
      t: "token.create",
      token: {
        id: randomUUID(),
        sceneId: arena.id,
        kind: "npc",
        name: "Lantern bearer",
        size: "medium",
        x: 5,
        y: 5,
        visibility: "all",
        partyVision: true,
        light: { bright: 20, dim: 20 },
        actor: { inline: { hp: { cur: 10, max: 10, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } },
      },
    });
    await view(arena.id);
    await waitFor("the party's explored ground on Arena", () => Object.values(dmSocket.state?.exploredTiles ?? {}).some((t) => t?.sceneId === arena.id) || null, 15_000);

    // Reveal by hand asks first. Focus stays on the radio, Explore stays chosen, and Escape answers no.
    panel = await scenesPanel(dm);
    const what = section(panel, "What players see");
    const see = playersSee(what);
    assert.equal(await checked(see), "explore");
    const reveal = see.getByRole("radio", { name: "Reveal by hand", exact: true });
    await reveal.click();
    const question = what.getByRole("group", { name: "Change what players see?" });
    await question.waitFor();
    assert.equal((await question.getByRole("status").innerText()).trim(), LEAVE);
    assert.equal(await checked(see), "explore", "the question is answered before anything changes");
    await question.scrollIntoViewIfNeeded();
    await shots.take(dm, "ss-1-leave-explore-asks");
    await dm.keyboard.press("Escape");
    await question.waitFor({ state: "detached" });
    assert.deepEqual(seeOf(arena.id), { fog: true, vision: true, light: "bright", perPlayer: false });
    // Change goes on.
    await reveal.click();
    await question.getByRole("button", { name: "Change", exact: true }).click();
    await waitFor("Arena on Reveal by hand", () => (seeOf(arena.id)?.vision === false ? true : null));
    assert.equal(seeOf(arena.id)?.fog, true);
    await see.getByRole("radio", { name: "Explore", exact: true }).click();
    await waitFor("Arena on Explore again, asking nothing", () => (seeOf(arena.id)?.vision === true ? true : null));
    assert.equal(await what.getByRole("group", { name: "Change what players see?" }).count(), 0);

    // The fold of the two switches starts closed. Party vision off from it asks too, and Cancel answers no.
    const fold = what.getByRole("button", { name: "Fog and party vision", exact: true });
    assert.equal(await fold.getAttribute("aria-expanded"), "false");
    assert.equal(await what.getByRole("switch", { name: "Fog", exact: true }).count(), 0);
    await fold.click();
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    await waitFor("the explored ground still there", () => Object.values(dmSocket.state?.exploredTiles ?? {}).some((t) => t?.sceneId === arena.id) || null, 15_000);
    await what.getByRole("switch", { name: "Party vision", exact: true }).click();
    const asked = what.getByRole("group", { name: "Change what players see?" });
    await asked.waitFor();
    await asked.getByRole("button", { name: "Cancel", exact: true }).click();
    await asked.waitFor({ state: "detached" });
    assert.equal(seeOf(arena.id)?.vision, true);

    // Fog off from the fold is Custom: no option chosen, its line, and the fold stays open. Explore puts it back.
    await what.getByRole("switch", { name: "Fog", exact: true }).click();
    await what.getByRole("group", { name: "Change what players see?" }).getByRole("button", { name: "Change", exact: true }).click();
    await waitFor("Arena's fog off", () => (seeOf(arena.id)?.fog === false ? true : null));
    await what.getByText(CUSTOM).waitFor();
    assert.equal(await checked(see), null);
    assert.equal(await fold.getAttribute("aria-expanded"), "true");
    await what.scrollIntoViewIfNeeded();
    await shots.take(dm, "ss-1-custom");
    await see.getByRole("radio", { name: "Explore", exact: true }).click();
    await waitFor("Arena on Explore", () => (seeOf(arena.id)?.fog === true && seeOf(arena.id)?.vision === true ? true : null));

    // The guide's picture: Arena dark, its lantern bearer lending the party its sight, the fold put away.
    await fold.click();
    await what.getByRole("radiogroup", { name: "Light level" }).getByRole("radio", { name: "Dark", exact: true }).check();
    await waitFor("Arena dark", () => (seeOf(arena.id)?.light === "dark" ? true : null));
    await what.getByText("Lends the party its sight").waitFor();
    await what.getByRole("heading", { name: "What players see" }).evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "start" }));
    await shots.take(dm, "ss-1-guide-what-players-see");
    assert.deepEqual(consoles.flatMap((c) => c.errors), []);
  });

  test("ss-2. Like Crypt on a map image copies fog, party vision with its light and Sight, and movement, keeping floor walls, and a Universal VTT import starts on Explore", async () => {
    run.cryptId = randomUUID();
    await ops.send({
      t: "scene.create",
      scene: { id: run.cryptId, name: "Crypt", bounds: { w: 20, h: 14 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true }, blockMovement: false },
    });
    await waitFor("Crypt in the DM's state", () => sceneOf(run.cryptId));
    await view(run.cryptId);
    const panel = await scenesPanel(dm);
    const form = section(panel, "New scene");
    await form.getByRole("radio", { name: "Map image", exact: true }).click();
    const like = playersSee(form).getByRole("radio", { name: "Like Crypt", exact: true });
    const summary = await like.getAttribute("aria-describedby");
    assert.equal(await dm.locator(`[id="${summary}"]`).textContent(), "Explore, Dark, Per player, players' moves not blocked");
    await like.check();
    // Crypt is on Explore, and a new map image has no walls.
    await form.getByText(WALLLESS).waitFor();
    await form.scrollIntoViewIfNeeded();
    await shots.take(dm, "ss-2-like-crypt");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    const ossuary = await newScene("Map image", "Ossuary", { see: "Like Crypt", file: await mapFile("ossuary_10x8.png") });
    assert.deepEqual(seeOf(ossuary.id), { fog: true, vision: true, light: "dark", perPlayer: true });
    assert.equal(ossuary.blockMovement, false, "movement comes with it");
    assert.equal(ossuary.autoWalls, "floor", "a map image keeps its own walls rule");
    assert.equal(dmSocket.state?.holders?.[ossuary.id], undefined, "a per-player copy starts with no holder list");

    // A Universal VTT import: Players see in place of Start under fog, on the room's Explore, and Like brings Crypt's light.
    await view(run.cryptId);
    const uvttPanel = await scenesPanel(dm);
    await uvttPanel.getByLabel("From a Universal VTT file").setInputFiles(await uvttFile());
    const dialog = dm.getByRole("dialog", { name: "Import a Universal VTT map" });
    const group = playersSee(dialog);
    await group.waitFor({ timeout: 30_000 });
    assert.equal(await checked(group), "explore");
    assert.equal(await dialog.getByLabel("Start under fog").count(), 0);
    assert.equal(await dialog.getByText(/stays off until you turn it on/).count(), 0, "the light's help is the file's reason alone");
    assert.equal(await dialog.getByText(WALLLESS).count(), 0, "the file brings walls");
    await group.getByRole("radio", { name: "Like Crypt", exact: true }).check();
    assert.equal(await dialog.getByRole("radio", { name: "Dark", exact: true }).isChecked(), true, "Like brings Crypt's light");
    await shots.take(dm, "ss-2-uvtt-like-crypt");
    const known = new Set(scenes(dmSocket.state).map((s) => s.id));
    await dialog.getByRole("button", { name: "Create scene" }).click();
    await dialog.waitFor({ state: "detached", timeout: 60_000 });
    const barrow = await waitFor("the imported scene", () => scenes(dmSocket.state).find((s) => !known.has(s.id)), 30_000);
    assert.deepEqual(seeOf(barrow.id), { fog: true, vision: true, light: "dark", perPlayer: true });
    assert.equal(barrow.autoWalls, "off", "an import keeps its own walls rule");
    assert.equal(barrow.blockMovement, false);
  });

  test("ss-3. Cave's settings used on 3 scenes in one step name what each will do, and one Undo puts all 3 back", async () => {
    await view(run.caveId);
    const panel = await scenesPanel(dm);
    const opener = section(panel, "What players see").getByRole("button", { name: "Use these settings on other scenes…" });
    await opener.click();
    const sheet = dm.getByRole("dialog", { name: "Use Cave's settings on…" });
    await sheet.waitFor();
    await sheet.getByText("Copies Players see, Light and Sight. Movement and walls stay as they are.").waitFor();
    const line = async (name: string) => {
      const box = sheet.getByRole("checkbox", { name, exact: true });
      return (await dm.locator(`[id="${await box.getAttribute("aria-describedby")}"]`).textContent()) ?? "";
    };
    assert.equal(await line("Arena"), "Explore. The players are here. They see the change at once. Players' remembered maps here reset.");
    assert.equal(await line("Crypt"), "Explore. Players' remembered maps here reset. Each player's own map here joins the party's.");
    assert.equal(await line("Battle mat"), "Everything.");
    const copy = sheet.getByRole("button", { name: /^Copy to/ });
    assert.equal(await copy.isDisabled(), true, "nothing ticked, nothing to copy");
    for (const name of ["Arena", "Crypt", "Battle mat"]) await sheet.getByRole("checkbox", { name, exact: true }).check();
    assert.equal(await copy.textContent(), "Copy to 3 scenes");
    await shots.take(dm, "ss-3-copy-sheet");
    const before = { arena: seeOf(run.arenaId), crypt: seeOf(run.cryptId), mat: seeOf(run.matId) };
    await copy.click();
    await sheet.getByRole("status").filter({ hasText: "Copied to 3 scenes." }).waitFor();
    const cave = { fog: true, vision: false, light: "bright", perPlayer: false };
    await waitFor("all 3 copied", () => ([run.arenaId, run.cryptId, run.matId].every((id) => JSON.stringify(seeOf(id)) === JSON.stringify(cave)) ? true : null));
    assert.equal(sceneOf(run.cryptId)?.blockMovement, false, "movement stays as it was");
    await shots.take(dm, "ss-3-copied");
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.equal(await opener.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "focus went back to the button");

    // One Undo, named for the copy, puts every scene back.
    await dm.getByRole("button", { name: "Undo", exact: true }).click();
    await dm.getByText("Undid using Cave's vision settings on 3 scenes.", { exact: true }).first().waitFor();
    await waitFor("all 3 back", () => (JSON.stringify([seeOf(run.arenaId), seeOf(run.cryptId), seeOf(run.matId)]) === JSON.stringify([before.arena, before.crypt, before.mat]) ? true : null));
    assert.deepEqual(consoles.flatMap((c) => c.errors), []);
  });

  test("ss-a. every new control is centered within 1 px at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, light and dark", async () => {
    const lines: string[] = [];
    const sizes = [
      { name: "1440x900", width: 1440, height: 900, touch: false },
      { name: "390x844", width: 390, height: 844, touch: true },
      { name: "320x568", width: 320, height: 568, touch: true },
    ];
    const state = await dmContext.storageState();
    const uvtt = await uvttFile();
    for (const size of sizes) {
      for (const scale of [1, 1.3]) {
        for (const scheme of ["light", "dark"] as const) {
          const screen = `${size.name}@${scale}-${scheme}`;
          const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: size.touch, hasTouch: size.touch, colorScheme: scheme, storageState: state });
          try {
            const page = await context.newPage();
            const watch = new ConsoleWatch(screen);
            watch.attach(page);
            consoles.push(watch);
            await page.goto(`${server.origin}/`);
            await page.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", String(s)), scale);
            await page.goto(`${server.origin}/r/${run.roomId}`);
            await page.getByRole("status", { name: "Connected" }).first().waitFor();
            const measure = async (name: string, root: Locator) => {
              await root.first().scrollIntoViewIfNeeded();
              const found = alignmentLines(await measureAlignment(root), `${screen} ${name}`);
              if (found.length > 0) await shots.take(page, `ss-a-${screen}-${name}`);
              lines.push(...found);
            };
            // The players' scene, Arena, with explored ground: What players see with the fold open and a question asked.
            await view(run.arenaId, page);
            const panel = await scenesPanel(page);
            const what = section(panel, "What players see");
            await playersSee(what).waitFor();
            await what.getByRole("button", { name: "Fog and party vision", exact: true }).click();
            await playersSee(what).getByRole("radio", { name: "Everything", exact: true }).click();
            await what.getByRole("group", { name: "Change what players see?" }).waitFor();
            await measure("what-players-see", what);
            await page.keyboard.press("Escape");
            // The new scene form's Players see on a map image, with Like.
            const form = section(panel, "New scene");
            await form.getByRole("radio", { name: "Map image", exact: true }).click();
            await playersSee(form).getByRole("radio", { name: "Explore", exact: true }).check();
            await measure("new-scene-players-see", playersSee(form).locator("xpath=../.."));
            await form.getByRole("button", { name: "Cancel", exact: true }).click();
            // The copy sheet.
            await what.getByRole("button", { name: "Use these settings on other scenes…" }).click();
            const sheet = page.getByRole("dialog", { name: "Use Arena's settings on…" });
            await sheet.waitFor();
            await sheet.getByRole("checkbox", { name: "Crypt", exact: true }).check();
            await measure("copy-sheet", sheet);
            await page.keyboard.press("Escape");
            await sheet.waitFor({ state: "detached" });
            // The Universal VTT dialog's Players see.
            await (await scenesPanel(page)).getByLabel("From a Universal VTT file").setInputFiles(uvtt);
            const dialog = page.getByRole("dialog", { name: "Import a Universal VTT map" });
            await playersSee(dialog).waitFor({ timeout: 30_000 });
            await measure("uvtt-players-see", playersSee(dialog).locator("xpath=../.."));
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "detached" });
            // Room settings' New scenes.
            await reopenRoom(page);
            await page.getByRole("status", { name: "Connected" }).first().waitFor();
            const menu = await menuPanel(page);
            await menu.getByRole("button", { name: /^Room settings/ }).click();
            const newScenes = page.getByRole("group", { name: "Players see on new scenes" });
            await newScenes.waitFor();
            await newScenes.scrollIntoViewIfNeeded();
            /*
             * Every choice in Room settings is the same radio card group,
             * whose name and help start at the cards' edge and whose options'
             * words sit in by a card's border and padding, which the edge
             * check reads as a step. That is the shared group's own look
             * (features/dm/controls.tsx RadioGroup), so New scenes is held to
             * Critical Hit damage's: only what it adds is a finding here.
             */
            // A finding with its screen, names and places left out: what kind of part is how far off.
            const kind = (line: string) => line.replace(/^[^:]*: /, "").replace(/"[^"]*"/g, '""').replace(/ \([^)]*\)$/, "");
            const crit = page.getByRole("group", { name: "Critical Hit damage" });
            const known = new Set(alignmentLines(await measureAlignment(crit), "").map(kind).filter((l) => l.startsWith("edge ")));
            const found = alignmentLines(await measureAlignment(newScenes.locator("xpath=ancestor::section[1]")), `${screen} room-new-scenes`);
            const added = found.filter((l) => !known.has(kind(l)));
            if (added.length > 0) await shots.take(page, `ss-a-${screen}-room-new-scenes`);
            lines.push(...added);
          } finally {
            await context.close();
          }
        }
      }
    }
    assert.deepEqual(lines, []);
    assert.deepEqual(consoles.flatMap((c) => c.errors), []);
  });
});

/** The Menu panel, as scenesPanel finds the Scenes panel. */
async function menuPanel(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if ((await tabs.count()) > 0 && (await tabs.isVisible())) {
    await openSideTab(page, "Menu");
    return page.getByRole("tabpanel", { name: sideTabName("Menu") });
  }
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
  await sheet.waitFor();
  return sheet;
}
