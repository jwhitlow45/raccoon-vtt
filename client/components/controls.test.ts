import "./testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { RadioCards } = await import("./RadioCards.tsx");
const { PlayersSeeChoice } = await import("../features/vision/PlayersSee.tsx");
const { ShapeRow } = await import("../features/grid/ShapeRow.tsx");

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

  test("Segmented: a description is a Help line the radiogroup points at, and without one there is none", () => {
    const options = [
      { value: "c", label: "Controlled" },
      { value: "i", label: "Independent" },
    ];
    for (const even of [false, true]) {
      const markup = html(createElement(Segmented<string>, { label: "Ride", value: "c", options, even, description: "Warhorse moves on Thorn's turn.", onChange() {} }));
      const id = /role="radiogroup"[^>]* aria-describedby="([^"]+)"/.exec(markup)?.[1];
      assert.ok(id, "the radiogroup names its description");
      assert.match(markup, new RegExp(`<p id="${id}"[^>]*>Warhorse moves on Thorn&#x27;s turn.</p>`));
    }
    // Its style places the whole choice: on the outer box with the Help line, never inside it, even or not (review P3-3).
    for (const even of [false, true]) {
      const markup = html(createElement(Segmented<string>, { label: "Ride", value: "c", options, even, description: "Warhorse moves on Thorn's turn.", style: { marginTop: 7 }, onChange() {} }));
      assert.match(markup, /^<div style="display:grid;[^"]*margin-top:7px">/, `the outer box takes the style${even ? ", even" : ""}`);
      assert.equal(markup.match(/margin-top:7px/g)?.length, 1, `only the outer box${even ? ", even" : ""}`);
    }
    const plain = html(createElement(Segmented<string>, { label: "Ride", value: "c", options, onChange() {} }));
    assert.doesNotMatch(plain, /aria-describedby/);
    assert.match(plain, /^<div role="radiogroup"/, "without a description the group is drawn as before");
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

describe("Checkbox", () => {
  test("a tick held by aria-disabled keeps its place in the focus order, with the disabled look and its reason as the description", () => {
    const markup = html(createElement(Checkbox, { label: "A creature steps onto it", help: "A trap on squares goes off at least one way.", checked: true, "aria-disabled": true, onChange() {} }));
    const input = /<input[^>]*>/.exec(markup)?.[0] ?? "";
    assert.match(input, /aria-disabled="true"/);
    assert.doesNotMatch(input, /\sdisabled=""/, "a native disabled drops it from the focus order");
    assert.match(input, /aria-describedby="[^"]+"/);
    assert.match(markup, new RegExp(theme.color.textDisabled), "it looks unavailable");
  });

  test("a plain checkbox has no aria-disabled", () => {
    const input = /<input[^>]*>/.exec(html(createElement(Checkbox, { label: "Secret", checked: false, onChange() {} })))?.[0] ?? "";
    assert.doesNotMatch(input, /aria-disabled/);
  });

  /*
   * With help under its label, the box marks the label's first line: it
   * stands centered in a slot as tall as that line, where a 2 px margin
   * set it 3.5 px under the line's middle (docs/design-v1-polish.md R1).
   */
  test("with help, the box stands centered in a slot as tall as its label's first line, with no margin of its own", () => {
    const markup = html(createElement(Checkbox, { label: "A creature steps onto it", help: "A trap on squares goes off at least one way.", checked: true, onChange() {} }));
    const slot = /<span style="([^"]*)"><input[^>]*><\/span>/.exec(markup)?.[1];
    assert.ok(slot, "the box has no slot of its own");
    const line = theme.font.body14 * theme.leading.body;
    assert.match(slot, new RegExp(`(^|;)height:${String(line).replace(".", "\\.")}px(;|$)`));
    assert.match(slot, /align-items:center/);
    assert.match(slot, /flex:none/);
    assert.match(/<input[^>]*>/.exec(markup)?.[0] ?? "", /margin:0[;"]/);
    // The slot's height is the label's own line: its 14 px text at body leading.
    assert.match(markup, new RegExp(`font-size:${theme.font.body14}px;line-height:${theme.leading.body}">A creature steps onto it<`));
  });

  test("with no help, the box sits on the row's middle in a slot of its own height", () => {
    const markup = html(createElement(Checkbox, { label: "Secret", checked: false, onChange() {} }));
    assert.match(markup, /^<label[^>]*align-items:center[^>]*><span style="[^"]*"><input/);
    const slot = /<span style="([^"]*)"><input[^>]*><\/span>/.exec(markup)?.[1] ?? "";
    assert.doesNotMatch(slot, /(^|;)height:/, "the slot sets a height with no help to fit");
  });

  /*
   * Another device can leave a focused tick the last one, which gives it
   * help (TrapPane.tsx). The input keeps its place in the tree either way,
   * so React keeps the element and its focus. The page's own rerender of
   * the focused tick is e2e/traps.e2e.ts pl1-c's.
   */
  test("the input stands at the same place in the tree with help and without, so help that comes or goes keeps the element", () => {
    const shape = (markup: string) => markup.replace(/ [a-z-]+="[^"]*"/g, "").replace(/>[^<]+</g, "><");
    const path = (markup: string) => /^<label><span><input\/?>/.test(shape(markup));
    const without = html(createElement(Checkbox, { label: "A creature steps onto it", checked: true, onChange() {} }));
    const withHelp = html(createElement(Checkbox, { label: "A creature steps onto it", help: "A trap on squares goes off at least one way.", checked: true, onChange() {} }));
    assert.ok(path(without), shape(without));
    assert.ok(path(withHelp), shape(withHelp));
  });
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

