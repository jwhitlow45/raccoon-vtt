import { LIMITS } from "#shared/limits.ts";
import { CHUNK_CELLS, type AutoWalls, type BuildChunk, type CellRect, type EdgeFeature, type FreeWall, type WallFeature } from "#shared/model.ts";
import { autoWallsOf, paintedCell, type Painted } from "#shared/rules/autoWalls.ts";
import { chunkHeights, markIn } from "#shared/rules/heights.ts";
import { hexAt } from "#shared/rules/hex.ts";
import {
  approachOf,
  boardCell,
  cellParts,
  eachOccupied,
  excusedOf,
  hexesBeside,
  hexLane,
  joinedRoom,
  joinWay,
  runAt,
  squareLane,
  wingBoard,
  type JoinExpect,
  type JoinLane,
  type WingBoard,
} from "#shared/rules/wingClear.ts";
import { endsKey, hexSide } from "./hexWalls.ts";
import { hexGridOf, latticeFor, type Lattice } from "./lattice.ts";
import type { Side } from "./layout.ts";
import type { Allowance } from "./fit.ts";
import type { WingBase } from "./plan.ts";
import { MAX_HEX_WALLS, type DungeonSettings, type GridKind } from "./settings.ts";

/*
 * Add a wing (phase 3, 3.2 to 3.4): what the planner reads of the scene a
 * wing joins. The join is a wall the DM tapped, a grid edge on squares or a
 * one-side free wall on hexes, with floor inside and empty ground beyond.
 * Open ground is what the planning flood reaches from the join's outside
 * cell, less every occupied cell and the cells within the margin of one.
 * The joined room's own structure is excused for the approach, the cells
 * a doorway at the join needs, so an ordinary wall can be joined however
 * deep its room runs (D-261110-233).
 *
 * How a join reads, its approach, the joined room, what is occupied and
 * what the joined room excuses are the server's own rules
 * (shared/rules/wingClear.ts), read here on the same scene cells and
 * turned into the planner's, so every wing planned passes the server's
 * checks.
 *
 * Cells are lattice indices over the whole scene (lattice.ts): squares, or
 * the hex rows lattice, mirrored on Hex columns.
 */

/** Why a join or a wing does not go, each with its line in the pane or the Wing row. */
export type WingProblem =
  /** The tapped wall has no empty ground beyond it that reaches the area: "Tap a wall with empty ground beyond it." */
  | "noGround"
  /** On hexes the joined room is open somewhere else. */
  | "openRoom"
  /** On hexes a wall or door more than one side long. */
  | "longWall"
  /** On squares a free wall, which is off the grid lines. */
  | "offGrid"
  /** On Wide, no second edge, or no three sides between two hexes and two. */
  | "wideShape"
  /** A "floor" scene's join stands raised or sunk. */
  | "raised"
  /** A protected object stands within the margin of the approach. */
  | "nearJoin"
  /** No room for the join's stairs. */
  | "noStairs"
  /** No way from the area to the join. */
  | "noWay"
  /** Fewer than two rooms fit. */
  | "noRooms"
  /** The scene holds too many walls and doors for a wing. */
  | "full";

/** The scene a wing is planned on, as a base posts it. */
export type WingScene = Pick<WingBase, "scene" | "state">;

/** A join as the planner reads it: its inside and outside cells lane by lane, the way out, the inside's ground and what each lane's wall is. */
export type JoinFacts = {
  inside: number[];
  outside: number[];
  /** The side out of the joined room on squares, and the offset side nearest it on hexes. */
  side: Side;
  /** On hexes the hex direction out, which a run at the join steps along. */
  dir: number;
  ground: number;
  /** Whether the join is a door now, which keeps its state, rather than a wall, which becomes a closed door. */
  door: boolean;
};

