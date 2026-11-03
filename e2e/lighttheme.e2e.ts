import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import sharp from "sharp";
import { accentFor } from "../client/lib/accent.ts";
import { PALETTES } from "../client/lib/theme.ts";
import { lightOnly, normal, parseColor, partColors, ratio, sweepContrast, sweepRing, type Sweep } from "./helpers/contrast.ts";
import { ConsoleWatch, OpSocket, openSideTab, pagePoint, pickOption, pickTool, Shots, sideTabName, sleep, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * The light theme (docs/design/design-v1-light-theme.md 13, lane LT-D): the
 * canvas never reads a CSS variable (lt-0), the Theme row and every open
 * page following it (lt-1), the board drawn the same in both (lt-2), the
 * contrast sweep over every surface, the board and its rings included
 * (lt-3), the screens that keep the dark look (lt-4), the table display's
 * hold (lt-5), the home-screen app's status band (lt-6), and the Height
 * tool's area outline in the accent (lt-7).
 *
 * A DM on a computer at 1440 x 900 and on a phone at 390 x 844, sharing a
 * session, and Pat on a phone. Every page carries the canvas net (lt-0):
 * it records any canvas color set to a string holding `var(`, which a
 * canvas would ignore, and every step ends with that list empty.
 *
 * It runs with `pnpm test:e2e` on its own port, E2E_PORT plus 47. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 47;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-lighttheme-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const COMPUTER = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 24, h: 16 };
const PAT_COLOR = "#30a46c";
/** The DM's color: the crest, so the light accent is the dark olive gold. */
const DM_COLOR = "#f7df00";

/**
 * The canvas net (lt-0): every color setter of the 2D context records a
 * value holding `var(`, which the canvas would drop, keeping the last
 * color. It covers what a step draws, and client/canvas/boardColors.test.ts
 * the files no step reaches.
 */
const CANVAS_NET = `(() => {
  const seen = [];
  globalThis.__rvttCanvasVars = seen;
  const protos = [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D].filter(Boolean).map((c) => c.prototype);
  for (const proto of protos) {
    for (const prop of ["fillStyle", "strokeStyle", "shadowColor"]) {
      const own = Object.getOwnPropertyDescriptor(proto, prop);
      if (!own || !own.set) continue;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: own.enumerable,
        get: own.get,
        set(value) {
          if (typeof value === "string" && value.includes("var(")) seen.push(prop + " = " + value);
          own.set.call(this, value);
        },
      });
    }
  }
})();`;

/** Set before the app's first script: it installs the hook that picks and turns the view without the menu (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

/** WebGL drawn in software, so the dice throw on a machine with no GPU, as dice.e2e.ts launches. */
const WEBGL_ARGS = ["--enable-unsafe-swiftshader", "--use-angle=swiftshader-webgl"];

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let phoneContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let dmPhone: Page;
let pat: Page;
let ops: OpSocket;
let patOps: OpSocket;
let heldPreview: WebSocketRoute | null = null;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), dmPhone: new ConsoleWatch("dm phone"), pat: new ConsoleWatch("pat") };

