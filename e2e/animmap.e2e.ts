import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, openSideTab, pagePoint, pickTool, ROOT, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

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
 * the facts its upload answered, which the server overwrites from the asset
 * row in any case (design 9.2). The still's cell size spreads the map over
 * the scene's bounds.
 */
function videoMap(still: StillRow, video: VideoRow) {
  return {
    assetId: still.id,
    widthPx: still.width,
    heightPx: still.height,
    cellPx: still.width / BOUNDS.w,
    originPx: { x: 0, y: 0 },
    video: { container: "webm", video: "vp8", fps: 30, durationMs: 2000, kbps: 1, ...video.video, assetId: video.id, widthPx: video.width, heightPx: video.height },
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
  let last: BoardProbe | null = null;
  try {
    return await waitFor(`the board to say ${String(state)}`, async () => {
      const p = (last = await probe(page, where));
      if (!p) return null;
      return (typeof state === "string" ? p.state === state : state.test(p.state)) ? p : null;
    });
  } catch (err) {
    throw new Error(`${(err as Error).message}, and it said ${JSON.stringify(last)}`, { cause: err });
  }
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

/** The board's ground behind the canvas, which the cover paints (features/animmap/AnimMapController.tsx BOARD_GROUND). */
const GROUND = { r: 0x16, g: 0x16, b: 0x1a };

/** The DM sets a scene's map to a still with its video, through the socket. */
async function setVideoMap(sceneId: string, still: StillRow, video: VideoRow): Promise<void> {
  await ops.send({ t: "scene.setMap", sceneId, map: videoMap(still, video) });
}

/** Every request a page made for one asset's bytes, by the asset's id in its address. */
const requests = new Map<Page, string[]>();
function watchRequests(page: Page): void {
  const seen: string[] = [];
  requests.set(page, seen);
  page.on("request", (req) => seen.push(req.url()));
}
function requestsFor(page: Page, assetId: string): number {
  return (requests.get(page) ?? []).filter((u) => u.includes(encodeURIComponent(assetId))).length;
}

/**
 * Set before the app's first script: a record of any element that took a
 * video source while another element held one, so a step can show that one
 * element at a time holds a video (5.2), and a switch for `play()` refusing
 * as iOS Low Power Mode does.
 */
const SOURCE_WATCH = `(() => {
  const set = Element.prototype.setAttribute;
  globalThis.__rvttSrcClashes = [];
  Element.prototype.setAttribute = function (name, value) {
    if (name === "src" && this instanceof HTMLMediaElement) {
      const others = [...document.querySelectorAll("video[src]")].filter((e) => e !== this);
      if (others.length > 0) globalThis.__rvttSrcClashes.push(String(value));
    }
    return set.call(this, name, value);
  };
  // Chrome answers "smooth" from its record of this machine's past playback, which a busy test machine spoils. Each step that tests the answer stands in its own.
  const caps = navigator.mediaCapabilities;
  if (caps) {
    const ask = caps.decodingInfo.bind(caps);
    caps.decodingInfo = async (config) => ({ ...(await ask(config)), smooth: true, powerEfficient: true });
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (globalThis.__rvttRefusePlay) return Promise.reject(new DOMException("needs a tap", "NotAllowedError"));
    return play.call(this);
  };
})();`;

function srcClashes(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { __rvttSrcClashes?: string[] }).__rvttSrcClashes ?? []);
}

/** The most video draws the page counted in any one second over `ms`, read on every animation frame. */
function mostDrawsInASecond(page: Page, ms: number, where: "room" | "preview" = "room"): Promise<{ most: number; total: number }> {
  return page.evaluate(
    ([span, inPreview]) =>
      new Promise<{ most: number; total: number }>((resolve) => {
        type Host = { closest(s: string): unknown; animMapDraws?: number };
        const g = globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<unknown> }; requestAnimationFrame(cb: (t: number) => void): number; performance: { now(): number } };
        const host = (Array.from(g.document.querySelectorAll("[data-animmap-board]")) as Host[]).find((h) => Boolean(h.closest("dialog[aria-label^='Viewing as']")) === inPreview);
        const times: number[] = [];
        let last = host?.animMapDraws ?? 0;
        const start = g.performance.now();
        const step = (t: number) => {
          const now = host?.animMapDraws ?? 0;
          for (; last < now; last++) times.push(t);
          if (t - start < span) g.requestAnimationFrame(step);
          else {
            let most = 0;
            let lo = 0;
            for (let hi = 0; hi < times.length; hi++) {
              while (times[hi]! - times[lo]! >= 1000) lo++;
              most = Math.max(most, hi - lo + 1);
            }
            resolve({ most, total: times.length });
          }
        };
        g.requestAnimationFrame(step);
      }),
    [ms, where === "preview"] as const,
  );
}

