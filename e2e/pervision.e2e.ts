import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type WebSocketRoute } from "playwright-core";
import sharp from "sharp";
import type { BuildChunk, EdgeFeature, RoomState } from "#shared/model.ts";
import { applyChanges, type ProjectedState } from "#shared/project.ts";
import { isCellFullyFogged } from "#shared/rules/fog.ts";
import { assertCanvasAt, ConsoleWatch, dragCells, openSideTab, OpSocket, pagePoint, Shots, sideTabName, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

/**
 * Per-player vision (docs/design-v1-per-player-vision.md section 10, steps
 * pv-1 to pv-8): the real server serving the production build, a DM on a
 * computer, Ana and Ben on phones and a table display, on one dark scene
 * whose Sight the DM sets to Per player.
 *
 * Ana plays Thorn, in the north hall, and Ben plays Bree, in a walled room
 * of the south half. Each carries a torch. A goblin stands in Thorn's light
 * and a label lies on ground only Thorn sees. Through the run, Ana gets
 * the goblin, its row and the label while Ben and the display get none of
 * them, Thorn opens a door Ben's map draws only once Bree has seen it, the
 * DM's View as a player shows each player their own view and no whisper
 * between them, a Night phase keeps the scene per player, the DM's list of
 * who sees for themselves moves Ana's place to a third player, and Whole
 * party pools the maps, which stay pooled once the scene is per player
 * again. At the end every frame Ben's page and the display received is
 * replayed: neither held the goblin while the scene was per player, nor
 * the label before the maps were pooled.
 *
 * It runs with `pnpm test:e2e` on its own port, E2E_PORT plus thirty,
 * which no other file uses. The other environment variables are the smoke
 * run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 30;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-pervision-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/**
 * The scene, 16 by 20 squares, dark, with fog and vision on, from a map
 * of 25 px squares with a Day and a Night phase:
 *
 * - The north hall, rows 0 to 9: Thorn at (3, 9) by the door, his torch
 *   (bright 20 ft, dim 20 ft more, so 8 squares) lighting the goblin at
 *   (7, 5) and the label "Old altar" at (6.5, 3.5).
 * - A wall along row 10 with a closed door above (3, 10).
 * - The south half, split by a wall along column 8: the west room behind
 *   the door, and the east room where Bree starts at (12, 15). The east
 *   room's corner at (14, 18) is ground only Bree ever sees.
 *
 * Bree moved to (6, 13) later sees the door's south side and, through the
 * open door, only a thin wedge of the north hall's west edge, far from the
 * goblin and the label.
 */
const BOUNDS = { w: 16, h: 20 };
const CELL_PX = 25;
const DOOR = "3,10,n";
const THORN_AT = { x: 3, y: 9 };
const BREE_AT = { x: 12, y: 15 };
const BREE_LATER = { x: 6, y: 13 };
const GOBLIN_AT = { x: 7, y: 5 };
/** Where the DM drags the goblin in pv-2b: still in Thorn's light, far from any wedge Bree later sees through the door. */
const GOBLIN_LATER = { x: 7, y: 4 };
const LABEL_AT = { x: 6.5, y: 3.5 };
const LABEL_CELL = { x: 6, y: 3 };
const DOOR_NORTH = { x: 3, y: 9 };
const DOOR_SOUTH = { x: 3, y: 10 };
/** Ground only Bree ever sees, until Whole party pools the maps. */
const BREE_CORNER = { x: 14, y: 18 };
const LABEL_TEXT = "Old altar";
const WHISPER = "Meet me by the old well";

const run = {
  roomId: "",
  roomName: `E2E pervision ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  anaId: "",
  benId: "",
  cyId: "",
  thornId: randomUUID(),
  breeId: randomUUID(),
  goblinId: randomUUID(),
  labelId: randomUUID(),
  phases: { day: randomUUID(), night: randomUUID() },
  /** The Night phase's map, which a player's copy of the scene shows once the DM switches to it (players hold no phase list). */
  nightMap: "",
  /** How many frames Ben's page and the display had received when Whole party pooled the maps (pv-7). */
  pooledAt: { ben: -1, tv: -1 },
};

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let benContext: BrowserContext;
let tvContext: BrowserContext;
let dm: Page;
let ana: Page;
let ben: Page;
let tv: Page;
let ops: OpSocket;
const sockets = { dm: new SocketWatch("dm"), ana: new SocketWatch("ana"), ben: new SocketWatch("ben"), tv: new SocketWatch("display") };
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana"), ben: new ConsoleWatch("ben"), tv: new ConsoleWatch("display") };

/**
 * The DM page's View as a player sockets (`as=`, not a display's), routed
 * through the run so it can hold the server's frames, and see the loading
 * line, and keep every frame the preview got.
 */
const previews = {
  /** While true, the server's frames to the preview wait in `queue`. */
  hold: false,
  queue: [] as (string | Buffer)[],
  /** Every frame the server sent the preview socket opened last, as text. */
  frames: [] as string[],
  socket: null as WebSocketRoute | null,
};

async function routePreviews(page: Page): Promise<void> {
  await page.routeWebSocket(/[?&]as=(?!display)/, (ws) => {
    previews.frames = [];
    previews.queue = [];
    previews.socket = ws;
    const upstream = ws.connectToServer();
    ws.onMessage((m) => upstream.send(m));
    upstream.onMessage((m) => {
      previews.frames.push(typeof m === "string" ? m : m.toString("utf8"));
      if (previews.hold) previews.queue.push(m);
      else ws.send(m);
    });
    ws.onClose((code, reason) => upstream.close({ code, reason }));
    upstream.onClose((code, reason) => ws.close({ code, reason }));
  });
}

function releasePreview(): void {
  previews.hold = false;
  for (const m of previews.queue.splice(0)) previews.socket?.send(m);
}

function picture(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: BOUNDS.w * CELL_PX, height: BOUNDS.h * CELL_PX, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .png()
    .toBuffer();
}

async function upload(data: Buffer): Promise<{ id: string; width: number; height: number }> {
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  return (await res.json()) as { id: string; width: number; height: number };
}

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

function creature(id: string, name: string, at: { x: number; y: number }, extra: Record<string, unknown>) {
  return { t: "token.create", token: { id, sceneId: run.sceneId, kind: "monster", name, size: "medium", x: at.x, y: at.y, visibility: "all", actor: { inline: actor() }, ...extra } };
}

/** Whether a page's copy holds the goblin, the label, or ground at a cell out of its fog. */
const has = {
  goblin: (s: RoomState | null) => s?.tokens[run.goblinId] !== undefined,
  label: (s: RoomState | null) => s?.labels[run.labelId] !== undefined,
  ground: (s: RoomState | null, cell: { x: number; y: number }) => !!s && !isCellFullyFogged(s.fogTiles, run.sceneId, cell),
  perPlayer: (s: RoomState | null) => s?.scenes[run.sceneId]?.vision?.perPlayer === true,
};

function doorIn(state: RoomState | null): EdgeFeature | undefined {
  return (state?.buildChunks[`${run.sceneId}:0,0`] as BuildChunk | undefined)?.edges[DOOR];
}

/** The scene's holder entries in the DM's copy, as "name on" or "name off", in list order. */
function holderList(): string[] {
  const state = sockets.dm.state;
  return (state?.holders?.[run.sceneId]?.entries ?? []).map((e) => `${state?.members[e.memberId]?.name ?? e.memberId} ${e.on ? "on" : "off"}`);
}

/** Waits for the holder list to hold exactly these entries, in any order: joins follow the sources' order, which the run does not pin. */
async function listIs(want: string[]): Promise<void> {
  const sorted = (list: string[]) => [...list].sort().join(", ");
  try {
    await waitFor(`the holder list ${want.join(", ")}`, () => (sorted(holderList()) === sorted(want) ? true : null));
  } catch (err) {
    throw new Error(`${(err as Error).message}: it is ${holderList().join(", ")}`);
  }
}

function turnStrip(page: Page | Locator): Locator {
  return page.getByRole("button", { name: /^Initiative, round 1\./ });
}

function scenesPanel(): Locator {
  return dm.getByRole("tabpanel", { name: sideTabName("Scenes") });
}

/** Picks an option of the DM's Sight row, and waits for the DM's copy to say it. */
async function pickSight(choice: "Whole party" | "Per player"): Promise<void> {
  await openSideTab(dm, "Scenes");
  await scenesPanel().getByRole("radiogroup", { name: "Sight" }).getByRole("radio", { name: choice }).check();
  await waitFor(`the scene ${choice} in the DM's copy`, () => (has.perPlayer(sockets.dm.state) === (choice === "Per player") ? true : null));
}

/** Taps a door's south edge, just past the cell above it, as a finger reaching for the door would. */
async function tapDoor(page: Page): Promise<void> {
  const p = await pagePoint(page, BOUNDS, { x: 3.5, y: 10.25 });
  await assertCanvasAt(page, p);
  await page.mouse.click(p.x, p.y);
}

/** A tap on empty ground, which puts a door's pill away. */
async function tapAway(page: Page, cell: { x: number; y: number }): Promise<void> {
  await tapCell(page, BOUNDS, cell);
  await page.getByRole("group", { name: /door$/ }).waitFor({ state: "detached" });
}

/** What reaches DMs only on a per-player scene (design section 9, rule 3): the holder list, the layers and every list of who saw. */
const DM_ONLY = ['"holders:', '"exploredAny:', "exploredBy", "seenBy"];

type Frame = { t?: string; state?: ProjectedState; changes?: Parameters<typeof applyChanges>[1]; you?: { memberId: string; role: string } };

/**
 * Opens View as a player for `name` from the DM panel, holding the
 * server's frames until the loading line shows, then letting them through,
 * and returns the preview's dialog once its map is drawn, with the
 * snapshot it got.
 */
async function viewAs(name: string): Promise<{ preview: Locator; snapshot: Frame }> {
  previews.hold = true;
  await openSideTab(dm, "DM");
  const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
  await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: name });
  await panel.getByRole("button", { name: "View", exact: true }).click();
  const preview = dm.locator(`dialog[aria-label="Viewing as ${name}"]`);
  await preview.waitFor();
  await preview.getByRole("status").filter({ hasText: `Loading what ${name} sees` }).waitFor();
  await waitFor(`the snapshot for the preview of ${name}, held`, () => (previews.queue.length > 0 ? true : null));
  await shots.take(dm, `pervision-preview-${name.toLowerCase()}-loading`);
  releasePreview();
  await preview.locator(".konvajs-content").first().waitFor();
  const snapshot = previews.frames.map((text) => JSON.parse(text) as Frame).find((f) => f.t === "snapshot");
  assert.ok(snapshot?.state, `the preview of ${name} got no snapshot`);
  return { preview, snapshot };
}

