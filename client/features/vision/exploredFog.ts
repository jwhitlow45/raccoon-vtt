import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { decodeTile, TILE_SUB } from "#shared/rules/fog.ts";
import { revealedMask } from "../../lib/fogTiles.ts";

/**
 * The party's explored ground as the DM sees it
 * (docs/design-v1-maps-vision.md section 4.3.3). A DM receives the two fog
 * layers apart: `fogTiles` is the DM's own, and `exploredTiles` is what the
 * party has seen. Players get them merged by the server. The DM's fog view
 * draws explored ground like revealed ground, with a dotted edge, so the DM
 * can tell what the party found from what the DM revealed.
 */

type Tiles = Readonly<Record<string, FogTile | undefined>>;

const merged = new WeakMap<Tiles, WeakMap<Tiles, Tiles>>();

/**
 * The tiles the DM's fog image draws: both layers. The fog mask only ever
 * adds what a tile reveals (lib/fogTiles.ts revealedMask), so a tile of
 * each layer at the same place, under keys of their own, draws as their
 * union without decoding anything here. The same two maps give the same
 * object, so the fog image is rebuilt only when a layer changes.
 */
export function withExplored(fogTiles: Tiles, exploredTiles: Tiles | undefined): Tiles {
  if (!exploredTiles || Object.keys(exploredTiles).length === 0) return fogTiles;
  let byExplored = merged.get(fogTiles);
  if (!byExplored) merged.set(fogTiles, (byExplored = new WeakMap()));
  let out = byExplored.get(exploredTiles);
  if (!out) {
    const both: Record<string, FogTile | undefined> = { ...fogTiles };
    for (const [key, tile] of Object.entries(exploredTiles)) both[`explored:${key}`] = tile;
    byExplored.set(exploredTiles, (out = both));
  }
  return out;
}

/**
 * The outline of ground only the party revealed: every sub-cell side
 * between a sub-cell the explored layer reveals and the DM's does not, and
 * one that is not such a sub-cell, as flat `[x0, y0, x1, y1, ...]` in cells.
 * Sides along the scene's edge are left out. Straight runs along a row or
 * a column come out as one segment.
 *
 * This works over the whole scene, and is the definition the map's
 * tile-by-tile ExploredOutline below is tested against.
 */
export function exploredOutline(bounds: { w: number; h: number }, sceneId: string, fogTiles: Tiles, exploredTiles: Tiles | undefined): number[] {
  const out: number[] = [];
  if (!exploredTiles) return out;
  // Only the tiles the explored layer holds can have an outline, plus one sub-cell around them.
  let tx0 = Infinity;
  let ty0 = Infinity;
  let tx1 = -Infinity;
  let ty1 = -Infinity;
  for (const tile of Object.values(exploredTiles)) {
    if (!tile || tile.sceneId !== sceneId || !Number.isInteger(tile.tx) || !Number.isInteger(tile.ty)) continue;
    tx0 = Math.min(tx0, tile.tx);
    ty0 = Math.min(ty0, tile.ty);
    tx1 = Math.max(tx1, tile.tx);
    ty1 = Math.max(ty1, tile.ty);
  }
  if (tx0 === Infinity) return out;
  const dm = revealedMask(bounds, sceneId, fogTiles);
  const explored = revealedMask(bounds, sceneId, exploredTiles);
  const { width, height } = dm;
  const only = new Uint8Array(width * height);
  for (let i = 0; i < only.length; i++) only[i] = explored.revealed[i]! & (dm.revealed[i]! ^ 1);

  const x0 = Math.max(0, tx0 * TILE_SUB - 1);
  const y0 = Math.max(0, ty0 * TILE_SUB - 1);
  const x1 = Math.min(width, (tx1 + 1) * TILE_SUB + 1);
  const y1 = Math.min(height, (ty1 + 1) * TILE_SUB + 1);
  const at = (x: number, y: number) => only[y * width + x]!;
  const s = 1 / FOG_SUBCELLS;

  // Horizontal sides: between row y - 1 and row y.
  for (let y = Math.max(1, y0); y < y1; y++) {
    let start = -1;
    for (let x = x0; x <= x1; x++) {
      const side = x < x1 && at(x, y - 1) !== at(x, y);
      if (side && start < 0) start = x;
      if (!side && start >= 0) {
        out.push(start * s, y * s, x * s, y * s);
        start = -1;
      }
    }
  }
  // Vertical sides: between column x - 1 and column x.
  for (let x = Math.max(1, x0); x < x1; x++) {
    let start = -1;
    for (let y = y0; y <= y1; y++) {
      const side = y < y1 && at(x - 1, y) !== at(x, y);
      if (side && start < 0) start = y;
      if (!side && start >= 0) {
        out.push(x * s, start * s, x * s, y * s);
        start = -1;
      }
    }
  }
  return out;
}

type Only = Uint8Array;
const NO_DM_TILE = {};

/** One explored tile's outline, with the inputs it was worked out from. */
type TileOutline = { only: Only; left: Only | null; top: Only | null; right: boolean; below: boolean; lines: number[] };

/**
 * exploredOutline kept up to date a tile at a time, for the DM's map. The
 * party explores on most moves, and working the outline out over the whole
 * scene took several milliseconds on a large one, so each explored tile
 * keeps its own piece and works it out again only when it or a neighbor it
 * borders changes. A tile draws its own sides, its left and top borders,
 * and its right and bottom borders where no explored tile lies beyond.
 */
