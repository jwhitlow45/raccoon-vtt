import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, openSceneGroup, openSideTab, pagePoint, pickTool, ROOT, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";
import { openGroup } from "./helpers/groups.ts";

/**
 * Animated maps (docs/design/design-v1-animated-maps.md): a WebM or MP4 on
 * a map's rectangle, drawn by the board's map layer in the still's place.
 * Lane AM-C's steps (am-2 to am-8 and am-12) drive playback on the board,
 * Still, Low power and reduced motion, and the table display. Lane AM-D's
 * (am-1 and am-9 to am-11) drive the DM's upload, the refusals, the Library
 * and Use the still only. Lane AR-B's (amr-1 to amr-7,
 * docs/design/design-v1-video-turns.md 14) upload turned, mirrored,
 * stretched and cropped videos and an iPhone MOV, and check the map shows
 * them upright, the still and the video alike. hs-1 checks that an HEVC
 * MOV is refused on the device with nothing sent. Maps are set through the
 * DM's socket where a step does not test the upload form.
 *
 * The board is read through its test hooks (features/animmap/board.ts):
 * the host over the board, `[data-animmap-board]`, holds `data-animmap`
 * ("playing", "paused", "loading", "waiting", "none" or "still <reason>",
 * set on change) and the `animMapDraws` and `animMapCameraDraws`
 * properties, video draws and camera draws of the map layer counted
 * apart. The one `<video>` is `video[data-animmap-video]`.
 *
 * The fixtures are e2e/fixtures/map-loop.webm (VP9) and map-loop.mp4
 * (H.264), 640 by 360 and 2 s long, and the turned and stretched copies of
 * their frames beside them, made by the script the folder's README names.
 * The browser is Chrome, which plays them all.
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
  /** The DM link, for a second DM session (amr-0). */
  dmLink: "",
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
async function createRoom(page: Page, context: BrowserContext, origin: string, name: string): Promise<{ roomId: string; password: string; ops: OpSocket; link: string }> {
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
  return { roomId, password, ops: await OpSocket.open({ origin, roomId, cookie }), link };
}

/** The board's ground behind the canvas in both themes, which the cover paints (features/animmap/AnimMapController.tsx BOARD_GROUND). */
const GROUND = { r: 0x16, g: 0x16, b: 0x1a };

