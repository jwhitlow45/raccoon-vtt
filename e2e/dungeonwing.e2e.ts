import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { cornerAt, hexCenter, hexCorners, hexNeighbors, type Hex, type HexGrid } from "../shared/rules/hex.ts";
import type { RoomState } from "../shared/model.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, openSideTab, pagePoint, pickOption, pickTool, Shots, sideTabName, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Add a wing in the Map builder (docs/design: dungeon generator phase 3,
 * 3.1 to 3.3, prefix DGW), the DM's side: the mode, its area and join, the
 * docked pane and the ghost, on a computer and a phone.
 *
 * - DGW-1: on squares the row's line moves on from the drag to the tap to
 *   the area and join, a refused wall says why and keeps nothing, and the
 *   mode is off with its line on a scene whose automatic walls are off.
 * - DGW-2: Generate a wing docks the pane at the map edge farther from the
 *   area, the map's height between the bars, draws the ghost inside the
 *   area, Edit rooms numbers its rooms, and Escape closes the pane and its
 *   ghost. The pane and row stand in line at the sweep's sizes.
 * - DGW-3: on a phone the pane is a bottom sheet of at most 60% of the
 *   height.
 * - DGW-4: on hexes an area over walls is refused with its line, and a wall
 *   one hex side long joins.
 * - D3FIX-1: on hexes Add the wing lands a Wide wing joined on a slanted
 *   side, whose three sides become its doors (DG3 review round 1).
 * - LP37FIX-1: a ghost room's panel names it as the ghost does, and Done
 *   gives focus back to Edit rooms.
 * - LP37FIX-2: the first drag right after picking the mode draws the area.
 *   DGW-3 also finds the sheet's foot in sight as it opens.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seventy. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 70;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-dungeonwing-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const KEEP = { w: 60, h: 40 };
const BURROW = { w: 40, h: 40 };
const TOOL = "Map builder";
const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const WING_TAP = "Tap the wall the wing joins.";
const WING_OFF = "Automatic walls are off on this scene, so a wing would stand without walls. Turn them on in Walls and movement to add one.";
const WING_HEX_COVERS = "On hexes the wing's area must not cover walls or other build.";

/** The side of a hex toward its neighbor in direction d, from corner d+1 to d+2, as the walls read it. */
function sideEnds(g: HexGrid, h: Hex, d: number): [{ x: number; y: number }, { x: number; y: number }] {
  const corners = hexCorners(g, h);
  return [cornerAt(g, corners[(d + 1) % 6]!), cornerAt(g, corners[(d + 2) % 6]!)];
}

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles: ConsoleWatch[] = [];

const run = { roomId: "", roomName: "The Sunken Keep", keepId: "", ruinsId: "", burrowId: "" };

function state(): RoomState {
  return dmSocket.state as RoomState;
}

async function line(page: Page = dm): Promise<string> {
  return (await page.locator('[data-options-line="shown"]').first().innerText()).replace(/\s+/g, " ").trim();
}

async function lineIs(want: string, page: Page = dm): Promise<void> {
  let last = "";
  try {
    await waitFor(`the line "${want}"`, async () => ((last = await line(page)) === want ? true : null));
  } catch (err) {
    throw new Error(`${(err as Error).message}, the line reading "${last}"`);
  }
}

async function showScene(page: Page, name: string, id: string): Promise<void> {
  await openSideTab(page, "Scenes");
  const panel = page.getByRole("tabpanel", { name: sideTabName("Scenes") });
  await panel.getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
  await waitFor(`the DM on ${name}`, () => (dmSocket.you?.sceneId === id ? true : null));
}

