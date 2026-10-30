import "./testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ProficiencyLabel } = await import("./ProficiencyMark.tsx");

test("fl7: each proficiency marker has its own glyph and accessible name", () => {
  for (const [level, name, circles] of [["none", null, 0], ["prof", "Proficient", 1], ["expert", "Expertise", 2]] as const) {
    const html = renderToStaticMarkup(createElement(ProficiencyLabel, { level, children: "Sleight of Hand +7" }));
    assert.match(html, new RegExp(`data-proficiency-marker="${level}"`));
    assert.equal((html.match(/<circle /g) ?? []).length, circles);
    assert.match(html, /white-space:nowrap/);
    assert.match(html, /align-items:center/);
    assert.match(html, /width:1em;height:1em/);
    assert.match(html, /data-proficiency-name=""/);
    if (name) {
      assert.match(html, new RegExp(`aria-label="${name}"`));
      assert.match(html, new RegExp(`title="${name}"`));
    } else assert.doesNotMatch(html, /role="img"|title=|aria-label=/);
  }
});
