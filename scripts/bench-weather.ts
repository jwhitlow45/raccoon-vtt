/**
 * The weather's bench (docs/design/design-v1-weather.md 6.1): what weather
 * over the map costs a mid phone held upright for a long session. It
 * follows bench-iso.ts: the real server on the production build, Chrome
 * with its CPU slowed 4 times, and the main thread's busy time read from
 * Performance.getMetrics TaskDuration. The page is 390 by 844 at 3x on
 * purpose, where bench-iso uses 2x: the weather's canvas stays at 1x and
 * the board's other layers cap at 2, which only a 3x page tests.
 *
 * One room, one scene: the starter Cavern Battlemap (public/starter, CC0),
 * 40 by 40 squares, with 8 creatures. Rows, in Top-down and Isometric:
 *
 * - rest: busy ms a second over 4 s with no weather, then with each kind
 *   heavy and its strongest wind (fog takes a moderate one, which is its
 *   most), moving, each on a page loaded afresh, measured once the
 *   step-down has settled: held still, or two of its windows after the
 *   warm-up that follows its last step (about 8.5 s with no step, 13.5 s
 *   after a halving), with the level it reached and what a tick adds to its
 *   frame. Still and Off with heavy rain too.
 * - pan and drag: each frame's gap while a finger pans the map and drags a
 *   creature, with no weather and with heavy rain and a strong wind.
 * - level after pans: heavy rain and a strong wind on a fresh page, a
 *   finger panning on and off for 11 s, past two windows, and the level
 *   it leaves.
 *
 * Gates (6.1): rest busy at most 60 ms a second over none for every kind,
 * no ticks at rest for Still and Off, and, with a GPU, a pan's and a drag's
 * 95th percentile frame at most 2 ms over none and all the particles still
 * there after the pans, since a pan is the board's work and never the
 * weather's. It exits 1 when one fails.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes its
 * room and deletes it at the end. Run it alone, since other work on the
 * machine skews every number:
 *
 *   DATABASE_URL=postgres://... BENCH_PORT=7591 node scripts/bench-weather.ts --out weather.json
 *
 * `--software` runs Chrome without a GPU for its 2D canvas, the worst case:
 * the raster then runs on the main thread, outside the sceneFunc's own
 * timing. The room measures what each tick adds to its whole frame for the
 * step-down (features/weather/store.ts), and this mode checks that the
 * step-down brings every kind within budget.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright-core";
import sharp from "sharp";
import { OpSocket, ROOT, sleep, SocketWatch, startServer, Touches, waitFor } from "../e2e/harness.ts";
import { WARMUP_MS, WINDOW_MS } from "../client/features/weather/mode.ts";

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const CPU_SLOWDOWN = 4;
const REST_MS = 4000;
const BOUNDS = { w: 40, h: 40 };
const HOOK_FLAG = "globalThis.__rvttIsoTest = true;";

/** The gates of 6.1. */
export const REST_BUDGET_MS_PER_S = 60;
export const FRAME_BUDGET_MS = 2;

type Weather = { kind: string; heavy?: true; wind?: "moderate" | "strong" } | null;
type View = "topDown" | "isometric";

/** Each kind at its heaviest: heavy, with the strongest wind it may have. */
export const HEAVIEST: readonly { name: string; weather: Weather }[] = [
  { name: "rain", weather: { kind: "rain", heavy: true, wind: "strong" } },
  { name: "snow", weather: { kind: "snow", heavy: true, wind: "strong" } },
  // Strong wind disperses fog, so moderate is its most.
  { name: "fog", weather: { kind: "fog", heavy: true, wind: "moderate" } },
  { name: "leaves", weather: { kind: "leaves", heavy: true, wind: "strong" } },
  { name: "ash", weather: { kind: "ash", heavy: true, wind: "strong" } },
  { name: "sand", weather: { kind: "sand", heavy: true, wind: "strong" } },
  { name: "wind", weather: { kind: "clear", wind: "strong" } },
];

