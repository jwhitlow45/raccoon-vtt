/**
 * The geometry rows of the wave 3 performance gate
 * (docs/design-v1-maps-vision.md section 4.3.6): the split's counting pass
 * on an op that writes geometry, and deriving, splitting and indexing a
 * scene's walls, on scenes at the split's caps and just past them. Wave 4
 * adds raised edges and stairs to the derive, and the movement rows: the leg
 * test while dragging, a squeezing creature's shifted paths included, the
 * work a phone does for a drag frame (the client's drop plan, part 4F), and
 * the derive a leg test pays after a door or build edit. Run it on the
 * machine being gated:
 *
 *   node scripts/bench-walls.ts
 *
 * The phone row runs the same `runBench` in a browser. Nothing here touches
 * Node, so a bundler can take this file as it is.
 *
 * A row over its budget means a cap comes down (section 4.3.6), not that
 * this file changes.
 */
import { wallChunk } from "../shared/keys.ts";
import type { BuildChunk, EdgeFeature, FreeWall, RoomState, Scene, StairMark, TerrainId } from "../shared/model.ts";
import { checkLimits, LIMITS } from "../shared/limits.ts";
import { encodeHeights } from "../shared/rules/heights.ts";
import { landing, legStop, ownWalk, type MovingToken } from "../shared/rules/movement.ts";
import { AREAS, SIGHT } from "../shared/rules/segments.ts";
import { countChunksSplit, sceneWalls, splitCheck } from "../shared/rules/walls.ts";
import { planOne } from "../client/features/movement/drop.ts";

const SIZE = 200;
const CHUNK = 16;

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Build = { cells: Map<string, TerrainId>; edges: Map<string, EdgeFeature>; walls: FreeWall[]; heights?: Map<string, number>; marks?: Map<string, StairMark> };

/**
 * A 200 x 200 dungeon of 20 x 20 rooms joined by doors and windows, a pillar
 * or two in each room. Its walls are drawn edges, 3,600 of them.
 */
function dungeon(rand: () => number): Build {
  const cells = new Map<string, TerrainId>();
  const edges = new Map<string, EdgeFeature>();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) cells.set(`${x},${y}`, "stone");
  for (let ry = 0; ry < SIZE / 20; ry++) {
    for (let rx = 0; rx < SIZE / 20; rx++) {
      const x0 = rx * 20;
      const y0 = ry * 20;
      for (let k = 0; k < 20; k++) {
        if (rx > 0) edges.set(`${x0},${y0 + k},w`, k === 9 ? { kind: "door", state: rand() < 0.5 ? "open" : "closed", secret: false, discovered: false } : { kind: "wall" });
        if (ry > 0) edges.set(`${x0 + k},${y0},n`, k === 10 ? { kind: "window" } : { kind: "wall" });
      }
      cells.set(`${x0 + 4},${y0 + 4}`, "pillar");
      if (rand() < 0.5) cells.set(`${x0 + 14},${y0 + 12}`, "pillar");
    }
  }
  return { cells, edges, walls: [] };
}

/** A wall drawn on every edge of the scene, which only the drawn edge cap refuses. */
function drawnEverywhere(): Build {
  const edges = new Map<string, EdgeFeature>();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (y > 0) edges.set(`${x},${y},n`, { kind: "wall" });
      if (x > 0) edges.set(`${x},${y},w`, { kind: "wall" });
    }
  }
  return { cells: new Map(), edges, walls: [] };
}

/**
 * The densest grid walls a build can have, every other cell painted so every
 * edge is a wall, with the most pillars, doors and windows and drawn edges
 * the caps allow spread evenly over it. The doors and windows sit on west
 * edges, where each also cuts a long vertical run, and the rest of the drawn
 * edges are walls drawn over north edges' automatic ones.
 */