/** Whether the map layer's image draws the board's video now: the Top-down stage's first layer, an image whose source is a video element. */
function mapLayerDrawsVideo(page: Page): Promise<{ first: boolean; layers: number }> {
  return page.evaluate(() => {
    type Node = { getClassName(): string; image?(): unknown };
    type Layer = { find(f: (n: Node) => boolean): Node[] };
    type Stage = { getLayers(): Layer[]; visible(): boolean; width(): number; container(): { closest(s: string): unknown } };
    const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
    const isVideo = (x: unknown) => typeof x === "object" && x !== null && (x as { tagName?: string }).tagName === "VIDEO";
    for (const stage of konva?.stages ?? []) {
      if (stage.container().closest("dialog[aria-label^='Viewing as']") || !stage.visible() || stage.width() === 0) continue;
      const layers = stage.getLayers();
      const at = layers.findIndex((l) => l.find((n) => n.getClassName() === "Image" && isVideo(n.image?.())).length > 0);
      return { first: at === 0, layers: at < 0 ? 0 : layers.length };
    }
    return { first: false, layers: 0 };
  });
}

/** The pixels of a screen box, as RGB triples. */
async function pixels(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<{ data: Buffer; count: number }> {
  const png = await page.screenshot({ clip: box });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, count: info.width * info.height };
}

/** How many of a box's pixels stray from a color by more than `tolerance` in any channel. */
async function offColor(page: Page, box: { x: number; y: number; width: number; height: number }, color: { r: number; g: number; b: number }, tolerance = 4): Promise<number> {
  const { data, count } = await pixels(page, box);
  let off = 0;
  for (let i = 0; i < count; i++) {
    if (Math.abs(data[i * 3]! - color.r) > tolerance || Math.abs(data[i * 3 + 1]! - color.g) > tolerance || Math.abs(data[i * 3 + 2]! - color.b) > tolerance) off++;
  }
  return off;
}

/** Whether the still shows in the middle of the map: its color, but for the grid's lines over it, which Low power's 1x canvas blurs wider. */
async function stillShows(page: Page): Promise<boolean> {
  const box = await middleOfMap(page);
  const { count } = await pixels(page, box);
  const off = await offColor(page, box, STILL_COLOR, 6);
  if (off >= count * 0.5) await shots.take(page, `still-check-${off}-of-${count}`);
  return off < count * 0.5;
}

/** Whether a box's pixels changed over `ms`: a moving video changes them, a still or the fog does not. */
async function moves(page: Page, box: { x: number; y: number; width: number; height: number }, ms = 400): Promise<boolean> {
  const a = await pixels(page, box);
  await sleep(ms);
  const b = await pixels(page, box);
  return !a.data.equals(b.data);
}

/** The scene's rectangle on the page, in CSS px. */
async function sceneBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const a = await pagePoint(page, BOUNDS, { x: 0, y: 0 });
  const b = await pagePoint(page, BOUNDS, { x: BOUNDS.w, y: BOUNDS.h });
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

/** A box in the middle of the scene's rectangle, clear of the bars. */
async function middleOfMap(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await sceneBox(page);
  const size = page.viewportSize()!;
  const cx = Math.min(Math.max(box.x + box.width / 2, 40), size.width - 40);
  const cy = Math.min(Math.max(box.y + box.height / 2, 160), size.height - 160);
  return { x: Math.round(cx - 30), y: Math.round(cy - 30), width: 60, height: 60 };
}