export type Row = { row: string; view: View; value: number; unit: "ms/s" | "ms p95" | "ticks" | "level" | "ms" };

/** The step-down's level as a row's value: 0 all the particles, 1 half, 2 still. */
export const LEVELS = ["full", "half", "still"] as const;

export function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

/**
 * Whether the step-down has settled, from the levels read since the page
 * loaded, oldest first: held still, or two windows after the warm-up that
 * follows the last change, so no window it could still judge is left.
 */
export function stepDownSettled(levels: readonly { at: number; level: number }[], now: number): boolean {
  const last = levels.at(-1);
  if (!last) return false;
  if (last.level === LEVELS.indexOf("still")) return true;
  const changed = levels.findLast((l, i) => i === 0 || l.level !== levels[i - 1]!.level)!.at;
  return now - changed >= WARMUP_MS + 2 * WINDOW_MS + 500;
}

const VIEWS = ["topDown", "isometric"] as const;

function rowValue(rows: readonly Row[], row: string, view: View): number | undefined {
  return rows.find((r) => r.row === row && r.view === view)?.value;
}

/** Each pan's and drag's 95th percentile frame that is more than its budget over none's, in words. */
export function gestureOverages(rows: readonly Row[]): string[] {
  const out: string[] = [];
  for (const view of VIEWS) {
    for (const gesture of ["pan", "drag"]) {
      const base = rowValue(rows, `${gesture}, none`, view);
      const rain = rowValue(rows, `${gesture}, rain`, view);
      if (base !== undefined && rain !== undefined && rain - base > FRAME_BUDGET_MS) out.push(`${view} ${gesture}: p95 ${(rain - base).toFixed(1)} ms over none`);
    }
  }
  return out;
}

/**
 * The gates' failures over a run's rows, in words. With a GPU, a pan must
 * never step the weather down. Without one the gestures are information
 * only: a software canvas's frame takes one vsync or two as its raster
 * happens to fall, so a pan's 95th percentile flips between 16.7 and 33.4 ms
 * with no weather as with it, and says nothing of the weather's own cost.
 * That run gates what the step-down leaves at rest.
 */
export function gateFailures(rows: readonly Row[], options: { software?: boolean } = {}): string[] {
  const out: string[] = [];
  const at = (row: string, view: View) => rowValue(rows, row, view);
  const gestures = options.software ? [] : gestureOverages(rows);
  for (const view of VIEWS) {
    const none = at("rest, none", view);
    for (const r of rows.filter((x) => x.view === view && x.row.startsWith("rest, ") && x.unit === "ms/s" && x.row !== "rest, none")) {
      if (none !== undefined && r.value - none > REST_BUDGET_MS_PER_S) out.push(`${view} ${r.row}: ${(r.value - none).toFixed(1)} ms/s over none`);
    }
    out.push(...gestures.filter((line) => line.startsWith(`${view} `)));
    for (const r of rows.filter((x) => x.view === view && x.unit === "ticks")) if (r.value !== 0) out.push(`${view} ${r.row}: ${r.value} ticks at rest`);
    const panned = at("level after pans, rain", view);
    if (!options.software && panned !== undefined && panned !== 0) out.push(`${view} level after pans, rain: ${LEVELS[panned]}`);
  }
  return out;
}

async function busy(cdp: CDPSession): Promise<number> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  return (metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
}

/** The weather canvas's ticks on the stage that shows, or null when none is mounted. */
function ticks(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    type Stage = { visible(): boolean; width(): number; getLayers(): { getCanvas(): { _canvas: { dataset: Record<string, string>; weatherTicks?: number } } }[] };
    const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
    for (const stage of konva?.stages ?? []) {
      if (!stage.visible() || stage.width() === 0) continue;
      const layer = stage.getLayers().find((l) => l.getCanvas()._canvas.dataset.weather !== undefined);
      if (layer) return layer.getCanvas()._canvas.weatherTicks ?? 0;
    }
    return null;
  });
}

