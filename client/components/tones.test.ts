import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast } from "../lib/accent.ts";
import { PALETTES, SCHEMES, theme } from "../lib/theme.ts";
import { NOTICE_TONES } from "./tones.ts";

/*
 * The highlight notice, such as the preview's "Viewing as" banner, is a
 * cream band under ink in both schemes (docs/design/design-v1-light-theme.md
 * 6.1): the fixed `highlightFill`, since `accentSoft` becomes an amber for
 * text on a light page, where ink on it would read 2.8:1. Its outline stays
 * the turn's own color, which shows the band's edge on a light page, where
 * cream reads 1.2:1.
 */
test("the highlight notice is the fixed cream under ink, its ring ink, its outline the turn's color", () => {
  const tone = NOTICE_TONES.highlight;
  assert.equal(tone.fill, theme.color.highlightFill);
  assert.equal(tone.text, theme.color.ink);
  assert.equal(tone.focus, theme.color.ink);
  assert.equal(tone.outline, theme.color.accentSoft);
  assert.ok(contrast(theme.color.ink, theme.color.highlightFill) >= 4.5);
  // The ring inside reads on the cream, where the crest yellow would not.
  assert.ok(contrast(theme.color.ink, theme.color.highlightFill) >= 3);
  assert.ok(contrast(theme.color.crest, theme.color.highlightFill) < 3);
  for (const scheme of SCHEMES) {
    const p = PALETTES[scheme];
    for (const ground of [p.bg, p.surface, p.surfaceRaised]) assert.ok(contrast(p.accentSoft, ground) >= 3, `${scheme}: the outline ${p.accentSoft} on ${ground}`);
  }
  // On light, amber under ink would fail: the reason for the fixed fill.
  assert.ok(contrast(theme.color.ink, PALETTES.light.accentSoft) < 4.5);
});
