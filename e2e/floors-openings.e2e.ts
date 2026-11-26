import assert from "node:assert/strict";
import { uuidv7 } from "#shared/ids.ts";
import type { FloorLink, RoomState, Token } from "#shared/model.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { FALL_CARD_ATTR, LINK_PANE_ATTR, TRAP_INTO_ATTR } from "../client/features/floors/ids.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { ConsoleWatch, dragCells, expandBar, OpSocket, openSideTab, pagePoint, pickOption, pickTool, Shots, sideTabName, SocketWatch, sleep, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";

/**
 * Openings between floors, falls and their cards, Fly up and Fly down, a
 * trapdoor and hidden stairs (docs/design/design-v1-floors.md phase 4), on
 * the real server serving the production build. Dana the DM is at a desk,
 * Ana plays Thorn on a phone, and Bree plays Bree at a desk. Tower has
 * Ground floor (the players' start) and Upper floor, 10 ft above it, and
 * Cave is a scene of its own. Labels carry the prefix FL4O.
 * - fl4o-0: the room, its floors and its creatures: Thorn, Bree and a rat
 *   on Upper floor, a goblin on Ground floor under where the hole goes, and
 *   a bat flying 5 ft up on Upper floor.
 * - fl4o-1: the DM's Between floors offers Opening, whose hint says so, and
 *   a drag places a 2 by 2 opening on Upper floor down to Ground floor and
 *   opens its pane, titled "Opening down to Ground floor", with no Kind,
 *   Locked or Hidden and focus on Go to. Kind and the pane in line at 1440
 *   x 900, 390 x 844 and 320 x 568, at 100% and 130%.
 * - fl4o-2: the board: the DM's hole reads "Down to Ground floor" under its
 *   rim with "10 ft down" over it, its lower end "Up to Upper floor", and
 *   the hole draws the floor below, the goblin in it. Ana, who holds both
 *   floors and sees the far end with the fog off, reads the same name and
 *   chip.
 * - fl4o-3: Bree drags Bree over the hole: the drag reads "Falls to Ground
 *   floor", the drop lands her below, her desk follows and says "Bree fell
 *   to Ground floor. Showing Ground floor.", and the DM gets "Bree fell 10
 *   ft to Ground floor." with Show.
 * - fl4o-4: the DM's desk holds the card, a region "Fall: Bree" reading
 *   "Bree fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.", in line at
 *   the three sizes and both scales. Apply opens the group save on Ground
 *   floor with no save, its Apply hurts Bree, lays her Prone and removes the
 *   card.
 * - fl4o-5: a fall on a scene the DM is not showing toasts "A creature
 *   fell 10 ft to Ground floor on Tower." with Show, which goes there, and
 *   the card then names the rat and is dismissed.
 * - LP46FIX-1: a pony with a kobold riding it walks onto the hole, and the
 *   card naming both applies: Apply's group save hurts both and removes the
 *   card, where it once refused with "This save's choices could not be
 *   kept."
 * - LP46FIX-3: four creatures that fall in one op toast once, "4
 *   creatures fell to Ground floor.", in line on a 390 x 844 phone at 100%
 *   and 130%.
 * - s67-1: both tokens of Shade, the DM's character, stand on Upper floor
 *   where the DM places an opening under them: one toast, one card naming
 *   Shade once, "fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.", the
 *   card and the fall's group save page in line at the three sizes and both
 *   scales, and Apply hurts Shade once, lays Shade Prone once and removes
 *   the card, both tokens settled.
 * - fl4o-6: the bat in the air over the hole: its bar leads with Fly down,
 *   named "Fly down to Ground floor" and tipped "Fly down to Ground floor
 *   ({)", in line at the three sizes and both scales. { flies it down to 5
 *   ft over Ground floor's ground and } flies it back up.
 * - fl4o-7: a pit trap on Upper floor gets Into, A pit or Ground floor, in
 *   line, and Ground floor makes it a trapdoor with its help. Its public
 *   springing drops the goblin standing on it to Ground floor with a card.
 *   LP46FIX-2: made from Hidden Pit, picking Ground floor takes the pit's
 *   1d6 and its pit words off the trap, since the fall card asks the
 *   drop's, so its springing leaves the fall card alone, with no trap card.
 * - fl4o-8: hidden stairs: the pane's Hidden from players hides both ends,
 *   the DM's name adds "Hidden", and Bree gets nothing of them.
 * - fl4o-9: the window's memory: four floors with four openings each over
 *   mapped floors, and Ana's phone switching 20 times among them, its heap
 *   within 10% over the last 10.
 * - FLR4R1-1: a second hole on Upper floor over a two-colored map on Ground
 *   floor: the window shows the map's blue half, and a calibration that
 *   shifts the map, the same image on the same bounds, turns the window red
 *   while it stays shown.
 * - FLR4R1-2: fog on Ground floor, hidden but for the hole's west column:
 *   the DM's window keeps the map in the revealed squares as it drew them
 *   with the fog off, and draws the fog over the rest.
 * - lp50fix-1: Nave, a hole down to Undercroft, a pit beside it and stairs
 *   up to Belfry beside the pit: on the DM's phone the pit's name keeps off
 *   the stairs' frame, and the stairs' name off the pit's squares, measured
 *   on the page from the pills Konva draws and the cells' page points.
 *   QF-ASTRA-02: then in Isometric at each turn the pit's name keeps off the
 *   frames of the stairs and the hole at every turn (over its own squares where no spot on its edges is clear), measured against the frames' corners
 *   where the ground plane puts them on the page.
 * - fl4o-10: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seventy-one, one file after
 * another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 71;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-openings-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const SMALL = { width: 320, height: 568 };
const SIZES = [DESK, PHONE, SMALL] as const;
const SCALES = [1, 1.3] as const;
const BOUNDS = { w: 24, h: 14 };
const TOOL = "Map builder";
/** The hole on Upper floor and its lower end on Ground floor: 2 by 2. */
const HOLE = { x: 8, y: 4, w: 2, h: 2 };
/** Where Thorn, Bree and the rat stand on Upper floor, clear of the hole. */
const THORN_AT = { x: 4, y: 4 };
const BREE_AT = { x: 4, y: 8 };
const RAT_AT = { x: 12, y: 8 };
/** The trapdoor's squares on Upper floor. */
const TRAPDOOR = { x: 16, y: 4, w: 2, h: 2 };
/** The hidden stairs' square on Ground floor and Upper floor. */
const STAIRS = { x: 20, y: 10 };
/** Where the DM places an opening under both of Shade's tokens on Upper floor, clear of every other end and creature. */
const SHADE_HOLE = { x: 4, y: 11, w: 2, h: 2 };
/** A second hole on Upper floor, clear of every end on both floors, for the window's own steps. */
const WINDOW_HOLE = { x: 16, y: 10, w: 2, h: 2 };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let breeContext: BrowserContext;
let dm: Page;
let ana: Page;
let bree: Page;
let ops: OpSocket;
let breeOps: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const breeSocket = new SocketWatch("bree");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), bree: new ConsoleWatch("bree") };

const run = {
  roomId: "",
  roomName: `E2E floors openings ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  ground: "",
  upper: uuidv7(),
  cave: uuidv7(),
  anaId: "",
  breeId: "",
  thorn: uuidv7(),
  breeCharacter: uuidv7(),
  tThorn: uuidv7(),
  tBree: uuidv7(),
  goblin: uuidv7(),
  goblin2: uuidv7(),
  rat: uuidv7(),
  bat: uuidv7(),
  pony: uuidv7(),
  kobold: uuidv7(),
  shade: uuidv7(),
  shade1: uuidv7(),
  shade2: uuidv7(),
  shadeHole: uuidv7(),
  shadeHoleBelow: uuidv7(),
  trapdoor: uuidv7(),
  hole: "",
  holeBelow: "",
  stairsDown: uuidv7(),
  stairsUp: uuidv7(),
};

const HP = 30;

function actor(hp: number, fly = 0) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30, ...(fly > 0 ? { fly } : {}) }, initBonus: 1, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

function cookieOf(context: BrowserContext): Promise<string> {
  return context.cookies(server.origin).then((list) => list.map((c) => `${c.name}=${c.value}`).join("; "));
}

async function openRoom(page: Page, watch: ConsoleWatch, socket: SocketWatch): Promise<void> {
  // A first visit asks for the member before the session cookie is read, which answers 403 once.
  watch.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor(`${watch.label}'s snapshot`, () => socket.state);
  watch.allow = [];
}

