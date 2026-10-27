import { LIMITS, serializedBytes } from "#shared/limits.ts";
import type { LightLevel, SceneMap } from "#shared/model.ts";
import { MAX_BUILD_EDGES, type ClientOp, type OpOf } from "#shared/protocol.ts";
import { MAX_CELL_PX, MAX_ORIGIN_PX, MIN_CELL_PX } from "#shared/reducer/phases.ts";
import { BLOCKS_MOVES, cleanName, DEFAULT_GRID, MAP_BACKGROUND } from "../scenes/create.ts";
import type { ImportPlan } from "./convert.ts";

/**
 * The ops a Universal VTT import sends (docs/design-v1-maps-vision.md
 * section 3.1 step 8): `scene.create`, then `build.edge`, `build.walls`
 * and `build.lights` in batches, every op under 48 KiB serialized. They are
 * ordinary bounded ops, which the server validates as it validates any
 * other, and the dialog sends them in one undo group.
 */

/** The byte bound of a free walls op (shared/limits.ts), used for every batch of the import. */
export const OP_BYTES = LIMITS.freeWallsOpBytes;

/**
 * Splits items into runs that each make an op of at most `maxItems` items
 * and `maxBytes` serialized. The size is counted, not guessed: an op with
 * items serializes to the op with an empty list, plus each item, plus a
 * comma between two, so one measure of each item is exact.
 */
export function batchByBytes<T>(items: readonly T[], maxItems: number, maxBytes: number, wrap: (items: T[]) => unknown): T[][] {
  const base = serializedBytes(wrap([]));
  const batches: T[][] = [];
  let current: T[] = [];
  let size = base;
  for (const item of items) {
    const bytes = serializedBytes(item);
    if (current.length > 0 && (current.length >= maxItems || size + 1 + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      size = base;
    }
    size += bytes + (current.length > 0 ? 1 : 0);
    current.push(item);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type SceneChoices = { id: string; name: string; light?: LightLevel };

/** The canonical map an upload answered with, and the file's own image width the grid was measured in. */
export type UploadedMap = { assetId: string; width: number; height: number; fileImageWidth: number };

export type SceneInput = OpOf<"scene.create">["scene"];

/**
 * Where the uploaded image sits. The file's grid is `pixels_per_grid` of
 * its own image's pixels, and the server's full variant may be smaller, so
 * the canonical cell is that times the canonical width over the file's.
 * The image starts at `frame.image` squares, so world 0 is that many cells
 * before its corner. Null when the grid falls outside what a map may store.
 */
export function placeMap(plan: Pick<ImportPlan, "frame" | "pixelsPerGrid">, upload: UploadedMap): SceneMap | null {
  const cellPx = (plan.pixelsPerGrid * upload.width) / upload.fileImageWidth;
  const originPx = { x: -plan.frame.image.x * cellPx, y: -plan.frame.image.y * cellPx };
  if (!(cellPx >= MIN_CELL_PX && cellPx <= MAX_CELL_PX)) return null;
  if (Math.abs(originPx.x) > MAX_ORIGIN_PX || Math.abs(originPx.y) > MAX_ORIGIN_PX) return null;
  return { assetId: upload.assetId, widthPx: upload.width, heightPx: upload.height, cellPx, originPx };
}

/**
 * The new scene. It walls nothing by itself (`autoWalls: "off"`), since the
 * file brings its walls, and the reducer never infers the rule, so the op
 * says it. Its grid is the file's, exact, which the scene keeps a mark of
 * (`gridFromFile`) for Find the grid. It starts under fog, and the
 * dialog's Players see sets fog and party vision over that
 * (scenes/create.ts `withPlayersSee`).
 */
export function importScene(plan: Pick<ImportPlan, "frame">, map: SceneMap, choices: SceneChoices): SceneInput {
  return {
    id: choices.id,
    name: cleanName(choices.name, "Map"),
    bounds: { w: plan.frame.w, h: plan.frame.h },
    background: MAP_BACKGROUND,
    grid: DEFAULT_GRID,
    fogEnabled: true,
    map,
    autoWalls: "off",
    gridFromFile: true,
    ...BLOCKS_MOVES,
    // The light level for when the DM turns party vision on (docs/design-v1-maps-vision.md 4.3.8). Vision itself stays off.
    ...(choices.light ? { vision: { on: false, light: choices.light } } : {}),
  };
}

/** Every op of the import, in the order they must apply: the scene, its edges, its free walls, its lights. */
export function importOps(scene: SceneInput, plan: Pick<ImportPlan, "edges" | "walls" | "lights">, newLightId: () => string): ClientOp[] {
  const sceneId = scene.id;
  const ops: ClientOp[] = [{ t: "scene.create", scene }];
  const edgeOp = (edges: OpOf<"build.edge">["edges"]): ClientOp => ({ t: "build.edge", sceneId, edges });
  for (const edges of batchByBytes(plan.edges, MAX_BUILD_EDGES, OP_BYTES, edgeOp)) ops.push(edgeOp(edges));
  const wallOp = (put: OpOf<"build.walls">["put"] & {}): ClientOp => ({ t: "build.walls", sceneId, put });
  for (const put of batchByBytes(plan.walls, LIMITS.freeWallsPerOp, OP_BYTES, wallOp)) ops.push(wallOp(put));
  const lights = plan.lights.map((l) => ({ id: newLightId(), ...l }));
  const lightOp = (put: OpOf<"build.lights">["put"] & {}): ClientOp => ({ t: "build.lights", sceneId, put });
  for (const put of batchByBytes(lights, LIMITS.lightsPerOp, OP_BYTES, lightOp)) ops.push(lightOp(put));
  return ops;
}
