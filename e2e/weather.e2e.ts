import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { alignmentLines, measureAlignment } from "./helpers/alignment.ts";
import { openGroup } from "./helpers/groups.ts";
import { ConsoleWatch, OpSocket, openSideTab, pagePoint, pickTool, ROOT, Shots, sideTabName, sleep, SocketWatch, startServer, Touches, waitFor, type Server } from "./harness.ts";
import { lookOf } from "../client/features/weather/looks.ts";
import { particleCount, WRAP_MARGIN } from "../client/features/weather/sim.ts";

/**
 * Weather over the map (docs/design/design-v1-weather.md, lane WX-C): the
 * layer, its one clock and where it sits, This device's choice, the table
 * display's menu, and the places it waits. Weather is set through the DM's
 * socket, so no step needs the DM's fold (WX-D's steps drive that).
 *
 * The weather canvas is read through its test hooks
 * (features/weather/WeatherLayer.tsx): `data-weather` ("rain heavy strong",
 * set on a change), and the `weatherTicks` and `weatherCameraDraws`
 * properties, counted apart. The weather's own flag adds what each draw
 * drew: up to 64 marks seen, each its center before sway and its drawn
 * center, and the marks seen by their alpha (the wz steps, lane wxbuild,
 * docs/design/design-v1-weather-zoom.md).
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

/** Set before the app's first script: it installs the hook that picks and turns the view without the menu (relief/isoTest.ts), and the weather's draw hooks (WeatherLayer.tsx WEATHER_TEST_FLAG). */
const HOOK_FLAG = "globalThis.__rvttIsoTest = true; globalThis.__rvttWeatherTest = true;";
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
  /** What the run measured and did on its own, printed at the end: each page `moving` opened again, and the step-down's times in fu49perfc-1. */
  measured: [] as string[],
};

type Weather = { kind: string; heavy?: true; wind?: "moderate" | "strong"; toward?: number; rules?: false } | null;

async function setWeather(sceneId: string, weather: Weather): Promise<void> {
  await ops.send({ t: "scene.update", sceneId, patch: { weather } });
}

/**
 * What a page's weather canvas says, the one in the View as a player dialog
 * or the room's own, or null when none is mounted. `drawn` says it has drawn
 * once, so its ticks are the room's: a canvas mounted anew reads 0 until its
 * first draw, and a count across that draw read the room's whole count as
 * ticks, which a weather held still passed (wx-5 on CI). `level` is the
 * step-down's (mode.ts).
 */
type Probe = { key: string; ticks: number; cameraDraws: number; index: number; layers: number; ratio: number; shown: boolean; width: number; drawn: boolean; level: string; frameCost: number };

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
      const canvas = layers[index]!.getCanvas()._canvas as { dataset: Record<string, string>; weatherTicks?: number; weatherCameraDraws?: number; weatherLevel?: string; weatherFrameCost?: number };
      // The hidden tree keeps its layer mounted, unregistered: the one that shows is the one asked for.
      if (!stage.visible() || stage.width() === 0) continue;
      return { key: canvas.dataset.weather!, ticks: canvas.weatherTicks ?? 0, cameraDraws: canvas.weatherCameraDraws ?? 0, index, layers: layers.length, ratio: layers[index]!.getCanvas().getPixelRatio(), shown: true, width: stage.width(), drawn: canvas.weatherTicks !== undefined, level: canvas.weatherLevel ?? "", frameCost: canvas.weatherFrameCost ?? 0 };
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
    return p && p.key === key && p.drawn ? p : null;
  });
}

/**
 * The page's weather moving at its full step, for a step that counts its
 * ticks. The step-down (mode.ts) only goes down until the page reloads, and
 * where the canvas has no GPU it halves the weather about 5 s after it
 * starts and holds it still about 10 s after (the weather design note 6.3).
 * So on a CI runner a page that has moved since the first steps holds still,
 * as it should, and its ticks could never come back. A page stepped down is
 * opened again, which leaves a step at least two windows before it holds still.
 */
