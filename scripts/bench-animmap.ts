/**
 * Animated maps' bench (docs/design/design-v1-animated-maps.md 6.1): what a
 * playing map costs a mid phone held upright for a long session. It follows
 * bench-weather.ts: the real server on the production build with its
 * ANIMATED_MAPS switch on, Chrome with its CPU slowed 4 times, a page of
 * 390 by 844 at 3x, and Heavy rain with a strong wind over the map.
 *
 * The video is a 1920 x 1080, 30 fps VP9 WebM, passed with --video (the
 * fixture script in e2e/fixtures/README.md makes one at that size). Its
 * still is a plain image of its size. Two scenes:
 *
 * - square: 50 px squares, at 20 px a square on screen.
 * - hex: 20 px hexes, zoomed out until a hex is just over HEX_LINES_MIN_PX,
 *   where the grid's lines cost the most.
 *
 * Rows, on each scene:
 * - pan and drag: each frame's 95th percentile gap while a finger pans the
 *   map and drags a creature, with the video playing and with the same
 *   scene on its still.
 * - draw: the main thread's time per video draw, median and 95th
 *   percentile, from the board's own timing (features/animmap/board.ts).
 * - most a second: the most video draws in any second over 10 s, and the
 *   draws while the page is hidden and on Still.
 * Then the long run: a 10 minute session on the hex scene, the JS heap and
 * the page's element count after a garbage collection at its start and end.
 *
 * Gates (6.1): a pan's and a drag's p95 at most 2 ms over the still, a
 * draw's median at most 1.5 ms and its p95 at most 4 ms, at most 32 video
 * draws in any second and none while hidden or on Still, and the heap and
 * the element count within 5% of where they began. It exits 1 when one
 * fails.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes its
 * room and deletes it at the end. Run it alone, since other work on the
 * machine skews every number:
 *
 *   DATABASE_URL=postgres://... BENCH_PORT=7592 node scripts/bench-animmap.ts --video map-1080p.webm --out animmap.json
 *
 * `--minutes 2` shortens the long run, for a quick look.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright-core";
import sharp from "sharp";
import { OpSocket, sleep, SocketWatch, startServer, Touches, waitFor } from "../e2e/harness.ts";

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const CPU_SLOWDOWN = 4;

/** The gates of 6.1. */
export const FRAME_BUDGET_MS = 2;
export const DRAW_MEDIAN_MS = 1.5;
export const DRAW_P95_MS = 4;
export const MOST_A_SECOND = 32;
export const DRIFT = 0.05;

export type Scene = "square" | "hex" | "session";
export type Row = { row: string; scene: Scene; value: number; unit: "ms p95" | "ms" | "draws" | "share" | "bytes" | "nodes" };

export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/** The gates' failures over a run's rows, in words. */
export function gateFailures(rows: readonly Row[]): string[] {
  const out: string[] = [];
  const at = (row: string, scene: Scene) => rows.find((r) => r.row === row && r.scene === scene)?.value;
  for (const scene of ["square", "hex"] as const) {
    for (const gesture of ["pan", "drag"]) {
      const still = at(`${gesture}, still`, scene);
      const moving = at(`${gesture}, moving`, scene);
      if (still !== undefined && moving !== undefined && moving - still > FRAME_BUDGET_MS) out.push(`${scene} ${gesture}: p95 ${(moving - still).toFixed(1)} ms over the still`);
    }
    const median = at("draw median", scene);
    const p95 = at("draw p95", scene);
    if (median !== undefined && median > DRAW_MEDIAN_MS) out.push(`${scene}: a video draw's median ${median.toFixed(2)} ms`);
    if (p95 !== undefined && p95 > DRAW_P95_MS) out.push(`${scene}: a video draw's p95 ${p95.toFixed(2)} ms`);
    const most = at("most a second", scene);
    if (most !== undefined && most > MOST_A_SECOND) out.push(`${scene}: ${most} video draws in one second`);
    for (const quiet of ["draws hidden", "draws on Still"]) {
      const n = at(quiet, scene);
      if (n !== undefined && n !== 0) out.push(`${scene}: ${n} ${quiet}`);
    }
  }
  for (const drift of ["heap drift", "element drift"]) {
    const v = at(drift, "session");
    if (v !== undefined && Math.abs(v) > DRIFT) out.push(`session: ${drift} ${(v * 100).toFixed(1)}%`);
  }
  return out;
}

