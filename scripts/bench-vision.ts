/**
 * The sight rows of the wave 4 performance gate (docs/design-v1-maps-vision.md
 * section 4.3.6), on scenes at the caps: 6,000 potential sight pieces from a
 * 200 x 200 dungeon with crossing free walls, pillars and raised areas, 12
 * party sources with 150 ft darkvision, and 100 free lights plus 20 lit
 * token lights, each 120 ft bright and 120 ft dim beyond. Run it on the
 * machine being gated:
 *
 *   node scripts/bench-vision.ts            (a laptop: budgets over 1.4, the reference server's ratio)
 *   node scripts/bench-vision.ts --server   (the server box itself: budgets as they are)
 *
 * The phone row runs the same `runBench` in a browser. Nothing here touches
 * Node, so a bundler can take this file as it is.
 *
 * A row over its budget means a cap comes down (section 4.3.6), not that
 * this file changes.
 */
import { wallChunk } from "../shared/keys.ts";
import { LIMITS } from "../shared/limits.ts";
import { DEFAULT_SETTINGS, type BuildChunk, type EdgeFeature, type FreeWall, type Light, type RoomState, type SightTile, type TerrainId, type Token } from "../shared/model.ts";
import { encodeHeights } from "../shared/rules/heights.ts";
import { clearVisionCache, partySight, sightTileLevels, type VisionWorld } from "../shared/rules/vision.ts";
import { sceneWalls } from "../shared/rules/walls.ts";

const SIZE = 200;
const CHUNK = 16;
const world: VisionWorld = { walls: sceneWalls };

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Build = { cells: Map<string, TerrainId>; edges: Map<string, EdgeFeature>; walls: FreeWall[]; heights: Map<string, number> };

/*
 * A 200 x 200 dungeon of 20 x 20 rooms joined by doors and windows, a pillar
 * or two in each, with a raised dais in every other room, around an open hall
 * 80 cells across in the middle. The hall has rows of pillars and a wall
 * across it with a door in its middle, which every source in the hall sees.
 */
function dungeon(rand: () => number): Build {
  const cells = new Map<string, TerrainId>();
  const edges = new Map<string, EdgeFeature>();
  const heights = new Map<string, number>();
  const inHall = (x: number, y: number) => x >= 60 && x < 140 && y >= 60 && y < 140;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) cells.set(`${x},${y}`, "stone");
  for (let ry = 0; ry < SIZE / 20; ry++) {
    for (let rx = 0; rx < SIZE / 20; rx++) {
      const x0 = rx * 20;
      const y0 = ry * 20;
      for (let k = 0; k < 20; k++) {
        if (rx > 0 && !(inHall(x0, y0 + k) && inHall(x0 - 1, y0 + k)))
          edges.set(`${x0},${y0 + k},w`, k === 9 ? { kind: "door", state: rand() < 0.5 ? "open" : "closed", secret: false, discovered: false } : { kind: "wall" });
        if (ry > 0 && !(inHall(x0 + k, y0) && inHall(x0 + k, y0 - 1))) edges.set(`${x0 + k},${y0},n`, k === 10 ? { kind: "window" } : { kind: "wall" });
      }
      if (inHall(x0, y0)) continue;
      cells.set(`${x0 + 4},${y0 + 4}`, "pillar");
      if (rand() < 0.5) cells.set(`${x0 + 14},${y0 + 12}`, "pillar");
      if ((rx + ry) % 2 === 0) for (let y = y0 + 8; y < y0 + 13; y++) for (let x = x0 + 8; x < x0 + 13; x++) heights.set(`${x},${y}`, 10);
    }
  }
  // Pillars in rows across the hall, and a wall through its middle with a door.
  for (let y = 66; y < 140; y += 12) for (let x = 66; x < 140; x += 12) cells.set(`${x},${y}`, "pillar");
  for (let x = 70; x < 130; x++) edges.set(`${x},100,n`, x === 100 ? { kind: "door", state: "closed", secret: false, discovered: false } : { kind: "wall" });
  return { cells, edges, walls: [], heights };
}

function q64(v: number): number {
  return Math.round(v * 64) / 64;
}

let wallIds = 0;
function wall(ax: number, ay: number, bx: number, by: number): FreeWall {
  return { id: `v${String(wallIds++).padStart(11, "0")}`, a: [q64(ax), q64(ay)], b: [q64(bx), q64(by)], f: { kind: "wall" } };
}

