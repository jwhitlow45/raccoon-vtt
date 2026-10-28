import { CHUNK_CELLS, type BuildChunk } from "#shared/model.ts";
import { isHex, SQUARES, type Grid } from "#shared/rules/grid.ts";
import { chunkHeights, facingsOf, stepper } from "#shared/rules/heights.ts";
import { hexCenter, hexInScene, sceneHexSpan } from "#shared/rules/hex.ts";

/**
 * The regions Height mode names (docs/design-v1-maps-vision.md section
 * 4.2): each run of touching cells at one height other than 0, with the cell
 * its number goes on. Pure, so the grouping is tested without a canvas.
 */

export type HeightRegion = {
  /** Feet. */
  ground: number;
  /** Cells in the region. */
  size: number;
  /**
   * Where the number may go, best first: the middles of the region's cells
   * deepest inside it, nearest its center of mass first, so the number sits
   * on the region, an L or a ring included. Later spots are for when a
   * neighbor's number already covers the first.
   */
  spots: { x: number; y: number }[];
};

/** How many spots a region offers its number. */
const SPOTS = 24;

/**
 * The scene's height regions, the largest first. On a hex scene the cells
 * are hexes by key, touching across their six sides, and a spot is a hex's
 * center (docs/design-v1-hex-grids.md H3).
 */
export function heightRegions(chunks: readonly BuildChunk[], bounds: { w: number; h: number }, grid: Grid = SQUARES): HeightRegion[] {
  const hex = isHex(grid) ? grid : null;
  // The key space: the scene's cells, or the columns and rows its hex keys run over.
  const { cols: W, rows: H } = hex ? sceneHexSpan(hex, bounds) : { cols: bounds.w, rows: bounds.h };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && (!hex || hexInScene(hex, bounds, { col: x, row: y }));
  const step = stepper(grid);
  const sides = facingsOf(grid).length;
  const id = (x: number, y: number) => y * W + x;
  const around = (c: number): number[] => {
    const x = c % W;
    const y = (c - x) / W;
    const out: number[] = [];
    for (let d = 0; d < sides; d++) {
      const [nx, ny] = step(x, y, d);
      out.push(inside(nx, ny) ? id(nx, ny) : -1);
    }
    return out;
  };
  const ground = new Map<number, number>();
  for (const chunk of chunks) {
    const heights = chunkHeights(chunk);
    if (!heights) continue;
    for (let k = 0; k < heights.length; k++) {
      const v = heights[k]!;
      if (v === 0) continue;
      const x = chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS);
      const y = chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
      if (!inside(x, y)) continue;
      ground.set(id(x, y), v);
    }
  }
  const out: HeightRegion[] = [];
  const done = new Set<number>();
  for (const start of [...ground.keys()].sort((a, b) => a - b)) {
    if (done.has(start)) continue;
    const level = ground.get(start)!;
    const cells: number[] = [start];
    done.add(start);
    for (let i = 0; i < cells.length; i++) {
      for (const n of around(cells[i]!)) {
        if (n < 0 || done.has(n) || ground.get(n) !== level) continue;
        done.add(n);
        cells.push(n);
      }
    }
    // Depth: steps from the region's edge, by a walk inward from every cell on it.
    const inRegion = new Set(cells);
    const depth = new Map<number, number>();
    const queue: number[] = [];
    for (const c of cells) {
      if (around(c).some((n) => n < 0 || !inRegion.has(n))) {
        depth.set(c, 0);
        queue.push(c);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i]!;
      for (const n of around(c)) {
        if (n < 0 || !inRegion.has(n) || depth.has(n)) continue;
        depth.set(n, depth.get(c)! + 1);
        queue.push(n);
      }
    }
    const middle = (c: number) => {
      const x = c % W;
      const y = (c - x) / W;
      return hex ? hexCenter(hex, { col: x, row: y }) : { x: x + 0.5, y: y + 0.5 };
    };
    let sx = 0;
    let sy = 0;
    for (const c of cells) {
      const m = middle(c);
      sx += m.x;
      sy += m.y;
    }
    const mx = sx / cells.length;
    const my = sy / cells.length;
    const far = (c: number) => {
      const m = middle(c);
      return (m.x - mx) * (m.x - mx) + (m.y - my) * (m.y - my);
    };
    const ranked = [...cells].sort((a, b) => depth.get(b)! - depth.get(a)! || far(a) - far(b) || a - b);
    // Spots at least two cells apart, so a fallback is somewhere else on the region, not beside the spot that was covered.
    const spots: { x: number; y: number }[] = [];
    for (const c of ranked) {
      const { x, y } = middle(c);
      if (spots.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 2)) continue;
      spots.push({ x, y });
      if (spots.length === SPOTS) break;
    }
    out.push({ ground: level, size: cells.length, spots });
  }
  return out.sort((a, b) => b.size - a.size || a.spots[0]!.y - b.spots[0]!.y || a.spots[0]!.x - b.spots[0]!.x);
}

/** How a region's number reads: up or down, in feet, the way a token's elevation badge says it ("↑10"). */
export function regionText(ground: number): string {
  return ground > 0 ? `↑${ground} ft` : `↓${-ground} ft`;
}