/** Drags between two world points, the button held through small steps. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, bounds: { w: number; h: number }): Promise<void> {
  const a = await pagePoint(page, bounds, from);
  const b = await pagePoint(page, bounds, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + (b.x - a.x) * 0.1, a.y + (b.y - a.y) * 0.1, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
}

async function tapWorld(page: Page, at: { x: number; y: number }, bounds: { w: number; h: number }): Promise<void> {
  const p = await pagePoint(page, bounds, at);
  await page.mouse.click(p.x, p.y);
}

/** How many of a grid of points over a world box differ from the rock behind the build, read from the map's canvases. */
async function drawnIn(page: Page, box: { x0: number; y0: number; x1: number; y1: number }, bounds: { w: number; h: number }): Promise<number> {
  const a = await pagePoint(page, bounds, { x: box.x0, y: box.y0 });
  const b = await pagePoint(page, bounds, { x: box.x1, y: box.y1 });
  return page.evaluate(
    ([x0, y0, x1, y1]) => {
      const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { left: number; top: number; width: number; height: number }; width: number; height: number; getContext(k: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null }> } }).document;
      let lit = 0;
      for (let i = 1; i < 20; i++) {
        for (let j = 1; j < 20; j++) {
          const x = x0! + ((x1! - x0!) * i) / 20;
          const y = y0! + ((y1! - y0!) * j) / 20;
          let bright = 0;
          for (const canvas of Array.from(doc.querySelectorAll(".konvajs-content canvas"))) {
            const r = canvas.getBoundingClientRect();
            const d = canvas.getContext("2d")?.getImageData(Math.round(((x - r.left) / r.width) * canvas.width), Math.round(((y - r.top) / r.height) * canvas.height), 1, 1).data;
            if (d && d[3]! > 20) bright = Math.max(bright, d[0]! + d[1]! + d[2]!);
          }
          // The rock behind a builder scene is near black (#141418): floor, walls and doors are far lighter.
          if (bright > 160) lit++;
        }
      }
      return lit;
    },
    [a.x, a.y, b.x, b.y] as const,
  );
}

/** The walls round a closed room of hexes, one on each side toward a hex outside it, as build.walls takes them. */
function hexWalls(g: HexGrid, x0: number, y0: number, w: number, h: number): { id: string; a: [number, number]; b: [number, number]; f: { kind: "wall" } }[] {
  const out: { id: string; a: [number, number]; b: [number, number]; f: { kind: "wall" } }[] = [];
  const inRoom = (q: Hex) => q.col >= x0 && q.col < x0 + w && q.row >= y0 && q.row < y0 + h;
  for (let row = y0; row < y0 + h; row++) {
    for (let col = x0; col < x0 + w; col++) {
      hexNeighbors(g, { col, row }).forEach((n, d) => {
        if (inRoom(n)) return;
        const [a, b] = sideEnds(g, { col, row }, d);
        out.push({ id: randomUUID().replace(/-/g, "").slice(0, 12), a: [a.x, a.y], b: [b.x, b.y], f: { kind: "wall" } });
      });
    }
  }
  return out;
}

/** Presses a button of the row, from ⋯ where a narrow row keeps it there. */
async function pressInRow(page: Page, name: string): Promise<void> {
  const bar = page.getByRole("toolbar", { name: `${TOOL} options` });
  const inRow = bar.getByRole("button", { name, exact: true });
  if ((await inRow.count()) > 0 && (await inRow.first().isVisible())) {
    await inRow.first().click();
    return;
  }
  await bar.getByRole("button", { name: "More options" }).click();
  await page.getByRole("dialog", { name: `More ${TOOL} options` }).getByRole("button", { name, exact: true }).click();
}

function pane(page: Page = dm): Locator {
  return page.locator("[data-wing-pane]");
}

/** Whether a control is in sight as it stands: inside the screen, and the topmost thing at its middle. */
async function inSight(target: Locator): Promise<string | null> {
  return target.evaluate((el) => {
    const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): unknown }; innerHeight: number; innerWidth: number }).document;
    const view = globalThis as unknown as { innerHeight: number; innerWidth: number };
    const r = (el as { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } }).getBoundingClientRect();
    if (r.width === 0 || r.top < 0 || r.left < 0 || r.bottom > view.innerHeight || r.right > view.innerWidth) return `off the screen: ${JSON.stringify(r)}`;
    const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || (el as { contains(n: unknown): boolean }).contains(hit) ? null : `covered at its middle: ${JSON.stringify(r)}`;
  });
}