/** Says the page is hidden or shown, as a locked phone or a tab in the background does. */
function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  return page.evaluate((to) => {
    const doc = (globalThis as unknown as { document: { dispatchEvent(e: unknown): void } }).document;
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => to });
    doc.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/**
 * The fixture's moving part on the page: the dark band under its color
 * bars, where a white square crosses and the frame number counts (e2e/
 * fixtures/README.md), clipped to the screen and clear of the bars.
 */
async function movingBand(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await sceneBox(page);
  const size = page.viewportSize()!;
  const x0 = Math.max(box.x, 4);
  const x1 = Math.min(box.x + box.width, size.width - 4);
  const y0 = Math.max(box.y + box.height * 0.62, 120);
  const y1 = Math.min(box.y + box.height * 0.98, size.height - 120);
  assert.ok(x1 - x0 > 20 && y1 - y0 > 8, `the fixture's band shows on screen: ${JSON.stringify(box)}`);
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

/** The board's element's source, or null. */
function sourceOf(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as { document: { querySelector(s: string): { getAttribute(n: string): string | null } | null } }).document.querySelector("video[data-animmap-video]")?.getAttribute("src") ?? null);
}

/** Whether the board's element is paused and whether it holds a source. */
function element(page: Page): Promise<{ paused: boolean; src: boolean } | null> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelector(s: string): { paused: boolean; hasAttribute(n: string): boolean } | null } }).document;
    const v = doc.querySelector("video[data-animmap-video]");
    return v ? { paused: v.paused, src: v.hasAttribute("src") } : null;
  });
}

async function openThisDevice(page: Page): Promise<Locator> {
  const tabs = page.getByRole("tablist", { name: "Panels" });
  let menu: Locator;
  if (await tabs.isVisible()) {
    await openSideTab(page, "Menu");
    menu = page.getByRole("tabpanel", { name: sideTabName("Menu") });
  } else {
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    menu = page.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
    await menu.waitFor();
  }
  if (await menu.getByRole("group", { name: "Map images" }).isVisible()) return menu;
  const back = page.getByRole("button", { name: /^Back to Menu/ });
  if (await back.isVisible()) await back.click();
  await menu.getByRole("button", { name: /^This device/ }).click();
  await menu.getByRole("group", { name: "Map images" }).waitFor();
  return menu;
}

