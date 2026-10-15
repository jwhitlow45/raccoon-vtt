import type { BuildChunk, EdgeFeature, FreeWall, TerrainId } from "#shared/model.ts";
import { MAX_BUILD_CELLS, MAX_BUILD_EDGES, MAX_POLY_VERTICES, type ClientOp, type FreeWallInput } from "#shared/protocol.ts";
import { pointInPolygonFixed } from "#shared/rules/fog.ts";

/**
 * Turning the builder's gestures into build ops (design section 12). Every
 * op changes at most 2,000 cells and 500 edges, so anything larger is split
 * here into several ops the server accepts one by one.
 *
 * Cells are keyed `"x,y"` and edges `"x,y,n"` or `"x,y,w"` (the north or
 * west edge of cell x, y), the same keys the build chunks use.
 */

export type Point = { x: number; y: number };
export type Bounds = { w: number; h: number };
export type BrushSize = 1 | 2 | 3;

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseCellKey(key: string): Point {
  const [xs, ys] = key.split(",");
  return { x: Number(xs), y: Number(ys) };
}

function inBounds(x: number, y: number, bounds: Bounds): boolean {
  return x >= 0 && y >= 0 && x < bounds.w && y < bounds.h;
}

/**
 * The cells under a square brush of `size` cells centered on a point. An
 * odd brush centers on the cell under the finger, an even one on the
 * nearest grid intersection, so the brush always sits where it is drawn.
 */
export function brushCells(p: Point, size: BrushSize, bounds: Bounds): string[] {
  const x0 = Math.floor(p.x - (size - 1) / 2);
  const y0 = Math.floor(p.y - (size - 1) / 2);
  const out: string[] = [];
  for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) if (inBounds(x, y, bounds)) out.push(cellKey(x, y));
  return out;
}

/** How far apart, in cells, a stroke is sampled. A quarter cell never skips a cell, even with the smallest brush. */
const STROKE_STEP = 0.25;

/**
 * The cells a brush covers moving from one pointer sample to the next. A
 * fast finger can jump several cells between samples, so the segment is
 * walked in small steps. `into` collects them in first-touched order, and
 * only cells new to it are returned.
 */
export function strokeCells(from: Point | null, to: Point, size: BrushSize, bounds: Bounds, into: Set<string>): string[] {
  const added: string[] = [];
  const visit = (p: Point) => {
    for (const key of brushCells(p, size, bounds)) {
      if (into.has(key)) continue;
      into.add(key);
      added.push(key);
    }
  };
  if (!from) {
    visit(to);
    return added;
  }
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / STROKE_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    visit({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return added;
}

/**
 * How long a touch stroke holds its cells before sending any. A pinch whose
 * second finger lands late starts as a one-finger stroke, and a cell sent by
 * then would stay on the map. Until this passes the stroke is only a
 * preview, which a second finger drops whole. A mouse or pen has no second
 * finger, so it sends at once.
 */
export const SECOND_FINGER_MS = 300;

export function strokeMaySend(touch: boolean, startedAt: number, now: number): boolean {
  return !touch || now - startedAt >= SECOND_FINGER_MS;
}

export function chunk<T>(items: readonly T[], max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += max) out.push(items.slice(i, i + max));
  return out;
}

/**
 * Paint (a terrain) or erase (null) the given cells, skipping cells that
 * already look that way, in ops of at most 2,000 cells. An erase also takes
 * the walls, doors and labels in a cell, so a cell with no floor still goes
 * when `occupied` says something else is there.
 */
export function paintOps(
  sceneId: string,
  cells: readonly string[],
  terrain: TerrainId | null,
  current: (key: string) => TerrainId | undefined,
  occupied: (key: string) => boolean = () => false,
): ClientOp[] {
  const changed = cells.filter((key) => (terrain === null ? current(key) !== undefined || occupied(key) : current(key) !== terrain));
  return chunk(changed, MAX_BUILD_CELLS).map((part) =>
    terrain === null ? { t: "build.erase", sceneId, cells: part } : { t: "build.paint", sceneId, terrain, cells: part },
  );
}

export type CellRect = { x: number; y: number; w: number; h: number };

/** The rectangle between two cells, both included. */
export function rectBetween(a: Point, b: Point): CellRect {
  const ax = Math.floor(a.x);
  const ay = Math.floor(a.y);
  const bx = Math.floor(b.x);
  const by = Math.floor(b.y);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax) + 1, h: Math.abs(by - ay) + 1 };
}

