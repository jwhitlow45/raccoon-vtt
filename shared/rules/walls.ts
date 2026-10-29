import { LIMITS, type LimitCheck } from "../limits.ts";
import { AUTO_CHARS, CHUNK_CELLS, KNOWN_CHARS, MAX_FREE_WALL_CELLS, UP_DIR_CHARS, type AutoWalls, type BuildChunk, type EdgeFeature, type FreeWall, type PlayerChunk, type RoomState, type Scene, type SceneId, type StairMark, type TerrainId, type WallFeature } from "../model.ts";
import { autoWallBetween, autoWallsOf, paintedOf, type Painted } from "./autoWalls.ts";
import type { Bounds, Point } from "./geom.ts";
import type { DoorRef } from "../protocol.ts";
import { chunkHeights, chunkMarks, COMPASS, facingOf, facingsOf, oppositeFacing, stairDirections, stepper, type Facing } from "./heights.ts";
import { sweptTouches } from "./movement.ts";
import { isWritable } from "../writable.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, hexKey, hexNeighbors, type Hex, type HexGrid } from "./hex.ts";
import { gridOfShape, isHex, SQUARES, type Grid } from "./grid.ts";
import {
  APART,
  AREAS,
  boundsOf,
  contact,
  countSplit,
  LATTICE,
  MAX_COORD,
  MOVEMENT,
  piecesWith,
  PIECE,
  SegmentIndex,
  SIGHT,
  SIGHT_POTENTIAL,
  splitSegments,
  type Candidates,
  type Pieces,
  type Polygon,
  type SplitCount,
} from "./segments.ts";

export { crossingsAt, indexPolygon, insideCrossings, pointInPolygon, type Polygon, type PolygonIndex } from "./segments.ts";
export type { WallFeature } from "../model.ts";

/**
 * Walls from the map builder (design section 12) and from imports, the
 * visibility polygons that clip areas of effect (section 9.3), and the
 * flood fill behind "reveal room" (section 13.2).
 *
 * Coordinates are cells. Edge `x,y,n` runs from (x, y) to (x + 1, y) and edge
 * `x,y,w` from (x, y) to (x, y + 1). Free walls (docs/design-v1-maps-vision.md
 * section 2.2) run between any two points of the 1/64 lattice.
 *
 * One derived set per scene feeds every rule (section 2.1): the stored
 * segments (grid walls merged into runs, doors, windows, free walls, pillar
 * squares and raised edges), split where they cross into pieces that each
 * say what they block. Areas sweep the pieces that block areas. Wave 4's
 * movement test reads the stored segments (movement.ts), and sight sweeps
 * the pieces that block sight for an eye at its height, through
 * shared/rules/segments.ts.
 *
 * Raised edges (section 4.2) are the edges between two cells of the scene
 * whose ground differs. Each carries its top, the higher ground, so sight
 * can keep only those above an eye. One that a directed stair connects
 * stops nobody's movement. The rest are ledges, which stop walking tokens
 * and fliers below their top.
 */

/**
 * What a raised edge blocks, beside segments.ts's tags. RAISED: sight from
 * an eye below its top. LEDGE: movement of a token walking, or flying below
 * its top, when no stair connects it. A raised edge always counts toward the
 * sight cap (SIGHT_POTENTIAL), whatever its height.
 */
export const RAISED = 16;
export const LEDGE = 32;

/** One cell edge that carries a wall, door or window. `auto` marks walls the builder derived. */
export type WallEdge = { x: number; y: number; side: "n" | "w"; feature: WallFeature; auto: boolean };

/** A stored free wall and the chunk that holds it, which is how ops name it. */
export type FreeWallRef = { cx: number; cy: number; wall: FreeWall };

/**
 * Build coordinates are packed into single numbers, which made deriving the
 * walls of a full 200x200 build several times faster than string keys.
 * Scenes are at most 200 cells a side (design section 10.5), so a cell
 * outside 0 to 1023 is bad data and is dropped.
 */
export const MAX_BUILD_COORD = 1023;
// Wider than any coordinate, edges included (an east edge sits at x = 1024).
const ROW = 2048;

export function cellId(x: number, y: number): number {
  return y * ROW + x;
}

export function edgeId(x: number, y: number, side: "n" | "w"): number {
  return (y * ROW + x) * 2 + (side === "w" ? 1 : 0);
}

/**
 * The build of one scene: terrain by `cellId`, edge features by `edgeId`,
 * its free walls, and from wave 4 the ground of every cell painted to a
 * height other than 0 and the mark of every cell with a stair mark.
 */
export type BuildIndex = {
  cells: Map<number, TerrainId>;
  edges: Map<number, EdgeFeature>;
  free: FreeWallRef[];
  ground?: Map<number, number>;
  marks?: Map<number, StairMark>;
  /** A player's held build (docs/design-v1-map-discovery.md 5.2): what its chunks carry beside the build. Absent for a stored one. */
  held?: HeldFacts;
};

/**
 * What a player's chunks carry beside the build on a scene with fog on
 * (docs/design-v1-map-discovery.md 5.2), which their device reads in place
 * of deriving it from cells it may not hold: the cells they hold
 * (`known`), the automatic walls on held edges (`auto`), by edge id, and
 * each held stair's direction (`upDir`), by cell id, 1 + its index in
 * COMPASS, 0 for a stair with none. A build whose chunks carry these holds
 * nothing else: a position with no chunk is all unknown.
 */
export type HeldFacts = { known: Set<number>; auto: Set<number>; dirs: Map<number, number> };

/*
 * Parses "x,y" (or "x,y,n" and "x,y,w" with `withSide`) into an id, or -1
 * for anything malformed or out of range. Written by hand because a full
 * build has 40,000 keys and a regular expression per key was the slowest
 * step of deriving walls.
 */
function parseKey(key: string, withSide: boolean): number {
  const len = key.length;
  let i = 0;
  let x = 0;
  let y = 0;
  let digits = 0;
  for (; i < len; i++) {
    const c = key.charCodeAt(i);
    if (c === 44) break;
    if (c < 48 || c > 57 || ++digits > 4) return -1;
    x = x * 10 + c - 48;
  }
  if (digits === 0 || i === len) return -1;
  digits = 0;
  for (i++; i < len; i++) {
    const c = key.charCodeAt(i);
    if (c === 44) break;
    if (c < 48 || c > 57 || ++digits > 4) return -1;
    y = y * 10 + c - 48;
  }
  if (digits === 0) return -1;
  if (!withSide) return i === len && x <= MAX_BUILD_COORD && y <= MAX_BUILD_COORD ? cellId(x, y) : -1;
  if (i !== len - 2 || x > MAX_BUILD_COORD + 1 || y > MAX_BUILD_COORD + 1) return -1;
  const side = key.charCodeAt(len - 1);
  return side === 110 ? edgeId(x, y, "n") : side === 119 ? edgeId(x, y, "w") : -1;
}

export function sceneChunks(all: Readonly<Record<string, BuildChunk>>, sceneId: SceneId): BuildChunk[] {
  return Object.values(all).filter((c) => c.sceneId === sceneId);
}

/*
 * The split's exact arithmetic assumes what the protocol and the room import
 * enforce: ends on the 1/64 lattice, inside the build's coordinate range,
 * apart, and at most 8 cells apart. A stored wall that is not is bad data
 * and is dropped, as malformed keys are, rather than trusted.
 */
const MAX_FREE_LENGTH_SQUARED = (MAX_FREE_WALL_CELLS * LATTICE) * (MAX_FREE_WALL_CELLS * LATTICE);

/**
 * The piece path (docs/design-v1-map-discovery.md 5.2, ASTRA-10, LK-30): a
 * free wall in a player's held chunk is a piece the server cut, whose cut
 * ends lie on its 1/10000 grid rather than the lattice. Ends finite and
 * inside the build's range, length above zero and at most 8 cells, all
 * checked exactly with no slack, since a piece is at most 5.66 cells long.
 */
function validPiece(w: FreeWall | undefined): w is FreeWall {
  if (!w || !Array.isArray(w.a) || !Array.isArray(w.b) || !w.f) return false;
  const k = w.f.kind;
  if (k !== "wall" && k !== "door" && k !== "window") return false;
  const coords = [w.a[0], w.a[1], w.b[0], w.b[1]];
  for (const v of coords) if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_COORD) return false;
  const dx = coords[2]! - coords[0]!;
  const dy = coords[3]! - coords[1]!;
  const len2 = dx * dx + dy * dy;
  return len2 > 0 && len2 <= MAX_FREE_WALL_CELLS * MAX_FREE_WALL_CELLS;
}

function validFreeWall(w: FreeWall | undefined): w is FreeWall {
  if (!w || !Array.isArray(w.a) || !Array.isArray(w.b) || !w.f) return false;
  const k = w.f.kind;
  if (k !== "wall" && k !== "door" && k !== "window") return false;
  const coords = [w.a[0], w.a[1], w.b[0], w.b[1]];
  for (const v of coords) {
    if (typeof v !== "number" || !Number.isInteger(v * LATTICE) || v < 0 || v > MAX_COORD) return false;
  }
  const dx = (coords[2]! - coords[0]!) * LATTICE;
  const dy = (coords[3]! - coords[1]!) * LATTICE;
  const len2 = dx * dx + dy * dy;
  return len2 > 0 && len2 <= MAX_FREE_LENGTH_SQUARED;
}

/*
 * Terrain as a byte, so a build's cells fit typed arrays. Codes are handed
 * out as terrains first appear and mean nothing outside this module. A
 * stored terrain the model does not know is bad data: past 254 distinct
 * names, the rest share code 255, which paints as an overlay like any
 * unknown terrain (autoWalls.ts `paintedOf`).
 */
const terrainCodes = new Map<TerrainId, number>();
const classOfCode = new Uint8Array(256).fill(2);
classOfCode[0] = 0;
const UNKNOWN_TERRAIN = 255;

function terrainCode(terrain: TerrainId): number {
  let code = terrainCodes.get(terrain);
  if (code === undefined) {
    if (terrainCodes.size >= 254) return UNKNOWN_TERRAIN;
    code = terrainCodes.size + 1;
    terrainCodes.set(terrain, code);
    classOfCode[code] = paintedClass(terrain);
  }
  return code;
}

/** Cells as parallel arrays: `cellId`s and their terrain codes. */
type CellArrays = { ids: Int32Array; codes: Uint8Array };

/** Cells as parallel arrays of `cellId`s and a value: their ground in feet, or their stair mark's character code. */
type CellValues = { ids: Int32Array; values: Int16Array };

const NO_VALUES: CellValues = { ids: new Int32Array(0), values: new Int16Array(0) };

/**
 * One chunk's build, parsed once for the life of the chunk object: entities
 * are replaced, never changed, so after a build op only the chunks it wrote
 * are parsed again. Parsing a full 200x200 build's keys was most of the
 * cost of deriving its walls.
 */
type ParsedChunk = { cells: CellArrays; terrains: TerrainId[]; edges: [number, EdgeFeature][]; free: FreeWallRef[]; ground: CellValues; marks: CellValues; box: Box | null; held: ParsedHeld | null };

