import { cellIndex, decodeHeights, decodeRough, decodeStairs, encodeHeights, encodeRough, encodeStairs } from "../heightCodec.ts";
import { chunkKey } from "../keys.ts";
import { CHUNK_CELLS, type BuildChunk, type Scene, type StairMark } from "../model.ts";
import type { OpOf } from "../protocol.ts";
import { emptyChunk, inBounds, landOnGround, parseCell, standingOn, withHeightFields, withRough, writeChunk } from "./map.ts";
import { invalid, type Tx } from "./tx.ts";

/**
 * Raised areas and stairs (docs/design-v1-maps-vision.md 4.2): heights and
 * stair marks painted on cells, kept in their chunks in the stored form of
 * shared/heightCodec.ts. Both change movement and sight, so both move the
 * walls version, and the limits step runs the split's counting pass on
 * them as on any op that writes geometry.
 */

type Cell = { x: number; y: number };

/**
 * Applies an edit to each painted cell's chunk, one write per chunk, in
 * key order so a replay touches the same keys in the same order. A chunk
 * the edit leaves as it was is not written.
 */
function editChunks(tx: Tx, scene: Scene, cells: readonly Cell[], edit: (chunk: BuildChunk, cells: readonly Cell[]) => BuildChunk): void {
  const byChunk = new Map<string, { cx: number; cy: number; cells: Cell[] }>();
  for (const cell of cells) {
    if (!inBounds(scene, cell)) throw invalid("cell outside the scene");
    const cx = Math.floor(cell.x / CHUNK_CELLS);
    const cy = Math.floor(cell.y / CHUNK_CELLS);
    const key = chunkKey(scene.id, cx, cy);
    let group = byChunk.get(key);
    if (!group) byChunk.set(key, (group = { cx, cy, cells: [] }));
    group.cells.push(cell);
  }
  for (const key of [...byChunk.keys()].sort()) {
    const group = byChunk.get(key)!;
    const chunk = tx.state.buildChunks[key] ?? emptyChunk(scene.id, group.cx, group.cy);
    const next = edit(chunk, group.cells);
    if (next.heights !== chunk.heights || next.up !== chunk.up || next.rough !== chunk.rough) writeChunk(tx, next);
  }
}

/**
 * Paints cells' ground to a height in feet, 0 clearing it. Every token on
 * the scene that stood on the ground there rises or sinks with it in the
 * same op (landOnGround in map.ts, which erase and clear share), and a
 * token flying above or burrowed below keeps its elevation.
 */
export function buildHeight(tx: Tx, op: OpOf<"build.height">): void {
  const scene = tx.scene(op.sceneId);
  const cells = op.cells.map(parseCell);
  const standing = standingOn(tx, scene.id, new Set(cells.map((c) => `${c.x},${c.y}`)));
  editChunks(tx, scene, cells, (chunk, here) => {
    const heights = decodeHeights(chunk.heights);
    for (const c of here) heights[cellIndex(chunk, c.x, c.y)] = op.height;
    return withHeightFields(chunk, encodeHeights(heights), chunk.up);
  });
  landOnGround(tx, standing);
  tx.bumpWalls(scene.id);
}

/** Marks cells as stairs pointing up by the rule ("a") or one way, or takes the marks away with null. Terrain is untouched. */
export function buildStairs(tx: Tx, op: OpOf<"build.stairs">): void {
  const scene = tx.scene(op.sceneId);
  const mark: StairMark = op.up ?? ".";
  editChunks(tx, scene, op.cells.map(parseCell), (chunk, here) => {
    const marks = decodeStairs(chunk.up);
    for (const c of here) marks[cellIndex(chunk, c.x, c.y)] = mark;
    return withHeightFields(chunk, chunk.heights, encodeStairs(marks));
  });
  tx.bumpWalls(scene.id);
}

/**
 * Marks cells as difficult ground, or clears the marks (docs/design-v1-movement.md
 * 6.3). The mark paints over the floor or the map without changing the
 * cell's terrain, and stops nothing, so no walls version moves.
 */
export function buildRough(tx: Tx, op: OpOf<"build.rough">): void {
  const scene = tx.scene(op.sceneId);
  editChunks(tx, scene, op.cells.map(parseCell), (chunk, here) => {
    const marks = decodeRough(chunk.rough);
    for (const c of here) marks[cellIndex(chunk, c.x, c.y)] = op.on;
    return withRough(chunk, encodeRough(marks));
  });
}