/** The scene's lattice, its grid and its keys. */
export type WingWorld = {
  L: Lattice;
  /** The scene's bounds in cells. */
  bounds: { w: number; h: number };
  grid: GridKind;
  autoWalls: AutoWalls;
  /** A scene key's lattice cell, or -1 off the scene. */
  cellOf(key: string): number;
  chunks: readonly BuildChunk[];
  /** The scene as the shared wing rules read it, by packed scene key. */
  board: WingBoard;
  /** A packed scene key's lattice cell, or -1 off the scene. */
  fromBoard(k: number): number;
  /** A lattice cell's packed scene key. */
  toBoard(k: number): number;
};

const SIDES: readonly Side[] = ["n", "e", "s", "w"];

export function wingWorld(base: WingScene): WingWorld {
  const scene = base.scene;
  const grid: GridKind = scene.gridShape ?? "squares";
  const L = latticeFor(grid, scene.bounds);
  const chunks = Object.values(base.state.buildChunks).filter((c): c is BuildChunk => c !== undefined && c.sceneId === scene.id);
  const columns = grid === "hexColumns";
  const lattice = (a: number, b: number) => {
    const [x, y] = columns ? [b, a] : [a, b];
    return Number.isInteger(x) && Number.isInteger(y) && L.inMap(x, y) ? y * L.W + x : -1;
  };
  const cellOf = (key: string) => {
    const [a, b] = key.split(",").map(Number) as [number, number];
    return lattice(a, b);
  };
  const fromBoard = (k: number) => (k < 0 ? -1 : lattice(...cellParts(k)));
  const toBoard = (k: number) => {
    const x = k % L.W;
    const y = (k - x) / L.W;
    return columns ? boardCell(y, x) : boardCell(x, y);
  };
  return { L, bounds: scene.bounds, grid, autoWalls: autoWallsOf(scene), cellOf, chunks, board: wingBoard(base.state, scene), fromBoard, toBoard };
}

/** The lattice cell a scene point falls in: its square, or the hex holding it. */
function cellAt(world: WingWorld, x: number, y: number): number {
  const { L, grid } = world;
  if (grid === "squares") {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    return L.inMap(cx, cy) ? cy * L.W + cx : -1;
  }
  const h = hexAt(hexGridOf(grid), { x, y });
  const [lx, ly] = grid === "hexRows" ? [h.col, h.row] : [h.row, h.col];
  return L.inMap(lx, ly) ? ly * L.W + lx : -1;
}

/** A square's painted state as automatic walls read it, from its chunk. */
function paintedIn(world: WingWorld, byKey: ReadonlyMap<string, BuildChunk>, x: number, y: number): Painted {
  if (x < 0 || y < 0) return "empty";
  const chunk = byKey.get(`${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`);
  return chunk ? paintedCell(chunk.cells[`${x},${y}`], markIn(chunk, x, y)) : "empty";
}

/** The two cells a grid edge "x,y,n" or "x,y,w" lies between, the north or west one first. */
export function edgeCells(key: string): [[number, number], [number, number]] {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  return side === "n" ? [[x, y - 1], [x, y]] : [[x - 1, y], [x, y]];
}

/** Every free wall of the scene, with its chunk. */
function freeWalls(world: WingWorld): { cx: number; cy: number; wall: FreeWall }[] {
  return world.chunks.flatMap((c) => (c.walls ?? []).map((wall) => ({ cx: c.cx, cy: c.cy, wall })));
}

/**
 * The join (3.2): its inside and outside cells, its way out and its ground,
 * or the problem with it. On hexes the outside is the side whose ground
 * reaches the area. Each edge or wall is a lane read by the server's own
 * rule (shared/rules/wingClear.ts), so a join taken here is one the
 * server's join check takes.
 */
