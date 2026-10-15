import { theme } from "./theme.ts";

/**
 * The interface accent follows the viewing member's own color (decided
 * 2026-10-14): a player's filled buttons, chosen options, focus ring and
 * selected tool take the color they picked, and the DM's take theirs. The
 * crest yellow is the accent before a room is joined and for a member with
 * no usable color. Colors that mean something (danger, statuses,
 * dispositions, area and token colors) and `accentSoft`, the active turn's
 * highlight, never follow it.
 *
 * A member may pick any color, and the accent has to read on the dark
 * surfaces as text, as an outline and as a fill, and must not pass for the
 * cream turn highlight or for muted text, which reads as disabled. A color
 * that breaks any of those moves to the nearest OKLCH lightness that keeps
 * them, with its own hue and as much of its chroma as fits, so a dark navy
 * becomes a lighter navy rather than a grey. Text on an accent fill takes
 * whichever of a dark and a light ink reads better, and black when neither
 * reaches 4.5:1.
 */
export type Accent = {
  accent: string;
  /** Text and icons on an accent fill. */
  onAccent: string;
  /** The faint fill behind a pressed or chosen control. */
  tint: string;
  /** Selected text's background. */
  selection: string;
};

export const MIN_TEXT_CONTRAST = 4.5;
/** How far apart, in CIE76, two colors must be to read as different at a glance. */
export const MIN_APART = 20;
const TINT_ALPHA = 0.14;
const SELECTION_ALPHA = 0.4;
const DARK_INK = "#1a1206";
const LIGHT_INK = "#ffffff";
const HEX = /^#[0-9a-f]{6}$/i;
/**
 * The crest orange reads as the crest yellow for the accent only, since
 * orange is never an interface color (docs/design-v1-visual.md 6.3,
 * question 1). Every room made before the accent followed members stored
 * its DM in it, the old default, which nobody picked. A member may now pick
 * it in the Members color picker, which says their buttons stay yellow.
 * The stored color, and so that member's pings and drawings, stay orange.
 */
const CREST_ORANGE = "#f38400";

export function accentFor(color: string | null | undefined): Accent {
  const picked = color && HEX.test(color) ? color.toLowerCase() : null;
  const base = picked && picked !== CREST_ORANGE ? picked : theme.color.crest;
  const accent = fits(base) ? base : nearestFit(base);
  return { accent, onAccent: inkOn(accent), tint: rgba(accent, TINT_ALPHA), selection: rgba(accent, SELECTION_ALPHA) };
}

/** Whether a color can be the accent as it is. */
function fits(hex: string): boolean {
  return (
    contrast(hex, behindAccentText(hex)) >= MIN_TEXT_CONTRAST &&
    cie76(hex, theme.color.accentSoft) >= MIN_APART &&
    cie76(hex, theme.color.textMuted) >= MIN_APART
  );
}

/**
 * The fitting color nearest the member's in OKLCH lightness, at the same
 * hue with as much of its chroma as sRGB holds there. Small steps, so it
 * moves no further than it must. Lighter goes first at each step: a dark
 * color can only get there by lightening, while a light one by the cream
 * can go either way.
 */
function nearestFit(hex: string): string {
  const [l, c, h] = toOklch(hex);
  for (let i = 1; i <= 200; i++) {
    for (const next of [l + i * 0.005, l - i * 0.005]) {
      if (next < 0 || next > 1) continue;
      const candidate = fromOklch(next, maxChroma(next, c, h), h);
      if (fits(candidate)) return candidate;
    }
  }
  return theme.color.crest;
}

/**
 * The lightest place accent text sits: a pressed control's tint over a
 * raised surface. Every other surface it sits on is darker.
 */
export function behindAccentText(accent: string): string {
  return mix(theme.color.surfaceRaised, accent, TINT_ALPHA);
}

/** The CSS variables that `theme.color.accent` and its kin read, for an element's style. */
export function accentVars(a: Accent): Record<string, string> {
  return {
    "--rvtt-accent": a.accent,
    "--rvtt-on-accent": a.onAccent,
    "--rvtt-accent-tint": a.tint,
    "--rvtt-selection": a.selection,
  };
}

function inkOn(fill: string): string {
  const dark = contrast(DARK_INK, fill);
  const light = contrast(LIGHT_INK, fill);
  if (Math.max(dark, light) >= MIN_TEXT_CONTRAST) return dark >= light ? DARK_INK : LIGHT_INK;
  return "#000000";
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` moved a fraction `t` of the way to `b`, in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const ca = channels(a);
  const cb = channels(b);
  return `#${ca.map((v, i) => Math.round(v + ((cb[i] ?? 0) - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

function linear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function gamma(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

/** OKLCH (Björn Ottosson's OKLab), with hue in radians. */
function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function fromOklch(L: number, C: number, h: number): string {
  return `#${oklchToLinear(L, C, h).map((v) => gamma(v).toString(16).padStart(2, "0")).join("")}`;
}

/** The most chroma, up to `C`, that sRGB can show at this lightness and hue. */
function maxChroma(L: number, C: number, h: number): number {
  const inGamut = (c: number) => oklchToLinear(L, c, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  if (inGamut(C)) return C;
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** CIE L*a*b*, for the CIE76 distance between two colors. */
function toLab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linear) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function cie76(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