const run = {
  roomId: "",
  roomName: `E2E light theme ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  patId: "",
  thornChar: randomUUID(),
  thorn: randomUUID(),
  goblin: randomUUID(),
  ally: randomUUID(),
  neutral: randomUUID(),
  monster: randomUUID(),
  monsterBlock: randomUUID(),
  trap: randomUUID(),
  area: randomUUID(),
  whiteMap: "",
};

function actor(over: Record<string, unknown> = {}) {
  return { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...over };
}

const BLOCK = {
  size: "medium", type: "Humanoid", alignment: "Neutral", ac: 12, initiative: 0,
  hp: { average: 30, formula: "4d8 + 12" }, speed: "30 ft.",
  abilities: { str: { score: 10, save: 2 }, dex: { score: 14, save: 2 }, con: { score: 10, save: 2 }, int: { score: 10, save: 0 }, wis: { score: 10, save: 0 }, cha: { score: 10, save: 0 } },
  skills: "Perception +2", vulnerabilities: "", resistances: "", immunities: "", gear: "", senses: "", passivePerception: 12, languages: "Common", cr: "1", xp: 200,
  traits: [{ name: "Keen Sight", text: "The guard has advantage on sight checks." }], actions: [], bonusActions: [], reactions: [], legendaryActions: [],
};

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

/** The scheme the page draws (lib/scheme.ts sets it on the root). */
function schemeOf(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as { document: { documentElement: { getAttribute(n: string): string | null } } }).document.documentElement.getAttribute("data-rvtt-scheme"));
}

/** The page's own ground, as computed. */
function groundOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { document: { body: unknown }; getComputedStyle(el: unknown): { backgroundColor: string } };
    return g.getComputedStyle(g.document.body).backgroundColor;
  });
}

async function untilScheme(page: Page, scheme: "dark" | "light", what: string): Promise<void> {
  await waitFor(`${what} turns ${scheme}`, async () => ((await schemeOf(page)) === scheme ? true : null), 5_000);
}

/** Stores a Theme choice as This device does, for a page loaded after it. */
async function storeTheme(page: Page, choice: "dark" | "light" | "auto"): Promise<void> {
  await page.evaluate((c) => localStorage.setItem("rvtt.theme", c), choice);
}

async function openPanel(page: Page, title: string): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  if (await tabs.isVisible()) {
    await openSideTab(page, title);
    return page.getByRole("tabpanel", { name: sideTabName(title) });
  }
  const sheet = page.locator(`dialog[data-rvtt-sheet][aria-label="${title}"]`);
  if (await sheet.isVisible()) return sheet;
  await closeSheets(page);
  await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: new RegExp(`^${title}`) }).click();
  await sheet.waitFor();
  return sheet;
}

async function closeSheets(page: Page): Promise<void> {
  for (let i = 0; i < 4 && (await page.locator("dialog[data-rvtt-sheet][open]").count()) > 0; i++) {
    await page.keyboard.press("Escape");
    await sleep(150);
  }
}

/** Menu, This device, as the Menu stands now. */
async function openThisDevice(page: Page): Promise<Locator> {
  const menu = await openPanel(page, "Menu");
  if (await menu.getByRole("radiogroup", { name: "Theme" }).isVisible()) return menu;
  const back = page.getByRole("button", { name: /^Back to Menu/ });
  if (await back.isVisible()) await back.click();
  await menu.getByRole("button", { name: /^This device/ }).click();
  await menu.getByRole("radiogroup", { name: "Theme" }).waitFor();
  return menu;
}

async function chooseTheme(page: Page, choice: "Dark" | "Light" | "Auto"): Promise<void> {
  const menu = await openThisDevice(page);
  const group = menu.getByRole("radiogroup", { name: "Theme" });
  await group.scrollIntoViewIfNeeded();
  await group.getByRole("radio", { name: choice, exact: true }).check();
}

/** What the canvas net caught on a page since the last read. */
async function canvasVars(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seen = (globalThis as unknown as { __rvttCanvasVars?: string[] }).__rvttCanvasVars ?? [];
    return seen.splice(0, seen.length);
  });
}

/** Opens the room on a page at a size, from a new navigation. */
async function openRoom(page: Page, size: { width: number; height: number }, store: Record<string, string> = {}): Promise<void> {
  await page.setViewportSize(size);
  if (!page.url().startsWith(server.origin)) await page.goto(`${server.origin}/`);
  await page.evaluate((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, store);
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Selects a token by a tap on its cell, and gives back its window. */
async function tokenWindow(page: Page, name: string, cell: { x: number; y: number }): Promise<Locator> {
  await page.getByRole("button", { name: "Fit the map to the screen", exact: true }).click();
  await sleep(300);
  await tapCell(page, BOUNDS, cell);
  const bar = page.getByRole("dialog", { name: `${name} actions` });
  await bar.waitFor();
  return bar;
}

/** A plain white PNG, the brightest map art there is. */
async function whitePng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
}

/** The pixels of a part of the page, as RGB. */
async function pixels(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<{ data: Buffer; width: number; height: number; at(x: number, y: number): [number, number, number] }> {
  const png = await page.screenshot({ clip });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    at: (x, y) => {
      const i = (Math.round(y) * info.width + Math.round(x)) * 3;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    },
  };
}

/** Collects one sweep's numbers into the step's lists. */
function keep(sweep: Sweep, into: { failures: string[]; counts: Map<string, number> }, part: string): void {
  into.failures.push(...sweep.failures);
  into.counts.set(part, (into.counts.get(part) ?? 0) + sweep.measured.length);
}

describe("the light theme", { concurrency: false }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1", args: WEBGL_ARGS });
    dmContext = await browser.newContext({ viewport: COMPUTER, deviceScaleFactor: 1 });
    patContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const c of [dmContext, patContext]) {
      await c.addInitScript(CANVAS_NET);
      await c.addInitScript(HOOK_FLAG);
    }
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    consoles.dm.attach(dm);
    consoles.pat.attach(pat);
    await dmSocket.attach(dmContext, dm);
    await patSocket.attach(patContext, pat);
    // The DM's preview sockets (`as=`) are held unanswered, for lt-4's waiting and failed screens. Set before the room loads.
    await dm.routeWebSocket(/[?&]as=(?!display)/, (ws) => {
      heldPreview = ws;
    });
  });

  afterEach(async () => {
    for (const page of [dm, dmPhone, pat]) {
      if (!page || page.isClosed()) continue;
      assert.deepEqual(await canvasVars(page), [], "a canvas was given a CSS variable as a color");
    }
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    patOps?.close();
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

  test("lt-0. a room on a light device, and the canvas net through Top-down and Isometric, a ruler, an area, a trap's Aim, the Height brush's area, a ping, the fog brush, the builder and the dice tray", async () => {
    await dm.goto(`${server.origin}/`);
    await storeTheme(dm, "light");
    await dm.reload();
    await untilScheme(dm, "light", "Home");
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
    const dmId = dmSocket.you!.memberId;
    await ops.send({ t: "member.update", memberId: dmId, color: DM_COLOR });

    // Tokens of every disposition, a monster with a stat block, Thorn in a fight, an area and a trap that hits an area.
    run.patId = await join(patContext, "Pat", PAT_COLOR);
    patOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: (await patContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ") });
    const tok = (id: string, extra: Record<string, unknown>) => ({ t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", ...extra } });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: true } });
    await ops.send({ t: "character.create", character: { id: run.thornChar, name: "Thorn", size: "medium", ownerIds: [run.patId], actor: actor() } });
    await ops.send(tok(run.thorn, { kind: "pc", name: "Thorn", x: 5, y: 5, disposition: "ally", actor: { ref: run.thornChar } }));
    await ops.send(tok(run.goblin, { kind: "monster", name: "Goblin", x: 9, y: 4, disposition: "hostile", actor: { inline: actor() } }));
    await ops.send(tok(run.ally, { kind: "npc", name: "Warhorse", x: 6, y: 7, disposition: "ally", actor: { inline: actor() } }));
    await ops.send(tok(run.neutral, { kind: "npc", name: "Prisoner", x: 10, y: 7, disposition: "neutral", actor: { inline: actor() } }));
    await ops.send({ t: "monster.create", monster: { ...BLOCK, id: run.monsterBlock, name: "Guard captain" } });
    await ops.send(tok(run.monster, { kind: "monster", name: "Guard captain", x: 12, y: 5, disposition: "hostile", actor: { inline: actor({ monsterId: run.monsterBlock }) } }));
    await ops.send({ t: "template.create", template: { id: run.area, sceneId: run.sceneId, shape: "sphere", size: 10, origin: { x: 15, y: 9, z: 0 }, yaw: 0, includeOrigin: false, color: "#3e8ef7", ownerId: dmId, visibility: "all" } });
    await ops.send({
      t: "trap.create",
      trap: {
        id: run.trap,
        sceneId: run.sceneId,
        name: "Needle wall",
        found: true,
        zone: { cells: [{ x: 17, y: 3, w: 2, h: 1 }] },
        rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: { area: { shape: "cone", size: 15, origin: { x: 17, y: 3, z: 0 }, yaw: 90, includeOrigin: false } }, save: { ability: "dex", dc: 13, onPass: "half" }, damage: [{ formula: "2d6", type: "piercing" }], actions: [], find: [], notice: false },
      },
    });
    await ops.send({ t: "encounter.start", entries: [{ id: randomUUID(), tokenId: run.thorn, value: 18 }, { id: randomUUID(), tokenId: run.goblin, value: 12 }] });
    await ops.send({ t: "encounter.next" });
    await openRoom(dm, COMPUTER);
    await untilScheme(dm, "light", "the DM's room");

    // Isometric and back to Top-down, through the test hook.
    await waitFor("the iso hook", () => dm.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
    for (const view of ["isometric", "topDown"] as const) {
      await dm.evaluate((v) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(v), view);
      await sleep(600);
      assert.deepEqual(await canvasVars(dm), [], `${view}: a canvas color read a variable`);
    }
    await dm.getByRole("button", { name: "Fit the map to the screen", exact: true }).click();
    await sleep(300);

    // A ruler, held mid-drag so it draws, then let go.
    const at = (x: number, y: number) => pagePoint(dm, BOUNDS, { x, y });
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, hold?: () => Promise<void>) => {
      const a = await at(from.x, from.y);
      const b = await at(to.x, to.y);
      await dm.mouse.move(a.x, a.y);
      await dm.mouse.down();
      await dm.mouse.move(b.x, b.y, { steps: 10 });
      await sleep(150);
      await hold?.();
      await dm.mouse.up();
      await sleep(150);
    };
    await pickTool(dm, "Ruler");
    await drag({ x: 2.5, y: 2.5 }, { x: 8.5, y: 6.5 });
    // An area's preview, from its tool.
    await pickTool(dm, "Area");
    await drag({ x: 3.5, y: 10.5 }, { x: 6.5, y: 12.5 });
    await dm.keyboard.press("Escape");
    // A ping.
    await pickTool(dm, "Ping");
    const ping = await at(7.5, 9.5);
    await dm.mouse.click(ping.x, ping.y);
    await sleep(400);
    // The fog brush.
    await pickTool(dm, "Fog");
    await drag({ x: 1.5, y: 13.5 }, { x: 4.5, y: 14.5 });
    // The builder's walls, then its Height brush's area, held mid-drag.
    await pickTool(dm, "Map builder");
    await drag({ x: 19, y: 10 }, { x: 22, y: 10 });
    await pickOption(dm, "Map builder", "Builder mode", "Heights and stairs");
    await pickOption(dm, "Map builder", "Brush", "Area");
    await drag({ x: 19.5, y: 12.5 }, { x: 22.5, y: 14.5 });
    await pickTool(dm, "Select");
    // A trap's Aim: its pane's Place the area draws the draft in the board's danger red.
    await pickTool(dm, "Trap");
    await tapCell(dm, BOUNDS, { x: 17, y: 3 });
    const pane = dm.getByRole("dialog", { name: "Edit trap" });
    await pane.waitFor();
    const hits = pane.getByRole("button", { name: "Hits", exact: true });
    if ((await hits.getAttribute("aria-expanded")) !== "true") await hits.click();
    await pane.getByRole("button", { name: "Place the area", exact: true }).click();
    const areaBar = dm.getByRole("toolbar", { name: "Area options" });
    await areaBar.waitFor();
    await sleep(500);
    await areaBar.getByRole("button", { name: "Cancel", exact: true }).click();
    await dm.keyboard.press("Escape");
    await pickTool(dm, "Select");
    // The dice tray, on Pat's phone, light too: a roll from the Dice panel throws.
    await pat.goto(`${server.origin}/`);
    await storeTheme(pat, "light");
    await openRoom(pat, PHONE);
    await untilScheme(pat, "light", "Pat's room");
    await throwDice(pat);
    await shots.take(dm, "lt-0-dm-board-light");
  });

  test("lt-1. the Theme row: Dark at first, Light switches the open room at once and survives a reload, Auto follows the device both ways, and the guide in a second page follows a change made in the room", async () => {
    const fresh = await browser.newContext({ viewport: COMPUTER });
    try {
      await fresh.addInitScript(CANVAS_NET);
      const page = await fresh.newPage();
      await page.goto(`${server.origin}/`);
      assert.equal(await schemeOf(page), "dark", "a new device is dark");
      assert.equal(await groundOf(page), normal(PALETTES.dark.bg));
    } finally {
      await fresh.close();
    }

    await storeTheme(dm, "dark");
    await openRoom(dm, COMPUTER);
    assert.equal(await schemeOf(dm), "dark");
    const menu = await openThisDevice(dm);
    const group = menu.getByRole("radiogroup", { name: "Theme" });
    assert.deepEqual(await group.getByRole("radio").evaluateAll((els) => els.map((e) => (e as unknown as { getAttribute(n: string): string | null }).getAttribute("value"))), ["dark", "light", "auto"]);
    assert.equal(await group.getByRole("radio", { name: "Dark", exact: true }).isChecked(), true);
    const help = await group.getAttribute("aria-describedby");
    assert.equal((await dm.locator(`[id="${help}"]`).textContent())?.trim(), "Auto follows this device's own light or dark setting. The map, the fog, the dice tray and the table display stay dark in both.");
    await shots.take(dm, "lt-1-this-device-dark");

    // A tap switches the open page: no navigation, no reload.
    await dm.evaluate(() => ((globalThis as unknown as { __lt1: boolean }).__lt1 = true));
    await group.getByRole("radio", { name: "Light", exact: true }).check();
    await untilScheme(dm, "light", "the room");
    assert.equal(await dm.evaluate(() => (globalThis as unknown as { __lt1?: boolean }).__lt1 === true), true, "the page was not reloaded");
    assert.equal(await groundOf(dm), normal(PALETTES.light.bg));
    assert.equal(await dm.locator('meta[name="theme-color"]').getAttribute("content"), PALETTES.light.bg);
    assert.equal(await group.getByRole("radio", { name: "Light", exact: true }).evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement), true, "focus stays on the chosen option");
    await shots.take(dm, "lt-1-this-device-light");
    await dm.reload();
    await dm.getByRole("status", { name: "Connected" }).first().waitFor();
    assert.equal(await schemeOf(dm), "light", "the choice survives a reload");

    // Auto follows the device's own setting, both ways, with no reload.
    await chooseTheme(dm, "Auto");
    await dm.emulateMedia({ colorScheme: "dark" });
    await untilScheme(dm, "dark", "Auto on a dark device");
    await dm.emulateMedia({ colorScheme: "light" });
    await untilScheme(dm, "light", "Auto on a light device");
    await dm.emulateMedia({ colorScheme: "dark" });
    await untilScheme(dm, "dark", "Auto on a dark device again");

    // The guide, open in a second page as the Menu opens it, follows a change made in the room.
    await chooseTheme(dm, "Dark");
    const guide = await dmContext.newPage();
    try {
      await guide.goto(`${server.origin}/docs/dm-guide`);
      await guide.getByRole("heading", { level: 1 }).first().waitFor();
      assert.equal(await schemeOf(guide), "dark");
      await chooseTheme(dm, "Light");
      await untilScheme(guide, "light", "the guide");
      assert.equal(await groundOf(guide), normal(PALETTES.light.bg));
      await shots.take(guide, "lt-1-guide-follows-light");
      await chooseTheme(dm, "Dark");
      await untilScheme(guide, "dark", "the guide");
      await chooseTheme(dm, "Light");
      await untilScheme(guide, "light", "the guide again");
    } finally {
      await guide.close();
      await dm.emulateMedia({ colorScheme: null });
    }
    await closeSheets(dm);
  });

  test("lt-2. the board: with every piece of chrome hidden, the canvas draws the same pixels in dark and light, and the map's ground is #16161a in both", async () => {
    await openRoom(dm, COMPUTER, { "rvtt.theme": "dark" });
    await dm.emulateMedia({ reducedMotion: "reduce" });
    try {
      await dm.getByRole("button", { name: "Fit the map to the screen", exact: true }).click();
      await sleep(500);
      const hide = async (on: boolean) =>
        dm.evaluate((hiding) => {
          const g = globalThis as unknown as { document: { adoptedStyleSheets: unknown[] }; CSSStyleSheet: new () => { replaceSync(t: string): void }; __lt2?: unknown };
          if (hiding) {
            const sheet = new g.CSSStyleSheet();
            // Everything but the map's canvases, which keep their own visibility under a hidden parent.
            // The map's column keeps its own ground, which shows wherever the map draws nothing.
            sheet.replaceSync("body * { visibility: hidden !important; } .konvajs-content, .konvajs-content *, [data-lt2-ground] { visibility: visible !important; }");
            g.document.adoptedStyleSheets = [...g.document.adoptedStyleSheets, sheet];
            g.__lt2 = sheet;
          } else g.document.adoptedStyleSheets = g.document.adoptedStyleSheets.filter((s) => s !== g.__lt2);
        }, on);
      const canvas = (await dm.locator(".konvajs-content").first().boundingBox())!;
      const clip = { x: Math.round(canvas.x), y: Math.round(canvas.y), width: Math.floor(canvas.width), height: Math.floor(canvas.height) };
      const mapColumn = dm.locator('[role="img"][aria-label="Map"][data-rvtt-ring]').locator("..");
      await mapColumn.evaluate((el) => (el as unknown as { setAttribute(n: string, v: string): void }).setAttribute("data-lt2-ground", ""));
      const shot = async () => (await pixels(dm, clip)).data;

      const withChrome = await shot();
      await hide(true);
      await sleep(200);
      const dark = await shot();
      assert.ok(!withChrome.equals(dark), "hiding the chrome changed nothing, so nothing was hidden over the board");
      assert.equal(await mapColumn.evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }).getComputedStyle(el).backgroundColor), "rgb(22, 22, 26)", "the map's ground in dark");
      await hide(false);

      await storeTheme(dm, "light");
      await dm.evaluate(() => (globalThis as unknown as { dispatchEvent(e: unknown): void; StorageEvent: new (t: string, i: object) => unknown }).dispatchEvent(new (globalThis as unknown as { StorageEvent: new (t: string, i: object) => unknown }).StorageEvent("storage", { key: "rvtt.theme", newValue: "light" })));
      await untilScheme(dm, "light", "the room");
      await sleep(400);
      assert.equal(await mapColumn.evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { backgroundColor: string } }).getComputedStyle(el).backgroundColor), "rgb(22, 22, 26)", "the map's ground in light");
      await shots.take(dm, "lt-2-board-light-with-chrome");
      await hide(true);
      await sleep(200);
      const light = await shot();
      await hide(false);
      let differ = 0;
      for (let i = 0; i < dark.length; i++) if (dark[i] !== light[i]) differ++;
      assert.equal(differ, 0, `${differ} canvas bytes differ between dark and light`);
    } finally {
      await dm.emulateMedia({ reducedMotion: null });
    }
  });

  test("lt-3. the contrast sweep at 1440 x 900 and 390 x 844: Home, Join, the guide, Docs, and in the room every bar, pane, panel, toast, dialog and notice, with rings and floating chrome measured over the board and over white art", async (t) => {
    let light: { failures: string[]; counts: Map<string, number> } | null = null;
    for (const scheme of ["light", "dark"] as const) {
      const found = { failures: [] as string[], counts: new Map<string, number>() };
      await sweepPages(dm, COMPUTER, scheme, found);
      await sweepRoom(dm, COMPUTER, scheme, found, "computer");
      if (!dmPhone || dmPhone.isClosed()) {
        phoneContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await dmContext.storageState() });
        await phoneContext.addInitScript(CANVAS_NET);
        dmPhone = await phoneContext.newPage();
        consoles.dmPhone.attach(dmPhone);
      }
      await sweepPages(dmPhone, PHONE, scheme, found);
      await sweepRoom(dmPhone, PHONE, scheme, found, "phone");
      if (scheme === "light") light = found;
      // Dark's findings are a follow-up list, not a failure (13).
      else for (const line of found.failures) t.diagnostic(`dark follow-up: ${line}`);
    }
    // Light's findings fail the step, after the dark pass and the white art have run, so one run lists all of them.
    const halo = await whiteArtHalo();
    assert.ok(light);
    for (const part of ["top bar", "toolbar", "tool options", "token window", "toast", "chosen tool", "map ring", "map after a pointer", "rings", "open rings", "dungeon dialog", "dungeon ring"]) assert.ok((light.counts.get(part) ?? 0) > 0, `the sweep measured nothing in the ${part}`);
    for (const line of light.failures) t.diagnostic(`light: ${line}`);
    assert.deepEqual([...light.failures, ...halo], [], "under its contrast in the light theme");
  });

  test("lt-4. the dark screens in a light browser: the pause screen and its X-card, the scene gate, the preview's waiting and failed screens and the tray mid-throw draw only dark colors, and their rings are the dark accent", async () => {
    const light = lightOnly();
    const onlyDark = async (page: Page, part: Locator, what: string, words = true) => {
      const colors = await partColors(part);
      assert.ok(colors.length > 0, `${what}: read no colors`);
      const wrong = colors.filter((c) => light.has(normal(c.value))).map((c) => `${what}: ${c.what} ${c.prop} ${c.value}`);
      assert.deepEqual(wrong, [], `${what} drew a light color`);
      const sweep = await sweepContrast(part, what);
      if (words) assert.ok(sweep.measured.length > 0, `${what}: measured nothing`);
      assert.deepEqual(sweep.failures, []);
    };
    const ringIs = async (page: Page, accent: string, what: string) => {
      const sweep = await sweepRing(page, what);
      assert.ok(sweep.measured.length > 0, `${what}: no ring to measure`);
      assert.deepEqual(sweep.failures, []);
      for (const m of sweep.measured) assert.equal(normal(m.color), normal(accent), `${what}: the ring is the dark accent`);
    };

    // The pause screen with its X-card, on Pat's light phone.
    await openRoom(pat, PHONE, { "rvtt.theme": "light" });
    await ops.send({ t: "view.blackout", blackout: true });
    const paused = pat.locator("[data-rvtt-pause-screen]");
    try {
      await paused.getByText("The DM has paused the game.").waitFor();
      assert.equal(await schemeOf(pat), "light", "the page around it stays light");
      await onlyDark(pat, paused, "the pause screen");
      await paused.getByRole("button", { name: "X-card" }).click();
      const send = paused.getByRole("button", { name: "Send the X-card" });
      await send.waitFor();
      await onlyDark(pat, paused, "the X-card, open");
      // Keys: Tab reaches Send and Cancel, and each rings in Pat's accent resolved for dark.
      const patDark = accentFor(PAT_COLOR, "dark").accent;
      await tabTo(pat, send);
      await ringIs(pat, patDark, "the X-card's Send");
      await pat.keyboard.press("Tab");
      assert.match((await pat.locator(":focus").textContent()) ?? "", /Cancel/);
      await ringIs(pat, patDark, "the X-card's Cancel");
      await shots.take(pat, "lt-4-pause-x-card-light-device");
      await pat.keyboard.press("Enter");
    } finally {
      // The steps after this one need the players' view back, whatever failed here.
      await ops.send({ t: "view.blackout", blackout: false });
    }
    await paused.waitFor({ state: "detached" });

    // The scene gate, while the room's socket gives no snapshot: "Loading the scene…" on black.
    const gateContext = await browser.newContext({ viewport: COMPUTER, storageState: await dmContext.storageState() });
    try {
      const gatePage = await gateContext.newPage();
      await gatePage.routeWebSocket(/\/ws/, () => {
        // Held: the room never answers, so the gate waits.
      });
      await gatePage.goto(`${server.origin}/r/${run.roomId}`);
      const gate = gatePage.getByText("Loading the scene…").locator("xpath=ancestor::div[1]/..");
      await gatePage.getByText("Loading the scene…").waitFor();
      assert.equal(await schemeOf(gatePage), "light");
      await onlyDark(gatePage, gate, "the scene gate");
      await shots.take(gatePage, "lt-4-scene-gate-light-device");
    } finally {
      await gateContext.close();
    }

    // The preview's waiting and failed screens, and Try again's ring in the DM's accent resolved for dark.
    await openRoom(dm, COMPUTER, { "rvtt.theme": "light" });
    heldPreview = null;
    const dmPanel = await openPanel(dm, "DM");
    await dmPanel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
    await dmPanel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    try {
      const loading = preview.locator('[data-preview-wait="loading"]');
      await loading.getByRole("status").filter({ hasText: "Loading what Pat sees" }).waitFor();
      await onlyDark(dm, loading, "the preview's wait");
      const held = await waitFor("the preview's socket", () => heldPreview as WebSocketRoute | null, 5_000);
      await held.close();
      const failed = preview.locator('[data-preview-wait="failed"]');
      await failed.getByRole("alert").filter({ hasText: "Could not load what Pat sees." }).waitFor();
      await onlyDark(dm, failed, "the preview's failure");
      const retry = failed.getByRole("button", { name: "Try again" });
      await tabTo(dm, retry);
      await ringIs(dm, accentFor(DM_COLOR, "dark").accent, "the preview's Try again");
      await shots.take(dm, "lt-4-preview-failed-light-device");
    } finally {
      await preview.getByRole("button", { name: "Exit", exact: true }).click();
      await preview.waitFor({ state: "detached" });
    }

    // The tray mid-throw, on Pat's light phone.
    // Its rings and scrim hold no words, so only its colors are read.
    await throwDice(pat, async (tray) => onlyDark(pat, tray, "the dice tray mid-throw", false));
  });

  test("lt-5. the table display holds dark: back to a room in the same window gives the device's light again, and a change made in another tab meanwhile is the one the room shows", async () => {
    const page = await dmContext.newPage();
    try {
      await page.goto(`${server.origin}/`);
      await storeTheme(page, "light");
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      assert.equal(await schemeOf(page), "light");
      const go = (to: string) =>
        page.evaluate((p) => {
          const g = globalThis as unknown as { history: { pushState(s: unknown, t: string, u: string): void }; dispatchEvent(e: unknown): void; PopStateEvent: new (t: string) => unknown };
          g.history.pushState(null, "", p);
          g.dispatchEvent(new g.PopStateEvent("popstate"));
        }, to);
      // The display's own code held back, so the frames before it loads show: none may be light once the room has gone (review LTB-2).
      await page.route(/\/assets\/DisplayPages-[^/]*\.js$/, async (route) => {
        await sleep(1_000);
        await route.continue();
      });
      await page.evaluate(() => {
        const g = globalThis as unknown as { __rvttFrames: string[]; requestAnimationFrame(f: () => void): void; document: { documentElement: { dataset: Record<string, string | undefined> }; querySelector(s: string): unknown } };
        g.__rvttFrames = [];
        const tick = () => {
          if (g.document.querySelector("[data-rvtt-topbar]") === null) g.__rvttFrames.push(g.document.documentElement.dataset.rvttScheme ?? "dark");
          if (g.__rvttFrames.length < 600) g.requestAnimationFrame(tick);
        };
        g.requestAnimationFrame(tick);
      });
      await go("/display");
      await page.getByLabel("Code from the DM's screen").waitFor();
      await untilScheme(page, "dark", "the display");
      const frames = await page.evaluate(() => (globalThis as unknown as { __rvttFrames: string[] }).__rvttFrames.splice(0));
      assert.ok(frames.length > 20, `frames while the display's code loaded: ${frames.length}`);
      assert.deepEqual([...new Set(frames)], ["dark"], "every frame from the room's going to the display's code is dark");
      await page.unrouteAll();
      await shots.take(page, "lt-5-display-dark-on-light-device");
      await page.goBack();
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await untilScheme(page, "light", "the room after the display");

      // Dark chosen, then the display, then Light chosen in another tab while it holds dark.
      await storeTheme(page, "dark");
      await page.evaluate(() => (globalThis as unknown as { dispatchEvent(e: unknown): void; StorageEvent: new (t: string, i: object) => unknown }).dispatchEvent(new (globalThis as unknown as { StorageEvent: new (t: string, i: object) => unknown }).StorageEvent("storage", { key: "rvtt.theme", newValue: "dark" })));
      await untilScheme(page, "dark", "the room on Dark");
      await go("/display");
      await page.getByLabel("Code from the DM's screen").waitFor();
      const other = await dmContext.newPage();
      try {
        await other.goto(`${server.origin}/docs`);
        await other.evaluate(() => localStorage.setItem("rvtt.theme", "light"));
      } finally {
        await other.close();
      }
      await sleep(300);
      assert.equal(await schemeOf(page), "dark", "the display still holds dark");
      await page.goBack();
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await untilScheme(page, "light", "the room, with the other tab's choice");
    } finally {
      await page.close();
    }

    // A fresh load of the display on a light device: dark from the first frame, while its code is still on the way.
    const fresh = await dmContext.newPage();
    try {
      await fresh.addInitScript(() => {
        const g = globalThis as unknown as { __rvttFrames: string[]; requestAnimationFrame(f: () => void): void; document: { documentElement: { dataset: Record<string, string | undefined> } } };
        g.__rvttFrames = [];
        const tick = () => {
          g.__rvttFrames.push(g.document.documentElement.dataset.rvttScheme ?? "dark");
          if (g.__rvttFrames.length < 600) g.requestAnimationFrame(tick);
        };
        g.requestAnimationFrame(tick);
      });
      await fresh.route(/\/assets\/DisplayPages-[^/]*\.js$/, async (route) => {
        await sleep(1_000);
        await route.continue();
      });
      await fresh.goto(`${server.origin}/display`);
      await fresh.getByLabel("Code from the DM's screen").waitFor();
      assert.equal(await fresh.evaluate(() => localStorage.getItem("rvtt.theme")), "light");
      const frames = await fresh.evaluate(() => (globalThis as unknown as { __rvttFrames: string[] }).__rvttFrames.splice(0));
      assert.ok(frames.length > 20, `frames while the display's code loaded: ${frames.length}`);
      assert.deepEqual([...new Set(frames)], ["dark"], "every frame of a fresh load is dark");
    } finally {
      await fresh.close();
    }
  });

  test("lt-6. the home-screen app's status band: black over the top 47 px and not below, on a light page at 390 x 844 at 100% and 130%, over Home, the room, a full-screen and a bottom-sheet dialog, the handout viewer's backdrop, a sheet, a popover and the preview, and absent in dark", async () => {
    // A stand-in notch, which Chromium cannot emulate: the app reads `--rvtt-safe-top` before env() (lib/theme.ts safe.top).
    const standalone = async (from: BrowserContext) => {
      const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1, isMobile: true, hasTouch: true, storageState: await from.storageState() });
      await context.addInitScript(`Object.defineProperty(Navigator.prototype, "standalone", { configurable: true, get: () => true });`);
      await context.addInitScript(CANVAS_NET);
      return context;
    };
    const dmApp = await standalone(dmContext);
    const patApp = await standalone(patContext);
    const failures: string[] = [];
    let lastXcard = 0;
    const band = async (page: Page, what: string, black: boolean) => {
      await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { style: { setProperty(n: string, v: string): void } } } }).document.documentElement.style.setProperty("--rvtt-safe-top", "47px"));
      await sleep(250);
      const shot = await pixels(page, { x: 0, y: 0, width: PHONE.width, height: 49 });
      // A filled sheet's rounded corners blend the strip's black with the black behind at their arcs, a few grey pixels, so dark enough is black.
      let notBlack = 0;
      let notPure = 0;
      for (let y = 0; y < 47; y++)
        for (let x = 0; x < shot.width; x++) {
          const p = shot.at(x, y);
          if (p.some((v) => v > 70)) notBlack++;
          if (p.some((v) => v > 6)) notPure++;
        }
      let belowBlack = 0;
      for (let x = 0; x < shot.width; x++) if (shot.at(x, 48).every((v) => v <= 6)) belowBlack++;
      if (black && notBlack > 0) failures.push(`${what}: ${notBlack} pixels of the top 47 px are not black`);
      if (black && belowBlack === shot.width) failures.push(`${what}: the row under the band is black too`);
      // Dark's own top bar is near black, so no band means the strip is not pure black.
      if (!black && notPure === 0) failures.push(`${what}: a band in dark`);
      await shots.take(page, `lt-6-${what.replace(/[^a-z0-9]+/gi, "-")}`);
    };
    const openAt = async (page: Page, scale: number, theme: "light" | "dark") => {
      await page.goto(`${server.origin}/`);
      await page.evaluate(([s, t]) => {
        localStorage.setItem("rvtt.theme", t);
        localStorage.setItem("rvtt.uiScale", s);
      }, [String(scale), theme] as const);
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
    };
    try {
      const player = await patApp.newPage();
      const desk = await dmApp.newPage();
      for (const scale of [1, 1.3]) {
        const at = `${scale * 100}%`;
        await player.goto(`${server.origin}/`);
        await player.evaluate((sc) => {
          localStorage.setItem("rvtt.theme", "light");
          localStorage.setItem("rvtt.uiScale", sc);
        }, String(scale));
        await player.reload();
        await band(player, `home ${at}`, true);
        await openAt(player, scale, "light");
        await band(player, `room ${at}`, true);
        // A sheet: the Menu, then This device's Shortcuts dialog, which fills a phone's screen.
        const menuSheet = await openPanel(player, "Menu");
        await band(player, `menu sheet ${at}`, true);
        // Swiped to the whole screen, the sheet's own ground reaches the top. Expand shows only with focus, as a keyboard reaches it.
        await menuSheet.getByRole("button", { name: "Expand sheet" }).focus();
        await player.keyboard.press("Enter");
        await sleep(500);
        await band(player, `whole-screen sheet ${at}`, true);
        const device = await openThisDevice(player);
        await device.getByRole("button", { name: /^Show the shortcuts/ }).click();
        const shortcuts = player.getByRole("dialog", { name: /shortcuts/i });
        await shortcuts.waitFor();
        await band(player, `full-screen dialog ${at}`, true);
        await player.keyboard.press("Escape");
        await shortcuts.waitFor({ state: "detached" });
        await closeSheets(player);
        // A popover: the Area tool's Shape chip.
        await pickTool(player, "Area");
        await player.getByRole("toolbar", { name: "Area options" }).getByRole("button", { name: /^Shape: / }).first().click();
        const popover = player.getByRole("dialog", { name: "Shape" });
        await popover.waitFor();
        await band(player, `popover ${at}`, true);
        await player.keyboard.press("Escape");
        await popover.waitFor({ state: "detached" });
        await pickTool(player, "Select");
        // The handout viewer, its card lower than the top: only its backdrop covers the band.
        if (!run.whiteMap) run.whiteMap = await uploadWhite("handout");
        const handoutId = randomUUID();
        await ops.send({ t: "handout.show", handout: { id: handoutId, assetId: run.whiteMap, title: "Plain letter", to: "all" } });
        const viewer = player.getByRole("dialog", { name: "Plain letter" });
        await viewer.waitFor();
        await band(player, `handout viewer ${at}`, true);
        await ops.send({ t: "handout.close", handoutId });
        await viewer.waitFor({ state: "detached" });

        // The DM's phone: the X-card Pat sends comes as a bottom-sheet dialog, then View as a player.
        await openAt(desk, scale, "light");
        // Taps within 10 s of the card a room showed merge into it (server/http/xcard.ts).
        await sleep(Math.max(0, lastXcard + 10_500 - Date.now()));
        lastXcard = Date.now();
        const sent = await patContext.request.post(`${server.origin}/api/rooms/${run.roomId}/xcard`, { headers: { Origin: server.origin } });
        assert.ok(sent.ok(), `sending the X-card answered ${sent.status()}`);
        const xcard = desk.getByRole("dialog", { name: "X-card" });
        await xcard.waitFor();
        await band(desk, `bottom-sheet dialog ${at}`, true);
        await desk.keyboard.press("Escape");
        await xcard.waitFor({ state: "detached" });
        const dmPanel = await openPanel(desk, "DM");
        await dmPanel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
        await dmPanel.getByRole("button", { name: "View", exact: true }).click();
        const preview = desk.locator('dialog[aria-label="Viewing as Pat"]');
        await preview.waitFor();
        await band(desk, `preview ${at}`, true);
        await preview.getByRole("button", { name: "Exit", exact: true }).click();
        await preview.waitFor({ state: "detached" });
        await closeSheets(desk);
      }
      await openAt(player, 1, "dark");
      await band(player, "room in dark", false);
    } finally {
      await dmApp.close();
      await patApp.close();
    }
    assert.deepEqual(failures, []);
  });

  test("lt-7. the Height tool's area outline draws in the accent resolved for dark, on a light device", async () => {
    await openRoom(dm, COMPUTER, { "rvtt.theme": "light" });
    await dm.getByRole("button", { name: "Fit the map to the screen", exact: true }).click();
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Heights and stairs");
    await pickOption(dm, "Map builder", "Brush", "Area");
    const a = await pagePoint(dm, BOUNDS, { x: 2, y: 9 });
    const b = await pagePoint(dm, BOUNDS, { x: 8, y: 14 });
    const accent = accentFor(DM_COLOR, "dark").accent;
    const want = [Number.parseInt(accent.slice(1, 3), 16), Number.parseInt(accent.slice(3, 5), 16), Number.parseInt(accent.slice(5, 7), 16)];
    await dm.mouse.move(a.x, a.y);
    await dm.mouse.down();
    try {
      await dm.mouse.move(b.x, b.y, { steps: 10 });
      await sleep(250);
      await shots.take(dm, "lt-7-height-area-outline");
      // The outline's top edge, read across its middle: the accent, not the black a variable would leave.
      const strip = await pixels(dm, { x: Math.round(a.x + (b.x - a.x) * 0.3), y: Math.round(a.y) - 3, width: Math.round((b.x - a.x) * 0.4), height: 7 });
      let hits = 0;
      for (let y = 0; y < strip.height; y++) for (let x = 0; x < strip.width; x++) if (strip.at(x, y).every((v, i) => Math.abs(v - want[i]!) <= 24)) hits++;
      assert.ok(hits >= strip.width, `the outline's edge shows ${hits} pixels of ${accent}, fewer than its length`);
    } finally {
      await dm.mouse.up();
      await dm.keyboard.press("Escape");
      await pickTool(dm, "Select");
    }
    // lt-3 takes the DM offline for its notice, and the socket's failed tries while offline are the browser's own words.
    const errors = [...consoles.dm.errors, ...consoles.pat.errors].filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e));
    assert.deepEqual(errors, [], "no page logged an error");
  });
});

