import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accentFor, contrast } from "../lib/accent.ts";
import { MEMBER_COLORS, theme } from "../lib/theme.ts";
import { NOTICE_TONES, TAG_TONES } from "./tones.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Segmented } = await import("./Segmented.tsx");
const { Swatches } = await import("./Swatches.tsx");
const { Switch } = await import("./Switch.tsx");
const { Checkbox } = await import("./Checkbox.tsx");
const { Chip } = await import("./Chip.tsx");
const { Field, Input, Select } = await import("./Field.tsx");
const { Row } = await import("./Row.tsx");
const { SettingRow } = await import("./SettingRow.tsx");

const html = renderToStaticMarkup;

/** The radio inputs in some markup, with their attributes. */
function radios(markup: string): string[] {
  return [...markup.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
}

/** A seeded generator, as accent.test.ts uses, so a failing case comes back the same every run. */
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe("choices are native radios", () => {
  test("Segmented: one named radiogroup, every option a radio sharing one name, one checked", () => {
    const markup = html(
      createElement(Segmented<string>, {
        label: "Ability",
        value: "dex",
        options: [
          { value: "str", label: "Str" },
          { value: "dex", label: "Dex" },
          { value: "con", label: "Con" },
        ],
        onChange() {},
      }),
    );
    assert.match(markup, /^<div role="radiogroup" aria-label="Ability"/);
    const inputs = radios(markup);
    assert.equal(inputs.length, 3);
    const names = new Set(inputs.map((i) => /name="([^"]+)"/.exec(i)?.[1]));
    assert.equal(names.size, 1, "the radios share one name, so the group is one Tab stop");
    assert.ok([...names][0], "the name is set");
    assert.equal(inputs.filter((i) => / checked=""/.test(i)).length, 1);
    assert.match(inputs[1]!, / checked=""/);
    assert.equal([...markup.matchAll(/class="rvtt-choice"/g)].length, 3, "each option carries the focus ring rule");
  });

  test("two Segmented groups get different names", () => {
    const one = { label: "A", value: "x", options: [{ value: "x", label: "X" }], onChange() {} };
    const markup = html(createElement("div", null, createElement(Segmented<string>, one), createElement(Segmented<string>, { ...one, label: "B" })));
    const names = new Set(radios(markup).map((i) => /name="([^"]+)"/.exec(i)?.[1]));
    assert.equal(names.size, 2);
  });

  test("a glyph option is named by its title", () => {
    const markup = html(createElement(Segmented<number>, { label: "Size", value: 1, options: [{ value: 1, label: "+", title: "Bigger" }], onChange() {} }));
    assert.match(radios(markup)[0]!, /aria-label="Bigger"/);
  });

  test("Swatches: named by color, never by hex, one checked, in a named radiogroup", () => {
    const markup = html(
      createElement(Swatches, {
        label: "Your color",
        value: "#30A46C",
        options: [...MEMBER_COLORS.slice(0, 3), { color: "#123456", name: "Current color" }, { color: "#e93d82", name: "Pink, used by Pat", badge: "P" }],
        onChange() {},
      }),
    );
    assert.match(markup, /^<div role="radiogroup" aria-label="Your color"/);
    const inputs = radios(markup);
    assert.deepEqual(
      inputs.map((i) => /aria-label="([^"]+)"/.exec(i)?.[1]),
      ["Yellow", "Green", "Blue", "Current color", "Pink, used by Pat"],
    );
    assert.equal(new Set(inputs.map((i) => /name="([^"]+)"/.exec(i)?.[1])).size, 1);
    assert.equal(inputs.filter((i) => / checked=""/.test(i)).length, 1);
    assert.match(inputs[1]!, / checked=""/, "the value matches whatever its case");
    assert.match(markup, />P<\/span>/);
    assert.doesNotMatch(markup, /opacity:0\.\d/);
  });
});

describe("disabled controls swap colors and never fade", () => {
  const cases = {
    Switch: createElement(Switch, { label: "Fog", help: "Hides the map", checked: true, disabled: true, onChange() {} }),
    Segmented: createElement(Segmented<string>, { label: "Light", value: "a", disabled: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], onChange() {} }),
    Swatches: createElement(Swatches, { label: "Color", value: "#30a46c", disabled: true, options: [...MEMBER_COLORS], onChange() {} }),
    Checkbox: createElement(Checkbox, { label: "Secret", checked: false, disabled: true, onChange() {} }),
    Chip: createElement(Chip, { pressed: true, disabled: true, onClick() {}, children: "Monsters" }),
    Field: createElement(Field, { label: "Name", disabled: true, defaultValue: "Pat" }),
    Input: createElement(Input, { "aria-label": "HP", type: "number", disabled: true }),
    Select: createElement(Select, { "aria-label": "Size", disabled: true }),
    Row: createElement(Row, { title: "Cave", detail: "30 x 20", disabled: true, onClick() {} }),
  };
  for (const [name, element] of Object.entries(cases)) {
    test(name, () => {
      const markup = html(element);
      // The radios lie unseen over their options at opacity 0, which is not a fade.
      assert.doesNotMatch(markup.replace(/opacity:0;/g, ""), /opacity/, `${name} fades by opacity`);
      assert.match(markup, new RegExp(theme.color.textDisabled), `${name} uses the disabled color`);
    });
  }
});

