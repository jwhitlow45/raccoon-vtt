import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import type { BuildChunk, RoomState, Scene, Stamp } from "#shared/model.ts";
import { drawMap } from "../client/features/grid/synthetic.ts";
import { STARTER_STAMPS } from "#shared/starterStamps.ts";
import { retainedGrid, starterMapScene } from "../client/features/starter/mapScene.ts";
import { ConsoleWatch, dragWorld, openSideTab, pickOption, pressOption, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";
import { assetRow, chooseStarterWork, starterWork } from "./starterPick.ts";

/**
 * The v1 wave 3 run (docs/design-v1-maps-vision.md section 3): the real
 * server serving the production build, a DM on a desktop and a player on a
 * phone. The DM imports a Universal VTT file written here, switches its map
 * between two phases with the player watching, stamps the map, and
 * duplicates the scene. Every frame the player receives is kept, to check
 * that nothing meant for the DM alone (the other phase, lights, a DM-only
 * stamp, a stamp under fog, the copy) ever reaches it.
 *
 * It runs with `pnpm test:e2e`, after the smoke run, on its own port so the
 * two never share one. The environment variables are the smoke run's
 * (smoke.e2e.ts), and E2E_PORT plus one is this run's port.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 1;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

/**
 * The synthetic map: 10 by 8 squares of 50 px, its origin half a square
 * into the grid on both axes, so the scene also covers the partial square
 * before the image (11 by 9) and the image starts at world 0.5.
 */
const UVTT = { file: "Sunken_keep.dd2vtt", name: "Sunken keep", cols: 10, rows: 8, ppg: 50, origin: 0.5 };
const PHASE = { file: "Blazing_inferno.png", name: "Blazing inferno" };

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-maps-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let playerContext: BrowserContext;
let dm: Page;
let player: Page;
const dmSocket = new SocketWatch("dm");
const playerSocket = new SocketWatch("player");
const dmConsole = new ConsoleWatch("dm");
const playerConsole = new ConsoleWatch("player");

const run = {
  roomId: "",
  roomName: `E2E maps ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  bounds: { w: 0, h: 0 },
  dayAssetId: "",
  fireAssetId: "",
  firePhaseId: "",
  lightId: "",
  stampId: "",
  hiddenStampId: "",
  copyId: "",
};

/** Flagstones drawn here in one tint, so no art is downloaded and the two phases look different. */
async function makeImage(cols: number, rows: number, ppg: number, tint: [number, number, number]): Promise<Buffer> {
  const width = cols * ppg;
  const height = rows * ppg;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const grout = x % ppg < 2 || y % ppg < 2;
      const shade = (Math.floor(x / ppg) + Math.floor(y / ppg)) % 2 === 0 ? 1 : 0.85;
      for (let c = 0; c < 3; c++) pixels[i + c] = grout ? 30 : Math.round(tint[c]! * shade);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

type P = { x: number; y: number };

/**
 * A Universal VTT file as Dungeondraft writes one (section 3.1's keys), in
 * file squares. A room along grid lines from (1, 1) to (9, 7), a door in its
 * north wall, a window in its south wall, one wall off the grid, and a light.
 */
async function writeUvtt(file: string): Promise<void> {
  const image = await makeImage(UVTT.cols, UVTT.rows, UVTT.ppg, [150, 140, 120]);
  const portal = (a: P, b: P, closed: boolean) => ({
    position: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    bounds: [a, b],
    rotation: 0,
    closed,
    freestanding: false,
  });
  const content = {
    format: 0.3,
    resolution: { map_origin: { x: UVTT.origin, y: UVTT.origin }, map_size: { x: UVTT.cols, y: UVTT.rows }, pixels_per_grid: UVTT.ppg },
    line_of_sight: [
      [
        { x: 1, y: 1 },
        { x: 9, y: 1 },
        { x: 9, y: 7 },
        { x: 1, y: 7 },
        { x: 1, y: 1 },
      ],
      [
        { x: 2, y: 5 },
        { x: 4, y: 6 },
      ],
    ],
    objects_line_of_sight: [],
    portals: [portal({ x: 4, y: 1 }, { x: 5, y: 1 }, true), portal({ x: 6, y: 7 }, { x: 7, y: 7 }, false)],
    environment: { baked_lighting: true, ambient_light: "ffffffff" },
    lights: [{ position: { x: 5.5, y: 4.5 }, range: 4, intensity: 1, color: "ffeccd8b", shadows: true }],
    image: image.toString("base64"),
  };
  writeFileSync(file, JSON.stringify(content));
}

function sceneOf(state: RoomState | null, id: string): Scene | undefined {
  return state?.scenes[id];
}

function chunksOf(state: RoomState | null, sceneId: string): BuildChunk[] {
  return Object.values(state?.buildChunks ?? {}).filter((c): c is BuildChunk => !!c && c.sceneId === sceneId);
}

function stampsOf(state: RoomState | null, sceneId: string): Stamp[] {
  return Object.values(state?.stamps ?? {}).filter((s): s is Stamp => !!s && s.sceneId === sceneId);
}

/**
 * Line up grid's box as the map draws it (features/grid/GridLayer.tsx, the
 * rectangle with the faint yellow fill), in world squares, with the
 * camera of its stage and the canvas's size, or null while none is drawn.
 */
function gridBox(page: Page) {
  return page.evaluate(() => {
    type Node = { x(): number; y(): number; width(): number; fill(): unknown };
    type KStage = { x(): number; y(): number; scaleX(): number; width(): number; height(): number; find(selector: string): Node[] };
    const konva = (globalThis as unknown as { Konva?: { stages: KStage[] } }).Konva;
    for (const stage of konva?.stages ?? []) {
      const box = stage.find("Rect").find((r) => r.fill() === "rgba(247, 223, 0, 0.08)");
      if (box) return { x: box.x(), y: box.y(), size: box.width(), stageX: stage.x(), stageY: stage.y(), scale: stage.scaleX(), width: stage.width(), height: stage.height() };
    }
    return null;
  });
}

/** A scene's edges and free walls in a form two scenes can be compared by. */
function wallsOf(state: RoomState | null, sceneId: string): { edges: Record<string, unknown>; free: unknown[] } {
  const edges: Record<string, unknown> = {};
  const free: unknown[] = [];
  for (const chunk of chunksOf(state, sceneId)) {
    Object.assign(edges, chunk.edges);
    free.push(...(chunk.walls ?? []));
  }
  return { edges, free };
}

/** Waits for the page to fetch an asset's image, whichever variant its device draws. */
function imageLoaded(page: Page, assetId: string) {
  return page.waitForResponse((r) => new RegExp(`/api/assets/${assetId}/(full|mobile)$`).test(r.url()) && r.ok(), { timeout: 30_000 });
}

/** What the player's projection says about a scene it must not see the DM's side of. */
function assertNoDmFields(scene: Scene | undefined): void {
  assert.ok(scene, "the player has no scene");
  for (const key of ["phases", "phaseId", "phaseGrid", "folder", "thumb"] as const) assert.equal(key in scene, false, `the player received the scene's ${key}`);
}

describe("raccoon-vtt maps run", { timeout: 300_000 }, () => {
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
  });

  test("2. the DM imports a Universal VTT file and gets its image, walls, doors and light", async () => {
    const file = path.join(work, UVTT.file);
    await writeUvtt(file);
    await openSideTab(dm, "Scenes");
    await dm.getByLabel("From a Universal VTT file").setInputFiles(file);
    const dialog = dm.getByRole("dialog", { name: "Import a Universal VTT map" });
    await dialog.getByText("11 × 9 squares, 500 × 400 pixels.").waitFor({ timeout: 30_000 });
    await dialog.getByText("27 walls (26 on the grid, 1 free), 1 door, 1 window, 1 light.").waitFor();
    assert.equal(await dialog.getByLabel("Scene name").inputValue(), UVTT.name);
    // A new room starts new scenes on Explore. This run reveals by hand, as an import under fog did before Players see.
    const playersSee = dialog.getByRole("radiogroup", { name: "Players see", exact: true });
    assert.equal(await playersSee.getByRole("radio", { name: "Explore", exact: true }).isChecked(), true);
    await playersSee.getByRole("radio", { name: "Reveal by hand", exact: true }).check();
    await shots.take(dm, "maps-uvtt-summary");

    const sceneIds = new Set(Object.keys(dmSocket.state?.scenes ?? {}));
    await dialog.getByRole("button", { name: "Create scene" }).click();
    await dialog.waitFor({ state: "detached", timeout: 60_000 });
    const scene = await waitFor("the imported scene", () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s && !sceneIds.has(s.id)), 30_000);
    run.sceneId = scene.id;
    run.bounds = scene.bounds;
    assert.equal(scene.name, UVTT.name);
    assert.deepEqual(scene.bounds, { w: 11, h: 9 }, "the scene covers the partial square before the image");
    assert.equal(scene.autoWalls, "off", "an import brings its own walls");
    assert.equal(scene.gridFromFile, true, "and keeps a mark that its grid came with the file");
    assert.equal(scene.fogEnabled, true);
    assert.ok(scene.map, "the scene has no map image");
    run.dayAssetId = scene.map.assetId;
    assert.deepEqual({ w: scene.map.widthPx, h: scene.map.heightPx, cellPx: scene.map.cellPx }, { w: 500, h: 400, cellPx: UVTT.ppg });
    assert.deepEqual(scene.map.originPx, { x: -UVTT.origin * UVTT.ppg, y: -UVTT.origin * UVTT.ppg });

    await waitFor("the DM on the imported scene", () => dmSocket.you?.sceneId === run.sceneId || null, 30_000);
    const walls = await waitFor("the imported walls", () => {
      const w = wallsOf(dmSocket.state, run.sceneId);
      return Object.keys(w.edges).length === 28 && w.free.length === 1 ? w : null;
    });
    const kinds = Object.values(walls.edges).map((f) => (f as { kind: string }).kind);
    assert.equal(kinds.filter((k) => k === "wall").length, 26);
    assert.deepEqual(walls.edges["4,1,n"], { kind: "door", state: "closed", secret: false, discovered: false });
    assert.deepEqual(walls.edges["6,7,n"], { kind: "window" });
    // The north wall's east end lies on the scene's own grid line, not past it.
    assert.deepEqual(walls.edges["9,1,w"], { kind: "wall" });
    const free = walls.free[0] as { a: [number, number]; b: [number, number]; f: { kind: string } };
    assert.deepEqual([free.a, free.b, free.f.kind], [[2, 5], [4, 6], "wall"]);
    const lights = Object.values(dmSocket.state?.lights ?? {}).filter((l) => l?.sceneId === run.sceneId);
    assert.equal(lights.length, 1);
    run.lightId = lights[0]!.id;
    assert.deepEqual({ x: lights[0]!.x, y: lights[0]!.y, bright: lights[0]!.bright, dim: lights[0]!.dim }, { x: 5.5, y: 4.5, bright: 10, dim: 10 });

    // The image draws on the DM's map. Its row in the panel shows the map's own thumbnail meanwhile.
    await waitFor("the map image on the DM's page", () =>
      dm.evaluate((id) => performance.getEntriesByType("resource").some((e) => new RegExp(`/api/assets/${id}/(full|mobile)$`).test(e.name)), run.dayAssetId),
    );
    await shots.take(dm, "maps-uvtt-imported");
  });

  test("3. the grid settings offer no square counts for a grid that starts before the image", async () => {
    // Counting assumes squares from the image's corner, which would slide this map half a square under its walls.
    await dm.getByRole("button", { name: "Line up the grid" }).waitFor();
    assert.equal(await dm.getByLabel("Squares across the image").count(), 0);
    assert.equal(await dm.getByText("Those counts make squares that are not square", { exact: false }).count(), 0);
  });

  test("4. the player moves to the imported scene and gets its image and walls, never its light", async () => {
    const loaded = imageLoaded(player, run.dayAssetId);
    await dm.getByRole("button", { name: `Move players to ${UVTT.name}` }).click();
    await waitFor("the player on the imported scene", () => playerSocket.state?.meta.playerSceneId === run.sceneId || null);
    await loaded;
    const walls = await waitFor("the walls in the player's state", () => {
      const w = wallsOf(playerSocket.state, run.sceneId);
      return Object.keys(w.edges).length === 28 && w.free.length === 1 ? w : null;
    });
    assert.deepEqual(walls, wallsOf(dmSocket.state, run.sceneId), "players see the imported walls and doors as the DM does");
    assert.equal(Object.keys(playerSocket.state?.lights ?? {}).length, 0);
    assert.equal(playerSocket.everSaw(run.lightId), false, "a light reached the player");
    assertNoDmFields(sceneOf(playerSocket.state, run.sceneId));
    await shots.take(player, "maps-player-imported-fogged");
  });

  test("5. a second map phase never reaches the player until it shows, and then only as the map", async () => {
    const file = path.join(work, PHASE.file);
    writeFileSync(file, await makeImage(UVTT.cols, UVTT.rows, UVTT.ppg, [220, 90, 40]));
    await dm.getByLabel("Add a phase from an image").setInputFiles(file);
    const scene = await waitFor("two phases", () => {
      const s = sceneOf(dmSocket.state, run.sceneId);
      return s?.phases?.length === 2 ? s : null;
    }, 30_000);
    const fire = scene.phases!.find((p) => p.name === PHASE.name);
    assert.ok(fire, `no phase named ${PHASE.name}`);
    run.fireAssetId = fire.assetId;
    run.firePhaseId = fire.id;
    assert.equal(scene.phases![0]!.name, "Day");
    assert.equal(scene.map?.assetId, run.dayAssetId, "adding a phase does not switch to it");

    // The player has nothing of it, and cannot fetch its image ahead of time.
    await dm.getByRole("group", { name: "Show a phase" }).waitFor();
    assert.equal(playerSocket.everSaw(run.fireAssetId), false, "the other phase's image reached the player");
    assert.equal(playerSocket.everSaw(PHASE.name), false, "the other phase's name reached the player");
    const early = await playerContext.request.get(`${server.origin}/api/assets/${run.fireAssetId}/mobile`);
    assert.equal(early.ok(), false, "the player could fetch a phase that is not showing");

    const loaded = imageLoaded(player, run.fireAssetId);
    await dm.getByRole("button", { name: `Show ${PHASE.name}` }).click();
    await waitFor("the player's map to switch", () => sceneOf(playerSocket.state, run.sceneId)?.map?.assetId === run.fireAssetId || null);
    await loaded;
    const dmScene = sceneOf(dmSocket.state, run.sceneId);
    assert.equal(dmScene?.phaseId, run.firePhaseId);
    assert.equal(dmScene?.map?.cellPx, UVTT.ppg, "the grid stays on the same cells");
    assertNoDmFields(sceneOf(playerSocket.state, run.sceneId));
    assert.equal(playerSocket.everSaw(PHASE.name), false, "a phase's name reached the player");
    assert.equal(playerSocket.everSaw("phaseGrid"), false);
    await shots.take(dm, "maps-phase-switched");
    await shots.take(player, "maps-player-phase-switched");

    // Back to day from the top bar's Phase menu.
    await dm.getByLabel("Map phase").selectOption({ label: "Day" });
    await waitFor("the player's map back to day", () => sceneOf(playerSocket.state, run.sceneId)?.map?.assetId === run.dayAssetId || null);
    assert.equal(playerSocket.everSaw(PHASE.name), false);
  });

  test("6. a stamp reaches the player once its cell is revealed, and a DM-only one never does", async () => {
    await dm.getByRole("button", { name: "Map builder" }).click();
    await pickOption(dm, "Map builder", "Builder mode", "Stamp");
    await dm.getByRole("button", { name: /Choose a stamp/ }).click();
    const picker = dm.getByRole("dialog", { name: "Stamps" });
    await picker.getByLabel("Search stamps").fill("barrel");
    await picker.getByRole("button", { name: "Barrel", exact: true }).click();
    await picker.waitFor({ state: "detached" });
    await tapCell(dm, run.bounds, { x: 2, y: 2 });
    const stamp = await waitFor("the stamp in the DM's state", () => stampsOf(dmSocket.state, run.sceneId)[0]);
    run.stampId = stamp.id;
    assert.deepEqual({ x: stamp.x, y: stamp.y, art: stamp.art, visibility: stamp.visibility }, { x: 2.5, y: 2.5, art: { key: "barrel" }, visibility: "all" });
    // The scene starts fogged, so a stamp in fully fogged cells stays out of the player's data.
    // The DM's socket state holds only what the server sent, so the stamp is committed, and the player's frames went out with it.
    await dm.waitForTimeout(500);
    assert.equal(playerSocket.everSaw(run.stampId), false, "a stamp under fog reached the player");

    await dm.getByRole("button", { name: "Fog", exact: true }).click();
    await dragWorld(dm, run.bounds, { x: 1, y: 1 }, { x: 5, y: 5 });
    await dm.getByRole("button", { name: /^Reveal to players \(1\)$/ }).click();
    await waitFor("the stamp in the player's state", () => playerSocket.state?.stamps[run.stampId]);
    await shots.take(player, "maps-player-stamp");

    // DM only takes it from the player, and its duplicate is DM only from the start.
    await dm.getByRole("button", { name: "Map builder" }).click();
    await pickOption(dm, "Map builder", "Builder mode", "Stamp");
    await tapCell(dm, run.bounds, { x: 2, y: 2 });
    await pressOption(dm, "Map builder", "DM only");
    await waitFor("the stamp to leave the player's state", () => (playerSocket.state?.stamps[run.stampId] ? null : true));
    await pressOption(dm, "Map builder", "Duplicate");
    const hidden = await waitFor("the duplicate", () => stampsOf(dmSocket.state, run.sceneId).find((s) => s.id !== run.stampId));
    run.hiddenStampId = hidden.id;
    assert.equal(hidden.visibility, "dm");
    await pressOption(dm, "Map builder", "Done");
    await dm.getByRole("button", { name: "Select", exact: true }).click();
    await dm.waitForTimeout(500);
    assert.equal(playerSocket.everSaw(run.hiddenStampId), false, "a DM-only stamp reached the player");
    assert.equal(Object.keys(playerSocket.state?.stamps ?? {}).length, 0);
    await shots.take(dm, "maps-dm-stamps");
  });

  test("7. the DM duplicates the scene, which the player never receives", async () => {
    const original = wallsOf(dmSocket.state, run.sceneId);
    const before = sceneOf(dmSocket.state, run.sceneId)!;
    await openSideTab(dm, "Scenes");
    await dm.getByRole("button", { name: `More for ${UVTT.name}` }).click();
    await dm.getByRole("button", { name: /^Duplicate…/ }).click();
    await dm.getByRole("button", { name: "Duplicate", exact: true }).click();
    const copy = await waitFor("the copy", () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.name === `${UVTT.name} (copy)`), 30_000);
    run.copyId = copy.id;
    await waitFor("the DM on the copy", () => dmSocket.you?.sceneId === run.copyId || null, 30_000);
    assert.deepEqual(copy.map, before.map);
    assert.deepEqual(copy.phases, before.phases);
    assert.deepEqual(copy.phaseGrid, before.phaseGrid);
    assert.equal(copy.autoWalls, "off");
    const walls = await waitFor("the copy's walls", () => {
      const w = wallsOf(dmSocket.state, run.copyId);
      return Object.keys(w.edges).length > 0 ? w : null;
    });
    assert.deepEqual(walls, original, "the copy has the original's walls, doors and window");
    const lights = Object.values(dmSocket.state?.lights ?? {}).filter((l) => l?.sceneId === run.copyId);
    assert.equal(lights.length, 1);
    assert.notEqual(lights[0]!.id, run.lightId, "a copied light gets its own ID");
    const stamps = stampsOf(dmSocket.state, run.copyId);
    assert.equal(stamps.length, 2);
    assert.ok(stamps.every((s) => s.id !== run.stampId && s.id !== run.hiddenStampId), "copied stamps get their own IDs");
    await shots.take(dm, "maps-duplicated");

    // Leaving the changed original draws its thumbnail. Neither it nor the copy reaches the player.
    const thumb = await waitFor("the original's thumbnail", () => sceneOf(dmSocket.state, run.sceneId)?.thumb, 30_000);
    await dm.waitForTimeout(500);
    assert.equal(playerSocket.everSaw(run.copyId), false, "the copy reached the player");
    assert.equal(playerSocket.everSaw(thumb), false, "a thumbnail reached the player");
    assertNoDmFields(sceneOf(playerSocket.state, run.sceneId));
    assert.deepEqual(Object.keys(playerSocket.state?.scenes ?? {}), [run.sceneId]);
  });

  test("gd-a. a drawn grid is found on upload, Use default and Undo take it back, Find the grid finds it again, a map without one keeps the guess, and a Universal VTT scene is only offered the box", async () => {
    // Both maps are drawn here by code (client/features/grid/synthetic.ts), never art: noise, and on one
    // of them 70 px squares whose lines cross at (20, 35). Neither name gives a size.
    const DRAWN = { cellPx: 70, originPx: { x: 20, y: 35 }, bounds: { w: 19, h: 13 } };
    // initialMap's first guess for a 1400 x 1000 image: about 30 squares on the long side.
    const GUESS = { cellPx: 47, originPx: { x: 0, y: 0 }, bounds: { w: 29, h: 21 } };
    const write = async (file: string, grid: boolean) => {
      const px = drawMap({ width: 1400, height: 1000, seed: grid ? 3 : 4, art: [{ kind: "noise", scale: 60, amp: 70 }], noise: 4, ...(grid ? { grid: { cellPx: 70, origin: { x: 20, y: 35 }, opacity: 0.5, width: 2 } } : {}) });
      await sharp(Buffer.from(px.data), { raw: { width: px.width, height: px.height, channels: 1 } }).png().toFile(file);
    };
    const upload = async (file: string) => {
      const known = new Set(Object.keys(dmSocket.state?.scenes ?? {}));
      await openSideTab(dm, "Scenes");
      await dm.getByRole("radio", { name: "Map image", exact: true }).click();
      await dm.getByRole("button", { name: "Choose a map image" }).setInputFiles(file);
      await dm.getByRole("button", { name: "Upload and create" }).click();
      const scene = await waitFor("the new map scene", () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.map && !known.has(s.id)), 30_000);
      await waitFor("the DM on it", () => dmSocket.you?.sceneId === scene.id || null);
      return scene.id;
    };
    /** Whether the scene's grid is `want`: the size to a twentieth of a pixel, the lines to half a pixel. */
    const gridIs = (id: string, want: { cellPx: number; originPx: { x: number; y: number }; bounds: { w: number; h: number } }) => {
      const scene = sceneOf(dmSocket.state, id);
      const map = scene?.map;
      return (
        !!map &&
        Math.abs(map.cellPx - want.cellPx) < 0.05 &&
        Math.abs(map.originPx.x - want.originPx.x) < 0.5 &&
        Math.abs(map.originPx.y - want.originPx.y) < 0.5 &&
        scene.bounds.w === want.bounds.w &&
        scene.bounds.h === want.bounds.h
      );
    };
    const gridOptions = dm.getByRole("toolbar", { name: "Line up grid options" });
    const drawn = path.join(work, "Drawn keep.png");
    const plain = path.join(work, "Plain field.png");
    await write(drawn, true);
    await write(plain, false);

    // On upload: the found grid is on the scene, sized to its squares, and Line up grid says so.
    const keep = await upload(drawn);
    await waitFor("the found grid on the scene", () => gridIs(keep, DRAWN) || null, 15_000);
    await dm.getByText("Found a grid of 70 px squares.").first().waitFor();
    await shots.take(dm, "maps-gd-found-on-upload");

    // Use default puts the first guess back.
    await gridOptions.getByRole("button", { name: "Use default", exact: true }).click();
    await waitFor("the guess back", () => gridIs(keep, GUESS) || null);

    // Find the grid, on a scene whose grid is wrong, finds it again. Undo takes it back in one step.
    await gridOptions.getByRole("button", { name: "Find the grid", exact: true }).click();
    await waitFor("the found grid again", () => gridIs(keep, DRAWN) || null, 15_000);
    await dm.getByText("Found a grid of 70 px squares.").first().waitFor();
    await dm.getByRole("button", { name: "Undo", exact: true }).click();
    await waitFor("one undo back to the guess", () => gridIs(keep, GUESS) || null);

    // A map without a grid keeps the guess, and Line up grid asks for a box as before. The Scenes
    // panel's Find the grid, in its Grid settings, answers in Line up grid too.
    const field = await upload(plain);
    await dm.getByText("Drag a box over 3 by 3 squares of the art").first().waitFor();
    assert.ok(gridIs(field, GUESS), "a map without a grid keeps the first guess");
    await openSideTab(dm, "Scenes");
    await dm.getByRole("tabpanel", { name: "Scenes" }).getByRole("button", { name: "Find the grid", exact: true }).click();
    await dm.getByText("No grid found.", { exact: false }).first().waitFor({ timeout: 15_000 });
    assert.ok(gridIs(field, GUESS), "finding no grid changes nothing");
    await shots.take(dm, "maps-gd-no-grid");

    // On the scene from the Universal VTT file, Find the grid only places the box, however sure, and says
    // the scene came with its own grid. Its art's grout runs from the image's corner, half a square off the file's grid.
    const fileGrid = sceneOf(dmSocket.state, run.sceneId)!.map!;
    await openSideTab(dm, "Scenes");
    const scenes = dm.getByRole("tabpanel", { name: "Scenes" });
    await scenes.getByRole("button", { name: new RegExp(`^${UVTT.name}(?! \\(copy\\))`) }).click();
    await waitFor("the DM on the imported scene", () => dmSocket.you?.sceneId === run.sceneId || null, 30_000);
    await scenes.getByRole("button", { name: "Find the grid", exact: true }).click();
    await dm.getByText("This scene came with its own grid.", { exact: false }).first().waitFor({ timeout: 15_000 });
    assert.deepEqual(sceneOf(dmSocket.state, run.sceneId)?.map, fileGrid, "the file's grid stays");
    await shots.take(dm, "maps-gd-own-grid");
  });

  test("uip3-a. Line up grid's box starts on the image of the scene the DM switches to, in the middle of its view, never where the last scene's view was", async () => {
    // gd-a left Line up grid open on the Universal VTT scene, 10 by 8 squares. The drawn keep is 29 by 21, so
    // the middle of its view lies past the small scene's image, where a box placed by the old view would land.
    const keep = Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.name === "Drawn keep");
    assert.ok(keep?.map, "gd-a's drawn keep");
    const gridOptions = dm.getByRole("toolbar", { name: "Line up grid options" });
    const scenes = dm.getByRole("tabpanel", { name: "Scenes" });
    for (const [id, card] of [
      [keep.id, /^Drawn keep/],
      [run.sceneId, new RegExp(`^${UVTT.name}(?! \\(copy\\))`)],
    ] as const) {
      await openSideTab(dm, "Scenes");
      await scenes.getByRole("button", { name: card }).click();
      await waitFor("the DM on the scene", () => dmSocket.you?.sceneId === id || null, 30_000);
      await gridOptions.waitFor();
      const map = sceneOf(dmSocket.state, id)!.map!;
      const image = { left: -map.originPx.x / map.cellPx, top: -map.originPx.y / map.cellPx, right: (map.widthPx - map.originPx.x) / map.cellPx, bottom: (map.heightPx - map.originPx.y) / map.cellPx };
      const box = await waitFor("Line up grid's box on this scene's image and in view", async () => {
        const b = await gridBox(dm);
        if (!b) return null;
        const mid = { x: b.x + b.size / 2, y: b.y + b.size / 2 };
        const onImage = mid.x > image.left && mid.x < image.right && mid.y > image.top && mid.y < image.bottom;
        const screen = { x: b.stageX + mid.x * b.scale, y: b.stageY + mid.y * b.scale };
        const inView = screen.x > 0 && screen.x < b.width && screen.y > 0 && screen.y < b.height;
        return onImage && inView ? { ...b, mid } : null;
      }, 5_000).catch(async (err: unknown) => {
        throw new Error(`${(err as Error).message}: the box is ${JSON.stringify(await gridBox(dm))} on an image of ${JSON.stringify(image)}`);
      });
      assert.ok(box.size > 0);
    }
    await shots.take(dm, "maps-uip3-box-after-switch");
  });

  test("sa-a-2. new scene from a starter map: the map is copied in, and the scene starts on its measured grid in its grid color, with no alignment", async () => {
    // A paper map with a measured grid and its own grid color, the case the catalog's grid exists for.
    const found = starterWork("map", (w) => w.grid?.originPx !== undefined && w.gridColor !== undefined);
    const known = new Set(Object.keys(dmSocket.state?.scenes ?? {}));
    // gd-a left Line up grid open, so the select tool first, to see that this scene never opens it.
    await dm.getByRole("button", { name: "Select", exact: true }).click();
    await dm.getByRole("toolbar", { name: "Line up grid options" }).waitFor({ state: "detached" });
    await openSideTab(dm, "Scenes");
    await dm.getByRole("radio", { name: "Map image", exact: true }).click();
    await dm.getByRole("button", { name: "From starter packs" }).click();
    const dialog = dm.getByRole("dialog", { name: "Starter maps" });
    await chooseStarterWork(dialog, found, "browse", false);
    await shots.take(dm, "sa-a-2-starter-maps");
    await dialog.getByRole("button", { name: "Use", exact: true }).click();
    const scene = await waitFor("the starter map's scene", () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.map && !known.has(s.id)), 30_000);
    await waitFor("the DM on it", () => dmSocket.you?.sceneId === scene.id || null, 30_000);
    const map = scene.map!;
    assert.equal(scene.name, found.work.name);
    assert.ok(Math.abs(map.cellPx - found.work.grid!.cellPx * (map.widthPx / found.work.width)) < 0.01, `the scene's squares are ${map.cellPx} px`);
    assert.equal(scene.grid.color, found.work.gridColor!.toLowerCase());
    // The catalog's grid on this very file, as the server answered it from its own catalog.
    const grid = retainedGrid({ width: map.widthPx, sha256: found.work.sha256 }, found.work);
    const expected = starterMapScene({ id: scene.id, name: "", asset: { id: map.assetId, width: map.widthPx, height: map.heightPx }, work: found.work, grid }).scene;
    assert.deepEqual(map.originPx, expected.map?.originPx);
    assert.deepEqual(scene.bounds, expected.bounds);
    // On the map's own grid, so Line up grid never opens.
    await dm.waitForTimeout(500);
    assert.equal(await dm.getByRole("toolbar", { name: "Line up grid options" }).count(), 0, "a starter map with a grid opened grid alignment");
    const row = await assetRow(dmContext.request, server.origin, run.roomId, map.assetId);
    assert.equal(row?.kind, "map");
    assert.equal(row?.starter, found.work.key, "the row names the work it was copied from");
    assert.equal(row?.sha256, found.work.sha256, "and the file it holds, so a later scene can trust the catalog's grid for it");
    await shots.take(dm, "sa-a-2-starter-map-scene");
  });

  test("sa-a-4. a starter prop from the stamp picker's Starter tab is placed by its key, with nothing copied, and the outliner names it", async () => {
    const found = starterWork("stamp");
    const sceneId = dmSocket.you!.sceneId!;
    const bounds = dmSocket.state!.scenes[sceneId]!.bounds;
    const assetsBefore = ((await (await dmContext.request.get(`${server.origin}/api/rooms/${run.roomId}/assets`)).json()) as { assets: unknown[] }).assets.length;
    await dm.getByRole("button", { name: "Map builder" }).click();
    await pickOption(dm, "Map builder", "Builder mode", "Stamp");
    await dm.getByRole("button", { name: /Choose (a|another) stamp/ }).click();
    const picker = dm.getByRole("dialog", { name: "Stamps" });
    await picker.getByRole("tab", { name: "Starter", exact: true }).click();
    await chooseStarterWork(picker, found, "browse", false);
    await shots.take(dm, "sa-a-4-starter-stamps");
    await picker.getByRole("button", { name: "Use", exact: true }).click();
    await picker.waitFor({ state: "detached" });
    await tapCell(dm, bounds, { x: 2, y: 2 });
    const key = found.work.stamp!.key;
    const stamp = await waitFor("the starter stamp in the DM's state", () => stampsOf(dmSocket.state, sceneId).find((s) => "key" in s.art && s.art.key === key));
    assert.deepEqual({ w: stamp.w, h: stamp.h }, { w: found.work.stamp!.w, h: found.work.stamp!.h });
    const assetsAfter = ((await (await dmContext.request.get(`${server.origin}/api/rooms/${run.roomId}/assets`)).json()) as { assets: unknown[] }).assets.length;
    assert.equal(assetsAfter, assetsBefore, "placing a starter stamp copied an image into the room");
    await pressOption(dm, "Map builder", "Done");
    await dm.getByRole("button", { name: "Select", exact: true }).click();
    // The outliner names it as the catalog does, rather than by its key.
    const name = STARTER_STAMPS.find((s) => s.key === key)?.name ?? found.work.name;
    await openSideTab(dm, "Outliner");
    await dm.getByRole("tabpanel", { name: "Outliner" }).getByText(name, { exact: true }).first().waitFor();
    await shots.take(dm, "sa-a-4-starter-stamp-placed");
  });

  /** A battle mat made from the Scenes tab, which the DM's view then switches to. */
  async function makeMat(name: string): Promise<string> {
    const known = new Set(Object.keys(dmSocket.state?.scenes ?? {}));
    await openSideTab(dm, "Scenes");
    await dm.getByRole("radio", { name: "Battle mat", exact: true }).click();
    await dm.getByPlaceholder("Battle mat").fill(name);
    await dm.getByRole("button", { name: "Create", exact: true }).click();
    const made = await waitFor(`the scene ${name}`, () => Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.name === name && !known.has(s.id)));
    await waitFor("the DM on it", () => dmSocket.you?.sceneId === made.id || null);
    return made.id;
  }

  async function openMenu(name: string) {
    await openSideTab(dm, "Scenes");
    await dm.getByRole("button", { name: `More for ${name}`, exact: true }).click();
    const menu = dm.getByRole("dialog", { name, exact: true });
    await menu.waitFor();
    return menu;
  }

  test("sd-a. Delete in the scene menu takes two taps, for a scene off screen and for the one on screen", async () => {
    const off = await makeMat("Del off");
    const keep = await makeMat("Del keep");

    // Not the scene on screen: the first tap arms the row in place, the second deletes and closes the sheet.
    const menu = await openMenu("Del off");
    await shots.take(dm, "sd-a-menu-rest");
    await menu.getByRole("button", { name: /^Delete/ }).click();
    const armed = menu.getByRole("button", { name: /^Tap again to delete/ });
    await armed.waitFor();
    assert.ok(sceneOf(dmSocket.state, off), "one tap deleted the scene");
    await shots.take(dm, "sd-a-menu-armed");
    await armed.click();
    await waitFor("the scene gone", () => (sceneOf(dmSocket.state, off) ? null : true));
    await menu.waitFor({ state: "detached" });
    assert.equal(dmSocket.you?.sceneId, keep, "deleting another scene moved the DM's view");
  });

  test("sd-b. Deleting the scene on screen switches the DM to another, and a tap elsewhere disarms the row", async () => {
    const keep = Object.values(dmSocket.state?.scenes ?? {}).find((s) => s?.name === "Del keep")!.id;
    const shown = await makeMat("Del shown");
    // One tap, then a tap elsewhere in the sheet: the row is back at rest and the scene stays.
    let menu = await openMenu("Del shown");
    await menu.getByRole("button", { name: /^Delete/ }).click();
    await menu.getByRole("button", { name: /^Tap again to delete/ }).waitFor();
    await menu.getByRole("heading", { name: "Del shown" }).click();
    await menu.getByRole("button", { name: /^Delete/ }).waitFor();
    assert.equal(await menu.getByRole("button", { name: /^Tap again to delete/ }).count(), 0);
    assert.ok(sceneOf(dmSocket.state, shown), "a tap elsewhere deleted the scene");
    // The scene on screen: the DM lands on another scene.
    await menu.getByRole("button", { name: /^Delete/ }).click();
    await menu.getByRole("button", { name: /^Tap again to delete/ }).click();
    await waitFor("the scene gone", () => (sceneOf(dmSocket.state, shown) ? null : true));
    await waitFor("the DM on another scene", () => (dmSocket.you?.sceneId && dmSocket.you.sceneId !== shown ? true : null));
    await menu.waitFor({ state: "detached" });
    assert.ok(sceneOf(dmSocket.state, keep), "the other scene is still there");
  });

  test("sd-d. on a phone the armed row stays where it was, so the second tap lands on it", async () => {
    await makeMat("Del phone");
    const desktop = dm.viewportSize()!;
    await dm.setViewportSize({ width: 390, height: 844 });
    try {
      // The resize closes the menu but leaves the Scenes sheet open.
      await dm.getByRole("button", { name: "More for Del phone", exact: true }).click();
      const menu = dm.getByRole("dialog", { name: "Del phone", exact: true });
      const row = menu.getByRole("button", { name: /^Delete/ });
      await row.waitFor();
      const before = await row.boundingBox();
      await shots.take(dm, "sd-d-phone-menu-rest");
      await row.click();
      await menu.getByRole("button", { name: /^Tap again to delete/ }).waitFor();
      const after = await menu.getByRole("button", { name: /^Tap again to delete/ }).boundingBox();
      assert.deepEqual(after, before, "arming moved or resized the row");
      await shots.take(dm, "sd-d-phone-menu-armed");
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    } finally {
      await dm.setViewportSize(desktop);
    }
  });

  test("lp9-a. the players' scene's Delete row waits until they are moved, says why, and keeps its focus", async () => {
    // Deleting it sent them to the first scene in the list, which can be one the DM is preparing (LP9-PLAY-2).
    const players = sceneOf(dmSocket.state, dmSocket.state!.meta.playerSceneId!)!;
    const menu = await openMenu(players.name);
    try {
      const row = menu.getByRole("button", { name: /^Delete/ });
      await menu.getByText("Move the players to another scene first.").waitFor();
      // Playwright's isDisabled() counts aria-disabled too, so the native property is read.
      assert.equal(await row.evaluate((el) => (el as unknown as { disabled: boolean }).disabled), false, "natively disabled, so a focused row would lose its focus");
      assert.equal(await row.getAttribute("aria-disabled"), "true");
      await row.focus();
      await dm.keyboard.press("Enter");
      // Forced, as Playwright waits for an aria-disabled button to be enabled before a click.
      await row.click({ force: true });
      await row.click({ force: true });
      assert.equal(await menu.getByRole("button", { name: /^Tap again to delete/ }).count(), 0, "the row armed");
      assert.equal(await row.evaluate((el) => el === el.ownerDocument.activeElement), true, "the row lost its focus");
      assert.ok(sceneOf(dmSocket.state, players.id), "the players' scene was deleted");
      await shots.take(dm, "lp9-a-players-scene-delete");
    } finally {
      await dm.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
    }
  });

  test("sd-c. the last scene's Delete row is disabled", async () => {
    // The players' scene cannot be deleted while they are on it, so they move to the DM's scene, which is left at the end.
    const kept = sceneOf(dmSocket.state, dmSocket.you!.sceneId!)!;
    if (dmSocket.state?.meta.playerSceneId !== kept.id) {
      await openSideTab(dm, "Scenes");
      await dm.getByRole("button", { name: `Move players to ${kept.name}`, exact: true }).click();
      // A scene with fog or lighting off asks first.
      await waitFor("the players on the DM's scene", async () => {
        if (dmSocket.state?.meta.playerSceneId === kept.id) return true;
        const anyway = dm.getByRole("button", { name: "Move anyway", exact: true });
        if (await anyway.isVisible()) await anyway.click();
        return null;
      });
    }
    for (let guard = 0; Object.keys(dmSocket.state?.scenes ?? {}).length > 1 && guard < 30; guard++) {
      const count = Object.keys(dmSocket.state?.scenes ?? {}).length;
      const target = Object.values(dmSocket.state?.scenes ?? {}).find((s) => s && s.id !== dmSocket.you?.sceneId)!;
      const menu = await openMenu(target.name);
      await menu.getByRole("button", { name: /^Delete/ }).click();
      await menu.getByRole("button", { name: /^Tap again to delete/ }).click();
      await waitFor("a scene gone", () => (Object.keys(dmSocket.state?.scenes ?? {}).length < count ? true : null));
      await menu.waitFor({ state: "detached" });
    }
    const [last] = Object.values(dmSocket.state?.scenes ?? {});
    const menu = await openMenu(last!.name);
    const row = menu.getByRole("button", { name: /^Delete/ });
    assert.equal(await row.isDisabled(), true);
    await menu.getByText("The last scene cannot be deleted.").waitFor();
    await shots.take(dm, "sd-c-last-scene");
    await dm.keyboard.press("Escape");
  });

  test("8. no page logged an error or a warning", () => {
    for (const c of [dmConsole, playerConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
