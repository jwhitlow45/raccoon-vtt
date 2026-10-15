import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { RULES_TEXT } from "#shared/srd/rules-text.ts";
import { inlineText, parseInline, parseMarkdown, safeLinkHref, type Block } from "./markdown.ts";

const MONSTERS = JSON.parse(readFileSync(new URL("../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];

describe("inline Markdown", () => {
  test("bold, italic and plain text", () => {
    assert.deepEqual(parseInline("**AC** 15 *Small Fey*"), [
      { kind: "bold", children: [{ kind: "text", text: "AC" }] },
      { kind: "text", text: " 15 " },
      { kind: "italic", children: [{ kind: "text", text: "Small Fey" }] },
    ]);
  });

  test("escapes are literal", () => {
    assert.deepEqual(parseInline("2 \\* 3 \\_x\\_ \\` \\\\"), [{ kind: "text", text: "2 * 3 _x_ ` \\" }]);
    assert.deepEqual(parseInline("a \\n b"), [{ kind: "text", text: "a \\n b" }]);
  });

  test("italic inside bold", () => {
    assert.deepEqual(parseInline("**Hit: *5* damage**"), [
      {
        kind: "bold",
        children: [
          { kind: "text", text: "Hit: " },
          { kind: "italic", children: [{ kind: "text", text: "5" }] },
          { kind: "text", text: " damage" },
        ],
      },
    ]);
  });

  test("an unclosed marker stays as asterisks, so nothing is lost", () => {
    assert.equal(inlineText(parseInline("a *b")), "a *b");
    assert.equal(inlineText(parseInline("**a")), "**a");
    assert.equal(inlineText(parseInline("x ** y")), "x ** y");
  });
});

describe("block Markdown", () => {
  test("a whole stat block", () => {
    const goblin = MONSTERS.find((m) => m.srdId === "goblin-warrior")!;
    const blocks = parseMarkdown(goblin.statBlock);
    assert.equal(blocks[0]?.kind, "heading");
    assert.equal(blocks[0]?.kind === "heading" && inlineText(blocks[0].content), "Goblin Warrior");
    const table = blocks.find((b) => b.kind === "table");
    assert.ok(table && table.kind === "table");
    assert.deepEqual(table.header.map(inlineText), ["", "Score", "Mod", "Save"]);
    assert.equal(table.rows.length, 6);
    assert.deepEqual(table.rows[1]!.map(inlineText), ["Dex", "15", "+2", "+2"]);
    const sections = blocks.filter((b) => b.kind === "heading" && b.level === 3).map((b) => b.kind === "heading" && inlineText(b.content));
    assert.deepEqual(sections, ["Actions", "Bonus Actions"]);
  });

  test("lists in a spellcasting block", () => {
    const dragon = MONSTERS.find((m) => m.srdId === "adult-red-dragon")!;
    const list = parseMarkdown(dragon.statBlock).find((b) => b.kind === "list");
    assert.ok(list && list.kind === "list");
    assert.equal(list.items.length, 2);
    assert.match(inlineText(list.items[0]!), /^At Will: Command/);
  });

  test("paragraph lines join, blank lines split", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    assert.deepEqual(
      blocks.map((b) => b.kind === "paragraph" && inlineText(b.content)),
      ["one two", "three"],
    );
  });

  test("every SRD text parses without losing a word", () => {
    const texts = [...MONSTERS.map((m) => m.statBlock), ...Object.values(RULES_TEXT.conditions).map((r) => r.text)];
    for (const text of texts) {
      const rendered = parseMarkdown(text)
        .flatMap((b) =>
          b.kind === "table"
            ? [...b.header, ...b.rows.flat()].map(inlineText)
            : b.kind === "list"
              ? b.items.map(inlineText)
              : b.kind === "quote"
                ? []
                : [inlineText(b.content)],
        )
        .join(" ");
      const words = (s: string) => s.replace(/[*|#\-\\]/g, " ").split(/\s+/).filter(Boolean);
      assert.deepEqual(words(rendered), words(text));
    }
  });
});

describe("journal Markdown", () => {
  const journal = { journal: true };
  const text = (blocks: Block[]) => blocks.map((b) => (b.kind === "paragraph" || b.kind === "heading" ? inlineText(b.content) : b.kind));

  test("stat blocks are unchanged: no breaks, no numbered lists, no quotes, no links, no single # heading", () => {
    const md = "one\ntwo\n\n1. first\n\n> said\n\n# Title\n\n[a](https://example.com/)";
    assert.deepEqual(text(parseMarkdown(md)), ["one two", "1. first", "> said", "# Title", "[a](https://example.com/)"]);
  });

  test("a single line break stays a break inside the paragraph", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree", journal);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { kind: "paragraph", content: [{ kind: "text", text: "one" }, { kind: "break" }, { kind: "text", text: "two" }] });
  });

  test("bold carries across a line break", () => {
    const [p] = parseMarkdown("**one\ntwo**", journal);
    assert.deepEqual(p, { kind: "paragraph", content: [{ kind: "bold", children: [{ kind: "text", text: "one" }, { kind: "break" }, { kind: "text", text: "two" }] }] });
  });

  test("numbered lists keep their first number, and a bulleted list after one is a list of its own", () => {
    const blocks = parseMarkdown("3. three\n4) four\n- dash", journal);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0]?.kind === "list" && blocks[0].start === 3);
    assert.deepEqual(blocks[0]?.kind === "list" && blocks[0].items.map(inlineText), ["three", "four"]);
    assert.ok(blocks[1]?.kind === "list" && blocks[1].start === undefined);
  });

  test("a quote holds blocks of its own, and nesting stops at three", () => {
    const [q] = parseMarkdown("> **Warning**\n> - a list\n>\n> more", journal);
    assert.ok(q?.kind === "quote");
    assert.deepEqual(q.blocks.map((b) => b.kind), ["paragraph", "list", "paragraph"]);
    let deep: Block | undefined = parseMarkdown(">>>>> deep", journal)[0];
    let depth = 0;
    while (deep?.kind === "quote") {
      depth++;
      deep = deep.blocks[0];
    }
    assert.equal(depth, 3);
    assert.ok(deep?.kind === "paragraph" && inlineText(deep.content) === ">> deep");
  });

  test("one # is a heading of its own level", () => {
    const blocks = parseMarkdown("# Old map\n## Rooms", journal);
    assert.deepEqual(
      blocks.map((b) => b.kind === "heading" && b.level),
      [1, 2],
    );
  });

  test("an https link becomes a link, with emphasis inside it", () => {
    assert.deepEqual(parseInline("see [the **old** map](https://example.com/map?a=1) now", journal), [
      { kind: "text", text: "see " },
      { kind: "link", href: "https://example.com/map?a=1", children: [{ kind: "text", text: "the " }, { kind: "bold", children: [{ kind: "text", text: "old" }] }, { kind: "text", text: " map" }] },
      { kind: "text", text: " now" },
    ]);
  });

  test("an http, javascript or data link stays as its text", () => {
    for (const href of ["http://example.com/", "javascript:alert(1)", "data:text/html,x", "HTTPS:/x", "//example.com"]) {
      const md = `[click](${href})`;
      assert.deepEqual(parseInline(md, journal), [{ kind: "text", text: md }], href);
    }
  });

  test("the address must be a valid https URL with a host", () => {
    assert.equal(safeLinkHref("https://example.com/a b"), "https://example.com/a%20b");
    assert.equal(safeLinkHref("https://"), null);
    assert.equal(safeLinkHref("http://example.com/"), null);
    assert.equal(safeLinkHref("javascript:alert(1)"), null);
  });

  test("escapes keep brackets, a # and a link literal", () => {
    assert.deepEqual(parseInline("\\[not](https://example.com/)", journal), [{ kind: "text", text: "[not](https://example.com/)" }]);
    assert.deepEqual(parseInline("\\[not\\](https://example.com/)", journal), [{ kind: "text", text: "[not](https://example.com/)" }]);
    assert.deepEqual(parseMarkdown("\\# not a heading", journal).map((b) => b.kind === "paragraph" && inlineText(b.content)), ["# not a heading"]);
  });
});