/** A held chunk's own facts (HeldFacts): its known cells' ids, its automatic walls' edge ids, its stairs' directions. */
type ParsedHeld = { known: number[]; auto: number[]; dirs: [number, number][] };

/** The cells a build's parts reach, inclusive, an edge counting as the cell it belongs to. */
type Box = { x0: number; y0: number; x1: number; y1: number };

function grow(box: Box | null, id: number): Box {
  const x = id % ROW;
  const y = (id - x) / ROW;
  if (!box) return { x0: x, y0: y, x1: x, y1: y };
  if (x < box.x0) box.x0 = x;
  if (x > box.x1) box.x1 = x;
  if (y < box.y0) box.y0 = y;
  if (y > box.y1) box.y1 = y;
  return box;
}

function union(a: Box | null, b: Box | null): Box | null {
  if (!a || !b) return a ?? (b && { ...b });
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** The box of a build's parts: every cell, edge, height and stair mark. */
function extent(cells: readonly CellArrays[], edges: readonly (readonly (readonly [number, EdgeFeature])[])[], ground: readonly CellValues[], marks: readonly CellValues[], auto: Iterable<number> = []): Box | null {
  let box: Box | null = null;
  for (const { ids } of cells) for (let i = 0; i < ids.length; i++) box = grow(box, ids[i]!);
  for (const part of edges) for (const [id] of part) box = grow(box, (id - (id & 1)) / 2);
  for (const id of auto) box = grow(box, (id - (id & 1)) / 2);
  for (const { ids } of ground) for (let i = 0; i < ids.length; i++) box = grow(box, ids[i]!);
  for (const { ids } of marks) for (let i = 0; i < ids.length; i++) box = grow(box, ids[i]!);
  return box;
}
const parsedChunks = new WeakMap<BuildChunk, ParsedChunk>();

const DOT = 46; // "."

/*
 * A chunk's cells whose value is not `empty` (ground 0, or the mark "."),
 * with their `cellId`s. A chunk at a position the build's range cannot hold
 * is bad data and has none.
 */
function reliefOf(chunk: BuildChunk, values: ArrayLike<number> | null, empty: number): CellValues {
  if (values === null) return NO_VALUES;
  const x0 = chunk.cx * CHUNK_CELLS;
  const y0 = chunk.cy * CHUNK_CELLS;
  if (!Number.isInteger(x0) || !Number.isInteger(y0) || x0 < 0 || y0 < 0 || x0 + CHUNK_CELLS - 1 > MAX_BUILD_COORD || y0 + CHUNK_CELLS - 1 > MAX_BUILD_COORD) return NO_VALUES;
  const ids: number[] = [];
  const out: number[] = [];
  for (let k = 0; k < CHUNK_CELLS * CHUNK_CELLS; k++) {
    const v = values[k]!;
    if (v === empty) continue;
    ids.push(cellId(x0 + (k % CHUNK_CELLS), y0 + (k - (k % CHUNK_CELLS)) / CHUNK_CELLS));
    out.push(v);
  }
  return ids.length === 0 ? NO_VALUES : { ids: Int32Array.from(ids), values: Int16Array.from(out) };
}

function markCodes(marks: string | null): Uint8Array | null {
  if (marks === null) return null;
  const out = new Uint8Array(marks.length);
  for (let k = 0; k < marks.length; k++) out[k] = marks.charCodeAt(k);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of exactly `bytes` bytes, as fog tiles are written (rules/fog.ts encodeTile), or null for anything else. */
function decodeBits(text: unknown, chars: number, bytes: number): Uint8Array | null {
  if (typeof text !== "string" || text.length !== chars) return null;
  const out = new Uint8Array(bytes);
  let o = 0;
  for (let i = 0; i < chars; i += 4) {
    let group = 0;
    let pad = 0;
    for (let j = 0; j < 4; j++) {
      const c = text[i + j]!;
      if (c === "=") {
        pad++;
        group *= 64;
        continue;
      }
      const v = B64.indexOf(c);
      if (v < 0 || pad > 0) return null;
      group = group * 64 + v;
    }
    for (let b = 2; b >= pad; b--) {
      if (o >= bytes) return null;
      out[o++] = Math.floor(group / 256 ** b) % 256;
    }
  }
  return o === bytes ? out : null;
}

const UP_DIRS = /^[nesw0-5.]*$/;

/**
 * A player's chunk's own facts (HeldFacts), or null for a stored chunk,
 * which carries none. A malformed field fails closed: `known` as nothing
 * held, `auto` and `upDir` as none.
 */
function heldOf(chunk: BuildChunk): ParsedHeld | null {
  const p = chunk as PlayerChunk;
  if (p.known === undefined) return null;
  const x0 = chunk.cx * CHUNK_CELLS;
  const y0 = chunk.cy * CHUNK_CELLS;
  if (!Number.isInteger(x0) || !Number.isInteger(y0) || x0 < 0 || y0 < 0 || x0 + CHUNK_CELLS - 1 > MAX_BUILD_COORD || y0 + CHUNK_CELLS - 1 > MAX_BUILD_COORD) return { known: [], auto: [], dirs: [] };
  const cell = (k: number) => cellId(x0 + (k % CHUNK_CELLS), y0 + (k - (k % CHUNK_CELLS)) / CHUNK_CELLS);
  const known: number[] = [];
  const bits = decodeBits(p.known, KNOWN_CHARS, (CHUNK_CELLS * CHUNK_CELLS) / 8);
  if (bits) for (let k = 0; k < CHUNK_CELLS * CHUNK_CELLS; k++) if ((bits[k >> 3]! >> (k & 7)) & 1) known.push(cell(k));
  const auto: number[] = [];
  const edges = p.auto === undefined ? null : decodeBits(p.auto, AUTO_CHARS, (2 * CHUNK_CELLS * CHUNK_CELLS) / 8);
  if (edges) {
    for (let bit = 0; bit < 2 * CHUNK_CELLS * CHUNK_CELLS; bit++) {
      if (!((edges[bit >> 3]! >> (bit & 7)) & 1)) continue;
      const k = bit >> 1;
      auto.push(edgeId(x0 + (k % CHUNK_CELLS), y0 + (k - (k % CHUNK_CELLS)) / CHUNK_CELLS, (bit & 1) === 1 ? "w" : "n"));
    }
  }
  const dirs: [number, number][] = [];
  if (typeof p.upDir === "string" && p.upDir.length === UP_DIR_CHARS && UP_DIRS.test(p.upDir)) {
    for (let k = 0; k < UP_DIR_CHARS; k++) {
      const c = p.upDir[k]!;
      // A compass letter on squares, a side from 0 to 5 on hexes: the set reads each code by its own grid (`stairAt`).
      if (c !== ".") dirs.push([cell(k), 1 + (c >= "0" && c <= "5" ? c.charCodeAt(0) - 48 : COMPASS.indexOf(c as (typeof COMPASS)[number]))]);
    }
  }
  return { known, auto, dirs };
}

function parseChunk(chunk: BuildChunk): ParsedChunk {
  const hit = parsedChunks.get(chunk);
  if (hit) return hit;
  const ids: number[] = [];
  const terrains: TerrainId[] = [];
  for (const key of Object.keys(chunk.cells)) {
    const id = parseKey(key, false);
    if (id < 0) continue;
    ids.push(id);
    terrains.push(chunk.cells[key]!);
  }
  const edges: [number, EdgeFeature][] = [];
  for (const key of Object.keys(chunk.edges)) {
    const id = parseKey(key, true);
    if (id >= 0) edges.push([id, chunk.edges[key]!]);
  }
  const held = heldOf(chunk);
  const free: FreeWallRef[] = [];
  // A held chunk's free walls are the server's pieces, whose cut ends lie off the lattice, so they take the piece path.
  if (Array.isArray(chunk.walls)) for (const wall of chunk.walls) if (held ? validPiece(wall) : validFreeWall(wall)) free.push({ cx: chunk.cx, cy: chunk.cy, wall });
  const cells = { ids: Int32Array.from(ids), codes: Uint8Array.from(terrains, terrainCode) };
  const ground = reliefOf(chunk, chunkHeights(chunk), 0);
  const marks = reliefOf(chunk, markCodes(chunkMarks(chunk)), DOT);
  const parsed = { cells, terrains, edges, free: sortFree(free), ground, marks, box: extent([cells], [edges], [ground], [marks], held?.auto), held };
  parsedChunks.set(chunk, parsed);
  return parsed;
}

/** Free walls in a fixed order, whatever order they were stored in, so every device derives the same pieces in the same order. */
function sortFree(free: FreeWallRef[]): FreeWallRef[] {
  return free.sort(
    (p, q) => p.wall.a[1] - q.wall.a[1] || p.wall.a[0] - q.wall.a[0] || p.wall.b[1] - q.wall.b[1] || p.wall.b[0] - q.wall.b[0] || (p.wall.id < q.wall.id ? -1 : p.wall.id > q.wall.id ? 1 : 0),
  );
}

function byPosition(a: BuildChunk, b: BuildChunk): number {
  return a.cy - b.cy || a.cx - b.cx;
}

/** Merges a scene's chunks into one lookup. Malformed keys and free walls are dropped instead of trusted. */
export function indexBuild(chunks: Iterable<BuildChunk>): BuildIndex {
  const cells = new Map<number, TerrainId>();
  const edges = new Map<number, EdgeFeature>();
  const free: FreeWallRef[] = [];
  const ground = new Map<number, number>();
  const marks = new Map<number, StairMark>();
  let held: HeldFacts | undefined;
  for (const chunk of chunks) {
    const parsed = parseChunk(chunk);
    for (let i = 0; i < parsed.cells.ids.length; i++) cells.set(parsed.cells.ids[i]!, parsed.terrains[i]!);
    for (const [id, feature] of parsed.edges) edges.set(id, feature);
    free.push(...parsed.free);
    for (let i = 0; i < parsed.ground.ids.length; i++) ground.set(parsed.ground.ids[i]!, parsed.ground.values[i]!);
    for (let i = 0; i < parsed.marks.ids.length; i++) marks.set(parsed.marks.ids[i]!, String.fromCharCode(parsed.marks.values[i]!) as StairMark);
    if (parsed.held) {
      held ??= { known: new Set(), auto: new Set(), dirs: new Map() };
      for (const id of parsed.held.known) held.known.add(id);
      for (const id of parsed.held.auto) held.auto.add(id);
      for (const [id, d] of parsed.held.dirs) held.dirs.set(id, d);
    }
  }
  return { cells, edges, free: sortFree(free), ground, marks, ...(held ? { held } : {}) };
}

/*
 * What deriving walls reads of a build: its cells, edge features, and cells
 * with ground or a stair mark, each in parts where a later write of the
 * same cell or edge wins, as in a Map, the free walls in a fixed order, and
 * the box all of it reaches. A BuildIndex gives one part from its Maps.
 * Chunks give one part each from their parsed arrays, which skips merging
 * every cell and edge into Maps on each derive, and their free walls chunk
 * by chunk in position order. Each chunk's box is worked out once with its
 * parse, so after an edit only the chunks it wrote are looked at again.
 */
type BuildSource = {
  cells: readonly CellArrays[];
  edges: readonly (readonly (readonly [number, EdgeFeature])[])[];
  free: readonly FreeWallRef[];
  ground: readonly CellValues[];
  marks: readonly CellValues[];
  box: Box | null;
  /** A player's held build's facts, or null for a stored build, whose walls the scene's rule derives. */
  held: HeldFacts | null;
};

function valuesOf<V>(map: ReadonlyMap<number, V> | undefined, code: (v: V) => number): CellValues[] {
  if (!map || map.size === 0) return [];
  const ids = new Int32Array(map.size);
  const values = new Int16Array(map.size);
  let i = 0;
  for (const [id, v] of map) {
    ids[i] = id;
    values[i++] = code(v);
  }
  return [{ ids, values }];
}

function sourceOfIndex(build: BuildIndex): BuildSource {
  const ids = new Int32Array(build.cells.size);
  const codes = new Uint8Array(build.cells.size);
  let i = 0;
  for (const [id, terrain] of build.cells) {
    ids[i] = id;
    codes[i++] = terrainCode(terrain);
  }
  const cells = [{ ids, codes }];
  const edges = [[...build.edges]];
  const ground = valuesOf(build.ground, (v) => v);
  const marks = valuesOf(build.marks, (m) => m.charCodeAt(0));
  return { cells, edges, free: build.free, ground, marks, box: extent(cells, edges, ground, marks, build.held?.auto), held: build.held ?? null };
}

function sourceOfChunks(chunks: readonly BuildChunk[]): BuildSource {
  const parsed = [...chunks].sort(byPosition).map(parseChunk);
  const free: FreeWallRef[] = [];
  let box: Box | null = null;
  let held: HeldFacts | null = null;
  for (const p of parsed) {
    for (const f of p.free) free.push(f);
    box = union(box, p.box);
    if (p.held) {
      held ??= { known: new Set(), auto: new Set(), dirs: new Map() };
      for (const id of p.held.known) held.known.add(id);
      for (const id of p.held.auto) held.auto.add(id);
      for (const [id, d] of p.held.dirs) held.dirs.set(id, d);
    }
  }
  const some = (v: CellValues) => v.ids.length > 0;
  return {
    cells: parsed.map((p) => p.cells),
    edges: parsed.map((p) => p.edges),
    free,
    ground: parsed.map((p) => p.ground).filter(some),
    marks: parsed.map((p) => p.marks).filter(some),
    box,
    held,
  };
}

/** Walls, closed or locked doors and windows stop an area of effect. Open doors do not. */
export function blocksAreas(feature: EdgeFeature): boolean {
  switch (feature.kind) {
    case "wall":
    case "window":
      return true;
    case "door":
      return feature.state !== "open";
    case "none":
      return false;
  }
}

/**
 * What a wall, door or window blocks (section 2.1's table). Areas keep the
 * MVP rule: a secret door blocks them by its real state. Movement and sight
 * see what players see: a secret door not yet found is a wall to them,
 * whatever its state, so the server's sets for players equal the ones a
 * player's own projected build gives. A window lets sight through and
 * nothing else. Every door counts toward the sight cap, open or not, so a
 * door's state never changes that count.
 */
export function tagsOf(feature: WallFeature): number {
  switch (feature.kind) {
    case "wall":
      return AREAS | MOVEMENT | SIGHT | SIGHT_POTENTIAL;
    case "window":
      return AREAS | MOVEMENT;
    case "door": {
      const shut = feature.state !== "open";
      const hidden = feature.secret && !feature.discovered;
      return (shut ? AREAS : 0) | (shut || hidden ? MOVEMENT | SIGHT : 0) | SIGHT_POTENTIAL;
    }
  }
}

/** A pillar cell's square stops movement and sight from wave 4. Areas pass it, as they always have. */
export const PILLAR_TAGS = MOVEMENT | SIGHT | SIGHT_POTENTIAL;
/** How far a pillar's square sits inside its cell, so its corners lie on the 1/64 lattice. */
export const PILLAR_INSET = 9 / LATTICE;

const AUTO_WALL: WallFeature = Object.freeze({ kind: "wall" });

const PAINTED: readonly Painted[] = ["empty", "floor", "overlay"];

function paintedClass(terrain: TerrainId | undefined): number {
  const p = paintedOf(terrain);
  return p === "empty" ? 0 : p === "floor" ? 1 : 2;
}

/** For each pair of painted classes, whether the rule puts an automatic wall between them. */
function ruleTable(rule: AutoWalls): Uint8Array {
  const table = new Uint8Array(9);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) table[a * 3 + b] = autoWallBetween(rule, PAINTED[a]!, PAINTED[b]!) ? 1 : 0;
  return table;
}

// What an edge of the grid below carries.
const AUTO = 1;
const DRAWN = 2;
const REMOVED = 3;

// What a raised edge of the grid below is: one a directed stair connects, which blocks only sight, or a ledge.
const CONNECTED = 1;
const LEDGED = 2;

/*
 * A build's effective edges, one byte per edge on a grid over its cells,
 * drawn edges, heights and stair marks, with a cell of padding all round, so
 * every painted or raised cell has its four neighbors in it. Derived once
 * per wall set, and everything else (the runs, the pillars, the raised
 * edges, the edge list for drawing) reads it in grid order, which needs no
 * sort and no object per edge on the way.
 */
type EdgeGrid = {
  /** The scene's grid: on hexes the cells below are hex keys, and only heights and stairs raise anything. */
  grid: Grid;
  gx: number;
  gy: number;
  w: number;
  h: number;
  /** Per cell index `(y - gy) * w + (x - gx)`: its north edge, and its west edge. 0 nothing, AUTO, DRAWN or REMOVED (a drawn `none`). */
  north: Uint8Array;
  west: Uint8Array;
  /** Drawn walls, doors and windows, by index * 2, plus 1 for a west edge. */
  drawn: Map<number, WallFeature>;
  /** Cell ids of pillar cells, ascending. */
  pillars: number[];
  /** Heights, stairs and raised edges, or null for a build with neither heights nor stairs. */
  relief: Relief | null;
  /** Per cell index, 1 where a held build holds the cell. Null for a stored build, which holds every cell. */
  known: Uint8Array | null;
};

/** Ground, stairs and raised edges, by the grid's cell index. */
type Relief = {
  ground: Int16Array;
  /** 0 not a stair, else 1 + its direction code from heights.ts `stairDirections` (so 1 is a stair with no direction). */
  stairs: Uint8Array;
  /** Per cell, its north and west edge: 0 not raised, CONNECTED or LEDGED. Empty on hexes. */
  northRaised: Uint8Array;
  westRaised: Uint8Array;
  /** On hexes, per hex index * 3 + d, its side toward facing d of 0, 1 and 2 (east, south-east and south-west on hex rows): 0, CONNECTED or LEDGED. Each side once. */
  sides: Uint8Array | null;
};

const EMPTY_GRID: EdgeGrid = { grid: SQUARES, gx: 0, gy: 0, w: 0, h: 0, north: new Uint8Array(0), west: new Uint8Array(0), drawn: new Map(), pillars: [], relief: null, known: null };

function edgeGrid(build: BuildSource, rule: AutoWalls, bounds: { w: number; h: number } | null, grid: Grid = SQUARES): EdgeGrid {
  if (!build.box) return grid === SQUARES ? EMPTY_GRID : { ...EMPTY_GRID, grid };
  const gx = build.box.x0 - 1;
  const gy = build.box.y0 - 1;
  const w = build.box.x1 - build.box.x0 + 3;
  const h = build.box.y1 - build.box.y0 + 3;
  const at = (id: number) => {
    const x = id % ROW;
    return ((id - x) / ROW - gy) * w + (x - gx);
  };
  const terrain = new Uint8Array(w * h);
  for (const { ids, codes } of build.cells) for (let i = 0; i < ids.length; i++) terrain[at(ids[i]!)] = codes[i]!;
  // A stair mark makes its cell a Stairs cell for automatic walls, whatever its terrain (section 2.1).
  const marks = build.marks.length > 0 ? new Uint8Array(w * h) : null;
  if (marks) for (const { ids, values } of build.marks) for (let i = 0; i < ids.length; i++) marks[at(ids[i]!)] = values[i]!;
  const north = new Uint8Array(w * h);
  const west = new Uint8Array(w * h);
  const drawn = new Map<number, WallFeature>();
  for (const part of build.edges) {
    for (const [id, feature] of part) {
      const side = id & 1;
      const k = at((id - side) / 2);
      if (feature.kind === "none") {
        (side === 1 ? west : north)[k] = REMOVED;
        drawn.delete(k * 2 + side);
      } else {
        (side === 1 ? west : north)[k] = DRAWN;
        drawn.set(k * 2 + side, feature);
      }
    }
  }
  let known: Uint8Array | null = null;
  if (build.held) {
    // A held build's automatic walls are those the server sent for held edges, whatever the cells it holds would make (5.2).
    for (const id of build.held.auto) {
      const side = id & 1;
      const cell = (id - side) / 2;
      const x = cell % ROW;
      const y = (cell - x) / ROW;
      if (x < gx || y < gy || x >= gx + w || y >= gy + h) continue;
      const grid = side === 1 ? west : north;
      const k = at(cell);
      if (grid[k] === 0) grid[k] = AUTO;
    }
    known = new Uint8Array(w * h);
    for (const cell of build.held.known) {
      const x = cell % ROW;
      const y = (cell - x) / ROW;
      if (x >= gx && y >= gy && x < gx + w && y < gy + h) known[at(cell)] = 1;
    }
  } else if (rule !== "off" && !isHex(grid)) {
    // A hex scene has no grid-line walls, automatic ones included (docs/design-v1-hex-grids.md HX-D7).
    const table = ruleTable(rule);
    const painted = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) painted[k] = classOfCode[terrain[k]!]!;
    if (marks) for (let k = 0; k < w * h; k++) if (marks[k] !== 0) painted[k] = 2;
    for (let k = w; k < w * h; k++) if (north[k] === 0 && table[painted[k]! * 3 + painted[k - w]!] === 1) north[k] = AUTO;
    for (let j = 0; j < h; j++) {
      for (let i = 1; i < w; i++) {
        const k = j * w + i;
        if (west[k] === 0 && table[painted[k]! * 3 + painted[k - 1]!] === 1) west[k] = AUTO;
      }
    }
  }
  const pillars: number[] = [];
  const pillar = terrainCodes.get("pillar");
  if (pillar !== undefined) for (let k = 0; k < w * h; k++) if (terrain[k] === pillar) pillars.push(cellId(gx + (k % w), gy + Math.floor(k / w)));
  const out: EdgeGrid = { grid, gx, gy, w, h, north, west, drawn, pillars, relief: null, known };
  out.relief = reliefOfGrid(out, build, terrain, marks, bounds);
  return out;
}

