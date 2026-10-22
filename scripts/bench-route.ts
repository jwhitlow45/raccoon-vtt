/**
 * The route search's performance gate (docs/design-v1-movement.md section
 * 10): how long a drag's search takes to find a creature's every route
 * within a Dash, within 30 squares, through the next door, and over a whole
 * 200 x 200 dungeon, for a Medium creature on whole squares and a Large one
 * on half squares. Then the densest wall build at the caps (design 9.7) and
 * a stair map of 1 ft and 3 ft rises under 5-10-5, where the vertical
 * residues come in. Each search starts cold, its step answers forgotten, as
 * a phone's first drag after an edit pays them. Last, the reducer's
 * `routeSeen` on a 1,000-spot walk of a lit monster across a dark vision
 * scene at the sight caps (bench-vision.ts capRoom), the sight already
 * worked out, as the op's own stop mark works it out first.
 *
 * Run it alone on the machine being gated, since parallel load skews it:
 *
 *   node scripts/bench-route.ts
 *   node scripts/bench-route.ts --chrome   (also the Dash row in headless Chrome, its CPU 4 times slower)
 *
 * The gates: a Medium route within a Dash under 5 ms and a whole-scene flood
 * under 150 ms on a development laptop, a Large route within 30 squares
 * under 40 ms, the throttled Dash row under 20 ms, a sliced walk's
 * longest slice, true distance's included, under 8 ms, and the board's
 * longest frame of route work, for a drag's aims, 40 rulers and the two
 * together, under 8 ms.
 */
import type { BuildChunk, EdgeFeature, FreeWall, RoomState, Scene, TerrainId } from "../shared/model.ts";
import { LIMITS } from "../shared/limits.ts";
import { footprintGround } from "../shared/rules/heights.ts";
import type { MovingToken } from "../shared/rules/movement.ts";
import { sceneWalls } from "../shared/rules/walls.ts";
import { forgetStepCaches, WalkSearch, WalkWorld, type WalkInput } from "../shared/rules/walk.ts";
import { seenAtEvery } from "../shared/project.ts";
import { atCap, chunksOf, mulberry32, randomWalls, type Build } from "./bench-walls.ts";
import { capRoom } from "./bench-vision.ts";

const SIZE = 200;

/**
 * A 200 x 200 dungeon of 20 x 20 rooms joined by open 5 ft doors, with a
 * pillar and a 3 x 3 patch of rubble in each room.
 */
function dungeon(): Build {
  const cells = new Map<string, TerrainId>();
  const edges = new Map<string, EdgeFeature>();
  const open: EdgeFeature = { kind: "door", state: "open", secret: false, discovered: false };
  for (let ry = 0; ry < SIZE / 20; ry++) {
    for (let rx = 0; rx < SIZE / 20; rx++) {
      const x0 = rx * 20;
      const y0 = ry * 20;
      for (let k = 0; k < 20; k++) {
        if (rx > 0) edges.set(`${x0},${y0 + k},w`, k === 9 ? open : { kind: "wall" });
        if (ry > 0) edges.set(`${x0 + k},${y0},n`, k === 10 ? open : { kind: "wall" });
      }
      cells.set(`${x0 + 4},${y0 + 4}`, "pillar");
      for (let y = 12; y < 15; y++) for (let x = 12; x < 15; x++) cells.set(`${x0 + x},${y0 + y}`, "rubble");
    }
  }
  return { cells, edges, walls: [] };
}

/** Ground rising 1 ft or 3 ft a square eastward and every third square southward, every square a stair's worth: no ledges stop the walk. */
function stairs(rise: number): Build {
  const heights = new Map<string, number>();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) heights.set(`${x},${y}`, Math.min(200, rise * ((x % 40) + Math.floor(y / 3) % 7)));
  return { cells: new Map(), edges: new Map(), walls: [], heights };
}

type Ms = { median: number; max: number };
export type RouteRow = { row: string; budget?: number; settled: number; ms: Ms };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

function stateOf(build: Build, sceneId: string, blockMovement = true): Pick<RoomState, "scenes" | "buildChunks"> {
  const chunks: Record<string, BuildChunk> = chunksOf(build, sceneId);
  const scene = { id: sceneId, rev: 1, bounds: { w: SIZE, h: SIZE }, autoWalls: "all", blockMovement } as Scene;
  const state = { scenes: { [sceneId]: scene }, buildChunks: chunks };
  // The wall set is derived before a drag, cached across drags (walls.ts sceneWalls).
  sceneWalls(scene, chunks);
  return state;
}

