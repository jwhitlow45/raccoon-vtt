import "./testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MarkedText, ProficiencyLabel, spokenProficiency, spokenText } = await import("./ProficiencyMark.tsx");

/* The mark is a zero-width underline under a test's name (D-261030-436). */

test("fl7: proficient is a dotted underline, expertise a double one, both in the text's own color and named", () => {
  for (const [level, style, word] of [["prof", "dotted", "Proficient"], ["expert", "double", "Expertise"]] as const) {
    const html = renderToStaticMarkup(createElement(ProficiencyLabel, { level, children: "Perception" }));
    assert.match(html, new RegExp(`^<span data-proficiency-label="" data-proficiency-level="${level}" title="${word}" style="text-decoration-line:underline;text-decoration-style:${style};`));
    assert.doesNotMatch(html, /text-decoration-color|color:|width:[^1]|padding|margin|display/, "no color of its own, and nothing that takes room");
    assert.match(html, new RegExp(`>Perception<span data-proficiency-marker="${level}" role="img" aria-label="${word}" style="position:absolute;width:1px;height:1px;overflow:hidden`));
    assert.equal(html.replace(/<[^>]*>/g, ""), "Perception", "the words are unchanged");
  }
});

test("fl7: neither keeps a bare span with no mark, no tooltip and no name", () => {
  assert.equal(renderToStaticMarkup(createElement(ProficiencyLabel, { level: "none", children: "Perception" })), '<span data-proficiency-label="" data-proficiency-level="none">Perception</span>');
});

test("fl7: marked text keeps its words, and its spoken form names each level after its test", () => {
  const text = "Pat rolled 19 for Thorn, Perception check.";
  const marks = [{ at: 25, length: 16, level: "expert" as const }];
  assert.equal(renderToStaticMarkup(createElement(MarkedText, { text, marks })).replace(/<[^>]*>/g, ""), text);
  assert.equal(spokenText(text, marks), "Pat rolled 19 for Thorn, Perception check, expertise.");
  assert.equal(spokenText(text, [{ at: 25, length: 10, level: "none" }]), text);
  assert.deepEqual([spokenProficiency("prof"), spokenProficiency("expert"), spokenProficiency("none")], [", proficient", ", expertise", ""]);
});