export function checkerboard(): Build {
  const cells = new Map<string, TerrainId>();
  const stride = Math.floor((SIZE * SIZE) / 2 / LIMITS.pillarsPerScene);
  let k = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((x + y) % 2 !== 0) continue;
      cells.set(`${x},${y}`, k % stride === 0 && k / stride < LIMITS.pillarsPerScene ? "pillar" : "stone");
      k++;
    }
  }
  const edges = new Map<string, EdgeFeature>();
  const west = (SIZE - 1) * SIZE;
  for (let d = 0; d < LIMITS.doorsAndWindowsPerScene; d++) {
    const e = Math.floor((d * west) / LIMITS.doorsAndWindowsPerScene);
    edges.set(`${1 + (e % (SIZE - 1))},${Math.floor(e / (SIZE - 1))},w`, d % 2 === 0 ? { kind: "door", state: "closed", secret: d % 4 === 0, discovered: false } : { kind: "window" });
  }
  const north = SIZE * (SIZE - 1);
  const plain = LIMITS.drawnEdgesPerScene - LIMITS.doorsAndWindowsPerScene;
  for (let d = 0; d < plain; d++) {
    const e = Math.floor((d * north) / plain);
    edges.set(`${e % SIZE},${1 + Math.floor(e / SIZE)},n`, { kind: "wall" });
  }
  return { cells, edges, walls: [] };
}

function q64(v: number): number {
  return Math.round(v * 64) / 64;
}

let wallIds = 0;
function wall(ax: number, ay: number, bx: number, by: number): FreeWall {
  return { id: `b${String(wallIds++).padStart(11, "0")}`, a: [q64(ax), q64(ay)], b: [q64(bx), q64(by)], f: { kind: "wall" } };
}

/** Random walls of 2 to 8 cells, at any angle, inside a square of `side` cells at (x0, y0). */
export function randomWalls(rand: () => number, count: number, x0: number, y0: number, side: number): FreeWall[] {
  const out: FreeWall[] = [];
  while (out.length < count) {
    const ax = x0 + rand() * side;
    const ay = y0 + rand() * side;
    const len = 2 + rand() * 5.9;
    const t = rand() * Math.PI * 2;
    const bx = ax + Math.cos(t) * len;
    const by = ay + Math.sin(t) * len;
    if (bx < 0 || by < 0 || bx > SIZE || by > SIZE) continue;
    const w = wall(ax, ay, bx, by);
    if (w.a[0] === w.b[0] && w.a[1] === w.b[1]) continue;
    out.push(w);
  }
  return out;
}

/** Parallel walls packed so their boxes overlap a lot and they never cross: candidate pairs without pieces. */
function parallelWalls(count: number, x0: number, y0: number, pitch: number): FreeWall[] {
  const out: FreeWall[] = [];
  const perRow = Math.floor(60 / pitch);
  for (let k = 0; k < count; k++) {
    const x = x0 + (k % perRow) * pitch;
    // A row step off the walls' own slope, so no two rows line up end to end.
    const y = y0 + Math.floor(k / perRow) * (2 * pitch + 1 / 64);
    out.push(wall(x, y, x + 6, y + 2));
  }
  return out;
}

/** The build as stored: 16 x 16 chunks, each free wall in the chunk of its midpoint. */
export function chunksOf(build: Build, sceneId: string): Record<string, BuildChunk> {
  const out: Record<string, BuildChunk> = {};
  const at = (cx: number, cy: number) => (out[`${sceneId}:${cx},${cy}`] ??= { sceneId, cx, cy, rev: 1, cells: {}, edges: {} });
  for (const [key, terrain] of build.cells) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    at(Math.floor(x / CHUNK), Math.floor(y / CHUNK)).cells[key] = terrain;
  }
  for (const [key, feature] of build.edges) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    at(Math.floor(Math.min(x, SIZE - 1) / CHUNK), Math.floor(Math.min(y, SIZE - 1) / CHUNK)).edges[key] = feature;
  }
  for (const w of build.walls) {
    const { cx, cy } = wallChunk(w);
    (at(cx, cy).walls ??= []).push(w);
  }
  const relief = (values: Map<string, number | string> | undefined, empty: number | string, write: (chunk: BuildChunk, cells: (number | string)[]) => void) => {
    const byChunk = new Map<string, (number | string)[]>();
    for (const [key, v] of values ?? []) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      const chunk = at(Math.floor(x / CHUNK), Math.floor(y / CHUNK));
      const k = `${chunk.cx},${chunk.cy}`;
      if (!byChunk.has(k)) byChunk.set(k, new Array(CHUNK * CHUNK).fill(empty));
      byChunk.get(k)![(y % CHUNK) * CHUNK + (x % CHUNK)] = v;
    }
    for (const [k, cells] of byChunk) write(out[`${sceneId}:${k}`]!, cells);
  };
  relief(build.heights, 0, (chunk, cells) => (chunk.heights = encodeHeights(cells as number[])));
  relief(build.marks, ".", (chunk, cells) => (chunk.up = cells.join("")));
  return out;
}

