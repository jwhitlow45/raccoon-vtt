import { CHUNK_CELLS, type BuildChunk } from "#shared/model.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";
import { chunkHeights, chunkMarks, facingsOf, oppositeFacing, stepper, type Compass, type Facing } from "#shared/rules/heights.ts";
import { cornerAt, hexCenter, hexCorners, hexInScene, type HexGrid } from "#shared/rules/hex.ts";
import { mergeRects, wallRuns } from "../geometry.ts";

/**
 * How raised areas and stairs draw (docs/design-v1-maps-vision.md section
 * 4.2), as paths in world cells, so the board and the map export draw them
 * alike. Pure, so the shapes are tested without a canvas.
 *
 * The scene is lit from the top left. Higher ground is lighter and lower
 * ground darker, each raised region casts a shadow down and to the right
 * onto lower ground, as long as the height difference, and its edges have a
 * pale rim where they face the light and a dark line where they face away.
 * Directed stairs draw five treads across the way up, lighter toward the
 * top, with a chevron at the high end.
 */

/** The subset of Path2D these shapes use (draw.ts `PathSink`). */
type Sink = Pick<Path2D, "moveTo" | "lineTo" | "closePath" | "rect">;

type Bounds = { w: number; h: number };

/** What the relief reads of the derived walls (shared/rules/walls.ts `WallSet`), so stairs point the way movement reads them. */
export type ReliefSource = {
  stairAt(x: number, y: number): Facing | null | undefined;
};

/** Lightening or darkening per 5 ft of height, and the most either goes. */
const TINT_PER_5FT = 0.04;
const TINT_MAX = 0.2;
/** How far a shadow falls per 5 ft of height difference, and the farthest, in cells. */
export const SHADOW_PER_5FT = 0.08;
export const SHADOW_MAX = 0.5;
/** A shadow is drawn as this many bands, nearest the edge darkest, so it fades as it falls away. */
export const SHADOW_BANDS = 3;

export type ReliefPaths<P> = {
  /** A wash over each ground level other than 0: white over higher ground, black over lower. */
  tints: { color: string; path: P }[];
  /** The shadows on lower ground, one path per band, the band reaching farthest first. Each band is filled with the same translucent black. */
  shadows: P[];
  /** Raised edges on the lit side of higher ground (its north and west edges): a pale rim. */
  rims: P;
  /** Raised edges on the far side of higher ground (its south and east edges): a dark line. */
  ledges: P;
};

/** A cell's ground as the relief reads it: painted heights from the chunks, 0 elsewhere. */
type Ground = { x0: number; y0: number; w: number; h: number; at: Int16Array; levels: Map<number, { x: number; y: number }[]> };

function inScene(bounds: Bounds | null, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && (!bounds || (x < bounds.w && y < bounds.h));
}

/**
 * The painted ground over the box around every cell with a height, padded
 * by a cell so each raised cell has its neighbors, or null when no cell in
 * the scene has one. A height left outside a shrunk scene raises nothing, as
 * the walls read it (walls.ts `reliefOfGrid`).
 */
