import { z } from "zod";

/**
 * A scene's weather (docs/design/design-v1-weather.md 9.1): a look drawn over
 * the map, plus the roll rules of shared/rules/weather.ts. It names a kind, a
 * strength and a wind, nothing of the map, so it is copied to players with the
 * scene they are on (shared/project.ts).
 */

export const WEATHER_KINDS = ["clear", "rain", "snow", "fog", "leaves", "ash", "sand"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** A scene's weather (Scene.weather). Only what differs from the default is stored. Clear and calm is no weather. */
export type SceneWeather = {
  kind: WeatherKind;
  /** Heavy rain or snow, heavy fog, a sandstorm, or more leaves or ash. Never with "clear". Absent reads as light. */
  heavy?: true;
  /** Absent reads as calm. "clear" always has one. */
  wind?: "moderate" | "strong";
  /** Degrees clockwise from the map's top edge, a multiple of 45 under 360. Only with a wind. Absent reads as 135. */
  toward?: number;
  /** "Weather rules on rolls" off: the look stays, presets and notes go. Absent reads as on. */
  rules?: false;
};

/** Toward the bottom right, where a wind blows until the DM turns it. */
export const DEFAULT_TOWARD = 135;

/** The picker's words for each weather that cannot be, the same in the fold, the op schema and the state schema. */
export const WEATHER_PROBLEMS = {
  fogWind: "Strong wind disperses fog.",
  sandstorm: "A sandstorm is a strong wind.",
  clearHeavy: "Clear weather has no strength.",
  clearCalm: "Clear and calm is no weather.",
} as const;

/** Why a weather cannot be, in the picker's words, or null: fog with strong wind, a sandstorm without it, clear with heavy or no wind. */
export function weatherProblem(w: SceneWeather): string | null {
  // Strong wind "disperses fog" (SRD 5.2.1, Gameplay Toolbox, Environmental Effects, Strong Wind).
  if (w.kind === "fog" && w.wind === "strong") return WEATHER_PROBLEMS.fogWind;
  // "A strong wind in a desert can create a sandstorm", so a sandstorm without one is not the SRD's.
  if (w.kind === "sand" && w.heavy === true && w.wind !== "strong") return WEATHER_PROBLEMS.sandstorm;
  if (w.kind === "clear" && w.heavy === true) return WEATHER_PROBLEMS.clearHeavy;
  // The picker sends null for clear and calm, so the scene keeps no field and hashes as a scene from before weather.
  if (w.kind === "clear" && w.wind === undefined) return WEATHER_PROBLEMS.clearCalm;
  return null;
}

/** The one stored form: drops `toward` without a wind or at 135. */
export function normalWeather(w: SceneWeather): SceneWeather {
  const out: SceneWeather = { kind: w.kind };
  if (w.heavy === true) out.heavy = true;
  if (w.wind !== undefined) {
    out.wind = w.wind;
    if (w.toward !== undefined && w.toward !== DEFAULT_TOWARD) out.toward = w.toward;
  }
  if (w.rules === false) out.rules = false;
  return out;
}

const KIND_NAMES: Record<WeatherKind, readonly [light: string, heavy: string]> = {
  clear: ["Clear", "Clear"],
  rain: ["Light rain", "Heavy rain"],
  snow: ["Light snow", "Heavy snow"],
  fog: ["Patchy fog", "Heavy fog"],
  leaves: ["Falling leaves", "Heavy falling leaves"],
  ash: ["Ash", "Heavy ash"],
  sand: ["Blowing sand", "Sandstorm"],
};

/** "Moderate wind" or "Strong wind", or null when calm. */
export function windName(w: Pick<SceneWeather, "wind">): string | null {
  return w.wind === "strong" ? "Strong wind" : w.wind === "moderate" ? "Moderate wind" : null;
}

/** "Heavy rain", "Patchy fog", "Sandstorm", "Strong wind", for summaries, sources and the status. Clear names its wind. */
export function weatherName(w: SceneWeather): string {
  if (w.kind === "clear") return windName(w) ?? "Clear";
  return KIND_NAMES[w.kind][w.heavy === true ? 1 : 0];
}

/**
 * The weather's names in order, the kind's then the wind's: ["Heavy rain",
 * "Strong wind"], or ["Strong wind"] on a clear day. The fold's summary joins
 * them with " · " and the status with ", ".
 */
export function weatherParts(w: SceneWeather | undefined): string[] {
  if (w === undefined) return [];
  const wind = windName(w);
  if (w.kind === "clear") return wind === null ? [] : [wind];
  return wind === null ? [weatherName(w)] : [weatherName(w), wind];
}

/**
 * A scene's weather as an op or a backup carries it: a strict object refused
 * in the picker's words where `weatherProblem` says it cannot be. `toward` is
 * bounded here and dropped without a wind by `normalWeather`, which the
 * reducer and the import store.
 */
export const sceneWeatherSchema = z
  .strictObject({
    kind: z.enum(WEATHER_KINDS),
    heavy: z.literal(true).optional(),
    wind: z.enum(["moderate", "strong"]).optional(),
    toward: z.number().int().min(0).max(315).multipleOf(45).optional(),
    rules: z.literal(false).optional(),
  })
  .superRefine((w, ctx) => {
    const problem = weatherProblem(w);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });
