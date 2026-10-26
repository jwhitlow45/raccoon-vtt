import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, openSideTab, OpSocket, pagePoint, pickTool, reopenRoom, Shots, sideTabName, SocketWatch, startServer, waitFor, wholeInReach, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { isometric, toWorld, type Turn, type ViewPoint } from "../client/lib/view.ts";

/**
 * The isometric view's choice (docs/design-v1-isometric-view.md 7 and 8,
 * lane ISO-5): the View button and its menu, a scene's Suggested view,
 * the keys I, Q and E, and the table display's rows. A DM on a computer,
 * Pat on a phone and a TV.
 *
 * Isometric is out of reach until the lanes that draw it are in
 * (client/features/view/store.ts isoReady), so every page here but one
 * is opened as an end-to-end test may open it: with the flag that makes a
 * page offer it set before the app's first script
 * (client/features/view/choice.ts isoOffered). The one plain page checks
 * that nothing of it shows without the flag.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus five, as
 * size.e2e.ts does, since the runs never overlap. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 5;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-iso-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script, as only a test sets it. */
const OFFER = "globalThis.__rvttIsoTest = true;";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let pat: Page;
let tv: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat"), tv: new ConsoleWatch("tv"), phone: new ConsoleWatch("phone") };

const run = {
  roomId: "",
  roomName: `E2E iso ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  secondId: randomUUID(),
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

const viewButton = (page: Page) => page.getByRole("button", { name: /^View: / });
const viewMenu = (page: Page) => page.getByRole("dialog", { name: "View" });

/** What this browser keeps for the room under `key`, parsed. */
async function stored(page: Page, key: string): Promise<unknown> {
  const raw = await page.evaluate((k) => (globalThis as unknown as { localStorage: { getItem(k: string): string | null } }).localStorage.getItem(k), key);
  return raw === null ? null : JSON.parse(raw);
}

/** The board's view as the View button names it, and the turn its icon shows: the flip of the diamond (pages/RoomChrome.tsx ISO_FLIP). */
async function shownView(page: Page): Promise<string> {
  const button = viewButton(page);
  const name = (await button.getAttribute("aria-label")) ?? "";
  const flip = await button.locator("svg").evaluate((el) => (el as unknown as { style: { transform: string } }).style.transform);
  const turn = { "": 0, "scaleY(-1)": 1, "scale(-1, -1)": 2, "scaleX(-1)": 3 }[flip];
  return name === "View: Isometric" ? `isometric ${turn}` : name === "View: Top-down" ? `top-down${flip ? ` ${flip}` : ""}` : name;
}

async function untilShown(page: Page, want: string): Promise<void> {
  let seen = "";
  try {
    await waitFor(`the board in ${want}`, async () => ((seen = await shownView(page)) === want ? true : null));
  } catch (err) {
    throw new Error(`${(err as Error).message}: showed ${seen}`);
  }
}

/** The words the elements an element's aria-describedby names hold. */
function description(el: Locator): Promise<string> {
  return el.evaluate((node) => {
    const el = node as unknown as { getAttribute(name: string): string | null; ownerDocument: { getElementById(id: string): { textContent: string | null } | null } };
    return (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id: string) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
  });
}

/**
 * Where the popover's turn row and its whole menu end. The popover keeps
 * the size it opened with (components/Popover.tsx), so a pick that moves
 * either leaves an empty band or pushes the reason under "Scroll for more"
 * (ISO5-OPUS-9).
 */
async function menuFoot(menu: Locator): Promise<{ turns: number; body: number }> {
  const bottom = async (el: Locator) => {
    const b = await el.boundingBox();
    assert.ok(b, "drawn");
    return b.y + b.height;
  };
  return { turns: await bottom(menu.getByRole("button", { name: "Turn right", exact: true })), body: await bottom(menu.locator("[data-view-menu]")) };
}

async function sameFoot(menu: Locator, before: { turns: number; body: number }, what: string): Promise<void> {
  const after = await menuFoot(menu);
  assert.ok(Math.abs(after.turns - before.turns) <= 1, `${what}: the turn row ended at ${before.turns}, now ${after.turns}`);
  assert.ok(Math.abs(after.body - before.body) <= 1, `${what}: the menu ended at ${before.body}, now ${after.body}`);
  assert.equal(await menu.getByText("Scroll for more").count(), 0, `${what}: the popover says Scroll for more`);
  const [scroll, client] = await menu.evaluate((el) => [(el as unknown as { scrollHeight: number }).scrollHeight, (el as unknown as { clientHeight: number }).clientHeight]);
  assert.ok(scroll <= client + 1, `${what}: the popover scrolls, ${scroll} past ${client}`);
}

/** Pairs a display page with the room by a code from the DM. */
async function pairDisplay(page: Page): Promise<void> {
  const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
  assert.equal(res.status(), 201, await res.text());
  await page.goto(`${server.origin}/display`);
  await page.getByLabel("Code from the DM's screen").fill(((await res.json()) as { code: string }).code);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator(".konvajs-content").first().waitFor();
}

/** Keys go to the page, not to a tab or button that kept focus. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
}

/** The polite status's region outside the menu, once it says `words`. */
async function said(page: Page, words: string): Promise<void> {
  await page.locator("[data-rvtt-view-status]").filter({ hasText: words }).first().waitFor({ state: "attached" });
}

async function openMenu(page: Page, touch: boolean): Promise<Locator> {
  if (touch) await viewButton(page).tap();
  else await viewButton(page).click();
  const menu = viewMenu(page);
  await menu.waitFor();
  await onCheckedRadio(page, menu);
  return menu;
}

/**
 * Any open of the menu, a tap and a click too, puts focus on the checked
 * radio, and after a pointer draws no ring (design 8, D-261026-12).
 */
async function onCheckedRadio(page: Page, menu: Locator): Promise<void> {
  const checked = menu.locator("input[type=radio]:checked");
  await waitFor("focus on the checked radio", () => checked.evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement || null));
  const ring = await checked.evaluate((el) => {
    const label = (el as unknown as { parentElement: unknown }).parentElement;
    return (globalThis as unknown as { getComputedStyle(e: unknown): { outlineStyle: string } }).getComputedStyle(label).outlineStyle;
  });
  assert.equal(ring, "none", "no ring after a pointer");
}

async function closeMenu(page: Page, touch: boolean): Promise<void> {
  const menu = viewMenu(page);
  if (touch) await menu.getByRole("button", { name: /^Close/ }).tap();
  else await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

async function suggest(view: "Top-down" | "Isometric"): Promise<void> {
  await openSideTab(dm, "Scenes");
  const group = dm.getByRole("tabpanel", { name: "Scenes" }).getByRole("radiogroup", { name: "Suggested view" });
  await group.getByRole("radio", { name: view }).check();
}

/** A plain map image of one color, uploaded as the DM, placed at 25 px a cell. */
async function uploadMap(rgb: [number, number, number]) {
  const data = await sharp({ create: { width: 500, height: 400, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  const row = (await res.json()) as { id: string; width: number; height: number };
  return { assetId: row.id, widthPx: row.width, heightPx: row.height, cellPx: 25, originPx: { x: 0, y: 0 } };
}

/** The scale of the board on screen, in pixels a cell. */
function boardScale(page: Page): Promise<number> {
  return page.evaluate(() => {
    const konva = (globalThis as unknown as { Konva: { stages: { width(): number; scaleX(): number }[] } }).Konva;
    return Math.max(...konva.stages.filter((st) => st.width() > 0).map((st) => st.scaleX()));
  });
}

/**
 * What the visible isometric board draws, read from Konva's own nodes
 * (lane ISO-3): on the ground stage, which never listens, and on the main
 * stage's drag layer and overlay. A ring's line is a Shape dashed 8 by 5
 * (measure/ringScene.ts), an aura's shading a Shape filled in its color,
 * and a pill a Label with its words. `clipped` counts the aura's shadings
 * under a group with a clip, as one moving over fog draws.
 */
type IsoMarks = { ground: { rings: number; aura: number; texts: string[] }; drag: { texts: string[]; uprightTexts: string[]; circles: number }; overlay: { rings: number; aura: number; clipped: number; texts: string[] } };

function isoMarks(page: Page, auraColor: string): Promise<IsoMarks | null> {
  return page.evaluate((color) => {
    type Node = {
      dash?: () => number[] | undefined;
      fill?: () => string | undefined;
      text?: () => string;
      clipFunc?: () => unknown;
      getParent(): Node | null;
      getAbsoluteTransform(): { decompose(): { rotation: number; scaleX: number; scaleY: number } };
      find(selector: string): Node[];
    };
    type Stage = { width(): number; visible(): boolean; listening(): boolean; getLayers(): Node[]; find(s: string): Node[] };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    const shown = konva.stages.filter((s) => s.width() > 0 && s.visible());
    const ground = shown.find((s) => !s.listening());
    const main = shown.find((s) => s.listening());
    if (!ground || !main) return null;
    const layers = main.getLayers();
    const drag = layers[1]!;
    const overlay = layers[2]!;
    const rings = (n: { find(s: string): Node[] }) => n.find("Shape").filter((x) => JSON.stringify(x.dash?.()) === "[8,5]").length;
    const auras = (n: { find(s: string): Node[] }) => n.find("Shape").filter((x) => x.fill?.() === color);
    const texts = (n: { find(s: string): Node[] }) => n.find("Text").map((t) => t.text?.() ?? "");
    const clippedBy = (x: Node) => {
      for (let p = x.getParent(); p; p = p.getParent()) if (p.clipFunc?.()) return true;
      return false;
    };
    const upright = (t: Node) => {
      const d = t.getAbsoluteTransform().decompose();
      return Math.abs(d.rotation % 360) < 0.01 && Math.abs(d.scaleX - d.scaleY) < 1e-6 * Math.abs(d.scaleX);
    };
    return {
      ground: { rings: rings(ground), aura: auras(ground).length, texts: texts(ground) },
      drag: { texts: texts(drag), uprightTexts: drag.find("Text").filter(upright).map((t) => t.text?.() ?? ""), circles: drag.find("Circle").length },
      overlay: { rings: rings(overlay), aura: auras(overlay).length, clipped: auras(overlay).filter(clippedBy).length, texts: overlay.find("Text").filter(upright).map((t) => t.text?.() ?? "") },
    };
  }, auraColor);
}

/** The isometric main stage's camera and the page point of its corner. */
async function isoCamera(page: Page): Promise<{ x: number; y: number; scale: number; left: number; top: number }> {
  const cam = await page.evaluate(() => {
    const konva = (globalThis as unknown as { Konva: { stages: { width(): number; visible(): boolean; listening(): boolean; x(): number; y(): number; scaleX(): number; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } }).Konva;
    const main = konva.stages.find((s) => s.width() > 0 && s.visible() && s.listening());
    if (!main) return null;
    const r = main.container().getBoundingClientRect();
    return { x: main.x(), y: main.y(), scale: main.scaleX(), left: r.left, top: r.top };
  });
  assert.ok(cam, "the isometric board shows");
  return cam;
}

/** Where a token's standee shows on the page: the middle of its node's box on screen. */
async function standeeAt(page: Page, tokenId: string): Promise<{ x: number; y: number }> {
  const at = await page.evaluate((id) => {
    const konva = (globalThis as unknown as { Konva: { stages: { width(): number; visible(): boolean; listening(): boolean; findOne(s: string): { getClientRect(): { x: number; y: number; width: number; height: number } } | undefined; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } }).Konva;
    const main = konva.stages.find((s) => s.width() > 0 && s.visible() && s.listening());
    const node = main?.findOne(`#${id}`);
    if (!main || !node) return null;
    const r = node.getClientRect();
    const c = main.container().getBoundingClientRect();
    return { x: c.left + r.x + r.width / 2, y: c.top + r.y + r.height / 2 };
  }, tokenId);
  assert.ok(at, `${tokenId} stands on the board`);
  return at;
}

