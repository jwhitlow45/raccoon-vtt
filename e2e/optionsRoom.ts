import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { barControl, ConsoleWatch, openSideTab, OpSocket, pagePoint, pickOption, pickTool, Shots, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";

/**
 * The room, the browsers and the reach sweep of tool options in one row
 * (docs/design-v1-tool-options.md section 14), shared by options.e2e.ts
 * and the sweep files options-*.e2e.ts. Each file starts its own server
 * and browsers and builds its own room, so each sweep stands alone and the
 * CI shards (scripts/e2e-shard.ts) can run them side by side. One file
 * held them all before, at about 16 minutes on a laptop.
 *
 * The server, the browsers and the op socket are live bindings: a file
 * reads them once its `before` has run openBrowsers and createRoom.
 */

export const PORT = Number(process.env.E2E_PORT ?? 3100) + 15;
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
export const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

export const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-options-"));
export const assetDir = path.join(work, "assets");
export const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

export type Insets = { top?: number; side?: number; bottom?: number };
export type Size = { width: number; height: number; insets: Insets; expect?: Partial<Record<Role, string>> };
export type Role = "dm" | "player";

/** The sizes of 4.3, with the notch and home bar each holds that way up. */
export const SIZES: Size[] = [
  { width: 320, height: 568, insets: {} },
  { width: 390, height: 844, insets: { top: 47, bottom: 34 } },
  { width: 844, height: 390, insets: { side: 47, bottom: 21 } },
  { width: 667, height: 375, insets: {} },
  { width: 480, height: 320, insets: { side: 47, bottom: 21 } },
  { width: 932, height: 430, insets: { side: 59, bottom: 21 } },
  { width: 1280, height: 800, insets: {} },
];
export const SCALES = [1, 1.3] as const;

/**
 * Rooms near the floors, `MERGE_MIN` and `MERGE_MIN_DM` (4.1), on phones
 * the main sweep does not hold, each with the arrangement it gives:
 * every priority-1 control must still stand inline (9.4, 13.1).
 */
export const FLOOR_ROWS: { role: Role; scale: number; size: Size }[] = [
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
export const UNDER_FLOOR = ["320x568@1.3", "480x320@1.3"];
/** While fixing a miss: `OPTIONS_ONLY=dm` or `player`, `OPTIONS_SIZES=844x390`, `OPTIONS_SCALES=1.3`, `OPTIONS_STATES=Fog` (a name's start), and `OPTIONS_SHOTS=1`. */
export const ONLY = process.env.OPTIONS_ONLY ?? "";
export const ONLY_SIZES = process.env.OPTIONS_SIZES?.split(",") ?? null;
export const ONLY_SCALES = process.env.OPTIONS_SCALES?.split(",").map(Number) ?? null;
export const ONLY_STATES = process.env.OPTIONS_STATES?.split(",") ?? null;
export const MISS_SHOTS = process.env.OPTIONS_SHOTS === "1";
export const sizes = () => (ONLY_SIZES ? SIZES.filter((s) => ONLY_SIZES.includes(`${s.width}x${s.height}`)) : SIZES);
export const scales = () => SCALES.filter((s) => !ONLY_SCALES || ONLY_SCALES.includes(s));

/** Where the row stands (4.3, 13.1). At 932 x 430 the side panel, shown, takes the map's width, and both roles take the pair. */
export function expectedArrangement(role: Role, size: Size, scale: number, sidePanel: boolean): string {
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
export const MAP_HEIGHT: Record<string, number> = {
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
export type PageBox = { top: number; bottom: number; left: number; right: number; height: number; width: number };
export type PageNode = {
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
export type PageDoc = { querySelector(s: string): PageNode | null; activeElement: PageNode | null; dispatchEvent(e: unknown): boolean };

export let server: Server;
export let browser: Browser;
export let dmContext: BrowserContext;
export let dm: Page;
export let dmCdp: CDPSession;
export let playerContext: BrowserContext;
export let player: Page;
export let playerCdp: CDPSession;
export let ops: OpSocket;
export const dmSocket = new SocketWatch("dm");
export const playerSocket = new SocketWatch("player");
export const consoles: ConsoleWatch[] = [];

export const run = {
  roomId: "",
  roomName: `E2E options ${new Date().toISOString().slice(0, 19)}`,
  sceneId: "",
  patId: "",
  thorn: { id: randomUUID(), characterId: randomUUID() },
  /** Thorn's companion and a scene to send Thorn to, for the From control's chip and its disabled form (docs/design-v1-area-from-character.md 6). */
  pip: randomUUID(),
  away: randomUUID(),
  goblins: [randomUUID(), randomUUID(), randomUUID()],
  kept: Array.from({ length: 10 }, () => randomUUID()),
  stamp: randomUUID(),
  page: randomUUID(),
  map: { assetId: "", widthPx: 0, heightPx: 0 },
};

export function actor(hp: number) {
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

export const misses: string[] = [];
let shotPage: Page | null = null;
export async function miss(text: string): Promise<void> {
  misses.push(text);
  if (MISS_SHOTS) console.error(`MISS ${misses.length}: ${text}`);
  if (MISS_SHOTS && shotPage) await shots.take(shotPage, `options-miss-${misses.length}`);
}

export async function view(page: Page, cdp: CDPSession, size: Size): Promise<void> {
  const i = size.insets;
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: i.top ?? 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(300);
}

/**
 * view() for the sweep: the same resize, then a wait until the room's
 * layout holds still (the bars, the side panel and the options row in the
 * same boxes three frames running) instead of a fixed 300 ms. The row
 * measures itself through ResizeObservers (pages/Room.tsx), so it settles
 * within a few frames, and the sweeps resize well over a thousand times.
 * It gives up waiting after a second, as a slow machine's frames come late.
 */
export async function settledView(page: Page, cdp: CDPSession, size: Size): Promise<void> {
  const i = size.insets;
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: i.top ?? 0, bottom: i.bottom ?? 0, left: i.side ?? 0, right: i.side ?? 0 } });
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const g = globalThis as unknown as {
          document: { querySelectorAll(s: string): ArrayLike<PageNode> };
          innerWidth: number;
          innerHeight: number;
          requestAnimationFrame(f: () => void): number;
          performance: { now(): number };
        };
        const parts = 'header, nav[aria-label="Tools"], aside, [role="toolbar"][data-rvtt-arrangement], [data-options-row] > [data-rvtt-slot], [data-rvtt-more], [data-options-line]';
        const layout = () =>
          `${g.innerWidth}x${g.innerHeight} ` +
          Array.from(g.document.querySelectorAll(parts))
            .map((e) => {
              const b = e.getBoundingClientRect();
              return `${e.tagName}${e.getAttribute("data-rvtt-arrangement") ?? ""}:${b.left},${b.top},${b.width},${b.height}`;
            })
            .join(" ");
        const deadline = g.performance.now() + 1000;
        let last = "";
        let still = 0;
        const frame = () => {
          const now = layout();
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 3 || g.performance.now() > deadline) resolve();
          else g.requestAnimationFrame(frame);
        };
        g.requestAnimationFrame(frame);
      }),
  );
}

