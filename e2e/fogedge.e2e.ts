import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, openSideTab, OpSocket, Shots, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * The fog's edge (fast lane FE): where the scene's edge falls inside a
 * device pixel, the fog frame past the scene and the fog image each cover
 * only part of that pixel, and two partial covers once let the map show
 * through as a hairline at some zooms (client/canvas/FogShape.tsx).
 *
 * A white map reaches well past a small scene. Each viewer's board is put
 * at several zooms and offsets off the pixel grid, at device pixel ratios
 * 1, 2 and 3, in Top-down and in Isometric at each turn, and the page's
 * pixels are read across every edge of the scene. A player's fully fogged
 * scene is the fog's color right across the edge. The DM's translucent fog
 * is one even tint there, no brighter line and no darker one. Revealed
 * ground reaches the edge in its soft edge's tint with at most a device
 * pixel more fog, and the frame still fogs all of the map past it. The
 * DM's Party sight veil, drawn the same way under the fog
 * (features/vision/SightOverlay.tsx), is one even tint across the edge in
 * Top-down too.
 *
 * It runs with `pnpm test:e2e` on its own port: E2E_PORT plus three, as
 * other files do, since the runs never overlap. The other environment
 * variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 3;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-fogedge-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script: it installs the hook that picks and turns the view (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

/** A scene small enough to show whole at every zoom below. */
const BOUNDS = { w: 8, h: 6 };
/** theme.color.fog, as a player sees it: opaque. */
const FOG: Rgb = [13, 13, 18];
const WHITE: Rgb = [255, 255, 255];
/** How much of the fog a viewer sees: all of it for a player, half for the DM (FogShape.tsx). */
const OPACITY: Record<"player" | "dm", number> = { player: 1, dm: 0.5 };
/** The tint of a revealed sub-cell that touches fog or the scene's edge (lib/fogTiles.ts fogPixels), as a byte. */
const SOFT_EDGE = Math.round(0.35 * 255) / 255;
/** The DM's Party sight over what the party cannot see (features/vision/sightRaster.ts VEIL_PALETTE), as a byte. */
const VEIL = Math.round(0.4 * 255) / 255;
/** Per channel. */
const TOLERANCE = 2;
/** Pixels per cell on the page, each with the fraction of a pixel the scene's middle sits off the pixel grid. */
const CAMERAS = [
  { scale: 23.37, fx: 0.37, fy: 0.13 },
  { scale: 31.81, fx: 0.71, fy: 0.29 },
  { scale: 40.13, fx: 0.5, fy: 0.83 },
  { scale: 47.66, fx: 0.13, fy: 0.61 },
] as const;
const RATIOS = [1, 2, 3] as const;
const ROLES = ["player", "dm"] as const;

type Rgb = [number, number, number];
type Role = (typeof ROLES)[number];
type View = "topDown" | "isometric";
type FogState = "fogged" | "revealed" | "veiled";

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const consoles: ConsoleWatch[] = [];

const run = { roomId: "", roomName: `E2E fog edge ${new Date().toISOString().slice(0, 19)}`, password: "", sceneId: "" };

/** Each case's worst miss, so one run names all of them, and the worst channel difference seen for each viewer, view and ratio. */
const misses: string[] = [];
const worst = new Map<string, number>();

async function join(context: BrowserContext, name: string, color: string): Promise<void> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
}

/** A white map 16 by 12 cells at 25 px a cell, its first grid line 4 cells in and 3 down, so it reaches past the scene on every side. */
async function uploadMap() {
  const data = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  const row = (await res.json()) as { id: string; width: number; height: number };
  return { assetId: row.id, widthPx: row.width, heightPx: row.height, cellPx: 25, originPx: { x: 100, y: 75 } };
}

/** A page of one viewer at one device pixel ratio, its board showing the map and the fog. */
async function openViewer(role: Role, ratio: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: ratio, storageState: await (role === "dm" ? dmContext : patContext).storageState() });
  await context.addInitScript(HOOK_FLAG);
  const page = await context.newPage();
  const watch = new ConsoleWatch(`${role}@${ratio}`);
  watch.attach(page);
  consoles.push(watch);
  await page.goto(`${server.origin}/r/${run.roomId}`);
  await page.locator(".konvajs-content").first().waitFor();
  await boardReady(page, "topDown");
  return { context, page };
}