/** The step-down's level on the weather canvas that shows (WeatherLayer.tsx `weatherLevel`), as LEVELS' index. */
function level(page: Page): Promise<number> {
  return page.evaluate((levels) => {
    type Stage = { visible(): boolean; width(): number; getLayers(): { getCanvas(): { _canvas: { dataset: Record<string, string>; weatherLevel?: string } } }[] };
    const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
    for (const stage of konva?.stages ?? []) {
      if (!stage.visible() || stage.width() === 0) continue;
      const layer = stage.getLayers().find((l) => l.getCanvas()._canvas.dataset.weather !== undefined);
      if (layer) return Math.max(0, levels.indexOf(layer.getCanvas()._canvas.weatherLevel ?? "full"));
    }
    return 0;
  }, [...LEVELS] as string[]);
}

/** What a tick adds to its frame on the main thread, as the layer measured it (WeatherLayer.tsx `weatherFrameCost`), in ms. */
function frameCost(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Stage = { visible(): boolean; width(): number; getLayers(): { getCanvas(): { _canvas: { dataset: Record<string, string>; weatherFrameCost?: number } } }[] };
    const konva = (globalThis as unknown as { Konva?: { stages: Stage[] } }).Konva;
    for (const stage of konva?.stages ?? []) {
      if (!stage.visible() || stage.width() === 0) continue;
      const layer = stage.getLayers().find((l) => l.getCanvas()._canvas.dataset.weather !== undefined);
      if (layer) return layer.getCanvas()._canvas.weatherFrameCost ?? 0;
    }
    return 0;
  });
}

