import { CHUNK_CELLS, type AutoWalls, type BuildChunk, type EdgeFeature, type FreeWall, type RoomState, type Scene, type WallFeature } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { stampCells } from "../project.ts";
import { autoWallBetween, autoWallsOf, paintedAt, type Painted } from "./autoWalls.ts";
import { occupiedCells, occupiedHexes } from "./footprint.ts";
import { sceneGrid } from "./grid.ts";
import { chunkHeights, chunkMarks, groundAt } from "./heights.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";

/*
 * What a wing's asks carry for the server to check (docs/design: dungeon
 * generator phase 3, 3.6, D-261110-172, 232 and 234): the join as the DM
 * tapped it, and the margin the wing keeps from everything else. The
 * generator writes these shapes into its plan and the ask carries them.
 * The device runs the same two checks at Make (dungeon/send.ts), so a wing
 * the server would refuse is planned again before it is asked about.
 */

/**
 * The wall a wing joins as it stood when planned. On squares its grid
 * edges, each with its feature (null for an automatic wall) and the ground
 * of its inside cell. On hexes its one-side free walls by chunk, id, ends
 * and feature, and the ground of the hexes inside it.
 */
export type JoinExpect =
  | { grid: "squares"; edges: { key: string; feature: EdgeFeature | null; ground: number }[] }
  | { grid: "hex"; walls: { cx: number; cy: number; id: string; a: [number, number]; b: [number, number]; f: WallFeature }[]; ground: number };

/**
 * A wing ask's check: the margin in cells (3 on Wide), the join, the
 * scene's automatic-wall rule, and on hexes the wing's whole floor as row
 * runs, carried on the last part only. A run `[y, x0, x1]` is the scene
 * keys "x0,y" to "x1,y". `inside` names the hexes inside a hex join by
 * their keys, since a free wall's ends do not say which side is the room:
 * the server reads their ground there, and a hex join without them reads
 * as changed. Squares find the inside from the paint.
 */
export type WingClear = { margin: 2 | 3; join: JoinExpect; autoWalls: AutoWalls; floor?: [row: number, from: number, to: number][]; inside?: string[] };

/** Refuses an ask whose join no longer stands as planned (D-261110-234). The device clears the join and the DM taps it again. */
export const JOIN_CHANGED = "The wall the wing joins has changed. Tap it again.";
/** Refuses an ask whose footprint or margin meets something new (D-261110-172). The device plans again. */
export const WING_MOVED = "Something moved into the area. Generate again.";

type ClearState = Pick<RoomState, "scenes" | "buildChunks">;
type ClashState = Pick<RoomState, "scenes" | "buildChunks" | "tokens" | "traps" | "stamps" | "lights" | "labels" | "pins" | "floorLinks">;
type MapOp = OpOf<"build.ask">["ops"][number];

/** A scene key as one number: every scene key's parts are below 4,096. */
const STRIDE = 4096;
const packed = (x: number, y: number) => y * STRIDE + x;
const xOf = (k: number) => k % STRIDE;
const yOf = (k: number) => Math.floor(k / STRIDE);
const keyText = (k: number) => `${xOf(k)},${yOf(k)}`;

/** How the checks read one scene: its grid, its chunks, and its cells by packed key. */
type Board = {
  sceneId: string;
  hex: HexGrid | null;
  chunks: Readonly<Record<string, BuildChunk>>;
  own: BuildChunk[];
  inScene(k: number): boolean;
  /** The cell or hex a point falls in, or -1 off the scene. */
  at(x: number, y: number): number;
  neighbors(k: number): number[];
};