describe("three even choices that wrap (docs/design-v1-design-pass.md 4.2)", () => {
  const three = [
    { value: "squares", label: "Squares" },
    { value: "hexRows", label: "Hex rows" },
    { value: "hexColumns", label: "Hex columns" },
  ];
  const classOf = (props: Record<string, unknown>) => /role="radiogroup"[^>]* class="([^"]+)"/.exec(html(createElement(Segmented<string>, { label: "Grid shape", value: "squares", options: three, onChange() {}, ...props })))?.[1];

  test("carry their own class, and three without wrap, four or six that wrap do not", () => {
    assert.equal(classOf({ even: true, wrap: true }), "rvtt-even-choices rvtt-even-three");
    assert.equal(classOf({ even: true }), "rvtt-even-choices", "Who in the trap pane keeps the two by two");
    assert.equal(classOf({ wrap: true }), undefined, "not even, no rule");
    const four = [...three, { value: "x", label: "X" }];
    assert.equal(classOf({ even: true, wrap: true, options: four }), "rvtt-even-choices");
    const six = [...four, { value: "y", label: "Y" }, { value: "z", label: "Z" }];
    assert.equal(classOf({ even: true, wrap: true, options: six }), "rvtt-even-choices rvtt-even-six");
  });

  test("Grid shape is three even options that wrap, each label wrapping between its words", () => {
    const markup = html(createElement(ShapeRow, { name: "Grid shape", help: "Help.", value: "squares", onChange() {} }));
    assert.match(markup, /role="radiogroup"[^>]* class="rvtt-even-choices rvtt-even-three"/);
    const labels = [...markup.matchAll(/<label class="rvtt-choice" style="([^"]+)"/g)].map((m) => m[1]!);
    assert.equal(labels.length, 3);
    for (const style of labels) {
      assert.match(style, /flex:1 1 0/);
      assert.match(style, /white-space:normal/);
      assert.match(style, new RegExp(`min-height:${theme.touch}px`));
    }
  });

  test("their rule stands them one per row under 220 px of their container, above the two by two rule's reach", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    const rule = /@container \(width < (\d+)px\) \{\s*\.rvtt-even-choices\.rvtt-even-three \{\s*flex-wrap: wrap !important;\s*\}\s*\.rvtt-even-choices\.rvtt-even-three > \.rvtt-choice \{\s*flex: 1 1 100% !important;\s*\}\s*\}/.exec(css);
    assert.ok(rule, "one option per row at full width");
    assert.equal(Number(rule[1]), 220);
    const pair = /@container \(width < (\d+)px\) \{\s*\.rvtt-even-choices \{/.exec(css);
    assert.ok(pair && Number(pair[1]) < 220, "the two by two rule starts narrower, where the more specific three rule still wins");
  });
});