/** Waits until the board on screen has drawn the map image and holds the fog. */
async function boardReady(page: Page, view: View): Promise<void> {
  await waitFor(`the ${view} board with its map and fog`, () =>
    page.evaluate((iso) => {
      type Node = { getAttr(name: string): unknown; image?: () => unknown };
      type Stage = { width(): number; visible(): boolean; listening(): boolean; find(selector: string | ((n: Node) => boolean)): Node[] };
      const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
      const shown = konva?.stages.filter((s) => s.width() > 0 && s.visible()) ?? [];
      // Isometric's ground stage, which holds the map and the fog, never listens.
      const stage = iso ? shown.find((s) => !s.listening()) : shown.length === 1 ? shown[0] : undefined;
      if (!stage) return null;
      const fog = stage.find((n) => n.getAttr("fogVersion") !== undefined).length > 0;
      const map = stage.find("Image").some((n) => Boolean(n.image?.()));
      return fog && map ? true : null;
    }, view === "isometric"),
  );
}

/** Picks Isometric at a turn through the test hook, as the View menu does, and waits for its board. */
async function isoAt(page: Page, turn: number): Promise<void> {
  await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate((t) => {
    const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
    hook.pick("isometric");
    hook.turn(t);
  }, turn);
  await boardReady(page, "isometric");
}

/**
 * The fog shape's transform to the page, as Konva's absolute transform
 * gives it: cells to CSS px, plus the stage's place on the page. And the
 * board canvas's pixels to a CSS px, at most 2 (features/device/settings.ts
 * pixelRatioFor), so at a ratio of 3 the page scales the canvas up.
 */
type Placement = { m: number[]; left: number; top: number; canvasRatio: number };

/**
 * Puts every stage on screen at `scale`, with the scene's middle at the
 * board's middle off the pixel grid by the camera's fractions, and draws
 * at once. Set straight on Konva's stages, as a pinch or a wheel leaves
 * them, so any zoom and offset can be had exactly.
 */
async function placeBoard(page: Page, cam: (typeof CAMERAS)[number]): Promise<Placement> {
  return page.evaluate(
    ([c, w, h]) => {
      type Transform = { point(p: { x: number; y: number }): { x: number; y: number }; m: number[] };
      type Node = { getAttr(name: string): unknown; getAbsoluteTransform(): Transform };
      type Stage = {
        width(): number;
        height(): number;
        visible(): boolean;
        find(f: (n: Node) => boolean): Node[];
        position(p: { x: number; y: number }): void;
        scale(p: { x: number; y: number }): void;
        draw(): void;
        container(): { getBoundingClientRect(): { left: number; top: number } };
        getLayers(): { getCanvas(): { getPixelRatio(): number } }[];
      };
      const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
      const shown = konva.stages.filter((s) => s.width() > 0 && s.visible());
      const isFog = (n: Node) => n.getAttr("fogVersion") !== undefined;
      const holder = shown.find((s) => s.find(isFog).length > 0);
      if (!holder) throw new Error("no fog on screen");
      const fog = holder.find(isFog)[0]!;
      for (const s of shown) {
        s.position({ x: 0, y: 0 });
        s.scale({ x: c.scale, y: c.scale });
      }
      const mid = fog.getAbsoluteTransform().point({ x: w / 2, y: h / 2 });
      const box = holder.container().getBoundingClientRect();
      const at = { x: Math.round(holder.width() / 2 - mid.x) + c.fx, y: Math.round(holder.height() / 2 - mid.y) + c.fy };
      for (const s of shown) {
        s.position(at);
        s.draw();
      }
      return { m: [...fog.getAbsoluteTransform().m], left: box.left, top: box.top, canvasRatio: holder.getLayers()[0]!.getCanvas().getPixelRatio() };
    },
    [cam, BOUNDS.w, BOUNDS.h] as const,
  );
}

