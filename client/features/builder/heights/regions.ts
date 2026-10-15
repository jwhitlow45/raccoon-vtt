import { CHUNK_CELLS, type BuildChunk } from "#shared/model.ts";
import { chunkHeights } from "#shared/rules/heights.ts";

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
 * Every region of the scene's painted heights, the largest first, then by
 * position. Cells touch along a side, not at a corner. Heights left outside
 * a shrunk scene are not regions.
 */
export function heightRegions(chunks: readonly BuildChunk[], bounds: { w: number; h: number }): HeightRegion[] {
  const ground = new Map<number, number>();
  const id = (x: number, y: number) => y * bounds.w + x;
  for (const chunk of chunks) {
    const heights = chunkHeights(chunk);
    if (!heights) continue;
    for (let k = 0; k < heights.length; k++) {
      const v = heights[k]!;
      if (v === 0) continue;
      const x = chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS);
      const y = chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
      if (x < 0 || y < 0 || x >= bounds.w || y >= bounds.h) continue;
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
      const c = cells[i]!;
      const x = c % bounds.w;
      const y = (c - x) / bounds.w;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= bounds.w || ny >= bounds.h) continue;
        const n = id(nx, ny);
        if (done.has(n) || ground.get(n) !== level) continue;
        done.add(n);
        cells.push(n);
      }
    }
    // Depth: steps from the region's edge, by a walk inward from every cell on it.
    const inRegion = new Set(cells);
    const depth = new Map<number, number>();
    const queue: number[] = [];
    for (const c of cells) {
      const x = c % bounds.w;
      const y = (c - x) / bounds.w;
      const edge = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ].some(([nx, ny]) => nx! < 0 || ny! < 0 || nx! >= bounds.w || ny! >= bounds.h || !inRegion.has(id(nx!, ny!)));
      if (edge) {
        depth.set(c, 0);
        queue.push(c);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i]!;
      const x = c % bounds.w;
      const y = (c - x) / bounds.w;
      for (const n of [c + 1, c - 1, c + bounds.w, c - bounds.w]) {
        const nx = n % bounds.w;
        if (Math.abs(nx - x) + Math.abs((n - nx) / bounds.w - y) !== 1 || !inRegion.has(n) || depth.has(n)) continue;
        depth.set(n, depth.get(c)! + 1);
        queue.push(n);
      }
    }
    let sx = 0;
    let sy = 0;
    for (const c of cells) {
      sx += c % bounds.w;
      sy += Math.floor(c / bounds.w);
    }
    const mx = sx / cells.length;
    const my = sy / cells.length;
    const far = (c: number) => {
      const x = c % bounds.w;
      const y = (c - x) / bounds.w;
      return (x - mx) * (x - mx) + (y - my) * (y - my);
    };
    const ranked = [...cells].sort((a, b) => depth.get(b)! - depth.get(a)! || far(a) - far(b) || a - b);
    // Spots at least two cells apart, so a fallback is somewhere else on the region, not beside the spot that was covered.
    const spots: { x: number; y: number }[] = [];
    for (const c of ranked) {
      const x = c % bounds.w + 0.5;
      const y = Math.floor(c / bounds.w) + 0.5;
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