type Case = { row: string; budget?: number; state: Pick<RoomState, "scenes" | "buildChunks">; token: Omit<MovingToken, "sceneId">; diagonal?: "five" | "fiveTen"; limit?: number; to?: { x: number; y: number } };

/** Half feet: the search's own units on the grid rules. */
const squares = (n: number) => n * 5 * 2;

export function cases(): Case[] {
  const built = dungeon();
  const rooms = stateOf(built, "bench-route-dungeon");
  // The dungeon crossed by free walls up to the split's pieces cap: the densest wall build a scene may hold where a creature still walks.
  const crossing: FreeWall[] = randomWalls(mulberry32(2026), LIMITS.freeWallsPerScene, 20, 20, 120);
  const capped = stateOf({ ...built, walls: crossing.slice(0, atCap(built, crossing)) }, "bench-route-caps");
  const medium = { size: "medium" as const, x: 45, y: 47, elevation: 0 };
  const large = { size: "large" as const, x: 45, y: 47, elevation: 0 };
  return [
    { row: "Medium, cost up to 12 squares (a 30 ft speed's Dash)", budget: 5, state: rooms, token: medium, limit: squares(12) },
    { row: "Medium, cost up to 30 squares", state: rooms, token: medium, limit: squares(30) },
    { row: "Medium, the whole scene", budget: 150, state: rooms, token: medium },
    { row: "Large, half squares, cost up to 12", state: rooms, token: large, limit: squares(12) },
    { row: "Large, half squares, cost up to 30", budget: 40, state: rooms, token: large, limit: squares(30) },
    { row: "Large, half squares, to the next room through a 5 ft door", state: rooms, token: large, to: { x: 64, y: 47 } },
    { row: "Medium within a Dash on the dungeon crossed by free walls at the pieces cap", state: capped, token: medium, limit: squares(12) },
    { row: "Medium, cost up to 30 squares, the same walls", state: capped, token: medium, limit: squares(30) },
    { row: "Medium within a Dash on 1 ft rises, 5-10-5", state: stateOf(stairs(1), "bench-route-stairs-1", false), token: { size: "medium", x: 45, y: 47, elevation: 0 }, diagonal: "fiveTen", limit: squares(12) },
    { row: "Medium within 30 squares on 3 ft rises, 5-10-5", state: stateOf(stairs(3), "bench-route-stairs-3", false), token: { size: "medium", x: 45, y: 47, elevation: 0 }, diagonal: "fiveTen", limit: squares(30) },
    { row: "Large within a Dash on 3 ft rises, 5-10-5", state: stateOf(stairs(3), "bench-route-stairs-3ld", false), token: { size: "large", x: 45, y: 47, elevation: 0 }, diagonal: "fiveTen", limit: squares(12) },
    { row: "Large within 30 squares on 3 ft rises, 5-10-5", state: stateOf(stairs(3), "bench-route-stairs-3l", false), token: { size: "large", x: 45, y: 47, elevation: 0 }, diagonal: "fiveTen", limit: squares(30) },
  ];
}

/** One search as a drag runs it: the world built, then settled to a spot and its route traced, or flooded to a cost. */
function runCase(c: Case): number {
  const sceneId = Object.keys(c.state.scenes)[0]!;
  // On its own ground, so a walker on the stairs stands on them.
  const token = { ...c.token, sceneId, elevation: footprintGround(c.state.buildChunks, { ...c.token, sceneId }) };
  const input: WalkInput = { build: c.state, token, rules: { feetPerCell: 5, diagonal: c.diagonal ?? "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } };
  const search = new WalkSearch(new WalkWorld(input));
  // A spot's row times the completed route, the trace with the fewest corners included (review ASTRA-08).
  if (c.to) {
    search.settle(c.to);
    search.routeTo(c.to);
  } else search.flood(c.limit ?? Infinity);
  return search.settled;
}

export function runRouteBench(runs = 15, only?: (c: Case) => boolean): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const raw of cases()) {
    if (only && !only(raw)) continue;
    const c = raw;
    let settled = 0;
    const times: number[] = [];
    for (let r = 0; r < runs + 3; r++) {
      forgetStepCaches();
      const t = performance.now();
      settled = runCase(c);
      if (r >= 3) times.push(performance.now() - t);
    }
    rows.push({ row: c.row, ...(c.budget !== undefined ? { budget: c.budget } : {}), settled, ms: stats(times) });
  }
  return rows;
}

