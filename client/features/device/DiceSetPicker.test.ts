import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The dice set picker's tiles in rows of four (docs/design-v1-roll-animation.md
 * 9.2). The chosen tile drew a 2 px border where the others drew 1 px, so its
 * row stood 2 px taller than the other, and choosing a set in the other row
 * moved every tile under it (LP9-DICE-1).
 */

const { tileStyle } = await import("./DiceSetPicker.tsx");
const { theme } = await import("../../lib/theme.ts");

/** The px numbers of a CSS shorthand, in order. */
function px(value: unknown): number[] {
  return [...String(value).matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
}

/** What a tile's border and padding add around its content, across and down. */
function frame(style: ReturnType<typeof tileStyle>): { across: number; down: number } {
  const [border] = px(style.border);
  const [vertical, horizontal] = px(style.padding);
  return { across: 2 * (border! + horizontal!), down: 2 * (border! + vertical!) };
}

describe("the dice set picker's tiles", () => {
  test("a chosen tile is the same size as the others, with or without the switch on", () => {
    for (const on of [true, false]) assert.deepEqual(frame(tileStyle(true, on)), frame(tileStyle(false, on)), `chosen and not differ with the switch ${on ? "on" : "off"}`);
  });

  test("the chosen tile still reads heavier: a strong border, in the accent while the switch is on", () => {
    assert.equal(tileStyle(true, true).border, `${theme.line.strong}px solid ${theme.color.accent}`);
    assert.equal(tileStyle(false, true).border, `${theme.line.border}px solid ${theme.color.border}`);
  });

  test("with the switch off the chosen tile keeps its mark, a dim outline with no tint, as a chosen option that cannot change now does (docs/design-v1-look-pass-2.md D37)", () => {
    assert.equal(tileStyle(true, false).border, `${theme.line.strong}px solid ${theme.color.textDisabled}`);
    assert.equal(tileStyle(true, false).background, "transparent");
    assert.equal(tileStyle(false, false).border, `${theme.line.border}px solid ${theme.color.border}`);
  });
});