function toPage(p: Placement, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = p.m as [number, number, number, number, number, number];
  return { x: p.left + a * x + c * y + e, y: p.top + b * x + d * y + f };
}

/** Each edge of the scene, from one corner to the next, and the way into the scene from it, in cells. */
const EDGES = [
  { name: "west", from: [0, 0], to: [0, BOUNDS.h], inward: [1, 0] },
  { name: "east", from: [BOUNDS.w, 0], to: [BOUNDS.w, BOUNDS.h], inward: [-1, 0] },
  { name: "north", from: [0, 0], to: [BOUNDS.w, 0], inward: [0, 1] },
  { name: "south", from: [0, BOUNDS.h], to: [BOUNDS.w, BOUNDS.h], inward: [0, -1] },
] as const;

type Shot = { data: Buffer; width: number; height: number; x0: number; y0: number; ratio: number };

/** The page's pixels over the whole scene and a margin, in device pixels. */
async function grab(page: Page, placement: Placement, ratio: number): Promise<Shot> {
  const corners = [toPage(placement, 0, 0), toPage(placement, BOUNDS.w, 0), toPage(placement, 0, BOUNDS.h), toPage(placement, BOUNDS.w, BOUNDS.h)];
  const x0 = Math.floor(Math.min(...corners.map((p) => p.x))) - 16;
  const y0 = Math.floor(Math.min(...corners.map((p) => p.y))) - 16;
  const x1 = Math.ceil(Math.max(...corners.map((p) => p.x))) + 16;
  const y1 = Math.ceil(Math.max(...corners.map((p) => p.y))) + 16;
  const png = await page.screenshot({ clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, scale: "device" });
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, x0, y0, ratio };
}

function pixel(shot: Shot, ix: number, iy: number): Rgb {
  const i = (iy * shot.width + ix) * 4;
  return [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
}

function diff(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** `top` at `alpha` over `under`. */
function over(under: Rgb, top: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(under[i]! + (top[i]! - under[i]!) * alpha)) as Rgb;
}

/** The white map seen through the fog at `alpha`, as the page composites it. */
function through(alpha: number): Rgb {
  return over(WHITE, FOG, alpha);
}

/** Three places along each edge, in cells and on the page. */
function samples(placement: Placement): { edge: (typeof EDGES)[number]; t: number; cell: { x: number; y: number }; page: { x: number; y: number } }[] {
  return EDGES.flatMap((edge) =>
    [0.3, 0.5, 0.7].map((t) => {
      const cell = { x: edge.from[0] + (edge.to[0] - edge.from[0]) * t, y: edge.from[1] + (edge.to[1] - edge.from[1]) * t };
      return { edge, t, cell, page: toPage(placement, cell.x, cell.y) };
    }),
  );
}

/** Fails when anything but the board's canvas lies over a place the pixels are read at, such as a bar or a panel. */
async function assertOnCanvas(page: Page, placement: Placement, label: string): Promise<void> {
  const points = samples(placement).map((s) => [s.page.x, s.page.y] as const);
  const covered = await page.evaluate(
    (at) =>
      at
        .map(([x, y]) => [x, y, (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { tagName: string } | null } }).document.elementFromPoint(x, y)?.tagName ?? "nothing"] as const)
        .filter(([, , tag]) => tag !== "CANVAS"),
    points,
  );
  assert.deepEqual(covered, [], `${label}: something other than the board lies over the edge`);
}

/**
 * Reads the pixels across each edge at three places along it, and records
 * a miss for each place whose worst pixel is off by more than TOLERANCE.
 * A pixel is judged by where its square lies: outside the scene, inside
 * it, or across the edge. Fogged or veiled, every pixel is the fog, over
 * the veil where there is one. Revealed, every
 * pixel reaching past the edge is the fog, so not a sliver of the map
 * there shows, and the inside past one pixel of the board's canvas is at
 * least as light as the revealed ground's soft edge.
 *
 * Where the page scales the canvas up, it blends each of the canvas's
 * pixels into the next, so a canvas pixel's width is kept clear on each
 * side of the edge before a pixel is judged as outside or inside.
 */