/*
 * The relief over the grid (section 4.2): each cell's ground, which way each
 * stair points, and the raised edges, between two cells of the scene whose
 * ground differs. An edge a directed stair connects, on its up or down side,
 * is CONNECTED and the rest LEDGED. A cell outside the scene has no ground
 * that counts, so a stale height left past a shrunk scene's border raises
 * nothing.
 */
function reliefOfGrid(g: EdgeGrid, build: BuildSource, terrain: Uint8Array, marks: Uint8Array | null, bounds: { w: number; h: number } | null): Relief | null {
  const { gx, gy, w, h } = g;
  const hex = isHex(g.grid) ? g.grid : null;
  const stairsCode = terrainCodes.get("stairs");
  const stairList: number[] = [];
  for (let k = 0; k < w * h; k++) if ((marks !== null && marks[k] !== 0) || (stairsCode !== undefined && terrain[k] === stairsCode)) stairList.push(k);
  if (build.ground.length === 0 && stairList.length === 0) return null;
  const ground = new Int16Array(w * h);
  for (const { ids, values } of build.ground) {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const x = id % ROW;
      ground[((id - x) / ROW - gy) * w + (x - gx)] = values[i]!;
    }
  }
  // A held build raises no edge beside a cell it does not hold: the ground there is unknown, not 0 (5.2).
  const known = g.known;
  const inScene = (k: number) => {
    if (known && known[k] !== 1) return false;
    if (!bounds) return true;
    const x = gx + (k % w);
    const y = gy + (k - (k % w)) / w;
    if (hex) return hexInScene(hex, bounds, { col: x, row: y });
    return x >= 0 && y >= 0 && x < bounds.w && y < bounds.h;
  };
  // A held build's stairs point where the server says (`upDir`), since the rule reads cells round them it may not hold.
  const held = build.held;
  const directions = held
    ? Uint8Array.from({ length: w * h }, (_, k) => held.dirs.get(cellId(gx + (k % w), gy + (k - (k % w)) / w)) ?? 0)
    : stairDirections(
        g.grid,
        {
          x0: gx,
          y0: gy,
          w,
          h,
          mark: (k) => (marks !== null && marks[k] !== 0 ? (String.fromCharCode(marks[k]!) as StairMark) : stairsCode !== undefined && terrain[k] === stairsCode ? "a" : "."),
          ground: (k) => ground[k]!,
          inScene,
        },
        stairList,
      );
  const stairs = new Uint8Array(w * h);
  if (hex) {
    for (const k of stairList) stairs[k] = 1 + directions[k]!;
    return { ground, stairs, northRaised: new Uint8Array(0), westRaised: new Uint8Array(0), sides: hexSides(hex, g, ground, stairs, inScene) };
  }
  const northLinked = new Uint8Array(w * h);
  const westLinked = new Uint8Array(w * h);
  for (const k of stairList) {
    stairs[k] = 1 + directions[k]!;
    const dir = facingOf(SQUARES, directions[k]!);
    // The padding keeps a stair's south and east neighbors inside the grid.
    if (dir === "n" || dir === "s") northLinked[k] = northLinked[k + w] = 1;
    else if (dir === "e" || dir === "w") westLinked[k] = westLinked[k + 1] = 1;
  }
  const northRaised = new Uint8Array(w * h);
  const westRaised = new Uint8Array(w * h);
  for (let k = w; k < w * h; k++) {
    if (ground[k] !== ground[k - w] && inScene(k) && inScene(k - w)) northRaised[k] = northLinked[k] === 1 ? CONNECTED : LEDGED;
  }
  for (let j = 0; j < h; j++) {
    for (let i = 1; i < w; i++) {
      const k = j * w + i;
      if (ground[k] !== ground[k - 1] && inScene(k) && inScene(k - 1)) westRaised[k] = westLinked[k] === 1 ? CONNECTED : LEDGED;
    }
  }
  return { ground, stairs, northRaised, westRaised, sides: null };
}

