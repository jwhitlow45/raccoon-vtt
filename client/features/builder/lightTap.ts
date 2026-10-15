import { createStore } from "zustand/vanilla";
import type { Light, Token } from "#shared/model.ts";
import type { Box } from "../../lib/boardText.ts";
import type { Point } from "../../lib/camera.ts";
import { lightCells } from "#shared/rules/vision.ts";
import { footprint } from "../../lib/scene.ts";
import { scopeSlot } from "../../state/scope.ts";
import { lightText } from "../vision/presets.ts";
import { overlaps } from "./heights/boardText.ts";

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

/** The ring drawn around a picked light's sun, and the room kept outside it. */
const RING_PX = 17;
const RING_GAP_PX = 6;
/** How far below or above the sun the caption's middle sits: clear of the ring, as it always sat below it. */
const CAPTION_DROP_PX = 28;

/**
 * Where a picked light's caption goes, in cells, or null for nowhere: under
 * the sun as always, else over it, else to its right, else its left, the
 * first spot that clears everything in `avoid`, in screen pixels with the
 * world's origin at 0,0. The layer passes every token label, plate and
 * mark (features/layers.ts LayerProps `labelBoxes`) and every token's body
 * (tokenBodies), since the caption draws over the tokens. With no spot
 * clear it is not drawn at this zoom, as a height pill is not
 * (heights/boardText.ts placeHeightPills): a caption over a name reads as
 * neither, and the light's pane says the same words. `size` is the
 * caption's box on screen, halo included.
 */
export function lightCaptionSpot(light: Point, size: { width: number; height: number }, scale: number, avoid: readonly Box[]): Point | null {
  const cx = light.x * scale;
  const cy = light.y * scale;
  const halfW = size.width / 2;
  const halfH = size.height / 2;
  const aside = RING_PX + RING_GAP_PX + halfW;
  const spots = [
    { x: cx, y: cy + CAPTION_DROP_PX },
    { x: cx, y: cy - CAPTION_DROP_PX },
    { x: cx + aside, y: cy },
    { x: cx - aside, y: cy },
  ];
  for (const s of spots) {
    const box = { x0: s.x - halfW, y0: s.y - halfH, x1: s.x + halfW, y1: s.y + halfH };
    if (!avoid.some((b) => overlaps(b, box))) return { x: s.x / scale, y: s.y / scale };
  }
  return null;
}

/** The bodies of a scene's tokens, in screen pixels with the world's origin at 0,0, the space of lightCaptionSpot's `avoid`. */
export function tokenBodies(tokens: Readonly<Record<string, Token | undefined>>, sceneId: string, scale: number): Box[] {
  const out: Box[] = [];
  for (const t of Object.values(tokens)) {
    if (!t || t.sceneId !== sceneId) continue;
    const fp = footprint(t);
    out.push({ x0: t.x * scale, y0: t.y * scale, x1: (t.x + fp.w) * scale, y1: (t.y + fp.h) * scale });
  }
  return out;
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