/** The moving marks' room (lane ISO-3): a fogged hall with a goblin that wears an aura and a ring, and Pat's Bree with a ring of her own. */
const hall = { sceneId: "", patId: "", goblin: randomUUID(), bree: randomUUID() };
const AURA = "#e5484d";

// ---------------------------------------------------------------- input (lane ISO-4)

const BREE = randomUUID();
const GRUM = randomUUID();
const FRONT = randomUUID();
const BEHIND = randomUUID();
/** View units a cell of height lifts (client/lib/view.ts K). */
const K = 0.8660254037844386;

function tokenOp(id: string, extra: Record<string, unknown>) {
  const actor = { hp: { cur: 30, max: 30, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
  return { t: "token.create", token: { id, sceneId: run.sceneId, size: "medium", visibility: "all", actor: { inline: actor }, ...extra } };
}

/**
 * The first scene as the input cases want it: fog on and all revealed, moves
 * not stopped by ledges, a 10 ft platform over cells 8 to 11 by 4 to 7, and
 * every page reopened at 40 px a cell around it.
 */
async function setUpSteps(): Promise<void> {
  const cells: string[] = [];
  for (let y = 4; y < 8; y++) for (let x = 8; x < 12; x++) cells.push(`${x},${y}`);
  await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true, blockMovement: false, defaultView: { x: 8, y: 6, zoom: 40 } } });
  await ops.send({ t: "build.height", sceneId: run.sceneId, cells, height: 10 });
  await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 20, h: 16 } }] });
  await reopenRoom(pat);
  await reopenRoom(dm);
}

/** Picks Isometric at a turn on a page, as the View menu does (relief/isoTest.ts), and waits for its board. */
async function isoOn(page: Page, turn: 0 | 1 | 2 | 3): Promise<void> {
  await page.evaluate((t) => {
    const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
    hook.pick("isometric");
    hook.turn(t);
  }, turn);
  await untilShown(page, `isometric ${turn}`);
}

/** Where a world point at a height of `z` cells shows on the page, through the isometric board's relief (relief/IsoBoard.tsx). */
function isoPoint(page: Page, p: { x: number; y: number }, z: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([p, z, k]) => {
      type Node = { getChildren(): Node[]; getAbsoluteTransform(): { point(p: { x: number; y: number }): { x: number; y: number } } };
      type Stage = Node & { width(): number; listening(): boolean; scaleY(): number; getLayers(): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } };
      const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
      // The isometric main stage: on screen, and listening, which its ground stage never does.
      const stage = konva.stages.find((s) => s.width() > 0 && s.listening() && s.getLayers().length === 3);
      if (!stage) throw new Error("no isometric board on screen");
      const ground = stage.getLayers()[0]!.getChildren()[0]!.getChildren()[0]!;
      const at = ground.getAbsoluteTransform().point(p);
      const box = stage.container().getBoundingClientRect();
      return { x: box.left + at.x, y: box.top + at.y - k * z * stage.scaleY() };
    },
    [p, z, K] as const,
  );
}

/** Where a world point shows on the page in Top-down. */
function flatPoint(page: Page, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    type Stage = { width(): number; x(): number; y(): number; scaleX(): number; container(): { getBoundingClientRect(): { left: number; top: number } } };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    const stage = konva.stages.find((s) => s.width() > 0);
    if (!stage) throw new Error("no board on screen");
    const box = stage.container().getBoundingClientRect();
    return { x: box.left + stage.x() + p.x * stage.scaleX(), y: box.top + stage.y() + p.y * stage.scaleX() };
  }, p);
}

/** The name of a token node's parent on the isometric main stage: the drag layer's ground group while a local drag moves it. */
function parentOf(page: Page, id: string): Promise<string> {
  return page.evaluate((tokenId) => {
    type Node = { getParent(): Node | null; name(): string };
    type Stage = { width(): number; listening(): boolean; getLayers(): unknown[]; findOne(s: string): Node | undefined };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    const stage = konva.stages.find((s) => s.width() > 0 && s.listening() && s.getLayers().length === 3);
    return stage?.findOne(`#${tokenId}`)?.getParent()?.name() ?? "none";
  }, id);
}

/** A one-finger drag from one page point to another, in steps a frame apart, and the dragged node's parent mid-drag and after. */
async function touchDrag(page: Page, cdp: import("playwright-core").CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, id: string): Promise<{ during: string; after: string }> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 0 }] });
  await page.waitForTimeout(50);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: 0 }] });
    await page.waitForTimeout(20);
  }
  const during = await parentOf(page, id);
  await page.waitForTimeout(200);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(300);
  return { during, after: await parentOf(page, id) };
}