/** The longest prefix of `walls` whose scene stays within the caps, found by bisection (the counts only grow with more walls). */
export function atCap(base: Build, walls: FreeWall[]): number {
  const fits = (n: number) => countChunksSplit(Object.values(chunksOf({ ...base, walls: walls.slice(0, n) }, "probe")), "all").over === null;
  let lo = 0;
  let hi = walls.length;
  if (fits(hi)) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The dungeon with every door open and a 10 ft platform in the north half
 * of every room, reached by a stair one cell wide: heights in every chunk.
 */
function raisedDungeon(rand: () => number): Build {
  const base = dungeon(rand);
  for (const [key, f] of base.edges) if (f.kind === "door") base.edges.set(key, { ...f, state: "open" });
  const heights = new Map<string, number>();
  const marks = new Map<string, StairMark>();
  for (let ry = 0; ry < SIZE / 20; ry++) {
    for (let rx = 0; rx < SIZE / 20; rx++) {
      for (let y = 1; y < 8; y++) for (let x = 1; x < 19; x++) heights.set(`${rx * 20 + x},${ry * 20 + y}`, 10);
      marks.set(`${rx * 20 + 15},${ry * 20 + 8}`, "a");
    }
  }
  return { ...base, heights, marks };
}

/** Heights on every other cell of the scene, the most raised edges a scene can have. */
function heightCheckerboard(): Build {
  const heights = new Map<string, number>();
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if ((x + y) % 2 === 0) heights.set(`${x},${y}`, 5 * (1 + ((x * 7 + y * 3) % 6)));
  return { cells: new Map(), edges: new Map(), walls: [], heights };
}

type Scenario = { name: string; build: Build };

function scenarios(): Scenario[] {
  const rand = mulberry32(2026);
  const rooms = dungeon(rand);
  const empty: Build = { cells: new Map(), edges: new Map(), walls: [] };
  // Crossing walls over the dungeon, crossing its walls, each other and its pillars, up to the pieces cap.
  const crossing = randomWalls(rand, LIMITS.freeWallsPerScene, 20, 20, 120);
  const piecesAt = atCap(rooms, crossing);
  // Parallel walls packed over a plain map, up to the pairs cap.
  const packed = parallelWalls(LIMITS.freeWallsPerScene, 10, 10, 0.25);
  const pairsAt = atCap(empty, packed);
  const imported = randomWalls(rand, 1_000, 0, 0, SIZE);
  // Walls whose boxes share rows and overlap along x but never meet: the sweep compares them all the same.
  const stacked = Array.from({ length: LIMITS.freeWallsPerScene }, (_, k) => wall(50 + (k % 4) * 8, 50 + Math.floor(k / 4) / 64, 58 + (k % 4) * 8, 50 + Math.floor(k / 4) / 64));
  // The worst of those: one cell row, its 64 lattice lines each holding coincident 8-cell walls, dealt out a line at a time so every prefix spreads over them.
  const onLines = (count: number) => Array.from({ length: count }, (_, k) => wall(50, 50 + (k % 64) / 64, 58, 50 + (k % 64) / 64));
  const linesAt = atCap(empty, onLines(LIMITS.freeWallsPerScene));
  // Coincident walls on one line: every pair compared meets along the whole line.
  const oneLine = Array.from({ length: 1_000 }, () => wall(50, 50, 58, 50));
  const oneLineAt = atCap(empty, oneLine);
  // Vertical 8-cell walls over the dungeon, each in nine rows: the most bookkeeping per wall, crossing the dungeon's walls.
  const tall = Array.from({ length: LIMITS.freeWallsPerScene }, (_, k) => {
    const x = 20 + Math.round(k * 2.5) / 64;
    const y = 20.5 + (k % 17) * 7.25;
    return wall(x, y, x, y + 8);
  });
  const tallAt = atCap(rooms, tall);
  const checkers = checkerboard();
  // Vertical walls over the whole scene, and two walls in opposite corners: either way every grid segment and pillar side is in the counting pass.
  const wide = Array.from({ length: LIMITS.freeWallsPerScene }, (_, k) => {
    const x = 0.5 + Math.round(k * 3.17) / 64;
    const y = 0.25 + (k % 24) * 8;
    return wall(x, y, x, y + 7.75);
  });
  const wideAt = atCap(checkers, wide);
  const checkersCrossingAt = atCap(checkers, crossing);
  const corners = [wall(0.5, 0.25, 1.5, 0.25), wall(198.5, 199.25, 199.5, 199.25)];
  const pillars = `${LIMITS.pillarsPerScene} pillars, ${LIMITS.drawnEdgesPerScene} drawn edges, ${LIMITS.doorsAndWindowsPerScene} of them doors and windows (their caps)`;
  return [
    { name: "builder dungeon, no free walls", build: rooms },
    { name: "builder dungeon with a platform and a stair in every room", build: raisedDungeon(mulberry32(2027)) },
    { name: "heights on every other cell (80,000 raised edges)", build: heightCheckerboard() },
    { name: `import, 1,000 free walls`, build: { ...empty, walls: imported } },
    { name: "4,000 free walls stacked 1/64 apart", build: { ...empty, walls: stacked } },
    { name: "3,520 walls, 55 on each of 64 lines 1/64 apart", build: { ...empty, walls: onLines(3_520) } },
    { name: `${linesAt} walls on 64 lines 1/64 apart (pairs cap)`, build: { ...empty, walls: onLines(linesAt) } },
    { name: `${oneLineAt} coincident walls on one line (pairs cap)`, build: { ...empty, walls: oneLine.slice(0, oneLineAt) } },
    { name: `dungeon + ${tallAt} tall free walls`, build: { ...rooms, walls: tall.slice(0, tallAt) } },
    { name: `checkerboard, ${pillars} + ${wideAt} tall free walls (pieces cap)`, build: { ...checkers, walls: wide.slice(0, wideAt) } },
    { name: `checkerboard, ${pillars} + ${checkersCrossingAt} crossing free walls (pieces cap)`, build: { ...checkers, walls: crossing.slice(0, checkersCrossingAt) } },
    { name: `checkerboard, ${pillars} + 2 free walls in opposite corners`, build: { ...checkers, walls: corners } },
    { name: "a wall drawn on every edge + 2 free walls (refused: drawn edges)", build: { ...drawnEverywhere(), walls: corners } },
    { name: `dungeon + ${piecesAt} crossing free walls (pieces cap)`, build: { ...rooms, walls: crossing.slice(0, piecesAt) } },
    { name: `dungeon + ${piecesAt + 5} crossing free walls (refused)`, build: { ...rooms, walls: crossing.slice(0, piecesAt + 5) } },
    { name: `${pairsAt} packed free walls (pairs cap)`, build: { ...empty, walls: packed.slice(0, pairsAt) } },
    { name: `${Math.min(pairsAt + 20, packed.length)} packed free walls (refused)`, build: { ...empty, walls: packed.slice(0, Math.min(pairsAt + 20, packed.length)) } },
  ];
}

type Ms = { median: number; max: number };
export type BenchRow = { scenario: string; pairs: number; pieces: number; refused: boolean; countMs: Ms; deriveMs: Ms; moveMs: Ms; coldMs: Ms };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

/** A room holding only the scene, for the limits step's per-scene counts. */
function roomOf(scene: Scene, chunks: Record<string, BuildChunk>): RoomState {
  const none = {};
  return {
    scenes: { [scene.id]: scene },
    buildChunks: chunks,
    ...Object.fromEntries(["characters", "members", "handouts", "monsters", "srdImages", "savedEncounters", "tokens", "templates", "drawings", "labels", "fogDrafts", "stamps", "lights"].map((k) => [k, none])),
  } as unknown as RoomState;
}

/*
 * Everything a scene's walls cost once derived: the stored segments, the
 * split, the area and sight sets and the per-cell index. A set over the
 * caps stops after its count, as it does everywhere.
 */
function deriveAll(scene: Scene, chunks: Record<string, BuildChunk>): void {
  const walls = sceneWalls(scene, chunks);
  if (walls.count.over !== null) return;
  walls.segmentsWith(AREAS);
  walls.segmentsWith(SIGHT);
  void walls.storedIndex;
}

/**
 * An op writes a chunk or a few, and the staged state shares every other
 * chunk object with the committed one, so the count and derive rows replace
 * one chunk per run, a different one each time, as a build edit or a door
 * does. The cold row replaces every chunk, as loading a room or a device's
 * first look at a scene does. No run can reuse a wall set, since its chunks
 * are never the same objects twice.
 */
export function runBench(runs = 15): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const { name, build } of scenarios()) {
    const sceneId = `bench-${rows.length}`;
    let chunks = chunksOf(build, sceneId);
    const keys = Object.keys(chunks).sort();
    const scene = { id: sceneId, rev: 1, bounds: { w: SIZE, h: SIZE } } as Scene;
    const count = countChunksSplit(Object.values(chunks), "all");
    const limits = checkLimits(roomOf(scene, chunks), sceneId);
    const countTimes: number[] = [];
    const deriveTimes: number[] = [];
    const moveTimes: number[] = [];
    const coldTimes: number[] = [];
    deriveAll(scene, chunks);
    for (let r = 0; r < runs + 2; r++) {
      const edit = () => {
        const key = keys[(r * 7919) % keys.length]!;
        chunks = { ...chunks, [key]: { ...chunks[key]! } };
        return chunks;
      };
      const staged = { scenes: { [sceneId]: scene }, buildChunks: edit() };
      let t = performance.now();
      splitCheck(staged, sceneId);
      const countMs = performance.now() - t;
      // What the first leg test after an edit pays: the stored segments and their index, no split.
      const moved = edit();
      t = performance.now();
      void sceneWalls(scene, moved).storedIndex;
      const moveMs = performance.now() - t;
      const next = edit();
      t = performance.now();
      deriveAll(scene, next);
      const deriveMs = performance.now() - t;
      const cold = Object.fromEntries(Object.entries(chunks).map(([k, c]) => [k, { ...c }]));
      t = performance.now();
      deriveAll(scene, cold);
      const coldMs = performance.now() - t;
      // The first two runs warm the engine up.
      if (r >= 2) {
        countTimes.push(countMs);
        deriveTimes.push(deriveMs);
        moveTimes.push(moveMs);
        coldTimes.push(coldMs);
      }
    }
    rows.push({ scenario: name, pairs: count.pairs, pieces: count.pieces, refused: count.over !== null || !limits.ok, countMs: stats(countTimes), deriveMs: stats(deriveTimes), moveMs: stats(moveTimes), coldMs: stats(coldTimes) });
  }
  return rows;
}

