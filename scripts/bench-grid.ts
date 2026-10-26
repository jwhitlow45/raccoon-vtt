/**
 * Hex grids' rules rows of the performance gate (docs/design-v1-hex-grids.md
 * section 10, against docs/design.md 9.3's budget): the coverage of a
 * 1,000 ft line at an angle, the worst bounded area, on a 200 by 200 scene,
 * graded per hex on hex rows and hex columns, beside the same line on
 * squares, open and walled (9.3's own worst case, bench-vision.ts
 * `capRoom`'s walls). 9.3 budgets one placed recompute at 8 ms on a phone,
 * so a laptop's time should sit well under it. A hex scene holds no walls
 * until phase H2, so its rows are open. The preview rows sample 4 a cell
 * side, as an area being aimed does. Hex lines on the board are the board's
 * own rows (HX-3).
 *
 *   node scripts/bench-grid.ts
 */
import { DEFAULT_SETTINGS } from "../shared/model.ts";
import { computeCoverage, PREVIEW_SAMPLES, type AreaContext, type AreaTemplateInput } from "../shared/rules/aoe.ts";
import { gridOfShape, SQUARES, type Grid } from "../shared/rules/grid.ts";
import { sceneWalls } from "../shared/rules/walls.ts";
import { capRoom } from "./bench-vision.ts";

const RUNS = 21;
const BUDGET_MS = 8;

type Row = { row: string; median: number; max: number; covered: number };

function stats(times: number[]): { median: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

/** A 1,000 ft line, 5 ft wide, at an angle across the scene: from near a corner on an open scene, from the dungeon spot where walls let it reach farthest on a walled one. */
function line(rev: number, walled: boolean): AreaTemplateInput {
  const origin = walled ? { x: 65.3, y: 65.1, z: 0 } : { x: 3.3, y: 7.1, z: 0 };
  return { id: "line", rev, shape: "line", size: 1000, width: 5, origin, yaw: 37, includeOrigin: false };
}

function row(name: string, grid: Grid, walled: boolean, samples?: number): Row {
  const { state } = capRoom("bright");
  const scene = state.scenes.bench!;
  const ctx: AreaContext = {
    settings: { ...DEFAULT_SETTINGS, aoeCoverage: "half", aoeInclusion: "anyCell" },
    bounds: scene.bounds,
    grid,
    walls: walled ? sceneWalls(scene, state.buildChunks) : null,
    ...(samples !== undefined ? { samples } : {}),
  };
  const times: number[] = [];
  let covered = 0;
  // A new rev each run, so no cache answers.
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const result = computeCoverage(line(i + 1, walled), ctx);
    times.push(performance.now() - t0);
    covered = result.hexes?.length ?? result.cells.length;
  }
  return { row: name, ...stats(times.slice(1)), covered };
}

export function runGridBench(): Row[] {
  return [
    row("Squares, walled (9.3's worst case)", SQUARES, true),
    row("Squares, open", SQUARES, false),
    row("Hex rows, open", gridOfShape("hexRows"), false),
    row("Hex columns, open", gridOfShape("hexColumns"), false),
    row("Hex rows, open, aiming (4 a side)", gridOfShape("hexRows"), false, PREVIEW_SAMPLES),
  ];
}

export function formatGridBench(rows: readonly Row[]): string {
  const lines = [
    `Coverage of a 1,000 ft line at 37° on a 200 by 200 scene, ${RUNS - 1} timed runs, median / max ms, against 9.3's ${BUDGET_MS} ms on a phone.`,
    "",
    "row | cells or hexes covered | ms (median / max)",
    "--- | --- | ---",
    ...rows.map((r) => `${r.row} | ${r.covered} | ${r.median.toFixed(2)} / ${r.max.toFixed(2)}`),
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(formatGridBench(runGridBench()));