export const DESK: Size = { width: 1280, height: 800, insets: {} };

export async function reloadAt(page: Page, scale: number): Promise<void> {
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

export function sizeLabel(size: Size, scale: number): string {
  return `${size.width} x ${size.height} at ${Math.round(scale * 100)}%`;
}

export function tools(page: Page): Locator {
  return page.locator('nav[aria-label="Tools"]');
}

export function options(page: Page): Locator {
  return page.locator('[role="toolbar"][data-rvtt-arrangement]');
}

/** Takes focus off any field, so a tool's key reaches the room. */
export async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
}

export async function key(page: Page, letter: string): Promise<void> {
  await blur(page);
  await page.keyboard.press(letter);
  await page.waitForTimeout(150);
}

export async function tapCellAt(page: Page, cell: { x: number; y: number }): Promise<void> {
  const p = await pagePoint(page, { w: 0, h: 0 }, { x: cell.x + 0.5, y: cell.y + 0.5 });
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(150);
}

export async function dragCellsTouch(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await pagePoint(page, { w: 0, h: 0 }, { x: from.x + 0.5, y: from.y + 0.5 });
  const b = await pagePoint(page, { w: 0, h: 0 }, { x: to.x + 0.5, y: to.y + 0.5 });
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/** Picks a tile in a chip's popover, wherever the chip stands (harness pickOption). */
export async function pick(page: Page, tool: string, group: string, option: string): Promise<void> {
  await pickOption(page, tool, group, option);
  await page.waitForTimeout(150);
}

/** Closes whatever popover is open, by Escape with focus off any field. */
export async function closePopover(page: Page): Promise<void> {
  const open = page.locator('[aria-expanded="true"][aria-haspopup]');
  if ((await open.count()) === 0) return;
  await blur(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}

// ------------------------------------------------ the states of section 9

/** A tool state to sweep: how to enter it, at `enterAt` where the desk's side panel would get in the way, and how to leave it. */
export type State = { name: string; roles: readonly Role[]; tool: string; enter(page: Page): Promise<void>; leave?(page: Page): Promise<void>; noRow?: true; enterAt?: Size };

export const BOTH: readonly Role[] = ["dm", "player"];
export const DM_ONLY: readonly Role[] = ["dm"];
export const PLAYER_ONLY: readonly Role[] = ["player"];

export async function selectTool(page: Page, letter: string): Promise<void> {
  await closePopover(page);
  await key(page, "v");
  await key(page, letter);
}

export const STATES: State[] = [
  { name: "Ruler, ten kept rulers", roles: BOTH, tool: "Ruler", enter: (p) => selectTool(p, "r") },
  { name: "Area idle", roles: BOTH, tool: "Area", enter: (p) => selectTool(p, "a") },
  {
    // The From control as a chip: Thorn and his companion Pip.
    name: "Area idle, two creatures",
    roles: PLAYER_ONLY,
    tool: "Area",
    async enter(p) {
      await ops.send({
        t: "token.create",
        token: { id: run.pip, sceneId: run.sceneId, kind: "npc", name: "Pip", size: "tiny", x: 6, y: 8, visibility: "all", disposition: "ally", companion: { of: run.thorn.characterId, turn: "shared" }, actor: { inline: actor(4) } },
      });
      await selectTool(p, "a");
      await options(p).locator('[data-rvtt-slot="from"] button[aria-haspopup="dialog"]').first().waitFor({ state: "attached" });
    },
    async leave() {
      await ops.send({ t: "token.delete", tokenId: run.pip });
    },
  },
  {
    // The From control disabled, with its reason: Thorn on another scene.
    name: "Area idle, no creature",
    roles: PLAYER_ONLY,
    tool: "Area",
    async enter(p) {
      if (!dmSocket.state?.scenes[run.away]) await ops.send({ t: "scene.create", scene: { id: run.away, name: "Away", bounds: { w: 10, h: 10 } } });
      await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { sceneId: run.away } });
      await selectTool(p, "a");
      await options(p).locator('[data-rvtt-slot="from"] button[aria-disabled="true"]').first().waitFor({ state: "attached" });
    },
    async leave() {
      await ops.send({ t: "token.update", tokenId: run.thorn.id, patch: { sceneId: run.sceneId } });
      await waitFor("Thorn back", () => (playerSocket.state?.tokens[run.thorn.id] ? true : null));
    },
  },
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
    // The DM's From toggle, once a tap casts from a goblin.
    name: "Area placing, from a goblin",
    roles: DM_ONLY,
    tool: "Area",
    async enter(p) {
      await selectTool(p, "a");
      const goblin = dmSocket.state!.tokens[run.goblins[0]!]!;
      await tapCellAt(p, { x: goblin.x, y: goblin.y });
      await options(p).locator('[data-rvtt-slot="from"] button[aria-pressed="true"]').first().waitFor({ state: "attached" });
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
      // Thorn's page, from his row unless it is open (docs/design-v1-look-pass.md 3.1).
      const place = p.getByRole("tabpanel").getByRole("button", { name: "Place a token" });
      if (!(await place.isVisible())) await p.getByRole("tabpanel").getByRole("button", { name: /^Thorn/ }).first().click();
      await place.click();
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
      // Whichever token the tap took: the sweep's own states add tokens, which may stand on that cell by now. On a phone held upright the strip has no room for Multi-select after an HP entry, so it may be behind Expand.
      const bar = p.getByRole("dialog", { name: / actions$/ }).first();
      await (await barControl(bar, "Multi-select")).click();
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
export async function closeSheet(page: Page, cdp: CDPSession): Promise<void> {
  await settledView(page, cdp, SIZES[1]!);
  await closeShownSheet(page);
  await settledView(page, cdp, DESK);
}

/** Closes the sheet on a phone's screen, if one shows. A sheet's close is named for its title ("Close Initiative"), the panel list's is plain "Close". */
export async function closeShownSheet(page: Page): Promise<void> {
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
export async function pressSlot(page: Page, id: string): Promise<void> {
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

export async function setMap(): Promise<void> {
  await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: run.map.assetId, widthPx: run.map.widthPx, heightPx: run.map.heightPx, cellPx: 50, originPx: { x: 0, y: 0 } } });
}

// ------------------------------------------------ one state at one size

export type Seen = { ids: Set<string>; where: Map<string, string> };

/**
 * Every check of the sweep (14, case 2) for the state as it stands now: its
 * arrangement, its one line of controls, every slot in reach inline or one
 * tap away, the priority-1 rule, the line and the map's height.
 */
export async function checkState(page: Page, role: Role, size: Size, scale: number, state: State, label: string): Promise<Seen | null> {
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
export async function controlsInReach(frame: Locator): Promise<boolean> {
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

export async function sweep(page: Page, cdp: CDPSession, role: Role, scale: number, at: readonly Size[] = sizes()): Promise<number> {
  let steps = 0;
  for (const state of STATES.filter((s) => s.roles.includes(role) && (!ONLY_STATES || ONLY_STATES.some((o) => s.name.startsWith(o))))) {
    await settledView(page, cdp, state.enterAt ?? DESK);
    try {
      await state.enter(page);
    } catch (err) {
      await miss(`${role} at ${scale}: entering "${state.name}" failed: ${(err as Error).message.split("\n")[0]}`);
      await key(page, "v").catch(() => undefined);
      continue;
    }
    let reference: Seen | null = null;
    for (const size of at) {
      await settledView(page, cdp, size);
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
    await settledView(page, cdp, DESK);
    await state.leave?.(page).catch(async (err) => miss(`${role} at ${scale}: leaving "${state.name}" failed: ${(err as Error).message.split("\n")[0]}`));
    await closeSheet(page, cdp);
  }
  return steps;
}

/** The server, the DM's browser and the player's, each a touch screen at a computer's size. */
export async function openBrowsers(): Promise<void> {
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
}

/** Deletes the room, then stops the browsers and the server. */
export async function closeAll(): Promise<void> {
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
}

/** Case 1: a DM's room with Pat's Thorn, goblins, ten of Pat's kept rulers, a map image, a stamp and a journal page, and Pat in it. */
export async function createRoom(): Promise<void> {
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
}

/** Case 2's sweep of one role at one interface size: every tool state at every size. Each miss is kept for 2b. */
export function sweepTest(role: Role, scale: (typeof SCALES)[number]): void {
  if (!scales().includes(scale)) return;
  const who = role === "dm" ? "the DM" : "the player";
  test(`2. the reach sweep, ${who} at ${Math.round(scale * 100)}%: every tool state at every size`, { skip: ONLY !== "" && ONLY !== role }, async () => {
    const page = role === "dm" ? dm : player;
    await reloadAt(page, scale);
    shotPage = page;
    const before = misses.length;
    const steps = await sweep(page, role === "dm" ? dmCdp : playerCdp, role, scale);
    console.error(`${role === "dm" ? "DM" : "player"} at ${scale}: ${steps} checks, ${misses.length - before} misses`);
  });
}

/**
 * Case 2's sweep at the floor for one role's rooms of FLOOR_ROWS, or for
 * some of them: `rows` names them by size, as "800x360@1".
 */
export function floorTest(role: Role, rows?: readonly string[]): void {
  const mine = FLOOR_ROWS.filter((r) => r.role === role && (!rows || rows.includes(`${r.size.width}x${r.size.height}@${r.scale}`)));
  const which = mine.map((r) => `${r.size.width} x ${r.size.height} at ${Math.round(r.scale * 100)}%`).join(", ");
  test(`2. the sweep at the floor: rooms just over it hold every priority-1 control, ${role === "dm" ? "the DM's" : "the player's"} at ${which}`, { skip: ONLY_SIZES !== null || (ONLY !== "" && ONLY !== role) }, async () => {
    const page = role === "dm" ? dm : player;
    for (const row of mine) {
      await reloadAt(page, row.scale);
      shotPage = page;
      const before = misses.length;
      const steps = await sweep(page, role === "dm" ? dmCdp : playerCdp, row.role, row.scale, [row.size]);
      console.error(`${row.role} at ${row.scale}, ${row.size.width} x ${row.size.height}: ${steps} checks, ${misses.length - before} misses`);
    }
    await reloadAt(page, 1);
  });
}

/** Case 9: no console errors in either browser. */
export function assertNoConsoleErrors(): void {
  for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label}: console errors`);
}

/**
 * A sweep file: its own server, browsers and room around the sweeps
 * `register` adds, then 2b over its misses and 9 over its browsers.
 */
export function sweepFile(title: string, register: () => void): void {
  describe(`raccoon-vtt tool options in one row: ${title}`, { timeout: 3_600_000 }, () => {
    before(async () => {
      await openBrowsers();
      await createRoom();
    });
    after(closeAll);
    register();
    test("2b. nothing in the sweep is out of reach", () => {
      assert.deepEqual(misses, []);
    });
    test("9. nothing went wrong in the browsers", assertNoConsoleErrors);
  });
}
