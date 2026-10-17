import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, pickOption, pickTool, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * Tool options in one row (docs/design-v1-tool-options.md section 14): the
 * reach sweep over every tool state at every size, the rules that keep
 * things still under the finger, the popovers, the toolbar's Setup, pair
 * and tuck, the measured box and the names.
 *
 * It runs on E2E_PORT plus fifteen, one file after another as the others.
 *
 * Not always here, and why:
 * - The side panel's More comes with docs/design-v1-panel-tabs.md. Case 4
 *   presses it only where that build has made it. Until then the base's
 *   one-open-popover rule across consumers is tested in
 *   client/components/popover.test.ts.
 * - Safari's own focus on a tapped button, and the on-screen keyboard over
 *   a popover's field, are checked by hand on an iPhone (14).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 15;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-options-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

type Insets = { top?: number; side?: number; bottom?: number };
type Size = { width: number; height: number; insets: Insets; expect?: Partial<Record<Role, string>> };
type Role = "dm" | "player";

/** The sizes of 4.3, with the notch and home bar each holds that way up. */
const SIZES: Size[] = [
  { width: 320, height: 568, insets: {} },
  { width: 390, height: 844, insets: { top: 47, bottom: 34 } },
  { width: 844, height: 390, insets: { side: 47, bottom: 21 } },
  { width: 667, height: 375, insets: {} },
  { width: 480, height: 320, insets: { side: 47, bottom: 21 } },
  { width: 932, height: 430, insets: { side: 59, bottom: 21 } },
  { width: 1280, height: 800, insets: {} },
];
const SCALES = [1, 1.3] as const;

/**
 * Rooms near the floors, `MERGE_MIN` and `MERGE_MIN_DM` (4.1), on phones
 * the main sweep does not hold, each with the arrangement it gives:
 * every priority-1 control must still stand inline (9.4, 13.1).
 */
const FLOOR_ROWS: { role: Role; scale: number; size: Size }[] = [
  // An iPhone 14 sideways at 115%: a player's merged room would be 260, under the floor, so the pair.
  { role: "player", scale: 1.15, size: { width: 844, height: 390, insets: { side: 47, bottom: 21 }, expect: { player: "pair" } } },
  // A 568 px phone sideways at 85%: a player merged at 276.
  { role: "player", scale: 0.85, size: { width: 568, height: 320, insets: {}, expect: { player: "merged" } } },
  // Sideways Android phones: a DM's whole toolbar would leave 283 and 279 px, under the DM's floor of 301, so the pair. At 85% it merges with 354.
  { role: "dm", scale: 1, size: { width: 800, height: 360, insets: {}, expect: { dm: "pair" } } },
  { role: "dm", scale: 1.15, size: { width: 915, height: 412, insets: {}, expect: { dm: "pair" } } },
  { role: "dm", scale: 0.85, size: { width: 740, height: 360, insets: {}, expect: { dm: "merged" } } },
];

/** The two rooms of the sweep under the floor (13.1), where a player's Draw sends its stroke chip behind ⋯. */
const UNDER_FLOOR = ["320x568@1.3", "480x320@1.3"];
/** While fixing a miss: `OPTIONS_ONLY=dm` or `player`, `OPTIONS_SIZES=844x390`, `OPTIONS_SCALES=1.3`, `OPTIONS_STATES=Fog` (a name's start), and `OPTIONS_SHOTS=1`. */
const ONLY = process.env.OPTIONS_ONLY ?? "";
const ONLY_SIZES = process.env.OPTIONS_SIZES?.split(",") ?? null;
const ONLY_SCALES = process.env.OPTIONS_SCALES?.split(",").map(Number) ?? null;
const ONLY_STATES = process.env.OPTIONS_STATES?.split(",") ?? null;
const MISS_SHOTS = process.env.OPTIONS_SHOTS === "1";
const sizes = () => (ONLY_SIZES ? SIZES.filter((s) => ONLY_SIZES.includes(`${s.width}x${s.height}`)) : SIZES);
const scales = () => SCALES.filter((s) => !ONLY_SCALES || ONLY_SCALES.includes(s));

/** Where the row stands (4.3, 13.1). At 932 x 430 the side panel, shown, takes the map's width, and both roles take the pair. */
function expectedArrangement(role: Role, size: Size, scale: number, sidePanel: boolean): string {
  const set = size.expect?.[role];
  if (set) return set;
  const key = `${size.width}x${size.height}`;
  if (key === "932x430" && sidePanel && scale === 1) return "pair";
  const pairForDm = role === "dm" && ["844x390", "667x375", "932x430"].includes(key);
  if (pairForDm) return "pair";
  if (key === "844x390" || key === "667x375" || key === "932x430") return scale === 1 ? "merged" : "pair";
  if (key === "1280x800") return "floating";
  return "stacked";
}

/** The map's height between the top bars and what stands at its foot, with a tool's row showing (13.1). */
const MAP_HEIGHT: Record<string, number> = {
  "320x568@1": 403,
  "320x568@1.3": 272,
  "390x844@1": 598,
  "390x844@1.3": 403,
  "844x390@1": 256,
  "844x390@1.3": 166,
  "667x375@1": 262,
  "667x375@1.3": 176,
  "480x320@1": 134,
  "480x320@1.3": 60,
  "932x430@1": 296,
  "932x430@1.3": 197,
  "1280x800@1": 628,
  "1280x800@1.3": 443,
};

/** The page's own objects as the callbacks below use them: the e2e files are typed without the DOM. */
type PageBox = { top: number; bottom: number; left: number; right: number; height: number; width: number };
type PageNode = {
  dataset: Record<string, string | undefined>;
  tagName: string;
  textContent: string | null;
  scrollWidth: number;
  clientWidth: number;
  firstElementChild: PageNode | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): PageBox;
  querySelector(s: string): PageNode | null;
  querySelectorAll(s: string): ArrayLike<PageNode> & Iterable<PageNode>;
  closest(s: string): PageNode | null;
};
type PageDoc = { querySelector(s: string): PageNode | null; activeElement: PageNode | null; dispatchEvent(e: unknown): boolean };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let dm: Page;
let dmCdp: CDPSession;
let playerContext: BrowserContext;
let player: Page;
let playerCdp: CDPSession;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const consoles: ConsoleWatch[] = [];

const run = {
  roomId: "",
  roomName: `E2E options ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  thorn: { id: randomUUID(), characterId: randomUUID() },
  goblins: [randomUUID(), randomUUID(), randomUUID()],
  kept: Array.from({ length: 10 }, () => randomUUID()),
  stamp: randomUUID(),
  page: randomUUID(),
  map: { assetId: "", widthPx: 0, heightPx: 0 },
};

function actor(hp: number) {
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: 15,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 9,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

const misses: string[] = [];
let shotPage: Page | null = null;
async function miss(text: string): Promise<void> {
  misses.push(text);
  if (MISS_SHOTS) console.error(`MISS ${misses.length}: ${text}`);
  if (MISS_SHOTS && shotPage) await shots.take(shotPage, `options-miss-${misses.length}`);
}

async function view(page: Page, cdp: CDPSession, size: Size): Promise<void> {
  const i = size.insets;
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: i.top ?? 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(300);
}

const DESK: Size = { width: 1280, height: 800, insets: {} };

async function reloadAt(page: Page, scale: number): Promise<void> {
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

function sizeLabel(size: Size, scale: number): string {
  return `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
}

function tools(page: Page): Locator {
  return page.locator('nav[aria-label="Tools"]');
}

function options(page: Page): Locator {
  return page.locator('[role="toolbar"][data-rvtt-arrangement]');
}

/** Takes focus off any field, so a tool's key reaches the room. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
}

async function key(page: Page, letter: string): Promise<void> {
  await blur(page);
  await page.keyboard.press(letter);
  await page.waitForTimeout(150);
}

async function tapCellAt(page: Page, cell: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, { w: 0, h: 0 }, { x: cell.x + 0.5, y: cell.y + 0.5 });
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(150);
}

async function dragCellsTouch(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await pagePoint(page, { w: 0, h: 0 }, { x: from.x + 0.5, y: from.y + 0.5 });
  const b = await pagePoint(page, { w: 0, h: 0 }, { x: to.x + 0.5, y: to.y + 0.5 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Picks a tile in a chip's popover, wherever the chip stands (harness pickOption). */
async function pick(page: Page, tool: string, group: string, option: string): Promise<void> {
  await pickOption(page, tool, group, option);
  await page.waitForTimeout(150);
}

