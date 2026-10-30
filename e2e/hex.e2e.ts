import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { FOG_SUBCELLS, type AreaTemplate, type Token } from "../shared/model.ts";
import { creaturesInArea } from "../shared/rules/aoe.ts";
import { footprintSubcells, occupiedHexes, placedOnHex, tokenRefHex } from "../shared/rules/footprint.ts";
import { isSubcellFogged } from "../shared/rules/fog.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexDistance, hexKey, hexNeighbors, hexSubcells, sceneHexes, type Hex, type HexGrid } from "../shared/rules/hex.ts";
import { hexCellsOutline } from "../client/features/fog/shapes.ts";
import { arrowStep, isometric } from "../client/lib/view.ts";
import { HEX_LIMITS, NEW_SCENES_HELP } from "../client/features/grid/words.ts";
import { calibrationFromHexFind } from "../client/features/grid/calibrate.ts";
import { drawMap } from "../client/features/grid/synthetic.ts";
import { assertCanvasAt, barControl, ConsoleWatch, dragWorld, expandBar, openSceneGroup, openSideTab, sceneGroup, OpSocket, pagePoint, pickOption, pickTool, reopenRoom, Shots, SocketWatch, startServer, untilReady, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { setupHistory } from "./helpers/undoScope.ts";
import { wallsRound } from "../shared/rules/hexWalls.testkit.ts";

/**
 * The board on a hex scene (docs/design-v1-hex-grids.md 10, lane HX-3):
 * hex lines in the scene's 22 rows, a goblin dropped between hexes landing
 * on the nearest one, a drag of 4 hexes on its turn reading 20 ft, the
 * arrow keys in both views, the Straight ruler, an area's limit line, the
 * export's words, and those screens measured for alignment. A player on a
 * phone sees the same lines.
 *
 * The room's battle mat is switched to hex rows by an op. Lane HX-4's
 * steps (HX4-) then make hex scenes through the settings: the room's New
 * scenes grid, the new scene form, a scene's Grid shape and its refusal,
 * Line up grid's box on a hex map, no "square" on a hex scene's screens,
 * and those screens' alignment. Lane HX-6's steps (HX6-) build a hex
 * scene of its own: Wall lines tapped and dragged, a free door's states,
 * Remove and undo, difficult ground by hexes, Erase by hexes, a player's
 * creature opening a free door from a hex beside it, and those screens'
 * alignment. Lane HX-7's steps (HX7-) ride, carry and trap on hexes.
 * Lane HX-9b's steps (HX9b-) reveal rooms on hex scenes: a room of hexes
 * closed by free walls and a door, revealed through the Fog tool's Builder
 * room and shown to Pat, the door open and shut, a room on hex columns,
 * the Fog tool's options measured, the whole of the largest open hex scene
 * drafted in messages that each fit a socket frame, and a room sent in
 * several ops counted and taken back as one edit, on hexes and squares.
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
/** Ben's browser, which only joins the room, so a creature of his sees on the scene. */
let benContext: BrowserContext;
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
  /** The DM link's secret, which signs a second DM device in on a session of its own. */
  dmKey: "",
  sceneId: "",
  goblin: randomUUID(),
  ogre: randomUUID(),
  entry: randomUUID(),
  patId: "",
  benId: "",
  thorn: randomUUID(),
  bree: randomUUID(),
  imp: randomUUID(),
  fireball: randomUUID(),
  guardians: randomUUID(),
  /** The battle mat HX4-1 makes through the new scene form, on the room's hex rows. */
  camp: "",
  moor: randomUUID(),
  /** Lane HX-6's hex scene (HX6-): Wall lines, difficult ground and a free door. */
  hall: randomUUID(),
  ash: randomUUID(),
  hallDoor: "hx6door00001",
  /** Lane HX-5's hex scene (HX5-): a wall of rock with a gap, and a one-row corridor. */
  vault: randomUUID(),
  vaultGob: randomUUID(),
  vaultOgre: randomUUID(),
  vaultEntry: randomUUID(),
  /** HX7-'s Large pony and the Medium Kip who rides it, and the trap HX7-2 draws. */
  pony: randomUUID(),
  kip: randomUUID(),
  trapId: "",
  /** Lane HX-9b's hex scenes (HX9b-): a walled room on hex rows and one on hex columns. */
  cellar: randomUUID(),
  ossuary: randomUUID(),
  cellarGob: randomUUID(),
  cellarFar: randomUUID(),
  cellarDoor: "hx9bdoor0001",
  /** HX9b-5's open 200 by 200 hex scene, and HX9b-6's square one with a builder floor of 6,000 squares. */
  moorland: randomUUID(),
  granary: randomUUID(),
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

/** Picks a view on a page through the test hook, as the View menu would. */
async function pickView(page: Page, pick: "isometric" | "follow"): Promise<void> {
  await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate((p) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(p), pick);
}

/**
 * A token's node on the isometric board (pervision.e2e.ts isoNode):
 * "standee" with its opacity on the relief stage, "flat" on the ground
 * stage only, where the stand rule lays a creature under the viewer's fog,
 * or null where the page draws none.
 */
async function isoNode(page: Page, tokenId: string): Promise<{ as: "standee"; opacity: number } | { as: "flat" } | null> {
  return page.evaluate((id) => {
    type Node = { opacity(): number };
    type Stage = { width(): number; listening(): boolean; getLayers(): unknown[]; findOne(s: string): Node | undefined };
    const stages = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.filter((s) => s.width() > 0);
    const relief = stages.find((s) => s.listening() && s.getLayers().length === 3);
    if (!relief) return null;
    const ground = stages.find((s) => s !== relief && !s.listening() && s.findOne(`#${id}`) !== undefined);
    if (ground) return { as: "flat" as const };
    const node = relief.findOne(`#${id}`);
    return node ? { as: "standee" as const, opacity: node.opacity() } : null;
  }, tokenId);
}

async function isoNodeIs(page: Page, tokenId: string, want: "standee" | "flat" | null, what: string): Promise<void> {
  let seen: string | null = null;
  await waitFor(what, async () => {
    const node = await isoNode(page, tokenId);
    seen = node?.as ?? null;
    return seen === want ? true : null;
  }).catch((err: Error) => {
    throw new Error(`${err.message}: it is ${seen}`);
  });
}

/** Reveals one fog sub-cell, by a square inside it, since a fog shape takes the sub-cells whose middles it holds. */
function revealSubcell(sx: number, sy: number) {
  return { id: randomUUID(), mode: "reveal" as const, shape: { kind: "rect" as const, x: (sx + 0.25) / FOG_SUBCELLS, y: (sy + 0.25) / FOG_SUBCELLS, w: 0.5 / FOG_SUBCELLS, h: 0.5 / FOG_SUBCELLS } };
}

function creature(id: string, name: string, size: "tiny" | "medium" | "large", hex: Hex, extra: Record<string, unknown> = {}) {
  return { t: "token.create" as const, token: { id, sceneId: run.sceneId, kind: "monster", name, size, ...placedOnHex(G, { size, x: 0, y: 0 }, hex), disposition: "hostile", visibility: "all", actor: { inline: ACTOR }, ...extra } };
}

async function moveTo(id: string, size: "tiny" | "medium" | "large", hex: Hex): Promise<void> {
  const at = placedOnHex(G, { size, x: 0, y: 0 }, hex);
  await ops.send({ t: "token.update", tokenId: id, patch: at });
  await waitFor(`${id} on hex ${hex.col},${hex.row}`, () => {
    const t = dmSocket.state?.tokens[id];
    return t && Math.abs(t.x - at.x) < 1e-9 && Math.abs(t.y - at.y) < 1e-9 ? true : null;
  });
}

/**
 * Where a ground point shows on the isometric board (iso.e2e.ts isoPoint at
 * no height), or null until the board is up: through the ground group's
 * transform on the listening relief stage.
 */
async function isoGroundPoint(page: Page, world: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  return page.evaluate((p) => {
    type Node = { getChildren(): Node[]; getAbsoluteTransform(): { point(p: { x: number; y: number }): { x: number; y: number } } };
    type Stage = Node & { width(): number; listening(): boolean; getLayers(): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } };
    const stage = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find((s) => s.width() > 0 && s.listening() && s.getLayers().length === 3);
    const ground = stage?.getLayers()[0]?.getChildren()[0]?.getChildren()[0];
    if (!stage || !ground) return null;
    const at = ground.getAbsoluteTransform().point(p);
    const box = stage.container().getBoundingClientRect();
    return { x: box.left + at.x, y: box.top + at.y };
  }, world);
}

/** The Area tool's reading after a tap inside a placed area, in Top-down or on the isometric board's ground: its "In area" list. */
async function areaReading(page: Page, world: { x: number; y: number }, title: string, view: "follow" | "isometric" = "follow"): Promise<string> {
  await pickTool(page, "Area");
  const p = view === "isometric" ? await waitFor("the isometric board", () => isoGroundPoint(page, world)) : await pagePoint(page, BOUNDS, world);
  await assertCanvasAt(page, p);
  if (page === dm) await page.mouse.click(p.x, p.y);
  else await page.touchscreen.tap(p.x, p.y);
  const toolbar = page.getByRole("toolbar", { name: "Area options" });
  const line = toolbar.locator("[data-options-line]").first();
  await line.filter({ hasText: title }).waitFor();
  // A tap that missed the area, or landed on a creature, starts a new one under the same title, with Place.
  assert.equal(await toolbar.getByRole("button", { name: "Place", exact: true }).count(), 0, `the tap picked the placed ${title}, not a new one`);
  return (await line.textContent()) ?? "";
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

/** Opens Room settings: the Menu's side tab on a wide screen, else the Panels sheet's Menu. */
async function openRoomSettings(page: Page): Promise<Locator> {
  const wide = (await page.getByRole("tablist", { name: "Panels" }).count()) > 0;
  let menu: Locator;
  if (wide) {
    await openSideTab(page, "Menu");
    menu = page.getByRole("tabpanel", { name: /^Menu/ });
  } else {
    const picker = page.getByRole("list", { name: "Panels" });
    if (!(await picker.isVisible())) await page.locator('button[title="Panels"]').click();
    await picker.getByRole("button", { name: /^Menu/ }).click();
    menu = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true }).last();
  }
  const back = page.getByRole("button", { name: /^Back to Menu/ });
  if ((await back.count()) > 0 && (await back.first().isVisible())) await back.first().click();
  await menu.getByRole("button", { name: /^Room settings/ }).click();
  await menu.getByRole("radiogroup", { name: "Grid on new scenes" }).waitFor();
  return menu;
}

/** The room socket of each DM page but the desk's own (dmSocket), so a wait reads that page's scene. */
const dmPageSockets = new Map<Page, SocketWatch>();

/**
 * A phone signed in as the DM by the DM link, on a session of its own. A
 * session gets 20 snapshots a minute (server/rooms/budgets.ts), and a size
 * sweep's phone spends two at each size and scale: its load, which lands on
 * the player scene, and its switch back. On the desk's session those came
 * on top of the desk's own and the sweep before, and the switch past 20
 * waited out the window, longer than viewScene waits.
 */
async function dmPhone(size: (typeof SIZES)[number]): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const res = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/dm`, { headers: { Origin: server.origin }, data: { key: run.dmKey, memberId: dmSocket.you?.memberId } });
  assert.ok(res.ok(), `the DM link answered ${res.status()}`);
  const page = await context.newPage();
  const socket = new SocketWatch("phone");
  await socket.attach(context, page);
  dmPageSockets.set(page, socket);
  consoles.phone.attach(page);
  return { context, page };
}

/** Shows the DM a scene from its row in the Scenes panel, and waits for its settings. */
async function viewScene(page: Page, panel: Locator, sceneId: string): Promise<void> {
  const name = dmSocket.state?.scenes[sceneId]?.name ?? "";
  const socket = page === dm ? dmSocket : dmPageSockets.get(page);
  assert.ok(socket, "viewScene waits on the page's own socket");
  await panel.getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
  await waitFor(`the DM on ${name}`, () => socket.you?.sceneId === sceneId || null);
  const field = panel.getByRole("textbox", { name: "Scene name" }).last();
  await waitFor(`${name}'s settings`, async () => ((await field.inputValue()) === name ? true : null));
}

/** The lines that describe an element, by its `aria-describedby`. */
async function describedBy(target: Locator): Promise<string[]> {
  const ids = ((await target.getAttribute("aria-describedby")) ?? "").split(" ").filter(Boolean);
  return Promise.all(ids.map(async (id) => (await target.page().locator(`[id="${id}"]`).count()) > 0 ? target.page().locator(`[id="${id}"]`).innerText() : `missing ${id}`));
}

/**
 * What is wrong with a choice of three even options that wrap
 * (docs/design-v1-design-pass.md 4.2), as lines: `stack` wants one option
 * per row at the group's full width, else all three on one row. Every
 * option is 44 px or more each way, no word breaks across lines, and
 * `wraps` names an option whose words take two lines, broken between them.
 */
async function threeLines(group: Locator, stack: boolean, screen: string, wraps: string | null = null): Promise<string[]> {
  const got = await group.evaluate((node) => {
    // The e2e files build without the DOM's types, so the few used here are named by hand.
    type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
    type Text = { nodeType: number; textContent: string | null };
    type Elem = { getBoundingClientRect(): Rect; querySelectorAll(s: string): ArrayLike<Elem>; childNodes: ArrayLike<Text> };
    type Range = { selectNodeContents(n: unknown): void; setStart(n: unknown, at: number): void; setEnd(n: unknown, at: number): void; getClientRects(): ArrayLike<Rect> };
    const doc = (globalThis as unknown as { document: { createRange(): Range } }).document;
    const el = node as unknown as Elem;
    const box = el.getBoundingClientRect();
    const lineTops = (range: Range) => new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
    const options = Array.from(el.querySelectorAll("label")).map((label) => {
      const r = label.getBoundingClientRect();
      const text = Array.from(label.childNodes).find((n) => n.nodeType === 3);
      const words = text?.textContent ?? "";
      const range = doc.createRange();
      let lines = 0;
      const split: string[] = [];
      if (text) {
        range.selectNodeContents(text);
        lines = lineTops(range);
        let at = 0;
        for (const word of words.split(" ")) {
          range.setStart(text, at);
          range.setEnd(text, at + word.length);
          if (lineTops(range) > 1) split.push(word);
          at += word.length + 1;
        }
      }
      return { text: words, l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, lines, split };
    });
    return { l: box.left, r: box.right, options };
  });
  const out: string[] = [];
  const say = (line: string) => out.push(`${screen}: ${line}`);
  if (got.options.length !== 3) say(`${got.options.length} options`);
  got.options.forEach((o, i) => {
    if (o.w < 44 || o.h < 44) say(`${o.text} is ${o.w.toFixed(1)} x ${o.h.toFixed(1)}`);
    if (o.split.length > 0) say(`${o.text} breaks inside ${o.split.join(", ")}`);
    const before = got.options[i - 1];
    if (stack) {
      if (Math.abs(o.l - got.l) > 1 || Math.abs(o.r - got.r) > 1) say(`${o.text} spans ${o.l.toFixed(1)} to ${o.r.toFixed(1)}, not the row's ${got.l.toFixed(1)} to ${got.r.toFixed(1)}`);
      if (before && o.t < before.b - 1) say(`${o.text} is not under ${before.text}`);
    } else if (before && (Math.abs(o.t - before.t) > 1 || o.l < before.r - 1)) say(`${o.text} is not beside ${before.text}`);
  });
  if (wraps) {
    const o = got.options.find((x) => x.text === wraps);
    if (o?.lines !== 2) say(`${wraps} takes ${o?.lines ?? 0} lines, not 2`);
  }
  return out;
}

