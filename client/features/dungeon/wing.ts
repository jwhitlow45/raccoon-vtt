import { LIMITS } from "#shared/limits.ts";
import { CHUNK_CELLS, type AutoWalls, type BuildChunk, type CellRect, type EdgeFeature, type FreeWall, type Scene, type WallFeature } from "#shared/model.ts";
import { stampCells } from "#shared/project.ts";
import { autoWallsOf, paintedCell, type Painted } from "#shared/rules/autoWalls.ts";
import { occupiedCells, occupiedHexes } from "#shared/rules/footprint.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { chunkHeights, markIn } from "#shared/rules/heights.ts";
import { hexAt, type HexGrid } from "#shared/rules/hex.ts";
import type { JoinExpect } from "#shared/rules/wingClear.ts";
import { endsKey, hexSide } from "./hexWalls.ts";
import { hexGridOf, latticeFor, type Lattice } from "./lattice.ts";
import { DX, DY, type Side } from "./layout.ts";
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
  grid: GridKind;
  autoWalls: AutoWalls;
  /** A scene key's lattice cell, or -1 off the scene. */
  cellOf(key: string): number;
  chunks: readonly BuildChunk[];
};

const SIDES: readonly Side[] = ["n", "e", "s", "w"];

export function wingWorld(base: WingScene): WingWorld {
  const scene = base.scene;
  const grid: GridKind = scene.gridShape ?? "squares";
  const L = latticeFor(grid, scene.bounds);
  const chunks = Object.values(base.state.buildChunks).filter((c): c is BuildChunk => c !== undefined && c.sceneId === scene.id);
  const cellOf = (key: string) => {
    const [a, b] = key.split(",").map(Number) as [number, number];
    const [x, y] = grid === "hexColumns" ? [b, a] : [a, b];
    return Number.isInteger(x) && Number.isInteger(y) && L.inMap(x, y) ? y * L.W + x : -1;
  };
  return { L, grid, autoWalls: autoWallsOf(scene), cellOf, chunks };
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

/** The two lattice cells either side of a one-side hex wall, or null when its ends are not one hex side. */
function hexesBeside(world: WingWorld, a: readonly [number, number], b: readonly [number, number]): [number, number] | null {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const nx = (-dy / len) * 0.25;
  const ny = (dx / len) * 0.25;
  const p = cellAt(world, mx + nx, my + ny);
  const q = cellAt(world, mx - nx, my - ny);
  if (p < 0 || q < 0 || p === q) return null;
  const d = world.L.halo(p).includes(q) ? [0, 1, 2, 3, 4, 5].find((dir) => world.L.step(p, dir, 1) === q) : undefined;
  if (d === undefined) return null;
  return endsKey(...hexSide(world.L, p, d)) === endsKey(a, b) ? [p, q] : null;
}

/** Every free wall of the scene, with its chunk. */
function freeWalls(world: WingWorld): { cx: number; cy: number; wall: FreeWall }[] {
  return world.chunks.flatMap((c) => (c.walls ?? []).map((wall) => ({ cx: c.cx, cy: c.cy, wall })));
}

/**
 * The join (3.2): its inside and outside cells, its way out and its ground,
 * or the problem with it. `reaches` says whether ground beyond a cell
 * reaches the area, which sets the outside on hexes.
 */
export function readJoin(base: WingScene, join: JoinExpect, area: CellRect, wide: boolean): { ok: true; facts: JoinFacts } | { ok: false; problem: WingProblem } {
  const world = wingWorld(base);
  const { L } = world;
  const byKey = new Map(world.chunks.map((c) => [`${c.cx},${c.cy}`, c]));
  if (join.grid === "squares") {
    if (world.grid !== "squares") return { ok: false, problem: "offGrid" };
    if (join.edges.length !== (wide ? 2 : 1)) return { ok: false, problem: "wideShape" };
    const lanes = join.edges.map((e) => {
      const [p, q] = edgeCells(e.key);
      const pp = paintedIn(world, byKey, ...p);
      const qp = paintedIn(world, byKey, ...q);
      const north = e.key.endsWith(",n");
      // The inside is the painted side: floor terrain, the ground an automatic wall bounds.
      if (pp !== "empty" && qp === "empty") return { inside: p, outside: q, side: (north ? "s" : "e") as Side };
      if (qp !== "empty" && pp === "empty") return { inside: q, outside: p, side: (north ? "n" : "w") as Side };
      return null;
    });
    if (lanes.some((l) => l === null)) return { ok: false, problem: "noGround" };
    const ok = lanes as { inside: [number, number]; outside: [number, number]; side: Side }[];
    if (ok.some((l) => l.side !== ok[0]!.side)) return { ok: false, problem: "wideShape" };
    const inside = ok.map((l) => l.inside[1] * L.W + l.inside[0]);
    const outside = ok.map((l) => l.outside[1] * L.W + l.outside[0]);
    if (outside.some((k, i) => !L.inMap(ok[i]!.outside[0], ok[i]!.outside[1]) || k < 0)) return { ok: false, problem: "noGround" };
    if (wide && Math.abs(inside[0]! - inside[1]!) !== (ok[0]!.side === "n" || ok[0]!.side === "s" ? 1 : L.W)) return { ok: false, problem: "wideShape" };
    const order = inside.map((_, i) => i).sort((a, b) => inside[a]! - inside[b]!);
    const ground = groundOf(world, byKey, inside[order[0]!]!);
    if (ground === null || inside.some((k) => groundOf(world, byKey, k) !== ground)) return { ok: false, problem: "raised" };
    return {
      ok: true,
      facts: { inside: order.map((i) => inside[i]!), outside: order.map((i) => outside[i]!), side: ok[0]!.side, dir: SIDES.indexOf(ok[0]!.side), ground, door: join.edges.every((e) => e.feature?.kind === "door") },
    };
  }
  if (world.grid === "squares") return { ok: false, problem: "longWall" };
  if (join.walls.length !== (wide ? 3 : 1)) return { ok: false, problem: "wideShape" };
  const pairs = join.walls.map((w) => hexesBeside(world, w.a, w.b));
  if (pairs.some((p) => p === null)) return { ok: false, problem: "longWall" };
  const sides = pairs as [number, number][];
  const flood = (from: number) => planningFlood(world, from, null);
  const areaCells = new Set(areaCellsOf(world, area));
  const reachesArea = (from: number) => [...flood(from)].some((k) => areaCells.has(k));
  const hexes = [...new Set(sides.flat())];
  if (hexes.length !== (wide ? 4 : 2)) return { ok: false, problem: "wideShape" };
  // The outside is the side whose flood reaches the area, and the inside the other, which must be a closed room.
  const first = sides[0]!;
  const outsideOf = (p: [number, number]) => (reachesArea(p[0]) ? p[0] : reachesArea(p[1]) ? p[1] : -1);
  const firstOut = outsideOf(first);
  if (firstOut < 0) return { ok: false, problem: "noGround" };
  const firstIn = first[0] === firstOut ? first[1] : first[0];
  if (flood(firstIn).has(firstOut)) return { ok: false, problem: "openRoom" };
  const room = flood(firstIn);
  const inside = hexes.filter((k) => room.has(k)).sort((a, b) => a - b);
  const outside = hexes.filter((k) => !room.has(k)).sort((a, b) => a - b);
  if (inside.length !== outside.length) return { ok: false, problem: "wideShape" };
  // A Wide join is the planner's own Wide doorway: two lanes a row or an offset column apart, each lane stepping out the same way.
  const dirs = inside.map((k, i) => [0, 1, 2, 3, 4, 5].find((d) => L.step(k, d, 1) === outside[i]) ?? -1);
  if (dirs.some((d) => d < 0 || d !== dirs[0])) return { ok: false, problem: "wideShape" };
  if (wide && inside[1]! - inside[0]! !== 1 && inside[1]! - inside[0]! !== L.W) return { ok: false, problem: "wideShape" };
  const dir = dirs[0]!;
  const ground = groundOf(world, byKey, inside[0]!);
  if (ground === null || inside.some((k) => groundOf(world, byKey, k) !== ground)) return { ok: false, problem: "raised" };
  const side: Side = dir === 0 ? "e" : dir === 3 ? "w" : dir === 1 || dir === 2 ? "s" : "n";
  return { ok: true, facts: { inside, outside, side, dir, ground, door: join.walls.every((w) => w.f.kind === "door") } };
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

/**
 * The joined room (3.4): the flood from the join's inside cell with the
 * join read as a wall. On squares it crosses painted cells, stopping at
 * drawn edges, free walls and automatic walls, and keeps only cells on the
 * room's side of the join's wall line, since a doorless opening could
 * otherwise take in a corridor beyond it (DG3 build note OPUS-40).
 */
export function joinedRoom(world: WingWorld, join: JoinExpect, facts: JoinFacts): Set<number> {
  const { L } = world;
  const room = new Set<number>();
  const byKey = new Map(world.chunks.map((c) => [`${c.cx},${c.cy}`, c]));
  const walls = freeWalls(world).map((w) => w.wall);
  const edges = new Map<string, EdgeFeature>(world.chunks.flatMap((c) => Object.entries(c.edges)));
  const extra = new Set(join.grid === "squares" ? join.edges.map((e) => e.key) : join.walls.map((w) => endsKey(w.a, w.b)));
  const squares = world.grid === "squares";
  const [jx, jy] = [facts.inside[0]! % L.W, Math.floor(facts.inside[0]! / L.W)];
  const roomSide = (k: number) => {
    if (!squares) return true;
    const x = k % L.W;
    const y = (k - x) / L.W;
    return facts.side === "n" ? y >= jy : facts.side === "s" ? y <= jy : facts.side === "w" ? x >= jx : x <= jx;
  };
  const painted = (k: number) => paintedIn(world, byKey, k % L.W, Math.floor(k / L.W));
  const passes = (k: number, n: number) => {
    if (!squares) return !wallBetween(world, walls, edges, k, n, extra);
    const a = painted(k);
    const b = painted(n);
    if (b === "empty" || !roomSide(n)) return false;
    if (world.autoWalls === "all" ? a === "empty" : a === "empty" && b === "floor") return false;
    return !wallBetween(world, walls, edges, k, n, extra);
  };
  const queue = [...facts.inside];
  for (const k of queue) room.add(k);
  while (queue.length > 0) {
    const k = queue.pop()!;
    for (const n of L.halo(k)) {
      if (room.has(n) || !passes(k, n)) continue;
      room.add(n);
      queue.push(n);
    }
  }
  return room;
}

/**
 * Every occupied cell (3.4): painted ground, drawn edges and free walls by
 * both their cells, height, stair and difficult marks, token footprints,
 * trap zones and the cells they hit, stamp boxes, lights, labels, pins and
 * floor link squares.
 */
export function occupiedOf(world: WingWorld, base: WingScene): Uint8Array {
  const { L } = world;
  const occ = new Uint8Array(L.W * L.H);
  const sceneId = base.scene.id;
  const mark = (k: number) => {
    if (k >= 0) occ[k] = 1;
  };
  const markKey = (key: string) => mark(world.cellOf(key));
  const markRect = (r: CellRect) => {
    for (let b = r.y; b < r.y + r.h; b++) for (let a = r.x; a < r.x + r.w; a++) markKey(`${a},${b}`);
  };
  const markPoint = (x: number, y: number) => mark(cellAt(world, x, y));
  const markSegment = (a: readonly [number, number], b: readonly [number, number]) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / 0.2));
    // Both cells of a wall: the points just off each side of it, all along.
    const nx = len === 0 ? 0 : (-(b[1] - a[1]) / len) * 0.2;
    const ny = len === 0 ? 0 : ((b[0] - a[0]) / len) * 0.2;
    for (let i = 0; i <= steps; i++) {
      const px = a[0] + ((b[0] - a[0]) * i) / steps;
      const py = a[1] + ((b[1] - a[1]) * i) / steps;
      markPoint(px + nx, py + ny);
      markPoint(px - nx, py - ny);
    }
  };
  for (const c of world.chunks) {
    for (const key of Object.keys(c.cells)) markKey(key);
    for (const [key, f] of Object.entries(c.edges)) {
      if (f.kind === "none") continue;
      for (const [x, y] of edgeCells(key)) markKey(`${x},${y}`);
    }
    for (const w of c.walls ?? []) markSegment(w.a, w.b);
    const heights = chunkHeights(c);
    for (let j = 0; j < CHUNK_CELLS; j++) {
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const a = c.cx * CHUNK_CELLS + i;
        const b = c.cy * CHUNK_CELLS + j;
        const at = j * CHUNK_CELLS + i;
        if ((heights && heights[at] !== 0) || (c.up && c.up[at] !== ".") || (c.rough && c.rough[at] !== ".")) markKey(`${a},${b}`);
      }
    }
  }
  const g = gridOfShape(base.scene.gridShape);
  for (const t of Object.values(base.state.tokens)) {
    if (!t || t.sceneId !== sceneId) continue;
    if (g.shape === "hex") for (const h of occupiedHexes(g as HexGrid, t)) markKey(`${h.col},${h.row}`);
    else for (const p of occupiedCells(g, t)) markKey(`${p.x},${p.y}`);
  }
  for (const trap of Object.values(base.state.traps)) {
    if (!trap || trap.sceneId !== sceneId) continue;
    const z = trap.zone;
    if ("cells" in z) z.cells.forEach(markRect);
    else if ("wire" in z) markSegment(z.wire.a, z.wire.b);
    else if ("edge" in z.door) for (const [x, y] of edgeCells(z.door.edge)) markKey(`${x},${y}`);
    else {
      const ref = z.door;
      const wall = world.chunks.find((c) => c.cx === ref.cx && c.cy === ref.cy)?.walls?.find((w) => w.id === ref.id);
      if (wall) markSegment(wall.a, wall.b);
    }
    const hits = trap.rig?.hits;
    if (hits && typeof hits === "object" && "cells" in hits) hits.cells.forEach(markRect);
  }
  for (const st of Object.values(base.state.stamps)) {
    if (!st || st.sceneId !== sceneId) continue;
    const box = stampCells(st);
    // A stamp's box in whole cells: every square of it, or every hex a point of it falls in.
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) markPoint(x + dx, y + dy);
  }
  for (const l of Object.values(base.state.lights)) if (l && l.sceneId === sceneId) markPoint(l.x, l.y);
  for (const l of Object.values(base.state.labels)) if (l && l.sceneId === sceneId) markPoint(l.x, l.y);
  for (const p of Object.values(base.state.pins)) if (p && p.sceneId === sceneId) markPoint(p.x, p.y);
  for (const f of Object.values(base.state.floorLinks ?? {})) if (f && f.sceneId === sceneId) markRect(f.rect);
  return occ;
}