/** Closes whatever popover is open, by Escape with focus off any field. */
async function closePopover(page: Page): Promise<void> {
  const open = page.locator('[aria-expanded="true"][aria-haspopup]');
  if ((await open.count()) === 0) return;
  await blur(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}

// ------------------------------------------------ the states of section 9

/** A tool state to sweep: how to enter it, at `enterAt` where the desk's side panel would get in the way, and how to leave it. */
type State = { name: string; roles: readonly Role[]; tool: string; enter(page: Page): Promise<void>; leave?(page: Page): Promise<void>; noRow?: true; enterAt?: Size };

const BOTH: readonly Role[] = ["dm", "player"];
const DM_ONLY: readonly Role[] = ["dm"];

async function selectTool(page: Page, letter: string): Promise<void> {
  await closePopover(page);
  await key(page, "v");
  await key(page, letter);
}

const STATES: State[] = [
  { name: "Ruler, ten kept rulers", roles: BOTH, tool: "Ruler", enter: (p) => selectTool(p, "r") },
  { name: "Area idle", roles: BOTH, tool: "Area", enter: (p) => selectTool(p, "a") },
  {
    name: "Area placing",
    roles: BOTH,
    tool: "Area",
    async enter(p) {
      await selectTool(p, "a");
      await tapCellAt(p, { x: 20, y: 12 });
      await options(p).getByRole("button", { name: "Place", exact: true }).first().waitFor({ state: "attached" });
    },
    async leave(p) {
      await key(p, "v");
    },
  },
  {
    name: "Area picked",
    roles: BOTH,
    tool: "Area",
    async enter(p) {
      await selectTool(p, "a");
      await tapCellAt(p, { x: 20, y: 12 });
      // Place it from wherever it stands: inline, or behind ⋯.
      await pressSlot(p, "place");
      await options(p).locator('[data-rvtt-slot="done"]').first().waitFor({ state: "attached" });
    },
    async leave(p) {
      await pressSlot(p, "delete").catch(() => undefined);
      await key(p, "v");
    },
  },
  { name: "Draw", roles: BOTH, tool: "Draw", enter: (p) => selectTool(p, "d") },
  {
    name: "Draw, text entry",
    roles: BOTH,
    tool: "Draw",
    async enter(p) {
      await selectTool(p, "d");
      await pick(p, "Draw", "Drawing tool", "Text");
      await tapCellAt(p, { x: 22, y: 4 });
      await options(p).getByRole("textbox", { name: "Text" }).waitFor({ state: "attached" });
    },
    async leave(p) {
      await key(p, "v");
      await key(p, "d");
      await pick(p, "Draw", "Drawing tool", "Pen");
    },
  },
  {
    name: "Draw, polygon",
    roles: BOTH,
    tool: "Draw",
    async enter(p) {
      await selectTool(p, "d");
      await pick(p, "Draw", "Drawing tool", "Shape");
      await tapCellAt(p, { x: 22, y: 4 });
      await tapCellAt(p, { x: 24, y: 6 });
      await options(p).locator('[data-rvtt-slot="finish"]').first().waitFor({ state: "attached" });
    },
    async leave(p) {
      await key(p, "v");
      await key(p, "d");
      await pick(p, "Draw", "Drawing tool", "Pen");
    },
  },
  { name: "Ping", roles: BOTH, tool: "Ping", enter: (p) => selectTool(p, "p") },
  {
    name: "Fog off",
    roles: DM_ONLY,
    tool: "Fog",
    async enter(p) {
      await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: false } });
      await selectTool(p, "f");
      await options(p).getByRole("button", { name: "Turn fog on" }).waitFor({ state: "attached" });
    },
    async leave() {
      await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true } });
    },
  },
  { name: "Fog, rectangle", roles: DM_ONLY, tool: "Fog", enter: (p) => selectTool(p, "f") },
  {
    name: "Fog, polygon with corners",
    roles: DM_ONLY,
    tool: "Fog",
    async enter(p) {
      await selectTool(p, "f");
      await pick(p, "Fog", "Shape", "Polygon");
      await tapCellAt(p, { x: 2, y: 2 });
      await tapCellAt(p, { x: 4, y: 2 });
    },
    async leave(p) {
      await key(p, "v");
      await key(p, "f");
      await pick(p, "Fog", "Shape", "Rectangle");
    },
  },
  {
    name: "Fog, brush",
    roles: DM_ONLY,
    tool: "Fog",
    async enter(p) {
      await selectTool(p, "f");
      await pick(p, "Fog", "Shape", "Brush");
    },
    async leave(p) {
      await pick(p, "Fog", "Shape", "Rectangle");
    },
  },
  {
    name: "Fog with a draft",
    roles: DM_ONLY,
    tool: "Fog",
    async enter(p) {
      await selectTool(p, "f");
      await dragCellsTouch(p, { x: 1, y: 1 }, { x: 3, y: 3 });
      await waitFor("the fog draft", () => (dmSocket.state?.fogDrafts[run.sceneId]?.ops.length ?? 0) > 0 || null);
    },
    async leave() {
      await ops.send({ t: "fog.discard", sceneId: run.sceneId });
    },
  },
  ...(["Brush", "Rectangle room", "Shape room", "Erase", "Erase area", "Walls and doors", "Heights and stairs", "Label", "Lights", "Stamp"] as const).map(
    (mode): State => ({
      name: `Builder, ${mode}`,
      roles: DM_ONLY,
      tool: "Map builder",
      async enter(p) {
        await selectTool(p, "b");
        await options(p).locator('[data-rvtt-slot="mode"]').first().waitFor({ state: "attached" });
        await pick(p, "Map builder", "Builder mode", mode);
      },
    }),
  ),
  {
    name: "Builder, a stamp selected",
    roles: DM_ONLY,
    tool: "Map builder",
    async enter(p) {
      await selectTool(p, "b");
      await pick(p, "Map builder", "Builder mode", "Stamp");
      await tapCellAt(p, { x: 14, y: 3 });
      await options(p).locator('[data-rvtt-slot="stampDone"]').first().waitFor({ state: "attached" });
    },
    async leave(p) {
      await pressSlot(p, "stampDone");
      await pick(p, "Map builder", "Builder mode", "Brush");
    },
  },
  {
    name: "Line up grid, no map image",
    roles: DM_ONLY,
    tool: "Line up grid",
    noRow: true,
    async enter(p) {
      await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: null });
      await selectTool(p, "g");
    },
    async leave() {
      await setMap();
    },
  },
  { name: "Line up grid, no box", roles: DM_ONLY, tool: "Line up grid", noRow: true, enter: (p) => selectTool(p, "g") },
  {
    name: "Line up grid, a box",
    roles: DM_ONLY,
    tool: "Line up grid",
    async enter(p) {
      await selectTool(p, "g");
      await tapCellAt(p, { x: 6, y: 6 });
      await options(p).locator('[data-rvtt-slot="apply"]').first().waitFor({ state: "attached" });
    },
  },
  { name: "Add token", roles: DM_ONLY, tool: "Add token", enter: (p) => selectTool(p, "t") },
  {
    name: "Add token, a character chosen",
    roles: DM_ONLY,
    tool: "Add token",
    async enter(p) {
      await selectTool(p, "v");
      await openSideTab(p, "Characters");
      await p.getByRole("tabpanel").getByRole("button", { name: /^Thorn/ }).first().click();
      await p.getByRole("tabpanel").getByRole("button", { name: "Place a token" }).click();
      await options(p).getByText("Tap the map to place").first().waitFor();
    },
    async leave(p) {
      await key(p, "v");
    },
  },
  { name: "Pin", roles: DM_ONLY, tool: "Pin", enter: (p) => selectTool(p, "m") },
  {
    name: "Pin, pinning a journal page",
    roles: DM_ONLY,
    tool: "Pin",
    async enter(p) {
      await selectTool(p, "v");
      await openSideTab(p, "Journal");
      await p.getByRole("button", { name: /^Lore/ }).first().click();
      await p.getByRole("button", { name: "Pin to the map" }).click();
      await options(p).getByText("Tap the map to place the pin for Lore.").first().waitFor();
    },
    async leave(p) {
      await key(p, "v");
      await p.getByRole("tab", { name: "Initiative" }).click().catch(() => undefined);
    },
  },
  {
    name: "Multi-select",
    roles: BOTH,
    tool: "Select",
    // On a phone, where a selection opens no Token tab that turning back to a phone would make a sheet over the options.
    enterAt: SIZES[1],
    async enter(p) {
      await selectTool(p, "v");
      const socket = p === player ? playerSocket : dmSocket;
      const mine = p === player ? run.thorn.id : run.goblins[0]!;
      const token = socket.state!.tokens[mine]!;
      await tapCellAt(p, { x: token.x, y: token.y });
      // Whichever token the tap took: the sweep's own states add tokens, which may stand on that cell by now.
      const bar = p.getByRole("dialog", { name: / actions$/ }).first();
      await bar.getByRole("button", { name: "Multi-select", exact: true }).click();
      await options(p).getByText("1 selected.").first().waitFor();
      // A tap off hides the group's bar, which on a short screen covers the row, and Actions shows: on a cell no token stands on or beside, where the map, not the bar, takes the tap.
      const tokens = Object.values(socket.state!.tokens);
      const bounds = socket.state!.scenes[run.sceneId]!.bounds;
      const origin = await pagePoint(p, bounds, { x: 0, y: 0 });
      const unit = await pagePoint(p, bounds, { x: 1, y: 1 });
      // Kept rulers take a tap too, so their boxes are no tap off either.
      const drawn = Object.values(socket.state!.drawings).map((d) => {
        const xs = d.points.filter((_, i) => i % 2 === 0);
        const ys = d.points.filter((_, i) => i % 2 === 1);
        return { left: Math.min(...xs) - 1, right: Math.max(...xs) + 1, top: Math.min(...ys) - 1, bottom: Math.max(...ys) + 1 };
      });
      const free: { x: number; y: number; px: number; py: number }[] = [];
      for (let y = 0; y < bounds.h; y++) {
        for (let x = 0; x < bounds.w; x++) {
          if (!tokens.every((t) => Math.abs(t.x - x) > 2 || Math.abs(t.y - y) > 2)) continue;
          if (drawn.some((b) => x + 1 >= b.left && x <= b.right && y + 1 >= b.top && y <= b.bottom)) continue;
          free.push({ x, y, px: origin.x + (x + 0.5) * (unit.x - origin.x), py: origin.y + (y + 0.5) * (unit.y - origin.y) });
        }
      }
      // Nearest the cell the earlier runs used first.
      free.sort((a, b) => Math.hypot(a.x - 5, a.y - 4) - Math.hypot(b.x - 5, b.y - 4));
      const onMap = await p.evaluate(
        (cells) => cells.findIndex((c) => (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(c.px, c.py)?.tagName === "CANVAS"),
        free,
      );
      await tapCellAt(p, free[onMap] ?? { x: 5, y: 4 });
      await options(p).getByRole("button", { name: "Actions", exact: true }).waitFor({ state: "attached" });
    },
    async leave(p) {
      await pressSlot(p, "done");
    },
  },
];