function boardOf(state: ClearState, scene: Scene): Board {
  const g = sceneGrid(scene);
  const hex = g.shape === "hex" ? g : null;
  const { w, h } = scene.bounds;
  const own = Object.values(state.buildChunks).filter((c): c is BuildChunk => c !== undefined && c.sceneId === scene.id);
  const base = { sceneId: scene.id, chunks: state.buildChunks, own };
  if (!hex) {
    return {
      ...base,
      hex: null,
      inScene: (k) => xOf(k) < w && yOf(k) < h,
      at: (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? packed(Math.floor(x), Math.floor(y)) : -1),
      neighbors: (k) => {
        const x = xOf(k);
        const y = yOf(k);
        const out: number[] = [];
        for (const [dx, dy] of SQUARE_STEP) if (x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h) out.push(packed(x + dx, y + dy));
        return out;
      },
    };
  }
  const fits = (c: Hex) => c.col >= 0 && c.row >= 0 && c.col < STRIDE && c.row < STRIDE && hexInScene(hex, scene.bounds, c);
  return {
    ...base,
    hex,
    inScene: (k) => fits({ col: xOf(k), row: yOf(k) }),
    at: (x, y) => {
      const c = hexAt(hex, { x, y });
      return fits(c) ? packed(c.col, c.row) : -1;
    },
    neighbors: (k) => hexNeighbors(hex, { col: xOf(k), row: yOf(k) }).flatMap((c) => (fits(c) ? [packed(c.col, c.row)] : [])),
  };
}

/** Square sides 0 to 3: north, east, south, west. */
const SQUARE_STEP: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** A cell at whole coordinates as a packed key, or -1 off the scene. */
function cellAt(board: Board, x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= STRIDE || y >= STRIDE) return -1;
  const k = packed(x, y);
  return board.inScene(k) ? k : -1;
}

/** A cell key "x,y" as a packed key, or -1 when it is not one of the scene's. */
function cellKey(board: Board, key: string): number {
  const [a, b] = key.split(",").map(Number) as [number, number];
  return cellAt(board, a, b);
}

/** The two cells a grid edge "x,y,n" or "x,y,w" lies between, the north or west one first. */
function edgeCells(key: string): [[number, number], [number, number]] {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  return side === "n" ? [[x, y - 1], [x, y]] : [[x - 1, y], [x, y]];
}

const sameEnds = (a: readonly [number, number], b: readonly [number, number], p: readonly [number, number], q: readonly [number, number]) =>
  (a[0] === p[0] && a[1] === p[1] && b[0] === q[0] && b[1] === q[1]) || (a[0] === q[0] && a[1] === q[1] && b[0] === p[0] && b[1] === p[1]);

/**
 * The two hexes either side of a free wall exactly one hex side long, with
 * the direction from the first to the second, or null for any other wall.
 */
function hexesBeside(board: Board, a: readonly [number, number], b: readonly [number, number]): { p: number; q: number; dir: number } | null {
  const hex = board.hex;
  if (!hex) return null;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len === 0) return null;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = (-(b[1] - a[1]) / len) * 0.25;
  const ny = ((b[0] - a[0]) / len) * 0.25;
  const p = hexAt(hex, { x: mx + nx, y: my + ny });
  const q = hexAt(hex, { x: mx - nx, y: my - ny });
  const dir = hexNeighbors(hex, p).findIndex((n) => n.col === q.col && n.row === q.row);
  if (dir < 0 || p.col < 0 || p.row < 0 || q.col < 0 || q.row < 0) return null;
  const corners = hexCorners(hex, p);
  const s = cornerAt(hex, corners[(dir + 1) % 6]!);
  const t = cornerAt(hex, corners[(dir + 2) % 6]!);
  if (!sameEnds(a, b, [s.x, s.y], [t.x, t.y])) return null;
  return { p: packed(p.col, p.row), q: packed(q.col, q.row), dir };
}

/**
 * A join as it stands now: its inside and outside cells, and the direction
 * out (a square side 0 to 3, or a hex direction).
 */
type JoinNow = { inside: number[]; outside: number[]; dir: number };

