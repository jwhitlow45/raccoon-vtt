import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { uuidv7 } from "#shared/ids.ts";
import { ConsoleWatch, OpSocket, Shots, SocketWatch, sleep, startServer, waitFor, type Server } from "./harness.ts";
import { depth, K, type Turn } from "../client/lib/view.ts";

/**
 * The floors below in Isometric (docs/design/design-v1-floors.md phase 4,
 * 9.1): each opening's hole on the floor shown draws as a drop, its
 * squares lowered by the drop so the relief draws a pit's sides, and its
 * bottom a copy of what the ground stage draws over the hole, the window
 * onto the floor below. A player without the floor below gets a black
 * bottom 10 ft down. Read off the board's own canvases: the relief's pixel
 * where the bottom shows against the ground stage's where the hole lies at
 * 0. Dana the DM is at a desk and Ana plays on a phone. Tower has Upper
 * floor 10 ft over Ground floor (the players' start) over Cellar, whose
 * ground under its end lies 10 ft down. Labels carry the prefix FL4I.
 * - fl4i-0: the room, its floors with a map each, an opening from Upper
 *   floor down to Ground floor and one from Ground floor down to Cellar.
 * - fl4i-1: the DM's Upper floor in Isometric at every turn: the hole's
 *   bottom 10 ft down copies the ground stage, under no shade, its far
 *   side stands, and the floor around it draws nothing on the relief.
 * - fl4i-2: Ana's Ground floor in Isometric over Cellar, which she has not
 *   reached: a black bottom 10 ft down.
 * - fl4i-3: the DM shows Ana Cellar: her bottom drops to its real 20 ft
 *   and copies the ground stage.
 * - fl4i-4: no page logged an error.
 *
 * It runs with `pnpm test:e2e` on E2E_PORT plus seventy-four, one file
 * after another. The other environment variables are the smoke run's
 * (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 74;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-floors-iso-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script, as only a test or the bench sets it: it installs the view hook (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const BOUNDS = { w: 20, h: 12 };
const CELL_PX = 40;
/** The hole on Upper floor down to Ground floor, and the one on Ground floor down to Cellar: each 8 by 8, apart on Ground floor. */
const UPPER_HOLE = { x: 11, y: 2, w: 8, h: 8 };
const GROUND_HOLE = { x: 1, y: 2, w: 8, h: 8 };
const FEET_PER_CELL = 5;
const TURNS: readonly Turn[] = [0, 1, 2, 3];

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let anaContext: BrowserContext;
let dm: Page;
let ana: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const anaSocket = new SocketWatch("ana");
const consoles = { dm: new ConsoleWatch("dm"), ana: new ConsoleWatch("ana") };

const run = {
  roomId: "",
  roomName: `E2E floors iso ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  ground: "",
  upper: uuidv7(),
  cellar: uuidv7(),
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

/**
 * A map of the room's with a color of its own in every square, so a copy
 * from the wrong square reads another color: red and green by column and
 * row, blue by floor. Each square's middle is one color, clear of the grid.
 */
async function uploadMap(blue: number): Promise<{ assetId: string; widthPx: number; heightPx: number; cellPx: number; originPx: { x: number; y: number } }> {
  const width = BOUNDS.w * CELL_PX;
  const height = BOUNDS.h * CELL_PX;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = 40 + 10 * Math.floor(x / CELL_PX);
      raw[i + 1] = 40 + 15 * Math.floor(y / CELL_PX);
      raw[i + 2] = blue;
    }
  }
  const data = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the map upload answered ${res.status()}`);
  const row = (await res.json()) as { id: string; width: number; height: number };
  return { assetId: row.id, widthPx: row.width, heightPx: row.height, cellPx: CELL_PX, originPx: { x: 0, y: 0 } };
}

/** Picks Isometric at a turn, as the View menu does (relief/isoTest.ts), and waits for the board's relief. */
async function isoOn(page: Page, turn: Turn): Promise<void> {
  await waitFor("the view hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate((t) => {
    const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
    hook.pick("isometric");
    hook.turn(t);
  }, turn);
  await waitFor(`isometric ${turn}`, async () => ((await page.getByRole("button", { name: "View: Isometric" }).count()) > 0 ? true : null));
}

/** The floor a page shows, by its Floor button's name, pressing the floor keys until it is the one asked for. */
async function showFloor(page: Page, floor: string, key: "[" | "]"): Promise<void> {
  const shown = async () => ((await page.locator('[data-floors="button"]').first().getAttribute("aria-label").catch(() => null)) ?? "").startsWith(`Floor: ${floor}.`);
  for (let i = 0; i < 4 && !(await shown()); i++) {
    await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
    await page.keyboard.press(key);
    await sleep(400);
  }
  await waitFor(`${floor} shown`, async () => ((await shown()) ? true : null));
}

type Rgba = [number, number, number, number];

/**
 * The relief's and the ground stage's pixels where each world point, at
 * its height in cells, shows on the page: the isometric board's two
 * stages (relief/IsoBoard.tsx), read off their canvases as drawn.
 */