/** Whether the page, or the scroller that holds `inside`, scrolls sideways. */
async function sideways(inside: Locator, screen: string): Promise<string[]> {
  const wide = await inside.evaluate((node) => {
    type Elem = { scrollWidth: number; clientWidth: number; parentElement: Elem | null; tagName: string; textContent: string | null; getBoundingClientRect(): { left: number; right: number }; querySelectorAll(s: string): ArrayLike<Elem> };
    const page = globalThis as unknown as { document: { documentElement: Elem }; getComputedStyle(el: Elem): { overflowX: string } };
    const out: string[] = [];
    const root = page.document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) out.push(`the page is ${root.scrollWidth} px wide in ${root.clientWidth}`);
    for (let at: Elem | null = node as unknown as Elem; at; at = at.parentElement) {
      const { overflowX } = page.getComputedStyle(at);
      if ((overflowX === "auto" || overflowX === "scroll") && at.scrollWidth > at.clientWidth + 1) {
        // The innermost element that runs past the scroller's right edge, so a failure names what is too wide.
        const edge = at.getBoundingClientRect().right;
        const past = Array.from(at.querySelectorAll("*")).filter((e) => e.getBoundingClientRect().right > edge + 1);
        const last = past[past.length - 1];
        out.push(`a scroller is ${at.scrollWidth} px wide in ${at.clientWidth}${last ? `, past its edge: ${last.tagName} "${(last.textContent ?? "").slice(0, 40)}"` : ""}`);
      }
    }
    return out;
  });
  return wide.map((line) => `${screen}: ${line}`);
}

/** The limit lines, which say what a hex scene leaves to squares (section 6's table). Walking and an area's movement inside are hexes' from H2. */
const LIMIT_LINES = new Set<string>(Object.values(HEX_LIMITS));

/** Every word "square" the page shows, but the Squares choices' own name and H1's limit lines. */
async function squareWords(page: Page): Promise<string[]> {
  const text = await page.locator("body").innerText();
  return text
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line) => line !== "Squares" && !LIMIT_LINES.has(line) && /square/i.test(line));
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

/** FU39-B: the size's count stays inside the bar and the panel on each measured hex screen. */
async function hexSizeControls(page: Page, tokenId: string, at: string, shot: string): Promise<string[]> {
  const socket = page === dm ? dmSocket : dmPageSockets.get(page);
  assert.ok(socket);
  await ops.send({ t: "token.update", tokenId, patch: { size: "large", x: 4, y: 3 } });
  await waitFor("FU39-B's Large token", () => socket.state?.tokens[tokenId]?.size === "large" || null);
  await page.getByRole("button", { name: "Fit the map to the screen" }).click();
  const point = await pagePoint(page, dmSocket.state!.scenes[run.camp]!.bounds, { x: 5, y: 4 });
  await assertCanvasAt(page, point);
  await page.mouse.click(point.x, point.y);
  const bar = page.getByRole("dialog", { name: /^FU39 Size token/ }).first();
  await bar.waitFor();
  await expandBar(bar);
  const group = bar.getByRole("group", { name: "Size", exact: true });
  await group.scrollIntoViewIfNeeded();
  const live = group.locator('[aria-live="polite"]');
  const words = async () => (await live.innerText()).replace(/\s+/g, " ").trim();
  await waitFor("FU39-B's Large hex count", async () => (await words()) === "Large (3 hexes)" || null);
  const off = alignmentLines(await measureAlignment(group), `FU39-B hex Size stepper at ${at}`);
  await shots.take(page, `fu39b-size-large-${shot}`);
  const smaller = group.getByRole("button", { name: "One size smaller" });
  const larger = group.getByRole("button", { name: "One size larger" });
  const before = { smaller: await smaller.boundingBox(), larger: await larger.boundingBox() };
  assert.ok(before.smaller && before.larger);
  for (const [size, label] of [["huge", "Huge (7 hexes)"], ["gargantuan", "Gargantuan (12 hexes)"]] as const) {
    await larger.click();
    await waitFor(`FU39-B's ${label}`, async () => (socket.state?.tokens[tokenId]?.size === size && (await words()) === label) || null);
    const after = { smaller: await smaller.boundingBox(), larger: await larger.boundingBox() };
    assert.ok(after.smaller && after.larger);
    assert.ok(Math.abs(before.smaller.x - after.smaller.x) <= 1 && Math.abs(before.larger.x - after.larger.x) <= 1, `FU39-B Size buttons moved at ${at}`);
  }
  assert.equal(await larger.isDisabled(), true);
  assert.equal(await smaller.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "focus leaves the disabled plus button");
  off.push(...alignmentLines(await measureAlignment(group), `FU39-B Gargantuan Size stepper at ${at}`));
  off.push(...(await sideways(group, `FU39-B Gargantuan Size stepper at ${at}`)));
  await shots.take(page, `fu39b-size-gargantuan-${shot}`);
  await (await barControl(bar, "Details")).click();
  const panel = page.locator("[data-token-panel]").filter({ visible: true });
  const fold = panel.getByRole("button", { name: "Stats", exact: true });
  const wasFolded = (await fold.getAttribute("aria-expanded")) === "false";
  if (wasFolded) await fold.click();
  const stats = panel.locator("[data-panel-group]").filter({ has: page.getByRole("button", { name: "Stats", exact: true }) });
  const size = stats.getByRole("combobox", { name: "Size", exact: true });
  await size.scrollIntoViewIfNeeded();
  assert.deepEqual(await size.locator("option").allTextContents(), ["Tiny (1 hex)", "Small (1 hex)", "Medium (1 hex)", "Large (3 hexes)", "Huge (7 hexes)", "Gargantuan (12 hexes)", "Custom"]);
  off.push(...alignmentLines(await measureAlignment(stats), `FU39-B hex Stats at ${at}`));
  off.push(...(await sideways(stats, `FU39-B hex Stats at ${at}`)));
  await shots.take(page, `fu39b-size-panel-${shot}`);
  await size.selectOption("large");
  await waitFor("FU39-B's panel restores Large", () => socket.state?.tokens[tokenId]?.size === "large" || null);
  if (wasFolded) await fold.click();
  await page.keyboard.press("Escape");
  await openScenes(page);
  await page.keyboard.press("Escape");
  return off;
}

/** Takes back the newest Setup step from Setup history, as a DM does, and closes the sheet. */
async function undoSetup(page: Page): Promise<void> {
  const { sheet } = await setupHistory(page);
  const undo = sheet.getByRole("button", { name: "Undo setup", exact: true });
  await untilReady(undo, "Undo setup");
  await undo.click();
  await sheet.locator("[data-history-result]").filter({ hasText: /^Undid setup: / }).waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
}

