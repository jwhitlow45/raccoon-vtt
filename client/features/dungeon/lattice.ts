import { hexCenter, sceneHexSpan, type HexGrid } from "#shared/rules/hex.ts";
import { isHexGrid, type GridKind } from "./settings.ts";

/*
 * The lattice a plan works on (phase 3, 2.1, D-261110-085). Squares are the
 * board they always were. Hexes plan on the rows lattice: W the hexes of an
 * even row, H the rows, odd rows one hex shorter and shifted half a hex
 * right, so keys a row or a column apart are always hex neighbors and the
 * square planner's 4 offset moves stay inside the hex graph. Hex columns
 * plan on the mirrored bounds and land through the mirror: lattice cell
 * (c, r) is the scene's hex "r,c", and a facing digit means the same
 * neighbor on both (shared/rules/hex.ts reads columns as mirrored rows).
 *
 * Cells are indices y * W + x, as the Board numbers them.
 */

export type Lattice = {
  kind: GridKind;
  W: number;
  H: number;
  /** Whether lattice cell (x, y) is on the scene: inside W by H, and on hexes not past an odd row's last hex. */
  inMap(x: number, y: number): boolean;
  /** A cell's neighbors on the scene: 4 on squares (north, east, south, west), 6 on hexes (hexNeighbors' order). */
  halo(k: number): readonly number[];
  /**
   * The cell `t` steps from `k` toward `dir`, or null off the scene.
   * Squares count `dir` 0 to 3 as north, east, south and west, hexes 0 to 5
   * clockwise from east on the rows lattice, as a hex stair's facing does.
   */
  step(k: number, dir: number, t: number): number | null;
  /**
   * Whether the side of `k` toward `dir` lies on the scene's edge, with
   * nothing of the scene beyond it. On hexes only an even row's west side at
   * x 0 and east side at x W do: every other outside-facing side looks onto
   * a sliver of the scene (2.2).
   */
  border(k: number, dir: number): boolean;
  /** Where lattice cell (x, y)'s middle lands in the scene, in cells: a square's middle, or its hex's center on the 1/64 wall lattice. */
  pointOf(x: number, y: number): [number, number];
  /** The scene's key for a cell: "x,y" on squares and Hex rows, "y,x" on Hex columns. */
  keyOf(k: number): string;
};

const SQUARE_STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** The wall lattice, 1/64 of a cell (model.ts FREE_WALL_LATTICE), which every hex corner and center rounds to. */
const WALL_LATTICE = 64;
const onWallLattice = (v: number) => Math.round(v * WALL_LATTICE) / WALL_LATTICE + 0;

/** The hex grid a hex kind names. */
export function hexGridOf(grid: "hexRows" | "hexColumns"): HexGrid {
  return { shape: "hex", orient: grid === "hexRows" ? "rows" : "columns" };
}

/**
 * The step toward hex direction `dir` from row `r` of the rows lattice, as
 * column and row offsets: east and west along the row, the slants by the
 * row's parity, since odd rows sit half a hex right (hex.ts DIRECTIONS).
 */
export function hexStep(r: number, dir: number): readonly [number, number] {
  const odd = (r & 1) === 1;
  switch (dir) {
    case 0:
      return [1, 0];
    case 1:
      return [odd ? 1 : 0, 1];
    case 2:
      return [odd ? 0 : -1, 1];
    case 3:
      return [-1, 0];
    case 4:
      return [odd ? 0 : -1, -1];
    default:
      return [odd ? 1 : 0, -1];
  }
}

/**
 * The lattice for a grid over a scene's bounds in cells. On squares that is
 * the bounds themselves. On hexes it is the rows lattice of the bounds
 * (`sceneHexSpan`), mirrored first on Hex columns.
 */
export function latticeFor(grid: GridKind, bounds: { w: number; h: number }): Lattice {
  if (!isHexGrid(grid)) return squareLattice(grid, bounds.w, bounds.h);
  const g = hexGridOf(grid);
  const span = sceneHexSpan(g, bounds);
  const columns = grid === "hexColumns";
  return hexLattice(grid, g, columns ? span.rows : span.cols, columns ? span.cols : span.rows);
}

function squareLattice(kind: GridKind, W: number, H: number): Lattice {
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const step = (k: number, dir: number, t: number): number | null => {
    const [dx, dy] = SQUARE_STEPS[dir]!;
    const x = (k % W) + dx * t;
    const y = Math.floor(k / W) + dy * t;
    return inMap(x, y) ? y * W + x : null;
  };
  return {
    kind,
    W,
    H,
    inMap,
    halo: (k) => SQUARE_STEPS.flatMap((_, d) => {
      const n = step(k, d, 1);
      return n === null ? [] : [n];
    }),
    step,
    border: (k, dir) => step(k, dir, 1) === null,
    pointOf: (x, y) => [x + 0.5, y + 0.5],
    keyOf: (k) => `${k % W},${Math.floor(k / W)}`,
  };
}

function hexLattice(kind: "hexRows" | "hexColumns", g: HexGrid, W: number, H: number): Lattice {
  const columns = kind === "hexColumns";
  const inMap = (x: number, y: number) => y >= 0 && y < H && x >= 0 && x < W - (y & 1);
  const step = (k: number, dir: number, t: number): number | null => {
    let x = k % W;
    let y = (k - x) / W;
    for (let i = 0; i < t; i++) {
      const [dx, dy] = hexStep(y, dir);
      x += dx;
      y += dy;
    }
    return inMap(x, y) ? y * W + x : null;
  };
  // Every step a plan takes asks for halos, so each cell's six are worked out once.
  const halos: number[][] = [];
  for (let k = 0; k < W * H; k++) {
    const x = k % W;
    const y = (k - x) / W;
    const out: number[] = [];
    if (inMap(x, y)) {
      for (let d = 0; d < 6; d++) {
        const n = step(k, d, 1);
        if (n !== null) out.push(n);
      }
    }
    halos.push(out);
  }
  return {
    kind,
    W,
    H,
    inMap,
    halo: (k) => halos[k] ?? [],
    step,
    border: (k, dir) => {
      const x = k % W;
      const y = (k - x) / W;
      if ((y & 1) === 1) return false;
      return (dir === 3 && x === 0) || (dir === 0 && x === W - 1);
    },
    pointOf: (x, y) => {
      const c = hexCenter(g, columns ? { col: y, row: x } : { col: x, row: y });
      return [onWallLattice(c.x), onWallLattice(c.y)];
    },
    keyOf: (k) => {
      const x = k % W;
      const y = (k - x) / W;
      return columns ? `${y},${x}` : `${x},${y}`;
    },
  };
}