describe("Switch", () => {
  test("a switch named by its setting alone, with the help as its description", () => {
    const markup = html(createElement(Switch, { label: "Fog", help: "Players see only what you reveal.", checked: false, onChange() {} }));
    assert.match(markup, /role="switch"/);
    assert.match(markup, /aria-checked="false"/);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
    assert.ok(labelledBy && describedBy && labelledBy !== describedBy);
    assert.match(markup, new RegExp(`id="${labelledBy}"[^>]*>Fog<`));
    assert.match(markup, new RegExp(`id="${describedBy}"[^>]*>Players see only what you reveal\\.<`));
  });

  test("busy keeps the switch enabled and says so", () => {
    const markup = html(createElement(Switch, { label: "Fog", checked: true, busy: true, onChange() {} }));
    assert.match(markup, /aria-busy="true"/);
    assert.doesNotMatch(markup, / disabled=""/);
    assert.match(markup, /rvtt-spin/);
  });

  test("the knob reads on the accent for every member color and any color at all", () => {
    const random = mulberry32(20261014);
    const colors = [...MEMBER_COLORS, ...Array.from({ length: 4000 }, () => `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, "0")}`)];
    for (const color of colors) {
      const { accent, onAccent } = accentFor(color);
      assert.ok(contrast(onAccent, accent) >= 4.5, `${color}: knob ${onAccent} on track ${accent} reads ${contrast(onAccent, accent).toFixed(2)}`);
    }
  });

  test("the off track's outline reads at 3:1 on every surface it sits on", () => {
    for (const surface of [theme.color.bg, theme.color.surface, theme.color.surfaceRaised]) assert.ok(contrast(theme.color.controlBorder, surface) >= 3);
  });
});

describe("tones", () => {
  for (const [tone, colors] of Object.entries(TAG_TONES)) {
    test(`a ${tone} tag's text reads at 4.5:1 on its bg fill`, () => {
      const ratio = contrast(colors.text, theme.color.bg);
      assert.ok(ratio >= 4.5, `${tone}: ${colors.text} on ${theme.color.bg} reads ${ratio.toFixed(2)}`);
    });
  }

  for (const [tone, colors] of Object.entries(NOTICE_TONES)) {
    test(`a ${tone} notice's text reads at 4.5:1 on its fill`, () => {
      assert.ok(contrast(colors.text, colors.fill) >= 4.5);
    });
  }

  test("the highlight notice's focus ring reads on cream, where the accent would not", () => {
    assert.ok(contrast(NOTICE_TONES.highlight.focus!, NOTICE_TONES.highlight.fill) >= 3);
    assert.ok(contrast(theme.color.crest, NOTICE_TONES.highlight.fill) < 3);
  });
});