function boardPixels(page: Page, points: readonly { x: number; y: number; z: number }[]): Promise<{ relief: Rgba; ground: Rgba }[]> {
  return page.evaluate(
    ([points, k]) => {
      type Canvas = { width: number; height: number; getContext(k: "2d"): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null };
      type Layer = { getCanvas(): { _canvas: Canvas; getPixelRatio(): number } };
      type Node = { getChildren(): Node[]; getAbsoluteTransform(): { point(p: { x: number; y: number }): { x: number; y: number } } };
      type Stage = Node & { width(): number; listening(): boolean; scaleY(): number; getLayers(): (Layer & Node)[] };
      const stages = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.filter((s) => s.width() > 0);
      // The main stage listens and holds the relief, the drag layer and the overlay. The ground stage never listens.
      const main = stages.find((s) => s.listening() && s.getLayers().length === 3);
      const groundStage = stages.find((s) => !s.listening() && s.getLayers().length === 1);
      if (!main || !groundStage) throw new Error("no isometric board on screen");
      const plane = main.getLayers()[0]!.getChildren()[0]!.getChildren()[0]!;
      const read = (layer: Layer, x: number, y: number): [number, number, number, number] => {
        const c = layer.getCanvas();
        const r = c.getPixelRatio();
        const d = c._canvas.getContext("2d")!.getImageData(Math.round(x * r), Math.round(y * r), 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]!];
      };
      return points.map((p) => {
        const at = plane.getAbsoluteTransform().point({ x: p.x, y: p.y });
        // A height lifts a point K view units a cell, which the stage scales to pixels.
        const lifted = { x: at.x, y: at.y - k * p.z * main.scaleY() };
        return { relief: read(main.getLayers()[0]!, lifted.x, lifted.y), ground: read(groundStage.getLayers()[0]!, at.x, at.y) };
      });
    },
    [points, K] as const,
  );
}

const near = (a: Rgba, b: Rgba, by = 3) => a.every((v, i) => Math.abs(v - b[i]!) <= by);
const show = (c: Rgba) => `rgba(${c.join(", ")})`;

/**
 * A point `by` cells in from a hole's far corner at a turn on both axes. A
 * cell and a half in is a square's middle whose bottom, at a depth of up
 * to four cells, still shows inside the hole's rim, which clips a pit's
 * drawing (relief/drawRelief.ts drawPits). Each cell of height down moves
 * where a point shows by about 1.22 cells toward the viewer.
 */
function inFromFar(rect: { x: number; y: number; w: number; h: number }, turn: Turn, by = 1.5): { x: number; y: number } {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x, y: rect.y + rect.h },
    { x: rect.x + rect.w, y: rect.y + rect.h },
  ];
  const far = corners.reduce((a, b) => (depth(turn, b.x, b.y) < depth(turn, a.x, a.y) ? b : a));
  return { x: far.x + (far.x === rect.x ? by : -by), y: far.y + (far.y === rect.y ? by : -by) };
}

/**
 * Waits until the hole's bottom shows `depth` cells down at a point: the
 * relief there opaque and `want` of the ground stage where the point lies
 * at 0 ("copy"), or black ("black"). A copy is of a map, never black here:
 * over a floor the page does not hold yet, the ground stage and the bottom
 * are both black, so a black copy is the state before the floor arrives.
 */
