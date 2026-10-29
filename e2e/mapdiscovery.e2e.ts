import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { autoAt, knownAt } from "#shared/discoveryTestutil.ts";
import { CHUNK_CELLS, type EdgeFeature, type PlayerChunk, type RoomState } from "#shared/model.ts";
import { SOMETHING_BLOCKS } from "#shared/permissions.ts";
import { privateFieldsIn } from "#shared/privateFields.ts";
import { applyChanges, type ProjectedState } from "#shared/project.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { partySight } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { assertCanvasAt, ConsoleWatch, dragCells, openSideTab, OpSocket, pagePoint, pickOption, pickTool, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Map discovery (docs/design-v1-map-discovery.md section 10, steps md-1 to
 * md-9): the real server serving the production build, a DM on a
 * computer, Ben on a phone and a table display, across four scenes with
 * fog on. Ben plays Bree, who carries a torch, and Mole, who carries none.
 *
 * - Sunken halls, dark, fog and party vision on: a hall where Bree starts,
 *   with two doors in its north wall, a corridor running east from it into
 *   the dark, and a treasury south of the corridor that nobody ever sees,
 *   with a door, a wall, raised floor, a label and a stamp. Mole waits in
 *   the dark south of the corridor.
 * - Reveal hall, fog on and party vision off: the DM reveals its west part
 *   by hand. Astra's wall (ASTRA-34) crosses it, with a door beside it.
 * - Open mat, bright, fog and party vision on, with nothing built.
 * - Great cavern, bright, floored in stone wall to wall, big enough that
 *   clearing it out of the party's sight runs past what their map keeps.
 *
 * At the end every frame Ben's page and the display received is replayed:
 * neither ever held the treasury, the Reveal hall's east part before the
 * DM revealed it, or the hall's changes made while the party was away.
 *
 * It runs with `pnpm test:e2e` on its own port, E2E_PORT plus thirty-six,
 * which no other file uses. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 36;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-mapdiscovery-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

type Cell = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

/**
 * Sunken halls, 24 by 12 squares. Bree's torch (bright 20 ft, dim 20 ft
 * more) lights 8 squares round her.
 */
const HALLS = {
  bounds: { w: 24, h: 12 },
  hall: { x: 0, y: 1, w: 7, h: 7 },
  /** One square wide, along row 4 from the hall's east side to the scene's. */
  corridor: { x: 7, y: 4, w: 17, h: 1 },
  /** South of the corridor, its walls the painted floor's own: no light the party carries ever reaches in. */
  treasury: { x: 14, y: 7, w: 7, h: 4 },
  treasuryDoor: "17,7,n",
  treasuryWall: { id: "treasurywl01", a: [15.25, 9.5] as [number, number], b: [19.75, 9.5] as [number, number] },
  treasuryRaised: ["15,8", "16,8"],
  label: "Gold of the drowned king",
  /** The hall's doors, in its north wall: the DM takes the first away while the party is gone, and a monster opens the second. */
  doorGone: "2,1,n",
  doorOpened: "4,1,n",
  /** The wall the DM adds across the hall's south end while the party is gone, clear of the line from the hall's middle to its north doors. */
  hallWall: { id: "hallwallnew1", a: [1.25, 6.5] as [number, number], b: [4.75, 6.5] as [number, number] },
  /** Across the corridor, where the party never went. */
  darkWall: "22,4,w",
  breeAt: { x: 2, y: 4 },
  /** Past the end of what Bree's torch first shows down the corridor, and short of the dark wall. */
  breeFar: { x: 12, y: 4 },
  moleAt: { x: 9, y: 9 },
};

/** Reveal hall, 16 by 12 squares, fog on and party vision off, revealed by hand west of x = 12. */
const REVEAL = {
  bounds: { w: 16, h: 12 },
  revealed: { x: 0, y: 0, w: 12, h: 12 },
  /** Astra's wall: it passes 0.00004 of a square north of (5.5, 5.5), so a walk from (5, 6) to (5, 5) ends inside a piece's band. */
  astra: { id: "astrawall001", a: [4.265625, 6.484375] as [number, number], b: [10.515625, 1.5] as [number, number] },
  /** A door the walk's end reaches by a line inside the same band. */
  door: "6,5,w",
  /** The east part, under the fog until md-7 reveals it. */
  east: { x: 13, y: 2, w: 3, h: 6 },
  eastWall: "14,9,n",
  /** A wall the DM adds on revealed ground while Ben watches. */
  liveWall: "2,2,n",
  breeAt: { x: 5, y: 6 },
};

/** Open mat, 20 by 12 squares, bright, with nothing built. */
const MAT = {
  bounds: { w: 20, h: 12 },
  breeAt: { x: 3, y: 6 },
  /** The room the DM drags out with Rectangle room, corner to corner. */
  room: { from: { x: 12, y: 3 }, to: { x: 17, y: 9 } },
  inside: { x: 14, y: 6 },
};

/**
 * Great cavern: 5,120 squares of stone the party sees, so clearing the
 * build while the party is away asks the map to remember each square's
 * floor, 16 bytes apiece, past its cap of 64 KiB a layer, in one op.
 */
const CAVERN = { bounds: { w: 80, h: 64 }, breeAt: { x: 40, y: 32 } };

/** Closet, 8 by 6 squares, bright, fog and party vision on: a room of 3 by 2 squares walled all round by its floor's edges, Bree in its west corner. */
const CLOSET = { bounds: { w: 8, h: 6 }, room: { x: 2, y: 2, w: 3, h: 2 }, breeAt: { x: 2, y: 2 }, westWall: "2,2,w" };

