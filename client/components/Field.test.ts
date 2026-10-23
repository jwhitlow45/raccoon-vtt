import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { FieldRow, Input, RowHintScope } = await import("./Field.tsx");
const { NumberField, Stepper, TextField } = await import("../features/tokens/ui.tsx");

const html = renderToStaticMarkup;

/** Each `<input>` in some markup, with its attributes. */
function inputs(markup: string): string[] {
  return [...markup.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
}

function describedBy(tag: string | undefined): string | undefined {
  return tag ? /aria-describedby="([^"]+)"/.exec(tag)?.[1] : undefined;
}

/** An id from useId, safe inside a RegExp. */
function re(id: string | undefined): string {
  return (id ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("FieldRow", () => {
  test("the hint runs under the row, outside the label, and describes a control that names itself", () => {
    const markup = html(createElement(FieldRow, { label: "Level", hint: "Sets the Proficiency Bonus too.", children: createElement(Input, { "aria-label": "Character level" }) }));
    assert.match(markup, /<label[^>]*>Level<\/label>/, "the label holds its name alone");
    const ids = describedBy(inputs(markup)[0]);
    assert.ok(ids, "the control has no description");
    assert.match(markup, new RegExp(`<div id="${re(ids)}"[^>]*flex-basis:100%[^>]*>Sets the Proficiency Bonus too\\.</div>`));
  });

  test("a row named through htmlFor keeps the label as the name and the hint as the description", () => {
    const markup = html(createElement(FieldRow, { label: "Name on the map", htmlFor: "kit-label", hint: "Up to 40 letters.", children: createElement(Input, { id: "kit-label" }) }));
    assert.match(markup, /<label for="kit-label"[^>]*>Name on the map<\/label>/);
    const ids = describedBy(inputs(markup)[0]);
    assert.match(markup, new RegExp(`id="${re(ids)}"[^>]*>Up to 40 letters\\.<`));
  });

  test("a control's own description comes first, then the row's hint", () => {
    const markup = html(createElement(FieldRow, { label: "AC", hint: "Optional", children: createElement(Input, { "aria-label": "AC", "aria-describedby": "why-off" }) }));
    const ids = describedBy(inputs(markup)[0])?.split(" ");
    assert.equal(ids?.length, 2);
    assert.equal(ids?.[0], "why-off");
  });

  test("a row with no hint describes nothing", () => {
    const markup = html(createElement(FieldRow, { label: "HP", children: createElement(Input, { "aria-label": "HP" }) }));
    assert.equal(describedBy(inputs(markup)[0]), undefined);
    assert.doesNotMatch(markup, /flex-basis/);
  });

  test("the token panel's text, number and stepper fields read the hint, and a stepper's buttons do not", () => {
    const controls = [
      ["TextField", createElement(TextField, { label: "Name players see", value: "", onCommit() {} })],
      ["NumberField", createElement(NumberField, { label: "Height", value: undefined, min: 0, max: 100, onCommit() {} })],
      ["Stepper", createElement(Stepper, { label: "Elevation", value: 0, step: 5, min: -100, max: 100, onChange() {} })],
    ] as const;
    for (const [name, control] of controls) {
      const markup = html(createElement(FieldRow, { label: "Some row", hint: "A hint.", children: control }));
      const ids = describedBy(inputs(markup)[0]);
      assert.ok(ids, `${name} has no description`);
      assert.match(markup, new RegExp(`id="${re(ids)}"[^>]*>A hint\\.<`));
      assert.doesNotMatch(markup, /<button[^>]*aria-describedby/, `${name}'s buttons are described`);
    }
  });

  /*
   * A row wraps only where its label and its controls do not fit
   * (docs/design-v1-polish.md R2): the controls ask for their own width up
   * to 160 px, and the label for 110 px or 40% of the row, so "DC" and a
   * 96 px field share a line too narrow for 110 and 160. The caps keep what
   * a text field and its label ask where it was, and the inner box's least
   * width of the whole cell lets a stretching field fill it as it did.
   */
  test("the controls take their own width up to 160 px as their basis, the label 110 px or 40%, and the controls fill their cell", () => {
    const markup = html(createElement(FieldRow, { label: "DC", children: createElement(Input, { "aria-label": "Save DC", type: "number" }) }));
    assert.match(markup, /<label[^>]*flex:1 1 min\(110px, 40%\)/);
    const cell = /<\/label><div style="([^"]*)"><div style="([^"]*)"><input/.exec(markup);
    assert.ok(cell, "the controls are not a cell holding one inner box");
    assert.match(cell[1]!, /(^|;)flex:1 1 auto(;|$)/);
    assert.match(cell[1]!, /min-width:0/);
    assert.match(cell[2]!, /min-width:100%/);
    assert.match(cell[2]!, /max-width:160px/);
    assert.match(cell[2]!, /justify-content:flex-end/);
  });

  test("a dialog's scope ends the hint, so a picker a row opens is not described by it", () => {
    const markup = html(createElement(FieldRow, { label: "Image", hint: "They differ.", children: createElement(RowHintScope, { children: createElement(Input, { "aria-label": "Image address" }) }) }));
    assert.equal(describedBy(inputs(markup)[0]), undefined);
  });
});
