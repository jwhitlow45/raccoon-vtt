import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contrast } from "./accent.ts";
import { MEMBER_COLOR_NAMES, MEMBER_COLORS, theme } from "./theme.ts";

const SURFACES = { bg: theme.color.bg, surface: theme.color.surface, surfaceRaised: theme.color.surfaceRaised } as const;

describe("the visual system's tokens", () => {
  for (const [name, surface] of Object.entries(SURFACES)) {
    test(`a disabled label reads at 3:1 on ${name}, and dimmer than muted text`, () => {
      const disabled = contrast(theme.color.textDisabled, surface);
      assert.ok(disabled >= 3, `textDisabled on ${name}: ${disabled.toFixed(2)}`);
      assert.ok(disabled < contrast(theme.color.textMuted, surface), `textDisabled must read dimmer than textMuted on ${name}`);
    });

    test(`a control's outline reads at 3:1 on ${name}`, () => {
      const ratio = contrast(theme.color.controlBorder, surface);
      assert.ok(ratio >= 3, `controlBorder on ${name}: ${ratio.toFixed(2)}`);
    });

    test(`error text reads at 4.5:1 on ${name}`, () => {
      const ratio = contrast(theme.color.dangerText, surface);
      assert.ok(ratio >= 4.5, `dangerText on ${name}: ${ratio.toFixed(2)}`);
    });
  }

  test("ink reads on the cream highlight, where the crest yellow would not", () => {
    assert.ok(contrast(theme.color.ink, theme.color.accentSoft) >= 4.5);
    assert.ok(contrast(theme.color.crest, theme.color.accentSoft) < 3);
  });

  test("text reads on the warning and danger notice fills", () => {
    for (const fill of [theme.color.warningFill, theme.color.dangerFill]) {
      assert.ok(contrast(theme.color.text, fill) >= 4.5, `text on ${fill}`);
    }
  });

  test("every member color has a name, and no two share one", () => {
    const names = MEMBER_COLORS.map((c) => MEMBER_COLOR_NAMES[c]);
    assert.equal(names.length, MEMBER_COLORS.length);
    for (const name of names) assert.ok(name && /^[A-Z][a-z]+$/.test(name), `"${name}"`);
    assert.equal(new Set(names).size, names.length);
  });

  test("the stacking order runs from panes to what sits over the bars", () => {
    const { pane, sheet, options, bars, barOverlay, notices, popover, alertsOverlay, overBars } = theme.z;
    const order = [pane, sheet, options, bars, barOverlay, notices, popover, alertsOverlay, overBars];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
});
