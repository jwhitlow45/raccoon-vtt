import { DEFAULT_TOWARD, normalWeather, weatherProblem, WEATHER_PROBLEMS, type SceneWeather, type WeatherKind } from "#shared/weather.ts";

/*
 * The fold's picker as plain data (docs/design/design-v1-weather.md 4.1), and the
 * one function that turns a pick into a valid weather. Each control sends
 * its change here with the picker as it stands, so every rule about which
 * mixes can be lives in one place and the fold never sends a weather the op
 * schema would refuse.
 */

export type WindLevel = "calm" | "moderate" | "strong";

export type Picker = {
  kind: WeatherKind;
  heavy: boolean;
  wind: WindLevel;
  /** Degrees clockwise from the map's top edge. Only meaningful with a wind. */
  toward: number;
  /** "Weather rules on rolls". */
  rules: boolean;
};

/** What a scene with no weather shows in the fold. */
export const CLEAR_PICKER: Picker = { kind: "clear", heavy: false, wind: "calm", toward: DEFAULT_TOWARD, rules: true };

export function pickerOf(weather: SceneWeather | undefined): Picker {
  if (!weather) return CLEAR_PICKER;
  return { kind: weather.kind, heavy: weather.heavy === true, wind: weather.wind ?? "calm", toward: weather.toward ?? DEFAULT_TOWARD, rules: weather.rules !== false };
}

export type Built = {
  /** What to send as the scene's weather, null for none. */
  weather: SceneWeather | null;
  /** Why the build changed something the DM did not pick, in the wind's help words, or null. */
  forced: string | null;
  /** The change was one the weather cannot hold, so nothing is sent and `weather` is what the DM had. */
  refused?: true;
};

const WIND_FORCED = {
  moderate: "The wind is moderate now: strong wind disperses fog.",
  strong: "The wind is strong now: a sandstorm is a strong wind.",
} as const;

/**
 * The picker after a change, composed valid:
 * - Clear drops the strength, and Clear with Calm is no weather (null).
 * - A kind picked keeps the wind and its direction, and starts light.
 * - Fog picked while the wind is Strong drops it to Moderate.
 * - A sandstorm picked while the wind is Calm or Moderate raises it to Strong.
 *   Leaving Sand for another kind keeps Strong unless that kind is Fog.
 * - Calm drops the direction, and a wind picked again starts toward the
 *   bottom right.
 * - "Weather rules on rolls" off stays off across kind changes.
 * A change the weather cannot hold (Strong with Fog, Calm in a sandstorm)
 * changes nothing, since the picker disables those.
 */
export function buildWeather(before: Picker, change: Partial<Picker>): Built {
  const next: Picker = { ...before, ...change };
  let forced: string | null = null;
  const kindChanged = change.kind !== undefined && change.kind !== before.kind;

  // A new kind starts light, so a sandstorm and a heavy fog are always a pick of their own.
  if (kindChanged || next.kind === "clear") next.heavy = false;

  // Calm forgets the direction with no code here: a stored weather keeps `toward` only with a wind, so the picker rebuilt from it starts a new wind toward the bottom right.
  if (next.kind === "fog" && next.wind === "strong") {
    if (change.wind === "strong") return { weather: toWeather(before), forced: null, refused: true };
    next.wind = "moderate";
    forced = WIND_FORCED.moderate;
  }
  if (next.kind === "sand" && next.heavy && next.wind !== "strong") {
    if (change.wind !== undefined) return { weather: toWeather(before), forced: null, refused: true };
    next.wind = "strong";
    forced = WIND_FORCED.strong;
  }

  const weather = toWeather(next);
  // A weather the schema refuses never leaves here: fall back to what the DM had.
  if (weather !== null && weatherProblem(weather) !== null) return { weather: toWeather(before), forced: null, refused: true };
  return { weather, forced };
}

function toWeather(p: Picker): SceneWeather | null {
  if (p.kind === "clear" && p.wind === "calm") return null;
  const out: SceneWeather = { kind: p.kind };
  if (p.heavy && p.kind !== "clear") out.heavy = true;
  if (p.wind !== "calm") {
    out.wind = p.wind;
    if (p.toward !== DEFAULT_TOWARD) out.toward = p.toward;
  }
  if (!p.rules) out.rules = false;
  return out;
}

/** Why a pick moved something the DM did not pick, and the weather it sent. */
export type Forced = { text: string; weather: SceneWeather | null };

/**
 * A forced change's reason while the scene still holds the weather that pick
 * sent, else null: an Undo, a co-DM's change or another device's moves the
 * weather on, and the reason with it.
 */
export function forcedNow(forced: Forced | null, weather: SceneWeather | undefined): string | null {
  if (!forced) return null;
  const key = (w: SceneWeather | null | undefined) => (w ? JSON.stringify(normalWeather(w)) : "none");
  return key(forced.weather) === key(weather) ? forced.text : null;
}

/** The wind's help under the picker: the forced change's reason, else why an option is off. */
export function windHelp(p: Picker, forced: string | null): string | null {
  if (forced !== null) return forced;
  if (p.kind === "fog") return WEATHER_PROBLEMS.fogWind;
  if (p.kind === "sand" && p.heavy) return WEATHER_PROBLEMS.sandstorm;
  return null;
}

/** Which winds the picker offers for a kind and strength. */
export function windOffered(p: Pick<Picker, "kind" | "heavy">, wind: WindLevel): boolean {
  if (p.kind === "fog" && wind === "strong") return false;
  if (p.kind === "sand" && p.heavy && wind !== "strong") return false;
  return true;
}

export const KIND_CHOICES: readonly { value: WeatherKind; label: string }[] = [
  { value: "clear", label: "Clear" },
  { value: "rain", label: "Rain" },
  { value: "snow", label: "Snow" },
  { value: "fog", label: "Fog" },
  { value: "leaves", label: "Falling leaves" },
  { value: "ash", label: "Ash" },
  { value: "sand", label: "Sand" },
];

/** The strength pair's words for a kind: Light and Heavy, Patchy and Heavy for fog, Blowing and Sandstorm for sand. */
export function strengthWords(kind: WeatherKind): readonly [light: string, heavy: string] {
  if (kind === "fog") return ["Patchy", "Heavy"];
  if (kind === "sand") return ["Blowing", "Sandstorm"];
  return ["Light", "Heavy"];
}

export const WIND_CHOICES: readonly { value: WindLevel; label: string }[] = [
  { value: "calm", label: "Calm" },
  { value: "moderate", label: "Moderate" },
  { value: "strong", label: "Strong" },
];

/** The compass's eight directions in the order a radio group's arrow keys walk them, clockwise from the top, with the grid cell each stands in. */
export const COMPASS: readonly { toward: number; name: string; row: number; col: number }[] = [
  { toward: 0, name: "Toward the top", row: 1, col: 2 },
  { toward: 45, name: "Toward the top right", row: 1, col: 3 },
  { toward: 90, name: "Toward the right", row: 2, col: 3 },
  { toward: 135, name: "Toward the bottom right", row: 3, col: 3 },
  { toward: 180, name: "Toward the bottom", row: 3, col: 2 },
  { toward: 225, name: "Toward the bottom left", row: 3, col: 1 },
  { toward: 270, name: "Toward the left", row: 2, col: 1 },
  { toward: 315, name: "Toward the top left", row: 1, col: 1 },
];
