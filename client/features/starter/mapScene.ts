import type { StarterWork } from "#shared/starter.ts";
import { BOX_CELLS, calibrationFromBox, fitBounds, MAX_CELL_PX, MIN_CELL_PX } from "../grid/calibrate.ts";
import { DEFAULT_GRID, mapScene, type MapAsset, type SceneInput } from "../scenes/create.ts";

/**
 * A scene from a starter map (docs/design-v1-starter-art.md 7). The
 * catalog measured each map's drawn grid on the file as shipped, so the
 * scene starts on it and skips grid alignment, as a size in a file's name
 * does: the cell size goes in as that hint, and a measured origin goes
 * through calibrationFromBox, as a found grid's does, so it is rounded and
 * snapped to the image's edge by the same rule. A map with no measured
 * grid starts on the upload's guess, and the DM lines it up next.
 *
 * A few maps have a measured square but no origin: the build found how far
 * apart the lines are and not where they fall. Their scene starts at that
 * size, so Line up grid's box opens at the right size, but it still opens
 * on Line up grid, since a grid from the image's corner can sit half a
 * square off the drawn one.
 *
 * The room's copy is normally the file as shipped. Should the server ever
 * store it at another size, the grid scales with it.
 *
 * A paper map's grid color replaces the app's white, which vanishes on
 * white paper. Feet per square is a room setting, never a scene's, so it
 * only comes back for the picker to mention.
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export type StarterMapScene = {
  scene: SceneInput;
  /** Whether the scene starts on the map's own grid, so it needs no alignment. */
  aligned: boolean;
  /** The map's feet per square, when the catalog says. */
  feetPerCell: number | null;
};

export function starterMapScene(input: { id: string; name: string; asset: MapAsset; work: Pick<StarterWork, "name" | "width" | "grid" | "gridColor"> }): StarterMapScene {
  const { asset, work } = input;
  const k = work.width > 0 ? asset.width / work.width : 1;
  const cellPx = work.grid ? work.grid.cellPx * k : NaN;
  const sized = Number.isFinite(cellPx) && cellPx >= MIN_CELL_PX && cellPx <= MAX_CELL_PX;
  const origin = work.grid?.originPx;
  const aligned = sized && origin !== undefined;
  const name = input.name.trim() || work.name;
  const { scene } = mapScene({ id: input.id, name, asset: sized ? { ...asset, cellPx } : { id: asset.id, width: asset.width, height: asset.height } });
  const map =
    aligned && scene.map ? { ...scene.map, ...calibrationFromBox({ x: origin.x * k, y: origin.y * k, size: BOX_CELLS * cellPx }) } : scene.map;
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
