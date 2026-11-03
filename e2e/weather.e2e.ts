import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { ConsoleWatch, OpSocket, openSideTab, pagePoint, pickTool, ROOT, Shots, sideTabName, sleep, SocketWatch, startServer, waitFor, type Server } from "./harness.ts";

/**
 * Weather over the map (docs/design/design-v1-weather.md, lane WX-C): the
 * layer, its one clock and where it sits, This device's choice, the table
 * display's menu, and the places it waits. Weather is set through the DM's
 * socket, so no step needs the DM's fold (WX-D's steps drive that).
 *
 * The weather canvas is read through its test hooks
 * (features/weather/WeatherLayer.tsx): `data-weather` ("rain heavy strong",
 * set on a change), and the `weatherTicks` and `weatherCameraDraws`
 * properties, counted apart.
 *
 * The map is the starter Cavern Battlemap (public/starter, CC0), 2,000 px
 * at 50 px a square. A DM on a computer, Pat on a phone held upright at
 * 3x, and a TV.
 *
 * It runs with `pnpm test:e2e` on its own port, E2E_PORT plus 33. The other
 * environment variables are the smoke run's (smoke.e2e.ts).
 */

const PORT = Number(process.env.E2E_PORT ?? 3100) + 33;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? "test-results/e2e-screenshots";

const work = mkdtempSync(path.join(tmpdir(), "raccoon-e2e-weather-"));
const assetDir = path.join(work, "assets");
const shots = new Shots(SHOT_DIR === "0" ? null : SHOT_DIR);

/** Set before the app's first script: it installs the hook that picks and turns the view without the menu (relief/isoTest.ts). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";
const BOUNDS = { w: 40, h: 40 };
const TV = { width: 1280, height: 720 };

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
  roomName: `E2E weather ${new Date().toISOString().slice(0, 19)}`,
  password: "",
  sceneId: "",
  cryptId: randomUUID(),
  patId: "",
  area: randomUUID(),
  trap: randomUUID(),
};

type Weather = { kind: string; heavy?: true; wind?: "moderate" | "strong"; toward?: number; rules?: false } | null;

async function setWeather(sceneId: string, weather: Weather): Promise<void> {
  await ops.send({ t: "scene.update", sceneId, patch: { weather } });
}

/** What a page's weather canvas says, the one in the View as a player dialog or the room's own, or null when none is mounted. */
type Probe = { key: string; ticks: number; cameraDraws: number; index: number; layers: number; ratio: number; shown: boolean; width: number };

function probe(page: Page, where: "room" | "preview" = "room"): Promise<Probe | null> {
  return page.evaluate((inPreview) => {
    type Layer = { getCanvas(): { _canvas: unknown; getPixelRatio(): number } };
    type Stage = { getLayers(): Layer[]; visible(): boolean; width(): number; container(): { closest(s: string): unknown } };
    const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
    for (const stage of konva?.stages ?? []) {
      if (Boolean(stage.container().closest("dialog[aria-label^='Viewing as']")) !== inPreview) continue;
      const layers = stage.getLayers();
      const index = layers.findIndex((l) => (l.getCanvas()._canvas as { dataset: Record<string, string> }).dataset.weather !== undefined);
      if (index < 0) continue;
      const canvas = layers[index]!.getCanvas()._canvas as { dataset: Record<string, string>; weatherTicks?: number; weatherCameraDraws?: number };
      // The hidden tree keeps its layer mounted, unregistered: the one that shows is the one asked for.
      if (!stage.visible() || stage.width() === 0) continue;
      return { key: canvas.dataset.weather!, ticks: canvas.weatherTicks ?? 0, cameraDraws: canvas.weatherCameraDraws ?? 0, index, layers: layers.length, ratio: layers[index]!.getCanvas().getPixelRatio(), shown: true, width: stage.width() };
    }
    return null;
  }, where === "preview");
}

/** Every weather canvas on the page, hidden trees' included. */
function weatherCanvases(page: Page): Promise<number> {
  return page.locator("canvas[data-weather]").count();
}

