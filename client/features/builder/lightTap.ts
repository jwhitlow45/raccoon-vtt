import { createStore } from "zustand/vanilla";
import type { Light } from "#shared/model.ts";
import type { Point } from "../../lib/camera.ts";
import { lightCells } from "#shared/rules/vision.ts";
import { scopeSlot } from "../../state/scope.ts";
import { lightText } from "../vision/presets.ts";

/**
 * Lights in the builder (docs/design-v1-maps-vision.md sections 3.6 and
 * 4.3.1). Wave 3 stores the lights a Universal VTT file brings and shows
 * them to the DM as small suns. In the builder's Lights mode a tap on a sun
 * selects it, which draws its reach as faint rings. Wave 4 places, edits
 * and moves lights there (client/features/lights). Lights are DM only: a
 * player's view never holds one.
 */

/** Half a 44 px touch target: how far from a sun a tap still picks it. */
export const LIGHT_REACH_PX = 22;

/**
 * The light selected in the builder, by id, and where it is being dragged
 * to, if it is, so its rings follow the finger. A slot of its own, since
 * nothing outside the builder reads it.
 */
export const lightSlot = scopeSlot(() => createStore<{ lightId: string | null; dragTo: Point | null }>(() => ({ lightId: null, dragTo: null })));

/** The light on a scene nearest a point, within `reach` cells, or null. */
export function lightAt(lights: Readonly<Record<string, Light | undefined>> | undefined, sceneId: string, p: Point, reach: number): Light | null {
  let best: Light | null = null;
  let bestD2 = reach * reach;
  for (const light of Object.values(lights ?? {})) {
    if (!light || light.sceneId !== sceneId) continue;
    const d2 = (light.x - p.x) ** 2 + (light.y - p.y) ** 2;
    if (d2 > bestD2 || (best && d2 === bestD2)) continue;
    best = light;
    bestD2 = d2;
  }
  return best;
}

/**
 * How far a light reaches, in cells: bright light to `bright`, and dim
 * light from there to `dim`. A light stores its dim band as feet beyond the
 * bright radius, as the SRD words it, so the outer ring adds the two. The
 * rings are sight's own reach (shared/rules/vision.ts `lightCells`), which
 * a grid finer than 5 ft per cell cuts short.
 */
export function lightReach(light: Pick<Light, "bright" | "dim">, feetPerCell: number): { bright: number; dim: number } {
  const perCell = feetPerCell > 0 ? feetPerCell : 5;
  const { rb, rd } = lightCells(light.bright, light.dim, perCell);
  return { bright: rb, dim: rd };
}

/**
 * What a selected light says beside its sun: its label, its radii, and
 * whether it is off. The dim band is stored as feet beyond bright, so the
 * caption gives the outer ring's own radius ("dim to 45 ft"), the number a
 * DM reads off the ring. Given the room's grid, it adds what the light
 * really reaches where a grid finer than 5 ft cuts it short.
 */
export function lightCaption(light: Pick<Light, "bright" | "dim" | "on" | "label">, feetPerCell?: number): string {
  const reach = lightText(light, feetPerCell);
  const text = light.label ? `${light.label}: ${reach}` : reach;
  return light.on ? text : `${text}, off`;
}

/** Whether a scene has any light, for the Lights mode's hint. */
export function sceneHasLights(lights: Readonly<Record<string, Light | undefined>> | undefined, sceneId: string): boolean {
  return Object.values(lights ?? {}).some((light) => light?.sceneId === sceneId);
}

/** The Lights mode's hint. A scene with no lights yet says how to place the first. */
export function lightModeHint(hasLights: boolean): string {
  return hasLights
    ? "Tap the map to place the light chosen. Tap a light to change it, or drag it to move it. Erase and Clear build take lights too."
    : "This scene has no lights yet. Tap the map to place the light chosen.";
}
