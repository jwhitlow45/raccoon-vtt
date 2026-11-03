import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { accentFor, baseAccentVars, behindAccentText, boardAccentVars, contrast, memberInk, MIN_TEXT_CONTRAST, mix } from "./accent.ts";
import { MEMBER_COLORS, PALETTES, SCHEMES, theme, type Scheme } from "./theme.ts";

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

/** The dark palette, which every check reads unless it names a scheme. */
const DARK = PALETTES.dark;

/** Every rule the accent keeps, whatever the member picked, on the scheme's own surfaces. */
function assertRules(color: string, scheme: Scheme = "dark"): void {
  const p = PALETTES[scheme];
  const { accent, onAccent } = accentFor(color, scheme);
  for (const surface of [p.bg, p.surface, p.surfaceRaised, behindAccentText(accent, scheme)]) {
    assert.ok(contrast(accent, surface) >= MIN_TEXT_CONTRAST, `${scheme} ${color}: ${accent} on ${surface} reads ${contrast(accent, surface).toFixed(2)}`);
  }
  assert.ok(contrast(onAccent, accent) >= MIN_TEXT_CONTRAST, `${scheme} ${color}: ${onAccent} on ${accent} reads ${contrast(onAccent, accent).toFixed(2)}`);
  assert.ok(distance(accent, p.accentSoft) >= 20, `${scheme} ${color}: ${accent} is ${distance(accent, p.accentSoft).toFixed(1)} from the turn highlight`);
  assert.ok(distance(accent, p.textMuted) >= 20, `${scheme} ${color}: ${accent} is ${distance(accent, p.textMuted).toFixed(1)} from the muted grey`);
  if (scheme === "light") assert.notEqual(accent, theme.color.crest, `${color}: the crest yellow reads 1.3:1 on a light page`);
  // The crest orange gives the crest yellow's accent, so its hue is the yellow's.
  const before = chromaHue(color.toLowerCase() === "#f38400" ? theme.color.crest : color);
  const after = chromaHue(accent);
  if (before.c >= 0.04 && after.c >= 0.02) {
    assert.ok(hueGap(before.h, after.h) <= 12, `${scheme} ${color}: ${accent} turned the hue ${hueGap(before.h, after.h).toFixed(1)} degrees`);
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
      for (const surface of [DARK.bg, DARK.surface, DARK.surfaceRaised, behindAccentText(accent)]) {
        assert.ok(contrast(accent, surface) >= MIN_TEXT_CONTRAST, `${accent} on ${surface}: ${contrast(accent, surface).toFixed(2)}`);
      }
      assert.ok(contrast(onAccent, accent) >= MIN_TEXT_CONTRAST, `${onAccent} on ${accent}: ${contrast(onAccent, accent).toFixed(2)}`);
    });

    test(`${color} stays apart from the active turn's highlight`, () => {
      const { accent } = accentFor(color);
      assert.ok(distance(accent, DARK.accentSoft) >= 20, `${accent} beside ${DARK.accentSoft}: ${distance(accent, DARK.accentSoft).toFixed(1)}`);
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
      assert.ok(distance(accent, DARK.textMuted) >= 20, `${color} gave ${accent}, ${distance(accent, DARK.textMuted).toFixed(1)} from ${DARK.textMuted}`);
    }
  });

  test("a color close to the cream turn highlight steps away from it", () => {
    for (const color of ["#ffe8a3", "#fff0b8", "#f8e2a0", "#ffeeb0", "#fde7b0"]) {
      const { accent } = accentFor(color);
      assert.ok(distance(accent, DARK.accentSoft) >= 20, `${color} gave ${accent}, ${distance(accent, DARK.accentSoft).toFixed(1)} from the highlight`);
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

/** A random #rrggbb color, for fast-check. */
const anyColor = fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, "0")}`);

describe("the member accent on a light page (docs/design/design-v1-light-theme.md 6.3)", () => {
  // The design's table: each member color's light accent, every one taking white text.
  const LIGHT: Record<(typeof MEMBER_COLORS)[number], string> = {
    "#f7df00": "#675c00",
    "#30a46c": "#00683f",
    "#3e8ef7": "#0057b4",
    "#8e4ec6": "#7b39b0",
    "#e93d82": "#ad0058",
    "#12a594": "#00665b",
    "#ad7f58": "#7d522c",
    "#e5e5e5": "#292929",
    "#ff6b4a": "#aa2500",
    "#f38400": "#675c00",
  };

  test("every member color takes its darker shade, with white text on it", () => {
    for (const color of MEMBER_COLORS) {
      const a = accentFor(color, "light");
      assert.equal(a.accent, LIGHT[color], color);
      assert.equal(a.onAccent, "#ffffff", color);
      assertRules(color, "light");
    }
  });

  test("the crest yellow with no member color, and for the crest orange, is the dark olive gold", () => {
    for (const color of [undefined, null, "", "orange", "#f7df00", "#f38400"]) assert.equal(accentFor(color, "light").accent, "#675c00", String(color));
  });

  test("dark is the default, and its accents are the ones it always had", () => {
    for (const color of [...MEMBER_COLORS, ...CUSTOM]) assert.deepEqual(accentFor(color), accentFor(color, "dark"), color);
    assert.equal(accentFor(null, "dark").accent, theme.color.crest);
    assert.equal(accentFor("#3e8ef7", "dark").accent, "#64a6ff");
  });

  for (const scheme of SCHEMES) {
    test(`${scheme}: any color at all keeps every rule (fast-check)`, () => {
      fc.assert(fc.property(anyColor, (color) => assertRules(color, scheme)), { numRuns: 2000, seed: 20261102 });
    });
  }

  test("on light the search tries darker first: a mid color that fails darkens rather than lightens", () => {
    for (const color of ["#3e8ef7", "#30a46c", "#12a594"]) {
      const before = luminanceOf(color);
      assert.ok(luminanceOf(accentFor(color, "light").accent) < before, color);
      assert.ok(luminanceOf(accentFor(color, "dark").accent) > before, color);
    }
    // A grey green beside the muted grey fits a step either way, and takes the darker step.
    assert.equal(accentFor("#385446", "light").accent, "#334f41");
  });
});

describe("a member's name in their own color", () => {
  test("reads at 4.5:1 on the scheme's surfaces, the member's color kept where it already does", () => {
    for (const scheme of SCHEMES) {
      const p = PALETTES[scheme];
      for (const color of [...MEMBER_COLORS, ...CUSTOM]) {
        const ink = memberInk(color, scheme);
        for (const surface of [p.bg, p.surface, p.surfaceRaised]) assert.ok(contrast(ink, surface) >= MIN_TEXT_CONTRAST, `${scheme} ${color}: ${ink} on ${surface}`);
      }
    }
    assert.equal(memberInk("#7dd3fc", "dark"), "#7dd3fc");
    assert.equal(memberInk("#00683f", "light"), "#00683f");
  });

  test("a navy name lightens in dark, where it read 1.2:1", () => {
    assert.ok(contrast("#1b1f3a", DARK.surface) < 1.5);
    assert.notEqual(memberInk("#1b1f3a", "dark"), "#1b1f3a");
  });

  test("orange stays orange, never the crest yellow the accent swaps it for", () => {
    for (const scheme of SCHEMES) {
      const ink = memberInk("#f38400", scheme);
      assert.notEqual(ink, accentFor("#f38400", scheme).accent, scheme);
      const { h } = chromaHue(ink);
      assert.ok(hueGap(h, chromaHue("#f38400").h) <= 12, `${scheme}: ${ink}`);
    }
  });

  test("no color reads as the scheme's text", () => {
    for (const scheme of SCHEMES) for (const color of [undefined, null, "", "orange"]) assert.equal(memberInk(color, scheme), PALETTES[scheme].text);
  });

  test("any color reads on both schemes' surfaces (fast-check)", () => {
    fc.assert(
      fc.property(anyColor, fc.constantFrom(...SCHEMES), (color, scheme) => {
        const p = PALETTES[scheme];
        const ink = memberInk(color, scheme);
        return [p.bg, p.surface, p.surfaceRaised].every((surface) => contrast(ink, surface) >= MIN_TEXT_CONTRAST);
      }),
      { numRuns: 2000, seed: 20261102 },
    );
  });

  test("orange on light steps clear of the turn's text and the whisper label, which it read as at 4.2 apart (review LTB-4)", () => {
    const ink = memberInk("#f38400", "light");
    const soft = PALETTES.light.accentSoft;
    assert.ok(distance(ink, soft) >= 20, `${ink} is ${distance(ink, soft).toFixed(1)} from ${soft}`);
  });

  test("any color stays 20 apart from the scheme's accentSoft, the words beside a name (fast-check)", () => {
    fc.assert(
      fc.property(anyColor, fc.constantFrom(...SCHEMES), (color, scheme) => distance(memberInk(color, scheme), PALETTES[scheme].accentSoft) >= 20),
      { numRuns: 2000, seed: 20261103 },
    );
  });
});

describe("the accent's variables", () => {
  test("the base set is the scheme's crest accent, and the board set the accent resolved for dark", () => {
    const light = accentFor(null, "light");
    assert.deepEqual(baseAccentVars(light), { "--rvtt-base-accent": "#675c00", "--rvtt-base-on-accent": "#ffffff", "--rvtt-base-accent-tint": light.tint, "--rvtt-base-selection": light.selection });
    const dark = accentFor("#3e8ef7", "dark");
    assert.deepEqual(boardAccentVars(dark), { "--rvtt-board-accent": "#64a6ff", "--rvtt-board-on-accent": dark.onAccent, "--rvtt-board-accent-tint": dark.tint, "--rvtt-board-selection": dark.selection });
  });
});

/** WCAG relative luminance, worked out here apart from accent.ts. */
function luminanceOf(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
