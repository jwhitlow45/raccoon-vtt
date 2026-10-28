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
import { footprintSubcells, placedOnHex, tokenRefHex } from "../shared/rules/footprint.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexDistance, hexNeighbors, type Hex, type HexGrid } from "../shared/rules/hex.ts";
import { arrowStep, isometric } from "../client/lib/view.ts";
import { HEX_LIMITS, NEW_SCENES_HELP } from "../client/features/grid/words.ts";
import { assertCanvasAt, ConsoleWatch, openSceneGroup, openSideTab, sceneGroup, OpSocket, pagePoint, pickOption, pickTool, reopenRoom, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

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
 * and those screens' alignment.
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

/** H1's limit lines, which say what a hex scene leaves to squares (section 6's table). */
const LIMIT_LINES = new Set<string>([...Object.values(HEX_LIMITS), "Walking needs squares.", "Counted on squares only."]);

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
    const state = dmSocket.state!;
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
    await panel.getByText("Line up the hexes next.", { exact: true }).waitFor();
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

  test("HX4-3. Line up grid on a hex map: a box over 7 hexes, px per hex, no search for square grids, and Apply stores the hexes' size", async () => {
    const data = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 80, g: 90, b: 70 } } }).png().toBuffer();
    const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
    assert.ok(res.ok(), `the upload answered ${res.status()}`);
    const art = (await res.json()) as { id: string; width: number; height: number };
    await ops.send({ t: "scene.setMap", sceneId: run.camp, map: { assetId: art.id, widthPx: art.width, heightPx: art.height, cellPx: 50, originPx: { x: 0, y: 0 } } });
    await waitFor("the camp's map", () => dmSocket.state?.scenes[run.camp]?.map?.assetId === art.id || null);
    const panel = await openScenes(dm);
    const map = await openSceneGroup(panel, "Map image and grid");
    const find = map.getByRole("button", { name: "Find the grid", exact: true });
    assert.equal(await find.isDisabled(), true, "Find the grid finds square grids only");
    assert.deepEqual(await describedBy(find), [HEX_LIMITS.findGrid]);
    await map.getByText(HEX_LIMITS.counting, { exact: true }).waitFor();
    assert.equal(await map.getByText("Or count the squares").count(), 0);
    await map.getByRole("button", { name: "Line up the grid", exact: true }).click();
    const bar = dm.getByRole("toolbar", { name: "Line up grid options" });
    await bar.locator("[data-options-line]").filter({ hasText: "Drag a box over 3 hexes across. Fine-tune it by its corners." }).waitFor();
    await bar.getByText("50 px per hex", { exact: true }).filter({ visible: true }).first().waitFor();
    assert.equal(await bar.getByRole("button", { name: HEX_LIMITS.findGrid }).isDisabled(), true);
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

  test("HX4-4. no square on a hex scene's screens, the DM's settings or Pat's board, but the Squares choices", async () => {
    const panel = await openScenes(dm);
    await openSceneGroup(panel, "Map image and grid");
    await openSceneGroup(panel, "Size and view");
    assert.deepEqual(await squareWords(dm), [], "the DM's screen");
    await pat.bringToFront();
    assert.deepEqual(await squareWords(pat), [], "Pat's screen");
    await dm.bringToFront();
  });

  test("HX4-5. Room settings, the new scene form on hexes, a hex scene's settings, Line up grid's options and the builder's line sit within 1 px at each size", async () => {
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
        }
      }
    } finally {
      await phone?.context.close();
    }
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("dp-2a. Grid shape, Kind of scene, the new scene form's Grid and Room settings' Grid on new scenes stand one per row at full width at 320 x 568 and 130%, else share one row, Hex columns wrapping between its words at 390 x 844 and 130%, with no option under 44 px, no sideways scroll, and within 1 px at each size (docs/design-v1-design-pass.md 4.2)", async () => {
    const wrong: string[] = [];
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
      await phoneContext?.close();
    }
    assert.deepEqual(wrong, []);
    assert.deepEqual(off, [], "out of line by more than 1 px");
  });

  test("HX-12. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});