/** Random walls of 2 to 8 cells, at any angle, outside the hall so its sources keep their view. */
function randomWalls(rand: () => number, count: number): FreeWall[] {
  const out: FreeWall[] = [];
  while (out.length < count) {
    const ax = rand() * SIZE;
    const ay = rand() * SIZE;
    const len = 2 + rand() * 5.9;
    const t = rand() * Math.PI * 2;
    const bx = ax + Math.cos(t) * len;
    const by = ay + Math.sin(t) * len;
    if (bx < 0 || by < 0 || bx > SIZE || by > SIZE) continue;
    if (Math.max(ax, bx) > 58 && Math.min(ax, bx) < 142 && Math.max(ay, by) > 58 && Math.min(ay, by) < 142) continue;
    const w = wall(ax, ay, bx, by);
    if (w.a[0] === w.b[0] && w.a[1] === w.b[1]) continue;
    out.push(w);
  }
  return out;
}

/** The build as stored: 16 x 16 chunks, each free wall in the chunk of its midpoint, heights per chunk. */
function chunksOf(build: Build, sceneId: string): Record<string, BuildChunk> {
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
  const feet = new Map<string, number[]>();
  for (const [key, h] of build.heights) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const k = `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;
    let list = feet.get(k);
    if (!list) feet.set(k, (list = new Array<number>(CHUNK * CHUNK).fill(0)));
    list[(y % CHUNK) * CHUNK + (x % CHUNK)] = h;
  }
  for (const [k, list] of feet) {
    const [cx, cy] = k.split(",").map(Number) as [number, number];
    const heights = encodeHeights(list);
    if (heights) at(cx, cy).heights = heights;
  }
  return out;
}

function actorWith(senses: string): Token["actor"] {
  return {
    inline: {
      hp: { cur: 20, max: 20, temp: 0 },
      life: "alive",
      ac: 14,
      speeds: { walk: 30 },
      initBonus: 0,
      passivePerception: 10,
      senses,
      effects: [],
      deathSaves: { ok: 0, fail: 0 },
      notes: "",
      dmNotes: "",
    },
  };
}

function tokenAt(id: string, x: number, y: number, extra: Partial<Token>): Token {
  return {
    id,
    rev: 0,
    sceneId: "bench",
    kind: "monster",
    name: id,
    nameHidden: false,
    size: "medium",
    x,
    y,
    elevation: 0,
    rotation: 0,
    disposition: "hostile",
    visibility: "all",
    fogExempt: false,
    fogExemptAuto: false,
    locked: false,
    layer: "token",
    ownerIds: [],
    actor: actorWith(""),
    hpVisibility: "label",
    ...extra,
  };
}

const MAX_LIGHT = { bright: 120, dim: 120 };

/*
 * The room: the dungeon with crossing free walls added until the scene holds
 * the most potential sight pieces vision allows (section 2.4) within the
 * split's caps, 12 player characters in the hall around its door, 8
 * monsters about the dungeon, 20 lit token lights (one per source and per
 * monster) and 100 free lights, every light and sense at its cap.
 */
export function capRoom(level: "bright" | "dark"): { state: RoomState; pieces: number } {
  const rand = mulberry32(2026);
  const build = dungeon(rand);
  const pool = randomWalls(rand, LIMITS.freeWallsPerScene);
  const sceneId = "bench";
  const scene = { id: sceneId, rev: 1, name: "bench", order: 0, bounds: { w: SIZE, h: SIZE }, grid: { show: true, color: "#fff", opacity: 0.2, lineWidth: 1 }, background: "#000", fogEnabled: true, wallsVersion: 1, autoWalls: "off" as const, vision: { on: true, light: level } };
  // The longest prefix of free walls within the sight cap and the split's caps, by bisection.
  const fits = (n: number) => {
    const walls = sceneWalls(scene, chunksOf({ ...build, walls: pool.slice(0, n) }, sceneId));
    return walls.count.over === null && walls.sightPotential <= LIMITS.sightPiecesPerScene;
  };
  let lo = 0;
  let hi = pool.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  build.walls = pool.slice(0, lo);
  const buildChunks = chunksOf(build, sceneId);
  const tokens: Record<string, Token> = {};
  for (let k = 0; k < LIMITS.partySourcesPerScene; k++) {
    // Six on each side of the hall's dividing wall, all in sight of its door.
    const x = 72 + (k % 6) * 10;
    const y = k < 6 ? 88 : 110;
    tokens[`pc${k}`] = tokenAt(`pc${k}`, x, y, { kind: "pc", ownerIds: ["p1"], disposition: "ally", actor: actorWith("darkvision 150 ft"), light: MAX_LIGHT });
  }
  for (let k = 0; k < LIMITS.litTokenLightsPerScene - LIMITS.partySourcesPerScene; k++) {
    tokens[`m${k}`] = tokenAt(`m${k}`, 5 + Math.floor(rand() * 190), 5 + Math.floor(rand() * 190), { light: MAX_LIGHT });
  }
  const lights: Record<string, Light> = {};
  for (let k = 0; k < LIMITS.lightsPerScene; k++) {
    lights[`l${k}`] = { id: `l${k}`, rev: 0, sceneId, x: q64(rand() * SIZE), y: q64(rand() * SIZE), ...MAX_LIGHT, on: true, walls: true };
  }
  const state = {
    meta: { name: "bench", settings: { ...DEFAULT_SETTINGS }, playerSceneId: sceneId, view: { follow: false, blackout: false } },
    scenes: { [sceneId]: scene },
    buildChunks,
    tokens,
    lights,
    characters: {},
    members: {},
  } as unknown as RoomState;
  return { state, pieces: sceneWalls(scene, buildChunks).sightPotential };
}

type Ms = { median: number; max: number };
export type BenchRow = { row: string; where: "server" | "phone"; budget: number; ms: Ms; note?: string };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

function withToken(s: RoomState, t: Token): RoomState {
  return { ...s, tokens: { ...s.tokens, [t.id]: t } };
}

/** Times `step` on states it derives from the last one, after two runs that warm the engine up. */
function timed(runs: number, start: RoomState, step: (s: RoomState, run: number) => RoomState, measure: (s: RoomState) => void): Ms {
  let s = start;
  measure(s);
  const times: number[] = [];
  for (let r = 0; r < runs + 2; r++) {
    s = step(s, r);
    const t = performance.now();
    measure(s);
    const ms = performance.now() - t;
    if (r >= 2) times.push(ms);
  }
  return stats(times);
}

const sight = (s: RoomState) => void partySight(s, "bench", world);

/** A cell's door flipped open or shut, as `door.set` writes it: a new chunk object, so the walls derive again. */
function flipDoor(s: RoomState, edge: string): RoomState {
  const [x, y] = edge.split(",").map(Number) as [number, number];
  const key = `bench:${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;
  const chunk = s.buildChunks[key]!;
  const door = chunk.edges[edge] as Extract<EdgeFeature, { kind: "door" }>;
  return { ...s, buildChunks: { ...s.buildChunks, [key]: { ...chunk, edges: { ...chunk.edges, [edge]: { ...door, state: door.state === "open" ? "closed" : "open" } } } } };
}

/** Every chunk replaced by a copy, as a room load gives: nothing cached reads it. */
function reloaded(s: RoomState): RoomState {
  return { ...s, buildChunks: Object.fromEntries(Object.entries(s.buildChunks).map(([k, c]) => [k, { ...c }])) };
}

export function runBench(runs = 15): { rows: BenchRow[]; pieces: Record<string, number> } {
  const rows: BenchRow[] = [];
  const bright = capRoom("bright");
  const dark = capRoom("dark");
  const pcs = (s: RoomState) => Object.values(s.tokens).filter((t) => t.kind === "pc");
  const moveBy = (s: RoomState, run: number, dx: number) => {
    const t = pcs(s)[run % LIMITS.partySourcesPerScene]!;
    return withToken(s, { ...t, x: t.x + (run % 2 === 0 ? dx : -dx) });
  };
  clearVisionCache();

  rows.push({ row: "One party source moved, bright scene", where: "server", budget: 25, ms: timed(runs, bright.state, (s, r) => moveBy(s, r, 1), sight) });
  rows.push({ row: "One source moved among lit lights, dark scene", where: "server", budget: 30, ms: timed(runs, dark.state, (s, r) => moveBy(s, r, 1), sight) });

  // Lights on the dark scene, each step against the scene as the last left it.
  const lightStep = (kind: "added" | "moved" | "switched" | "removed") => (s: RoomState, run: number): RoomState => {
    const id = `l${(run * 7) % LIMITS.lightsPerScene}`;
    const lights = { ...s.lights };
    if (kind === "added") {
      // One out and one in, so the scene stays at its cap of 100.
      delete lights[id];
      lights[`new${run}`] = { id: `new${run}`, rev: 0, sceneId: "bench", x: 20 + run, y: 30 + run, ...MAX_LIGHT, on: true, walls: true };
      return { ...s, lights };
    }
    const l = lights[id] ?? Object.values(lights)[0]!;
    if (kind === "moved") lights[l.id] = { ...l, x: l.x + 1 };
    else if (kind === "switched") lights[l.id] = { ...l, on: !l.on };
    else delete lights[l.id];
    return { ...s, lights };
  };
  for (const kind of ["added", "moved", "switched", "removed"] as const) {
    rows.push({ row: `A light ${kind}, dark scene`, where: "server", budget: 10, ms: timed(runs, dark.state, lightStep(kind), sight) });
  }

  // Sources added and removed: a death, Blinded, a token placed.
  const sourceStep = (kind: "dies" | "blinded" | "placed") => (s: RoomState, run: number): RoomState => {
    if (kind === "placed") {
      // A source in and one out, so the cap of 12 holds.
      const tokens = { ...s.tokens };
      const out = pcs(s)[run % LIMITS.partySourcesPerScene]!;
      delete tokens[out.id];
      tokens[`new${run}`] = { ...out, id: `new${run}`, x: out.x + 2 };
      return { ...s, tokens };
    }
    const t = pcs(s)[run % LIMITS.partySourcesPerScene]!;
    const a = (t.actor as { inline: Extract<Token["actor"], { inline: unknown }>["inline"] }).inline;
    const next =
      kind === "dies" ? { ...a, life: a.life === "alive" ? ("dead" as const) : ("alive" as const) } : { ...a, effects: a.effects.length > 0 ? [] : [{ id: "b", key: "blinded" as const }] };
    return withToken(s, { ...t, actor: { inline: next } });
  };
  for (const [level, room] of [
    ["bright", bright],
    ["dark", dark],
  ] as const) {
    for (const kind of ["dies", "blinded", "placed"] as const) {
      rows.push({ row: `A source ${kind === "dies" ? "dies or revives" : kind === "blinded" ? "is Blinded or recovers" : "is placed"}, ${level} scene`, where: "server", budget: 25, ms: timed(runs, room.state, sourceStep(kind), sight) });
    }
  }

  // The hall's door, which every source sees, including deriving the walls.
  for (const [level, room] of [
    ["bright", bright],
    ["dark", dark],
  ] as const) {
    rows.push({ row: `A door every source sees, with the derive, ${level} scene`, where: "server", budget: 250, ms: timed(runs, room.state, (s) => flipDoor(s, "100,100,n"), sight) });
    rows.push({
      row: `A group move of every source, ${level} scene`,
      where: "server",
      budget: 250,
      // Each run a cell further east, so no run repeats a state the cache holds.
      ms: timed(runs, room.state, (s) => pcs(s).reduce((acc, t) => withToken(acc, { ...t, x: t.x + 1 }), s), sight),
    });
  }

  // Cold: a room load (walls derived too), and a light level switch over walls already derived.
  for (const [level, room] of [
    ["bright", bright],
    ["dark", dark],
  ] as const) {
    rows.push({
      row: `Cold sight on room load, with the derive, ${level} scene`,
      where: "server",
      budget: 250,
      ms: timed(
        runs,
        room.state,
        (s) => {
          clearVisionCache();
          return reloaded(s);
        },
        sight,
      ),
    });
  }
  rows.push({
    row: "Cold sight on a light level switch (dark to dim and back)",
    where: "server",
    budget: 250,
    ms: timed(
      runs,
      dark.state,
      (s) => {
        // Every switch computes from nothing anyway. Clearing the cache keeps a switch back from finding the last answer.
        clearVisionCache();
        const sc = s.scenes.bench!;
        return { ...s, scenes: { bench: { ...sc, vision: { on: true, light: sc.vision!.light === "dark" ? "dim" : "dark" } } } };
      },
      sight,
    ),
  });

  /*
   * The fan-out's share that is sight's (section 4.3.5): after one source
   * moves, find the tiles that changed and hash each once, which the server
   * then compares per connection (server/rooms/fanout.ts does the rest).
   */
  {
    let s = dark.state;
    let before = partySight(s, "bench", world).tiles;
    const times: number[] = [];
    for (let r = 0; r < runs + 2; r++) {
      s = moveBy(s, r, 1);
      const after = partySight(s, "bench", world).tiles;
      const t = performance.now();
      let changed = 0;
      let h = 0;
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const tile = after.get(key);
        if (tile === before.get(key)) continue;
        changed++;
        const text = tile ? JSON.stringify(tile) : "";
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      }
      const ms = performance.now() - t;
      if (r >= 2) times.push(ms);
      before = after;
      if (changed < 0 || h === 0.5) throw new Error("unreachable");
    }
    rows.push({ row: "Sight tiles diffed and hashed once for the fan-out, one source moved", where: "server", budget: 10, ms: stats(times) });
  }

  /*
   * The phone's share (section 4.3.7): the tiles one move changed, decoded
   * and written into the overlay's RGBA pixels at 4 px per cell. Drawing
   * that image is the client's, and is one canvas draw.
   */
  {
    let s = dark.state;
    let before = partySight(s, "bench", world).tiles;
    const rgba = new Uint8ClampedArray(SIZE * 4 * SIZE * 4 * 4);
    const shade = [
      [0, 0, 0, 166],
      [60, 70, 90, 140],
      [0, 0, 0, 89],
      [0, 0, 0, 0],
    ];
    const times: number[] = [];
    for (let r = 0; r < runs + 2; r++) {
      s = moveBy(s, r, 1);
      const after = partySight(s, "bench", world).tiles;
      const changed: [string, SightTile | undefined][] = [];
      for (const key of new Set([...before.keys(), ...after.keys()])) if (after.get(key) !== before.get(key)) changed.push([key, after.get(key)]);
      const t = performance.now();
      for (const [key, tile] of changed) {
        const [tx, ty] = key.split(",").map(Number) as [number, number];
        const levels = tile ? sightTileLevels(tile) : null;
        for (let row = 0; row < 64; row++) {
          const sy = ty * 64 + row;
          if (sy >= SIZE * 4) break;
          for (let col = 0; col < 64; col++) {
            const sx = tx * 64 + col;
            if (sx >= SIZE * 4) break;
            const c = shade[levels ? levels[row * 64 + col]! : 0]!;
            const p = (sy * SIZE * 4 + sx) * 4;
            rgba[p] = c[0]!;
            rgba[p + 1] = c[1]!;
            rgba[p + 2] = c[2]!;
            rgba[p + 3] = c[3]!;
          }
        }
      }
      const ms = performance.now() - t;
      if (r >= 2) times.push(ms);
      before = after;
    }
    rows.push({ row: "Changed sight tiles decoded into the overlay's pixels, one source moved", where: "phone", budget: 4, ms: stats(times), note: "measured here on the laptop: run in a phone's browser for the gate" });
  }

  return { rows, pieces: { bright: bright.pieces, dark: dark.pieces } };
}

