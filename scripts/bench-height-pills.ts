/**
 * Part 8's timing for the height pills (docs/design-v1-visual.md 3.4). The
 * pills follow the map and keep off the token names, so their spots are
 * placed again on every zoom step of a pinch, each checked against the
 * placed names and plates. The budget: the height layer, that check
 * included, adds at most 4 ms to a frame of a pinch on a phone.
 *
 * Two parts, over one scene: 300 height regions (square platforms 3 to 6
 * cells wide, a cell apart, 100 by 88 cells) and 40 goblins standing on
 * them, each with a name and an HP line.
 *
 * - In Node, the spot pass alone (heights/boardText.ts placeHeightPills)
 *   at three zooms: a phone fitted to the whole scene, a closer zoom, and
 *   40 px a cell. The names come from the real label pass
 *   (lib/boardText.ts). Node measures text by an estimate, not a font, so
 *   the widths differ a little from a browser's.
 * - With `--chrome`, a 20-step pinch in and back out on a phone-sized page
 *   in Chrome, its CPU throttled 4 times to stand in for a phone. Each step
 *   is one frame of the camera, and the main thread's busy time for it is
 *   read from Chrome (Performance.getMetrics TaskDuration). The same pinch
 *   runs with Height mode open and with the builder in Label mode, which
 *   draws the same build and no height marks, alternating over several
 *   rounds. What the layer adds is the difference of the two, step by step.
 *   On a busy machine that difference is noisy, so the same pinch also
 *   runs under Chrome's CPU profiler, which times the layer's own code
 *   alone. This part runs the real server on the production build, so it needs
 *   `pnpm build` first and a Postgres in DATABASE_URL. It makes a room and
 *   deletes it at the end.
 *
 * Run it alone, since other work on the machine skews every number:
 *
 *   node scripts/bench-height-pills.ts
 *   DATABASE_URL=postgres://... BENCH_PORT=3190 node scripts/bench-height-pills.ts --chrome
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { CHUNK_CELLS, type BuildChunk } from "../shared/model.ts";
import { encodeHeights } from "../shared/rules/heights.ts";
import { OpSocket, ROOT, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";
import { heightTextSizes, placeHeightPills } from "../client/features/builder/heights/boardText.ts";
import { heightRegions, type HeightRegion } from "../client/features/builder/heights/regions.ts";
import { boardSizes } from "../client/lib/boardScale.ts";
import { labelStyle, placeLabels, type Box, type LabelInput, type Obstacle } from "../client/lib/boardText.ts";
import { DECOR_MIN_PX } from "../client/lib/tokenView.ts";

export const BOUNDS = { w: 100, h: 88 };
/** What HeightLayer.tsx numbers at most. */
const MAX_NUMBERS = 300;
const FEET = [5, 10, 15, 20, 25, 30, -5, -10, -15, -20];

/** Every painted cell's height, keyed "x,y": 16 rows of square platforms, 3 to 6 cells wide by row, a cell apart. */
export function benchHeights(): Map<string, number> {
  const out = new Map<string, number>();
  let y = 0;
  let n = 0;
  for (let row = 0; row < 16; row++) {
    const side = 3 + (row % 4);
    for (let x = 0; x + side <= BOUNDS.w; x += side + 1) {
      const feet = FEET[n++ % FEET.length]!;
      for (let dy = 0; dy < side; dy++) for (let dx = 0; dx < side; dx++) out.set(`${x + dx},${y + dy}`, feet);
    }
    y += side + 1;
  }
  return out;
}

export type Goblin = { name: string; x: number; y: number };

/** Forty goblins in eight staggered rows of five, standing on the platforms. */
export function benchGoblins(): Goblin[] {
  const out: Goblin[] = [];
  for (let row = 0; row < 8; row++) for (let col = 0; col < 5; col++) out.push({ name: `Goblin ${out.length + 1}`, x: 3 + col * 20 + (row % 2) * 9, y: 2 + row * 11 });
  return out;
}

/**
 * Text widths as canvas/measureText.ts estimates them where there is no
 * canvas: a share of an em a character, bold pills a little wider than the
 * labels' weight 600. Node has no fonts, and that file needs the DOM.
 */
const measureLabel = (text: string, px: number) => text.length * px * 0.58;
const measurePill = (text: string, px: number) => text.length * px * 0.62;