type Host = { dataset: Record<string, string | undefined>; animMapDraws?: number; animMapDrawMs?: number[] };

function boardState(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelector(s: string): Host | null } }).document;
    return doc.querySelector("[data-animmap-board]")?.dataset.animmap ?? null;
  });
}

function draws(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelector(s: string): Host | null } }).document;
    return doc.querySelector("[data-animmap-board]")?.animMapDraws ?? 0;
  });
}

function drawTimes(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { querySelector(s: string): Host | null } }).document;
    return doc.querySelector("[data-animmap-board]")?.animMapDrawMs ?? [];
  });
}

/** The most video draws in any one second over `ms`, read on every animation frame. */
function mostInASecond(page: Page, ms: number): Promise<number> {
  return page.evaluate(
    (span) =>
      new Promise<number>((resolve) => {
        const g = globalThis as unknown as { document: { querySelector(s: string): Host | null }; requestAnimationFrame(cb: (t: number) => void): number };
        const host = g.document.querySelector("[data-animmap-board]");
        const times: number[] = [];
        let last = host?.animMapDraws ?? 0;
        let start = -1;
        const step = (t: number) => {
          if (start < 0) start = t;
          const now = host?.animMapDraws ?? 0;
          for (; last < now; last++) times.push(t);
          if (t - start < span) return void g.requestAnimationFrame(step);
          let most = 0;
          let lo = 0;
          for (let hi = 0; hi < times.length; hi++) {
            while (times[hi]! - times[lo]! >= 1000) lo++;
            most = Math.max(most, hi - lo + 1);
          }
          resolve(most);
        };
        g.requestAnimationFrame(step);
      }),
    ms,
  );
}

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