/** A plain map image of the room's, `w` by `h` px in one color, through the asset route. */
async function uploadImage(w: number, h: number, background: { r: number; g: number; b: number }): Promise<{ id: string; width: number; height: number }> {
  const data = await sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the image upload answered ${res.status()}`);
  return (await res.json()) as { id: string; width: number; height: number };
}

/** A map image of the room's, 1920 by 1120 px, red on its left half and blue on its right, through the asset route. */
async function uploadSplitImage(): Promise<{ id: string; width: number; height: number }> {
  const red = await sharp({ create: { width: 960, height: 1120, channels: 3, background: { r: 220, g: 40, b: 40 } } }).png().toBuffer();
  const data = await sharp({ create: { width: 1920, height: 1120, channels: 3, background: { r: 40, g: 40, b: 220 } } }).composite([{ input: red, left: 0, top: 0 }]).png().toBuffer();
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the image upload answered ${res.status()}`);
  return (await res.json()) as { id: string; width: number; height: number };
}

function imageMap(image: { id: string; width: number; height: number }) {
  return { assetId: image.id, widthPx: image.width, heightPx: image.height, cellPx: image.width / BOUNDS.w, originPx: { x: 0, y: 0 } };
}

const state = (socket: SocketWatch = dmSocket) => socket.state as RoomState | null;
const tokenOf = (id: string, socket: SocketWatch = dmSocket): Token | undefined => state(socket)?.tokens[id];
const topBar = (page: Page) => page.locator("header[data-rvtt-topbar]").first();
const said = (page: Page, words: string) => page.locator("[data-rvtt-view-status]").filter({ hasText: words }).first();
const toast = (page: Page, words: string) => page.locator("[data-toast]").filter({ hasText: words }).first();
const barOf = (page: Page, name: string) => page.getByRole("dialog", { name: `${name} actions`, exact: true });
const climbButton = (scope: Page | Locator, dir: "up" | "down") => scope.locator(`[data-climb="${dir}"]:visible`).first();
const linkPane = (page: Page) => page.locator(`[${LINK_PANE_ATTR}]`);
const optionsBar = (page: Page) => page.getByRole("toolbar", { name: `${TOOL} options` });
const fallCard = (page: Page, id?: string) => page.locator(id ? `[${FALL_CARD_ATTR}="${id}"]` : `[${FALL_CARD_ATTR}]`).first();

/** The floor a page shows, by its Floor button's name. */
async function showsFloor(page: Page, floor: string, what = `${floor} shown`): Promise<void> {
  const name = `Floor: ${floor}. Show another floor`;
  await waitFor(what, async () => ((await topBar(page).locator('[data-floors="button"]').getAttribute("aria-label").catch(() => null)) === name ? true : null), 15_000);
}

async function keyOn(page: Page, key: string): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
  await page.keyboard.press(key);
}

/**
 * Shows a page a floor of Tower by its floor keys, from whichever it shows.
 * Once the opening is placed, the board's own marks tell the floor, since a
 * narrow top bar folds its Floor button into the menu.
 */
async function showFloor(page: Page, floor: "Ground floor" | "Upper floor"): Promise<void> {
  const mark = floor === "Upper floor" ? run.hole : run.holeBelow;
  const shown = async () => {
    if (mark) return (await boardLinks(page))[mark] !== undefined;
    return ((await topBar(page).locator('[data-floors="button"]').getAttribute("aria-label").catch(() => null)) ?? "").startsWith(`Floor: ${floor}.`);
  };
  await sleep(300);
  if (await shown()) return;
  await keyOn(page, floor === "Upper floor" ? "]" : "[");
  await waitFor(`${floor} shown`, async () => ((await shown()) ? true : null));
}

/** Each end the board draws on the floor shown, by id, with its name pill's words and its chip's (LinkLayer.tsx). */
function boardLinks(page: Page): Promise<Record<string, { name: string; chip: string | null }>> {
  return page.evaluate(() => {
    type Node = { getAttr(name: string): unknown };
    type Stage = { width(): number; find(match: (n: Node) => boolean): Node[] };
    const stages = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.filter((s) => s.width() > 0);
    const out: Record<string, { name: string; chip: string | null }> = {};
    for (const stage of stages)
      for (const n of stage.find((node) => node.getAttr("data-floor-link") !== undefined)) {
        const chip = n.getAttr("data-floor-link-chip");
        out[String(n.getAttr("data-floor-link"))] = { name: String(n.getAttr("data-floor-link-name") ?? ""), chip: chip === undefined ? null : String(chip) };
      }
    return out;
  });
}

/** The texts on the map's canvas, a drag's label among them. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages.flatMap((s) => s.find("Text")).filter((t) => t.isVisible()).map((t) => t.text());
  });
}

/** The strongest color drawn at a square's center across the map's canvases, as r, g, b, or null where nothing is drawn. */
async function colorAt(page: Page, cell: { x: number; y: number }): Promise<[number, number, number] | null> {
  const p = await pagePoint(page, BOUNDS, { x: cell.x + 0.5, y: cell.y + 0.5 });
  return page.evaluate(([x, y]) => {
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { left: number; top: number; width: number; height: number }; width: number; height: number; getContext(k: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null }> } }).document;
    let top: [number, number, number] | null = null;
    for (const canvas of Array.from(doc.querySelectorAll(".konvajs-content canvas"))) {
      const r = canvas.getBoundingClientRect();
      const d = canvas.getContext("2d")?.getImageData(Math.round(((x! - r.left) / r.width) * canvas.width), Math.round(((y! - r.top) / r.height) * canvas.height), 1, 1).data;
      if (d && d[3]! > 200) top = [d[0]!, d[1]!, d[2]!];
    }
    return top;
  }, [p.x, p.y] as const);
}

/** Lets go of whatever a page has selected, by Escape on the map. */
async function deselect(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.getByRole("dialog", { name: /actions$/ }).count()) > 0; i++) await keyOn(page, "Escape");
}

/** Sets a page's size and interface scale and reloads it. */
async function sizeTo(page: Page, size: { width: number; height: number }, scale: number): Promise<void> {
  await page.setViewportSize(size);
  await page.evaluate((s) => localStorage.setItem("rvtt.uiScale", String(s)), scale);
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  await sleep(800);
}

/** The page back at a desk at 100%. */
async function deskAgain(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
  await page.setViewportSize(DESK);
  await page.reload();
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
}

const at = (size: { width: number; height: number }, scale: number) => `${size.width}x${size.height}${scale === 1 ? "" : "-130"}`;

