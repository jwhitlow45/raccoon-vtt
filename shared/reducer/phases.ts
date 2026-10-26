import { keys } from "../keys.ts";
import type { MapPhase, PhaseGrid, Scene, SceneMap } from "../model.ts";
import type { MapPhaseInput, OpOf } from "../protocol.ts";
import { HEX_ORIGIN, hexOriginBefore } from "../rules/grid.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * Map phases (docs/design-v1-maps-vision.md section 3.4): one scene, several
 * images, the same grid. `Scene.map` is always the active phase's image, so
 * nothing that draws, projects or exports the map knows phases exist.
 *
 * The grid is kept once, in `phaseGrid`, in the pixels of a reference size
 * stored there. Each phase's grid is that reference scaled by the phase's
 * width over the reference width, one multiplication, so reordering,
 * replacing or removing phases never moves the grid off its cells.
 */

export const NOT_SAME_SHAPE = "This image is not the same shape as the map, so the grid would not line up.";
export const TOO_SMALL = "This image is too small for the map's grid.";
export const GRID_DOES_NOT_FIT = "That grid would not fit every phase of this map.";

/**
 * The bounds the protocol puts on a map's grid (`sceneMap` in
 * shared/protocol.ts), so every stored calibration imports again. The
 * client's checks import these rather than keep copies.
 */
export const MIN_CELL_PX = 1;
export const MAX_CELL_PX = 16_384;
export const MAX_ORIGIN_PX = 100_000;

/** The reference grid scaled to an image of this width: one multiplication. */
function scaledGrid(grid: PhaseGrid, widthPx: number): Pick<SceneMap, "cellPx" | "originPx"> {
  const scale = widthPx / grid.refWidthPx;
  return { cellPx: grid.cellPx * scale, originPx: { x: grid.originPx.x * scale, y: grid.originPx.y * scale } };
}

/** The active image a phase gives the map: its own asset and size, with the reference grid scaled to it. */
export function phaseMap(grid: PhaseGrid, phase: Pick<MapPhase, "assetId" | "widthPx" | "heightPx">): SceneMap {
  return { assetId: phase.assetId, widthPx: phase.widthPx, heightPx: phase.heightPx, ...scaledGrid(grid, phase.widthPx) };
}

export function gridFits(map: Pick<SceneMap, "cellPx" | "originPx">): boolean {
  const { cellPx, originPx } = map;
  return cellPx >= MIN_CELL_PX && cellPx <= MAX_CELL_PX && Math.abs(originPx.x) <= MAX_ORIGIN_PX && Math.abs(originPx.y) <= MAX_ORIGIN_PX;
}

/**
 * Why an image cannot be a phase of this grid, or null when it can. Its
 * height, computed from its width at the reference's aspect ratio, must be
 * within a pixel of its own: canonical sizes are rounded to whole pixels,
 * which a tolerance in pixels follows and a percentage does not.
 */
export function phaseProblem(grid: PhaseGrid, size: Pick<MapPhase, "widthPx" | "heightPx">): string | null {
  const expected = (size.widthPx * grid.refHeightPx) / grid.refWidthPx;
  if (Math.abs(expected - size.heightPx) > 1) return NOT_SAME_SHAPE;
  return gridFits(scaledGrid(grid, size.widthPx)) ? null : TOO_SMALL;
}

/** The scene's calibration, or the one its current map would start. */
function gridOf(scene: Scene & { map: SceneMap }): PhaseGrid {
  if (scene.phaseGrid) return scene.phaseGrid;
  const { widthPx, heightPx, cellPx, originPx } = scene.map;
  return { refWidthPx: widthPx, refHeightPx: heightPx, cellPx, originPx };
}

function activePhase(scene: Scene): MapPhase | undefined {
  return scene.phases?.find((p) => p.id === scene.phaseId);
}

/**
 * The scene showing a phase it switched to: a phase with a light level
 * gives it to the scene's vision, so Night can make the scene dark
 * (docs/design-v1-maps-vision.md 4.3.8), and one without leaves the level
 * as it was. Every way the showing phase changes applies it the same way: a
 * switch, the list losing the showing phase, and an import whose showing
 * phase's image did not come through.
 */
export function withPhaseLight(scene: Scene, phase: Pick<MapPhase, "light">): Scene {
  if (phase.light === undefined) return scene;
  // A per-player scene stays one, whatever the phase does to its light (docs/design-v1-per-player-vision.md 6.7).
  return { ...scene, vision: { on: scene.vision?.on ?? false, light: phase.light, ...(scene.vision?.perPlayer === true ? { perPlayer: true as const } : {}) } };
}