export function formatBench(rows: readonly BenchRow[]): string {
  const ms = (s: Ms) => `${s.median.toFixed(1)} / ${s.max.toFixed(1)}`;
  const lines = [
    "scenario | pairs | pieces | refused | count after an edit, ms | derive after an edit, ms | movement derive after an edit, ms | derive cold, ms",
    "--- | --- | --- | --- | --- | --- | --- | ---",
  ];
  for (const r of rows) lines.push(`${r.scenario} | ${r.pairs} | ${r.pieces} | ${r.refused ? "yes" : "no"} | ${ms(r.countMs)} | ${ms(r.deriveMs)} | ${ms(r.moveMs)} | ${ms(r.coldMs)}`);
  lines.push("", "Times are median / max over the runs.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The leg test (section 4.3.6: 1 ms on a phone while dragging)

export type MoveRow = { scenario: string; allowed: boolean; ms: Ms };

/** A corridor one cell wide, 40 cells long, walled by short imported free walls and closed at its east end. */
function freeCorridor(): Build {
  const walls: FreeWall[] = [];
  for (let k = 0; k < 160; k++) {
    const x = 20 + k / 4;
    walls.push(wall(x, 50, x + 1 / 4, 50), wall(x, 51, x + 1 / 4, 51));
  }
  walls.push(wall(60, 50, 60, 51));
  return { cells: new Map(), edges: new Map(), walls };
}

export function runMovementBench(runs = 200): MoveRow[] {
  const rand = mulberry32(2028);
  const raised = raisedDungeon(rand);
  const checkers = checkerboard();
  const crossing = randomWalls(rand, LIMITS.freeWallsPerScene, 20, 20, 120);
  const at = atCap(checkers, crossing);
  /*
   * `frame` runs what a phone runs when a drag frame crosses into another
   * quarter cell (client/features/movement/stageHooks.ts): the client's drop
   * plan from the unsnapped finger, the squeezed spot under it tried first,
   * then the rule's landing with its last clear spot.
   */
  type Case = { name: string; build: Build; token: Omit<MovingToken, "sceneId">; to: { x: number; y: number; elevation: number }; drop?: boolean; frame?: boolean };
  const large = { size: "large" as const, elevation: 0 };
  const cases: Case[] = [
    // Room (0, 1) to room (1, 1) through the open door at (20, 29): the core lines up only on a shifted path.
    { name: "Large creature through a 5 ft door on a shifted path, 12 cells", build: raised, token: { ...large, x: 13, y: 28 }, to: { x: 24, y: 28, elevation: 0 } },
    { name: "Large creature into a wall: every one of the 81 paths, 12 cells", build: raised, token: { ...large, x: 13, y: 33 }, to: { x: 24, y: 33, elevation: 0 } },
    { name: "Large creature up onto a platform off the stair: a ledge, every path", build: raised, token: { ...large, x: 5, y: 32 }, to: { x: 5, y: 23, elevation: 10 } },
    { name: "Medium creature across five rooms, 100 cells, stopped at a wall", build: raised, token: { size: "medium", elevation: 0, x: 3, y: 33 }, to: { x: 103, y: 37, elevation: 0 } },
    { name: "Large creature along a 40-cell corridor of 320 free walls, stopped at its end", build: freeCorridor(), token: { ...large, x: 20.5, y: 49.5, squeeze: true }, to: { x: 62.5, y: 49.5, elevation: 0 } },
    { name: `Large creature on the checkerboard at its caps + ${at} crossing free walls, 20 cells`, build: { ...checkers, walls: crossing.slice(0, at) }, token: { ...large, x: 60, y: 60 }, to: { x: 80, y: 75, elevation: 0 } },
    { name: "Huge creature dropped 60 cells into a wall: the last clear spot", build: raised, token: { size: "huge", elevation: 0, x: 4, y: 32 }, to: { x: 64, y: 34, elevation: 0 }, drop: true },
    { name: "Drag frame: Large creature held at a wall 12 cells on, its squeezed spot tried first", build: raised, token: { ...large, x: 13, y: 33 }, to: { x: 24.3, y: 33.2, elevation: 0 }, frame: true },
    { name: "Drag frame: Huge creature 60 cells into a wall", build: raised, token: { size: "huge", elevation: 0, x: 4, y: 32 }, to: { x: 64.2, y: 34.4, elevation: 0 }, frame: true },
    { name: "Drag frame: squeezed Large creature along the corridor of 320 free walls", build: freeCorridor(), token: { ...large, x: 20.5, y: 49.5, squeeze: true }, to: { x: 40.2, y: 49.7, elevation: 0 }, frame: true },
    { name: "Drag frame: Medium creature across five rooms, stopped at a wall", build: raised, token: { size: "medium", elevation: 0, x: 3, y: 33 }, to: { x: 103.2, y: 37.1, elevation: 0 }, frame: true },
  ];
  const rows: MoveRow[] = [];
  for (const c of cases) {
    const sceneId = `move-bench-${rows.length}`;
    const chunks = chunksOf(c.build, sceneId);
    const scene = { id: sceneId, rev: 1, bounds: { w: SIZE, h: SIZE }, autoWalls: "all", blockMovement: true } as Scene;
    const state = { scenes: { [sceneId]: scene }, buildChunks: chunks };
    const token = ownWalk({ ...c.token, sceneId });
    const dragged = { ...token, id: "bench" };
    const once = () =>
      c.frame
        ? planOne(state, dragged, c.to, "walk").stop === null
        : c.drop
          ? landing(state, token, c.to, "walk").stopped === null
          : legStop(state, token, c.to) === null;
    const allowed = once();
    const times: number[] = [];
    for (let r = 0; r < runs + 20; r++) {
      const t = performance.now();
      once();
      if (r >= 20) times.push(performance.now() - t);
    }
    rows.push({ scenario: c.name, allowed, ms: stats(times) });
  }
  return rows;
}

export function formatMovementBench(rows: readonly MoveRow[]): string {
  const lines = ["leg test | allowed | ms (median / max)", "--- | --- | ---"];
  for (const r of rows) lines.push(`${r.scenario} | ${r.allowed ? "yes" : "no"} | ${r.ms.median.toFixed(3)} / ${r.ms.max.toFixed(3)}`);
  lines.push("", "The wall set is derived before the runs, as it is during a drag. Its derive after an edit is the table above's movement column.");
  return lines.join("\n");
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  console.log(formatBench(runBench()));
  console.log("");
  console.log(formatMovementBench(runMovementBench()));
}
