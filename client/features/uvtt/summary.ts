import { LIMITS } from "#shared/limits.ts";
import type { GridShape } from "#shared/model.ts";
import { HEX_LIMITS } from "../grid/words.ts";
import { MAX_MAP_SIDE, MAX_MAP_UPLOAD_BYTES, SIMPLIFY_STEPS, count } from "./limits.ts";
import type { ImportPlan, Summary } from "./convert.ts";
import type { ReadInfo } from "./messages.ts";
import { proposedLight, type LightProposal } from "../vision/uvttLight.ts";

/** The proposal shown with the current conversion, including a retry after the first plan failed. */
export function summaryLight(read: { info: Pick<ReadInfo, "environment">; plan: Pick<ImportPlan, "lights"> | null } | null): LightProposal | null {
  return read ? proposedLight(read.info.environment, read.plan?.lights.length ?? 0) : null;
}

/**
 * The summary sheet's sentences (docs/design-v1-maps-vision.md section
 * 3.1, "DM behavior"), so the DM can check an import against the map
 * before anything is sent.
 */

function n(value: number, one: string, many: string): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

/** "412 walls (380 on the grid, 32 free), 14 doors, 3 windows, 9 lights." */
export function foundLine(s: Summary): string {
  const walls = s.gridWalls + s.freeWalls;
  const wallText = s.gridWalls > 0 && s.freeWalls > 0 ? `${n(walls, "wall", "walls")} (${count(s.gridWalls)} on the grid, ${count(s.freeWalls)} free)` : n(walls, "wall", "walls");
  return `${wallText}, ${n(s.doors, "door", "doors")}, ${n(s.windows, "window", "windows")}, ${n(s.lights, "light", "lights")}.`;
}

/** What the import changed from the file, each as its own sentence, or nothing when it changed nothing. */
export function notes(s: Summary): string[] {
  const out: string[] = [];
  if (s.welded > 0) out.push(`Joined ${n(s.welded, "wall end", "wall ends")} that nearly met, so no gap is left between them.`);
  if (s.clipped > 0) out.push(`Cut back ${n(s.clipped, "wall, door or light", "walls, doors and lights")} that ran past the map's edge.`);
  const overCap = s.lightsLeftOut - s.lightsFarOutside;
  if (overCap > 0) out.push(`Left out the ${n(overCap, "smallest light", "smallest lights")}: a scene holds ${LIMITS.lightsPerScene}.`);
  if (s.lightsFarOutside > 0) out.push(`Left out ${n(s.lightsFarOutside, "light that", "lights that")} sat far outside the map.`);
  if (s.lightsMoved > 0) out.push(`Moved ${n(s.lightsMoved, "light", "lights")} a little off the wall ${s.lightsMoved === 1 ? "it sat" : "they sat"} on.`);
  if (s.tolerance > SIMPLIFY_STEPS[0]) out.push(`Smoothed curved walls more than usual to fit a scene's ${count(LIMITS.freeWallsPerScene)} free walls.`);
  return out;
}

/**
 * What happens to the image before it uploads, said after its size. Only
 * an image over 8,192 px on its long side is drawn down. One within that
 * whose file is over a map upload's 32 MB is encoded again at its own
 * size, which keeps every pixel.
 */
export function imageNote(image: { width: number; height: number }, resize: boolean): string {
  if (!resize) return "";
  if (Math.max(image.width, image.height) > MAX_MAP_SIDE) return `, drawn down to ${count(MAX_MAP_SIDE)} pixels on its long side before it uploads`;
  return `, encoded again at this size before it uploads, since the image is over ${MAX_MAP_UPLOAD_BYTES / (1024 * 1024)} MB`;
}

/** "12 MB" or "800 KB", for the upload step. */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Why the import makes squares in a room whose new scenes start on hexes
 * (docs/design-v1-hex-grids.md HX-D13): the file's walls stand in its own
 * square grid. Nothing in a room on squares, where there is nothing to say.
 */
export function shapeNote(newScenes: GridShape | undefined): string | null {
  return newScenes === undefined ? null : HEX_LIMITS.uvtt;
}
