import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import type { BuildChunk, Drawing, EdgeFeature, RoomState, SightTile, Token } from "#shared/model.ts";
import { SOMETHING_BLOCKS } from "#shared/permissions.ts";
import type { PartySight } from "#shared/ruleHooks.ts";
import { decodeTile, getBit, isCellFullyFogged, TILE_CELLS } from "#shared/rules/fog.ts";
import { groundAt } from "#shared/rules/heights.ts";
import { partyMember, partySight, type VisionWorld } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { assertCanvasAt, ConsoleWatch, dragCells, openSideTab, OpSocket, pagePoint, pickOption, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { SQUARES } from "../shared/rules/grid.ts";

/**
 * The v1 wave 4 run (docs/design-v1-maps-vision.md section 4): the real
 * server serving the production build, a DM on a desktop and a player on a
 * phone, on a dark scene where players see only what their character sees.
 *
 * The scene is laid out over a second socket of the DM's session (walls, a
 * door, a raised platform and its stair, a light, three creatures), since
 * the builder is not what this run tests. Everything after that goes through
 * the two browsers: the DM drags a goblin to the edge of the party's torch
 * and back out, the player's drag stops at a closed door and the player
 * opens it, stops at a ledge no stair it has seen leads up and takes the
 * stair, reads the platform's and the stair's height with a tap
 * (docs/design-v1-heights-readout.md), measures up onto the platform,
 * teleports past a wall, and leaves explored ground behind. Back in the
 * first room, on its turn, it walks round a wall's end, pays double for a
 * square of rubble, and its marker says what that used
 * (docs/design-v1-movement.md 12, steps mv-1 to mv-3).
 *
 * Every frame the player receives is kept. After each step the player's
 * creatures and sight tiles are checked against the party's sight computed
 * from the DM's state with the server's own rules, and at the end every
 * frame is checked: nothing out of the party's sight, no light, no
 * explored layer, no drag path and no DM log line ever reached the player,
 * and every ruler's ground heights are the measurer's own.
 *
 * It runs with `pnpm test:e2e`, after the smoke and maps runs, on its own
 * port: E2E_PORT plus two. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 2;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-vision-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);
/** What a stored drawing may hold (shared/model.ts Drawing), so a new field reaching players fails the run. */
const DRAWING_FIELDS = new Set(["id", "rev", "sceneId", "kind", "points", "style", "text", "ownerId", "visibility", "anchors", "z"]);
const WORLD: VisionWorld = { walls: sceneWalls };

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

/**
 * The scene, 16 by 20 squares, dark, with fog and vision on and players'
 * moves stopped at walls and ledges:
 *
 * - Room A, rows 0 to 9: Thorn starts at (3, 4) carrying a torch (bright
 *   20 ft, dim 20 ft more, so 8 squares). The goblin waits at (14, 4) in the
 *   dark. At (11, 4) its nearest quarter square is 7.6 squares from the
 *   torch, at (12, 4) 8.6: the edge of the light.
 * - A wall along row 10 with a closed door above (3, 10).
 * - Room C, rows 10 to 19: a platform 10 ft up over columns 6 to 11 and rows
 *   12 to 17, reached by a stair at (5, 14) that points east, up to it. A
 *   wall along column 9 splits the platform's top for the teleport.
 * - A closet at (14, 18) to (15, 19), walled on its open sides, holds the
 *   boss and a candle, neither of which the party can ever see. Its floor is
 *   10 ft down, painted after the boss is placed so the boss sinks with it.
 * - A pin with only a label, "Old shrine", on the platform at (8, 16).
 */
const BOUNDS = { w: 16, h: 20 };
const SCENE_NAME = "Torchlit vault";
const DOOR = "3,10,n";
const START = { x: 3, y: 4 };
const PIN_CELL = { x: 8, y: 16 };
const CLOSET = { x: 14, y: 19 };
/** Step lp2-2b's cap on a frame's route work, in units (features/movement/boardWork.ts): a walk across this scene takes several frames at it. */
const ROUTE_UNITS_PER_FRAME = 40;

const run = {
  roomId: "",
  roomName: `E2E vision ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  patId: "",
  sceneId: randomUUID(),
  thornId: randomUUID(),
  goblinId: randomUUID(),
  bossId: randomUUID(),
  lightId: randomUUID(),
  pinId: randomUUID(),
  entryId: randomUUID(),
  /** pv4: the six players who join to fill the scene's list of who sees for themselves. */
  extraIds: [] as string[],
  /** The DM's frames from where the player's ruler began to where it ended, and the player's fog meanwhile, which nothing changes then. */
  playerRulers: null as { from: number; to: number; fog: RoomState["fogTiles"] } | null,
  /** The player's frame count when the goblin left the party's sight. */
  goblinGoneAt: -1,
  /** The player's frame count when Thorn first moved, after which the goblin was never in sight again. */
  thornMovedAt: -1,
  /** The party's sight while Thorn stood at its start, which every goblin frame the player got must fall inside. */
  startSight: null as PartySight | null,
};

function actor(senses = "") {
  return {
    hp: { cur: 20, max: 20, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 0,
    passivePerception: 10,
    senses,
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

function cells(x0: number, y0: number, x1: number, y1: number): string[] {
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`${x},${y}`);
  return out;
}

async function layOut(): Promise<void> {
  const wall: EdgeFeature = { kind: "wall" };
  const edges: { key: string; feature: EdgeFeature }[] = [];
  for (let x = 0; x < BOUNDS.w; x++) edges.push({ key: `${x},10,n`, feature: x === 3 ? { kind: "door", state: "closed", secret: false, discovered: false } : wall });
  for (let y = 12; y <= 17; y++) edges.push({ key: `9,${y},w`, feature: wall });
  for (const key of ["14,18,w", "14,19,w", "14,18,n", "15,18,n"]) edges.push({ key, feature: wall });
  await ops.send({
    t: "scene.create",
    scene: { id: run.sceneId, name: SCENE_NAME, bounds: BOUNDS, background: "#2b2b31", fogEnabled: true, autoWalls: "off", blockMovement: true, vision: { on: true, light: "dark" } },
  });
  await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });
  await ops.send({ t: "build.height", sceneId: run.sceneId, cells: cells(6, 12, 11, 17), height: 10 });
  await ops.send({ t: "build.stairs", sceneId: run.sceneId, cells: ["5,14"], up: "a" });
  await ops.send({ t: "build.lights", sceneId: run.sceneId, put: [{ id: run.lightId, x: 15.5, y: 19.5, bright: 5, dim: 5, on: true, walls: true, label: "Closet candle" }] });
  const creature = (id: string, name: string, at: { x: number; y: number }, extra: Record<string, unknown>) => ({
    t: "token.create",
    token: { id, sceneId: run.sceneId, kind: "monster", name, size: "medium", x: at.x, y: at.y, visibility: "all", actor: { inline: actor() }, ...extra },
  });
  await ops.send(creature(run.thornId, "Thorn", START, { kind: "pc", disposition: "ally", ownerIds: [run.patId], light: { bright: 20, dim: 20 } }));
  await ops.send(creature(run.goblinId, "Goblin", { x: 14, y: 4 }, { disposition: "hostile" }));
  await ops.send(creature(run.bossId, "Goblin Boss", { x: 14, y: 18 }, { disposition: "hostile" }));
  await ops.send({ t: "build.height", sceneId: run.sceneId, cells: cells(14, 18, 15, 19), height: -10 });
  await ops.send({ t: "pin.put", pin: { id: run.pinId, sceneId: run.sceneId, x: PIN_CELL.x + 0.5, y: PIN_CELL.y + 0.5, label: "Old shrine", color: "#f7df00", visibility: "all" } });
}

function tokenOf(state: RoomState | null, id: string): Token | undefined {
  return state?.tokens[id];
}

/** The party's sight as the server computes it, from the DM's state, which holds every creature and light on the scene. */
function sightFromDm(): PartySight {
  const state = dmSocket.state;
  assert.ok(state, "the DM has no state");
  return partySight(state, run.sceneId, WORLD);
}

function sightTilesOf(state: RoomState | null): Record<string, SightTile> {
  const prefix = `${run.sceneId}:`;
  const sight = (state as unknown as { sight?: Record<string, SightTile> } | null)?.sight ?? {};
  return Object.fromEntries(Object.entries(sight).filter(([key]) => key.startsWith(prefix)));
}

/**
 * What is wrong with the player's view now, or null when it is right: every
 * creature on the scene is in the player's state exactly when it is a party
 * member or in the party's sight, and the player's sight tiles are exactly
 * the computed ones.
 */
function viewProblem(): string | null {
  const dmState = dmSocket.state;
  const mine = playerSocket.state;
  if (!dmState || !mine) return "no state yet";
  const sight = sightFromDm();
  for (const token of Object.values(dmState.tokens)) {
    if (!token || token.sceneId !== run.sceneId) continue;
    const shown = token.visibility === "all" && (partyMember(dmState, token) || token.fogExempt || sight.seesToken(token, SQUARES));
    const has = mine.tokens[token.id] !== undefined;
    if (shown !== has) return `${token.name} at ${token.x},${token.y}: expected ${shown ? "shown" : "withheld"}, the player ${has ? "has it" : "does not"}`;
  }
  const want = Object.fromEntries([...sight.tiles].map(([at, tile]) => [`${run.sceneId}:${at}`, tile]));
  const got = sightTilesOf(mine);
  const keys = (o: Record<string, unknown>) => Object.keys(o).sort().join(" ");
  if (keys(want) !== keys(got)) return `sight tiles: expected ${keys(want)}, the player has ${keys(got)}`;
  for (const key of Object.keys(want)) if (JSON.stringify(want[key]) !== JSON.stringify(got[key])) return `sight tile ${key} differs`;
  return null;
}

async function viewSettles(what: string): Promise<void> {
  let last: string | null = null;
  try {
    await waitFor(what, () => (last = viewProblem()) === null);
  } catch (err) {
    throw new Error(`${(err as Error).message}: ${last}`);
  }
}

/** Waits for Thorn to stand at a spot in the DM's and the player's states. */
async function thornAt(at: { x: number; y: number; elevation?: number }): Promise<void> {
  const there = (state: RoomState | null) => {
    const t = tokenOf(state, run.thornId);
    return !!t && t.x === at.x && t.y === at.y && (at.elevation === undefined || t.elevation === at.elevation);
  };
  try {
    await waitFor(`Thorn at ${at.x},${at.y}`, () => there(dmSocket.state) && there(playerSocket.state));
  } catch (err) {
    const t = tokenOf(dmSocket.state, run.thornId);
    throw new Error(`${(err as Error).message}: Thorn is at ${t?.x},${t?.y}, ${t?.elevation} ft`);
  }
}

/** The stopped walk's note on the player's screen: the card, whose sentence alone is its status. */
function stopNote(text: string) {
  return player.locator("[data-stop-note]").filter({ has: player.getByRole("status").filter({ hasText: text }) });
}

/**
 * Brings up the stopped walk's note at `size` at 130%, by step 9's walk into
 * the platform's wall again, and checks it keeps between the bars: Close,
 * Teleport here and the note's top and foot each take a tap, as a finger's
 * would. `more` checks the note further. Then 390 x 844 at 100% again.
 */
async function stopNoteAt(size: { width: number; height: number }, shot: string, more?: (note: Locator) => Promise<void>): Promise<void> {
  await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
  await player.setViewportSize(size);
  await player.reload();
  await player.getByRole("status", { name: "Connected" }).first().waitFor();
  await player.locator(".konvajs-content").first().waitFor();
  // Back west of the platform's wall, then the walk of step 9 again.
  await ops.send({ t: "token.move", tokenId: run.thornId, x: 7, y: 14, elevation: 10 });
  await thornAt({ x: 7, y: 14, elevation: 10 });
  await player.waitForTimeout(500);
  await dragCells(player, BOUNDS, { x: 7, y: 14 }, { x: 10, y: 14 });
  await thornAt({ x: 8, y: 14, elevation: 10 });
  const note = player.locator("[data-stop-note]");
  await note.getByRole("button", { name: "Teleport here" }).waitFor();
  await player.waitForTimeout(300);
  /** Whether a tap at a point lands inside `target`. */
  const lands = (target: string, x: number, y: number) =>
    player.evaluate(
      ([sel, px, py]) => {
        const doc = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { closest(s: string): unknown } | null } }).document;
        return doc.elementFromPoint(px, py)?.closest(sel) != null;
      },
      [target, x, y] as const,
    );
  const inReach = async (when: string) => {
    const box = (await note.boundingBox())!;
    const buttons: { name: string; b: { x: number; y: number; width: number; height: number } }[] = [];
    for (const name of ["Close", "Teleport here"]) {
      const b = (await note.getByRole("button", { name, exact: true }).boundingBox())!;
      assert.ok(await lands("[data-stop-note] button", b.x + b.width / 2, b.y + b.height / 2), `${name} takes a tap at its middle${when}`);
      buttons.push({ name, b });
    }
    // Their whole touch areas, not only their middles, stay apart, so a tap at Close's edge never lands on Teleport here (review LP2L2-ASTRA-3).
    const [c, t] = buttons.map((x) => x.b);
    const apart = c!.x + c!.width <= t!.x + 0.5 || t!.x + t!.width <= c!.x + 0.5 || c!.y + c!.height <= t!.y + 0.5 || t!.y + t!.height <= c!.y + 0.5;
    assert.ok(apart, `Close ${JSON.stringify(c)} and Teleport here ${JSON.stringify(t)} overlap${when}`);
    // Its top and its foot are the note's own, not under the top bar or the toolbar.
    assert.ok(await lands("[data-stop-note]", box.x + box.width / 2, box.y + 3), `the note's top is in reach${when}`);
    assert.ok(await lands("[data-stop-note]", box.x + box.width / 2, box.y + box.height - 3), `the note's foot is in reach, not under the toolbar${when}`);
  };
  await inReach("");
  await shots.take(player, shot);
  if (more) {
    await more(note);
    await inReach(", after the further checks");
  }
  await note.getByRole("button", { name: "Close" }).click();
  await note.waitFor({ state: "detached" });
  await player.evaluate(() => localStorage.setItem("rvtt.uiScale", "1"));
  await player.setViewportSize({ width: 390, height: 844 });
  await player.reload();
  await player.getByRole("status", { name: "Connected" }).first().waitFor();
  await player.locator(".konvajs-content").first().waitFor();
}