export function formatBench(result: ReturnType<typeof runBench>, onServer: boolean): string {
  const factor = onServer ? 1 : 1.4;
  const ms = (s: Ms) => `${s.median.toFixed(1)} / ${s.max.toFixed(1)}`;
  const lines = [
    `Potential sight pieces: bright scene ${result.pieces.bright}, dark scene ${result.pieces.dark} (cap ${LIMITS.sightPiecesPerScene}).`,
    "",
    `row | where | ms here (median / max) | budget | limit here | ok`,
    "--- | --- | --- | --- | --- | ---",
  ];
  for (const r of result.rows) {
    // The phone row is not scaled: a laptop is no stand-in for a phone, only a floor.
    const limit = r.where === "server" ? r.budget / factor : r.budget;
    lines.push(`${r.row} | ${r.where} | ${ms(r.ms)} | ${r.budget} | ${limit.toFixed(1)} | ${r.ms.median <= limit ? "yes" : "NO"}${r.note ? ` (${r.note})` : ""}`);
  }
  lines.push("", `Times are median / max over the runs. "limit here" is the budget${onServer ? "" : " over 1.4, the reference server's time to this laptop's,"} for server rows, which the median must meet.`);
  return lines.join("\n");
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  console.log(formatBench(runBench(), argv.includes("--server")));
}