/**
 * `scene.update { phases }`: the whole list. A scene's first list takes its
 * grid reference from the map it has then. The active phase stays active
 * while it is listed, and its image may have been replaced. Otherwise the
 * first phase becomes active, with its light level as a switch gives it
 * (withPhaseLight). A light level the list sets on the showing phase
 * applies at once, and taking it away leaves the scene's level as it is.
 */
export function withPhases(scene: Scene, phases: MapPhaseInput[]): Scene {
  if (!scene.map) throw invalid("the scene has no map to add phases to");
  const grid = gridOf({ ...scene, map: scene.map });
  for (const phase of phases) {
    const problem = phaseProblem(grid, phase);
    if (problem) throw invalid(problem);
  }
  const list: MapPhase[] = phases.map((p) => {
    const phase: MapPhase = { id: p.id, name: p.name, assetId: p.assetId, widthPx: p.widthPx, heightPx: p.heightPx };
    if (p.light !== undefined) phase.light = p.light;
    return phase;
  });
  const active = list.find((p) => p.id === scene.phaseId) ?? list[0]!;
  const next: Scene = { ...scene, phases: list, phaseId: active.id, phaseGrid: grid, map: phaseMap(grid, active) };
  // A first list names the image already showing, so the scene keeps its light until the showing phase or its light
  // level changes. A level set on the showing phase applies at once, as switching to it would apply it.
  if (scene.phaseId === undefined) return next;
  if (active.id !== scene.phaseId || active.light !== activePhase(scene)?.light) return withPhaseLight(next, active);
  return next;
}

/**
 * Every op that stores phases checks them, so this refusal is for a scene
 * no op made, such as one a hand-made backup brought in: a switch never
 * writes a map the protocol would refuse. For the same reason it refuses a
 * map whose origin lies before the image on a hex scene, as every other op
 * that writes a map does (reducer/room.ts onHexGrid, D-261026-8).
 */
export function sceneSetPhase(tx: Tx, op: OpOf<"scene.setPhase">): void {
  const scene = tx.scene(op.sceneId);
  const phase = scene.phases?.find((p) => p.id === op.phaseId);
  if (!scene.phaseGrid || !phase) throw gone("phase");
  if (phase.id === scene.phaseId) return;
  const problem = phaseProblem(scene.phaseGrid, phase);
  if (problem) throw invalid(problem);
  const next = withPhaseLight({ ...scene, phaseId: phase.id, map: phaseMap(scene.phaseGrid, phase) }, phase);
  if (hexOriginBefore(next)) throw invalid(HEX_ORIGIN);
  tx.write(keys.scene(scene.id), next);
}

/**
 * `scene.setMap` on a scene with phases: a new image replaces the active
 * phase's, on the reference grid, so it must have the reference's shape.
 * No map at all removes every phase with their grid.
 */
export function setMapWithPhases(scene: Scene, map: SceneMap | null): Scene {
  if (map === null) {
    const { map: _map, phases: _phases, phaseId: _phaseId, phaseGrid: _grid, ...rest } = scene;
    return rest;
  }
  const active = activePhase(scene);
  if (!scene.phaseGrid || !active) return { ...scene, map };
  const replaced: MapPhase = { ...active, assetId: map.assetId, widthPx: map.widthPx, heightPx: map.heightPx };
  const problem = phaseProblem(scene.phaseGrid, replaced);
  if (problem) throw invalid(problem);
  const phases = (scene.phases ?? []).map((p) => (p.id === active.id ? replaced : p));
  return { ...scene, phases, map: phaseMap(scene.phaseGrid, replaced) };
}

/**
 * `scene.setGrid` on a scene with phases: the grid the DM lined up on the
 * active image, converted into reference pixels by that image's width over
 * the reference width. A grid that would leave any phase outside the
 * protocol's bounds is refused, so every stored calibration stays valid.
 * The reference grid itself is not held to them: no image need have the
 * reference's size any more.
 */
export function setGridWithPhases(scene: Scene, grid: Pick<SceneMap, "cellPx" | "originPx">): Scene {
  const active = activePhase(scene);
  if (!scene.map || !scene.phaseGrid || !active) throw invalid("the scene has no map to align");
  const toRef = scene.phaseGrid.refWidthPx / active.widthPx;
  const next: PhaseGrid = {
    ...scene.phaseGrid,
    cellPx: grid.cellPx * toRef,
    originPx: { x: grid.originPx.x * toRef, y: grid.originPx.y * toRef },
  };
  if ((scene.phases ?? []).some((p) => phaseProblem(next, p) !== null)) throw invalid(GRID_DOES_NOT_FIT);
  return { ...scene, phaseGrid: next, map: phaseMap(next, active) };
}