const run = {
  roomId: "",
  /** Shown in the guide's pictures, so it reads as a table's room would. */
  roomName: "The drowned king",
  password: "",
  halls: "",
  reveal: randomUUID(),
  mat: randomUUID(),
  cavern: randomUUID(),
  benId: "",
  closet: randomUUID(),
  bree: { halls: randomUUID(), reveal: randomUUID(), mat: randomUUID(), cavern: randomUUID(), closet: randomUUID() },
  moleId: randomUUID(),
  labelId: randomUUID(),
  stampId: randomUUID(),
  /** Frames Ben's page and the display had received when the party left the hall (md-3) and when it saw it again (md-4). */
  leftAt: { ben: -1, tv: -1 },
  backAt: { ben: -1, tv: -1 },
  /** Frames each had received when the DM revealed the Reveal hall's east part (md-7). */
  eastAt: { ben: -1, tv: -1 },
};

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let benContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let ben: Page;
let tv: Page;
let ops: OpSocket;
const sockets = { dm: new SocketWatch("dm"), ben: new SocketWatch("ben"), tv: new SocketWatch("display") };
const consoles = { dm: new ConsoleWatch("dm"), ben: new ConsoleWatch("ben"), tv: new ConsoleWatch("display") };

/** Joins the room as a player from a context, as the join page does, and returns the new member's id. */
async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