/** Cells within `margin` of a marked one: Chebyshev distance on squares, hex steps on hexes. */
export function grown(world: WingWorld, marked: Uint8Array, margin: number): Uint8Array {
  const { L } = world;
  const out = marked.slice();
  if (world.grid === "squares") {
    for (let k = 0; k < marked.length; k++) {
      if (marked[k] !== 1) continue;
      const x = k % L.W;
      const y = (k - x) / L.W;
      for (let dy = -margin; dy <= margin; dy++) for (let dx = -margin; dx <= margin; dx++) if (L.inMap(x + dx, y + dy)) out[(y + dy) * L.W + x + dx] = 1;
    }
    return out;
  }
  let ring: number[] = [];
  for (let k = 0; k < marked.length; k++) if (marked[k] === 1) ring.push(k);
  for (let step = 0; step < margin; step++) {
    const next: number[] = [];
    for (const k of ring) for (const n of L.halo(k)) if (out[n] !== 1) (out[n] = 1), next.push(n);
    ring = next;
  }
  return out;
}

/** The joined room's own structure, which the approach's cells do not count (3.4): its cells and both cells of each of its boundary walls or edges. */
export function excusedOf(world: WingWorld, room: ReadonlySet<number>): Set<number> {
  const out = new Set(room);
  for (const k of room) for (const n of world.L.halo(k)) out.add(n);
  return out;
}

