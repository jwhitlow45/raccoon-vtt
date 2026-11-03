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
  /** A falling kind's wind drift, as a multiple of its speed: 0 calm, 1 moderate, 2 strong. */
  drift: number;
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

/**
 * A tiling noise sheet drawn over the screen, drifting along the wind.
 * `scale` is its size on screen against its pixels at the middle zoom: two
 * sheets at sizes that do not divide each other hide each one's repeat.
 */
export type Sheet = { color: string; alpha: number; speed: number; scale: number };

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

const WINDS = { moderate: 1, strong: 2 } as const;

const RAIN = "#c8d8f0";
const SNOW = "#f4f8ff";
const FOG = "#d9dee4";
const SAND = "#d6b77a";
/** Burnt orange, gold, deep red and brown, in the atlas's order (textures.ts). */
export const LEAF_COLORS = ["#c4561d", "#d9a12b", "#8f2d1f", "#7a5a2a"] as const;
const ASH = ["#8a8a8a", "#a9a9a9", "#c9c9c9"] as const;

/** Fields every kind shares unless it says otherwise. */
const PLAIN = { width: 1, sway: 0, swayHz: 0, spin: null, splashEvery: 0, falls: true } as const;

function particlesOf(kind: WeatherKind, heavy: boolean, wind: 0 | 1 | 2): Particles | null {
  const pick = <T>(light: T, dense: T): T => (heavy ? dense : light);
  switch (kind) {
    case "rain":
      return { ...PLAIN, shape: "streak", perArea: pick(40, 100), cap: pick(250, 600), width: pick(1, 1.5), size: pick([10, 18], [14, 26]), colors: [RAIN], alpha: pick(0.35, 0.45), speed: [700, 1100], drift: wind, splashEvery: pick(0, 200) };
    case "snow":
      return { ...PLAIN, shape: "disc", perArea: pick(25, 70), cap: pick(150, 400), size: pick([1, 2.5], [1.5, 3.5]), colors: [SNOW], alpha: 0.85, speed: pick([30, 70], [60, 140]), drift: wind, sway: 8, swayHz: 0.4 };
    case "leaves":
      // A strong wind's leaves have speeds of their own (5.3), so it drifts them once, not twice.
      return { ...PLAIN, shape: "leaf", perArea: pick(6, 16), cap: pick(40, 100), size: [6, 12], colors: LEAF_COLORS, alpha: 0.95, speed: wind === 2 ? [150, 250] : [40, 120], drift: Math.min(wind, 1), sway: 10, swayHz: 0.3, spin: [0.5, 2] };
    case "ash":
      return { ...PLAIN, shape: "flake", perArea: pick(30, 80), cap: pick(200, 500), size: [2, 4], colors: ASH, alpha: 0.8, speed: [15, 40], drift: wind, sway: 6, swayHz: 0.25 };
    case "sand":
      return { ...PLAIN, shape: "streak", perArea: pick(60, 160), cap: pick(400, 900), width: 1.5, size: [2, 7], colors: [SAND], alpha: 0.8, speed: [250, 500], drift: 0, falls: false };
    case "clear":
      if (wind === 0) return null;
      return { ...PLAIN, shape: "streak", perArea: wind === 2 ? 20 : 8, cap: wind === 2 ? 150 : 60, size: [30, 60], colors: ["#ffffff"], alpha: 0.15, speed: [300, 600], drift: 0, falls: false };
    case "fog":
      return null;
  }
}

function sheetsOf(kind: WeatherKind, heavy: boolean): readonly Sheet[] {
  if (kind === "fog") {
    const [a, b] = heavy ? [0.35, 0.25] : [0.18, 0.12];
    return [{ color: FOG, alpha: a, speed: 3, scale: 2 }, { color: FOG, alpha: b, speed: 8, scale: 3.3 }];
  }
  if (kind === "sand" && heavy) return [{ color: SAND, alpha: 0.2, speed: 160, scale: 2.5 }];
  return [];
}

function veilOf(kind: WeatherKind, heavy: boolean): Look["veil"] {
  if (kind === "sand") return { color: SAND, alpha: heavy ? 0.3 : 0.08 };
  if (!heavy) return null;
  if (kind === "rain") return { color: "#1b2a3a", alpha: 0.12 };
  if (kind === "snow") return { color: "#ffffff", alpha: 0.1 };
  if (kind === "ash") return { color: "#3a3330", alpha: 0.12 };
  return null;
}

/** Whether two looks draw the same: the same kind, strength and wind, blowing the same way. The roll rules draw nothing. */
export function sameLook(a: Look | null, b: Look | null): boolean {
  return a === b || (a !== null && b !== null && a.key === b.key && a.toward === b.toward);
}

/** The look of a weather, or null when nothing draws (no weather, or clear and calm). */
export function lookOf(w: WeatherLook | null | undefined): Look | null {
  if (!w) return null;
  const wind = w.wind ? WINDS[w.wind] : 0;
  const heavy = w.heavy === true && w.kind !== "clear";
  if (w.kind === "clear" && wind === 0) return null;
  const toward = ((((w.wind ? (w.toward ?? DEFAULT_TOWARD) : DEFAULT_TOWARD) % 360) + 360) % 360);
  return {
    key: `${w.kind} ${heavy ? "heavy" : "light"} ${w.wind ?? "calm"}`,
    particles: particlesOf(w.kind, heavy, wind),
    sheets: sheetsOf(w.kind, heavy),
    veil: veilOf(w.kind, heavy),
    wind,
    toward,
  };
}