describe("radio cards (docs/design-v1-design-pass.md 4.2)", () => {
  const OPTIONS = [
    { value: "phone", label: "Phone size", help: "Loads faster and needs less memory." },
    { value: "full", label: "Full size", help: "Sharper on a large screen." },
  ];
  const cards = (extra: Record<string, unknown> = {}) => html(createElement(RadioCards<string>, { legend: "Map images", value: "full", options: OPTIONS, onChange() {}, ...extra }));
  /** The text of the element with an id, in some markup. */
  const textOf = (markup: string, id: string | undefined) => (id ? new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(markup)?.[1] : undefined);

  test("one radio per option sharing one name, each named by its label alone and described by its help", () => {
    const markup = cards();
    const inputs = radios(markup);
    assert.equal(inputs.length, 2);
    assert.equal(new Set(inputs.map((i) => /name="([^"]+)"/.exec(i)?.[1])).size, 1);
    inputs.forEach((input, i) => {
      assert.equal(textOf(markup, /aria-labelledby="([^"]+)"/.exec(input)?.[1]), OPTIONS[i]!.label);
      assert.equal(textOf(markup, /aria-describedby="([^"]+)"/.exec(input)?.[1]), OPTIONS[i]!.help);
    });
    assert.match(inputs[1]!, / checked=""/);
  });

  test("a fieldset under its legend, described by its help and then the chosen card's help", () => {
    const markup = cards({ help: "For this device only." });
    assert.match(markup, /^<fieldset aria-describedby="([^"]+)"/);
    assert.match(markup, /<legend[^>]*>Map images<\/legend>/);
    const ids = /^<fieldset aria-describedby="([^"]+)"/.exec(markup)![1]!.split(" ");
    assert.deepEqual(ids.map((id) => textOf(markup, id)), ["For this device only.", "Sharper on a large screen."]);
    assert.doesNotMatch(markup, /role="status"/, "no status line unless asked");
  });

  test("a disabled group keeps its shape with dim words, never a fade, and every radio is off", () => {
    const markup = cards({ disabled: true });
    assert.match(markup, /^<fieldset[^>]* disabled=""/);
    assert.ok(radios(markup).every((i) => / disabled=""/.test(i)));
    assert.match(markup, new RegExp(`<legend[^>]*color:${escape(theme.color.textDisabled)}`));
    assert.doesNotMatch(markup, new RegExp(escape(theme.color.accentTint)), "the chosen card wears no accent while off");
    assert.doesNotMatch(markup, /opacity/);
  });

  test("Players see: a radio group under its name, its Like card fourth, described by the chosen help", () => {
    const like = { name: "Crypt", summary: "Explore, Dark, Per player" };
    const markup = html(createElement(PlayersSeeChoice, { value: "like", like, onChange() {} }));
    const group = /<div role="radiogroup" aria-labelledby="([^"]+)" aria-describedby="([^"]+)"/.exec(markup);
    assert.ok(group, "a named, described radio group");
    assert.equal(textOf(markup, group[1]), "Players see");
    assert.equal(textOf(markup, group[2]), like.summary);
    const inputs = radios(markup);
    assert.equal(inputs.length, 4);
    assert.equal(textOf(markup, /aria-labelledby="([^"]+)"/.exec(inputs[3]!)?.[1]), "Like Crypt");
    assert.match(inputs[3]!, / checked=""/);
    assert.doesNotMatch(markup, /<fieldset/);
  });

  test("Players see's status line is mounted while empty, and says the work in hand with the small wait, no div inside", () => {
    const quiet = html(createElement(PlayersSeeChoice, { value: "explore", onChange() {} }));
    assert.match(quiet, /<div role="status" style="display:grid;min-width:0">/, "mounted, taking no room");
    const working = html(createElement(PlayersSeeChoice, { value: "explore", busy: true, working: "Working out who sees what…", onChange() {} }));
    assert.match(working, /<div role="radiogroup"[^>]* aria-busy="true"/);
    const status = /<div role="status"[^>]*>(.*)<\/div>/.exec(working)?.[1] ?? "";
    assert.match(status, /^<span style="[^"]*display:inline-flex[^"]*"><svg[^>]*width="16"/, "the small wait, saying nothing of its own inside the status");
    assert.ok(status.includes("Working out who sees what…"));
    assert.doesNotMatch(status, /<div|role=/);
  });

  test("with nothing chosen the group is described by the none line, in the warning tone", () => {
    const markup = html(createElement(PlayersSeeChoice, { value: null, none: "Custom: this scene's own settings.", onChange() {} }));
    const id = /<div role="radiogroup"[^>]* aria-describedby="([^"]+)"/.exec(markup)?.[1];
    assert.equal(textOf(markup, id), "Custom: this scene&#x27;s own settings.");
    assert.match(markup, new RegExp(`id="${id}" style="[^"]*color:${escape(theme.color.warning)}`));
    assert.equal(radios(markup).filter((i) => / checked=""/.test(i)).length, 0);
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
