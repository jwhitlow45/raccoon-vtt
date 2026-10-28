/**
 * Hex grids' rules rows of the performance gate (docs/design-v1-hex-grids.md
 * section 10, against docs/design.md 9.3's budget): the coverage of a
 * 1,000 ft line at an angle, the worst bounded area, on a 200 by 200 scene,
 * graded per hex on hex rows and hex columns, beside the same line on
 * squares, open and walled (9.3's own worst case, bench-vision.ts
 * `capRoom`'s walls). 9.3 budgets one placed recompute at 8 ms on a phone,
 * so a laptop's time should sit well under it. A hex scene holds no walls
 * until phase H2, so its rows are open. The preview rows sample 4 a cell
 * side, as an area being aimed does.
 *
 * The board's hex lines (HX-D18, HX-3) add three rows: the path a redraw
 * builds for what a 1440 by 900 canvas shows of the largest hex scene, at
 * fit (under 6 px a hex, so none), at 40 px a cell, and at 6 px a cell,
 * the most hexes a view ever draws lines for. They time the walk of the
 * hexes in view and the path's points, which is this code's part of a
 * frame. The stroke itself is the canvas's, and the isometric bench
 * (bench-iso.ts) times whole frames.
 *
 * Beside them, two rows review HX2-ASTRA-03 and 04 asked for: a 1,000 ft
 * emanation, whose reach once walked every hex within its steps before
 * the scene clipped it, and the spots of a 2,000-hex straight walk with an
 * area sweep's samples along it, which once built the whole hex line again
 * for every spot.
 *
 * Phase H2's wall clip (HX-D10) adds two rows on the walled scene at the
 * sight caps, set to hex rows: the clip of 500 Gargantuans, a scene's
 * most tokens, as a projection asks it once per token, and a 200-spot
 * walk's shared ground on a per-player scene with fog, as seenAtEvery
 * reads it per spot. Each run puts them at new spots, so no clip comes
 * from the cache.
 *
 *   node scripts/bench-grid.ts
 */
import { tileKey } from "../shared/keys.ts";
import { LIMITS } from "../shared/limits.ts";
import { DEFAULT_SETTINGS, type FogTile, type RoomState } from "../shared/model.ts";
import { seenAtEvery } from "../shared/project.ts";
import { computeCoverage, PREVIEW_SAMPLES, type AreaContext, type AreaTemplateInput } from "../shared/rules/aoe.ts";
import { placedOnHex } from "../shared/rules/footprint.ts";
import { gridOfShape, SQUARES, type Grid } from "../shared/rules/grid.ts";
import type { HexGrid } from "../shared/rules/hex.ts";
import { ownWalk } from "../shared/rules/movement.ts";
import { hexPiece, routeWalk } from "../shared/rules/route.ts";
import { rng, token } from "../shared/testutil.ts";
import { FULL_TILE, tilesAcross } from "../shared/rules/fog.ts";
import { clipFootprint, sightClipOf } from "../shared/rules/vision.ts";
import { sceneWalls } from "../shared/rules/walls.ts";
import { capRoom } from "./bench-vision.ts";
import { hexLinesInView } from "../client/canvas/layers/hexSpans.ts";
import { ringShape } from "../client/features/measure/rings.ts";

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

/** The hex lines a 1440 by 900 canvas at `px` a cell shows of a 200 by 200 hex rows scene, from its middle, into a sink that only counts. */
function linesRow(name: string, px: number): Row {
  const g = gridOfShape("hexRows") as HexGrid;
  const w = 1440 / px;
  const h = 900 / px;
  const x0 = 100 - w / 2;
  const y0 = 100 - h / 2;
  const corners = [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }];
  let points = 0;
  const sink = { moveTo: () => void points++, lineTo: () => void points++ };
  return timed(name, () => hexLinesInView(g, { w: 200, h: 200 }, { corners, pxPerCell: px }, sink));
}

/**
 * A Gargantuan's range ring on a 200 by 200 scene at 5 ft a cell, each run
 * drawn again as a ring is: standing at one spot, or dragged a hex a run,
 * since a ring is worked out again on every change of a drag.
 */
