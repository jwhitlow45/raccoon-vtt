import { holderTileKey, tileKey } from "../keys.ts";
import { CHUNK_CELLS, FOG_SUBCELLS, FREE_WALL_LATTICE, type FogTile, type FreeWall, type RoomState, type Scene, type SightTile } from "../model.ts";
import { visionRules, type PartySight, type SightProbe } from "../ruleHooks.ts";
import { decodeTile, getBit, TILE_CELLS, TILE_SUB } from "./fog.ts";
import { placedOnHex, type CellRange } from "./footprint.ts";
import type { Point } from "./geom.ts";
import { isHex, sceneGrid, type Grid } from "./grid.ts";
import { cornerAt, hexAt, hexCorners, hexInScene, hexKey, hexNeighbors, hexSubcells, parseHexKey, type Hex, type HexGrid } from "./hex.ts";
import { seenFogBits } from "./vision.ts";

/*
 * What a player holds of a scene's build (docs/design-v1-map-discovery.md
 * 5.1, 5.2 and decision 1), read by the projection, the touch rule's words
 * and the area rule (decision 13), so all three read one ground.
 *
 * A viewer reads by their fog class (5.6): a sight holder on a per-player
 * scene alone, and every other player and table display together. Their
 * ground has three layers, each by fog sub-cell:
 * - held: revealed in the fog the class gets, the DM's layer, the party's
 *   explored layer and a holder's own merged.
 * - live: in the class's sight or revealed by the DM, on the players' scene
 *   outside a blackout. On a scene with fog on and party vision off every
 *   held sub-cell is live, since only memory makes ground not live, and
 *   memory needs vision. With fog off everything is held and live.
 * - own: a holder's own explored layer alone, which decides whose memory an
 *   element reads (decision 6). Empty for the shared class.
 *
 * A cell is held, live or own when any of its sub-cells is, a hex by the
 * sub-cells inside it (HX-D10). Only cells inside the scene count, so
 * stale bits past a shrunk scene's side hold nothing.
 */

const SUB = FOG_SUBCELLS;
const CELLS_PER_TILE = TILE_CELLS * TILE_CELLS;

/** A viewer's ground on one scene. */
export type Ground = {
  readonly sceneId: string;
  readonly grid: Grid;
  readonly bounds: { readonly w: number; readonly h: number };
  /** Whether the scene withholds anything: its fog is on. */
  readonly fogged: boolean;
  /** Whether the scene keeps memory: fog and party vision on (5.1). */
  readonly remembers: boolean;
  /** The sight holder whose own layer counts, or null for the shared class. */
  readonly holder: string | null;
  subHeld(sx: number, sy: number): boolean;
  subLive(sx: number, sy: number): boolean;
  /** A square cell, by its coordinates. Each answers false outside the scene. */
  held(x: number, y: number): boolean;
  live(x: number, y: number): boolean;
  own(x: number, y: number): boolean;
  /** A cell by its key on the scene's own grid: `"x,y"` on squares, a hex key on hexes. */
  keyHeld(key: string): boolean;
  keyLive(key: string): boolean;
  keyOwn(key: string): boolean;
  /**
   * A tile's cells in one layer as a short text, one bit a cell, the same
   * for tiles whose cells are the same whatever their sub-cells: `live` is
   * the class's sight and the DM's reveals before they are cut to held
   * ground. For keys of what a square position reads (project.ts memoKey).
   */
  cellsKey(layer: "held" | "live" | "own", tx: number, ty: number): string;
  /** Any square cell of a range, as labels and stamps are judged on every grid. */
  rangeHeld(r: CellRange): boolean;
  rangeLive(r: CellRange): boolean;
  rangeOwn(r: CellRange): boolean;
};

/** Whether a member sees for themselves on a scene (docs/design-v1-per-player-vision.md 6.1). */
export function holdsOwnSight(state: RoomState, sceneId: string, memberId: string): boolean {
  if (state.scenes[sceneId]?.vision?.perPlayer !== true || state.members[memberId]?.kind !== "player") return false;
  return state.holders?.[sceneId]?.entries.some((e) => e.on && e.memberId === memberId) === true;
}

/** A viewer's fog class on a scene (5.6): their own member id when they see for themselves there, else null, the shared class. */
export function fogClassOf(state: RoomState, sceneId: string, memberId: string): string | null {
  return holdsOwnSight(state, sceneId, memberId) ? memberId : null;
}

/*
 * Decoded bits and per-cell masks, kept for the life of the tile objects,
 * which are replaced and never changed. A projection reads each tile for
 * every chunk, label and stamp on it, and every class shares the DM's.
 */
