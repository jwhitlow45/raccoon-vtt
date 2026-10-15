import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accentFor, behindAccentText, contrast, MIN_TEXT_CONTRAST, mix } from "./accent.ts";
import { MEMBER_COLORS, theme } from "./theme.ts";

/** CIE L*a*b* from sRGB hex, for telling two colors apart by eye (CIE76). */
function lab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function distance(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** OKLCH chroma and hue in degrees, worked out here apart from accent.ts. */
function chromaHue(hex: string): { c: number; h: number } {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q;
  return { c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** A seeded generator, so a failing fuzz case comes back the same every run. */
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every rule the accent keeps, whatever the member picked. */
function assertRules(color: string): void {
  const { accent, onAccent } = accentFor(color);
  for (const surface of [theme.color.bg, theme.color.surface, theme.color.surfaceRaised, behindAccentText(accent)]) {
    assert.ok(contrast(accent, surface) >= MIN_TEXT_CONTRAST, `${color}: ${accent} on ${surface} reads ${contrast(accent, surface).toFixed(2)}`);
  }
  assert.ok(contrast(onAccent, accent) >= MIN_TEXT_CONTRAST, `${color}: ${onAccent} on ${accent} reads ${contrast(onAccent, accent).toFixed(2)}`);
  assert.ok(distance(accent, theme.color.accentSoft) >= 20, `${color}: ${accent} is ${distance(accent, theme.color.accentSoft).toFixed(1)} from the turn highlight`);
  assert.ok(distance(accent, theme.color.textMuted) >= 20, `${color}: ${accent} is ${distance(accent, theme.color.textMuted).toFixed(1)} from the muted grey`);
  const before = chromaHue(color);
  const after = chromaHue(accent);
  if (before.c >= 0.04 && after.c >= 0.02) {
    assert.ok(hueGap(before.h, after.h) <= 12, `${color}: ${accent} turned the hue ${hueGap(before.h, after.h).toFixed(1)} degrees`);
  }
}

/** Dark and odd colors a member could pick with the browser's color input. */
const CUSTOM = ["#000000", "#1b1f3a", "#4b0082", "#7f1d1d", "#14532d", "#808080", "#ffffff", "#00ffff"];

describe("the member accent", () => {
  test("the crest yellow is the accent with no member color, and stays as it is", () => {
    for (const color of [undefined, null, "", "orange", "#fff", "#f7df00"]) {
      const a = accentFor(color);
      assert.equal(a.accent, theme.color.crest);
      assert.equal(a.onAccent, "#1a1206");
    }
  });

  test("the crest orange gives the crest yellow, whether a room stored it for its DM or a member picked it", () => {
    for (const color of ["#f38400", "#F38400"]) {
      assert.equal(accentFor(color).accent, theme.color.crest);
      assert.equal(accentFor(color).onAccent, "#1a1206");
    }
  });

  test("a color that already reads is kept exactly", () => {
    assert.equal(accentFor("#7dd3fc").accent, "#7dd3fc");
    assert.equal(accentFor("#E5E5E5").accent, "#e5e5e5");
  });

  for (const color of [...MEMBER_COLORS, ...CUSTOM]) {
    test(`${color} reads as text, as an outline and as a fill on the dark surfaces`, () => {
      const { accent, onAccent } = accentFor(color);
      for (const surface of [theme.color.bg, theme.color.surface, theme.color.surfaceRaised, behindAccentText(accent)]) {
        assert.ok(contrast(accent, surface) >= MIN_TEXT_CONTRAST, `${accent} on ${surface}: ${contrast(accent, surface).toFixed(2)}`);
      }
      assert.ok(contrast(onAccent, accent) >= MIN_TEXT_CONTRAST, `${onAccent} on ${accent}: ${contrast(onAccent, accent).toFixed(2)}`);
    });

    test(`${color} stays apart from the active turn's highlight`, () => {
      const { accent } = accentFor(color);
      assert.ok(distance(accent, theme.color.accentSoft) >= 20, `${accent} beside ${theme.color.accentSoft}: ${distance(accent, theme.color.accentSoft).toFixed(1)}`);
    });
  }

  test("a dark color is lightened keeping its hue and some of its chroma, so it does not go grey", () => {
    for (const color of ["#1b1f3a", "#4b0082", "#7f1d1d", "#14532d", "#000080"]) {
      const { accent } = accentFor(color);
      assert.notEqual(accent, color);
      const before = chromaHue(color);
      const after = chromaHue(accent);
      assert.ok(hueGap(before.h, after.h) <= 12, `${color} gave ${accent}, hue moved ${hueGap(before.h, after.h).toFixed(1)} degrees`);
      assert.ok(after.c >= 0.05, `${color} gave ${accent}, chroma ${after.c.toFixed(3)}, which reads as grey`);
    }
    assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  });

  test("black and dark greys stay clear of the muted grey, which reads as disabled", () => {
    for (const color of ["#000000", "#202020", "#333333", "#555555"]) {
      const { accent } = accentFor(color);
      assert.ok(distance(accent, theme.color.textMuted) >= 20, `${color} gave ${accent}, ${distance(accent, theme.color.textMuted).toFixed(1)} from ${theme.color.textMuted}`);
    }
  });

  test("a color close to the cream turn highlight steps away from it", () => {
    for (const color of ["#ffe8a3", "#fff0b8", "#f8e2a0", "#ffeeb0", "#fde7b0"]) {
      const { accent } = accentFor(color);
      assert.ok(distance(accent, theme.color.accentSoft) >= 20, `${color} gave ${accent}, ${distance(accent, theme.color.accentSoft).toFixed(1)} from the highlight`);
    }
  });

  test("any color at all keeps every rule (fuzz)", () => {
    const random = mulberry32(20261014);
    for (let i = 0; i < 4000; i++) {
      const color = `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, "0")}`;
      assertRules(color);
    }
  });
});