/*
 * The raised sides of a hex window (H3): between two hexes of the scene
 * whose ground differs, as on squares, read once each, from the hex whose
 * facing 0, 1 or 2 reaches the other. A directed stair connects its up
 * side and its down side, the one straight across, whatever the heights,
 * and the rest are ledges. The padding of one key all round holds every
 * neighbor of a hex inside the box.
 */
function hexSides(hex: HexGrid, g: EdgeGrid, ground: Int16Array, stairs: Uint8Array, inScene: (k: number) => boolean): Uint8Array {
  const { gx, gy, w, h } = g;
  const step = stepper(hex);
  const sides = new Uint8Array(w * h * 3);
  // A stair's code is 1 + 1 + its facing, 1 alone for one with no direction.
  const links = (k: number, d: number) => {
    const code = stairs[k]!;
    if (code < 2) return false;
    const f = code - 2;
    return f === d || f === oppositeFacing(hex, d);
  };
  for (let k = 0; k < w * h; k++) {
    const x = gx + (k % w);
    const y = gy + (k - (k % w)) / w;
    for (let d = 0; d < 3; d++) {
      const [nx, ny] = step(x, y, d);
      const i = nx - gx;
      const j = ny - gy;
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const n = j * w + i;
      if (ground[k] === ground[n] || !inScene(k) || !inScene(n)) continue;
      sides[k * 3 + d] = links(k, d) || links(n, oppositeFacing(hex, d)) ? CONNECTED : LEDGED;
    }
  }
  return sides;
}

/** The side of hex (x, y) toward facing `d`, as its two corners on the 1/64 lattice (hex.ts cornerAt): between its corners d + 1 and d + 2. */
function hexSideEnds(g: HexGrid, x: number, y: number, d: number): [Point, Point] {
  const corners = hexCorners(g, { col: x, row: y });
  return [cornerAt(g, corners[(d + 1) % 6]!), cornerAt(g, corners[(d + 2) % 6]!)];
}

/** The grid's edges as a sorted list for drawing: north edges by row, then west edges by row. */
function edgesOfGrid(g: EdgeGrid): WallEdge[] {
  const out: WallEdge[] = [];
  for (const [side, grid] of [
    ["n", g.north],
    ["w", g.west],
  ] as const) {
    for (let k = 0; k < g.w * g.h; k++) {
      const v = grid[k]!;
      if (v !== AUTO && v !== DRAWN) continue;
      const x = g.gx + (k % g.w);
      const y = g.gy + Math.floor(k / g.w);
      out.push(v === AUTO ? { x, y, side, feature: AUTO_WALL, auto: true } : { x, y, side, feature: g.drawn.get(k * 2 + (side === "w" ? 1 : 0))!, auto: false });
    }
  }
  return out;
}

/**
 * The effective edges of a build: an automatic wall wherever the scene's
 * rule puts one (shared/rules/autoWalls.ts, section 2.1), then the edge
 * features override: `none` removes a wall, and a wall, door or window
 * replaces whatever was there. Sorted, for drawing.
 */
export function effectiveEdges(build: BuildIndex, rule: AutoWalls = "all"): WallEdge[] {
  return edgesOfGrid(edgeGrid(sourceOfIndex(build), rule, null));
}

/** A stored segment's origin when it is one drawn edge (its `edgeId`) or a free wall (-2 - its index in `free`). -1 otherwise. */
const NO_ORIGIN = -1;

/**
 * Flat segments with their tags, tops and origins, grown as the candidates
 * are collected. Typed arrays that double when full: a dense build has
 * about 50,000 candidates, and pushing them onto plain arrays to copy at the
 * end was a fifth of deriving its walls.
 */
