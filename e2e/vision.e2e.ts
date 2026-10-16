import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BuildChunk, Drawing, EdgeFeature, RoomState, SightTile, Token } from "#shared/model.ts";
import type { PartySight } from "#shared/ruleHooks.ts";
import { decodeTile, getBit, isCellFullyFogged, TILE_CELLS } from "#shared/rules/fog.ts";
import { groundAt } from "#shared/rules/heights.ts";
import { partyMember, partySight, type VisionWorld } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { assertCanvasAt, ConsoleWatch, dragCells, openSideTab, OpSocket, pagePoint, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

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
 * opens it, stops at a ledge and takes the stair, reads the platform's and
 * the stair's height with a tap (docs/design-v1-heights-readout.md), measures
 * up onto the platform, teleports past a wall, and leaves explored ground
 * behind.
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
    const shown = token.visibility === "all" && (partyMember(dmState, token) || token.fogExempt || sight.seesToken(token));
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

/** The stopped walk's note on the player's screen. */
function stopNote(text: string) {
  return player.getByRole("status").filter({ hasText: text });
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

/** A cell's ground as the layout painted it. The run paints nothing after, so it is the ground every ruler stood on. */
function layoutGround(x: number, y: number): number {
  return groundAt(dmSocket.state?.buildChunks ?? {}, run.sceneId, Math.floor(x), Math.floor(y));
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
    assert.equal(run.startSight.seesToken({ size: "medium", x: 11, y: 4 }), true, "the torch reaches (11, 4)");
    assert.equal(run.startSight.seesToken({ size: "medium", x: 12, y: 4 }), false, "the torch stops short of (12, 4)");
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
    assert.equal(await stopNote("in the way").count(), 0, "a note after a walk that was not stopped");
  });

  test("5. a ledge stops a walking token, and the stair takes it up", async () => {
    await dragCells(player, BOUNDS, { x: 3, y: 12 }, { x: 7, y: 12 });
    await thornAt({ x: 5, y: 12, elevation: 0 });
    await stopNote("Ledge in the way. Take the stairs.").waitFor();
    await shots.take(player, "vision-player-stopped-at-ledge");
    await closeNote("Ledge in the way. Take the stairs.");

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
    await dm.locator("select").filter({ has: dm.locator('option[value="height"]') }).first().selectOption("height");
    const stepper = dm.getByRole("group", { name: "Height" });
    const plus = stepper.getByRole("button", { name: "5 ft higher" });
    assert.equal((await stepper.innerText()).trim(), "10 ft up");
    const b = await plus.boundingBox();
    assert.ok(b);
    await dm.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await dm.mouse.down();
    await waitFor("the stepper at 100 ft", async () => (await stepper.innerText()).trim() === "100 ft up", 5_000);
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
      assert.equal((await stepper.innerText()).trim(), end, `a held Enter on ${name}`);
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
    const text = "Stopped at a wall. Drop at the corner first, then go on.";
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
    assert.equal(sightFromDm().seesToken({ size: "medium", x: START.x, y: START.y }), false, "the party still sees Thorn's first square");
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
        assert.equal(start.seesToken(goblin), true, `frame ${i}: the goblin at ${goblin.x},${goblin.y} reached the player out of sight`);
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
          assert.equal(start.seesToken({ size: "medium", x: e.x!, y: e.y! }), true, `frame ${i}: a goblin ${e.k} at ${e.x},${e.y} out of sight`);
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

  test("12. no page logged an error or a warning", () => {
    for (const c of [dmConsole, playerConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