export function readJoin(base: WingScene, join: JoinExpect, area: CellRect, wide: boolean): { ok: true; facts: JoinFacts } | { ok: false; problem: WingProblem } {
  const world = wingWorld(base);
  const { board } = world;
  if (join.grid === "squares") {
    if (world.grid !== "squares") return { ok: false, problem: "offGrid" };
    if (join.edges.length !== (wide ? 2 : 1)) return { ok: false, problem: "wideShape" };
    const lanes = join.edges.map((e) => squareLane(board, e.key));
    if (lanes.some((l) => l === null)) return { ok: false, problem: "noGround" };
    return facing(world, lanes as JoinLane[], wide, join.edges.every((e) => e.feature?.kind === "door"));
  }
  if (world.grid === "squares") return { ok: false, problem: "longWall" };
  if (join.walls.length !== (wide ? 3 : 1)) return { ok: false, problem: "wideShape" };
  const sides = join.walls.map((w) => hexesBeside(board, w.a, w.b));
  if (sides.some((p) => p === null || world.fromBoard(p.p) < 0 || world.fromBoard(p.q) < 0)) return { ok: false, problem: "longWall" };
  const flood = (from: number) => planningFlood(world, world.fromBoard(from), null);
  const areaCells = new Set(areaCellsOf(world, area));
  const reachesArea = (from: number) => [...flood(from)].some((k) => areaCells.has(k));
  const hexes = new Set(sides.flatMap((p) => [p!.p, p!.q]));
  if (hexes.size !== (wide ? 4 : 2)) return { ok: false, problem: "wideShape" };
  // The outside is the side whose flood reaches the area. Both reaching it means the room is open somewhere else, so its inside cannot be told.
  const first = sides[0]!;
  const [reach0, reach1] = [reachesArea(first.p), reachesArea(first.q)];
  if (reach0 && reach1) return { ok: false, problem: "openRoom" };
  if (!reach0 && !reach1) return { ok: false, problem: "noGround" };
  const room = joinedRoom(board, base.scene, { inside: [reach0 ? first.q : first.p], dir: -1 }, join);
  const lanes = join.walls.map((w) => hexLane(board, w.a, w.b, (k) => room.has(k)));
  if (lanes.some((l) => l === null)) return { ok: false, problem: "wideShape" };
  return facing(world, lanes as JoinLane[], wide, join.walls.every((w) => w.f.kind === "door"));
}

/**
 * A join's facts from its lanes: the way out most of them share, each
 * lane along it by its inside cell's lattice order, and its ground. Every
 * cell the join touches must lie on one of those lanes, and on Wide the
 * two lanes must stand as the planner's own Wide doorway does, a lattice
 * row or offset column apart.
 */
function facing(world: WingWorld, lanes: readonly JoinLane[], wide: boolean, door: boolean): { ok: true; facts: JoinFacts } | { ok: false; problem: WingProblem } {
  const { L } = world;
  const way = joinWay(lanes);
  if (!way) return { ok: false, problem: "wideShape" };
  const touched = new Set(lanes.map((l) => l.inside));
  const beyond = new Set(lanes.map((l) => l.outside));
  if (new Set(way.inside).size !== way.inside.length || way.inside.length !== touched.size || new Set(way.outside).size !== beyond.size) return { ok: false, problem: "wideShape" };
  const pairs = way.inside.map((k, i) => [world.fromBoard(k), world.fromBoard(way.outside[i]!)] as const).sort((a, b) => a[0] - b[0]);
  if (pairs.some(([i, o]) => i < 0 || o < 0)) return { ok: false, problem: "noGround" };
  const inside = pairs.map(([i]) => i);
  const outside = pairs.map(([, o]) => o);
  const dir = way.dir;
  const side: Side = world.grid === "squares" ? SIDES[dir]! : dir === 0 ? "e" : dir === 3 ? "w" : dir === 1 || dir === 2 ? "s" : "n";
  if (wide) {
    const apart = inside[1]! - inside[0]!;
    const ok = world.grid === "squares" ? apart === (side === "n" || side === "s" ? 1 : L.W) : apart === 1 || apart === L.W;
    if (!ok) return { ok: false, problem: "wideShape" };
  }
  const byKey = new Map(world.chunks.map((c) => [`${c.cx},${c.cy}`, c]));
  const ground = groundOf(world, byKey, inside[0]!);
  if (ground === null || inside.some((k) => groundOf(world, byKey, k) !== ground)) return { ok: false, problem: "raised" };
  return { ok: true, facts: { inside, outside, side, dir, ground, door } };
}