async function metrics(cdp: CDPSession): Promise<{ heap: number; nodes: number }> {
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  return { heap: metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0, nodes: metrics.find((m) => m.name === "Nodes")?.value ?? 0 };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" }, video: { type: "string" }, minutes: { type: "string" } } });
  if (!values.video) throw new Error("--video <a 1920 x 1080, 30 fps VP9 WebM> is needed (e2e/fixtures/README.md)");
  const minutes = Number(values.minutes ?? 10);
  const port = Number(process.env.BENCH_PORT ?? 7592);
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
  const work = mkdtempSync(path.join(tmpdir(), "raccoon-bench-animmap-"));
  process.env.ANIMATED_MAPS = "1";
  const server = await startServer({ port, assetDir: path.join(work, "assets"), databaseUrl });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const rows: Row[] = [];
  const add = (r: Row) => {
    rows.push(r);
    console.log(`${r.scene.padEnd(8)} ${r.row.padEnd(18)} ${r.value.toFixed(r.unit === "share" ? 4 : 2).padStart(12)} ${r.unit}`);
  };
  let roomId = "";
  let roomName = "";
  let ops: OpSocket | null = null;
  const context = await browser.newContext(PHONE);
  try {
    const page = await context.newPage();
    const watch = new SocketWatch("bench");
    await watch.attach(context, page);
    roomName = `Bench animated maps ${new Date().toISOString().slice(0, 19)}`;
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
    const squareId = await waitFor("the scene", () => watch.state?.meta.playerSceneId ?? null);

    const headers = { Origin: server.origin };
    const up = await context.request.put(`${server.origin}/api/rooms/${roomId}/assets?kind=video`, { headers: { ...headers, "content-type": "video/webm" }, data: readFileSync(values.video) });
    if (!up.ok()) throw new Error(`the video upload answered ${up.status()}: ${await up.text()}`);
    const video = (await up.json()) as { id: string; width: number; height: number; video?: Record<string, unknown> };
    if (video.width !== 1920 || video.height !== 1080) console.warn(`the video is ${video.width} x ${video.height}, not 1920 x 1080`);
    const stillPng = await sharp({ create: { width: video.width, height: video.height, channels: 3, background: { r: 60, g: 70, b: 60 } } }).png().toBuffer();
    const stillRes = await context.request.put(`${server.origin}/api/rooms/${roomId}/assets?kind=map`, { headers: { ...headers, "content-type": "image/png" }, data: stillPng });
    const still = (await stillRes.json()) as { id: string; width: number; height: number };
    const mapVideo = { container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 4000, kbps: 1, ...video.video, assetId: video.id, widthPx: video.width, heightPx: video.height };
    const map = (cellPx: number, moving: boolean) => ({ assetId: still.id, widthPx: still.width, heightPx: still.height, cellPx, originPx: { x: 0, y: 0 }, ...(moving ? { video: mapVideo } : {}) });

    const square = { id: squareId, cellPx: 50, zoom: 20 };
    const hex = { id: randomUUID(), cellPx: 20, zoom: 7 };
    const squareBounds = { w: Math.floor(still.width / square.cellPx), h: Math.floor(still.height / square.cellPx) };
    const hexBounds = { w: Math.floor(still.width / hex.cellPx), h: Math.floor(still.height / hex.cellPx) };
    await ops.send({ t: "scene.update", sceneId: square.id, patch: { bounds: squareBounds, fogEnabled: false, defaultView: { x: squareBounds.w / 2, y: squareBounds.h / 2, zoom: square.zoom }, weather: { kind: "rain", heavy: true, wind: "strong" } } });
    await ops.send({ t: "scene.create", scene: { id: hex.id, name: "Hex", bounds: hexBounds, fogEnabled: false, gridShape: "hexRows", defaultView: { x: hexBounds.w / 2, y: hexBounds.h / 2, zoom: hex.zoom } } });
    await ops.send({ t: "scene.update", sceneId: hex.id, patch: { weather: { kind: "rain", heavy: true, wind: "strong" } } });
    const actor = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 13, speeds: { walk: 30 }, initBonus: 2, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    for (const s of [{ ...square, bounds: squareBounds }, { ...hex, bounds: hexBounds }]) {
      for (let i = 0; i < 8; i++) {
        await ops.send({ t: "token.create", token: { id: randomUUID(), sceneId: s.id, kind: "monster", name: `Goblin ${i + 1}`, size: "medium", x: Math.floor(s.bounds.w / 2) - 4 + (i % 4) * 2, y: Math.floor(s.bounds.h / 2) - 2 + Math.floor(i / 4) * 3, disposition: "hostile", visibility: "all", actor: { inline: actor } } });
      }
    }

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const throttled = async <T>(run: () => Promise<T>) => {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
      try {
        return await run();
      } finally {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
    };
    const fresh = async (sceneId: string, cellPx: number, moving: boolean) => {
      await ops!.send({ t: "scene.setMap", sceneId, map: map(cellPx, moving) });
      // A reloaded DM page opens on the players' scene.
      await ops!.send({ t: "room.setPlayerScene", sceneId });
      await page.reload();
      await page.locator(".konvajs-content").first().waitFor({ state: "attached" });
      await waitFor(moving ? "the video playing" : "the still", async () => {
        const state = await boardState(page);
        return (moving ? state === "playing" : state === "none") ? true : null;
      }, 20_000);
      // Past the step-down's warm-up and the weather's.
      await sleep(2500);
    };
    const pan = () =>
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
        return quantile(await stop(), 0.95);
      });
    const drag = () =>
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
        const from = at ?? { x: 195, y: 422 };
        const stop = await recordFrames(page);
        const touches = new Touches(cdp);
        await touches.start([from]);
        for (let i = 1; i <= 30; i++) await touches.move([{ x: from.x + i * 3, y: from.y + i * 2 }], 16);
        for (let i = 29; i >= 0; i--) await touches.move([{ x: from.x + i * 3, y: from.y + i * 2 }], 16);
        await touches.end([], 16);
        await sleep(300);
        return quantile(await stop(), 0.95);
      });

    for (const [name, s] of [["square", square], ["hex", hex]] as const) {
      await fresh(s.id, s.cellPx, false);
      add({ row: "pan, still", scene: name, value: await pan(), unit: "ms p95" });
      add({ row: "drag, still", scene: name, value: await drag(), unit: "ms p95" });
      await fresh(s.id, s.cellPx, true);
      add({ row: "pan, moving", scene: name, value: await pan(), unit: "ms p95" });
      add({ row: "drag, moving", scene: name, value: await drag(), unit: "ms p95" });
      // The draws at rest, slowed as the gestures were.
      const times = await throttled(async () => {
        await sleep(12_000);
        return drawTimes(page);
      });
      add({ row: "draw median", scene: name, value: quantile(times, 0.5), unit: "ms" });
      add({ row: "draw p95", scene: name, value: quantile(times, 0.95), unit: "ms" });
      add({ row: "most a second", scene: name, value: await throttled(() => mostInASecond(page, 10_000)), unit: "draws" });
      add({ row: "state", scene: name, value: (await boardState(page)) === "playing" ? 1 : 0, unit: "share" });
      // Hidden, as a locked phone: no draws.
      await page.evaluate(() => {
        const doc = (globalThis as unknown as { document: { dispatchEvent(e: unknown): void } }).document;
        Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => "hidden" });
        doc.dispatchEvent(new Event("visibilitychange"));
      });
      await sleep(300);
      let before = await draws(page);
      await sleep(3000);
      add({ row: "draws hidden", scene: name, value: (await draws(page)) - before, unit: "draws" });
      // Still, on this device.
      await page.evaluate(() => localStorage.setItem("rvtt.animatedMaps", "still"));
      await page.reload();
      await page.locator(".konvajs-content").first().waitFor({ state: "attached" });
      await sleep(1500);
      before = await draws(page);
      await sleep(3000);
      add({ row: "draws on Still", scene: name, value: (await draws(page)) - before, unit: "draws" });
      await page.evaluate(() => localStorage.removeItem("rvtt.animatedMaps"));
    }

    // The long session: the hex scene playing with heavy rain, slowed throughout.
    await fresh(hex.id, hex.cellPx, true);
    const start = await metrics(cdp);
    await throttled(async () => {
      const end = Date.now() + minutes * 60_000;
      while (Date.now() < end) {
        // A pan now and then, as a session has.
        const touches = new Touches(cdp);
        await touches.start([{ x: 160, y: 400 }]);
        for (let i = 1; i <= 10; i++) await touches.move([{ x: 160 + i * 4, y: 400 + (i % 2) * 3 }], 16);
        await touches.end([], 16);
        await sleep(30_000);
      }
    });
    const end = await metrics(cdp);
    add({ row: "heap start", scene: "session", value: start.heap, unit: "bytes" });
    add({ row: "heap end", scene: "session", value: end.heap, unit: "bytes" });
    add({ row: "heap drift", scene: "session", value: (end.heap - start.heap) / start.heap, unit: "share" });
    add({ row: "elements start", scene: "session", value: start.nodes, unit: "nodes" });
    add({ row: "elements end", scene: "session", value: end.nodes, unit: "nodes" });
    add({ row: "element drift", scene: "session", value: (end.nodes - start.nodes) / start.nodes, unit: "share" });
    add({ row: "state", scene: "session", value: (await boardState(page)) === "playing" ? 1 : 0, unit: "share" });
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
