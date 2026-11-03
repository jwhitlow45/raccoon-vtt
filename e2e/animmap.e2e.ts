import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import { ConsoleWatch, OpSocket, ROOT, Shots, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Animated maps (docs/design/design-v1-animated-maps.md): a WebM or MP4 on
 * a map's rectangle, drawn by the board's map layer in the still's place.
 * Lane AM-C's steps (am-2 to am-8 and am-12) drive playback on the board,
 * Still, Low power and reduced motion, and the table display. Lane AM-D's
 * (am-1 and am-9 to am-11) drive the DM's upload, the refusals, the Library
 * and Use the still only. Maps are set through the DM's socket where a
 * step does not test the upload form.
 *
 * The board is read through its test hooks (features/animmap/board.ts):
 * the host over the board, `[data-animmap-board]`, holds `data-animmap`
 * ("playing", "paused", "loading", "waiting", "none" or "still <reason>",
 * set on change) and the `animMapDraws` and `animMapCameraDraws`
 * properties, video draws and camera draws of the map layer counted
 * apart. The one `<video>` is `video[data-animmap-video]`.
 *
 * The fixtures are e2e/fixtures/map-loop.webm (VP9) and map-loop.mp4
 * (H.264), 640 by 360 and 2 s long, made by the script the folder's README
 * names. The browser is Chrome, which plays both.
 *
 * It runs with `pnpm test:e2e` on its own port, E2E_PORT plus 44, with the
 * server's ANIMATED_MAPS switch on. am-12 starts a second server with the
 * switch off, on E2E_PORT plus 45. The other environment variables are the
 * smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 44;
const OFF_PORT = Number(process.env.E2E_PORT ?? 3100) + 45;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-animmap-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script: it installs the hook that picks and turns the view without the menu (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";
const BOUNDS = { w: 32, h: 18 };
const TV = { width: 1280, height: 720 };
const FIXTURES = path.join(ROOT, "e2e", "fixtures");
export const WEBM = path.join(FIXTURES, "map-loop.webm");
export const MP4 = path.join(FIXTURES, "map-loop.mp4");

let server: Server;
let browser: Browser;
let dmContext: BrowserContext;
let patContext: BrowserContext;
let dm: Page;
let pat: Page;
let ops: OpSocket;
const dmSocket = new SocketWatch("dm");
const patSocket = new SocketWatch("pat");
const consoles = { dm: new ConsoleWatch("dm"), pat: new ConsoleWatch("pat"), tv: new ConsoleWatch("tv") };

const run = {
  roomId: "",
  roomName: `E2E animated maps ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  cryptId: randomUUID(),
  patId: "",
  /** The WebM's asset row and its still, uploaded in am-0. */
  webm: null as VideoRow | null,
  webmStill: null as StillRow | null,
};

type VideoRow = { id: string; width: number; height: number; created?: boolean; video?: Record<string, unknown> };
type StillRow = { id: string; width: number; height: number };

/** A fixture uploaded as a video of the room's, through the asset route. */
async function uploadVideo(file: string, context: BrowserContext = dmContext, origin = server.origin, roomId = run.roomId): Promise<VideoRow> {
  const type = file.endsWith(".mp4") ? "video/mp4" : "video/webm";
  const res = await context.request.put(`${origin}/api/rooms/${roomId}/assets?kind=video`, { headers: { Origin: origin, "content-type": type, "x-name": path.basename(file) }, data: readFileSync(file) });
  assert.ok(res.ok(), `the video upload answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as VideoRow;
}

/**
 * A still for a fixture: a plain image of the video's shape, as the DM's
 * device would make from its first frame. Its color is one the fixture's
 * pattern never shows, so a screenshot tells the still from the video.
 */
async function uploadStill(widthPx: number, heightPx: number, context: BrowserContext = dmContext, origin = server.origin, roomId = run.roomId): Promise<StillRow> {
  const data = await sharp({ create: { width: widthPx, height: heightPx, channels: 3, background: STILL_COLOR } }).png().toBuffer();
  const res = await context.request.put(`${origin}/api/rooms/${roomId}/assets?kind=map`, { headers: { Origin: origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the still upload answered ${res.status()}`);
  return (await res.json()) as StillRow;
}

/** The still's one color: a muted violet the test pattern never draws. */
const STILL_COLOR = { r: 96, g: 64, b: 128 };

/**
 * A scene's map with its video, as the client sends it: the video's id with
 * placeholder facts, which the server overwrites from the asset row
 * (design 9.2). The still's cell size spreads the map over the scene's
 * bounds.
 */
function videoMap(still: StillRow, video: VideoRow) {
  return {
    assetId: still.id,
    widthPx: still.width,
    heightPx: still.height,
    cellPx: still.width / BOUNDS.w,
    originPx: { x: 0, y: 0 },
    video: { assetId: video.id, widthPx: 0, heightPx: 0, container: "webm", video: "", fps: 0, durationMs: 0, kbps: 0 },
  };
}

/** What a page's board says about its video: the room's own board, or the one in View as a player. */
type BoardProbe = { state: string; draws: number; cameraDraws: number; videos: number; withSrc: number };

function probe(page: Page, where: "room" | "preview" = "room"): Promise<BoardProbe | null> {
  return page.evaluate((inPreview) => {
    type Host = { dataset: Record<string, string | undefined>; closest(s: string): unknown; animMapDraws?: number; animMapCameraDraws?: number };
    type Video = { hasAttribute(name: string): boolean };
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<unknown> } }).document;
    const hosts = Array.from(doc.querySelectorAll("[data-animmap-board]")) as Host[];
    const host = hosts.find((h) => Boolean(h.closest("dialog[aria-label^='Viewing as']")) === inPreview);
    const videos = Array.from(doc.querySelectorAll("video")) as Video[];
    if (!host) return null;
    return {
      state: host.dataset.animmap ?? "",
      draws: host.animMapDraws ?? 0,
      cameraDraws: host.animMapCameraDraws ?? 0,
      videos: videos.length,
      withSrc: videos.filter((v) => v.hasAttribute("src")).length,
    };
  }, where === "preview");
}

async function boardSays(page: Page, state: string | RegExp, where: "room" | "preview" = "room"): Promise<BoardProbe> {
  return waitFor(`the board to say ${String(state)}`, async () => {
    const p = await probe(page, where);
    if (!p) return null;
    return (typeof state === "string" ? p.state === state : state.test(p.state)) ? p : null;
  });
}

/** Video draws and camera draws over `ms`. */
async function drawsOver(page: Page, ms: number, where: "room" | "preview" = "room"): Promise<{ draws: number; cameraDraws: number }> {
  const a = await probe(page, where);
  await sleep(ms);
  const b = await probe(page, where);
  assert.ok(a && b, "a board through the count");
  return { draws: b.draws - a.draws, cameraDraws: b.cameraDraws - a.cameraDraws };
}

async function viewAs(page: Page, view: "topDown" | "isometric"): Promise<void> {
  await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate((v) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(v), view);
  await sleep(400);
}

async function join(context: BrowserContext, name: string, color: string, origin = server.origin, roomId = run.roomId, password = run.password): Promise<string> {
  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await context.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

/** Makes a room through the home page, as a DM does, and returns its id, its player password and the DM's ops socket. */
async function createRoom(page: Page, context: BrowserContext, origin: string, name: string): Promise<{ roomId: string; password: string; ops: OpSocket }> {
  await page.goto(`${origin}/`);
  await page.getByLabel("Room name").fill(name);
  await page.getByLabel("Your name").fill("Dana the DM");
  const password = await page.getByLabel("Player password").inputValue();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await page.locator("code").first().textContent()) ?? "";
  const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
  assert.ok(match, `DM link looks wrong: ${link}`);
  const roomId = match[1]!.replace("-", "");
  await page.getByLabel("I saved my DM link").check();
  await page.getByRole("button", { name: "Continue to the room" }).click();
  const cookie = (await context.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  return { roomId, password, ops: await OpSocket.open({ origin, roomId, cookie }) };
}

describe("animated maps", { concurrency: false }, () => {
  before(async () => {
    for (const f of [WEBM, MP4]) assert.ok(existsSync(f), `the fixture ${path.basename(f)} (e2e/fixtures/README.md makes it)`);
    // startServer passes this process's environment on: every step but am-12 runs with the switch on.
    process.env.ANIMATED_MAPS = "1";
    server = await startServer({ port: PORT, assetDir, databaseUrl: DATABASE_URL });
    browser = await chromium.launch({ channel: "chrome", headless: process.env.E2E_HEADED !== "1" });
    dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    patContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    for (const c of [dmContext, patContext]) await c.addInitScript(HOOK_FLAG);
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

  test("am-0. the DM's room on a computer, the WebM and its still uploaded, a second scene, and Pat on a phone", async () => {
    const made = await createRoom(dm, dmContext, server.origin, run.roomName);
    run.roomId = made.roomId;
    run.password = made.password;
    ops = made.ops;
    await waitFor("the DM's snapshot", () => dmSocket.state);
    run.sceneId = dmSocket.state!.meta.playerSceneId!;
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { name: "Flooded hall", bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.create", scene: { id: run.cryptId, name: "The crypt", bounds: { w: 20, h: 14 }, fogEnabled: false } });
    run.webm = await uploadVideo(WEBM);
    assert.equal(run.webm.video?.container, "webm", "the server's facts name the container");
    run.webmStill = await uploadStill(run.webm.width, run.webm.height);
    run.patId = await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state);
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
    // A scene with no video holds no element and says so.
    for (const page of [dm, pat]) {
      const p = await boardSays(page, "none");
      assert.equal(p.videos, 0, "no video element before a scene has one");
    }
  });

  // am-1 (lane AM-D): the DM adds a WebM through the New scene form.
});