async function shown(page: Page, key: string, where: "room" | "preview" = "room"): Promise<Probe> {
  return waitFor(`${key} on the page`, async () => {
    const p = await probe(page, where);
    return p && p.key === key ? p : null;
  });
}

/** Ticks over `ms`, read from the canvas. */
async function ticksOver(page: Page, ms: number, where: "room" | "preview" = "room"): Promise<{ ticks: number; cameraDraws: number }> {
  const a = await probe(page, where);
  await sleep(ms);
  const b = await probe(page, where);
  assert.ok(a && b, "a weather canvas through the count");
  return { ticks: b.ticks - a.ticks, cameraDraws: b.cameraDraws - a.cameraDraws };
}

/** A zoom by the wheel over the map's middle: a camera change, as a pan is. */
async function zoomOnce(page: Page, dy = -120): Promise<void> {
  const size = page.viewportSize()!;
  await page.mouse.move(size.width / 2, size.height / 2);
  await page.mouse.wheel(0, dy);
  await sleep(150);
}

async function viewAs(page: Page, view: "topDown" | "isometric", turn = 0): Promise<void> {
  await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
  await page.evaluate(
    ([v, t]) => {
      const hook = (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void; turn(t: number): void } }).__rvttIsoHook;
      hook.pick(v);
      if (v === "isometric") hook.turn(t);
    },
    [view, turn] as const,
  );
  await sleep(400);
}

async function join(context: BrowserContext, name: string, color: string): Promise<string> {
  const headers = { Origin: server.origin, "content-type": "application/json" };
  const joined = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join`, { headers, data: { password: run.password } });
  assert.ok(joined.ok(), `joining answered ${joined.status()}`);
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await context.request.post(`${server.origin}/api/rooms/${run.roomId}/join/complete`, { headers, data: { ticket, name, color } });
  assert.ok(done.ok(), `completing the join answered ${done.status()}`);
  return ((await done.json()) as { member: { id: string } }).member.id;
}

/** The starter cavern, uploaded as a map of the DM's. */
async function uploadCavern() {
  const data = await sharp(readFileSync(path.join(ROOT, "public", "starter", "cavern-battlemap", "fe-01.webp"))).png().toBuffer();
  const res = await dmContext.request.put(`${server.origin}/api/rooms/${run.roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
  assert.ok(res.ok(), `the upload answered ${res.status()}`);
  const row = (await res.json()) as { id: string; width: number; height: number };
  return { assetId: row.id, widthPx: row.width, heightPx: row.height, cellPx: 50, originPx: { x: 0, y: 0 } };
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
  // The Menu may still stand on This device from the last visit: its header, with Back to Menu, is outside the panel's body.
  if (await menu.getByRole("group", { name: "Weather on the map" }).isVisible()) return menu;
  const back = page.getByRole("button", { name: /^Back to Menu/ });
  if (await back.isVisible()) await back.click();
  await menu.getByRole("button", { name: /^This device/ }).click();
  return menu;
}

async function chooseWeather(page: Page, choice: "Moving" | "Still" | "Off"): Promise<void> {
  const menu = await openThisDevice(page);
  const group = menu.getByRole("group", { name: "Weather on the map" });
  await group.scrollIntoViewIfNeeded();
  await group.getByRole("radio", { name: choice, exact: true }).check();
  await page.keyboard.press("Escape");
  await sleep(200);
}

/** The relative luminance of an sRGB pixel (WCAG 2.x). */
function luminance(r: number, g: number, b: number): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/**
 * The contrast of a pill's words on its backing, from the screen's pixels:
 * the backing is the pill's most common shade and the words its farthest,
 * read within the box, so rain over the pill shows in both.
 */
async function pillContrast(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = await page.screenshot({ clip: box });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lums: number[] = [];
  for (let i = 0; i < info.width * info.height; i++) lums.push(luminance(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!));
  lums.sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)]!;
  // The words are the side away from the backing.
  const far = median > 0.5 ? lums[Math.floor(lums.length * 0.03)]! : lums[Math.floor(lums.length * 0.97)]!;
  const [hi, lo] = median > far ? [median, far] : [far, median];
  return (hi + 0.05) / (lo + 0.05);
}