/** The join as it stands, or null where it no longer stands as planned (H5). */
function readJoin(board: Board, scene: Scene, clear: WingClear): JoinNow | null {
  if (autoWallsOf(scene) !== clear.autoWalls) return null;
  const join = clear.join;
  const out: JoinNow = { inside: [], outside: [], dir: -1 };
  const sameDir = (dir: number) => {
    if (out.dir >= 0 && out.dir !== dir) return false;
    out.dir = dir;
    return true;
  };
  if (join.grid === "squares") {
    if (board.hex) return null;
    for (const e of join.edges) {
      const [p, q] = edgeCells(e.key);
      const pp = paintedAt(board.chunks, scene.id, p[0], p[1]);
      const qp = paintedAt(board.chunks, scene.id, q[0], q[1]);
      // The inside is the painted side, as the pick reads it (3.2).
      if ((pp === "empty") === (qp === "empty")) return null;
      const [inside, outside] = pp !== "empty" ? [p, q] : [q, p];
      const north = e.key.endsWith(",n");
      if (!sameDir(north ? (pp !== "empty" ? 2 : 0) : pp !== "empty" ? 1 : 3)) return null;
      if (!sameFeature(edgeNow(board, e.key), e.feature, clear.autoWalls, pp, qp)) return null;
      const ki = cellAt(board, inside[0], inside[1]);
      const ko = cellAt(board, outside[0], outside[1]);
      if (ki < 0 || ko < 0 || groundAt(board.chunks, scene.id, inside[0], inside[1]) !== e.ground) return null;
      out.inside.push(ki);
      out.outside.push(ko);
    }
    return out;
  }
  if (!board.hex || !clear.inside || clear.inside.length === 0) return null;
  const inside = new Set(clear.inside.map((key) => cellKey(board, key)));
  if (inside.has(-1)) return null;
  for (const w of join.walls) {
    const now = board.chunks[`${scene.id}:${w.cx},${w.cy}`]?.walls?.find((x) => x.id === w.id);
    if (!now || now.a[0] !== w.a[0] || now.a[1] !== w.a[1] || now.b[0] !== w.b[0] || now.b[1] !== w.b[1] || !sameWallFeature(now.f, w.f)) return null;
    const side = hexesBeside(board, w.a, w.b);
    if (!side || !board.inScene(side.p) || !board.inScene(side.q)) return null;
    let lane: [number, number, number];
    if (inside.has(side.p) && !inside.has(side.q)) lane = [side.p, side.q, side.dir];
    else if (inside.has(side.q) && !inside.has(side.p)) lane = [side.q, side.p, (side.dir + 3) % 6];
    else return null;
    if (!sameDir(lane[2])) return null;
    if (!out.inside.includes(lane[0])) out.inside.push(lane[0]);
    if (!out.outside.includes(lane[1])) out.outside.push(lane[1]);
  }
  for (const k of inside) if (!out.inside.includes(k) || groundAt(board.chunks, scene.id, xOf(k), yOf(k)) !== join.ground) return null;
  return out;
}

/** A grid edge's drawn feature now, or undefined where none is drawn. */
function edgeNow(board: Board, key: string): EdgeFeature | undefined {
  const [, q] = edgeCells(key);
  return board.chunks[`${board.sceneId}:${Math.floor(q[0] / CHUNK_CELLS)},${Math.floor(q[1] / CHUNK_CELLS)}`]?.edges[key];
}

/** Whether an edge still carries what the join planned: the same drawn feature, or no drawn one and still an automatic wall where it was one. */
function sameFeature(now: EdgeFeature | undefined, planned: EdgeFeature | null, rule: AutoWalls, a: Painted, b: Painted): boolean {
  if (planned === null) return now === undefined && autoWallBetween(rule, a, b);
  return now !== undefined && JSON.stringify(normalFeature(now)) === JSON.stringify(normalFeature(planned));
}

/** A feature's fields in one order, so two equal ones compare equal however they were written. */
function normalFeature(f: EdgeFeature): unknown {
  if (f.kind !== "door") return { kind: f.kind };
  return { kind: "door", state: f.state, secret: f.secret, discovered: f.discovered, cover: "cover" in f ? (f.cover ?? null) : null };
}

const sameWallFeature = (a: WallFeature, b: WallFeature) => JSON.stringify(normalFeature(a)) === JSON.stringify(normalFeature(b));

/**
 * Whether the join no longer stands as planned (3.6, H5): any of its edges
 * or walls gone, moved, or with another feature or door state, the ground
 * inside it changed, or the scene's automatic-wall rule changed.
 */
export function joinChanged(state: ClearState, sceneId: string, clear: WingClear): boolean {
  const scene = state.scenes[sceneId];
  if (!scene) return true;
  return readJoin(boardOf(state, scene), scene, clear) === null;
}

/**
 * Where a wing's ops write, as packed scene keys, split as the check grows
 * them: floor (painted, marked, both cells of an edge, a stamp's box, the
 * floor runs, and the join's outside cells, which the join's own edge or
 * wall writes in place of its two, J1), and the hexes beside its other free
 * walls.
 */
