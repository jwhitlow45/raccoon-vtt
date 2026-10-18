import type { StarterWork } from "#shared/starter.ts";
import { BOX_CELLS, calibrationFromBox, fitBounds, MAX_CELL_PX, MIN_CELL_PX } from "../grid/calibrate.ts";
import { DEFAULT_GRID, mapScene, type MapAsset, type SceneInput } from "../scenes/create.ts";

/**
 * A scene from a starter map (docs/design-v1-starter-art.md 7). The build
 * measured each map's drawn grid on the file as shipped, so the scene
 * starts on it and skips grid alignment, as a size in a file's name does:
 * the cell size goes in as that hint, and a measured origin goes through
 * calibrationFromBox, as a found grid's does, so it is rounded and snapped
 * to the image's edge by the same rule. A map with no measured grid starts
 * on the upload's guess, and the DM lines it up next.
 *
 * A few maps have a measured square but no origin: the build found how far
 * apart the lines are and not where they fall. Their scene starts at that
 * size, so Line up grid's box opens at the right size, but it still opens
 * on Line up grid, since a grid from the image's corner can sit half a
 * square off the drawn one.
 *
 * The grid always describes the file the room holds. A work's key can be
 * rebuilt with a new file, and a tab can hold its catalog from before a
 * deploy, so a fresh pick takes the grid the server answers from the file
 * it copied (answeredGrid), and a pick the room already holds takes this
 * page's catalog only when the catalog's file is the room's (retainedGrid).
 * Both take a row by its shape rather than as lib/api.ts AssetRow, so the
 * e2e suite imports this module without the DOM types api.ts needs.
 *
 * A paper map's grid color replaces the app's white, which vanishes on
 * white paper. Feet per square is a room setting, never a scene's, so it
 * only comes back for the picker to mention.
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A drawn grid on the image as the room stored it. */
export type StarterGrid = { cellPx: number; originPx?: { x: number; y: number } };

export type StarterMapScene = {
  scene: SceneInput;
  /** Whether the scene starts on the map's own grid, so it needs no alignment. */
  aligned: boolean;
  /** The map's feet per square, when the catalog says. */
  feetPerCell: number | null;
};

/** The grid a fresh pick's answer carries, measured by the server's catalog on the very file it copied. */
export function answeredGrid(row: { cellPx?: number; originPx?: { x: number; y: number } }): StarterGrid | null {
  if (row.cellPx === undefined) return null;
  return { cellPx: row.cellPx, ...(row.originPx ? { originPx: row.originPx } : null) };
}

/**
 * The catalog's grid for a pick the room already holds, scaled to the
 * room's copy, or null unless the room's file is the one this page's
 * catalog describes: a rebuilt work, or a catalog older than the pick,
 * would put another file's grid on it.
 */
export function retainedGrid(row: { width: number; sha256?: string }, work: Pick<StarterWork, "sha256" | "width" | "grid">): StarterGrid | null {
  if (!work.grid || work.width <= 0 || !row.sha256 || row.sha256.toLowerCase() !== work.sha256.toLowerCase()) return null;
  const k = row.width / work.width;
  const { cellPx, originPx } = work.grid;
  return { cellPx: cellPx * k, ...(originPx ? { originPx: { x: originPx.x * k, y: originPx.y * k } } : null) };
}

export function starterMapScene(input: {
  id: string;
  name: string;
  asset: MapAsset;
  work: Pick<StarterWork, "name" | "grid" | "gridColor">;
  grid: StarterGrid | null;
}): StarterMapScene {
  const { asset, work, grid } = input;
  const cellPx = grid ? grid.cellPx : NaN;
  const sized = Number.isFinite(cellPx) && cellPx >= MIN_CELL_PX && cellPx <= MAX_CELL_PX;
  const origin = sized ? grid?.originPx : undefined;
  const aligned = origin !== undefined;
  const name = input.name.trim() || work.name;
  const { scene } = mapScene({ id: input.id, name, asset: sized ? { ...asset, cellPx } : { id: asset.id, width: asset.width, height: asset.height } });
  const map = origin && scene.map ? { ...scene.map, ...calibrationFromBox({ x: origin.x, y: origin.y, size: BOX_CELLS * cellPx }) } : scene.map;
  const color = work.gridColor && HEX_COLOR.test(work.gridColor) ? work.gridColor.toLowerCase() : null;
  return {
    scene: {
      ...scene,
      ...(map ? { map, bounds: fitBounds(map) } : null),
      grid: color ? { ...DEFAULT_GRID, color } : DEFAULT_GRID,
    },
    aligned,
    feetPerCell: work.grid?.feetPerCell ?? null,
  };
}
