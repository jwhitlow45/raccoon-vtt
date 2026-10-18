import "./testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { RULES_TEXT } from "#shared/srd/rules-text.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Markdown } = await import("./Markdown.tsx");

const MONSTERS = JSON.parse(readFileSync(new URL("../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];

/**
 * A stat block and a journal page that use every block and inline kind,
 * with the markup the renderer drew for them before the guide got a look
 * of its own. The guide's look sits behind `guide`, so these stay
 * identical.
 */
const GOLDEN = JSON.parse(readFileSync(new URL("markdown.golden.json", import.meta.url), "utf8")) as { name: string; text: string; journal: boolean; html: string }[];

const html = (props: Parameters<typeof Markdown>[0]) => renderToStaticMarkup(createElement(Markdown, props));

/** What only the guide's look draws: steps, keycaps, figures and callouts. */
const GUIDE_ONLY = ['role="list"', "<kbd", "<figure", 'role="note"'];

describe("the Markdown renderer", () => {
  test("a stat block and a journal page render exactly as before the guide's look", () => {
    assert.equal(GOLDEN.length, 2);
    for (const c of GOLDEN) {
      // If a change to them is meant, the golden file takes the new markup.
      assert.equal(html({ text: c.text, journal: c.journal }), c.html, c.name);
    }
  });

  test("no SRD stat block or rules text draws any of the guide's look", () => {
    const texts = [...MONSTERS.map((m) => m.statBlock), ...Object.values(RULES_TEXT.conditions).map((r) => r.text)];
    for (const text of texts) {
      const markup = html({ text });
      for (const mark of GUIDE_ONLY) assert.ok(!markup.includes(mark), mark);
    }
  });

  test("the guide draws numbered lists as steps that keep their numbers and list role", () => {
    const markup = html({ text: "3. Pick **Fog**.\n4. Press `F`.", guide: true });
    assert.match(markup, /<ol role="list" start="3"/);
    assert.deepEqual([...markup.matchAll(/<span style="width:26px;[^"]*">(\d+)<\/span>/g)].map((m) => m[1]), ["3", "4"]);
    // The line between the discs is decoration.
    assert.equal([...markup.matchAll(/<span aria-hidden="true" style="position:absolute/g)].length, 1);
  });

  test("the guide draws keys as keycaps, a chord as keys inside one key, and other code as code", () => {
    const markup = html({ text: "Press `N`, `Ctrl+Shift+Z` or type `goblin`.", guide: true });
    assert.match(markup, /<kbd style="[^"]*">N<\/kbd>/);
    assert.match(markup, /<kbd style="font-family:inherit;white-space:nowrap"><span><kbd [^>]*>Ctrl<\/kbd><\/span><span>\+<kbd [^>]*>Shift<\/kbd><\/span><span>\+<kbd [^>]*>Z<\/kbd><\/span><\/kbd>/);
    assert.match(markup, /<code [^>]*>goblin<\/code>/);
  });

  test("the guide frames a known image as a figure with its size and a caption for the eye", () => {
    const image = (src: string) => (src === "dm-guide/fog.webp" ? { url: "/assets/fog-1.webp", width: 1280, height: 800 } : null);
    const markup = html({ text: "![The Fog tool.](dm-guide/fog.webp)\n\n![Unknown.](dm-guide/nope.webp)", guide: true, image });
    assert.match(markup, /<figure /);
    assert.match(markup, /<img src="\/assets\/fog-1.webp" alt="The Fog tool." width="1280" height="800" loading="lazy"/);
    assert.match(markup, /<figcaption aria-hidden="true"[^>]*>The Fog tool.<\/figcaption>/);
    assert.ok(!markup.includes("Unknown."), "an image the page does not know is left out");
  });

  test("the guide draws an alert as a labelled note, and a bold line alone as a label", () => {
    const markup = html({ text: "> [!TIP]\n> Undo takes it back.\n\n> [!NOTE]\n> Hidden means two things.\n\n**Building it**\n\n**Bold** then text.", guide: true });
    const notes = [...markup.matchAll(/<div role="note"[^>]*><p [^>]*>(\w+)<\/p><p [^>]*>([^<]*)<\/p><\/div>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(notes, [
      ["Tip", "Undo takes it back."],
      ["Note", "Hidden means two things."],
    ]);
    assert.match(markup, /<p style="[^"]*text-transform:uppercase[^"]*">Building it<\/p>/);
    assert.match(markup, /<p style="[^"]*max-width:34em[^"]*"><strong>Bold<\/strong> then text.<\/p>/);
  });
});