export type WingFootprint = { floor: Set<number>; walls: Set<number> };

/** The cells each op writes, added to `into` (a new footprint when left out). */
export function wingFootprint(state: ClearState, sceneId: string, ops: readonly MapOp[], clear: WingClear, into: WingFootprint = { floor: new Set(), walls: new Set() }): WingFootprint {
  const scene = state.scenes[sceneId];
  if (!scene) return into;
  const board = boardOf(state, scene);
  const join = clear.join;
  const joinEdges = new Set(join.grid === "squares" ? join.edges.map((e) => e.key) : []);
  const joinIds = new Set(join.grid === "hex" ? join.walls.map((w) => `${w.cx},${w.cy},${w.id}`) : []);
  const isJoinWall = (a: readonly [number, number], b: readonly [number, number]) => join.grid === "hex" && join.walls.some((w) => sameEnds(a, b, w.a, w.b));
  let outside: number[] | null = null;
  const joinOutside = () => {
    outside ??= readJoin(board, scene, clear)?.outside ?? [];
    for (const k of outside) into.floor.add(k);
  };
  const floor = (x: number, y: number) => {
    const k = cellAt(board, x, y);
    if (k >= 0) into.floor.add(k);
  };
  for (const op of ops) {
    if (op.sceneId !== sceneId) continue;
    switch (op.t) {
      case "build.paint":
      case "build.erase":
      case "build.height":
      case "build.stairs":
      case "build.rough":
        for (const key of op.cells) {
          const k = cellKey(board, key);
          if (k >= 0) into.floor.add(k);
        }
        break;
      case "build.rect":
        for (let y = op.y; y < op.y + op.h; y++) for (let x = op.x; x < op.x + op.w; x++) floor(x, y);
        break;
      case "build.edge":
        for (const e of op.edges) {
          if (joinEdges.has(e.key)) joinOutside();
          else for (const [x, y] of edgeCells(e.key)) floor(x, y);
        }
        break;
      case "build.walls":
        for (const r of op.remove ?? []) if (joinIds.has(`${r.cx},${r.cy},${r.id}`)) joinOutside();
        for (const w of op.put ?? []) {
          if (isJoinWall(w.a, w.b)) joinOutside();
          else for (const k of wallCells(board, w.a, w.b)) into.walls.add(k);
        }
        break;
      case "build.stamps":
        for (const s of op.put ?? []) for (const k of boxCells(board, stampCells(s))) into.floor.add(k);
        break;
    }
  }
  for (const [y, x0, x1] of clear.floor ?? []) for (let x = Math.max(0, x0); x <= x1; x++) floor(x, y);
  return into;
}

/** The cells on either side of a segment, all along it: a wall's two cells, or every cell a longer one passes. */
function wallCells(board: Board, a: readonly [number, number], b: readonly [number, number]): Set<number> {
  const out = new Set<number>();
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.ceil(len / 0.2));
  const nx = len === 0 ? 0 : (-(b[1] - a[1]) / len) * 0.2;
  const ny = len === 0 ? 0 : ((b[0] - a[0]) / len) * 0.2;
  for (let i = 0; i <= steps; i++) {
    const px = a[0] + ((b[0] - a[0]) * i) / steps;
    const py = a[1] + ((b[1] - a[1]) * i) / steps;
    for (const k of [board.at(px + nx, py + ny), board.at(px - nx, py - ny)]) if (k >= 0) out.add(k);
  }
  return out;
}

/** The cells of a whole-cell box: every square of it, or every hex a quarter point of each of its squares falls in. */
function boxCells(board: Board, box: { x0: number; y0: number; x1: number; y1: number }): Set<number> {
  const out = new Set<number>();
  const points: readonly (readonly [number, number])[] = board.hex
    ? [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]
    : [[0.5, 0.5]];
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      for (const [dx, dy] of points) {
        const k = board.at(x + dx, y + dy);
        if (k >= 0) out.add(k);
      }
    }
  }
  return out;
}