function checkEdges(shot: Shot, placement: Placement, label: string, role: Role, state: FogState): void {
  const r = shot.ratio;
  const dev = (p: { x: number; y: number }) => ({ x: (p.x - shot.x0) * r, y: (p.y - shot.y0) * r });
  // Veiled, the DM's fog lies over Party sight's veil, which lies over the map.
  const fog = state === "veiled" ? over(over(WHITE, [0, 0, 0], VEIL), FOG, OPACITY[role]) : through(OPACITY[role]);
  const soft = through(OPACITY[role] * SOFT_EDGE);
  // The page's pixels to one of the canvas's, and how far the page's scaling spreads one.
  const canvasPx = r / placement.canvasRatio;
  const blur = canvasPx > 1 ? canvasPx : 0;
  for (const { edge, t, cell, page } of samples(placement)) {
    const a = dev(toPage(placement, edge.from[0], edge.from[1]));
    const b = dev(toPage(placement, edge.to[0], edge.to[1]));
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const along = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const s = dev(page);
    const inPoint = dev(toPage(placement, cell.x + edge.inward[0] * 0.01, cell.y + edge.inward[1] * 0.01));
    let n = { x: -along.y, y: along.x };
    if (n.x * (inPoint.x - s.x) + n.y * (inPoint.y - s.y) < 0) n = { x: -n.x, y: -n.y };
    // How far a pixel's square reaches along the normal either side of its center.
    const reach = (Math.abs(n.x) + Math.abs(n.y)) / 2;
    let bad = { by: 0, what: "" };
    for (let iy = Math.floor(s.y) - 8; iy <= Math.floor(s.y) + 8; iy++) {
      for (let ix = Math.floor(s.x) - 8; ix <= Math.floor(s.x) + 8; ix++) {
        if (ix < 0 || iy < 0 || ix >= shot.width || iy >= shot.height) continue;
        const c = { x: ix + 0.5 - s.x, y: iy + 0.5 - s.y };
        const d = c.x * n.x + c.y * n.y;
        if (Math.abs(c.x * along.x + c.y * along.y) > 3 || Math.abs(d) > 6) continue;
        const got = pixel(shot, ix, iy);
        let by = 0;
        let want = "";
        // Shown one to one, a pixel any part of which lies past the edge is the fog, unless it also reaches a canvas pixel in, where Isometric's frame ends.
        const outside = blur === 0 ? d - reach < 0 && d + reach <= canvasPx : d + reach <= -blur;
        if (state !== "revealed" || outside) {
          by = diff(got, fog);
          want = fog.join(",");
        } else if (d - reach >= canvasPx + blur) {
          // Lighter is fine: the soft edge gives way to the clear map a quarter cell in.
          by = Math.max(0, ...soft.map((v, i) => v - got[i]!));
          want = `at least ${soft.join(",")}`;
        }
        if (by > bad.by) bad = { by, what: `pixel ${ix},${iy} (${d.toFixed(2)} px in) got ${got.join(",")} want ${want}` };
      }
    }
    const key = `${state} ${label.split(",").slice(0, 3).join(",")}`;
    worst.set(key, Math.max(worst.get(key) ?? 0, bad.by));
    if (bad.by > TOLERANCE) misses.push(`${label}, ${edge.name} edge at ${t}: ${bad.what}`);
  }
}

/** Every viewer, ratio, view and camera over the scene as it stands, each edge checked. */
async function sweep(state: FogState): Promise<void> {
  misses.length = 0;
  for (const role of ROLES) {
    for (const ratio of RATIOS) {
      const { context, page } = await openViewer(role, ratio);
      try {
        for (const view of ["topDown", "isometric"] as const) {
          for (const [i, cam] of CAMERAS.entries()) {
            // Each camera in Isometric at its own turn, so the four turns are all read.
            if (view === "isometric") await isoAt(page, i);
            const label = `${role}, ${view}${view === "isometric" ? ` turn ${i}` : ""}, ratio ${ratio}, ${cam.scale} px a cell`;
            const placement = await placeBoard(page, cam);
            await assertOnCanvas(page, placement, label);
            checkEdges(await grab(page, placement, ratio), placement, label, role, state);
            if (i === 0 && ratio === 2) await shots.take(page, `fogedge-${state}-${role}-${view}-ratio-2`);
          }
        }
      } finally {
        await context.close();
      }
    }
  }
}