/** Pat's page in `scheme`, as This device's Theme keeps it, after a reload that also fits the scene again. */
async function setScheme(page: Page, scheme: "dark" | "light"): Promise<void> {
  await page.evaluate((s) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem("rvtt.theme", s), scheme);
  await page.reload();
  await page.locator(".konvajs-content").first().waitFor();
  await waitFor(`the page turns ${scheme}`, async () => ((await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { getAttribute(n: string): string | null } } }).document.documentElement.getAttribute("data-rvtt-scheme"))) === scheme ? true : null), 5_000);
}

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
  // This device's groups start folded on a phone (docs/design/design-v1-panel-groups.md 6.2): Map detail holds the rows here.
  await openGroup(menu, "Map detail");
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
    run.dmLink = made.link;
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

  /*
   * Lane AM-D's steps (am-1 and am-9 to am-11): the DM's upload through each
   * form, the refusals, the still pick, Use the still only and the Library.
   * Their helpers load here, so the file's import block stays the board
   * lane's.
   */
  /** The words the steps look for (client/features/animmap words.ts, upload.ts and firstFrame.ts, whose unit tests pin them). The client's modules need a DOM, so they are not imported here. */
  const AMD_WORDS = {
    pickHelp: "A WebM, MP4 or MOV video makes an animated map, up to 64 MB. H.264 plays on the most devices.",
    noFrame: "This device can't read that video's first frame. Pick a still image for it, such as the one that came with the map.",
    lowPower: "Low Power Mode stopped the video from opening. Tap Try again, or pick a still image.",
    videoType: "That video isn't WebM, MP4 or MOV.",
    badVideo: "That video could not be read.",
    geometry: "That video's file crops or reshapes its picture in a way this app can't show. Export it again as a plain MP4 or WebM.",
    hevc: "That video is HEVC (High Efficiency), which most browsers can't play. Export it as H.264, for example with QuickTime Player's Export As and Greater Compatibility on a Mac. For new iPhone videos, set Settings > Camera > Formats to Most Compatible.",
  };
  /** The map pickers while the server takes videos (upload.ts mapAccept). */
  const VIDEO_PICKER = 'input[type="file"][accept="image/*,video/webm,video/mp4,video/quicktime,.mov"]';
  const amd = {
    /** The Scenes panel, the side panel's tab on a computer. */
    async scenes(page: Page = dm) {
      const { openSideTab, sideTabName } = await import("./harness.ts");
      await openSideTab(page, "Scenes");
      return page.getByRole("tabpanel", { name: sideTabName("Scenes") });
    },
    /** A panel's section or group by its label: the nearest around the heading. */
    section(panel: ReturnType<Page["locator"]>, label: string) {
      return panel.getByRole("heading", { name: label, exact: true }).locator("xpath=ancestor::*[self::section or @data-panel-group][1]");
    },
    /** Shows the DM a scene from its row in the list, and waits for its settings to name it. */
    async view(sceneId: string) {
      const panel = await amd.scenes();
      const name = dmSocket.state?.scenes[sceneId]?.name ?? "";
      await panel.getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
      await waitFor(`the DM on ${name}`, () => dmSocket.you?.sceneId === sceneId || null);
      const field = panel.getByRole("textbox", { name: "Scene name" }).last();
      await waitFor(`${name}'s settings`, async () => ((await field.inputValue()) === name ? true : null));
      return panel;
    },
    /** Every busy label the page's upload buttons show from now on, kept in the page so none is lost between polls. */
    async recordLabels(page: Page = dm) {
      await page.evaluate(() => {
        type W = { __amdLabels?: string[]; document: { body: unknown } };
        const w = globalThis as unknown as W & { MutationObserver: new (cb: () => void) => { observe(n: unknown, o: unknown): void } };
        w.__amdLabels = [];
        const seen = w.__amdLabels;
        const read = () => {
          const text = (w.document.body as { innerText: string }).innerText;
          for (const m of text.matchAll(/(Reading the first frame…|Uploading the (?:video|still)… \d+%|Looking for a grid…)/g)) if (seen.at(-1) !== m[1]) seen.push(m[1]!);
        };
        new w.MutationObserver(read).observe(w.document.body, { subtree: true, childList: true, characterData: true });
      });
    },
    labels(page: Page = dm): Promise<string[]> {
      return page.evaluate(() => (globalThis as unknown as { __amdLabels?: string[] }).__amdLabels ?? []);
    },
    /** Slows this page's uploads, so each percent stays on screen long enough to read. Null lifts it. */
    async throttle(page: Page, bytesPerSecond: number | null) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: bytesPerSecond ?? -1 });
      if (bytesPerSecond === null) await cdp.detach();
    },
    /**
     * Makes the first-frame probe's play() fail as an older iPhone or Low
     * Power Mode would. Only the form's probes are touched: on the picked
     * file (`blob:` sources) alone, or on the stored copy too (`any`). Null
     * puts play() back.
     */
    async probeRefuses(page: Page, name: "NotSupportedError" | "NotAllowedError" | null, which: "blob" | "any" = "blob") {
      await page.evaluate(
        ([refuse, on]) => {
          type El = { currentSrc: string; src: string; hasAttribute(n: string): boolean };
          type P = { play(this: El): Promise<void>; __amdPlay?: P["play"] };
          const proto = (globalThis as unknown as { HTMLMediaElement: { prototype: P } }).HTMLMediaElement.prototype;
          proto.__amdPlay ??= proto.play;
          const real = proto.__amdPlay;
          proto.play = refuse
            ? function (this: El) {
                const probe = this.hasAttribute("data-animmap-probe") && (on === "any" || (this.src || this.currentSrc).startsWith("blob:"));
                return probe ? Promise.reject(new DOMException("refused", refuse)) : real.call(this);
              }
            : real;
        },
        [name, which] as const,
      );
    },
    png(width: number, height: number, rgb = { r: 96, g: 64, b: 128 }) {
      return sharp({ create: { width, height, channels: 3, background: rgb } }).png().toBuffer();
    },
    async assets(): Promise<{ id: string; kind: string; width: number; height: number; inUse?: boolean; video?: Record<string, unknown> }[]> {
      const res = await dmContext.request.get(`${server.origin}/api/rooms/${run.roomId}/assets`);
      assert.ok(res.ok(), `the asset list answered ${res.status()}`);
      return ((await res.json()) as { assets: never[] }).assets;
    },
  };

  test("am-1. the DM makes a scene from a WebM: the first frame, the video and the still with their percent, the grid looked for on the still, one Setup step, and the map moves; then the crypt's Map image row takes a named video for its scale", async () => {
    const VIDEO_PICK_HELP = AMD_WORDS.pickHelp;
    const known = new Set(Object.keys(dmSocket.state!.scenes));
    const panel = await amd.scenes();
    const form = await openSceneGroup(panel, "New scene");
    await form.getByRole("radio", { name: "Map image", exact: true }).click();
    await form.getByRole("textbox", { name: "Scene name" }).fill("Lagoon");
    await form.getByText(VIDEO_PICK_HELP, { exact: true }).waitFor();
    // A name with no size, so the grid is looked for, on the still since a video cannot be searched.
    await form.locator(VIDEO_PICKER).first().setInputFiles({ name: "lagoon.webm", mimeType: "video/webm", buffer: readFileSync(WEBM) });
    await amd.recordLabels();
    await amd.throttle(dm, 64 * 1024);
    const puts: string[] = [];
    dm.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/assets?kind=")) puts.push(new URL(r.url()).searchParams.get("kind") ?? "");
    });
    await form.getByRole("button", { name: "Upload and create" }).click();
    await form.getByRole("button", { name: /^Uploading the video… \d+%$/ }).waitFor();
    await shots.take(dm, "am-1-upload-percent");
    const made = await waitFor("the Lagoon scene with its video", () => Object.values(dmSocket.state!.scenes).find((s) => s && !known.has(s.id) && s.name === "Lagoon" && s.map?.video), 60_000);
    await amd.throttle(dm, null);
    const labels = await amd.labels();
    assert.equal(labels[0], "Reading the first frame…", labels.join(" | "));
    const percents = labels.filter((l) => l.startsWith("Uploading the video…")).map((l) => Number(/(\d+)%/.exec(l)![1]));
    assert.ok(percents.some((p) => p > 0 && p < 100), `a real percent between 0 and 100: ${percents.join(", ")}`);
    assert.ok(percents.every((p, i) => i === 0 || p >= percents[i - 1]!), "the percent only rises");
    assert.ok(labels.some((l) => l.startsWith("Uploading the still…")), labels.join(" | "));
    assert.ok(labels.indexOf("Looking for a grid…") > labels.findIndex((l) => l.startsWith("Uploading the still…")), "the grid is looked for after the still is up");
    assert.deepEqual(puts, ["video", "map"], "the video first, then the still");
    const map = made.map!;
    assert.equal(map.video!.assetId, run.webm!.id, "the same file is the room's one row");
    assert.equal(map.video!.container, "webm");
    assert.equal(map.video!.widthPx, 640);
    assert.equal(map.widthPx, 640, "the still is the first frame, at the video's size");
    assert.equal(map.heightPx, 360);
    assert.notEqual(map.assetId, run.webmStill!.id);
    const rows = await amd.assets();
    assert.equal(rows.find((r) => r.id === map.assetId)?.kind, "map", "the still is a map image");
    await waitFor("the DM on Lagoon", () => dmSocket.you?.sceneId === made.id || null);
    // A map with no size in its name opens Line up grid, a setup tool, which shows the still the grid was looked for on.
    await boardSays(dm, "still still-view");
    const { pickTool } = await import("./harness.ts");
    await pickTool(dm, "Select");
    await boardSays(dm, "playing");
    await shots.take(dm, "am-1-lagoon-moving");

    // One Setup step: Undo setup takes the scene back whole, video and all, and Redo setup brings it again.
    const { setupHistory } = await import("./helpers/undoScope.ts");
    const { sheet } = await setupHistory(dm);
    await sheet.getByRole("button", { name: "Undo setup", exact: true }).click();
    await waitFor("the Lagoon scene undone", () => (dmSocket.state!.scenes[made.id] ? null : true));
    await sheet.getByRole("button", { name: "Redo setup", exact: true }).click();
    await waitFor("the Lagoon scene back with its video", () => (dmSocket.state!.scenes[made.id]?.map?.video?.assetId === run.webm!.id ? true : null));
    await dm.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    // The crypt's Map image row: a name that gives the size, which the still's upload carries, so the grid is not looked for.
    const crypt = await amd.view(run.cryptId);
    const group = await openSceneGroup(crypt, "Map and grid");
    await group.getByText(VIDEO_PICK_HELP, { exact: true }).waitFor();
    await amd.recordLabels();
    await group.locator(VIDEO_PICKER).first().setInputFiles({ name: "crypt_32x18.webm", mimeType: "video/webm", buffer: readFileSync(WEBM) });
    const cryptMap = await waitFor("the crypt's animated map", () => dmSocket.state!.scenes[run.cryptId]?.map?.video ?? null, 60_000);
    assert.equal(cryptMap.assetId, run.webm!.id);
    assert.equal(dmSocket.state!.scenes[run.cryptId]!.map!.cellPx, 20, "640 px over 32 squares, from the video's name");
    assert.ok(!(await amd.labels()).includes("Looking for a grid…"), "a named size is not searched");
    // The row's help, this device's line under it, and Use the still only, last on the picker's line (pe1-1 holds the lines).
    await group.getByText("A 640 × 360 px video, 0:02, looping. Its first frame is the still.", { exact: true }).waitFor();
    await group.getByText("Moving on this device.", { exact: true }).waitFor();
    await group.getByRole("button", { name: "Use the still only", exact: true }).waitFor();
    // The guide's picture (docs/dm-guide/animated-map.webp): the row at the top of the panel, once the steps' toasts have gone.
    await dm.locator("[data-toast]").first().waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
    await group.getByText("Map image", { exact: true }).evaluate((el) => (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({ block: "start" }));
    await shots.take(dm, "am-1-crypt-map-image-row");
  });

  test("am-9. a video the DM's device or the server refuses says why in 4.5's words, and leaves nothing behind", async () => {
    const before = (await amd.assets()).length;
    const panel = await amd.scenes();
    const form = await openSceneGroup(panel, "New scene");
    await form.getByRole("radio", { name: "Map image", exact: true }).click();
    const input = form.locator(VIDEO_PICKER).first();
    const puts: string[] = [];
    const watch = (r: { method(): string; url(): string }) => {
      if (r.method() === "PUT" && r.url().includes("/assets?kind=")) puts.push(r.url());
    };
    dm.on("request", watch);
    // The server's refusal of the broken MP4 is a failed request, which Chrome logs as an error.
    const allowed = consoles.dm.allow;
    consoles.dm.allow = [...allowed, /status of 422 .*kind=video&name=harbor\.mp4/];
    try {
      // A video that is not WebM, MP4 or MOV is refused on the device, before any byte goes up. A MOV goes on to the server (amr-7).
      await input.setInputFiles({ name: "harbor.avi", mimeType: "video/x-msvideo", buffer: Buffer.from("not a video at all") });
      await form.getByRole("button", { name: "Upload and create" }).click();
      await form.getByText(AMD_WORDS.videoType, { exact: true }).waitFor();
      assert.equal(puts.length, 0, "nothing went up");
      await shots.take(dm, "am-9-refused-type");

      // Bytes after the MP4's last box: Chrome reads the first frame, and the server's header check refuses the file.
      const broken = Buffer.concat([readFileSync(MP4), Buffer.from([0, 0, 0])]);
      await input.setInputFiles({ name: "harbor.mp4", mimeType: "video/mp4", buffer: broken });
      await form.getByRole("button", { name: "Upload and create" }).click();
      await form.getByText(AMD_WORDS.badVideo, { exact: true }).waitFor({ timeout: 30_000 });
      assert.equal(puts.filter((u) => u.includes("kind=video")).length, 1, "the video went up once");
      assert.equal(puts.filter((u) => u.includes("kind=map")).length, 0, "no still went up for a refused video");
      assert.equal((await amd.assets()).length, before, "nothing left in the Library");
      assert.ok(!Object.values(dmSocket.state!.scenes).some((s) => s?.name === "harbor"), "no scene was made");
    } finally {
      dm.off("request", watch);
      consoles.dm.allow = allowed;
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  });

  test("hs-1. an iPhone's default HEVC MOV, its moov after the media, is refused on the device in the server's words with nothing sent (AMROT-O-06)", async () => {
    // The fixture script's writer (e2e/fixtures/README.md), so the bytes are made here and no video is downloaded.
    const { defaultSoundTrack, defaultVideoTrack, mp4File, visualEntry } = await import("../server/assets/video/videoTestutil.ts");
    const { checkVideoBytes } = await import("../server/assets/video/check.ts");
    // 3 MB with moov last, as an iPhone writes it, so the scan reads the first and last MiB apart.
    const samples = Array.from({ length: 60 }, () => ({ size: 50_000, delta: 512 }));
    const mov = mp4File({ brand: "qt  ", compatible: ["qt  "], moovLast: true, tracks: [defaultVideoTrack({ entry: visualEntry("hvc1", 1920, 1080, ""), samples }), defaultSoundTrack()] });
    assert.ok(mov.length > 2 * 1024 * 1024, `${mov.length} bytes`);
    const top: string[] = [];
    for (let at = 0; at < mov.length; at += mov.readUInt32BE(at)) top.push(mov.toString("latin1", at + 4, at + 8));
    assert.deepEqual(top, ["ftyp", "mdat", "moov"], "moov after the media");
    await assert.rejects(checkVideoBytes(mov), (err: { code?: string }) => err.code === "video_hevc", "the server refuses the same bytes as video_hevc");
    const before = (await amd.assets()).length;
    const form = await openSceneGroup(await amd.scenes(), "New scene");
    await form.getByRole("radio", { name: "Map image", exact: true }).click();
    const puts: string[] = [];
    const watch = (r: { method(): string; url(): string }) => {
      if (r.method() === "PUT" && r.url().includes("/assets?kind=")) puts.push(r.url());
    };
    dm.on("request", watch);
    try {
      await form.locator(VIDEO_PICKER).first().setInputFiles({ name: "IMG_0042.MOV", mimeType: "video/quicktime", buffer: mov });
      await form.getByRole("button", { name: "Upload and create" }).click();
      await form.getByText(AMD_WORDS.hevc, { exact: true }).waitFor();
      await shots.take(dm, "hs-1-refused-hevc");
      assert.equal(puts.length, 0, "nothing went up");
      assert.equal((await amd.assets()).length, before, "nothing in the Library");
      assert.equal(await form.getByRole("button", { name: "Upload and create" }).isEnabled(), true, "the form is ready for another file");
    } finally {
      dm.off("request", watch);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  });

  test("am-10. a device that cannot read the first frame: the video goes up, a still of another shape is refused by the server's facts, one of its shape makes the phase, and Low Power Mode's Try again reads it", async () => {
    const { noFrame: NO_FIRST_FRAME, lowPower: LOW_POWER_STOPPED } = AMD_WORDS;
    const crypt = await amd.view(run.cryptId);
    const group = await openSceneGroup(crypt, "Map and grid");
    const phaseCount = () => dmSocket.state!.scenes[run.cryptId]?.phases?.length ?? 1;
    const start = phaseCount();
    const add = group.getByLabel("Add a phase from an image", { exact: true });
    try {
      // amr-b: neither the picked file nor its stored copy can be read here (docs/design/design-v1-video-turns.md 8 step 5).
      await amd.probeRefuses(dm, "NotSupportedError", "any");
      await add.setInputFiles({ name: "crypt_night.mp4", mimeType: "video/mp4", buffer: readFileSync(MP4) });
      await group.getByText(NO_FIRST_FRAME, { exact: true }).waitFor({ timeout: 30_000 });
      await shots.take(dm, "am-10-pick-a-still");
      const pick = group.locator("label").filter({ hasText: "Pick a still image" }).locator('input[type="file"]');
      // A square still for a 16:9 video: the video goes up first, and its facts refuse the still.
      await pick.setInputFiles({ name: "square.png", mimeType: "image/png", buffer: await amd.png(500, 500) });
      await group.getByText("That image isn't the video's shape (16:9). Pick one the same shape.", { exact: true }).waitFor({ timeout: 30_000 });
      const rows = await amd.assets();
      const mp4Row = rows.find((r) => r.kind === "video" && r.video?.container === "mp4");
      assert.ok(mp4Row, "the video went up before the still was checked");
      await shots.take(dm, "am-10-still-shape");
      // One of its shape, at another size: the phase is the video over that still.
      await pick.setInputFiles({ name: "night.png", mimeType: "image/png", buffer: await amd.png(1280, 720, { r: 20, g: 24, b: 60 }) });
      await waitFor("the video phase", () => (phaseCount() === start + 1 ? true : null), 30_000);
      const phase = dmSocket.state!.scenes[run.cryptId]!.phases!.at(-1)!;
      assert.equal(phase.video?.assetId, mp4Row.id);
      assert.equal(phase.widthPx, 1280);
      assert.equal(phase.name, "crypt night");
      // The phase list says Video after its name.
      await group.getByRole("listitem").filter({ hasText: "crypt night" }).getByText("Video", { exact: true }).waitFor();
      assert.equal((await amd.assets()).filter((r) => r.kind === "video" && r.video?.container === "mp4").length, 1, "the video went up once for both stills");

      // amr-b: only the picked file cannot be read, as a MOV in Firefox: the still comes from the stored copy, with nothing asked.
      await amd.probeRefuses(dm, "NotSupportedError", "blob");
      await amd.recordLabels();
      await add.setInputFiles({ name: "crypt_dusk.webm", mimeType: "video/webm", buffer: readFileSync(WEBM) });
      await waitFor("the stored copy's phase", () => (phaseCount() === start + 2 ? true : null), 30_000);
      const dusk = dmSocket.state!.scenes[run.cryptId]!.phases!.at(-1)!;
      assert.equal(dusk.video?.assetId, run.webm!.id);
      assert.deepEqual([dusk.widthPx, dusk.heightPx], [640, 360], "the stored copy's frame is the still");
      const labels = await amd.labels();
      assert.equal(labels.filter((l) => l === "Reading the first frame…").length, 2, `the busy button reads the frame again: ${labels.join(" | ")}`);
      assert.equal(await group.getByText(NO_FIRST_FRAME, { exact: true }).count(), 0, "no still was asked for");

      // Low Power Mode refuses play(): Try again is a tap, which may start it.
      await amd.probeRefuses(dm, "NotAllowedError");
      await add.setInputFiles({ name: "crypt_flood.webm", mimeType: "video/webm", buffer: readFileSync(WEBM) });
      await group.getByText(LOW_POWER_STOPPED, { exact: true }).waitFor({ timeout: 30_000 });
      await shots.take(dm, "am-10-low-power");
      await amd.probeRefuses(dm, null);
      await group.getByRole("button", { name: "Try again", exact: true }).click();
      await waitFor("the third video phase", () => (phaseCount() === start + 3 ? true : null), 30_000);
      assert.equal(dmSocket.state!.scenes[run.cryptId]!.phases!.at(-1)!.video?.assetId, run.webm!.id);
    } finally {
      await amd.probeRefuses(dm, null);
    }
  });

  test("am-11. Use the still only drops the crypt's video in one Setup step and Undo brings it back, and the Library shows the video as a film strip that plays in its viewer while the board lets go", async () => {
    const crypt = await amd.view(run.cryptId);
    const group = await openSceneGroup(crypt, "Map and grid");
    const before = dmSocket.state!.scenes[run.cryptId]!.map!;
    assert.ok(before.video, "the crypt starts animated");
    await group.getByRole("button", { name: "Use the still only", exact: true }).click();
    await waitFor("the crypt's still alone", () => (dmSocket.state!.scenes[run.cryptId]!.map!.video ? null : true));
    const still = dmSocket.state!.scenes[run.cryptId]!.map!;
    assert.equal(still.assetId, before.assetId, "the still stays the map");
    assert.equal(still.cellPx, before.cellPx, "and keeps its grid");
    await group.getByText(`A ${still.widthPx} × ${still.heightPx} px image.`, { exact: true }).waitFor();
    assert.equal(await group.getByRole("button", { name: "Use the still only", exact: true }).count(), 0);
    const { undoSetup } = await import("./helpers/undoScope.ts");
    await undoSetup(dm);
    await waitFor("the crypt's video back", () => (dmSocket.state!.scenes[run.cryptId]!.map!.video?.assetId === before.video!.assetId ? true : null));

    // The Library: the video among the maps, a film strip with its length and In use.
    const { openSideTab, sideTabName } = await import("./harness.ts");
    await openSideTab(dm, "Library");
    const library = dm.getByRole("tabpanel", { name: sideTabName("Library") });
    const maps = library.getByRole("list", { name: "Maps in this room", exact: true });
    const tile = maps.getByRole("button", { name: "Animated map", exact: true }).first();
    await tile.waitFor();
    await maps.getByText("0:02", { exact: true }).first().waitFor();
    await shots.take(dm, "am-11-library-tile");
    await boardSays(dm, "playing");
    await tile.click();
    const viewer = dm.getByRole("dialog", { name: "Animated map", exact: true });
    await viewer.waitFor();
    await viewer.getByText(/^640 × 360 px, 0:02, .+\. In use\.$/).waitFor();
    // One element holds a video: the viewer's. The board's let go of its src first.
    await waitFor("the viewer's video playing", () =>
      viewer.evaluate((el) => {
        const v = (el as unknown as { querySelector(s: string): { currentTime: number; paused: boolean; hasAttribute(n: string): boolean } | null }).querySelector("video");
        return v && v.hasAttribute("src") && !v.paused && v.currentTime > 0 ? true : null;
      }),
    );
    const held = await probe(dm);
    assert.equal(held?.withSrc, 1, "only the viewer's element holds a src");
    await shots.take(dm, "am-11-library-viewer");
    await dm.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    // Closed, the board takes the decoder back.
    await boardSays(dm, "playing");
    // The room is left naming the MP4 only where the board lane's steps put it: am-12 counts a video the room names nowhere as new.
    const mp4 = (await amd.assets()).find((r) => r.kind === "video" && r.video?.container === "mp4");
    const cryptNow = dmSocket.state!.scenes[run.cryptId]!;
    if (mp4 && cryptNow.phases?.some((p) => p.video?.assetId === mp4.id)) {
      await ops.send({ t: "scene.update", sceneId: run.cryptId, patch: { phases: cryptNow.phases.filter((p) => p.video?.assetId !== mp4.id) } });
    }
    assert.deepEqual(consoles.dm.errors, [], "the DM's page logged no errors");
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

  test("amfix-1. on a light page the cover and the ground around the scene stay the board's dark ground, in Top-down and in Isometric", async () => {
    await setScheme(pat, "light");
    await boardSays(pat, "playing");
    const cover = await pat.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelector(s: string): unknown }; getComputedStyle(e: unknown): { backgroundColor: string } });
      const el = d.document.querySelector("[data-animmap-cover]");
      return el ? d.getComputedStyle(el).backgroundColor : null;
    });
    const size = pat.viewportSize()!;
    await pat.mouse.move(size.width / 2, size.height / 2);
    for (let i = 0; i < 8; i++) await pat.mouse.wheel(0, 240);
    await sleep(600);
    await shots.take(pat, "amfix-1-pat-light-zoomed-out");
    assert.equal(cover, "rgb(22, 22, 26)", "the cover paints the board's ground");
    const scene = await sceneBox(pat);
    const strips = [
      { x: 0, y: scene.y + scene.height / 2 - 20, width: Math.floor(scene.x) - 4, height: 40 },
      { x: Math.ceil(scene.x + scene.width) + 4, y: scene.y + scene.height / 2 - 20, width: size.width - Math.ceil(scene.x + scene.width) - 4, height: 40 },
    ].filter((b) => b.width >= 8 && b.height >= 8);
    assert.ok(strips.length > 0, `some ground shows around the scene: ${JSON.stringify(scene)}`);
    for (const strip of strips) assert.equal(await offColor(pat, strip, GROUND), 0, `only the dark ground outside the scene at ${JSON.stringify(strip)}`);
    await viewAs(pat, "isometric");
    await boardSays(pat, "still still-view");
    await shots.take(pat, "amfix-1-pat-light-isometric");
    assert.equal(await offColor(pat, { x: 4, y: 140, width: 30, height: 30 }, GROUND), 0, "the dark ground at the screen's edge in Isometric");
    await viewAs(pat, "topDown");
    await setScheme(pat, "dark");
    await boardSays(pat, "playing");
  });

  /*
   * pe1-1: the Map image row's lines (docs/design/design-v1-polish-pass.md
   * 3.3) on the crypt, where the players are not, and on their scene, folded
   * and asked, on the computer and on the smallest phone at 130%. Use the
   * still only stands last on the picker's line and Remove map image alone
   * on the last, each line filled, and Remove's second tap moves no other
   * button: its armed words stay on one line where the line holds them,
   * and wrap inside it where it does not, its top unmoved.
   */
  type Control = { words: string; l: number; r: number; t: number; b: number; lines: number; over: boolean; lineL: number; lineR: number };
  /** The Map image row's buttons and file pickers as they lay out, each with its words' line count, whether they overflow it, and the line of buttons it stands in. */
  const controlsOf = (row: Locator): Promise<Control[]> =>
    row.evaluate((el) => {
      type R = { left: number; right: number; top: number; bottom: number; width: number; height: number };
      type E = { getBoundingClientRect(): R; parentElement: E | null; textContent: string | null; scrollWidth: number; clientWidth: number; contains(o: E): boolean; querySelectorAll(s: string): ArrayLike<E> };
      type Doc = { createRange(): { selectNodeContents(n: unknown): void; getClientRects(): ArrayLike<R> }; createTreeWalker(root: unknown, what: number): { nextNode(): E | null } };
      const g = globalThis as unknown as { document: Doc; getComputedStyle(e: E): { display: string; flexWrap: string } };
      const found = Array.from((el as unknown as E).querySelectorAll('button, label:has(input[type="file"])')).filter((c) => c.getBoundingClientRect().width > 2 && c.getBoundingClientRect().height > 2);
      const controls = found.filter((c) => !found.some((o) => o !== c && o.contains(c)));
      return controls.map((c) => {
        const box = c.getBoundingClientRect();
        const tops: number[] = [];
        const walker = g.document.createTreeWalker(c, 4);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!(n.textContent ?? "").trim()) continue;
          const range = g.document.createRange();
          range.selectNodeContents(n);
          for (const r of Array.from(range.getClientRects())) if (r.width > 1 && r.height > 1) tops.push(r.top);
        }
        tops.sort((a, b) => a - b);
        // The line of buttons it stands in: the nearest flex row that wraps (SceneSettings.tsx Row).
        let line = c.parentElement;
        while (line && !(g.getComputedStyle(line).display === "flex" && g.getComputedStyle(line).flexWrap === "wrap")) line = line.parentElement;
        const lb = (line ?? c).getBoundingClientRect();
        return { words: (c.textContent ?? "").trim(), l: box.left, r: box.right, t: box.top, b: box.bottom, lines: tops.filter((t, i) => i === 0 || t > tops[i - 1]! + 4).length, over: c.scrollWidth > c.clientWidth + 1, lineL: lb.left, lineR: lb.right };
      });
    });
  /** The controls by the line they lay out on, top to bottom, each line's words in order. */
  const linesOf = (controls: readonly Control[]): Control[][] => {
    const out: Control[][] = [];
    for (const c of [...controls].sort((a, b) => a.t - b.t || a.l - b.l)) {
      const last = out.at(-1);
      if (last && Math.abs(last[0]!.t - c.t) < 2) last.push(c);
      else out.push([c]);
    }
    return out;
  };
  /** Lines naming what is out of place: the lines' words against `want`, and each line but Cancel's filled from its line's start to its end. */
  const checkLines = (controls: readonly Control[], want: readonly (readonly string[])[], at: string): string[] => {
    const got = linesOf(controls);
    const words = got.map((line) => line.map((c) => c.words));
    if (JSON.stringify(words) !== JSON.stringify(want)) return [`${at}: lines ${JSON.stringify(words)}, wanted ${JSON.stringify(want)}`];
    const out: string[] = [];
    for (const line of got) {
      if (line[0]!.words === "Cancel") continue;
      const first = line[0]!;
      const last = line.at(-1)!;
      if (Math.abs(first.l - first.lineL) > 1 || Math.abs(last.r - last.lineR) > 1) out.push(`${at}: the line ${JSON.stringify(line.map((c) => c.words))} spans ${first.l.toFixed(1)} to ${last.r.toFixed(1)} of ${first.lineL.toFixed(1)} to ${last.lineR.toFixed(1)}`);
    }
    for (const c of controls) if (c.lines !== 1 || c.over) out.push(`${at}: "${c.words}" takes ${c.lines} lines${c.over ? " and overflows" : ""}`);
    return out;
  };
  /** Arms Remove map image with one tap, reads the row, and waits for it to disarm by itself: lines naming a button it moved, and Remove's words not laid out as `wrapped` says. */
  const armRemove = async (row: Locator, wrapped: boolean, at: string, page: Page): Promise<string[]> => {
    // In view first, so the tap scrolls nothing and every box stays where it was read.
    await row.getByRole("button", { name: "Remove map image", exact: true }).scrollIntoViewIfNeeded();
    const before = await controlsOf(row);
    await row.getByRole("button", { name: "Remove map image", exact: true }).click();
    const armed = row.getByRole("button", { name: /^Tap again to remove/ });
    await armed.waitFor();
    const after = await controlsOf(row);
    await shots.take(page, `pe1-1-remove-armed-${at.replace(/[^a-z0-9]+/gi, "-")}`);
    // Left alone, it disarms after 4 s (scenes/controls.tsx ConfirmButton), so the next step starts unarmed.
    await row.getByRole("button", { name: "Remove map image", exact: true }).waitFor({ timeout: 8_000 });
    const out: string[] = [];
    const remove = after.find((c) => c.words.startsWith("Tap again to remove"));
    const was = before.find((c) => c.words === "Remove map image");
    if (!remove || !was || before.length !== after.length) return [`${at}: armed, the row reads ${JSON.stringify(after.map((c) => c.words))}`];
    for (const [i, c] of before.entries()) {
      if (c === was) continue;
      const now = after[i]!;
      const moved = Math.max(Math.abs(now.l - c.l), Math.abs(now.r - c.r), Math.abs(now.t - c.t), Math.abs(now.b - c.b));
      if (now.words !== c.words || moved >= 0.5) out.push(`${at}: arming Remove moved "${c.words}" by ${moved.toFixed(2)} px`);
    }
    if (Math.abs(remove.t - was.t) >= 0.5) out.push(`${at}: Remove's top moved by ${(remove.t - was.t).toFixed(2)} px`);
    if (remove.lines !== (wrapped ? 2 : 1) || remove.over) out.push(`${at}: "${remove.words}" takes ${remove.lines} lines${remove.over ? " and overflows" : ""}, wanted ${wrapped ? 2 : 1}`);
    if (remove.r > remove.lineR + 1) out.push(`${at}: "${remove.words}" ends ${(remove.r - remove.lineR).toFixed(1)} px past its line`);
    return out;
  };
  const mapImageRow = (group: Locator) => group.locator("[data-setting-row]").filter({ has: group.page().getByText("Map image", { exact: true }) }).first();

  test("pe1-1. the Map image row on the computer and the smallest phone at 130%: Use the still only last on the picker's line and Remove map image alone on the last, each filled, where the players are and where they are not, asked and not, and Remove's second tap moves no other button", async () => {
    const back = dmSocket.you?.sceneId ?? run.sceneId;
    const phases = dmSocket.state!.scenes[run.cryptId]?.phases?.length ?? 1;
    assert.ok(phases >= 2, `the crypt keeps am-10's phases, so Remove's second tap names them: ${phases}`);
    assert.ok(dmSocket.state!.scenes[run.sceneId]?.map?.video && !dmSocket.state!.scenes[run.sceneId]?.phases?.length, "the players' scene is am-2's animated map, one phase");
    const lines: string[] = [];
    const phone = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await dmContext.storageState() });
    const watch = new ConsoleWatch("pe1 phone");
    try {
      // The computer: the crypt, where the players are not.
      let group = await openSceneGroup(await amd.view(run.cryptId), "Map and grid");
      let row = mapImageRow(group);
      await row.getByRole("button", { name: "Use the still only", exact: true }).waitFor();
      await row.scrollIntoViewIfNeeded();
      lines.push(...checkLines(await controlsOf(row), [["Replace map image", "Paste an image"], ["Use the still only"], ["Remove map image"]], "computer, players elsewhere"));
      await shots.take(dm, "pe1-1-map-image-elsewhere");
      lines.push(...(await armRemove(row, false, "computer, players elsewhere", dm)));
      // The players' scene: the ask, then its answers once asked.
      group = await openSceneGroup(await amd.view(run.sceneId), "Map and grid");
      row = mapImageRow(group);
      await row.getByRole("button", { name: "Use the still only", exact: true }).waitFor();
      await row.scrollIntoViewIfNeeded();
      lines.push(...checkLines(await controlsOf(row), [["Replace map image", "Use the still only"], ["Remove map image"]], "computer, players here"));
      await row.getByRole("button", { name: "Replace map image", exact: true }).click();
      await row.getByText(/^The players are on this scene\./).waitFor();
      lines.push(...checkLines(await controlsOf(row), [["Choose the image", "Paste an image"], ["Use the still only"], ["Cancel"], ["Remove map image"]], "computer, players here, asked"));
      await shots.take(dm, "pe1-1-map-image-asked");
      lines.push(...(await armRemove(row, false, "computer, players here, asked", dm)));
      await row.getByRole("button", { name: "Cancel", exact: true }).click();

      // The smallest phone at 130%: each button takes its own full line, and the crypt's Remove wraps its phases inside its own.
      const page = await phone.newPage();
      watch.attach(page);
      await page.goto(`${server.origin}/`);
      await page.evaluate(() => localStorage.setItem("rvtt.uiScale", "1.3"));
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.getByRole("status", { name: "Connected" }).first().waitFor();
      const scenes = async () => {
        const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Scenes"]');
        if (!(await sheet.isVisible())) {
          await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
          await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Scenes/ }).click();
          await sheet.waitFor();
        }
        return sheet;
      };
      const view = async (sceneId: string) => {
        const name = dmSocket.state!.scenes[sceneId]!.name;
        await (await scenes()).getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
        // A phone may put the sheet away to show the scene, so it is found again.
        const field = (await scenes()).getByRole("textbox", { name: "Scene name" }).last();
        await waitFor(`${name}'s settings on the phone`, async () => ((await field.inputValue({ timeout: 1_000 }).catch(() => "")) === name ? true : null));
        const map = mapImageRow(await openSceneGroup(await scenes(), "Map and grid"));
        await map.getByRole("button", { name: "Use the still only", exact: true }).waitFor();
        await map.scrollIntoViewIfNeeded();
        return map;
      };
      row = await view(run.cryptId);
      lines.push(...checkLines(await controlsOf(row), [["Replace map image"], ["Paste an image"], ["Use the still only"], ["Remove map image"]], "320 at 130%, players elsewhere"));
      await shots.take(page, "pe1-1-map-image-elsewhere-320-130");
      lines.push(...(await armRemove(row, true, `320 at 130%, players elsewhere, ${phases} phases`, page)));
      row = await view(run.sceneId);
      lines.push(...checkLines(await controlsOf(row), [["Replace map image"], ["Use the still only"], ["Remove map image"]], "320 at 130%, players here"));
      await row.getByRole("button", { name: "Replace map image", exact: true }).click();
      await row.getByText(/^The players are on this scene\./).waitFor();
      lines.push(...checkLines(await controlsOf(row), [["Choose the image"], ["Paste an image"], ["Use the still only"], ["Cancel"], ["Remove map image"]], "320 at 130%, players here, asked"));
      await shots.take(page, "pe1-1-map-image-asked-320-130");
      lines.push(...(await armRemove(row, false, "320 at 130%, players here, asked", page)));
      await row.getByRole("button", { name: "Cancel", exact: true }).click();
    } finally {
      await phone.close();
      await amd.view(back);
    }
    assert.deepEqual(lines, []);
    assert.deepEqual(watch.errors, [], "the phone page logged no errors");
    assert.ok(dmSocket.state!.scenes[run.cryptId]?.map && dmSocket.state!.scenes[run.sceneId]?.map, "no second tap removed a map");
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
    await openGroup(lowMenu, "Battery");
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

  /*
   * Lane AR-B's steps (amr-1 to amr-7, docs/design/design-v1-video-turns.md
   * 14): each turned, mirrored or stretched fixture becomes a new scene's
   * map through the New scene form, so its still is read from the stored
   * copy. The map layer is sampled where the pattern's first bar, last bar
   * and dark strip must show once the file's own turn and stretch apply,
   * under Still and then Moving, and the two must agree. amr-1, amr-3 and
   * amr-7 also check the colors there, so a placement bug the still and the
   * board share cannot pass. They run in a second DM session, signed in by
   * the DM link, since their uploads would spend the first session's 30
   * uploads an hour that am-12 still needs.
   */
  const AMR = {
    turn90: path.join(FIXTURES, "map-turn-90.mp4"),
    turn180: path.join(FIXTURES, "map-turn-180.mp4"),
    turn270Mirror: path.join(FIXTURES, "map-turn-270-mirror.mp4"),
    wideMp4: path.join(FIXTURES, "map-wide.mp4"),
    wideWebm: path.join(FIXTURES, "map-wide.webm"),
    clap: path.join(FIXTURES, "map-clap.mp4"),
    iphone: path.join(FIXTURES, "map-iphone.mov"),
  };
  /** Spots of the 640 × 360 pattern (scripts/video-fixtures.ts): the first bar, the last bar, and the dark strip above the square's path. */
  const AMR_SPOTS = [
    { name: "first bar", x: 45, y: 135, rgb: { r: 0xc0, g: 0xc0, b: 0xc0 } },
    { name: "last bar", x: 595, y: 135, rgb: { r: 0x00, g: 0x00, b: 0xc0 } },
    { name: "strip", x: 320, y: 280, rgb: { r: 0x10, g: 0x10, b: 0x10 } },
  ];
  /** H.264 and VP9 at this size, then the still's own encode, move a color this far at most. */
  const AMR_TOLERANCE = 32;
  const amrSocket = new SocketWatch("dm-amr");
  const amrConsole = new ConsoleWatch("dm-amr");
  /** The second DM session's page (amr-0). */
  let adm: Page;
  type AmrVideo = { widthPx: number; heightPx: number; turn?: 90 | 180 | 270; mirror?: true; displayWidthPx?: number };
  const amr = {
    /** Shows the second DM session a scene from its row in the list, and waits for its settings to name it. */
    async view(sceneId: string) {
      const panel = await amd.scenes(adm);
      const name = amrSocket.state?.scenes[sceneId]?.name ?? "";
      await panel.getByRole("button", { name: new RegExp(`^${name}(?![A-Za-z])`) }).first().click();
      await waitFor(`the DM on ${name}`, () => amrSocket.you?.sceneId === sceneId || null);
      const field = panel.getByRole("textbox", { name: "Scene name" }).last();
      await waitFor(`${name}'s settings`, async () => ((await field.inputValue()) === name ? true : null));
      return panel;
    },
    /** Where a spot of the coded frame shows in the drawn picture, as a fraction of it, by the table's matrix row and its stretch. */
    async spotAt(video: AmrVideo, x: number, y: number): Promise<{ fx: number; fy: number }> {
      const { drawnSize, matrixRow, orientationOf, rowShift } = await import("../shared/videoGeometry.ts");
      const w = video.displayWidthPx ?? video.widthPx;
      const h = video.heightPx;
      const px = (x * w) / video.widthPx;
      const row = matrixRow(orientationOf(video));
      const [tx, ty] = rowShift(row, w, h);
      const drawn = drawnSize(video);
      return { fx: (row.a * px + row.c * y + tx) / drawn.widthPx, fy: (row.b * px + row.d * y + ty) / drawn.heightPx };
    },
    /** The median color of a 9 × 9 box around a page point, clear of the grid's thin lines. */
    async colorAt(page: Page, p: { x: number; y: number }): Promise<{ r: number; g: number; b: number }> {
      const { data, count } = await pixels(page, { x: Math.round(p.x) - 4, y: Math.round(p.y) - 4, width: 9, height: 9 });
      const channel = (c: number) => {
        const values = Array.from({ length: count }, (_, i) => data[i * 3 + c]!).sort((a, b) => a - b);
        return values[Math.floor(count / 2)]!;
      };
      return { r: channel(0), g: channel(1), b: channel(2) };
    },
    /** The three spots' colors on the board's map layer. */
    async sample(page: Page, map: { widthPx: number; heightPx: number; cellPx: number; video: AmrVideo }): Promise<{ r: number; g: number; b: number }[]> {
      const out: { r: number; g: number; b: number }[] = [];
      for (const spot of AMR_SPOTS) {
        const { fx, fy } = await amr.spotAt(map.video, spot.x, spot.y);
        const p = await pagePoint(page, BOUNDS, { x: (fx * map.widthPx) / map.cellPx, y: (fy * map.heightPx) / map.cellPx });
        out.push(await amr.colorAt(page, p));
      }
      return out;
    },
    near(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): boolean {
      return Math.abs(a.r - b.r) <= AMR_TOLERANCE && Math.abs(a.g - b.g) <= AMR_TOLERANCE && Math.abs(a.b - b.b) <= AMR_TOLERANCE;
    },
    /** This device's Animated maps, through the Menu. */
    async choose(page: Page, choice: "Still" | "Moving") {
      const menu = await openThisDevice(page);
      await menu.getByRole("group", { name: "Animated maps" }).getByRole("radio", { name: choice, exact: true }).check();
      await closeMenu(page);
    },
    /**
     * Adds `file` as a new scene's map through the New scene form, the way a
     * DM picks it, and checks the facts and the three spots under Still and
     * then Moving. Returns the scene and its map.
     */
    async addAndCheck(label: string, file: string, as: { name: string; mimeType: string }, facts: { turn?: 90 | 180 | 270; mirror?: true; displayWidthPx?: number; container: "mp4" | "webm" }, drawn: [number, number], upright: boolean) {
      const known = new Set(Object.keys(amrSocket.state!.scenes));
      const panel = await amd.scenes(adm);
      const form = await openSceneGroup(panel, "New scene");
      await form.getByRole("radio", { name: "Map image", exact: true }).click();
      const sceneName = `Turned ${label}`;
      await form.getByRole("textbox", { name: "Scene name" }).fill(sceneName);
      await form.locator(VIDEO_PICKER).first().setInputFiles({ ...as, buffer: readFileSync(file) });
      await amd.recordLabels(adm);
      await form.getByRole("button", { name: "Upload and create" }).click();
      const made = await waitFor(`the ${label} scene with its video`, () => Object.values(amrSocket.state!.scenes).find((sc) => sc && !known.has(sc.id) && sc.name === sceneName && sc.map?.video), 60_000);
      const map = made.map!;
      const video = map.video!;
      assert.equal(video.container, facts.container, `${label}: stored as ${facts.container}`);
      assert.deepEqual([video.widthPx, video.heightPx], [640, 360], `${label}: the coded size`);
      assert.equal(video.turn, facts.turn, `${label}: turn`);
      assert.equal(video.mirror, facts.mirror, `${label}: mirror`);
      assert.equal(video.displayWidthPx, facts.displayWidthPx, `${label}: stretched width`);
      assert.deepEqual([map.widthPx, map.heightPx], drawn, `${label}: the still is the stored copy's frame at the drawn size`);
      const labels = await amd.labels(adm);
      // Read on this device first, then, for a file that is not plain, from the stored copy (docs/design/design-v1-video-turns.md 8).
      assert.equal(labels.filter((l) => l === "Reading the first frame…").length, 2, labels.join(" | "));
      await waitFor(`the DM on ${sceneName}`, () => amrSocket.you?.sceneId === made.id || null);
      // Fog would tint the DM's view of the colors, so this scene has none.
      await ops.send({ t: "scene.update", sceneId: made.id, patch: { fogEnabled: false } });
      await pickTool(adm, "Select");
      await adm.locator("[data-toast]").first().waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
      const shaped = { widthPx: map.widthPx, heightPx: map.heightPx, cellPx: map.cellPx, video };

      await amr.choose(adm, "Still");
      await boardSays(adm, "still setting");
      await sleep(300);
      const still = await amr.sample(adm, shaped);
      await shots.take(adm, `amr-${label}-still`);
      await amr.choose(adm, "Moving");
      await boardSays(adm, "playing");
      await sleep(500);
      const moving = await amr.sample(adm, shaped);
      await shots.take(adm, `amr-${label}-moving`);
      for (const [i, spot] of AMR_SPOTS.entries()) {
        assert.ok(amr.near(still[i]!, moving[i]!), `${label} ${spot.name}: the still ${JSON.stringify(still[i])} and the video ${JSON.stringify(moving[i])} disagree`);
        if (upright) {
          assert.ok(amr.near(still[i]!, spot.rgb), `${label} ${spot.name}: the still shows ${JSON.stringify(still[i])}, not upright ${JSON.stringify(spot.rgb)}`);
          assert.ok(amr.near(moving[i]!, spot.rgb), `${label} ${spot.name}: the video shows ${JSON.stringify(moving[i])}, not upright ${JSON.stringify(spot.rgb)}`);
        }
      }
      return { scene: made, map };
    },
  };

  test("amr-0. a second DM session, signed in by the DM link on a computer", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(HOOK_FLAG);
    await context.addInitScript(SOURCE_WATCH);
    adm = await context.newPage();
    amrConsole.attach(adm);
    await amrSocket.attach(context, adm);
    // Signing in by the link asks who this is, after a 403 for the unknown session and a 409 for the DM already signed in elsewhere.
    amrConsole.allow = [/status of 403 .*\/api\/rooms\/[0-9A-Z]{8}\/me\)$/, /status of 409 .*\/api\/rooms\/[0-9A-Z]{8}\/dm\)$/];
    await adm.goto(run.dmLink);
    await adm.getByRole("button", { name: /Dana the DM/ }).click();
    await waitFor("the second session's snapshot", () => amrSocket.state);
    assert.equal(amrSocket.you?.memberId, dmSocket.you?.memberId, "the same DM");
    amrConsole.allow = [];
    await adm.locator(".konvajs-content").first().waitFor();
  });

  test("amr-1. an Android portrait video, the 90 row: the map and its still show it upright at 360 × 640, the Map image row names that size, and the Library viewer turns it into an upright page", async () => {
    const { scene, map } = await amr.addAndCheck("90", AMR.turn90, { name: "tower.mp4", mimeType: "video/mp4" }, { turn: 90, container: "mp4" }, [360, 640], true);
    assert.equal(map.video!.turn, 90);
    // The board draws the frame turned: the Konva image's own rotation.
    const rotation = await adm.evaluate(() => {
      type Node = { getClassName(): string; image?(): unknown; rotation(): number };
      const konva = (globalThis as unknown as { Konva?: { stages: { visible(): boolean; width(): number; getLayers(): { find(f: (n: Node) => boolean): Node[] }[] }[] } }).Konva;
      for (const stage of konva?.stages ?? []) {
        if (!stage.visible() || stage.width() === 0) continue;
        const image = stage.getLayers()[0]?.find((n) => n.getClassName() === "Image" && (n.image?.() as { tagName?: string } | undefined)?.tagName === "VIDEO")[0];
        if (image) return image.rotation();
      }
      return null;
    });
    assert.equal(rotation, 90, "the map layer turns the video's frame");
    const scenes = await amr.view(scene.id);
    const group = await openSceneGroup(scenes, "Map and grid");
    await group.getByText("A 360 × 640 px video, 0:02, looping. Its first frame is the still.", { exact: true }).waitFor();
    await shots.take(adm, "amr-1-map-image-row");

    // The Library viewer: the tile whose line names the drawn size.
    const { openSideTab, sideTabName } = await import("./harness.ts");
    await openSideTab(adm, "Library");
    const library = adm.getByRole("tabpanel", { name: sideTabName("Library") });
    const tiles = library.getByRole("list", { name: "Maps in this room", exact: true }).getByRole("button", { name: /^Animated map/ });
    await tiles.first().waitFor();
    let viewer: Locator | null = null;
    for (let i = 0; i < (await tiles.count()) && !viewer; i++) {
      await tiles.nth(i).click();
      const open = adm.getByRole("dialog", { name: "Animated map", exact: true });
      await open.waitFor();
      if ((await open.getByText(/^360 × 640 px, 0:02, /).count()) > 0) viewer = open;
      else {
        await adm.keyboard.press("Escape");
        await open.waitFor({ state: "detached" });
      }
    }
    assert.ok(viewer, "a tile opens the turned video, its line naming 360 × 640");
    const box = await waitFor("the viewer's video playing", () =>
      viewer!.evaluate((el) => {
        type V = { currentTime: number; paused: boolean; hasAttribute(n: string): boolean; getBoundingClientRect(): { x: number; y: number; width: number; height: number }; style: { transform: string } };
        const v = (el as unknown as { querySelector(s: string): V | null }).querySelector("video");
        if (!v || !v.hasAttribute("src") || v.paused || v.currentTime <= 0) return null;
        const r = v.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, transform: v.style.transform };
      }),
    );
    assert.equal(box.transform, "matrix(0, 1, -1, 0, 0, 0)", "the element turns as the table's 90 row");
    assert.ok(Math.abs(box.height / box.width - 640 / 360) < 0.02, `its box on screen is the upright page: ${JSON.stringify(box)}`);
    await sleep(300);
    for (const spot of AMR_SPOTS) {
      const { fx, fy } = await amr.spotAt(map.video!, spot.x, spot.y);
      const color = await amr.colorAt(adm, { x: box.x + fx * box.width, y: box.y + fy * box.height });
      assert.ok(amr.near(color, spot.rgb), `the viewer's ${spot.name} shows ${JSON.stringify(color)}, not upright ${JSON.stringify(spot.rgb)}`);
    }
    await shots.take(adm, "amr-1-library-viewer");
    await adm.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    await boardSays(adm, "playing");
  });

  test("amr-2. Apple's 180 row, moved back into view by the picture's width and height: the still and the video agree", async () => {
    await amr.addAndCheck("180", AMR.turn180, { name: "harbor.mp4", mimeType: "video/mp4" }, { turn: 180, container: "mp4" }, [640, 360], false);
  });

  test("amr-3. FFmpeg's 270 and then a mirror: the map and its still show it upright at 360 × 640", async () => {
    await amr.addAndCheck("270-mirror", AMR.turn270Mirror, { name: "mirror.mp4", mimeType: "video/mp4" }, { turn: 270, mirror: true, container: "mp4" }, [360, 640], true);
  });

  test("amr-4. an MP4 with a pasp of 4:3 shows stretched to 853 × 360, the still and the video alike", async () => {
    await amr.addAndCheck("wide-mp4", AMR.wideMp4, { name: "wide.mp4", mimeType: "video/mp4" }, { displayWidthPx: 853, container: "mp4" }, [853, 360], false);
  });

  test("amr-5. a WebM with DisplayWidth 853 shows stretched to 853 × 360, the still and the video alike", async () => {
    await amr.addAndCheck("wide-webm", AMR.wideWebm, { name: "wide.webm", mimeType: "video/webm" }, { displayWidthPx: 853, container: "webm" }, [853, 360], false);
  });

  test("amr-6. a video whose clap crops its picture is refused in 4.4's words, and leaves nothing behind", async () => {
    const before = (await amd.assets()).length;
    const panel = await amd.scenes(adm);
    const form = await openSceneGroup(panel, "New scene");
    await form.getByRole("radio", { name: "Map image", exact: true }).click();
    const allowed = amrConsole.allow;
    amrConsole.allow = [...allowed, /status of 422 .*kind=video&name=cropped\.mp4/];
    try {
      await form.locator(VIDEO_PICKER).first().setInputFiles({ name: "cropped.mp4", mimeType: "video/mp4", buffer: readFileSync(AMR.clap) });
      await form.getByRole("button", { name: "Upload and create" }).click();
      await form.getByText(AMD_WORDS.geometry, { exact: true }).waitFor({ timeout: 30_000 });
      await shots.take(adm, "amr-6-refused-clap");
      assert.equal((await amd.assets()).length, before, "nothing left in the Library");
    } finally {
      amrConsole.allow = allowed;
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
    }
  });

  test("amr-7. an iPhone's Most Compatible MOV, picked as video/quicktime, is stored as an MP4 and shows upright at 360 × 640", async () => {
    const form = await openSceneGroup(await amd.scenes(adm), "New scene");
    await form.getByRole("radio", { name: "Map image", exact: true }).click();
    const accept = await form.locator(VIDEO_PICKER).first().getAttribute("accept");
    assert.ok(accept?.includes("video/quicktime") && accept.includes(".mov"), `the picker takes a MOV: ${accept}`);
    await amr.addAndCheck("iphone", AMR.iphone, { name: "IMG_0042.MOV", mimeType: "video/quicktime" }, { turn: 90, container: "mp4" }, [360, 640], true);
    const row = (await amd.assets()).find((r) => r.kind === "video" && r.video?.turn === 90 && r.video?.container === "mp4" && r.id === amrSocket.state!.scenes[amrSocket.you!.sceneId!]!.map!.video!.assetId);
    assert.ok(row, "the room's row is an MP4");
    const bytes = await dmContext.request.get(`${server.origin}/api/assets/${row.id}/full`);
    assert.equal(bytes.headers()["content-type"], "video/mp4", "served as an MP4");
    // Back on the players' scene, where am-12 begins.
    await amr.view(run.sceneId);
    assert.deepEqual(amrConsole.errors, [], "the second DM page logged no errors");
    await adm.context().close();
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
