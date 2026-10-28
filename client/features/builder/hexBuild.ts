import { stairMarkAt } from "#shared/heightCodec.ts";
import { groundAt } from "#shared/rules/heights.ts";
import { decodeRough } from "#shared/heightCodec.ts";
import { cellOf, chunkKey, wallMidpoint } from "#shared/keys.ts";
import { CHUNK_CELLS, FREE_WALL_ID_LENGTH, FREE_WALL_LATTICE, MAX_FREE_WALL_CELLS, type RoomState, type WallFeature } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { MAX_BUILD_CELLS, type ClientOp, type FreeWallInput } from "#shared/protocol.ts";
import { inScene } from "#shared/rules/grid.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, hexKey, hexNeighbors, parseHexKey, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { labelBox } from "#shared/rules/labels.ts";
import { chunk, type Bounds, type Point } from "./cells.ts";
import type { EdgeKind } from "./store.ts";

/*
 * The builder on a hex scene (docs/design-v1-hex-grids.md HX-D7, HX-D9):
 * Wall lines drawn point to point as free walls, and Erase and Difficult
 * ground by hex keys. Squares keep cells.ts.
 */

/** A brush of `size` takes the hexes within `size - 1` steps of the one under the pointer: 1, 7, 19 and on. */
export function hexBrush(g: HexGrid, p: Point, size: number, bounds: Bounds): string[] {
  const center = hexAt(g, p);
  const out: string[] = [];
  const seen = new Set<string>([hexKey(center)]);
  let ring: Hex[] = [center];
  for (let step = 0; step < size; step++) {
    for (const h of ring) if (hexInScene(g, bounds, h)) out.push(hexKey(h));
    if (step === size - 1) break;
    const next: Hex[] = [];
    for (const h of ring) {
      for (const n of hexNeighbors(g, h)) {
        const key = hexKey(n);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(n);
      }
    }
    ring = next;
  }
  return out;
}

/** How far apart a stroke's brush stops are, in cells, so a fast drag leaves no gap between hexes. */
const STROKE_STEP = 0.25;

/** The hexes a brush stroke from `from` to `to` adds that `into` does not hold yet, added to it. A stroke's first press has no `from`. */
export function hexStroke(g: HexGrid, from: Point | null, to: Point, size: number, bounds: Bounds, into: Set<string>): string[] {
  const added: string[] = [];
  const visit = (p: Point) => {
    for (const key of hexBrush(g, p, size, bounds)) {
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
  for (let i = 1; i <= steps; i++) visit({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
  return added;
}

/** The scene's hexes whose centers lie in the box between two points, its edges included, in key order. */
export function hexesInRect(g: HexGrid, a: Point, b: Point, bounds: Bounds): string[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const out: string[] = [];
  // Every hex whose center can lie in the box is within one step of a hex holding a point of it, so the search walks the hexes of a grid of points over it.
  const seen = new Set<string>();
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y += 0.5) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x += 0.5) {
      const h = hexAt(g, { x, y });
      for (const n of [h, ...hexNeighbors(g, h)]) {
        const key = hexKey(n);
        if (seen.has(key)) continue;
        seen.add(key);
        const c = hexCenter(g, n);
        if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1 && hexInScene(g, bounds, n)) out.push(key);
      }
    }
  }
  return out.sort(byKey);
}

function byKey(a: string, b: string): number {
  const p = parseHexKey(a)!;
  const q = parseHexKey(b)!;
  return p.row - q.row || p.col - q.col;
}

/** A hex's outline as its six corners, for drawing. */
export function hexOutline(g: HexGrid, key: string): Point[] {
  const h = parseHexKey(key);
  return h ? hexCorners(g, h).map((c) => cornerAt(g, c)) : [];
}

/** A point on the free walls' 1/64 lattice, kept inside the scene, its border included, as the reducer holds a wall's ends. */
export function onLattice(p: Point, bounds: Bounds): Point {
  const round = (v: number, most: number) => Math.min(most, Math.max(0, Math.round(v * FREE_WALL_LATTICE) / FREE_WALL_LATTICE));
  return { x: round(p.x, bounds.w), y: round(p.y, bounds.h) };
}

