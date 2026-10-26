import { FOG_SUBCELLS, type FogTile } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { decodeTile, getBit, TILE_SUB } from "#shared/rules/fog.ts";

type Tiles = Readonly<Record<string, FogTile | undefined>>;

/** A tile's bits, decoded once for the life of the tile object, which the store replaces on every change. */
const decoded = new WeakMap<FogTile, Uint8Array | null>();

function bitsOf(tile: FogTile): Uint8Array | null {
  let bits = decoded.get(tile);
  if (bits === undefined) decoded.set(tile, (bits = decodeTile(tile.bits)));
  return bits;
}

/** Two layers' tiles at one place as one, kept for the life of the pair. */
const unions = new WeakMap<FogTile, WeakMap<FogTile, Uint8Array | null>>();

function unionOf(a: FogTile, b: FogTile): Uint8Array | null {
  let byB = unions.get(a);
  if (!byB) unions.set(a, (byB = new WeakMap()));
  let bits = byB.get(b);
  if (bits === undefined) {
    const x = bitsOf(a);
    const y = bitsOf(b);
    // A layer that does not decode adds nothing, as the fog image skips it.
    bits = x && y ? x.map((v, i) => v | y[i]!) : (x ?? y);
    byB.set(b, bits);
  }
  return bits;
}

/** A box in cells, the far edges excluded. */
export type CellBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * What one viewer's fog reveals, sub-cell by sub-cell (docs/design-v1-isometric-view.md
 * 5.2). `tiles` null is a viewer who sees all the ground: the DM, or anyone
 * on a scene without fog. Everything fails closed as the fog image does
 * (lib/fogTiles.ts): a sub-cell past the scene's edge, in a missing tile or
 * in one that does not decode counts as fogged.
 *
 * The DM's drawn fog holds the party's explored layer beside the DM's own,
 * each tile under a key of its own (features/vision/exploredFog.ts
 * withExplored), and the fog image draws their union. So a sub-cell either
 * layer reveals is revealed here too, and the DM's Isometric dims a
 * standee by the same ground the DM's map shows fogged (D-261026-18).
 */
export class FogView {
  readonly tiles: Tiles | null;
  readonly sceneId: string;
  readonly bounds: { readonly w: number; readonly h: number };

  constructor(tiles: Tiles | null, sceneId: string, bounds: { w: number; h: number }) {
    this.tiles = tiles;
    this.sceneId = sceneId;
    this.bounds = bounds;
  }

  /** Whether this viewer sees every sub-cell, so nothing needs a test. */
  get all(): boolean {
    return this.tiles === null;
  }

  /** The bits of the tile at tx, ty, both layers', or null where the whole tile is fogged. */
  private tileBits(tx: number, ty: number): Uint8Array | null {
    const own = this.layerTile(tileKey(this.sceneId, tx, ty), tx, ty);
    const explored = this.layerTile(`explored:${tileKey(this.sceneId, tx, ty)}`, tx, ty);
    if (own && explored) return unionOf(own, explored);
    const tile = own ?? explored;
    return tile ? bitsOf(tile) : null;
  }

  private layerTile(key: string, tx: number, ty: number): FogTile | null {
    const tile = this.tiles?.[key];
    // A tile filed under another tile's key would draw elsewhere in the fog image, so it reveals nothing here.
    return tile && tile.sceneId === this.sceneId && tile.tx === tx && tile.ty === ty ? tile : null;
  }

  /** Whether the sub-cell at sx, sy (FOG_SUBCELLS to a cell) is revealed. */
  revealed(sx: number, sy: number): boolean {
    if (!this.tiles) return true;
    if (sx < 0 || sy < 0 || sx >= this.bounds.w * FOG_SUBCELLS || sy >= this.bounds.h * FOG_SUBCELLS) return false;
    const tx = Math.floor(sx / TILE_SUB);
    const ty = Math.floor(sy / TILE_SUB);
    const bits = this.tileBits(tx, ty);
    return bits !== null && getBit(bits, sx - tx * TILE_SUB, sy - ty * TILE_SUB);
  }