async function bottomShows(page: Page, at: { x: number; y: number }, cells: number, want: "copy" | "black", what: string): Promise<{ relief: Rgba; ground: Rgba }> {
  let last: { relief: Rgba; ground: Rgba } | undefined;
  try {
    return await waitFor(what, async () => {
      [last] = await boardPixels(page, [{ ...at, z: -cells }]);
      const { relief, ground } = last!;
      if (relief[3] !== 255) return null;
      if (want === "black") return near(relief, [0, 0, 0, 255]) ? last! : null;
      return near(relief, ground) && ground[3] === 255 && !near(ground, [0, 0, 0, 255], 12) ? last! : null;
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}: the relief read ${last ? show(last.relief) : "nothing"}, the ground ${last ? show(last.ground) : "nothing"}`);
  }
}

describe("the floors below in Isometric", { concurrency: false, timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: DESK });
    anaContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await dmContext.addInitScript(HOOK_FLAG);
    await anaContext.addInitScript(HOOK_FLAG);
    dm = await dmContext.newPage();
    ana = await anaContext.newPage();
    consoles.dm.attach(dm);
    consoles.ana.attach(ana);
    await dmSocket.attach(dmContext, dm);
    await anaSocket.attach(anaContext, ana);
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

  test("fl4i-0. Tower's three floors with a map each, a hole from Upper floor down to Ground floor and one from Ground floor down to Cellar", async () => {
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
    await join(anaContext, "Ana", "#30a46c");

    // Fog off, so the hole and the window draw what lies there without the party exploring it first.
    await ops.send({ t: "scene.update", sceneId: run.ground, patch: { name: "Tower", bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.upper, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "above", besideName: "Ground floor", name: "Upper floor" } });
    await ops.send({ t: "scene.create", scene: { id: run.cellar, name: "Tower", bounds: BOUNDS }, floor: { beside: run.ground, side: "below", name: "Cellar" } });
    for (const [sceneId, blue] of [
      [run.upper, 200],
      [run.ground, 120],
      [run.cellar, 40],
    ] as const) {
      await ops.send({ t: "scene.update", sceneId, patch: { fogEnabled: false } });
      await ops.send({ t: "scene.setMap", sceneId, map: await uploadMap(blue) });
    }
    // Cellar's ground under its end lies 10 ft down, so the drop there is 20 ft.
    const cellarCells: string[] = [];
    for (let y = GROUND_HOLE.y; y < GROUND_HOLE.y + GROUND_HOLE.h; y++) for (let x = GROUND_HOLE.x; x < GROUND_HOLE.x + GROUND_HOLE.w; x++) cellarCells.push(`${x},${y}`);
    await ops.send({ t: "build.height", sceneId: run.cellar, cells: cellarCells, height: -10 });
    await ops.send({ t: "floorLink.put", link: { id: uuidv7(), pairId: uuidv7(), sceneId: run.upper, to: run.ground, rect: UPPER_HOLE, kind: "opening" } });
    await ops.send({ t: "floorLink.put", link: { id: uuidv7(), pairId: uuidv7(), sceneId: run.ground, to: run.cellar, rect: GROUND_HOLE, kind: "opening" } });
    await waitFor("four ends of two openings", () => (Object.values(dmSocket.state?.floorLinks ?? {}).filter((l) => l?.kind === "opening").length === 4 ? true : null));
    await openRoom(ana, consoles.ana, anaSocket);
  });

  test("fl4i-1. the DM's Upper floor in Isometric at every turn: the hole's bottom 10 ft down copies the ground stage under no shade, its far side stands, and the floor around draws nothing on the relief", async () => {
    await showFloor(dm, "Upper floor", "]");
    for (const turn of TURNS) {
      await isoOn(dm, turn);
      const at = inFromFar(UPPER_HOLE, turn);
      // Each square's own color: a bottom a cell higher or lower would copy the square beside this one.
      await bottomShows(dm, at, 2, "copy", `the hole's bottom 2 cells down at turn ${turn}`);
      // Where the point lies at 0 the hole's far sides show, which a flat floor never draws on the relief. The point itself stands in front of the far corner, on the seam where the two far sides meet, whose pixel each side covers only in part on some renderers (CI's read alpha 232). Half a cell along x puts it a quarter cell across the screen onto one side, clear of the seam and of a square's edge.
      const [flat, beside] = await boardPixels(dm, [
        { x: at.x + 0.5, y: at.y, z: 0 },
        { x: UPPER_HOLE.x - 3.5, y: UPPER_HOLE.y + 3.5, z: 0 },
      ]);
      assert.ok(flat!.relief[3] === 255 && !near(flat!.relief, flat!.ground), `turn ${turn}: the far side stands, read ${show(flat!.relief)} over ${show(flat!.ground)}`);
      assert.equal(beside!.relief[3], 0, `turn ${turn}: the flat floor beside it draws nothing on the relief, read ${show(beside!.relief)}`);
      await shots.take(dm, `fl4i-1-dm-upper-hole-turn-${turn}`);
    }
  });

  test("fl4i-2. Ana's Ground floor in Isometric over Cellar, which she has not reached: a black bottom 10 ft down", async () => {
    await isoOn(ana, 0);
    // Half a cell in from the far corner the bottom shows 2 cells down, and 1.2 cells down the far side above it: so the bottom lies 2 cells down, not Cellar's 4.
    const at = inFromFar(GROUND_HOLE, 0, 0.5);
    await bottomShows(ana, at, 2, "black", "a black bottom 2 cells down");
    // A quarter cell across the screen from the seam where the two far sides meet, as fl4i-1 reads, onto the lit one.
    const [side] = await boardPixels(ana, [{ x: at.x - 0.25, y: at.y + 0.25, z: -1.2 }]);
    assert.ok(side!.relief[3] === 255 && !near(side!.relief, [0, 0, 0, 255], 12), `the far side above the bottom, read ${show(side!.relief)}`);
    await shots.take(ana, "fl4i-2-ana-hole-unreached");
  });

  test("fl4i-3. the DM shows Ana Cellar: her bottom drops to its 20 ft and copies the ground stage, and the black is gone", async () => {
    await ops.send({ t: "floor.open", sceneId: run.cellar, open: true });
    const at = inFromFar(GROUND_HOLE, 0);
    await bottomShows(ana, at, 4, "copy", "the bottom 4 cells down once Cellar is held");
    const [shallow] = await boardPixels(ana, [{ ...at, z: -2 }]);
    assert.ok(!near(shallow!.relief, [0, 0, 0, 255]), `no black bottom at 2 cells, read ${show(shallow!.relief)}`);
    await shots.take(ana, "fl4i-3-ana-hole-cellar-held");
    // The DM's hole on Ground floor is as deep.
    await showFloor(dm, "Ground floor", "[");
    await isoOn(dm, 0);
    await bottomShows(dm, at, 4, "copy", "the DM's bottom 4 cells down");
    await shots.take(dm, "fl4i-3-dm-ground-hole");
  });

  test("fl4i-4. no page logged an error", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