/**
 * Where a Wall line's point lands (HX-D7): the nearest hex corner while
 * Snap to hex corners is on, else the 1/64 lattice, for tracing walls that
 * do not follow the hexes on the art. The nearest corner of the honeycomb
 * is always one of the six of the hex that holds the point. Corners lie on
 * the 1/64 lattice already (hex.ts cornerAt), so a wall ending on one meets
 * a Large creature's anchor exactly.
 */
export function wallPoint(g: HexGrid, p: Point, snap: boolean, bounds: Bounds): Point {
  if (!snap) return onLattice(p, bounds);
  let best: Point | null = null;
  let bestD = Infinity;
  for (const corner of hexCorners(g, hexAt(g, p))) {
    const c = cornerAt(g, corner);
    const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return onLattice(best!, bounds);
}

/**
 * A run from `a` to `b` cut into free walls of at most 8 cells
 * (MAX_FREE_WALL_CELLS), each end on the lattice, in as few even pieces as
 * keep every one within the cap once its cuts are rounded onto the
 * lattice, read exactly as the protocol reads a wall's length. A run of no
 * length gives none.
 */
export function wallPieces(a: Point, b: Point): [Point, Point][] {
  if (a.x === b.x && a.y === b.y) return [];
  const cut = (n: number, i: number): Point =>
    i === 0 ? a : i === n ? b : { x: Math.round((a.x + ((b.x - a.x) * i) / n) * FREE_WALL_LATTICE) / FREE_WALL_LATTICE, y: Math.round((a.y + ((b.y - a.y) * i) / n) * FREE_WALL_LATTICE) / FREE_WALL_LATTICE };
  const fits = (p: Point, q: Point) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= MAX_FREE_WALL_CELLS ** 2;
  for (let n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / MAX_FREE_WALL_CELLS)); ; n++) {
    const pieces: [Point, Point][] = [];
    for (let i = 0; i < n; i++) pieces.push([cut(n, i), cut(n, i + 1)]);
    if (pieces.every(([p, q]) => fits(p, q))) return pieces.filter(([p, q]) => p.x !== q.x || p.y !== q.y);
  }
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A free wall's id: random characters that say nothing about the wall, as an import's are (uvtt/convert.ts randomWallId). */
export function newWallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(FREE_WALL_ID_LENGTH));
  let id = "";
  for (const b of bytes) id += ID_CHARS[b & 63];
  return id;
}

/**
 * What a Wall line puts down, by the Walls and doors choice: a wall, a
 * closed door, a secret door hidden or found, or a window. No wall has no
 * grid edges to work on here, so a line drawn under it is a wall, as its
 * chip shows. Remove draws nothing.
 */
export function lineFeature(kind: EdgeKind, secretFound: boolean): WallFeature | null {
  if (kind === "clear") return null;
  if (kind === "wall" || kind === "none") return { kind: "wall" };
  if (kind === "window") return { kind: "window" };
  return { kind: "door", state: "closed", secret: kind === "secret", discovered: kind === "secret" ? secretFound : false };
}

/**
 * The ops that put a Wall line down: a free wall for each run between two
 * of its points, each cut at 8 cells, batched by the protocol's count and
 * byte bound so a long line still goes as one gesture.
 */
export function wallLineOps(sceneId: string, points: readonly Point[], feature: WallFeature, newId: () => string = newWallId): ClientOp[] {
  const walls: FreeWallInput[] = [];
  for (let i = 1; i < points.length; i++) {
    for (const [a, b] of wallPieces(points[i - 1]!, points[i]!)) walls.push({ id: newId(), a: [a.x, a.y], b: [b.x, b.y], f: feature });
  }
  // A wall is under 100 bytes in an op, so this count stays well inside the byte bound too.
  const per = Math.min(LIMITS.freeWallsPerOp, Math.floor(LIMITS.freeWallsOpBytes / 128));
  return chunk(walls, per).map((put) => ({ t: "build.walls", sceneId, put }));
}