  /**
   * Whether every sub-cell a box touches is revealed. A sub-cell counts when
   * the box covers any of its area, and a box with no area counts the
   * sub-cell its corner lies in, so a degenerate box is never waved through.
   */
  boxClear(box: CellBox): boolean {
    if (!this.tiles) return true;
    const [sx0, sx1] = subRange(box.x0, box.x1);
    const [sy0, sy1] = subRange(box.y0, box.y1);
    if (sx0 < 0 || sy0 < 0 || sx1 > this.bounds.w * FOG_SUBCELLS || sy1 > this.bounds.h * FOG_SUBCELLS) return false;
    for (let ty = Math.floor(sy0 / TILE_SUB); ty * TILE_SUB < sy1; ty++) {
      for (let tx = Math.floor(sx0 / TILE_SUB); tx * TILE_SUB < sx1; tx++) {
        const bits = this.tileBits(tx, ty);
        if (!bits) return false;
        const ya = Math.max(sy0, ty * TILE_SUB) - ty * TILE_SUB;
        const yb = Math.min(sy1, (ty + 1) * TILE_SUB) - ty * TILE_SUB;
        const xa = Math.max(sx0, tx * TILE_SUB) - tx * TILE_SUB;
        const xb = Math.min(sx1, (tx + 1) * TILE_SUB) - tx * TILE_SUB;
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) if (!getBit(bits, x, y)) return false;
      }
    }
    return true;
  }

  /** Whether any sub-cell a box touches is revealed, the scene's edge counting as fog. */
  boxAny(box: CellBox): boolean {
    if (!this.tiles) return true;
    const [sx0, sx1] = subRange(box.x0, box.x1);
    const [sy0, sy1] = subRange(box.y0, box.y1);
    for (let sy = Math.max(0, sy0); sy < sy1; sy++) for (let sx = Math.max(0, sx0); sx < sx1; sx++) if (this.revealed(sx, sy)) return true;
    return false;
  }

  /** Whether any sub-cell of the cell at x, y is revealed: the cell is seen, as `seenGround` counts it. */
  cellSeen(x: number, y: number): boolean {
    if (!this.tiles) return x >= 0 && y >= 0 && x < this.bounds.w && y < this.bounds.h;
    for (let sy = 0; sy < FOG_SUBCELLS; sy++) {
      for (let sx = 0; sx < FOG_SUBCELLS; sx++) if (this.revealed(x * FOG_SUBCELLS + sx, y * FOG_SUBCELLS + sy)) return true;
    }
    return false;
  }

  /** Whether every sub-cell of the cell at x, y is revealed. */
  cellClear(x: number, y: number): boolean {
    return this.boxClear({ x0: x, y0: y, x1: x + 1, y1: y + 1 });
  }

  /**
   * The revealed sub-cells a box touches, as rectangles in cells, each a
   * run of revealed sub-cells along one row: the clip for something drawn
   * flat over fog (5.2), so it shows only where Top-down would show it.
   * Fogged sub-cells are opaque in the fog image, so this exposes nothing.
   */
  revealedRects(box: CellBox): { x: number; y: number; w: number; h: number }[] {
    const [sx0, sx1] = subRange(box.x0, box.x1);
    const [sy0, sy1] = subRange(box.y0, box.y1);
    const out: { x: number; y: number; w: number; h: number }[] = [];
    const k = 1 / FOG_SUBCELLS;
    for (let sy = sy0; sy < sy1; sy++) {
      let start = -1;
      for (let sx = sx0; sx <= sx1; sx++) {
        const open = sx < sx1 && this.revealed(sx, sy);
        if (open && start < 0) start = sx;
        else if (!open && start >= 0) {
          out.push({ x: start * k, y: sy * k, w: (sx - start) * k, h: k });
          start = -1;
        }
      }
    }
    return out;
  }
}

/** The sub-cells from `a` to `b` in cells touch, as a half-open range. A range with no length takes the one sub-cell at `a`. */
function subRange(a: number, b: number): [number, number] {
  const lo = Math.floor(a * FOG_SUBCELLS);
  const hi = Math.ceil(b * FOG_SUBCELLS);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}
