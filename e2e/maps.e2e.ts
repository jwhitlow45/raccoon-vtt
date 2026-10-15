import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import type { BuildChunk, RoomState, Scene, Stamp } from "#shared/model.ts";
import { ConsoleWatch, dragWorld, Shots, SocketWatch, startServer, tapCell, waitFor, type Server } from "./harness.ts";

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
    await dm.getByRole("tab", { name: "Scenes" }).click();
    await dm.getByLabel("From a Universal VTT file").setInputFiles(file);
    const dialog = dm.getByRole("dialog", { name: "Import a Universal VTT map" });
    await dialog.getByText("11 × 9 squares, 500 × 400 pixels.").waitFor({ timeout: 30_000 });
    await dialog.getByText("27 walls (26 on the grid, 1 free), 1 door, 1 window, 1 light.").waitFor();
    assert.equal(await dialog.getByLabel("Scene name").inputValue(), UVTT.name);
    assert.equal(await dialog.getByLabel("Start under fog").isChecked(), true);
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
    await dm.getByLabel("Builder mode").selectOption("stamp");
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
    await dm.getByLabel("Builder mode").selectOption("stamp");
    await tapCell(dm, run.bounds, { x: 2, y: 2 });
    const bar = dm.getByRole("toolbar", { name: "Map builder options" });
    await bar.getByRole("button", { name: "DM only" }).click();
    await waitFor("the stamp to leave the player's state", () => (playerSocket.state?.stamps[run.stampId] ? null : true));
    await bar.getByRole("button", { name: "Duplicate" }).click();
    const hidden = await waitFor("the duplicate", () => stampsOf(dmSocket.state, run.sceneId).find((s) => s.id !== run.stampId));
    run.hiddenStampId = hidden.id;
    assert.equal(hidden.visibility, "dm");
    await bar.getByRole("button", { name: "Done" }).click();
    await dm.getByRole("button", { name: "Select", exact: true }).click();
    await dm.waitForTimeout(500);
    assert.equal(playerSocket.everSaw(run.hiddenStampId), false, "a DM-only stamp reached the player");
    assert.equal(Object.keys(playerSocket.state?.stamps ?? {}).length, 0);
    await shots.take(dm, "maps-dm-stamps");
  });

  test("7. the DM duplicates the scene, which the player never receives", async () => {
    const original = wallsOf(dmSocket.state, run.sceneId);
    const before = sceneOf(dmSocket.state, run.sceneId)!;
    await dm.getByRole("tab", { name: "Scenes" }).click();
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

  test("8. no page logged an error or a warning", () => {
    for (const c of [dmConsole, playerConsole]) {
      assert.deepEqual(c.errors, [], `${c.label} logged errors`);
      assert.deepEqual(c.warnings, [], `${c.label} logged warnings`);
    }
  });
});