export class ExploredOutline {
  private readonly sceneId: string;
  private readonly width: number;
  private readonly height: number;
  private readonly onlyCache = new WeakMap<object, WeakMap<object, Only>>();
  private readonly tiles = new Map<string, TileOutline>();

  constructor(bounds: { w: number; h: number }, sceneId: string) {
    this.sceneId = sceneId;
    this.width = bounds.w * FOG_SUBCELLS;
    this.height = bounds.h * FOG_SUBCELLS;
  }

  /** The outline for these layers, a piece per explored tile, each flat `[x0, y0, x1, y1, ...]` in cells. */
  update(fogTiles: Tiles, exploredTiles: Tiles | undefined): (readonly number[])[] {
    const explored = this.byPlace(exploredTiles);
    const dm = this.byPlace(fogTiles);
    const only = new Map<string, Only>();
    for (const [at, tile] of explored) only.set(at, this.onlyOf(tile, dm.get(at)));
    const out: (readonly number[])[] = [];
    const next = new Map<string, TileOutline>();
    for (const at of explored.keys()) {
      const [tx, ty] = at.split(",").map(Number) as [number, number];
      const inputs = {
        only: only.get(at)!,
        left: only.get(`${tx - 1},${ty}`) ?? null,
        top: only.get(`${tx},${ty - 1}`) ?? null,
        right: only.has(`${tx + 1},${ty}`),
        below: only.has(`${tx},${ty + 1}`),
      };
      const kept = this.tiles.get(at);
      const same = kept && kept.only === inputs.only && kept.left === inputs.left && kept.top === inputs.top && kept.right === inputs.right && kept.below === inputs.below;
      const piece = same ? kept : { ...inputs, lines: this.linesOf(tx, ty, inputs) };
      next.set(at, piece);
      if (piece.lines.length > 0) out.push(piece.lines);
    }
    this.tiles.clear();
    for (const [at, piece] of next) this.tiles.set(at, piece);
    return out;
  }

  /** A layer's tiles of this scene inside its bounds, by `"tx,ty"`. */
  private byPlace(tiles: Tiles | undefined): Map<string, FogTile> {
    const out = new Map<string, FogTile>();
    for (const tile of Object.values(tiles ?? {})) {
      if (!tile || tile.sceneId !== this.sceneId || !Number.isInteger(tile.tx) || !Number.isInteger(tile.ty) || tile.tx < 0 || tile.ty < 0) continue;
      if (tile.tx * TILE_SUB >= this.width || tile.ty * TILE_SUB >= this.height) continue;
      out.set(`${tile.tx},${tile.ty}`, tile);
    }
    return out;
  }

  /** The sub-cells of one place that only the explored layer reveals, one byte each, cached by the two tiles. */
  private onlyOf(explored: FogTile, dm: FogTile | undefined): Only {
    let byDm = this.onlyCache.get(explored);
    if (!byDm) this.onlyCache.set(explored, (byDm = new WeakMap()));
    const key = dm ?? NO_DM_TILE;
    const hit = byDm.get(key);
    if (hit) return hit;
    const out = new Uint8Array(TILE_SUB * TILE_SUB);
    const e = decodeTile(explored.bits);
    const d = dm ? decodeTile(dm.bits) : null;
    if (e) for (let i = 0; i < out.length; i++) out[i] = (e[i >> 3]! >> (i & 7)) & 1 & ~(d ? (d[i >> 3]! >> (i & 7)) & 1 : 0);
    byDm.set(key, out);
    return out;
  }

  private linesOf(tx: number, ty: number, t: Omit<TileOutline, "lines">): number[] {
    const out: number[] = [];
    const x0 = tx * TILE_SUB;
    const y0 = ty * TILE_SUB;
    const w = Math.min(TILE_SUB, this.width - x0);
    const h = Math.min(TILE_SUB, this.height - y0);
    const s = 1 / FOG_SUBCELLS;
    const at = (only: Only | null, x: number, y: number) => (only ? only[y * TILE_SUB + x]! : 0);
    const own = (x: number, y: number) => t.only[y * TILE_SUB + x]!;
    /** Adds the runs of a line of `n` unit sides, where `side(k)` says whether the k-th is a side. */
    const runs = (n: number, side: (k: number) => boolean, put: (a: number, b: number) => void) => {
      let start = -1;
      for (let k = 0; k <= n; k++) {
        const on = k < n && side(k);
        if (on && start < 0) start = k;
        if (!on && start >= 0) {
          put(start, k);
          start = -1;
        }
      }
    };
    const across = (y: number) => (a: number, b: number) => out.push((x0 + a) * s, (y0 + y) * s, (x0 + b) * s, (y0 + y) * s);
    const down = (x: number) => (a: number, b: number) => out.push((x0 + x) * s, (y0 + a) * s, (x0 + x) * s, (y0 + b) * s);
    // Its own sides, then its borders, leaving out the scene's edge.
    for (let y = 1; y < h; y++) runs(w, (x) => own(x, y - 1) !== own(x, y), across(y));
    for (let x = 1; x < w; x++) runs(h, (y) => own(x - 1, y) !== own(x, y), down(x));
    if (y0 > 0) runs(w, (x) => at(t.top, x, TILE_SUB - 1) !== own(x, 0), across(0));
    if (x0 > 0) runs(h, (y) => at(t.left, TILE_SUB - 1, y) !== own(0, y), down(0));
    if (!t.below && h === TILE_SUB && y0 + h < this.height) runs(w, (x) => own(x, h - 1) === 1, across(h));
    if (!t.right && w === TILE_SUB && x0 + w < this.width) runs(h, (y) => own(w - 1, y) === 1, down(w));
    return out;
  }
}