/** Cells within `margin` steps of any in `from`, added to `into`: Chebyshev on squares, hex steps on hexes. */
function grow(board: Board, from: Iterable<number>, margin: number, into: Set<number>): void {
  if (margin < 0) return;
  if (!board.hex) {
    for (const k of from) {
      const x = xOf(k);
      const y = yOf(k);
      for (let dy = -margin; dy <= margin; dy++) {
        for (let dx = -margin; dx <= margin; dx++) {
          const n = cellAt(board, x + dx, y + dy);
          if (n >= 0) into.add(n);
        }
      }
    }
    return;
  }
  let ring: number[] = [];
  for (const k of from) {
    if (into.has(k)) continue;
    into.add(k);
    ring.push(k);
  }
  for (let step = 0; step < margin; step++) {
    const next: number[] = [];
    for (const k of ring) {
      for (const n of board.neighbors(k)) {
        if (into.has(n)) continue;
        into.add(n);
        next.push(n);
      }
    }
    ring = next;
  }
}

/**
 * The join's approach (3.4): its outside cells and the cells straight out
 * from them for the doorway's depth, which is the outside cell, a run where
 * the floor inside stands raised or sunk, then the margin, as the planner
 * reads it (dungeon/wing.ts).
 */
function approachOf(board: Board, join: JoinNow, ground: number, margin: number): Set<number> {
  const depth = 1 + (ground !== 0 ? Math.abs(ground) / 5 + 1 : 0) + margin;
  const out = new Set<number>();
  for (const o of join.outside) {
    let k = o;
    for (let t = 0; t < depth && k >= 0; t++) {
      out.add(k);
      if (!board.hex) {
        const [dx, dy] = SQUARE_STEP[join.dir]!;
        k = cellAt(board, xOf(k) + dx, yOf(k) + dy);
      } else {
        const n = hexNeighbors(board.hex, { col: xOf(k), row: yOf(k) })[join.dir]!;
        k = cellAt(board, n.col, n.row);
      }
    }
  }
  return out;
}

/** Whether segment p-q meets segment a-b, touching counted. */
function crosses(p: readonly [number, number], q: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): boolean {
  const o = (u: readonly [number, number], v: readonly [number, number], w: readonly [number, number]) => Math.sign((v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]));
  const d1 = o(p, q, a);
  const d2 = o(p, q, b);
  const d3 = o(a, b, p);
  const d4 = o(a, b, q);
  if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
  const within = (u: readonly [number, number], v: readonly [number, number], w: readonly [number, number]) =>
    Math.min(u[0], v[0]) <= w[0] && w[0] <= Math.max(u[0], v[0]) && Math.min(u[1], v[1]) <= w[1] && w[1] <= Math.max(u[1], v[1]);
  return (d1 === 0 && within(p, q, a)) || (d2 === 0 && within(p, q, b)) || (d3 === 0 && within(a, b, p)) || (d4 === 0 && within(a, b, q));
}

/** The scene's free walls, bucketed by every whole cell their box covers, for the flood's crossing test. */
function wallIndex(board: Board): (p: readonly [number, number], q: readonly [number, number]) => FreeWall[] {
  const buckets = new Map<number, FreeWall[]>();
  const cellsOf = (a: readonly [number, number], b: readonly [number, number], each: (k: number) => void) => {
    for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1]))); y <= Math.floor(Math.max(a[1], b[1])); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0]))); x <= Math.floor(Math.max(a[0], b[0])); x++) each(packed(x, y));
    }
  };
  for (const c of board.own) {
    for (const w of c.walls ?? []) {
      cellsOf(w.a, w.b, (k) => {
        const list = buckets.get(k);
        if (list) list.push(w);
        else buckets.set(k, [w]);
      });
    }
  }
  return (p, q) => {
    const out = new Set<FreeWall>();
    cellsOf(p, q, (k) => {
      for (const w of buckets.get(k) ?? []) out.add(w);
    });
    return [...out];
  };
}

/** A cell's middle in scene units: a square's, or its hex's center. */
function middle(board: Board, k: number): [number, number] {
  if (!board.hex) return [xOf(k) + 0.5, yOf(k) + 0.5];
  const c = hexCenter(board.hex, { col: xOf(k), row: yOf(k) });
  return [c.x, c.y];
}

/**
 * The joined room (3.4): the flood from the join's inside cells with the
 * join read as a wall. On squares it crosses painted cells on the room's
 * side of the join's wall line (DG3 build note OPUS-40), stopping at drawn
 * edges, free walls and automatic walls. On hexes it steps between hexes
 * where no free wall of any kind meets the line between their centers, so
 * every door and window bounds it.
 */