describe("raccoon-vtt hex grids: the board", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    benContext = await browser.newContext();
    for (const c of [dmContext, patContext]) await c.addInitScript(HOOK_FLAG);
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
    run.dmKey = link.slice(link.indexOf("#dm=") + "#dm=".length);
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

    run.patId = await join(patContext, "Pat", "#30a46c");
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

  test("HX-5. the Straight ruler counts hexes, and Walking is on offer from phase H2", async () => {
    await pickTool(dm, "Ruler");
    const bar = dm.getByRole("toolbar", { name: "Ruler options" });
    await bar.waitFor();
    const line = bar.locator("[data-options-line]");
    assert.equal(await line.filter({ hasText: "Walking needs squares." }).count(), 0, "no limit line for walking");
    // Six hexes down a slant of the lattice: 30 ft, where the squares under its ends would read 25.
    let end: Hex = { col: 4, row: 8 };
    for (let i = 0; i < 6; i++) end = hexNeighbors(G, end)[1]!;
    await holdDrag(dm, hexCenter(G, { col: 4, row: 8 }), hexCenter(G, end));
    await dm.mouse.up();
    await line.filter({ hasText: /^30 ft · / }).waitFor();
    await shots.take(dm, "hex-dm-ruler");
    const { group, popover } = await measureChoice(dm);
    const walking = group.getByRole("radio", { name: "Walking", exact: true });
    assert.equal(await walking.isDisabled(), false, "Walking is on offer on hexes");
    assert.equal(await group.getByRole("radio", { name: "Straight", exact: true }).isChecked(), true);
    if (popover) {
      await dm.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });
    }
    await pickTool(dm, "Select");
  });

  test("HX-6. an area's options offer movement inside with no squares-only line, since a walk on hexes reads it from H2", async () => {
    await pickTool(dm, "Area");
    await pickOption(dm, "Area", "Shape", "Sphere");
    await draftArea(dm);
    const bar = dm.getByRole("toolbar", { name: "Area options" });
    await bar.getByRole("button", { name: "More options" }).click();
    const more = dm.getByRole("dialog", { name: "More Area options" });
    await more.getByRole("radiogroup", { name: "Movement inside" }).waitFor();
    assert.equal(await more.getByText("Counted on squares only.", { exact: true }).count(), 0);
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

  test("HX-8. under fog a goblin reaches neither of Pat's boards, a revealed sub-cell of its hex sends it lying flat, its whole hex stands it, and a Tiny imp revealed past its drawn box lies flat for Pat and stands bright for the DM", async () => {
    // Thorn, Pat's cleric, on the revealed west strip. The goblin and a Tiny imp under fog to the east.
    await ops.send(creature(run.thorn, "Thorn", "medium", { col: 3, row: 12 }, { kind: "pc", disposition: "ally", ownerIds: [run.patId] }));
    await ops.send(creature(run.imp, "Imp", "tiny", { col: 14, row: 12 }));
    await moveTo(run.goblin, "medium", { col: 9, row: 12 });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true } });
    await ops.send({ t: "fog.reset", sceneId: run.sceneId, to: "hidden" });
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 6, h: 20 } }] });
    await waitFor("Thorn in Pat's copy", () => (patSocket.state?.tokens[run.thorn] ? true : null));
    await waitFor("the goblin and the imp out of Pat's copy", () => (!patSocket.state?.tokens[run.goblin] && !patSocket.state?.tokens[run.imp] ? true : null));
    await shots.take(pat, "hex-pat-fog-top-down");
    await pickView(pat, "isometric");
    await pickView(dm, "isometric");
    await isoNodeIs(pat, run.thorn, "standee", "Thorn standing on Pat's board");
    assert.equal(await isoNode(pat, run.goblin), null, "Pat's board draws the fogged goblin");

    // One sub-cell of the goblin's hex, its middle's: the server sends it, and Pat's board lays it flat, the rest of its hex fogged.
    const goblinAt = goblin();
    const mid = hexCenter(G, { col: 9, row: 12 });
    const subs = footprintSubcells(G, goblinAt);
    const [sx, sy] = subs.reduce((best, s) => (Math.hypot((s[0] + 0.5) / FOG_SUBCELLS - mid.x, (s[1] + 0.5) / FOG_SUBCELLS - mid.y) < Math.hypot((best[0] + 0.5) / FOG_SUBCELLS - mid.x, (best[1] + 0.5) / FOG_SUBCELLS - mid.y) ? s : best));
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [revealSubcell(sx, sy)] });
    await waitFor("the goblin in Pat's copy", () => (patSocket.state?.tokens[run.goblin] ? true : null));
    await isoNodeIs(pat, run.goblin, "flat", "the goblin lying flat on Pat's board");
    // Its whole hex and drawn box revealed: it stands.
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: mid.x - 0.75, y: mid.y - 0.75, w: 1.5, h: 1.5 } }] });
    await isoNodeIs(pat, run.goblin, "standee", "the goblin standing on Pat's board");
    await shots.take(pat, "hex-pat-fog-isometric");

    // A sub-cell of the imp's hex past its half-cell drawn box (HX3-VIEW-03): Pat gets it, lying flat, and the DM's standee is bright.
    const imp = dmSocket.state!.tokens[run.imp]!;
    const past = footprintSubcells(G, imp).find(([x, y]) => (x + 1) / FOG_SUBCELLS <= imp.x || x / FOG_SUBCELLS >= imp.x + 0.5 || (y + 1) / FOG_SUBCELLS <= imp.y || y / FOG_SUBCELLS >= imp.y + 0.5);
    assert.ok(past, "the imp's hex reaches past its drawn box");
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [revealSubcell(past[0], past[1])] });
    await waitFor("the imp in Pat's copy", () => (patSocket.state?.tokens[run.imp] ? true : null));
    await isoNodeIs(pat, run.imp, "flat", "the imp lying flat on Pat's board");
    await isoNodeIs(dm, run.imp, "standee", "the imp standing on the DM's board");
    assert.equal((await isoNode(dm, run.imp)) && (await isoNode(dm, run.imp) as { opacity: number }).opacity, 1, "bright, as players get it");
    await shots.take(dm, "hex-dm-fog-isometric");
    await pickView(pat, "follow");
    await pickView(dm, "follow");
  });

  test("HX-9. per player on a hex scene: a goblin in the dark that Ben's darkvision sees reaches Pat while the party shares sight, and leaves both of Pat's boards once each sees for themselves", async () => {
    // A hex scene has no walls in H1, so a lit goblin shows from anywhere: darkvision, which reaches only so far, makes the two players' sight differ.
    run.benId = await join(benContext, "Ben", "#0090ff");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { vision: { on: true, light: "dark" } } });
    await ops.send(creature(run.bree, "Bree", "medium", { col: 22, row: 6 }, { kind: "pc", disposition: "ally", ownerIds: [run.benId], actor: { inline: { ...ACTOR, senses: "Darkvision 60 ft." } } }));
    await moveTo(run.goblin, "medium", { col: 24, row: 6 });
    await waitFor("the goblin in Pat's copy by the party's sight", () => (patSocket.state?.tokens[run.goblin] ? true : null));
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { vision: { on: true, light: "dark", perPlayer: true } } });
    // Each player sees for themselves, as the DM's list in Scenes picks them.
    await ops.send({ t: "vision.holders", sceneId: run.sceneId, on: [run.patId, run.benId] });
    await waitFor("the goblin out of Pat's copy, per player", () => (patSocket.state?.tokens[run.goblin] ? null : true));
    await shots.take(pat, "hex-pat-per-player-top-down");
    await pickView(pat, "isometric");
    await waitFor("Pat's board up, with Thorn on it", async () => ((await isoNode(pat, run.thorn)) ? true : null));
    assert.equal(await isoNode(pat, run.goblin), null, "Pat's board draws a goblin only Ben sees");
    await shots.take(pat, "hex-pat-per-player-isometric");
    await pickView(pat, "follow");
  });

  test("HX-10. a fireball on a hex corner and Spirit Guardians on Thorn read the creatures the rules catch, for the DM and for Pat alike, in Top-down and in Isometric", async () => {
    // Everyone in plain sight, so Pat's list is the whole list.
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: false, vision: { on: false, light: "bright", perPlayer: false } } });
    await moveTo(run.goblin, "medium", { col: 10, row: 8 });
    await moveTo(run.ogre, "large", { col: 12, row: 9 });
    await moveTo(run.imp, "tiny", { col: 5, row: 13 });
    const dmId = dmSocket.you!.memberId;
    const corner = cornerAt(G, { hex: { col: 11, row: 9 }, k: 0 });
    await ops.send({ t: "template.create", template: { id: run.fireball, sceneId: run.sceneId, shape: "sphere", size: 20, origin: { ...corner, z: 0 }, yaw: 0, includeOrigin: true, color: "#e5484d", ownerId: dmId, visibility: "all" } });
    await ops.send({ t: "template.create", template: { id: run.guardians, sceneId: run.sceneId, shape: "emanation", size: 15, origin: { ...hexCenter(G, { col: 3, row: 12 }), z: 0 }, yaw: 0, attachedTo: run.thorn, casterId: run.thorn, includeOrigin: false, color: "#ffc53d", ownerId: dmId, visibility: "all" } });
    await waitFor("both areas in Pat's copy", () => (patSocket.state?.templates[run.fireball] && patSocket.state?.templates[run.guardians] ? true : null));
    // The DM's page hears them on its own socket, in no set order with Pat's.
    const state = await waitFor("both areas in the DM's copy", () => (dmSocket.state?.templates[run.fireball] && dmSocket.state?.templates[run.guardians] ? dmSocket.state : null));
    const ctx = { settings: state.meta.settings, bounds: BOUNDS, grid: G, walls: null, tokens: state.tokens as Record<string, Token> };
    const names = (id: string) => creaturesInArea(state.templates[id] as AreaTemplate, Object.values(state.tokens) as Token[], ctx).map((t) => state.tokens[t]!.name);
    const fireball = names(run.fireball);
    const guardians = names(run.guardians);
    assert.ok(fireball.includes("Goblin") && fireball.includes("Ogre") && !fireball.includes("Imp"), `the fireball catches ${fireball.join(", ")}`);
    assert.ok(guardians.includes("Imp") && !guardians.includes("Goblin"), `the guardians catch ${guardians.join(", ")}`);
    // A tap inside each, off any creature: in Top-down the fireball by its corner and the guardians a hex north-east
    // of Thorn. In Isometric the ogre's token stands over that corner, where a tap starts an area from the ogre, so
    // there the fireball's tap goes three cells east of its corner and the guardians' two hexes south-west of Thorn.
    const inFire = { follow: { x: corner.x, y: corner.y - 0.1 }, isometric: { x: corner.x + 3, y: corner.y - 0.3 } };
    const inGuard = { follow: hexCenter(G, { col: 4, row: 11 }), isometric: hexCenter(G, { col: 2, row: 14 }) };
    // Each page reads both in Top-down and on the isometric board's ground (D-261026-24).
    for (const page of [dm, pat]) {
      const who = page === dm ? "the DM" : "Pat";
      for (const view of ["follow", "isometric"] as const) {
        await pickView(page, view);
        for (const [where, want, title] of [[inFire[view], fireball, "20 ft Sphere"], [inGuard[view], guardians, "15 ft Emanation"]] as const) {
          const reading = await areaReading(page, where, title, view);
          assert.match(reading, new RegExp(`In area \\(${want.length}\\): `), `${who} in ${view}: ${reading}`);
          for (const name of want) assert.ok(reading.includes(name), `${who} in ${view} reads ${name}: ${reading}`);
          await page.keyboard.press("Escape");
        }
        await shots.take(page, `hex-${page === dm ? "dm" : "pat"}-area-catch${view === "isometric" ? "-isometric" : ""}`);
        await pickTool(page, "Select");
      }
      await pickView(page, "follow");
    }
    await ops.send({ t: "template.delete", templateId: run.fireball });
    await ops.send({ t: "template.delete", templateId: run.guardians });
  });

  test("HX-11. the ruler's row and Measure choice, an area's options and the export sit within 1 px at each size", async () => {
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
          await ruler.locator("[data-options-line]").waitFor();
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
          await more.getByRole("radiogroup", { name: "Movement inside" }).waitFor();
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

  test("HX4-1. Room settings start new scenes on hex rows, and the new scene form shows it: a battle mat and a map image on hex rows, a builder scene and starter maps on squares", async () => {
    await dm.bringToFront();
    const menu = await openRoomSettings(dm);
    // The scene's own Grid shape choice, described by the setting's help (docs/design-v1-design-pass.md 4.2).
    const start = menu.getByRole("radiogroup", { name: "Grid on new scenes" });
    await menu.getByText(NEW_SCENES_HELP, { exact: true }).waitFor();
    assert.deepEqual(await describedBy(start), [NEW_SCENES_HELP]);
    assert.equal(await start.getByRole("radio", { name: "Squares" }).isChecked(), true, "the room holds a hex scene, so it names hexes, but new scenes still start on squares");
    assert.equal(dmSocket.state?.meta.settings.newScenes, undefined);
    await start.getByRole("radio", { name: "Hex rows" }).check();
    await waitFor("the room's new scenes on hex rows", () => dmSocket.state?.meta.settings.newScenes === "hexRows" || null);
    await menu.getByText("Feet per square or hex", { exact: true }).waitFor();
    await menu.getByText(/On hex scenes every hex is one step\. This rule counts only height there\.$/).waitFor();
    await shots.take(dm, "hx4-room-settings");

    const panel = await openScenes(dm);
    const known = new Set(Object.keys(dmSocket.state?.scenes ?? {}));
    const grid = panel.getByRole("radiogroup", { name: "Grid", exact: true });
    await panel.getByRole("radio", { name: "Builder", exact: true }).click();
    assert.equal(await grid.getByRole("radio", { name: "Squares" }).isChecked(), true, "a builder scene starts on squares");
    await grid.getByRole("radio", { name: "Hex rows" }).check();
    await panel.getByText(HEX_LIMITS.builder, { exact: true }).waitFor();
    assert.ok((await describedBy(grid)).includes(HEX_LIMITS.builder), "the builder's limit describes the choice");
    await panel.getByRole("radio", { name: "Map image", exact: true }).click();
    assert.equal(await grid.getByRole("radio", { name: "Hex rows" }).isChecked(), true, "a map image starts on the room's hex rows");
    await panel.getByText(HEX_LIMITS.starter, { exact: true }).waitFor();
    // A file name's size counts squares, so the hex help promises no scale from it (D-261028-05).
    await panel.getByText("A grid drawn on the map is looked for, and you check it or line up the hexes next.", { exact: true }).waitFor();
    await panel.getByRole("radio", { name: "Battle mat", exact: true }).click();
    assert.equal(await grid.getByRole("radio", { name: "Hex rows" }).isChecked(), true, "a battle mat starts on the room's hex rows");
    // The form's and, below it, the hex scene on screen's.
    await panel.getByText("Size in 5 ft steps", { exact: true }).first().waitFor();
    await panel.getByText("Holds 30 hexes across and 22 rows down.", { exact: true }).first().waitFor();
    await shots.take(dm, "hx4-new-scene-hex");
    await panel.getByPlaceholder("Battle mat").fill("Hex camp");
    await panel.getByRole("button", { name: "Create", exact: true }).click();
    const made = await waitFor("the new mat", () => Object.values(dmSocket.state?.scenes ?? {}).find((sc) => sc?.name === "Hex camp" && !known.has(sc.id)));
    assert.equal(made.gridShape, "hexRows");
    run.camp = made.id;
    await waitFor("the DM on it", () => dmSocket.you?.sceneId === made.id || null);
  });

  test("HX4-2. a scene's Grid shape changes its grid, and a square scene with painted ground keeps its hex choices off, saying why, with focus left on Squares", async () => {
    await ops.send({ t: "scene.create", scene: { id: run.moor, name: "Moor", bounds: { w: 20, h: 20 } } });
    await ops.send({ t: "build.paint", sceneId: run.moor, terrain: "dirt", cells: ["4,4"] });
    await waitFor("the moor in the DM's state", () => dmSocket.state?.scenes[run.moor] ?? null);
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.moor);
    const map = await openSceneGroup(panel, "Map image and grid");
    const shape = map.getByRole("radiogroup", { name: "Grid shape", exact: true });
    const why = "This scene has painted ground on its squares, which can't stand on hexes. Remove them to change the grid.";
    await map.getByText(why, { exact: true }).waitFor();
    assert.equal(await shape.getByRole("radio", { name: "Hex rows" }).isDisabled(), true);
    assert.equal(await shape.getByRole("radio", { name: "Hex columns" }).isDisabled(), true);
    assert.deepEqual(await describedBy(shape), ["Hex rows have pointed tops and run straight across. Hex columns have flat tops and run straight down.", why]);
    const squares = shape.getByRole("radio", { name: "Squares" });
    await squares.focus();
    await dm.keyboard.press("ArrowRight");
    assert.equal(await squares.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, "focus stays on Squares");
    assert.equal(dmSocket.state?.scenes[run.moor]?.gridShape, undefined);
    await shots.take(dm, "hx4-grid-shape-refused");

    await viewScene(dm, panel, run.camp);
    await openSceneGroup(panel, "Map image and grid");
    await shape.getByRole("radio", { name: "Hex columns" }).check();
    await waitFor("the camp on hex columns", () => dmSocket.state?.scenes[run.camp]?.gridShape === "hexColumns" || null);
    await openSceneGroup(panel, "Size and view");
    await panel.getByText("Holds 34 columns across and 20 hexes down.", { exact: true }).waitFor();
    await shape.getByRole("radio", { name: "Hex rows" }).check();
    await waitFor("the camp back on hex rows", () => dmSocket.state?.scenes[run.camp]?.gridShape === "hexRows" || null);
  });

  test("HX4-3. Line up grid on a hex map: a box over 7 hexes, px per hex, Find the grid on, and Apply stores the hexes' size", async () => {
    const data = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 80, g: 90, b: 70 } } }).png().toBuffer();
    const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
    assert.ok(res.ok(), `the upload answered ${res.status()}`);
    const art = (await res.json()) as { id: string; width: number; height: number };
    await ops.send({ t: "scene.setMap", sceneId: run.camp, map: { assetId: art.id, widthPx: art.width, heightPx: art.height, cellPx: 50, originPx: { x: 0, y: 0 } } });
    await waitFor("the camp's map", () => dmSocket.state?.scenes[run.camp]?.map?.assetId === art.id || null);
    const panel = await openScenes(dm);
    const map = await openSceneGroup(panel, "Map image and grid");
    const find = map.getByRole("button", { name: "Find the grid", exact: true });
    assert.equal(await find.isDisabled(), false, "Find the grid looks for hexes too (HX-9c)");
    await map.getByText(HEX_LIMITS.counting, { exact: true }).waitFor();
    assert.equal(await map.getByText("Or count the squares").count(), 0);
    await map.getByRole("button", { name: "Line up the grid", exact: true }).click();
    const bar = dm.getByRole("toolbar", { name: "Line up grid options" });
    await bar.locator("[data-options-line]").filter({ hasText: "Drag a box over 3 hexes across. Fine-tune it by its corners." }).waitFor();
    await bar.getByText("50 px per hex", { exact: true }).filter({ visible: true }).first().waitFor();
    assert.equal(await bar.getByRole("button", { name: "Find the grid", exact: true }).isDisabled(), false);
    await bar.getByRole("button", { name: /^Nudge/ }).first().click();
    const larger = dm.getByRole("button", { name: "Make the hexes larger" });
    for (let i = 0; i < 3; i++) await larger.click();
    await dm.keyboard.press("Escape");
    await bar.getByText("51 px per hex", { exact: true }).filter({ visible: true }).first().waitFor();
    await shots.take(dm, "hx4-line-up-hexes");
    await bar.getByRole("button", { name: "Apply", exact: true }).click();
    const lined = await waitFor("the camp's hexes at 51 px", () => (dmSocket.state?.scenes[run.camp]?.map?.cellPx === 51 ? dmSocket.state.scenes[run.camp]!.map! : null));
    assert.ok(lined.originPx.x >= 0 && lined.originPx.y >= 0, "a hex scene's origin never lies before the image");
    await pickTool(dm, "Select");
  });

  test("FU39-B-G2. a pending 51 px alignment survives Hex columns, Squares and Hex rows before Apply", async () => {
    const before = dmSocket.state!.scenes[run.camp]!;
    assert.ok(before.map);
    try {
      await ops.send({ t: "scene.setGrid", sceneId: run.camp, cellPx: 50, originPx: before.map.originPx });
      await waitFor("FU39-B's stored 50 px grid", () => dmSocket.state?.scenes[run.camp]?.map?.cellPx === 50 || null);
      await pickTool(dm, "Line up grid");
      const bar = dm.getByRole("toolbar", { name: "Line up grid options" });
      await bar.getByText("50 px per hex", { exact: true }).filter({ visible: true }).first().waitFor();
      await bar.getByRole("button", { name: /^Nudge/ }).first().click();
      for (let i = 0; i < 3; i++) await dm.getByRole("button", { name: "Make the hexes larger" }).click();
      await dm.keyboard.press("Escape");
      await bar.getByText("51 px per hex", { exact: true }).filter({ visible: true }).first().waitFor();
      for (const [label, shape, cell] of [["Hex columns", "hexColumns", "hex"], ["Squares", undefined, "square"], ["Hex rows", "hexRows", "hex"]] as const) {
        const panel = await openScenes(dm);
        await openSceneGroup(panel, "Map image and grid");
        await panel.getByRole("radiogroup", { name: "Grid shape", exact: true }).getByRole("radio", { name: label, exact: true }).check();
        await waitFor(`FU39-B's switch to ${label}`, () => dmSocket.state?.scenes[run.camp]?.gridShape === shape || null);
        assert.equal(dmSocket.state!.scenes[run.camp]!.map!.cellPx, 50, "switching the shape does not apply the pending size");
        await bar.getByText(`51 px per ${cell}`, { exact: true }).filter({ visible: true }).first().waitFor();
      }
      await shots.take(dm, "fu39b-grid-pending-size");
      await bar.getByRole("button", { name: "Apply", exact: true }).click();
      await waitFor("FU39-B's measured grid applied", () => dmSocket.state?.scenes[run.camp]?.map?.cellPx === 51 || null);
    } finally {
      await ops.send({ t: "scene.setGrid", sceneId: run.camp, cellPx: before.map.cellPx, originPx: before.map.originPx });
      await ops.send({ t: "scene.update", sceneId: run.camp, patch: { gridShape: before.gridShape ?? "squares", bounds: before.bounds } });
      await waitFor("FU39-B's camp grid restored", () => {
        const scene = dmSocket.state?.scenes[run.camp];
        return (scene?.gridShape === before.gridShape && scene?.map?.cellPx === before.map!.cellPx && scene.map.originPx.x === before.map!.originPx.x && scene.map.originPx.y === before.map!.originPx.y && scene.bounds.w === before.bounds.w && scene.bounds.h === before.bounds.h) || null;
      });
      await dm.keyboard.press("Escape");
      await pickTool(dm, "Select");
    }
  });

  test("HX4-4. no square on a hex scene's screens, the DM's settings or Pat's board, but the Squares choices", async () => {
    const panel = await openScenes(dm);
    await openSceneGroup(panel, "Map image and grid");
    await openSceneGroup(panel, "Size and view");
    assert.deepEqual(await squareWords(dm), [], "the DM's screen");
    await pat.bringToFront();
    assert.deepEqual(await squareWords(pat), [], "Pat's screen");
    await dm.bringToFront();
  });

  test("HX4-5. Room settings, the new scene form on hexes, a hex scene's settings, Line up grid's options, the builder's line and FU39-B-G1's token Size controls sit within 1 px at each size", async () => {
    const off: string[] = [];
    const sizeToken = randomUUID();
    let phone: Awaited<ReturnType<typeof dmPhone>> | null = null;
    try {
      await ops.send({ t: "token.create", token: { id: sizeToken, sceneId: run.camp, kind: "monster", name: "FU39 Size token", size: "large", x: 4, y: 3, disposition: "hostile", visibility: "all", actor: { inline: ACTOR } } });
      for (const size of SIZES) {
        let page = dm;
        if (size.touch) {
          phone ??= await dmPhone(size);
          page = phone.page;
        }
        for (const scale of SCALES) {
          const at = `${size.name} at ${scale * 100}%`;
          await openAt(page, size, scale);
          const menu = await openRoomSettings(page);
          await menu.getByRole("radiogroup", { name: "Grid on new scenes" }).scrollIntoViewIfNeeded();
          off.push(...alignmentLines(await measureAlignment(menu), `Room settings at ${at}`));
          await shots.take(page, `hx4-room-settings-${size.name}-${scale * 100}`);
          await page.keyboard.press("Escape");

          const panel = await openScenes(page);
          await viewScene(page, panel, run.camp);
          await openSceneGroup(panel, "Map image and grid");
          await openSceneGroup(panel, "Size and view");
          await panel.getByRole("radiogroup", { name: "Grid shape", exact: true }).scrollIntoViewIfNeeded();
          // The groups this lane changed. The scene list above them is not this lane's.
          off.push(...alignmentLines(await measureAlignment(sceneGroup(panel, "Map image and grid")), `a hex scene's Map image and grid at ${at}`));
          off.push(...alignmentLines(await measureAlignment(sceneGroup(panel, "Size and view")), `a hex scene's Size and view group at ${at}`));
          await shots.take(page, `hx4-scene-settings-${size.name}-${scale * 100}`);
          await panel.getByRole("radio", { name: "Builder", exact: true }).click();
          const grid = panel.getByRole("radiogroup", { name: "Grid", exact: true });
          await grid.getByRole("radio", { name: "Hex rows" }).check();
          await panel.getByText(HEX_LIMITS.builder, { exact: true }).scrollIntoViewIfNeeded();
          off.push(...alignmentLines(await measureAlignment(panel.getByRole("radiogroup", { name: "Kind of scene" }).locator("xpath=..")), `the new scene form on hexes at ${at}`));
          await shots.take(page, `hx4-new-scene-${size.name}-${scale * 100}`);
          await panel.getByRole("button", { name: "Cancel", exact: true }).first().click();
          await page.keyboard.press("Escape");

          await pickTool(page, "Line up grid");
          const bar = page.getByRole("toolbar", { name: "Line up grid options" });
          await bar.locator("[data-options-line]").first().waitFor();
          off.push(...alignmentLines(await measureAlignment(bar), `Line up grid's options at ${at}`));
          await shots.take(page, `hx4-line-up-${size.name}-${scale * 100}`);
          await pickTool(page, "Map builder");
          const build = page.getByRole("toolbar", { name: "Map builder options" });
          await build.locator("[data-options-line]").filter({ hasText: HEX_LIMITS.builder }).waitFor();
          off.push(...alignmentLines(await measureAlignment(build), `the builder's options at ${at}`));
          await shots.take(page, `hx4-builder-${size.name}-${scale * 100}`);
          await pickTool(page, "Select");
          off.push(...(await hexSizeControls(page, sizeToken, at, `${size.name}-${scale * 100}`)));
        }
      }
    } finally {
      await phone?.context.close();
      if (dmSocket.state?.tokens[sizeToken]) await ops.send({ t: "token.delete", tokenId: sizeToken });
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("dp-2a. Grid shape, Kind of scene, the new scene form's Grid and Room settings' Grid on new scenes stand one per row at full width at 320 x 568 and 130%, else share one row, Hex columns wrapping between its words at 390 x 844 and 130%, with no option under 44 px, no sideways scroll, and within 1 px at each size (docs/design-v1-design-pass.md 4.2)", async () => {
    const wrong: string[] = [];
    const off: string[] = [];
    let phone: Awaited<ReturnType<typeof dmPhone>> | null = null;
    try {
      for (const size of SIZES) {
        let page = dm;
        if (size.touch) {
          phone ??= await dmPhone(size);
          page = phone.page;
        }
        for (const scale of SCALES) {
          const at = `${size.name} at ${scale * 100}%`;
          // Measured at 320 x 568 and 130%, each row is under 220 px: 213 in a scene's settings, 187 in the new scene form.
          const stack = size.name === "320x568" && scale === 1.3;
          await openAt(page, size, scale);

          const menu = await openRoomSettings(page);
          const start = menu.getByRole("radiogroup", { name: "Grid on new scenes" });
          await start.scrollIntoViewIfNeeded();
          wrong.push(...(await threeLines(start, stack, `Grid on new scenes at ${at}`)), ...(await sideways(start, `Room settings at ${at}`)));
          off.push(...alignmentLines(await measureAlignment(start.locator("xpath=..")), `Grid on new scenes at ${at}`));
          await shots.take(page, `dp-2a-room-settings-${size.name}-${scale * 100}`);
          await page.keyboard.press("Escape");

          const panel = await openScenes(page);
          await viewScene(page, panel, run.camp);
          await openSceneGroup(panel, "Map image and grid");
          const shape = panel.getByRole("radiogroup", { name: "Grid shape", exact: true });
          await shape.scrollIntoViewIfNeeded();
          wrong.push(...(await threeLines(shape, stack, `Grid shape at ${at}`, size.name === "390x844" && scale === 1.3 ? "Hex columns" : null)), ...(await sideways(shape, `a scene's settings at ${at}`)));
          off.push(...alignmentLines(await measureAlignment(shape.locator("xpath=..")), `Grid shape at ${at}`));
          await shots.take(page, `dp-2a-grid-shape-${size.name}-${scale * 100}`);

          const kinds = panel.getByRole("radiogroup", { name: "Kind of scene", exact: true });
          await kinds.scrollIntoViewIfNeeded();
          wrong.push(...(await threeLines(kinds, stack, `Kind of scene at ${at}`)));
          off.push(...alignmentLines(await measureAlignment(kinds.locator("xpath=..")), `Kind of scene at ${at}`));
          await kinds.getByRole("radio", { name: "Battle mat", exact: true }).click();
          const grid = panel.getByRole("radiogroup", { name: "Grid", exact: true });
          await grid.scrollIntoViewIfNeeded();
          wrong.push(...(await threeLines(grid, stack, `the new scene form's Grid at ${at}`)), ...(await sideways(grid, `the new scene form at ${at}`)));
          off.push(...alignmentLines(await measureAlignment(grid.locator("xpath=..")), `the new scene form's Grid at ${at}`));
          await shots.take(page, `dp-2a-new-scene-${size.name}-${scale * 100}`);
          await panel.getByRole("button", { name: "Cancel", exact: true }).first().click();
          await page.keyboard.press("Escape");
        }
      }
    } finally {
      await phone?.context.close();
    }
    assert.deepEqual(wrong, []);
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  /** HX-6's helpers: the builder's bar, a tap on the board, and the hall's free walls in the DM's state. */
  const buildBar = (page: Page) => page.getByRole("toolbar", { name: "Map builder options" });
  async function tapAt(page: Page, world: { x: number; y: number }): Promise<void> {
    const p = await pagePoint(page, BOUNDS, world);
    await assertCanvasAt(page, p);
    await page.mouse.click(p.x, p.y);
  }
  function hallWalls(): { id: string; a: [number, number]; b: [number, number]; f: { kind: string; state?: string } }[] {
    return Object.values(dmSocket.state?.buildChunks ?? {}).flatMap((c) => (c && c.sceneId === run.hall ? (c.walls ?? []) : []));
  }
  const corner = (col: number, row: number, k: 0 | 1) => cornerAt(G, { hex: { col, row }, k });
  const same = (p: readonly [number, number], q: { x: number; y: number }) => Math.abs(p[0] - q.x) < 1e-9 && Math.abs(p[1] - q.y) < 1e-9;
  const joins = (w: { a: [number, number]; b: [number, number] }, p: { x: number; y: number }, q: { x: number; y: number }) => (same(w.a, p) && same(w.b, q)) || (same(w.a, q) && same(w.b, p));

  test("HX6-1. on a hex scene Walls and doors draws Wall lines: taps snap to hex corners and Done puts free walls down, split past 8 cells, and a drag puts a door down straight", async () => {
    await ops.send({ t: "scene.create", scene: { id: run.hall, name: "Hall", bounds: BOUNDS, gridShape: "hexRows" } });
    await waitFor("the hall in the DM's state", () => dmSocket.state?.scenes[run.hall] ?? null);
    await dm.setViewportSize({ width: 1440, height: 900 });
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.hall);
    await dm.keyboard.press("Escape");
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Walls and doors");
    const bar = buildBar(dm);
    await bar.locator("[data-options-line]").filter({ hasText: "Tap points for a wall line, then Done, or drag for a straight wall." }).waitFor();
    assert.equal(await bar.getByRole("button", { name: "Snap to hex corners" }).getAttribute("aria-pressed"), "true", "Snap to hex corners is on");

    // Each tap a little off its corner: 10 cells along row 4's north points, then down to row 8's.
    const a = corner(4, 4, 0);
    const b = corner(14, 4, 0);
    const c = corner(14, 8, 0);
    for (const p of [a, b, c]) await tapAt(dm, { x: p.x + 0.12, y: p.y + 0.06 });
    await bar.getByRole("button", { name: "Done", exact: true }).click();
    await waitFor("the wall line's three free walls", () => (hallWalls().length === 3 ? true : null));
    const walls = hallWalls();
    const mid = walls.find((w) => joins(w, a, { x: (a.x + b.x) / 2, y: a.y }));
    assert.ok(mid, `the 10 cell run splits in two at its middle: ${JSON.stringify(walls)}`);
    assert.ok(walls.some((w) => joins(w, { x: (a.x + b.x) / 2, y: a.y }, b)));
    assert.ok(walls.some((w) => joins(w, b, c)), "the run down from the corner");
    assert.ok(walls.every((w) => w.f.kind === "wall"));
    assert.equal(Object.values(dmSocket.state!.buildChunks).some((ch) => ch?.sceneId === run.hall && ch.grid !== undefined), false, "free walls carry no stamp");

    await pickOption(dm, "Map builder", "Edge", "Door");
    const p = corner(10, 10, 1);
    const q = corner(11, 10, 1);
    await holdDrag(dm, { x: p.x + 0.1, y: p.y - 0.05 }, { x: q.x - 0.1, y: q.y + 0.05 });
    await dm.mouse.up();
    await waitFor("the dragged door", () => (hallWalls().some((w) => w.f.kind === "door" && joins(w, p, q)) ? true : null));
    await shots.take(dm, "hx6-wall-lines");
  });

  test("HX6-2. a tap on a free door steps it open, Remove takes a wall off, and Undo puts it back", async () => {
    const p = corner(10, 10, 1);
    const q = corner(11, 10, 1);
    await tapAt(dm, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    await waitFor("the door open", () => (hallWalls().some((w) => joins(w, p, q) && w.f.state === "open") ? true : null));
    await pickOption(dm, "Map builder", "Edge", "Remove");
    await buildBar(dm).locator("[data-options-line]").filter({ hasText: "Tap a wall, door or window to remove it." }).waitFor();
    const b = corner(14, 4, 0);
    const c = corner(14, 8, 0);
    await tapAt(dm, { x: b.x + 0.04, y: (b.y + c.y) / 2 });
    await waitFor("the wall down taken off", () => (hallWalls().some((w) => joins(w, b, c)) ? null : true));
    await buildBar(dm).getByRole("button", { name: "Undo your last play or board change" }).click();
    await waitFor("the wall down back", () => (hallWalls().some((w) => joins(w, b, c)) ? true : null));
  });

  test("HX6-3. Difficult ground marks hexes under hex keys in a stamped chunk, and Erase takes them by hexes, with the door whose middle lies in an erased hex", async () => {
    await pickOption(dm, "Map builder", "Builder mode", "Difficult ground");
    const rough = (col: number, row: number) => {
      const ch = dmSocket.state?.buildChunks[`${run.hall}:${Math.floor(col / 16)},${Math.floor(row / 16)}`];
      return ch?.rough?.[(row % 16) * 16 + (col % 16)] === "d";
    };
    await tapAt(dm, hexCenter(G, { col: 12, row: 14 }));
    await waitFor("hex 12,14 marked", () => (rough(12, 14) ? true : null));
    assert.equal(dmSocket.state!.buildChunks[`${run.hall}:0,0`]?.grid, "hexRows", "its chunk carries the shape");
    await holdDrag(dm, hexCenter(G, { col: 2, row: 14 }), hexCenter(G, { col: 6, row: 14 }));
    await dm.mouse.up();
    await waitFor("hexes 2 to 6 of row 14 marked", () => ([2, 3, 4, 5, 6].every((c) => rough(c, 14)) ? true : null));
    assert.equal(rough(2, 13) || rough(2, 15), false, "and no hex of the rows beside");
    await shots.take(dm, "hx6-difficult-ground");

    await pickOption(dm, "Map builder", "Builder mode", "Erase");
    await buildBar(dm).locator("[data-options-line]").filter({ hasText: "Drag to erase walls, doors, windows, heights, stairs, difficult ground, labels, stamps and lights." }).waitFor();
    await tapAt(dm, hexCenter(G, { col: 4, row: 14 }));
    await waitFor("hex 4,14 erased", () => (!rough(4, 14) && rough(3, 14) && rough(5, 14) ? true : null));
    const p = corner(10, 10, 1);
    const q = corner(11, 10, 1);
    const doorHex = hexAt(G, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    await tapAt(dm, hexCenter(G, doorHex));
    await waitFor("the door erased with its hex", () => (hallWalls().some((w) => w.f.kind === "door") ? null : true));
  });

  test("HX6-4. Pat's creature on the hex next to one beside a free door opens it, and from two hexes off it is too far", async () => {
    // Along the west side of hex 5,12, between it and hex 4,12.
    const sides = hexCorners(G, { col: 5, row: 12 }).map((k) => cornerAt(G, k));
    const lat = (v: number) => Math.round(v * 64) / 64;
    const door = { id: run.hallDoor, a: [lat(sides[4]!.x), lat(sides[4]!.y)] as [number, number], b: [lat(sides[5]!.x), lat(sides[5]!.y)] as [number, number], f: { kind: "door" as const, state: "closed" as const, secret: false, discovered: false } };
    await ops.send({ t: "build.walls", sceneId: run.hall, put: [door] });
    const ash = creature(run.ash, "Ash", "medium", { col: 3, row: 12 }, { kind: "pc", disposition: "ally", ownerIds: [run.patId] });
    await ops.send({ ...ash, token: { ...ash.token, sceneId: run.hall } });
    await ops.send({ t: "room.setPlayerScene", sceneId: run.hall });
    await pat.bringToFront();
    await waitFor("the hall's door in Pat's copy", () => (Object.values(patSocket.state?.buildChunks ?? {}).some((c) => c?.sceneId === run.hall && c.walls?.some((w) => w.id === run.hallDoor)) ? true : null));
    await pat.getByRole("button", { name: "Fit the map to the screen" }).click();
    const doorMid = { x: (door.a[0] + door.b[0]) / 2, y: (door.a[1] + door.b[1]) / 2 };
    const open = async () => {
      await tapAt(pat, doorMid);
      const pill = pat.getByRole("group", { name: "Closed door" });
      await pill.getByRole("button", { name: "Open" }).click();
    };
    const doorState = () => Object.values(dmSocket.state?.buildChunks ?? {}).flatMap((c) => (c?.sceneId === run.hall ? (c.walls ?? []) : [])).find((w) => w.id === run.hallDoor)?.f;
    await open();
    await waitFor("the door open, from one hex off", () => (doorState()?.kind === "door" && (doorState() as { state: string }).state === "open" ? true : null));
    await shots.take(pat, "hx6-pat-door-open");

    await ops.send({ t: "door.set", sceneId: run.hall, door: { cx: Math.floor(doorMid.x / 16), cy: Math.floor(doorMid.y / 16), id: run.hallDoor }, state: "closed" });
    await ops.send({ t: "token.update", tokenId: run.ash, patch: placedOnHex(G, { size: "medium", x: 0, y: 0 }, { col: 2, row: 12 }) });
    await waitFor("the door shut and Ash two hexes off in Pat's copy", () => {
      const t = patSocket.state?.tokens[run.ash];
      const shut = Object.values(patSocket.state?.buildChunks ?? {}).some((c) => c?.walls?.some((w) => w.id === run.hallDoor && w.f.kind === "door" && w.f.state === "closed"));
      return t && tokenRefHex(G, t).col === 2 && shut ? true : null;
    });
    await open();
    await pat.getByText("Too far from the door.").first().waitFor();
    assert.equal((doorState() as { state: string }).state, "closed");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await dm.bringToFront();
  });

  test("HX6-5. the builder's Wall lines with a line begun, Difficult ground's hex brush and Erase sit within 1 px at each size", async () => {
    const off: string[] = [];
    let phone: Awaited<ReturnType<typeof dmPhone>> | null = null;
    try {
      for (const size of SIZES) {
        let page = dm;
        if (size.touch) {
          phone ??= await dmPhone(size);
          page = phone.page;
        }
        for (const scale of SCALES) {
          const at = `${size.name} at ${scale * 100}%`;
          await openAt(page, size, scale);
          const panel = await openScenes(page);
          await viewScene(page, panel, run.hall);
          await page.keyboard.press("Escape");
          await pickTool(page, "Map builder");
          const bar = buildBar(page);
          await pickOption(page, "Map builder", "Builder mode", "Walls and doors");
          await pickOption(page, "Map builder", "Edge", "Wall");
          await page.getByRole("button", { name: "Fit the map to the screen" }).click();
          await tapAt(page, corner(15, 10, 0));
          await bar.getByRole("button", { name: "Done", exact: true }).waitFor();
          off.push(...alignmentLines(await measureAlignment(bar), `Wall lines with a line begun at ${at}`));
          await shots.take(page, `hx6-wall-line-bar-${size.name}-${scale * 100}`);
          // A new mode drops the line begun.
          await pickOption(page, "Map builder", "Builder mode", "Difficult ground");
          await bar.locator("[data-options-line]").first().waitFor();
          off.push(...alignmentLines(await measureAlignment(bar), `Difficult ground on hexes at ${at}`));
          await shots.take(page, `hx6-rough-bar-${size.name}-${scale * 100}`);
          await pickOption(page, "Map builder", "Builder mode", "Erase");
          await bar.locator("[data-options-line]").filter({ hasText: "Drag to erase walls" }).waitFor();
          off.push(...alignmentLines(await measureAlignment(bar), `Erase on hexes at ${at}`));
          await shots.take(page, `hx6-erase-bar-${size.name}-${scale * 100}`);
          await pickTool(page, "Select");
        }
      }
    } finally {
      await phone?.context.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  /** HX-5's vault: rock down column 10 with a gap at row 6, and a block of rock east of it with a one-row corridor along row 14. */
  const VAULT_ROCK = (h: Hex) => (h.col === 10 && h.row !== 6) || (h.col >= 16 && h.col <= 22 && h.row >= 11 && h.row <= 17 && h.row !== 14);
  const vaultToken = (id: string) => dmSocket.state?.tokens[id];
  const onVaultHex = (id: string, size: "medium" | "large", hex: Hex) => {
    const at = placedOnHex(G, { size, x: 0, y: 0 }, hex);
    const t = vaultToken(id);
    return t && Math.abs(t.x - at.x) < 1e-9 && Math.abs(t.y - at.y) < 1e-9 ? t : null;
  };

  test("HX5-1. on a hex scene that stops moves the walking ruler walks round the rock through its gap, longer than the straight hexes", async () => {
    await ops.send({ t: "scene.create", scene: { id: run.vault, name: "Vault", bounds: BOUNDS, gridShape: "hexRows" } });
    await waitFor("the vault in the DM's state", () => dmSocket.state?.scenes[run.vault] ?? null);
    // The DM's copy holds the build of the scene in view, so the vault is opened before its walls go down.
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.vault);
    await dm.keyboard.press("Escape");
    await ops.send({ t: "scene.update", sceneId: run.vault, patch: { blockMovement: true } });
    const walls = wallsRound(G, BOUNDS, VAULT_ROCK);
    for (let i = 0; i < walls.length; i += 100) await ops.send({ t: "build.walls", sceneId: run.vault, put: walls.slice(i, i + 100) });
    await waitFor("the vault's walls, and moves stopped there", () => (dmSocket.state?.scenes[run.vault]?.blockMovement === true && Object.values(dmSocket.state?.buildChunks ?? {}).reduce((n, c) => n + (c?.sceneId === run.vault ? (c.walls?.length ?? 0) : 0), 0) === walls.length ? true : null));
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await pickTool(dm, "Ruler");
    const { group, popover } = await measureChoice(dm);
    await group.getByRole("radio", { name: "Walking", exact: true }).click();
    if (popover) {
      await dm.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });
    }
    // Eight hexes east along row 9, through the rock: 40 ft straight, and the walk goes up through the gap at row 6.
    await holdDrag(dm, hexCenter(G, { col: 6, row: 9 }), hexCenter(G, { col: 14, row: 9 }));
    await dm.mouse.up();
    const line = dm.getByRole("toolbar", { name: "Ruler options" }).locator("[data-options-line]");
    const reading = await waitFor("the walking reading", async () => {
      const text = await line.innerText();
      const m = /Walking (\d+) ft/.exec(text);
      return m ? Number(m[1]) : null;
    });
    assert.ok(reading > 40 && reading % 5 === 0, `${reading} ft walks round the rock, whole hexes`);
    await waitFor("the board's walk drawn round the rock", async () => ((await boardTexts(dm)).some((t) => t.startsWith(`Walking ${reading} ft`)) ? true : null), 5_000);
    await shots.take(dm, "hx5-walking-ruler");
    const back = await measureChoice(dm);
    await back.group.getByRole("radio", { name: "Straight", exact: true }).click();
    if (back.popover) {
      await dm.keyboard.press("Escape");
      await back.popover.waitFor({ state: "detached" });
    }
    await pickTool(dm, "Select");
  });

  test("HX5-2. on its turn a goblin dragged across the rock walks round through the gap: its stop keeps the route's corners and the walk's feet", async () => {
    await ops.send(creature(run.vaultGob, "Vault goblin", "medium", { col: 6, row: 9 }, { sceneId: run.vault }));
    await waitFor("the vault goblin", () => onVaultHex(run.vaultGob, "medium", { col: 6, row: 9 }));
    await ops.send({ t: "encounter.start", entries: [{ id: run.vaultEntry, tokenId: run.vaultGob, value: 12 }] });
    await ops.send({ t: "encounter.next" });
    await waitFor("the vault goblin's turn", () => (dmSocket.state?.encounter?.activeEntryId === run.vaultEntry ? true : null));
    await holdDrag(dm, hexCenter(G, { col: 6, row: 9 }), hexCenter(G, { col: 14, row: 9 }));
    const label = await waitFor("the drag's label", async () => (await boardTexts(dm)).find((t) => /^\d+ ft\b/.test(t)) ?? null, 5_000);
    await shots.take(dm, "hx5-drag-round-the-rock");
    await dm.mouse.up();
    await waitFor("the goblin past the rock", () => onVaultHex(run.vaultGob, "medium", { col: 14, row: 9 }));
    const stop = await waitFor("the move's stop", () => vaultToken(run.vaultGob)?.path?.stops.at(-1));
    assert.ok(stop.via && stop.via.length > 0, "the route's corners");
    assert.ok(stop.moved! > 40, `${stop.moved} ft round the rock`);
    assert.match(label, new RegExp(`^${stop.cost} ft`), "the label read what the move stored");
    await ops.send({ t: "encounter.end" });
  });

  test("HX5-3. an ogre dragged into the one-row corridor squeezes onto one hex there, and one walked through it pays for each squeezed hex", async () => {
    await ops.send(creature(run.vaultOgre, "Vault ogre", "large", { col: 13, row: 13 }, { sceneId: run.vault }));
    await waitFor("the vault ogre", () => onVaultHex(run.vaultOgre, "large", { col: 13, row: 13 }));
    await ops.send({ t: "encounter.start", entries: [{ id: run.vaultEntry, tokenId: run.vaultOgre, value: 12 }] });
    await ops.send({ t: "encounter.next" });
    await waitFor("the ogre's turn", () => (dmSocket.state?.encounter?.activeEntryId === run.vaultEntry ? true : null));
    const from = placedOnHex(G, { size: "large", x: 0, y: 0 }, { col: 13, row: 13 });
    await holdDrag(dm, { x: from.x + 1, y: from.y + 1 }, hexCenter(G, { col: 19, row: 14 }));
    await dm.mouse.up();
    const inside = await waitFor("the ogre squeezed in the corridor", () => {
      const t = vaultToken(run.vaultOgre);
      return t?.squeeze === true && tokenRefHex(G, t).row === 14 && tokenRefHex(G, t).col >= 16 ? t : null;
    });
    assert.equal(footprintSubcells(G, inside).length <= 16, true, "it stands on one hex");
    await shots.take(dm, "hx5-ogre-squeezed");
    const stop = inside.path!.stops.at(-1)!;
    assert.ok(stop.cost! > stop.moved!, `${stop.cost} ft for ${stop.moved} ft walked: the squeeze costs`);
    await ops.send({ t: "encounter.end" });
  });

  /*
   * Lane HX-7's steps (HX7-): riding and traps on hexes, phase H2. A Medium
   * gets on a Large pony from the Attach list and off beside it, the Trap
   * tool draws a trap of hexes that Thorn's walk sets off, a found trap of
   * hexes stays from Pat while ground beside its hexes is revealed and
   * reaches Pat once one of its own sub-cells is, and those screens sit
   * within 1 px at section 8's sizes.
   */

  test("HX7-1. Kip gets on the pony from the Attach list, sits on one of its hexes, and gets off beside it", async () => {
    await openAt(dm, SIZES[0], 1);
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.sceneId);
    await dm.keyboard.press("Escape");
    await ops.send(creature(run.pony, "Pony", "large", { col: 5, row: 16 }, { disposition: "ally" }));
    await ops.send(creature(run.kip, "Kip", "medium", { col: 6, row: 16 }, { disposition: "ally" }));
    await waitFor("Kip in the DM's state", () => dmSocket.state?.tokens[run.kip] ?? null);
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    const at = await pagePoint(dm, BOUNDS, hexCenter(G, { col: 6, row: 16 }));
    await assertCanvasAt(dm, at);
    await dm.mouse.click(at.x, at.y);
    const bar = dm.getByRole("dialog", { name: "Kip actions" });
    await bar.waitFor();
    await (await barControl(bar, "Attach")).click();
    const list = dm.getByRole("dialog", { name: "Attach Kip" });
    await list.getByRole("button", { name: "Ride Pony" }).click();
    const ride = list.getByRole("button", { name: "Ride", exact: true });
    await ride.waitFor();
    await shots.take(dm, "hx7-attach-ride");
    await ride.click();
    const kip = await waitFor("Kip on the pony", () => (dmSocket.state?.tokens[run.kip]?.attached?.to === run.pony ? dmSocket.state.tokens[run.kip]! : null));
    const pony = dmSocket.state!.tokens[run.pony]!;
    const ponyHexes = occupiedHexes(G, pony).map((h) => `${h.col},${h.row}`);
    assert.ok(ponyHexes.includes(occupiedHexes(G, kip).map((h) => `${h.col},${h.row}`)[0]!), `Kip on one of the pony's hexes ${ponyHexes}`);

    await (await barControl(dm.getByRole("dialog", { name: "Kip actions" }), "Get off")).click();
    const off = await waitFor("Kip off the pony", () => (dmSocket.state?.tokens[run.kip] && dmSocket.state.tokens[run.kip]!.attached === undefined ? dmSocket.state.tokens[run.kip]! : null));
    const offHex = occupiedHexes(G, off)[0]!;
    assert.ok(!ponyHexes.includes(`${offHex.col},${offHex.row}`), "off the pony's hexes");
    assert.ok(occupiedHexes(G, pony).some((h) => hexDistance(G, h, offHex) === 1), "beside it");
    await shots.take(dm, "hx7-attach-got-off");
    await dm.keyboard.press("Escape");
  });

  test("HX7-2. the Trap tool draws a trap of hexes, in hex words, and Thorn's walk across its hexes sets it off", async () => {
    await pickTool(dm, "Trap");
    const options = dm.getByRole("toolbar", { name: "Trap options" });
    await options.locator("[data-options-line]").filter({ hasText: "Drag across the hexes of a new trap" }).waitFor();
    const from = hexCenter(G, { col: 10, row: 16 });
    const to = hexCenter(G, { col: 11, row: 17 });
    await dragWorld(dm, BOUNDS, from, to);
    const made = await waitFor("the trap on the DM's copy", () => Object.values(dmSocket.state?.traps ?? {}).find((t) => t.sceneId === run.sceneId) ?? null);
    run.trapId = made.id;
    assert.deepEqual(made.zone, { cells: [{ x: 10, y: 16, w: 2, h: 2 }] });
    assert.equal(made.grid, "hexRows");
    const editor = dm.getByRole("dialog", { name: "Edit trap" });
    await editor.waitFor();
    await editor.getByRole("button", { name: "Afterwards", exact: true }).click();
    const pit = editor.getByRole("switch", { name: "Opens a pit" });
    assert.equal(await pit.isDisabled(), false, "from H3 a pit opens on hexes too (HX-8)");
    await shots.take(dm, "hx7-trap-pane");
    await editor.getByRole("button", { name: "Done", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await pickTool(dm, "Select");

    // Thorn, Pat's, walks east along row 16 through the trap's hexes.
    await moveTo(run.thorn, "medium", { col: 7, row: 16 });
    await ops.send({ t: "token.move", tokenId: run.thorn, ...placedOnHex(G, { size: "medium", x: 0, y: 0 }, { col: 14, row: 16 }) });
    const sprung = await waitFor("the trap gone off", () => (dmSocket.state?.traps[run.trapId]?.state === "sprung" ? dmSocket.state.traps[run.trapId]! : null));
    assert.equal(sprung.found, true, "found as Pat's Thorn set it off");
    await shots.take(dm, "hx7-trap-sprung");
  });

  test("HX7-3. a found trap of hexes stays from Pat while the ground beside its hexes is revealed, and reaches Pat once a sub-cell of one of them is", async () => {
    // A found trap in the scene's south-west corner, far from any ground the party's sight explored in HX-9, under the fog once it is reset.
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true, vision: { on: false, light: "dark" } } });
    await ops.send({ t: "fog.reset", sceneId: run.sceneId, to: "hidden" });
    await waitFor("fog on, vision off", () => (dmSocket.state?.scenes[run.sceneId]?.fogEnabled === true && dmSocket.state.scenes[run.sceneId]?.vision?.on === false) || null);
    const plate = randomUUID().replace(/-/g, "").slice(0, 16);
    const rig = { on: ["enter"], who: "party", floor: false, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: plate, sceneId: run.sceneId, name: "Buried plate", zone: { cells: [{ x: 2, y: 18, w: 2, h: 2 }] }, found: true, rig } });
    await waitFor("the plate on the DM's copy", () => dmSocket.state?.traps[plate]?.grid === "hexRows" || null);
    const hexes = [{ col: 2, row: 18 }, { col: 3, row: 18 }, { col: 2, row: 19 }, { col: 3, row: 19 }];
    const own = new Set(hexes.flatMap((h) => hexSubcells(G, h)).map(([x, y]) => `${x},${y}`));
    // Every other sub-cell of the cells its hexes lie in.
    const around: ReturnType<typeof revealSubcell>[] = [];
    const xs = hexes.flatMap((h) => hexSubcells(G, h).map(([x]) => x));
    const ys = hexes.flatMap((h) => hexSubcells(G, h).map(([, y]) => y));
    for (let sy = Math.floor(Math.min(...ys) / FOG_SUBCELLS) * FOG_SUBCELLS; sy < (Math.floor(Math.max(...ys) / FOG_SUBCELLS) + 1) * FOG_SUBCELLS; sy++) {
      for (let sx = Math.floor(Math.min(...xs) / FOG_SUBCELLS) * FOG_SUBCELLS; sx < (Math.floor(Math.max(...xs) / FOG_SUBCELLS) + 1) * FOG_SUBCELLS; sx++) if (!own.has(`${sx},${sy}`)) around.push(revealSubcell(sx, sy));
    }
    for (let i = 0; i < around.length; i += 40) await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: around.slice(i, i + 40) });
    // A marker on revealed ground in the far corner: once Pat's copy holds it, Pat has had every op before it.
    const marker = randomUUID();
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 26, y: 0, w: 4, h: 3 } }] });
    await ops.send(creature(marker, "Marker", "tiny", { col: 27, row: 1 }));
    await waitFor("Pat's copy after the reveal", () => patSocket.state?.tokens[marker] ?? null);
    assert.equal(patSocket.state!.traps[plate], undefined, "the ground beside its hexes revealed");
    const [sx, sy] = hexSubcells(G, { col: 3, row: 19 })[0]!;
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [revealSubcell(sx, sy)] });
    const seen = await waitFor("the plate in Pat's copy", () => patSocket.state?.traps[plate] ?? null);
    assert.deepEqual(seen.zone, { cells: [{ x: 2, y: 18, w: 2, h: 2 }] });
    await shots.take(pat, "hx7-pat-trap-revealed");
  });

  test("HX7-4. the Trap tool's options, the trap's pane and the Attach list on a hex scene sit within 1 px at each size", async () => {
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
          const fit = page.getByRole("button", { name: "Fit the map to the screen" });
          if ((await fit.count()) > 0 && (await fit.first().isVisible())) await fit.first().click();
          const tap = async (hex: Hex) => {
            const p = await pagePoint(page, BOUNDS, hexCenter(G, hex));
            await assertCanvasAt(page, p);
            if (size.touch) await page.touchscreen.tap(p.x, p.y);
            else await page.mouse.click(p.x, p.y);
          };
          await pickTool(page, "Trap");
          const options = page.getByRole("toolbar", { name: "Trap options" });
          await options.locator("[data-options-line]").first().waitFor();
          off.push(...alignmentLines(await measureAlignment(options), `the Trap tool's options on hexes at ${at}`));
          await tap({ col: 10, row: 16 });
          const editor = page.getByRole("dialog", { name: "Edit trap" });
          await editor.waitFor();
          await editor.getByRole("button", { name: "Afterwards", exact: true }).click();
          await editor.getByRole("switch", { name: "Opens a pit" }).scrollIntoViewIfNeeded();
          off.push(...alignmentLines(await measureAlignment(editor), `the trap's pane on hexes at ${at}`));
          await shots.take(page, `hx7-trap-pane-${size.name}-${scale * 100}`);
          await editor.getByRole("button", { name: "Done", exact: true }).click();
          await editor.waitFor({ state: "detached" });
          await pickTool(page, "Select");
          const kip = occupiedHexes(G, dmSocket.state!.tokens[run.kip]!)[0]!;
          await tap(kip);
          const bar = page.getByRole("dialog", { name: "Kip actions" });
          await bar.waitFor();
          await (await barControl(bar, "Attach")).click();
          const list = page.getByRole("dialog", { name: "Attach Kip" });
          await list.getByRole("button", { name: "Ride Pony" }).waitFor();
          off.push(...alignmentLines(await measureAlignment(list), `the Attach list on hexes at ${at}`));
          await shots.take(page, `hx7-attach-list-${size.name}-${scale * 100}`);
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }
      }
    } finally {
      await phoneContext?.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  /** HX-9b's helpers: a hex and its six neighbors, the free walls along their outline, and the Fog tool's bar. */
  const fogBar = (page: Page) => page.getByRole("toolbar", { name: "Fog options" });
  const ROOM_LINE = "Tap a room closed in by wall lines.";
  const sevenOf = (g: HexGrid, middle: Hex) => [middle, ...hexNeighbors(g, middle)].map(hexKey).sort();
  function ringWalls(g: HexGrid, keys: string[], door: string | null): { id: string; a: [number, number]; b: [number, number]; f: { kind: "wall" } | { kind: "door"; state: "closed"; secret: false; discovered: false } }[] {
    const outline = hexCellsOutline(g, keys);
    const out = [];
    for (let i = 0; i < outline.length; i += 4) {
      const id = i === 0 && door ? door : randomUUID().replace(/-/g, "").slice(0, 12);
      const f = i === 0 && door ? ({ kind: "door", state: "closed", secret: false, discovered: false } as const) : ({ kind: "wall" } as const);
      out.push({ id, a: [outline[i]!, outline[i + 1]!] as [number, number], b: [outline[i + 2]!, outline[i + 3]!] as [number, number], f });
    }
    return out;
  }
  const draftCells = (sceneId: string) => (dmSocket.state?.fogDrafts[sceneId]?.ops ?? []).flatMap((o) => (o.shape.kind === "cells" ? o.shape.cells : []));
  async function tapRoom(sceneId: string, g: HexGrid, hex: Hex, want: number): Promise<string[]> {
    await tapAt(dm, hexCenter(g, hex));
    return waitFor(`a draft of ${want} hexes`, () => (draftCells(sceneId).length === want ? draftCells(sceneId).slice().sort() : null));
  }
  const cellarRoom = sevenOf(G, { col: 6, row: 6 });

  test("HX9b-1. Builder room on a hex scene drafts the hexes its free walls and closed door close in, stamped hex rows and outlined, and Pat then sees the goblin in the room and not the one outside", async () => {
    await ops.send({ t: "scene.create", scene: { id: run.cellar, name: "Cellar", bounds: BOUNDS, gridShape: "hexRows" } });
    await waitFor("the cellar in the DM's state", () => dmSocket.state?.scenes[run.cellar] ?? null);
    await ops.send({ t: "scene.update", sceneId: run.cellar, patch: { fogEnabled: true } });
    await ops.send({ t: "build.walls", sceneId: run.cellar, put: ringWalls(G, cellarRoom, run.cellarDoor) });
    for (const [id, name, hex] of [
      [run.cellarGob, "Cellar goblin", { col: 6, row: 6 }],
      [run.cellarFar, "Far goblin", { col: 12, row: 12 }],
    ] as const) {
      const c = creature(id, name, "medium", hex);
      await ops.send({ ...c, token: { ...c.token, sceneId: run.cellar } });
    }
    await ops.send({ t: "room.setPlayerScene", sceneId: run.cellar });
    await dm.bringToFront();
    await dm.setViewportSize({ width: 1440, height: 900 });
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.cellar);
    await dm.keyboard.press("Escape");
    // The DM's copy holds the chunks of the scene they view.
    await waitFor("the cellar's walls in the DM's state", () => (Object.values(dmSocket.state?.buildChunks ?? {}).flatMap((c) => (c?.sceneId === run.cellar ? (c.walls ?? []) : [])).length === 18 ? true : null));
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await pickTool(dm, "Fog");
    await pickOption(dm, "Fog", "Shape", "Builder room");
    await fogBar(dm).locator("[data-options-line]").filter({ hasText: ROOM_LINE }).waitFor();

    const cells = await tapRoom(run.cellar, G, { col: 5, row: 6 }, 7);
    assert.deepEqual(cells, cellarRoom);
    assert.equal(dmSocket.state!.fogDrafts[run.cellar]?.grid, "hexRows", "the draft carries the scene's shape");
    assert.equal(dmSocket.state!.fogDrafts[run.cellar]?.ops.length, 1, "one tap, one edit");
    await shots.take(dm, "hx9b-room-draft");

    await fogBar(dm).getByRole("button", { name: "Reveal to players (1)" }).click();
    await waitFor("the draft published", () => (dmSocket.state?.fogDrafts[run.cellar] === undefined ? true : null));
    for (const k of cellarRoom) {
      const [col, row] = k.split(",").map(Number) as [number, number];
      for (const [sx, sy] of hexSubcells(G, { col, row })) assert.equal(isSubcellFogged(dmSocket.state!.fogTiles, run.cellar, sx, sy), false, `hex ${k} revealed by its sub-cells`);
    }
    await pat.bringToFront();
    await waitFor("the cellar goblin in Pat's copy", () => (patSocket.state?.tokens[run.cellarGob] ? true : null));
    assert.equal(patSocket.state?.tokens[run.cellarFar], undefined, "the goblin outside stays under fog");
    await pat.getByRole("button", { name: "Fit the map to the screen" }).click();
    await shots.take(pat, "hx9b-pat-room");
    await dm.bringToFront();
  });

  test("HX9b-2. with the door open the flood runs through it to the map's edge, and shut again it stops at the room", async () => {
    const door = Object.values(dmSocket.state!.buildChunks)
      .flatMap((c) => (c?.sceneId === run.cellar ? (c.walls ?? []).map((w) => ({ w, cx: c.cx, cy: c.cy })) : []))
      .find(({ w }) => w.id === run.cellarDoor)!;
    assert.ok(door, "the cellar's door");
    const setDoor = async (state: "open" | "closed") => {
      await ops.send({ t: "door.set", sceneId: run.cellar, door: { cx: door.cx, cy: door.cy, id: run.cellarDoor }, state });
      await waitFor(`the door ${state}`, () => (Object.values(dmSocket.state?.buildChunks ?? {}).some((c) => c?.walls?.some((w) => w.id === run.cellarDoor && w.f.kind === "door" && w.f.state === state)) ? true : null));
    };
    const discard = async () => {
      await ops.send({ t: "fog.discard", sceneId: run.cellar });
      await waitFor("the draft discarded", () => (dmSocket.state?.fogDrafts[run.cellar] === undefined ? true : null));
    };
    await setDoor("open");
    const all = sceneHexes(G, BOUNDS).map(hexKey).sort();
    assert.deepEqual(await tapRoom(run.cellar, G, { col: 6, row: 5 }, all.length), all, "every hex of the scene, to its edge");
    await shots.take(dm, "hx9b-door-open");
    await discard();
    await setDoor("closed");
    assert.deepEqual(await tapRoom(run.cellar, G, { col: 6, row: 5 }, 7), cellarRoom);
    await discard();
    const outside = await tapRoom(run.cellar, G, { col: 2, row: 2 }, all.length - 7);
    assert.ok(!outside.some((k) => cellarRoom.includes(k)), "outside, the rest of the scene and none of the room");
    await discard();
    await tapAt(dm, { x: BOUNDS.w - 0.1, y: hexCenter(G, { col: 0, row: 1 }).y });
    await fogBar(dm).locator("[data-options-line]").filter({ hasText: "Tap a whole hex inside the map." }).waitFor();
    assert.equal(dmSocket.state?.fogDrafts[run.cellar], undefined, "the half hex past an odd row's end drafts nothing");
  });

  test("HX9b-3. on hex columns Builder room drafts the column room's hexes, stamped hex columns, and publishing reveals them by their sub-cells", async () => {
    const C: HexGrid = { shape: "hex", orient: "columns" };
    const ossuaryRoom = sevenOf(C, { col: 8, row: 6 });
    await ops.send({ t: "scene.create", scene: { id: run.ossuary, name: "Ossuary", bounds: BOUNDS, gridShape: "hexColumns" } });
    await waitFor("the ossuary in the DM's state", () => dmSocket.state?.scenes[run.ossuary] ?? null);
    await ops.send({ t: "scene.update", sceneId: run.ossuary, patch: { fogEnabled: true } });
    await ops.send({ t: "build.walls", sceneId: run.ossuary, put: ringWalls(C, ossuaryRoom, null) });
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.ossuary);
    await dm.keyboard.press("Escape");
    await waitFor("the ossuary's walls", () => (Object.values(dmSocket.state?.buildChunks ?? {}).flatMap((c) => (c?.sceneId === run.ossuary ? (c.walls ?? []) : [])).length === 18 ? true : null));
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await pickTool(dm, "Fog");
    await pickOption(dm, "Fog", "Shape", "Builder room");
    assert.deepEqual(await tapRoom(run.ossuary, C, { col: 8, row: 7 }, 7), ossuaryRoom);
    assert.equal(dmSocket.state!.fogDrafts[run.ossuary]?.grid, "hexColumns");
    await shots.take(dm, "hx9b-ossuary-draft");
    await fogBar(dm).getByRole("button", { name: "Reveal to players (1)" }).click();
    await waitFor("the ossuary's draft published", () => (dmSocket.state?.fogDrafts[run.ossuary] === undefined ? true : null));
    const tiles = dmSocket.state!.fogTiles;
    for (const k of ossuaryRoom) {
      const [col, row] = k.split(",").map(Number) as [number, number];
      for (const [sx, sy] of hexSubcells(C, { col, row })) assert.equal(isSubcellFogged(tiles, run.ossuary, sx, sy), false, `hex ${k} revealed`);
    }
    for (const n of hexNeighbors(C, { col: 8, row: 4 })) {
      if (ossuaryRoom.includes(hexKey(n))) continue;
      for (const [sx, sy] of hexSubcells(C, n)) assert.equal(isSubcellFogged(tiles, run.ossuary, sx, sy), true, `hex ${hexKey(n)} outside stays fogged`);
    }
  });

  test("HX9b-4. the Fog tool's options with Builder room picked on a hex scene sit within 1 px at each size", async () => {
    const off: string[] = [];
    let phone: Awaited<ReturnType<typeof dmPhone>> | null = null;
    try {
      for (const size of SIZES) {
        let page = dm;
        if (size.touch) {
          phone ??= await dmPhone(size);
          page = phone.page;
        }
        for (const scale of SCALES) {
          const at = `${size.name} at ${scale * 100}%`;
          await openAt(page, size, scale);
          const panel = await openScenes(page);
          await viewScene(page, panel, run.cellar);
          await page.keyboard.press("Escape");
          await pickTool(page, "Fog");
          await pickOption(page, "Fog", "Shape", "Builder room");
          const bar = fogBar(page);
          await bar.locator("[data-options-line]").filter({ hasText: ROOM_LINE }).waitFor();
          off.push(...alignmentLines(await measureAlignment(bar), `the Fog tool's Builder room on hexes at ${at}`));
          await shots.take(page, `hx9b-fog-bar-${size.name}-${scale * 100}`);
          await pickTool(page, "Select");
        }
      }
    } finally {
      await phone?.context.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("HX9b-5. Builder room on an open 200 by 200 hex scene drafts all of its hexes without closing the socket, and one undo takes the draft back", async () => {
    const big = { w: 200, h: 200 };
    await ops.send({ t: "scene.create", scene: { id: run.moorland, name: "Moorland", bounds: big, gridShape: "hexRows" } });
    await waitFor("the moorland in the DM's state", () => dmSocket.state?.scenes[run.moorland] ?? null);
    await ops.send({ t: "scene.update", sceneId: run.moorland, patch: { fogEnabled: true } });
    await dm.bringToFront();
    await openAt(dm, SIZES[0], 1);
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.moorland);
    await dm.keyboard.press("Escape");
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await pickTool(dm, "Fog");
    await pickOption(dm, "Fog", "Shape", "Builder room");
    const closes = dmSocket.closes;
    const p = await pagePoint(dm, big, { x: 100, y: 100 });
    await assertCanvasAt(dm, p);
    await dm.mouse.click(p.x, p.y);
    const all = sceneHexes(G, big).length;
    // A frame over the socket's limit closes it, and the outbox would send the op again on every reconnect, so nothing would land.
    await waitFor(`a draft of all ${all} hexes`, () => (draftCells(run.moorland).length === all ? true : null), 30_000);
    assert.equal(dmSocket.closes, closes, "the DM's socket stayed open");
    assert.ok((dmSocket.state!.fogDrafts[run.moorland]?.ops.length ?? 0) > 1, "the room in several ops");
    await fogBar(dm).getByRole("button", { name: "Reveal to players (1)" }).waitFor();
    await shots.take(dm, "hx9b-moorland-draft");
    await dm.getByRole("button", { name: "Undo", exact: true, description: /^Undo your last play or board change(: .+)? \(Ctrl\+Z\)$/ }).click();
    await waitFor("the whole draft taken back by the top bar's one undo", () => (dmSocket.state?.fogDrafts[run.moorland] === undefined ? true : null));
    await dm.mouse.click(p.x, p.y);
    await waitFor("the room drafted again", () => (draftCells(run.moorland).length === all ? true : null), 30_000);
    await fogBar(dm).getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("the whole draft taken back by the fog bar's one undo", () => (dmSocket.state?.fogDrafts[run.moorland] === undefined ? true : null));
    assert.equal(dmSocket.closes, closes);
    await pickTool(dm, "Select");
  });

  test("HX9b-7. two Builder room taps back to back on the open 200 by 200 hex scene send more than the socket's byte budget, and the outbox paces them: both rooms land well before the answer timer, the socket stays open and the next edit goes through", async () => {
    const big = { w: 200, h: 200 };
    const all = sceneHexes(G, big).length;
    await pickTool(dm, "Fog");
    await pickOption(dm, "Fog", "Shape", "Builder room");
    const closes = dmSocket.closes;
    const p = await pagePoint(dm, big, { x: 100, y: 100 });
    await assertCanvasAt(dm, p);
    // Each tap sends about 447 KB, past the 512 KiB the server takes at once and 256 KiB a second after (server/rooms/budgets.ts
    // FrameBudget). The outbox sends no faster than that (client/state/socket.ts SendBudget), so the server drops no frame and no
    // op waits for the 10 s answer timer to go again (OP_ANSWER_MS, client/state/store.ts), as every one did before (H3-FOG-BURST).
    await dm.mouse.click(p.x, p.y);
    await dm.waitForTimeout(300);
    await dm.mouse.click(p.x + 40, p.y + 40);
    const tapped = Date.now();
    await waitFor("both rooms in the draft", () => (draftCells(run.moorland).length === 2 * all ? true : null), 40_000);
    const took = Date.now() - tapped;
    assert.ok(took < 8_000, `both rooms landed ${took} ms after the second tap`);
    assert.equal(dmSocket.closes, closes, "the DM's socket stayed open");
    const draft = dmSocket.state!.fogDrafts[run.moorland]!;
    assert.equal(new Set(draft.ops.map((o) => o.id)).size, draft.ops.length, "every op once");
    await fogBar(dm).getByRole("button", { name: "Reveal to players (2)" }).waitFor();
    // The outbox is not stuck: the next edits land at once, each taking a room back whole.
    await fogBar(dm).getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("the second room taken back", () => (draftCells(run.moorland).length === all ? true : null), 5_000);
    await fogBar(dm).getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("the first room taken back", () => (dmSocket.state?.fogDrafts[run.moorland] === undefined ? true : null), 5_000);
    console.error(`[hx9b-7] both rooms ${took} ms after the second tap`);
    await pickTool(dm, "Select");
  });

  test("HX9b-6. on squares a builder room sent in several ops counts as one edit, outlined as one room, and the fog bar's Undo takes it back whole", async () => {
    const field = { w: 100, h: 60 };
    await ops.send({ t: "scene.create", scene: { id: run.granary, name: "Granary", bounds: field } });
    await waitFor("the granary in the DM's state", () => dmSocket.state?.scenes[run.granary] ?? null);
    await ops.send({ t: "scene.update", sceneId: run.granary, patch: { fogEnabled: true } });
    for (const y of [0, 20, 40]) await ops.send({ t: "build.rect", sceneId: run.granary, terrain: "stone", x: 0, y, w: 100, h: 20 });
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.granary);
    await dm.keyboard.press("Escape");
    await waitFor("the granary's floor in the DM's state", () => (Object.values(dmSocket.state?.buildChunks ?? {}).filter((c) => c?.sceneId === run.granary).reduce((n, c) => n + Object.keys(c!.cells).length, 0) === 6000 ? true : null));
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await pickTool(dm, "Fog");
    await pickOption(dm, "Fog", "Shape", "Builder room");
    const p = await pagePoint(dm, field, { x: 50.5, y: 30.5 });
    await assertCanvasAt(dm, p);
    await dm.mouse.click(p.x, p.y);
    await waitFor("the granary drafted", () => (draftCells(run.granary).length === 6000 ? true : null));
    assert.equal(dmSocket.state!.fogDrafts[run.granary]?.ops.length, 3, "in three ops of 2,000 squares");
    await fogBar(dm).getByRole("button", { name: "Reveal to players (1)" }).waitFor();
    await shots.take(dm, "hx9b-granary-draft");
    await fogBar(dm).getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("the whole room taken back by one tap", () => (dmSocket.state?.fogDrafts[run.granary] === undefined ? true : null));
    await pickTool(dm, "Select");
  });

  /*
   * Lane HX-8's steps (HX8-): heights, stairs and pits on hexes, phase H3,
   * on a scene of their own. A 10 ft terrace along row 8 from column 12,
   * reached by a stair on hex 11,8 facing east, its up side.
   */
  const terrace = { scene: randomUUID(), gob: randomUUID(), entry: randomUUID(), pit: randomUUID(), thorn: randomUUID() };
  const TERRACE = [12, 13, 14, 15, 16].map((col) => ({ col, row: 8 }));
  const terraceChunk = () => dmSocket.state?.buildChunks[`${terrace.scene}:0,0`];
  const groundOf = (h: Hex) => {
    const c = dmSocket.state?.buildChunks[`${terrace.scene}:${Math.floor(h.col / 16)},${Math.floor(h.row / 16)}`];
    if (!c?.heights) return 0;
    const bytes = Buffer.from(c.heights, "base64");
    const k = (h.row % 16) * 16 + (h.col % 16);
    const u = bytes[2 * k]! + bytes[2 * k + 1]! * 256;
    return u >= 32768 ? u - 65536 : u;
  };
  const onTerraceHex = (id: string, hex: Hex) => {
    const at = placedOnHex(G, { size: "medium", x: 0, y: 0 }, hex);
    const t = dmSocket.state?.tokens[id];
    return t && Math.abs(t.x - at.x) < 1e-9 && Math.abs(t.y - at.y) < 1e-9 ? t : null;
  };

  test("HX8-1. Heights and stairs paints a terrace by hexes and a stair facing it, under the chunk's hex rows stamp", async () => {
    await ops.send({ t: "scene.create", scene: { id: terrace.scene, name: "Terrace", bounds: BOUNDS, gridShape: "hexRows" } });
    await waitFor("the terrace scene", () => dmSocket.state?.scenes[terrace.scene] ?? null);
    const panel = await openScenes(dm);
    await viewScene(dm, panel, terrace.scene);
    await dm.keyboard.press("Escape");
    await ops.send({ t: "scene.update", sceneId: terrace.scene, patch: { blockMovement: true } });
    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Heights and stairs");
    const bar = buildBar(dm);
    // The value alone, not the stepper's buttons' tooltips the group also holds.
    assert.equal((await bar.getByRole("group", { name: "Height" }).locator("[aria-live]").innerText()).trim(), "10 ft up");
    await holdDrag(dm, hexCenter(G, TERRACE[0]!), hexCenter(G, TERRACE[4]!));
    await dm.mouse.up();
    await waitFor("the terrace's five hexes at 10 ft", () => (TERRACE.every((h) => groundOf(h) === 10) ? true : null));
    assert.equal(groundOf({ col: 12, row: 7 }) + groundOf({ col: 12, row: 9 }) + groundOf({ col: 11, row: 8 }), 0, "and no hex beside them");
    assert.equal(terraceChunk()?.grid, "hexRows", "its chunk carries the shape");

    await pickOption(dm, "Map builder", "Paint", "Mark stairs");
    // A press on the compact chip pins it in the form it stands in (pages/optionsLayout.ts fitRow, HX8-FITROW-PIN), so its popover opens and nothing in the row moves.
    const slotsInRow = () => bar.locator("[data-options-row] > [data-rvtt-slot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-rvtt-slot")));
    const resting = await slotsInRow();
    await bar.getByRole("button", { name: /^Stairs point:/ }).click();
    const popover = dm.getByRole("dialog", { name: "Stairs point" });
    await popover.waitFor();
    assert.deepEqual(await slotsInRow(), resting, "the row refit around the pressed chip");
    await popover.getByRole("radio", { name: "Up to the east", exact: true }).click();
    await popover.waitFor({ state: "detached" });
    await tapAt(dm, hexCenter(G, { col: 11, row: 8 }));
    await waitFor("the stair facing east", () => (terraceChunk()?.up?.[8 * 16 + 11] === "0" ? true : null));
    await bar.locator("[data-options-line]").filter({ hasText: "Drag to mark stairs." }).waitFor();
    await shots.take(dm, "hx8-terrace-and-stair");
    await pickTool(dm, "Select");
  });

  test("HX8-2. a goblin walks up the stair onto the terrace, and the walking ruler's feet are the feet its move stores", async () => {
    await ops.send(creature(terrace.gob, "Terrace goblin", "medium", { col: 8, row: 8 }, { sceneId: terrace.scene }));
    await waitFor("the terrace goblin", () => onTerraceHex(terrace.gob, { col: 8, row: 8 }));
    await pickTool(dm, "Ruler");
    const { group, popover } = await measureChoice(dm);
    await group.getByRole("radio", { name: "Walking", exact: true }).click();
    if (popover) {
      await dm.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });
    }
    // Six hexes east along row 8, the fourth a climb of 10 ft up the stair: more than the 30 ft of level hexes.
    await holdDrag(dm, hexCenter(G, { col: 8, row: 8 }), hexCenter(G, { col: 14, row: 8 }));
    await dm.mouse.up();
    const line = dm.getByRole("toolbar", { name: "Ruler options" }).locator("[data-options-line]");
    const reading = await waitFor("the walking reading", async () => {
      const m = /Walking (\d+) ft/.exec(await line.innerText());
      return m ? Number(m[1]) : null;
    });
    assert.ok(reading > 30, `${reading} ft counts the climb`);
    await shots.take(dm, "hx8-walking-ruler-up-the-stair");
    const back = await measureChoice(dm);
    await back.group.getByRole("radio", { name: "Straight", exact: true }).click();
    if (back.popover) {
      await dm.keyboard.press("Escape");
      await back.popover.waitFor({ state: "detached" });
    }
    await pickTool(dm, "Select");

    await ops.send({ t: "encounter.start", entries: [{ id: terrace.entry, tokenId: terrace.gob, value: 12 }] });
    await ops.send({ t: "encounter.next" });
    await waitFor("the terrace goblin's turn", () => (dmSocket.state?.encounter?.activeEntryId === terrace.entry ? true : null));
    await holdDrag(dm, hexCenter(G, { col: 8, row: 8 }), hexCenter(G, { col: 14, row: 8 }));
    await dm.mouse.up();
    const up = await waitFor("the goblin on the terrace", () => onTerraceHex(terrace.gob, { col: 14, row: 8 }));
    assert.equal(up.elevation, 10, "standing on the terrace's ground");
    const stop = up.path!.stops.at(-1)!;
    assert.equal(stop.cost, reading, "the move stored the ruler's feet");
    await shots.take(dm, "hx8-goblin-on-the-terrace");
    await ops.send({ t: "encounter.end" });
  });

  test("HX8-3. a pit trap on hexes springs under Thorn's walk: its hexes drop to the floor under the stamp, and Thorn with them", async () => {
    const pitHexes = [{ col: 5, row: 12 }, { col: 6, row: 12 }];
    // Traps go off by themselves on the players' scene (rules/traps.ts liveTrapScene).
    await ops.send({ t: "room.setPlayerScene", sceneId: terrace.scene });
    await ops.send({
      t: "trap.create",
      trap: {
        id: terrace.pit,
        sceneId: terrace.scene,
        name: "Hidden Pit",
        zone: { cells: [{ x: 5, y: 12, w: 2, h: 1 }] },
        found: false,
        rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, pit: { floor: -10 } },
      },
    });
    const made = await waitFor("the pit on the DM's copy", () => dmSocket.state?.traps[terrace.pit] ?? null);
    assert.equal(made.grid, "hexRows");
    await ops.send(creature(terrace.thorn, "Thorn", "medium", { col: 2, row: 12 }, { sceneId: terrace.scene, kind: "pc" }));
    await waitFor("Thorn by the pit", () => onTerraceHex(terrace.thorn, { col: 2, row: 12 }));
    await ops.send({ t: "token.move", tokenId: terrace.thorn, ...placedOnHex(G, { size: "medium", x: 0, y: 0 }, { col: 10, row: 12 }) });
    const sprung = await waitFor("the pit gone off", () => (dmSocket.state?.traps[terrace.pit]?.state === "sprung" ? true : null));
    assert.ok(sprung);
    await waitFor("its hexes at the floor", () => (pitHexes.every((h) => groundOf(h) === -10) ? true : null));
    assert.equal(groundOf({ col: 7, row: 12 }), 0, "beside it the ground stays");
    const fell = await waitFor("Thorn in the pit", () => onTerraceHex(terrace.thorn, { col: 5, row: 12 }));
    assert.equal(fell.elevation, -10);
    await shots.take(dm, "hx8-pit-sprung");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
  });

  test("HX8-4. Heights and stairs' options on a hex scene, painting a height and marking stairs with six facings, sit within 1 px at each size", async () => {
    const off: string[] = [];
    let phone: Awaited<ReturnType<typeof dmPhone>> | null = null;
    try {
      for (const size of SIZES) {
        let page = dm;
        if (size.touch) {
          phone ??= await dmPhone(size);
          page = phone.page;
        }
        for (const scale of SCALES) {
          const at = `${size.name} at ${scale * 100}%`;
          await openAt(page, size, scale);
          const panel = await openScenes(page);
          await viewScene(page, panel, terrace.scene);
          await page.keyboard.press("Escape");
          await pickTool(page, "Map builder");
          const bar = buildBar(page);
          await pickOption(page, "Map builder", "Builder mode", "Heights and stairs");
          await pickOption(page, "Map builder", "Paint", "Paint a height");
          await bar.locator("[data-options-line]").filter({ hasText: "to paint the height" }).waitFor();
          off.push(...alignmentLines(await measureAlignment(bar), `Heights on hexes at ${at}`));
          await shots.take(page, `hx8-heights-bar-${size.name}-${scale * 100}`);
          await pickOption(page, "Map builder", "Paint", "Mark stairs");
          await bar.locator("[data-options-line]").filter({ hasText: "to mark stairs" }).waitFor();
          off.push(...alignmentLines(await measureAlignment(bar), `Stairs on hexes at ${at}`));
          await shots.take(page, `hx8-stairs-bar-${size.name}-${scale * 100}`);
          await pickOption(page, "Map builder", "Paint", "Paint a height");
          await pickTool(page, "Select");
        }
      }
    } finally {
      await phone?.context.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  /*
   * HX-9c: the grid finder looks for squares and hexes on every search
   * (docs/design-v1-grid-detect.md 10.7). Every map here is drawn by code
   * (client/features/grid/synthetic.ts): noise with hexes of a known size
   * and center, written as a PNG whose name gives no size.
   */
  const hx9cMap = async (name: string, orient: "rows" | "columns", cellPx: number, seed: number) => {
    const file = path.join(work, `${name}.png`);
    const px = drawMap({ width: 1400, height: 1000, seed, art: [{ kind: "noise", scale: 60, amp: 60 }], noise: 4, hexGrid: { orient, cellPx, center: { x: 30, y: 40 }, width: 2, opacity: 0.6 } });
    await sharp(Buffer.from(px.data), { raw: { width: px.width, height: px.height, channels: 1 } }).png().toFile(file);
    return file;
  };
  /** A drawn map already uploaded, put on a scene with today's first guess. */
  const hx9cPut = async (sceneId: string, file: string) => {
    const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: await sharp(file).toBuffer() });
    assert.ok(res.ok(), `the upload answered ${res.status()}`);
    const art = (await res.json()) as { id: string; width: number; height: number };
    await ops.send({ t: "scene.setMap", sceneId, map: { assetId: art.id, widthPx: art.width, heightPx: art.height, cellPx: 50, originPx: { x: 0, y: 0 } } });
    await waitFor("the drawn map on the scene", () => dmSocket.state?.scenes[sceneId]?.map?.assetId === art.id || null);
  };
  /** Whether a scene's grid is the drawn hexes': the size to a twentieth of a pixel, the origin to half a pixel. */
  const hx9cOnHexes = (sceneId: string, orient: "rows" | "columns", cellPx: number) => {
    const scene = dmSocket.state?.scenes[sceneId];
    const want = calibrationFromHexFind({ cellPx, center: { x: 30, y: 40 }, orient });
    const map = scene?.map;
    const shape = orient === "rows" ? "hexRows" : "hexColumns";
    return !!map && scene.gridShape === shape && Math.abs(map.cellPx - cellPx) < 0.05 && Math.abs(map.originPx.x - want.originPx.x) < 0.5 && Math.abs(map.originPx.y - want.originPx.y) < 0.5 ? map : null;
  };
  const hx9cPx = (v: number) => String(Math.round(v * 10) / 10);
  const hx9cGuess = (sceneId: string, shape: string | undefined, cellPx: number) => {
    const scene = dmSocket.state?.scenes[sceneId];
    return scene?.gridShape === shape && Math.abs((scene?.map?.cellPx ?? 0) - cellPx) < 1e-6 && scene?.map?.originPx.x === 0 && scene.map.originPx.y === 0 ? true : null;
  };

  test("hx9c-1. a code-drawn hex map through New scene in a square room starts on hex rows with its grid, one undo step, and Use default puts back squares and the guess", async () => {
    await openAt(dm, SIZES[0], 1);
    // The sizes and reloads before leave the op socket from the first test without answers, so a new one sends from here.
    ops.close();
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ") });
    await ops.send({ t: "room.update", settings: { newScenes: "squares" } });
    await waitFor("a square room", () => (dmSocket.state && dmSocket.state.meta.settings.newScenes === undefined) || null);
    const file = await hx9cMap("Hex fen", "rows", 64, 31);
    const panel = await openScenes(dm);
    const known = new Set(Object.keys(dmSocket.state?.scenes ?? {}));
    await panel.getByRole("radio", { name: "Map image", exact: true }).click();
    assert.equal(await panel.getByRole("radiogroup", { name: "Grid", exact: true }).getByRole("radio", { name: "Squares" }).isChecked(), true, "the form starts on the room's squares");
    await panel.getByText("A name like", { exact: false }).first().waitFor();
    await panel.getByRole("button", { name: "Choose a map image" }).setInputFiles(file);
    await panel.getByRole("button", { name: "Upload and create" }).click();
    const made = await waitFor("the new map scene", () => Object.values(dmSocket.state?.scenes ?? {}).find((sc) => sc?.map && !known.has(sc.id)), 30_000);
    const map = await waitFor("the scene on the drawn hex rows", () => hx9cOnHexes(made.id, "rows", 64), 15_000);
    const bar = dm.getByRole("toolbar", { name: "Line up grid options" });
    await bar.locator("[data-options-line]").filter({ hasText: `Found hex rows of ${hx9cPx(map.cellPx)} px. The grid is hex rows now.` }).first().waitFor();
    await shots.take(dm, "hx9c-new-scene-hex-rows");
    // Heights raised on the hexes since: squares are refused, so Use default sends nothing and says why (H3-OPUS-03).
    await ops.send({ t: "build.height", sceneId: made.id, cells: ["3,3"], height: 10 });
    await bar.getByRole("button", { name: "Use default", exact: true }).click();
    await bar.locator("[data-options-line]").filter({ hasText: "Can't go back to squares: this scene has heights on its hexes, which can't stand on squares. Remove them to change the grid." }).first().waitFor();
    assert.ok(hx9cOnHexes(made.id, "rows", 64), "the scene keeps its hexes and their grid");
    await shots.take(dm, "hx9cfix-use-default-refused");
    // Undo takes the heights back (the op socket is the DM's), and Use default may go.
    const raised = () => Object.values(dmSocket.state?.buildChunks ?? {}).some((c) => c?.sceneId === made.id && c.heights !== undefined);
    assert.equal(raised(), true);
    await dm.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("the heights undone", () => !raised() || null);
    // Use default puts back the form's squares and the first guess, 47 px for a 1400 by 1000 image.
    await bar.getByRole("button", { name: "Use default", exact: true }).click();
    await waitFor("squares and the guess back", () => hx9cGuess(made.id, undefined, 47));
    // Grid calibration is Setup (docs/design-v1-undo-scope.md 2): Undo setup takes Use default back, then the find, each in one step.
    await undoSetup(dm);
    await waitFor("the found hexes again", () => hx9cOnHexes(made.id, "rows", 64));
    await undoSetup(dm);
    await waitFor("one undo back to squares and the guess", () => hx9cGuess(made.id, undefined, 47));
    await pickTool(dm, "Select");
  });

  test("hx9c-2. Find the grid on a hex rows scene finds drawn hex columns and switches the scene to them in one undo step, focus staying on Find the grid", async () => {
    await hx9cPut(run.camp, await hx9cMap("Hex columns", "columns", 56, 32));
    assert.equal(dmSocket.state?.scenes[run.camp]?.gridShape, "hexRows");
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.camp);
    const group = await openSceneGroup(panel, "Map image and grid");
    await group.getByRole("button", { name: "Find the grid", exact: true }).click();
    const map = await waitFor("the camp on the drawn hex columns", () => hx9cOnHexes(run.camp, "columns", 56), 15_000);
    const bar = dm.getByRole("toolbar", { name: "Line up grid options" });
    await bar.locator("[data-options-line]").filter({ hasText: `Found hex columns of ${hx9cPx(map.cellPx)} px. The grid is hex columns now.` }).first().waitFor();
    await shots.take(dm, "hx9c-find-switches-to-hex-columns");
    await undoSetup(dm);
    await waitFor("one undo back to hex rows and the guess", () => hx9cGuess(run.camp, "hexRows", 50));
    // From the options strip: the button keeps focus through the search and the switch.
    const find = bar.getByRole("button", { name: "Find the grid", exact: true });
    await find.focus();
    await find.press("Enter");
    await waitFor("the camp on hex columns again", () => hx9cOnHexes(run.camp, "columns", 56), 15_000);
    await bar.locator("[data-options-line]").filter({ hasText: "The grid is hex columns now." }).first().waitFor();
    assert.equal(await find.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement), true, "focus stays on Find the grid");
    await pickTool(dm, "Select");
  });

  test("hx9c-3. hexes found on a square scene with painted ground leave its shape, and the line says why", async () => {
    await hx9cPut(run.moor, await hx9cMap("Hex moor", "rows", 64, 33));
    const panel = await openScenes(dm);
    await viewScene(dm, panel, run.moor);
    const group = await openSceneGroup(panel, "Map image and grid");
    await group.getByRole("button", { name: "Find the grid", exact: true }).click();
    const bar = dm.getByRole("toolbar", { name: "Line up grid options" });
    const line = bar.locator("[data-options-line]").filter({ hasText: "but this scene has painted ground on its squares, which can't stand on hexes. Remove them to change the grid." }).first();
    await line.waitFor({ timeout: 15_000 });
    assert.match(await line.innerText(), /^Found hex rows of 6[34](\.\d)? px, but this scene has painted ground/);
    assert.equal(dmSocket.state?.scenes[run.moor]?.gridShape, undefined, "the shape stays");
    assert.equal(dmSocket.state?.scenes[run.moor]?.map?.cellPx, 50, "the grid stays");
    await shots.take(dm, "hx9c-find-refused-switch");
    await pickTool(dm, "Select");
  });

  test("hx9c-4. Line up grid's options strip with the longest new line, a refused switch, sits within 1 px at each size", async () => {
    const off: string[] = [];
    let phone: Awaited<ReturnType<typeof dmPhone>> | null = null;
    try {
      for (const size of SIZES) {
        let page = dm;
        if (size.touch) {
          phone ??= await dmPhone(size);
          page = phone.page;
        }
        for (const scale of SCALES) {
          const at = `${size.name} at ${scale * 100}%`;
          await openAt(page, size, scale);
          const panel = await openScenes(page);
          await viewScene(page, panel, run.moor);
          const group = await openSceneGroup(panel, "Map image and grid");
          await group.getByRole("button", { name: "Find the grid", exact: true }).click();
          const bar = page.getByRole("toolbar", { name: "Line up grid options" });
          await bar.locator("[data-options-line]").filter({ hasText: "Remove them to change the grid." }).first().waitFor({ timeout: 15_000 });
          off.push(...alignmentLines(await measureAlignment(bar), `Line up grid's options with a refused switch at ${at}`));
          await shots.take(page, `hx9c-refused-line-${size.name}-${scale * 100}`);
          // Cut short, the line opens on a tap and wraps, as section 6.1's lines do.
          const cut = bar.locator('[data-options-line="shown"] button[aria-expanded="false"]');
          if ((await cut.count()) > 0) {
            await cut.first().click();
            await bar.locator('[data-options-line="open"]').waitFor();
            off.push(...alignmentLines(await measureAlignment(bar), `Line up grid's options with the refused switch's line open at ${at}`));
            await shots.take(page, `hx9c-refused-line-open-${size.name}-${scale * 100}`);
          }
          await pickTool(page, "Select");
        }
      }
    } finally {
      await phone?.context.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  /*
   * Lane FU35-A's steps (fu35a-): a rider on a Large mount squeezed into a
   * corridor one hex or one square wide sits on the mount's one hex or
   * square there (D-261029-52, D-261029-53), so the rider's own torch
   * lights the corridor and the party sees down it.
   */

  test("fu35a-1. Brom rides the warhorse into a one-hex corridor: he sits on its one hex there, and his torch lights the corridor for the party, so Pat sees the goblin down it", async () => {
    const keep = { scene: randomUUID(), horse: randomUUID(), brom: randomUUID(), gob: randomUUID() };
    // A block of rock with a one-row corridor along row 14, the warhorse well west of it, a goblin in the dark down the corridor.
    const rock = (h: Hex) => h.col >= 16 && h.col <= 22 && h.row >= 11 && h.row <= 17 && h.row !== 14;
    await ops.send({ t: "scene.create", scene: { id: keep.scene, name: "Keep", bounds: BOUNDS, gridShape: "hexRows" } });
    await waitFor("the keep in the DM's state", () => dmSocket.state?.scenes[keep.scene] ?? null);
    // The DM's copy holds the build of the scene in view, so the keep is opened before its walls go down.
    const panel = await openScenes(dm);
    await viewScene(dm, panel, keep.scene);
    await dm.keyboard.press("Escape");
    await ops.send({ t: "scene.update", sceneId: keep.scene, patch: { blockMovement: true, fogEnabled: true, vision: { on: true, light: "dark" } } });
    const walls = wallsRound(G, BOUNDS, rock);
    for (let i = 0; i < walls.length; i += 100) await ops.send({ t: "build.walls", sceneId: keep.scene, put: walls.slice(i, i + 100) });
    await waitFor("the keep's walls", () => (Object.values(dmSocket.state?.buildChunks ?? {}).reduce((n, c) => n + (c?.sceneId === keep.scene ? (c.walls?.length ?? 0) : 0), 0) === walls.length ? true : null));
    await ops.send(creature(keep.horse, "Warhorse", "large", { col: 8, row: 9 }, { sceneId: keep.scene, kind: "npc", disposition: "ally" }));
    await ops.send(creature(keep.brom, "Brom", "medium", { col: 6, row: 9 }, { sceneId: keep.scene, kind: "pc", disposition: "ally", ownerIds: [run.patId], light: { bright: 10, dim: 10 } }));
    await ops.send(creature(keep.gob, "Keep goblin", "medium", { col: 21, row: 14 }, { sceneId: keep.scene }));
    const horse = await waitFor("the warhorse", () => dmSocket.state?.tokens[keep.horse] ?? null);
    // Brom on the warhorse's lower west hex, which its offset alone would carry into the rock beside the corridor.
    const seat = placedOnHex(G, { size: "medium", x: 0, y: 0 }, occupiedHexes(G, horse)[2]!);
    await ops.send({ t: "token.attach", tokenId: keep.brom, to: keep.horse, kind: "ride", x: seat.x, y: seat.y, elevation: 0 });
    await waitFor("Brom on the warhorse", () => (dmSocket.state?.tokens[keep.brom]?.attached?.to === keep.horse ? true : null));
    await ops.send({ t: "room.setPlayerScene", sceneId: keep.scene });
    await waitFor("Brom in Pat's copy", () => (patSocket.state?.tokens[keep.brom] ? true : null));
    assert.equal(patSocket.state?.tokens[keep.gob], undefined, "the goblin in the dark, past Brom's torch");

    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    // The warhorse's middle starts a drag of the warhorse, whatever it carries.
    await holdDrag(dm, { x: horse.x + 1, y: horse.y + 1 }, hexCenter(G, { col: 19, row: 14 }));
    await dm.mouse.up();
    const inside = await waitFor("the warhorse squeezed in the corridor", () => {
      const t = dmSocket.state?.tokens[keep.horse];
      return t?.squeeze === true && tokenRefHex(G, t).row === 14 && tokenRefHex(G, t).col >= 17 ? t : null;
    });
    const brom = dmSocket.state!.tokens[keep.brom]!;
    assert.equal(brom.attached?.to, keep.horse, "still riding");
    assert.deepEqual(occupiedHexes(G, brom).map(hexKey), occupiedHexes(G, inside).map(hexKey), "Brom on the warhorse's one hex");
    await waitFor("the goblin in Pat's copy, in Brom's torchlight", () => (patSocket.state?.tokens[keep.gob] ? true : null));
    await shots.take(dm, "fu35a-brom-in-corridor-dm");
    await shots.take(pat, "fu35a-corridor-lit-pat");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
  });

  test("fu35a-2. on squares too (D-261029-53): Brom, on the warhorse's far lower square, rides into a corridor one square wide on its one square there, and Pat sees the goblin down it", async () => {
    const keep = { scene: randomUUID(), horse: randomUUID(), brom: randomUUID(), gob: randomUUID() };
    await ops.send({ t: "scene.create", scene: { id: keep.scene, name: "Square keep", bounds: BOUNDS } });
    await waitFor("the square keep in the DM's state", () => dmSocket.state?.scenes[keep.scene] ?? null);
    const panel = await openScenes(dm);
    await viewScene(dm, panel, keep.scene);
    await dm.keyboard.press("Escape");
    await ops.send({ t: "scene.update", sceneId: keep.scene, patch: { blockMovement: true, fogEnabled: true, vision: { on: true, light: "dark" } } });
    // Rock from x 8 to 16 but for a corridor along row 10, its walls in runs of at most 8 cells.
    const runs: [number, number, number, number][] = [[8, 0, 8, 8], [8, 8, 8, 10], [8, 11, 8, 19], [8, 19, 8, 20], [16, 0, 16, 8], [16, 8, 16, 10], [16, 11, 16, 19], [16, 19, 16, 20], [8, 10, 16, 10], [8, 11, 16, 11]];
    const walls = runs.map(([ax, ay, bx, by], i) => ({ id: `fu35aq${String(i).padStart(6, "0")}`, a: [ax, ay] as [number, number], b: [bx, by] as [number, number], f: { kind: "wall" as const } }));
    await ops.send({ t: "build.walls", sceneId: keep.scene, put: walls });
    await waitFor("the square keep's walls", () => (Object.values(dmSocket.state?.buildChunks ?? {}).reduce((n, c) => n + (c?.sceneId === keep.scene ? (c.walls?.length ?? 0) : 0), 0) === walls.length ? true : null));
    const make = (id: string, name: string, size: "medium" | "large", x: number, y: number, extra: Record<string, unknown>) => ({ t: "token.create" as const, token: { id, sceneId: keep.scene, kind: "monster", name, size, x, y, disposition: "hostile", visibility: "all", actor: { inline: ACTOR }, ...extra } });
    await ops.send(make(keep.horse, "Warhorse", "large", 3, 9, { kind: "npc", disposition: "ally" }));
    await ops.send(make(keep.brom, "Brom", "medium", 1, 9, { kind: "pc", disposition: "ally", ownerIds: [run.patId], light: { bright: 10, dim: 10 } }));
    await ops.send(make(keep.gob, "Keep goblin", "medium", 14, 10, {}));
    await waitFor("the warhorse", () => dmSocket.state?.tokens[keep.horse] ?? null);
    // The square whose offset alone would leave Brom straddling the corridor's far wall, his eye on the rock's side of it.
    await ops.send({ t: "token.attach", tokenId: keep.brom, to: keep.horse, kind: "ride", x: 4, y: 10, elevation: 0 });
    await waitFor("Brom on the warhorse", () => (dmSocket.state?.tokens[keep.brom]?.attached?.to === keep.horse ? true : null));
    await ops.send({ t: "room.setPlayerScene", sceneId: keep.scene });
    await waitFor("Brom in Pat's copy", () => (patSocket.state?.tokens[keep.brom] ? true : null));
    assert.equal(patSocket.state?.tokens[keep.gob], undefined, "the goblin in the dark, past Brom's torch");

    await dm.getByRole("button", { name: "Fit the map to the screen" }).click();
    // The warhorse's middle, a corner Brom's square only touches, starts a drag of the warhorse.
    await holdDrag(dm, { x: 4, y: 10 }, { x: 12.5, y: 10.5 });
    await dm.mouse.up();
    await waitFor("the warhorse squeezed in the corridor", () => {
      const t = dmSocket.state?.tokens[keep.horse];
      return t?.squeeze === true && t.y === 9.5 && t.x >= 8 ? t : null;
    });
    const brom = dmSocket.state!.tokens[keep.brom]!;
    const horse = dmSocket.state!.tokens[keep.horse]!;
    assert.equal(brom.attached?.to, keep.horse, "still riding");
    assert.deepEqual([brom.x, brom.y], [horse.x + 0.5, horse.y + 0.5], "Brom on the warhorse's one square");
    await waitFor("the goblin in Pat's copy, in Brom's torchlight", () => (patSocket.state?.tokens[keep.gob] ? true : null));
    await shots.take(dm, "fu35a-square-corridor-dm");
    await shots.take(pat, "fu35a-square-corridor-lit-pat");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
  });

  test("HX-12. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});