describe("raccoon-vtt Add a wing: the DM's mode, pane and ghost", { timeout: 900_000 }, () => {
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

  test("DGW-1. on squares the line moves from the drag to the tap to the area and join, a refused wall says why, and the mode is off where automatic walls are", async () => {
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

    run.keepId = randomUUID();
    run.ruinsId = randomUUID();
    run.burrowId = randomUUID();
    await ops.send({ t: "scene.create", scene: { id: run.keepId, name: "Keep", bounds: KEEP, fogEnabled: false } });
    await ops.send({ t: "build.rect", sceneId: run.keepId, terrain: "stone", x: 4, y: 4, w: 9, h: 9 });
    await ops.send({ t: "scene.create", scene: { id: run.ruinsId, name: "Ruins", bounds: KEEP, autoWalls: "off" } });
    await ops.send({ t: "scene.create", scene: { id: run.burrowId, name: "Burrow", bounds: BURROW, gridShape: "hexRows" } });
    await ops.send({ t: "build.walls", sceneId: run.burrowId, put: hexWalls(ROWS, 10, 10, 4, 4) });
    await waitFor("the three scenes", () => (state().scenes[run.burrowId] && state().scenes[run.ruinsId] ? true : null));

    await showScene(dm, "Keep", run.keepId);
    await pickTool(dm, TOOL);
    await pickOption(dm, TOOL, "Builder mode", "Add a wing");
    const bar = dm.getByRole("toolbar", { name: `${TOOL} options` });
    await bar.getByRole("button", { name: /^Builder mode: Add a wing/ }).waitFor();
    await lineIs("Drag the wing's area over empty ground, up to 100 by 100.");
    const generate = bar.getByRole("button", { name: "Generate a wing" });
    assert.equal(await generate.isDisabled(), true, "off until an area and a join are set");
    await shots.take(dm, "dgw-1-mode");

    // A wall between two floor cells is no join, and nothing is kept.
    await drag(dm, { x: 22.5, y: 4.5 }, { x: 47.5, y: 29.5 }, KEEP);
    await lineIs(WING_TAP);
    await tapWorld(dm, { x: 8, y: 8.5 }, KEEP);
    await lineIs("Tap a wall or door between floor and empty ground.");
    // The room's east wall, an automatic wall between floor and rock.
    await tapWorld(dm, { x: 13, y: 8.5 }, KEEP);
    await lineIs("Area 26 by 26 squares, joined at the ringed wall.");
    assert.equal(await generate.isDisabled(), false);
    await shots.take(dm, "dgw-1-area-and-join");

    // On a scene whose automatic walls are off the tile is off with its line, and a mode left on says it.
    await showScene(dm, "Ruins", run.ruinsId);
    await lineIs(WING_OFF);
    await bar.getByRole("button", { name: /^Builder mode:/ }).first().click();
    const picker = dm.getByRole("dialog", { name: "Builder mode" });
    const tile = picker.getByRole("radio", { name: /^Add a wing/ });
    assert.equal(await tile.isDisabled(), true);
    await dm.keyboard.press("Escape");
    await showScene(dm, "Keep", run.keepId);
    // Another scene cleared the area and join.
    await lineIs("Drag the wing's area over empty ground, up to 100 by 100.");
  });

  test("DGW-2. Generate a wing docks the pane away from the area, draws the ghost in the area, numbers its rooms, and Escape closes both", async () => {
    const bar = dm.getByRole("toolbar", { name: `${TOOL} options` });
    await drag(dm, { x: 22.5, y: 4.5 }, { x: 47.5, y: 29.5 }, KEEP);
    await tapWorld(dm, { x: 13, y: 8.5 }, KEEP);
    await lineIs("Area 26 by 26 squares, joined at the ringed wall.");
    const area = { x0: 22, y0: 4, x1: 48, y1: 30 };
    const before = await drawnIn(dm, area, KEEP);
    await bar.getByRole("button", { name: "Generate a wing" }).click();
    await pane().waitFor();
    await pane().getByRole("heading", { name: "Add a wing" }).waitFor();
    await pane().getByText("Area 26 by 26 squares (130 by 130 ft)", { exact: true }).waitFor();
    await pane().getByText("Players see this scene without fog, so the wing shows at once.", { exact: true }).waitFor();
    // The status counts the plan once the ghost is drawn.
    await waitFor("the plan's counts", async () => (/rooms?\b.*doors?\b.*traps?\b/.test(await pane().getByRole("status").innerText()) ? true : null));
    assert.equal(await pane().getByRole("button", { name: "Add the wing" }).isDisabled(), false, "the planned wing can be added");

    // The area's middle (35 of the scene's 60 across, framed whole) is right of the map's middle, so the pane docks on the left, the map's height between the bars.
    const box = (await pane().boundingBox())!;
    const canvas = (await dm.locator(".konvajs-content").first().boundingBox())!;
    assert.equal(Math.round(box.width), 296);
    assert.ok(box.x >= canvas.x && box.x <= canvas.x + 80, `docked at the left: ${JSON.stringify(box)} in ${JSON.stringify(canvas)}`);
    assert.ok(box.height > WIDE.height * 0.6, `the map's height: ${box.height}`);
    const after = await waitFor("the ghost in the area", async () => {
      const n = await drawnIn(dm, area, KEEP);
      return n > before + 20 ? n : null;
    });
    assert.ok(after > before);
    await shots.take(dm, "dgw-2-pane-and-ghost");

    await pane().getByRole("button", { name: "Edit rooms" }).click();
    assert.equal(await pane().getByRole("button", { name: "Edit rooms" }).getAttribute("aria-pressed"), "true");
    await shots.take(dm, "dgw-2-room-numbers");

    // The pane, its foot and the row in line at the sweep's sizes, at 100% and 130%.
    const lines: string[] = [];
    lines.push(...alignmentLines(await measureAlignment(pane()), "the wing pane at 1440 x 900"));
    lines.push(...alignmentLines(await measureAlignment(bar), "the Wing row at 1440 x 900"));
    assert.deepEqual(lines, [], "out of line");

    await dm.keyboard.press("Escape");
    await pane().waitFor({ state: "detached" });
    await waitFor("the ghost gone", async () => ((await drawnIn(dm, area, KEEP)) <= before + 5 ? true : null));
    // The area and join stay for another try.
    await lineIs("Area 26 by 26 squares, joined at the ringed wall.");
  });

  test("LP37FIX-1. a tap on a ghost room opens its panel named as the ghost numbers it, and Done gives focus back to Edit rooms", async () => {
    const bar = dm.getByRole("toolbar", { name: `${TOOL} options` });
    await drag(dm, { x: 22.5, y: 4.5 }, { x: 47.5, y: 29.5 }, KEEP);
    await tapWorld(dm, { x: 13, y: 8.5 }, KEEP);
    await lineIs("Area 26 by 26 squares, joined at the ringed wall.");
    const area = { x0: 22, y0: 4, x1: 48, y1: 30 };
    await bar.getByRole("button", { name: "Generate a wing" }).click();
    await pane().waitFor();
    await waitFor("the plan's counts", async () => (/rooms?\b.*doors?\b/.test(await pane().getByRole("status").innerText()) ? true : null));
    await pane().getByRole("button", { name: "Edit rooms" }).click();
    // A tap that misses every room is judged as a join and refused, which leaves the pane as it was.
    const panel = pane().locator("[data-room-panel]");
    let opened = false;
    for (let j = 1; j < 8 && !opened; j++) {
      for (let i = 1; i < 8 && !opened; i++) {
        await tapWorld(dm, { x: area.x0 + ((area.x1 - area.x0) * i) / 8, y: area.y0 + ((area.y1 - area.y0) * j) / 8 }, KEEP);
        opened = await panel.waitFor({ timeout: 400 }).then(
          () => true,
          () => false,
        );
      }
    }
    assert.ok(opened, "a tap inside the area opened a ghost room's panel");
    const title = (await panel.getByRole("heading", { level: 3 }).innerText()).trim();
    assert.match(title, /^Room W\d+$/, "the panel names the room as the ghost does");
    await shots.take(dm, "lp37fix-room-panel-w-title");
    await panel.getByRole("button", { name: "Done", exact: true }).click();
    await panel.waitFor({ state: "detached" });
    assert.equal(await pane().getByRole("button", { name: "Edit rooms" }).evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "Done gave focus back to Edit rooms");
    await dm.keyboard.press("Escape");
    await pane().waitFor({ state: "detached" });
  });

  test("LP37FIX-2. the first drag right after picking Add a wing draws its area, the picker closed by the pick", async () => {
    // Live play 37 picked the tile by a script's click, which leaves the picker open, so its first press only closed the picker.
    await pickOption(dm, TOOL, "Builder mode", "Brush");
    // The drag's ends are read first, since reading them waits for a still camera, and the pick moves no camera.
    const a = await pagePoint(dm, KEEP, { x: 22.5, y: 4.5 });
    const b = await pagePoint(dm, KEEP, { x: 47.5, y: 29.5 });
    const bar = dm.getByRole("toolbar", { name: `${TOOL} options` });
    await bar.getByRole("button", { name: /^Builder mode:/ }).first().click();
    await dm.getByRole("dialog", { name: "Builder mode" }).getByRole("radio", { name: /^Add a wing/ }).click();
    // At once: no wait for the picker to go or the row to change.
    await dm.mouse.move(a.x, a.y);
    await dm.mouse.down();
    await dm.mouse.move(a.x + (b.x - a.x) * 0.1, a.y + (b.y - a.y) * 0.1, { steps: 3 });
    await dm.mouse.move(b.x, b.y, { steps: 12 });
    await dm.mouse.up();
    await lineIs(WING_TAP);
  });

  test("DGW-3. on a phone the pane is a bottom sheet of at most 60% of the height, and in line at 390 and 320 wide, 100% and 130%", async () => {
    // A new page of the DM's opens on the players' scene, so they go to the Keep first.
    await ops.send({ t: "room.setPlayerScene", sceneId: run.keepId });
    await waitFor("players on the Keep", () => (state().meta.playerSceneId === run.keepId ? true : null));
    const lines: string[] = [];
    const page = await dmContext.newPage();
    const watch = new ConsoleWatch("dm-phone");
    watch.attach(page);
    consoles.push(watch);
    try {
      for (const size of [PHONE, { width: 320, height: 568 }]) {
        for (const scale of ["1", "1.3"]) {
          await page.setViewportSize(size);
          await page.goto(`${server.origin}/r/${run.roomId}`);
          await page.evaluate((v) => localStorage.setItem("rvtt.uiScale", v), scale);
          await page.reload();
          await page.locator(".konvajs-content").first().waitFor();
          await pickTool(page, TOOL);
          await pickOption(page, TOOL, "Builder mode", "Add a wing");
          await lineIs("Drag the wing's area over empty ground, up to 100 by 100.", page);
          const row = page.getByRole("toolbar", { name: `${TOOL} options` });
          lines.push(...alignmentLines(await measureAlignment(row), `the Wing row at ${size.width} x ${size.height} at ${scale}`));
          await drag(page, { x: 22.5, y: 4.5 }, { x: 47.5, y: 29.5 }, KEEP);
          await tapWorld(page, { x: 13, y: 8.5 }, KEEP);
          await lineIs("Area 26 by 26 squares, joined at the ringed wall.", page);
          await pressInRow(page, "Generate a wing");
          await pane(page).waitFor();
          await waitFor("the plan's counts", async () => (/rooms?\b/.test(await pane(page).getByRole("status").innerText()) ? true : null));
          const box = (await pane(page).boundingBox())!;
          assert.ok(Math.round(box.width) >= size.width - 1, `a sheet as wide as the screen: ${JSON.stringify(box)}`);
          assert.ok(box.height <= size.height * 0.6 + 1, `at most 60% of the height: ${box.height}`);
          // LP37FIX: the foot is pinned, so the plan's counts and Add the wing are in sight as the sheet opens.
          for (const [what, control] of [
            ["Add the wing", pane(page).getByRole("button", { name: "Add the wing" })],
            ["the status", pane(page).getByRole("status")],
          ] as const) {
            const off = await inSight(control);
            assert.equal(off, null, `${what} at ${size.width} x ${size.height} at ${scale}: ${off}`);
          }
          // And the rows stay in reach: scrolled to, Reroll shows with the foot still in sight below it.
          const reroll = pane(page).getByRole("button", { name: "Reroll", exact: true });
          await reroll.scrollIntoViewIfNeeded();
          for (const [what, control] of [
            ["Reroll", reroll],
            ["Add the wing after scrolling", pane(page).getByRole("button", { name: "Add the wing" })],
          ] as const) {
            const off = await inSight(control);
            assert.equal(off, null, `${what} at ${size.width} x ${size.height} at ${scale}: ${off}`);
          }
          lines.push(...alignmentLines(await measureAlignment(pane(page)), `the wing pane at ${size.width} x ${size.height} at ${scale}`));
          await shots.take(page, `dgw-3-sheet-${size.width}-${scale.replace(".", "")}`);
          await page.keyboard.press("Escape");
          await pane(page).waitFor({ state: "detached" });
        }
      }
      await page.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
    } finally {
      await page.close();
    }
    assert.deepEqual(lines, [], "out of line");
  });

  test("DGW-4. on hexes an area over walls is refused with its line, and a wall one hex side long joins", async () => {
    await showScene(dm, "Burrow", run.burrowId);
    await lineIs("Drag the wing's area over empty ground, up to 100 hexes across and 100 rows down.");
    // From inside the walled room out to open ground: it covers the room's walls.
    await drag(dm, hexCenter(ROWS, { col: 11, row: 11 }), hexCenter(ROWS, { col: 25, row: 25 }), BURROW);
    await lineIs(WING_HEX_COVERS);
    await drag(dm, hexCenter(ROWS, { col: 20, row: 18 }), hexCenter(ROWS, { col: 34, row: 34 }), BURROW);
    await lineIs(WING_TAP);
    const [a, b] = sideEnds(ROWS, { col: 13, row: 11 }, 0);
    await tapWorld(dm, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, BURROW);
    await lineIs("Area 15 hexes across and 17 rows down, joined at the ringed wall.");
    await shots.take(dm, "dgw-4-hex-join");
  });

  test("D3FIX-1. on hexes Add the wing lands a Wide wing joined on a slanted side, whose three sides become its doors", async () => {
    const walls = () => Object.values(state().buildChunks).filter((c) => c?.sceneId === run.burrowId).flatMap((c) => c!.walls ?? []);
    const before = walls();
    // Another scene clears DGW-4's area and join, which would still stand for the new area.
    await showScene(dm, "Keep", run.keepId);
    await showScene(dm, "Burrow", run.burrowId);
    await lineIs("Drag the wing's area over empty ground, up to 100 hexes across and 100 rows down.");
    // Below the room, and its bottom row's south-east side: on Wide its join is that side and the two beside it, the doorway facing south-west.
    await drag(dm, hexCenter(ROWS, { col: 2, row: 18 }), hexCenter(ROWS, { col: 30, row: 36 }), BURROW);
    await lineIs(WING_TAP);
    const [a, b] = sideEnds(ROWS, { col: 11, row: 13 }, 1);
    await tapWorld(dm, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, BURROW);
    await lineIs("Area 29 hexes across and 19 rows down, joined at the ringed wall.");
    const bar = dm.getByRole("toolbar", { name: `${TOOL} options` });
    await bar.getByRole("button", { name: "Generate a wing" }).click();
    await pane().waitFor();
    await pane().getByRole("radio", { name: "Wide", exact: true }).check();
    // The pane opens on a random seed, and this crowded Wide join finds no way for about one seed in four, which the pane says with Reroll first: so Reroll until one plans.
    for (let tries = 0; ; tries++) {
      const outcome = await waitFor("the Wide plan's counts or its no way line", async () => {
        const status = await pane().getByRole("status").innerText();
        if (/rooms?\b.*doors?\b/.test(status) && (await pane().getByRole("button", { name: "Add the wing" }).isEnabled())) return "planned";
        return /^No way from the area|^Could not fit two rooms/.test(status) ? "reroll" : null;
      });
      if (outcome === "planned") break;
      assert.ok(tries < 8, "a Wide plan within 8 rerolls");
      await pane().getByRole("button", { name: "Reroll", exact: true }).click();
      // The next plan can say the same words, so the old line is given time to go: the pane waits 120 ms, and a plan here takes far less than the rest.
      await dm.waitForTimeout(800);
    }
    await shots.take(dm, "d3fix-1-wide-hex-wing");
    await pane().getByRole("button", { name: "Add the wing" }).click();
    await pane().waitFor({ state: "detached", timeout: 30_000 });
    await waitFor("the wing's walls stored", () => (walls().length > before.length + 20 ? true : null));
    // The three sides of the join: the tapped one, and on either side of it the room's sides toward 12,14 and from 11,13 toward 11,14.
    for (const [h, d] of [
      [{ col: 11, row: 13 }, 1],
      [{ col: 12, row: 13 }, 2],
      [{ col: 11, row: 13 }, 2],
    ] as const) {
      const [p, q] = sideEnds(ROWS, h, d);
      const leaf = walls().find((w) => (w.a[0] === p.x && w.a[1] === p.y && w.b[0] === q.x && w.b[1] === q.y) || (w.a[0] === q.x && w.a[1] === q.y && w.b[0] === p.x && w.b[1] === p.y));
      assert.equal(leaf?.f.kind, "door", `a door on side ${d} of ${h.col},${h.row}`);
    }
    await lineIs("Drag the wing's area over empty ground, up to 100 hexes across and 100 rows down.");
    await shots.take(dm, "d3fix-1-wide-hex-wing-added");
  });

  test("DGW-B1. Add the wing asks, lands the wing on the scene, closes the pane and clears the mode, and the wing takes the join for its door", async () => {
    await showScene(dm, "Keep", run.keepId);
    await pickOption(dm, TOOL, "Builder mode", "Add a wing");
    const bar = dm.getByRole("toolbar", { name: `${TOOL} options` });
    await drag(dm, { x: 22.5, y: 4.5 }, { x: 47.5, y: 29.5 }, KEEP);
    await tapWorld(dm, { x: 13, y: 8.5 }, KEEP);
    await lineIs("Area 26 by 26 squares, joined at the ringed wall.");
    const cells = () => Object.values(state().buildChunks).filter((c) => c?.sceneId === run.keepId).reduce((n, c) => n + Object.keys(c!.cells).length, 0);
    const before = cells();
    await bar.getByRole("button", { name: "Generate a wing" }).click();
    await pane().waitFor();
    await waitFor("the plan's counts", async () => (/rooms?\b.*doors?\b/.test(await pane().getByRole("status").innerText()) ? true : null));
    await pane().getByRole("button", { name: "Add the wing" }).click();
    await pane().waitFor({ state: "detached", timeout: 30_000 });
    await waitFor("the wing's floor stored", () => (cells() > before + 20 ? true : null));
    const join = Object.values(state().buildChunks).find((c) => c?.sceneId === run.keepId && c.edges["13,8,w"]);
    assert.equal(join?.edges["13,8,w"]?.kind, "door", "the joined wall became the wing's door");
    // The mode clears: the line asks for a new area.
    await lineIs("Drag the wing's area over empty ground, up to 100 by 100.");
    await shots.take(dm, "dgw-b1-wing-added");
  });

  test("DGW-5. the pages logged no console errors", () => {
    for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