/** Moves focus to `target` by Tab from where focus is, as keys would, so its ring shows as a keyboard user sees it. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await target.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  assert.fail("Tab never reached the control");
}

/** Uploads a white picture as a map or a handout, for the halo over white art and the handout viewer. */
async function uploadWhite(kind: "map" | "handout"): Promise<string> {
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=${kind}`, { headers: { Origin: server.origin, "content-type": "image/png" }, data: await whitePng(1200, 800) });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  return ((await res.json()) as { id: string }).id;
}

/**
 * Rolls a d20 from the Dice panel until the dice throw (their chunk warms
 * up in a quiet moment, and a roll before then shows its total at once),
 * and calls `during` with the tray while they fall.
 */
async function throwDice(page: Page, during?: (tray: Locator) => Promise<void>): Promise<void> {
  const panel = await openPanel(page, "Dice");
  const field = panel.getByLabel("Dice formula");
  // At rest a tray holds only the canvas's slot. A throw adds its scrim and marks around it.
  const tray = page.locator("[data-dice-tray]:has(> :nth-child(2))").first();
  await waitFor(
    "a throw",
    async () => {
      await field.fill("1d20");
      await field.press("Enter");
      try {
        // The tray is a 0 px band its throw overflows, so it is attached, never "visible".
        await tray.waitFor({ state: "attached", timeout: 1_500 });
      } catch {
        await sleep(800);
        return null;
      }
      await during?.(tray);
      return true;
    },
    30_000,
  );
  await waitFor("the throw to end", async () => ((await tray.count()) === 0 ? true : null), 10_000);
  await closeSheets(page);
}

/** Home, Join, the guide and Docs, swept in a scheme. */
async function sweepPages(page: Page, size: { width: number; height: number }, scheme: "dark" | "light", found: { failures: string[]; counts: Map<string, number> }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(`${server.origin}/`);
  await storeTheme(page, scheme);
  const at = `${size.width}x${size.height} ${scheme}`;
  for (const [what, url] of [["Home", "/"], ["Join", `/r/${run.roomId}`], ["the guide", "/docs/dm-guide"], ["Docs", "/docs"]] as const) {
    if (what === "Join") {
      // A device with no session sees the join page.
      const guest = await browser.newContext({ viewport: size, isMobile: size.width < 900, hasTouch: size.width < 900 });
      try {
        const g = await guest.newPage();
        await g.goto(`${server.origin}/`);
        await storeTheme(g, scheme);
        await g.goto(`${server.origin}/r/${run.roomId}`);
        await g.getByLabel("Player password").or(g.getByLabel("Password")).first().waitFor();
        keep(await sweepContrast(g.locator("body"), `${at} ${what}`), found, what);
        await shots.take(g, `lt-3-${size.width}-${scheme}-join`);
      } finally {
        await guest.close();
      }
      continue;
    }
    await page.goto(`${server.origin}${url}`);
    await page.locator("h1, h2").first().waitFor();
    await sleep(300);
    assert.equal(await schemeOf(page), scheme);
    keep(await sweepContrast(page.locator("body"), `${at} ${what}`), found, what);
    await shots.take(page, `lt-3-${size.width}-${scheme}-${what.replace(/ /g, "-")}`);
  }
}

/** Every room surface the design names, swept in a scheme on one page, with the rings over the board. */
async function sweepRoom(page: Page, size: { width: number; height: number }, scheme: "dark" | "light", found: { failures: string[]; counts: Map<string, number> }, kind: "computer" | "phone"): Promise<void> {
  const at = `${size.width}x${size.height} ${scheme}`;
  const sweep = async (part: string, root: Locator) => {
    await root.first().waitFor();
    keep(await sweepContrast(root.first(), `${at} ${part}`), found, part);
  };
  // Thorn dying, for the party bar's word.
  if (dmSocket.state?.characters[run.thornChar]?.actor.life !== "dying") await ops.send({ t: "actor.hp", target: { characterId: run.thornChar }, change: { kind: "damage", amount: 30 } });
  await openRoom(page, size, { "rvtt.theme": scheme });
  await page.getByRole("button", { name: "Fit the map to the screen", exact: true }).click();
  await sleep(300);

  await sweep("top bar", page.locator("[data-rvtt-topbar]"));
  await pickTool(page, "Ruler");
  await sweep("toolbar", page.locator('nav[aria-label="Tools"]'));
  const chosen = page.locator('nav[aria-label="Tools"] button[data-active="true"]');
  await sweep("chosen tool", chosen);
  await sweep("tool options", page.getByRole("toolbar", { name: "Ruler options" }));
  await shots.take(page, `lt-3-${kind}-${scheme}-ruler`);
  await pickTool(page, "Select");

  const window = await tokenWindow(page, "Thorn", { x: 5, y: 5 });
  await sweep("token window", window);
  await shots.take(page, `lt-3-${kind}-${scheme}-token-window`);
  if (kind === "computer") {
    // Rings by keys once with chrome floating on the board, the token window and Select's options row (review LTB-7).
    await window.getByRole("button", { name: "Multi-select", exact: true }).click();
    const options = page.getByRole("toolbar", { name: "Select options" });
    await options.waitFor();
    await ringsByKeys(page, `${at} open`, found, [window, options]);
    await window.getByRole("button", { name: "Multi-select", exact: true }).click();
    await options.waitFor({ state: "detached" });
  }
  await page.keyboard.press("Escape");

  // A toast: Pat's whisper to the DM.
  const words = `The altar hums, ${kind} ${scheme}.`;
  await patOps.send({ t: "log.whisper", to: [dmSocket.you!.memberId], text: words });
  const toast = page.locator("[data-toast]").filter({ hasText: words }).first();
  await toast.waitFor({ timeout: 5_000 });
  await sweep("toast", toast.locator("xpath=.."));
  await shots.take(page, `lt-3-${kind}-${scheme}-toast`);

  for (const panel of ["Initiative", "Log", "Dice", "Party"]) {
    // The party bar stands atop the side panel from 900 px up, and is a panel of its own on a phone.
    const docked = page.locator('section[aria-label="Party"]').first();
    const root = panel === "Party" && (await docked.isVisible()) ? docked : await openPanel(page, panel);
    await sleep(200);
    await sweep(panel === "Initiative" ? "tracker" : panel === "Party" ? "party bar" : panel, root);
    if (panel === "Party") {
      const dying = root.getByText("Dying", { exact: true });
      assert.ok((await dying.count()) > 0, "the party bar shows Thorn dying");
    }
    await shots.take(page, `lt-3-${kind}-${scheme}-${panel.toLowerCase()}`);
  }
  // Members, This device and Room settings, pages of the Menu.
  const back = page.getByRole("button", { name: /^Back to Menu/ });
  const members = await openPanel(page, "Menu");
  if (await back.isVisible()) await back.click();
  await members.getByRole("button", { name: /^Members/ }).click();
  await sweep("Members", members);
  await shots.take(page, `lt-3-${kind}-${scheme}-members`);
  const device = await openThisDevice(page);
  await sweep("This device", device);
  // A dialog: This device's Shortcuts.
  const show = device.getByRole("button", { name: /^Show the shortcuts/ });
  await show.scrollIntoViewIfNeeded();
  await show.click();
  const dialog = page.getByRole("dialog", { name: /shortcuts/i });
  await sweep("dialog", dialog);
  await shots.take(page, `lt-3-${kind}-${scheme}-dialog`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  if (!(await back.isVisible())) await openThisDevice(page);
  await back.click();
  const menu = await openPanel(page, "Menu");
  await menu.getByRole("button", { name: /^Room settings/ }).click();
  await sweep("Room settings", menu);
  await shots.take(page, `lt-3-${kind}-${scheme}-room-settings`);
  await back.click();
  await closeSheets(page);

  await dungeonDialog(page, at, kind, scheme, found);

  // The token panel and a stat block.
  const guard = await tokenWindow(page, "Guard captain", { x: 12, y: 5 });
  const details = guard.getByRole("button", { name: "Details", exact: true });
  if (!(await details.isVisible())) await guard.getByRole("button", { name: "Expand", exact: true }).click();
  await details.click();
  const tokenPanel = page.getByRole("tabpanel", { name: "Token", exact: true }).or(page.getByRole("region", { name: "Token", exact: true })).or(page.locator('dialog[data-rvtt-sheet][aria-label="Token"]'));
  const fold = tokenPanel.getByRole("button", { name: "Stat block", exact: true });
  await fold.waitFor();
  if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  await sweep("token panel", tokenPanel);
  await sweep("stat block", tokenPanel.locator("[data-ability-grid]").locator("xpath=.."));
  await shots.take(page, `lt-3-${kind}-${scheme}-stat-block`);
  await page.keyboard.press("Escape");
  await closeSheets(page);

  // A danger notice: offline.
  await page.context().setOffline(true);
  try {
    const notice = page.getByText(/You are offline|Reconnecting/).first();
    await notice.waitFor({ timeout: 15_000 });
    await sweep("danger notice", notice.locator("xpath=ancestor::*[@role][1]"));
    await shots.take(page, `lt-3-${kind}-${scheme}-offline`);
  } finally {
    await page.context().setOffline(false);
  }
  await page.getByRole("status", { name: "Connected" }).first().waitFor({ timeout: 20_000 });

  // Rings: every control on the map area focused by keys, the map's own ring included.
  await ringsByKeys(page, at, found);
}

/**
 * Tabs from the map's focus target through what follows it on the map's
 * column, as a keyboard user would, and measures each ring against the
 * ground behind its line: the halo where it has one, else what lies there,
 * over both board grounds when that is the board. Dialogs are left out,
 * except the floating chrome in `open`, whose rings are counted apart.
 *
 * First a pointer: the map's target then draws neither ring nor halo
 * (D-261102-538), as a script focus after a tap must not frame the map.
 */
async function ringsByKeys(page: Page, at: string, found: { failures: string[]; counts: Map<string, number> }, open: Locator[] = []): Promise<void> {
  if (open.length === 0) await closeSheets(page);
  const map = page.locator('[role="img"][aria-label="Map"][data-rvtt-ring]');
  const look = () =>
    map.evaluate((el) => {
      const s = (globalThis as unknown as { getComputedStyle(e: unknown): { outlineStyle: string; boxShadow: string } }).getComputedStyle(el);
      return { visible: (el as { matches(q: string): boolean }).matches(":focus-visible"), outline: s.outlineStyle, shadow: s.boxShadow };
    });
  // A real key first, so the browser counts the next script focus as visible, as iOS Safari may after a tap.
  await page.keyboard.press("Shift");
  await setModality(page, "pointer");
  await map.focus();
  const afterPointer = await look();
  assert.ok(afterPointer.visible, "the map's target matches :focus-visible, so the pointer rule is what hides its ring");
  if (afterPointer.outline !== "none" || afterPointer.shadow !== "none") found.failures.push(`${at}: after a pointer the map's focus target draws outline ${afterPointer.outline}, shadow ${afterPointer.shadow}`);
  found.counts.set("map after a pointer", (found.counts.get("map after a pointer") ?? 0) + 1);
  await setModality(page, "keys");
  const byKeys = await look();
  if (byKeys.outline === "none" || !byKeys.shadow.includes("inset")) found.failures.push(`${at}: under keys the map's focus target draws outline ${byKeys.outline}, shadow ${byKeys.shadow}`);
  const mapRing = await sweepRing(page, `${at} map ring`);
  keep(mapRing, found, "map ring");
  const column = map.locator("..");
  const roots = await Promise.all(open.map((l) => l.first().elementHandle()));
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const g = globalThis as unknown as { document: { activeElement: { outerHTML: string; closest(s: string): unknown; getAttribute(n: string): string | null } | null } };
      const el = g.document.activeElement;
      return el && el.closest("body > *") !== null ? { key: el.outerHTML.slice(0, 160), dialog: el.closest("dialog") !== null } : null;
    });
    // Focus left the page's elements (the body, or the browser's own chrome), or came round again.
    if (!where || seen.has(where.key)) break;
    seen.add(where.key);
    const focused = page.locator(":focus");
    const inOpen = await focused.evaluate((el, rs) => (rs as { contains(e: unknown): boolean }[]).some((r) => r.contains(el)), roots);
    if (inOpen) {
      keep(await sweepRing(page, `${at} ring`), found, "open rings");
      continue;
    }
    const inColumn = await focused.evaluate((el, col) => (col as { contains(e: unknown): boolean }).contains(el), await column.elementHandle());
    if (!inColumn || where.dialog) continue;
    keep(await sweepRing(page, `${at} ring`), found, "rings");
  }
}

