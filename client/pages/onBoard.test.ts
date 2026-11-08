import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { accentFor, contrast, mix } from "../lib/accent.ts";
import { MARK_RING } from "../lib/memberColor.ts";
import { BOARD_SCOPE, boardTheme, MEMBER_COLORS, ON_BOARD, ON_BOARD_STYLE, PALETTES, SCHEMES, theme } from "../lib/theme.ts";
import { MAP_FOCUS_ATTRS, MAP_FOCUS_STYLE, MAP_GROUND, memberDotStyle, SCENE_GATE_STYLE, toolGround, toolOnBoard } from "./onBoard.ts";

/*
 * The Room page where it meets the board (docs/design/design-v1-light-theme.md
 * 6.4, D-261102-362 and D-261102-364): the map's ground, the floating
 * toolbar's chosen tool and rings, the map's focus target, the chip's dot
 * and the scene gate. Room.tsx cannot load under node (Konva wants a
 * window), so its wiring is read from its source.
 */

const room = readFileSync(new URL("./Room.tsx", import.meta.url), "utf8");

/** A CSS color, hex or rgba, laid over an opaque hex ground. */
function over(color: string, ground: string): string {
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
  if (!rgba) return color;
  const hex = `#${[rgba[1], rgba[2], rgba[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
  return mix(ground, hex, Number(rgba[4]));
}

/** The two grounds a zoomed or panned map can put under floating chrome: the board's own and the brightest art. */
const BOARD_GROUNDS = [boardTheme.color.bg, "#ffffff"];

describe("the ground around the map", () => {
  test("is the board's in both schemes, and the map's column wears it", () => {
    assert.equal(MAP_GROUND, PALETTES.dark.bg);
    assert.doesNotMatch(MAP_GROUND, /var\(/, "plain hex, which no scheme's variables reach");
    assert.match(room, /flex: 1, minWidth: 0, background: MAP_GROUND,/);
  });
});

describe("a floating toolbar button", () => {
  test("lays the chosen tint over the overlay its neighbors wear, only where it floats", () => {
    assert.equal(toolGround(true, true), `linear-gradient(${theme.color.accentTint}, ${theme.color.accentTint}), ${theme.color.overlay}`);
    assert.equal(toolGround(false, true), theme.color.overlay);
    assert.equal(toolGround(true, false), theme.color.accentTint, "a band's chosen tool keeps the tint alone, the band is its ground");
    assert.equal(toolGround(false, false), "transparent");
    assert.match(room, /background: toolGround\(chosen, props\.floating === true\)/);
  });

  for (const scheme of SCHEMES) {
    test(`chosen, its ${scheme} accent reads on its own ground over the board and over white art`, () => {
      const p = PALETTES[scheme];
      for (const color of MEMBER_COLORS) {
        const a = accentFor(color, scheme);
        for (const art of BOARD_GROUNDS) {
          const ground = over(a.tint, over(p.overlay, art));
          const ratio = contrast(a.accent, ground);
          // Its name is 13 px text, so 4.5:1, over white art too: at 0.88 dark's overlay let white art lift the ground to 4.1:1 for a mid-light accent (LT-DARK-OVERLAY).
          assert.ok(ratio >= 4.5, `${color} on ${scheme} over ${art}: ${ratio.toFixed(2)}`);
        }
      }
    });
  }

  test("takes the two-tone ring of chrome on the board, a band's button does not", () => {
    assert.deepEqual(toolOnBoard(true), { attrs: ON_BOARD, style: ON_BOARD_STYLE });
    assert.deepEqual(toolOnBoard(false), { attrs: {}, style: {} });
    assert.match(room, /const onBoard = toolOnBoard\(props\.floating === true\);/);
    assert.match(room, /type="button"\n\s*\{\.\.\.onBoard\.attrs\}/);
    assert.match(room, /\.\.\.sizeStyle\(props\.size\),\n\s*\.\.\.onBoard\.style,/, "after the size, so nothing later drops the ring's accent");
  });
});

describe("the map's focus target", () => {
  test("keeps its ring under keys (data-rvtt-ring) and takes the two-tone ring in its inset form", () => {
    assert.equal(MAP_FOCUS_ATTRS["data-rvtt-ring"], "");
    assert.equal(MAP_FOCUS_ATTRS["data-rvtt-on-board"], "");
    assert.equal(MAP_FOCUS_STYLE.outlineOffset, -2, "inside the map's edge");
    assert.equal((MAP_FOCUS_STYLE as Record<string, unknown>)["--rvtt-focus"], ON_BOARD_STYLE["--rvtt-focus"], "the accent resolved for dark");
    assert.match(room, /role="img" aria-label="Map" \{\.\.\.MAP_FOCUS_ATTRS\} style=\{MAP_FOCUS_STYLE\}/);
  });
});

describe("the chip's member dot", () => {
  test("keeps the raw color and wears the 1 px inset mark ring, so it keeps its size", () => {
    const style = memberDotStyle("#e5e5e5", 8);
    assert.equal(style.background, "#e5e5e5");
    assert.equal(style.width, 8);
    assert.equal(style.height, 8);
    assert.equal(style.boxShadow, `inset 0 0 0 1px ${theme.color.markRing}`);
    // The ring every member mark wears, from lib/memberColor.ts, so the chip's dot cannot drift from the rest.
    assert.equal(style.boxShadow, MARK_RING);
    const onBoard = readFileSync(new URL("./onBoard.ts", import.meta.url), "utf8");
    assert.match(onBoard, /import \{ MARK_RING \} from "\.\.\/lib\/memberColor\.ts";/);
    assert.doesNotMatch(onBoard, /const MARK_RING\b/);
    // The top bar's chips moved to their own file with their menus (docs/design/design-v1-qol.md 6).
    const chips = readFileSync(new URL("./ChipMenus.tsx", import.meta.url), "utf8");
    assert.match(chips, /function ChipDot\(props: \{ color: string \}\) \{\n\s*return <span aria-hidden style=\{memberDotStyle\(props\.color, 8\)\} \/>;/);
  });

  for (const scheme of SCHEMES) {
    test(`a white or yellow dot's ring shows its edge on the ${scheme} bar`, () => {
      const p = PALETTES[scheme];
      const bar = over(p.overlay, p.bg);
      // Where the dot itself fades into the bar, the ring must stand apart from the bar.
      for (const color of ["#e5e5e5", "#f7df00"]) if (contrast(color, bar) < 1.5) assert.ok(contrast(p.markRing, bar) >= 3, `${color} on ${scheme}`);
    });
  }
});

describe("the scene gate", () => {
  test("is black with the whole dark palette and the dark accent in scope, and sets its text under it", () => {
    for (const [name, value] of Object.entries(BOARD_SCOPE)) assert.equal((SCENE_GATE_STYLE as Record<string, unknown>)[name], value, name);
    assert.equal(SCENE_GATE_STYLE.background, theme.color.stage);
    assert.equal(SCENE_GATE_STYLE.color, theme.color.textMuted);
    assert.ok(contrast(PALETTES.dark.textMuted, theme.color.stage) >= 4.5, "the dark muted text reads on black");
    assert.match(room, /return <div style=\{SCENE_GATE_STYLE\}>/);
  });
});
