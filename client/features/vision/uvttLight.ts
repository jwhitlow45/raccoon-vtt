import type { LightLevel, ScenePreset } from "#shared/model.ts";

/**
 * The light level a Universal VTT import proposes for its scene
 * (docs/design-v1-maps-vision.md section 4.3.8), from the file's
 * `environment` and the lights the import keeps:
 *
 * - Lights inside the map: Dark under party vision, so those lights light
 *   it for the party (D-261028-08), unless the ambient light is 70% or
 *   brighter, a daylit map, which keeps its own level below.
 * - `baked_lighting`: Bright, since the image already shows its lighting.
 * - Otherwise `ambient_light`, read as a color from its last six hex digits
 *   (the first two are alpha in Dungeondraft's ARGB): Bright at 70%
 *   luminance or more, Dim at 30% or more, else Dark.
 *
 * Luminance here is the Rec. 709 weighting of the color as written, not of
 * linear light, so a mid grey reads as 50%, as a color picker shows it.
 * A file with none of these proposes nothing, and the scene starts Bright.
 */

export type LightProposal = {
  level: LightLevel;
  why: string;
  /** The map's own lights, when they are why the scene starts dark under party vision. */
  lights?: number;
};

/** What the file says about its light, as the import reads it. */
export type UvttEnvironment = { baked: boolean; ambient: string | null };

export function proposedLight(environment: UvttEnvironment | null | undefined, lights = 0): LightProposal | null {
  const ambient = ambientOf(environment?.ambient);
  if (lights > 0 && ambient?.level !== "bright") return { level: "dark", why: "The map's own lights light it for the party.", lights };
  if (!environment) return null;
  if (environment.baked) return { level: "bright", why: "The map image already shows its lighting." };
  if (!ambient) return null;
  return { level: ambient.level, why: `The map's ambient light is ${ambient.percent}% bright.` };
}

function ambientOf(raw: string | null | undefined): { level: LightLevel; percent: number } | null {
  const hex = /^#?(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(raw?.trim() ?? "")?.[1];
  if (!hex) return null;
  const n = Number.parseInt(hex, 16);
  const luminance = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return { level: luminance >= 0.7 ? "bright" : luminance >= 0.3 ? "dim" : "dark", percent: Math.round(luminance * 100) };
}

/** The import dialog's Players see and light, as the DM has them. */
export type ImportLight = { seen: ScenePreset | "like"; light: LightLevel };

const DARK_WITH_VISION: ImportLight = { seen: "explore", light: "dark" };

/** Where the dialog starts: the map's lights under party vision, else the room's default with the file's level. */
export function startingLight(proposal: LightProposal | null, roomDefault: ScenePreset): ImportLight {
  return proposal?.lights ? DARK_WITH_VISION : { seen: roomDefault, light: proposal?.level ?? "bright" };
}

/**
 * The summary's lead line for a map that brings lights, with its one-tap
 * button. While the scene is set dark under party vision, Keep it lit
 * puts back the start a lit map has: Bright, and the room's default. Once
 * the DM moves off that, the line offers the dark start again, so the
 * button never vanishes from under a keyboard's focus.
 */
export function lightsLead(proposal: LightProposal | null, now: ImportLight, roomDefault: ScenePreset): { text: string; action: string; to: ImportLight } | null {
  const n = proposal?.lights;
  if (!n) return null;
  const brings = n === 1 ? "This map brings 1 light." : `This map brings ${n} lights.`;
  const lights = n === 1 ? "it lights the scene" : "they light it";
  if (now.seen === DARK_WITH_VISION.seen && now.light === DARK_WITH_VISION.light) {
    return { text: `${brings} The scene starts dark with party vision on, so ${lights} for the party.`, action: "Keep it lit", to: { seen: roomDefault, light: "bright" } };
  }
  return { text: `${brings} Start the scene dark with party vision on, and ${lights} for the party.`, action: "Start it dark", to: DARK_WITH_VISION };
}