function chunksOf(heights: ReadonlyMap<string, number>): BuildChunk[] {
  const byChunk = new Map<string, number[]>();
  for (const [key, v] of heights) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const id = `${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`;
    let feet = byChunk.get(id);
    if (!feet) byChunk.set(id, (feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0)));
    feet[(y % CHUNK_CELLS) * CHUNK_CELLS + (x % CHUNK_CELLS)] = v;
  }
  return [...byChunk].map(([id, feet]) => {
    const [cx, cy] = id.split(",").map(Number) as [number, number];
    return { sceneId: "bench", cx, cy, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) };
  });
}

/**
 * The names' boxes at a zoom, as Stage hands them to the layer: each
 * goblin's label placed by the real label pass, below or above it. A token
 * under DECOR_MIN_PX on screen tries for no name unless it is acting or the
 * viewer's own (canvas/useBoardText.ts), and these goblins are neither.
 */
function labelBoxes(goblins: readonly Goblin[], cellPx: number): Box[] {
  if (cellPx < DECOR_MIN_PX) return [];
  const sizes = boardSizes(cellPx, 1);
  const obstacles: Obstacle[] = [];
  const inputs: LabelInput[] = [];
  for (const [i, t] of goblins.entries()) {
    const box = { x0: t.x * cellPx, y0: t.y * cellPx, x1: (t.x + 1) * cellPx, y1: (t.y + 1) * cellPx };
    obstacles.push({ box, owner: String(i), kind: "body" });
    inputs.push({ id: String(i), box, belowY: box.y1 + sizes.gapPx, aboveY: box.y0 - sizes.gapPx, name: t.name, hp: "7/7", alert: false, rank: 0, sides: false, nameOnly: false, style: labelStyle(sizes, cellPx, cellPx) });
  }
  return [...placeLabels(inputs, obstacles, measureLabel).values()].filter((p) => p.lines.length > 0).map((p) => p.box);
}

type Ms = { median: number; max: number };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

function time(runs: number, work: () => void): Ms {
  const times: number[] = [];
  for (let r = 0; r < runs + 2; r++) {
    const t = performance.now();
    work();
    // The first two runs warm the engine up.
    if (r >= 2) times.push(performance.now() - t);
  }
  return stats(times);
}

export type BenchRow = { row: string; ms: Ms };

/** A phone 390 px wide fitted to the scene's width (too small a zoom for names), a closer zoom, and the zoom where board text has its design size. */
const NODE_SCALES = [390 / BOUNDS.w, 20, 40];

export function runNodeBench(runs = 101): BenchRow[] {
  const regions: HeightRegion[] = heightRegions(chunksOf(benchHeights()), BOUNDS).slice(0, MAX_NUMBERS).reverse();
  if (regions.length !== MAX_NUMBERS) throw new Error(`the scene has ${regions.length} numbered regions, not ${MAX_NUMBERS}`);
  const goblins = benchGoblins();
  const rows: BenchRow[] = [];
  for (const cellPx of NODE_SCALES) {
    const labels = labelBoxes(goblins, cellPx);
    const { pill } = heightTextSizes(cellPx, 1);
    const placed = placeHeightPills(regions, labels, cellPx, pill, measurePill).length;
    rows.push({
      row: `spot pass in Node: ${regions.length} regions, ${labels.length} names, ${cellPx.toFixed(1)} px a cell (${placed} pills placed)`,
      ms: time(runs, () => void placeHeightPills(regions, labels, cellPx, pill, measurePill)),
    });
  }
  return rows;
}

// The pinch in Chrome.

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const STEPS = 20;
const ROUNDS = 8;
const CPU_SLOWDOWN = 4;
const BUDGET_MS = 4;

function actor() {
  return {
    hp: { cur: 7, max: 7, temp: 0 },
    life: "alive",
    ac: 15,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 9,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  };
}

/** Resolves once the page has drawn a few frames, long after a camera step's render and Konva's draw. */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const raf = (globalThis as unknown as { requestAnimationFrame(cb: () => void): number }).requestAnimationFrame;
        let n = 0;
        const frame = () => (++n < 4 ? raf(frame) : setTimeout(resolve, 0));
        raf(frame);
      }),
  );
}

/** The main thread's busy time so far in ms, and the time now in µs on the clock CPU profiles use. */
async function metrics(cdp: CDPSession): Promise<{ busy: number; at: number }> {
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  const read = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { busy: read("TaskDuration") * 1000, at: read("Timestamp") * 1e6 };
}

type Pinch = { x: number; y: number; from: number; to: number };

/**
 * Two fingers, one above the other, spread over STEPS moves and then close
 * over as many. Returns the main thread's busy time for each move, in
 * order, when each move's frames began and ended, and the camera's scale
 * at the widest.
 */