describe("weather over the map", { concurrency: false }, () => {
  before(async () => {
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

  test("wx-0. the DM's room over the cavern map, a second scene, and Pat on a phone", async () => {
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
    await ops.send({ t: "scene.update", sceneId: run.sceneId, patch: { name: "Forest road", bounds: BOUNDS, fogEnabled: false } });
    await ops.send({ t: "scene.setMap", sceneId: run.sceneId, map: await uploadCavern() });
    await ops.send({ t: "scene.create", scene: { id: run.cryptId, name: "The crypt", bounds: { w: 20, h: 14 }, fogEnabled: false } });
    run.patId = await join(patContext, "Pat", "#30a46c");
    await pat.goto(`${server.origin}/r/${run.roomId}`);
    await waitFor("Pat's snapshot", () => patSocket.state);
    await pat.locator(".konvajs-content").first().waitFor();
    await dm.locator(".konvajs-content").first().waitFor();
    // A clear scene mounts no weather layer, so Top-down keeps its four.
    assert.equal(await weatherCanvases(dm), 0);
    assert.equal(await weatherCanvases(pat), 0);
  });

  test("wx-1. heavy rain with a strong wind on the players' scene: both draw it at 1x as Top-down's third layer, 30 ticks a second, and a camera change counts apart from the ticks", async () => {
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    const started = Date.now();
    const onPat = await shown(pat, "rain heavy strong");
    assert.ok(Date.now() - started < 3000, "Pat's map shows it soon");
    const onDm = await shown(dm, "rain heavy strong");
    // Top-down: map, board, weather, tokens, overlay. The weather is the third, at 1x.
    for (const p of [onPat, onDm]) {
      assert.equal(p.index, 2, "the weather is Top-down's third layer");
      assert.ok(p.layers <= 5, `at most five layers, ${p.layers}`);
      assert.equal(p.ratio, 1, "the weather draws 1 device pixel a CSS pixel");
    }
    // 30 a second, on the test's 60 Hz frames, while Moving.
    const rate = await ticksOver(pat, 2000);
    assert.ok(rate.ticks >= 40 && rate.ticks <= 64, `Pat's ticks in 2 s: ${rate.ticks}`);

    // A camera change draws through the stage's own batchDraw, as a camera draw, and the clock keeps its pace.
    const before = await probe(dm);
    await zoomOnce(dm);
    await zoomOnce(dm, 120);
    const afterZoom = await probe(dm);
    assert.ok(before && afterZoom);
    assert.ok(afterZoom.cameraDraws > before.cameraDraws, "the zoom drew as a camera draw");
    const dmRate = await ticksOver(dm, 1500);
    assert.ok(dmRate.ticks >= 30 && dmRate.ticks <= 50, `the DM's ticks in 1.5 s: ${dmRate.ticks}`);
    await shots.take(pat, "wx-1-pat-heavy-rain");
    await shots.take(dm, "wx-1-dm-heavy-rain");
    const konvaWarnings = [...consoles.dm.warnings, ...consoles.pat.warnings].filter((w) => /Konva warning/.test(w));
    assert.deepEqual(konvaWarnings, [], "no Konva warning, five layers at most");
  });

  test("wx-2. weather on a scene the players are not on never reaches Pat, and comes when the DM moves them there", async () => {
    await setWeather(run.cryptId, { kind: "fog", heavy: true });
    await waitFor("the crypt's fog on the DM's state", () => (dmSocket.state?.scenes[run.cryptId] as { weather?: unknown } | undefined)?.weather ?? null);
    await sleep(500);
    assert.equal(patSocket.everSaw('"fog"'), false, "Pat's socket never carried the crypt's weather");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.cryptId });
    await shown(pat, "fog heavy calm");
    await ops.send({ t: "room.setPlayerScene", sceneId: run.sceneId });
    await shown(pat, "rain heavy strong");
  });

  test("wx-3. reduced motion keeps it still: no ticks, a draw only on a camera change", async () => {
    await pat.emulateMedia({ reducedMotion: "reduce" });
    try {
      await sleep(300);
      const rest = await ticksOver(pat, 1000);
      assert.equal(rest.ticks, 0, "no ticks under reduced motion");
      const before = await probe(pat);
      await pat.mouse.wheel(0, -120);
      await sleep(300);
      const after = await probe(pat);
      assert.ok(before && after);
      assert.equal(after.ticks, before.ticks, "a camera change steps nothing");
      assert.ok(after.cameraDraws >= before.cameraDraws, "it draws on a camera change");
    } finally {
      await pat.emulateMedia({ reducedMotion: "no-preference" });
    }
    await waitFor("ticks again", async () => ((await ticksOver(pat, 300)).ticks > 0 ? true : null));
  });

  test("wx-4. This device: Still draws on camera changes only, Off mounts no canvas, Low power keeps it still", async () => {
    await chooseWeather(dm, "Still");
    await sleep(300);
    const still = await ticksOver(dm, 1000);
    assert.equal(still.ticks, 0, "Still: no ticks");
    const before = await probe(dm);
    await zoomOnce(dm);
    const after = await probe(dm);
    assert.ok(before && after);
    assert.ok(after.cameraDraws > before.cameraDraws, "Still draws on a camera change");
    assert.equal(after.ticks, before.ticks);

    await chooseWeather(dm, "Off");
    await waitFor("no weather canvas", async () => ((await weatherCanvases(dm)) === 0 ? true : null));
    const stored = await dm.evaluate(() => localStorage.getItem("rvtt.weather"));
    assert.equal(stored, "off");

    await chooseWeather(dm, "Moving");
    await shown(dm, "rain heavy strong");
    await waitFor("the DM's ticks again", async () => ((await ticksOver(dm, 300)).ticks > 0 ? true : null));

    // Low power remounts the stage at 1x and keeps the weather still, and This device says why.
    const menu = await openThisDevice(dm);
    await menu.getByRole("switch", { name: /^Low power/ }).click();
    await menu.getByText("Low power keeps weather still.", { exact: true }).waitFor();
    await dm.keyboard.press("Escape");
    await shown(dm, "rain heavy strong");
    await sleep(300);
    assert.equal((await ticksOver(dm, 1000)).ticks, 0, "Low power: no ticks");
    const back = await openThisDevice(dm);
    await back.getByRole("switch", { name: /^Low power/ }).click();
    await dm.keyboard.press("Escape");
    await shown(dm, "rain heavy strong");
    await waitFor("the DM's ticks after Low power", async () => ((await ticksOver(dm, 300)).ticks > 0 ? true : null));
  });

  test("wx-5. a hidden page, a sheet over the whole screen and View as a player stop the covered board's ticks, and they come back", async () => {
    // A hidden page mounts no layer.
    await setVisibility(pat, "hidden");
    await waitFor("no weather canvas on a hidden page", async () => ((await weatherCanvases(pat)) === 0 ? true : null));
    await setVisibility(pat, "visible");
    await shown(pat, "rain heavy strong");
    await waitFor("Pat's ticks within a moment", async () => ((await ticksOver(pat, 200)).ticks > 0 ? true : null), 3000);

    // A phone's sheet swiped to fill the screen covers the map.
    await pat.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
    await pat.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    const sheet = pat.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
    await sheet.waitFor();
    // Expand sheet shows only with focus, as a keyboard reaches it.
    await sheet.getByRole("button", { name: "Expand sheet" }).focus();
    await pat.keyboard.press("Enter");
    await sleep(500);
    assert.equal((await ticksOver(pat, 800)).ticks, 0, "no ticks under a sheet that fills the screen");
    await pat.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await waitFor("Pat's ticks after the sheet", async () => ((await ticksOver(pat, 300)).ticks > 0 ? true : null));

    // View as a player: the DM's own board waits and the preview's draws its own.
    await openSideTab(dm, "DM");
    const panel = dm.getByRole("tabpanel", { name: sideTabName("DM") });
    await panel.getByRole("combobox", { name: "View as a player" }).selectOption({ label: "Pat" });
    await panel.getByRole("button", { name: "View", exact: true }).click();
    const preview = dm.locator('dialog[aria-label="Viewing as Pat"]');
    await preview.locator(".konvajs-content").first().waitFor();
    await shown(dm, "rain heavy strong", "preview");
    await sleep(300);
    const covered = await page2Rates(dm);
    assert.equal(covered.room, 0, "the covered room's board does not tick");
    assert.ok(covered.preview > 0, "the preview's board ticks");
    await shots.take(dm, "wx-5-view-as-pat");
    await preview.getByRole("button", { name: "Exit", exact: true }).click();
    await preview.waitFor({ state: "detached" });
    await waitFor("the DM's ticks after the preview", async () => ((await ticksOver(dm, 300)).ticks > 0 ? true : null));
  });

  test("wx-6. Isometric: the main stage's second layer, clipped to the ground's outline, at its stage's camera", async () => {
    await viewAs(dm, "isometric", 0);
    const iso = await shown(dm, "rain heavy strong");
    assert.equal(iso.index, 1, "relief, weather, drag, upright");
    assert.equal(iso.layers, 4);
    const rate = await ticksOver(dm, 1500);
    assert.ok(rate.ticks >= 30 && rate.ticks <= 50, `iso ticks in 1.5 s: ${rate.ticks}`);
    const before = await probe(dm);
    await zoomOnce(dm, 240);
    const after = await probe(dm);
    assert.ok(before && after && after.cameraDraws > before.cameraDraws, "an isometric camera change draws once through the main stage");
    // Zoomed out, the corners of the screen are outside the turned and squashed ground, and the weather leaves them empty.
    const corner = await dm.evaluate(() => {
      type Layer = { getCanvas(): { _canvas: { dataset: Record<string, string>; getContext(t: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } } } };
      const konva = (globalThis as unknown as { Konva: { stages: { getLayers(): Layer[]; visible(): boolean; width(): number }[] } }).Konva;
      for (const stage of konva.stages) {
        if (!stage.visible() || stage.width() === 0) continue;
        const layer = stage.getLayers().find((l) => l.getCanvas()._canvas.dataset.weather !== undefined);
        if (!layer) continue;
        const px = layer.getCanvas()._canvas.getContext("2d").getImageData(2, 2, 8, 8).data;
        let alpha = 0;
        for (let i = 3; i < px.length; i += 4) alpha = Math.max(alpha, px[i]!);
        return alpha;
      }
      return -1;
    });
    assert.equal(corner, 0, "nothing drawn outside the ground's outline");
    await shots.take(dm, "wx-6-dm-iso-heavy-rain");
    // Back to Top-down: the same field, the third layer again.
    await viewAs(dm, "topDown");
    const top = await shown(dm, "rain heavy strong");
    assert.equal(top.index, 2);
    await waitFor("Top-down ticks after the switch", async () => ((await ticksOver(dm, 300)).ticks > 0 ? true : null));
  });

  test("wx-7. the DM's Builder hides the weather, and Select brings it back", async () => {
    await pickTool(dm, "Map builder");
    await waitFor("no weather while building", async () => ((await weatherCanvases(dm)) === 0 ? true : null));
    await pickTool(dm, "Select");
    await shown(dm, "rain heavy strong");
  });

  test("wx-8. the table display draws it, and its menu's Off leaves a member's setting in the same browser alone", async () => {
    const tvContext = await browser.newContext({ viewport: TV, storageState: await dmContext.storageState() });
    try {
      const tv = await tvContext.newPage();
      consoles.tv.attach(tv);
      const res = await dmContext.request.post(`${server.origin}/api/rooms/${run.roomId}/display/code`, { headers: { Origin: server.origin } });
      assert.equal(res.status(), 201, await res.text());
      const { code } = (await res.json()) as { code: string };
      await tv.goto(`${server.origin}/display`);
      await tv.getByLabel("Code from the DM's screen").fill(code);
      await tv.getByRole("button", { name: "Connect" }).click();
      await tv.locator(".konvajs-content").first().waitFor();
      await shown(tv, "rain heavy strong");
      await shots.take(tv, "wx-8-display-heavy-rain");
      await tv.evaluate(() => localStorage.setItem("rvtt.weather", "still"));
      await tv.mouse.click(TV.width / 2, TV.height / 2);
      const menu = tv.getByRole("menu", { name: "Table display" });
      await menu.getByRole("group", { name: "Weather" }).getByRole("menuitemradio", { name: "Off" }).click();
      await waitFor("no weather canvas on the display", async () => ((await weatherCanvases(tv)) === 0 ? true : null));
      assert.equal(await tv.evaluate(() => localStorage.getItem("rvtt.weather")), "still", "the member's setting is unchanged");
      assert.equal(await tv.evaluate(() => localStorage.getItem("rvtt.displayWeather")), "off");
      await shots.take(tv, "wx-8-display-menu-off");

      // The menu with its Weather row, in line at the sweep's sizes and text sizes (a display is any screen the DM pairs).
      const lines: string[] = [];
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
        for (const scale of ["100%", "130%"]) {
          await tv.setViewportSize(size);
          if (!(await menu.isVisible())) await tv.mouse.click(size.width / 2, size.height / 3);
          await menu.waitFor();
          await menu.getByRole("group", { name: "Text size" }).getByRole("menuitemradio", { name: scale }).click();
          await sleep(200);
          const row = menu.getByRole("group", { name: "Weather" });
          await row.scrollIntoViewIfNeeded();
          lines.push(...alignmentLines(await measureAlignment(row), `display weather ${size.width}x${size.height} ${scale}`));
          await shots.take(tv, `wx-8-display-menu-${size.width}-${scale.replace("%", "")}`);
        }
      }
      await menu.getByRole("group", { name: "Text size" }).getByRole("menuitemradio", { name: "100%" }).click();
      assert.deepEqual(lines, [], "the display menu's Weather row out of line");
    } finally {
      await tvContext.close();
    }
  });

  test("wx-9. an area's name and a trap's pill read at 4.5:1 or better under each heavy kind, held still", async () => {
    const dmId = dmSocket.you!.memberId;
    await ops.send({ t: "template.create", template: { id: run.area, sceneId: run.sceneId, shape: "sphere", size: 20, origin: { x: 20, y: 20, z: 0 }, yaw: 0, includeOrigin: false, color: "#e5484d", spell: "Fireball", ownerId: dmId, visibility: "all" } });
    const rig = { on: ["enter"], who: "any", floor: false, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: run.trap, sceneId: run.sceneId, name: "Snare", zone: { cells: [{ x: 19, y: 25, w: 2, h: 1 }] }, rig } });
    // A computer at 2x, as most are, so a pill's words draw whole rather than as 1 px of blur, and the weather held still in its storage.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, storageState: await dmContext.storageState() });
    const failures: string[] = [];
    try {
      await context.addInitScript(() => localStorage.setItem("rvtt.weather", "still"));
      const page = await context.newPage();
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.locator(".konvajs-content").first().waitFor();
      await sleep(800);
      // Close enough that a trap's small name shows, both pills on screen.
      const middle = await pagePoint(page, BOUNDS, { x: 20, y: 23 });
      await page.mouse.move(middle.x, middle.y);
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
      await sleep(400);
      for (const weather of [{ kind: "rain", heavy: true }, { kind: "snow", heavy: true }, { kind: "fog", heavy: true }, { kind: "leaves", heavy: true }, { kind: "ash", heavy: true }, { kind: "sand", heavy: true, wind: "strong" }] as const) {
        await setWeather(run.sceneId, weather as Weather);
        await waitFor(`${weather.kind} on the DM's map`, async () => ((await probe(page))?.key.startsWith(`${weather.kind} heavy`) ? true : null));
        await sleep(300);
        for (const name of ["Fireball", "Snare"]) {
          const box = await pillBox(page, name);
          if (!box) {
            failures.push(`${weather.kind}: no ${name} pill on screen`);
            continue;
          }
          const ratio = await pillContrast(page, box);
          if (ratio < 4.5) failures.push(`${weather.kind}: ${name} at ${ratio.toFixed(2)}:1`);
        }
        await shots.take(page, `wx-9-${weather.kind}-heavy-still`);
      }
    } finally {
      await context.close();
    }
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    assert.deepEqual(failures, []);
  });

  test("wx-11. This device's Weather section, with its help under reduced motion, in line at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%", async () => {
    const lines: string[] = [];
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      for (const scale of [1, 1.3]) {
        const phone = size.width < 900;
        const context = await browser.newContext({ viewport: size, storageState: await patContext.storageState(), ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), reducedMotion: "reduce" });
        try {
          const page = await context.newPage();
          await page.addInitScript((n) => localStorage.setItem("rvtt.uiScale", String(n)), scale);
          await page.goto(`${server.origin}/r/${run.roomId}`);
          await page.locator(".konvajs-content").first().waitFor();
          const menu = await openThisDevice(page);
          const section = menu.locator("section").filter({ has: page.getByRole("heading", { name: "Weather", exact: true }) }).last();
          await section.scrollIntoViewIfNeeded();
          await section.getByText("Reduced motion is on for this device, so weather stays still.", { exact: true }).waitFor();
          const at = `this device weather ${size.width}x${size.height} ${Math.round(scale * 100)}%`;
          lines.push(...alignmentLines(await measureAlignment(section), at));
          await shots.take(page, `wx-11-${size.width}-${Math.round(scale * 100)}`);
        } finally {
          await context.close();
        }
      }
    }
    assert.deepEqual(lines, [], "This device's Weather section out of line");
  });

  test("wx-12. no console errors on any page", () => {
    for (const c of Object.values(consoles)) assert.deepEqual(c.errors, [], `${c.label} errors`);
  });
});