/**
 * The DM's Party sight on a scene with party vision and no party, so the
 * veil lies over all of it, under the DM's fog: Top-down at every ratio
 * and camera. Isometric keeps the veil's frame and image meeting at the
 * edge itself (SightOverlay.tsx), where a line a few levels lighter stays
 * under the DM's fog, so it is not read here.
 */
async function sweepVeiled(): Promise<void> {
  misses.length = 0;
  for (const ratio of RATIOS) {
    const { context, page } = await openViewer("dm", ratio);
    try {
      await openSideTab(page, "DM");
      await page.getByRole("switch", { name: /^Party sight/ }).click();
      await waitFor("the veil on the board", () =>
        page.evaluate(() => {
          type Stage = { width(): number; visible(): boolean; find(f: (n: { getAttr(name: string): unknown }) => boolean): unknown[] };
          const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
          return konva.stages.some((s) => s.width() > 0 && s.visible() && s.find((n) => n.getAttr("sightVersion") !== undefined).length > 0) || null;
        }),
      );
      for (const cam of CAMERAS) {
        const label = `dm, topDown, ratio ${ratio}, ${cam.scale} px a cell, Party sight`;
        const placement = await placeBoard(page, cam);
        await assertOnCanvas(page, placement, label);
        checkEdges(await grab(page, placement, ratio), placement, label, "dm", "veiled");
      }
      if (ratio === 2) await shots.take(page, "fogedge-veiled-dm-topDown-ratio-2");
    } finally {
      await context.close();
    }
  }
}

function report(state: FogState): void {
  const lines = [...worst].filter(([k]) => k.startsWith(state)).map(([k, v]) => `${k}: ${v}`);
  console.error(`worst channel difference at the edge, ${state}:\n  ${lines.join("\n  ")}`);
}

describe("raccoon-vtt the fog's edge", { timeout: 600_000 }, () => {
  before(async () => {
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  });

  after(async () => {
    if (process.env.E2E_DEBUG === "1") console.error(server?.output().split("\n").slice(-40).join("\n"));
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

  test("FE-1. a DM's room whose scene is 8 by 6 squares of a white map that reaches past it, fog on, no grid, and Pat", async () => {
    const dm = await dmContext.newPage();
    await dmSocket.attach(dmContext, dm);
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
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { bounds: BOUNDS, fogEnabled: true, grid: { show: false, color: "#000000", opacity: 1, lineWidth: 1 } } });
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: await uploadMap() });
    await dm.close();
    await join(patContext, "Pat", "#30a46c");
  });

  test("FE-2. a fully fogged scene: every pixel across its edge is the fog's color for Pat, and the DM's one even tint, at every zoom, ratio and view", async () => {
    await sweep("fogged");
    report("fogged");
    assert.deepEqual(misses, []);
  });

  test("FE-3. the scene revealed: its map reaches the edge with at most a device pixel of fog, and the map past the edge stays fogged", async () => {
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [{ id: randomUUID(), mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: BOUNDS.w, h: BOUNDS.h } }] });
    await sweep("revealed");
    report("revealed");
    assert.deepEqual(misses, []);
  });

  test("FE-4. party vision with the DM's Party sight on and the scene fogged again: the veil under the DM's fog is one even tint across the edge in Top-down", async () => {
    await ops.send({ t: "fog.live", sceneId: run.sceneId, ops: [{ id: randomUUID(), mode: "hide", shape: { kind: "rect", x: 0, y: 0, w: BOUNDS.w, h: BOUNDS.h } }] });
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { vision: { on: true, light: "dark" } } });
    await sweepVeiled();
    report("veiled");
    assert.deepEqual(misses, []);
  });

  test("FE-5. no page logged an error", () => {
    for (const c of consoles) assert.deepEqual(c.errors, [], `${c.label} logged errors`);
  });
});