/** A cell's ground in feet, or null off the scene. */
function groundOf(world: WingWorld, byKey: ReadonlyMap<string, BuildChunk>, k: number): number | null {
  if (k < 0) return null;
  const key = world.L.keyOf(k);
  const [a, b] = key.split(",").map(Number) as [number, number];
  const chunk = byKey.get(`${Math.floor(a / CHUNK_CELLS)},${Math.floor(b / CHUNK_CELLS)}`);
  if (!chunk) return 0;
  const heights = chunkHeights(chunk);
  if (!heights) return 0;
  return heights[(b - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (a - chunk.cx * CHUNK_CELLS)] ?? 0;
}

/** The area's cells on the lattice: its keys, mirrored on Hex columns, on the scene. */
export function areaCellsOf(world: WingWorld, area: CellRect): number[] {
  const out: number[] = [];
  for (let b = area.y; b < area.y + area.h; b++) {
    for (let a = area.x; a < area.x + area.w; a++) {
      const k = world.cellOf(`${a},${b}`);
      if (k >= 0) out.push(k);
    }
  }
  return out;
}

/** Whether a step between two neighboring cells crosses a wall, door or window, `extra` walls among them. */
function wallBetween(world: WingWorld, walls: readonly FreeWall[], edges: ReadonlyMap<string, EdgeFeature>, k: number, n: number, extra: ReadonlySet<string>): boolean {
  const { L } = world;
  if (world.grid === "squares") {
    const kx = k % L.W;
    const ky = (k - kx) / L.W;
    const nx = n % L.W;
    const ny = (n - nx) / L.W;
    const key = kx === nx ? `${kx},${Math.max(ky, ny)},n` : `${Math.max(kx, nx)},${ky},w`;
    const f = edges.get(key);
    if (extra.has(key) || (f !== undefined && f.kind !== "none")) return true;
    return walls.some((w) => crosses(w.a, w.b, [kx + 0.5, ky + 0.5], [nx + 0.5, ny + 0.5]));
  }
  const d = [0, 1, 2, 3, 4, 5].find((dir) => L.step(k, dir, 1) === n);
  if (d === undefined) return true;
  return extra.has(endsKey(...hexSide(L, k, d))) || hexWallKeys(world, walls).has(endsKey(...hexSide(L, k, d)));
}

const hexKeysCache = new WeakMap<readonly FreeWall[], Set<string>>();
/**
 * The ends of every free wall on hexes. A longer wall is cut at each hex
 * corner it passes, so a step is stopped by any wall lying on its side.
 */
function hexWallKeys(world: WingWorld, walls: readonly FreeWall[]): Set<string> {
  const known = hexKeysCache.get(walls);
  if (known) return known;
  const out = new Set<string>();
  for (const w of walls) {
    out.add(endsKey(w.a, w.b));
    // A wall several sides long: each side it covers, found from the hexes along it.
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const steps = Math.ceil(len / 0.25);
    for (let i = 0; i <= steps; i++) {
      const t = (i + 0.5) / (steps + 1);
      const px = w.a[0] + (w.b[0] - w.a[0]) * t;
      const py = w.a[1] + (w.b[1] - w.a[1]) * t;
      const k = cellAt(world, px, py);
      if (k < 0) continue;
      for (let d = 0; d < 6; d++) {
        const [p, q] = hexSide(world.L, k, d);
        if (onSegment(p, w.a, w.b) && onSegment(q, w.a, w.b)) out.add(endsKey(p, q));
      }
    }
  }
  hexKeysCache.set(walls, out);
  return out;
}

function onSegment(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-6) return false;
  return Math.min(a[0], b[0]) - 1e-6 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-6 && Math.min(a[1], b[1]) - 1e-6 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-6;
}

