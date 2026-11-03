import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { colorVar, PALETTES, theme, type Palette } from "./lib/theme.ts";

/*
 * globals.css under the light theme (docs/design/design-v1-light-theme.md
 * 6.2 and 6.4): what it colors reads the scheme's custom properties, with
 * the dark value as the fallback for the boot page, and a ring that falls
 * on the board stands on a fixed dark halo.
 */

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `globals.css has a rule for ${selector}`);
  const open = css.indexOf("{", at + selector.length);
  return css.slice(open + 1, css.indexOf("}", open));
}

/** A palette color as globals.css must read it: its variable, with the dark value as the fallback. */
const read = (key: keyof Palette) => `var(${colorVar(key)}, ${PALETTES.dark[key]})`;

const RING = "var(--rvtt-focus, var(--rvtt-accent, var(--rvtt-base-accent, #f7df00)))";

describe("globals.css reads the scheme", () => {
  test("the page's ground and text", () => {
    const base = rule("html,\nbody,\n#root");
    assert.match(base, new RegExp(`background: ${escape(read("bg"))};`));
    assert.match(base, new RegExp(`color: ${escape(read("text"))};`));
  });

  test("the boot text and an off field's placeholder", () => {
    assert.match(rule(".rvtt-boot"), new RegExp(`color: ${escape(read("textMuted"))};`));
    assert.match(rule(':root[data-rvtt-scheme] :is(input, textarea):is(:disabled, [aria-disabled="true"])::placeholder'), new RegExp(`color: ${escape(read("textDisabled"))};`));
  });

  test("every focus ring takes a container's focus color, else the member's accent, else the scheme's crest accent", () => {
    for (const selector of [":focus-visible", ".rvtt-choice:has(> input:focus-visible)", "[data-pill-focus]:focus-visible > [data-pill]"]) {
      assert.ok(rule(selector).includes(`outline: 2px solid ${RING};`), selector);
    }
    // No ring left on the accent alone, which would skip the base outside a room.
    assert.equal(css.match(/var\(--rvtt-accent, #f7df00\)/g), null);
  });

  test("selection and the resize handle fall back to the scheme's crest accent", () => {
    assert.ok(rule("::selection").includes("var(--rvtt-selection, var(--rvtt-base-selection, #f7df0066))"));
    assert.ok(css.includes("color: var(--rvtt-accent, var(--rvtt-base-accent, #f7df00)) !important;"));
  });

  test("native controls start dark, for the boot page", () => {
    assert.match(rule(":root"), /color-scheme: dark;/);
  });
});

describe("a ring on the board (ON_BOARD) is two-tone", () => {
  const halo = `0 0 0 6px ${theme.ringHalo} !important`;

  test("the dark halo lies 6 px out under the ring, on the control, its pill and its choice", () => {
    const own = rule("[data-rvtt-on-board]:focus-visible,\n[data-pill-focus][data-rvtt-on-board]:focus-visible > [data-pill],\n.rvtt-choice[data-rvtt-on-board]:has(> input:focus-visible)");
    assert.ok(own.includes(`box-shadow: ${halo};`), own);
    // A pill's ring is on the pill, so its 44 px target draws no halo of its own.
    assert.match(rule("[data-pill-focus][data-rvtt-on-board]:focus-visible"), /box-shadow: none !important;/);
  });

  test("the map's focus target, whose ring lies inside the map's edge, takes it inset", () => {
    assert.ok(rule("[data-rvtt-on-board][data-rvtt-ring]:focus-visible").includes(`box-shadow: inset ${halo};`));
  });

  test("after a pointer the halo goes where the ring goes, the map's focus target's included (D-261102-538)", () => {
    const off = rule('[data-rvtt-input="pointer"] [data-rvtt-on-board]:focus-visible,\n[data-rvtt-input="pointer"] [data-pill-focus][data-rvtt-on-board]:focus-visible > [data-pill],\n[data-rvtt-input="pointer"] .rvtt-choice[data-rvtt-on-board]:has(> input:focus-visible)');
    assert.match(off, /box-shadow: none !important;/);
    // Later than the inset halo's rule and as specific, so it wins on the map's focus target.
    assert.ok(css.indexOf('\n[data-rvtt-input="pointer"] [data-rvtt-on-board]:focus-visible,') > css.indexOf("\n[data-rvtt-on-board][data-rvtt-ring]:focus-visible {"));
    const outlineOff = /\n\[data-rvtt-input="pointer"\] :focus-visible:not\(([^{]*)\) \{\s*outline: none;/.exec(css);
    assert.ok(outlineOff, "the pointer rule");
    assert.doesNotMatch(outlineOff[1]!, /data-rvtt-ring|data-rvtt-on-board/, "no ring kept after a pointer");
    assert.doesNotMatch(css, /:not\(\[data-rvtt-ring\]\)/, "no halo kept after a pointer");
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