/**
 * Puts the page in pointer or keys mode (lib/inputModality.ts) by an event
 * on the window, which the app's own handlers on the document never hear,
 * so nothing on the page acts on it. A real Shift press would not do: a
 * bare modifier leaves the mode as it was, and a phone starts as a pointer.
 */
async function setModality(page: Page, mode: "pointer" | "keys"): Promise<void> {
  await page.evaluate((m) => {
    const g = globalThis as unknown as { dispatchEvent(e: unknown): void; PointerEvent: new (t: string) => unknown; KeyboardEvent: new (t: string, i: object) => unknown };
    g.dispatchEvent(m === "pointer" ? new g.PointerEvent("pointerdown") : new g.KeyboardEvent("keydown", { key: "Unidentified" }));
  }, mode);
  await waitFor(`${mode} mode`, () => page.evaluate((m) => ((globalThis as unknown as { document: { documentElement: { getAttribute(n: string): string | null } } }).document.documentElement.getAttribute("data-rvtt-input") === m ? true : null), mode));
}

/**
 * The dungeon generator's dialog (review LTB-1): its words, and Reroll's
 * ring in the preview's corner, where it stands on the board's dark
 * ground or the dark picture in either scheme. The ring sweep leaves out
 * what lies over the picture, an image, so the ring is also measured on
 * the preview's own ground, which the picture is drawn in the look of.
 */