function ringRow(name: string, grid: Grid, ft: number, dragging: boolean): Row {
  const g = grid.shape === "hex" ? grid : null;
  const rules = { feetPerCell: 5, diagonal: "five" as const };
  let step = 0;
  return timed(name, () => {
    const col = 90 + (dragging ? step++ % 20 : 0);
    const at = g ? placedOnHex(g, { size: "gargantuan", x: 0, y: 0 }, { col, row: 100 }) : { x: col, y: 100 };
    return ringShape(grid, { ...token("g", { size: "gargantuan" }), ...at }, ft, rules, { w: 200, h: 200 }).segments.length / 4;
  });
}

/**
 * The wall clip at the sight caps (HX-D10): capRoom's walled scene on hex
 * rows, every Gargantuan at a new unsnapped spot each run. Per token, the
 * clip a projection asks of each of a scene's most tokens. Per spot, a
 * walk's seenAtEvery on the scene made per player with every tile
 * revealed and vision off, so each spot reads the clip, the fog and every
 * hex's shared ground.
 */
function clipRows(): Row[] {
  const g = gridOfShape("hexRows") as HexGrid;
  const { state } = capRoom("bright");
  const scene = { ...state.scenes.bench!, gridShape: "hexRows" as const, vision: { on: false, light: "bright" as const, perPlayer: true as const } };
  const clip = sightClipOf(sceneWalls(scene, state.buildChunks));
  const fogTiles: Record<string, FogTile> = {};
  for (let ty = 0; ty < tilesAcross(scene.bounds.h); ty++) {
    for (let tx = 0; tx < tilesAcross(scene.bounds.w); tx++) fogTiles[tileKey(scene.id, tx, ty)] = { sceneId: scene.id, tx, ty, rev: 0, bits: FULL_TILE };
  }
  const room: RoomState = { ...state, scenes: { [scene.id]: scene }, fogTiles };
  const r = rng(2027);
  const spot = () => ({ x: 4 + r() * (scene.bounds.w - 8), y: 4 + r() * (scene.bounds.h - 8) });
  const garg = { ...token("g", { sceneId: scene.id, size: "gargantuan" }) };
  const perToken = timed(`Hex rows at the sight cap, the wall clip of ${LIMITS.tokensPerScene} Gargantuans in a projection`, () => {
    let kept = 0;
    for (let i = 0; i < LIMITS.tokensPerScene; i++) kept += clipFootprint(g, { ...garg, ...spot() }, clip).kept.length;
    return kept;
  });
  const perSpot = timed("Hex rows at the sight cap, seenAtEvery over a Gargantuan's 200 spots, per player, fog on", () => {
    const spots = Array.from({ length: 200 }, () => ({ ...spot(), elevation: 0 }));
    seenAtEvery(room, garg, spots, {});
    return spots.length;
  });
  return [perToken, perSpot];
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
    linesRow("Hex lines, 200 by 200, a 1440 by 900 canvas at fit (4.5 px a cell)", 900 / 200),
    linesRow("Hex lines, 200 by 200, a 1440 by 900 canvas at 40 px a cell", 40),
    linesRow("Hex lines, 200 by 200, a 1440 by 900 canvas at 6 px a cell", 6),
    ringRow("Squares, a 1,000 ft range ring round a Gargantuan, 200 by 200, standing", SQUARES, 1000, false),
    ringRow("Hex rows, a 150 ft range ring round a Gargantuan, 200 by 200, standing", gridOfShape("hexRows"), 150, false),
    ringRow("Hex rows, a 150 ft range ring round a Gargantuan, 200 by 200, dragged a hex a run", gridOfShape("hexRows"), 150, true),
    ringRow("Hex rows, a 1,000 ft range ring round a Gargantuan, 200 by 200, standing", gridOfShape("hexRows"), 1000, false),
    ringRow("Hex rows, a 1,000 ft range ring round a Gargantuan, 200 by 200, dragged a hex a run", gridOfShape("hexRows"), 1000, true),
    ...clipRows(),
  ];
}

export function formatGridBench(rows: readonly Row[]): string {
  const lines = [
    `Coverage of a 1,000 ft line at 37° on a 200 by 200 scene, then the emanation and walk rows, ${RUNS - 1} timed runs, median / max ms, against 9.3's ${BUDGET_MS} ms on a phone.`,
    "",
    "row | cells, hexes, spots or sides | ms (median / max)",
    "--- | --- | ---",
    ...rows.map((r) => `${r.row} | ${r.covered} | ${r.median.toFixed(2)} / ${r.max.toFixed(2)}`),
  ];
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(formatGridBench(runGridBench()));