describe("SettingRow", () => {
  test("the control is named by the setting and described by its help", () => {
    const markup = html(
      createElement(SettingRow, {
        name: "Interface size",
        help: "For this device only.",
        wide: true,
        children: (ids) => createElement(Segmented<string>, { labelledBy: ids.nameId, value: "100", options: [{ value: "100", label: "100%" }], onChange() {} }),
      }),
    );
    const labelledBy = /role="radiogroup" aria-labelledby="([^"]+)"/.exec(markup)?.[1];
    assert.ok(labelledBy);
    assert.match(markup, new RegExp(`id="${labelledBy}"[^>]*>Interface size<`));
  });
});

describe("panel sections", () => {
  test("a labelled section is no landmark unless asked, and its label is a heading either way", async () => {
    const { Section } = await import("./Panel.tsx");
    const plain = html(createElement(Section, { label: "Undo", children: "x" }));
    assert.doesNotMatch(plain, /aria-labelledby/);
    assert.match(plain, /<h3[^>]*>Undo<\/h3>/);
    const region = html(createElement(Section, { label: "Delete this room", region: true, children: "x" }));
    const id = /<section aria-labelledby="([^"]+)"/.exec(region)?.[1];
    assert.ok(id);
    assert.match(region, new RegExp(`<h3 id="${id}"[^>]*>Delete this room</h3>`));
  });
});

describe("rows and chips carry their callers' states and marks", () => {
  test("a row that discloses what is under it says whether it is open", () => {
    const open = html(createElement(Row, { title: "Thorn", expanded: true, onClick() {} }));
    assert.match(open, /<button[^>]* aria-expanded="true"/);
    assert.doesNotMatch(html(createElement(Row, { title: "Thorn", onClick() {} })), /aria-expanded/);
  });

  test("a chip that removes its filter looks chosen, is named for its tap and is not a toggle", () => {
    const markup = html(createElement(Chip, { remove: true, "aria-label": "Remove the filter Large", "data-chip": true, onClick() {}, children: "Large" }));
    assert.match(markup, /aria-label="Remove the filter Large"/);
    assert.match(markup, /data-chip="true"/);
    assert.doesNotMatch(markup, /aria-pressed/);
    assert.match(markup, /<svg/, "it shows the close icon");
    assert.match(html(createElement(Chip, { pressed: false, onClick() {}, children: "Beast" })), /aria-pressed="false"/);
  });
});

describe("a Segmented option with its own chosen look", () => {
  // The HP entry draws Damage in red and Heal in green rather than the accent (docs/design-v1-visual.md 2.3).
  const red = { border: `${theme.line.border}px solid ${theme.color.danger}`, background: theme.color.dangerTint };
  const render = (value: string, disabled = false) =>
    html(
      createElement(Segmented<string>, {
        label: "What the number does",
        value,
        disabled,
        options: [
          { value: "damage", label: "Damage", chosenStyle: red },
          { value: "heal", label: "Heal" },
        ],
        onChange() {},
      }),
    );

  test("draws its look only while chosen, and the accent's look is gone from it", () => {
    const chosen = render("damage");
    assert.match(chosen, new RegExp(theme.color.danger));
    assert.match(chosen, new RegExp(escape(theme.color.dangerTint)));
    // The other option is at rest, so nothing in the group wears the accent's chosen look.
    assert.doesNotMatch(chosen, new RegExp(escape(theme.color.accentTint)));
    const other = render("heal");
    assert.doesNotMatch(other, new RegExp(theme.color.danger));
    assert.match(other, new RegExp(escape(theme.color.accentTint)), "an option with no look of its own keeps the accent's");
  });

  test("a disabled chosen option keeps the disabled look", () => {
    const markup = render("damage", true);
    assert.doesNotMatch(markup, new RegExp(theme.color.danger));
    assert.match(markup, new RegExp(`border:${theme.line.border}px solid ${theme.color.textDisabled}`));
  });
});

/** A string as a literal in a RegExp: the tints carry parentheses and dots. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