/** The part of a rectangle inside the scene, or null when none of it is. */
export function clipRect(rect: CellRect, bounds: Bounds): CellRect | null {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(bounds.w, rect.x + rect.w);
  const y1 = Math.min(bounds.h, rect.y + rect.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A rectangle room, clipped to the scene and split into bands of at most 2,000 cells. */
export function rectOps(sceneId: string, rect: CellRect, terrain: TerrainId | null, bounds: Bounds): ClientOp[] {
  const r = clipRect(rect, bounds);
  if (!r) return [];
  const band = Math.max(1, Math.floor(MAX_BUILD_CELLS / r.w));
  const ops: ClientOp[] = [];
  for (let y = r.y; y < r.y + r.h; y += band) {
    ops.push({ t: "build.rect", sceneId, terrain, x: r.x, y, w: r.w, h: Math.min(band, r.y + r.h - y) });
  }
  return ops;
}

/**
 * The cells whose centers lie inside a polygon (flat `[x0, y0, x1, y1, ...]`
 * in cells), clipped to the scene. Fixed point in eighths of a cell, the
 * same as the reducer's `build.poly` and the fog, so the preview, the
 * fallback ops and the server always pick the same cells.
 */
export function polygonCells(points: readonly number[], bounds: Bounds): string[] {
  const pts = points.map((v) => Math.round(v * 8));
  const n = Math.floor(pts.length / 2);
  if (n < 3) return [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[2 * i]!);
    maxX = Math.max(maxX, pts[2 * i]!);
    minY = Math.min(minY, pts[2 * i + 1]!);
    maxY = Math.max(maxY, pts[2 * i + 1]!);
  }
  const x0 = Math.max(0, Math.floor(minX / 8));
  const y0 = Math.max(0, Math.floor(minY / 8));
  const x1 = Math.min(bounds.w, Math.ceil(maxX / 8));
  const y1 = Math.min(bounds.h, Math.ceil(maxY / 8));
  const out: string[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (pointInPolygonFixed(pts, n, x * 8 + 4, y * 8 + 4)) out.push(cellKey(x, y));
  }
  return out;
}

/**
 * A polygon room. One `build.poly` when the server can take it whole, which
 * keeps the op small. Past 2,000 cells the reducer refuses a polygon, so the
 * cells go as several paint (or erase) ops instead.
 */
export function polyOps(sceneId: string, points: readonly number[], terrain: TerrainId | null, bounds: Bounds): ClientOp[] {
  const cells = polygonCells(points, bounds);
  if (cells.length === 0) return [];
  if (cells.length <= MAX_BUILD_CELLS && points.length <= MAX_POLY_VERTICES * 2) {
    return [{ t: "build.poly", sceneId, terrain, points: [...points] }];
  }
  return chunk(cells, MAX_BUILD_CELLS).map((part) =>
    terrain === null ? { t: "build.erase", sceneId, cells: part } : { t: "build.paint", sceneId, terrain, cells: part },
  );
}

/** The nearest grid intersection, where polygon corners go so walls come out straight. */
export function snapToCorner(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * Whether an edge may carry a feature: it must lie on the scene, its
 * borders included (docs/design-v1-maps-vision.md section 3.1 step 5). A
 * west edge `x,y,w` runs down the line at x, so x may be the scene's width,
 * and a north edge `x,y,n` runs along the line at y, so y may be its height.
 * That is how the east and south borders hold a wall, as the reducer checks.
 */
export function edgeInBounds(key: string, bounds: Bounds): boolean {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return false;
  if (side === "w") return x <= bounds.w && y < bounds.h;
  if (side === "n") return x < bounds.w && y <= bounds.h;
  return false;
}

/** The cell edge nearest a point, or null when that edge lies off the scene. */
export function nearestEdge(p: Point, bounds: Bounds): string | null {
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const fx = p.x - cx;
  const fy = p.y - cy;
  const options: [number, string][] = [
    [fy, `${cx},${cy},n`],
    [1 - fy, `${cx},${cy + 1},n`],
    [fx, `${cx},${cy},w`],
    [1 - fx, `${cx + 1},${cy},w`],
  ];
  options.sort((a, b) => a[0] - b[0]);
  const key = options[0]![1];
  return edgeInBounds(key, bounds) ? key : null;
}

/**
 * A straight run of edges for a wall dragged from one point to another. It
 * follows the grid line nearest where the drag started, along whichever
 * axis the drag moved further, so a wobbly finger still draws a straight
 * wall.
 */
export function edgeRun(from: Point, to: Point, bounds: Bounds): string[] {
  const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
  const out: string[] = [];
  if (horizontal) {
    const y = Math.round(from.y);
    const a = Math.round(from.x);
    const b = Math.round(to.x);
    for (let x = Math.min(a, b); x < Math.max(a, b); x++) out.push(`${x},${y},n`);
  } else {
    const x = Math.round(from.x);
    const a = Math.round(from.y);
    const b = Math.round(to.y);
    for (let y = Math.min(a, b); y < Math.max(a, b); y++) out.push(`${x},${y},w`);
  }
  return out.filter((key) => edgeInBounds(key, bounds));
}

/** Edge changes in ops of at most 500 edges. */
export function edgeOps(sceneId: string, edges: readonly { key: string; feature: EdgeFeature | null }[]): ClientOp[] {
  return chunk(edges, MAX_BUILD_EDGES).map((part) => ({ t: "build.edge", sceneId, edges: part }));
}

type Door = Extract<EdgeFeature, { kind: "door" }>;

/**
 * The states a tap on a door steps through, in order, ending where it
 * began. Secret doors are not in the cycle: a door in play gets opened and
 * closed often, and a tap too many must never show players a hidden door
 * or take a door away. Hiding, finding and removing each have their own
 * choice in the bar.
 */
export const DOOR_STATES: readonly Door["state"][] = ["closed", "open", "locked"];

const CLOSED_DOOR: Door = { kind: "door", state: "closed", secret: false, discovered: false };

export function isHiddenDoor(feature: EdgeFeature | undefined): boolean {
  return feature?.kind === "door" && feature.secret && !feature.discovered;
}

/**
 * The door a tap leaves on an edge: a closed door where there was none, or
 * the next state of the door there. A found secret door stays secret and
 * found. Callers leave hidden secret doors alone.
 */
export function nextDoor(current: EdgeFeature | undefined): Door {
  if (current?.kind !== "door") return CLOSED_DOOR;
  const i = DOOR_STATES.indexOf(current.state);
  return { ...current, state: DOOR_STATES[(i + 1) % DOOR_STATES.length]! };
}

/**
 * The secret door a tap leaves on an edge, `found` or hidden as the bar
 * says, or null to take off a secret door that already is. A hidden door
 * is always closed, since players see a wall there.
 */
export function secretDoor(current: EdgeFeature | undefined, found: boolean): Door | null {
  if (current?.kind === "door" && current.secret && current.discovered === found) return null;
  const state = found && current?.kind === "door" ? current.state : "closed";
  return { kind: "door", state, secret: true, discovered: found };
}

/** What a dragged run leaves on an edge, or undefined to leave the edge alone because it already has it. */
export function runFeature(
  kind: "wall" | "door" | "secret" | "window" | "none" | "clear",
  current: EdgeFeature | undefined,
  found: boolean,
): EdgeFeature | null | undefined {
  switch (kind) {
    case "clear":
      return current === undefined ? undefined : null;
    case "door":
      return current?.kind === "door" ? undefined : CLOSED_DOOR;
    case "secret":
      return current?.kind === "door" && current.secret && current.discovered === found ? undefined : secretDoor(current, found);
    default:
      return current?.kind === kind ? undefined : { kind };
  }
}

export function doorLabel(door: Door): string {
  if (door.secret) return door.discovered ? "Secret door, found" : "Secret door";
  return door.state === "open" ? "Open door" : door.state === "locked" ? "Locked door" : "Closed door";
}

/*
 * Free walls (docs/design-v1-maps-vision.md section 2.2) are walls, doors
 * and windows off the grid lines, which a Universal VTT import brings. The
 * DM does not draw them by hand: the builder taps a free door through its
 * states, Remove takes a free wall off, and the eraser takes the ones whose
 * midpoint is in an erased cell.
 */

/** A free wall under a tap, with the chunk that holds it, which ops name it by. */
export type FreeWallHit = { wall: FreeWall; cx: number; cy: number };

type Ends = { a: readonly [number, number]; b: readonly [number, number] };

/** The squared distance from a point to a segment. */
function segmentDistance2(p: Point, s: Ends): number {
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.a[0]) * dx + (p.y - s.a[1]) * dy) / len2)) : 0;
  const ex = s.a[0] + dx * t - p.x;
  const ey = s.a[1] + dy * t - p.y;
  return ex * ex + ey * ey;
}

