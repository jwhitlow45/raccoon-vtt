import "./testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PALETTES, theme } from "../lib/theme.ts";
import { tokenPattern } from "./testing/tokenPattern.ts";

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Held, HeldScope } = await import("./Held.tsx");
const { Button } = await import("./Button.tsx");
const { IconButton } = await import("./IconButton.tsx");
const { Field, Input, Select, TextArea } = await import("./Field.tsx");
const { Segmented } = await import("./Segmented.tsx");
const { Switch } = await import("./Switch.tsx");
const { Checkbox } = await import("./Checkbox.tsx");
const { Chip } = await import("./Chip.tsx");
const { RadioCards } = await import("./RadioCards.tsx");
const { Swatches } = await import("./Swatches.tsx");
const { Section } = await import("./Panel.tsx");
const { TextField, NumberField } = await import("../features/tokens/ui.tsx");

/*
 * LOCKED-LOOK: a held group's fieldset stops its native controls, and each
 * shared control must also draw the disabled look, as it would for its own
 * `disabled`. Each is drawn inside `Held held` with nothing of its own.
 */
const nothing = () => {};
const controls = {
  Button: () => h(Button, { onClick: nothing }, "Roll"),
  IconButton: () => h(IconButton, { icon: "close", label: "Close", onClick: nothing }),
  Input: () => h(Input, { "aria-label": "DC", value: "14", onChange: nothing }),
  Select: () => h(Select, { "aria-label": "It lasts", value: "a", onChange: nothing }, h("option", { value: "a" }, "Until removed")),
  TextArea: () => h(TextArea, { "aria-label": "Note", value: "x", onChange: nothing }),
  Field: () => h(Field, { label: "Room name", value: "Keep", onChange: nothing }),
  Segmented: () => h(Segmented<"half" | "none">, { label: "On a pass", value: "none", options: [{ value: "half", label: "Half" }, { value: "none", label: "None" }], onChange: nothing }),
  Switch: () => h(Switch, { label: "Against a spell", checked: true, onChange: nothing }),
  Checkbox: () => h(Checkbox, { label: "Players see the DC", checked: true, onChange: nothing }),
  Chip: () => h(Chip, { pressed: true, onClick: nothing, children: "Frightened" }),
  RadioCards: () => h(RadioCards<"a" | "b">, { legend: "Map images", value: "a", options: [{ value: "a", label: "Keep" }, { value: "b", label: "Drop", help: "Frees room." }], onChange: nothing }),
  "RadioCards as a radio group": () => h(RadioCards<"a" | "b">, { legend: "Players see", radiogroup: true, value: "a", options: [{ value: "a", label: "All" }, { value: "b", label: "None" }], onChange: nothing }),
  // A disk's color is its content and never dims, so the badge's words carry the look.
  Swatches: () => h(Swatches, { label: "Color", value: "#2e7d32", options: [{ color: "#2e7d32", badge: "DM" }], onChange: nothing }),
  "Section fold": () => h(Section, { label: "Conditions", fold: { open: true, onToggle: nothing }, children: "inside" }),
  TextField: () => h(TextField, { label: "Name", value: "Goblin", onCommit: nothing }),
  NumberField: () => h(NumberField, { label: "Bonus", value: 2, min: -10, max: 20, onCommit: nothing }),
};
const held = (on: boolean, child: ReturnType<typeof h>) => h(Held, { held: on, children: child });
const dim = new RegExp(`color:${tokenPattern(theme.color.textDisabled)}`, "i");
const bright = new RegExp(`color:${tokenPattern(theme.color.text)}[;"]`, "i");

describe("a held group gives every shared control the disabled look (LOCKED-LOOK)", () => {
  for (const [name, draw] of Object.entries(controls)) {
    test(name, () => {
      const free = renderToStaticMarkup(draw());
      const inHeld = renderToStaticMarkup(held(true, draw()));
      assert.doesNotMatch(free, dim, "free, it never draws dim");
      assert.match(inHeld, /^<fieldset disabled=""/);
      assert.match(inHeld, dim, "held, it draws textDisabled");
      // Its own native control is off as well, so a portal or a nested fieldset never leaves look and behavior apart.
      assert.match(inHeld.replace(/^<fieldset disabled=""[^>]*>/, ""), /\sdisabled=""/);
    });
  }

  test("an inner group that is not held stays held inside a held one", () => {
    const markup = renderToStaticMarkup(held(true, held(false, controls.Button())));
    assert.match(markup, dim);
  });

  test("a group that is not held changes nothing", () => {
    const markup = renderToStaticMarkup(held(false, controls.Button()));
    assert.doesNotMatch(markup, dim);
    assert.match(markup, bright);
  });

  test("HeldScope ends it, as Dialog's portal does", () => {
    const markup = renderToStaticMarkup(held(true, h(HeldScope, { children: controls.Button() })));
    assert.doesNotMatch(markup, dim);
  });

  test("an off field's placeholder draws textDisabled, from the one rule an inline style cannot write", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    // One rule, reading the scheme's variable with dark's value for the boot page, before the scheme marks the root.
    const rule = /(^|\n):is\(input, textarea\):is\(:disabled, \[aria-disabled="true"\]\)::placeholder \{\s*color: var\(--rvtt-text-disabled, (#[0-9a-f]{6})\);\s*\}/.exec(css);
    assert.ok(rule, "globals.css dims an off field's placeholder");
    assert.equal(rule[2], PALETTES.dark.textDisabled);
    assert.equal(css.match(/::placeholder \{/g)?.length, 1, "no second rule for the same placeholder");
  });

  test("an off select keeps full strength, where Chrome's own stylesheet fades it to 0.7 (LP29-A-LOOK-1)", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    assert.match(css, /(^|\n)select:disabled \{\s*opacity: 1;\s*\}/, "globals.css undoes the browser's fade on every off select");
  });
});
