import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { FloorLink, RoomState, Scene } from "#shared/model.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { floorRoot, LINK_PANE_ATTR } from "../client/features/floors/ids.ts";
import { ConsoleWatch, dragCells, OpSocket, openSceneGroup, openSideTab, pagePoint, pickOption, pickTool, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { undoSetup } from "./helpers/undoScope.ts";

/**
 * Stairs and ladders, the DM's building side (docs/design/design-v1-floors.md
 * phase 2, 7 and 14, lane FL2-E), in a room made as a DM makes one, on a
 * computer.
 *
 * - FLRK-1: Between floors is no builder mode on a scene of one floor and is
 *   one once it has two. Its row holds Kind and To, To lists only the floors
 *   next to the one shown, the floor above first, and the hint names the kind.
 * - FLRK-2: a drag places a pair on the same squares of both floors and opens
 *   its pane. The pane changes the kind and the lock of both ends, says where
 *   players stand with the far floor, goes to that floor with the other end
 *   open and removes the pair on a second tap, which Setup history's Undo
 *   brings back. A tap on an end opens its pane, and a tap elsewhere places
 *   one square.
 * - FLRK-3: a drag is held to 4 by 4, and the draft's reason shows while the
 *   button is down and sends nothing: over another end, a wall, two heights,
 *   a pit trap, past the other floor's edge, and a 17th pair.
 * - FLRK-4: Add a floor above and below, Move up and Move down are off between
 *   two floors that stairs join, with the stairs' words, and on again once the
 *   pair is removed.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus sixty-four. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 64;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-links-build-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const WIDE = { width: 1280, height: 800 };
const BOUNDS = { w: 20, h: 14 };
const TOOL = "Map builder";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles: ConsoleWatch[] = [];

const run = { roomId: "", roomName: "The Sunken Keep", matId: "", towerId: "", upperId: "", atticId: "" };

function state(): RoomState {
  return dmSocket.state as RoomState;
}

function floorNamed(name: string): Scene | undefined {
  return Object.values(state().scenes).find((s): s is Scene => s !== undefined && s.name === "Tower" && s.floor?.name === name);
}

/** The stored ends, by id order. */
function ends(): FloorLink[] {
  return Object.values(state().floorLinks ?? {})
    .filter((l): l is FloorLink => l !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The end on a floor with these squares. */
function endOn(sceneId: string, x: number, y: number): FloorLink | undefined {
  return ends().find((l) => l.sceneId === sceneId && l.rect.x === x && l.rect.y === y);
}

async function scenesPanel(page: Page): Promise<Locator> {
  await openSideTab(page, "Scenes");
  return page.getByRole("tabpanel", { name: sideTabName("Scenes") });
}

/** Shows the DM a floor of Tower: its page's Go to this floor, then back to the list. */
async function showFloorNamed(name: string): Promise<void> {
  const panel = await scenesPanel(dm);
  const group = await openSceneGroup(panel, "Floors");
  const back = dm.locator(floorRoot("page")).getByRole("button", { name: "Back to Floors" });
  if ((await back.count()) > 0) await back.click();
  await group.getByRole("button", { name: new RegExp(`^${name},`) }).click();
  await dm.locator(floorRoot("page")).getByRole("button", { name: "Go to this floor" }).click();
  await dm.locator(floorRoot("page")).getByRole("button", { name: "Back to Floors" }).click();
  await waitFor(`${name} on screen`, async () => ((await group.getByRole("button", { name: new RegExp(`^${name},`) }).getAttribute("aria-label"))?.includes(", on screen") ? true : null));
}

/** The pane of an end, a dialog. */
function pane(): Locator {
  return dm.locator(`[${LINK_PANE_ATTR}]`);
}

/** The builder's one line under its row: the hint, or the note a refusal leaves. */
async function line(): Promise<string> {
  return (await dm.locator('[data-options-line="shown"]').first().innerText()).replace(/\s+/g, " ").trim();
}

/** Holds the button down over `to` after pressing at `from`, calls `during`, and lifts. */
async function holdDrag(from: { x: number; y: number }, to: { x: number; y: number }, during: () => Promise<void>): Promise<void> {
  const a = await pagePoint(dm, BOUNDS, { x: from.x + 0.5, y: from.y + 0.5 });
  const b = await pagePoint(dm, BOUNDS, { x: to.x + 0.5, y: to.y + 0.5 });
  await dm.mouse.move(a.x, a.y);
  await dm.mouse.down();
  await dm.mouse.move(a.x + (b.x - a.x) * 0.1, a.y + (b.y - a.y) * 0.1, { steps: 3 });
  await dm.mouse.move(b.x, b.y, { steps: 10 });
  try {
    await during();
  } finally {
    await dm.mouse.up();
  }
}

/**
 * The draft's color at a square's center, read from the map's canvases: "red" where the danger color shows, "clear" where the accent does, "none" where neither is drawn.
 */
async function drawnAt(cell: { x: number; y: number }): Promise<"red" | "clear" | "none"> {
  const p = await pagePoint(dm, BOUNDS, { x: cell.x + 0.5, y: cell.y + 0.5 });
  return dm.evaluate(([x, y]) => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { left: number; top: number; width: number; height: number }; width: number; height: number; getContext(k: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null }> } }).document;
    let seen: "red" | "clear" | "none" = "none";
    // Every layer is read, since the opaque ones under the draft would hide it from a read of the strongest pixel.
    for (const canvas of Array.from(doc.querySelectorAll(".konvajs-content canvas"))) {
      const r = canvas.getBoundingClientRect();
      const px = Math.round(((x! - r.left) / r.width) * canvas.width);
      const py = Math.round(((y! - r.top) / r.height) * canvas.height);
      const d = canvas.getContext("2d")?.getImageData(px, py, 1, 1).data;
      if (!d || d[3]! < 20) continue;
      if (d[0]! > 150 && d[1]! < 120 && d[2]! < 130) return "red";
      if (d[0]! > 150 && d[1]! > 120 && d[2]! < 120) seen = "clear";
    }
    return seen;
  }, [p.x, p.y] as const);
}

