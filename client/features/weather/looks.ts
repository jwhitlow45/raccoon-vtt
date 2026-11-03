/**
 * How each weather looks and moves (the weather design note, 5.3), as
 * data the field and the draw read. Sizes and speeds are CSS px and px per
 * second, counts are per 100,000 CSS px² of screen.
 */

export type WeatherKind = "clear" | "rain" | "snow" | "fog" | "leaves" | "ash" | "sand";

/**
 * What the drawing reads of a scene's weather. It is the shape of
 * shared/weather.ts `SceneWeather`, written out here so the drawing core
 * needs nothing of the model: a `SceneWeather` passes as one.
 */
export type WeatherLook = {
  kind: WeatherKind;
  heavy?: true;
  wind?: "moderate" | "strong";
  /** Degrees clockwise from the map's top edge. Absent reads as 135. */
  toward?: number;
};

/** Where the map's wind blows when nothing says: toward the bottom right. */
export const DEFAULT_TOWARD = 135;

/** How the marks are drawn: a line along the motion, a dot, a leaf from the atlas, or a small square flake. */
export type ParticleShape = "streak" | "disc" | "leaf" | "flake";

export type Particles = {
  shape: ParticleShape;
  /** Per 100,000 CSS px² of screen. */
  perArea: number;
  /** The most on any screen. */
  cap: number;
  /** A streak's or flake's line width in px. */
  width: number;
  /** A streak's length, a disc's radius, or a leaf's or flake's size, in px. */
  size: readonly [number, number];
  /** One fill or stroke per color a draw. */
  colors: readonly string[];
  alpha: number;
  /** Px per second. */
  speed: readonly [number, number];
  /** Falls down the screen, with the wind as drift. False: moves only along the wind. */
  falls: boolean;
  /** Side to side, in px and times a second. */
  sway: number;
  swayHz: number;
  /** Turns a second, for leaves. */
  spin: readonly [number, number] | null;
  /** In Top-down, a ring where one drop in this many lands (heavy rain), else 0. */
  splashEvery: number;
};

/** A tiling noise sheet drawn over the screen, drifting along the wind. */
export type Sheet = { color: string; alpha: number; speed: number };

export type Look = {
  /** "rain heavy strong": kind, strength and wind, for the canvas's `data-weather`. */
  key: string;
  particles: Particles | null;
  sheets: readonly Sheet[];
  /** One fill over the scene, under the marks. */
  veil: { color: string; alpha: number } | null;
  /** 0 calm, 1 moderate, 2 strong. */
  wind: 0 | 1 | 2;
  /** Degrees clockwise from the map's top edge. */
  toward: number;
};

/** The look of a weather, or null when nothing draws (no weather, or clear and calm). */
export function lookOf(w: WeatherLook | null | undefined): Look | null {
  void w;
  return null;
}
