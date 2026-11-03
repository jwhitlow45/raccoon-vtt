import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../../lib/theme.ts";
import { tokenPattern } from "../../components/testing/tokenPattern.ts";

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Held } = await import("../../components/Held.tsx");
const { ColorInput, NumberInput, Select, Slider } = await import("./controls.tsx");

/*
 * LOCKED-LOOK: the Scenes panel's own small controls read a held group, as
 * the shared Input and Select do. Each goes natively off and draws the
 * disabled look. The color picker has no words, so it takes the quiet outline.
 */
const nothing = () => {};
const controls = {
  Select: () => h(Select<"a">, { label: "Grid", value: "a", options: [{ value: "a", label: "Squares" }], onChange: nothing }),
  NumberInput: () => h(NumberInput, { label: "Width", value: 30, min: 1, max: 99, onChange: nothing }),
  ColorInput: () => h(ColorInput, { label: "Background", value: "#336699", onChange: nothing }),
  Slider: () => h(Slider, { label: "Dim", value: 3, min: 0, max: 9, step: 1, onChange: nothing }),
};
const held = (on: boolean, child: ReturnType<typeof h>) => renderToStaticMarkup(h(Held, { held: on, children: child }));

describe("a held group stops the Scenes panel's controls (LOCKED-LOOK)", () => {
  for (const [name, draw] of Object.entries(controls)) {
    test(name, () => {
      const free = held(false, draw());
      const off = held(true, draw());
      assert.doesNotMatch(free, /<(select|input)[^>]*\sdisabled=""/, "free, it is live");
      assert.match(off, /<(select|input)[^>]*\sdisabled=""/, "held, it is natively off");
      if (name === "ColorInput") assert.match(off, new RegExp(`solid ${tokenPattern(theme.color.border)}`, "i"));
      else assert.match(off, new RegExp(`color:${tokenPattern(theme.color.textDisabled)}`, "i"));
    });
  }

  test("a slider dims its value and its track too", () => {
    const off = held(true, controls.Slider());
    assert.equal(off.match(new RegExp(`(?<!-)color:${tokenPattern(theme.color.textDisabled)}`, "gi"))?.length, 2, "label and value");
    assert.match(off, new RegExp(`accent-color:${tokenPattern(theme.color.textDisabled)}`, "i"));
    assert.doesNotMatch(held(false, controls.Slider()), new RegExp(`color:${tokenPattern(theme.color.textDisabled)}`, "i"));
  });
});