/**
 * The trace of a cheapest walk with the fewest corners (5.3, `routeTo`),
 * once the spot is settled: a Large creature round a wall 40 squares long
 * on open ground, 80 squares to walk, where many cheapest walks tie. Its
 * `settled` column holds the states the search settled first.
 */
export function runTraceRow(runs = 15): RouteRow {
  return traceRow("Large round a 40-square wall, 80 squares: the trace with the fewest corners", 40, 40, { x: 80, y: 2 }, runs);
}

/**
 * The trace's worst case (review MV-O-17): a Large creature past a wall 60
 * squares long, then 140 squares on across open ground, where the cheapest
 * walks tie by the tens of thousands, so the trace stops at MAX_TRACED and
 * keeps the first arrival's walk. Gated at the Large row's 40 ms.
 */
export function runLongTraceRow(runs = 15): RouteRow {
  return { ...traceRow("Large past a 60-square wall, about 148 squares: the trace, bounded", 10, 60, { x: 150, y: 72 }, runs), budget: 40 };
}

/**
 * Walks as a drag finds them, a 4 ms slice a frame (review ASTRA-08): the
 * settle, the trace and its pieces, true distance's pulling taut included,
 * each slice ended by the same deadline. Rows: the whole route over all its
 * slices, and the longest slice, which a frame pays and which may run past
 * the 4 ms by no more than one poll of the clock. `settled` holds the
 * slices.
 */
export function runSlicedRows(runs = 15): RouteRow[] {
  return [
    ...slicedRows("Large past a 60-square wall, about 148 squares, as a drag finds it", "five", { x: 150, y: 72 }, runs),
    ...slicedRows("Large past a 60-square wall to the far side, true distance, as a drag finds it", "euclid", { x: 198, y: 100 }, runs),
  ];
}

function slicedRows(row: string, diagonal: "five" | "euclid", to: { x: number; y: number }, runs: number): RouteRow[] {
  const SLICE = 4;
  const edges = new Map<string, EdgeFeature>();
  for (let y = 0; y < 60; y++) edges.set(`10,${y},w`, { kind: "wall" });
  const sceneId = `bench-route-sliced-${diagonal}`;
  const state = stateOf({ cells: new Map(), edges, walls: [], heights: new Map() }, sceneId);
  const token = { size: "large" as const, x: 2, y: 2, elevation: 0, sceneId };
  const whole: number[] = [];
  const longest: number[] = [];
  let slices = 0;
  for (let r = 0; r < runs + 3; r++) {
    forgetStepCaches();
    const search = new WalkSearch(new WalkWorld({ build: state, token, rules: { feetPerCell: 5, diagonal }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }));
    let total = 0;
    let worst = 0;
    let n = 0;
    for (let done = false; !done; n++) {
      const t = performance.now();
      const settled = search.settle(to, t + SLICE);
      done = settled !== "paused" && (settled !== "settled" || search.traceTo(to, t + SLICE) !== "paused");
      const spent = performance.now() - t;
      total += spent;
      worst = Math.max(worst, spent);
    }
    if (r >= 3) {
      whole.push(total);
      longest.push(worst);
      slices = n;
    }
  }
  return [
    { row: `${row}: settle, trace and pieces, ${SLICE} ms slices (settled holds the slices)`, settled: slices, ms: stats(whole) },
    { row: `${row}: its longest slice`, budget: 2 * SLICE, settled: slices, ms: stats(longest) },
  ];
}

function traceRow(row: string, wallX: number, wallLength: number, to: { x: number; y: number }, runs: number): RouteRow {
  const edges = new Map<string, EdgeFeature>();
  for (let y = 0; y < wallLength; y++) edges.set(`${wallX},${y},w`, { kind: "wall" });
  const sceneId = `bench-route-trace-${wallX}-${wallLength}`;
  const state = stateOf({ cells: new Map(), edges, walls: [], heights: new Map() }, sceneId);
  const token = { size: "large" as const, x: 2, y: 2, elevation: 0, sceneId };
  let settled = 0;
  const times: number[] = [];
  for (let r = 0; r < runs + 3; r++) {
    const search = new WalkSearch(new WalkWorld({ build: state, token, rules: { feetPerCell: 5, diagonal: "five" }, seen: null, creatures: [], areas: [], prone: false, counter: { h: 0, v: 0 } }));
    search.settle(to);
    settled = search.settled;
    const t = performance.now();
    search.routeTo(to);
    if (r >= 3) times.push(performance.now() - t);
  }
  return { row, settled, ms: stats(times) };
}

