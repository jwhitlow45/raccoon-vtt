import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { RoomState, Scene } from "#shared/model.ts";
import { floorRoot } from "../client/features/floors/ids.ts";
import { ConsoleWatch, OpSocket, openSceneGroup, openSideTab, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { undoSetup } from "./helpers/undoScope.ts";

/**
 * Several floors, the DM's building side (docs/design/design-v1-floors.md
 * 7.1 and 7.4, lane FLR-E), in a room made as a DM makes one, on a computer.
 *
 * - FLRB-1: a scene with one floor lists none and offers the two adds.
 *   Add a floor above names the scene's first floor "Ground floor" and the new
 *   one "New floor", shows it, and opens its page on the name, selected. The
 *   name, the height, Move up and Move down and Back to Floors each change
 *   the scene's floors, and the group lists them top first. Two more adds
 *   go beside the floor shown, below Ground and above Upper floor.
 * - FLRB-2: Move to floor lists the other floors of a creature's scene,
 *   warns that moving a party member opens a floor players have not
 *   reached, is off where the creature's full space lies outside the floor,
 *   lands the creature on the floor, opens it and is one undo step.
 * - FLRB-3: a floor's page says where the players stand, shows or hides the
 *   floor, refuses to hide the start floor and to remove the main floor with
 *   its reasons, removes a floor on a second tap and Setup history's Undo
 *   setup brings it back.
 * - FLRB-4: Delete from the scene's menu says how many floors go with the
 *   scene, and is refused while the players start on one of them.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-three. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 63;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-build-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const WIDE = { width: 1280, height: 800 };
const BOUNDS = { w: 20, h: 14 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles: ConsoleWatch[] = [];

const run = { roomId: "", roomName: "The Sunken Keep", matId: "", towerId: "", thornId: randomUUID(), goblinId: randomUUID() };

function state(): RoomState {
  return dmSocket.state as RoomState;
}

/** The scenes named `name`, bottom floor first: every floor of a scene is named for the scene. */
function floorsOf(name: string): Scene[] {
  return Object.values(state().scenes)
    .filter((s): s is Scene => s !== undefined && s.name === name)
    .sort((a, b) => (a.floor?.level ?? 0) - (b.floor?.level ?? 0));
}

/** The floor of Tower with this floor name. */
function floorNamed(name: string): Scene | undefined {
  return floorsOf("Tower").find((s) => s.floor?.name === name);
}

/** The Scenes panel on a computer: a side tab. */
async function scenesPanel(page: Page): Promise<Locator> {
  await openSideTab(page, "Scenes");
  return page.getByRole("tabpanel", { name: sideTabName("Scenes") });
}

/** The Floors group, open, with its page or its list. */
async function floorsGroup(page: Page): Promise<Locator> {
  const panel = await scenesPanel(page);
  const group = await openSceneGroup(panel, "Floors");
  return group;
}

/** Shows the DM a floor of Tower: its page's Show this floor, then back to the list. */
async function showFloorNamed(name: string): Promise<void> {
  const group = await floorsGroup(dm);
  const back = dm.locator(floorRoot("page")).getByRole("button", { name: "Back to Floors" });
  if ((await back.count()) > 0) await back.click();
  await floorRow(group, name).click();
  await dm.locator(floorRoot("page")).getByRole("button", { name: "Show this floor" }).click();
  await dm.locator(floorRoot("page")).getByRole("button", { name: "Back to Floors" }).click();
  await waitFor(`${name} shown`, async () => ((await floorRow(group, name).getAttribute("aria-label"))?.includes(", shown") ? true : null));
}

/** A floor's row in the group, whatever its mark: named for the floor. */
function floorRow(group: Locator, name: string): Locator {
  return group.getByRole("button", { name: new RegExp(`^${name},`) });
}

function actor() {
  return { hp: { cur: 10, max: 10, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

function creature(id: string, sceneId: string, name: string, over: Record<string, unknown>) {
  return { id, sceneId, kind: "npc", name, size: "medium", x: 4, y: 4, visibility: "all", actor: { inline: actor() }, ...over };
}

/** The token's bar, a dialog named for it. */
async function selectToken(name: string, cell: { x: number; y: number }): Promise<Locator> {
  await tapCell(dm, BOUNDS, cell);
  const bar = dm.getByRole("dialog", { name: `${name} actions` });
  await bar.waitFor();
  return bar;
}

/** Opens Move to floor in a bar and returns its list. */
async function moveList(bar: Locator): Promise<Locator> {
  const open = bar.getByRole("button", { name: /^(Move to floor…|Floor…)$/ });
  await open.scrollIntoViewIfNeeded();
  await open.click();
  const list = bar.locator(floorRoot("move-list"));
  await list.waitFor();
  return list;
}

describe("raccoon-vtt several floors: the DM's building side", { timeout: 900_000 }, () => {
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

  test("FLRB-1. a scene with one floor lists none, Add a floor above names both, shows the new floor and opens its page on the name, and the page changes the stack", async () => {
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

    // Tower is prepared in private: the players stay on the mat.
    run.towerId = randomUUID();
    await ops.send({ t: "scene.create", scene: { id: run.towerId, name: "Tower", bounds: BOUNDS, fogEnabled: false, blockMovement: false } });
    await ops.send({ t: "token.create", token: creature(run.thornId, run.towerId, "Thorn", { partyVision: true, x: 4, y: 4 }) });
    await ops.send({ t: "token.create", token: creature(run.goblinId, run.towerId, "Goblin", { kind: "monster", x: 12, y: 5 }) });
    let panel = await scenesPanel(dm);
    await panel.getByRole("button", { name: /^Tower(?![A-Za-z])/ }).first().click();
    await waitFor("the DM on Tower", () => dmSocket.you?.sceneId === run.towerId || null);

    let group = await floorsGroup(dm);
    await group.getByText("Tower has one floor.", { exact: false }).waitFor();
    assert.equal(await group.getByRole("list").count(), 0, "one floor, no list");
    assert.equal(await group.locator('[data-search="scenes.floor.height"]').count(), 0);
    const add = group.getByRole("button", { name: "Add a floor above" });
    await add.click();
    await waitFor("Tower's two floors", () => (floorsOf("Tower").length === 2 ? true : null));
    let [ground, upper] = floorsOf("Tower") as [Scene, Scene];
    assert.deepEqual([ground.floor?.name, ground.floor?.level, ground.floor?.of], ["Ground floor", 0, ground.id]);
    assert.deepEqual([upper.floor?.name, upper.floor?.level, upper.floor?.of], ["New floor", 1, ground.id]);
    assert.equal(upper.folder, undefined, "only the main floor is filed in a folder");

    // The page of the new floor: its name, selected.
    const page = dm.locator(floorRoot("page"));
    await page.waitFor();
    const name = page.getByRole("textbox", { name: "Floor name" });
    assert.equal(await name.inputValue(), "New floor");
    assert.equal(await name.evaluate((el) => (el as unknown as { selectionStart: number; selectionEnd: number; value: string }).selectionEnd - (el as unknown as { selectionStart: number }).selectionStart), "New floor".length, "the name is selected");
    await name.fill("Upper floor");
    await name.press("Enter");
    await waitFor("Upper floor's name", () => (floorNamed("Upper floor") ? true : null));
    assert.deepEqual(floorsOf("Tower").map((s) => s.name), ["Tower", "Tower"], "the scene's name is the same on every floor");

    // The height above the floor below: 10 ft, + takes 5, never below 5.
    upper = floorNamed("Upper floor")!;
    assert.equal(upper.floor?.height, 10);
    await page.getByRole("button", { name: "Raise Upper floor by 5 feet" }).click();
    await waitFor("Upper floor 15 ft", () => (floorNamed("Upper floor")?.floor?.height === 15 ? true : null));
    await page.getByRole("button", { name: "Lower Upper floor by 5 feet" }).click();
    await page.getByRole("button", { name: "Lower Upper floor by 5 feet" }).click();
    await waitFor("Upper floor 5 ft", () => (floorNamed("Upper floor")?.floor?.height === 5 ? true : null));
    assert.equal(await page.getByRole("button", { name: "Lower Upper floor by 5 feet" }).isDisabled(), true, "5 ft is the least");
    await page.getByRole("button", { name: "Raise Upper floor by 5 feet" }).click();
    await shots.take(dm, "flrb-1-floor-page");

    // Move down puts it below Ground, Move up puts it back. The top floor has no Move up.
    assert.equal(await page.getByRole("button", { name: "Move up" }).isDisabled(), true);
    await page.getByRole("button", { name: "Move down" }).click();
    await waitFor("Upper floor below Ground", () => (floorNamed("Upper floor")?.floor?.level === 0 && floorNamed("Ground floor")?.floor?.level === 1 ? true : null));
    assert.equal(await page.getByRole("button", { name: "Height above the floor below" }).count(), 0);
    await page.getByRole("button", { name: "Move up" }).click();
    await waitFor("Upper floor above Ground", () => (floorNamed("Upper floor")?.floor?.level === 1 ? true : null));

    // Back to Floors lists them top first, the floor on screen marked shown.
    await page.getByRole("button", { name: "Back to Floors" }).click();
    group = await floorsGroup(dm);
    const rows = await group.getByRole("listitem").getByRole("button").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    assert.deepEqual(rows, ["Upper floor, Not reached yet, shown. Open its page", "Ground floor, Not reached yet. Open its page"]);
    await shots.take(dm, "flrb-1-floors-group");

    // A second add below Ground, and one more above Upper floor: each goes beside the floor on screen, and the reducer names them without a clash.
    await showFloorNamed("Ground floor");
    await (await floorsGroup(dm)).getByRole("button", { name: "Add a floor below" }).click();
    await waitFor("three floors", () => (floorsOf("Tower").length === 3 ? true : null));
    await dm.locator(floorRoot("page")).getByRole("button", { name: "Back to Floors" }).click();
    await showFloorNamed("Upper floor");
    await (await floorsGroup(dm)).getByRole("button", { name: "Add a floor above" }).click();
    await waitFor("four floors", () => (floorsOf("Tower").length === 4 ? true : null));
    assert.deepEqual(floorsOf("Tower").map((s) => s.floor?.level), [0, 1, 2, 3]);
    assert.deepEqual(floorsOf("Tower").map((s) => s.floor?.name), ["New floor", "Ground floor", "Upper floor", "New floor 2"], "bottom first, each add beside the floor shown");
  });

  test("FLRB-2. Move to floor lists the other floors, warns before it opens one to the players, is off where a creature does not fit, and is one undo step", async () => {
    // Four floors from FLRB-1: the players start on Ground, and the top floor becomes Attic, too small for the goblin.
    const ground = floorNamed("Ground floor")!;
    const attic = floorsOf("Tower").find((s) => s.floor?.level === 3)!;
    await ops.send({ t: "scene.update", sceneId: attic.id, patch: { floor: { name: "Attic" } } });
    await ops.send({ t: "scene.update", sceneId: attic.id, patch: { bounds: { w: 6, h: 6 } } });
    await ops.send({ t: "room.setPlayerScene", sceneId: ground.id });
    await waitFor("Attic", () => (floorNamed("Attic") ? true : null));
    await showFloorNamed("Ground floor");

    // Thorn is a party member on Ground. Attic and Upper floor are not reached, and Attic is too small for the goblin.
    let bar = await selectToken("Thorn", { x: 4, y: 4 });
    let list = await moveList(bar);
    const attic1 = list.getByRole("button", { name: /^Attic/ });
    const upperRow = list.getByRole("button", { name: /^Upper floor/ });
    await attic1.waitFor();
    assert.match((await attic1.innerText()).replace(/\s+/g, " "), /Players haven't reached Attic\. Moving Thorn there opens it to them\./);
    assert.match((await upperRow.innerText()).replace(/\s+/g, " "), /Players haven't reached Upper floor\. Moving Thorn there opens it to them\./);
    assert.equal(await list.getByRole("button", { name: /^Ground floor/ }).count(), 0, "the floor Thorn stands on is not offered");
    await shots.take(dm, "flrb-2-move-to-floor");
    await upperRow.click();
    await waitFor("Thorn on Upper floor", () => (state().tokens[run.thornId]?.sceneId === floorNamed("Upper floor")!.id ? true : null));
    assert.deepEqual([state().tokens[run.thornId]?.x, state().tokens[run.thornId]?.y], [4, 4], "the same squares");
    await waitFor("Upper floor opened to the players", () => (state().openFloors?.[floorNamed("Upper floor")!.id] ? true : null));

    // One undo step puts Thorn back on Ground. The floor stays opened: marks are bookkeeping outside undo.
    await dm.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("Thorn back on Ground", () => (state().tokens[run.thornId]?.sceneId === ground.id ? true : null));

    // A monster off the party's footing warns of nothing, and Attic is off for the goblin: it stands at 12, 5 and Attic is 6 across.
    await dm.keyboard.press("Escape");
    await showFloorNamed("Ground floor");
    bar = await selectToken("Goblin", { x: 12, y: 5 });
    list = await moveList(bar);
    const atticOff = list.getByRole("button", { name: /^Attic/ });
    assert.equal(await atticOff.isDisabled(), true);
    assert.match((await atticOff.innerText()).replace(/\s+/g, " "), /Outside Attic/);
    const goblinUpper = list.getByRole("button", { name: /^Upper floor/ });
    assert.equal((await goblinUpper.innerText()).includes("Players haven't reached"), false, "a monster opens nothing");
    await shots.take(dm, "flrb-2-outside-attic");
  });

  test("FLRB-3. a floor's page says where the players stand, shows and hides the floor, gives reasons where Hide and Remove are off, and Remove takes a second tap that Undo reverses", async () => {
    const ground = floorNamed("Ground floor")!;
    let group = await floorsGroup(dm);
    // Ground is the start floor: players are here, Hide is off with its reason.
    await floorRow(group, "Ground floor").click();
    let page = dm.locator(floorRoot("page"));
    await page.getByText("Players are here.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Hide from players" }).isDisabled(), true);
    await page.getByText("The players start here.", { exact: true }).waitFor();
    await page.getByText(`Tower was made with this floor. Delete Tower from its menu to remove every floor.`, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove floor" }).isDisabled(), true);
    await page.getByRole("button", { name: "Back to Floors" }).click();

    // Attic: not reached. Show to players opens it, Hide from players closes it.
    group = await floorsGroup(dm);
    await floorRow(group, "Attic").click();
    page = dm.locator(floorRoot("page"));
    const atticId = floorNamed("Attic")!.id;
    await page.getByText("Players have not reached this floor.", { exact: true }).waitFor();
    await page.getByText("Players get a floor once a party member stands on it, or once you show it.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Show to players" }).click();
    await waitFor("Attic shown", () => (state().openFloors?.[atticId] ? true : null));
    await page.getByText("Players have reached this floor.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Hide from players" }).click();
    await waitFor("Attic hidden", () => (state().openFloors?.[atticId] === undefined ? true : null));
    await page.getByText("Players have not reached this floor.", { exact: true }).waitFor();

    // Show this floor looks at it. The group's row says it is shown.
    await page.getByRole("button", { name: "Show this floor" }).click();
    await page.getByRole("button", { name: "Back to Floors" }).click();
    group = await floorsGroup(dm);
    await floorRow(group, "Attic").filter({ hasText: "Attic" }).waitFor();
    assert.match((await floorRow(group, "Attic").getAttribute("aria-label")) ?? "", /, shown\./);

    // Remove: the first tap arms, the second removes the floor with everything on it. Undo brings it back.
    await floorRow(group, "Attic").click();
    page = dm.locator(floorRoot("page"));
    const remove = page.getByRole("button", { name: "Remove floor" });
    await remove.click();
    assert.equal(floorsOf("Tower").length, 4, "one tap removes nothing");
    await page.getByRole("button", { name: "Tap again to remove" }).click();
    await waitFor("three floors", () => (floorsOf("Tower").length === 3 ? true : null));
    // Removing a floor is setup, so Setup history takes it back. The top bar's Undo takes back play.
    await undoSetup(dm);
    await waitFor("four floors again", () => (floorsOf("Tower").length === 4 ? true : null));
    assert.ok(floorNamed("Attic"), "Attic is back");
    assert.equal(floorNamed("Ground floor")!.id, ground.id);
  });

  test("FLRB-4. Delete from a scene's menu names the floors that go with it, and waits while the players start on one of them", async () => {
    const panel = await scenesPanel(dm);
    await panel.getByRole("button", { name: "More for Tower" }).click();
    const sheet = dm.getByRole("dialog", { name: "Tower" });
    await sheet.waitFor();
    // The players start on Ground, a floor of Tower.
    await sheet.getByText("Move the players to another scene first.", { exact: true }).waitFor();
    await dm.keyboard.press("Escape");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.matId });
    await panel.getByRole("button", { name: "More for Tower" }).click();
    const again = dm.getByRole("dialog", { name: "Tower" });
    await again.getByText("Removes every floor with its tokens, drawings, build and fog too.", { exact: true }).waitFor();
    await again.getByRole("button", { name: /^Delete/ }).click();
    await again.getByRole("button", { name: /^Delete Tower and its 4 floors/ }).click();
    await waitFor("Tower gone with its floors", () => (floorsOf("Tower").length === 0 ? true : null));
    assert.equal(Object.keys(state().tokens).includes(run.thornId), false, "what stood on it goes too");
  });

  test("FLRB-9. the page logged no console errors", () => {
    for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
