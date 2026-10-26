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
 * Beside them, two rows review HX2-ASTRA-03 and 04 asked for: a 1,000 ft
 * emanation, whose reach once walked every hex within its steps before
 * the scene clipped it, and the spots of a 2,000-hex straight walk with an
 * area sweep's samples along it, which once built the whole hex line again
 * for every spot.
 *
 *   node scripts/bench-grid.ts
 */
import { DEFAULT_SETTINGS } from "../shared/model.ts";
import { computeCoverage, PREVIEW_SAMPLES, type AreaContext, type AreaTemplateInput } from "../shared/rules/aoe.ts";
import { placedOnHex } from "../shared/rules/footprint.ts";
import { gridOfShape, SQUARES, type Grid } from "../shared/rules/grid.ts";
import type { HexGrid } from "../shared/rules/hex.ts";
import { ownWalk } from "../shared/rules/movement.ts";
import { hexPiece, routeWalk } from "../shared/rules/route.ts";
import { token } from "../shared/testutil.ts";
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

function timed(name: string, run: () => number): Row {
  const times: number[] = [];
  let covered = 0;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    covered = run();
    times.push(performance.now() - t0);
  }
  return { row: name, ...stats(times.slice(1)), covered };
}

/** A 1,000 ft emanation around a Medium in the middle of a `w` by `h` hex rows scene, at `fpc` feet a cell. */
function emanationRow(name: string, w: number, h: number, fpc: number): Row {
  const g = gridOfShape("hexRows") as HexGrid;
  const caster = token("c", { size: "medium", ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: Math.floor(w / 2), row: Math.floor(h / 2) }) });
  const ctx: AreaContext = { settings: { ...DEFAULT_SETTINGS, feetPerCell: fpc, aoeCoverage: "half", aoeInclusion: "anyCell" }, bounds: { w, h }, grid: g, walls: null, tokens: { c: caster } };
  let rev = 0;
  return timed(name, () => {
    const aura: AreaTemplateInput = { id: "e", rev: ++rev, shape: "emanation", size: 1000, origin: { x: caster.x, y: caster.y, z: 0 }, yaw: 0, includeOrigin: true, attachedTo: "c", casterId: "c" };
    return computeCoverage(aura, ctx).hexes?.length ?? 0;
  });
}

/** A Medium's straight walk 2,000 hexes east on hex rows: its spots as the reducer reads a leg, then an area sweep's 600 samples, its cap, along it. */
function walkRow(): Row {
  const g = gridOfShape("hexRows") as HexGrid;
  const start = ownWalk({ ...token("w", { size: "medium" }), ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 0, row: 4 }) });
  const end = { ...start, ...placedOnHex(g, start, { col: 2000, row: 4 }) };
  return timed("Hex rows, a 2,000-hex walk's spots and an area sweep along it", () => {
    const spots = routeWalk(g, [start, end], { buildChunks: {} }).length;
    const piece = hexPiece(g, start, start, end);
    for (let k = 1; k < 600; k++) piece.at(k / 600);
    return spots;
  });
}

export function runGridBench(): Row[] {
  return [
    row("Squares, walled (9.3's worst case)", SQUARES, true),
    row("Squares, open", SQUARES, false),
    row("Hex rows, open", gridOfShape("hexRows"), false),
    row("Hex columns, open", gridOfShape("hexColumns"), false),
    row("Hex rows, open, aiming (4 a side)", gridOfShape("hexRows"), false, PREVIEW_SAMPLES),
    emanationRow("Hex rows, a 1,000 ft emanation, 200 by 200", 200, 200, 5),
    emanationRow("Hex rows, a 1,000 ft emanation at 1 ft a cell, 20 by 20", 20, 20, 1),
    walkRow(),
  ];
}

export function formatGridBench(rows: readonly Row[]): string {
  const lines = [
    `Coverage of a 1,000 ft line at 37° on a 200 by 200 scene, then the emanation and walk rows, ${RUNS - 1} timed runs, median / max ms, against 9.3's ${BUDGET_MS} ms on a phone.`,
    "",
    "row | cells, hexes or spots | ms (median / max)",
    "--- | --- | ---",
    ...rows.map((r) => `${r.row} | ${r.covered} | ${r.median.toFixed(2)} / ${r.max.toFixed(2)}`),
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(formatGridBench(runGridBench()));
