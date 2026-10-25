import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { inlineText, parseMarkdown, type Block } from "../../components/markdown.ts";
import { PANELS } from "../panels.ts";
import { guideBody } from "./guide.ts";
import { CONTENTS_ID, EXAMPLES_ID, firstSentence, guideOutline, outlineIds, partOf, type GuideOutline } from "./outline.ts";
import { currentOf } from "./useCurrentSection.ts";

const SOURCE = readFileSync(new URL("../../../docs/dm-guide.md", import.meta.url), "utf8");
const BLOCKS = parseMarkdown(guideBody(SOURCE), { guide: true });
const OUTLINE = guideOutline(BLOCKS);

const guide = { guide: true };
const title = (content: Parameters<typeof inlineText>[0]) => inlineText(content);

/** Every block the outline kept, in the page's order. */
function keptBlocks(o: GuideOutline): Block[] {
  return [...o.intro, ...o.opening.flatMap((s) => s.body), ...o.parts.flatMap((p) => [...p.intro, ...p.sections.flatMap((s) => s.body)])];
}

/** Every heading id the page draws: the parts and sections the outline names, and the subsections inside their bodies. */
function pageIds(o: GuideOutline): Set<string> {
  const inner = keptBlocks(o).flatMap((b) => (b.kind === "heading" && b.id ? [b.id] : []));
  return new Set([CONTENTS_ID, ...outlineIds(o), ...inner]);
}

describe("the guide's outline (outline.ts)", () => {
  test("the guide's parts are numbered in order, each with an introduction the contents can show", () => {
    assert.deepEqual(
      OUTLINE.parts.map((p) => [p.number, title(p.title)]),
      [
        [1, "Making maps"],
        [2, "Running fights"],
        [3, "Deeper tools"],
        [4, "Scenarios"],
        [5, "Reference"],
      ],
    );
    for (const part of OUTLINE.parts) {
      assert.ok(part.summary && /[.!?]$/.test(part.summary), `${part.id}: ${part.summary}`);
      assert.equal(part.examples, part.id === EXAMPLES_ID, part.id);
    }
  });

  test("the opening sections come before the parts and take no number", () => {
    assert.deepEqual(
      OUTLINE.opening.map((s) => [s.id, s.number]),
      [
        ["where-things-are", null],
        ["quick-start", null],
        ["use-what-helps-your-table", null],
      ],
    );
  });

  test("each part's sections are numbered from 1 within the part", () => {
    for (const part of OUTLINE.parts) {
      assert.ok(part.sections.length > 0, part.id);
      assert.deepEqual(
        part.sections.map((s) => s.number),
        part.sections.map((_, i) => `${part.number}.${i + 1}`),
      );
    }
    assert.equal(OUTLINE.parts[1]!.sections.find((s) => s.id === "initiative")?.number, "2.5");
  });

  test("the markdown contents list gives way to the page's own, and nothing else is lost", () => {
    const contents = BLOCKS.findIndex((b) => b.kind === "heading" && b.id === CONTENTS_ID);
    assert.ok(contents > 0);
    assert.equal(BLOCKS[contents + 1]?.kind, "list", "the list right under the contents heading");
    const kept = keptBlocks(OUTLINE);
    assert.ok(!kept.includes(BLOCKS[contents + 1]!), "the markdown list is dropped");
    // Every other block is kept, besides the part and section headings the page draws itself.
    const drawn = new Set([CONTENTS_ID, ...outlineIds(OUTLINE)]);
    const expected = BLOCKS.filter((b, i) => i !== contents + 1 && !(b.kind === "heading" && b.id && drawn.has(b.id)));
    assert.deepEqual(kept, expected);
  });

  test("every Guide link from a panel, and the quick start's, still finds a heading the page draws", () => {
    const ids = pageIds(OUTLINE);
    for (const p of PANELS.filter((p) => p.guide !== undefined)) assert.ok(ids.has(p.guide!), `${p.id}: #${p.guide}`);
    assert.ok(ids.has("quick-start"));
    assert.ok(ids.has("running-turns"), "a subsection keeps its id inside its section's body");
  });

  test("the guide's asides are alerts, so no quote shows a stray [! marker", () => {
    const quotes = keptBlocks(OUTLINE).filter((b) => b.kind === "quote");
    assert.ok(quotes.some((q) => q.kind === "quote" && q.alert === "tip"), "a tip");
    assert.ok(quotes.some((q) => q.kind === "quote" && q.alert === "note"), "a note");
    for (const q of quotes) {
      if (q.kind !== "quote" || q.alert) continue;
      const text = q.blocks.map((b) => (b.kind === "paragraph" ? inlineText(b.content) : "")).join(" ");
      assert.ok(!text.includes("[!"), text);
    }
  });

  test("the guide holds no table, which its page draws as the journal's, one unwrapped line a cell, wider than any phone", () => {
    assert.deepEqual(
      keptBlocks(OUTLINE).flatMap((b) => (b.kind === "table" ? [b.header.map((c) => inlineText(c)).join(" | ")] : [])),
      [],
    );
  });

  test("a part's own subheadings before its first section stay in its introduction", () => {
    const o = guideOutline(parseMarkdown("Intro.\n\n## Contents\n\n- a\n\n## Start\n\nGo.\n\n# Part\n\nFirst. Second.\n\n### Aside\n\nText.\n\n## One\n\n### Sub\n\nBody.", guide));
    assert.deepEqual(o.intro.map((b) => b.kind), ["paragraph"]);
    assert.deepEqual(o.opening.map((s) => [s.id, s.body.length]), [["start", 1]]);
    assert.deepEqual(o.parts[0]!.intro.map((b) => b.kind), ["paragraph", "heading", "paragraph"]);
    assert.equal(o.parts[0]!.summary, "First.");
    assert.deepEqual(o.parts[0]!.sections.map((s) => [s.id, s.number, s.body.map((b) => b.kind)]), [["one", "1.1", ["heading", "paragraph"]]]);
  });

  test("a heading named Contents inside a part is an ordinary section", () => {
    const o = guideOutline(parseMarkdown("# Part\n\n## Contents\n\nText.", guide));
    assert.deepEqual(o.parts[0]!.sections.map((s) => s.id), ["contents"]);
  });

  test("partOf finds the part of a section or of the part itself, and none for an opening section", () => {
    assert.equal(partOf(OUTLINE, "initiative")?.id, "running-fights");
    assert.equal(partOf(OUTLINE, "running-fights")?.id, "running-fights");
    assert.equal(partOf(OUTLINE, "quick-start"), null);
    assert.equal(partOf(OUTLINE, null), null);
  });

  test("a part's description is its intro's first sentence, as plain text", () => {
    const first = (md: string) => firstSentence(parseMarkdown(md, guide));
    assert.equal(first("One **bold** thing. Two."), "One bold thing.");
    assert.equal(first("SRD 5.2.1 has them. More."), "SRD 5.2.1 has them.");
    assert.equal(first("Is it? Yes."), "Is it?");
    assert.equal(first("No stop at the end"), "No stop at the end");
    assert.equal(first("- a list first\n\nThen a paragraph. Two."), "Then a paragraph.");
    assert.equal(first("- only a list"), null);
  });
});