const decoded = new WeakMap<FogTile, Uint8Array | null>();
const seenBits = new WeakMap<SightTile, Uint8Array>();
const masks = new WeakMap<Uint8Array, Uint8Array>();
type Chain = { next: WeakMap<object, Chain>; bits?: Uint8Array | null };
const chains = new WeakMap<object, Chain>();

function fogBits(tile: FogTile | undefined): Uint8Array | null {
  if (!tile) return null;
  let bits = decoded.get(tile);
  if (bits === undefined) decoded.set(tile, (bits = decodeTile(tile.bits)));
  return bits;
}

function sightBits(tile: SightTile | undefined): Uint8Array | null {
  if (!tile) return null;
  let bits = seenBits.get(tile);
  if (!bits) seenBits.set(tile, (bits = seenFogBits(tile)));
  return bits;
}

/** The union of some layers' bits, kept per sequence of layer objects, or null where none holds the tile. */
function unionOf(parts: readonly (object | undefined)[], bitsOf: (part: object) => Uint8Array | null): Uint8Array | null {
  const present = parts.filter((p): p is object => p !== undefined);
  if (present.length === 0) return null;
  if (present.length === 1) return bitsOf(present[0]!);
  let node: Chain | undefined;
  for (const part of present) {
    const level = node ? node.next : chains;
    let next = level.get(part);
    if (!next) level.set(part, (next = { next: new WeakMap() }));
    node = next;
  }
  if (node!.bits === undefined) {
    let out: Uint8Array | null = null;
    for (const part of present) {
      const b = bitsOf(part);
      if (!b) continue;
      if (!out) out = new Uint8Array(b);
      else for (let i = 0; i < out.length; i++) out[i] = out[i]! | b[i]!;
    }
    node!.bits = out;
  }
  return node!.bits;
}

/** One byte per cell of a tile, 1 where any of its sub-cells is set. */
function cellMask(bits: Uint8Array): Uint8Array {
  let mask = masks.get(bits);
  if (mask) return mask;
  mask = new Uint8Array(CELLS_PER_TILE);
  for (let cy = 0; cy < TILE_CELLS; cy++) {
    for (let cx = 0; cx < TILE_CELLS; cx++) {
      let any = 0;
      for (let sy = 0; sy < SUB && any === 0; sy++) for (let sx = 0; sx < SUB; sx++) if (getBit(bits, cx * SUB + sx, cy * SUB + sy)) any = 1;
      mask[cy * TILE_CELLS + cx] = any;
    }
  }
  masks.set(bits, mask);
  return mask;
}

const maskTexts = new WeakMap<Uint8Array, string>();

/** A cell mask as text, 16 bits a character, kept per mask. */
function maskText(mask: Uint8Array): string {
  let text = maskTexts.get(mask);
  if (text === undefined) {
    const codes: number[] = [];
    for (let i = 0; i < mask.length; i += 16) {
      let code = 0;
      for (let j = 0; j < 16; j++) code = (code << 1) | (mask[i + j] ?? 0);
      codes.push(code);
    }
    maskTexts.set(mask, (text = String.fromCharCode(...codes)));
  }
  return text;
}

/** A layer of the ground: the bits of each tile, looked up once per tile. */
type Layer = (tx: number, ty: number) => Uint8Array | null;

function cached(read: Layer): Layer {
  const seen = new Map<number, Uint8Array | null>();
  return (tx, ty) => {
    const at = ty * 4096 + tx;
    let bits = seen.get(at);
    if (bits === undefined) seen.set(at, (bits = read(tx, ty)));
    return bits;
  };
}

const NONE: Layer = () => null;

/**
 * The sight a class reads on a scene, where sight makes ground live: the
 * players' scene with party vision on, outside a blackout. A holder's own
 * on a per-player scene, the shared sight for everyone else there, and the
 * party's on a whole-party scene.
 */
export function classSight(state: RoomState, scene: Scene, holder: string | null): PartySight | null {
  if (scene.vision?.on !== true || state.meta.playerSceneId !== scene.id || state.meta.view?.blackout === true) return null;
  if (scene.vision.perPlayer === true) return visionRules.holderSight(state, scene.id, holder);
  return visionRules.partySight(state, scene.id);
}

/**
 * The ground of a fog class on a scene of the server's state, or null for
 * a scene the state lacks. `holder` is a sight holder's member id, or null
 * for the shared class (fogClassOf).
 */
export function groundOf(state: RoomState, sceneId: string, holder: string | null): Ground | null {
  return groundWith(state, sceneId, holder, true);
}

/**
 * The ground a ray test inside the reducer reads (decision 13, MD2-O-3):
 * groundOf's, but live ground is the class's sight and the DM's reveals
 * as they are, not cut to held ground. Ground an op brings into sight is
 * not explored until the explore step that follows the batch, which writes
 * exactly this sight into the class's layers, so the projections that read
 * the line then hold it. Never for a projection.
 */