/**
 * `routeSeen`'s cost: a lit monster in the hall of the capped dark scene,
 * walked back and forth past the party for 1,000 spots, every one of them
 * in the party's sight, so no early answer cuts it short. Its `settled`
 * column holds the spots asked.
 */
export function runRouteSeenRow(runs = 15): RouteRow {
  const { state } = capRoom("dark");
  const monster = { ...state.tokens.m0!, x: 74, y: 95 };
  const spots = Array.from({ length: 1000 }, (_, k) => {
    const lap = Math.floor(k / 50);
    const along = k % 50;
    return { x: 74 + (lap % 2 === 0 ? along : 49 - along), y: 95 + (lap % 3), elevation: 0 };
  });
  const env = { opVersion: undefined };
  const seen = seenAtEvery(state, monster, spots, env);
  const times: number[] = [];
  for (let r = 0; r < runs + 3; r++) {
    const t = performance.now();
    seenAtEvery(state, monster, spots, env);
    if (r >= 3) times.push(performance.now() - t);
  }
  return { row: `routeSeen, 1,000 spots of a lit monster on a dark vision scene at the sight caps${seen ? "" : " (an unseen spot cut it short)"}`, settled: spots.length, ms: stats(times) };
}

export function formatRouteBench(rows: readonly RouteRow[], where = "laptop"): string {
  const lines = [`search (${where}) | settled | ms (median / max) | budget`, "--- | --- | --- | ---"];
  for (const r of rows) {
    const verdict = r.budget === undefined ? "" : `${r.budget} ms ${r.ms.median <= r.budget ? "met" : "MISSED"}`;
    lines.push(`${r.row} | ${r.settled.toLocaleString("en-US")} | ${r.ms.median.toFixed(2)} / ${r.ms.max.toFixed(2)} | ${verdict}`);
  }
  return lines.join("\n");
}

/** The Dash row in a browser, for the throttled run: the same search, bundled. */
export function runDashRow(runs = 15): RouteRow[] {
  return runRouteBench(runs, (c) => c.row.startsWith("Medium, cost up to 12")).map((r) => ({ ...r, budget: 20 }));
}

const CPU_SLOWDOWN = 4;

/**
 * The Dash row in headless Chrome with its CPU throttled 4 times, standing
 * in for a phone (`Emulation.setCPUThrottlingRate`). The search is bundled
 * by Vite from this very file, its Node-only parts left out.
 */
async function runChrome(): Promise<string> {
  const vite = await import("vite");
  const { chromium } = await import("playwright-core");
  const here = new URL(import.meta.url).pathname;
  const entry = "\0bench-route-entry";
  const out = await vite.build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "bench-route-entry",
        resolveId: (id: string) => (id === entry ? id : null),
        load: (id: string) => (id === entry ? `import { runDashRow } from ${JSON.stringify(here)}; globalThis.__runDashRow = runDashRow;` : null),
      },
    ],
    build: { write: false, minify: false, rollupOptions: { input: entry, external: ["vite", "playwright-core"], output: { format: "es" } } },
  });
  const output = (Array.isArray(out) ? out[0] : out) as { output: { type: string; code?: string; isEntry?: boolean }[] };
  // The entry, should the bundle ever hold another chunk.
  const code = output.output.find((o) => o.type === "chunk" && o.isEntry === true)?.code;
  if (!code) throw new Error("Vite gave no bundle");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => typeof (globalThis as { __runDashRow?: unknown }).__runDashRow === "function");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
    const rows = (await page.evaluate(() => (globalThis as unknown as { __runDashRow: (runs: number) => RouteRow[] }).__runDashRow(15))) as RouteRow[];
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    return formatRouteBench(rows, `headless Chrome, ${CPU_SLOWDOWN}x slower CPU`);
  } finally {
    await browser.close();
  }
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  // The walking ruler's and the public world's rows read client code and the test rooms, so only the Node run loads them, never the Chrome bundle.
  const nodeOnly = "./bench-ruler.ts";
  const { runFrameRows, runPublicWorldRow, runRulerRows } = (await import(/* @vite-ignore */ nodeOnly)) as typeof import("./bench-ruler.ts");
  console.log(formatRouteBench([...runRouteBench(), runTraceRow(), runLongTraceRow(), ...runSlicedRows(), runRouteSeenRow(), runPublicWorldRow(), ...runRulerRows(), ...runFrameRows()]));
  if (argv.includes("--chrome")) {
    console.log("");
    console.log(await runChrome());
  }
}