async function moving(page: Page, key = "rain heavy strong"): Promise<void> {
  const was = await shown(page, key);
  if (was.level === "full") return;
  // Said in the log, so a step-down on a machine with a GPU, which this reload would hide, shows there (CIFIX-F3). fu49perfc-1 holds the step-down itself to a cost the test sets.
  run.measured.push(`moving: ${page === dm ? "the DM's" : page === pat ? "Pat's" : "a"} page had stepped down to ${was.level}, opened again`);
  await page.reload();
  await page.locator(".konvajs-content").first().waitFor();
  const fresh = await shown(page, key);
  assert.equal(fresh.level, "full", "a page opened again starts at the full step");
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
  // This device's groups start folded on a phone (docs/design/design-v1-panel-groups.md 6.2).
  await openGroup(menu, "Weather");
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
    if (run.measured.length > 0) console.log(`WX measured:\n${run.measured.join("\n")}`);
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
    await moving(pat);
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
    await moving(dm);
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

  test("wxfix-1. held still, a scene edit that leaves the weather as it was draws nothing, and a turned wind draws once", async () => {
    await chooseWeather(dm, "Still");
    await sleep(300);
    const before = await probe(dm);
    assert.ok(before);
    // The same weather sent again comes back as a new scene object, as any scene edit does.
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    await sleep(600);
    const same = await probe(dm);
    assert.ok(same);
    assert.equal(same.cameraDraws, before.cameraDraws, "nothing to draw again");
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong", toward: 270 });
    const turned = await waitFor("a draw for the turned wind", async () => {
      const p = await probe(dm);
      return p && p.cameraDraws > same.cameraDraws ? p : null;
    });
    assert.equal(turned.key, "rain heavy strong");
    assert.equal(turned.ticks, before.ticks, "still: no ticks");
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    await chooseWeather(dm, "Moving");
    await waitFor("the DM's ticks again", async () => ((await ticksOver(dm, 300)).ticks > 0 ? true : null));
  });

  test("wx-5. a hidden page, a sheet over the whole screen and View as a player stop the covered board's ticks, and they come back", async () => {
    await moving(pat);
    await moving(dm);
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

  test("wx-6. Isometric: the main stage's second layer, clipped to the ground's outline, at its stage's camera", async (t) => {
    await moving(dm);
    await viewAs(dm, "isometric", 0);
    // Top-down again when a check here fails: the room's view is stored, and wx-9's new pages would open in Isometric.
    let back = false;
    t.after(async () => {
      if (!back) await viewAs(dm, "topDown");
    });
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
    back = true;
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

  test("fu49perfc-1. the step-down at costs the test sets, on any machine: ticks that cost nothing keep moving past the windows that would hold them still, ticks that busy their frames 6 ms halve the rain, then hold it still, and This device says why, and ticks under 2 ms by the median that add 70 ms a second step down too", async () => {
    /** A DM page of its own whose ticks cost what `cost` says (WeatherLayer.tsx WEATHER_TEST_COST), from its first tick, so no step before carries over. */
    const open = async (cost: { skip?: boolean; ms?: number | number[] }) => {
      const page = await dmContext.newPage();
      consoles.dm.attach(page);
      await page.addInitScript((c) => void ((globalThis as Record<string, unknown>).__rvttWeatherCost = c), cost);
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.locator(".konvajs-content").first().waitFor();
      await shown(page, "rain heavy strong");
      return { page, from: Date.now() };
    };
    /** The levels a page goes through over `ms`, and when each began, from the page's opening. */
    const levelsOver = async (at: { page: Page; from: number }, ms: number, until?: string) => {
      const seen: { level: string; at: number }[] = [];
      while (Date.now() - at.from < ms) {
        const p = await probe(at.page);
        if (p && p.level !== seen.at(-1)?.level) seen.push({ level: p.level, at: Date.now() - at.from });
        if (until && p?.level === until) break;
        await sleep(200);
      }
      return seen;
    };

    // Past the 2 s warm-up and four 3 s windows: weather this slow would have held still by then, at 30 frames a second too (the weather design note, 6.3).
    const cheap = await open({ skip: true });
    try {
      const levels = await levelsOver(cheap, 15_000);
      const p = await probe(cheap.page);
      run.measured.push(`fu49perfc-1: ticks costing their step alone, over 15 s: ${levels.map((l) => `${l.level} at ${(l.at / 1000).toFixed(1)} s`).join(", ")}, a tick's frame cost ${p?.frameCost.toFixed(2)} ms`);
      assert.deepEqual(levels.map((l) => l.level), ["full"], "a tick that costs nothing never steps down");
      assert.ok((await ticksOver(cheap.page, 1000)).ticks >= 20, "and it keeps ticking");
    } finally {
      await cheap.page.close();
    }

    const slow = await open({ ms: 6 });
    try {
      const levels = await levelsOver(slow, 30_000, "still");
      run.measured.push(`fu49perfc-1: ticks busying their frames 6 ms: ${levels.map((l) => `${l.level} at ${(l.at / 1000).toFixed(1)} s`).join(", ")}`);
      assert.deepEqual(levels.map((l) => l.level), ["full", "half", "still"], "6 ms a tick halves the rain, then holds it still");
      // No step before the warm-up and a whole window, and the second a warm-up and a window after the first, at 30 frames a second a window later (6.3).
      const [, half, still] = levels;
      assert.ok(half!.at >= 4000, `halved at ${half!.at} ms`);
      assert.ok(still!.at - half!.at >= 4000, `held still ${still!.at - half!.at} ms after it halved`);
      assert.equal((await ticksOver(slow.page, 1000)).ticks, 0, "held still, it ticks no more");
      const menu = await openThisDevice(slow.page);
      const why = menu.getByText("Weather was slowing the map, so it stays still until you reload.", { exact: true });
      await why.waitFor();
      await why.scrollIntoViewIfNeeded();
      await shots.take(slow.page, "fu49perfc-1-still-slow");
    } finally {
      await slow.page.close();
    }

    // Two ticks in three busy 1.5 ms and the third 4: a median of 1.5, under the 2 ms line, and about 70 ms a second with the loop's own work, over 6.1's 60 (mode.ts BUSY_MS_PER_S).
    const busy = await open({ skip: true, ms: [1.5, 1.5, 4] });
    try {
      const levels = await levelsOver(busy, 30_000, "still");
      const p = await probe(busy.page);
      run.measured.push(`fu49perfc-1: ticks busying 1.5, 1.5 and 4 ms in turn: ${levels.map((l) => `${l.level} at ${(l.at / 1000).toFixed(1)} s`).join(", ")}, a tick's frame cost ${p?.frameCost.toFixed(2)} ms by the median`);
      assert.deepEqual(levels.map((l) => l.level), ["full", "half", "still"], "70 ms a second steps down though the median is under the line");
    } finally {
      await busy.page.close();
    }
  });

  test("wx-8. the table display draws it and says it in its polite status, and its menu's Off leaves a member's setting in the same browser alone", async () => {
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
      // A screen reader at the table hears the weather in the display's polite status, as in a member's room.
      await setWeather(run.sceneId, { kind: "snow" });
      await tv.locator("[data-rvtt-view-status]").filter({ hasText: "Weather here: Light snow." }).first().waitFor({ state: "attached" });
      await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
      await tv.locator("[data-rvtt-view-status]").filter({ hasText: "Weather here: Heavy rain, Strong wind." }).first().waitFor({ state: "attached" });
      await shown(tv, "rain heavy strong");
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

  test("wx-9. an area's name and a trap's pill read at 4.5:1 or better under each heavy kind, held still, at 2x and at 1x, beside their words with no weather", async () => {
    const dmId = dmSocket.you!.memberId;
    await ops.send({ t: "template.create", template: { id: run.area, sceneId: run.sceneId, shape: "sphere", size: 20, origin: { x: 20, y: 20, z: 0 }, yaw: 0, includeOrigin: false, color: "#e5484d", spell: "Fireball", ownerId: dmId, visibility: "all" } });
    const rig = { on: ["enter"], who: "any", floor: false, resets: "never", stops: false, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false };
    await ops.send({ t: "trap.create", trap: { id: run.trap, sceneId: run.sceneId, name: "Snare", zone: { cells: [{ x: 19, y: 25, w: 2, h: 1 }] }, rig } });
    const failures: string[] = [];
    const read: string[] = [];
    // A computer at 2x, as most are, and one at 1x, where a sandstorm once read 4.2:1. Each pill is read with no weather first, so a failure says whether the words or the weather lost the contrast.
    for (const ratio of [2, 1]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: ratio, storageState: await dmContext.storageState() });
      try {
        await context.addInitScript(() => localStorage.setItem("rvtt.weather", "still"));
        const page = await context.newPage();
        await setWeather(run.sceneId, null);
        await page.goto(`${server.origin}/r/${run.roomId}`);
        await page.locator(".konvajs-content").first().waitFor();
        await sleep(800);
        // Close enough that a trap's small name shows, both pills on screen.
        const middle = await pagePoint(page, BOUNDS, { x: 20, y: 23 });
        await page.mouse.move(middle.x, middle.y);
        for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
        await sleep(400);
        const base: Record<string, number> = {};
        for (const name of ["Fireball", "Snare"]) {
          const box = await pillBox(page, name);
          if (box) base[name] = await pillContrast(page, box);
        }
        read.push(`${ratio}x clear: ${Object.entries(base).map(([n, r]) => `${n} ${r.toFixed(2)}`).join(", ")}`);
        for (const weather of [{ kind: "rain", heavy: true }, { kind: "snow", heavy: true }, { kind: "fog", heavy: true }, { kind: "leaves", heavy: true }, { kind: "ash", heavy: true }, { kind: "sand", heavy: true, wind: "strong" }] as const) {
          await setWeather(run.sceneId, weather as Weather);
          await waitFor(`${weather.kind} on the DM's map`, async () => ((await probe(page))?.key.startsWith(`${weather.kind} heavy`) ? true : null));
          await sleep(300);
          const line: string[] = [];
          for (const name of ["Fireball", "Snare"]) {
            const box = await pillBox(page, name);
            const clear = base[name];
            if (!box || clear === undefined) {
              failures.push(`${ratio}x ${weather.kind}: no ${name} pill on screen`);
              continue;
            }
            const contrast = await pillContrast(page, box);
            line.push(`${name} ${contrast.toFixed(2)}`);
            if (contrast < 4.5) failures.push(`${ratio}x ${weather.kind}: ${name} at ${contrast.toFixed(2)}:1, ${clear.toFixed(2)}:1 with no weather`);
          }
          read.push(`${ratio}x ${weather.kind}: ${line.join(", ")}`);
          await shots.take(page, `wx-9-${weather.kind}-heavy-still-${ratio}x`);
        }
      } finally {
        await context.close();
      }
    }
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    console.log(`wx-9 contrast\n${read.join("\n")}`);
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
          const section = menu.locator("[data-panel-group]").filter({ has: page.getByRole("heading", { name: "Weather", exact: true }) }).last();
          await section.scrollIntoViewIfNeeded();
          await section.getByText("Reduced motion keeps weather still.", { exact: true }).waitFor();
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

  test("wz-1. Top-down, held still: a wheel notch, a + press and a pinch on Pat's phone keep every mark on its ground and each drawn center within its sway, and fog's banks grow from the zoom point", async () => {
    const lines = await heldStill(async () => {
      const out: string[] = [];
      for (const k of ZOOM_KINDS) out.push(...(await zoomsHold(k)));
      out.push(...(await fogHolds()));
      return out;
    });
    console.log(`wz-1 Top-down\n${lines.join("\n")}`);
  });

  test("wz-2. the same in Isometric, after a turn", async (t) => {
    await viewAs(dm, "isometric", 1);
    await viewAs(pat, "isometric", 1);
    t.after(async () => {
      await viewAs(dm, "topDown");
      await viewAs(pat, "topDown");
    });
    const lines = await heldStill(async () => {
      const out: string[] = [];
      for (const k of ZOOM_KINDS) out.push(...(await zoomsHold(k)));
      out.push(...(await fogHolds()));
      return out;
    });
    console.log(`wz-2 Isometric\n${lines.join("\n")}`);
  });

  test("wz-3. moving heavy rain through a pinch on Pat's phone: on each frame with no tick the named marks stand on their ground, the ticks keep about 30 a second, and camera draws count apart", async () => {
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    await moving(pat);
    // Every draw, as it publishes its marks: the draw sets its tick and camera draw counts just before them (WeatherLayer.tsx).
    await pat.evaluate(() => {
      type Canvas = { dataset: Record<string, string>; weatherTicks?: number; weatherCameraDraws?: number };
      type Stage = { visible(): boolean; width(): number; getLayers(): { getCanvas(): { _canvas: Canvas } }[] };
      const g = globalThis as unknown as { Konva: { stages: Stage[] }; __wz: unknown[]; __wzStop(): void };
      g.__wz = [];
      const stage = g.Konva.stages.find((x) => x.visible() && x.width() > 0 && x.getLayers().some((l) => l.getCanvas()._canvas.dataset.weather !== undefined))!;
      const canvas = stage.getLayers().find((l) => l.getCanvas()._canvas.dataset.weather !== undefined)!.getCanvas()._canvas;
      let last: unknown = null;
      Object.defineProperty(canvas, "weatherSpots", {
        configurable: true,
        get: () => last,
        set(spots: unknown) {
          last = spots;
          g.__wz.push({ at: performance.now(), ticks: canvas.weatherTicks ?? 0, draws: canvas.weatherCameraDraws ?? 0, spots });
        },
      });
      g.__wzStop = () => Object.defineProperty(canvas, "weatherSpots", { configurable: true, writable: true, value: last });
    });
    const touches = new Touches(await patContext.newCDPSession(pat));
    // Most of a pinch's camera draws share a frame with a tick, and how many do not varies with the machine's load (13, 10 and 4 in three runs of four pinches), so eight.
    for (let r = 0; r < 8; r++) await pinch(touches, pat, r % 2 === 0 ? 1 : -1, 150);
    const frames = (await pat.evaluate(() => {
      const g = globalThis as unknown as { __wz: unknown[]; __wzStop(): void };
      g.__wzStop();
      return g.__wz;
    })) as { at: number; ticks: number; draws: number; spots: Spots | null }[];
    const seconds = (frames.at(-1)!.at - frames[0]!.at) / 1000;
    const ticks = frames.at(-1)!.ticks - frames[0]!.ticks;
    const draws = frames.at(-1)!.draws - frames[0]!.draws;
    // Each camera draw right after another draw with no tick between: the camera moved and nothing fell, so every named mark is where the ground under it went.
    const medians: number[] = [];
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1]!;
      const b = frames[k]!;
      if (b.ticks !== a.ticks || b.draws !== a.draws + 1 || !a.spots || !b.spots || a.spots.camera.join() === b.spots.camera.join()) continue;
      const offs = sharedMarks(a.spots, b.spots).map((m) => m.center);
      if (offs.length === 0) continue;
      offs.sort((x, y) => x - y);
      medians.push(offs[offs.length >> 1]!);
    }
    console.log(`wz-3: ${ticks} ticks and ${draws} camera draws in ${seconds.toFixed(1)} s, ${medians.length} camera draws after a draw with no tick between, their medians up to ${Math.max(...medians).toFixed(3)} px`);
    assert.ok(medians.length >= 3, `${medians.length} camera draws with no tick between`);
    for (const m of medians) assert.ok(m < 1, `a named mark's median ${m} px off its ground`);
    assert.ok(ticks / seconds >= 20 && ticks / seconds <= 40, `${(ticks / seconds).toFixed(1)} ticks a second through the pinch`);
    assert.ok(draws > 0, "the pinch drew as camera draws, counted apart");
  });

  test("wz-4. zoomed by the wheel out to the scene's floor and in to 400 px a square, the marks seen are as dense as today's screen, in both views", async (t) => {
    t.after(async () => {
      await viewAs(pat, "topDown");
    });
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    const look = lookOf({ kind: "rain", heavy: true, wind: "strong" })!;
    const lines = await heldStill(async () => {
      // A runner whose canvas has no GPU has halved the weather by now (moving). That step has its own check, wz-4b, so this measures at the full step, as a machine with a GPU does, held still so it stays there.
      await moving(pat);
      const out: string[] = [];
      for (const view of ["topDown", "isometric"] as const) out.push(await densityStops(pat, look, view, SUM_LIMIT.full));
      return out;
    }, [pat]);
    console.log(`wz-4\n${lines.join("\n")}`);
  });

  test("wz-4b. at the half step a GPU-less canvas steps down to, held there by reduced motion, the marks seen in Isometric are half as dense as the full step's, within the limit its own counts set", async () => {
    await setWeather(run.sceneId, { kind: "rain", heavy: true, wind: "strong" });
    const look = lookOf({ kind: "rain", heavy: true, wind: "strong" })!;
    // A page of Pat's own whose ticks cost 6 ms each (WeatherLayer.tsx WEATHER_TEST_COST), so it halves on any machine, as fu49perfc-1 does.
    const page = await patContext.newPage();
    consoles.pat.attach(page);
    try {
      await page.addInitScript(() => void ((globalThis as Record<string, unknown>).__rvttWeatherCost = { ms: 6 }));
      await page.goto(`${server.origin}/r/${run.roomId}`);
      await page.locator(".konvajs-content").first().waitFor();
      await shown(page, "rain heavy strong");
      // Held the moment it halves: about 5 s later it would hold still, and a page held still draws no marks to count.
      await waitFor("the half step", async () => (((await probe(page))?.level ?? "") === "half" ? true : null), 20_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await sleep(300);
      const line = await densityStops(page, look, "isometric", SUM_LIMIT.half);
      console.log(`wz-4b\n${line}`);
    } finally {
      await page.close();
    }
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

// ---------------------------------------------------------------- the wz steps: weather on a zoom (docs/design/design-v1-weather-zoom.md 7)

/** What the weather's last draw drew (WeatherLayer.tsx `weatherSpots`, `weatherMarks`), with its canvas's counters and size, and its stage's camera now. */
type Spots = { camera: [number, number, number]; clip: number[]; spots: Record<string, [number, number, number, number]>; marks: number; draws: number; ticks: number; width: number; height: number; level: string; stage: string };

/** Each kind the wz steps zoom, with its sway in screen px (looks.ts). */
const ZOOM_KINDS = [
  { weather: { kind: "rain", heavy: true, wind: "strong" }, key: "rain heavy strong", sway: 0 },
  { weather: { kind: "snow", heavy: true }, key: "snow heavy calm", sway: 8 },
  { weather: { kind: "ash", heavy: true }, key: "ash heavy calm", sway: 6 },
  { weather: { kind: "leaves", heavy: true }, key: "leaves heavy calm", sway: 10 },
] as const;

function spotsNow(page: Page): Promise<Spots | null> {
  return page.evaluate(() => {
    type Canvas = { dataset: Record<string, string>; width: number; height: number; weatherTicks?: number; weatherCameraDraws?: number; weatherLevel?: string; weatherMarks?: number; weatherSpots?: { camera: [number, number, number]; clip: number[]; spots: Record<string, [number, number, number, number]> } };
    type Stage = { visible(): boolean; width(): number; x(): number; y(): number; scaleX(): number; getLayers(): { getCanvas(): { _canvas: Canvas } }[] };
    const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
    for (const stage of konva?.stages ?? []) {
      if (!stage.visible() || stage.width() === 0) continue;
      const c = stage.getLayers().find((l) => l.getCanvas()._canvas.dataset.weather !== undefined)?.getCanvas()._canvas;
      if (!c?.weatherSpots) continue;
      return { ...c.weatherSpots, marks: c.weatherMarks ?? 0, draws: c.weatherCameraDraws ?? 0, ticks: c.weatherTicks ?? 0, width: c.width, height: c.height, level: c.weatherLevel ?? "", stage: [stage.x(), stage.y(), stage.scaleX()].join() };
    }
    return null;
  });
}

/** The last draw once the stage's camera has held still and the weather drew at it: a wheel's or a pinch's zoom may take a few frames. */
async function settledSpots(page: Page): Promise<Spots> {
  let last = "";
  let still = 0;
  return waitFor("the weather drawn at a camera that holds still", async () => {
    const s = await spotsNow(page);
    const camera = s?.stage ?? "";
    still = camera === last ? still + 1 : 0;
    last = camera;
    await sleep(60);
    return s && still >= 3 && s.camera.join() === camera ? s : null;
  });
}

/** Where a screen point under camera `a` goes under camera `b`, as the ground under it does. */
function carried(a: [number, number, number], b: [number, number, number], x: number, y: number): [number, number] {
  return [((x - a[0]) / a[2]) * b[2] + b[0], ((y - a[1]) / a[2]) * b[2] + b[1]];
}

/** The marks two draws both name: how far each center before sway, and each drawn center, stands from where the ground under it went. */
function sharedMarks(a: Pick<Spots, "camera" | "spots">, b: Pick<Spots, "camera" | "spots">): { center: number; drawn: number }[] {
  const out: { center: number; drawn: number }[] = [];
  for (const [key, p] of Object.entries(a.spots)) {
    const q = b.spots[key];
    if (!q) continue;
    const c = carried(a.camera, b.camera, p[0], p[1]);
    const d = carried(a.camera, b.camera, p[2], p[3]);
    out.push({ center: Math.hypot(c[0] - q[0], c[1] - q[1]), drawn: Math.hypot(d[0] - q[2], d[1] - q[3]) });
  }
  return out;
}

/** The page box of the stage that shows the weather: in Isometric the hidden Top-down tree's stage is still in the page. */
async function stageBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.evaluate(() => {
    type Stage = { visible(): boolean; width(): number; container(): { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }; getLayers(): { getCanvas(): { _canvas: { dataset: Record<string, string> } } }[] };
    const stage = (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages.find((x) => x.visible() && x.width() > 0 && x.getLayers().some((l) => l.getCanvas()._canvas.dataset.weather !== undefined));
    const r = stage?.container().getBoundingClientRect();
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  });
  assert.ok(box, "a stage that shows the weather");
  return box;
}

/** A wheel notch at a page point, the stage's middle by default: up zooms in. A phone at 3x gets a third of the delta, so a phone's notch is 360. */
async function wheelAt(page: Page, at: { x: number; y: number } | null, dy: number): Promise<void> {
  const box = await stageBox(page);
  const p = at ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, dy);
  await sleep(150);
}

/**
 * Two fingers pinching out from 100 to 160 px apart about the stage's
 * middle, or in by as much. Under an octave, so the two draws always share
 * a level of the field to name marks in (sim.ts levelsAt): a zoom of 2.5
 * times can step past both levels the first draw showed.
 */
async function pinch(touches: Touches, page: Page, way: 1 | -1, span = 60): Promise<void> {
  const box = await stageBox(page);
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const at = (d: number) => [
    { x: mid.x - d / 2, y: mid.y, id: 1 },
    { x: mid.x + d / 2, y: mid.y, id: 2 },
  ];
  const from = way === 1 ? 100 : 100 + span;
  await touches.start(at(from), 120);
  for (let i = 1; i <= 15; i++) await touches.move(at(from + (way * i * span) / 15), 16);
  await touches.end([], 16);
  await sleep(200);
}

/**
 * How far the sum of marks seen over every zoom stop may stray from the sum wanted. A count of marks spreads by about
 * its root, so each stop holds within four of those, and the sum within these fractions. The full step ran within 10%.
 * At the half step the fixed seed's Isometric marks ran 2.1% to 2.5% over in three local runs and 4.9% to 10.2% over on CI, so its limit
 * is 12%: past the CI counts, and far under the 50% a step that halved twice or not at all would miss by.
 */
const SUM_LIMIT = { full: 0.1, half: 0.12 };

/** Zooms Pat's page out to the scene's floor and in to 400 px a square in one view, and checks the marks seen at each stop against the marks wanted. */
async function densityStops(page: Page, look: NonNullable<ReturnType<typeof lookOf>>, view: "topDown" | "isometric", sumLimit: number): Promise<string> {
  await viewAs(page, view, 1);
  await shown(page, "rain heavy strong");
  const stops: { scale: number; got: number; want: number }[] = [];
  const seen = new Set<string>();
  const read = async () => {
    const s = await settledSpots(page);
    // A notch past the floor or the top leaves the camera where it was: that stop counts once.
    if (!seen.has(s.camera.join())) stops.push({ scale: s.camera[2], got: s.marks, want: expectedMarks(look, s) });
    seen.add(s.camera.join());
    return { s };
  };
  // Out to the floor, where the scene stops shrinking.
  let last = (await read()).s.camera[2];
  for (let i = 0; i < 30; i++) {
    await wheelAt(page, null, 360);
    const now = (await read()).s.camera[2];
    if (Math.abs(now - last) < 1e-6) break;
    last = now;
  }
  // Then in to 400 px a square.
  for (let i = 0; i < 40 && last < 399; i++) {
    await wheelAt(page, null, -360);
    last = (await read()).s.camera[2];
  }
  console.log(`wz-4 ${view} stops: ${stops.map((x) => `${x.scale.toFixed(1)}:${x.got.toFixed(0)}/${x.want.toFixed(0)}`).join(" ")}`);
  for (const stop of stops) assert.ok(Math.abs(stop.got - stop.want) <= 4 * Math.sqrt(stop.want) + 1, `${view} at ${stop.scale.toFixed(1)} px a square: ${stop.got.toFixed(1)} marks seen, ${stop.want.toFixed(1)} wanted`);
  const got = stops.reduce((a, x) => a + x.got, 0);
  const want = stops.reduce((a, x) => a + x.want, 0);
  console.log(`wz-4 ${view} sum over ${((got / want - 1) * 100).toFixed(1)}%`);
  assert.ok(Math.abs(got / want - 1) < sumLimit, `${view}: ${got.toFixed(0)} marks over every stop, ${want.toFixed(0)} wanted`);
  const lo = Math.min(...stops.map((x) => x.scale));
  const hi = Math.max(...stops.map((x) => x.scale));
  assert.ok(lo < 6 && hi > 399, `${view}: from ${lo} to ${hi} px a square`);
  const floor = stops.find((x) => x.scale === lo)!;
  return `${view}: ${stops.length} stops from ${lo.toFixed(2)} to ${hi.toFixed(0)} px a square, ${got.toFixed(0)} of ${want.toFixed(0)} marks, the floor ${floor.got.toFixed(1)} of ${floor.want.toFixed(1)}`;
}

/** Runs `check` with the weather held still by reduced motion, so each zoom is camera draws alone, and moving again after. */
async function heldStill<T>(check: () => Promise<T>, pages: Page[] = [dm, pat]): Promise<T> {
  for (const p of pages) await p.emulateMedia({ reducedMotion: "reduce" });
  try {
    await sleep(300);
    return await check();
  } finally {
    for (const p of pages) await p.emulateMedia({ reducedMotion: "no-preference" });
  }
}

/** A zoom by `act` holds every named mark's center on its ground to 1 px, and each drawn center within its sway times |f - 1|, plus 1 px. */
async function zoomHolds(page: Page, what: string, sway: number, act: () => Promise<void>): Promise<string> {
  const before = await settledSpots(page);
  await act();
  const after = await waitFor(`${what}: a camera draw`, async () => {
    const s = await settledSpots(page);
    return s.camera.join() !== before.camera.join() ? s : null;
  });
  assert.equal(after.ticks, before.ticks, `${what}: held still, so no tick`);
  const f = after.camera[2] / before.camera[2];
  const bound = sway * Math.abs(f - 1) + 1;
  const shared = sharedMarks(before, after);
  const center = Math.max(...shared.map((m) => m.center));
  const drawn = Math.max(...shared.map((m) => m.drawn));
  console.log(`${what}: zoom ${f.toFixed(3)} from ${before.camera[2].toFixed(1)}, ${shared.length} marks, centers ${center.toFixed(3)}, drawn ${drawn.toFixed(2)} of ${bound.toFixed(2)}`);
  // Heavy leaves are about 35 marks on a phone, so a zoom keeps only a few of them named in both draws.
  assert.ok(shared.length >= 3, `${what}: ${shared.length} marks named in both draws`);
  assert.ok(center <= 1, `${what}: a center ${center.toFixed(2)} px off its ground`);
  assert.ok(drawn <= bound, `${what}: a drawn center ${drawn.toFixed(2)} px off, over ${bound.toFixed(2)}`);
  return `${what}: zoom ${f.toFixed(3)}, ${shared.length} marks, centers within ${center.toFixed(3)} px, drawn within ${drawn.toFixed(2)} of ${bound.toFixed(2)}`;
}

/** Each kind through a wheel notch at a point and back, a + press and a - press on the DM's computer, and a pinch out and in on Pat's phone. */
async function zoomsHold(k: (typeof ZOOM_KINDS)[number]): Promise<string[]> {
  await setWeather(run.sceneId, k.weather as Weather);
  await shown(dm, k.key);
  await shown(pat, k.key);
  const box = await stageBox(dm);
  const point = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.375 };
  const touches = new Touches(await patContext.newCDPSession(pat));
  await blurPage(dm);
  return [
    await zoomHolds(dm, `${k.key}, a wheel notch in`, k.sway, () => wheelAt(dm, point, -120)),
    await zoomHolds(dm, `${k.key}, a wheel notch out`, k.sway, () => wheelAt(dm, point, 120)),
    await zoomHolds(dm, `${k.key}, +`, k.sway, () => dm.keyboard.press("+")),
    await zoomHolds(dm, `${k.key}, -`, k.sway, () => dm.keyboard.press("-")),
    await zoomHolds(pat, `${k.key}, Pat's pinch out`, k.sway, () => pinch(touches, pat, 1, 40)),
    await zoomHolds(pat, `${k.key}, Pat's pinch in`, k.sway, () => pinch(touches, pat, -1, 40)),
  ];
}

/**
 * Heavy fog through a wheel notch and a + press on the DM's computer: the
 * canvas after, read back through the ground's zoom about its fixed point,
 * differs from before by less than half what it differs read back by the
 * stage's pan change alone, which is how fog moved before.
 */
async function fogHolds(): Promise<string[]> {
  await setWeather(run.sceneId, { kind: "fog", heavy: true });
  await shown(dm, "fog heavy calm");
  const box = await stageBox(dm);
  const point = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.375 };
  await blurPage(dm);
  const out: string[] = [];
  const zooms: [string, () => Promise<void>][] = [
    ["a wheel notch", () => wheelAt(dm, point, -120)],
    ["+", () => dm.keyboard.press("+")],
  ];
  for (const [what, act] of zooms) {
    await intoOctave(dm, point, 0.8);
    const before = await fogPixels(dm);
    await act();
    await waitFor(`fog, ${what}: a camera draw`, async () => ((await settledSpots(dm)).camera.join() !== before.camera.join() ? true : null));
    const after = await fogPixels(dm);
    const [x0, y0, s0] = before.camera;
    const [x1, y1, s1] = after.camera;
    const f = s1 / s0;
    const fixed = { x: (x0 * s1 - x1 * s0) / (s1 - s0), y: (y0 * s1 - y1 * s0) / (s1 - s0) };
    const ground = alphaDiff(before, after, (x, y) => [fixed.x + (x - fixed.x) / f, fixed.y + (y - fixed.y) / f]);
    const panned = alphaDiff(before, after, (x, y) => [x - (x1 - x0), y - (y1 - y0)]);
    const lens = alphaDiff(before, after, (x, y) => [x, y]);
    console.log(`fog, ${what}: zoom ${f.toFixed(3)} from ${s0.toFixed(1)}, ground ${ground.toFixed(2)}, pan change ${panned.toFixed(2)}, lens ${lens.toFixed(2)}`);
    assert.ok(ground < panned / 2, `fog, ${what}: ${ground.toFixed(2)} read through the ground's zoom, ${panned.toFixed(2)} through the pan change`);
    out.push(`fog, ${what}: zoom ${f.toFixed(3)}, ${ground.toFixed(2)} through the ground's zoom against ${panned.toFixed(2)} through the pan change`);
  }
  return out;
}

/**
 * Zooms by small trackpad pinches (a wheel with Ctrl) until the camera
 * stands `u` into an octave of fog's sheets (draw.ts SHEET_SCALE_AT). The
 * sheets crossfade between two octaves through each one (D-261106-301), so
 * how much a zoom changes their look apart from moving them depends on
 * where it starts: 0.8 into an octave a notch changes the octaves' weights
 * least, about a fifth, against half from 0.35.
 */
async function intoOctave(page: Page, at: { x: number; y: number }, u: number): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const scale = (await settledSpots(page)).camera[2];
    const octave = Math.log2(scale / 50);
    const target = 50 * 2 ** (Math.floor(octave - u + 0.5) + u);
    const step = Math.log(target / scale);
    if (Math.abs(step) < 0.004) return;
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down("Control");
    // A pinch's wheel zooms by e to the minus a hundredth of its delta, up to 200 a step (camera.ts wheelZoomFactor).
    await page.mouse.wheel(0, Math.max(-200, Math.min(200, -step * 100)));
    await page.keyboard.up("Control");
    await sleep(150);
  }
}

/** The weather canvas's alpha, with the camera it was drawn at. */
async function fogPixels(page: Page): Promise<{ camera: [number, number, number]; width: number; height: number; alpha: Uint8Array }> {
  const s = await settledSpots(page);
  const read = await page.evaluate(() => {
    type Canvas = { dataset: Record<string, string>; width: number; height: number; getContext(type: "2d"): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null };
    type Stage = { visible(): boolean; width(): number; getLayers(): { getCanvas(): { _canvas: Canvas } }[] };
    for (const stage of (globalThis as unknown as { Konva: { stages: Stage[] } }).Konva.stages) {
      if (!stage.visible() || stage.width() === 0) continue;
      const c = stage.getLayers().find((l) => l.getCanvas()._canvas.dataset.weather !== undefined)?.getCanvas()._canvas;
      if (!c) continue;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const a = new Uint8Array(c.width * c.height);
      for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]!;
      let text = "";
      for (let i = 0; i < a.length; i += 0x8000) text += String.fromCharCode(...a.subarray(i, i + 0x8000));
      return { width: c.width, height: c.height, alpha: (globalThis as unknown as { btoa(s: string): string }).btoa(text) };
    }
    return null;
  });
  assert.ok(read, "a weather canvas to read");
  return { camera: s.camera, width: read.width, height: read.height, alpha: new Uint8Array(Buffer.from(read.alpha, "base64")) };
}

/** The mean alpha difference between `after` and `before` read back through `back`, over the middle of the screen. */
function alphaDiff(before: { width: number; height: number; alpha: Uint8Array }, after: { width: number; height: number; alpha: Uint8Array }, back: (x: number, y: number) => [number, number]): number {
  const { width: w, height: h } = after;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y += 2) {
    for (let x = Math.floor(w * 0.2); x < w * 0.8; x += 2) {
      const [bx, by] = back(x, y);
      const ix = Math.round(bx);
      const iy = Math.round(by);
      if (ix < 0 || iy < 0 || ix >= before.width || iy >= before.height) continue;
      sum += Math.abs(after.alpha[y * w + x]! - before.alpha[iy * before.width + ix]!);
      n++;
    }
  }
  return n ? sum / n : NaN;
}

/** The marks a draw should show: the screen's count spread over the wrap box (sim.ts tileCount), times the scene's area on screen, halved after a step-down to half. */
function expectedMarks(look: NonNullable<ReturnType<typeof lookOf>>, s: Spots): number {
  const density = particleCount(look, s.width, s.height) / ((s.width + 2 * WRAP_MARGIN) * (s.height + 2 * WRAP_MARGIN));
  return density * areaOnScreen(s.clip, s.width, s.height) * (s.level === "half" ? 0.5 : 1);
}

/** The area of a polygon clipped to the screen, by Sutherland and Hodgman's clip and the shoelace. */
function areaOnScreen(poly: readonly number[], w: number, h: number): number {
  let pts: [number, number][] = [];
  for (let k = 0; k + 1 < poly.length; k += 2) pts.push([poly[k]!, poly[k + 1]!]);
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= w, (a, b) => [w, a[1] + ((b[1] - a[1]) * (w - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= h, (a, b) => [a[0] + ((b[0] - a[0]) * (h - a[1])) / (b[1] - a[1]), h]],
  ];
  for (const [inside, cut] of edges) {
    const next: [number, number][] = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k]!;
      const b = pts[(k + 1) % pts.length]!;
      if (inside(a)) next.push(a);
      if (inside(a) !== inside(b)) next.push(cut(a, b));
    }
    pts = next;
  }
  let area = 0;
  for (let k = 0; k < pts.length; k++) area += pts[k]![0] * pts[(k + 1) % pts.length]![1] - pts[(k + 1) % pts.length]![0] * pts[k]![1];
  return Math.abs(area) / 2;
}

/** Takes the keyboard's focus off any control, so + and - reach the map. */
function blurPage(page: Page): Promise<void> {
  return page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?(): void } | null } }).document.activeElement?.blur?.());
}
