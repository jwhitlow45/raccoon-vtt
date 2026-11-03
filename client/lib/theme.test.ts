import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contrast, mix } from "./accent.ts";
import { BOARD_SCOPE, boardTheme, colorVar, MEMBER_COLOR_NAMES, MEMBER_COLORS, ON_BOARD_STYLE, PALETTES, paletteVars, SCHEMES, SHADOWS, shadowVar, statusBand, theme, type Palette, type Scheme } from "./theme.ts";

/** An rgba token laid over a solid ground, as the eye sees it. */
function over(ground: string, rgba: string): string {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
  assert.ok(m, rgba);
  const hex = `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
  return mix(ground, hex, Number(m[4]));
}

/**
 * The grounds words and outlines sit on. On a light page the turn's tint
 * over a surface or a raised surface is the worst of them (docs/design/
 * design-v1-light-theme.md 6.1). In dark the tint lies on the turn's row,
 * whose words are text and the turn's own cream, so the three surfaces
 * hold the rest.
 */
function grounds(scheme: Scheme): Record<string, string> {
  const p = PALETTES[scheme];
  const solid = { bg: p.bg, surface: p.surface, surfaceRaised: p.surfaceRaised };
  return scheme === "light" ? { ...solid, "turn tint on surface": over(p.surface, p.turnTint), "turn tint on raised": over(p.surfaceRaised, p.turnTint) } : solid;
}

/** Colors that are words somewhere, at 4.5:1, and colors that only outline or mark, at 3:1. Dark's ally blue rings tokens and is never words. */
const WORDS: Record<Scheme, (keyof Palette)[]> = {
  dark: ["text", "textMuted", "accentSoft", "dangerText", "success", "warning"],
  light: ["text", "textMuted", "accentSoft", "dangerText", "success", "warning", "ally"],
};
const MARKS: Record<Scheme, (keyof Palette)[]> = {
  dark: ["textDisabled", "controlBorder", "danger", "neutral", "hostile", "ally"],
  light: ["textDisabled", "controlBorder", "danger", "neutral", "hostile", "markRing"],
};

describe("the visual system's tokens", () => {
  for (const scheme of SCHEMES) {
    const p = PALETTES[scheme];
    for (const [name, ground] of Object.entries(grounds(scheme))) {
      test(`${scheme}: a disabled label reads at 3:1 on ${name}, and dimmer than muted text`, () => {
        const disabled = contrast(p.textDisabled, ground);
        assert.ok(disabled >= 3, `textDisabled on ${name}: ${disabled.toFixed(2)}`);
        assert.ok(disabled < contrast(p.textMuted, ground), `textDisabled must read dimmer than textMuted on ${name}`);
      });

      test(`${scheme}: words read at 4.5:1 and outlines at 3:1 on ${name}`, () => {
        for (const key of WORDS[scheme]) assert.ok(contrast(p[key], ground) >= 4.5, `${key} ${p[key]} on ${name}: ${contrast(p[key], ground).toFixed(2)}`);
        for (const key of MARKS[scheme]) assert.ok(contrast(p[key], ground) >= 3, `${key} ${p[key]} on ${name}: ${contrast(p[key], ground).toFixed(2)}`);
      });
    }

    test(`${scheme}: text reads on the warning and danger notice fills`, () => {
      for (const fill of [p.warningFill, p.dangerFill]) assert.ok(contrast(p.text, fill) >= 4.5, `text on ${fill}`);
    });
  }

  test("ink reads on the cream highlight, where the crest yellow would not", () => {
    assert.ok(contrast(theme.color.ink, theme.color.highlightFill) >= 4.5);
    assert.ok(contrast(theme.color.crest, theme.color.highlightFill) < 3);
  });

  test("dark's highlight fill and turn color are the one cream they always were", () => {
    assert.equal(theme.color.highlightFill, PALETTES.dark.accentSoft);
  });

  test("every member color has a name, and no two share one", () => {
    const names = MEMBER_COLORS.map((c) => MEMBER_COLOR_NAMES[c]);
    assert.equal(names.length, MEMBER_COLORS.length);
    for (const name of names) assert.ok(name && /^[A-Z][a-z]+$/.test(name), `"${name}"`);
    assert.equal(new Set(names).size, names.length);
  });

  test("the stacking order runs from panes to the home-screen app's status strip", () => {
    const { pane, sheet, options, bars, barOverlay, paneOverBars, notices, popover, alertsOverlay, overBars, statusBand: band } = theme.z;
    const order = [pane, sheet, options, bars, barOverlay, paneOverBars, notices, popover, alertsOverlay, overBars, band];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
});

describe("the two palettes as the page reads them", () => {
  test("every palette color is its custom property with the dark value as the fallback, so a page before the scheme starts draws dark", () => {
    for (const key of Object.keys(PALETTES.dark) as (keyof Palette)[]) {
      assert.equal(theme.color[key], `var(${colorVar(key)}, ${PALETTES.dark[key]})`, key);
    }
    assert.equal(colorVar("surfaceRaised"), "--rvtt-surface-raised");
  });

  test("the two palettes hold the same colors, and paletteVars sets every one and every shadow", () => {
    assert.deepEqual(Object.keys(PALETTES.light).sort(), Object.keys(PALETTES.dark).sort());
    assert.deepEqual(Object.keys(SHADOWS.light).sort(), Object.keys(SHADOWS.dark).sort());
    for (const scheme of SCHEMES) {
      const vars = paletteVars(scheme);
      assert.equal(Object.keys(vars).length, Object.keys(PALETTES[scheme]).length + Object.keys(SHADOWS[scheme]).length);
      for (const [key, value] of Object.entries(PALETTES[scheme])) assert.equal(vars[colorVar(key as keyof Palette)], value, `${scheme} ${key}`);
      for (const [key, value] of Object.entries(SHADOWS[scheme])) assert.equal(vars[shadowVar(key as keyof typeof SHADOWS.dark)], value, `${scheme} ${key}`);
    }
  });

  test("the shadows that differ are custom properties too, and the rim stays fixed", () => {
    for (const key of Object.keys(SHADOWS.dark) as (keyof typeof SHADOWS.dark)[]) assert.equal(theme.shadow[key], `var(${shadowVar(key)}, ${SHADOWS.dark[key]})`, key);
    assert.doesNotMatch(theme.shadow.rim, /var\(/);
  });

  test("the accent falls back to the scheme's crest accent, then to the crest yellow", () => {
    assert.equal(theme.color.accent, "var(--rvtt-accent, var(--rvtt-base-accent, #f7df00))");
    assert.equal(theme.color.onAccent, "var(--rvtt-on-accent, var(--rvtt-base-on-accent, #1a1206))");
    assert.equal(theme.color.accentTint, "var(--rvtt-accent-tint, var(--rvtt-base-accent-tint, rgba(247, 223, 0, 0.14)))");
  });

  test("a test can stand in a notch: the top safe area reads a property nothing in the app sets", () => {
    assert.equal(theme.safe.top, "var(--rvtt-safe-top, env(safe-area-inset-top, 0px))");
    assert.equal(statusBand(1.3), "inset 0 calc(var(--rvtt-safe-top, env(safe-area-inset-top, 0px)) / 1.3) 0 0 var(--rvtt-status-band, transparent)");
  });
});

describe("the board's palette", () => {
  test("is the dark palette and the fixed colors, every one plain, which a canvas can draw", () => {
    for (const [key, value] of Object.entries(boardTheme.color)) assert.match(value, /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/, key);
    for (const [key, value] of Object.entries(PALETTES.dark)) assert.equal(boardTheme.color[key as keyof Palette], value, key);
    for (const key of ["ink", "crest", "highlightFill", "fog", "textHalo", "scrimLight", "stage", "white"] as const) assert.equal(boardTheme.color[key], theme.color[key], key);
  });

  test("a subtree that keeps the dark look reads the dark palette, the accent resolved for dark and a dark focus ring", () => {
    for (const [name, value] of Object.entries(paletteVars("dark"))) assert.equal(BOARD_SCOPE[name], value, name);
    assert.equal(BOARD_SCOPE["--rvtt-accent"], "var(--rvtt-board-accent, #f7df00)");
    assert.equal(BOARD_SCOPE["--rvtt-on-accent"], "var(--rvtt-board-on-accent, #1a1206)");
    assert.equal(BOARD_SCOPE["--rvtt-accent-tint"], "var(--rvtt-board-accent-tint, rgba(247, 223, 0, 0.14))");
    assert.equal(BOARD_SCOPE["--rvtt-selection"], "var(--rvtt-board-selection, rgba(247, 223, 0, 0.4))");
    assert.equal(BOARD_SCOPE["--rvtt-focus"], "var(--rvtt-board-accent, #f7df00)");
    assert.equal(BOARD_SCOPE.colorScheme, "dark");
    assert.equal(ON_BOARD_STYLE["--rvtt-focus"], BOARD_SCOPE["--rvtt-focus"]);
  });
});
