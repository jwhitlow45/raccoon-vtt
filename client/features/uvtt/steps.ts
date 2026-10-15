import { placeMap } from "./batch.ts";
import { convertUvtt, frameOf, type ImportOptions, type ImportPlan } from "./convert.ts";
import type { ImagePlan } from "./image.ts";
import { GRID_PROBLEM } from "./limits.ts";
import { readUvtt, type ReadResult, type UvttMap } from "./schema.ts";

/**
 * The worker's checks, by what the import makes (worker.ts), as plain
 * functions so the tests run them on synthetic files.
 */

/** A new scene from the whole file, or a phase of a scene from its image alone (section 3.4). */
export type ReadTarget = "scene" | "phase";

/**
 * Step 1 for the target. A new scene takes the file's walls, doors, lights
 * and size, so they are checked against the map and a scene's 200 squares
 * first. A phase keeps its scene's own walls, size and grid, so neither
 * check applies to it, and a file that fails them can still give a phase
 * its image.
 */
export function checkFile(raw: unknown, target: ReadTarget): ReadResult {
  const checked = readUvtt(raw, { geometry: target === "scene" });
  if (!checked.ok || target === "phase") return checked;
  const framed = frameOf(checked.map);
  return framed.ok ? checked : framed;
}

/**
 * Steps 3 to 7, then the grid as the upload will place it. The server
 * keeps a map at the size it is sent when that is at most 8,192 px, and
 * the import sends nothing larger, so the canonical width is known now:
 * the resize's, or the file's own. A `pixels_per_grid` that puts a cell
 * outside what a map may store is refused here, on the summary sheet,
 * rather than after a full upload that would leave its image unused.
 */
export function planScene(
  map: UvttMap,
  options: ImportOptions,
  image: { width: number; height: number; plan: ImagePlan },
): { plan: ImportPlan | null; problem: string | null } {
  const result = convertUvtt(map, options);
  if (!result.ok) return { plan: null, problem: result.error };
  const canonical = image.plan.kind === "resize" ? image.plan : image;
  const placed = placeMap(result.plan, { assetId: "", width: canonical.width, height: canonical.height, fileImageWidth: image.width });
  return placed ? { plan: result.plan, problem: null } : { plan: null, problem: GRID_PROBLEM };
}
