import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import type { Token } from "../shared/model.ts";
import { placedOnHex, tokenRefHex } from "../shared/rules/footprint.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexNeighbors, type Hex, type HexGrid } from "../shared/rules/hex.ts";
import { arrowStep, isometric } from "../client/lib/view.ts";
import { assertCanvasAt, ConsoleWatch, openSideTab, OpSocket, pagePoint, pickOption, pickTool, reopenRoom, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * The board on a hex scene (docs/design-v1-hex-grids.md 10, lane HX-3):
 * hex lines in the scene's 22 rows, a goblin dropped between hexes landing
 * on the nearest one, a drag of 4 hexes on its turn reading 20 ft, the
 * arrow keys in both views, the Straight ruler, an area's limit line, the
 * export's words, and those screens measured for alignment. A player on a
 * phone sees the same lines.
 *
 * The room's battle mat is switched to hex rows by an op, since the
 * settings that make a hex scene come with lane HX-4, which adds its own
 * steps here.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus 31. The
 * other environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 31;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-hex-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const G: HexGrid = { shape: "hex", orient: "rows" };
const BOUNDS = { w: 30, h: 20 };
/** Set before the app's first script: it installs the isometric view's test hook (relief/isoTest.ts) and offers nothing. */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

/** The sizes section 8 measures, each at 100% and 130%. */
const SIZES = [
  { name: "1440x900", width: 1440, height: 900, touch: false },
  { name: "390x844", width: 390, height: 844, touch: true },
  { name: "320x568", width: 320, height: 568, touch: true },
] as const;
const SCALES = [1, 1.3] as const;

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat"), phone: new ConsoleWatch("phone") };

const run = {
  roomId: "",
  roomName: `E2E hex ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  goblin: randomUUID(),
  ogre: randomUUID(),
  entry: randomUUID(),
};

const ACTOR = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

function goblin(): Token {
  const t = dmSocket.state?.tokens[run.goblin];
  assert.ok(t, "the goblin in the DM's state");
  return t;
}

/** The middle of a hex's side `i`, from its first point clockwise. */
function sideMiddle(h: Hex, i: number): { x: number; y: number } {
  const corners = hexCorners(G, h).map((c) => cornerAt(G, c));
  const a = corners[i]!;
  const b = corners[(i + 1) % 6]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * The brightest pixel within 2 px of a point on the map, as the mean of its
 * channels: the battle mat is #2b2b31, about 45, and a grid line is white at
 * a quarter's opacity, about 97 where it covers a pixel.
 */
async function brightAt(page: Page, world: { x: number; y: number }): Promise<number> {
  const p = await pagePoint(page, BOUNDS, world);
  await assertCanvasAt(page, p);
  const png = await page.screenshot({ clip: { x: Math.round(p.x) - 2, y: Math.round(p.y) - 2, width: 5, height: 5 } });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let most = 0;
  for (let i = 0; i < data.length; i += info.channels) most = Math.max(most, (data[i]! + data[i + 1]! + data[i + 2]!) / 3);
  return most;
}

/** Whether the accent's yellow lies within a pixel of a point on the map. */
async function accentNear(page: Page, world: { x: number; y: number }): Promise<boolean> {
  const p = await pagePoint(page, BOUNDS, world);
  const png = await page.screenshot({ clip: { x: Math.round(p.x) - 1, y: Math.round(p.y) - 1, width: 3, height: 3 } });
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) if (data[i]! > 150 && data[i + 1]! > 130 && data[i + 2]! < 90) return true;
  return false;
}

async function lineAt(page: Page, world: { x: number; y: number }, what: string): Promise<void> {
  let seen = 0;
  await waitFor(`a grid line ${what}`, async () => ((seen = await brightAt(page, world)) > 58 ? true : null), 8_000).catch((err: Error) => {
    throw new Error(`${err.message}: brightest ${seen}`);
  });
}

async function blankAt(page: Page, world: { x: number; y: number }, what: string): Promise<void> {
  const seen = await brightAt(page, world);
  assert.ok(seen < 54, `no grid line ${what}: brightest ${seen}`);
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
}

/** The words on the board's canvas, as Konva holds them. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages[0]!.find("Text")
      .filter((t) => t.isVisible())
      .map((t) => t.text());
  });
}

/** Presses on a world point and moves to another in steps, leaving the button down. */
async function holdDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await pagePoint(page, BOUNDS, from);
  const b = await pagePoint(page, BOUNDS, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
}

async function goblinAt(at: { x: number; y: number }, what: string): Promise<void> {
  await waitFor(what, () => {
    const t = dmSocket.state?.tokens[run.goblin];
    return t && Math.abs(t.x - at.x) < 1e-9 && Math.abs(t.y - at.y) < 1e-9 ? true : null;
  });
}

/** The Measure choice's radio group wherever the row put it: in the row, behind its chip, or behind ⋯. Returns the group and what closes it. */
async function measureChoice(page: Page): Promise<{ group: Locator; popover: Locator | null }> {
  const bar = page.getByRole("toolbar", { name: "Ruler options" });
  const chip = bar.getByRole("button", { name: /^Measure:/ });
  if ((await chip.count()) > 0 && (await chip.first().isVisible())) {
    await chip.first().click();
    const pop = page.getByRole("dialog", { name: "Measure" });
    return { group: pop.getByRole("radiogroup", { name: "Measure" }), popover: pop };
  }
  const inRow = bar.locator("[data-options-row]").getByRole("radiogroup", { name: "Measure" });
  if ((await inRow.count()) > 0 && (await inRow.first().isVisible())) return { group: inRow.first(), popover: null };
  await bar.getByRole("button", { name: "More options" }).click();
  const more = page.getByRole("dialog", { name: "More Ruler options" });
  return { group: more.getByRole("radiogroup", { name: "Measure" }), popover: more };
}

/** Starts a sphere on open ground in the middle of the scene, which gives the Area tool's row its options. */
async function draftArea(page: Page): Promise<void> {
  const fit = page.getByRole("button", { name: "Fit the map to the screen" });
  if ((await fit.count()) > 0 && (await fit.first().isVisible())) await fit.first().click();
  const p = await pagePoint(page, BOUNDS, hexCenter(G, { col: 15, row: 13 }));
  await assertCanvasAt(page, p);
  await page.mouse.click(p.x, p.y);
  await page.getByRole("toolbar", { name: "Area options" }).getByRole("button", { name: "More options" }).waitFor();
}

/** Opens the Scenes panel: its side tab on a wide screen, else the Panels sheet's button. */
async function openScenes(page: Page): Promise<Locator> {
  const wide = (await page.getByRole("tablist", { name: "Panels" }).count()) > 0;
  if (wide) {
    await openSideTab(page, "Scenes");
    return page.getByRole("tabpanel", { name: "Scenes" });
  }
  const picker = page.getByRole("list", { name: "Panels" });
  if (!(await picker.isVisible())) await page.locator('button[title="Panels"]').click();
  await picker.getByRole("button", { name: /^Scenes/ }).click();
  return page.locator("dialog[data-rvtt-sheet]").filter({ visible: true }).last();
}

function exportSection(panel: Locator, page: Page): Locator {
  return panel.locator("section").filter({ has: page.getByRole("heading", { name: "Export as image", exact: true }) }).last();
}

/** Opens the room at a size and interface scale, from a new navigation. */
async function openAt(page: Page, size: (typeof SIZES)[number], scale: number): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  if (!page.url().startsWith(server.origin)) await page.goto(`${server.origin}/`);
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  if (page.url().includes(`/r/${run.roomId}`)) await reopenRoom(page);
  else await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

describe("raccoon-vtt hex grids: the board", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await dmContext.addInitScript(HOOK_FLAG);
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("HX-1. a battle mat on hex rows draws the lines of its 22 rows, for the DM and for Pat on a phone", async () => {
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
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { gridShape: "hexRows" } });
    await waitFor("the hex rows in the DM's state", () => dmSocket.state?.scenes[run.sceneId]?.gridShape === "hexRows" || null);
    const at = (size: "medium" | "large", hex: Hex) => placedOnHex(G, { size, x: 0, y: 0 }, hex);
    await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.sceneId, kind: "monster", name: "Goblin", size: "medium", ...at("medium", { col: 6, row: 6 }), disposition: "hostile", visibility: "all", actor: { inline: ACTOR } } });
    await ops.send({ t: "token.create", token: { id: run.ogre, sceneId: run.sceneId, kind: "monster", name: "Ogre", size: "large", ...at("large", { col: 22, row: 4 }), disposition: "hostile", visibility: "all", actor: { inline: ACTOR } } });
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();

    // A hex's sides and not its middle. Then row 21, the scene's last, and nothing of a row 22 below it.
    await lineAt(dm, sideMiddle({ col: 3, row: 3 }, 1), "on hex 3,3's side");
    await lineAt(dm, sideMiddle({ col: 3, row: 3 }, 2), "on hex 3,3's slanted side");
    await blankAt(dm, hexCenter(G, { col: 3, row: 3 }), "in hex 3,3's middle");
    await lineAt(dm, sideMiddle({ col: 2, row: 21 }, 4), "on row 21's west side");
    await blankAt(dm, sideMiddle({ col: 3, row: 22 }, 4), "where a row 22 would be");
    await shots.take(dm, "hex-dm-board");

    await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state);
    await pat.locator(".konvajs-content").first().waitFor();
    const mid = { col: 16, row: 11 };
    await lineAt(pat, sideMiddle(mid, 2), "on Pat's board");
    await blankAt(pat, hexCenter(G, mid), "in the middle of a hex on Pat's board");
    await shots.take(pat, "hex-pat-board");
  });

  test("HX-2. a goblin dropped between hexes lands on the nearest one's anchor", async () => {
    await dm.bringToFront();
    const from = hexCenter(G, { col: 6, row: 6 });
    // Most of the way to hex 10,6's west side, and inside it.
    const to = { x: hexCenter(G, { col: 10, row: 6 }).x - 0.38, y: hexCenter(G, { col: 10, row: 6 }).y + 0.12 };
    assert.deepEqual(hexAt(G, to), { col: 10, row: 6 });
    await holdDrag(dm, from, to);
    await dm.mouse.up();
    await goblinAt(placedOnHex(G, goblin(), { col: 10, row: 6 }), "the goblin on hex 10,6");
    assert.deepEqual(tokenRefHex(G, goblin()), { col: 10, row: 6 });

    // Selected, it shows the outline of its hex in the accent, on the hex's own sides: zoomed in, a ring round its box would pass a few pixels outside their middles.
    await blur(dm);
    for (let i = 0; i < 4; i++) await dm.keyboard.press("+");
    const hex = { col: 10, row: 6 };
    const on = await pagePoint(dm, BOUNDS, hexCenter(G, hex));
    await dm.mouse.click(on.x, on.y);
    await dm.getByRole("dialog", { name: /^Goblin/ }).first().waitFor();
    let sides = 0;
    await waitFor("the selected goblin's hex outline", async () => {
      sides = 0;
      for (let i = 0; i < 6; i++) if (await accentNear(dm, sideMiddle(hex, i))) sides++;
      return sides >= 2 ? true : null;
    }, 5_000).catch((err: Error) => {
      throw new Error(`${err.message}: the accent at ${sides} of its 6 sides' middles`);
    });
    await shots.take(dm, "hex-dm-selected-outline");
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
  });

  test("HX-3. on the goblin's turn a drag of 4 hexes reads 20 ft on its label and in the path it stores", async () => {
    await ops.send({ t: "encounter.start", entries: [{ id: run.entry, tokenId: run.goblin, value: 15 }] });
    await ops.send({ t: "encounter.next" });
    await waitFor("the goblin's turn", () => dmSocket.state?.encounter?.activeEntryId === run.entry || null);
    let end: Hex = { col: 10, row: 6 };
    for (let i = 0; i < 4; i++) end = hexNeighbors(G, end)[1]!;
    await holdDrag(dm, hexCenter(G, { col: 10, row: 6 }), hexCenter(G, end));
    const label = await waitFor("the drag's label", async () => (await boardTexts(dm)).find((t) => /^20 ft\b/.test(t)) ?? null, 5_000);
    assert.match(label, /^20 ft/);
    await shots.take(dm, "hex-dm-drag-20ft");
    await dm.mouse.up();
    await goblinAt(placedOnHex(G, goblin(), end), "the goblin 4 hexes on");
    const stop = await waitFor("the move's stop", () => dmSocket.state?.tokens[run.goblin]?.path?.stops.at(-1));
    assert.equal(stop.cost, 20, "the path stores 20 ft");
  });

  test("HX-4. arrow keys move the goblin one hex, up one column in Top-down and by the screen in Isometric", async () => {
    const start = tokenRefHex(G, goblin());
    const on = await pagePoint(dm, BOUNDS, hexCenter(G, start));
    await dm.mouse.click(on.x, on.y);
    // The click opens the goblin's window, whose first control takes the focus and with it the arrow keys, so the focus leaves it once it has opened.
    const window = dm.getByRole("dialog", { name: /^Goblin/ });
    await window.first().waitFor();
    await waitFor("the window's focus", async () => ((await window.first().evaluate((w) => (w as unknown as { contains(n: unknown): boolean }).contains((globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement))) ? true : null), 3_000).catch(() => {});
    await blur(dm);
    await dm.keyboard.press("ArrowUp");
    await goblinAt(placedOnHex(G, goblin(), { col: start.col, row: start.row - 1 }), "the goblin a hex up");
    await dm.keyboard.press("ArrowUp");
    await goblinAt(placedOnHex(G, goblin(), { col: start.col, row: start.row - 2 }), "the goblin two hexes up, back above its column");

    await dm.keyboard.press("i");
    await waitFor("the board in Isometric", async () => ((await dm.getByRole("button", { name: /^View: / }).getAttribute("aria-label")) === "View: Isometric" ? true : null));
    const step = arrowStep(isometric(0), "ArrowUp");
    assert.ok(step);
    const before = tokenRefHex(G, goblin());
    await dm.keyboard.press("ArrowUp");
    await goblinAt(placedOnHex(G, goblin(), { col: before.col + step[0], row: before.row + step[1] }), "the goblin a hex toward the screen's top in Isometric");
    await shots.take(dm, "hex-dm-isometric");
    await dm.keyboard.press("i");
    await waitFor("the board in Top-down", async () => ((await dm.getByRole("button", { name: /^View: / }).getAttribute("aria-label")) === "View: Top-down" ? true : null));
    await ops.send({ t: "encounter.end" });
  });

  test("HX-5. the Straight ruler counts hexes, and Walking is off, saying it needs squares", async () => {
    await pickTool(dm, "Ruler");
    const bar = dm.getByRole("toolbar", { name: "Ruler options" });
    await bar.waitFor();
    const line = bar.locator("[data-options-line]");
    await line.filter({ hasText: "Walking needs squares." }).waitFor();
    // Six hexes down a slant of the lattice: 30 ft, where the squares under its ends would read 25.
    let end: Hex = { col: 4, row: 8 };
    for (let i = 0; i < 6; i++) end = hexNeighbors(G, end)[1]!;
    await holdDrag(dm, hexCenter(G, { col: 4, row: 8 }), hexCenter(G, end));
    await dm.mouse.up();
    await line.filter({ hasText: /^30 ft · / }).waitFor();
    await shots.take(dm, "hex-dm-ruler");
    const { group, popover } = await measureChoice(dm);
    // Its title names it, so the reason is what a screen reader hears (lib/a11y.ts accessibleName).
    const walking = group.getByRole("radio", { name: "Walking needs squares.", exact: true });
    assert.equal(await walking.isDisabled(), true, "Walking is off on hexes");
    assert.equal(await group.getByRole("radio", { name: "Straight", exact: true }).isChecked(), true);
    if (popover) {
      await dm.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });
    }
    await pickTool(dm, "Select");
  });

  test("HX-6. an area's options say its movement inside is counted on squares only", async () => {
    await pickTool(dm, "Area");
    await pickOption(dm, "Area", "Shape", "Sphere");
    await draftArea(dm);
    const bar = dm.getByRole("toolbar", { name: "Area options" });
    await bar.getByRole("button", { name: "More options" }).click();
    const more = dm.getByRole("dialog", { name: "More Area options" });
    await more.getByText("Counted on squares only.", { exact: true }).waitFor();
    await shots.take(dm, "hex-dm-area-more");
    await dm.keyboard.press("Escape");
    await more.waitFor({ state: "detached" });
    await pickTool(dm, "Select");
  });

  test("HX-7. Export as image speaks of hexes: pixels per hex, hexes at 70 px, and Hex lines", async () => {
    const panel = await openScenes(dm);
    const section = exportSection(panel, dm);
    await section.getByRole("button", { name: "Export as image" }).click();
    await section.getByRole("radiogroup", { name: "Pixels per hex" }).waitFor();
    await section.getByText("2100 × 1400 px: hexes at 70 px.", { exact: true }).waitFor();
    await section.getByText("Hex lines", { exact: true }).waitFor();
    assert.equal(await section.getByText(/square/).count(), 0, "no square in the export's words");
    await shots.take(dm, "hex-dm-export");
    await section.getByRole("button", { name: "Close", exact: true }).click();
  });

  test("HX-8. the ruler's row and Measure choice, an area's options and the export sit within 1 px at each size", async () => {
    const off: string[] = [];
    let phoneContext: BrowserContext | null = null;
    try {
      for (const size of SIZES) {
        let page = dm;
        if (size.touch) {
          phoneContext ??= await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await dmContext.storageState() });
          const pages = phoneContext.pages();
          page = pages[0] ?? (await phoneContext.newPage());
          if (pages.length === 0) consoles.phone.attach(page);
        }
        for (const scale of SCALES) {
          const at = `${size.name} at ${scale * 100}%`;
          await openAt(page, size, scale);

          await pickTool(page, "Ruler");
          const ruler = page.getByRole("toolbar", { name: "Ruler options" });
          await ruler.locator("[data-options-line]").filter({ hasText: "Walking needs squares." }).waitFor();
          off.push(...alignmentLines(await measureAlignment(ruler), `the Ruler's options at ${at}`));
          const { group, popover } = await measureChoice(page);
          await group.waitFor();
          off.push(...alignmentLines(await measureAlignment(popover ?? group), `the Measure choice at ${at}`));
          if (popover) {
            await page.keyboard.press("Escape");
            await popover.waitFor({ state: "detached" });
          }
          await shots.take(page, `hex-ruler-${size.name}-${scale * 100}`);

          await pickTool(page, "Area");
          await pickOption(page, "Area", "Shape", "Sphere");
          await draftArea(page);
          const area = page.getByRole("toolbar", { name: "Area options" });
          off.push(...alignmentLines(await measureAlignment(area), `the Area options at ${at}`));
          await area.getByRole("button", { name: "More options" }).click();
          const more = page.getByRole("dialog", { name: "More Area options" });
          await more.getByText("Counted on squares only.", { exact: true }).waitFor();
          off.push(...alignmentLines(await measureAlignment(more), `More area options at ${at}`));
          await shots.take(page, `hex-area-more-${size.name}-${scale * 100}`);
          await page.keyboard.press("Escape");
          await more.waitFor({ state: "detached" });
          await pickTool(page, "Select");

          const panel = await openScenes(page);
          const section = exportSection(panel, page);
          await section.getByRole("button", { name: "Export as image" }).click();
          await section.getByText("Hex lines", { exact: true }).waitFor();
          await section.scrollIntoViewIfNeeded();
          off.push(...alignmentLines(await measureAlignment(section), `Export as image at ${at}`));
          await shots.take(page, `hex-export-${size.name}-${scale * 100}`);
          await section.getByRole("button", { name: "Close", exact: true }).click();
          await page.keyboard.press("Escape");
        }
      }
    } finally {
      await phoneContext?.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("HX-9. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});