/** Says the page is hidden or shown, as a locked phone or a tab in the background does. */
function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  return page.evaluate((to) => {
    const doc = (globalThis as unknown as { document: { dispatchEvent(e: unknown): void } }).document;
    Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => to });
    doc.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** A board pill's words on the page, from the Konva text that holds them, on the stage that shows. */
function pillBox(page: Page, words: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((text) => {
    type Rect = { x: number; y: number; width: number; height: number };
    type Node = { getClassName(): string; text?(): string; getClientRect(): Rect; isVisible(): boolean };
    type Stage = { visible(): boolean; width(): number; find(f: (n: Node) => boolean): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } };
    const konva = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva;
    for (const stage of konva.stages) {
      if (!stage.visible() || stage.width() === 0) continue;
      const found = stage.find((n) => n.getClassName() === "Text" && n.text?.() === text && n.isVisible())[0];
      if (!found) continue;
      // The words with their padding, inside the pill's colored border, so the border is neither backing nor words.
      const r = found.getClientRect();
      const at = stage.container().getBoundingClientRect();
      return { x: Math.round(at.left + r.x), y: Math.round(at.top + r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
    }
    return null;
  }, words);
}

/** The covered room's ticks and the preview's over one second, on the DM's page. */
async function page2Rates(page: Page): Promise<{ room: number; preview: number }> {
  const a = { room: await probe(page, "room"), preview: await probe(page, "preview") };
  await sleep(1000);
  const b = { room: await probe(page, "room"), preview: await probe(page, "preview") };
  return { room: (b.room?.ticks ?? 0) - (a.room?.ticks ?? 0), preview: (b.preview?.ticks ?? 0) - (a.preview?.ticks ?? 0) };
}