/** Closes a phone's Menu sheet and waits for it to go, so the map shows again. On a computer the side panel stays. */
async function closeMenu(page: Page): Promise<void> {
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
  if ((await sheet.count()) === 0) return;
  await sheet.getByRole("button", { name: /^Close/ }).first().click();
  await sheet.waitFor({ state: "detached" });
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
    for (const c of [dmContext, patContext]) {
      await c.addInitScript(HOOK_FLAG);
      await c.addInitScript(SOURCE_WATCH);
    }
    dm = await dmContext.newPage();
    pat = await patContext.newPage();
    watchRequests(dm);
    watchRequests(pat);
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

  test("am-2. the players' scene plays its video in the map layer under the fog and tokens, at most 32 draws in any second, and nothing but the ground shows outside the scene", async () => {
    await setVideoMap(run.sceneId, run.webmStill!, run.webm!);
    const started = Date.now();
    await boardSays(pat, "playing");
    assert.ok(Date.now() - started < 8000, "Pat's map moves soon");
    await boardSays(dm, "playing");
    for (const page of [pat, dm]) {
      const drawn = await mapLayerDrawsVideo(page);
      assert.ok(drawn.first, "the video draws in the map layer, the stage's first, under the board, the tokens and the fog");
      assert.ok(drawn.layers <= 5, `at most five layers, ${drawn.layers}`);
    }
    // At most 32 video draws in any second, read on every frame, and about 30 a second at rest.
    const pace = await mostDrawsInASecond(pat, 3000);
    assert.ok(pace.most <= 32, `${pace.most} video draws in one second`);
    assert.ok(pace.total >= 40, `${pace.total} video draws in 3 s`);
    // A camera change draws as a camera draw, counted apart.
    const before = await probe(pat);
    const size = pat.viewportSize()!;
    await pat.mouse.move(size.width / 2, size.height / 2);
    await pat.mouse.wheel(0, -120);
    await sleep(300);
    const after = await probe(pat);
    assert.ok(before && after && after.cameraDraws > before.cameraDraws, "the zoom drew as a camera draw");
    assert.ok(await moves(pat, await movingBand(pat)), "the map moves on Pat's screen");
    assert.equal((await probe(pat))!.withSrc, 1, "one element holds the video");
    await shots.take(pat, "am-2-pat-moving");
    await shots.take(dm, "am-2-dm-moving");

    // Zoomed out and panned to an edge: the ground around the scene is the cover's, never the raw video.
    for (let i = 0; i < 8; i++) await pat.mouse.wheel(0, 240);
    await sleep(600);
    const scene = await sceneBox(pat);
    const strips = [
      { x: 0, y: scene.y + scene.height / 2 - 20, width: Math.floor(scene.x) - 4, height: 40 },
      { x: Math.ceil(scene.x + scene.width) + 4, y: scene.y + scene.height / 2 - 20, width: size.width - Math.ceil(scene.x + scene.width) - 4, height: 40 },
      { x: size.width / 2 - 40, y: Math.max(130, scene.y - 50), width: 80, height: Math.min(40, scene.y - 4 - Math.max(130, scene.y - 50)) },
    ].filter((b) => b.width >= 8 && b.height >= 8);
    assert.ok(strips.length > 0, `some ground shows around the scene: ${JSON.stringify(scene)}`);
    for (const strip of strips) assert.equal(await offColor(pat, strip, GROUND), 0, `only the ground outside the scene at ${JSON.stringify(strip)}`);
    await shots.take(pat, "am-2-pat-zoomed-out");

    // Isometric shows the still, and the ground around it is the cover's too.
    await viewAs(pat, "isometric");
    await boardSays(pat, "still still-view");
    assert.deepEqual(await element(pat), { paused: true, src: true }, "Isometric pauses the video and keeps its source");
    const corner = { x: 4, y: 140, width: 30, height: 30 };
    assert.equal(await offColor(pat, corner, GROUND), 0, "no video at the screen's edge in Isometric");
    await viewAs(pat, "topDown");
    await boardSays(pat, "playing");

    // Fully fogged for players: the video plays on under the fog, and nothing of it shows.
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: true } });
    await waitFor("the fog on Pat's state", () => ((patSocket.state?.scenes[run.sceneId] as { fogEnabled?: boolean } | undefined)?.fogEnabled ? true : null));
    await sleep(500);
    await boardSays(pat, "playing");
    assert.equal(await moves(pat, await movingBand(pat), 600), false, "nothing moves under the fog");
    await shots.take(pat, "am-2-pat-fogged");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { fogEnabled: false } });
    await sleep(500);
    assert.deepEqual(await srcClashes(pat), []);
    // Pat's map as it opens, for the steps after: a reload fits the scene again.
    await pat.reload();
    await pat.locator(".konvajs-content").first().waitFor();
    await boardSays(pat, "playing");
  });

  test("am-3. a video phase plays for Pat when the DM switches to it, the old element freed, and a map replaced while one plays clears its source first", async () => {
    const mp4 = await uploadVideo(MP4);
    const mp4Still = await uploadStill(mp4.width, mp4.height);
    const plain = await uploadStill(run.webm!.width, run.webm!.height);
    // Phase 1 a plain still, phase 2 the MP4 over its still.
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: { assetId: plain.id, widthPx: plain.width, heightPx: plain.height, cellPx: plain.width / BOUNDS.w, originPx: { x: 0, y: 0 } } });
    await boardSays(pat, "none");
    assert.equal((await probe(pat))!.withSrc, 0, "a still map frees the element");
    const phases = [
      { id: randomUUID(), name: "Dry", assetId: plain.id, widthPx: plain.width, heightPx: plain.height },
      { id: randomUUID(), name: "Flooded", assetId: mp4Still.id, widthPx: mp4Still.width, heightPx: mp4Still.height, video: videoMap(mp4Still, mp4).video },
    ];
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { phases } });
    await sleep(300);
    assert.equal(requestsFor(pat, mp4.id), 0, "a phase not showing sends Pat nothing of its video");
    await ops.send({ t: "scene.setPhase", sceneId: run.sceneId, phaseId: phases[1]!.id });
    await boardSays(pat, "playing");
    assert.ok(requestsFor(pat, mp4.id) > 0, "the shown phase's video loads");
    assert.ok(await moves(pat, await movingBand(pat)), "the MP4 moves");
    await shots.take(pat, "am-3-pat-video-phase");
    await ops.send({ t: "scene.setPhase", sceneId: run.sceneId, phaseId: phases[0]!.id });
    await boardSays(pat, "none");
    assert.equal((await probe(pat))!.withSrc, 0, "switching to a still phase frees the element");
    // A map replaced while another animated map plays: the MP4 plays, then the WebM takes its place.
    await ops.send({ t: "scene.setPhase", sceneId: run.sceneId, phaseId: phases[1]!.id });
    await boardSays(pat, "playing");
    await setVideoMap(run.sceneId, run.webmStill!, run.webm!);
    // The browser may play the WebM from its cache, so the element's source says which video it holds.
    await waitFor("the WebM on Pat's board", async () => ((await probe(pat))?.state === "playing" && (await sourceOf(pat))?.includes(run.webm!.id) ? true : null));
    const p = (await probe(pat))!;
    assert.equal(p.withSrc, 1);
    assert.deepEqual(await srcClashes(pat), [], "no element took a source while another held one");
  });

  test("am-4. Still, Low power and reduced motion show the still, download no video, and say why", async () => {
    const id = run.webm!.id;
    const still = async (page: Page, state: string) => {
      const p = await boardSays(page, state);
      assert.equal(p.withSrc, 0, `${state}: no element holds the video`);
      assert.ok(await stillShows(page), `${state}: the still shows`);
    };
    // Still, chosen on This device, frees the element at once.
    const menu = await openThisDevice(pat);
    const row = menu.getByRole("group", { name: "Animated maps" });
    await row.scrollIntoViewIfNeeded();
    await shots.take(pat, "am-4-this-device-moving");
    await row.getByRole("radio", { name: "Still", exact: true }).check();
    await closeMenu(pat);
    await still(pat, "still setting");
    assert.equal(await pat.evaluate(() => localStorage.getItem("rvtt.animatedMaps")), "still");
    // Reloaded on Still: not one request for the video's bytes.
    let before = requestsFor(pat, id);
    await pat.reload();
    await pat.locator(".konvajs-content").first().waitFor();
    await still(pat, "still setting");
    await sleep(1000);
    assert.equal(requestsFor(pat, id), before, "Still downloads no video");
    await pat.evaluate(() => localStorage.setItem("rvtt.animatedMaps", "moving"));

    // Low power, with This device's help line.
    await pat.evaluate(() => localStorage.setItem("rvtt.lowPower", "on"));
    before = requestsFor(pat, id);
    await pat.reload();
    await pat.locator(".konvajs-content").first().waitFor();
    await still(pat, "still low-power");
    await sleep(800);
    assert.equal(requestsFor(pat, id), before, "Low power downloads no video");
    const lowMenu = await openThisDevice(pat);
    await lowMenu.getByText("Low power keeps animated maps still.", { exact: true }).waitFor();
    await lowMenu.getByText(/keeps weather and animated maps still/).waitFor();
    await shots.take(pat, "am-4-this-device-low-power");
    await closeMenu(pat);
    await pat.evaluate(() => localStorage.removeItem("rvtt.lowPower"));
    await pat.reload();
    await pat.locator(".konvajs-content").first().waitFor();
    await boardSays(pat, "playing");

    // Reduced motion, followed live.
    await pat.emulateMedia({ reducedMotion: "reduce" });
    try {
      await still(pat, "still reduced-motion");
      const rmMenu = await openThisDevice(pat);
      await rmMenu.getByText("Reduced motion keeps animated maps still.", { exact: true }).waitFor();
      await closeMenu(pat);
    } finally {
      await pat.emulateMedia({ reducedMotion: "no-preference" });
    }
    await boardSays(pat, "playing");

    // This device's row in line at the sweep's sizes and interface sizes.
    const lines: string[] = [];
    const page = await dmContext.newPage();
    try {
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.locator(".konvajs-content").first().waitFor();
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
        for (const scale of ["1", "1.3"]) {
          await page.evaluate((v) => localStorage.setItem("rvtt.uiScale", v), scale);
          await page.setViewportSize(size);
          await page.reload();
          await page.locator(".konvajs-content").first().waitFor();
          const m = await openThisDevice(page);
          const group = m.getByRole("group", { name: "Animated maps" });
          await group.scrollIntoViewIfNeeded();
          lines.push(...alignmentLines(await measureAlignment(group), `This device's Animated maps ${size.width}x${size.height} ${scale}`));
          await shots.take(page, `am-4-this-device-${size.width}-${scale.replace(".", "")}`);
        }
      }
      await page.evaluate(() => localStorage.removeItem("rvtt.uiScale"));
    } finally {
      await page.close();
    }
    assert.deepEqual(lines, [], "This device's Animated maps row out of line");
  });

  test("am-5. a phone on Phone size shows the still when its browser cannot decode the video power-efficiently, and a computer plays it", async () => {
    const stub = () => {
      const caps = (navigator as unknown as { mediaCapabilities: { decodingInfo(c: unknown): Promise<unknown> } }).mediaCapabilities;
      caps.decodingInfo = async () => ({ supported: true, smooth: true, powerEfficient: false });
    };
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState: await patContext.storageState() });
    const computer = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await dmContext.storageState() });
    try {
      for (const c of [phone, computer]) await c.addInitScript(stub);
      await phone.addInitScript(() => localStorage.setItem("rvtt.mapVariant", sessionStorage.getItem("fullSize") === "1" ? "full" : "mobile"));
      const onPhone = await phone.newPage();
      watchRequests(onPhone);
      await onPhone.goto(`${server.origin}/r/${run.roomId}`);
      await onPhone.locator(".konvajs-content").first().waitFor();
      const p = await boardSays(onPhone, "still not-smooth");
      assert.equal(p.withSrc, 0);
      assert.equal(requestsFor(onPhone, run.webm!.id), 0, "no video request");
      // The same phone on Full size takes a smooth decoder that is not power-efficient.
      await onPhone.evaluate(() => sessionStorage.setItem("fullSize", "1"));
      await onPhone.reload();
      await onPhone.locator(".konvajs-content").first().waitFor();
      await boardSays(onPhone, "playing");
      const onComputer = await computer.newPage();
      await onComputer.goto(`${server.origin}/r/${run.roomId}`);
      await onComputer.locator(".konvajs-content").first().waitFor();
      await boardSays(onComputer, "playing");
    } finally {
      await phone.close();
      await computer.close();
    }
  });

  test("am-6. a play() the browser refuses shows the still, and a tap on the board plays it", async () => {
    // As iOS Low Power Mode refuses a muted play() from the page's load on: the flag is kept in the tab's storage across the reload.
    await pat.addInitScript(() => {
      try {
        (globalThis as unknown as { __rvttRefusePlay: boolean }).__rvttRefusePlay = sessionStorage.getItem("refusePlay") === "1";
      } catch {
        // about:blank has no storage.
      }
    });
    await pat.evaluate(() => sessionStorage.setItem("refusePlay", "1"));
    await pat.reload();
    await pat.locator(".konvajs-content").first().waitFor();
    await boardSays(pat, "still not-started");
    assert.ok(await stillShows(pat), "the still shows");
    await pat.evaluate(() => {
      sessionStorage.removeItem("refusePlay");
      (globalThis as unknown as { __rvttRefusePlay: boolean }).__rvttRefusePlay = false;
    });
    const at = await middleOfMap(pat);
    await pat.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
    await boardSays(pat, "playing");
  });

  test("am-7. Isometric, a setup tool, a hidden page and a sheet over the screen pause it, View as a player frees the covered board's source, and each plays again", async () => {
    // A hidden page.
    await setVisibility(pat, "hidden");
    await boardSays(pat, "paused");
    assert.deepEqual(await element(pat), { paused: true, src: true });
    const resumed = Date.now();
    await setVisibility(pat, "visible");
    await boardSays(pat, "playing");
    assert.ok(Date.now() - resumed < 2000, "it plays again at once");

    // A phone's sheet swiped to fill the screen.
    await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await pat.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    const sheet = pat.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
    await sheet.waitFor();
    await sheet.getByRole("button", { name: "Expand sheet" }).focus();
    await pat.keyboard.press("Enter");
    await boardSays(pat, "paused");
    assert.equal((await drawsOver(pat, 600)).draws, 0, "no draws under a sheet over the screen");
    await pat.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await boardSays(pat, "playing");

    // Isometric on the DM's computer.
    await viewAs(dm, "isometric");
    await boardSays(dm, "still still-view");
    assert.equal((await drawsOver(dm, 500)).draws, 0);
    await viewAs(dm, "topDown");
    await boardSays(dm, "playing");

    // A setup tool shows the still, and the video waits paused.
    await pickTool(dm, "Fog");
    await boardSays(dm, "still still-view");
    assert.deepEqual(await element(dm), { paused: true, src: true });
    assert.equal((await mapLayerDrawsVideo(dm)).first, false, "the fog tool paints on the still");
    await pickTool(dm, "Select");
    await boardSays(dm, "playing");

    // View as a player: the DM's own board frees its source for the preview's.
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.locator(".konvajs-content").first().waitFor();
    await boardSays(dm, "playing", "preview");
    await boardSays(dm, "covered");
    assert.equal((await probe(dm))!.withSrc, 1, "one element on the page holds a video");
    assert.equal((await drawsOver(dm, 500)).draws, 0, "the covered board draws nothing");
    await shots.take(dm, "am-7-view-as-pat");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await boardSays(dm, "playing");
    assert.equal((await probe(dm))!.withSrc, 1);
    assert.deepEqual(await srcClashes(dm), [], "no element took a source while another held one");
  });

  test("am-8. the table display plays it, and its menu's Still shows the still with no further requests, a member's own choice left alone", async () => {
    const tvContext = await browser.newContext({ viewport: TV, storageState: await dmContext.storageState() });
    try {
      await tvContext.addInitScript(SOURCE_WATCH);
      const tv = await tvContext.newPage();
      consoles.tv.attach(tv);
      watchRequests(tv);
      const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
      assert.equal(res.status(), 201, await res.text());
      const { code } = (await res.json()) as { code: string };
      await tv.goto(`${server.origin}/display`);
      await tv.getByLabel("Code from the DM's screen").fill(code);
      await tv.getByRole("button", { name: "Connect" }).click();
      await tv.locator(".konvajs-content").first().waitFor();
      await boardSays(tv, "playing");
      assert.ok(requestsFor(tv, run.webm!.id) > 0, "the display loads the video");
      await shots.take(tv, "am-8-display-moving");
      await tv.evaluate(() => localStorage.setItem("rvtt.animatedMaps", "moving"));
      await tv.mouse.click(TV.width / 2, TV.height / 2);
      const menu = tv.getByRole("menu", { name: "Table display" });
      await menu.getByRole("group", { name: "Animated maps" }).getByRole("menuitemradio", { name: "Still" }).click();
      const p = await boardSays(tv, "still setting");
      assert.equal(p.withSrc, 0);
      const settled = requestsFor(tv, run.webm!.id);
      await sleep(1500);
      assert.equal(requestsFor(tv, run.webm!.id), settled, "no further requests on Still");
      assert.equal(await tv.evaluate(() => localStorage.getItem("rvtt.animatedMaps")), "moving", "the member's setting is unchanged");
      assert.equal(await tv.evaluate(() => localStorage.getItem("rvtt.displayAnimatedMaps")), "still");
      await shots.take(tv, "am-8-display-menu-still");

      const lines: string[] = [];
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
        for (const scale of ["100%", "130%"]) {
          await tv.setViewportSize(size);
          if (!(await menu.isVisible())) await tv.mouse.click(size.width / 2, size.height / 3);
          await menu.waitFor();
          await menu.getByRole("group", { name: "Text size" }).getByRole("menuitemradio", { name: scale }).click();
          await sleep(200);
          const row = menu.getByRole("group", { name: "Animated maps" });
          await row.scrollIntoViewIfNeeded();
          lines.push(...alignmentLines(await measureAlignment(row), `display animated maps ${size.width}x${size.height} ${scale}`));
          await shots.take(tv, `am-8-display-menu-${size.width}-${scale.replace("%", "")}`);
        }
      }
      await menu.getByRole("group", { name: "Text size" }).getByRole("menuitemradio", { name: "100%" }).click();
      await menu.getByRole("group", { name: "Animated maps" }).getByRole("menuitemradio", { name: "Moving" }).click();
      assert.deepEqual(lines, [], "the display menu's Animated maps row out of line");
    } finally {
      await tvContext.close();
    }
  });

  // am-9 to am-11 (lane AM-D): the refusals, the Library and Use the still only.

  test("am-12. with the server's switch off, maps show their stills, video uploads and bytes are refused, a new video is invalid, and edits and undos of the room's own videos pass", async () => {
    // Made while the switch is on: a scene whose two phases are the WebM and the MP4.
    const mp4 = await uploadVideo(MP4);
    const mp4Still = await uploadStill(mp4.width, mp4.height);
    const phases = [
      { id: randomUUID(), name: "Flooded", assetId: run.webmStill!.id, widthPx: run.webmStill!.width, heightPx: run.webmStill!.height, video: videoMap(run.webmStill!, run.webm!).video },
      { id: randomUUID(), name: "Burning", assetId: mp4Still.id, widthPx: mp4Still.width, heightPx: mp4Still.height, video: videoMap(mp4Still, mp4).video },
    ];
    await setVideoMap(run.sceneId, run.webmStill!, run.webm!);
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { phases } });
    const cookie = (await dmContext.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");

    // The same database and files, served with the switch off. Every later step and the cleanup use this server.
    ops.close();
    for (const page of [dm, pat]) await page.goto("about:blank");
    await server.stop();
    process.env.ANIMATED_MAPS = "0";
    server = await startServer({ port: OFF_PORT, assetDir, databaseUrl: DATABASE_URL });
    ops = await OpSocket.open({ origin: server.origin, roomId: run.roomId, cookie });
    const asked = requestsFor(dm, run.webm!.id);
    await dm.goto(`${server.origin}/r/${run.roomId}`);
    await dm.locator(".konvajs-content").first().waitFor();
    const p = await boardSays(dm, "still server-off");
    assert.equal(p.withSrc, 0);
    assert.ok(await stillShows(dm), "the still shows");
    assert.equal(requestsFor(dm, run.webm!.id), asked, "no video request");
    const menu = await openThisDevice(dm);
    assert.equal(await menu.getByRole("group", { name: "Animated maps" }).count(), 0, "no Animated maps row while the switch is off");
    await shots.take(dm, "am-12-this-device-switch-off");
    await closeMenu(dm);

    // The bytes and an upload are refused.
    const bytes = await dmContext.request.get(`${server.origin}/api/assets/${run.webm!.id}/full`);
    assert.equal(bytes.status(), 404, "a video's bytes answer 404");
    const upload = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=video`, { headers: { Origin: server.origin, "content-type": "video/webm" }, data: readFileSync(WEBM) });
    assert.ok(!upload.ok(), `the upload answered ${upload.status()}`);
    assert.match(await upload.text(), /video_off/);

    // Edits of the videos the room holds pass, and so do their undos.
    const [flooded, burning] = phases;
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { phases: [{ ...flooded!, name: "High water" }, burning!] } });
    await ops.step("undo", "setup");
    const still = { id: randomUUID(), name: "Dry", assetId: run.webmStill!.id, widthPx: run.webmStill!.width, heightPx: run.webmStill!.height };
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { phases: [flooded!, burning!, still] } });
    await ops.step("undo", "setup");
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { phases: [flooded!] } });
    await ops.step("undo", "setup");
    await waitFor("both video phases back", () => ((dmSocket.state?.scenes[run.sceneId] as { phases?: unknown[] } | undefined)?.phases?.length === 2 ? true : null));
    // A video the room no longer names anywhere is a new one: refused. Undoing its removal brings it back.
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { phases: [flooded!] } });
    await assert.rejects(ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { phases: [flooded!, burning!] } }), /invalid: Animated maps are off on this server/);
    await ops.step("undo", "setup");
    await waitFor("the MP4 phase back by undo", () => ((dmSocket.state?.scenes[run.sceneId] as { phases?: unknown[] } | undefined)?.phases?.length === 2 ? true : null));
    await ops.send({ t: "scene.duplicate", sceneId: run.sceneId, newSceneId: randomUUID(), name: "Flooded hall copy", include: { creatures: false, characters: false, fog: false, drawings: false } });

    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} errors`);
  });
});