function groundOf(chunks: readonly BuildChunk[], bounds: Bounds | null): Ground | null {
  const levels = new Map<number, { x: number; y: number }[]>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const chunk of chunks) {
    const heights = chunkHeights(chunk);
    if (!heights) continue;
    for (let k = 0; k < heights.length; k++) {
      const v = heights[k]!;
      if (v === 0) continue;
      const x = chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS);
      const y = chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
      if (!inScene(bounds, x, y)) continue;
      let list = levels.get(v);
      if (!list) levels.set(v, (list = []));
      list.push({ x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (levels.size === 0) return null;
  const x0 = minX - 1;
  const y0 = minY - 1;
  const w = maxX - minX + 3;
  const h = maxY - minY + 3;
  const at = new Int16Array(w * h);
  for (const [v, cells] of levels) for (const c of cells) at[(c.y - y0) * w + (c.x - x0)] = v;
  return { x0, y0, w, h, at, levels };
}

/** The tint for a ground level: lighter above 0, darker below, 4% per 5 ft and at most 20%. */
export function tintOf(ground: number): string {
  const alpha = Math.round(Math.min(TINT_MAX, (TINT_PER_5FT * Math.abs(ground)) / 5) * 1000) / 1000;
  return ground > 0 ? `rgba(255, 255, 255, ${alpha})` : `rgba(0, 0, 0, ${alpha})`;
}

/** How far a shadow falls for a height difference, in cells: 0.08 per 5 ft, at most half a cell. */
export function shadowLength(difference: number): number {
  return Math.min(SHADOW_MAX, (SHADOW_PER_5FT * difference) / 5);
}

/** Whether a stair direction runs across a horizontal edge (north or south) or a vertical one (east or west). */
const ACROSS_ROW = (d: Facing | null | undefined) => d === "n" || d === "s";
const ACROSS_COLUMN = (d: Facing | null | undefined) => d === "e" || d === "w";

/**
 * The relief's paths for a scene's chunks. `bounds` limits it to the scene,
 * as the walls are. A raised edge a directed stair connects (its up and
 * down sides, as walls.ts connects them) draws no rim or line, so the top
 * of a stair does not look like a cliff.
 */
export function reliefPaths<P extends Sink>(chunks: readonly BuildChunk[], walls: ReliefSource, bounds: Bounds | null, make: () => P, grid: Grid = { shape: "squares" }): ReliefPaths<P> {
  if (isHex(grid)) return hexReliefPaths(chunks, walls, bounds, make, grid);
  const shadows = Array.from({ length: SHADOW_BANDS }, make);
  const out: ReliefPaths<P> = { tints: [], shadows, rims: make(), ledges: make() };
  const g = groundOf(chunks, bounds);
  if (!g) return out;

  for (const [level, cells] of [...g.levels].sort((a, b) => a[0] - b[0])) {
    const path = make();
    for (const r of mergeRects(cells)) path.rect(r.x, r.y, r.w, r.h);
    out.tints.push({ color: tintOf(level), path });
  }

  const ground = (x: number, y: number) => g.at[(y - g.y0) * g.w + (x - g.x0)]!;
  const rims: { x: number; y: number; side: "n" | "w" }[] = [];
  const ledges: { x: number; y: number; side: "n" | "w" }[] = [];
  // Every cell of the box but its last row and column, with its east, south and south-east neighbors.
  for (let y = g.y0; y < g.y0 + g.h - 1; y++) {
    for (let x = g.x0; x < g.x0 + g.w - 1; x++) {
      if (!inScene(bounds, x, y)) continue;
      const top = ground(x, y);
      const east = inScene(bounds, x + 1, y) ? ground(x + 1, y) : null;
      const south = inScene(bounds, x, y + 1) ? ground(x, y + 1) : null;
      const southEast = inScene(bounds, x + 1, y + 1) ? ground(x + 1, y + 1) : null;
      /*
       * The cell's shadow is the cell moved down and to the right by the
       * shadow's length, cut to each lower neighbor it falls on. Each
       * neighbor gets its own length, from its own difference, and is never
       * shaded by more than half a cell, so a shadow never reaches past it.
       */
      for (let band = 1; band <= SHADOW_BANDS; band++) {
        const path = shadows[SHADOW_BANDS - band]!;
        const reach = (below: number) => (shadowLength(top - below) * band) / SHADOW_BANDS;
        if (east !== null && east < top) {
          const e = reach(east);
          path.rect(x + 1, y + e, e, 1 - e);
        }
        if (south !== null && south < top) {
          const e = reach(south);
          path.rect(x + e, y + 1, 1 - e, e);
        }
        if (southEast !== null && southEast < top) {
          const e = reach(southEast);
          path.rect(x + 1, y + 1, e, e);
        }
      }
      if (east !== null && east !== top && !ACROSS_COLUMN(walls.stairAt(x, y)) && !ACROSS_COLUMN(walls.stairAt(x + 1, y))) {
        (east > top ? rims : ledges).push({ x: x + 1, y, side: "w" });
      }
      if (south !== null && south !== top && !ACROSS_ROW(walls.stairAt(x, y)) && !ACROSS_ROW(walls.stairAt(x, y + 1))) {
        (south > top ? rims : ledges).push({ x, y: y + 1, side: "n" });
      }
    }
  }
  for (const [edges, path] of [
    [rims, out.rims],
    [ledges, out.ledges],
  ] as const) {
    const runs = wallRuns(edges, () => true);
    for (let i = 0; i < runs.length; i += 4) {
      path.moveTo(runs[i]!, runs[i + 1]!);
      path.lineTo(runs[i + 2]!, runs[i + 3]!);
    }
  }
  return out;
}

/**
 * The relief on a hex scene (docs/design-v1-hex-grids.md H3), lit from the
 * top left as on squares: each level's hexes washed, a shadow falling from
 * each raised side that faces away from the light onto the lower hex
 * beyond it, and the sides between two heights drawn as a pale rim where
 * the higher hex faces the light and a dark line where it faces away. A
 * side a directed stair runs through draws neither.
 */
function hexReliefPaths<P extends Sink>(chunks: readonly BuildChunk[], walls: ReliefSource, bounds: Bounds | null, make: () => P, g: HexGrid): ReliefPaths<P> {
  const shadows = Array.from({ length: SHADOW_BANDS }, make);
  const out: ReliefPaths<P> = { tints: [], shadows, rims: make(), ledges: make() };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && (!bounds || hexInScene(g, bounds, { col: x, row: y }));
  const ground = new Map<string, number>();
  const levels = new Map<number, { x: number; y: number }[]>();
  for (const chunk of chunks) {
    const heights = chunkHeights(chunk);
    if (!heights) continue;
    for (let k = 0; k < heights.length; k++) {
      const v = heights[k]!;
      if (v === 0) continue;
      const x = chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS);
      const y = chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
      if (!inside(x, y)) continue;
      ground.set(`${x},${y}`, v);
      let list = levels.get(v);
      if (!list) levels.set(v, (list = []));
      list.push({ x, y });
    }
  }
  if (ground.size === 0) return out;
  const corners = (x: number, y: number) => hexCorners(g, { col: x, row: y }).map((c) => cornerAt(g, c));
  for (const [level, hexes] of [...levels].sort((a, b) => a[0] - b[0])) {
    const path = make();
    for (const h of hexes) {
      corners(h.x, h.y).forEach((p, k) => (k === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
      path.closePath();
    }
    out.tints.push({ color: tintOf(level), path });
  }
  const step = stepper(g);
  const at = (x: number, y: number) => ground.get(`${x},${y}`) ?? 0;
  const linked = (x: number, y: number, d: number) => {
    const f = walls.stairAt(x, y);
    const i = f == null ? -1 : facingsOf(g).indexOf(f);
    return i === d || i === oppositeFacing(g, d);
  };
  // Every hex with ground and each of its neighbors: a side between two heights has at least one of them raised or lowered.
  const seen = new Set<string>();
  for (const key of ground.keys()) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    for (let d = 0; d < 6; d++) {
      const [nx, ny] = step(x, y, d);
      if (!inside(nx, ny)) continue;
      const pair = d < 3 ? `${x},${y},${d}` : `${nx},${ny},${d - 3}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const here = at(x, y);
      const there = at(nx, ny);
      if (here === there) continue;
      const c = hexCenter(g, { col: x, row: y });
      const n = hexCenter(g, { col: nx, row: ny });
      const cs = corners(x, y);
      const a = cs[(d + 1) % 6]!;
      const b = cs[(d + 2) % 6]!;
      // From the higher hex toward the lower: down and to the right faces away from the light.
      const ux = here > there ? n.x - c.x : c.x - n.x;
      const uy = here > there ? n.y - c.y : c.y - n.y;
      const away = ux + uy > 0;
      if (away) {
        for (let band = 1; band <= SHADOW_BANDS; band++) {
          const e = (shadowLength(Math.abs(here - there)) * band) / SHADOW_BANDS;
          const path = shadows[SHADOW_BANDS - band]!;
          path.moveTo(a.x, a.y);
          path.lineTo(b.x, b.y);
          path.lineTo(b.x + ux * e, b.y + uy * e);
          path.lineTo(a.x + ux * e, a.y + uy * e);
          path.closePath();
        }
      }
      if (linked(x, y, d) || linked(nx, ny, oppositeFacing(g, d))) continue;
      const line = away ? out.ledges : out.rims;
      line.moveTo(a.x, a.y);
      line.lineTo(b.x, b.y);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stairs

/** A stair cell: where it is, which way it points up (null when the rule cannot settle it), and whether floor is painted under it. */
export type StairCell = { x: number; y: number; dir: Facing | null; floor: boolean };

/**
 * Every stair of a scene: cells of Stairs terrain and cells with a stair
 * mark (section 4.2), each once, with the direction the walls give it.
 */
export function stairCells(chunks: readonly BuildChunk[], walls: ReliefSource): StairCell[] {
  const seen = new Set<string>();
  const out: StairCell[] = [];
  const add = (x: number, y: number, floor: boolean) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y, dir: walls.stairAt(x, y) ?? null, floor });
  };
  for (const chunk of chunks) {
    for (const [key, terrain] of Object.entries(chunk.cells)) {
      if (terrain !== "stairs") continue;
      const [xs, ys] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (Number.isInteger(x) && Number.isInteger(y)) add(x, y, true);
    }
    const marks = chunkMarks(chunk);
    if (marks === null) continue;
    for (let k = 0; k < marks.length; k++) {
      if (marks[k] === ".") continue;
      const x = chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS);
      const y = chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS);
      add(x, y, chunk.cells[`${x},${y}`] !== undefined);
    }
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

export const TREADS = 5;
/** The stair symbol's inset from its cell's sides, the Stairs terrain's own. */
const INSET = 0.08;

export type StairPaths<P> = {
  /** One path per tread, lowest first, each filled lighter than the one below. */
  treads: P[];
  /** The lines between treads. */
  risers: P;
  /** A chevron in the top tread, pointing up the stair. */
  chevrons: P;
  /** A stair with no direction: five lines across, as Stairs terrain always drew. */
  steps: P;
};

/**
 * A point of the cell's stair symbol, given as if the stair pointed north
 * (`u` across, `v` down from the high end), turned to its direction. Each
 * turn is a quarter turn about the cell's middle, never a mirror.
 */
function turn(dir: Compass, u: number, v: number): [number, number] {
  switch (dir) {
    case "n":
      return [u, v];
    case "e":
      return [1 - v, u];
    case "s":
      return [1 - u, 1 - v];
    case "w":
      return [v, 1 - u];
  }
}

/** How wide a hex stair's symbol is: the square one scaled to sit inside the hexagon, whose flats are a cell apart. */
const HEX_SYMBOL = 0.68;

/**
 * Where a hex stair's symbol points (H3): its hex's center and the step
 * toward the neighbor its facing names, a cell long, so the square
 * symbol's north turns onto it, never mirrored.
 */
function hexFrame(g: HexGrid, s: StairCell): { c: { x: number; y: number }; up: { x: number; y: number } | null } {
  const c = hexCenter(g, { col: s.x, row: s.y });
  const i = s.dir === null ? -1 : facingsOf(g).indexOf(s.dir);
  if (i < 0) return { c, up: null };
  const [nx, ny] = stepper(g)(s.x, s.y, i);
  const n = hexCenter(g, { col: nx, row: ny });
  return { c, up: { x: n.x - c.x, y: n.y - c.y } };
}

/** The paths for a set of stairs, in world cells: on hexes each drawn in its hexagon, turned to its facing. */
export function stairPaths<P extends Sink>(stairs: readonly StairCell[], make: () => P, grid: Grid = { shape: "squares" }): StairPaths<P> {
  const out: StairPaths<P> = { treads: Array.from({ length: TREADS }, make), risers: make(), chevrons: make(), steps: make() };
  const hex = isHex(grid) ? grid : null;
  const depth = (1 - 2 * INSET) / TREADS;
  for (const s of stairs) {
    const frame = hex ? hexFrame(hex, s) : null;
    if (s.dir === null || (frame && !frame.up)) {
      for (let k = 0; k < TREADS; k++) {
        if (frame) {
          const y = frame.c.y + (-0.3 + k * 0.15) * HEX_SYMBOL;
          out.steps.moveTo(frame.c.x - 0.36 * HEX_SYMBOL, y);
          out.steps.lineTo(frame.c.x + 0.36 * HEX_SYMBOL, y);
          continue;
        }
        const y = s.y + 0.2 + k * 0.15;
        out.steps.moveTo(s.x + 0.14, y);
        out.steps.lineTo(s.x + 0.86, y);
      }
      continue;
    }
    const dir = s.dir as Compass;
    const at = (u: number, v: number): readonly [number, number] => {
      if (frame?.up) {
        // Across is the up step turned a quarter clockwise, as the square symbol's east is its north turned.
        const { c, up } = frame;
        return [c.x + (-up.y * (u - 0.5) + up.x * (0.5 - v)) * HEX_SYMBOL, c.y + (up.x * (u - 0.5) + up.y * (0.5 - v)) * HEX_SYMBOL] as const;
      }
      const [px, py] = turn(dir, u, v);
      return [s.x + px, s.y + py] as const;
    };
    const lo = INSET;
    const hi = 1 - INSET;
    for (let k = 0; k < TREADS; k++) {
      // Tread k counts up from the low end, at v = 1 - INSET, toward the high end, at v = INSET.
      const v1 = hi - k * depth;
      const v0 = v1 - depth;
      const path = out.treads[k]!;
      path.moveTo(...at(lo, v0));
      path.lineTo(...at(hi, v0));
      path.lineTo(...at(hi, v1));
      path.lineTo(...at(lo, v1));
      path.closePath();
      if (k > 0) {
        out.risers.moveTo(...at(lo + 0.04, v1));
        out.risers.lineTo(...at(hi - 0.04, v1));
      }
    }
    // Across the top two treads, wide enough to read at a phone's fitted zoom.
    const tip = INSET + depth * 0.2;
    const arm = INSET + depth * 1.4;
    out.chevrons.moveTo(...at(0.26, arm));
    out.chevrons.lineTo(...at(0.5, tip));
    out.chevrons.lineTo(...at(0.74, arm));
  }
  return out;
}