/**
 * A panel picked from the side panel opens as a sheet once the screen is
 * a phone's, which hides the options: closed on a phone's screen so the
 * next state starts with the options in view.
 */
async function closeSheet(page: Page, cdp: CDPSession): Promise<void> {
  await view(page, cdp, SIZES[1]!);
  await closeShownSheet(page);
  await view(page, cdp, DESK);
}

/** Closes the sheet on a phone's screen, if one shows. A sheet's close is named for its title ("Close Initiative"), the panel list's is plain "Close". */
async function closeShownSheet(page: Page): Promise<void> {
  const sheet = page.locator("dialog[data-rvtt-sheet]").filter({ visible: true }).first();
  const title = (await sheet.count()) > 0 ? await sheet.getAttribute("aria-label") : null;
  const close = title
    ? sheet.getByRole("button", { name: `Close ${title}`, exact: true })
    : page.locator('[role="dialog"][aria-modal="false"], section').getByRole("button", { name: "Close", exact: true });
  if ((await close.count()) > 0 && (await close.first().isVisible())) {
    await close.first().tap();
    await page.waitForTimeout(200);
  }
}

/** Presses a slot's control wherever it stands: inline, or in ⋯. */
async function pressSlot(page: Page, id: string): Promise<void> {
  const inline = options(page).locator(`[data-options-row] [data-rvtt-slot="${id}"]`).first();
  if ((await inline.count()) > 0) {
    await inline.locator("button").first().click();
    return;
  }
  await options(page).locator("[data-rvtt-more] button").first().click();
  const more = page.locator(`[role="dialog"] [data-rvtt-slot="${id}"]`).first();
  await more.locator("button").first().click();
  await closePopover(page);
}

async function setMap(): Promise<void> {
  await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: run.map.assetId, widthPx: run.map.widthPx, heightPx: run.map.heightPx, cellPx: 50, originPx: { x: 0, y: 0 } } });
}

// ------------------------------------------------ one state at one size

type Seen = { ids: Set<string>; where: Map<string, string> };

/**
 * Every check of the sweep (14, case 2) for the state as it stands now: its
 * arrangement, its one line of controls, every slot in reach inline or one
 * tap away, the priority-1 rule, the line and the map's height.
 */
async function checkState(page: Page, role: Role, size: Size, scale: number, state: State, label: string): Promise<Seen | null> {
  const el = options(page);
  if ((await el.count()) === 0) {
    await miss(`${label}: no options element`);
    return null;
  }
  const arrangement = await el.getAttribute("data-rvtt-arrangement");
  const sidePanel = await page.locator("aside").first().isVisible().catch(() => false);
  const expected = expectedArrangement(role, size, scale, sidePanel);
  if (arrangement !== expected) await miss(`${label}: arranged ${arrangement}, expected ${expected}`);
  const facts = await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: PageDoc }).document;
    const root = doc.querySelector('[role="toolbar"][data-rvtt-arrangement]')!;
    const row = root.querySelector("[data-options-row]");
    const slots = row ? [...row.querySelectorAll(":scope > [data-rvtt-slot]")] : [];
    const r = (e: PageNode) => {
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height };
    };
    const line = root.querySelector("[data-options-line]");
    const nav = doc.querySelector('nav[aria-label="Tools"]')!;
    const header = doc.querySelector("header")!;
    return {
      overflow: row ? row.scrollWidth > row.clientWidth + 1 : false,
      slots: slots.map((s) => ({ id: s.dataset.rvttSlot!, priority: Number(s.dataset.rvttPriority), holds: s.dataset.rvttHolds ?? "", box: r(s) })),
      more: !!root.querySelector("[data-rvtt-more]"),
      line: line ? { box: r(line), cut: !!line.querySelector("button[aria-expanded]"), state: line.dataset.optionsLine } : null,
      element: r(root),
      toolbar: r(nav),
      header: r(header),
      width: (globalThis as unknown as { innerWidth: number }).innerWidth,
      arrangement: root.getAttribute("data-rvtt-arrangement"),
    };
  });
  if (facts.overflow) await miss(`${label}: the row overflows`);
  const centers = facts.slots.map((s) => (s.box.top + s.box.bottom) / 2);
  if (centers.length > 0 && Math.max(...centers) - Math.min(...centers) > 1) await miss(`${label}: the row's controls stand on more than one line`);
  if (!state.noRow && facts.slots.length === 0 && !facts.more) await miss(`${label}: the row is empty`);

  const seen: Seen = { ids: new Set(), where: new Map() };
  for (const s of facts.slots) {
    seen.ids.add(s.id);
    seen.where.set(s.id, "row");
    const frame = el.locator(`[data-options-row] > [data-rvtt-slot="${s.id}"]`);
    if (!(await wholeInReach(frame))) await miss(`${label}: the slot "${s.id}" is cut off or takes no tap`);
  }
  const inRow = facts.arrangement === "merged" || facts.arrangement === "pair";
  // Priority 1 stays inline in the toolbar's row, and for a player in every room at or over the floor (4.1).
  const p1Checked = inRow || (role === "player" && !UNDER_FLOOR.includes(`${size.width}x${size.height}@${scale}`));
  const p1Allowed = (id: string) => role === "dm" && id === "height";
  // ⋯ and what waits in it.
  if (facts.more) {
    const button = el.locator("[data-rvtt-more] button").first();
    if (!(await wholeInReach(button))) await miss(`${label}: ⋯ is cut off or takes no tap`);
    await button.tap();
    const dialog = page.getByRole("dialog", { name: `More ${state.tool} options` });
    if (!(await dialog.isVisible().catch(() => false))) await miss(`${label}: ⋯ opened no "More ${state.tool} options"`);
    else {
      const frames = dialog.locator("[data-rvtt-slot]");
      for (let i = 0; i < (await frames.count()); i++) {
        const frame = frames.nth(i);
        const id = (await frame.getAttribute("data-rvtt-slot")) ?? "";
        const priority = Number(await frame.getAttribute("data-rvtt-priority"));
        seen.ids.add(id);
        seen.where.set(id, "more");
        if (!(await controlsInReach(frame))) await miss(`${label}: "${id}" in ⋯ is cut off once scrolled to`);
        if (p1Checked && priority === 1 && !p1Allowed(id)) await miss(`${label}: the priority-1 "${id}" waits in ⋯`);
      }
      await closePopover(page);
    }
  }
  // What waits in a chip's popover.
  for (const s of facts.slots.filter((x) => x.holds)) {
    await el.locator(`[data-options-row] > [data-rvtt-slot="${s.id}"] button`).first().tap();
    for (const id of s.holds.split(" ")) {
      const frame = page.locator(`[role="dialog"] [data-rvtt-slot="${id}"]`).first();
      seen.ids.add(id);
      seen.where.set(id, `in ${s.id}`);
      if ((await frame.count()) === 0) {
        await miss(`${label}: "${id}" is not in its chip's popover`);
        continue;
      }
      if (!(await controlsInReach(frame))) await miss(`${label}: "${id}" in its chip's popover is cut off`);
      if (p1Checked && Number(await frame.getAttribute("data-rvtt-priority")) === 1 && !p1Allowed(id)) await miss(`${label}: the priority-1 "${id}" waits in a popover`);
    }
    await closePopover(page);
  }

  // The line: above the row or the toolbar, inside the map, and a cut one shows all of itself.
  if (facts.line && facts.line.state === "shown") {
    const foot = inRow || facts.slots.length === 0 ? facts.toolbar.top : facts.element.top;
    if (facts.line.box.bottom > foot - 4) await miss(`${label}: the line stands on the row or the toolbar`);
    if (facts.line.box.top < facts.header.bottom - 1 || facts.line.box.left < 0 || facts.line.box.right > facts.width + 1) await miss(`${label}: the line leaves the map`);
    if (facts.line.cut) {
      const button = el.locator("[data-options-line] button[aria-expanded]");
      await button.tap();
      if ((await button.getAttribute("aria-expanded")) !== "true") await miss(`${label}: a tap on the cut line did not open it`);
      else {
        const whole = await button.evaluate((b) => (globalThis as unknown as { getComputedStyle(e: unknown): { whiteSpace: string } }).getComputedStyle(b.firstElementChild).whiteSpace !== "nowrap");
        if (!whole) await miss(`${label}: the open line is still cut`);
        await button.tap();
      }
    }
  }

  // The map's height between the bars (13.1), for the Ruler, whose row always shows.
  if (state.name.startsWith("Ruler")) {
    const foot = inRow ? facts.toolbar.top : Math.min(facts.element.top, facts.toolbar.top);
    const height = Math.round((foot - facts.header.bottom) / scale);
    const want = MAP_HEIGHT[`${size.width}x${size.height}@${scale}`];
    if (want !== undefined && Math.abs(height - want) > 2) await miss(`${label}: the map is ${height} px tall between the bars, expected ${want}`);
  }
  return seen;
}