function joinedRoom(board: Board, scene: Scene, join: JoinNow, clear: WingClear): Set<number> {
  const room = new Set<number>(join.inside);
  const near = wallIndex(board);
  const squares = !board.hex;
  const jx = xOf(join.inside[0]!);
  const jy = yOf(join.inside[0]!);
  const roomSide = (k: number) => (join.dir === 0 ? yOf(k) >= jy : join.dir === 2 ? yOf(k) <= jy : join.dir === 3 ? xOf(k) >= jx : xOf(k) <= jx);
  const painted = (k: number) => paintedAt(board.chunks, scene.id, xOf(k), yOf(k));
  const joinEdges = new Set(clear.join.grid === "squares" ? clear.join.edges.map((e) => e.key) : []);
  const rule = autoWallsOf(scene);
  const passes = (k: number, n: number) => {
    const p = middle(board, k);
    const q = middle(board, n);
    // The join's own walls are among the scene's, so they bound the room on hexes too.
    if (near(p, q).some((w) => crosses(p, q, w.a, w.b))) return false;
    if (!squares) return true;
    if (painted(n) === "empty" || !roomSide(n) || autoWallBetween(rule, painted(k), painted(n))) return false;
    const key = xOf(k) === xOf(n) ? `${xOf(k)},${Math.max(yOf(k), yOf(n))},n` : `${Math.max(xOf(k), xOf(n))},${yOf(k)},w`;
    if (joinEdges.has(key)) return false;
    const f = edgeNow(board, key);
    return f === undefined || f.kind === "none";
  };
  const queue = [...join.inside];
  while (queue.length > 0) {
    const k = queue.pop()!;
    for (const n of board.neighbors(k)) {
      if (room.has(n) || !passes(k, n)) continue;
      room.add(n);
      queue.push(n);
    }
  }
  return room;
}

/**
 * Every occupied cell (3.4), told to `hit` with whether it is structure
 * (painted ground, drawn edges and free walls by both their cells, height
 * and difficult marks), which the joined room may excuse, or an object
 * (stair marks, token footprints, trap zones and hit cells, stamp boxes,
 * lights, labels, pins, floor link squares), which nothing excuses
 * (D-261110-233). `hit` returning true stops the walk.
 */
function eachOccupied(state: ClashState, board: Board, hit: (k: number, structure: boolean) => boolean): void {
  const sceneId = board.sceneId;
  const at = (x: number, y: number, structure: boolean) => {
    const k = cellAt(board, x, y);
    return k >= 0 && hit(k, structure);
  };
  const rect = (r: { x: number; y: number; w: number; h: number }) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (at(x, y, false)) return true;
    return false;
  };
  const point = (x: number, y: number) => {
    const k = board.at(x, y);
    return k >= 0 && hit(k, false);
  };
  const segment = (a: readonly [number, number], b: readonly [number, number], structure: boolean) => {
    for (const k of wallCells(board, a, b)) if (hit(k, structure)) return true;
    return false;
  };
  const edge = (key: string, structure: boolean) => {
    for (const [x, y] of edgeCells(key)) if (at(x, y, structure)) return true;
    return false;
  };
  for (const c of board.own) {
    for (const key of Object.keys(c.cells)) if (hit(cellKey(board, key), true)) return;
    for (const [key, f] of Object.entries(c.edges)) if (f.kind !== "none" && edge(key, true)) return;
    for (const w of c.walls ?? []) if (segment(w.a, w.b, true)) return;
    const heights = chunkHeights(c);
    const marks = chunkMarks(c);
    const rough = c.rough;
    if (!heights && marks === null && rough === undefined) continue;
    for (let j = 0; j < CHUNK_CELLS; j++) {
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const n = j * CHUNK_CELLS + i;
        const x = c.cx * CHUNK_CELLS + i;
        const y = c.cy * CHUNK_CELLS + j;
        if (((heights !== null && heights[n] !== 0) || (rough !== undefined && rough[n] === "d")) && at(x, y, true)) return;
        if (marks !== null && marks[n] !== "." && at(x, y, false)) return;
      }
    }
  }
  const g = sceneGrid(state.scenes[sceneId]!);
  for (const t of Object.values(state.tokens)) {
    if (!t || t.sceneId !== sceneId) continue;
    if (g.shape === "hex") {
      for (const h of occupiedHexes(g, t)) if (at(h.col, h.row, false)) return;
    } else for (const p of occupiedCells(g, t)) if (at(p.x, p.y, false)) return;
  }
  for (const trap of Object.values(state.traps)) {
    if (!trap || trap.sceneId !== sceneId) continue;
    const z = trap.zone;
    if ("cells" in z) {
      if (z.cells.some(rect)) return;
    } else if ("wire" in z) {
      if (segment(z.wire.a, z.wire.b, false)) return;
    } else if ("edge" in z.door) {
      if (edge(z.door.edge, false)) return;
    } else {
      const ref = z.door;
      const wall = state.buildChunks[`${sceneId}:${ref.cx},${ref.cy}`]?.walls?.find((w) => w.id === ref.id);
      if (wall && segment(wall.a, wall.b, false)) return;
    }
    const hits = trap.rig?.hits;
    if (hits && typeof hits === "object" && "cells" in hits && hits.cells.some(rect)) return;
  }
  for (const st of Object.values(state.stamps)) {
    if (!st || st.sceneId !== sceneId) continue;
    for (const k of boxCells(board, stampCells(st))) if (hit(k, false)) return;
  }
  for (const l of Object.values(state.lights)) if (l && l.sceneId === sceneId && point(l.x, l.y)) return;
  for (const l of Object.values(state.labels)) if (l && l.sceneId === sceneId && point(l.x, l.y)) return;
  for (const p of Object.values(state.pins)) if (p && p.sceneId === sceneId && point(p.x, p.y)) return;
  for (const f of Object.values(state.floorLinks ?? {})) if (f && f.sceneId === sceneId && rect(f.rect)) return;
}

