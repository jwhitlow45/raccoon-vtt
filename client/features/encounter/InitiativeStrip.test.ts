import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tokenPattern } from "../../components/testing/tokenPattern.ts";
import { ON_BOARD, ON_BOARD_STYLE, theme } from "../../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { trackerTargetLook, TURN_FACE_PX, YourTurn } = await import("./InitiativeStrip.tsx");
const { TURN_PILL_PX } = await import("./parts.tsx");

/*
 * "Your turn" flares as a cream pill under ink, the fixed `highlightFill`
 * in both schemes, and settles into the strip's turn text, `accentSoft`,
 * which is amber on a light page (docs/design/design-v1-light-theme.md 6.1).
 */
test("your turn's flare fills with the fixed cream and settles into the turn's text color", () => {
  const flare = renderToStaticMarkup(createElement(YourTurn, { notice: true, fontSize: 14 }));
  assert.match(flare, new RegExp(`--rvtt-notice-fill:${tokenPattern(theme.color.highlightFill)};`));
  assert.match(flare, new RegExp(`--rvtt-notice-ink:${tokenPattern(theme.color.ink)};`));
  assert.match(flare, new RegExp(`--rvtt-notice-settled:${tokenPattern(theme.color.accentSoft)};`));
  assert.match(flare, new RegExp(`background:${tokenPattern(theme.color.highlightFill)};color:${tokenPattern(theme.color.ink)}`));
  const settled = renderToStaticMarkup(createElement(YourTurn, { notice: false, fontSize: 14 }));
  assert.match(settled, new RegExp(`color:${tokenPattern(theme.color.accentSoft)}`));
  assert.doesNotMatch(settled, /background/);
});

/*
 * In the top bar's turn chip "Your turn" sits in one row with the acting
 * face, both painted while it flares, so they share a height
 * (measureAlignment's row-height check, which the 20 px pill beside the
 * 26 px face failed by 6 px for its 4 s). The chip's end then holds the
 * pill as its top and bottom do. Under the name in the band, nothing
 * painted shares its row.
 */
test("the bar's inline your turn is as tall as the acting face, in its flare and after, and the band's keeps its own line", () => {
  for (const notice of [true, false]) {
    const inline = renderToStaticMarkup(createElement(YourTurn, { notice, fontSize: 13, inline: true }));
    assert.match(inline, new RegExp(`line-height:${TURN_FACE_PX}px`), `inline, notice ${notice}`);
    assert.match(renderToStaticMarkup(createElement(YourTurn, { notice, fontSize: 13 })), /line-height:20px/, `the band's, notice ${notice}`);
  }
  const strip = readFileSync(new URL("./InitiativeStrip.tsx", import.meta.url), "utf8");
  assert.ok(strip.includes("<Portrait entry={current} size={TURN_FACE_PX}"), "the chip draws the acting face at that size");
  assert.ok(strip.includes("${yours && props.fit.yourTurn ? (TURN_PILL_PX - TURN_FACE_PX) / 2 : theme.space(3)}px"), "the chip's end is the pill's gap above and below");
  assert.equal((TURN_PILL_PX - TURN_FACE_PX) / 2, 5);
});

/*
 * The strip's tracker target covers its band or pill, and its ring falls
 * past the band's foot onto the map: the board's two-tone ring, the accent
 * resolved for dark on a dark halo (docs/design/design-v1-light-theme.md 6.4).
 */
test("the tracker target wears the board's two-tone ring, at either reach", () => {
  for (const reach of [0, 6]) {
    const look = trackerTargetLook(reach);
    for (const [name, value] of Object.entries(ON_BOARD)) assert.equal(look.attrs[name], value, name);
    for (const [name, value] of Object.entries(ON_BOARD_STYLE)) assert.equal((look.style as Record<string, unknown>)[name], value, name);
    assert.equal(look.attrs["data-rvtt-backdrop"], "");
    assert.equal(look.style.top, -reach);
  }
});