/** The ends of an edge key, in cells. */
export function edgeEnds(key: string): Ends {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  return { a: [x, y], b: side === "n" ? [x + 1, y] : [x, y + 1] };
}

/** How far a point is from an edge, in cells. */
export function edgeDistance(key: string, p: Point): number {
  return Math.sqrt(segmentDistance2(p, edgeEnds(key)));
}

/**
 * The free wall nearest a point, within `reach` cells, among those `accept`
 * takes, or null. Its distance comes with it, so a tap can weigh it against
 * the nearest grid edge.
 */
export function nearestFreeWall(
  chunks: Iterable<BuildChunk>,
  p: Point,
  reach: number,
  accept: (wall: FreeWall) => boolean = () => true,
): (FreeWallHit & { distance: number }) | null {
  let best: FreeWallHit | null = null;
  let bestD2 = reach * reach;
  for (const chunk of chunks) {
    for (const wall of chunk.walls ?? []) {
      if (!accept(wall)) continue;
      const d2 = segmentDistance2(p, wall);
      if (d2 > bestD2 || (best && d2 === bestD2)) continue;
      best = { wall, cx: chunk.cx, cy: chunk.cy };
      bestD2 = d2;
    }
  }
  return best ? { ...best, distance: Math.sqrt(bestD2) } : null;
}

/** A free wall as an op carries it: exactly the fields the protocol takes. */
function freeWallInput(wall: FreeWall): FreeWallInput {
  return { id: wall.id, a: [wall.a[0], wall.a[1]], b: [wall.b[0], wall.b[1]], f: wall.f };
}

/**
 * What a Door tap leaves on a free door: the next state, as nextDoor steps
 * an edge's door, under the same id so the put replaces it in its chunk.
 */
export function nextFreeDoor(wall: FreeWall): FreeWall {
  return { ...wall, f: nextDoor(wall.f) };
}

export function freeWallPutOp(sceneId: string, wall: FreeWall): ClientOp {
  return { t: "build.walls", sceneId, put: [freeWallInput(wall)] };
}

export function freeWallRemoveOp(sceneId: string, hit: FreeWallHit): ClientOp {
  return { t: "build.walls", sceneId, remove: [{ cx: hit.cx, cy: hit.cy, id: hit.wall.id }] };
}
