import { LIMITS } from "#shared/limits.ts";
import type { MapPhase, PhaseGrid, Scene } from "#shared/model.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { NOT_SAME_SHAPE, phaseProblem, TOO_SMALL } from "#shared/reducer/phases.ts";

/**
 * The phase list the Scenes panel edits (docs/design-v1-maps-vision.md
 * section 3.4). Phases are sent as the whole list with `scene.update`, so
 * every edit here is a pure function from the scene to the next list. Which
 * image fits is the reducer's own `phaseProblem` (shared/reducer/phases.ts),
 * run here first so the DM reads why an image does not fit beside the
 * button, before an op is sent.
 */

/** What the map's current image is called when it becomes the first phase. */
export const FIRST_PHASE_NAME = "Day";

export { NOT_SAME_SHAPE, phaseProblem, TOO_SMALL };

/**
 * The scene's phases as the DM sees them: the stored list, or, for a map
 * with none yet, its current image as the one phase. That implicit phase
 * has no id until the first edit stores the list (`id` is empty).
 */
export function phasesOf(scene: Scene): MapPhase[] {
  if (scene.phases && scene.phases.length > 0) return scene.phases;
  if (!scene.map) return [];
  const { assetId, widthPx, heightPx } = scene.map;
  return [{ id: "", name: FIRST_PHASE_NAME, assetId, widthPx, heightPx }];
}

/** The phase showing now. A scene without a stored list shows its only phase. */
export function activePhaseId(scene: Scene, phases: readonly MapPhase[]): string | undefined {
  return scene.phaseId ?? phases[0]?.id;
}

/**
 * The grid every phase is aligned by: the stored reference, or the one the
 * current map would start when the scene first gets phases.
 */
export function referenceGrid(scene: Scene): PhaseGrid | null {
  if (scene.phaseGrid) return scene.phaseGrid;
  if (!scene.map) return null;
  const { widthPx, heightPx, cellPx, originPx } = scene.map;
  return { refWidthPx: widthPx, refHeightPx: heightPx, cellPx, originPx };
}

export function canAddPhase(phases: readonly MapPhase[]): boolean {
  return phases.length < LIMITS.phasesPerScene;
}

/** A phase name as the protocol takes it: one trimmed line, never empty. */
export function cleanPhaseName(name: string, fallback: string): string {
  // Control and text direction characters are refused by the protocol, so they go before trimming.
  const line = name.replace(/[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
  const cut = line.slice(0, MAX_NAME).trim();
  return cut.length > 0 ? cut : fallback;
}

/** Gives the implicit first phase an id, so the list can be stored. */
function stored(phases: readonly MapPhase[], newId: () => string): MapPhase[] {
  return phases.map((p) => (p.id === "" ? { ...p, id: newId() } : p));
}

export type PhaseEdit = { phases: MapPhase[] } | { problem: string };

/**
 * The list with a new image added at the end. The map's current image
 * stays first, so a scene's first list keeps showing what it showed.
 */
export function addPhase(scene: Scene, image: { assetId: string; widthPx: number; heightPx: number; name: string }, newId: () => string): PhaseEdit {
  const grid = referenceGrid(scene);
  if (!grid) return { problem: "Add a map image first." };
  const phases = phasesOf(scene);
  if (!canAddPhase(phases)) return { problem: `A map can have at most ${LIMITS.phasesPerScene} phases.` };
  const problem = phaseProblem(grid, image);
  if (problem) return { problem };
  const list = stored(phases, newId);
  const added: MapPhase = { id: newId(), name: cleanPhaseName(image.name, `Phase ${phases.length + 1}`), assetId: image.assetId, widthPx: image.widthPx, heightPx: image.heightPx };
  return { phases: [...list, added] };
}

/** The list with one phase renamed, or null when nothing changes. */
export function renamePhase(scene: Scene, phaseId: string, name: string, newId: () => string): MapPhase[] | null {
  const phases = phasesOf(scene);
  const phase = phases.find((p) => p.id === phaseId);
  if (!phase) return null;
  const next = cleanPhaseName(name, phase.name);
  if (next === phase.name) return null;
  return stored(
    phases.map((p) => (p.id === phaseId ? { ...p, name: next } : p)),
    newId,
  );
}

/** The list with one phase moved up (-1) or down (+1), or null at either end. */
export function movePhase(scene: Scene, phaseId: string, delta: -1 | 1): MapPhase[] | null {
  const phases = phasesOf(scene);
  const i = phases.findIndex((p) => p.id === phaseId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= phases.length) return null;
  const next = [...phases];
  next[i] = phases[j]!;
  next[j] = phases[i]!;
  return next;
}

/**
 * What a phase's Remove says once armed. Removing the phase showing
 * switches the map to the first phase left, on the players' screens too
 * when they are on this scene, so the visible words say so, not only the
 * button's title, which a phone never shows.
 */
export function removeConfirmText(phases: readonly MapPhase[], phaseId: string, showing: boolean): string {
  const next = showing ? phases.find((p) => p.id !== phaseId) : undefined;
  return next ? `Tap again: the map switches to ${next.name}` : "Tap again to remove";
}

/**
 * The list without one phase, or null when it is the last one: removing
 * the map's only image is removing the map, which the map image's own
 * Remove does. The server shows the first phase left when the one showing
 * goes.
 */
export function removePhase(scene: Scene, phaseId: string): MapPhase[] | null {
  const phases = phasesOf(scene);
  if (phases.length <= 1 || !phases.some((p) => p.id === phaseId)) return null;
  return phases.filter((p) => p.id !== phaseId);
}