class CandidateList {
  #xy = new Float64Array(1024);
  #tags = new Uint8Array(256);
  #free = new Uint8Array(256);
  #tops = new Int16Array(256);
  #origin = new Int32Array(256);
  #n = 0;
  /** `free` as segments.ts Candidates has it: 0 a grid segment, 1 a stored free wall, PIECE a held build's piece. */
  add(ax: number, ay: number, bx: number, by: number, tags: number, free: number, top = 0, origin = NO_ORIGIN): void {
    if (this.#n === this.#tags.length) {
      const grow = <T extends Float64Array | Uint8Array | Int16Array | Int32Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.#xy = grow(this.#xy);
      this.#tags = grow(this.#tags);
      this.#free = grow(this.#free);
      this.#tops = grow(this.#tops);
      this.#origin = grow(this.#origin);
    }
    const k = this.#n++;
    this.#xy[4 * k] = ax;
    this.#xy[4 * k + 1] = ay;
    this.#xy[4 * k + 2] = bx;
    this.#xy[4 * k + 3] = by;
    this.#tags[k] = tags;
    this.#free[k] = free;
    this.#tops[k] = top;
    this.#origin[k] = origin;
  }
  done(): { stored: Candidates; tops: Int16Array; origin: Int32Array } {
    const n = this.#n;
    return { stored: { xy: this.#xy.slice(0, 4 * n), tags: this.#tags.slice(0, n), free: this.#free.slice(0, n), n }, tops: this.#tops.slice(0, n), origin: this.#origin.slice(0, n) };
  }
}

/*
 * What an edge contributes to the runs below: 0 nothing, WALL_RUN a wall,
 * SINGLE a door or window, which stays one edge, or a raised edge's class,
 * which packs its top and whether it is a ledge, so only raised edges alike
 * merge.
 */
const WALL_RUN = 1;
const SINGLE = -1;

function raisedRun(top: number, ledge: boolean): number {
  return 2 + (top + 32768) * 2 + (ledge ? 1 : 0);
}

function raisedTags(raised: number): number {
  return raised === 0 ? 0 : RAISED | SIGHT_POTENTIAL | (raised === LEDGED ? LEDGE : 0);
}

/*
 * Plain walls merge into runs along each grid line, which keeps the sweeps
 * small, and so do raised edges alike in top and kind. Doors and windows
 * stay one edge each, so the runs, and so the split's counts, never depend
 * on a door's state. A raised edge under a wall adds nothing, since the wall
 * blocks everything it would, and one under a door or window joins that
 * edge's segment. Two runs would cross where a vertical run passes straight
 * through a horizontal one, so a horizontal run is cut at such a crossing,
 * which leaves the vertical run passing between two ends (a T on each side),
 * which a sweep handles. Grid segments meet each other nowhere else.
 */
function gridCandidates(g: EdgeGrid, out: CandidateList): void {
  const { gx, gy, w, h, north, west, drawn, relief } = g;
  if (isHex(g.grid)) {
    // Hex sides meet only at their corners, so each raised one is a segment of its own, and no grid line runs them together.
    const sides = relief?.sides;
    if (!relief || !sides) return;
    const step = stepper(g.grid);
    for (let k = 0; k < w * h; k++) {
      for (let d = 0; d < 3; d++) {
        const raised = sides[k * 3 + d]!;
        if (raised === 0) continue;
        const x = gx + (k % w);
        const y = gy + (k - (k % w)) / w;
        const [nx, ny] = step(x, y, d);
        const [a, b] = hexSideEnds(g.grid, x, y, d);
        out.add(a.x, a.y, b.x, b.y, raisedTags(raised), 0, Math.max(relief.ground[k]!, relief.ground[(ny - gy) * w + (nx - gx)]!));
      }
    }
    return;
  }
  const top = (k: number, other: number) => (relief ? Math.max(relief.ground[k]!, relief.ground[other]!) : 0);
  const hRun = new Int32Array(w * h);
  const vRun = new Int32Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const n = north[k]!;
    if (n === AUTO) hRun[k] = WALL_RUN;
    else if (n === DRAWN) hRun[k] = drawn.get(k * 2)!.kind === "wall" ? WALL_RUN : SINGLE;
    else if (relief && relief.northRaised[k] !== 0) hRun[k] = raisedRun(top(k, k - w), relief.northRaised[k] === LEDGED);
    const v = west[k]!;
    if (v === AUTO) vRun[k] = WALL_RUN;
    else if (v === DRAWN) vRun[k] = drawn.get(k * 2 + 1)!.kind === "wall" ? WALL_RUN : SINGLE;
    else if (relief && relief.westRaised[k] !== 0) vRun[k] = raisedRun(top(k, k - 1), relief.westRaised[k] === LEDGED);
  }
  const wall = tagsOf(AUTO_WALL);
  const emitRun = (run: number, ax: number, ay: number, bx: number, by: number) => {
    if (run === WALL_RUN) out.add(ax, ay, bx, by, wall, 0);
    else out.add(ax, ay, bx, by, raisedTags((run - 2) % 2 === 1 ? LEDGED : CONNECTED), 0, (run - 2 - ((run - 2) % 2)) / 2 - 32768);
  };
  const emitSingle = (k: number, side: 0 | 1, ax: number, ay: number, bx: number, by: number) => {
    const raised = relief ? (side === 0 ? relief.northRaised[k]! : relief.westRaised[k]!) : 0;
    const x = gx + (k % w);
    const y = gy + (k - (k % w)) / w;
    out.add(ax, ay, bx, by, tagsOf(drawn.get(k * 2 + side)!) | raisedTags(raised), 0, raised === 0 ? 0 : top(k, side === 0 ? k - w : k - 1), edgeId(x, y, side === 0 ? "n" : "w"));
  };
  for (let j = 0; j < h; j++) {
    const y = gy + j;
    let start = -1;
    let run = 0;
    for (let i = 0; i <= w; i++) {
      const k = j * w + i;
      const c = i < w ? hRun[k]! : 0;
      if (start >= 0) {
        if (c !== run) {
          emitRun(run, gx + start, y, gx + i, y);
          start = -1;
        } else if (j > 0 && j < h && vRun[k - w]! > 0 && vRun[k - w] === vRun[k]) {
          emitRun(run, gx + start, y, gx + i, y);
          start = i;
        }
      }
      if (start < 0 && c > 0) {
        start = i;
        run = c;
      }
      if (c === SINGLE) emitSingle(k, 0, gx + i, y, gx + i + 1, y);
    }
  }
  for (let i = 0; i < w; i++) {
    const x = gx + i;
    let start = -1;
    let run = 0;
    for (let j = 0; j <= h; j++) {
      const k = j * w + i;
      const c = j < h ? vRun[k]! : 0;
      if (start >= 0 && c !== run) {
        emitRun(run, x, gy + start, x, gy + j);
        start = -1;
      }
      if (start < 0 && c > 0) {
        start = j;
        run = c;
      }
      if (c === SINGLE) emitSingle(k, 1, x, gy + j, x, gy + j + 1);
    }
  }
}

function pillarCandidates(ids: readonly number[], out: CandidateList): void {
  const lo = PILLAR_INSET;
  const hi = 1 - PILLAR_INSET;
  for (const id of ids) {
    const x = id % ROW;
    const y = (id - x) / ROW;
    out.add(x + lo, y + lo, x + hi, y + lo, PILLAR_TAGS, 0);
    out.add(x + hi, y + lo, x + hi, y + hi, PILLAR_TAGS, 0);
    out.add(x + hi, y + hi, x + lo, y + hi, PILLAR_TAGS, 0);
    out.add(x + lo, y + hi, x + lo, y + lo, PILLAR_TAGS, 0);
  }
}

/** The split's caps on every scene (section 2.4). */
export const SPLIT_CAPS = { pairs: LIMITS.splitPairsPerScene, pieces: LIMITS.splitPiecesPerScene } as const;

/** Why an op over one of the split's caps is refused. An undo says "could not undo ...: " before it (server/rooms/actor.ts). */
export function splitRefusal(over: "pairs" | "pieces"): string {
  return over === "pairs"
    ? `this scene's walls would cross and meet too often: more than ${SPLIT_CAPS.pairs.toLocaleString("en-US")} pairs of walls to check`
    : `this scene's walls would cross too often: they would split into more than ${SPLIT_CAPS.pieces.toLocaleString("en-US")} extra pieces`;
}

/** A wall, door or window a stored segment carries on its own, and how an op names it. */
export type StoredFeature = { feature: WallFeature; ref: DoorRef };

/** What sight sweeps from an eye at one height: the split pieces, and the stored segments by cell for the step off a wall (all tagged SIGHT). */
export type SightSet = { pieces: Float64Array; stored: SegmentIndex };

/**
 * The derived walls of one scene (section 2.1). Built from the stored build
 * at once. The split, the area set and the per-cell index are worked out
 * the first time something asks, so the limits step's counting pass never
 * pays for a split it does not need.
 *
 * A set over the split's caps is never stored, since the limits step
 * refuses the op that would make it, but a device can hold one for a moment
 * (a client's optimistic state, the server's staged state before the check).
 * Its pieces then leave out the free walls, so no derive ever does more
 * work than the caps allow.
 *
 * For wave 4: `stored`, `storedTops` and `storedIndex` are the stored
 * segments with their tags and the tops of raised edges, for the movement
 * test (movement.ts). `sight(eyeFt)` is what sight sweeps from an eye at a
 * height: the split pieces that block it and the stored ones for the step
 * off a wall. `clipToBox` (segments.ts) cuts the pieces to a culled box.
 */
/** How far off a whole square a footprint's side may lie and still count as on it, for `withoutLedgesInside`. */
const EDGE_EPS = 1e-9;

export class WallSet {
  /** Changes whenever the derived walls may differ: part of every cache key over them. */
  readonly version: string | number;
  /** Every stored free wall, in a fixed order. */
  readonly free: readonly FreeWallRef[];
  /** The stored segments, unsplit, every end on the 1/64 lattice. */
  readonly stored: Candidates;
  /** Per stored segment carrying RAISED, its top in feet: the higher ground beside it. 0 for the rest. */
  readonly storedTops: Int16Array;
  /** The scene's size when derived, for a whole-scene sweep box. Null for a set derived without one. */
  readonly bounds: { w: number; h: number } | null;
  #count: SplitCount | undefined;
  #pieces: Pieces | undefined;
  #index: SegmentIndex | undefined;
  readonly #masked = new Map<number, Float64Array>();
  #blockerBounds: Bounds | null | undefined;
  readonly #grid: EdgeGrid;
  readonly #origin: Int32Array;
  #edges: WallEdge[] | undefined;
  #pieceTops: Int16Array | undefined;
  #tops: number[] | undefined;
  readonly #sight = new Map<number, SightSet>();
  readonly #inside = new Map<string, WallSet>();
  #potential: number | undefined;

  constructor(version: string | number, grid: EdgeGrid, free: readonly FreeWallRef[], derived: { stored: Candidates; tops: Int16Array; origin: Int32Array }, bounds: { w: number; h: number } | null) {
    this.version = version;
    this.#grid = grid;
    this.free = free;
    this.stored = derived.stored;
    this.storedTops = derived.tops;
    this.#origin = derived.origin;
    this.bounds = bounds;
  }