async function closeNote(text: string): Promise<void> {
  await stopNote(text).getByRole("button", { name: "Close" }).click();
  await stopNote(text).waitFor({ state: "detached" });
}

/** Whether a sub-square of the scene is revealed in this fog layer. */
function revealedIn(tiles: RoomState["fogTiles"] | undefined, sx: number, sy: number): boolean {
  const per = TILE_CELLS * 4;
  const tile = tiles?.[`${run.sceneId}:${Math.floor(sx / per)},${Math.floor(sy / per)}`];
  const bits = tile ? decodeTile(tile.bits) : null;
  return !!bits && getBit(bits, sx % per, sy % per);
}

type RulerPoint = { x: number; y: number; z?: number; tokenId?: string };
type Frame = {
  t?: string;
  from?: string;
  changes?: { key: string; value?: unknown; deleted?: true }[];
  e?: { k?: string; id?: string; tokenId?: string; x?: number; y?: number; path?: unknown; points?: RulerPoint[]; shared?: boolean };
};

function framesFrom(index: number, watch: SocketWatch = playerSocket): Frame[] {
  return watch.received.slice(index).map((text) => JSON.parse(text) as Frame);
}

/** The ruler frames a page received since `index`. */
function rulerFrames(watch: SocketWatch, index: number): NonNullable<Frame["e"]>[] {
  return framesFrom(index, watch).flatMap((f) => (f.t === "eph" && f.e?.k === "ruler" ? [f.e] : []));
}

/** The height readout's status line and pill on a page (features/builder/heights/ReadoutHost.tsx). */
function heightStatus(page: Page) {
  return page.locator("[data-rvtt-height-status]");
}
function heightPill(page: Page) {
  return page.locator("[data-rvtt-height-pill]");
}

async function heard(page: Page, words: string): Promise<void> {
  await waitFor(`"${words}" on the status line`, async () => (await heightStatus(page).innerText()) === words);
}

/**
 * A finger held still on the phone's screen, sent through the DevTools
 * protocol so the press is a real touch, as a phone sends it. tapCell's
 * mouse clicks never press long enough to ping, and are no touch.
 */