export function pendingGround(state: RoomState, sceneId: string, holder: string | null): Ground | null {
  return groundWith(state, sceneId, holder, false);
}

function groundWith(state: RoomState, sceneId: string, holder: string | null, liveInsideHeld: boolean): Ground | null {
  const scene = state.scenes[sceneId];
  if (!scene) return null;
  const own = holder !== null && holdsOwnSight(state, sceneId, holder) ? holder : null;
  const held: Layer = cached((tx, ty) => {
    const key = tileKey(sceneId, tx, ty);
    const parts = [state.fogTiles[key], state.exploredTiles?.[key], own === null ? undefined : state.exploredBy?.[holderTileKey(sceneId, own, tx, ty)]];
    return unionOf(parts, (p) => fogBits(p as FogTile));
  });
  const ownLayer: Layer = own === null ? NONE : cached((tx, ty) => fogBits(state.exploredBy?.[holderTileKey(sceneId, own, tx, ty)]));
  let live: Layer;
  let asked: PointLive | undefined;
  const remembers = scene.fogEnabled && scene.vision?.on === true;
  if (!remembers) live = held;
  else {
    const sight = classSight(state, scene, own);
    live = cached((tx, ty) => {
      const dm = state.fogTiles[tileKey(sceneId, tx, ty)];
      const seen = sight?.tiles.get(`${tx},${ty}`);
      return unionOf([dm, seen], (p) => (p === dm ? fogBits(p as FogTile) : sightBits(p as SightTile)));
    });
    /*
     * A ray test runs at each moment of a sweep or a routed walk, on states
     * whose holders' rasters no projection reads. Asked of the point query,
     * a cell's sight costs its own sub-cells, not every holder's raster
     * drawn at every moment.
     */
    if (!liveInsideHeld) asked = { dm: cached((tx, ty) => fogBits(state.fogTiles[tileKey(sceneId, tx, ty)])), sight };
  }
  return makeGround(scene, own, held, live, ownLayer, liveInsideHeld, asked);
}

/**
 * Live cells asked of the sight's point query (PartySight.seesToken),
 * beside the DM's reveals, in place of the live layer's tiles. The answers
 * are the layer's: a cell or a hex is live where any of its sub-cells is,
 * and the point query reads the very sub-cells the sight's tiles hold.
 * Single sub-cells still read the tiles.
 */
type PointLive = { dm: Layer; sight: PartySight | null };

/** The point query's probe of one hex: a Medium creature standing on it, which stands on that hex alone. */
function hexProbe(grid: HexGrid, hx: Hex): SightProbe {
  return { size: "medium", ...placedOnHex(grid, { size: "medium", x: 0, y: 0 }, hx) };
}

/**
 * The ground a player's own device reads from its copy of the room
 * (docs/design-v1-map-discovery.md 6, the device's live ground): its fog
 * is the held layer, with fog on and vision off all of it is live, and
 * with both on only its sight is, since its fog merges the DM's reveals
 * into explored ground (ASTRA-28). The server's live ground holds this
 * one, so a device can only predict too little of it.
 */
export function deviceGround(view: RoomState & { sight?: Readonly<Record<string, SightTile>> }, sceneId: string): Ground | null {
  const scene = view.scenes[sceneId];
  if (!scene) return null;
  const held: Layer = cached((tx, ty) => fogBits(view.fogTiles[tileKey(sceneId, tx, ty)]));
  const remembers = scene.fogEnabled && scene.vision?.on === true;
  const sight = view.sight ?? {};
  const live: Layer = remembers ? cached((tx, ty) => sightBits(sight[tileKey(sceneId, tx, ty)])) : held;
  return makeGround(scene, null, held, live, NONE);
}