async function pinch(page: Page, cdp: CDPSession, p: Pinch): Promise<{ busy: number[]; windows: [number, number][]; widest: number }> {
  const points = (d: number) => [
    { x: p.x, y: p.y - d / 2, id: 0 },
    { x: p.x, y: p.y + d / 2, id: 1 },
  ];
  const ratio = p.to / p.from;
  const spans = [...Array.from({ length: STEPS }, (_, i) => p.from * ratio ** ((i + 1) / STEPS)), ...Array.from({ length: STEPS }, (_, i) => p.from * ratio ** ((STEPS - i - 1) / STEPS))];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(p.from) });
  await settle(page);
  const busy: number[] = [];
  const windows: [number, number][] = [];
  let widest = 0;
  for (const d of spans) {
    const before = await metrics(cdp);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(d) });
    await settle(page);
    const after = await metrics(cdp);
    busy.push(after.busy - before.busy);
    windows.push([before.at, after.at]);
    if (busy.length === STEPS) widest = await cameraScale(page);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle(page);
  return { busy, windows, widest };
}

type CpuProfile = {
  nodes: { id: number; callFrame: { url: string }; children?: number[] }[];
  startTime: number;
  samples: number[];
  timeDeltas: number[];
};

/**
 * The time each step spent in the height layer's own code, from a CPU
 * profile: every sample whose stack passes through the layer's lazy chunk
 * (HeightLayer.tsx and boardText.ts, built as HeightLayer-<hash>.js), its
 * canvas calls and text measures included. Unlike the frame difference
 * above, it leaves out the rest of the page, so other work on the machine
 * moves it far less.
 */
function layerMsPerStep(profile: CpuProfile, windows: readonly [number, number][]): number[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const inLayer = new Map<number, boolean>();
  const underLayer = (id: number): boolean => {
    let hit = inLayer.get(id);
    if (hit === undefined) {
      const up = parent.get(id);
      hit = /\/HeightLayer-[^/]*\.js$/.test(byId.get(id)?.callFrame.url ?? "") || (up !== undefined && underLayer(up));
      inLayer.set(id, hit);
    }
    return hit;
  };
  const out = windows.map(() => 0);
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0;
    // A sample stands for the time until the next one.
    const span = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    if (!underLayer(profile.samples[i]!)) continue;
    const step = windows.findIndex(([a, b]) => t >= a && t < b);
    if (step >= 0) out[step]! += span;
  }
  if (out.every((ms) => ms === 0)) throw new Error("The profile has no samples in the height layer's chunk: did its file name change?");
  return out;
}

async function cameraScale(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as { Konva: { stages: { scaleX(): number }[] } }).Konva.stages[0]!.scaleX());
}