describe("raccoon-vtt isometric view: the choice", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const c of [dmContext, patContext]) await c.addInitScript(OFFER);
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

  test("ISO-1. the DM's room with a second scene, Pat on a phone, and a page without the flag shows nothing of the choice", async () => {
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
    await ops.send({ t: "scene.create", scene: { id: run.secondId, name: "The crypt", bounds: { w: 20, h: 14 }, fogEnabled: false } });
    await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state);
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();

    // The same DM in a browser no test flagged, as every device is until Isometric is ready.
    const plainContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await dmContext.storageState() });
    try {
      const plain = await plainContext.newPage();
      const plainConsole = new ConsoleWatch("plain");
      plainConsole.attach(plain);
      await plain.goto(`${server.origin}/r/${run.roomId}`);
      await plain.getByRole("button", { name: "Fit the map to the screen" }).waitFor();
      assert.equal(await viewButton(plain).count(), 0, "no View button");
      await openSideTab(plain, "Scenes");
      await plain.getByRole("tabpanel", { name: "Scenes" }).getByText("Starting view").waitFor();
      assert.equal(await plain.getByRole("radiogroup", { name: "Suggested view" }).count(), 0, "no Suggested view");
      await blur(plain);
      await plain.keyboard.press("i");
      await plain.keyboard.press("e");
      await plain.waitForTimeout(300);
      assert.equal(await stored(plain, `rvtt.view.${run.roomId}`), null, "I stored no pick");
      assert.equal(await plain.locator("[data-toast]").filter({ hasText: /isometric|top-down/i }).count(), 0, "E said nothing");
      await plain.keyboard.press("?");
      const sheet = plain.getByRole("dialog", { name: /shortcuts/i });
      await sheet.waitFor();
      assert.equal(await sheet.getByText("Switch between top-down and isometric").count(), 0, "the sheet has no I");
      await plain.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached" });

      // The narrowest phone with the blackout chip overflows its row, and gives way only as it always has: Redo stays, at the 6 px gap (ISO5-OPUS-1).
      await plain.setViewportSize({ width: 320, height: 568 });
      await plain.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", "1.3"));
      await reopenRoom(plain);
      await ops.send({ t: "view.blackout", blackout: true });
      try {
        await plain.getByText("Players see black").waitFor();
        await plain.waitForTimeout(300);
        assert.equal(await plain.getByRole("button", { name: "Redo", exact: true }).count(), 1, "Redo stays in the bar");
        const gap = await plain
          .getByRole("button", { name: "Undo", exact: true })
          .evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { columnGap: string } }).getComputedStyle((el as unknown as { closest(s: string): unknown }).closest("header > div")).columnGap);
        assert.equal(gap, "6px", "the row keeps its gap");
        await shots.take(plain, "iso-plain-dm-320-130-blackout");
      } finally {
        await ops.send({ t: "view.blackout", blackout: false });
      }
      assert.deepEqual(plainConsole.errors, []);
    } finally {
      await plainContext.close();
    }
  });

  test("ISO-2. Pat's page follows the scene: Top-down, then Isometric as soon as the DM suggests it, then Top-down again", async () => {
    await untilShown(pat, "top-down");
    let menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene", checked: true }).waitFor();
    await menu.getByText("This scene suggests Top-down.").waitFor();
    assert.equal(await menu.getByRole("button", { name: "Turn right", exact: true }).count(), 0, "no turns in Top-down");
    await shots.take(pat, "iso-pat-menu-top-down");
    await closeMenu(pat, true);

    await suggest("Isometric");
    await untilShown(pat, "isometric 0");
    await said(pat, "Isometric view.");
    menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene", checked: true }).waitFor();
    await menu.getByText("This scene suggests Isometric.").waitFor();
    await shots.take(pat, "iso-pat-menu-isometric");
    await closeMenu(pat, true);
    assert.deepEqual(await stored(pat, `rvtt.view.${run.roomId}`), null, "following stores nothing");

    await suggest("Top-down");
    await untilShown(pat, "top-down");
    await said(pat, "Top-down view.");
  });

  test("ISO-3. a turn holds per scene, survives a reload, and never stops Pat following the scene", async () => {
    await suggest("Isometric");
    await untilShown(pat, "isometric 0");
    let menu = await openMenu(pat, true);
    await menu.getByRole("button", { name: "Turn right", exact: true }).tap();
    await menu.locator("[data-rvtt-view-status]").filter({ hasText: "Turned right. The map's top edge faces down and to the right." }).waitFor({ state: "attached" });
    await closeMenu(pat, true);
    await untilShown(pat, "isometric 1");
    assert.deepEqual(await stored(pat, `rvtt.view.${run.roomId}`), { v: 1, turns: { [run.sceneId]: 1 } }, "a turn alone is no pick");

    await reopenRoom(pat);
    await untilShown(pat, "isometric 1");
    menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene", checked: true }).waitFor();
    await closeMenu(pat, true);

    // The crypt suggests Isometric too, and has a turn of its own.
    await ops.send({ t: "scene.update", sceneId: run.secondId, patch: { suggestedView: "isometric" } });
    await ops.send({ t: "room.setPlayerScene", sceneId: run.secondId });
    await untilShown(pat, "isometric 0");
    menu = await openMenu(pat, true);
    await menu.getByRole("button", { name: "Turn left", exact: true }).tap();
    await closeMenu(pat, true);
    await untilShown(pat, "isometric 3");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await untilShown(pat, "isometric 1");
    assert.deepEqual(await stored(pat, `rvtt.view.${run.roomId}`), { v: 1, turns: { [run.sceneId]: 1, [run.secondId]: 3 } });

    await suggest("Top-down");
    await untilShown(pat, "top-down");
  });

  test("ISO-4. Pat's pick holds for the whole room, every scene, across a reload, until Follow the scene again", async () => {
    await suggest("Isometric");
    await untilShown(pat, "isometric 1");
    let menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Top-down" }).check();
    await closeMenu(pat, true);
    await untilShown(pat, "top-down");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.secondId });
    await waitFor("Pat on the crypt", () => (patSocket.state?.meta.playerSceneId === run.secondId ? true : null));
    await pat.waitForTimeout(300);
    await untilShown(pat, "top-down");
    await reopenRoom(pat);
    await untilShown(pat, "top-down");
    assert.equal((await stored(pat, `rvtt.view.${run.roomId}`) as { pick?: string }).pick, "topDown");

    menu = await openMenu(pat, true);
    await menu.getByRole("radio", { name: "Follow the scene" }).check();
    await menu.locator("[data-rvtt-view-status]").filter({ hasText: "Following the scene: isometric." }).waitFor({ state: "attached" });
    await closeMenu(pat, true);
    await untilShown(pat, "isometric 3");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await untilShown(pat, "isometric 1");
    await suggest("Top-down");
    await untilShown(pat, "top-down");
  });

  test("ISO-5. the DM's keys: I and E, the builder showing Top-down with its line, Isometric back with Select, and Q in Top-down saying why", async () => {
    await dm.bringToFront();
    await untilShown(dm, "top-down");
    await blur(dm);
    await dm.keyboard.press("i");
    await untilShown(dm, "isometric 0");
    await said(dm, "Isometric view.");
    await dm.keyboard.press("e");
    await untilShown(dm, "isometric 1");
    await said(dm, "Turned right. The map's top edge faces down and to the right.");

    await dm.keyboard.press("b");
    await untilShown(dm, "top-down");
    await said(dm, "The map builder works top-down. Isometric comes back when you switch tools.");
    const menu = await openMenu(dm, false);
    await menu.getByRole("radio", { name: "Isometric", checked: true }).waitFor();
    await menu.getByText("The map builder works top-down. Isometric comes back when you switch tools.").waitFor();
    // The popover keeps its turns, disabled, with the tool's line as their reason (D-261026-12).
    assert.ok(await menu.getByRole("button", { name: "Turn right", exact: true }).isDisabled(), "no turns while the builder shows Top-down");
    assert.ok((await description(menu.getByRole("button", { name: "Turn right", exact: true }))).includes("The map builder works top-down."), "the tool's line says why");
    await shots.take(dm, "iso-dm-menu-builder");
    // A pick of Top-down swaps the tool's line for the plain reason in the place the panel holds for the taller.
    const opened = await menuFoot(menu);
    await menu.getByRole("radio", { name: "Top-down", exact: true }).check();
    await menu.getByText("Turning works in Isometric.").waitFor();
    await sameFoot(menu, opened, "the builder's line, Top-down picked");
    await menu.getByRole("radio", { name: "Isometric", exact: true }).check();
    await menu.getByText("The map builder works top-down. Isometric comes back when you switch tools.").waitFor();
    await sameFoot(menu, opened, "the builder's line, Isometric picked again");
    await closeMenu(dm, false);
    await dm.keyboard.press("e");
    await dm.locator("[data-toast]").filter({ hasText: "The map builder works top-down. Isometric comes back when you switch tools." }).first().waitFor();
    await dm.keyboard.press("v");
    await untilShown(dm, "isometric 1");
    await said(dm, "Isometric view.");

    await dm.keyboard.press("q");
    await untilShown(dm, "isometric 0");
    await dm.keyboard.press("i");
    await untilShown(dm, "top-down");
    await dm.keyboard.press("q");
    await dm.locator("[data-toast]").filter({ hasText: "Turning needs the isometric view." }).first().waitFor();
    assert.deepEqual(await stored(dm, `rvtt.view.${run.roomId}`), { v: 1, pick: "topDown", turns: { [run.sceneId]: 0 } });

    // A Top-down pick keeps Top-down after the builder, so the menu promises no Isometric back (ISO5-ASTRA-03).
    await dm.keyboard.press("b");
    const flat = await openMenu(dm, false);
    await flat.getByRole("radio", { name: "Top-down", checked: true }).waitFor();
    // Its place in the popover is held, unseen and unread (ISO5-OPUS-9).
    assert.equal(await flat.getByText(/Isometric comes back/).filter({ visible: true }).count(), 0, "no promise of Isometric");
    assert.ok(!(await description(flat.getByRole("button", { name: "Turn right", exact: true }))).includes("Isometric comes back"), "nor one read with the turns");
    await closeMenu(dm, false);
    // And in the sheet a phone's layout opens.
    // Each resize waits for the room's layout to follow, or the View button pressed next is the other layout's, gone a moment later with what it opened.
    const sidePanels = dm.getByRole("tablist", { name: "Panels" });
    await dm.setViewportSize({ width: 390, height: 844 });
    try {
      await sidePanels.waitFor({ state: "hidden" });
      const sheet = await openMenu(dm, false);
      assert.equal(await sheet.getAttribute("aria-modal"), "true", "the phone's sheet, not the popover");
      await sheet.getByRole("radio", { name: "Top-down", checked: true }).waitFor();
      assert.equal(await sheet.getByText(/Isometric comes back/).count(), 0, "no promise of Isometric in the sheet");
      await closeMenu(dm, false);
    } finally {
      await dm.setViewportSize({ width: 1280, height: 800 });
      await sidePanels.waitFor();
    }
    await dm.keyboard.press("v");
  });

  test("ISO-6. the View button by keyboard: focus on the checked radio, the arrows choose, Tab reaches the turns, Escape goes back to the button", async () => {
    await viewButton(dm).focus();
    await dm.keyboard.press("Enter");
    const menu = viewMenu(dm);
    await menu.waitFor();
    await waitFor("focus on Top-down", () => dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { value?: string } | null } }).document.activeElement?.value === "topDown" || null));
    // In Top-down the turns are there, disabled, and say why: the panel has no empty band (D-261026-12).
    const left = menu.getByRole("button", { name: "Turn left", exact: true });
    assert.ok(await left.isDisabled(), "Turn left is disabled in Top-down");
    await menu.getByText("Turning works in Isometric.").waitFor();
    assert.ok((await description(left)).includes("Turning works in Isometric."), "its reason is its description");
    await shots.take(dm, "iso-dm-menu-top-down");
    const opened = await menuFoot(menu);
    await dm.keyboard.press("ArrowDown");
    await untilShown(dm, "isometric 0");
    await waitFor("Turn left enabled", async () => ((await left.isEnabled()) ? true : null));
    assert.ok(!(await menu.getByText("Turning works in Isometric.").isVisible()), "no reason shows once they turn");
    assert.ok(!(await description(left)).includes("Turning works in Isometric."), "nor describes them");
    // The popover keeps the size it opened with, and the turns' place, so they show without a scroll.
    for (const name of ["Turn left", "Turn right"]) assert.ok(await wholeInReach(menu.getByRole("button", { name, exact: true })), `${name} shows whole`);
    await sameFoot(menu, opened, "opened in Top-down, Isometric picked");
    // Named by their words, with what turns in the description (D-261026-11).
    for (const [name, says] of [
      ["Turn left", "Turn the map left"],
      ["Turn right", "Turn the map right"],
    ] as const) {
      assert.ok((await description(menu.getByRole("button", { name, exact: true }))).includes(says), `${name}'s description`);
    }
    await dm.keyboard.press("Tab");
    await waitFor("focus on Turn left", () => menu.getByRole("button", { name: "Turn left", exact: true }).evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement || null));
    await dm.keyboard.press("Enter");
    await untilShown(dm, "isometric 3");
    await shots.take(dm, "iso-dm-menu-isometric");
    await dm.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await waitFor("focus back on the View button", () => viewButton(dm).evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement || null));

    // Opened in Isometric, a pick of Top-down shows the reason whole in the same panel, with nothing to scroll.
    const again = await openMenu(dm, false);
    const fromIsometric = await menuFoot(again);
    await again.getByRole("radio", { name: "Top-down", exact: true }).check();
    await untilShown(dm, "top-down");
    const reason = again.getByText("Turning works in Isometric.");
    await reason.waitFor();
    assert.ok(await wholeInReach(reason), "the reason shows whole");
    await sameFoot(again, fromIsometric, "opened in Isometric, Top-down picked");
    await shots.take(dm, "iso-dm-menu-isometric-then-top-down");
    await again.getByRole("radio", { name: "Isometric", exact: true }).check();
    await untilShown(dm, "isometric 3");
    await closeMenu(dm, false);

    await dm.keyboard.press("?");
    const sheet = dm.getByRole("dialog", { name: /shortcuts/i });
    await sheet.waitFor();
    for (const words of ["Switch between top-down and isometric", "Turn the isometric view left", "Turn the isometric view right"]) await sheet.getByText(words, { exact: true }).waitFor();
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
  });

  test("ISO-7. View as a player keeps a view of its own: a pick and a turn there leave the DM's pick, turns and storage as they were", async () => {
    const key = `rvtt.view.${run.roomId}`;
    const before = await stored(dm, key);
    const shownBefore = await shownView(dm);
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.waitFor();
    const button = preview.getByRole("button", { name: /^View: / });
    await waitFor("the preview's View button", async () => ((await button.getAttribute("aria-label")) === "View: Top-down" ? true : null));
    await button.click();
    const menu = preview.getByRole("dialog", { name: "View" });
    await menu.waitFor();
    await menu.getByRole("radio", { name: "Follow the scene", checked: true }).waitFor();
    await menu.getByRole("radio", { name: "Isometric" }).check();
    await waitFor("the preview in Isometric", async () => ((await button.getAttribute("aria-label")) === "View: Isometric" ? true : null));
    await menu.getByRole("button", { name: "Turn right", exact: true }).click();
    await menu.locator("[data-rvtt-view-status]").filter({ hasText: "Turned right." }).waitFor({ state: "attached" });
    // Its anchor closes it, as Escape would leave the preview too.
    await button.click();
    await menu.waitFor({ state: "detached" });
    assert.deepEqual(await stored(dm, key), before, "the DM's stored view is untouched");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    assert.equal(await shownView(dm), shownBefore, "the DM's board shows what it showed");
    assert.deepEqual(await stored(dm, key), before, "and nothing was saved after");
  });

  test("ISO-8. the table display picks its own view, apart from a member's pick in the same browser, and its rows sit within 1 px at each size", async () => {
    // A display no test flagged: its menu as it always was, no View rows, no height cap (ISO5-OPUS-6).
    const plainTv = await browser.newContext({ viewport: { width: 320, height: 568 } });
    try {
      const page = await plainTv.newPage();
      await pairDisplay(page);
      const size = page.viewportSize()!;
      await page.mouse.click(size.width / 2, size.height / 2);
      const menu = page.getByRole("menu", { name: "Table display" });
      await menu.waitFor();
      assert.equal(await menu.getByRole("group", { name: "View" }).count(), 0, "no View rows");
      const cap = await menu.evaluate((el) => {
        const style = (globalThis as unknown as { getComputedStyle(e: unknown): { maxHeight: string; overflowY: string } }).getComputedStyle(el);
        return `${style.maxHeight} ${style.overflowY}`;
      });
      assert.equal(cap, "none visible", "the menu's height as it always was");
    } finally {
      await plainTv.close();
    }

    tvContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await tvContext.addInitScript(OFFER);
    tv = await tvContext.newPage();
    consoles.tv.attach(tv);
    // A member's pick in this browser, which the display must not read.
    await tv.goto(`${server.origin}/`);
    await tv.evaluate((k) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(k, '{"v":1,"pick":"isometric","turns":{}}'), `rvtt.view.${run.roomId}`);
    await pairDisplay(tv);

    const openTvMenu = async () => {
      const size = tv.viewportSize()!;
      await tv.mouse.click(size.width / 2, size.height / 2);
      const menu = tv.getByRole("menu", { name: "Table display" });
      await menu.waitFor();
      return menu;
    };
    let menu = await openTvMenu();
    const view = menu.getByRole("group", { name: "View" });
    await view.getByRole("menuitemradio", { name: "Follow the scene", checked: true }).waitFor();
    await menu.getByText("This scene suggests Top-down.").waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: "Turn right", exact: true }).count(), 0, "the display follows its Top-down scene");
    await view.getByRole("menuitemradio", { name: "Isometric" }).click();
    await menu.getByRole("menuitem", { name: "Turn right", exact: true }).click();
    await shots.take(tv, "iso-display-menu");
    assert.deepEqual(await stored(tv, `rvtt.displayView.${run.roomId}`), { v: 1, pick: "isometric", turns: { [run.sceneId]: 1 } });
    assert.deepEqual(await stored(tv, `rvtt.view.${run.roomId}`), { v: 1, pick: "isometric", turns: {} }, "the member's pick untouched");
    await view.getByRole("menuitemradio", { name: "Top-down" }).click();
    assert.equal((await stored(tv, `rvtt.view.${run.roomId}`) as { pick: string }).pick, "isometric", "the display's Top-down is its own");

    await tv.reload();
    await tv.locator(".konvajs-content").filter({ visible: true }).first().waitFor();
    menu = await openTvMenu();
    await menu.getByRole("group", { name: "View" }).getByRole("menuitemradio", { name: "Top-down", checked: true }).waitFor();
    await menu.getByRole("group", { name: "View" }).getByRole("menuitemradio", { name: "Isometric" }).click();

    const lines: string[] = [];
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      for (const scale of [1, 1.3]) {
        await tv.setViewportSize(size);
        await tv.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.displayUiScale", String(s)), scale);
        await tv.reload();
        await tv.locator(".konvajs-content").filter({ visible: true }).first().waitFor();
        menu = await openTvMenu();
        await menu.getByRole("menuitem", { name: "Turn left", exact: true }).waitFor();
        const at = `display ${size.width}x${size.height}${scale === 1 ? "" : "-130"}`;
        const found = alignmentLines(await measureAlignment(menu.getByRole("group", { name: "View" })), at);
        // "Top-down" on one line, never broken at its hyphen (ISO5-OPUS-5).
        for (const n of await menu.locator("[data-view-name]").evaluateAll((els) => els.map((el) => (el as unknown as { getClientRects(): { length: number } }).getClientRects().length))) {
          if (n !== 1) found.push(`${at}: the view's name in the help drawn over ${n} lines`);
        }
        lines.push(...found);
        if (found.length > 0) await shots.take(tv, `iso-display-${size.width}-${Math.round(scale * 100)}`);
        const box = await menu.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= size.width + 0.5 && box.y >= 0 && box.y + box.height <= size.height + 0.5, `${at}: the menu runs off the screen: ${JSON.stringify(box)}`);
        // Its last control still takes a tap, scrolled to where the menu is taller than the screen.
        const leave = menu.getByRole("menuitem", { name: "Leave" });
        await leave.scrollIntoViewIfNeeded();
        assert.ok(await wholeInReach(leave), `${at}: Leave is out of reach`);
        const frame = await menu.boundingBox();
        const last = await leave.boundingBox();
        assert.ok(frame && last && last.y + last.height <= frame.y + frame.height + 0.5, `${at}: Leave spills past the menu's frame: ${JSON.stringify([frame, last])}`);
        // A menu held to the screen stands as far from the top as from the foot (ISO5-OPUS-3).
        if (frame && (await menu.evaluate((el) => (el as unknown as { scrollHeight: number; clientHeight: number }).scrollHeight > (el as unknown as { clientHeight: number }).clientHeight + 1))) {
          const top = frame.y;
          const foot = size.height - frame.y - frame.height;
          assert.ok(Math.abs(top - foot) <= 1, `${at}: the menu stands ${top} px from the top and ${foot} px from the foot`);
        }
      }
    }
    assert.deepEqual(lines, [], "the display's View rows");
  });

  test("ISO-9. on the narrowest phone the room's menu holds View, and a widening that gives the bar its View button back closes the sheet for good", async () => {
    // As alignment-icons' iso5-a finds it: the DM at 320 x 568 and 130% folds the View button into the menu (D-261026-12).
    const phoneContext = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await dmContext.storageState() });
    await phoneContext.addInitScript(OFFER);
    try {
      const phone = await phoneContext.newPage();
      consoles.phone.attach(phone);
      await phone.goto(`${server.origin}/r/${run.roomId}`);
      await phone.evaluate(() => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.uiScale", "1.3"));
      await reopenRoom(phone);
      await phone.getByRole("button", { name: "Fit the map to the screen" }).waitFor();
      const folded = async () => ((await viewButton(phone).count()) === 0 ? true : null);
      await waitFor("the View button folded into the menu", folded);
      await phone.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
      await phone.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
      const roomMenu = phone.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
      const row = roomMenu.getByRole("button", { name: /^View/ });
      // The menu's panel loads as it opens.
      await row.waitFor();
      await row.click();
      const sheet = viewMenu(phone);
      await sheet.waitFor();
      await onCheckedRadio(phone, sheet);
      await shots.take(phone, "iso-dm-320-130-view-sheet-from-menu");

      await phone.setViewportSize({ width: 390, height: 844 });
      await viewButton(phone).waitFor();
      await sheet.waitFor({ state: "detached" });
      await phone.setViewportSize({ width: 320, height: 568 });
      await waitFor("the View button folded again", folded);
      await row.waitFor();
      // Long enough for a sheet that would open unasked to open.
      await phone.waitForTimeout(500);
      assert.equal(await sheet.count(), 0, "the View sheet stays closed (ISO5-ASTRA-04)");
      await row.click();
      await sheet.waitFor();
      await closeMenu(phone, true);
    } finally {
      await phoneContext.close();
    }
  });

  test("ISO-10. a map changed while Isometric is hidden: back in Isometric, a cell raised meanwhile draws, with no error (ISO2-OPUS-11)", async () => {
    await dm.bringToFront();
    // Counts the map bitmaps the page makes and frees, so the test knows the first is freed before it goes back.
    await dm.evaluate(() => {
      const g = globalThis as unknown as { createImageBitmap: (...a: unknown[]) => Promise<{ close(): void }>; __isoMaps?: { made: number; freed: number } };
      const maps = (g.__isoMaps = { made: 0, freed: 0 });
      const make = g.createImageBitmap.bind(g);
      g.createImageBitmap = async (...a: unknown[]) => {
        const bitmap = await make(...a);
        maps.made++;
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => {
          maps.freed++;
          close();
        };
        return bitmap;
      };
    });
    const maps = () => dm.evaluate(() => (globalThis as unknown as { __isoMaps: { made: number; freed: number } }).__isoMaps);
    const first = await uploadMap([150, 140, 120]);
    const second = await uploadMap([70, 110, 90]);
    const shownIs = (kind: string) => waitFor(`the board in ${kind}`, async () => ((await shownView(dm)).startsWith(kind) ? true : null));
    // I goes to the other view, as a DM's key does.
    const show = async (kind: "isometric" | "top-down") => {
      if (!(await shownView(dm)).startsWith(kind)) {
        await blur(dm);
        await dm.keyboard.press("i");
      }
      await shownIs(kind);
    };

    // Isometric with the first map: the board reads its tints from that bitmap.
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: first });
    await show("isometric");
    await waitFor("the first map decoded", async () => ((await maps()).made >= 1 ? true : null));
    await dm.waitForTimeout(500);
    // A height stands at this zoom (lib/view.ts STAND_MIN_PX), or no side is read.
    assert.ok((await boardScale(dm)) >= 12, "the DM's board is zoomed in far enough for heights to stand");

    // Top-down, then the second map: once it settles the first bitmap is freed, while Isometric's tree is hidden.
    await show("top-down");
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: second });
    await waitFor("the second map decoded and the first freed", async () => {
      const m = await maps();
      return m.made >= 2 && m.freed >= 1 ? true : null;
    });
    // A cell raised meanwhile, with no terrain and inside the map, so its sides read a tint no one has read yet.
    await ops.send({ t: "build.height", sceneId: run.sceneId, cells: ["3,3"], height: 10 });
    await dm.waitForTimeout(300);

    await show("isometric");
    await dm.waitForTimeout(500);
    await dm.locator(".konvajs-content").filter({ visible: true }).first().waitFor();
    assert.deepEqual(consoles.dm.errors, [], "the board drew without an error");
    await shots.take(dm, "iso-dm-map-swapped-while-hidden");

    // The room as it was, for the tests after.
    await ops.send({ t: "build.height", sceneId: run.sceneId, cells: ["3,3"], height: 0 });
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: null });
    await show("top-down");
  });

  test("ISO-11. a map removed while Pat's Isometric shows is never read again: a raised cell revealed after shows the neutral side, and the bitmap is freed (ISO2-ASTRA-10)", async () => {
    const vault = randomUUID();
    const raised = "2,2";
    await ops.send({ t: "scene.create", scene: { id: vault, name: "The vault", bounds: { w: 8, h: 6 }, fogEnabled: true } });
    await ops.send({ t: "scene.update", sceneId: vault, patch: { suggestedView: "isometric" } });
    await ops.send({ t: "build.height", sceneId: vault, cells: [raised], height: 10 });
    // Everything revealed but the raised cell, so no side of it has been read.
    await ops.send({
      t: "fog.live",
      sceneId: vault,
      ops: [
        { id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 8, h: 6 } },
        { id: randomUUID(), mode: "hide", shape: { kind: "cells", cells: [raised] } },
      ],
    });
    // Pat's page counts the map bitmaps it makes and frees, and, once watching, every draw of one.
    await pat.evaluate(() => {
      const g = globalThis as unknown as {
        createImageBitmap: (...a: unknown[]) => Promise<{ close(): void }>;
        CanvasRenderingContext2D: { prototype: { drawImage(...a: unknown[]): void } };
        __isoGone?: { made: number; freed: number; watching: boolean; drawn: number };
      };
      const gone = (g.__isoGone = { made: 0, freed: 0, watching: false, drawn: 0 });
      const bitmaps = new Set<unknown>();
      const make = g.createImageBitmap.bind(g);
      g.createImageBitmap = async (...a: unknown[]) => {
        const bitmap = await make(...a);
        gone.made++;
        bitmaps.add(bitmap);
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => {
          gone.freed++;
          close();
        };
        return bitmap;
      };
      const draw = g.CanvasRenderingContext2D.prototype.drawImage;
      g.CanvasRenderingContext2D.prototype.drawImage = function (this: unknown, ...a: unknown[]) {
        if (gone.watching && bitmaps.has(a[0])) gone.drawn++;
        return draw.apply(this, a);
      };
    });
    const gone = () => pat.evaluate(() => (globalThis as unknown as { __isoGone: { made: number; freed: number; drawn: number } }).__isoGone);
    await ops.send({ t: "scene.setMap", sceneId: vault, map: await uploadMap([150, 140, 120]) });
    await ops.send({ t: "room.setPlayerScene", sceneId: vault });
    await waitFor("Pat on the vault", () => (patSocket.state?.meta.playerSceneId === vault ? true : null));
    await waitFor("Pat's board in Isometric", async () => ((await shownView(pat)).startsWith("isometric") ? true : null));
    await waitFor("the vault's map decoded", async () => ((await gone()).made >= 1 ? true : null));
    await pat.waitForTimeout(500);
    assert.ok((await boardScale(pat)) >= 24, "Pat's board is zoomed in far enough for heights to stand, even in low power");

    await ops.send({ t: "scene.setMap", sceneId: vault, map: null });
    await waitFor("the map gone from Pat's room", () => (patSocket.state?.scenes[vault] && !patSocket.state.scenes[vault]!.map ? true : null));
    // Past the frame that stopped drawing it.
    await pat.waitForTimeout(500);
    await pat.evaluate(() => void ((globalThis as unknown as { __isoGone: { watching: boolean } }).__isoGone.watching = true));
    await ops.send({ t: "fog.live", sceneId: vault, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "cells", cells: [raised] } }] });
    await pat.waitForTimeout(800);
    assert.equal((await gone()).drawn, 0, "nothing drew or read the removed map's image");
    await waitFor("the removed map's bitmap freed, not held until the next map", async () => {
      const g = await gone();
      return g.freed >= g.made ? true : null;
    });
    assert.deepEqual(consoles.pat.errors, [], "Pat's board drew without an error");
    await shots.take(pat, "iso-pat-map-removed-cell-revealed");

    // The room as it was, for the tests after.
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await waitFor("Pat back on the first scene", () => (patSocket.state?.meta.playerSceneId === run.sceneId ? true : null));
  });

  test("ISO-30. Pat in Isometric on a fogged scene: a goblin the DM drags carries its range ring and its aura as moving marks, the aura clipped to Pat's revealed ground, and both lie on the ground again after the drop", async () => {
    hall.sceneId = randomUUID();
    const dmId = dmSocket.you!.memberId;
    hall.patId = patSocket.you!.memberId;
    await ops.send({ t: "scene.create", scene: { id: hall.sceneId, name: "The hall", bounds: { w: 16, h: 12 }, fogEnabled: true } });
    await ops.send({ t: "scene.update", sceneId: hall.sceneId, patch: { suggestedView: "isometric" } });
    // Revealed: columns 0 to 9. The goblin's aura reaches the fog past column 10.
    await ops.send({ t: "fog.live", sceneId: hall.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 10, h: 12 } }] });
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 0, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({ t: "token.create", token: { id: hall.goblin, sceneId: hall.sceneId, kind: "monster", name: "Goblin", size: "medium", x: 6, y: 5, disposition: "hostile", visibility: "all", rangeRings: [15], actor: { inline: actor } } });
    await ops.send({ t: "token.create", token: { id: hall.bree, sceneId: hall.sceneId, kind: "monster", name: "Bree", size: "medium", x: 2, y: 8, disposition: "ally", visibility: "all", ownerIds: [hall.patId], rangeRings: [10], actor: { inline: actor } } });
    await ops.send({
      t: "template.create",
      template: { id: randomUUID(), sceneId: hall.sceneId, shape: "emanation", size: 15, origin: { x: 6.5, y: 5.5, z: 0 }, yaw: 0, attachedTo: hall.goblin, includeOrigin: false, color: AURA, ownerId: dmId, visibility: "all" },
    });
    await ops.send({ t: "room.setPlayerScene", sceneId: hall.sceneId });
    await waitFor("Pat on the hall", () => (patSocket.state?.meta.playerSceneId === hall.sceneId ? true : null));
    await waitFor("Pat's board in Isometric", async () => ((await shownView(pat)).startsWith("isometric") ? true : null));
    // The DM drags in Top-down, as any DM may while a player shows Isometric.
    await dm.bringToFront();
    await openSideTab(dm, "Scenes");
    await dm.getByRole("tabpanel", { name: "Scenes" }).getByRole("button", { name: /^The hall/ }).first().click();
    await waitFor("the goblin on the DM's board", () =>
      dm.evaluate((id) => !!(globalThis as unknown as { Konva: { stages: { width(): number; findOne(s: string): unknown }[] } }).Konva.stages.find((s) => s.width() > 0 && s.findOne(`#${id}`)) || null, hall.goblin),
    );
    if (!(await shownView(dm)).startsWith("top-down")) {
      await blur(dm);
      await dm.keyboard.press("i");
    }
    await waitFor("the DM's board in Top-down", async () => ((await shownView(dm)).startsWith("top-down") ? true : null));

    let still: IsoMarks | null = null;
    await waitFor("the goblin's ring and aura on Pat's ground stage", async () => {
      still = await isoMarks(pat, AURA);
      return still && still.ground.rings >= 2 && still.ground.aura >= 1 ? true : null;
    });
    assert.equal(still!.overlay.aura, 0, "no aura moves before a drag");
    assert.ok(still!.overlay.texts.includes("15 ft"), "the ring's label stands on the overlay, above the fog as in Top-down");

    // Down on the goblin and part of the way to a new cell, held there.
    const from = await pagePoint(dm, { w: 16, h: 12 }, { x: 6.5, y: 5.5 });
    const to = await pagePoint(dm, { w: 16, h: 12 }, { x: 7.5, y: 6.5 });
    await dm.mouse.move(from.x, from.y);
    await dm.mouse.down();
    await dm.mouse.move(from.x + (to.x - from.x) * 0.2, from.y + (to.y - from.y) * 0.2, { steps: 3 });
    await dm.mouse.move(to.x, to.y, { steps: 10 });
    try {
      let moving: IsoMarks | null = null;
      await waitFor("the goblin's ring and aura moving on Pat's overlay", async () => {
        moving = await isoMarks(pat, AURA);
        return moving && moving.overlay.rings >= 1 && moving.overlay.aura >= 1 ? true : null;
      });
      // Only Bree's ring is left on the ground: the goblin's is the drag's.
      assert.equal(moving!.ground.aura, 0, "the aura left the ground stage");
      assert.equal(moving!.overlay.clipped, moving!.overlay.aura, "the aura shows only through Pat's revealed sub-cells");
      assert.ok(moving!.overlay.texts.includes("15 ft"), "the moving ring's label stands");
      await shots.take(pat, "iso-pat-goblin-dragged-ring-aura");
    } finally {
      await dm.mouse.up();
    }
    await waitFor("the goblin's ring and aura back on Pat's ground stage", async () => {
      const after = await isoMarks(pat, AURA);
      return after && after.ground.aura >= 1 && after.overlay.aura === 0 && after.overlay.rings === 0 ? true : null;
    });
  });

  test("ISO-31. Pat drags Bree in Isometric: her ring moves on the overlay with the drag and lies on the ground stage after the drop", async () => {
    await pat.bringToFront();
    const at = await standeeAt(pat, hall.bree);
    await pat.mouse.move(at.x, at.y);
    await pat.mouse.down();
    await pat.mouse.move(at.x + 20, at.y, { steps: 3 });
    await pat.mouse.move(at.x + 70, at.y + 10, { steps: 10 });
    try {
      await waitFor("Bree's ring moving on Pat's overlay", async () => {
        const m = await isoMarks(pat, AURA);
        return m && m.overlay.rings >= 1 && m.overlay.texts.includes("10 ft") ? true : null;
      });
      await shots.take(pat, "iso-pat-bree-dragged-ring");
    } finally {
      await pat.mouse.up();
    }
    await waitFor("Bree's ring back on the ground stage", async () => {
      const m = await isoMarks(pat, AURA);
      return m && m.overlay.rings === 0 && m.ground.rings >= 2 ? true : null;
    });
  });

  test("ISO-32. Pat measures in Isometric: the ruler's line and its distance draw in the drag layer, the distance standing upright", async () => {
    await pickTool(pat, "Ruler");
    const cam = await isoCamera(pat);
    // Empty ground near the scene's middle, between the two creatures.
    const a = { x: cam.left + cam.x + 0 * cam.scale, y: cam.top + cam.y + 5 * cam.scale };
    const b = { x: a.x + 3 * cam.scale, y: a.y + 1 * cam.scale };
    await pat.mouse.move(a.x, a.y);
    await pat.mouse.down();
    await pat.mouse.move(b.x, b.y, { steps: 12 });
    try {
      let m: IsoMarks | null = null;
      await waitFor("the ruler's distance in Pat's drag layer", async () => {
        m = await isoMarks(pat, AURA);
        return m && m.drag.texts.some((t) => / ft$/.test(t)) ? true : null;
      });
      assert.ok(m!.drag.uprightTexts.some((t) => / ft$/.test(t)), "the distance stands upright, not turned into the ground");
      assert.ok(!m!.ground.texts.some((t) => / ft$/.test(t)), "nothing of the ruler draws on the ground stage");
      await shots.take(pat, "iso-pat-ruler");
    } finally {
      await pat.mouse.up();
    }
    await pickTool(pat, "Select");
  });

  test("ISO-33. Pat holds to ping in Isometric: the DM gets the ground point the press means, and Pat's drag layer draws the ping", async () => {
    const cam = await isoCamera(pat);
    const turn = Number((await shownView(pat)).split(" ")[1]) as Turn;
    // Empty, flat ground: what the press means is the ground under it at 0.
    const screen = { x: cam.x + 1 * cam.scale, y: cam.y + 6 * cam.scale };
    const want = toWorld(isometric(turn), { x: (screen.x - cam.x) / cam.scale, y: (screen.y - cam.y) / cam.scale } as ViewPoint);
    const seen = dmSocket.received.length;
    await pat.mouse.move(cam.left + screen.x, cam.top + screen.y);
    await pat.mouse.down();
    await pat.waitForTimeout(800);
    await pat.mouse.up();
    const ping = await waitFor("the DM's ping from Pat", () => {
      for (const f of dmSocket.received.slice(seen)) {
        const msg = JSON.parse(f) as { t?: string; from?: string; e?: { k?: string; x?: number; y?: number } };
        if (msg.t === "eph" && msg.e?.k === "ping" && msg.from === hall.patId) return { x: msg.e.x!, y: msg.e.y! };
      }
      return null;
    });
    assert.ok(Math.abs(ping.x - want.x) < 0.05 && Math.abs(ping.y - want.y) < 0.05, `pinged at ${ping.x}, ${ping.y}, the press meant ${want.x}, ${want.y}`);
    await waitFor("the ping's rings in Pat's drag layer", async () => {
      const m = await isoMarks(pat, AURA);
      return m && m.drag.circles >= 2 ? true : null;
    });
    await shots.take(pat, "iso-pat-ping");
    // The room as it was, for the tests after.
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await waitFor("Pat back on the first scene", () => (patSocket.state?.meta.playerSceneId === run.sceneId ? true : null));
  });

  // ---------------------------------------------------------------- input (lane ISO-4, docs/design-v1-isometric-view.md 6)

  test("ISO-40. Pat drags in Isometric: up a revealed platform to its top at 10 ft, and a Large across a ledge stays under the finger, each moving in the drag layer", async () => {
    const patId = patSocket.you!.memberId;
    await setUpSteps();
    await ops.send(tokenOp(BREE, { kind: "npc", name: "Bree", x: 3, y: 5, ownerIds: [patId], disposition: "ally" }));
    await ops.send(tokenOp(GRUM, { kind: "npc", name: "Grum", size: "large", x: 9, y: 10, ownerIds: [patId], disposition: "ally" }));
    await waitFor("Bree and Grum on Pat's page", () => (patSocket.state?.tokens[BREE] && patSocket.state.tokens[GRUM] ? true : null));
    await isoOn(pat, 0);
    await pat.waitForTimeout(400);
    assert.ok((await boardScale(pat)) >= 24, "heights stand at Pat's zoom");

    const cdp = await patContext.newCDPSession(pat);
    try {
      // The ring's middle to the platform's top cell (9, 5), 10 ft up.
      const layers = await touchDrag(pat, cdp, await isoPoint(pat, { x: 3.5, y: 5.5 }, 0), await isoPoint(pat, { x: 9.5, y: 5.5 }, 2), BREE);
      assert.equal(layers.during, "dragGround", "mid-drag the standee draws in the drag layer");
      assert.notEqual(layers.after, "dragGround", "after the drop it is back among the relief's pieces");
      await waitFor("Bree on the platform", () => {
        const t = dmSocket.state?.tokens[BREE];
        return t && t.x === 9 && t.y === 5 && t.elevation === 10 ? true : null;
      });
      await shots.take(pat, "iso-40-pat-walker-on-platform");

      // Grum's ring to just short of the ledge at x = 8: half its footprint on the 10 ft side.
      await touchDrag(pat, cdp, await isoPoint(pat, { x: 10, y: 11 }, 0), await isoPoint(pat, { x: 7.9, y: 6 }, 2), GRUM);
      await waitFor("Grum across the ledge at 10 ft", () => {
        const t = dmSocket.state?.tokens[GRUM];
        return t && t.x === 7 && t.y === 5 && t.elevation === 10 ? true : null;
      });
      await shots.take(pat, "iso-40-pat-large-across-ledge");
    } finally {
      await cdp.detach();
    }
  });

  test("ISO-41. a tap again on the DM's standee picks the one behind it, front to back and round again", async () => {
    await dm.bringToFront();
    await ops.send(tokenOp(FRONT, { kind: "monster", name: "Front", x: 13, y: 9, disposition: "hostile" }));
    await ops.send(tokenOp(BEHIND, { kind: "monster", name: "Behind", x: 12, y: 8, disposition: "hostile" }));
    await waitFor("both on the DM's page", () => (dmSocket.state?.tokens[FRONT] && dmSocket.state.tokens[BEHIND] ? true : null));
    await isoOn(dm, 0);
    await blur(dm);
    await dm.keyboard.press("Escape");
    await dm.waitForTimeout(400);
    // At turn 0 the front one's art rises over the ring of the one behind: a press there hits both.
    const both = await isoPoint(dm, { x: 12.5 + 0.1, y: 8.5 + 0.1 }, 0);
    const bar = (name: string) => dm.getByRole("dialog", { name: `${name} actions` });
    await dm.mouse.click(both.x, both.y);
    await bar("Front").waitFor();
    await dm.mouse.click(both.x, both.y);
    await bar("Behind").waitFor();
    await shots.take(dm, "iso-41-dm-tap-again-behind");
    await dm.mouse.click(both.x, both.y);
    await bar("Front").waitFor();
    await dm.keyboard.press("Escape");
  });

  test("ISO-42. Pat's arrow keys move Bree by the screen at each turn: Up is north, west, south, then east", async () => {
    await pat.bringToFront();
    // Down off the platform onto open ground near the middle, in view at every turn, and Grum out of the way, so no art stands over Bree's.
    await pat.keyboard.press("Escape");
    await ops.send({ t: "token.move", tokenId: GRUM, x: 17, y: 13, elevation: 0 });
    await ops.send({ t: "token.move", tokenId: BREE, x: 6, y: 9, elevation: 0 });
    await waitFor("Bree on open ground", () => (patSocket.state?.tokens[BREE]?.x === 6 && patSocket.state.tokens[BREE]!.elevation === 0 ? true : null));
    const expected = [
      { dx: 0, dy: -1 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 0 },
    ];
    for (const [turn, step] of expected.entries()) {
      await isoOn(pat, turn as 0 | 1 | 2 | 3);
      await pat.waitForTimeout(200);
      const at = await isoPoint(pat, { x: patSocket.state!.tokens[BREE]!.x + 0.5, y: patSocket.state!.tokens[BREE]!.y + 0.5 }, 0);
      await pat.touchscreen.tap(at.x, at.y - 10);
      await shots.take(pat, `iso-42-pat-turn-${turn}-tapped`);
      await pat.getByRole("dialog", { name: "Bree actions" }).waitFor({ timeout: 5000 });
      const before = { ...dmSocket.state!.tokens[BREE]! };
      await blur(pat);
      await pat.keyboard.press("ArrowUp");
      await waitFor(`turn ${turn}: Bree moved`, () => {
        const t = dmSocket.state?.tokens[BREE];
        return t && (t.x !== before.x || t.y !== before.y) ? t : null;
      });
      const t = dmSocket.state!.tokens[BREE]!;
      assert.deepEqual({ dx: t.x - before.x, dy: t.y - before.y }, step, `turn ${turn}`);
      await pat.keyboard.press("Escape");
    }
  });

  test("ISO-43. the DM's builder shows Top-down centered on the selected token and comes back to Isometric with it in place", async () => {
    await dm.bringToFront();
    await isoOn(dm, 1);
    await dm.waitForTimeout(300);
    const at = await isoPoint(dm, { x: 13.5, y: 9.5 }, 0);
    await dm.mouse.click(at.x, at.y - 8);
    await dm.getByRole("dialog", { name: "Front actions" }).waitFor();
    const ring = await isoPoint(dm, { x: 13.5, y: 9.5 }, 0);
    await blur(dm);
    await dm.keyboard.press("b");
    await untilShown(dm, "top-down");
    await dm.waitForTimeout(300);
    const flat = await flatPoint(dm, { x: 13.5, y: 9.5 });
    assert.ok(Math.hypot(flat.x - ring.x, flat.y - ring.y) <= 1, `the builder's Top-down keeps the token where it was: ${JSON.stringify([ring, flat])}`);
    await shots.take(dm, "iso-43-dm-builder-top-down");
    await dm.keyboard.press("v");
    await untilShown(dm, "isometric 1");
    await dm.waitForTimeout(300);
    const back = await isoPoint(dm, { x: 13.5, y: 9.5 }, 0);
    assert.ok(Math.hypot(back.x - ring.x, back.y - ring.y) <= 1, `back in Isometric it stands where it was: ${JSON.stringify([ring, back])}`);
    await dm.keyboard.press("Escape");
  });

  test("ISO-44. a label on the platform tapped with Select in Isometric opens its pane by the label as drawn", async () => {
    await dm.bringToFront();
    const labelId = randomUUID();
    await ops.send({ t: "build.label", sceneId: run.sceneId, labelId, label: { x: 10.5, y: 6.5, text: "Altar", size: 1 } });
    await waitFor("the label on the DM's page", () => (dmSocket.state?.labels[labelId] ? true : null));
    await isoOn(dm, 0);
    await dm.waitForTimeout(300);
    // The text stands on its anchor on the 10 ft top: its middle is half a text height above it.
    const foot = await isoPoint(dm, { x: 10.5, y: 6.5 }, 2);
    const scale = await boardScale(dm);
    await dm.mouse.click(foot.x, foot.y - 0.5 * scale);
    const pane = dm.getByRole("dialog", { name: "Edit label" });
    await pane.waitFor();
    const box = await pane.boundingBox();
    assert.ok(box && box.x <= foot.x + 1 && box.x + box.width >= foot.x - 1, `the pane stands by the label: ${JSON.stringify([box, foot])}`);
    await shots.take(dm, "iso-44-dm-label-pane");
    await dm.keyboard.press("Escape");
    await ops.send({ t: "build.label", sceneId: run.sceneId, labelId, label: null });
  });

  test("ISO-45. a held ruler keeps Pat's view through a new suggestion, which follows once the finger lifts", async () => {
    await pat.bringToFront();
    await pat.evaluate(() => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick("follow"));
    await suggest("Isometric");
    await waitFor("Pat following into Isometric", async () => ((await shownView(pat)).startsWith("isometric") ? true : null));
    const following = await shownView(pat);
    await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Ruler/ }).tap();
    const cdp = await patContext.newCDPSession(pat);
    try {
      // The board's middle, on screen at any turn.
      const board = await pat.locator(".konvajs-content").filter({ visible: true }).first().boundingBox();
      assert.ok(board, "the board on screen");
      const from = { x: board.x + board.width / 2, y: board.y + board.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 0 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + 40, y: from.y + 10, id: 0 }] });
      await suggest("Top-down");
      await pat.waitForTimeout(600);
      assert.equal(await shownView(pat), following, "the view waits for the finger");
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await untilShown(pat, "top-down");
    } finally {
      await cdp.detach();
    }
    await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Select/ }).tap();
    await suggest("Top-down");
  });

  test("ISO-12. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s page`);
  });
});