/** Whether a hex carries a difficult ground mark in these chunks, by its key's chunk of 16 by 16 hexes. */
export function hexRoughAt(chunks: RoomState["buildChunks"], sceneId: string, key: string): boolean {
  const h = parseHexKey(key);
  if (!h) return false;
  const cx = Math.floor(h.col / CHUNK_CELLS);
  const cy = Math.floor(h.row / CHUNK_CELLS);
  const c = chunks[chunkKey(sceneId, cx, cy)];
  return c?.rough !== undefined && decodeRough(c.rough)[(h.row - cy * CHUNK_CELLS) * CHUNK_CELLS + (h.col - cx * CHUNK_CELLS)] === true;
}

/** Marks hexes as difficult ground or clears them, leaving out those already so, so a stroke back over its own marks sends nothing. */
export function hexRoughOps(view: RoomState | null, sceneId: string, keys: readonly string[], on: boolean): ClientOp[] {
  const chunks = view?.buildChunks ?? {};
  const changed = keys.filter((key) => hexRoughAt(chunks, sceneId, key) !== on);
  return chunk(changed, MAX_BUILD_CELLS).map((cells) => ({ t: "build.rough", sceneId, cells, on }));
}

/**
 * Whether erasing a hex would take anything, as the reducer reads it
 * (shared/reducer/map.ts eraseHexes): its height, stair mark or difficult ground, a free wall
 * whose midpoint, or a stamp or light whose center, lies in it, or a label
 * whose box meets its box. The label test is the hex's box, a little
 * generous at its corners: an erase sent for nothing changes nothing.
 */
export function hexErasable(view: RoomState | null, g: HexGrid, sceneId: string): (key: string) => boolean {
  const held = new Set<string>();
  const holdAt = (x: number, y: number) => held.add(hexKey(hexAt(g, { x, y })));
  for (const c of Object.values(view?.buildChunks ?? {})) {
    if (c?.sceneId !== sceneId) continue;
    for (const wall of c.walls ?? []) holdAt(...wallMidpoint(wall));
  }
  for (const stamp of Object.values(view?.stamps ?? {})) if (stamp?.sceneId === sceneId) holdAt(stamp.x, stamp.y);
  for (const light of Object.values(view?.lights ?? {})) if (light?.sceneId === sceneId) holdAt(light.x, light.y);
  const boxes = Object.values(view?.labels ?? {}).flatMap((label) => (label && label.sceneId === sceneId ? [labelBox(label)] : []));
  const chunks = view?.buildChunks ?? {};
  return (key) => {
    if (held.has(key) || hexRoughAt(chunks, sceneId, key)) return true;
    const h = parseHexKey(key);
    // From H3 a hex's height and stair mark go with it too (reducer/map.ts withoutHeights).
    if (h && (groundAt(chunks, sceneId, h.col, h.row) !== 0 || stairMarkAt(chunks, sceneId, h.col, h.row) !== ".")) return true;
    if (!h || boxes.length === 0) return false;
    const c = hexCenter(g, h);
    return boxes.some((box) => box.x0 < c.x + 0.6 && box.x1 > c.x - 0.6 && box.y0 < c.y + 0.6 && box.y1 > c.y - 0.6);
  };
}

/** The erase ops for hexes, leaving out those with nothing to take. */
export function hexEraseOps(view: RoomState | null, g: HexGrid, sceneId: string, keys: readonly string[]): ClientOp[] {
  const erasable = hexErasable(view, g, sceneId);
  return chunk(keys.filter(erasable), MAX_BUILD_CELLS).map((cells) => ({ t: "build.erase", sceneId, cells }));
}

/** The square cells under hexes' centers, so the builder's in-sight note (inSight.ts) reads a hex gesture by the fog's own cells. */
export function hexSightCells(g: HexGrid, keys: readonly string[], bounds: Bounds): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const h = parseHexKey(key);
    if (!h || !inScene(g, bounds, key)) continue;
    const c = hexCenter(g, h);
    out.push(cellOf(c.x, c.y));
  }
  return out;
}