async function exitPreview(preview: Locator): Promise<void> {
  await preview.getByRole("button", { name: "Exit", exact: true }).click();
  await preview.waitFor({ state: "detached" });
}

/**
 * Replays every frame a page received from its first, and returns the
 * frames after which its copy broke `rule`, by index, with what it held.
 */
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

describe("raccoon-vtt per-player vision run", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    anaContext = await browser.newContext(phone);
    benContext = await browser.newContext(phone);
    tvContext = await browser.newContext({ viewport: { width: 960, height: 540 } });
    dm = await dmContext.newPage();
    ana = await anaContext.newPage();
    ben = await benContext.newPage();
    tv = await tvContext.newPage();
    for (const [page, key] of [[dm, "dm"], [ana, "ana"], [ben, "ben"], [tv, "tv"]] as const) consoles[key].attach(page);
    await sockets.dm.attach(dmContext, dm);
    await sockets.ana.attach(anaContext, ana);
    await sockets.ben.attach(benContext, ben);
    await sockets.tv.attach(tvContext, tv);
    // Before the room loads: Playwright routes only the sockets of a document loaded after the route.
    await routePreviews(dm);
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

  test("pv-0. the DM lays out a dark scene with Day and Night, Ana and Ben join on phones, and a table display pairs", async () => {
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
    run.sceneId = sockets.dm.state!.meta.playerSceneId!;
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(dmContext) });

    const day = await upload(await picture([120, 110, 95]));
    const night = await upload(await picture([30, 34, 60]));
    run.nightMap = night.id;
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { name: "Twin halls", bounds: BOUNDS, fogEnabled: true, autoWalls: "off", vision: { on: true, light: "dark" } } });
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: day.id, widthPx: day.width, heightPx: day.height, cellPx: CELL_PX, originPx: { x: 0, y: 0 } } });
    await ops.send({
      t: "scene.update",
      sceneId: run.sceneId,
      patch: {
        phases: [
          { id: run.phases.day, name: "Day", assetId: day.id, widthPx: day.width, heightPx: day.height },
          { id: run.phases.night, name: "Night", assetId: night.id, widthPx: night.width, heightPx: night.height, light: "dark" },
        ],
      },
    });
    const wall: EdgeFeature = { kind: "wall" };
    const edges: { key: string; feature: EdgeFeature }[] = [];
    for (let x = 0; x < BOUNDS.w; x++) edges.push({ key: `${x},10,n`, feature: `${x},10,n` === DOOR ? { kind: "door", state: "closed", secret: false, discovered: false } : wall });
    for (let y = 10; y < BOUNDS.h; y++) edges.push({ key: `8,${y},w`, feature: wall });
    await ops.send({ t: "build.edge", sceneId: run.sceneId, edges });

    run.anaId = await join(anaContext, "Ana", "#e5484d");
    run.benId = await join(benContext, "Ben", "#0090ff");
    for (const [page, watch] of [[ana, sockets.ana], [ben, sockets.ben]] as const) {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      await waitFor(`${watch.label}'s snapshot`, () => watch.state);
    }

    const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
    assert.equal(res.status(), 201, await res.text());
    const { code } = (await res.json()) as { code: string };
    await tv.goto(`${server.origin}/display`);
    await tv.getByLabel("Code from the DM's screen").fill(code);
    await tv.getByRole("button", { name: "Connect" }).click();
    await waitFor("the display's snapshot", () => sockets.tv.state);
    await tv.locator(".konvajs-content").first().waitFor();
  });

  test("pv-1. per player, Ana sees the goblin in Thorn's torchlight and its row, and Ben and the display see neither, Ben's turn line reading Another creature's turn", async () => {
    // The scene goes per player before any creature stands on it, so no ground is explored for the whole party first.
    await pickSight("Per player");
    await waitFor("the scene per player on both phones and the display", () => (has.perPlayer(sockets.ana.state) && has.perPlayer(sockets.ben.state) && has.perPlayer(sockets.tv.state) ? true : null));
    const torch = { bright: 20, dim: 20 };
    await ops.send(creature(run.thornId, "Thorn", THORN_AT, { kind: "pc", disposition: "ally", ownerIds: [run.anaId], light: torch }));
    await ops.send(creature(run.breeId, "Bree", BREE_AT, { kind: "pc", disposition: "ally", ownerIds: [run.benId], light: torch }));
    // Each joins the list the first time they own a creature that sees here.
    await listIs(["Ana on", "Ben on"]);
    await ops.send(creature(run.goblinId, "Goblin", GOBLIN_AT, { disposition: "hostile" }));
    await ops.send({ t: "build.label", sceneId: run.sceneId, labelId: run.labelId, label: { ...LABEL_AT, text: LABEL_TEXT, size: 1 } });
    await ops.send({
      t: "encounter.start",
      entries: [
        { id: randomUUID(), tokenId: run.goblinId, value: 20 },
        { id: randomUUID(), tokenId: run.thornId, value: 15 },
        { id: randomUUID(), tokenId: run.breeId, value: 10 },
      ],
    });
    await ops.send({ t: "encounter.next" });

    await waitFor("the goblin in Ana's copy", () => has.goblin(sockets.ana.state) || null);
    await turnStrip(ana).and(ana.getByRole("button", { name: /Goblin's turn/ })).waitFor();
    await turnStrip(ben).and(ben.getByRole("button", { name: /Another creature's turn/ })).waitFor();
    // Bree's own torchlight reached Ben's copy, so his view has settled past the goblin's arrival.
    await waitFor("Bree's room on Ben's map", () => has.ground(sockets.ben.state, BREE_CORNER) || null);
    for (const [who, state] of [["Ben", sockets.ben.state], ["the display", sockets.tv.state]] as const) {
      assert.equal(has.goblin(state), false, `the goblin reached ${who}`);
      assert.equal(state?.encounter?.entries.some((e) => e.tokenId === run.goblinId), false, `the goblin's row reached ${who}`);
    }
    assert.ok(sockets.ana.state?.encounter?.entries.some((e) => e.tokenId === run.goblinId), "Ana has no row for the goblin");
    // Each still sees the other's character, a party member.
    assert.ok(sockets.ben.state?.tokens[run.thornId] && sockets.ana.state?.tokens[run.breeId], "a party member was withheld");
    await shots.take(ana, "pervision-ana-goblin-in-torchlight");
    await shots.take(ben, "pervision-ben-another-creature");
    await shots.take(tv, "pervision-display-shared-sight");
    await shots.take(dm, "pervision-dm-per-player");
  });

  test("pv-2. ground Thorn explores stays under Ben's fog, with the label in it", async () => {
    await waitFor("the label in Ana's copy", () => has.label(sockets.ana.state) || null);
    assert.equal(has.ground(sockets.ana.state, LABEL_CELL), true, "the label's ground is fogged on Ana's map");
    for (const [who, state] of [["Ben", sockets.ben.state], ["the display", sockets.tv.state]] as const) {
      assert.equal(has.ground(state, LABEL_CELL), false, `the label's ground is open on ${who}'s map`);
      assert.equal(has.ground(state, GOBLIN_AT), false, `the goblin's ground is open on ${who}'s map`);
      assert.equal(has.label(state), false, `the label reached ${who}`);
    }
    // And the other way: Bree's room is Ben's alone.
    assert.equal(has.ground(sockets.ana.state, BREE_CORNER), false, "Bree's room is open on Ana's map");
  });

  test("pv-2b. the DM drags the goblin within Thorn's light: Ana's page gets the drag, and pv-8 finds none of it on Ben's or the display's", async () => {
    const from = sockets.ana.received.length;
    await dragCells(dm, BOUNDS, GOBLIN_AT, GOBLIN_LATER);
    await waitFor("the goblin moved in Ana's copy", () => {
      const g = sockets.ana.state?.tokens[run.goblinId];
      return g?.x === GOBLIN_LATER.x && g.y === GOBLIN_LATER.y ? true : null;
    });
    const dragFrames = sockets.ana.received.slice(from).filter((text) => text.includes('"t":"eph"') && text.includes(run.goblinId));
    assert.ok(dragFrames.length > 0, "Ana's page got no frame of the goblin's drag, so the run never tested the drag's filter");
    // The goblin stays in Thorn's light, so pv-3 to pv-7 meet it as before.
    assert.equal(has.goblin(sockets.ben.state), false, "the goblin reached Ben by the drag");
  });

  test("pv-3. Thorn opens a door on ground Ben never explored: open on Ana's map, not drawn on Ben's, and drawn open for Ben once Bree sees it", async () => {
    await tapDoor(ana);
    const closed = ana.getByRole("group", { name: "Closed door" });
    await closed.getByRole("button", { name: "Open" }).click();
    await waitFor("the open door in Ana's copy", () => (doorIn(sockets.ana.state)?.kind === "door" && (doorIn(sockets.ana.state) as { state: string }).state === "open" ? true : null));
    await ana.getByRole("group", { name: "Open door" }).waitFor();
    await shots.take(ana, "pervision-ana-door-open");
    await tapAway(ana, { x: 13, y: 3 });

    // Doors are shared and live (D-261025-17): Ben's copy holds the open door, under his fog, so his map draws nothing there.
    await waitFor("the open door in Ben's copy", () => ((doorIn(sockets.ben.state) as { state?: string } | undefined)?.state === "open" ? true : null));
    assert.equal(has.ground(sockets.ben.state, DOOR_NORTH) || has.ground(sockets.ben.state, DOOR_SOUTH), false, "the door's ground is open on Ben's map");
    await tapDoor(ben);
    await ben.waitForTimeout(800);
    assert.equal(await ben.getByRole("group", { name: /door$/ }).count(), 0, "Ben's map offered a door it does not draw");
    await shots.take(ben, "pervision-ben-door-unseen");

    await ops.send({ t: "token.move", tokenId: run.breeId, ...BREE_LATER });
    await waitFor("the door's south side on Ben's map", () => has.ground(sockets.ben.state, DOOR_SOUTH) || null);
    await tapDoor(ben);
    await ben.getByRole("group", { name: "Open door" }).waitFor();
    await shots.take(ben, "pervision-ben-door-seen");
    await tapAway(ben, { x: 13, y: 3 });
    // Through the open door Bree sees only the north hall's west edge.
    assert.equal(has.goblin(sockets.ben.state), false, "the goblin reached Ben through the door");
    assert.equal(has.label(sockets.ben.state), false, "the label reached Ben through the door");
  });

  test("pv-4. View as Ben and as Ana each show only that player's view, after the loading line, and no whisper between them", async () => {
    const anaOps = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie: await cookieOf(anaContext) });
    try {
      await anaOps.send({ t: "log.whisper", to: [run.benId], text: WHISPER });
    } finally {
      anaOps.close();
    }
    await ops.send({ t: "log.chat", text: "Roll for initiative" });
    await waitFor("the whisper in Ben's log", () => sockets.ben.state?.log.some((e) => e.text === WHISPER) || null);

    for (const [name, memberId, sees] of [["Ben", run.benId, false], ["Ana", run.anaId, true]] as const) {
      const { preview, snapshot } = await viewAs(name);
      try {
        const state = snapshot.state as unknown as RoomState;
        assert.equal(snapshot.you?.memberId, memberId, `the preview of ${name} is someone else's view`);
        assert.equal(snapshot.you?.role, "player");
        assert.equal(has.goblin(state), sees, `the preview of ${name} ${sees ? "lacks" : "holds"} the goblin`);
        assert.equal(has.label(state), sees, `the preview of ${name} ${sees ? "lacks" : "holds"} the label`);
        assert.equal(has.ground(state, BREE_CORNER), !sees, `the preview of ${name} has the wrong map of Bree's room`);
        await turnStrip(preview)
          .and(preview.getByRole("button", { name: sees ? /Goblin's turn/ : /Another creature's turn/ }))
          .waitFor();
        await preview.getByRole("tab", { name: sideTabName("Log") }).waitFor();
        await openSideTab(preview, "Log");
        const log = preview.getByRole("tabpanel", { name: sideTabName("Log") });
        await log.getByText("Roll for initiative").waitFor();
        assert.equal(await log.getByText(WHISPER).count(), 0, `the preview of ${name} shows the whisper`);
        assert.equal(previews.frames.some((f) => f.includes(WHISPER)), false, `a frame of the preview of ${name} carried the whisper`);
        await shots.take(dm, `pervision-preview-${name.toLowerCase()}`);
      } finally {
        await exitPreview(preview);
      }
    }
  });

  test("pv-5. a Night phase switch keeps the scene per player", async () => {
    await dm.getByLabel("Map phase").selectOption({ label: "Night" });
    await waitFor("Night in the DM's copy", () => (sockets.dm.state?.scenes[run.sceneId]?.phaseId === run.phases.night ? true : null));
    await waitFor("Night's map on Ben's phone", () => (sockets.ben.state?.scenes[run.sceneId]?.map?.assetId === run.nightMap ? true : null));
    for (const [who, watch] of Object.entries(sockets)) assert.equal(has.perPlayer(watch.state), true, `${who}'s copy lost Per player`);
    await openSideTab(dm, "Scenes");
    assert.equal(await scenesPanel().getByRole("radiogroup", { name: "Sight" }).getByRole("radio", { name: "Per player" }).isChecked(), true, "the Sight row left Per player");
    assert.equal(has.goblin(sockets.ben.state), false, "the goblin reached Ben at Night");
    assert.equal(has.goblin(sockets.ana.state), true, "Ana lost the goblin at Night");
  });

  test("pv-6. the DM unticks Ana and ticks Cy, a third player: the list and the maps follow", async () => {
    const cyContext = await browser.newContext();
    try {
      run.cyId = await join(cyContext, "Cy", "#46a758");
    } finally {
      await cyContext.close();
    }
    await openSideTab(dm, "Scenes");
    const list = scenesPanel().getByRole("group", { name: "Who sees for themselves" });
    const box = (name: string) => list.getByRole("checkbox", { name });
    await waitFor("Cy in the list, unticked", async () => ((await box("Cy").count()) === 1 && !(await box("Cy").isChecked()) ? true : null));
    await box("Ana").click();
    const question = list.getByRole("group", { name: "Untick Ana?" });
    await question.getByRole("button", { name: "Untick", exact: true }).click();
    await question.waitFor({ state: "detached" });
    await listIs(["Ana off", "Ben on"]);
    await box("Cy").click();
    await listIs(["Ana off", "Ben on", "Cy on"]);
    await list.getByText("Ana sees only what creatures that share sight see here.").waitFor();
    await list.scrollIntoViewIfNeeded();
    await shots.take(dm, "pervision-dm-list-ana-off-cy-on");

    // Ana forgets her map of the scene and sees only what shares sight, which here is nothing.
    await waitFor("the goblin gone from Ana's copy", () => (has.goblin(sockets.ana.state) ? null : true));
    await waitFor("the label gone from Ana's copy", () => (has.label(sockets.ana.state) ? null : true));
    assert.equal(has.ground(sockets.ana.state, LABEL_CELL), false, "Ana's map kept the north hall");
    await turnStrip(ana).and(ana.getByRole("button", { name: /Another creature's turn/ })).waitFor();
    await shots.take(ana, "pervision-ana-unticked");
    // Ben's place and map stay as they were.
    assert.equal(has.ground(sockets.ben.state, BREE_CORNER), true, "Ben lost his map");
    assert.equal(has.goblin(sockets.ben.state), false);
  });

  test("pv-7. Whole party pools the maps, and back to Per player they stay pooled", async () => {
    run.pooledAt = { ben: sockets.ben.received.length, tv: sockets.tv.received.length };
    await pickSight("Whole party");
    await waitFor("the list emptied", () => (holderList().length === 0 ? true : null));
    // Bree's corner, which only Ben's own map held, is on Ana's map now, and the north hall Thorn sees on Ben's.
    await waitFor("Bree's corner on Ana's map", () => has.ground(sockets.ana.state, BREE_CORNER) || null);
    await waitFor("the label on Ben's map", () => has.label(sockets.ben.state) || null);
    assert.equal(has.goblin(sockets.ben.state), true, "the whole party's sight left the goblin out of Ben's copy");
    await shots.take(ben, "pervision-ben-whole-party");

    await pickSight("Per player");
    await listIs(["Ana on", "Ben on"]);
    await waitFor("the goblin gone from Ben's copy", () => (has.goblin(sockets.ben.state) ? null : true));
    await waitFor("the goblin back in Ana's copy", () => has.goblin(sockets.ana.state) || null);
    assert.equal(has.ground(sockets.ana.state, BREE_CORNER), true, "Ana's map lost Bree's corner");
    assert.equal(has.ground(sockets.ben.state, LABEL_CELL), true, "Ben's map lost the north hall");
    assert.equal(has.label(sockets.ben.state), true, "the label left Ben's pooled map");
    await shots.take(ben, "pervision-ben-pooled");
    await shots.take(ana, "pervision-ana-pooled");
  });

  test("pv-8. no frame Ben's page or the display received held or named the goblin, its row or a list or layer while per player, or the label before the pool, and no page logged an error", () => {
    for (const [who, watch, pooledAt] of [["Ben", sockets.ben, run.pooledAt.ben], ["the display", sockets.tv, run.pooledAt.tv]] as const) {
      assert.ok(pooledAt > 0, "pv-7 never ran");
      let perPlayer = 0;
      const broken = replay(watch, (state, index) => {
        if (has.perPlayer(state)) perPlayer++;
        if (has.perPlayer(state) && has.goblin(state)) return "the goblin, per player";
        if (has.perPlayer(state) && state.encounter?.entries.some((e) => e.tokenId === run.goblinId)) return "the goblin's row, per player";
        if (index < pooledAt && has.label(state)) return "the label, before the pool";
        return null;
      });
      assert.deepEqual(broken, [], `${who}'s page`);
      // So the rule above judged copies of a per-player scene, not only whole-party ones.
      assert.ok(perPlayer > 5, `${who}'s page held a per-player scene after only ${perPlayer} frames`);
      // Every frame as sent, of every kind, drag frames, rows and log lines included. Before the pool the goblin never
      // reached this page, so not even a deletion may name it, and the label's words never did.
      const named = watch.received.flatMap((text, index) => {
        const found: string[] = [];
        if (index < pooledAt && text.includes(run.goblinId)) found.push("the goblin's id");
        if (index < pooledAt && text.includes(LABEL_TEXT)) found.push("the label's words");
        for (const needle of DM_ONLY) if (text.includes(needle)) found.push(needle);
        return found.length > 0 ? [`frame ${index} (${(JSON.parse(text) as Frame).t}): ${found.join(", ")}`] : [];
      });
      assert.deepEqual(named, [], `${who}'s page`);
    }
    for (const c of Object.values(consoles)) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