describe("raccoon-vtt stairs and ladders: the DM's building side", { timeout: 900_000 }, () => {
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

  test("FLRK-1. Between floors is no mode on a scene of one floor and one once it has two, with Kind and To, To naming only the floors next to the one shown, the floor above first", async () => {
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

    run.towerId = randomUUID();
    await ops.send({ t: "scene.create", scene: { id: run.towerId, name: "Tower", bounds: BOUNDS, fogEnabled: false, blockMovement: false } });
    const panel = await scenesPanel(dm);
    await panel.getByRole("button", { name: /^Tower(?![A-Za-z])/ }).first().click();
    await waitFor("the DM on Tower", () => dmSocket.you?.sceneId === run.towerId || null);

    // One floor: the mode picker has no Between floors.
    await pickTool(dm, TOOL);
    const bar = dm.getByRole("toolbar", { name: `${TOOL} options` });
    await bar.waitFor();
    await bar.getByRole("button", { name: /^Builder mode:/ }).first().click();
    const picker = dm.getByRole("dialog", { name: "Builder mode" });
    await picker.getByRole("radio", { name: "Brush", exact: true }).waitFor();
    assert.equal(await picker.getByRole("radio", { name: "Between floors", exact: true }).count(), 0, "a scene of one floor has no mode between floors");
    await dm.keyboard.press("Escape");

    // Two more floors: Upper floor and Attic, in order.
    run.upperId = randomUUID();
    run.atticId = randomUUID();
    await ops.send({ t: "scene.create", scene: { id: run.upperId, name: "Tower", bounds: BOUNDS }, floor: { beside: run.towerId, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: run.upperId, patch: { floor: { name: "Upper floor" } } });
    await ops.send({ t: "scene.create", scene: { id: run.atticId, name: "Tower", bounds: BOUNDS }, floor: { beside: run.upperId, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: run.atticId, patch: { floor: { name: "Attic" } } });
    await waitFor("Tower's three floors", () => (floorNamed("Attic") && floorNamed("Upper floor") ? true : null));
    await showFloorNamed("Ground floor");

    await pickOption(dm, TOOL, "Builder mode", "Between floors");
    await bar.getByRole("button", { name: /^Builder mode: Between floors/ }).waitFor();
    assert.equal(await line(), "Drag over squares to place stairs.");
    await bar.getByRole("button", { name: "Kind: Stairs" }).waitFor();
    // On Ground floor the only floor next to it is Upper floor: Attic is two levels away.
    const to = bar.getByRole("button", { name: /^To:/ });
    assert.match((await to.first().innerText()).replace(/\s+/g, " "), /Up to Upper floor/);
    await to.first().click();
    let popover = dm.getByRole("dialog", { name: "To" });
    assert.deepEqual(await popover.getByRole("radio").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.parentElement?.textContent?.trim())), ["Up to Upper floor"]);
    await dm.keyboard.press("Escape");

    // On Upper floor both neighbors, the floor above first. The kind carries into the hint.
    await showFloorNamed("Upper floor");
    await pickOption(dm, TOOL, "Kind", "Ladder");
    assert.equal(await line(), "Drag over squares to place a ladder.");
    await bar.getByRole("button", { name: /^To:/ }).first().click();
    popover = dm.getByRole("dialog", { name: "To" });
    await popover.getByRole("radio", { name: "Up to Attic", exact: true }).waitFor();
    assert.deepEqual(await popover.getByRole("radio").evaluateAll((els) => els.map((el) => (el as unknown as { labels: { textContent: string }[] }).labels[0]?.textContent?.trim())), ["Up to Attic", "Down to Ground floor"]);
    await shots.take(dm, "flrk-1-to-picker");
    await dm.keyboard.press("Escape");
    await pickOption(dm, TOOL, "Kind", "Stairs");
    await showFloorNamed("Ground floor");
  });

  test("FLRK-2. a drag places a pair on both floors and opens its pane, whose Kind, Locked, Go to and Remove change both ends, and a tap on an end opens its pane while a tap elsewhere places one square", async () => {
    await dragCells(dm, BOUNDS, { x: 6, y: 6 }, { x: 7, y: 6 });
    await waitFor("a pair of ends", () => (ends().length === 2 ? true : null));
    const [a, b] = ends() as [FloorLink, FloorLink];
    const ground = endOn(run.towerId, 6, 6)!;
    const upper = endOn(run.upperId, 6, 6)!;
    assert.deepEqual([ground.rect, upper.rect], [{ x: 6, y: 6, w: 2, h: 1 }, { x: 6, y: 6, w: 2, h: 1 }], "the same squares on both floors");
    assert.deepEqual([ground.to, upper.to], [run.upperId, run.towerId]);
    assert.deepEqual([a.kind, b.kind], ["stairs", "stairs"]);

    // The placed pair opens its pane, on Kind.
    await pane().waitFor();
    await pane().getByRole("heading", { name: "Stairs up to Upper floor" }).waitFor();
    assert.equal(await pane().getByRole("radio", { name: "Stairs" }).isChecked(), true);
    await pane().getByText('Players haven\'t reached Upper floor, so they see "Stairs up" here.', { exact: true }).waitFor();
    await shots.take(dm, "flrk-2-pane");

    // Kind changes both ends and the pane's title.
    await pane().getByRole("radio", { name: "Ladder" }).click();
    await waitFor("both ends a ladder", () => (ends().every((l) => l.kind === "ladder") ? true : null));
    await pane().getByRole("heading", { name: "Ladder up to Upper floor" }).waitFor();
    await pane().getByText('Players haven\'t reached Upper floor, so they see "Ladder up" here.', { exact: true }).waitFor();

    // Locked changes both ends too, and its help says what it does.
    const locked = pane().getByRole("switch", { name: "Locked" });
    await pane().getByText("Go up and Go down are off while it's locked. A party member who climbs opens the floor to players.", { exact: true }).waitFor();
    await locked.click();
    await waitFor("both ends locked", () => (ends().every((l) => l.locked === true) ? true : null));
    await locked.click();
    await waitFor("both ends unlocked", () => (ends().every((l) => l.locked !== true) ? true : null));

    // Go to Upper floor shows that floor with the other end's pane open.
    await pane().getByRole("button", { name: "Go to Upper floor" }).click();
    await pane().getByRole("heading", { name: "Ladder down to Ground floor" }).waitFor();
    assert.equal(await pane().getAttribute(LINK_PANE_ATTR), upper.id, "the pane is of the end on Upper floor");

    // Escape closes the pane, and a tap on the end opens it again.
    await dm.keyboard.press("Escape");
    await pane().waitFor({ state: "detached" });
    await tapCell(dm, BOUNDS, { x: 7, y: 6 });
    await pane().getByRole("heading", { name: "Ladder down to Ground floor" }).waitFor();

    // Remove takes a second tap, removes both ends, and Setup history's Undo brings them back.
    await pane().getByRole("button", { name: "Remove ladder" }).click();
    assert.equal(ends().length, 2, "one tap removes nothing");
    await pane().getByRole("button", { name: "Remove both ends" }).click();
    await waitFor("no ends", () => (ends().length === 0 ? true : null));
    await pane().waitFor({ state: "detached" });
    await undoSetup(dm);
    await waitFor("the pair back", () => (ends().length === 2 ? true : null));

    // A tap on empty squares places one square, on this floor and the one it leads to, and opens its pane.
    await showFloorNamed("Ground floor");
    await tapCell(dm, BOUNDS, { x: 12, y: 9 });
    await waitFor("a second pair", () => (ends().length === 4 ? true : null));
    assert.deepEqual(endOn(run.towerId, 12, 9)?.rect, { x: 12, y: 9, w: 1, h: 1 });
    assert.deepEqual(endOn(run.upperId, 12, 9)?.rect, { x: 12, y: 9, w: 1, h: 1 });
    await pane().waitFor();
    await dm.keyboard.press("Escape");
  });

  test("FLRK-3. a drag is held to 4 by 4, and the draft's reason shows while the button is down and sends nothing: another end, a wall, two heights, a pit trap, the other floor's edge and a 17th pair", async () => {
    const before = () => ends().length;
    // A draft over clear squares is drawn in the accent while the button is down, and nothing is drawn after.
    await holdDrag({ x: 2, y: 9 }, { x: 3, y: 9 }, async () => {
      await waitFor("the draft drawn", async () => ((await drawnAt({ x: 2, y: 9 })) === "clear" ? true : null));
    });
    await waitFor("the pair of that draft", () => (endOn(run.towerId, 2, 9) ? true : null));
    await dm.keyboard.press("Escape");
    for (const l of ends().filter((e) => e.rect.x === 2 && e.rect.y === 9)) await ops.send({ t: "floorLink.delete", linkId: l.id }).catch(() => {});
    await waitFor("that pair removed", () => (endOn(run.towerId, 2, 9) ? null : true));
    // 5 by 1 is held to 4 from the square the drag began on.
    await dragCells(dm, BOUNDS, { x: 2, y: 9 }, { x: 6, y: 9 });
    await waitFor("a pair of 4 by 1", () => (endOn(run.towerId, 2, 9) ? true : null));
    assert.deepEqual(endOn(run.towerId, 2, 9)?.rect, { x: 2, y: 9, w: 4, h: 1 });
    await dm.keyboard.press("Escape");

    const refuses = async (from: { x: number; y: number }, to: { x: number; y: number }, words: string) => {
      const count = before();
      await holdDrag(from, to, async () => {
        await waitFor(`"${words}"`, async () => ((await line()) === words ? true : null)).catch(async (err: Error) => {
          throw new Error(`${err.message}, the line reads "${await line()}"`);
        });
        // The draft is red while the rules refuse it.
        assert.equal(await drawnAt(from), "red", `${words}: the draft is not drawn red`);
      });
      // Nothing is sent, and the note stays after the lift.
      assert.equal(await line(), words);
      assert.equal(before(), count, `${words} sent a pair`);
      assert.equal(await pane().count(), 0, "a refused draft opens no pane");
    };

    // Over another end: the pair FLRK-2 made a ladder.
    await refuses({ x: 7, y: 5 }, { x: 7, y: 7 }, LINK_WORDS.overEnd("ladder", "Upper floor"));
    // A wall inside the squares, on Ground floor.
    await ops.send({ t: "build.edge", sceneId: run.towerId, edges: [{ key: "15,3,w", feature: { kind: "wall" } }] });
    await refuses({ x: 14, y: 3 }, { x: 15, y: 3 }, LINK_WORDS.wall("Ground floor"));
    // Two heights.
    await ops.send({ t: "build.height", sceneId: run.towerId, cells: ["15,5"], height: 5 });
    await refuses({ x: 14, y: 5 }, { x: 15, y: 5 }, LINK_WORDS.twoHeights("Ground floor"));
    // A pit trap on the other floor.
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, pit: { floor: -10 } };
    await ops.send({ t: "trap.create", trap: { id: randomUUID(), sceneId: run.upperId, name: "Pit", zone: { cells: [{ x: 15, y: 8, w: 1, h: 1 }] }, rig } });
    await refuses({ x: 14, y: 8 }, { x: 15, y: 8 }, LINK_WORDS.pit("Upper floor"));
    // Past the other floor's edge: Upper floor shrinks to 10 across, which the square at 12, 9 would not survive.
    await ops.send({ t: "floorLink.delete", linkId: endOn(run.towerId, 12, 9)!.id });
    await ops.send({ t: "scene.update", sceneId: run.upperId, patch: { bounds: { w: 10, h: 14 } } });
    await refuses({ x: 11, y: 1 }, { x: 12, y: 1 }, LINK_WORDS.pastEdge("Upper floor"));
    await ops.send({ t: "scene.update", sceneId: run.upperId, patch: { bounds: BOUNDS } });
    await shots.take(dm, "flrk-3-refused");

    // The draft is red while refused, then the squares are free again once the wall goes.
    await ops.send({ t: "build.edge", sceneId: run.towerId, edges: [{ key: "15,3,w", feature: null }] });
    await dragCells(dm, BOUNDS, { x: 14, y: 3 }, { x: 15, y: 3 });
    await waitFor("a pair where the wall was", () => (endOn(run.towerId, 14, 3) ? true : null));
    await dm.keyboard.press("Escape");

    // A 17th pair: the scene holds 16.
    const have = ends().length / 2;
    for (let i = have; i < 16; i++) {
      const x = i % 8;
      const y = i < 8 ? 0 : 1;
      await ops.send({ t: "floorLink.put", link: { id: `k${i}a`, pairId: `k${i}b`, sceneId: run.towerId, to: run.upperId, rect: { x: x * 2, y, w: 1, h: 1 }, kind: "stairs" } });
    }
    await waitFor("16 pairs", () => (ends().length === 32 ? true : null));
    await refuses({ x: 18, y: 9 }, { x: 19, y: 9 }, LINK_WORDS.tooMany("Tower"));
    for (const l of ends().filter((e) => e.id.startsWith("k") && e.id.endsWith("a"))) await ops.send({ t: "floorLink.delete", linkId: l.id });
  });

  test("FLRK-4. Add a floor above and below, Move up and Move down are off between floors that stairs join, with the stairs' words, and on again once they are removed", async () => {
    // One pair of stairs joins Ground floor and Upper floor.
    for (const l of ends()) if (state().floorLinks?.[l.id]) await ops.send({ t: "floorLink.delete", linkId: l.id }).catch(() => {});
    await waitFor("no ends", () => (ends().length === 0 ? true : null));
    await ops.send({ t: "floorLink.put", link: { id: "j1", pairId: "j2", sceneId: run.towerId, to: run.upperId, rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs" } });
    const joins = LINK_WORDS.between("stairs", "Ground floor", "Upper floor");
    await pickTool(dm, "Select");
    await showFloorNamed("Ground floor");
    const panel = await scenesPanel(dm);
    const group = await openSceneGroup(panel, "Floors");
    const above = group.getByRole("button", { name: "Add a floor above" });
    const below = group.getByRole("button", { name: "Add a floor below" });
    assert.equal(await above.isDisabled(), true, "above Ground floor puts a floor between it and Upper floor");
    assert.equal(await below.isDisabled(), false, "below Ground floor joins nothing");
    await group.getByText(joins, { exact: false }).waitFor();
    await shots.take(dm, "flrk-4-add-off");

    // Upper floor's page: Move down swaps it with Ground floor, which keeps them next to each other, and Move up would take Attic between.
    await group.getByRole("button", { name: /^Upper floor,/ }).click();
    const page = dm.locator(floorRoot("page"));
    await page.waitFor();
    assert.equal(await page.getByRole("button", { name: "Move down" }).isDisabled(), false);
    assert.equal(await page.getByRole("button", { name: "Move up" }).isDisabled(), true);
    await page.getByText(joins, { exact: false }).waitFor();
    await shots.take(dm, "flrk-4-move-off");
    await page.getByRole("button", { name: "Back to Floors" }).click();

    // With every pair removed, the adds are on again.
    await ops.send({ t: "floorLink.delete", linkId: "j1" });
    await waitFor("no ends", () => (ends().length === 0 ? true : null));
    await waitFor("Add a floor above on", async () => ((await above.isDisabled()) === false ? true : null));
  });

  test("FLRK-9. the page logged no console errors", () => {
    for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
