import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { GROUP_BOX, GROUP_FOLD, Group, Section } = await import("./Panel.tsx");

/** A panel's groups (docs/design-v1-dice-ui.md 3.2, docs/design-v1-token-panel-groups.md 4), as markup. */
describe("Group", () => {
  test("its name is an h3 holding the disclosure, which says open or folded in aria-expanded and is named by the name alone", () => {
    const folded = renderToStaticMarkup(createElement(Group, { label: "Combat", open: false, onToggle: () => {}, summary: "HP 3/7 · 2 conditions" }, "inside"));
    assert.match(folded, /<h3[^>]*><button[^>]*aria-labelledby="([^"]+)"[^>]*aria-expanded="false"/);
    assert.match(folded, /aria-describedby="[^"]+-summary"/, "the summary describes it");
    assert.match(folded, />HP 3\/7 · 2 conditions</);
    assert.doesNotMatch(folded, /inside/, "folded, its content is not drawn");
    const open = renderToStaticMarkup(createElement(Group, { label: "Combat", open: true, onToggle: () => {}, summary: "HP 3/7" }, "inside"));
    assert.match(open, /aria-expanded="true"/);
    assert.doesNotMatch(open, />HP 3\/7</, "open, it shows no summary");
    assert.match(open, /inside/);
  });

  test("it is no landmark: no section, no region, no accessible name on its box", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Notes", open: true, onToggle: () => {} }, "inside"));
    assert.doesNotMatch(markup, /<section/);
    assert.doesNotMatch(markup, /role="region"/);
  });

  test("a group that never folds draws its name with no disclosure", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Stat block" }, "block"));
    assert.match(markup, /<h3[^>]*><span[^>]*><span[^>]*>Stat block<\/span>/);
    assert.doesNotMatch(markup, /aria-expanded/);
    assert.doesNotMatch(markup, /data-group-fold/, "and no fold to hand focus to");
  });

  test("code inside a group finds its box and its fold by GROUP_BOX and GROUP_FOLD, since the box is no section", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Token settings", open: true, onToggle: () => {} }, createElement(Section, { label: "Make a companion", children: "form" })));
    assert.equal(GROUP_BOX, "[data-panel-group]");
    assert.equal(GROUP_FOLD, "[data-group-fold]");
    assert.match(markup, /^<div data-panel-group=""/, "the group's own box");
    assert.match(markup, /<h3[^>]*><button[^>]*data-group-fold=""[^>]*aria-expanded="true"/, "its fold, in its heading");
    assert.equal(markup.match(/data-group-fold/g)?.length, 1, "one fold: a section's label inside is not one");
  });

  test("the sections inside part by 16 px with no bottom padding of their own, their labels a level under the group's (h4)", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Group,
        { label: "Combat", open: true, onToggle: () => {}, holds: "sections" },
        createElement(Section, { key: "a", label: "Hit points", children: "hp" }),
        createElement(Section, { key: "b", label: "Conditions", children: "conditions" }),
      ),
    );
    assert.match(markup, /gap:16px/, "the body parts its sections by space(4)");
    assert.match(markup, /<h4[^>]*>Hit points<\/h4>/);
    assert.match(markup, /<h4[^>]*>Conditions<\/h4>/);
    const sections = markup.match(/<section style="[^"]*"/g) ?? [];
    assert.equal(sections.length, 2);
    for (const s of sections) {
      assert.match(s, /padding-bottom:0/, "no bottom padding inside a group");
      assert.doesNotMatch(s, /border-top/, "no line between them");
    }
  });

  test("a group of fields keeps a section's 8 px between them, and a section outside any group keeps its h3, line and padding", () => {
    const rows = renderToStaticMarkup(createElement(Group, { label: "Stats", open: true, onToggle: () => {} }, "a", "b"));
    assert.match(rows, /gap:8px/);
    const alone = renderToStaticMarkup(createElement(Section, { label: "Sight", children: "sight" }));
    assert.match(alone, /<h3[^>]*>Sight<\/h3>/);
    assert.match(alone, /padding-bottom:16px/);
    assert.match(alone, /border-top/);
  });
});