async function cookieOf(context: BrowserContext): Promise<string> {
  return (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
}

function actor() {
  return { hp: { cur: 20, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

const TORCH = { bright: 20, dim: 20 };
/** The builder's note while the party's sight meets a cell being built (design section 9). */
const BUILD_IN_SIGHT = "The party can see where you are building, so they see it as you build. Build before players come here, or tap Fog all when done.";

/** One of Ben's characters on a scene, with a torch unless `dark`. */
function pc(id: string, sceneId: string, name: string, at: Cell, dark = false) {
  return {
    t: "token.create",
    token: { id, sceneId, kind: "pc", disposition: "ally", name, size: "medium", ...at, visibility: "all", ownerIds: [run.benId], actor: { inline: actor() }, ...(dark ? {} : { light: TORCH }) },
  };
}

function rectCells(r: Rect): string[] {
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(`${x},${y}`);
  return out;
}

/** The chunk of a copy holding a cell of a scene. */
function chunkOf(state: RoomState | null, sceneId: string, x: number, y: number): PlayerChunk | undefined {
  return state?.buildChunks[`${sceneId}:${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`] as PlayerChunk | undefined;
}

function edgeIn(state: RoomState | null, sceneId: string, key: string): EdgeFeature | undefined {
  const [x, y] = key.split(",").map(Number) as [number, number];
  return chunkOf(state, sceneId, x, y)?.edges[key];
}

function cellIn(state: RoomState | null, sceneId: string, x: number, y: number): string | undefined {
  return chunkOf(state, sceneId, x, y)?.cells[`${x},${y}`];
}

/** Every free wall or piece a copy holds on a scene. */
function wallsIn(state: RoomState | null, sceneId: string): { a: [number, number]; b: [number, number] }[] {
  return Object.values(state?.buildChunks ?? {}).flatMap((c) => (c && c.sceneId === sceneId ? (c.walls ?? []) : []));
}

/** Whether a copy holds a piece along a wall's line, between its ends. */
function holdsAlong(state: RoomState | null, sceneId: string, wall: { a: [number, number]; b: [number, number] }): boolean {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const on = (p: [number, number]) => Math.abs((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)) < 1e-3 * Math.hypot(bx - ax, by - ay);
  return wallsIn(state, sceneId).some((w) => on(w.a) && on(w.b));
}

function tokenAt(state: RoomState | null, id: string): Cell | null {
  const t = state?.tokens[id];
  return t ? { x: t.x, y: t.y } : null;
}

/** Waits for one of Ben's creatures to stand at a spot in his copy, which the server's answer writes. */
async function standsAt(id: string, name: string, at: Cell): Promise<void> {
  try {
    await waitFor(`${name} at ${at.x},${at.y}`, () => {
      const t = tokenAt(sockets.ben.state, id);
      return (t?.x === at.x && t.y === at.y) || null;
    });
  } catch (err) {
    const t = tokenAt(sockets.ben.state, id);
    throw new Error(`${(err as Error).message}: ${name} is at ${t?.x},${t?.y}`);
  }
}

/**
 * Sends a log line and waits for Ben's copy to hold it, so every change
 * the DM sent before it has reached his page: the server answers each
 * socket in the order its changes were made. The display holds no log.
 */
async function settle(what: string): Promise<void> {
  const text = `Settled: ${what} ${randomUUID().slice(0, 8)}`;
  await ops.send({ t: "log.chat", text });
  await waitFor(`${what} on Ben's page`, () => sockets.ben.state?.log.some((e) => e.text === text) || null);
}

/** Moves the players to a scene and waits for Ben's and the display's copies to show it. */
async function playersTo(sceneId: string): Promise<void> {
  await ops.send({ t: "room.setPlayerScene", sceneId });
  await waitFor("the players on the scene", () => (sockets.ben.state?.meta.playerSceneId === sceneId && sockets.tv.state?.meta.playerSceneId === sceneId) || null);
}

/** Moves the DM's own page to a scene, from the Scenes tab. */
async function dmTo(name: string, sceneId: string): Promise<void> {
  await openSideTab(dm, "Scenes");
  await dm.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await waitFor(`the DM on ${name}`, () => sockets.dm.you?.sceneId === sceneId || null, 30_000);
  await dm.locator(".konvajs-content").first().waitFor();
}

/** Presses the Map builder's Clear build, behind ⋯, and its second tap. */
async function clearBuild(page: Page): Promise<void> {
  await page.getByRole("toolbar", { name: "Map builder options" }).getByRole("button", { name: "More options" }).click();
  const more = page.getByRole("dialog", { name: "More Map builder options" });
  await more.getByRole("button", { name: "Clear build", exact: true }).click();
  await more.getByRole("button", { name: "Tap again to clear" }).click();
  if (await more.isVisible()) await page.keyboard.press("Escape");
}

/**
 * Starts recording where a token's node stands on a page's board, every
 * frame it draws while the node is not being dragged, until `stoodAt`
 * reads them back: a move the page predicts shows there before the
 * server's answer, though no copy of the state holds it.
 */
async function watchStanding(page: Page, tokenId: string): Promise<void> {
  await page.evaluate((id) => {
    type Node = { x(): number; y(): number; isDragging(): boolean };
    type Stage = { findOne(selector: string): Node | undefined };
    const g = globalThis as unknown as { Konva: { stages: Stage[] }; requestAnimationFrame(f: () => void): number; __mdStood?: { at: [number, number][]; on: boolean } };
    const log: { at: [number, number][]; on: boolean } = { at: [], on: true };
    g.__mdStood = log;
    const tick = () => {
      if (!log.on) return;
      const node = g.Konva.stages.map((st) => st.findOne(`#${id}`)).find((n) => n !== undefined);
      if (node && !node.isDragging()) log.at.push([node.x(), node.y()]);
      g.requestAnimationFrame(tick);
    };
    tick();
  }, tokenId);
}

async function stoodAt(page: Page): Promise<[number, number][]> {
  return page.evaluate(() => {
    const g = globalThis as unknown as { __mdStood?: { at: [number, number][]; on: boolean } };
    if (g.__mdStood) g.__mdStood.on = false;
    return g.__mdStood?.at ?? [];
  });
}

/** Whether any `ev` a page received from frame `from` on answered an op the page sent. */
function answeredOps(watch: SocketWatch, from: number): boolean {
  return watch.received.slice(from).some((text) => {
    const frame = JSON.parse(text) as { t?: string; acks?: number[]; rejects?: unknown[] };
    return frame.t === "ev" && ((frame.acks?.length ?? 0) > 0 || (frame.rejects?.length ?? 0) > 0);
  });
}

function stopNote(text: string): Locator {
  return ben.locator("[data-stop-note]").filter({ has: ben.getByRole("status").filter({ hasText: text }) });
}

async function closeNote(text: string): Promise<void> {
  await stopNote(text).getByRole("button", { name: "Close" }).click();
  await stopNote(text).waitFor({ state: "detached" });
}

type Frame = { t?: string; state?: ProjectedState; changes?: Parameters<typeof applyChanges>[1] };

/** Replays every frame a page received from its first, and returns the frames after which its copy broke `rule`, by index, with what it held. */
function replay(watch: SocketWatch, rule: (state: RoomState, index: number) => string | null): string[] {
  let state: ProjectedState | null = null;
  const broken: string[] = [];
  watch.received.forEach((text, index) => {
    const frame = JSON.parse(text) as Frame;
    if (frame.t === "snapshot" && frame.state) state = frame.state;
    else if (frame.t === "ev" && frame.changes && state) state = applyChanges(state, frame.changes);
    else return;
    const wrong = rule(state as unknown as RoomState, index);
    if (wrong) broken.push(`frame ${index}: ${wrong}`);
  });
  return broken;
}

/** What of the treasury a copy holds, or null for nothing (md-1). */
function treasuryIn(state: RoomState | null): string | null {
  const t = HALLS.treasury;
  for (let y = t.y; y < t.y + t.h; y++) {
    for (let x = t.x; x < t.x + t.w; x++) {
      const c = chunkOf(state, run.halls, x, y);
      if (knownAt(c, x, y)) return `the treasury's cell ${x},${y}`;
      if (c?.cells[`${x},${y}`]) return `the treasury's floor at ${x},${y}`;
    }
  }
  if (edgeIn(state, run.halls, HALLS.treasuryDoor)) return "the treasury's door";
  if (holdsAlong(state, run.halls, HALLS.treasuryWall)) return "the treasury's wall";
  if (state?.labels[run.labelId]) return "the treasury's label";
  if (state?.stamps[run.stampId]) return "the treasury's stamp";
  return null;
}

describe("raccoon-vtt map discovery run", { timeout: 900_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    benContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    tvContext = await browser.newContext({ viewport: { width: 960, height: 540 } });
    dm = await dmContext.newPage();
    ben = await benContext.newPage();
    tv = await tvContext.newPage();
    for (const [page, key] of [[dm, "dm"], [ben, "ben"], [tv, "tv"]] as const) consoles[key].attach(page);
    await sockets.dm.attach(dmContext, dm);
    await sockets.ben.attach(benContext, ben);
    await sockets.tv.attach(tvContext, tv);
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

  test("md-0. the DM lays out four scenes with fog on, Ben joins on a phone, and a table display pairs", async () => {
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
    await waitFor("the DM's snapshot", () => sockets.dm.state);
    run.halls = sockets.dm.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });

    // Sunken halls: walls come from the painted floor's edges.
    const halls = run.halls;
    await ops.send({ t: "scene.update", sceneId: halls, patch: { name: "Sunken halls", bounds: HALLS.bounds, fogEnabled: true, autoWalls: "all", blockMovement: true, vision: { on: true, light: "dark" } } });
    await ops.send({ t: "build.rect", sceneId: halls, terrain: "stone", ...HALLS.hall });
    await ops.send({ t: "build.rect", sceneId: halls, terrain: "stone", ...HALLS.corridor });
    await ops.send({ t: "build.rect", sceneId: halls, terrain: "wood", ...HALLS.treasury });
    const door: EdgeFeature = { kind: "door", state: "closed", secret: false, discovered: false };
    await ops.send({ t: "build.edge", sceneId: halls, edges: [HALLS.treasuryDoor, HALLS.doorGone, HALLS.doorOpened].map((key) => ({ key, feature: door })) });
    await ops.send({ t: "build.walls", sceneId: halls, put: [{ ...HALLS.treasuryWall, f: { kind: "wall" } }] });
    await ops.send({ t: "build.height", sceneId: halls, cells: HALLS.treasuryRaised, height: 10 });
    await ops.send({ t: "build.label", sceneId: halls, labelId: run.labelId, label: { x: 17, y: 8.5, text: HALLS.label, size: 1 } });
    await ops.send({ t: "build.stamps", sceneId: halls, put: [{ id: run.stampId, art: { key: "chest" }, x: 18.5, y: 9.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] });

    // Reveal hall: fog on, party vision off.
    await ops.send({ t: "scene.create", scene: { id: run.reveal, name: "Reveal hall", bounds: REVEAL.bounds, fogEnabled: true, autoWalls: "off", blockMovement: true } });
    await ops.send({ t: "fog.live", sceneId: run.reveal, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", ...REVEAL.revealed } }] });
    await ops.send({ t: "build.walls", sceneId: run.reveal, put: [{ ...REVEAL.astra, f: { kind: "wall" } }] });
    await ops.send({ t: "build.rect", sceneId: run.reveal, terrain: "dirt", ...REVEAL.east });
    await ops.send({ t: "build.edge", sceneId: run.reveal, edges: [{ key: REVEAL.door, feature: door }, { key: REVEAL.eastWall, feature: { kind: "wall" } }] });

    // Open mat and Great cavern: bright, the mat bare and the cavern floored, in bands as the builder sends a big room.
    for (const [id, name, bounds] of [[run.mat, "Open mat", MAT.bounds], [run.cavern, "Great cavern", CAVERN.bounds]] as const) {
      await ops.send({ t: "scene.create", scene: { id, name, bounds, fogEnabled: true, autoWalls: "all", blockMovement: true, vision: { on: true, light: "bright" } } });
    }
    for (let y = 0; y < CAVERN.bounds.h; y += 16) await ops.send({ t: "build.rect", sceneId: run.cavern, terrain: "stone", x: 0, y, w: CAVERN.bounds.w, h: 16 });

    run.benId = await join(benContext, "Ben", "#0090ff");
    await ops.send(pc(run.bree.halls, halls, "Bree", HALLS.breeAt));
    await ops.send(pc(run.moleId, halls, "Mole", HALLS.moleAt, true));
    await ops.send(pc(run.bree.reveal, run.reveal, "Bree", REVEAL.breeAt));
    await ops.send(pc(run.bree.mat, run.mat, "Bree", MAT.breeAt));
    await ops.send(pc(run.bree.cavern, run.cavern, "Bree", CAVERN.breeAt));

    await ben.goto(`${server.origin}/r/${run.roomId}`);
    await ben.getByRole("status", { name: "Connected" }).first().waitFor();
    await waitFor("Ben's snapshot", () => sockets.ben.state);
    const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
    assert.equal(res.status(), 201, await res.text());
    const { code } = (await res.json()) as { code: string };
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await waitFor("the display's snapshot", () => sockets.tv.state);
    await tv.locator(".konvajs-content").first().waitFor();
    await ben.locator(".konvajs-content").first().waitFor();
  });

  test("md-1. a room the party never saw: no cell, wall, door, height, label or stamp of it in Ben's or the display's copy", async () => {
    // The hall Bree stands in reached them as built.
    await waitFor("the hall on Ben's map and the display's", () => (cellIn(sockets.ben.state, run.halls, 2, 4) === "stone" && cellIn(sockets.tv.state, run.halls, 2, 4) === "stone") || null);
    await settle("the hall laid out");
    for (const [who, state] of [["Ben", sockets.ben.state], ["the display", sockets.tv.state]] as const) {
      assert.equal(treasuryIn(state), null, `${who}'s copy`);
      const text = JSON.stringify(state?.buildChunks);
      for (const word of ['"wood"', HALLS.treasuryWall.id]) assert.ok(!text.includes(word), `${word} reached ${who}`);
      assert.equal(cellIn(state, run.halls, 2, 4), "stone", `the hall on ${who}'s map`);
      assert.equal((edgeIn(state, run.halls, HALLS.doorGone) as { kind?: string } | undefined)?.kind, "door", `the hall's door on ${who}'s map`);
    }
    await shots.take(ben, "mapdiscovery-ben-hall");
    await shots.take(dm, "mapdiscovery-dm-halls");
  });

  test("md-2. a corridor running on into darkness: no wall at the edge of Ben's map, and Bree walks on past it", async () => {
    const at = (x: number, y: number) => chunkOf(sockets.ben.state, run.halls, x, y);
    let last = -1;
    for (let x = HALLS.corridor.x; x < HALLS.bounds.w; x++) if (knownAt(at(x, 4), x, 4)) last = x;
    assert.ok(last >= HALLS.corridor.x && last < HALLS.breeFar.x - 1, `the corridor held to x = ${last}`);
    // Its long walls reach as far as Ben holds it.
    for (let x = HALLS.corridor.x; x <= last; x++) assert.ok(autoAt(at(x, 4), `${x},4,n`) && autoAt(at(x, 5), `${x},5,n`), `the corridor's walls at x = ${x}`);
    // And no wall stands across it, where his ground ends included.
    for (let x = HALLS.corridor.x; x <= last + 1; x++) assert.ok(!autoAt(at(x, 4), `${x},4,w`) && edgeIn(sockets.ben.state, run.halls, `${x},4,w`) === undefined, `a wall across the corridor at x = ${x}`);
    // Closer in for the guide's picture: the whole scene fits a phone's width with room to spare.
    const middle = await pagePoint(ben, HALLS.bounds, { x: 6, y: 5 });
    await ben.mouse.move(middle.x, middle.y);
    await ben.mouse.wheel(0, -400);
    await ben.waitForTimeout(400);
    await shots.take(ben, "mapdiscovery-ben-corridor-into-dark");
    await ben.mouse.wheel(0, 400);
    await ben.waitForTimeout(400);

    await dragCells(ben, HALLS.bounds, HALLS.breeAt, HALLS.breeFar);
    await standsAt(run.bree.halls, "Bree", HALLS.breeFar);
    assert.equal(await ben.locator("[data-stop-note]").count(), 0, "a note after a walk nothing stopped");
    // The torch shows more of the corridor, and still none of the treasury.
    await waitFor("more of the corridor on Ben's map", () => knownAt(at(last + 2, 4), last + 2, 4) || null);
    assert.equal(treasuryIn(sockets.ben.state), null);
    await shots.take(ben, "mapdiscovery-ben-down-the-corridor");
  });

  test("md-3. Bree leaves the hall, the DM adds a wall in it and takes a door away, and a monster opens the other: Ben's map shows the hall as before", async () => {
    // From x = 12 the torch's 8 squares reach no further west than the hall's east side, and down the corridor none of its north side.
    await waitFor("the hall's north side out of the party's sight", () => {
      const state = sockets.dm.state;
      if (!state) return null;
      const sight = partySight(state, run.halls, { walls: sceneWalls });
      const cells = [{ x: 2, y: 1 }, { x: 4, y: 1 }, ...[1, 2, 3, 4].map((x) => ({ x, y: 6 }))];
      return cells.every((c) => !sight.seesToken({ size: "medium", ...c }, SQUARES)) || null;
    });
    run.leftAt = { ben: sockets.ben.received.length, tv: sockets.tv.received.length };
    await ops.send({ t: "build.walls", sceneId: run.halls, put: [{ ...HALLS.hallWall, f: { kind: "wall" } }] });
    await ops.send({ t: "build.edge", sceneId: run.halls, edges: [{ key: HALLS.doorGone, feature: null }] });
    await ops.send({ t: "door.set", sceneId: run.halls, door: { edge: HALLS.doorOpened }, state: "open" });
    await settle("the hall changed out of sight");
    for (const [who, state] of [["Ben", sockets.ben.state], ["the display", sockets.tv.state]] as const) {
      assert.equal(holdsAlong(state, run.halls, HALLS.hallWall), false, `the new wall on ${who}'s map`);
      assert.equal((edgeIn(state, run.halls, HALLS.doorGone) as { kind?: string } | undefined)?.kind, "door", `the door taken away is gone from ${who}'s map`);
      assert.equal((edgeIn(state, run.halls, HALLS.doorOpened) as { state?: string } | undefined)?.state, "closed", `the door the monster opened is open on ${who}'s map`);
    }
    await shots.take(ben, "mapdiscovery-ben-hall-remembered");
    await shots.take(dm, "mapdiscovery-dm-hall-changed");
  });

  test("md-4. Bree comes back and sees the hall: the live build replaces what Ben's map remembered", async () => {
    run.backAt = { ben: sockets.ben.received.length, tv: sockets.tv.received.length };
    await dragCells(ben, HALLS.bounds, HALLS.breeFar, { x: 3, y: 4 });
    await standsAt(run.bree.halls, "Bree", { x: 3, y: 4 });
    await waitFor("the hall as built on Ben's map", () => {
      const s = sockets.ben.state;
      const open = (edgeIn(s, run.halls, HALLS.doorOpened) as { state?: string } | undefined)?.state === "open";
      const gone = (edgeIn(s, run.halls, HALLS.doorGone) as { kind?: string } | undefined)?.kind !== "door";
      return (open && gone && holdsAlong(s, run.halls, HALLS.hallWall)) || null;
    });
    // The door taken away leaves the floor's own wall.
    assert.ok(autoAt(chunkOf(sockets.ben.state, run.halls, 2, 1), HALLS.doorGone), "the hall's north wall where the door was");
    await shots.take(ben, "mapdiscovery-ben-hall-seen-again");
  });

  test("md-4b. a one-cell drag and an arrow press into a wall Bree sees send nothing: she never leaves her square, and the note names the wall (D-261027-05)", async () => {
    await ops.send({ t: "scene.create", scene: { id: run.closet, name: "Closet", bounds: CLOSET.bounds, fogEnabled: true, autoWalls: "all", blockMovement: true, vision: { on: true, light: "bright" } } });
    await ops.send({ t: "build.rect", sceneId: run.closet, terrain: "stone", ...CLOSET.room });
    await ops.send(pc(run.bree.closet, run.closet, "Bree", CLOSET.breeAt));
    await playersTo(run.closet);
    try {
      await waitFor("the closet's west wall on Ben's map", () => autoAt(chunkOf(sockets.ben.state, run.closet, CLOSET.breeAt.x, CLOSET.breeAt.y), CLOSET.westWall) || null);
      await ben.locator(".konvajs-content").first().waitFor();
      const at = CLOSET.breeAt;
      const from = sockets.ben.received.length;
      // A phone's usual flow: tap the token, then drag it. The closet is walled all round, so no way leads past its west wall:
      // the drag stops at its very first step, and its note wins over the token's action bar, the selection kept.
      await watchStanding(ben, run.bree.closet);
      await tapCell(ben, CLOSET.bounds, at);
      await ben.getByRole("dialog", { name: "Bree actions" }).waitFor();
      await dragCells(ben, CLOSET.bounds, at, { x: at.x - 1, y: at.y });
      await stopNote("Stopped at a wall.").waitFor();
      await shots.take(ben, "mapdiscovery-ben-first-step-wall");
      await closeNote("Stopped at a wall.");
      // Bree is still selected. An arrow key steps her one square, never round a wall.
      await ben.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
      await ben.keyboard.press("ArrowLeft");
      await stopNote("Stopped at a wall.").waitFor();
      await ben.waitForTimeout(500);
      const stood = await stoodAt(ben);
      assert.ok(stood.length > 10, `${stood.length} frames read`);
      // The drop puts the node back where the plan lands it, a frame or so after the finger lifts. From then on it stands in its square.
      const back = stood.findIndex(([x, y]) => x === at.x && y === at.y);
      assert.ok(back >= 0, "Bree's node never stood in her square");
      const away = stood.slice(back).filter(([x, y]) => x !== at.x || y !== at.y);
      assert.deepEqual(away, [], "a frame showed Bree off her square after the drop");
      assert.equal(answeredOps(sockets.ben, from), false, "Ben's page sent a move");
      await standsAt(run.bree.closet, "Bree", at);
      await closeNote("Stopped at a wall.");
    } finally {
      await playersTo(run.halls);
    }
  });

  test("md-5. a drag into the dark with a wall there lands at its last clear spot with the generic words, Teleport here sends unknown, and Mole, who sees nothing, is stopped by the real walls", async () => {
    await ops.send({ t: "build.edge", sceneId: run.halls, edges: [{ key: HALLS.darkWall, feature: { kind: "wall" } }] });
    await settle("the dark wall built");
    assert.equal(edgeIn(sockets.ben.state, run.halls, HALLS.darkWall), undefined, "the dark wall reached Ben");
    const from = sockets.ben.received.length;
    await dragCells(ben, HALLS.bounds, { x: 3, y: 4 }, { x: 23, y: 4 });
    await standsAt(run.bree.halls, "Bree", { x: 21, y: 4 });
    await stopNote(SOMETHING_BLOCKS).waitFor();
    const blocked = sockets.ben.received.slice(from).some((text) => {
      const frame = JSON.parse(text) as { t?: string; blocked?: number[] };
      return frame.t === "ev" && (frame.blocked?.length ?? 0) > 0;
    });
    assert.ok(blocked, "Ben's page heard no blocked walk");
    await shots.take(ben, "mapdiscovery-ben-something-blocks");
    await stopNote(SOMETHING_BLOCKS).getByRole("button", { name: "Teleport here" }).click();
    await standsAt(run.bree.halls, "Bree", { x: 23, y: 4 });
    await dm.getByText("Bree teleported past something they could not see.").first().waitFor();
    const line = (sockets.dm.state?.log ?? []).find((e) => (e.data as { type?: string } | undefined)?.type === "teleport");
    assert.deepEqual(line?.data, { type: "teleport", tokenId: run.bree.halls, past: "unknown" });
    await shots.take(dm, "mapdiscovery-dm-teleport-unknown");

    // Mole carries no light, so Ben holds nothing round him, and the treasury's west wall stops him as it would anyone.
    await dragCells(ben, HALLS.bounds, HALLS.moleAt, { x: 16, y: 9 });
    await standsAt(run.moleId, "Mole", { x: 13, y: 9 });
    await stopNote(SOMETHING_BLOCKS).waitFor();
    await closeNote(SOMETHING_BLOCKS);
    assert.equal(treasuryIn(sockets.ben.state), null, "Mole's stop showed Ben the treasury");
  });

  test("md-6. Fog all forgets what Ben's map remembered and explored, and an edit past the cap asks the DM, then forgets whole tiles", async () => {
    const corridor = (s: RoomState | null) => !!s && !isCellFullyFogged(s.fogTiles, run.halls, { x: 12, y: 4 });
    // Bree, back at the corridor's east end, no longer sees x = 12, which the party explored on the way.
    await ops.send({ t: "token.move", tokenId: run.bree.halls, ...HALLS.breeAt });
    await standsAt(run.bree.halls, "Bree", HALLS.breeAt);
    await waitFor("the explored corridor on Ben's map", () => corridor(sockets.ben.state) || null);
    await pickTool(dm, "Fog");
    // Fog all sits in the row where it fits, else behind ⋯, and asks for a second tap.
    const bar = dm.getByRole("toolbar", { name: "Fog options" });
    let scope: Locator = bar.locator("[data-options-row]");
    if ((await scope.getByRole("button", { name: "Fog all", exact: true }).count()) === 0) {
      await bar.getByRole("button", { name: "More options" }).click();
      scope = dm.getByRole("dialog", { name: "More Fog options" });
    }
    await scope.getByRole("button", { name: "Fog all", exact: true }).click();
    await scope.getByRole("button", { name: "Tap again: fog all" }).click();
    await waitFor("the corridor forgotten on Ben's map", () => (corridor(sockets.ben.state) ? null : true));
    assert.equal(holdsAlong(sockets.ben.state, run.halls, HALLS.hallWall), true, "the hall Bree stands in is still live");
    await shots.take(ben, "mapdiscovery-ben-after-fog-all");
    await dm.keyboard.press("Escape");
    await pickTool(dm, "Select");

    // The party sees the whole bright cavern, then leaves it, and the DM clears its build: one op, past the cap.
    await playersTo(run.cavern);
    await waitFor("the cavern explored on Ben's map", () => (sockets.ben.state && !isCellFullyFogged(sockets.ben.state.fogTiles, run.cavern, { x: CAVERN.bounds.w - 1, y: CAVERN.bounds.h - 1 }) ? true : null));
    await playersTo(run.halls);
    await dmTo("Great cavern", run.cavern);
    const explored = () => Object.keys(sockets.dm.state?.exploredTiles ?? {}).filter((k) => k.startsWith(`${run.cavern}:`)).length;
    const before = await waitFor("the cavern's explored tiles in the DM's copy", () => explored() || null);
    const built = () => sockets.dm.state?.buildChunks[`${run.cavern}:0,0`]?.cells["0,0"];
    const floored = () => Object.values(sockets.dm.state?.buildChunks ?? {}).reduce((n, c) => n + (c?.sceneId === run.cavern ? Object.values(c.cells).filter((t) => t === "stone").length : 0), 0);
    const whole = CAVERN.bounds.w * CAVERN.bounds.h;
    assert.equal(floored(), whole);
    await pickTool(dm, "Map builder");
    const ask = dm.getByRole("dialog", { name: "Remembered map" });
    // A rectangle of 76 by 57 squares, 4,332 floors past the cap's 4,096, goes as three bands of at most 2,000 squares
    // and asks before the first (builder's item 10). It starts below the top rows, where the log's toasts cover the map.
    await pickOption(dm, "Map builder", "Builder mode", "Erase area");
    await dragCells(dm, CAVERN.bounds, { x: 2, y: 6 }, { x: 77, y: 62 });
    await ask.waitFor();
    await ask.getByRole("button", { name: "Cancel" }).click();
    await ask.waitFor({ state: "detached" });
    await settle("the rectangle left unmade");
    assert.equal(floored(), whole, "Cancel left a band of the rectangle erased");
    await pickOption(dm, "Map builder", "Builder mode", "Brush");
    await clearBuild(dm);
    await ask.waitFor();
    await shots.take(dm, "mapdiscovery-dm-forget-question");
    // Cancel leaves the cavern as it was, and the same Clear build asks again.
    await ask.getByRole("button", { name: "Cancel" }).click();
    await ask.waitFor({ state: "detached" });
    await settle("the cavern left as it was");
    assert.equal(built(), "stone", "Cancel cleared the cavern");
    await clearBuild(dm);
    await ask.waitFor();
    await ask.getByRole("button", { name: "Go ahead" }).click();
    await ask.waitFor({ state: "detached" });
    await waitFor("the cavern cleared", () => (built() ? null : true));
    await waitFor("whole tiles of the party's explored ground forgotten", () => (explored() < before ? true : null));

    // The cavern floored and seen whole again. The same rectangle, drawn while the DM's device is offline, waits on its
    // asks: the builder says it is checking and nothing of it is built. Back online, it asks, and Go ahead erases all of it.
    for (let y = 0; y < CAVERN.bounds.h; y += 16) await ops.send({ t: "build.rect", sceneId: run.cavern, terrain: "stone", x: 0, y, w: CAVERN.bounds.w, h: 16, forget: true });
    await playersTo(run.cavern);
    await waitFor("the cavern explored again", () => (explored() >= before ? true : null));
    await playersTo(run.halls);
    await waitFor("the cavern floored again", () => (floored() === whole ? true : null));
    await pickOption(dm, "Map builder", "Builder mode", "Erase area");
    // The wait is the small loading line, muted, and the line keeps its place and a reading's height through it, so the
    // row and the line stand still before, during and after (docs/design-v1-design-pass.md 2.4 rules 5 and 6).
    const builderBar = dm.getByRole("toolbar", { name: "Map builder options" });
    const line = builderBar.locator("[data-options-line]");
    const place = async () => ({ line: await line.boundingBox(), row: await builderBar.locator("[data-options-row]").boundingBox(), reading: (await line.getAttribute("data-options-reading")) !== null });
    const colorOf = (el: unknown) => (globalThis as unknown as { getComputedStyle(e: unknown): { color: string } }).getComputedStyle(el).color;
    const hintColor = await line.evaluate(colorOf);
    const resting = await place();
    consoles.dm.expectSocketFailures = true;
    await dmContext.setOffline(true);
    await dragCells(dm, CAVERN.bounds, { x: 2, y: 6 }, { x: 77, y: 62 });
    const checking = line.locator("[data-options-wait]").filter({ hasText: "Checking players' remembered map…" });
    await checking.waitFor();
    const waiting = await place();
    assert.equal(waiting.reading, true, "the wait gave up the line's place as a reading");
    assert.equal(await line.getAttribute("data-finding"), "", "the wait is not marked as one");
    assert.equal(await checking.evaluate(colorOf), hintColor, "the wait is not in the muted hint's color");
    for (const [what, a, b] of [["line's top", resting.line?.y, waiting.line?.y], ["line's height", resting.line?.height, waiting.line?.height], ["row's top", resting.row?.y, waiting.row?.y]] as const) {
      assert.ok(a !== undefined && b !== undefined && Math.abs(a - b) <= 0.5, `the ${what} moved for the wait: ${a} to ${b}`);
    }
    assert.deepEqual(alignmentLines(await measureAlignment(line), "the builder's asking line"), []);
    await shots.take(dm, "mapdiscovery-dm-build-asking");
    assert.equal(floored(), whole, "a band went before the answer");
    // While it waits, the builder takes no other edit (D-261027-07): an Erase tap on a corner the rectangle leaves does nothing.
    await pickOption(dm, "Map builder", "Builder mode", "Erase");
    await tapCell(dm, CAVERN.bounds, { x: 0, y: 63 });
    await checking.waitFor();
    await dmContext.setOffline(false);
    await ask.waitFor({ timeout: 30_000 });
    await checking.waitFor({ state: "detached" });
    const answered = await place();
    for (const [what, a, b] of [["line's top", resting.line?.y, answered.line?.y], ["line's height", resting.line?.height, answered.line?.height], ["row's top", resting.row?.y, answered.row?.y]] as const) {
      assert.ok(a !== undefined && b !== undefined && Math.abs(a - b) <= 0.5, `the ${what} moved for the answer: ${a} to ${b}`);
    }
    consoles.dm.expectSocketFailures = false;
    await ask.getByRole("button", { name: "Go ahead" }).click();
    await ask.waitFor({ state: "detached" });
    await waitFor("the whole rectangle erased", () => (floored() === whole - 76 * 57 ? true : null));
    await settle("nothing after the rectangle");
    assert.equal(sockets.dm.state?.buildChunks[`${run.cavern}:0,3`]?.cells["0,63"], "stone", "the tap made while the rectangle waited erased its corner");
    await pickOption(dm, "Map builder", "Builder mode", "Brush");
    await pickTool(dm, "Select");
  });

  test("md-7. a fog-only scene: ground the DM has not revealed reaches Ben with nothing of it, and revealed ground is live", async () => {
    await playersTo(run.reveal);
    await waitFor("astra's wall on Ben's map", () => holdsAlong(sockets.ben.state, run.reveal, REVEAL.astra) || null);
    for (const [who, state] of [["Ben", sockets.ben.state], ["the display", sockets.tv.state]] as const) {
      assert.ok(!JSON.stringify(state?.buildChunks).includes('"dirt"'), `the east part's floor reached ${who}`);
      assert.equal(edgeIn(state, run.reveal, REVEAL.eastWall), undefined, `the east part's wall reached ${who}`);
      assert.equal((edgeIn(state, run.reveal, REVEAL.door) as { kind?: string } | undefined)?.kind, "door", `the door on ${who}'s map`);
    }
    // The pieces the server cut from astra's wall, none under its own id.
    assert.ok(wallsIn(sockets.ben.state, run.reveal).every((w) => (w as { id?: string }).id !== REVEAL.astra.id), "astra's wall reached Ben whole");
    await shots.take(ben, "mapdiscovery-ben-reveal-hall");

    await ops.send({ t: "build.edge", sceneId: run.reveal, edges: [{ key: REVEAL.liveWall, feature: { kind: "wall" } }] });
    await waitFor("the new wall on revealed ground on Ben's map", () => ((edgeIn(sockets.ben.state, run.reveal, REVEAL.liveWall) as { kind?: string } | undefined)?.kind === "wall" ? true : null));
    await ops.send({ t: "build.paint", sceneId: run.reveal, terrain: "dirt", cells: ["14,10"] });
    await settle("dirt painted under the fog");
    assert.ok(!JSON.stringify(sockets.ben.state?.buildChunks).includes('"dirt"'), "floor painted under the fog reached Ben");

    run.eastAt = { ben: sockets.ben.received.length, tv: sockets.tv.received.length };
    await ops.send({ t: "fog.live", sceneId: run.reveal, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 12, y: 0, w: 4, h: 12 } }] });
    await waitFor("the east part on Ben's map", () => (cellIn(sockets.ben.state, run.reveal, 14, 4) === "dirt" && edgeIn(sockets.ben.state, run.reveal, REVEAL.eastWall) ? true : null));
    await shots.take(ben, "mapdiscovery-ben-reveal-hall-east");
  });

  test("md-9. astra's case: Bree's walk from (5, 6) to (5, 5) ends inside a piece's band and lands there, and the door reached inside the band opens", async () => {
    await standsAt(run.bree.reveal, "Bree", REVEAL.breeAt);
    await dragCells(ben, REVEAL.bounds, REVEAL.breeAt, { x: 5, y: 5 });
    await standsAt(run.bree.reveal, "Bree", { x: 5, y: 5 });
    assert.equal(await ben.locator("[data-stop-note]").count(), 0, "a note after a walk the wall allows");
    await shots.take(ben, "mapdiscovery-ben-astra-walk");

    // The door's tap zone, just past Bree's east side so her token does not take the tap.
    const p = await pagePoint(ben, REVEAL.bounds, { x: 6.25, y: 5.5 });
    await assertCanvasAt(ben, p);
    await ben.mouse.click(p.x, p.y);
    const pill = ben.getByRole("group", { name: "Closed door" });
    await pill.getByRole("button", { name: "Open" }).click();
    await waitFor("the door open on Ben's map", () => (edgeIn(sockets.ben.state, run.reveal, REVEAL.door) as { state?: string } | undefined)?.state === "open" || null);
    await shots.take(ben, "mapdiscovery-ben-astra-door-open");
    await tapCell(ben, REVEAL.bounds, { x: 2, y: 9 });
  });

  test("md-8. the party on an empty mat, the DM builds a room in its sight: the builder says the party sees it, and the room's wall shows as built", async () => {
    await playersTo(run.mat);
    await dmTo("Open mat", run.mat);
    await waitFor("the party's sight on the mat in the DM's copy", () => (Object.keys((sockets.dm.state as { sight?: Record<string, unknown> } | null)?.sight ?? {}).some((k) => k.startsWith(`${run.mat}:`)) ? true : null));
    await pickTool(dm, "Map builder");
    await pickOption(dm, "Map builder", "Builder mode", "Rectangle room");
    await dragCells(dm, MAT.bounds, MAT.room.from, MAT.room.to);
    const options = dm.getByRole("toolbar", { name: "Map builder options" });
    await options.getByText(BUILD_IN_SIGHT).waitFor();
    await shots.take(dm, "mapdiscovery-dm-builder-in-sight");
    // The room's west wall faces Bree.
    await waitFor("the room's west wall on Ben's map", () => {
      const c = chunkOf(sockets.ben.state, run.mat, MAT.room.from.x, MAT.inside.y);
      return autoAt(c, `${MAT.room.from.x},${MAT.inside.y},w`) || null;
    });
    await shots.take(ben, "mapdiscovery-ben-room-built-in-sight");
    await pickTool(dm, "Select");
  });

  test("md-8b. the room's inside, seen empty before its walls stood, stays empty on Ben's map until a door shows it", async () => {
    const inside = () => cellIn(sockets.ben.state, run.mat, MAT.inside.x, MAT.inside.y);
    assert.equal(inside(), undefined, "the room's floor reached Ben before Bree saw it");
    assert.ok(knownAt(chunkOf(sockets.ben.state, run.mat, MAT.inside.x, MAT.inside.y), MAT.inside.x, MAT.inside.y), "the ground Bree saw empty left Ben's map");
    await ops.send({ t: "build.edge", sceneId: run.mat, edges: [{ key: `${MAT.room.from.x},${MAT.inside.y},w`, feature: { kind: "door", state: "open", secret: false, discovered: false } }] });
    await waitFor("the room's floor through the door on Ben's map", () => (inside() ? true : null));
    await shots.take(ben, "mapdiscovery-ben-room-through-door");
  });

  test("md-end. no frame Ben's page or the display received held the treasury, the Reveal hall's east part before it was revealed, or the hall's changes while the party was away, and no page logged an error", () => {
    for (const [who, watch, key] of [["Ben", sockets.ben, "ben"], ["the display", sockets.tv, "tv"]] as const) {
      const away = (index: number) => run.leftAt[key] >= 0 && index >= run.leftAt[key] && index < run.backAt[key];
      const broken = replay(watch, (state, index) => {
        const treasury = treasuryIn(state);
        if (treasury) return treasury;
        if (run.eastAt[key] >= 0 && index < run.eastAt[key] && edgeIn(state, run.reveal, REVEAL.eastWall)) return "the Reveal hall's east wall, under the fog";
        if (away(index) && holdsAlong(state, run.halls, HALLS.hallWall)) return "the hall's new wall, while away";
        if (away(index) && (edgeIn(state, run.halls, HALLS.doorOpened) as { state?: string } | undefined)?.state === "open") return "the door the monster opened, while away";
        return null;
      });
      assert.deepEqual(broken, [], `${who}'s page`);
      // Every frame as sent, of every kind. The treasury's words, wall and stamp never reached this page, so no frame names them, and no frame holds what reaches DMs only.
      const named = watch.received.flatMap((text, index) => {
        const found: string[] = [];
        for (const word of [HALLS.label, HALLS.treasuryWall.id, run.stampId, '"wood"']) if (text.includes(word)) found.push(word);
        if (run.eastAt[key] >= 0 && index < run.eastAt[key] && text.includes('"dirt"')) found.push("the east part's floor");
        const frame = JSON.parse(text) as Frame;
        found.push(...privateFieldsIn(frame));
        return found.length > 0 ? [`frame ${index} (${frame.t}): ${found.join(", ")}`] : [];
      });
      assert.deepEqual(named, [], `${who}'s page`);
    }
    for (const c of Object.values(consoles)) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