describe("openings between floors, falls, Fly up and Fly down, a trapdoor and hidden stairs", { concurrency: false, timeout: 1_400_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    await dmContext.addInitScript("globalThis.__rvttIsoTest = true;");
    anaContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    breeContext = await browser.newContext({ viewport: DESK });
    dm = await dmContext.newPage();
    ana = await anaContext.newPage();
    bree = await breeContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    consoles.bree.attach(bree);
    await dmSocket.attach(dmContext, dm);
    await anaSocket.attach(anaContext, ana);
    await breeSocket.attach(breeContext, bree);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of Object.values(consoles)) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
      console.error(server?.output().split("\n").slice(-40).join("\n"));
    }
    ops?.close();
    breeOps?.close();
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

  test("fl4o-0. a room with Tower's two floors and Cave, Thorn, Bree and a rat on Upper floor, a goblin on Ground floor and a bat flying on Upper floor", async () => {
    await dm.goto(`${server.origin}/`);
    await dm.getByLabel("Room name").fill(run.roomName);
    await dm.getByLabel("Your name").fill("Dana the DM");
    run.password = await dm.getByLabel("Player password").inputValue();
    await dm.getByRole("button", { name: "Create room" }).click();
    await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await dm.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=(.+)$/.exec(link);
    assert.ok(match, `DM link looks wrong: ${link}`);
    run.roomId = match[1]!.replace("-", "");
    await dm.getByLabel("I saved my DM link").check();
    await dm.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.ground = dmSocket.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });
    run.anaId = await join(anaContext, "Ana", "#30a46c");
    run.breeId = await join(breeContext, "Bree", "#e5484d");
    breeOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(breeContext) });

    // Fog off on both floors, so the window and the drag read what stands there without the party having explored it first.
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower", bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "above", besideName: "Ground floor" } });
    await ops.send({ t: "scene.update", sceneId: run.upper, patch: { floor: { name: "Upper floor", height: 10 }, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.cave, name: "Cave", bounds: BOUNDS } });
    await ops.send({ t: "character.create", character: { id: run.thorn, name: "Thorn", size: "medium", ownerIds: [run.anaId], actor: actor(HP) } });
    await ops.send({ t: "character.create", character: { id: run.breeCharacter, name: "Bree", size: "medium", ownerIds: [run.breeId], actor: actor(HP) } });
    const shown = { size: "medium", visibility: "all" } as const;
    await ops.send({ t: "token.create", token: { id: run.tThorn, sceneId: run.upper, kind: "pc", name: "Thorn", ownerIds: [run.anaId], actor: { ref: run.thorn }, disposition: "ally", ...THORN_AT, ...shown } });
    await ops.send({ t: "token.create", token: { id: run.tBree, sceneId: run.upper, kind: "pc", name: "Bree", ownerIds: [run.breeId], actor: { ref: run.breeCharacter }, disposition: "ally", ...BREE_AT, ...shown } });
    await ops.send({ t: "token.create", token: { id: run.rat, sceneId: run.upper, kind: "monster", name: "Rat", disposition: "hostile", actor: { inline: actor(HP) }, ...RAT_AT, ...shown, size: "small" } });
    await ops.send({ t: "token.create", token: { id: run.goblin, sceneId: run.ground, kind: "monster", name: "Goblin", disposition: "hostile", actor: { inline: actor(HP) }, x: HOLE.x, y: HOLE.y, ...shown } });
    await ops.send({ t: "token.create", token: { id: run.bat, sceneId: run.upper, kind: "monster", name: "Bat", disposition: "neutral", actor: { inline: actor(HP, 30) }, x: HOLE.x + 1, y: HOLE.y + 1, elevation: 5, ...shown, size: "small" } });
    // The party stands on Upper floor, and Ground floor is where players start, so both are open to them.
    await ops.send({ t: "floor.open", sceneId: run.upper, open: true });
    await waitFor("five creatures in the DM's copy", () => (Object.keys(dmSocket.state?.tokens ?? {}).length === 5 ? true : null));
    await openRoom(ana, consoles.ana, anaSocket);
    await openRoom(bree, consoles.bree, breeSocket);
  });

  test("fl4o-1. Between floors offers Opening: a drag places a 2 by 2 hole on Upper floor and opens its pane with no Kind, Locked or Hidden, focus on Go to, Kind and the pane in line", async () => {
    await showFloor(dm, "Upper floor");
    await pickTool(dm, TOOL);
    await pickOption(dm, TOOL, "Builder mode", "Between floors");
    await pickOption(dm, TOOL, "Kind", "Opening");
    await optionsBar(dm).getByRole("button", { name: "Kind: Opening" }).waitFor();
    assert.equal((await dm.locator('[data-options-line="shown"]').first().innerText()).replace(/\s+/g, " ").trim(), "Drag over squares to place an opening.");
    await pickOption(dm, TOOL, "To", "Down to Ground floor");
    await dragCells(dm, BOUNDS, { x: HOLE.x, y: HOLE.y }, { x: HOLE.x + HOLE.w - 1, y: HOLE.y + HOLE.h - 1 });
    const placed = await waitFor("an opening's two ends", () => {
      const ends = Object.values(state()?.floorLinks ?? {}).filter((l): l is FloorLink => l !== undefined && l.kind === "opening");
      return ends.length === 2 ? ends : null;
    });
    const hole = placed.find((l) => l.sceneId === run.upper)!;
    const below = placed.find((l) => l.sceneId === run.ground)!;
    run.hole = hole.id;
    run.holeBelow = below.id;
    assert.deepEqual([hole.rect, below.rect], [HOLE, HOLE], "one rect on both floors");
    const pane = linkPane(dm);
    await pane.getByRole("heading", { name: "Opening down to Ground floor" }).waitFor();
    assert.equal(await pane.getAttribute("aria-label"), "Edit opening");
    assert.equal(await pane.getByRole("radiogroup", { name: "Kind" }).count(), 0, "an opening's pane has no Kind");
    assert.equal(await pane.getByRole("switch", { name: "Locked" }).count(), 0, "nor Locked");
    assert.equal(await pane.getByRole("switch", { name: "Hidden from players" }).count(), 0, "nor Hidden");
    await waitFor("focus on Go to", async () => ((await dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { textContent: string | null } | null } }).document.activeElement?.textContent ?? "")) === "Go to Ground floor" ? true : null), 5_000);
    await shots.take(dm, "fl4o-1-pane-opening");

    const lines: string[] = [];
    try {
      for (const size of SIZES) {
        for (const scale of SCALES) {
          await sizeTo(dm, size, scale);
          await showFloor(dm, "Upper floor");
          await pickTool(dm, TOOL);
          await pickOption(dm, TOOL, "Builder mode", "Between floors");
          const kind = optionsBar(dm);
          await kind.waitFor();
          lines.push(...alignmentLines(await measureAlignment(kind), `${at(size, scale)} the builder's row with Kind: Opening`));
          await tapCell(dm, BOUNDS, { x: HOLE.x, y: HOLE.y });
          await linkPane(dm).getByRole("heading", { name: "Opening down to Ground floor" }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(linkPane(dm)), `${at(size, scale)} the opening's pane`));
          await shots.take(dm, `fl4o-1-pane-${at(size, scale)}`);
          await keyOn(dm, "Escape");
          await linkPane(dm).waitFor({ state: "detached" });
        }
      }
    } finally {
      await deskAgain(dm);
    }
    assert.deepEqual(lines, [], "Kind or the opening's pane out of line");
    await pickTool(dm, "Select");
  });

  test("fl4o-2. the DM's hole names the floor below under its rim with 10 ft down over it and draws the goblin there, and Ana reads the same", async () => {
    await showFloor(dm, "Upper floor");
    await waitFor("the hole's name and chip", async () => {
      const mark = (await boardLinks(dm))[run.hole];
      return mark?.name === "Down to Ground floor" && mark.chip === "10 ft down" ? true : null;
    });
    // The window draws the floor below under its veil: the goblin's round in the hole is no black drop.
    const inHole = await colorAt(dm, { x: HOLE.x, y: HOLE.y });
    assert.ok(inHole !== null && inHole.some((c) => c > 12), `the hole draws the floor below, read ${inHole}`);
    await shots.take(dm, "fl4o-2-dm-hole-window");
    await showFloor(dm, "Ground floor");
    await waitFor("the lower end's name", async () => ((await boardLinks(dm))[run.holeBelow]?.name === "Up to Upper floor" ? true : null));
    await showFloor(dm, "Upper floor");

    await showsFloor(ana, "Upper floor", "Ana's phone on Upper floor with Thorn");
    await waitFor("Ana's hole", async () => {
      const mark = (await boardLinks(ana))[run.hole];
      return mark?.name === "Down to Ground floor" && mark.chip === "10 ft down" ? true : null;
    });
    await shots.take(ana, "fl4o-2-ana-hole");
  });

  test("fl4o-3. Bree's drag over the hole reads Falls to Ground floor, the drop lands her below, her desk follows and says so, and the DM gets the toast with Show", async () => {
    await showFloor(bree, "Upper floor");
    const from = await pagePoint(bree, BOUNDS, { x: BREE_AT.x + 0.5, y: BREE_AT.y + 0.5 });
    const to = await pagePoint(bree, BOUNDS, { x: HOLE.x + 0.5, y: HOLE.y + 0.5 });
    await bree.mouse.move(from.x, from.y);
    await bree.mouse.down();
    await bree.mouse.move(from.x + (to.x - from.x) * 0.1, from.y + (to.y - from.y) * 0.1, { steps: 3 });
    await bree.mouse.move(to.x, to.y, { steps: 12 });
    try {
      await waitFor("Falls to Ground floor on the drag's label", async () => ((await boardTexts(bree)).some((t) => t.split("\n").includes("Falls to Ground floor")) ? true : null), 10_000);
      await shots.take(bree, "fl4o-3-bree-drag-falls");
    } finally {
      await bree.mouse.up();
    }
    await waitFor("Bree below", () => (tokenOf(run.tBree)?.sceneId === run.ground ? true : null));
    const landed = tokenOf(run.tBree)!;
    assert.deepEqual([landed.x, landed.y], [HOLE.x, HOLE.y], "on the same squares below");
    await said(bree, "Bree fell to Ground floor. Showing Ground floor.").waitFor({ state: "attached" });
    await showsFloor(bree, "Ground floor", "Bree's desk follows her down");
    await toast(dm, "Bree fell 10 ft to Ground floor.").waitFor();
    await toast(dm, "Bree fell 10 ft to Ground floor.").getByRole("button", { name: "Show" }).waitFor();
  });

  test("fl4o-4. the DM's desk holds Bree's fall card, in line, and Apply's group save on Ground floor hurts her, lays her Prone and removes the card", async () => {
    const card = dm.getByRole("region", { name: "Fall: Bree" });
    await card.waitFor();
    await card.getByText("Bree fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.", { exact: true }).waitFor();
    const lines: string[] = [];
    try {
      for (const size of SIZES) {
        for (const scale of SCALES) {
          await sizeTo(dm, size, scale);
          // On a phone the desk folds into its summary, whose sheet holds the card.
          if (!(await fallCard(dm).isVisible().catch(() => false))) {
            const fold = dm.getByRole("button", { name: /fell/ }).first();
            if (await fold.isVisible().catch(() => false)) await fold.click();
          }
          const shown = fallCard(dm);
          await shown.waitFor();
          const toggle = shown.getByRole("button", { expanded: false });
          if ((await toggle.count()) > 0) await toggle.first().click();
          await shown.getByRole("button", { name: "Apply Bree's fall" }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(shown), `${at(size, scale)} Bree's fall card`));
          await shots.take(dm, `fl4o-4-card-${at(size, scale)}`);
        }
      }
    } finally {
      await deskAgain(dm);
    }
    assert.deepEqual(lines, [], "the fall card out of line");

    const hp = () => state()?.characters[run.breeCharacter]?.actor.hp.cur ?? null;
    await dm.getByRole("region", { name: "Fall: Bree" }).getByRole("button", { name: "Apply Bree's fall" }).click();
    const damage = dm.getByLabel("Damage", { exact: true });
    await damage.waitFor();
    const lines0 = state()?.log.length ?? 0;
    await damage.press("Enter");
    const rolled = await waitFor("the fall's roll", () => state()?.log.slice(lines0).find((e) => e.data?.type === "dice" && e.data.rolls.some((r) => r.formula === "1d6")) ?? null);
    const amount = rolled.data?.type === "dice" ? rolled.data.rolls.find((r) => r.formula === "1d6")!.total : 0;
    const apply = dm.getByRole("button", { name: /^Apply/ }).last();
    await apply.waitFor();
    await shots.take(dm, "fl4o-4-fall-group-save");
    await apply.click();
    await waitFor(`Bree at ${HP - amount}`, () => (hp() === HP - amount ? true : null));
    await waitFor("Bree Prone", () => ((state()?.characters[run.breeCharacter]?.actor.effects ?? []).some((e) => e.key === "prone") ? true : null));
    await waitFor("the card gone", () => (Object.keys(state()?.falls ?? {}).length === 0 ? true : null));
    await dm.getByRole("region", { name: "Fall: Bree" }).waitFor({ state: "detached" });
  });

  test("fl4o-5. a fall on a scene the DM is not showing toasts A creature fell 10 ft to Ground floor on Tower with Show, which goes there, and its card is dismissed", async () => {
    // The DM looks at Cave, and the rat walks onto the hole upstairs.
    await showScene(dm, "Cave", run.cave);
    await ops.send({ t: "token.move", tokenId: run.rat, x: HOLE.x, y: HOLE.y });
    const note = toast(dm, "A creature fell 10 ft to Ground floor on Tower.");
    await note.waitFor();
    await shots.take(dm, "fl4o-5-toast-other-scene");
    await note.getByRole("button", { name: "Show" }).click();
    await showsFloor(dm, "Ground floor", "Show brings the DM to Ground floor");
    const card = dm.getByRole("region", { name: "Fall: Rat" });
    await card.getByText("Rat fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Dismiss Rat's fall" }).click();
    await card.waitFor({ state: "detached" });
    await waitFor("no card left", () => (Object.keys(state()?.falls ?? {}).length === 0 ? true : null));
  });

  test("LP46FIX-1. a pony with a kobold riding it falls through the hole, and the card naming both applies: Apply's group save hurts both and removes the card", async () => {
    const PONY_AT = { x: 11, y: 4 };
    await ops.send({ t: "token.create", token: { id: run.pony, sceneId: run.upper, kind: "monster", name: "Pony", disposition: "neutral", actor: { inline: actor(HP) }, ...PONY_AT, size: "large", visibility: "all" } });
    await ops.send({ t: "token.create", token: { id: run.kobold, sceneId: run.upper, kind: "monster", name: "Kobold", disposition: "hostile", actor: { inline: actor(HP) }, ...PONY_AT, size: "small", visibility: "all" } });
    await ops.send({ t: "token.attach", tokenId: run.kobold, to: run.pony, kind: "ride", steer: true, ...PONY_AT, elevation: 0 });
    await waitFor("the kobold riding the pony", () => (tokenOf(run.kobold)?.attached?.to === run.pony ? true : null));
    await ops.send({ t: "token.move", tokenId: run.pony, x: HOLE.x, y: HOLE.y });
    await waitFor("both below", () => (tokenOf(run.pony)?.sceneId === run.ground && tokenOf(run.kobold)?.sceneId === run.ground ? true : null));
    const card = dm.getByRole("region", { name: "Fall: Pony and Kobold" });
    await card.getByText("Pony and Kobold fell 10 ft to Ground floor: each 1d6 Bludgeoning, Prone.", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Apply Pony and Kobold's fall" }).click();
    const damage = dm.getByLabel("Damage", { exact: true });
    await damage.waitFor();
    const lines0 = state()?.log.length ?? 0;
    await damage.press("Enter");
    const rolled = await waitFor("the fall's roll", () => state()?.log.slice(lines0).find((e) => e.data?.type === "dice" && e.data.rolls.some((r) => r.formula === "1d6")) ?? null);
    const amount = rolled.data?.type === "dice" ? rolled.data.rolls.find((r) => r.formula === "1d6")!.total : 0;
    const apply = dm.getByRole("button", { name: /^Apply/ }).last();
    await apply.waitFor();
    await apply.click();
    const hp = (id: string) => {
      const a = tokenOf(id)?.actor;
      return a && "inline" in a ? a.inline.hp?.cur : undefined;
    };
    await waitFor(`both at ${HP - amount}`, () => (hp(run.pony) === HP - amount && hp(run.kobold) === HP - amount ? true : null));
    assert.equal(await dm.getByText("This save's choices could not be kept", { exact: false }).count(), 0);
    await waitFor("the card gone", () => (Object.keys(state()?.falls ?? {}).length === 0 ? true : null));
    await card.waitFor({ state: "detached" });
    await shots.take(dm, "lp46fix-1-riders-applied");
  });

  test("LP46FIX-3. four creatures that fall in one op toast once with the count, in line on a phone at 100% and 130%", async () => {
    const cells = [{ x: HOLE.x, y: HOLE.y }, { x: HOLE.x + 1, y: HOLE.y }, { x: HOLE.x, y: HOLE.y + 1 }, { x: HOLE.x + 1, y: HOLE.y + 1 }];
    const lines: string[] = [];
    try {
      for (const scale of SCALES) {
        await sizeTo(dm, PHONE, scale);
        const imps = cells.map(() => uuidv7());
        for (const [i, id] of imps.entries()) await ops.send({ t: "token.create", token: { id, sceneId: run.upper, kind: "monster", name: `Imp ${i + 1}`, disposition: "hostile", actor: { inline: actor(HP) }, x: i, y: 12, size: "small", visibility: "all" } });
        await waitFor("the imps upstairs", () => (imps.every((id) => tokenOf(id)?.sceneId === run.upper) ? true : null));
        await ops.send({ t: "token.moveMany", moves: imps.map((tokenId, i) => ({ tokenId, ...cells[i]! })) });
        await waitFor("the imps below", () => (imps.every((id) => tokenOf(id)?.sceneId === run.ground) ? true : null));
        const note = toast(dm, "4 creatures fell to Ground floor.");
        await note.waitFor();
        assert.equal(await dm.locator("[data-toast]").filter({ hasText: /Imp \d fell/ }).count(), 0, "no toast for each");
        lines.push(...alignmentLines(await measureAlignment(note), `${at(PHONE, scale)} the crowd's toast`));
        await shots.take(dm, `lp46fix-3-crowd-toast-${at(PHONE, scale)}`);
        await ops.send({ t: "token.deleteMany", tokenIds: imps });
        await waitFor("their cards gone", () => (Object.keys(state()?.falls ?? {}).length === 0 ? true : null));
      }
    } finally {
      await deskAgain(dm);
    }
    assert.deepEqual(lines, [], "the crowd's toast out of line");
  });

  test("s67-1. both tokens of one character on an opening placed under them make one fall card, and Apply takes the fall once", async () => {
    await ops.send({ t: "character.create", character: { id: run.shade, name: "Shade", size: "medium", ownerIds: [], actor: actor(HP) } });
    const shown = { kind: "pc", name: "Shade", actor: { ref: run.shade }, disposition: "hostile", size: "medium", visibility: "all" } as const;
    await ops.send({ t: "token.create", token: { id: run.shade1, sceneId: run.upper, x: SHADE_HOLE.x, y: SHADE_HOLE.y, ...shown } });
    await ops.send({ t: "token.create", token: { id: run.shade2, sceneId: run.upper, x: SHADE_HOLE.x + 1, y: SHADE_HOLE.y + 1, ...shown } });
    await waitFor("Shade's tokens upstairs", () => (tokenOf(run.shade1)?.sceneId === run.upper && tokenOf(run.shade2)?.sceneId === run.upper ? true : null));
    const toasts0 = await dm.locator("[data-toast]").filter({ hasText: /fell/ }).count();
    await ops.send({ t: "floorLink.put", link: { id: run.shadeHole, pairId: run.shadeHoleBelow, sceneId: run.upper, to: run.ground, rect: SHADE_HOLE, kind: "opening" } });
    await waitFor("both of Shade's tokens below", () => (tokenOf(run.shade1)?.sceneId === run.ground && tokenOf(run.shade2)?.sceneId === run.ground ? true : null));
    const cards = Object.values(state()?.falls ?? {});
    assert.equal(cards.length, 1, "one card");
    assert.deepEqual(new Set([cards[0]!.tokenId, ...(cards[0]!.riders ?? [])]), new Set([run.shade1, run.shade2]), "naming both tokens");
    const note = dm.locator("[data-toast]").filter({ hasText: /^Shade[^,]* fell 10 ft to Ground floor\./ });
    await note.first().waitFor();
    await sleep(500);
    assert.equal((await dm.locator("[data-toast]").filter({ hasText: /fell/ }).count()) - toasts0, 1, "one toast");
    const region = dm.getByRole("region", { name: /^Fall: Shade/ });
    await region.waitFor();
    assert.equal(await region.count(), 1, "one card on the desk");
    const name = ((await region.getAttribute("aria-label")) ?? "").slice("Fall: ".length);
    assert.ok(!name.includes(" and "), `the card names Shade once: ${name}`);
    await region.getByText(`${name} fell 10 ft to Ground floor: 1d6 Bludgeoning, Prone.`, { exact: true }).waitFor();
    await shots.take(dm, "s67-1-one-card");

    const page = dm.locator('dialog[data-rvtt-sheet][aria-label="Dice"]').or(dm.getByRole("tabpanel", { name: /Dice/ }));
    const lines: string[] = [];
    try {
      for (const size of SIZES) {
        for (const scale of SCALES) {
          await sizeTo(dm, size, scale);
          // On a phone the desk folds into its summary, whose sheet holds the card.
          if (!(await fallCard(dm).isVisible().catch(() => false))) {
            const fold = dm.getByRole("button", { name: /fell/ }).first();
            if (await fold.isVisible().catch(() => false)) await fold.click();
          }
          const card = fallCard(dm);
          await card.waitFor();
          const toggle = card.getByRole("button", { expanded: false });
          if ((await toggle.count()) > 0) await toggle.first().click();
          await card.getByRole("button", { name: `Apply ${name}'s fall` }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(card), `${at(size, scale)} Shade's fall card`));
          await shots.take(dm, `s67-1-card-${at(size, scale)}`);
          await card.getByRole("button", { name: `Apply ${name}'s fall` }).click();
          await page.getByLabel("Damage", { exact: true }).waitFor();
          lines.push(...alignmentLines(await measureAlignment(page), `${at(size, scale)} Shade's fall page`));
          await shots.take(dm, `s67-1-page-${at(size, scale)}`);
          await page.getByRole("button", { name: "Discard", exact: true }).first().click();
          const sheet = dm.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
          if (await sheet.isVisible().catch(() => false)) {
            await sheet.getByRole("button", { name: "Close Dice", exact: true }).click();
            await sheet.waitFor({ state: "hidden" });
          }
        }
      }
    } finally {
      await deskAgain(dm);
    }
    assert.deepEqual(lines, [], "Shade's fall card or page out of line");

    const hp = () => state()?.characters[run.shade]?.actor.hp.cur ?? null;
    await dm.getByRole("region", { name: `Fall: ${name}` }).getByRole("button", { name: `Apply ${name}'s fall` }).click();
    const damage = dm.getByLabel("Damage", { exact: true });
    await damage.waitFor();
    const lines0 = state()?.log.length ?? 0;
    await damage.press("Enter");
    const rolled = await waitFor("the fall's roll", () => state()?.log.slice(lines0).find((e) => e.data?.type === "dice" && e.data.rolls.some((r) => r.formula === "1d6")) ?? null);
    const amount = rolled.data?.type === "dice" ? rolled.data.rolls.find((r) => r.formula === "1d6")!.total : 0;
    const apply = dm.getByRole("button", { name: /^Apply/ }).last();
    await apply.waitFor();
    await shots.take(dm, "s67-1-fall-page");
    await apply.click();
    await waitFor("the card gone", () => (Object.keys(state()?.falls ?? {}).length === 0 ? true : null));
    await sleep(500);
    assert.equal(hp(), HP - amount, "Shade hurt once");
    assert.equal((state()?.characters[run.shade]?.actor.effects ?? []).filter((e) => e.key === "prone").length, 1, "Prone once");
    await dm.getByRole("region", { name: `Fall: ${name}` }).waitFor({ state: "detached" });
    await ops.send({ t: "token.deleteMany", tokenIds: [run.shade1, run.shade2] });
    await ops.send({ t: "floorLink.delete", linkId: run.shadeHole });
  });

  test("fl4o-6. the bat over the hole leads its bar with Fly down, named and tipped for Ground floor, in line, { flies it down 5 ft over the ground and } back up", async () => {
    await showFloor(dm, "Upper floor");
    await deselect(dm);
    await tapCell(dm, BOUNDS, { x: HOLE.x + 1, y: HOLE.y + 1 });
    const bar = barOf(dm, "Bat");
    await bar.waitFor();
    const down = climbButton(bar, "down");
    await down.waitFor();
    assert.equal(await down.getAttribute("aria-label"), "Fly down to Ground floor");
    assert.equal(await down.getAttribute("title"), "Fly down to Ground floor ({)");
    assert.equal((await down.innerText()).trim(), "Fly down");
    const lines: string[] = [];
    try {
      for (const size of SIZES) {
        for (const scale of SCALES) {
          await sizeTo(dm, size, scale);
          await showFloor(dm, "Upper floor");
          await deselect(dm);
          await tapCell(dm, BOUNDS, { x: HOLE.x + 1, y: HOLE.y + 1 });
          const shown = barOf(dm, "Bat");
          await shown.waitFor();
          await sleep(300);
          if ((await climbButton(shown, "down").count()) === 0) await expandBar(shown);
          await climbButton(shown, "down").waitFor();
          lines.push(...alignmentLines(await measureAlignment(shown), `${at(size, scale)} the bat's bar with Fly down`));
          await shots.take(dm, `fl4o-6-fly-down-${at(size, scale)}`);
        }
      }
    } finally {
      await deskAgain(dm);
    }
    assert.deepEqual(lines, [], "Fly down out of line");
    await showFloor(dm, "Upper floor");
    await deselect(dm);
    await tapCell(dm, BOUNDS, { x: HOLE.x + 1, y: HOLE.y + 1 });
    await barOf(dm, "Bat").waitFor();
    await keyOn(dm, "{");
    await waitFor("the bat below, 5 ft up", () => (tokenOf(run.bat)?.sceneId === run.ground && tokenOf(run.bat)?.elevation === 5 ? true : null));
    await showsFloor(dm, "Ground floor", "the DM follows the bat down");
    await climbButton(barOf(dm, "Bat"), "up").waitFor();
    await keyOn(dm, "}");
    await waitFor("the bat back up", () => (tokenOf(run.bat)?.sceneId === run.upper && tokenOf(run.bat)?.elevation === 5 ? true : null));
    await deselect(dm);
  });

  test("fl4o-7. a pit trap on Upper floor gets Into, in line, Ground floor makes it a trapdoor, and its springing drops the goblin standing on it to Ground floor with a card", async () => {
    await showFloor(dm, "Upper floor");
    // Made from Hidden Pit (LP46FIX-2): its 1d6 and its words are the pit's falling damage and the pit's own.
    const pit = trapPreset("hidden-pit", "1-4")!.rig;
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, pit: { floor: -10 }, hits: "trigger", actions: [], find: [], notice: false, damage: pit.damage, note: pit.note, preset: "hidden-pit" };
    await ops.send({ t: "trap.create", trap: { id: run.trapdoor, sceneId: run.upper, name: "Trapdoor", zone: { cells: [TRAPDOOR] }, rig } });
    await ops.send({ t: "token.create", token: { id: run.goblin2, sceneId: run.upper, kind: "monster", name: "Second Goblin", disposition: "hostile", actor: { inline: actor(HP) }, x: TRAPDOOR.x, y: TRAPDOOR.y, size: "medium", visibility: "all" } });
    await waitFor("the trap and the goblin upstairs", () => (state()?.traps[run.trapdoor] && tokenOf(run.goblin2) ? true : null));
    const trapPane = dm.getByRole("dialog", { name: "Edit trap" });
    const openPane = async () => {
      await pickTool(dm, "Trap");
      await tapCell(dm, BOUNDS, { x: TRAPDOOR.x, y: TRAPDOOR.y });
      await trapPane.waitFor();
      const fold = trapPane.getByRole("button", { name: "Aftermath", exact: true });
      if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
    };
    await openPane();
    const into = trapPane.locator(`[${TRAP_INTO_ATTR}]`);
    await into.waitFor();
    await into.getByRole("radio", { name: "A pit", exact: true }).waitFor();
    await into.getByRole("radio", { name: "Ground floor", exact: true }).click();
    await waitFor("a trapdoor", () => (state()?.traps[run.trapdoor]?.rig?.below === true && state()?.traps[run.trapdoor]?.rig?.pit === undefined ? true : null));
    // LP46FIX-2: the same step takes the pit's falling damage and words off, as the pane now shows.
    const door = state()!.traps[run.trapdoor]!.rig!;
    assert.deepEqual([door.damage, door.note, door.preset], [undefined, undefined, "hidden-pit"], "the pit's 1d6 and words gone, the rest kept");
    await trapPane.getByText("Creatures standing on it fall to Ground floor, onto the same squares.", { exact: true }).waitFor();
    await shots.take(dm, "fl4o-7-trapdoor-into");
    const lines: string[] = [];
    try {
      for (const size of SIZES) {
        for (const scale of SCALES) {
          await sizeTo(dm, size, scale);
          await showFloor(dm, "Upper floor");
          await openPane();
          await trapPane.locator(`[${TRAP_INTO_ATTR}]`).waitFor();
          lines.push(...alignmentLines(await measureAlignment(trapPane.locator(`[${TRAP_INTO_ATTR}]`)), `${at(size, scale)} Into`));
          await shots.take(dm, `fl4o-7-into-${at(size, scale)}`);
          await keyOn(dm, "Escape");
        }
      }
    } finally {
      await deskAgain(dm);
    }
    assert.deepEqual(lines, [], "Into out of line");
    await pickTool(dm, "Select");
    await ops.send({ t: "trap.spring", trapId: run.trapdoor, tokenIds: [run.goblin2] });
    await waitFor("the goblin dropped below", () => (tokenOf(run.goblin2)?.sceneId === run.ground ? true : null));
    assert.deepEqual([tokenOf(run.goblin2)!.x, tokenOf(run.goblin2)!.y], [TRAPDOOR.x, TRAPDOOR.y], "onto the same squares");
    await dm.getByRole("region", { name: "Fall: Second Goblin" }).waitFor();
    // LP46FIX-2: with nothing of its own left to apply, the trapdoor leaves the drop's damage to the fall card and makes no card.
    assert.deepEqual(state()?.traps[run.trapdoor]?.rig?.due ?? [], [], "no springing waits");
    assert.equal(await dm.getByRole("group", { name: "Trapdoor went off" }).count(), 0, "no trap card");
    await shots.take(dm, "lp46fix-2-trapdoor-fall-only");
    for (const id of Object.keys(state()?.falls ?? {})) await ops.send({ t: "fall.settle", fallId: id });
    for (const due of state()?.traps[run.trapdoor]?.rig?.due ?? []) await ops.send({ t: "trap.settle", trapId: run.trapdoor, due: due.id });
  });

  test("fl4o-8. hidden stairs: Hidden from players hides both ends, the DM's name adds Hidden, and Bree gets nothing of them", async () => {
    await ops.send({ t: "floorLink.put", link: { id: run.stairsDown, pairId: run.stairsUp, sceneId: run.ground, to: run.upper, rect: { ...STAIRS, w: 1, h: 1 }, kind: "stairs" } });
    await showFloor(dm, "Ground floor");
    await pickTool(dm, TOOL);
    await pickOption(dm, TOOL, "Builder mode", "Between floors");
    await tapCell(dm, BOUNDS, STAIRS);
    const pane = linkPane(dm);
    await pane.getByRole("heading", { name: "Stairs up to Upper floor" }).waitFor();
    await pane.getByText("Players see nothing of these stairs until you turn this off.", { exact: true }).waitFor();
    await pane.getByRole("switch", { name: "Hidden from players" }).click();
    await waitFor("both ends hidden", () => (state()?.floorLinks?.[run.stairsDown]?.hidden === true && state()?.floorLinks?.[run.stairsUp]?.hidden === true ? true : null));
    await keyOn(dm, "Escape");
    await pickTool(dm, "Select");
    await waitFor("Hidden on the DM's name", async () => ((await boardLinks(dm))[run.stairsDown]?.name === "Up to Upper floor · Hidden" ? true : null));
    await shots.take(dm, "fl4o-8-dm-hidden-stairs");
    await showFloor(bree, "Ground floor");
    await bree.waitForTimeout(800);
    assert.equal((await boardLinks(bree))[run.stairsDown], undefined, "Bree's board draws no hidden end");
    assert.equal(state(breeSocket)?.floorLinks?.[run.stairsDown], undefined, "Bree's copy holds no hidden end");
    await ops.send({ t: "floorLink.delete", linkId: run.stairsDown });
  });

  test("fl4o-9. the window's memory: four floors with four openings each over mapped floors, and Ana's phone switching 20 times, its heap within 10% over the last 10", async () => {
    const attic = uuidv7();
    const roof = uuidv7();
    await ops.send({ t: "scene.create", scene: { id: attic, name: "Tower", bounds: BOUNDS }, floor: { beside: run.upper, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: attic, patch: { floor: { name: "Attic" }, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: roof, name: "Tower", bounds: BOUNDS }, floor: { beside: attic, side: "above" } });
    await ops.send({ t: "scene.update", sceneId: roof, patch: { floor: { name: "Roof" }, fogEnabled: false } });
    const floors = [run.ground, run.upper, attic, roof];
    for (const [i, id] of floors.entries()) {
      const image = await uploadImage(1920, 1120, { r: 60 + i * 30, g: 90, b: 120 - i * 20 });
      await ops.send({ t: "scene.setMap", sceneId: id, map: imageMap(image) });
    }
    // Four holes a floor above Ground, each down to the floor below. No two ends on a floor overlap, so a floor's
    // holes stand clear of the lower ends of the holes above it, and both clear of the first hole and the trapdoor.
    const west = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 10 },
      { x: 4, y: 10 },
    ];
    const east = [
      { x: 12, y: 0 },
      { x: 20, y: 0 },
      { x: 12, y: 10 },
      { x: 20, y: 10 },
    ];
    for (const [i, id] of floors.entries()) {
      if (i === 0) continue;
      for (const spot of i % 2 === 1 ? west : east) await ops.send({ t: "floorLink.put", link: { id: uuidv7(), pairId: uuidv7(), sceneId: id, to: floors[i - 1]!, rect: { ...spot, w: 3, h: 3 }, kind: "opening" } });
    }
    for (const id of [attic, roof]) await ops.send({ t: "floor.open", sceneId: id, open: true });
    await waitFor("Ana holds 4 floors", () => (Object.values(anaSocket.state?.scenes ?? {}).filter((s) => s.floor !== undefined).length === 4 ? true : null), 20_000);

    const cdp = await anaContext.newCDPSession(ana);
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      return (await cdp.send("Runtime.getHeapUsage")).usedSize;
    };
    const names = ["Ground floor", "Upper floor", "Attic", "Roof"];
    // From Upper, where Ana follows Thorn: down to Ground, up to the Roof, down again and up, 20 switches in all.
    const steps: ("[" | "]")[] = ["[", "]", "]", "]", "[", "[", "[", "]", "]", "]", "[", "[", "[", "]", "]", "]", "[", "[", "[", "]"];
    let shown = 1;
    const used: number[] = [];
    let peak = 0;
    for (const key of steps) {
      await keyOn(ana, key);
      shown += key === "]" ? 1 : -1;
      await showsFloor(ana, names[shown]!, `switch ${used.length + 1} to ${names[shown]}`);
      peak = Math.max(peak, (await cdp.send("Runtime.getHeapUsage")).usedSize);
      await ana.waitForTimeout(600);
      used.push(await heap());
    }
    assert.equal(used.length, 20);
    const tenth = used[9]!;
    const worst = Math.max(...used.slice(10));
    console.log(`fl4o-9: heap after each switch, MB: ${used.map((u) => (u / 1e6).toFixed(1)).join(" ")}; peak during a draw ${(peak / 1e6).toFixed(1)} MB`);
    await shots.take(ana, "fl4o-9-ana-roof-windows");
    assert.ok(worst <= tenth * 1.1, `the heap grew to ${(worst / 1e6).toFixed(1)} MB over the last 10, past 10% above the tenth's ${(tenth / 1e6).toFixed(1)} MB`);
  });

  test("FLR4R1-1. a window over a two-colored map shows its blue half, and a calibration that shifts the map turns it red while it stays shown", async () => {
    await ops.send({ t: "floorLink.put", link: { id: uuidv7(), pairId: uuidv7(), sceneId: run.upper, to: run.ground, rect: WINDOW_HOLE, kind: "opening" } });
    const image = await uploadSplitImage();
    await ops.send({ t: "scene.setMap", sceneId: run.ground, map: imageMap(image) });
    await showFloor(dm, "Upper floor");
    const cell = { x: WINDOW_HOLE.x, y: WINDOW_HOLE.y };
    const blue = (c: [number, number, number] | null) => c !== null && c[2] > c[0] + 40;
    const red = (c: [number, number, number] | null) => c !== null && c[0] > c[2] + 40;
    // 16 cells in, past the image's middle at cell 12, the window shows the blue half.
    await waitFor("the window's blue half", async () => (blue(await colorAt(dm, cell)) ? true : null), 15_000);
    // Moved 8 cells east on the same bounds, the middle lies at cell 20, so the same squares show the red half.
    await ops.send({ t: "scene.setGrid", sceneId: run.ground, cellPx: image.width / BOUNDS.w, originPx: { x: -8 * (image.width / BOUNDS.w), y: 0 } });
    await waitFor("the window redrawn from the new calibration", async () => (red(await colorAt(dm, cell)) ? true : null), 15_000);
    await shots.take(dm, "flr4r1-1-window-recalibrated");
  });

  test("FLR4R1-2. with fog on below, the window keeps the map in the revealed squares and fogs the rest", async () => {
    await showFloor(dm, "Upper floor");
    const revealed = { x: WINDOW_HOLE.x, y: WINDOW_HOLE.y };
    const hidden = { x: WINDOW_HOLE.x + 1, y: WINDOW_HOLE.y + 1 };
    const unfogged = await waitFor("the window with the fog off", async () => {
      const [a, b] = [await colorAt(dm, revealed), await colorAt(dm, hidden)];
      return a !== null && b !== null ? { a, b } : null;
    });
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { fogEnabled: true } });
    await ops.send({ t: "fog.reset", sceneId: run.ground, to: "hidden" });
    await ops.send({ t: "fog.live", sceneId: run.ground, ops: [{ id: uuidv7(), mode: "reveal", shape: { kind: "rect", x: WINDOW_HOLE.x, y: WINDOW_HOLE.y, w: 1, h: WINDOW_HOLE.h } }] });
    const near = (a: readonly number[] | null, b: readonly number[]) => a !== null && a.every((v, i) => Math.abs(v - b[i]!) <= 10);
    await waitFor("the fog over the hole's hidden squares", async () => (!near(await colorAt(dm, hidden), unfogged.b) ? true : null), 15_000);
    const shown = await colorAt(dm, revealed);
    assert.ok(near(shown, unfogged.a), `a revealed square of the window shows the map as with the fog off: read ${shown}, then ${unfogged.a}`);
    await shots.take(dm, "flr4r1-2-window-fog-revealed");
  });

  test("lp50fix-1. on the DM's phone a trap's name keeps off the frame of the stairs beside it, and the stairs' name off the trap's squares, at 390 x 844 at 100% and 130%", async () => {
    const NAVE = { w: 8, h: 6 };
    const nave = uuidv7();
    const stairs = { id: uuidv7(), pairId: uuidv7(), rect: { x: 5, y: 1, w: 2, h: 2 } };
    const pit = { x: 3, y: 2, w: 2, h: 1 };
    await ops.send({ t: "scene.create", scene: { id: nave, name: "Nave", bounds: NAVE } });
    const belfry = uuidv7();
    const undercroft = uuidv7();
    await ops.send({ t: "scene.create", scene: { id: belfry, name: "Nave", bounds: NAVE }, floor: { beside: nave, side: "above", besideName: "Nave", name: "Belfry" } });
    await ops.send({ t: "scene.create", scene: { id: undercroft, name: "Nave", bounds: NAVE }, floor: { beside: nave, side: "below", name: "Undercroft" } });
    // As live play laid it out: a hole down to Undercroft, the pit beside it, and the stairs up to Belfry beside the pit, a row taller.
    await ops.send({ t: "floorLink.put", link: { id: uuidv7(), pairId: uuidv7(), sceneId: nave, to: undercroft, rect: { x: 1, y: 2, w: 2, h: 1 }, kind: "opening" } });
    await ops.send({ t: "floorLink.put", link: { id: stairs.id, pairId: stairs.pairId, sceneId: nave, to: belfry, rect: stairs.rect, kind: "stairs" } });
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: uuidv7(), sceneId: nave, name: "Hidden Pit", zone: { cells: [pit] }, rig } });
    await showScene(dm, "Nave", nave);
    /** The board's pills in page px, by their first words. */
    const pills = () =>
      dm.evaluate(() => {
        type KRect = { x: number; y: number; width: number; height: number };
        type KLabel = { isVisible(): boolean; getClientRect(o?: { skipStroke?: boolean }): KRect; getText(): { text(): string } | undefined; getTag(): { getClientRect(o?: { skipStroke?: boolean }): KRect } | undefined };
        type KStage = { container(): { getBoundingClientRect(): { left: number; top: number } }; find(selector: string): KLabel[] };
        const out: { text: string; l: number; t: number; r: number; b: number }[] = [];
        for (const stage of (globalThis as unknown as { Konva: { stages: KStage[] } }).Konva.stages) {
          const host = stage.container().getBoundingClientRect();
          for (const label of stage.find("Label")) {
            if (!label.isVisible()) continue;
            const r = (label.getTag() ?? label).getClientRect({ skipStroke: true });
            out.push({ text: (label.getText()?.text() ?? "").replace(/\n/g, " "), l: host.left + r.x, t: host.top + r.y, r: host.left + r.x + r.width, b: host.top + r.y + r.height });
          }
        }
        return out;
      });
    /** A cell rectangle's box in page px. */
    const pageBox = async (r: { x: number; y: number; w: number; h: number }) => {
      const a = await pagePoint(dm, NAVE, { x: r.x, y: r.y });
      const b = await pagePoint(dm, NAVE, { x: r.x + r.w, y: r.y + r.h });
      return { l: a.x, t: a.y, r: b.x, b: b.y };
    };
    // A pill's edge may touch a frame's line: past a pixel it covers it.
    const covered = (p: { l: number; t: number; r: number; b: number }, f: { l: number; t: number; r: number; b: number }) => Math.min(p.r, f.r) - Math.max(p.l, f.l) > 1 && Math.min(p.b, f.b) - Math.max(p.t, f.t) > 1;
    const lines: string[] = [];
    try {
      for (const scale of SCALES) {
        const where = at(PHONE, scale);
        await sizeTo(dm, PHONE, scale);
        // A reload starts the page on the players' scene, so the phone picks Nave from its Scenes sheet.
        if (dmSocket.you?.sceneId !== nave) {
          await dm.locator('nav[aria-label="Tools"] button[title="Panels"]').click();
          await dm.getByRole("region", { name: "Panels" }).getByRole("button", { name: "Scenes", exact: true }).click();
          await dm.locator('section[aria-label="Scenes"]').first().getByRole("button", { name: /^Nave(?![A-Za-z])/ }).first().click();
        }
        await waitFor(`the DM on Nave at ${where}`, () => (dmSocket.you?.sceneId === nave ? true : null));
        if (await dm.locator('section[aria-label="Scenes"]').first().isVisible()) await keyOn(dm, "Escape");
        const [name, stairsName] = await waitFor(`both names drawn at ${where}`, async () => {
          const seen = await pills();
          const a = seen.find((p) => p.text.startsWith("Hidden Pit"));
          const b = seen.find((p) => p.text.startsWith("Up to Belfry"));
          return a && b ? ([a, b] as const) : null;
        });
        const frame = await pageBox(stairs.rect);
        const squares = await pageBox(pit);
        if (covered(name, frame)) lines.push(`${where}: the pit's name ${JSON.stringify(name)} covers the stairs' frame ${JSON.stringify(frame)}`);
        if (covered(stairsName, squares)) lines.push(`${where}: the stairs' name ${JSON.stringify(stairsName)} covers the pit's squares ${JSON.stringify(squares)}`);
        await shots.take(dm, `lp50fix-1-pit-beside-stairs-${where}`);
      }
      // QF-ASTRA-02: still on the phone at the last scale, in Isometric the name stands upright over the turned ground, so it is measured against each frame's corners where the ground plane puts them on the page.
      const hole = { x: 1, y: 2, w: 2, h: 1 };
      for (const turn of [0, 1, 2, 3]) {
        await dm.evaluate((t) => {
          const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
          hook.pick("isometric");
          hook.turn(t);
        }, turn);
        // The phone folds the View button into its menu, so the board's relief is given time to build.
        await sleep(2500);
        const corners = (r: { x: number; y: number; w: number; h: number }) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
        const quads = await dm.evaluate(
          (rects) => {
            type Node = { getChildren(): Node[]; getAbsoluteTransform(): { point(p: { x: number; y: number }): { x: number; y: number } } };
            type Stage = Node & { listening(): boolean; width(): number; getLayers(): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } };
            const main = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find((st) => st.width() > 0 && st.listening() && st.getLayers().length === 3);
            if (!main) throw new Error("no isometric board on screen");
            const plane = main.getLayers()[0]!.getChildren()[0]!.getChildren()[0]!;
            const host = main.container().getBoundingClientRect();
            return rects.map((pts) => pts.map((c) => { const p = plane.getAbsoluteTransform().point(c); return { x: host.left + p.x, y: host.top + p.y }; }));
          },
          [corners(stairs.rect), corners(hole), corners(pit)],
        );
        const meets = (p: { l: number; t: number; r: number; b: number }, q: { x: number; y: number }[]) => {
          const rect = [{ x: p.l, y: p.t }, { x: p.r, y: p.t }, { x: p.r, y: p.b }, { x: p.l, y: p.b }];
          const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }, ...q.map((a, i) => { const b = q[(i + 1) % q.length]!; return { x: a.y - b.y, y: b.x - a.x }; })];
          return axes.every((a) => {
            const on = (pts: { x: number; y: number }[]) => pts.map((v) => (v.x * a.x + v.y * a.y) / Math.hypot(a.x, a.y));
            const u = on(rect);
            const w = on(q);
            return Math.min(Math.max(...u), Math.max(...w)) - Math.max(Math.min(...u), Math.min(...w)) > 1;
          });
        };
        const seen = await pills();
        const a = seen.find((p) => p.text.startsWith("Hidden Pit"));
        assert.ok(a, `the pit's name drawn in Isometric at turn ${turn}`);
        if (meets(a, quads[0]!)) lines.push(`Isometric turn ${turn}: the pit's name ${JSON.stringify(a)} covers the stairs' frame`);
        if (meets(a, quads[1]!)) lines.push(`Isometric turn ${turn}: the pit's name ${JSON.stringify(a)} covers the hole's frame`);
        await shots.take(dm, `qf-astra-02-iso-pit-turn-${turn}`);
      }
    } finally {
      await deskAgain(dm);
    }
    assert.deepEqual(lines, [], "a name over the thing beside it");
  });

  test("fl4o-10. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label}'s console`);
  });
});

/** Shows the DM a scene from its row in the Scenes panel. */
async function showScene(page: Page, name: string, id: string): Promise<void> {
  await openSideTab(page, "Scenes");
  const panel = page.getByRole("tabpanel", { name: sideTabName("Scenes") });
  await panel.getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
  await waitFor(`the DM on ${name}`, () => (dmSocket.you?.sceneId === id ? true : null));
}