/** Whether segment p-q crosses segment a-b, touching counted. */
function crosses(p: readonly [number, number], q: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): boolean {
  const o = (u: readonly [number, number], v: readonly [number, number], w: readonly [number, number]) => Math.sign((v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]));
  const d1 = o(p, q, a);
  const d2 = o(p, q, b);
  const d3 = o(a, b, p);
  const d4 = o(a, b, q);
  return d1 !== d2 && d3 !== d4;
}

/**
 * The planning flood (3.4) from a cell. On squares it crosses unpainted
 * cells and no drawn edge or free wall. On hexes it steps from hex to hex
 * where no free wall lies on the side between, every door and window read
 * as a wall, as `floodHexRoom` steps. `extra` names more sides to read as
 * walls: the join's, for the joined room.
 */
export function planningFlood(world: WingWorld, from: number, extra: ReadonlySet<string> | null): Set<number> {
  const { L } = world;
  const seen = new Set<number>();
  if (from < 0) return seen;
  const byKey = new Map(world.chunks.map((c) => [`${c.cx},${c.cy}`, c]));
  const walls = freeWalls(world).map((w) => w.wall);
  const edges = new Map<string, EdgeFeature>(world.chunks.flatMap((c) => Object.entries(c.edges)));
  const squares = world.grid === "squares";
  const open = (k: number) => !squares || paintedIn(world, byKey, k % L.W, Math.floor(k / L.W)) === "empty";
  if (!open(from)) return seen;
  const none = extra ?? new Set<string>();
  seen.add(from);
  const queue = [from];
  while (queue.length > 0) {
    const k = queue.pop()!;
    for (const n of L.halo(k)) {
      if (seen.has(n) || !open(n) || wallBetween(world, walls, edges, k, n, none)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/** An occupied cell's structure: painted ground, an edge or a wall, a height or difficult mark, which the joined room's own excuses for the approach. */
export const STRUCTURE = 1;
/** An occupied cell's objects and stair marks, which count wherever they stand. */
export const OBJECT = 2;

/**
 * Every occupied cell (3.4), as bits, read by the server's own rule
 * (`eachOccupied`): STRUCTURE for painted ground, drawn edges and free
 * walls by both their cells, height and difficult marks, and OBJECT for
 * stair marks, token footprints, trap zones and the cells they hit, stamp
 * boxes, lights, labels, pins and floor link squares.
 */
export function occupiedOf(world: WingWorld, base: WingScene): Uint8Array {
  const occ = new Uint8Array(world.L.W * world.L.H);
  eachOccupied(base.state, world.board, (k, structure) => {
    const at = world.fromBoard(k);
    if (at >= 0) occ[at]! |= structure ? STRUCTURE : OBJECT;
    return false;
  });
  return occ;
}

/** Cells within `margin` of a marked one: Chebyshev distance on squares, hex steps on hexes. */
export function grown(world: WingWorld, marked: Uint8Array, margin: number): Uint8Array {
  const { L } = world;
  const out = marked.map((v) => (v !== 0 ? 1 : 0));
  if (world.grid === "squares") {
    for (let k = 0; k < marked.length; k++) {
      if (marked[k] === 0) continue;
      const x = k % L.W;
      const y = (k - x) / L.W;
      for (let dy = -margin; dy <= margin; dy++) for (let dx = -margin; dx <= margin; dx++) if (L.inMap(x + dx, y + dy)) out[(y + dy) * L.W + x + dx] = 1;
    }
    return out;
  }
  let ring: number[] = [];
  for (let k = 0; k < marked.length; k++) if (marked[k] !== 0) ring.push(k);
  for (let step = 0; step < margin; step++) {
    const next: number[] = [];
    for (const k of ring) for (const n of L.halo(k)) if (out[n] !== 1) (out[n] = 1), next.push(n);
    ring = next;
  }
  return out;
}

/** The free walls whose ends the wing's wall pass leaves alone: every wall of the scene but the join's, which the wing replaces (DG3 build note OPUS-41). */
export function standingWallEnds(world: WingWorld, join: JoinExpect): Set<string> {
  const replaced = new Set(join.grid === "hex" ? join.walls.map((w) => `${w.cx},${w.cy},${w.id}`) : []);
  const out = new Set<string>();
  for (const { cx, cy, wall } of freeWalls(world)) if (!replaced.has(`${cx},${cy},${wall.id}`)) for (const key of hexWallKeys(world, [wall])) out.add(key);
  return out;
}

/** A join's features as the pick finds them, for building the `JoinExpect` it hands the pane. */
export function joinFeatures(base: WingScene, edges: readonly string[]): { key: string; feature: EdgeFeature | null }[] {
  const world = wingWorld(base);
  const all = new Map<string, EdgeFeature>(world.chunks.flatMap((c) => Object.entries(c.edges)));
  return edges.map((key) => ({ key, feature: all.get(key) ?? null }));
}

/** A free wall's feature as a door leaf's state on the plan: a wall becomes a closed door, a door keeps its state (3.2). */
export function leafState(f: WallFeature | EdgeFeature | null): "closed" | "locked" | "secret" | "keep" {
  if (f && f.kind === "door") return "keep";
  return "closed";
}

/**
 * What the planner takes for a wing (3.4): the scene's lattice, the join,
 * the area as a lattice rectangle, the open ground its rooms and corridors
 * may take (`inside`) and its stub may cross (`reach`), the area's cells
 * closed to rooms (`blocked`, area-local, the approach among them), whether
 * the wing is flat on a "floor" scene, the wall ends the wall pass leaves
 * alone, and what the scene has room for. `problem` says why nothing can
 * be planned.
 */
export type WingSetup = {
  world: WingWorld;
  facts: JoinFacts;
  expect: JoinExpect;
  area: { x: number; y: number; w: number; h: number };
  inside: Uint8Array;
  reach: Uint8Array;
  blocked: Uint8Array;
  approach: number[];
  flat: boolean;
  skip: Set<string>;
  allowance: Allowance;
  problem: WingProblem | null;
};

/** The part of a scene cap a wing may take: 90% of it less what the scene holds (3.4). */
const share = (cap: number, held: number) => Math.max(0, Math.floor(0.9 * cap) - held);

/** What a scene holds of each cap a wing counts against. */
export function wingAllowance(world: WingWorld, base: WingScene): Allowance {
  const sceneId = base.scene.id;
  const count = (o: Readonly<Record<string, { sceneId: string } | undefined>>) => Object.values(o).filter((v) => v?.sceneId === sceneId).length;
  let walls = 0;
  let doors = 0;
  let pillars = 0;
  for (const c of world.chunks) {
    walls += c.walls?.length ?? 0;
    doors += (c.walls ?? []).filter((w) => w.f.kind !== "wall").length;
    doors += Object.values(c.edges).filter((f) => f.kind === "door" || f.kind === "window").length;
    pillars += Object.values(c.cells).filter((t) => t === "pillar").length;
  }
  return {
    walls: Math.min(world.grid === "squares" ? Infinity : MAX_HEX_WALLS, share(LIMITS.freeWallsPerScene, walls)),
    doors: share(LIMITS.doorsAndWindowsPerScene, doors),
    pillars: share(LIMITS.pillarsPerScene, pillars),
    traps: share(LIMITS.trapsPerScene, count(base.state.traps)),
    stamps: share(LIMITS.stampsPerScene, count(base.state.stamps)),
    lights: share(LIMITS.lightsPerScene, count(base.state.lights)),
    pins: share(LIMITS.pinsPerScene, count(base.state.pins)),
  };
}

/** The setup for planning a wing on a base, with Wide's margin and a run's depth from the choices. */
export function wingSetup(base: WingScene & Pick<WingBase, "area" | "join">, s: Pick<DungeonSettings, "wide">): WingSetup {
  const world = wingWorld(base);
  const { L } = world;
  const columns = world.grid === "hexColumns";
  const raw = columns ? { x: base.area.y, y: base.area.x, w: base.area.h, h: base.area.w } : base.area;
  const area = { x: Math.max(0, raw.x), y: Math.max(0, raw.y), w: Math.max(0, Math.min(L.W, raw.x + raw.w) - Math.max(0, raw.x)), h: Math.max(0, Math.min(L.H, raw.y + raw.h) - Math.max(0, raw.y)) };
  const empty = new Uint8Array(L.W * L.H);
  const facts0: JoinFacts = { inside: [], outside: [], side: "w", dir: 3, ground: 0, door: false };
  const none = (problem: WingProblem): WingSetup => ({ world, facts: facts0, expect: base.join, area, inside: empty, reach: empty, blocked: new Uint8Array(area.w * area.h).fill(1), approach: [], flat: false, skip: new Set(), allowance: wingAllowance(world, base), problem });
  if (world.autoWalls === "off") return none("noGround");
  const read = readJoin(base, base.join, base.area, s.wide);
  if (!read.ok) return none(read.problem);
  const facts = read.facts;
  const flat = world.grid === "squares" && world.autoWalls === "floor";
  if (flat && facts.ground !== 0) return none("raised");
  const margin = s.wide ? 3 : 2;
  const occ = occupiedOf(world, base);
  const way = { inside: facts.inside.map(world.toBoard), outside: facts.outside.map(world.toBoard), dir: facts.dir };
  const excused = excusedOf(world.board, joinedRoom(world.board, base.scene, way, base.join));
  // The approach runs past the joined room's own margin, since a hex wall's outside hex is occupied too.
  const approach = approachOf(world.board, way, runAt(facts.ground), margin).flatMap((k) => {
    const at = world.fromBoard(k);
    return at < 0 ? [] : [at];
  });
  const approachSet = new Set(approach);
  // For the approach the joined room's own structure does not count, but its objects and stair marks do (D-261110-233).
  const otherOcc = occ.slice();
  for (const k of excused) {
    const at = world.fromBoard(k);
    if (at >= 0) otherOcc[at]! &= ~STRUCTURE;
  }
  const nearAll = grown(world, occ, margin);
  const nearOther = grown(world, otherOcc, margin);
  const flood = planningFlood(world, facts.outside[0]!, null);
  const reach = new Uint8Array(L.W * L.H);
  for (const k of flood) if ((approachSet.has(k) ? nearOther[k] : nearAll[k]) === 0) reach[k] = 1;
  if (approach.some((k) => reach[k] !== 1)) return { ...none("nearJoin"), facts };
  const inside = new Uint8Array(L.W * L.H);
  const blocked = new Uint8Array(area.w * area.h).fill(1);
  for (let y = 0; y < area.h; y++) {
    for (let x = 0; x < area.w; x++) {
      const k = (area.y + y) * L.W + area.x + x;
      if (!L.inMap(area.x + x, area.y + y) || reach[k] !== 1) continue;
      inside[k] = 1;
      if (!approachSet.has(k)) blocked[y * area.w + x] = 0;
    }
  }
  return { world, facts, expect: base.join, area, inside, reach, blocked, approach, flat, skip: world.grid === "squares" ? new Set() : standingWallEnds(world, base.join), allowance: wingAllowance(world, base), problem: null };
}

/**
 * A wing base's hash (4.2, D-261110-231): what the planner reads of the
 * scene, the join's facts and the open ground, so a base posted again with
 * the same ground keeps the edits and one whose ground changed drops them.
 */
export function wingHash(base: WingScene & Pick<WingBase, "area" | "join">, s: Pick<DungeonSettings, "wide">): string {
  const setup = wingSetup(base, s);
  let h = 0x811c9dc5;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(JSON.stringify([setup.world.grid, base.scene.bounds, setup.world.autoWalls, base.area, base.join, setup.facts, setup.problem, [...setup.skip].sort()]));
  for (let k = 0; k < setup.reach.length; k++) if (setup.reach[k] === 1) feed(`${k},`);
  return h.toString(16).padStart(8, "0");
}
