import type { BuildChunk, TerrainId } from "#shared/model.ts";
import type { WallEdge } from "#shared/rules/walls.ts";

/**
 * What the board layer draws for a build (design section 12): one path per
 * floor texture, symbols for the terrains that have no texture, and wall
 * runs. Pure, so the merging is tested without a canvas.
 */

export type CellRect = { x: number; y: number; w: number; h: number };

/** Terrains with a texture in public/textures. */
export type TexturedTerrain = Exclude<TerrainId, "pit" | "pillar" | "stairs">;

/** Pit, pillar and stairs have no texture: they draw as symbols over a stone floor (CREDITS.md). */
export type SymbolTerrain = Extract<TerrainId, "pit" | "pillar" | "stairs">;

export const SYMBOL_TERRAINS: readonly SymbolTerrain[] = ["pit", "pillar", "stairs"];

export function isSymbolTerrain(t: TerrainId): t is SymbolTerrain {
  return t === "pit" || t === "pillar" || t === "stairs";
}

/**
 * Merges cells into few rectangles: runs along each row, then runs with the
 * same span on consecutive rows into one taller rectangle. The rectangles
 * never overlap and cover exactly the input, so one path of them fills the
 * cells in a single draw with no seams inside a terrain.
 */
export function mergeRects(cells: readonly { x: number; y: number }[]): CellRect[] {
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: CellRect[] = [];
  /** Rectangles still growing, keyed by their row span, from the row above. */
  let open = new Map<string, CellRect>();
  let i = 0;
  while (i < sorted.length) {
    const y = sorted[i]!.y;
    const next = new Map<string, CellRect>();
    while (i < sorted.length && sorted[i]!.y === y) {
      const x0 = sorted[i]!.x;
      let x1 = x0 + 1;
      i++;
      while (i < sorted.length && sorted[i]!.y === y && sorted[i]!.x <= x1) {
        x1 = Math.max(x1, sorted[i]!.x + 1);
        i++;
      }
      const span = `${x0},${x1}`;
      const above = open.get(span);
      if (above && above.y + above.h === y) {
        above.h++;
        open.delete(span);
        next.set(span, above);
      } else {
        const rect = { x: x0, y, w: x1 - x0, h: 1 };
        out.push(rect);
        next.set(span, rect);
      }
    }
    open = next;
  }
  return out;
}

export type BuildDrawing = {
  /** The floor under each texture. Pit, pillar and stairs cells are in `stone`. */
  floors: Map<TexturedTerrain, CellRect[]>;
  /** Every floor cell, for the base fill and the grid over the floor. */
  all: CellRect[];
  symbols: Record<SymbolTerrain, { x: number; y: number }[]>;
  /** Floor cell count, for the empty check. */
  count: number;
};

function parseCell(key: string): { x: number; y: number } | null {
  const comma = key.indexOf(",");
  if (comma < 1) return null;
  const x = Number(key.slice(0, comma));
  const y = Number(key.slice(comma + 1));
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}

/** Groups a scene's cells by what draws them, merged into rectangles. */
export function buildDrawing(chunks: readonly BuildChunk[]): BuildDrawing {
  const byTerrain = new Map<TexturedTerrain, { x: number; y: number }[]>();
  const all: { x: number; y: number }[] = [];
  const symbols: BuildDrawing["symbols"] = { pit: [], pillar: [], stairs: [] };
  for (const chunk of chunks) {
    for (const [key, terrain] of Object.entries(chunk.cells)) {
      const cell = parseCell(key);
      if (!cell) continue;
      all.push(cell);
      let floor: TexturedTerrain;
      if (isSymbolTerrain(terrain)) {
        symbols[terrain].push(cell);
        floor = "stone";
      } else {
        floor = terrain;
      }
      const list = byTerrain.get(floor);
      if (list) list.push(cell);
      else byTerrain.set(floor, [cell]);
    }
  }
  const floors = new Map<TexturedTerrain, CellRect[]>();
  for (const [terrain, cells] of byTerrain) floors.set(terrain, mergeRects(cells));
  return { floors, all: mergeRects(all), symbols, count: all.length };
}

/**
 * Plain walls as straight runs, flat `[ax, ay, bx, by, ...]` in cells.
 * Neighboring unit edges on one grid line join into one segment, so a long
 * wall strokes as one line with clean joins. The raised edges of the relief
 * (heights/relief.ts) join the same way.
 */
export function wallRuns<E extends Pick<WallEdge, "x" | "y" | "side">>(edges: readonly E[], isWall: (e: E) => boolean): number[] {
  const rows = new Map<number, number[]>();
  const cols = new Map<number, number[]>();
  for (const e of edges) {
    if (!isWall(e)) continue;
    const lines = e.side === "n" ? rows : cols;
    const at = e.side === "n" ? e.y : e.x;
    let list = lines.get(at);
    if (!list) lines.set(at, (list = []));
    list.push(e.side === "n" ? e.x : e.y);
  }
  const out: number[] = [];
  for (const [horizontal, lines] of [
    [true, rows],
    [false, cols],
  ] as const) {
    for (const [at, list] of [...lines].sort((a, b) => a[0] - b[0])) {
      list.sort((a, b) => a - b);
      let start = list[0]!;
      let end = start + 1;
      for (let i = 1; i <= list.length; i++) {
        const v = list[i];
        if (v !== undefined && v <= end) {
          end = Math.max(end, v + 1);
          continue;
        }
        if (horizontal) out.push(start, at, end, at);
        else out.push(at, start, at, end);
        if (v !== undefined) {
          start = v;
          end = v + 1;
        }
      }
    }
  }
  return out;
}

/**
 * The side of its edge an open door swings into: 1 for the cell south of a
 * north edge or east of a west edge, -1 for the cell on the other side. A
 * door swings into floor, never into rock, and keeps to the south or east
 * when both sides are floor.
 */
export function swingSide(e: { x: number; y: number; side: "n" | "w" }, isFloor: (x: number, y: number) => boolean): 1 | -1 {
  const ahead = isFloor(e.x, e.y);
  const behind = e.side === "n" ? isFloor(e.x, e.y - 1) : isFloor(e.x - 1, e.y);
  return !ahead && behind ? -1 : 1;
}
