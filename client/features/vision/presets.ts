import { MAX_LIGHT_FT, type TokenLight } from "#shared/model.ts";
import { lightOnGrid, reachesOnGrid } from "./reach.ts";

/**
 * The SRD's light sources (docs/design-v1-maps-vision.md sections 3.6 and
 * 4.3.1), in its own wording: "Bright Light in a 20-foot radius and Dim
 * Light for an additional 20 feet" is `{ bright: 20, dim: 20 }`. The
 * Bullseye Lantern lights a cone, which v1 does not model, and the SRD has
 * no brazier.
 */
export type LightPreset = { name: string; bright: number; dim: number };

/** What a creature can carry: its action bar's Light choices. */
export const CARRIED_LIGHTS: readonly LightPreset[] = [
  { name: "Candle", bright: 5, dim: 5 },
  { name: "Torch", bright: 20, dim: 20 },
  { name: "Lamp", bright: 15, dim: 30 },
  { name: "Hooded Lantern", bright: 30, dim: 30 },
  { name: "Light", bright: 20, dim: 20 },
];

/** What the DM places in the builder's Light mode: the carried ones, and the Daylight spell. */
export const PLACED_LIGHTS: readonly LightPreset[] = [...CARRIED_LIGHTS, { name: "Daylight", bright: 60, dim: 60 }];

/** Whether a light has the preset's radii. A Torch and the Light cantrip are the same light, so both match one. */
export function isPreset(light: TokenLight | undefined, preset: LightPreset): boolean {
  return light !== undefined && light.bright === preset.bright && light.dim === preset.dim;
}

/**
 * The one preset a light shows as chosen. A Torch and the Light cantrip
 * have the same radii, so radii alone would light both. `name` settles it:
 * a placed light keeps its preset's name as its label, and the token's
 * Light choices remember the one last tapped. The named preset wins when
 * it has the light's radii, else the first that has them. Null for radii
 * no preset has.
 */
export function presetOf(light: TokenLight | undefined, list: readonly LightPreset[], name?: string | null): LightPreset | null {
  if (!light) return null;
  const named = name ? list.find((p) => p.name === name && isPreset(light, p)) : undefined;
  return named ?? list.find((p) => isPreset(light, p)) ?? null;
}

/** Whether a light is one of the list's, by its radii. Anything else is Custom. */
export function isCustom(light: TokenLight | undefined, list: readonly LightPreset[]): boolean {
  return light !== undefined && !list.some((p) => isPreset(light, p));
}

/** A radius typed by hand, held to whole feet from 0 to the SRD's largest. */
export function clampFeet(feet: number): number {
  if (!Number.isFinite(feet)) return 0;
  return Math.min(MAX_LIGHT_FT, Math.max(0, Math.round(feet)));
}

/**
 * How a carried light reads in a sentence, its radii as the rings draw
 * them: the dim band is stored as feet beyond bright, so the outer radius
 * adds the two, as the builder's caption does ("dim to 40 ft"). Given the
 * room's grid, it adds what the light really reaches where a grid finer
 * than 5 ft cuts it short (reach.ts).
 */
export function lightText(light: TokenLight | undefined, feetPerCell?: number): string {
  if (!light || (light.bright <= 0 && light.dim <= 0)) return "No light";
  const outer = light.bright + light.dim;
  const text = light.dim <= 0 ? `${light.bright} ft bright` : light.bright <= 0 ? `dim to ${outer} ft` : `${light.bright} ft bright, dim to ${outer} ft`;
  const cut = feetPerCell === undefined ? null : lightOnGrid(light, feetPerCell);
  return cut ? `${text}${reachesOnGrid(lightText(cut))}` : text;
}