export async function runChromeBench(): Promise<BenchRow[]> {
  if (!existsSync(path.join(ROOT, "dist/index.html"))) throw new Error("No production build in dist/. Run `pnpm build` first.");
  const port = Number(process.env.BENCH_PORT ?? 3190);
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
  const work = mkdtempSync(path.join(tmpdir(), "raccoon-bench-pills-"));
  const server = await startServer({ port, assetDir: path.join(work, "assets"), databaseUrl });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const socket = new SocketWatch("dm");
  await socket.attach(context, page);
  const roomName = `Bench height pills ${new Date().toISOString().slice(0, 19)}`;
  let roomId = "";
  let ops: OpSocket | null = null;
  try {
    await page.goto(`${server.origin}/`);
    await page.getByLabel("Room name").fill(roomName);
    await page.getByLabel("Your name").fill("Dana the DM");
    await page.getByRole("button", { name: "Create room" }).click();
    await page.getByRole("heading", { name: "Save your DM link" }).waitFor();
    const link = (await page.locator("code").first().textContent()) ?? "";
    const match = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link);
    if (!match) throw new Error(`The DM link looks wrong: ${link}`);
    roomId = match[1]!.replace("-", "");
    await page.getByLabel("I saved my DM link").check();
    await page.getByRole("button", { name: "Continue to the room" }).click();
    await waitFor("the DM's snapshot", () => socket.state);
    const sceneId = socket.state!.meta.playerSceneId!;

    const cookie = (await context.cookies(server.origin)).map((c) => `${c.name}=${c.value}`).join("; ");
    ops = await OpSocket.open({ origin: server.origin, roomId, cookie });
    await ops.send({ t: "scene.update", sceneId, patch: { bounds: BOUNDS, fogEnabled: false } });
    const byFeet = new Map<number, string[]>();
    for (const [key, feet] of benchHeights()) byFeet.set(feet, [...(byFeet.get(feet) ?? []), key]);
    for (const [height, cells] of byFeet) for (let i = 0; i < cells.length; i += 2000) await ops.send({ t: "build.height", sceneId, cells: cells.slice(i, i + 2000), height });
    for (const g of benchGoblins()) {
      await ops.send({ t: "token.create", token: { id: randomUUID(), sceneId, kind: "monster", name: g.name, size: "medium", x: g.x, y: g.y, disposition: "hostile", visibility: "all", actor: { inline: actor() } } });
    }
    await waitFor("every goblin in the DM's view", () => Object.keys(socket.state?.tokens ?? {}).length >= 40 || null);
    const revs = () => JSON.stringify(Object.values(socket.state?.buildChunks ?? {}).map((c) => c?.rev));
    const setUp = revs();

    await page.reload();
    await page.getByRole("status", { name: "Connected" }).first().waitFor();
    await page.getByRole("button", { name: "Map builder" }).click();
    const mode = page.getByLabel("Builder mode");
    await mode.selectOption("height");

    // The pinch spreads about the middle of the map, as far as the map's height allows.
    const canvas = await page.locator("canvas").first().boundingBox();
    if (!canvas) throw new Error("No map canvas");
    const options = await page.getByRole("toolbar", { name: "Map builder options" }).boundingBox();
    const top = canvas.y;
    const bottom = options ? Math.min(options.y, canvas.y + canvas.height) : canvas.y + canvas.height;
    const p: Pinch = { x: canvas.x + canvas.width / 2, y: (top + bottom) / 2, from: 60, to: Math.min(480, (bottom - top) * 0.9) };

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "timeTicks" });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
    const fitted = await cameraScale(page);
    let closest = fitted;
    const runs: Record<"open" | "closed", number[][]> = { open: [], closed: [] };
    // A first pinch in each mode warms the engine up and is not counted.
    for (let round = -1; round < ROUNDS; round++) {
      const order: ("open" | "closed")[] = round % 2 === 0 ? ["open", "closed"] : ["closed", "open"];
      for (const which of order) {
        await mode.selectOption(which === "open" ? "height" : "label");
        await settle(page);
        const { busy, widest } = await pinch(page, cdp, p);
        closest = widest;
        if (round >= 0) runs[which].push(busy);
      }
    }
    // Then the same pinch under the profiler, apart from the timed rounds, since sampling slows the page.
    await mode.selectOption("height");
    await settle(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
    const profiled: number[][] = [];
    for (let i = 0; i < 3; i++) {
      await cdp.send("Profiler.start");
      const { windows } = await pinch(page, cdp, p);
      const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
      profiled.push(layerMsPerStep(profile, windows));
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    if (revs() !== setUp) throw new Error("The pinch changed the build: a finger painted.");

    // Each step's median over the rounds, then the difference step by step.
    const perStep = (which: "open" | "closed") => Array.from({ length: 2 * STEPS }, (_, i) => stats(runs[which].map((r) => r[i]!)).median);
    const open = perStep("open");
    const closed = perStep("closed");
    const added = open.map((v, i) => v - closed[i]!);
    const own = Array.from({ length: 2 * STEPS }, (_, i) => stats(profiled.map((r) => r[i]!)).median);
    const where = `${STEPS}-step pinch in and out, ${fitted.toFixed(1)} to ${closest.toFixed(1)} px a cell, ${CPU_SLOWDOWN}x slower CPU, median of ${ROUNDS} rounds a step`;
    return [
      { row: `Chrome frame, Height mode open (${where})`, ms: stats(open) },
      { row: "Chrome frame, Label mode (the same build, no height marks)", ms: stats(closed) },
      { row: `added by the height layer, frame minus frame (budget ${BUDGET_MS} ms a frame)`, ms: stats(added) },
      { row: "the height layer's own code in a CPU profile, median of 3 pinches a step", ms: stats(own) },
    ];
  } finally {
    ops?.close();
    if (roomId) {
      const res = await context.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => null);
      if (!res?.ok()) console.error(`Could not delete the bench room ${roomId}`);
    }
    await browser.close();
    await server.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

export function formatBench(rows: readonly BenchRow[]): string {
  const lines = ["row | ms (median / max)", "--- | ---"];
  for (const r of rows) lines.push(`${r.row} | ${r.ms.median.toFixed(3)} / ${r.ms.max.toFixed(3)}`);
  return lines.join("\n");
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  const rows = runNodeBench();
  if (argv.includes("--chrome")) rows.push(...(await runChromeBench()));
  console.log(formatBench(rows));
}