/** Each control of a slot in a popover whole in reach once the popover scrolls to it: a slot taller than the popover is reached a control at a time. */
async function controlsInReach(frame: Locator): Promise<boolean> {
  const controls = frame.locator('button, input:not([type="radio"]), label.rvtt-choice');
  const count = await controls.count();
  if (count === 0) {
    await frame.evaluate((e) => e.scrollIntoView({ block: "nearest" }));
    return wholeInReach(frame);
  }
  for (let i = 0; i < count; i++) {
    const control = controls.nth(i);
    await control.evaluate((e) => e.scrollIntoView({ block: "nearest" }));
    if (!(await wholeInReach(control))) return false;
  }
  return true;
}

async function sweep(page: Page, cdp: CDPSession, role: Role, scale: number, at: readonly Size[] = sizes()): Promise<number> {
  let steps = 0;
  for (const state of STATES.filter((s) => s.roles.includes(role) && (!ONLY_STATES || ONLY_STATES.some((o) => s.name.startsWith(o))))) {
    await view(page, cdp, state.enterAt ?? DESK);
    try {
      await state.enter(page);
    } catch (err) {
      await miss(`${role} at ${scale}: entering "${state.name}" failed: ${(err as Error).message.split("\n")[0]}`);
      await key(page, "v").catch(() => undefined);
      continue;
    }
    let reference: Seen | null = null;
    for (const size of at) {
      await view(page, cdp, size);
      const label = `${role}, ${sizeLabel(size, scale)}, ${state.name}`;
      const seen = await checkState(page, role, size, scale, state, label);
      steps += 1;
      if (!seen) continue;
      // Every control drawn in exactly one place, and the same ones at every size.
      if (!reference) reference = seen;
      else {
        const lost = [...reference.ids].filter((id) => !seen.ids.has(id));
        const extra = [...seen.ids].filter((id) => !reference!.ids.has(id));
        if (lost.length > 0 || extra.length > 0)
          await miss(`${label}: slots differ from the first size: lost ${lost.join(", ") || "none"}, extra ${extra.join(", ") || "none"} (first ${JSON.stringify([...reference.where])}, now ${JSON.stringify([...seen.where])})`);
      }
      if (scale === 1.3 && size.width === 480) await shots.take(page, `options-${role}-480x320-130-${state.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
    }
    await view(page, cdp, DESK);
    await state.leave?.(page).catch(async (err) => miss(`${role} at ${scale}: leaving "${state.name}" failed: ${(err as Error).message.split("\n")[0]}`));
    await closeSheet(page, cdp);
  }
  return steps;
}

describe("raccoon-vtt tool options in one row", { timeout: 3_600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
    dm = await dmContext.newPage();
    await dmSocket.attach(dmContext, dm);
    const dmConsole = new ConsoleWatch("dm");
    dmConsole.attach(dm);
    consoles.push(dmConsole);
    dmCdp = await dmContext.newCDPSession(dm);
    playerContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, hasTouch: true });
    player = await playerContext.newPage();
    await playerSocket.attach(playerContext, player);
    const playerConsole = new ConsoleWatch("player");
    playerConsole.attach(player);
    consoles.push(playerConsole);
    playerCdp = await playerContext.newCDPSession(player);
  });

  after(async () => {
    ops?.close();
    if (run.roomId && dmContext) {
      try {
        await dmContext.request.delete(`${server.origin}/api/rooms/${run.roomId}`, { headers: { Origin: server.origin }, data: { name: run.roomName } });
      } catch (err) {
        console.error(`Deleting room ${run.roomId} failed`, err);
      }
    }
    await browser?.close();
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  test("1. a DM's room with Pat's Thorn, goblins, ten of Pat's kept rulers, a map image, a stamp and a journal page", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    const password = await dm.getByLabel("Player password").inputValue();
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

    const headers = { Origin: server.origin, "content-type": "application/json" };
    const joined = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password } });
    assert.ok(joined.ok(), `joining answered ${joined.status()}`);
    const { ticket } = (await joined.json()) as { ticket: string };
    const done = await playerContext.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name: "Pat", color: "#30a46c" } });
    assert.ok(done.ok(), `completing the join answered ${done.status()}`);
    run.patId = ((await done.json()) as { member: { id: string } }).member.id;

    const image = await sharp({ create: { width: 1500, height: 1000, channels: 3, background: { r: 70, g: 80, b: 60 } } }).png().toBuffer();
    const uploaded = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: image });
    assert.ok(uploaded.ok(), `the upload answered ${uploaded.status()}`);
    const asset = (await uploaded.json()) as { id: string; width: number; height: number };
    run.map = { assetId: asset.id, widthPx: asset.width, heightPx: asset.height };

    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await setMap();
    await ops.send({ t: "settings.update", patch: { playersDraw: "all" } }).catch(() => undefined);
    await ops.send({ t: "character.create", character: { id: run.thorn.characterId, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor(24) } });
    const token = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send(token(run.thorn.id, { kind: "pc", name: "Thorn", x: 8, y: 8, disposition: "ally", actor: { ref: run.thorn.characterId } }));
    for (const [i, id] of run.goblins.entries()) await ops.send(token(id, { kind: "monster", name: "Goblin", number: i + 1, x: 12 + i * 2, y: 9, disposition: "hostile", actor: { inline: actor(7) } }));
    for (const [i, id] of run.kept.entries()) {
      await ops.send({
        t: "drawing.create",
        drawing: { id, sceneId: run.sceneId, kind: "ruler", points: [1, 10 + i, 3 + i, 10 + i], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: run.patId, visibility: "all", anchors: [null, null] },
      });
    }
    await ops.send({ t: "build.stamps", sceneId: run.sceneId, put: [{ id: run.stamp, art: { key: "barrel" }, x: 14.5, y: 3.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] });
    await ops.send({ t: "journal.create", page: { id: run.page, title: "Lore", access: "all", blocks: [{ id: randomUUID().replace(/-/g, "").slice(0, 12), text: "The citadel fell." }] } });

    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Thorn on the player's map", () => playerSocket.state?.tokens[run.thorn.id]);
  });

  for (const scale of scales()) {
    test(`2. the reach sweep, the DM at ${Math.round(scale * 100)}%: every tool state at every size`, { skip: ONLY === "player" }, async () => {
      await reloadAt(dm, scale);
      shotPage = dm;
      const before = misses.length;
      const steps = await sweep(dm, dmCdp, "dm", scale);
      console.error(`DM at ${scale}: ${steps} checks, ${misses.length - before} misses`);
    });
    test(`2. the reach sweep, the player at ${Math.round(scale * 100)}%: every tool state at every size`, { skip: ONLY === "dm" }, async () => {
      await reloadAt(player, scale);
      shotPage = player;
      const before = misses.length;
      const steps = await sweep(player, playerCdp, "player", scale);
      console.error(`player at ${scale}: ${steps} checks, ${misses.length - before} misses`);
    });
  }

  test("2. the sweep at the floor: rooms just over it hold every priority-1 control", { skip: ONLY_SIZES !== null }, async () => {
    for (const row of FLOOR_ROWS) {
      if (ONLY && ONLY !== row.role) continue;
      const page = row.role === "dm" ? dm : player;
      await reloadAt(page, row.scale);
      shotPage = page;
      const before = misses.length;
      const steps = await sweep(page, row.role === "dm" ? dmCdp : playerCdp, row.role, row.scale, [row.size]);
      console.error(`${row.role} at ${row.scale}, ${row.size.width} x ${row.size.height}: ${steps} checks, ${misses.length - before} misses`);
    }
    await reloadAt(dm, 1);
    await reloadAt(player, 1);
  });

  test("2b. nothing in the sweep is out of reach", () => {
    assert.deepEqual(misses, []);
  });

  test("3. nothing moves under the finger", async () => {
    await reloadAt(dm, 1);
    await view(dm, dmCdp, SIZES[1]!);
    // A tool's first frame already stands in its arrangement: read before any paint after the key.
    const firstFrame = await dm.evaluate(async () => {
      const g = globalThis as unknown as { document: PageDoc; requestAnimationFrame(cb: () => void): number; KeyboardEvent: new (type: string, init: object) => unknown };
      const seen: (string | null)[] = [];
      const read = () => seen.push(g.document.querySelector('[role="toolbar"][data-rvtt-arrangement]')?.getAttribute("data-rvtt-arrangement") ?? null);
      g.document.dispatchEvent(new g.KeyboardEvent("keydown", { key: "d", code: "KeyD", bubbles: true }));
      await new Promise<void>((resolve) => g.requestAnimationFrame(() => (read(), resolve())));
      return seen;
    });
    assert.deepEqual(firstFrame, ["stacked"], "Draw's first frame is already stacked");

    // Picking Eraser in the drawing tool popover leaves Undo where it was.
    const undo = options(dm).locator('[data-options-row] [data-rvtt-slot="undo"]');
    const before = await undo.boundingBox();
    await pick(dm, "Draw", "Drawing tool", "Eraser");
    assert.deepEqual(await undo.boundingBox(), before, "Undo stays put");
    await pick(dm, "Draw", "Drawing tool", "Pen");

    // Keeping a ruler leaves Keep and Clear where they were.
    await selectTool(dm, "r");
    const keep = options(dm).locator('[data-rvtt-slot="keep"]');
    const clear = options(dm).locator('[data-rvtt-slot="clear"]');
    await dragCellsTouch(dm, { x: 18, y: 2 }, { x: 22, y: 2 });
    const keepAt = await keep.boundingBox();
    const clearAt = await clear.boundingBox();
    await keep.locator("button").tap();
    await dm.waitForTimeout(300);
    assert.deepEqual([await keep.boundingBox(), await clear.boundingBox()], [keepAt, clearAt], "Keep and Clear stay put");

    // The first tap on a stamp's Delete leaves its box.
    await view(dm, dmCdp, DESK);
    await selectTool(dm, "b");
    await pick(dm, "Map builder", "Builder mode", "Stamp");
    await tapCellAt(dm, { x: 14, y: 3 });
    const del = options(dm).locator('[data-options-row] [data-rvtt-slot="delete"] button');
    await del.waitFor();
    const delAt = await del.boundingBox();
    await del.tap();
    assert.deepEqual(await del.boundingBox(), delAt, "the armed Delete keeps its box");
    await pressSlot(dm, "stampDone");

    // The first tap on Clear build in ⋯ leaves its box.
    await options(dm).locator("[data-rvtt-more] button").first().tap();
    const clearBuild = dm.getByRole("dialog", { name: "More Map builder options" }).getByRole("button", { name: "Clear build" });
    const clearBuildAt = await clearBuild.boundingBox();
    await clearBuild.tap();
    const armed = dm.getByRole("dialog", { name: "More Map builder options" }).getByRole("button", { name: /Tap again to clear/ });
    assert.deepEqual(await armed.boundingBox(), clearBuildAt, "the armed Clear build keeps its box");
    await closePopover(dm);
    await pick(dm, "Map builder", "Builder mode", "Brush");

    // A popover's controls stay put while Area's reminders grow it.
    await selectTool(dm, "a");
    await tapCellAt(dm, { x: 20, y: 12 });
    await options(dm).locator("[data-rvtt-more] button").first().tap();
    const more = dm.getByRole("dialog", { name: "More Area options" });
    const enters = more.getByRole("button", { name: /Remind when a creature enters/ });
    const boxBefore = await more.boundingBox();
    const entersAt = await enters.boundingBox();
    await enters.tap();
    await dm.waitForTimeout(200);
    assert.deepEqual(await more.boundingBox(), boxBefore, "the popover's box stays as it was");
    assert.deepEqual(await enters.boundingBox(), entersAt, "the reminder stays under the finger");
    await closePopover(dm);
    await key(dm, "v");
  });

  test("4. popovers open and close as the base says", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await selectTool(dm, "d");
    const stroke = options(dm).getByRole("button", { name: /^Stroke:/ });
    // A tap opens, a second closes.
    await stroke.tap();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor();
    await stroke.tap();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    // A tap puts focus on the chip, and Enter puts it inside, on the chosen option.
    await stroke.tap();
    assert.equal(await stroke.evaluate((b) => b === b.ownerDocument.activeElement), true, "a tap focuses the chip");
    await dm.keyboard.press("Escape");
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    assert.equal(await stroke.evaluate((b) => b === b.ownerDocument.activeElement), true, "Escape returns focus to the chip");
    await dm.keyboard.press("Enter");
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor();
    assert.equal(await dm.evaluate(() => (globalThis as unknown as { document: PageDoc }).document.activeElement?.getAttribute("value")), "4", "Enter moves focus to the chosen width, Mid");
    await dm.keyboard.press("Escape");

    // Two fingers pan with the popover open, arriving 50 ms apart, and it stays open, also when one lifts first.
    await stroke.tap();
    const map = await dm.locator(".konvajs-content").boundingBox();
    assert.ok(map);
    const cx = map.x + map.width / 2;
    const cy = map.y + map.height / 3;
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) => dmCdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
    await touch("touchStart", [{ x: cx, y: cy, id: 1 }]);
    await dm.waitForTimeout(50);
    await touch("touchStart", [{ x: cx, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }]);
    await touch("touchMove", [{ x: cx + 20, y: cy + 10, id: 1 }, { x: cx + 80, y: cy + 10, id: 2 }]);
    await touch("touchEnd", [{ x: cx + 80, y: cy + 10, id: 2 }]);
    await touch("touchEnd", []);
    await dm.waitForTimeout(200);
    assert.ok(await dm.getByRole("dialog", { name: "Stroke" }).isVisible(), "a pinch leaves the popover open");

    // One finger on the map closes it as the finger lifts, and draws nothing.
    const drawings = Object.keys(dmSocket.state?.drawings ?? {}).length;
    await touch("touchStart", [{ x: cx, y: cy, id: 3 }]);
    await touch("touchMove", [{ x: cx + 40, y: cy + 40, id: 3 }]);
    assert.ok(await dm.getByRole("dialog", { name: "Stroke" }).isVisible(), "still open while the finger is down");
    await touch("touchEnd", []);
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    await dm.waitForTimeout(300);
    assert.equal(Object.keys(dmSocket.state?.drawings ?? {}).length, drawings, "the press drew nothing");

    // The wheel leaves it open, and a tool key closes it.
    await stroke.tap();
    await dm.mouse.move(cx, cy);
    await dm.mouse.wheel(0, 120);
    await dm.waitForTimeout(150);
    assert.ok(await dm.getByRole("dialog", { name: "Stroke" }).isVisible(), "the wheel leaves it open");
    await dm.keyboard.press("r");
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });

    // The arrows in the drawing tool popover change the tool without closing it.
    await selectTool(dm, "d");
    const chip = options(dm).getByRole("button", { name: /^Drawing tool:/ });
    await chip.focus();
    await dm.keyboard.press("Enter");
    const tiles = dm.getByRole("dialog", { name: "Drawing tool" });
    await tiles.waitFor();
    await dm.keyboard.press("ArrowRight");
    await dm.waitForTimeout(100);
    assert.ok(await tiles.isVisible(), "an arrow keeps it open");
    assert.equal(await chip.getAttribute("aria-label"), "Drawing tool: Line", "and changes the tool");
    await dm.keyboard.press("Enter");
    await tiles.waitFor({ state: "detached" });
    await pick(dm, "Draw", "Drawing tool", "Pen");

    // With Ping and the Tools menu, a tap on the map sends no ping: here Setup at 390, which stands where Tools does.
    await selectTool(dm, "p");
    const pings = playerSocket.received.length;
    await tools(dm).getByRole("button", { name: "Setup tools" }).tap();
    await dm.getByRole("menu", { name: "Setup tools" }).waitFor();
    await dm.touchscreen.tap(cx, cy);
    await dm.getByRole("menu", { name: "Setup tools" }).waitFor({ state: "detached" });
    await dm.waitForTimeout(400);
    assert.ok(!playerSocket.received.slice(pings).some((m) => JSON.stringify(m).includes('"k":"ping"')), "the press that closed the menu sent no ping");

    // Back closes it before the room.
    await selectTool(dm, "d");
    await stroke.tap();
    await dm.goBack();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    assert.ok(dm.url().includes(`/r/`), "Back stayed in the room");

    // A phone sheet opening closes it.
    await stroke.tap();
    await tools(dm).getByRole("button", { name: "Panels" }).tap();
    await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
    await closeShownSheet(dm);

    // Turning the phone places it again, or closes it where its anchor is gone (Setup in the pair).
    await tools(dm).getByRole("button", { name: "Setup tools" }).tap();
    await view(dm, dmCdp, SIZES[2]!);
    await dm.getByRole("menu", { name: "Setup tools" }).waitFor({ state: "detached" });
    await view(dm, dmCdp, SIZES[1]!);

    // Across consumers, one popover in the room (7.1): the side panel's More, where the panel tabs build has made it, closes a tool popover and the other way round, and a tap on the map with More open sends no ping.
    await view(dm, dmCdp, DESK);
    // More is the tab with a menu, named "More panels" or by the panel it holds that is open.
    const moreTab = dm.getByRole("tablist", { name: "Panels" }).locator('[role="tab"][aria-haspopup="menu"]');
    if ((await moreTab.count()) > 0) {
      await selectTool(dm, "d");
      await options(dm).getByRole("button", { name: /^Stroke:/ }).click();
      await dm.getByRole("dialog", { name: "Stroke" }).waitFor();
      await moreTab.click();
      const menu = dm.getByRole("menu", { name: "More panels" });
      await menu.waitFor();
      await dm.getByRole("dialog", { name: "Stroke" }).waitFor({ state: "detached" });
      await options(dm).getByRole("button", { name: /^Stroke:/ }).click();
      await menu.waitFor({ state: "detached" });
      await closePopover(dm);
      await selectTool(dm, "p");
      await moreTab.click();
      await menu.waitFor();
      const before = playerSocket.received.length;
      const desk = await dm.locator(".konvajs-content").boundingBox();
      assert.ok(desk);
      await dm.mouse.click(desk.x + desk.width / 2, desk.y + desk.height / 3);
      await menu.waitFor({ state: "detached" });
      await dm.waitForTimeout(400);
      assert.ok(!playerSocket.received.slice(before).some((m) => JSON.stringify(m).includes('"k":"ping"')), "the click that closed More sent no ping");
      await key(dm, "v");
    } else console.error("the side panel has no More in this build: its popover cases wait for the panel tabs build");

    // At 480 x 320 at 130% in a fight, the shape popover still shows its title and a row.
    await reloadAt(dm, 1.3);
    await view(dm, dmCdp, SIZES[4]!);
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.goblins[0]!, value: 12 }] });
    await selectTool(dm, "a");
    await options(dm).getByRole("button", { name: /^Shape:/ }).tap();
    const shape = dm.getByRole("dialog", { name: "Shape" });
    await shape.waitFor();
    const title = await shape.getByText("Shape", { exact: true }).first().boundingBox();
    const tile = await shape.getByRole("radio").first().boundingBox();
    const box = await shape.boundingBox();
    assert.ok(title && tile && box && title.y >= box.y && tile.y + tile.height <= box.y + box.height + 1, "the title and a row show");
    await shots.take(dm, "options-480x320-130-fight-shape");
    await closePopover(dm);
    await ops.send({ t: "encounter.end" });
    await reloadAt(dm, 1);
  });

  test("4b. dismissed spell results stay closed until the words change or the field is pressed", async () => {
    await reloadAt(dm, 1);
    await view(dm, dmCdp, SIZES[1]!);
    await selectTool(dm, "a");
    const field = options(dm).locator('[data-options-row] input[aria-label="Spell"]');
    const results = dm.getByRole("dialog", { name: "Spells" });
    const stayClosed = async (how: string) => {
      await results.waitFor({ state: "detached" });
      await dm.waitForTimeout(400);
      assert.equal(await results.count(), 0, `${how}: the results opened again by themselves`);
    };
    await field.tap();
    await field.fill("fire");
    await results.waitFor();
    // Escape in the field.
    await dm.keyboard.press("Escape");
    await stayClosed("Escape in the field");
    assert.equal(await field.evaluate((e) => e === e.ownerDocument.activeElement), true, "the field keeps focus");
    // New words ask for them again.
    await dm.keyboard.type("b");
    await results.waitFor();
    // Escape from a result puts focus back on the field and leaves them closed.
    await results.getByRole("button").first().focus();
    await dm.keyboard.press("Escape");
    await stayClosed("Escape from a result");
    assert.equal(await field.evaluate((e) => e === e.ownerDocument.activeElement), true, "focus is back on the field");
    // Down asks for them, and Back dismisses them too.
    await dm.keyboard.press("ArrowDown");
    await results.waitFor();
    await dm.goBack();
    await stayClosed("Back");
    // A press on the field asks for them.
    await field.tap();
    await results.waitFor();
    await field.fill("");
    await results.waitFor({ state: "detached" });
    await key(dm, "v");
  });

  test("4c. a scene change closes an open popover: a chip's and ⋯", async () => {
    const other = randomUUID();
    await ops.send({ t: "scene.create", scene: { id: other, name: "Elsewhere", bounds: { w: 10, h: 10 }, background: "#2b2b31", fogEnabled: false, autoWalls: "off" } });
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[1]!);
    await selectTool(player, "d");
    const moveTo = async (sceneId: string) => {
      await ops.send({ t: "room.setPlayerScene", sceneId });
      await waitFor("the player on the scene", () => (playerSocket.state?.meta.playerSceneId === sceneId ? true : null));
    };
    await options(player).getByRole("button", { name: /^Color:/ }).tap();
    const color = player.getByRole("dialog", { name: "Color" });
    await color.waitFor();
    await moveTo(other);
    await color.waitFor({ state: "detached" });
    await selectTool(player, "d");
    await options(player).locator("[data-rvtt-more] button").first().tap();
    const more = player.getByRole("dialog", { name: "More Draw options" });
    await more.waitFor();
    await moveTo(run.sceneId);
    await more.waitFor({ state: "detached" });
    await key(player, "v");
    await ops.send({ t: "scene.delete", sceneId: other });
  });

  test("5. the toolbar: Setup, the pair and keys", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await key(dm, "v");
    // Seven buttons and Panels, and no sideways scroll.
    const strip = tools(dm).locator("button");
    assert.equal(await strip.count(), 8);
    assert.ok(
      await dm.evaluate(() => {
        const s = (globalThis as unknown as { document: PageDoc }).document.querySelector('nav[aria-label="Tools"] div[style*="overflow"]')!;
        return s.scrollWidth <= s.clientWidth;
      }),
      "the tools do not scroll",
    );
    const setup = tools(dm).getByRole("button", { name: "Setup tools" });
    // A tap opens the menu with focus on Setup.
    await setup.tap();
    const menu = dm.getByRole("menu", { name: "Setup tools" });
    await menu.waitFor();
    assert.equal(await setup.evaluate((b) => b === b.ownerDocument.activeElement), true);
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    // Enter opens it with focus on the checked tile, else the first.
    await setup.focus();
    await dm.keyboard.press("Enter");
    await menu.waitFor();
    const focused = () => dm.evaluate(() => (globalThis as unknown as { document: PageDoc }).document.activeElement?.textContent ?? "");
    assert.equal(await focused(), "Add token");
    await dm.keyboard.press("ArrowDown");
    assert.equal(await focused(), "Pin");
    await dm.keyboard.press("ArrowRight");
    assert.equal(await focused(), "Map builder");
    await dm.keyboard.press("ArrowUp");
    assert.equal(await focused(), "Pin");
    await dm.keyboard.press("ArrowLeft");
    assert.equal(await focused(), "Add token");
    await dm.keyboard.press("End");
    assert.equal(await focused(), "Line up grid");
    await dm.keyboard.press("Home");
    assert.equal(await focused(), "Add token");
    await dm.keyboard.press("m");
    assert.equal(await focused(), "Map builder");
    // Shift+Tab closes it with focus on Setup, and Tab with focus on Panels.
    await dm.keyboard.press("Shift+Tab");
    await menu.waitFor({ state: "detached" });
    assert.equal(await setup.evaluate((b) => b === b.ownerDocument.activeElement), true);
    await dm.keyboard.press("Enter");
    await menu.waitFor();
    await dm.keyboard.press("Tab");
    await menu.waitFor({ state: "detached" });
    assert.equal(await tools(dm).getByRole("button", { name: "Panels" }).evaluate((b) => b === b.ownerDocument.activeElement), true);
    // Picking Map builder shows Builder on Setup.
    await setup.tap();
    await menu.getByRole("menuitemradio", { name: "Map builder" }).tap();
    await menu.waitFor({ state: "detached" });
    const named = tools(dm).getByRole("button", { name: "Setup tools: Map builder" });
    await named.waitFor();
    assert.match((await named.textContent()) ?? "", /Builder/);
    // T, M, B and G pick directly, outside the menu.
    for (const [letter, id] of [["t", "add-token"], ["m", "pin"], ["g", "grid"], ["b", "build"]] as const) {
      await key(dm, letter);
      await waitFor(`the ${letter} key`, async () => ((await dm.evaluate(() => (globalThis as unknown as { document: PageDoc }).document.querySelector('[role="toolbar"][data-rvtt-arrangement]')?.getAttribute("aria-label"))) ? true : null));
      assert.ok(id);
    }
    await key(dm, "v");

    // Setup over the token's bar (7.5): spanning at 390 x 844, docked at 820 x 1180. Escape closes Setup first and leaves the bar, and a press on the docked window's Conditions closes Setup and opens Conditions. The spanning bar's Conditions stands under the menu, and the window's may too where it docks at the foot, so the window first moves up by its grip and its Reset puts it back after.
    for (const size of [SIZES[1]!, { width: 820, height: 1180, insets: {} }]) {
      await view(dm, dmCdp, size);
      await selectTool(dm, "v");
      const goblin = dmSocket.state!.tokens[run.goblins[1]!]!;
      await tapCellAt(dm, { x: goblin.x, y: goblin.y });
      const bar = dm.getByRole("dialog", { name: "Goblin 2 actions" });
      await bar.waitFor();
      await setup.tap();
      await menu.waitFor();
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      assert.ok(await bar.isVisible(), `${size.width} x ${size.height}: Escape closed the bar with Setup`);
      if (size.width === 820) {
        await bar.getByRole("button", { name: "Move window", exact: true }).focus();
        await dm.keyboard.press("Shift+ArrowUp");
        await dm.keyboard.press("Shift+ArrowUp");
        await setup.tap();
        await menu.waitFor();
        await bar.getByRole("button", { name: "Conditions", exact: true }).click();
        await menu.waitFor({ state: "detached" });
        await bar.getByRole("button", { name: "Conditions", exact: true, pressed: true }).waitFor();
        await bar.getByRole("button", { name: "Reset window position and size", exact: true }).click();
      }
      await dm.keyboard.press("Escape");
      await bar.waitFor({ state: "detached" });
      await key(dm, "v");
    }

    // 844 x 390: the pair. Ruler, the last tool used, is the second button. A tap on it while active opens Tools, Fog takes its place, and R puts Ruler back.
    await key(dm, "r");
    await key(dm, "v");
    await view(dm, dmCdp, SIZES[2]!);
    assert.deepEqual(await tools(dm).locator("button[data-active]").evaluateAll((bs) => bs.map((b) => b.getAttribute("title"))), ["Select", "Ruler", "Panels"]);
    const ruler = tools(dm).getByRole("button", { name: "Ruler" });
    // Its caret shows before its tool is active, and once active its description says it is in use, in place of a pressed state.
    const described = (b: Locator) => b.evaluate((el) => {
      const doc = (globalThis as unknown as { document: { getElementById(id: string): { textContent: string | null } | null } }).document;
      return (el.getAttribute("aria-describedby") ?? "").split(" ").map((id: string) => doc.getElementById(id)?.textContent ?? "").join(" ");
    });
    // The mark stands in the button's corner, the button's own last child.
    assert.equal(await ruler.locator(":scope > span[aria-hidden] > svg").count(), 1, "the caret shows while Select is active");
    assert.equal(await described(ruler), "Tap it, then again for all tools.");
    await ruler.tap();
    assert.match(await described(ruler), /^In use\. Tap again for all tools\./);
    await ruler.tap();
    const all = dm.getByRole("menu", { name: "Tools" });
    await all.waitFor();
    await all.getByRole("menuitemradio", { name: "Fog" }).tap();
    await tools(dm).getByRole("button", { name: "Fog" }).waitFor();
    await key(dm, "r");
    await tools(dm).getByRole("button", { name: "Ruler" }).waitFor();
    await key(dm, "v");

    // The player at 844 x 390: five tools and the options in one row, and at 130% the pair.
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[2]!);
    await key(player, "r");
    assert.equal(await options(player).getAttribute("data-rvtt-arrangement"), "merged");
    assert.equal(await tools(player).locator("button[data-active]").count(), 6, "five tools and Panels");
    await reloadAt(player, 1.3);
    await view(player, playerCdp, SIZES[2]!);
    await key(player, "r");
    assert.equal(await options(player).getAttribute("data-rvtt-arrangement"), "pair");
    await reloadAt(player, 1);
  });

  test("6. tuck", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    // A DM with Map builder active picks its tile again: the options hide, the tool stays and still paints, and the tile shows them again.
    await selectTool(dm, "b");
    await pick(dm, "Map builder", "Builder mode", "Brush");
    const setup = () => tools(dm).getByRole("button", { name: /^Setup tools/ });
    await setup().tap();
    await dm.getByRole("menuitemradio", { name: "Map builder" }).tap();
    await options(dm).locator("[data-rvtt-tucked]").first().waitFor({ state: "attached" }).catch(() => undefined);
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "tucked");
    assert.match((await setup().getAttribute("aria-label")) ?? "", /Map builder/, "the tool stays");
    assert.ok(await setup().getAttribute("aria-describedby"), "Setup carries the tucked line");
    const built = () => JSON.stringify(dmSocket.state?.buildChunks ?? {});
    const unpainted = built();
    await dragCellsTouch(dm, { x: 12, y: 8 }, { x: 14, y: 8 });
    await waitFor("a stroke painted while tucked", () => (built() !== unpainted ? true : null));
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "still tucked after painting");
    await setup().tap();
    await dm.getByRole("menuitemradio", { name: "Map builder" }).tap();
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null, "shown again");
    // Enter on that tile does the same.
    await setup().focus();
    await dm.keyboard.press("Enter");
    await dm.keyboard.press("Enter");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "tucked by Enter");
    await setup().focus();
    await dm.keyboard.press("Enter");
    await dm.keyboard.press("Enter");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null);
    await key(dm, "v");

    // In the pair the same holds through Tools for the Ruler, and the tuck holds after turning the phone upright.
    await view(dm, dmCdp, SIZES[2]!);
    await key(dm, "r");
    await tools(dm).getByRole("button", { name: "Ruler" }).tap();
    await dm.getByRole("menu", { name: "Tools" }).getByRole("menuitemradio", { name: "Ruler" }).tap();
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "");
    await view(dm, dmCdp, SIZES[1]!);
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "the tuck holds upright");
    await tools(dm).getByRole("button", { name: "Ruler" }).tap();
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null, "the Ruler's own button shows them again");

    // A second tap on Draw tucks: still pressed, described, marked, the map gains 53 px stacked, and the pen still draws.
    await key(dm, "d");
    await pick(dm, "Draw", "Drawing tool", "Pen");
    const draw = tools(dm).getByRole("button", { name: "Draw" });
    const headerBottom = async () => (await dm.locator("header").boundingBox())!;
    const mapFoot = async () => (await options(dm).boundingBox())!.y;
    const footBefore = await mapFoot();
    await draw.tap();
    assert.equal(await draw.getAttribute("aria-pressed"), "true");
    const described = await draw.getAttribute("aria-describedby");
    assert.ok(described);
    assert.equal(await dm.locator(`[id="${described}"]`).textContent(), "Its options are hidden. Press again to show them.");
    const footAfter = await mapFoot();
    assert.ok(Math.abs(footAfter - footBefore - 53) <= 2, `the map gains 53 px (${footAfter - footBefore})`);
    void headerBottom;
    const drawings = () => Object.keys(dmSocket.state?.drawings ?? {}).length;
    const drawn = drawings();
    await dragCellsTouch(dm, { x: 18, y: 6 }, { x: 22, y: 8 });
    await waitFor("a stroke drawn while tucked", () => (drawings() > drawn ? true : null));
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), "", "still tucked after drawing");
    // D brings them back, and picking Ruler shows the Ruler's options.
    await key(dm, "d");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null);
    await draw.tap();
    await key(dm, "r");
    assert.equal(await options(dm).getAttribute("data-rvtt-tucked"), null, "a new tool shows its options");

    // Merged, the map's height does not change.
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[2]!);
    await key(player, "d");
    const toolbarTop = async () => (await tools(player).boundingBox())!.y;
    const before = await toolbarTop();
    await tools(player).getByRole("button", { name: "Draw" }).tap();
    assert.equal(await toolbarTop(), before);
    await tools(player).getByRole("button", { name: "Draw" }).tap();

    // With an area waiting for Place, a tuck leaves "Area options hidden. Tap to show.", whose tap brings Place back.
    await key(dm, "a");
    await tapCellAt(dm, { x: 20, y: 12 });
    await tools(dm).getByRole("button", { name: "Area" }).tap();
    const pill = dm.getByRole("button", { name: "Area options hidden. Tap to show." });
    assert.ok(await wholeInReach(pill), "the pill is in reach");
    await pill.tap();
    await options(dm).getByRole("button", { name: "Place", exact: true }).waitFor();
    await key(dm, "v");
  });

  test("7. the box: Fit, the summary row, the roll card and a lasting notice", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await key(dm, "d");
    await dm.getByRole("button", { name: "Fit the map to the screen" }).tap();
    await dm.waitForTimeout(400);
    // The fitted scene stands clear of the row and the line.
    const line = await options(dm).locator("[data-options-line]").boundingBox();
    assert.ok(line);
    const bounds = dmSocket.state!.scenes[run.sceneId]!.bounds;
    const foot = await pagePoint(dm, bounds, { x: 0, y: bounds.h });
    assert.ok(foot.y <= line.y + 1, `the scene's foot (${Math.round(foot.y)}) stands above the line (${Math.round(line.y)})`);

    // A very short sheet opening closes an open popover.
    await view(dm, dmCdp, SIZES[4]!);
    await reloadAt(dm, 1.3);
    await key(dm, "d");
    await options(dm).getByRole("button", { name: /^Drawing tool:/ }).tap();
    await dm.getByRole("dialog", { name: "Drawing tool" }).waitFor();
    await tools(dm).getByRole("button", { name: "Panels" }).tap();
    await dm.getByRole("dialog", { name: "Drawing tool" }).waitFor({ state: "detached" });
    await closeShownSheet(dm);
    await reloadAt(dm, 1);
    await key(dm, "v");
  });

  test("8. names and roles", async () => {
    await view(dm, dmCdp, SIZES[1]!);
    await key(dm, "d");
    await options(dm).getByRole("button", { name: "Drawing tool: Pen" }).waitFor();
    await options(dm).getByRole("button", { name: "Drawing tool: Pen" }).tap();
    const dialog = dm.getByRole("dialog", { name: "Drawing tool" });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-modal"), null, "a popover is not modal");
    await dialog.getByRole("radiogroup", { name: "Drawing tool" }).waitFor();
    // The line stays one polite live region while a popover covers it.
    const line = options(dm).locator("[data-options-line]");
    assert.equal(await line.getAttribute("aria-live"), "polite");
    assert.equal(await line.getAttribute("data-options-line"), "hidden");
    await closePopover(dm);

    // A focused control is not moved into ⋯ by a resize.
    await view(dm, dmCdp, DESK);
    const redo = options(dm).locator('[data-options-row] [data-rvtt-slot="redo"] button');
    await redo.focus();
    await view(dm, dmCdp, SIZES[0]!);
    assert.equal(await options(dm).locator('[data-options-row] [data-rvtt-slot="redo"]').count(), 1, "Redo held focus, so it stays in the row");

    // After Discard by keyboard, focus is on the next control in the row where Discard stands there (6.4). At 622 px it waits in ⋯ (13.2), and as a button that ends the task it closes ⋯, so focus goes back to ⋯ (7.2). It never falls to the page.
    await view(dm, dmCdp, DESK);
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true } });
    await selectTool(dm, "f");
    await options(dm).getByRole("button", { name: "Turn fog on" }).waitFor({ state: "detached" });
    await dragCellsTouch(dm, { x: 1, y: 1 }, { x: 3, y: 3 });
    await waitFor("the fog draft", () => (dmSocket.state?.fogDrafts[run.sceneId]?.ops.length ?? 0) > 0 || null);
    await options(dm).locator('[data-rvtt-slot="discard"], [data-rvtt-more]').first().waitFor();
    const inline = options(dm).locator('[data-options-row] [data-rvtt-slot="discard"] button');
    const inMore = (await inline.count()) === 0;
    if (inMore) {
      await options(dm).locator("[data-rvtt-more] button").first().focus();
      await dm.keyboard.press("Enter");
      await dm.getByRole("dialog", { name: "More Fog options" }).waitFor();
      await dm.locator('[role="dialog"] [data-rvtt-slot="discard"] button').first().focus();
    } else await inline.focus();
    await dm.keyboard.press("Enter");
    await dm.locator('[data-rvtt-slot="discard"]').first().waitFor({ state: "detached" });
    const focused = await dm.evaluate(() => {
      const active = (globalThis as unknown as { document: PageDoc }).document.activeElement;
      return {
        slot: active?.closest("[data-rvtt-slot]")?.getAttribute("data-rvtt-slot") ?? null,
        more: active?.closest("[data-rvtt-more]") !== null && active?.closest("[data-rvtt-more]") !== undefined,
        body: active?.tagName === "BODY",
        what: `${active?.tagName} ${active?.getAttribute("aria-label") ?? ""} ${active?.textContent?.slice(0, 40) ?? ""}`,
      };
    });
    assert.ok(!focused.body && (focused.more || (focused.slot !== null && focused.slot !== "discard")), `focus went to the next control${inMore ? " in ⋯" : " in the row"} (${focused.what})`);
    await closePopover(dm);
    await key(dm, "v");
  });

  test("8b. focus in a popover stays there when its control goes, and the row keeps focus in its own room", async () => {
    /** The focused element: its name, and whether it stands inside `within`. */
    const focusIn = (page: Page, within: string) =>
      page.evaluate((sel) => {
        const active = (globalThis as unknown as { document: PageDoc }).document.activeElement;
        return { name: active?.getAttribute("aria-label") ?? active?.textContent ?? "", inside: active?.closest(sel) !== null && active?.closest(sel) !== undefined, body: active?.tagName === "BODY" };
      }, within);

    // A key open puts focus on the first kept ruler's Remove: removing it hands focus to the next one, inside, and so does one reached by Tab.
    await reloadAt(player, 1);
    await view(player, playerCdp, SIZES[1]!);
    await selectTool(player, "r");
    const chip = options(player).getByRole("button", { name: /^Kept rulers/ });
    await chip.focus();
    await player.keyboard.press("Enter");
    const kept = player.getByRole("dialog", { name: "Kept rulers" });
    await kept.waitFor();
    const removes = kept.getByRole("button", { name: /^Remove the kept ruler/ });
    const count = await removes.count();
    assert.ok(count >= 3, `${count} kept rulers to remove`);
    assert.match((await focusIn(player, "[data-rvtt-popover]")).name, /^Remove the kept ruler/, "the key open put focus on the first ruler");
    await player.keyboard.press("Enter");
    await waitFor("one ruler fewer", async () => ((await removes.count()) === count - 1 ? true : null));
    let at = await focusIn(player, "[data-rvtt-popover]");
    assert.ok(at.inside && /^Remove the kept ruler/.test(at.name), `focus went to the next ruler in the popover, not behind it (${at.name})`);
    await player.keyboard.press("Tab");
    await player.keyboard.press("Enter");
    await waitFor("two rulers fewer", async () => ((await removes.count()) === count - 2 ? true : null));
    at = await focusIn(player, "[data-rvtt-popover]");
    assert.ok(at.inside && !at.body, `focus stayed in the popover after a ruler reached by Tab went (${at.name})`);
    await closePopover(player);
    await key(player, "v");

    // In "Viewing as Pat", over the DM's room with Draw active, ending a text drawing moves focus to the preview's own next control.
    await view(dm, dmCdp, DESK);
    await selectTool(dm, "d");
    await openSideTab(dm, "DM");
    await dm.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    await pickTool(dm, "Draw", preview);
    const previewOptions = preview.getByRole("toolbar", { name: "Draw options" });
    await previewOptions.getByRole("button", { name: /^Drawing tool:/ }).click();
    await dm.getByRole("dialog", { name: "Drawing tool" }).getByRole("radio", { name: "Text", exact: true }).click();
    const map = await preview.locator(".konvajs-content").first().boundingBox();
    assert.ok(map);
    await dm.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
    const text = previewOptions.getByRole("textbox", { name: "Text" });
    await text.waitFor();
    await previewOptions.getByRole("button", { name: "Cancel", exact: true }).focus();
    await dm.keyboard.press("Enter");
    await text.waitFor({ state: "detached" });
    at = await focusIn(dm, 'dialog[aria-label="Viewing as Pat"]');
    assert.ok(at.inside && !at.body, `focus went to the preview's next control, not the room behind it (${at.name})`);
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await key(dm, "v");
  });

  test("9. nothing went wrong in the browsers", () => {
    for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label}: console errors`);
  });
});