  /**
   * The movement test's set for a walk off a holder before it first clears
   * the holder (movement.ts MovingToken, reviews AT-O-26 and AT-ASTRA-16):
   * no ledge edge whose whole length lies strictly inside the holder's
   * footprint `rect` stops the walk, so it crosses the step under a holder
   * that straddles two heights. Raised edges are whole grid edges, merged
   * into runs along grid lines, so a run on a line strictly inside the
   * footprint is cut to the grid edges the footprint holds end to end. A
   * ledge on the footprint's boundary or beyond it, and a grid edge only
   * partly inside, as under a holder half a square off the grid, stop the
   * walk as any ledge does. A wall or a door under the footprint still
   * stops it. The set itself when no ledge is exempt. Kept per footprint,
   * so a walk's tests share one set.
   */
  withoutLedgesInside(rect: { x: number; y: number; w: number; h: number }): WallSet {
    const key = `${rect.x},${rect.y},${rect.w},${rect.h}`;
    const known = this.#inside.get(key);
    if (known) return known;
    let exempt = false;
    const s = this.stored;
    const out = new CandidateList();
    const x0 = rect.x;
    const y0 = rect.y;
    const x1 = rect.x + rect.w;
    const y1 = rect.y + rect.h;
    for (let k = 0; k < s.n; k++) {
      const ax = s.xy[4 * k]!;
      const ay = s.xy[4 * k + 1]!;
      const bx = s.xy[4 * k + 2]!;
      const by = s.xy[4 * k + 3]!;
      const tags = s.tags[k]!;
      const free = s.free[k]!;
      const top = this.storedTops[k]!;
      const origin = this.#origin[k]!;
      const along = ax === bx && x0 < ax && ax < x1 ? "y" : ay === by && y0 < ay && ay < y1 ? "x" : null;
      if ((tags & LEDGE) === 0 || along === null) {
        out.add(ax, ay, bx, by, tags, free, top, origin);
        continue;
      }
      // The run's span along its line, and the whole grid edges of it the footprint holds: there the run is no ledge.
      const lo = along === "y" ? Math.min(ay, by) : Math.min(ax, bx);
      const hi = along === "y" ? Math.max(ay, by) : Math.max(ax, bx);
      const inLo = Math.max(lo, Math.ceil((along === "y" ? y0 : x0) - EDGE_EPS));
      const inHi = Math.min(hi, Math.floor((along === "y" ? y1 : x1) + EDGE_EPS));
      const piece = (from: number, to: number, pieceTags: number) => {
        if (to <= from) return;
        if (along === "y") out.add(ax, from, ax, to, pieceTags, free, top, origin);
        else out.add(from, ay, to, ay, pieceTags, free, top, origin);
      };
      if (inHi <= inLo) {
        out.add(ax, ay, bx, by, tags, free, top, origin);
        continue;
      }
      piece(lo, inLo, tags);
      piece(inLo, inHi, tags & ~LEDGE);
      piece(inHi, hi, tags);
      exempt = true;
    }
    const set = !exempt ? this : new WallSet(`${this.version}|off:${key}`, this.#grid, this.free, out.done(), this.bounds);
    this.#inside.set(key, set);
    return set;
  }

  /**
   * The set with each stored segment cut to the parts `keep` returns for
   * it, flat `[ax, ay, bx, by, ...]`, every end on the 1/64 lattice so the
   * split stays exact: the walls as a viewer who knows only some of them
   * reads them, such as a player's aimed area on a fogged scene
   * (client/features/areas/coverage.ts). Each part keeps its segment's
   * tags, top and feature. Only the stored segments are cut: the grid's
   * edges, ground and stairs read as before. `version` names the new set
   * in every cache key over it.
   */
  cutTo(version: string, keep: (ax: number, ay: number, bx: number, by: number) => readonly number[]): WallSet {
    const s = this.stored;
    const out = new CandidateList();
    for (let k = 0; k < s.n; k++) {
      const parts = keep(s.xy[4 * k]!, s.xy[4 * k + 1]!, s.xy[4 * k + 2]!, s.xy[4 * k + 3]!);
      for (let i = 0; i + 3 < parts.length; i += 4) out.add(parts[i]!, parts[i + 1]!, parts[i + 2]!, parts[i + 3]!, s.tags[k]!, s.free[k]!, this.storedTops[k]!, this.#origin[k]!);
    }
    return new WallSet(version, this.#grid, this.free, out.done(), this.bounds);
  }

  /** Every effective grid edge, sorted, for drawing. */
  get edges(): readonly WallEdge[] {
    return (this.#edges ??= edgesOfGrid(this.#grid));
  }

  /** The split's counting pass against the caps. */
  get count(): SplitCount {
    return (this.#count ??= countSplit(this.stored, SPLIT_CAPS));
  }

  /** The stored segments split where free walls cross or touch them: no two cross. */
  get pieces(): Pieces {
    if (this.#pieces) return this.#pieces;
    if (this.count.over) {
      const s = this.stored;
      const keep: number[] = [];
      for (let k = 0; k < s.n; k++) if (s.free[k] !== 1) keep.push(k);
      const xy = new Float64Array(keep.length * 4);
      keep.forEach((k, m) => xy.set(s.xy.subarray(4 * k, 4 * k + 4), 4 * m));
      return (this.#pieces = { xy, tags: Uint8Array.from(keep, (k) => s.tags[k]!), n: keep.length });
    }
    return (this.#pieces = splitSegments(this.stored));
  }

  /** Flat pieces carrying any of `mask`, for a sweep. */
  segmentsWith(mask: number): Float64Array {
    let hit = this.#masked.get(mask);
    if (!hit) this.#masked.set(mask, (hit = piecesWith(this.pieces, mask)));
    return hit;
  }

  /** The pieces that stop areas of effect, flat `[ax, ay, bx, by, ...]`. */
  get blockers(): Float64Array {
    return this.segmentsWith(AREAS);
  }

  /** Bounds of `blockers`, or null when nothing blocks. */
  get blockerBounds(): Bounds | null {
    if (this.#blockerBounds === undefined) this.#blockerBounds = boundsOf(this.blockers);
    return this.#blockerBounds;
  }

  /** The stored segments by cell, for tests of what touches what. */
  get storedIndex(): SegmentIndex {
    return (this.#index ??= new SegmentIndex(this.stored.xy, this.stored.tags, this.stored.free));
  }

  /** The wall, door or window stored segment `k` is on its own (a drawn edge or a free wall), or null for a run, a pillar side or a raised edge. */
  featureAt(k: number): StoredFeature | null {
    const origin = this.#origin[k]!;
    if (origin >= 0) {
      const side = origin & 1;
      const base = (origin - side) / 2;
      const x = base % ROW;
      const y = (base - x) / ROW;
      const g = this.#grid;
      const feature = g.drawn.get(((y - g.gy) * g.w + (x - g.gx)) * 2 + side);
      return feature ? { feature, ref: { edge: `${x},${y},${side === 1 ? "w" : "n"}` } } : null;
    }
    if (origin <= -2) {
      const f = this.free[-2 - origin];
      return f ? { feature: f.wall.f, ref: { cx: f.cx, cy: f.cy, id: f.wall.id } } : null;
    }
    return null;
  }

  /** A cell's ground in feet, 0 where none is painted. Read from the stored build, so it holds outside the scene too. */
  groundAt(x: number, y: number): number {
    const g = this.#grid;
    const i = x - g.gx;
    const j = y - g.gy;
    if (!g.relief || i < 0 || j < 0 || i >= g.w || j >= g.h) return 0;
    return g.relief.ground[j * g.w + i]!;
  }

  /** The highest ground over a range of cells (footprint.ts `occupiedRange`). */
  rangeGround(r: { x0: number; y0: number; x1: number; y1: number }): number {
    if (!this.#grid.relief) return 0;
    let top = -Infinity;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) top = Math.max(top, this.groundAt(x, y));
    return top === -Infinity ? 0 : top;
  }

  /** Which way the stair in a cell (a hex on hexes, by its key) points up, null for a stair with no direction, undefined for a cell that is not a stair. */
  stairAt(x: number, y: number): Facing | null | undefined {
    const g = this.#grid;
    const i = x - g.gx;
    const j = y - g.gy;
    if (!g.relief || i < 0 || j < 0 || i >= g.w || j >= g.h) return undefined;
    const code = g.relief.stairs[j * g.w + i]!;
    return code === 0 ? undefined : facingOf(g.grid, code - 1);
  }

  /** The grid its cells are keyed by: hex keys on a hex scene. */
  get grid(): Grid {
    return this.#grid.grid;
  }

  /** Whether the build has any height or stair, so the movement test can skip the ground. */
  get hasRelief(): boolean {
    return this.#grid.relief !== null;
  }

  /** Pieces that could block sight with every door closed and every secret door hidden, every raised edge included: what the sight cap counts (section 2.1). */
  get sightPotential(): number {
    if (this.#potential === undefined) {
      const p = this.pieces;
      let n = 0;
      for (let k = 0; k < p.n; k++) if (p.tags[k]! & SIGHT_POTENTIAL) n++;
      this.#potential = n;
    }
    return this.#potential;
  }

  /**
   * What blocks sight from an eye `eyeFt` feet up (sections 4.2 and 4.3.2):
   * every piece and stored segment tagged SIGHT, and every raised edge whose
   * top is above the eye. The pieces are a subset of a crossing-free split,
   * so they go to a sweep as they are. The stored segments are indexed with
   * SIGHT as their only tag, for `stepOffWalls(x, y, set.stored, SIGHT)`.
   * Eyes between the same two raised tops share one set.
   */
  sight(eyeFt: number): SightSet {
    const tops = this.#raisedTops();
    // How many distinct tops the eye is at or above: every raised edge with a higher top blocks it.
    let lo = 0;
    let hi = tops.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid]! <= eyeFt) lo = mid + 1;
      else hi = mid;
    }
    let hit = this.#sight.get(lo);
    if (hit) return hit;
    const above = lo < tops.length ? tops[lo]! : Infinity;
    const blocks = (tags: number, top: number) => (tags & SIGHT) !== 0 || ((tags & RAISED) !== 0 && top >= above);
    const p = this.pieces;
    const pieceTops = this.#topsOfPieces();
    const pieces: number[] = [];
    for (let k = 0; k < p.n; k++) if (blocks(p.tags[k]!, pieceTops[k]!)) pieces.push(p.xy[4 * k]!, p.xy[4 * k + 1]!, p.xy[4 * k + 2]!, p.xy[4 * k + 3]!);
    const s = this.stored;
    const stored: number[] = [];
    for (let k = 0; k < s.n; k++) if (blocks(s.tags[k]!, this.storedTops[k]!)) stored.push(s.xy[4 * k]!, s.xy[4 * k + 1]!, s.xy[4 * k + 2]!, s.xy[4 * k + 3]!);
    hit = { pieces: Float64Array.from(pieces), stored: new SegmentIndex(Float64Array.from(stored), new Uint8Array(stored.length / 4).fill(SIGHT)) };
    this.#sight.set(lo, hit);
    return hit;
  }

  /** The distinct tops of the raised edges, ascending. */
  #raisedTops(): number[] {
    if (this.#tops) return this.#tops;
    const seen = new Set<number>();
    const s = this.stored;
    for (let k = 0; k < s.n; k++) if (s.tags[k]! & RAISED) seen.add(this.storedTops[k]!);
    return (this.#tops = [...seen].sort((a, b) => a - b));
  }

  /*
   * The top of each piece carrying RAISED. Raised edges lie on grid lines
   * and merge only with edges of the same top, and a split point on a grid
   * line keeps its exact coordinate there, so a piece's midpoint names a grid
   * edge of the run it came from.
   */
  #topsOfPieces(): Int16Array {
    if (this.#pieceTops) return this.#pieceTops;
    const p = this.pieces;
    const g = this.#grid;
    const tops = new Int16Array(p.n);
    if (g.relief && isHex(g.grid)) {
      // A piece of a hex side keeps the top of the raised side it was cut from: the stored one running along it through its
      // middle. Corners are rounded onto the lattice, so the hex centers nearest a short piece by a corner may name another side.
      const s = this.stored;
      const index = this.storedIndex;
      for (let k = 0; k < p.n; k++) {
        if (!(p.tags[k]! & RAISED)) continue;
        const ax = p.xy[4 * k]!;
        const ay = p.xy[4 * k + 1]!;
        const bx = p.xy[4 * k + 2]!;
        const by = p.xy[4 * k + 3]!;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        // Tops run below the floor too, so none is assumed: a piece always lies along the side it was cut from, and one
        // that somehow did not would stop every eye rather than open a gap.
        let top: number | null = null;
        index.query(mx, my, mx, my, RAISED, (j) => {
          if (alongSide(s.xy, j, ax, ay, bx, by)) top = Math.max(top ?? -Infinity, this.storedTops[j]!);
        });
        tops[k] = top ?? HIGHEST_TOP;
      }
    } else if (g.relief) {
      const ground = g.relief.ground;
      for (let k = 0; k < p.n; k++) {
        if (!(p.tags[k]! & RAISED)) continue;
        const ax = p.xy[4 * k]!;
        const ay = p.xy[4 * k + 1]!;
        const bx = p.xy[4 * k + 2]!;
        const by = p.xy[4 * k + 3]!;
        if (ay === by) {
          const c = (ay - g.gy) * g.w + (Math.floor((ax + bx) / 2) - g.gx);
          tops[k] = Math.max(ground[c]!, ground[c - g.w]!);
        } else {
          const c = (Math.floor((ay + by) / 2) - g.gy) * g.w + (ax - g.gx);
          tops[k] = Math.max(ground[c]!, ground[c - 1]!);
        }
      }
    }
    return (this.#pieceTops = tops);
  }
}

/** The highest top a piece can hold (`storedTops` is 16-bit), over every eye. */
const HIGHEST_TOP = 32767;

/** Split points lie on the 1/64 lattice, so a piece of a slanted side may stand off it by up to half a lattice step. */
const SIDE_SLACK = 1 / 64;

/** Whether the piece from (ax, ay) to (bx, by) lies along stored segment `j`: parallel to it, its middle on it. */
function alongSide(xy: Float64Array, j: number, ax: number, ay: number, bx: number, by: number): boolean {
  const cx = xy[4 * j]!;
  const cy = xy[4 * j + 1]!;
  const ex = xy[4 * j + 2]! - cx;
  const ey = xy[4 * j + 3]! - cy;
  const len = Math.hypot(ex, ey);
  const px = bx - ax;
  const py = by - ay;
  const plen = Math.hypot(px, py);
  if (len === 0 || plen === 0 || Math.abs(px * ey - py * ex) / (len * plen) > SIDE_SLACK) return false;
  const mx = (ax + bx) / 2 - cx;
  const my = (ay + by) / 2 - cy;
  const t = (mx * ex + my * ey) / (len * len);
  return Math.abs(mx * ey - my * ex) / len <= SIDE_SLACK && t >= 0 && t <= 1;
}

/** The stored segments of a build under an automatic walls rule: grid edges and raised edges, pillar squares, then free walls. */
function candidatesOf(build: BuildSource, grid: EdgeGrid): { stored: Candidates; tops: Int16Array; origin: Int32Array } {
  const out = new CandidateList();
  gridCandidates(grid, out);
  pillarCandidates(grid.pillars, out);
  // A held build's free walls are pieces, which the exact split and its count leave to a plain pass (segments.ts PIECE).
  const kind = build.held ? PIECE : 1;
  build.free.forEach(({ wall }, i) => out.add(wall.a[0], wall.a[1], wall.b[0], wall.b[1], tagsOf(wall.f), kind, 0, -2 - i));
  return out.done();
}

/**
 * The wall set of a build under the scene's automatic walls rule (absent
 * reads as "all", today's rule). `version` goes into every cache key over
 * the set, so give a new one for different walls. `sceneWalls` does.
 * Without bounds every cell counts as in the scene for raised edges.
 */
export function deriveWalls(build: BuildIndex, version: string | number, opts: { rule?: AutoWalls; bounds?: { w: number; h: number }; grid?: Grid } = {}): WallSet {
  return deriveFrom(sourceOfIndex(build), version, opts);
}

function deriveFrom(build: BuildSource, version: string | number, opts: { rule?: AutoWalls; bounds?: { w: number; h: number }; grid?: Grid }): WallSet {
  const grid = edgeGrid(build, opts.rule ?? "all", opts.bounds ?? null, opts.grid ?? SQUARES);
  return new WallSet(version, grid, build.free, candidatesOf(build, grid), opts.bounds ?? null);
}

/**
 * The split's counting pass over chunks that would be stored, for the room
 * import and the Universal VTT import, which check before they write.
 */
export function countChunksSplit(chunks: Iterable<BuildChunk>, rule: AutoWalls): SplitCount {
  const build = sourceOfChunks([...chunks]);
  if (build.free.length === 0) return { pairs: 0, pieces: 0, over: null };
  return countSplit(candidatesOf(build, edgeGrid(build, rule, null)).stored, SPLIT_CAPS);
}

/*
 * Caches follow identity, not version numbers (section 2.1). A scene's walls
 * version is reused when the size guard refuses a staged op, so a cache
 * keyed on it could serve walls the room never kept. Entities are replaced,
 * never changed, so the list of a scene's chunk objects, with its automatic
 * walls rule and bounds, names exactly one wall set. Each scene keeps two
 * sets, for the committed state and the staged one (or a client's confirmed
 * and optimistic views). Scene ids are chosen by clients, so two rooms can
 * share one, which costs a miss and never a wrong answer.
 */
type CacheEntry = { chunks: readonly BuildChunk[]; rule: AutoWalls; grid: Grid; w: number; h: number; walls: WallSet };
const sceneCache = new Map<string, CacheEntry[]>();
const SCENES_KEPT = 64;
const SETS_PER_SCENE = 2;
let serial = 0;

/** Every scene's chunks, grouped once per chunk collection and sorted by position. */
const chunkLists = new WeakMap<object, Map<string, BuildChunk[]>>();
const NO_CHUNKS: readonly BuildChunk[] = Object.freeze([]);

function chunksOf(all: Readonly<Record<string, BuildChunk>>, sceneId: SceneId): readonly BuildChunk[] {
  let lists = chunkLists.get(all);
  if (!lists) {
    lists = new Map();
    for (const chunk of Object.values(all)) {
      if (!chunk) continue;
      let list = lists.get(chunk.sceneId);
      if (!list) lists.set(chunk.sceneId, (list = []));
      list.push(chunk);
    }
    for (const list of lists.values()) list.sort(byPosition);
    // An op still writing into the collection (writable.ts) would change it under the lists.
    if (!isWritable(all)) chunkLists.set(all, lists);
  }
  return lists.get(sceneId) ?? NO_CHUNKS;
}

function sameItems(a: readonly BuildChunk[], b: readonly BuildChunk[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The derived walls of a scene, from the state's chunk collection. */
export function sceneWalls(scene: Pick<Scene, "id" | "autoWalls" | "bounds" | "gridShape">, buildChunks: Readonly<Record<string, BuildChunk>>): WallSet {
  const chunks = chunksOf(buildChunks, scene.id);
  const rule = autoWallsOf(scene);
  const grid = gridOfShape(scene.gridShape);
  const { w, h } = scene.bounds;
  const entries = sceneCache.get(scene.id) ?? [];
  sceneCache.delete(scene.id);
  let hit: CacheEntry | undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.rule === rule && e.grid === grid && e.w === w && e.h === h && sameItems(e.chunks, chunks)) {
      hit = e;
      entries.splice(i, 1);
      break;
    }
  }
  hit ??= { chunks, rule, grid, w, h, walls: deriveFrom(sourceOfChunks(chunks), ++serial, { rule, bounds: { w, h }, grid }) };
  sceneCache.set(scene.id, [hit, ...entries].slice(0, SETS_PER_SCENE));
  if (sceneCache.size > SCENES_KEPT) {
    const oldest = sceneCache.keys().next().value;
    if (oldest !== undefined) sceneCache.delete(oldest);
  }
  return hit.walls;
}

/**
 * The limits step's check of the split's caps on one scene (sections 2.1
 * and 2.4), run on the state an op would produce. A scene without free
 * walls has nothing to split, so its check costs one look at its chunks.
 */
export function splitCheck(state: Pick<RoomState, "scenes" | "buildChunks">, sceneId: SceneId): LimitCheck {
  const scene = state.scenes[sceneId];
  if (!scene) return { ok: true };
  const chunks = chunksOf(state.buildChunks, sceneId);
  if (!chunks.some((c) => Array.isArray(c.walls) && c.walls.length > 0)) return { ok: true };
  const over = sceneWalls(scene, state.buildChunks).count.over;
  return over ? { ok: false, code: "quota", message: splitRefusal(over) } : { ok: true };
}

/**
 * Everything visible from (ox, oy) through the segments, clipped to `box`,
 * which must contain the point. A standard angular sweep: segment endpoints
 * sorted by angle, with the segments the current ray crosses kept in order of
 * distance, so the nearest one is the polygon's boundary. O(w log w) for w
 * segments, plus the size of the active list on each insert, which is the
 * number of walls a single ray crosses.
 *
 * A segment that passes through the point blocks nothing: no ray leaving the
 * point crosses it. Callers that want a point on a wall to count as one side
 * of it move the point off the wall first (aoe.ts does).
 */
export function visibilityPolygon(ox: number, oy: number, segments: Float64Array, box: Bounds): Polygon {
  const segCount = segments.length >> 2;
  const coords = new Float64Array((segCount + 4) * 4);
  coords.set(segments.subarray(0, segCount * 4));
  coords.set(
    [box.x0, box.y0, box.x1, box.y0, box.x1, box.y0, box.x1, box.y1, box.x1, box.y1, box.x0, box.y1, box.x0, box.y1, box.x0, box.y0],
    segCount * 4,
  );

  // Pieces: segments as seen from the point, split where they cross the ray
  // at angle pi so every piece spans an increasing range of angles.
  const pStart: number[] = [];
  const pEnd: number[] = [];
  const pAx: number[] = [];
  const pAy: number[] = [];
  const pBx: number[] = [];
  const pBy: number[] = [];
  const addPiece = (ta: number, tb: number, ax: number, ay: number, bx: number, by: number) => {
    if (!(tb > ta)) return;
    pStart.push(ta);
    pEnd.push(tb);
    pAx.push(ax);
    pAy.push(ay);
    pBx.push(bx);
    pBy.push(by);
  };
  for (let s = 0; s < segCount + 4; s++) {
    // Adding 0 normalizes -0, which would flip atan2 from pi to -pi.
    let ax = coords[s * 4]! - ox + 0;
    let ay = coords[s * 4 + 1]! - oy + 0;
    let bx = coords[s * 4 + 2]! - ox + 0;
    let by = coords[s * 4 + 3]! - oy + 0;
    const cross = ax * by - ay * bx;
    if (!(cross !== 0)) continue;
    if (cross < 0) {
      [ax, bx] = [bx, ax];
      [ay, by] = [by, ay];
    }
    if (ay > 0 && by < 0) {
      // Counterclockwise from above the axis to below it passes angle pi.
      const t = ay / (ay - by);
      const cx = ax + t * (bx - ax);
      addPiece(Math.atan2(ay, ax), Math.PI, ax, ay, cx, 0);
      addPiece(-Math.PI, Math.atan2(by, bx), cx, 0, bx, by);
    } else {
      let ta = Math.atan2(ay, ax);
      if (ta === Math.PI) ta = -Math.PI;
      addPiece(ta, Math.atan2(by, bx), ax, ay, bx, by);
    }
  }

  const n = pStart.length;
  const byStart = Array.from({ length: n }, (_, i) => i).sort((a, b) => pStart[a]! - pStart[b]!);
  const byEnd = Array.from({ length: n }, (_, i) => i).sort((a, b) => pEnd[a]! - pEnd[b]!);

  // Distance along the ray at `angle` to the line of piece p.
  const along = (p: number, angle: number) => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const ex = pBx[p]! - pAx[p]!;
    const ey = pBy[p]! - pAy[p]!;
    return (pAx[p]! * ey - pAy[p]! * ex) / (dx * ey - dy * ex);
  };
  /*
   * Two pieces that are both active never cross, so their order is the same
   * at every angle they share. Comparing in the middle of the shared range
   * avoids the shared endpoints, where the distances tie.
   */
  const closer = (p: number, q: number) => {
    const lo = Math.max(pStart[p]!, pStart[q]!);
    const hi = Math.min(pEnd[p]!, pEnd[q]!);
    const mid = (lo + hi) / 2;
    return along(p, mid) < along(q, mid);
  };

  const out: number[] = [];
  const push = (x: number, y: number) => {
    const len = out.length;
    if (len >= 2 && out[len - 2] === x && out[len - 1] === y) return;
    out.push(x, y);
  };
  const pushHit = (p: number, angle: number) => {
    if (angle === pStart[p]) push(pAx[p]! + ox, pAy[p]! + oy);
    else if (angle === pEnd[p]) push(pBx[p]! + ox, pBy[p]! + oy);
    else {
      const t = along(p, angle);
      push(Math.cos(angle) * t + ox, Math.sin(angle) * t + oy);
    }
  };

  const active: number[] = [];
  let si = 0;
  let ei = 0;
  while (si < n || ei < n) {
    const nextStart = si < n ? pStart[byStart[si]!]! : Infinity;
    const nextEnd = ei < n ? pEnd[byEnd[ei]!]! : Infinity;
    const angle = Math.min(nextStart, nextEnd);
    const before = active.length ? active[0]! : -1;
    while (ei < n && pEnd[byEnd[ei]!] === angle) {
      const k = active.indexOf(byEnd[ei]!);
      if (k >= 0) active.splice(k, 1);
      ei++;
    }
    while (si < n && pStart[byStart[si]!] === angle) {
      const p = byStart[si]!;
      let lo = 0;
      let hi = active.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (closer(p, active[mid]!)) hi = mid;
        else lo = mid + 1;
      }
      active.splice(lo, 0, p);
      si++;
    }
    const after = active.length ? active[0]! : -1;
    if (before !== after) {
      if (before >= 0) pushHit(before, angle);
      if (after >= 0) pushHit(after, angle);
    }
  }
  if (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return Float64Array.from(out);
}


/*
 * Marks every cell of a grid window that a polygon edge touches. Generous on
 * purpose: a cell that only touches an edge is marked too. A marked cell is
 * merely sampled instead of classified at once, so over-marking costs a
 * little time and never changes an answer, while under-marking would.
 */
export function markPolygonCells(poly: Polygon, gx: number, gy: number, nx: number, ny: number, grid: Uint8Array): void {
  const EPS = 1e-7;
  const n = poly.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[2 * j]!;
    const ay = poly[2 * j + 1]!;
    const bx = poly[2 * i]!;
    const by = poly[2 * i + 1]!;
    const ylo = Math.min(ay, by);
    const yhi = Math.max(ay, by);
    const r0 = Math.max(gy, Math.floor(ylo - EPS));
    const r1 = Math.min(gy + ny - 1, Math.floor(yhi + EPS));
    for (let r = r0; r <= r1; r++) {
      let xa: number;
      let xb: number;
      if (ay === by) {
        xa = Math.min(ax, bx);
        xb = Math.max(ax, bx);
      } else {
        const ya = Math.max(ylo, r - EPS);
        const yb = Math.min(yhi, r + 1 + EPS);
        const k = (bx - ax) / (by - ay);
        const xA = ax + (ya - ay) * k;
        const xB = ax + (yb - ay) * k;
        xa = Math.min(xA, xB);
        xb = Math.max(xA, xB);
      }
      const c0 = Math.max(gx, Math.floor(xa - EPS));
      const c1 = Math.min(gx + nx - 1, Math.floor(xb + EPS));
      for (let c = c0; c <= c1; c++) grid[(r - gy) * nx + (c - gx)] = 1;
    }
  }
}

const visibilityCache = new WeakMap<WallSet, Map<string, Polygon>>();
const VISIBILITY_CACHE_MAX = 64;

/**
 * The visibility polygon from a point, cached per wall set (so per derived
 * walls) and point. The clip box covers the scene, every wall and the
 * point, with a margin, so it never cuts off anything inside the scene.
 */
export function cachedVisibility(walls: WallSet, p: Point, bounds: { w: number; h: number }): Polygon {
  let cache = visibilityCache.get(walls);
  if (!cache) visibilityCache.set(walls, (cache = new Map()));
  const key = `${p.x},${p.y},${bounds.w},${bounds.h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const wb = walls.blockerBounds;
  const box: Bounds = {
    x0: Math.min(0, p.x, wb ? wb.x0 : 0) - 1,
    y0: Math.min(0, p.y, wb ? wb.y0 : 0) - 1,
    x1: Math.max(bounds.w, p.x, wb ? wb.x1 : 0) + 1,
    y1: Math.max(bounds.h, p.y, wb ? wb.y1 : 0) + 1,
  };
  const poly = visibilityPolygon(p.x, p.y, walls.blockers, box);
  cache.set(key, poly);
  if (cache.size > VISIBILITY_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return poly;
}

/**
 * Only walls, windows and closed or locked doors bound a room. An open door
 * joins two rooms, and so does an edge between floor cells with no feature.
 */
function blocksPassage(feature: EdgeFeature | undefined): boolean {
  return feature !== undefined && blocksAreas(feature);
}

/**
 * The room under a cell for "reveal room": the floor cells reachable from it
 * without crossing a wall, window, or closed or locked door. Empty when the
 * cell is not floor. Stops after `maxCells` cells and reports `truncated`.
 * Cells come back as `"x,y"` keys, the form fog ops use.
 */
export function floodRoom(
  build: BuildIndex,
  start: Point,
  opts: { bounds?: { w: number; h: number }; maxCells?: number } = {},
): { cells: string[]; truncated: boolean } {
  const { bounds, maxCells = Infinity } = opts;
  const inBounds = (x: number, y: number) =>
    x >= 0 && y >= 0 && x <= MAX_BUILD_COORD && y <= MAX_BUILD_COORD && (!bounds || (x < bounds.w && y < bounds.h));
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  if (!inBounds(sx, sy) || !build.cells.has(cellId(sx, sy))) return { cells: [], truncated: false };

  const seen = new Set<number>([cellId(sx, sy)]);
  const cells: string[] = [];
  const queue: number[] = [sx, sy];
  let truncated = false;
  const visit = (nx: number, ny: number, edge: number) => {
    if (!inBounds(nx, ny)) return;
    const id = cellId(nx, ny);
    if (seen.has(id) || !build.cells.has(id) || blocksPassage(build.edges.get(edge))) return;
    seen.add(id);
    queue.push(nx, ny);
  };
  for (let head = 0; head < queue.length; head += 2) {
    const x = queue[head]!;
    const y = queue[head + 1]!;
    if (cells.length >= maxCells) {
      truncated = true;
      break;
    }
    cells.push(`${x},${y}`);
    // Each neighbor, with the edge between it and this cell.
    visit(x + 1, y, edgeId(x + 1, y, "w"));
    visit(x - 1, y, edgeId(x, y, "w"));
    visit(x, y + 1, edgeId(x, y + 1, "n"));
    visit(x, y - 1, edgeId(x, y, "n"));
  }
  return { cells, truncated };
}

/**
 * The room under a point on a hex scene for "reveal room"
 * (docs/design-v1-hex-grids.md HX-D10, phase H3): the scene's hexes
 * reachable from the one holding the point, a step between two neighbors
 * blocked where a movement wall touches the line between their centers. So
 * walls, windows, closed and locked doors, and secret doors not yet found
 * bound a room, as they stop a creature's step (HX-D8). Touching counts, as
 * it does there, so two walls whose ends only meet on that line still
 * close it. A hex scene has no painted floor, so only its walls and its
 * edge bound a room, and a room open to the edge runs to it. Empty when the
 * point holds no hex of the scene. Stops after `maxCells` hexes and reports
 * `truncated`. Hexes come back as `"col,row"` keys, the form a hex scene's
 * fog cells take.
 */
export function floodHexRoom(
  walls: WallSet,
  g: HexGrid,
  bounds: { w: number; h: number },
  start: Point,
  opts: { maxCells?: number } = {},
): { cells: string[]; truncated: boolean } {
  const { maxCells = Infinity } = opts;
  const first = hexAt(g, start);
  if (!hexInScene(g, bounds, first)) return { cells: [], truncated: false };
  const index = walls.storedIndex;
  const xy = index.xy;
  // A scene's hex keys stay below MAX_BUILD_COORD on both axes, so one number names a hex.
  const id = (h: Hex) => h.col * (MAX_BUILD_COORD + 1) + h.row;
  const blocked = (a: Point, b: Point): boolean => {
    let hit = false;
    index.query(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), MOVEMENT, (k) => {
      if (!hit && contact(a.x, a.y, b.x, b.y, xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!) !== APART) hit = true;
    });
    return hit;
  };
  const seen = new Set<number>([id(first)]);
  const queue: Hex[] = [first];
  const cells: string[] = [];
  let truncated = false;
  for (let head = 0; head < queue.length; head++) {
    if (cells.length >= maxCells) {
      truncated = true;
      break;
    }
    const h = queue[head]!;
    cells.push(hexKey(h));
    const at = hexCenter(g, h);
    for (const n of hexNeighbors(g, h)) {
      if (seen.has(id(n)) || !hexInScene(g, bounds, n) || blocked(at, hexCenter(g, n))) continue;
      seen.add(id(n));
      queue.push(n);
    }
  }
  return { cells, truncated };
}

// ---------------------------------------------------------------------------
// The device's two tests of a piece (docs/design-v1-map-discovery.md 5.2)

/**
 * How far a piece may lie from the exact wall it was cut from: every point
 * of the exact stretch lies within 2/10000 cell of the piece sent, since
 * rounding moves each end at most 1/10000 cell per coordinate (decision 2).
 */
export const PIECE_BAND = 2 / 10_000;
/** How far from its ends a piece's band surely holds the exact wall: twice the band, past the rounding at either end. */
export const PIECE_END_MARGIN = 4 / 10_000;

/**
 * The preview test (ASTRA-30): whether a core of half sides (hx, hy) swept
 * from P to Q comes within PIECE_BAND of the piece AB, its ends included.
 * For what has no server check after it (area rays, caught lists, rings,
 * walking rulers, a drag's drawn path, words shown before sending), so a
 * T-junction on a tilted piece stays closed and a crossing that rounds to
 * a corner touch still blocks. The core grows by the band on each side,
 * which holds every point within the band of the exact sweep.
 */
export function pieceTouches(px: number, py: number, qx: number, qy: number, hx: number, hy: number, ax: number, ay: number, bx: number, by: number): boolean {
  return sweptTouches(px, py, qx, qy, hx + PIECE_BAND, hy + PIECE_BAND, ax, ay, bx, by);
}

/**
 * The gate test (ASTRA-34): whether the swept core crosses the piece's
 * band clear through, more than PIECE_END_MARGIN from its ends, where the
 * exact wall surely blocks: it meets both lines PIECE_BAND either side of
 * the piece within that span. The exact wall runs the whole span inside
 * the band, and a convex sweep meeting both of the band's sides there
 * holds a segment from one to the other, which crosses it. For an action
 * sent to the server, so the device never refuses, shortens or withholds
 * what the exact walls allow: within the band it sends, and the server's
 * landing decides. The offsets are rounded doubles, kept a hair outside
 * the band, so rounding only makes the test pass more.
 */
export function pieceBlocks(px: number, py: number, qx: number, qy: number, hx: number, hy: number, ax: number, ay: number, bx: number, by: number): boolean {
  const ex = bx - ax;
  const ey = by - ay;
  const len = Math.hypot(ex, ey);
  if (!(len > 2 * PIECE_END_MARGIN)) return false;
  const ux = ex / len;
  const uy = ey / len;
  const off = PIECE_BAND * (1 + 1e-9);
  const sx = ax + ux * PIECE_END_MARGIN;
  const sy = ay + uy * PIECE_END_MARGIN;
  const tx = bx - ux * PIECE_END_MARGIN;
  const ty = by - uy * PIECE_END_MARGIN;
  const nx = -uy * off;
  const ny = ux * off;
  return sweptTouches(px, py, qx, qy, hx, hy, sx + nx, sy + ny, tx + nx, ty + ny) && sweptTouches(px, py, qx, qy, hx, hy, sx - nx, sy - ny, tx - nx, ty - ny);
}

/** Whether stored segment `k` of a set is a held build's piece, which the device tests by pieceTouches or pieceBlocks rather than exactly. */
export function isPiece(walls: WallSet, k: number): boolean {
  return walls.stored.free[k] === PIECE;
}