function makeGround(scene: Scene, holder: string | null, heldLayer: Layer, liveLayer: Layer, ownLayer: Layer, liveInsideHeld = true, asked?: PointLive): Ground {
  const grid = sceneGrid(scene);
  const { w, h } = scene.bounds;
  const fogged = scene.fogEnabled;
  const sub = (layer: Layer) => (sx: number, sy: number) => {
    if (!fogged) return true;
    if (sx < 0 || sy < 0) return false;
    const tx = Math.floor(sx / TILE_SUB);
    const ty = Math.floor(sy / TILE_SUB);
    const bits = layer(tx, ty);
    return bits !== null && getBit(bits, sx - tx * TILE_SUB, sy - ty * TILE_SUB);
  };
  const square = (layer: Layer, all: boolean) => (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (all) return true;
    const tx = Math.floor(x / TILE_CELLS);
    const ty = Math.floor(y / TILE_CELLS);
    const bits = layer(tx, ty);
    return bits !== null && cellMask(bits)[(y - ty * TILE_CELLS) * TILE_CELLS + (x - tx * TILE_CELLS)] === 1;
  };
  const hexOf = (layer: Layer, all: boolean) => {
    const test = sub(layer);
    return (hx: Hex) => hexInScene(grid as HexGrid, scene.bounds, hx) && (all || hexSubcells(grid as HexGrid, hx).some(([sx, sy]) => test(sx, sy)));
  };
  const keyed = (cell: (x: number, y: number) => boolean, hex: (hx: Hex) => boolean) => {
    if (!isHex(grid)) {
      // Read without splitting, since a projection asks this of every cell and edge it holds.
      return (key: string) => {
        const comma = key.indexOf(",");
        const x = Number(key.slice(0, comma));
        const y = Number(key.slice(comma + 1));
        return comma > 0 && Number.isInteger(x) && Number.isInteger(y) && cell(x, y);
      };
    }
    return (key: string) => {
      const hx = parseHexKey(key);
      return hx !== null && hex(hx);
    };
  };
  const byKey = (layer: Layer, all: boolean) => keyed(square(layer, all), hexOf(layer, all));
  const range = (cell: (x: number, y: number) => boolean) => (r: CellRange) => {
    for (let y = Math.max(0, r.y0); y < Math.min(h, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(w, r.x1); x++) if (cell(x, y)) return true;
    return false;
  };
  // Asked only where fog is on (groundWith), so no cell is live for want of fog.
  const askedSquare = ({ dm, sight }: PointLive) => {
    const dmCell = square(dm, false);
    // The point query reads only sub-cells on the scene, so a cell off it is never seen.
    return (x: number, y: number) => dmCell(x, y) || (sight !== null && sight.seesToken({ size: "medium", x, y }, grid));
  };
  const askedHex = ({ dm, sight }: PointLive) => {
    const dmHex = hexOf(dm, false);
    return (hx: Hex) => dmHex(hx) || (sight !== null && hexInScene(grid as HexGrid, scene.bounds, hx) && sight.seesToken(hexProbe(grid as HexGrid, hx), grid));
  };
  // Live ground is held ground: sight the explore step has not added to the explored layer yet holds nothing.
  const held = square(heldLayer, !fogged);
  const liveOnly = asked ? askedSquare(asked) : square(liveLayer, !fogged);
  const live = (x: number, y: number) => liveOnly(x, y) && (!liveInsideHeld || held(x, y));
  const own = square(ownLayer, false);
  const subHeld = sub(heldLayer);
  const subLiveOnly = sub(liveLayer);
  const keyHeld = byKey(heldLayer, !fogged);
  const keyLiveOnly = asked ? keyed(liveOnly, askedHex(asked)) : byKey(liveLayer, !fogged);
  const layerOf = { held: heldLayer, live: liveLayer, own: ownLayer };
  const cellsKey = (layer: "held" | "live" | "own", tx: number, ty: number): string => {
    if (!fogged) return "all";
    const bits = layerOf[layer](tx, ty);
    return bits === null ? "" : maskText(cellMask(bits));
  };
  return {
    sceneId: scene.id,
    grid,
    bounds: scene.bounds,
    fogged,
    remembers: fogged && scene.vision?.on === true,
    holder,
    subHeld,
    subLive: (sx, sy) => subLiveOnly(sx, sy) && (!liveInsideHeld || subHeld(sx, sy)),
    held,
    live,
    own: holder === null ? () => false : own,
    keyHeld,
    keyLive: (key) => keyLiveOnly(key) && (!liveInsideHeld || keyHeld(key)),
    keyOwn: holder === null ? () => false : byKey(ownLayer, false),
    cellsKey,
    rangeHeld: range(held),
    rangeLive: range(live),
    rangeOwn: holder === null ? () => false : range(own),
  };
}

/**
 * Whether every cell of the scene on its own grid, a square or a hex, that
 * a closed convex polygon touches lies on live ground, a hair past
 * touching included, so rounding only ever answers no (decisions 11 and
 * 13). `hull` is in cells and in order round it (aoe.ts convexHull), and
 * may be a segment or a point. Cells off the scene hold nothing to hide,
 * so the search is clipped to the scene's box first: a hull reaching far
 * past the scene, as from an area's origin stored anywhere, costs no more
 * than the scene (MD2-ASTRA-7). `work`, for tests, counts the cells and
 * grid points visited.
 */
export function convexLive(ground: Ground, hull: readonly Point[], work?: { n: number }): boolean {
  if (hull.length === 0) return true;
  const E = 1e-9;
  const xs = hull.map((p) => p.x);
  const ys = hull.map((p) => p.y);
  // Every cell of the scene, hexes included (hex.ts hexInScene), lies inside its box.
  const x0 = Math.max(Math.min(...xs) - E, -E);
  const y0 = Math.max(Math.min(...ys) - E, -E);
  const x1 = Math.min(Math.max(...xs) + E, ground.bounds.w + E);
  const y1 = Math.min(Math.max(...ys) + E, ground.bounds.h + E);
  if (x0 > x1 || y0 > y1) return true;
  if (!isHex(ground.grid)) {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(ground.bounds.h - 1, Math.floor(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(ground.bounds.w - 1, Math.floor(x1)); x++) {
        if (work) work.n++;
        if (!ground.live(x, y) && convexMeet(hull, [{ x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 }], E)) return false;
      }
    }
    return true;
  }
  // Every hex the clipped box reaches: a point of the box lies within 0.36 cell of a point of a half-cell grid over it,
  // so the hex holding that grid point is its own or a neighbor (centers 1 apart, the next ring 1.73).
  const grid = ground.grid as HexGrid;
  const near = new Map<string, Hex>();
  const step = 0.5;
  for (let y = y0; y <= y1 + step; y += step) {
    for (let x = x0; x <= x1 + step; x += step) {
      if (work) work.n++;
      const at = hexAt(grid, { x: Math.min(x, x1), y: Math.min(y, y1) });
      for (const hx of [at, ...hexNeighbors(grid, at)]) near.set(hexKey(hx), hx);
    }
  }
  for (const [key, hx] of near) {
    if (!hexInScene(grid, ground.bounds, hx) || ground.keyLive(key)) continue;
    if (convexMeet(hull, hexCorners(grid, hx).map((c) => cornerAt(grid, c)), E)) return false;
  }
  return true;
}

/* The separating axis test of two convex polygons in order (or a segment or a point), each grown by `e`. */
function convexMeet(a: readonly Point[], b: readonly Point[], e: number): boolean {
  const separated = (nx: number, ny: number) => {
    const len = Math.hypot(nx, ny);
    if (len === 0) return false;
    let aLo = Infinity;
    let aHi = -Infinity;
    let bLo = Infinity;
    let bHi = -Infinity;
    for (const p of a) {
      const v = (p.x * nx + p.y * ny) / len;
      aLo = Math.min(aLo, v);
      aHi = Math.max(aHi, v);
    }
    for (const p of b) {
      const v = (p.x * nx + p.y * ny) / len;
      bLo = Math.min(bLo, v);
      bHi = Math.max(bHi, v);
    }
    return aHi + 2 * e < bLo || bHi + 2 * e < aLo;
  };
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      if (separated(q.y - p.y, p.x - q.x)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Free walls cut at held cells (decision 2, 5.2)

/*
 * The geometry works in lattice units (cells times 64), where every stored
 * wall end and every hex corner (hex.ts cornerAt) is a whole number below
 * 2^16 and a free wall spans at most 512 along each axis. A point along a
 * wall from A to B is A + t (B - A) with t a ratio n / d of whole numbers:
 * crossings of a square's side have d at most 512, crossings of a hex's
 * side at most about 2^16, so every product below stays exact in doubles.
 */
const LAT = FREE_WALL_LATTICE;

/** A ratio n / d with d > 0. */
type Ratio = { n: number; d: number };

function less(a: Ratio, b: Ratio): boolean {
  return a.n * b.d < b.n * a.d;
}

function same(a: Ratio, b: Ratio): boolean {
  return a.n * b.d === b.n * a.d;
}

function ratio(n: number, d: number): Ratio {
  return d < 0 ? { n: -n, d: -d } : { n, d };
}

/** Floor of n / d for whole numbers, exact (d > 0). */
function floorDiv(n: number, d: number): number {
  let q = Math.floor(n / d);
  if (q * d > n) q--;
  else if ((q + 1) * d <= n) q++;
  return q;
}

/** One stretch of a free wall inside one cell's closure, by its parameters along the wall, t0 < t1. */
export type Span = { readonly cell: string; readonly t0: Ratio; readonly t1: Ratio };

const spansBySquares = new WeakMap<object, Span[]>();
const spansByHexes = new WeakMap<object, Map<string, Span[]>>();

/**
 * The cells a free wall crosses, each with the stretch of the wall inside
 * the cell's closure, in order along the wall. A stretch along a grid line
 * lies in both cells beside it. A touch at a single point is no stretch.
 * Kept per wall object, which is replaced and never changed.
 */
export function wallSpans(grid: Grid, wall: Pick<FreeWall, "a" | "b">): readonly Span[] {
  if (!isHex(grid)) {
    let hit = spansBySquares.get(wall);
    if (!hit) spansBySquares.set(wall, (hit = squareSpans(wall)));
    return hit;
  }
  let byGrid = spansByHexes.get(wall);
  if (!byGrid) spansByHexes.set(wall, (byGrid = new Map()));
  let hit = byGrid.get(grid.orient);
  if (!hit) byGrid.set(grid.orient, (hit = hexSpans(grid, wall)));
  return hit;
}

function latticeEnds(wall: Pick<FreeWall, "a" | "b">): [number, number, number, number] {
  return [Math.round(wall.a[0] * LAT), Math.round(wall.a[1] * LAT), Math.round(wall.b[0] * LAT), Math.round(wall.b[1] * LAT)];
}

function squareSpans(wall: Pick<FreeWall, "a" | "b">): Span[] {
  const [ax, ay, bx, by] = latticeEnds(wall);
  const ex = bx - ax;
  const ey = by - ay;
  if (ex === 0 && ey === 0) return [];
  const ts: Ratio[] = [ratio(0, 1), ratio(1, 1)];
  const crossings = (a: number, e: number) => {
    if (e === 0) return;
    const lo = Math.min(a, a + e);
    const hi = Math.max(a, a + e);
    for (let k = Math.floor(lo / LAT) + 1; k * LAT < hi; k++) ts.push(ratio(k * LAT - a, e));
  };
  crossings(ax, ex);
  crossings(ay, ey);
  ts.sort((p, q) => p.n * q.d - q.n * p.d);
  const out: Span[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i]!;
    const t1 = ts[i + 1]!;
    if (!less(t0, t1)) continue;
    // The stretch's midpoint, exact: its cell is the one the open stretch lies in, or the two beside a grid line it runs along.
    const md = 2 * t0.d * t1.d;
    const mn = t0.n * t1.d + t1.n * t0.d;
    const cellOf = (a: number, e: number) => floorDiv(a * md + e * mn, md * LAT);
    const onLine = (a: number, e: number) => e === 0 && a % LAT === 0;
    const xs = onLine(ax, ex) ? [ax / LAT - 1, ax / LAT] : [cellOf(ax, ex)];
    const ys = onLine(ay, ey) ? [ay / LAT - 1, ay / LAT] : [cellOf(ay, ey)];
    for (const y of ys) for (const x of xs) out.push({ cell: `${x},${y}`, t0, t1 });
  }
  return out;
}

/** A hex's corners in lattice units, in order round it. */
function hexPolygon(grid: HexGrid, hex: Hex): [number, number][] {
  return hexCorners(grid, hex).map((c) => {
    const p = cornerAt(grid, c);
    return [Math.round(p.x * LAT), Math.round(p.y * LAT)] as [number, number];
  });
}

function hexSpans(grid: HexGrid, wall: Pick<FreeWall, "a" | "b">): Span[] {
  const [ax, ay, bx, by] = latticeEnds(wall);
  const ex = bx - ax;
  const ey = by - ay;
  if (ex === 0 && ey === 0) return [];
  // Every hex near the wall: those the points along it fall in, and their neighbors, so one it only grazes is tried too.
  const near = new Map<string, Hex>();
  const steps = Math.ceil(Math.max(Math.abs(ex), Math.abs(ey)) / (LAT / 4)) + 1;
  for (let i = 0; i <= steps; i++) {
    const p = { x: (ax + (ex * i) / steps) / LAT, y: (ay + (ey * i) / steps) / LAT };
    const at = hexAt(grid, p);
    for (const hx of [at, ...hexNeighbors(grid, at)]) near.set(hexKey(hx), hx);
  }
  const out: { span: Span; at: Ratio }[] = [];
  for (const [key, hx] of near) {
    const clip = clipToPolygon(ax, ay, ex, ey, hexPolygon(grid, hx));
    if (clip) out.push({ span: { cell: key, t0: clip[0], t1: clip[1] }, at: clip[0] });
  }
  out.sort((p, q) => p.at.n * q.at.d - q.at.n * p.at.d || (p.span.cell < q.span.cell ? -1 : p.span.cell > q.span.cell ? 1 : 0));
  return out.map((o) => o.span);
}

/** The exact stretch of A + t E, t in [0, 1], inside a closed convex polygon, or null when it is a point or nothing (Cyrus-Beck). */
function clipToPolygon(ax: number, ay: number, ex: number, ey: number, poly: readonly [number, number][]): [Ratio, Ratio] | null {
  const n = poly.length;
  let turn = 0;
  for (let i = 0; i < n && turn === 0; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % n]!;
    const [x2, y2] = poly[(i + 2) % n]!;
    turn = Math.sign((x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1));
  }
  let lo = ratio(0, 1);
  let hi = ratio(1, 1);
  for (let i = 0; i < n; i++) {
    const [cx, cy] = poly[i]!;
    const [dx, dy] = poly[(i + 1) % n]!;
    const sx = dx - cx;
    const sy = dy - cy;
    // Inside the side: turn * cross(side, P - C) >= 0, with P = A + t E.
    const alpha = turn * (sx * (ay - cy) - sy * (ax - cx));
    const beta = turn * (sx * ey - sy * ex);
    if (beta === 0) {
      if (alpha < 0) return null;
      continue;
    }
    const t = ratio(-alpha, beta);
    if (beta > 0) {
      if (less(lo, t)) lo = t;
    } else if (less(t, hi)) hi = t;
  }
  return less(lo, hi) ? [lo, hi] : null;
}

/** The cells of the scene whose closure holds a lattice point (in lattice units): one, two beside a side, or the three or four at a corner. */
function cellsAt(grid: Grid, px: number, py: number): string[] {
  if (!isHex(grid)) {
    const xs = px % LAT === 0 ? [px / LAT - 1, px / LAT] : [Math.floor(px / LAT)];
    const ys = py % LAT === 0 ? [py / LAT - 1, py / LAT] : [Math.floor(py / LAT)];
    return ys.flatMap((y) => xs.map((x) => `${x},${y}`));
  }
  const at = hexAt(grid, { x: px / LAT, y: py / LAT });
  const out: string[] = [];
  for (const hx of [at, ...hexNeighbors(grid, at)]) {
    const poly = hexPolygon(grid, hx);
    let turn = 0;
    let inside = true;
    for (let i = 0; i < poly.length && inside; i++) {
      const [cx, cy] = poly[i]!;
      const [dx, dy] = poly[(i + 1) % poly.length]!;
      const c = Math.sign((dx - cx) * (py - cy) - (dy - cy) * (px - cx));
      if (c === 0) continue;
      if (turn === 0) turn = c;
      else if (c !== turn) inside = false;
    }
    if (inside) out.push(hexKey(hx));
  }
  return out;
}

/** What a piece is to players: a wall, or a window, which lets sight through. A hidden secret door reaches them as a wall. */
export type PieceKind = "wall" | "window";

/** One wall's stretch on one held cell, by the cut that chose it: the wall it lies on (lattice ends) and its parameters. */
export type CellPiece = { readonly a: readonly [number, number]; readonly b: readonly [number, number]; readonly t0: Ratio; readonly t1: Ratio; readonly kind: PieceKind };

/** A piece as players get it, ends in cells and rounded (decision 2), with the chunk position its midpoint files it under. */
export type Piece = { readonly a: [number, number]; readonly b: [number, number]; readonly kind: PieceKind; readonly cx: number; readonly cy: number };

/** The length of every world-anchored split's band, in cells (5.2). */
export const SPLIT_CELLS = 4;
/** The grid cut and rounded ends move to, per cell (decision 2). */
export const PIECE_GRID = 10_000;

/** An end along a line: the wall it was cut from and its parameter there. */
type End = { ax: number; ay: number; ex: number; ey: number; t: Ratio; stored: boolean };

function endX(e: End): Ratio {
  return { n: e.ax * e.t.d + e.t.n * e.ex, d: e.t.d };
}

function endY(e: End): Ratio {
  return { n: e.ay * e.t.d + e.t.n * e.ey, d: e.t.d };
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * Joins, splits and rounds the stretches the cut chose (decision 2, 5.2):
 * stretches on one line and of one kind that touch or overlap join into a
 * run, each run is split where it crosses the lines x = 4m, or y = 4m for
 * a run steeper than 45 degrees, and then every end on a cell's side or
 * corner, cut or stored alike, moves away from the piece's other end: each
 * coordinate to the next multiple of 1/10000 cell strictly past it, a
 * coordinate equal to the other end's staying and one that would leave
 * the scene clamped to its side (decision 2, D-261026-29 item 16). A
 * stored end strictly inside a cell stays exact, and a split inside a hex
 * moves like a cut. So the pieces depend only on the
 * stretches, whichever walls they came from, and no end on a side tells a
 * wall that stops there from one that runs on, past held ground or into
 * ground the player only remembers.
 */
export function joinPieces(stretches: readonly CellPiece[], ground: Pick<Ground, "grid" | "bounds" | "keyHeld">): Piece[] {
  type Run = { lo: End; hi: End };
  const lines = new Map<string, { major: "x" | "y"; runs: { lo: End; hi: End }[] }>();
  for (const s of stretches) {
    const ax = s.a[0];
    const ay = s.a[1];
    const ex = s.b[0] - ax;
    const ey = s.b[1] - ay;
    const g = gcd(ex, ey);
    let ux = ex / g;
    let uy = ey / g;
    if (ux < 0 || (ux === 0 && uy < 0)) {
      ux = -ux;
      uy = -uy;
    }
    const c = uy * ax - ux * ay;
    const key = `${ux},${uy},${c},${s.kind}`;
    const major = Math.abs(ux) >= Math.abs(uy) ? "x" : "y";
    let line = lines.get(key);
    if (!line) lines.set(key, (line = { major, runs: [] }));
    const stored = (t: Ratio) => t.n === 0 || t.n === t.d;
    let lo: End = { ax, ay, ex, ey, t: s.t0, stored: stored(s.t0) };
    let hi: End = { ax, ay, ex, ey, t: s.t1, stored: stored(s.t1) };
    const along = major === "x" ? endX : endY;
    if (less(along(hi), along(lo))) [lo, hi] = [hi, lo];
    line.runs.push({ lo, hi });
  }
  const out: Piece[] = [];
  for (const [key, line] of [...lines].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))) {
    const kind = key.slice(key.lastIndexOf(",") + 1) as PieceKind;
    const along = line.major === "x" ? endX : endY;
    const runs = line.runs.sort((p, q) => {
      const a = along(p.lo);
      const b = along(q.lo);
      return a.n * b.d - b.n * a.d;
    });
    const joined: Run[] = [];
    for (const r of runs) {
      const last = joined[joined.length - 1];
      if (last && !less(along(last.hi), along(r.lo))) {
        // Touching or overlapping: one run.
        if (less(along(last.hi), along(r.hi))) last.hi = r.hi;
        continue;
      }
      joined.push({ ...r });
    }
    for (const run of joined) for (const piece of splitRun(run.lo, run.hi, line.major)) out.push(rounded(piece[0], piece[1], kind, ground));
  }
  return out;
}