/** Starts recording each frame's gap on the page, and returns what stops it and gives the gaps. */
async function recordFrames(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate(() => {
    const g = globalThis as unknown as { requestAnimationFrame(cb: (t: number) => void): number; __gaps: number[]; __recording: boolean };
    g.__gaps = [];
    g.__recording = true;
    let last = -1;
    const step = (t: number) => {
      if (last >= 0) g.__gaps.push(t - last);
      last = t;
      if (g.__recording) g.requestAnimationFrame(step);
    };
    g.requestAnimationFrame(step);
  });
  return () =>
    page.evaluate(() => {
      const g = globalThis as unknown as { __gaps: number[]; __recording: boolean };
      g.__recording = false;
      return g.__gaps;
    });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" }, software: { type: "boolean" } } });
  const port = Number(process.env.BENCH_PORT ?? 7591);
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
  const work = mkdtempSync(path.join(tmpdir(), "raccoon-bench-weather-"));
  const server = await startServer({ port, assetDir: path.join(work, "assets"), databaseUrl });
  // --software: a page whose 2D canvas has no GPU, so its raster runs on the main thread, where the sceneFunc's own timing cannot see it.
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: values.software ? ["--disable-gpu", "--disable-accelerated-2d-canvas"] : [] });
  const rows: Row[] = [];
  // Each row prints as it is measured, so a run that stops partway keeps what it had.
  const add = (r: Row) => {
    rows.push(r);
    console.log(`${r.view.padEnd(10)} ${r.row.padEnd(22)} ${r.value.toFixed(1).padStart(8)} ${r.unit}`);
  };
  let roomId = "";
  let roomName = "";
  let ops: OpSocket | null = null;
  const context = await browser.newContext(PHONE);
  try {
    await context.addInitScript(HOOK_FLAG);
    const page = await context.newPage();
    const watch = new SocketWatch("bench");
    await watch.attach(context, page);
    roomName = `Bench weather ${new Date().toISOString().slice(0, 19)}`;
    await page.goto(`${server.origin}/`);
    await page.getByLabel("Room name").fill(roomName);
    await page.getByLabel("Your name").fill("Bench DM");
    await page.getByRole("button", { name: "Create room" }).click();
    await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await page.locator("code").first().textContent()) ?? "";
    roomId = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link)![1]!.replace("-", "");
    await page.getByLabel("I saved my DM link").check();
    await page.getByRole("button", { name: "Continue to the room" }).click();
    await page.locator(".konvajs-content").first().waitFor({ state: "attached" });
    const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId, cookie });
    const sceneId = await waitFor("the scene", () => watch.state?.meta.playerSceneId ?? null);
    const data = await sharp(readFileSync(path.join(ROOT, "public", "starter", "cavern-battlemap", "fe-01.webp"))).png().toBuffer();
    const res = await context.request.put(`${server.origin}/api/rooms/${roomId}/assets?kind=map`, { headers: { Origin: server.origin, "content-type": "image/png" }, data });
    const asset = (await res.json()) as { id: string; width: number; height: number };
    await ops.send({ t: "scene.update", sceneId, patch: { bounds: BOUNDS, fogEnabled: false, defaultView: { x: 20, y: 20, zoom: 40 } } });
    await ops.send({ t: "scene.setMap", sceneId, map: { assetId: asset.id, widthPx: asset.width, heightPx: asset.height, cellPx: 50, originPx: { x: 0, y: 0 } } });
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30 }, initBonus: 2, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = randomUUID();
      ids.push(id);
      await ops.send({ t: "token.create", token: { id, sceneId, kind: "monster", name: `Goblin ${i + 1}`, size: "medium", x: 16 + (i % 4) * 2, y: 18 + Math.floor(i / 4) * 3, disposition: "hostile", visibility: "all", actor: { inline: actor } } });
    }
    await page.reload();
    await page.locator(".konvajs-content").first().waitFor({ state: "attached" });
    await sleep(1500);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const set = async (weather: Weather) => {
      await ops!.send({ t: "scene.update", sceneId, patch: { weather } });
      await sleep(400);
    };
    const throttled = async <T>(run: () => Promise<T>) => {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
      try {
        return await run();
      } finally {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
    };
    // Past the 2 s warm-up and two 3 s windows, so what is measured is after any step-down, as a long session runs.
    // The CPU is slowed from the page's load on, so the warm-up and the step-down judge the slowed page.
    /** Waits until the step-down cannot move again (stepDownSettled), at most 30 s. */
    const settle = async () => {
      const from = Date.now();
      const levels: { at: number; level: number }[] = [];
      while (Date.now() - from < 30_000) {
        levels.push({ at: Date.now(), level: await level(page) });
        if (stepDownSettled(levels, Date.now())) return;
        await sleep(250);
      }
    };
    const rest = async (prepare: () => Promise<void> = async () => {}) =>
      throttled(async () => {
        await prepare();
        await settle();
        const a = await busy(cdp);
        await sleep(REST_MS);
        return ((await busy(cdp)) - a) / (REST_MS / 1000);
      });
    const pick = (view: View) => page.evaluate((v) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(v), view);
    /** The page loaded afresh on `weather` in `view`: a step-down lasts until the page reloads, so each kind starts at full. */
    const fresh = async (view: View, weather: Weather) => {
      await set(weather);
      await page.reload();
      await page.locator(".konvajs-content").first().waitFor({ state: "attached" });
      await waitFor("the test hook", () => page.evaluate(() => ("__rvttIsoHook" in globalThis ? true : null)));
      await pick(view);
      await sleep(800);
    };
    const middle = { x: 195, y: 422 };
    /** One finger panning the map down and right, then back. */
    const swipes = async (touches: Touches) => {
      await touches.start([{ x: 120, y: 300 }]);
      for (let i = 1; i <= 20; i++) await touches.move([{ x: 120 + i * 6, y: 300 + i * 8 }], 16);
      await touches.end([], 16);
      await touches.start([{ x: 240, y: 460 }], 120);
      for (let i = 1; i <= 20; i++) await touches.move([{ x: 240 - i * 6, y: 460 - i * 8 }], 16);
      await touches.end([], 16);
    };
    const pan = async () =>
      throttled(async () => {
        const stop = await recordFrames(page);
        const touches = new Touches(cdp);
        for (let r = 0; r < 3; r++) {
          await swipes(touches);
          await sleep(300);
        }
        return p95(await stop());
      });
    /** Pans on and off from a fresh page past two windows, and reads the level the weather is left at. */
    const panned = async (view: View) =>
      throttled(async () => {
        await fresh(view, HEAVIEST[0]!.weather);
        const touches = new Touches(cdp);
        const from = Date.now();
        while (Date.now() - from < 11_000) {
          await swipes(touches);
          await sleep(500);
        }
        return level(page);
      });
    const drag = async () =>
      throttled(async () => {
        const at = await page.evaluate(() => {
          type Node = { name(): string; getAbsolutePosition(): { x: number; y: number } };
          const konva = (globalThis as unknown as { Konva: { stages: { visible(): boolean; width(): number; find(f: (n: Node) => boolean): Node[]; container(): { getBoundingClientRect(): { left: number; top: number } } }[] } }).Konva;
          for (const stage of konva.stages) {
            if (!stage.visible() || stage.width() === 0) continue;
            const token = stage.find((n) => n.name() === "token")[0];
            if (!token) continue;
            const p = token.getAbsolutePosition();
            const box = stage.container().getBoundingClientRect();
            return { x: box.left + p.x, y: box.top + p.y };
          }
          return null;
        });
        const from = at ?? middle;
        const stop = await recordFrames(page);
        const touches = new Touches(cdp);
        await touches.start([from]);
        for (let i = 1; i <= 30; i++) await touches.move([{ x: from.x + i * 3, y: from.y + i * 2 }], 16);
        for (let i = 29; i >= 0; i--) await touches.move([{ x: from.x + i * 3, y: from.y + i * 2 }], 16);
        await touches.end([], 16);
        await sleep(300);
        return p95(await stop());
      });

    for (const view of ["topDown", "isometric"] as const) {
      await fresh(view, null);
      add({ row: "rest, none", view, value: await rest(), unit: "ms/s" });
      add({ row: "pan, none", view, value: await pan(), unit: "ms p95" });
      add({ row: "drag, none", view, value: await drag(), unit: "ms p95" });
      for (const k of HEAVIEST) {
        add({ row: `rest, ${k.name}`, view, value: await rest(() => fresh(view, k.weather)), unit: "ms/s" });
        add({ row: `level, ${k.name}`, view, value: await level(page), unit: "level" });
        add({ row: `frame cost, ${k.name}`, view, value: await frameCost(page), unit: "ms" });
      }
      await fresh(view, HEAVIEST[0]!.weather);
      add({ row: "pan, rain", view, value: await pan(), unit: "ms p95" });
      add({ row: "drag, rain", view, value: await drag(), unit: "ms p95" });
      add({ row: "level after pans, rain", view, value: await panned(view), unit: "level" });
      for (const mode of ["still", "off"] as const) {
        await page.evaluate((m) => localStorage.setItem("rvtt.weather", m), mode);
        await fresh(view, HEAVIEST[0]!.weather);
        await sleep(700);
        const before = (await ticks(page)) ?? 0;
        add({ row: `rest, rain ${mode}`, view, value: await rest(), unit: "ms/s" });
        add({ row: `ticks, rain ${mode}`, view, value: ((await ticks(page)) ?? 0) - before, unit: "ticks" });
      }
      await page.evaluate(() => localStorage.removeItem("rvtt.weather"));
    }
  } finally {
    ops?.close();
    if (roomId) await context.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
    await context.close();
    await browser.close();
    await server.stop();
    rmSync(work, { recursive: true, force: true });
  }
  if (values.out) writeFileSync(values.out, `${JSON.stringify(rows, null, 2)}\n`);
  const failures = gateFailures(rows, { software: values.software === true });
  if (values.software) for (const line of gestureOverages(rows)) console.log(`information, not gated without a GPU: ${line}`);
  for (const f of failures) console.error(`over budget: ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
