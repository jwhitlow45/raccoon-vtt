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
 *   most), moving. Still and Off with heavy rain too.
 * - pan and drag: each frame's gap while a finger pans the map and drags a
 *   creature, with no weather and with heavy rain and a strong wind.
 *
 * Gates (6.1): rest busy at most 60 ms a second over none for every kind,
 * a pan's and a drag's 95th percentile frame at most 2 ms over none, and
 * no ticks at rest for Still and Off. It exits 1 when one fails.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes its
 * room and deletes it at the end. Run it alone, since other work on the
 * machine skews every number:
 *
 *   DATABASE_URL=postgres://... BENCH_PORT=7591 node scripts/bench-weather.ts --out weather.json
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright-core";
import sharp from "sharp";
import { OpSocket, ROOT, sleep, SocketWatch, startServer, Touches, waitFor } from "../e2e/harness.ts";

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

export type Row = { row: string; view: View; value: number; unit: "ms/s" | "ms p95" | "ticks" };

export function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

/** The gates' failures over a run's rows, in words. */
export function gateFailures(rows: readonly Row[]): string[] {
  const out: string[] = [];
  const at = (row: string, view: View) => rows.find((r) => r.row === row && r.view === view)?.value;
  for (const view of ["topDown", "isometric"] as const) {
    const none = at("rest, none", view);
    for (const r of rows.filter((x) => x.view === view && x.row.startsWith("rest, ") && x.unit === "ms/s" && x.row !== "rest, none")) {
      if (none !== undefined && r.value - none > REST_BUDGET_MS_PER_S) out.push(`${view} ${r.row}: ${(r.value - none).toFixed(1)} ms/s over none`);
    }
    for (const gesture of ["pan", "drag"]) {
      const base = at(`${gesture}, none`, view);
      const rain = at(`${gesture}, rain`, view);
      if (base !== undefined && rain !== undefined && rain - base > FRAME_BUDGET_MS) out.push(`${view} ${gesture}: p95 ${(rain - base).toFixed(1)} ms over none`);
    }
    for (const r of rows.filter((x) => x.view === view && x.unit === "ticks")) if (r.value !== 0) out.push(`${view} ${r.row}: ${r.value} ticks at rest`);
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
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const port = Number(process.env.BENCH_PORT ?? 7591);
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
  const work = mkdtempSync(path.join(tmpdir(), "raccoon-bench-weather-"));
  const server = await startServer({ port, assetDir: path.join(work, "assets"), databaseUrl });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
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
    // Past the 2 s warm-up, so a step-down could show in what is measured.
    const rest = async () =>
      throttled(async () => {
        await sleep(2500);
        const a = await busy(cdp);
        await sleep(REST_MS);
        return ((await busy(cdp)) - a) / (REST_MS / 1000);
      });
    const middle = { x: 195, y: 422 };
    const pan = async () =>
      throttled(async () => {
        const stop = await recordFrames(page);
        const touches = new Touches(cdp);
        for (let r = 0; r < 3; r++) {
          await touches.start([{ x: 120, y: 300 }]);
          for (let i = 1; i <= 20; i++) await touches.move([{ x: 120 + i * 6, y: 300 + i * 8 }], 16);
          await touches.end([], 16);
          await touches.start([{ x: 240, y: 460 }], 120);
          for (let i = 1; i <= 20; i++) await touches.move([{ x: 240 - i * 6, y: 460 - i * 8 }], 16);
          await touches.end([], 16);
          await sleep(300);
        }
        return p95(await stop());
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
      await page.evaluate((v) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(v), view);
      await sleep(800);
      await set(null);
      add({ row: "rest, none", view, value: await rest(), unit: "ms/s" });
      add({ row: "pan, none", view, value: await pan(), unit: "ms p95" });
      add({ row: "drag, none", view, value: await drag(), unit: "ms p95" });
      for (const k of HEAVIEST) {
        await set(k.weather);
        add({ row: `rest, ${k.name}`, view, value: await rest(), unit: "ms/s" });
      }
      await set(HEAVIEST[0]!.weather);
      add({ row: "pan, rain", view, value: await pan(), unit: "ms p95" });
      add({ row: "drag, rain", view, value: await drag(), unit: "ms p95" });
      for (const mode of ["still", "off"] as const) {
        await page.evaluate((m) => localStorage.setItem("rvtt.weather", m), mode);
        await page.reload();
        await page.locator(".konvajs-content").first().waitFor({ state: "attached" });
        await page.evaluate((v) => (globalThis as unknown as { __rvttIsoHook: { pick(p: string): void } }).__rvttIsoHook.pick(v), view);
        await sleep(1500);
        const before = (await ticks(page)) ?? 0;
        add({ row: `rest, rain ${mode}`, view, value: await rest(), unit: "ms/s" });
        add({ row: `ticks, rain ${mode}`, view, value: ((await ticks(page)) ?? 0) - before, unit: "ticks" });
      }
      await page.evaluate(() => localStorage.removeItem("rvtt.weather"));
      await page.reload();
      await page.locator(".konvajs-content").first().waitFor({ state: "attached" });
      await sleep(1000);
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
  const failures = gateFailures(rows);
  for (const f of failures) console.error(`over budget: ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