describe("the place being read (useCurrentSection's rule)", () => {
  const ids = ["a", "b", "c", "d"];
  const at = (tops: Record<string, number | null>) => (id: string) => tops[id] ?? null;

  test("none above the first heading, then the last heading past a third of the window", () => {
    assert.equal(currentOf(ids, at({ a: 400, b: 900, c: 1400, d: 1900 }), 900, false), null);
    assert.equal(currentOf(ids, at({ a: -500, b: 120, c: 700, d: 1200 }), 900, false), "b");
    assert.equal(currentOf(ids, at({ a: -900, b: -400, c: 200, d: 800 }), 900, false), "c");
    // On a short window the line is a third of its height: 200 px of 600.
    assert.equal(currentOf(ids, at({ a: -10, b: 190, c: 210, d: 800 }), 600, false), "b");
  });

  test("the line stops 240 px down on a tall window", () => {
    assert.equal(currentOf(ids, at({ a: 100, b: 250, c: 900, d: 1500 }), 1500, false), "a");
  });

  test("a heading that is not drawn is passed over", () => {
    assert.equal(currentOf(ids, at({ a: -100, b: null, c: 100, d: 900 }), 900, false), "c");
  });

  test("at the page's foot the last heading in view wins, though it never reached the line", () => {
    assert.equal(currentOf(ids, at({ a: -2000, b: -300, c: 500, d: 820 }), 900, true), "d");
    assert.equal(currentOf(ids, at({ a: -2000, b: -300, c: 500, d: 950 }), 900, true), "c");
  });
});
