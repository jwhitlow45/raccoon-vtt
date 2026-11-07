import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Group, Section } = await import("./Panel.tsx");
const { Switch } = await import("./Switch.tsx");
const { Checkbox } = await import("./Checkbox.tsx");
const { Segmented } = await import("./Segmented.tsx");
const { RadioCards } = await import("./RadioCards.tsx");
const { Button } = await import("./Button.tsx");
const { Field, FieldRow, Input, Select, TextArea } = await import("./Field.tsx");
const ui = await import("../features/tokens/ui.tsx");

/*
 * The room search's anchors (designs/qol/search.md 5.10): each control of
 * the kit takes an optional `search` id and draws it as `data-search` on
 * the element the route lands on (features/search/route.ts landOn), never
 * as an attribute of its own, and draws none without it.
 */

const ID = "menu.test.control";

/** The opening tag that carries the anchor, which must be the only one. */
function anchored(markup: string): string {
  const tags = [...markup.matchAll(/<[a-z0-9]+\b[^>]*\bdata-search="([^"]*)"[^>]*>/g)];
  assert.equal(tags.length, 1, markup);
  assert.equal(tags[0]![1], ID);
  assert.doesNotMatch(markup, /\ssearch="/, "the prop never reaches the page as an attribute of its own");
  return tags[0]![0];
}

const draw = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

describe("the kit's anchors for the room search", () => {
  test("a folding group: on its header's heading, which holds the fold, and takes no focus of its own", () => {
    const markup = draw(createElement(Group, { label: "Sounds", open: false, onToggle: noop, search: ID }, "inside"));
    const tag = anchored(markup);
    assert.match(tag, /^<h3/);
    assert.doesNotMatch(tag, /tabindex/);
    assert.match(markup, /data-search="[^"]*"[^>]*><button[^>]*aria-expanded="false"/, "the fold is the heading's control, which the search focuses");
  });

  test("a group that never folds: its heading takes focus from script", () => {
    const tag = anchored(draw(createElement(Group, { label: "Join requests", search: ID }, "inside")));
    assert.match(tag, /^<h3[^>]*tabindex="-1"/);
  });

  test("a section: on its label's heading, its fold's or one that takes focus from script", () => {
    const folded = draw(createElement(Section, { label: "Up next", fold: { open: false, onToggle: noop }, search: ID, children: "inside" }));
    assert.match(anchored(folded), /^<h3/);
    assert.match(folded, /data-search="[^"]*"[^>]*><button[^>]*aria-expanded/);
    const plain = anchored(draw(createElement(Section, { label: "Combat", search: ID, children: "inside" })));
    assert.match(plain, /^<h3[^>]*tabindex="-1"/);
    const withAction = anchored(draw(createElement(Section, { label: "Combat", action: createElement("span", null, "act"), search: ID, children: "inside" })));
    assert.match(withAction, /^<h3[^>]*tabindex="-1"/);
  });

  test("a switch: on its own button", () => {
    assert.match(anchored(draw(createElement(Switch, { label: "Turn sound", checked: false, onChange: noop, search: ID }))), /^<button[^>]*role="switch"/);
  });

  test("a checkbox: on its whole row, which holds the box", () => {
    const markup = draw(createElement(Checkbox, { label: "Include sounds", checked: true, onChange: noop, search: ID }));
    assert.match(anchored(markup), /^<label/);
    assert.match(markup, /data-search="[^"]*"[^>]*>(?:(?!<\/label>).)*<input[^>]*type="checkbox"/);
  });

  test("a choice: on its radio group", () => {
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    assert.match(anchored(draw(createElement(Segmented, { label: "Theme", value: "a", options, onChange: noop, search: ID }))), /^<div[^>]*role="radiogroup"/);
    assert.match(anchored(draw(createElement(Segmented, { label: "Theme", value: "a", options, even: true, description: "why", onChange: noop, search: ID }))), /^<div[^>]*role="radiogroup"/);
  });

  test("cards: on their fieldset, or their radio group", () => {
    const options = [
      { value: "a", label: "A", help: "first" },
      { value: "b", label: "B" },
    ];
    assert.match(anchored(draw(createElement(RadioCards, { legend: "Map images", value: "a", options, onChange: noop, search: ID }))), /^<fieldset/);
    assert.match(anchored(draw(createElement(RadioCards, { legend: "Show to", value: "a", options, radiogroup: true, onChange: noop, search: ID }))), /^<div[^>]*role="radiogroup"/);
  });

  test("a button: on the button, an icon alone included", () => {
    assert.match(anchored(draw(createElement(Button, { search: ID }, "Add a TV"))), /^<button/);
    assert.match(anchored(draw(createElement(Button, { search: ID, icon: "more", iconOnly: "always", "aria-label": "More" }))), /^<button/);
  });

  test("fields: on the control, or a labeled field's and a row's whole box", () => {
    assert.match(anchored(draw(createElement(Input, { search: ID, "aria-label": "Room name" }))), /^<input/);
    assert.match(anchored(draw(createElement(Select, { search: ID, "aria-label": "Handle" }, createElement("option", { value: "a" }, "A")))), /^<select/);
    assert.match(anchored(draw(createElement(TextArea, { search: ID, "aria-label": "Notes" }))), /^<textarea/);
    const field = draw(createElement(Field, { label: "New player password", search: ID }));
    assert.match(anchored(field), /^<div/);
    assert.match(field, /data-search="[^"]*"[^>]*><label[^>]*>New player password<\/label><div[^>]*><input/);
    assert.match(anchored(draw(createElement(FieldRow, { label: "Speed", search: ID, children: createElement("input") }))), /^<div/);
  });

  test("the token panel's fields: on the input or the select", () => {
    assert.match(anchored(draw(createElement(ui.TextField, { label: "Name", value: "", onCommit: noop, search: ID }))), /^<input/);
    assert.match(anchored(draw(createElement(ui.TextField, { label: "Notes", value: "", multiline: true, onCommit: noop, search: ID }))), /^<textarea/);
    assert.match(anchored(draw(createElement(ui.NumberField, { label: "AC", value: 15, min: 0, max: 99, onCommit: noop, search: ID }))), /^<input/);
    assert.match(anchored(draw(createElement(ui.Select, { label: "Size", value: "m", options: [{ value: "m", label: "Medium" }], onChange: noop, search: ID }))), /^<select/);
  });

  test("without an id, none of them draws an anchor", () => {
    const markup = [
      draw(createElement(Group, { label: "Sounds", open: true, onToggle: noop }, "inside")),
      draw(createElement(Group, { label: "Join requests" }, "inside")),
      draw(createElement(Section, { label: "Combat", children: "inside" })),
      draw(createElement(Switch, { label: "Turn sound", checked: false, onChange: noop })),
      draw(createElement(Checkbox, { label: "Include sounds", checked: true, onChange: noop })),
      draw(createElement(Button, null, "Add a TV")),
      draw(createElement(Field, { label: "Password" })),
      draw(createElement(ui.NumberField, { label: "AC", value: 15, min: 0, max: 99, onCommit: noop })),
    ].join("");
    assert.doesNotMatch(markup, /search=/);
    assert.doesNotMatch(markup, /<h3[^>]*tabindex/, "a heading takes focus from script only as an anchor");
  });
});