/** The join's approach (3.4): its outside cells and the cells straight out from them for the doorway's depth. */
export function approachOf(world: WingWorld, facts: JoinFacts, depth: number): number[] {
  const out: number[] = [];
  for (const o of facts.outside) {
    for (let t = 0; t < depth; t++) {
      const k = world.grid === "squares" ? stepSquare(world.L, o, facts.side, t) : world.L.step(o, facts.dir, t);
      if (k !== null && k >= 0) out.push(k);
    }
  }
  return out;
}

function stepSquare(L: Lattice, k: number, side: Side, t: number): number | null {
  const x = (k % L.W) + DX[side] * t;
  const y = Math.floor(k / L.W) + DY[side] * t;
  return L.inMap(x, y) ? y * L.W + x : null;
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
  const room = joinedRoom(world, base.join, facts);
  const excused = excusedOf(world, room);
  // The approach runs past the joined room's own margin, since a hex wall's outside hex is occupied too: the outside cell, a run where the floor is raised or sunk, then the margin.
  const depth = 1 + (facts.ground !== 0 ? Math.abs(facts.ground) / 5 + 1 : 0) + margin;
  const approach = approachOf(world, facts, depth);
  const approachSet = new Set(approach);
  const otherOcc = occ.slice();
  for (const k of excused) otherOcc[k] = 0;
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