/** A run cut where it crosses the split lines strictly inside it, each cut a new end on the same wall. */
function splitRun(lo: End, hi: End, major: "x" | "y"): [End, End][] {
  const along = major === "x" ? endX : endY;
  const a = along(lo);
  const b = along(hi);
  const band = SPLIT_CELLS * LAT;
  const out: [End, End][] = [];
  let from = lo;
  // The first split line past the run's low end, in lattice units.
  for (let k = floorDiv(a.n, a.d * band) + 1; ; k++) {
    const at = { n: k * band, d: 1 };
    if (!less(at, b)) break;
    // The cut's parameter on the low end's wall: along that wall's major axis, a ratio of whole numbers again.
    const e = major === "x" ? lo.ex : lo.ey;
    const s = major === "x" ? lo.ax : lo.ay;
    const cut: End = { ...lo, t: ratio(k * band - s, e), stored: false };
    out.push([from, cut]);
    from = cut;
  }
  out.push([from, hi]);
  return out;
}

/** An end's coordinates moved outward per decision 2, or kept, in cells. */
function rounded(lo: End, hi: End, kind: PieceKind, ground: Pick<Ground, "grid" | "bounds" | "keyHeld">): Piece {
  const lx = endX(lo);
  const ly = endY(lo);
  const hx = endX(hi);
  const hy = endY(hi);
  // A cut lies on a cell's side by construction, so only a stored end, a lattice point that cellsAt tests exactly, needs the test. Cells off the scene count, so the scene's own side moves too. A split inside a hex moves for the byte bound.
  const moves = (e: End, x: Ratio, y: Ratio): boolean => !e.stored || cellsAt(ground.grid, x.n / x.d, y.n / y.d).length > 1;
  const exact = (v: Ratio) => v.n / (v.d * LAT);
  // The coordinate moved, in 1/10000 cells and exactly (v.n / (v.d * 64) * 10000), or null where it stays.
  const step = (v: Ratio, other: Ratio): number | null => {
    if (same(v, other)) return null;
    const n = v.n * PIECE_GRID;
    const d = v.d * LAT;
    return less(other, v) ? floorDiv(n, d) + 1 : -floorDiv(-n, d) - 1;
  };
  const { w, h } = ground.bounds;
  // Only a coordinate exactly on the scene's side can step out of it, so the clamp keeps that whole number and the coordinate on the 1/10000 grid.
  const coord = (v: Ratio, other: Ratio, side: number): number => {
    const s = step(v, other);
    return s === null ? exact(v) : Math.min(Math.max(s, 0), side * PIECE_GRID) / PIECE_GRID;
  };
  const end = (e: End, x: Ratio, y: Ratio, ox: Ratio, oy: Ratio): [number, number] => (moves(e, x, y) ? [coord(x, ox, w), coord(y, oy, h)] : [exact(x), exact(y)]);
  const a = end(lo, lx, ly, hx, hy);
  const b = end(hi, hx, hy, lx, ly);
  const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  return { a: p, b: q, kind, cx: Math.floor(mx / CHUNK_CELLS), cy: Math.floor(my / CHUNK_CELLS) };
}

/** A wall's lattice ends, for the cut. */
export function wallLattice(wall: Pick<FreeWall, "a" | "b">): { a: [number, number]; b: [number, number] } {
  const [ax, ay, bx, by] = latticeEnds(wall);
  return { a: [ax, ay], b: [bx, by] };
}