async function holdFinger(page: Page, context: BrowserContext, at: { x: number; y: number }, ms: number): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Whether a pin's label popover shows: a screen-size pill pointing down at the pin (features/pins/PinLayer.tsx). */
function pinPopover(page: Page, text: string): Promise<boolean> {
  return page.evaluate((label) => {
    type Node = { getTag(): { pointerDirection(): string } | undefined; getText(): { text(): string } | undefined };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages[0]!.find("Label").some((l) => l.getTag()?.pointerDirection() === "down" && l.getText()?.text() === label);
  }, text);
}

/** Every text the board draws in Konva, such as a drag's label and the movement marker. */
function boardTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Node = { text(): string; isVisible(): boolean };
    const konva = (globalThis as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } }).Konva;
    return konva.stages[0]!.find("Text").filter((t) => t.isVisible()).map((t) => t.text());
  });
}

/** A cell's ground as the layout painted it. The run paints nothing after, so it is the ground every ruler stood on. */
function layoutGround(x: number, y: number): number {
  return groundAt(dmSocket.state?.buildChunks ?? {}, run.sceneId, Math.floor(x), Math.floor(y));
}

/**
 * pv4: a second DM page, Dana's on the same device, whose room socket the
 * run reads every frame the page sends on, and can hold the Vision
 * settings' changes on. The first DM page's socket opened before any
 * route could be set, so it can do neither.
 */
const dm2 = {
  page: null as Page | null,
  /** Every frame the page sent on its room socket, as text. */
  sent: [] as string[],
  /** While set, a scene.update that changes the vision waits here, and the server never hears of it until it is let go. */
  held: null as string[] | null,
  upstream: null as WebSocketRoute | null,
};

async function openDm2(): Promise<Page> {
  const page = await dmContext.newPage();
  dmConsole.attach(page);
  await page.routeWebSocket(/\/ws\?room=/, (ws) => {
    const upstream = ws.connectToServer();
    dm2.upstream = upstream;
    ws.onMessage((m) => {
      const text = typeof m === "string" ? m : m.toString("utf8");
      dm2.sent.push(text);
      if (dm2.held && text.includes('"t":"scene.update"') && text.includes('"vision"')) dm2.held.push(text);
      else upstream.send(m);
    });
    upstream.onMessage((m) => ws.send(m));
  });
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.getByRole("status", { name: "Connected" }).first().waitFor();
  dm2.page = page;
  return page;
}

/** The `vision.holders` ops the second DM page sent from the frame at `index` on. */
function holderOpsSent(index: number): { on: string[] }[] {
  return dm2.sent.slice(index).flatMap((text) => {
    const msg = JSON.parse(text) as { t?: string; op?: { t?: string; on?: string[] } };
    return msg.t === "op" && msg.op?.t === "vision.holders" ? [{ on: msg.op.on ?? [] }] : [];
  });
}

function hasFocus(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement);
}

/** The scene's holder entry of a member in the DM's state, or undefined while there is none. */
function holderEntry(memberId: string): { on: boolean } | undefined {
  return dmSocket.state?.holders?.[run.sceneId]?.entries.find((e) => e.memberId === memberId);
}