async function dungeonDialog(page: Page, at: string, kind: "computer" | "phone", scheme: "dark" | "light", found: { failures: string[]; counts: Map<string, number> }): Promise<void> {
  const panel = await openPanel(page, "Scenes");
  const form = panel.getByRole("heading", { name: "New scene", exact: true }).locator("xpath=ancestor::*[self::section or @data-panel-group][1]");
  await form.getByRole("radio", { name: "Builder", exact: true }).click();
  await form.getByRole("button", { name: "Generate a dungeon", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Generate a dungeon" });
  await dialog.getByRole("img", { name: /^Preview of the dungeon/ }).waitFor({ timeout: 30_000 });
  await dialog.locator("footer [aria-live=polite]").waitFor({ timeout: 30_000 });
  const reroll = dialog.getByRole("button", { name: "Reroll", exact: true });
  await waitFor("Reroll on", async () => ((await reroll.isEnabled()) ? true : null));
  keep(await sweepContrast(dialog, `${at} dungeon dialog`), found, "dungeon dialog");
  await page.keyboard.press("Shift");
  await setModality(page, "keys");
  await reroll.focus();
  keep(await sweepRing(page, `${at} the dungeon preview's Reroll`), found, "dungeon ring");
  const ring = await reroll.evaluate((el) => {
    type E = { parentElement: E | null };
    const g = globalThis as unknown as { getComputedStyle(e: unknown): { outlineStyle: string; outlineColor: string; backgroundColor: string } };
    const own = g.getComputedStyle(el);
    // The preview's box: the first ground under the button's corner slot.
    let box = (el as E).parentElement;
    while (box && g.getComputedStyle(box).backgroundColor === "rgba(0, 0, 0, 0)") box = box.parentElement;
    return { style: own.outlineStyle, color: own.outlineColor, ground: box ? g.getComputedStyle(box).backgroundColor : "none" };
  });
  const least = ring.style === "none" ? 0 : ratio(parseColor(ring.color), parseColor(ring.ground));
  if (least < 3) found.failures.push(`${at}: the dungeon preview's Reroll ring ${ring.color} reads ${least.toFixed(2)}:1 on the preview's ground ${ring.ground}, under 3:1`);
  found.counts.set("dungeon ring", (found.counts.get("dungeon ring") ?? 0) + 1);
  await shots.take(page, `lt-3-${kind}-${scheme}-dungeon-reroll-ring`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await closeSheets(page);
}

/**
 * A white map under the toolbar and the map's edge: the pixels just inside
 * a focused tool's halo and the map ring's inset halo are its dark, and the
 * accent ring stands on it.
 */
async function whiteArtHalo(): Promise<string[]> {
  const failures: string[] = [];
  const mapId = await uploadWhite("map");
  // No fog, whose shade would grey the white art.
  await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: false } });
  await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: mapId, widthPx: 1200, heightPx: 800, cellPx: 50, originPx: { x: 0, y: 0 } } });
  await openRoom(dm, COMPUTER, { "rvtt.theme": "light" });
  // Zoomed in, so white art fills the screen under the bars and to the map's edge.
  await dm.getByRole("button", { name: "Fit the map to the screen", exact: true }).click();
  await sleep(300);
  const box = (await dm.locator(".konvajs-content").first().boundingBox())!;
  for (let i = 0; i < 6; i++) {
    await dm.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await dm.mouse.wheel(0, -240);
    await sleep(120);
  }
  await sleep(400);
  const halo = (p: [number, number, number]) => p.every((v) => v <= 50);
  const white = (p: [number, number, number]) => p.every((v) => v >= 235);

  // A floating tool, focused by keys: Tab on from the map's focus target.
  const map = dm.locator('[role="img"][aria-label="Map"][data-rvtt-ring]');
  await map.focus();
  const ruler = dm.locator('nav[aria-label="Tools"]').getByRole("button", { name: "Ruler", exact: true });
  await tabTo(dm, ruler);
  const r = (await ruler.boundingBox())!;
  const around = await pixels(dm, { x: Math.round(r.x) - 14, y: Math.round(r.y) - 14, width: Math.round(r.width) + 28, height: Math.round(r.height) + 28 });
  // 5 px out from the button's edge is halo, under no outline; 12 px out is the art.
  const mid = Math.round(around.height / 2);
  // Left and above: the next tool to the right paints over its side of the halo, as it should.
  const centre = Math.round(around.width / 2);
  if (!halo(around.at(14 - 5, mid))) failures.push(`the tool's halo, left, reads ${around.at(14 - 5, mid)}`);
  if (!halo(around.at(centre, 14 - 5))) failures.push(`the tool's halo, above, reads ${around.at(centre, 14 - 5)}`);
  if (!white(around.at(centre, 1))) failures.push(`above the tool's halo, the white art reads ${around.at(centre, 1)}`);
  await shots.take(dm, "lt-3-white-art-tool-ring");

  // The map's ring, inset: its halo lies inside the map's edge, over the white art.
  await map.focus();
  const m = (await map.boundingBox())!;
  const edge = await pixels(dm, { x: Math.round(m.x), y: Math.round(m.y + m.height / 2) - 4, width: 16, height: 8 });
  if (!halo(edge.at(4, 4))) failures.push(`the map ring's inset halo reads ${edge.at(4, 4)}`);
  if (!white(edge.at(12, 4))) failures.push(`past the map ring's halo, the white art reads ${edge.at(12, 4)}`);
  failures.push(...(await sweepRing(dm, "the map ring over white art")).failures);
  await shots.take(dm, "lt-3-white-art-map-ring");
  await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: null });
  await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true } });
  return failures;
}
