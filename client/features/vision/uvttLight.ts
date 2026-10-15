import type { LightLevel } from "#shared/model.ts";

/**
 * The light level a Universal VTT import proposes for its scene
 * (docs/design-v1-maps-vision.md section 4.3.8), from the file's
 * `environment`:
 *
 * - `baked_lighting`: Bright, since the image already shows its lighting.
 * - Otherwise `ambient_light`, read as a color from its last six hex digits
 *   (the first two are alpha in Dungeondraft's ARGB): Bright at 70%
 *   luminance or more, Dim at 30% or more, else Dark.
 *
 * Luminance here is the Rec. 709 weighting of the color as written, not of
 * linear light, so a mid grey reads as 50%, as a color picker shows it.
 * A file with neither proposes nothing, and the scene starts Bright.
 */

export type LightProposal = { level: LightLevel; why: string };

/** What the file says about its light, as the import reads it. */
export type UvttEnvironment = { baked: boolean; ambient: string | null };

export function proposedLight(environment: UvttEnvironment | null | undefined): LightProposal | null {
  if (!environment) return null;
  if (environment.baked) return { level: "bright", why: "The map image already shows its lighting." };
  const hex = /^#?(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(environment.ambient?.trim() ?? "")?.[1];
  if (!hex) return null;
  const n = Number.parseInt(hex, 16);
  const luminance = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  const percent = Math.round(luminance * 100);
  const level: LightLevel = luminance >= 0.7 ? "bright" : luminance >= 0.3 ? "dim" : "dark";
  return { level, why: `The map's ambient light is ${percent}% bright.` };
}