describe("raccoon-vtt vision run", { timeout: 300_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    dm = await dmContext.newPage();
    player = await playerContext.newPage();
    dmConsole.attach(dm);
    playerConsole.attach(player);
    await dmSocket.attach(dmContext, dm);
    await playerSocket.attach(playerContext, player);
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") {
      for (const c of [dmConsole, playerConsole]) console.error(`[${c.label}] errors`, c.errors, "warnings", c.warnings);
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

  test("1. the DM creates a room and a player joins from a phone", async () => {
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

    // A new device is answered 403 by GET /me before it joins, which Chrome logs.
    playerConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/];
    await player.goto(`${server.origin}/r/${run.roomId}`);
    await player.getByLabel("Player password").fill(run.password);
    await player.getByRole("button", { name: "Next" }).click();
    await player.getByLabel("Your name").fill("Pat");
    await player.getByRole("button", { name: "Join", exact: true }).click();
    await waitFor("the player's snapshot", () => playerSocket.state);
    playerConsole.allow = [];
    await player.getByRole("status", { name: "Connected" }).first().waitFor();
    run.patId = playerSocket.you!.memberId;
  });

  test("2. the DM lays out a dark vision scene and moves the player there, who sees only Thorn's torchlight", async () => {
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    await layOut();

    await openSideTab(dm, "Scenes");
    await dm.getByRole("button", { name: new RegExp(`^${SCENE_NAME}`) }).click();
    await waitFor("the DM on the vision scene", () => dmSocket.you?.sceneId === run.sceneId || null, 30_000);
    await waitFor("the party's sight in the DM's state", () => Object.keys(sightTilesOf(dmSocket.state)).length > 0 || null);
    // Thorn's torch lets the party see, so moving the players there asks nothing.
    await dm.getByRole("button", { name: `Move players to ${SCENE_NAME}` }).click();
    await waitFor("the player on the vision scene", () => playerSocket.state?.meta.playerSceneId === run.sceneId || null);
    await waitFor("Thorn in the player's state", () => tokenOf(playerSocket.state, run.thornId));
    await viewSettles("the player's view of the dark scene");
    assert.equal(tokenOf(playerSocket.state, run.goblinId), undefined, "the goblin in the dark reached the player");
    assert.equal(Object.keys(playerSocket.state?.lights ?? {}).length, 0);
    run.startSight = sightFromDm();
    assert.equal(run.startSight.seesToken({ size: "medium", x: 11, y: 4 }, SQUARES), true, "the torch reaches (11, 4)");
    assert.equal(run.startSight.seesToken({ size: "medium", x: 12, y: 4 }, SQUARES), false, "the torch stops short of (12, 4)");
    await openSideTab(dm, "Scenes");
    await shots.take(dm, "vision-dm-scene");
    await shots.take(player, "vision-player-torchlight");
  });

  test("3. a monster appears at the edge of the torch's light and vanishes past it", async () => {
    await dragCells(dm, BOUNDS, { x: 14, y: 4 }, { x: 11, y: 4 });
    await waitFor("the goblin in the player's state", () => tokenOf(playerSocket.state, run.goblinId));
    await viewSettles("the player's view with the goblin in the light");
    await shots.take(player, "vision-player-goblin-in-light");

    await dragCells(dm, BOUNDS, { x: 11, y: 4 }, { x: 12, y: 4 });
    await waitFor("the goblin to leave the player's state", () => (tokenOf(playerSocket.state, run.goblinId) ? null : true));
    await waitFor("the goblin at (12, 4) for the DM", () => {
      const g = tokenOf(dmSocket.state, run.goblinId);
      return g?.x === 12 && g.y === 4;
    });
    await viewSettles("the player's view with the goblin gone");
    run.goblinGoneAt = playerSocket.received.length;
    await shots.take(player, "vision-player-goblin-gone");
    await shots.take(dm, "vision-dm-goblin-at-edge");
  });

  test("4. the player's drag stops at a closed door, and the player opens it and walks through", async () => {
    run.thornMovedAt = playerSocket.received.length;
    await dragCells(player, BOUNDS, START, { x: 3, y: 12 });
    await thornAt({ x: 3, y: 9 });
    // The door is in sight, on the side of the square Thorn stops in, so the note names it though no light shows the
    // party the square past it (D-261027-04): the landing shows where the stop is, and the player sees the door.
    await stopNote("A door is in the way. Tap it to open.").waitFor();
    await shots.take(player, "vision-player-stopped-at-door");
    await closeNote("A door is in the way. Tap it to open.");

    // The door's tap zone, just past Thorn's edge so the token does not take the tap.
    const p = await pagePoint(player, BOUNDS, { x: 3.5, y: 10.25 });
    await assertCanvasAt(player, p);
    await player.mouse.click(p.x, p.y);
    const pill = player.getByRole("group", { name: "Closed door" });
    await pill.getByRole("button", { name: "Open" }).click();
    await waitFor("the open door in the player's state", () => {
      const chunk = playerSocket.state?.buildChunks[`${run.sceneId}:0,0`] as BuildChunk | undefined;
      const door = chunk?.edges[DOOR];
      return door?.kind === "door" && door.state === "open";
    });
    // A tap on empty ground puts the pill away.
    await tapCell(player, BOUNDS, { x: 8, y: 6 });
    await pill.waitFor({ state: "detached" });
    await shots.take(player, "vision-player-door-open");

    await dragCells(player, BOUNDS, { x: 3, y: 9 }, { x: 3, y: 12 });
    await thornAt({ x: 3, y: 12 });
    await viewSettles("the player's view past the door");
    assert.equal(await player.locator("[data-stop-note]").count(), 0, "a note after a walk that was not stopped");
  });

  test("5. a ledge stops a walking token, and the stair takes it up", async () => {
    // The platform is 10 ft up, so the torch below has not shown the party its top, and the player's map holds none of it.
    // The walk goes, and the server stops it at the ledge, at its last free spot, in words that name nothing
    // (docs/design-v1-map-discovery.md decision 11).
    await dragCells(player, BOUNDS, { x: 3, y: 12 }, { x: 7, y: 12 });
    await thornAt({ x: 5, y: 12, elevation: 0 });
    await stopNote(SOMETHING_BLOCKS).waitFor();
    await shots.take(player, "vision-player-stopped-at-ledge");
    await closeNote(SOMETHING_BLOCKS);

    await dragCells(player, BOUNDS, { x: 5, y: 12 }, { x: 5, y: 14 });
    await thornAt({ x: 5, y: 14, elevation: 0 });
    await dragCells(player, BOUNDS, { x: 5, y: 14 }, { x: 7, y: 14 });
    // Landing on the platform writes its ground: Thorn stands 10 ft up.
    await thornAt({ x: 7, y: 14, elevation: 10 });
    await viewSettles("the player's view from the platform");
    await shots.take(player, "vision-player-up-the-stair");
  });

  test("6. with Select, a tap reads the platform's and the stair's height, leaves a pin its popover, and says nothing of the closet under the fog", async () => {
    await waitFor("the pin on explored ground in the player's state", () => playerSocket.state?.pins[run.pinId]);
    await tapCell(player, BOUNDS, { x: 6, y: 13 });
    await heard(player, "Ground 10 ft up.");
    assert.equal(await heightPill(player).innerText(), "↑10 ft");
    await shots.take(player, "vision-player-readout-platform");

    await tapCell(player, BOUNDS, { x: 5, y: 14 });
    await heard(player, "Stairs, up to the east.");
    assert.equal(await heightPill(player).innerText(), "Stairs");
    await shots.take(player, "vision-player-readout-stair");

    // The pin is on raised ground, and its own tap wins.
    await tapCell(player, BOUNDS, PIN_CELL);
    await waitFor("the pin's popover", () => pinPopover(player, "Old shrine"));
    assert.equal(await heightPill(player).count(), 0, "a readout beside the pin's popover");
    assert.equal(await heightStatus(player).innerText(), "");
    await shots.take(player, "vision-player-pin-not-readout");

    // The closet is 10 ft down, and the party never saw it.
    await tapCell(player, BOUNDS, { x: 6, y: 13 });
    await heard(player, "Ground 10 ft up.");
    await tapCell(player, BOUNDS, CLOSET);
    await heard(player, "");
    await player.waitForTimeout(300);
    assert.equal(await heightStatus(player).innerText(), "", "the closet's ground was spoken");
    assert.equal(await heightPill(player).count(), 0, "the closet's ground showed");

    await tapCell(dm, BOUNDS, CLOSET);
    await heard(dm, "Ground 10 ft down.");
    assert.equal(await heightPill(dm).innerText(), "↓10 ft");
    await shots.take(dm, "vision-dm-readout-closet");
  });

  test("7. a finger held on the door or on the platform pings and opens nothing, and the DM's held + climbs to 100 ft and a held Enter stops at each end", async () => {
    const doorPill = player.getByRole("group", { name: /door$/ });
    for (const [what, world] of [
      ["the door", { x: 3.5, y: 10.1 }],
      ["the platform", { x: 6.5, y: 13.5 }],
    ] as const) {
      const dmFrom = dmSocket.received.length;
      const p = await pagePoint(player, BOUNDS, world);
      await assertCanvasAt(player, p);
      await holdFinger(player, playerContext, p, 900);
      await waitFor(`the ping held on ${what} at the DM`, () => framesFrom(dmFrom, dmSocket).some((f) => f.t === "eph" && f.e?.k === "ping" && f.from === run.patId));
      await player.waitForTimeout(300);
      assert.equal(await doorPill.count(), 0, `a finger held on ${what} opened the door's pill`);
      assert.equal(await heightPill(player).count(), 0, `a finger held on ${what} showed a reading`);
      assert.equal(await heightStatus(player).innerText(), "");
    }
    // A short touch on the platform is still a tap.
    await holdFinger(player, playerContext, await pagePoint(player, BOUNDS, { x: 6.5, y: 13.5 }), 60);
    await heard(player, "Ground 10 ft up.");
    await shots.take(player, "vision-player-touch-tap-after-holds");

    // The DM's + held climbs from 10 ft to 100 ft, and the hold ends there with the finger still down, so the value is spoken.
    await dm.getByRole("button", { name: "Map builder" }).first().click();
    await pickOption(dm, "Map builder", "Builder mode", "Heights and stairs");
    const stepper = dm.getByRole("group", { name: "Height" });
    const plus = stepper.getByRole("button", { name: "5 ft higher" });
    // The value alone: the group also holds each button's tooltip, which keyboard focus shows 150 ms later (Tooltip.tsx FOCUS_MS).
    const height = async () => (await stepper.locator("[aria-live]").innerText()).trim();
    assert.equal(await height(), "10 ft up");
    const b = await plus.boundingBox();
    assert.ok(b);
    await dm.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await dm.mouse.down();
    await waitFor("the stepper at 100 ft", async () => (await height()) === "100 ft up", 5_000);
    assert.equal(await plus.getAttribute("aria-disabled"), "true");
    await waitFor("the value spoken again before the lift", async () => (await stepper.locator("[aria-live]").getAttribute("aria-live")) === "polite");
    await shots.take(dm, "vision-dm-stepper-held-to-100");
    await dm.mouse.up();

    // A held Enter repeats a step to the end of the range and stops there: the button at its limit keeps the focus and
    // takes no click, rather than handing the focus, and the rest of the key repeat, to the other button.
    const focused = () => dm.evaluate(() => (globalThis as unknown as { document: { activeElement: { getAttribute(n: string): string | null } | null } }).document.activeElement?.getAttribute("aria-label") ?? null);
    for (const [name, end] of [
      ["5 ft lower", "20 ft down"],
      ["5 ft higher", "100 ft up"],
    ] as const) {
      const button = stepper.getByRole("button", { name });
      await button.focus();
      for (let i = 0; i < 30; i++) await dm.keyboard.down("Enter");
      await dm.keyboard.up("Enter");
      assert.equal(await height(), end, `a held Enter on ${name}`);
      assert.equal(await focused(), name, `the focus left ${name} at its limit`);
      assert.equal(await button.getAttribute("aria-disabled"), "true");
      assert.equal(await button.evaluate((b) => (b as unknown as { disabled: boolean }).disabled), false, "a button at its limit stays focusable");
    }
    await dm.getByRole("button", { name: "Select", exact: true }).click();
  });

  test("8. a ruler stop stands on the ground its measurer sees, and every page reads the measurer's numbers", async () => {
    // The pin's popover would cover the reading in the screenshot.
    await waitFor("the pin's popover to go", async () => !(await pinPopover(player, "Old shrine")), 6_000);
    const dmFrom = dmSocket.received.length;
    await player.getByRole("button", { name: "Ruler", exact: true }).click();
    const options = player.getByRole("toolbar", { name: "Ruler options" });
    await dragCells(player, BOUNDS, { x: 5, y: 12 }, { x: 6, y: 12 });
    await options.getByText(/^10 ft · every diagonal 5 ft$/).waitFor();
    const climb = await waitFor("the climb's frame at the DM", () =>
      rulerFrames(dmSocket, dmFrom).find((e) => e.points?.length === 2 && e.points[1]!.x === 6.5 && e.points[1]!.y === 12.5),
    );
    assert.deepEqual(climb.points, [{ x: 5.5, y: 12.5 }, { x: 6.5, y: 12.5, z: 10 }]);
    await shots.take(player, "vision-player-ruler-onto-platform");

    await options.getByRole("button", { name: "Keep this ruler on the map" }).click();
    const kept = (state: RoomState | null) => Object.values(state?.drawings ?? {}).find((d): d is Drawing => d?.kind === "ruler" && d.ownerId === run.patId);
    await waitFor("the kept ruler in both states", () => kept(dmSocket.state) && kept(playerSocket.state));
    for (const state of [dmSocket.state, playerSocket.state]) {
      assert.deepEqual(kept(state)!.points, [5.5, 12.5, 6.5, 12.5]);
      assert.deepEqual(kept(state)!.z, [0, 10]);
    }

    // The closet's floor is under the player's fog, so their stop there stands at 0.
    await tapCell(player, BOUNDS, CLOSET);
    const dark = await waitFor("the closet stop's frame at the DM", () =>
      rulerFrames(dmSocket, dmFrom).find((e) => e.points?.length === 1 && e.points[0]!.x === CLOSET.x + 0.5 && e.points[0]!.y === CLOSET.y + 0.5),
    );
    assert.deepEqual(dark.points, [{ x: CLOSET.x + 0.5, y: CLOSET.y + 0.5 }]);
    await player.getByRole("button", { name: "Select", exact: true }).click();
    await waitFor("the player's ruler ended at the DM", () => framesFrom(dmFrom, dmSocket).some((f) => f.t === "eph" && f.e?.k === "rulerEnd"));
    run.playerRulers = { from: dmFrom, to: dmSocket.received.length, fog: playerSocket.state?.fogTiles ?? {} };

    // The DM's shared ruler stands on the closet's floor, 10 ft down, and the player reads the DM's numbers.
    const playerFrom = playerSocket.received.length;
    await dm.getByRole("button", { name: "Ruler", exact: true }).click();
    await dm.getByRole("toolbar", { name: "Ruler options" }).getByRole("button", { name: "Shared" }).click();
    await dragCells(dm, BOUNDS, { x: 12, y: 19 }, CLOSET);
    const shared = await waitFor("the DM's shared ruler at the player", () =>
      rulerFrames(playerSocket, playerFrom).find((e) => e.points?.at(-1)?.x === CLOSET.x + 0.5 && e.points.at(-1)?.y === CLOSET.y + 0.5),
    );
    assert.deepEqual(shared.points, [{ x: 12.5, y: 19.5 }, { x: CLOSET.x + 0.5, y: CLOSET.y + 0.5, z: -10 }]);
    await shots.take(dm, "vision-dm-shared-ruler-into-closet");
    await dm.getByRole("button", { name: "Select", exact: true }).click();
  });

  test("9. Teleport here after a stopped walk replaces the walk, and only the DM hears of it", async () => {
    // A phone's usual flow: tap the token, then drag it. The stopped walk's note wins over its action bar (W4-O-1).
    const bar = player.getByRole("dialog", { name: "Thorn actions" });
    await tapCell(player, BOUNDS, { x: 7, y: 14 });
    await bar.waitFor();
    await dragCells(player, BOUNDS, { x: 7, y: 14 }, { x: 10, y: 14 });
    await thornAt({ x: 8, y: 14, elevation: 10 });
    // The platform's east half has no way up and no way round the wall that the party has seen. The wall stands on the
    // side of the square Thorn stops in, which he sees, so the note names it (D-261027-04).
    const text = "Stopped at a wall. There is no way around it that you have seen.";
    await stopNote(text).getByRole("button", { name: "Teleport here" }).waitFor();
    assert.equal(await bar.count(), 0, "the action bar came back over the stopped walk's note");
    await shots.take(player, "vision-player-stopped-at-wall");
    // A tap on the token, still selected, opens its bar again and the note steps aside, then comes back with the bar closed.
    await tapCell(player, BOUNDS, { x: 8, y: 14 });
    await bar.waitFor();
    await stopNote(text).waitFor({ state: "detached" });
    await bar.getByRole("button", { name: "Close" }).click();
    await stopNote(text).waitFor();
    await stopNote(text).getByRole("button", { name: "Teleport here" }).click();
    await thornAt({ x: 10, y: 14, elevation: 10 });
    await stopNote(text).waitFor({ state: "detached" });
    // The teleport takes the walk back with an undo of its own, which says nothing: the move did not go back.
    assert.equal(await player.getByText("Undid moving Thorn.").count(), 0);

    await dm.getByText("Thorn teleported past a wall.").first().waitFor();
    const line = (dmSocket.state?.log ?? []).find((e) => (e.data as { type?: string } | undefined)?.type === "teleport");
    assert.deepEqual(line?.data, { type: "teleport", tokenId: run.thornId, past: "wall" });
    await viewSettles("the player's view past the wall");
    await shots.take(dm, "vision-dm-teleport-toast");
    await shots.take(player, "vision-player-teleported");
  });

  test("10. ground the party explored stays revealed after it leaves, with no creature on it", async () => {
    // A quarter square in the middle of Thorn's first square: the party saw it, and sees it no longer.
    const sx = START.x * 4 + 2;
    const sy = START.y * 4 + 2;
    assert.equal(revealedIn(playerSocket.state?.fogTiles, sx, sy), true, "the player's fog forgot explored ground");
    assert.equal(revealedIn(dmSocket.state?.exploredTiles, sx, sy), true, "the DM's explored layer lacks it");
    assert.equal(revealedIn(dmSocket.state?.fogTiles, sx, sy), false, "the DM's own fog layer was written");
    assert.equal(sightFromDm().seesToken({ size: "medium", x: START.x, y: START.y }, SQUARES), false, "the party still sees Thorn's first square");
    assert.equal(tokenOf(playerSocket.state, run.goblinId), undefined, "the goblin on explored ground reached the player");

    // The DM moves the goblin across the explored room: still nothing reaches the player.
    await dragCells(dm, BOUNDS, { x: 12, y: 4 }, { x: 6, y: 5 });
    await waitFor("the goblin at (6, 5) for the DM", () => {
      const g = tokenOf(dmSocket.state, run.goblinId);
      return g?.x === 6 && g.y === 5;
    });
    await dm.waitForTimeout(500);
    await viewSettles("the player's view after the goblin crossed explored ground");
    assert.equal(tokenOf(playerSocket.state, run.goblinId), undefined);
    await shots.take(player, "vision-player-explored-behind");
    await shots.take(dm, "vision-dm-explored-outline");
  });

  test("lp2-2e. at 844 x 390 at 130% the stopped walk's note keeps between the bars, its Close and Teleport here in reach", async () => {
    // A phone held sideways at the largest interface size, where the note with its help is taller than the map between the bars.
    await stopNoteAt({ width: 844, height: 390 }, "lp2-2e-stop-note-844x390-130");
  });

  test("lp2-2f. at 480 x 320 at 130%, too short for the note's usual rows, its sentence and help scroll as its body, and the capped search's sentence too, and over a 21 px home bar Close and Teleport here share a row", async () => {
    const scrolls = async (note: Locator) => {
      const body = note.locator("[data-stop-note-body]");
      await body.waitFor();
      /** The help's height in view inside the body once the body is scrolled to its end, and whether the body scrolls at all. */
      const helpInView = () =>
        body.evaluate((el) => {
          type Box = { top: number; bottom: number };
          const b = el as unknown as { scrollTop: number; scrollHeight: number; clientHeight: number; getBoundingClientRect(): Box; querySelector(s: string): { getBoundingClientRect(): Box } | null };
          const scrolls = b.scrollHeight > b.clientHeight + 1;
          b.scrollTop = b.scrollHeight;
          const outer = b.getBoundingClientRect();
          const help = b.querySelector("p")!.getBoundingClientRect();
          return { scrolls, shown: Math.min(outer.bottom, help.bottom) - Math.max(outer.top, help.top) };
        });
      const ordinary = await helpInView();
      assert.ok(ordinary.scrolls, "the body scrolls");
      assert.ok(ordinary.shown > 0, `the help shows ${ordinary.shown} px once scrolled to`);
      // The capped search's sentence, which a scene this size cannot stage, put in the ordinary one's place: the body takes it, and Close and Teleport here stay where they were.
      await note.getByRole("status").evaluate((el) => {
        (el as unknown as { textContent: string }).textContent = "Too far to work out a way around. Stopped at a wall. There is no way around it that you have seen.";
      });
      const capped = await helpInView();
      assert.ok(capped.scrolls && capped.shown > 0, `with the longer sentence the help shows ${capped.shown} px once scrolled to`);
    };
    await stopNoteAt({ width: 480, height: 320 }, "lp2-2f-stop-note-480x320-130", scrolls);
    // Over a phone held sideways with its 21 px home bar, too short for Close over Teleport here: they share one row under the body.
    const cdp = await playerContext.newCDPSession(player);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 21, left: 0, right: 0 } });
    try {
      await stopNoteAt({ width: 480, height: 320 }, "lp2-2f-stop-note-480x320-130-home-bar", async (note) => {
        await note.locator("[data-stop-note-actions]").getByRole("button", { name: "Close", exact: true }).waitFor();
        await scrolls(note);
      });
    } finally {
      await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
      await cdp.detach();
    }
  });

  test("mv-1. on Thorn's turn the player's drag walks round a wall's end, and the trail bends there", async () => {
    // Out of the party's way first: the goblin goes where nobody sees it, so no frame of it reaches the player again.
    await ops.send({ t: "token.update", tokenId: run.goblinId, patch: { visibility: "dm" } });
    const wall: EdgeFeature = { kind: "wall" };
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges: [0, 1, 2, 3].map((y) => ({ key: `8,${y},w`, feature: wall })) });
    await ops.send({ t: "build.paint", sceneId: run.sceneId, terrain: "rubble", cells: ["10,5"] });
    await ops.send({ t: "token.move", tokenId: run.thornId, x: 7, y: 3, elevation: 0 });
    await thornAt({ x: 7, y: 3, elevation: 0 });
    await ops.send({ t: "encounter.start", entries: [{ id: run.entryId, tokenId: run.thornId, value: 15 }] });
    await ops.send({ t: "encounter.next" });
    await waitFor("Thorn's turn in the player's state", () => playerSocket.state?.encounter?.activeEntryId === run.entryId || null);
    await viewSettles("the player's view back in the first room");

    // The wall runs along column 8 from the top down to row 4, so the way to (9, 3) goes round its end.
    await dragCells(player, BOUNDS, { x: 7, y: 3 }, { x: 9, y: 3 });
    await thornAt({ x: 9, y: 3, elevation: 0 });
    const walked = await waitFor("the walk's stop in the player's state", () => tokenOf(playerSocket.state, run.thornId)?.path?.stops.at(-1));
    assert.ok(walked.via && walked.via.length >= 2, `the walk did not bend: ${JSON.stringify(walked)}`);
    assert.ok(Math.max(...walked.via.filter((_, i) => i % 2 === 1)) >= 4, "the walk went through the wall, not round its end");
    await shots.take(player, "vision-player-walked-round-wall");
  });

  test("mv-2. a step into rubble reads 10 ft while dragged", async () => {
    // A new turn, so the marker counts only what follows.
    await ops.send({ t: "encounter.next" });
    await waitFor("Thorn's next turn", () => ((tokenOf(playerSocket.state, run.thornId)?.path?.stops.length ?? 0) <= 1 ? true : null));
    await dragCells(player, BOUNDS, { x: 9, y: 3 }, { x: 9, y: 5 });
    await thornAt({ x: 9, y: 5, elevation: 0 });
    const a = await pagePoint(player, BOUNDS, { x: 9.5, y: 5.5 });
    const b = await pagePoint(player, BOUNDS, { x: 10.5, y: 5.5 });
    await assertCanvasAt(player, a);
    await player.mouse.move(a.x, a.y);
    await player.mouse.down();
    await player.mouse.move(a.x + (b.x - a.x) * 0.2, a.y, { steps: 3 });
    await player.mouse.move(b.x, b.y, { steps: 8 });
    // The kept ruler of test 8 reads "10 ft" too: the drag's label is the one with the band's words.
    const label = await waitFor("the drag's label", async () => (await boardTexts(player)).find((t) => t.startsWith("10 ft · ")));
    assert.equal(label, "10 ft · 10 ft left\n+5 ft for difficult terrain");
    await shots.take(player, "vision-player-rubble-step");
    await player.mouse.up();
    await thornAt({ x: 10, y: 5, elevation: 0 });
    const stop = await waitFor("the rubble step's stop", () => {
      const s = tokenOf(playerSocket.state, run.thornId)?.path?.stops.at(-1);
      return s && s.x === 10 ? s : null;
    });
    assert.deepEqual([stop.moved, stop.cost], [5, 10]);
  });

  test("mv-3. the marker reads what the turn moved and what it used", async () => {
    const marker = await waitFor("the movement marker", async () => (await boardTexts(player)).find((t) => t.startsWith("Moved ")));
    assert.equal(marker, "Moved 15 ft, used 20 ft\n10 ft left");
    await shots.take(player, "vision-player-moved-used");
    await ops.send({ t: "encounter.end" });
  });

  test("lp2-2b. a walking ruler keeps its total while its walk is searched, and the search shows on its line and ends", async () => {
    // The DM's own ruler, which stays on the DM's screen, so no frame of it reaches the player.
    await dm.getByRole("button", { name: "Ruler", exact: true }).click();
    await pickOption(dm, "Ruler", "Measure", "Walking");
    const line = dm.getByRole("toolbar", { name: "Ruler options" }).locator("[data-options-line]");
    // What each frame shows: the line marked while a walk is searched, the board's total, and its wait.
    await dm.evaluate(() => {
      type Node = { text(): string; isVisible(): boolean };
      const g = globalThis as unknown as {
        Konva: { stages: { find(selector: string): Node[] }[] };
        document: { querySelector(s: string): { hasAttribute(name: string): boolean } | null };
        requestAnimationFrame(cb: () => void): number;
        lp2Frames: { finding: boolean; walk: boolean; waiting: boolean }[];
        lp2Stop: boolean;
      };
      g.lp2Frames = [];
      g.lp2Stop = false;
      const read = () => {
        const texts = g.Konva.stages[0]!.find("Text")
          .filter((t) => t.isVisible())
          .map((t) => t.text());
        g.lp2Frames.push({
          finding: g.document.querySelector("[data-options-line]")?.hasAttribute("data-finding") === true,
          walk: texts.some((t) => t.startsWith("Walking ")),
          waiting: texts.includes("Finding the way…"),
        });
        if (!g.lp2Stop) g.requestAnimationFrame(read);
      };
      g.requestAnimationFrame(read);
    });
    const at = (x: number, y: number) => pagePoint(dm, BOUNDS, { x: x + 0.5, y: y + 0.5 });
    const start = await at(13, 3);
    await dm.mouse.move(start.x, start.y);
    // For the drag only, each frame's route work (features/movement/boardWork.ts) stops at a few units, so every walk the drag asks for
    // is searched over several frames, on a fast machine as on a slow one (review LP2L2-E2E-CPU). The line's data-finding, asserted
    // below, shows that it was.
    await dm.evaluate((units) => {
      (globalThis as unknown as { rvttRouteUnitsPerFrame?: number }).rvttRouteUnitsPerFrame = units;
    }, ROUTE_UNITS_PER_FRAME);
    try {
      await dm.mouse.down();
      // Round the room and through the wall's door, up onto the platform and back, so each stop's walk is searched anew.
      for (const [x, y] of [
        [13, 7],
        [6, 8],
        [2, 13],
        [5, 15],
        [10, 15],
        [12, 17],
        [4, 12],
      ] as const) {
        const p = await at(x, y);
        await dm.mouse.move(p.x, p.y, { steps: 6 });
        await dm.waitForTimeout(120);
      }
      await dm.mouse.up();
    } finally {
      await dm.evaluate(() => delete (globalThis as unknown as { rvttRouteUnitsPerFrame?: number }).rvttRouteUnitsPerFrame);
    }
    // The last walk is found, and the line no longer says it is searching.
    await waitFor("the walk found", async () => ((await line.getAttribute("data-finding")) === null ? true : null));
    await dm.waitForTimeout(200);
    const frames = await dm.evaluate(() => {
      const g = globalThis as unknown as { lp2Frames: { finding: boolean; walk: boolean; waiting: boolean }[]; lp2Stop: boolean };
      g.lp2Stop = true;
      return g.lp2Frames;
    });
    await shots.take(dm, "lp2-2b-walking-ruler");
    assert.ok(
      frames.some((f) => f.finding),
      "no frame showed a walk being searched, so nothing here was tested",
    );
    assert.equal(frames.at(-1)?.finding, false, "the search ended");
    const first = frames.findIndex((f) => f.walk);
    assert.ok(first >= 0, "the walking ruler never read a total");
    const searchedAfter = frames.slice(first).filter((f) => f.finding).length;
    assert.ok(searchedAfter > 0, "no walk was searched once the ruler had a total");
    const blank = frames.slice(first).filter((f) => !f.walk && !f.waiting).length;
    assert.equal(blank, 0, `the total went blank in ${blank} of ${frames.length - first} frames, ${searchedAfter} of them searching`);
    await pickOption(dm, "Ruler", "Measure", "Straight");
    await dm.getByRole("button", { name: "Select", exact: true }).click();
  });

  test("11. no frame the player received held anything out of the party's sight, and every ruler stood on its measurer's ground", () => {
    const frames = framesFrom(0);
    const start = run.startSight;
    assert.ok(start);
    let goblinDrags = 0;
    let rulers = 0;
    let keptWithGround = 0;
    for (const [i, frame] of frames.entries()) {
      for (const change of frame.changes ?? []) {
        assert.equal(change.key.startsWith("explored:"), false, `frame ${i}: the explored layer reached the player`);
        assert.equal(change.key.startsWith("light:"), false, `frame ${i}: a light reached the player`);
        const drawing = change.value as Drawing | undefined;
        if (change.key.startsWith("drawing:") && drawing?.kind === "ruler") {
          assert.deepEqual(Object.keys(drawing).filter((k) => !DRAWING_FIELDS.has(k)), [], `frame ${i}: a kept ruler with a new field`);
          if (drawing.z !== undefined) {
            keptWithGround++;
            assert.equal(drawing.z.length, drawing.points.length / 2, `frame ${i}: a kept ruler without one height per stop`);
            for (const [s, feet] of drawing.z.entries()) if (drawing.anchors?.[s]) assert.equal(feet, 0, `frame ${i}: a kept ruler's stop on a token stands on ground`);
          }
        }
        if (change.key !== `token:${run.goblinId}` || change.deleted) continue;
        // The goblin reached the player only while it stood in the torchlight, before Thorn moved.
        const goblin = change.value as Token;
        assert.ok(i < run.thornMovedAt, `frame ${i}: the goblin reached the player after it left the light`);
        assert.equal(start.seesToken(goblin, SQUARES), true, `frame ${i}: the goblin at ${goblin.x},${goblin.y} reached the player out of sight`);
      }
      const e = frame.t === "eph" ? frame.e : undefined;
      if (e?.k === "ruler") {
        rulers++;
        assert.deepEqual(Object.keys(e).filter((k) => !["k", "id", "points", "shared"].includes(k)), [], `frame ${i}: a ruler frame with a new field`);
        for (const p of e.points ?? []) {
          assert.deepEqual(Object.keys(p).filter((k) => !["x", "y", "z", "tokenId"].includes(k)), [], `frame ${i}: a ruler stop with a new field`);
          // Only the DM's rulers reach the player, and the DM stands every free stop on the ground there.
          if (p.tokenId !== undefined) assert.equal(p.z, undefined, `frame ${i}: a stop on a token stands on ground`);
          else assert.equal(p.z ?? 0, layoutGround(p.x, p.y), `frame ${i}: a stop at ${p.x},${p.y} off the measurer's ground`);
        }
      }
      if (e) {
        assert.equal(e.path, undefined, `frame ${i}: a drag frame carried its path`);
        if (e.tokenId === run.goblinId && e.k !== "dragCancel") {
          assert.ok(i < run.goblinGoneAt, `frame ${i}: a goblin drag frame after it left the light`);
          assert.equal(start.seesToken({ size: "medium", x: e.x!, y: e.y! }, SQUARES), true, `frame ${i}: a goblin ${e.k} at ${e.x},${e.y} out of sight`);
          goblinDrags++;
        }
      }
    }
    assert.equal(playerSocket.everSaw(run.bossId), false, "the boss in the closet reached the player");
    assert.equal(playerSocket.everSaw(run.lightId), false, "the closet's candle reached the player");
    assert.equal(playerSocket.everSaw("Closet candle"), false);
    assert.equal(playerSocket.everSaw('"teleport","tokenId"'), false, "the DM's teleport line reached the player");
    assert.ok(playerSocket.everSaw(run.goblinId), "the goblin never showed at all");
    // The DM's drag reached the player while the goblin was in the light, so the filter passes what it should.
    assert.ok(goblinDrags > 0, "no goblin drag frame reached the player");
    assert.equal(Object.keys(playerSocket.state?.exploredTiles ?? {}).length, 0);
    assert.equal(Object.keys(playerSocket.state?.lights ?? {}).length, 0);
    assert.ok(rulers > 0, "no ruler frame reached the player");
    assert.ok(keptWithGround > 0, "no kept ruler with its ground reached the player");

    // The player's ruler frames stand only on ground the player could see when they were sent: all of them came while the
    // player measured, and nothing moved the fog then.
    const measured = run.playerRulers;
    assert.ok(measured);
    let playerStops = 0;
    for (const [i, frame] of framesFrom(0, dmSocket).entries()) {
      if (frame.t !== "eph" || frame.e?.k !== "ruler" || frame.from !== run.patId) continue;
      assert.ok(i >= measured.from && i < measured.to, `DM frame ${i}: a ruler of the player's outside their measuring`);
      for (const p of frame.e.points ?? []) {
        if (p.z === undefined) continue;
        playerStops++;
        assert.equal(isCellFullyFogged(measured.fog, run.sceneId, { x: Math.floor(p.x), y: Math.floor(p.y) }), false, `DM frame ${i}: the player's stop at ${p.x},${p.y} stood on ground under their fog`);
        assert.equal(p.z, layoutGround(p.x, p.y), `DM frame ${i}: the player's stop at ${p.x},${p.y} off the ground`);
      }
    }
    assert.ok(playerStops > 0, "no stop of the player's stood on raised ground");
  });

  test("pv4-1. on a per-player scene the DM's list of who sees for themselves asks before an untick, Escape and Cancel answer no and Untick sends the list, focus on the box through each", async () => {
    // Six more players, who own no creature here, so the server's join step never lists them.
    for (const [name, color] of [["Ash", "#e5484d"], ["Bo", "#f76b15"], ["Cy", "#ffc53d"], ["Dee", "#46a758"], ["Eli", "#0090ff"], ["Fen", "#8e4ec6"]] as const) {
      const context = await browser.newContext();
      try {
        const headers = { Origin: server.origin, "content-type": "application/json" };
        const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
        assert.ok(joined.ok(), `joining answered ${joined.status()}`);
        const { ticket } = (await joined.json()) as { ticket: string };
        const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
        assert.ok(done.ok(), `completing the join answered ${done.status()}`);
        run.extraIds.push(((await done.json()) as { member: { id: string } }).member.id);
      } finally {
        await context.close();
      }
    }
    const page = await openDm2();
    await openSideTab(page, "Scenes");
    const panel = page.getByRole("tabpanel", { name: sideTabName("Scenes") });
    await panel.getByRole("radiogroup", { name: "Sight" }).getByRole("radio", { name: "Per player" }).check();
    await waitFor("the scene per player in the DM's state", () => dmSocket.state?.scenes[run.sceneId]?.vision?.perPlayer === true || null);
    await ops.send({ t: "vision.holders", sceneId: run.sceneId, on: [run.patId] });
    await waitFor("Pat listed on", () => holderEntry(run.patId)?.on === true || null);
    const list = panel.getByRole("group", { name: "Who sees for themselves" });
    const pat = list.getByRole("checkbox", { name: "Pat" });
    await waitFor("Pat ticked", async () => (await pat.isChecked()) || null, 5_000);
    const question = list.getByRole("group", { name: "Untick Pat?" });
    const ask = async (how: string) => {
      await pat.focus();
      await page.keyboard.press("Space");
      await question.waitFor();
      assert.equal(await hasFocus(pat), true, `focus left Pat's box as the question opened${how}`);
      assert.equal(await pat.isChecked(), true, `Pat's box unticked before the question was answered${how}`);
      assert.match((await question.getByRole("status").innerText()).trim(), /^Untick Pat\? They forget their map of this scene\.$/);
    };

    // Escape, pressed on the box itself, answers no and leaves the panel open (review PV4-ASTRA-1).
    let from = dm2.sent.length;
    await ask("");
    await page.keyboard.press("Escape");
    await question.waitFor({ state: "detached" });
    assert.equal(await hasFocus(pat), true, "focus left Pat's box on Escape");
    assert.equal(await pat.isChecked(), true, "Escape unticked Pat");
    assert.equal(await list.isVisible(), true, "Escape closed the Scenes panel too");
    await shots.take(page, "vision-pv4-holders-after-escape");

    await ask(", the second time");
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await question.waitFor({ state: "detached" });
    assert.equal(await hasFocus(pat), true, "focus did not come back to Pat's box from Cancel");
    assert.equal(await pat.isChecked(), true, "Cancel unticked Pat");
    assert.deepEqual(holderOpsSent(from), [], "Escape or Cancel sent the list");

    from = dm2.sent.length;
    await ask(", the third time");
    await question.getByRole("button", { name: "Untick", exact: true }).click();
    await question.waitFor({ state: "detached" });
    assert.deepEqual(holderOpsSent(from), [{ on: [] }], "Untick sent no list, or another");
    await waitFor("Pat listed off", () => holderEntry(run.patId)?.on === false || null);
    await list.getByText("Pat sees only what creatures that share sight see here.").waitFor();
    assert.equal(await pat.isChecked(), false, "the list kept Pat ticked");
    assert.equal(await hasFocus(pat), true, "focus did not come back to Pat's box from Untick");
    await shots.take(page, "vision-pv4-holders-pat-off");
  });

  test("pv4-2. with six players ticked a seventh tick is refused in the list's own status, and the page sends nothing", async () => {
    const page = dm2.page!;
    const panel = page.getByRole("tabpanel", { name: sideTabName("Scenes") });
    const list = panel.getByRole("group", { name: "Who sees for themselves" });
    await ops.send({ t: "vision.holders", sceneId: run.sceneId, on: run.extraIds });
    for (const name of ["Ash", "Bo", "Cy", "Dee", "Eli", "Fen"]) {
      const box = list.getByRole("checkbox", { name });
      await waitFor(`${name} ticked`, async () => (await box.isChecked()) || null, 5_000);
    }
    const from = dm2.sent.length;
    const pat = list.getByRole("checkbox", { name: "Pat" });
    await pat.click();
    await list.getByRole("status").filter({ hasText: "At most 6 players see for themselves here. Untick one first." }).waitFor();
    assert.equal(await pat.isChecked(), false, "a refused tick shows Pat ticked");
    assert.equal(await hasFocus(pat), true, "focus left Pat's box on the refusal");
    await page.waitForTimeout(300);
    assert.deepEqual(holderOpsSent(from), [], "a refused tick left the device");
    assert.equal(holderEntry(run.patId)?.on, false);
    await shots.take(page, "vision-pv4-holders-refused");
  });

  test("pv4-3. while a light change is on its way on a per-player scene, the line under Party vision says what each player sees is worked out", async () => {
    const page = dm2.page!;
    const panel = page.getByRole("tabpanel", { name: sideTabName("Scenes") });
    try {
      dm2.held = [];
      await panel.getByRole("radiogroup", { name: "Light level" }).getByRole("radio", { name: "Dim", exact: true }).check();
      await waitFor("the light change held", () => dm2.held!.length > 0 || null, 5_000);
      const working = panel.getByText("Working out what each player sees…", { exact: true });
      await working.waitFor();
      await working.scrollIntoViewIfNeeded();
      assert.equal(await panel.getByText("Working out what the party sees…").count(), 0, "the working line spoke of the party on a per-player scene");
      await shots.take(page, "vision-pv4-light-working");
      const held = dm2.held!;
      dm2.held = null;
      for (const text of held) dm2.upstream!.send(text);
      await working.waitFor({ state: "detached" });
      await waitFor("the dim light in the DM's state", () => dmSocket.state?.scenes[run.sceneId]?.vision?.light === "dim" || null);
    } finally {
      dm2.held = null;
      await ops.send({ t: "vision.holders", sceneId: run.sceneId, on: [run.patId] });
      await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { vision: { on: true, light: "dark", perPlayer: false } } });
      await page.close();
      dm2.page = null;
    }
  });

  test("pv4-4. in View as a player the Log's older pages ask as Pat, and are taken only when the answer says it was as Pat", async () => {
    // The server's preview is PV3's, so the run answers the preview's socket with Pat's own view, and the log's older pages itself.
    await ops.send({ t: "log.chat", text: "Before the archive" });
    await waitFor("the line in Pat's log", () => playerSocket.state?.log.some((e) => e.text === "Before the archive") || null);
    const last = framesFrom(0).reverse().find((f) => f.t === "snapshot") as { seq?: number; watermark?: number } | undefined;
    assert.ok(last, "the player never got a snapshot");
    // The watch keeps `you` from Pat's last snapshot, sent before the DM moved the players here.
    const snapshot = JSON.stringify({ t: "snapshot", seq: last.seq, state: playerSocket.state, you: { ...playerSocket.you!, sceneId: run.sceneId }, watermark: last.watermark });
    const asked: string[] = [];
    let answer: { as?: string } = {};
    const page = await dmContext.newPage();
    dmConsole.attach(page);
    await page.routeWebSocket(/[?&]as=(?!display)/, (ws) => {
      ws.onMessage((m) => {
        const msg = JSON.parse(typeof m === "string" ? m : m.toString("utf8")) as { t?: string; k?: number };
        if (msg.t === "hello") ws.send(snapshot);
        else if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong", k: msg.k }));
      });
    });
    await page.route(/\/api\/rooms\/[0-9A-Z]{8}\/log\?/, (route) => {
      asked.push(route.request().url());
      const entries = [{ id: "0:0", at: new Date().toISOString(), kind: "chat", from: run.patId, text: "From the archive" }];
      void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries, nextBefore: null, ...answer }) });
    });
    try {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await openSideTab(page, "DM");
      const dmPanel = page.getByRole("tabpanel", { name: sideTabName("DM") });
      await dmPanel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
      await dmPanel.getByRole("button", { name: "View", exact: true }).click();
      const preview = page.locator('dialog[aria-label="Viewing as Pat"]');
      await preview.waitFor();
      // Its tab row settles first: until it is measured, More holds every tab, and the Log it lists then is gone once it is.
      await preview.getByRole("tab", { name: sideTabName("Log") }).waitFor();
      await openSideTab(preview, "Log");
      const log = preview.getByRole("tabpanel", { name: sideTabName("Log") });
      await log.getByText("Before the archive").waitFor();
      const older = log.getByRole("button", { name: "Show older", exact: true });
      const refused = log.getByRole("alert").filter({ hasText: "Could not load older messages." });
      const archived = log.getByText("From the archive");

      // A page without the answer, as from a server that ignores `as`, and one answered as the DM, are both refused.
      for (const [i, as] of [undefined, dmSocket.you!.memberId].entries()) {
        answer = as === undefined ? {} : { as };
        await older.click();
        await waitFor(`older page ${i + 1} asked`, () => asked.length === i + 1 || null);
        await refused.waitFor();
        assert.equal(await archived.count(), 0, `a page answered ${as === undefined ? "with no one" : "as the DM"} was shown as Pat's`);
      }
      answer = { as: run.patId };
      await older.click();
      await archived.waitFor();
      await log.getByText("This is the start of the log.").waitFor();
      assert.equal(asked.length, 3);
      for (const url of asked) {
        const q = new URL(url).searchParams;
        assert.equal(q.get("as"), run.patId, `the preview's older page asked as ${q.get("as")}: ${url}`);
        assert.equal(q.get("sceneId"), null, `the preview's older page followed the DM's scene: ${url}`);
      }
      await shots.take(page, "vision-pv4-preview-older-log");
      await preview.getByRole("button", { name: "Exit", exact: true }).click();
      await preview.waitFor({ state: "detached" });
    } finally {
      await page.close();
    }
  });

  test("12. no page logged an error or a warning", () => {
    for (const c of [dmConsole, playerConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