/**
 * The first occupied cell, as a key, that a wing's footprint meets within
 * its margin, or null when the wing stands clear (3.6, H3, I1, J1). Floor
 * cells keep the whole margin from everything. The join's approach keeps it
 * from all but the joined room's own structure (its floor, marks and
 * boundary walls, both cells of each). The hexes beside the wing's walls
 * keep the margin less one, past the floor beside them that kept the whole,
 * with the same excuse, since the walls next to the join stand against the
 * joined room's own. A join no longer standing clashes at its first edge
 * or wall.
 *
 * `ops` are this ask's, and `prior` what the chain's earlier parts wrote
 * (D-261110-241), so a part checks every part so far against the room as
 * it stands when that part is read.
 */
export function wingClash(state: ClashState, sceneId: string, ops: readonly MapOp[], clear: WingClear, prior?: WingFootprint): string | null {
  const scene = state.scenes[sceneId];
  if (!scene) return sceneId;
  const board = boardOf(state, scene);
  const join = readJoin(board, scene, clear);
  if (!join) return clear.join.grid === "squares" ? clear.join.edges[0]!.key : clear.join.walls[0]!.id;
  const footprint = wingFootprint(state, sceneId, ops, clear, prior ? { floor: new Set(prior.floor), walls: new Set(prior.walls) } : undefined);
  const ground = clear.join.grid === "hex" ? clear.join.ground : clear.join.edges[0]!.ground;
  const approach = approachOf(board, join, ground, clear.margin);
  const strict = new Set<number>();
  const lenient = new Set<number>();
  grow(board, [...footprint.floor].filter((k) => !approach.has(k)), clear.margin, strict);
  grow(board, [...footprint.floor].filter((k) => approach.has(k)), clear.margin, lenient);
  grow(board, footprint.walls, clear.margin - 1, lenient);
  let excused: Set<number> | null = null;
  const excuses = (k: number) => {
    if (!excused) {
      // The joined room's own structure: its cells and the cells just past its boundary (3.4).
      const room = joinedRoom(board, scene, join, clear);
      excused = new Set(room);
      for (const r of room) for (const n of board.neighbors(r)) excused.add(n);
    }
    return excused.has(k);
  };
  let found = -1;
  eachOccupied(state, board, (k, structure) => {
    if (k < 0) return false;
    if (strict.has(k) || (lenient.has(k) && !(structure && excuses(k)))) {
      found = k;
      return true;
    }
    return false;
  });
  return found < 0 ? null : keyText(found);
}
