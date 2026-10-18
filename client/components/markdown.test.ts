import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { RULES_TEXT } from "#shared/srd/rules-text.ts";
import { headingSlug, inlineText, keyChord, parseInline, parseMarkdown, safeLinkHref, type Block, type MarkdownOptions } from "./markdown.ts";

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
              : b.kind === "quote" || b.kind === "image"
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

describe("the DM guide's Markdown (docs/dm-guide.md)", () => {
  const guide = { guide: true };

  test("headings get GitHub's ids, numbered when one repeats", () => {
    const blocks = parseMarkdown("# Running fights\n## HP, damage and conditions\n### Ping, Look here and pins\n## Areas\n## Areas", guide);
    assert.deepEqual(
      blocks.map((b) => b.kind === "heading" && b.id),
      ["running-fights", "hp-damage-and-conditions", "ping-look-here-and-pins", "areas", "areas-1"],
    );
    assert.equal(headingSlug("What you can ignore at first", new Map()), "what-you-can-ignore-at-first");
    assert.equal(headingSlug("Map phases, imports and exports", new Map()), "map-phases-imports-and-exports");
  });

  test("the journal and the stat blocks keep headings without ids", () => {
    const [journalHeading] = parseMarkdown("## Areas", { journal: true });
    const [srdHeading] = parseMarkdown("## Areas");
    assert.deepEqual(journalHeading, { kind: "heading", level: 2, content: [{ kind: "text", text: "Areas" }] });
    assert.deepEqual(srdHeading, { kind: "heading", level: 2, content: [{ kind: "text", text: "Areas" }] });
  });

  test("code spans keep what they hold, and a lone backtick stays", () => {
    assert.deepEqual(parseInline("Press `Ctrl+Shift+Z` or `?`.", guide), [
      { kind: "text", text: "Press " },
      { kind: "code", text: "Ctrl+Shift+Z" },
      { kind: "text", text: " or " },
      { kind: "code", text: "?" },
      { kind: "text", text: "." },
    ]);
    assert.deepEqual(parseInline("`8d6 *fire*`", guide), [{ kind: "code", text: "8d6 *fire*" }]);
    assert.deepEqual(parseInline("a ` b", guide), [{ kind: "text", text: "a ` b" }]);
    assert.deepEqual(parseInline("``", guide), [{ kind: "text", text: "``" }]);
    // Outside the guide a backtick is text, as before.
    assert.deepEqual(parseInline("`x`", { journal: true }), [{ kind: "text", text: "`x`" }]);
  });

  test("a link to a heading stays a link, and a link to a file keeps only its text", () => {
    assert.deepEqual(parseInline("See [Areas](#areas) and [FEATURES.md](../FEATURES.md).", guide), [
      { kind: "text", text: "See " },
      { kind: "link", href: "#areas", children: [{ kind: "text", text: "Areas" }] },
      { kind: "text", text: " and FEATURES.md." },
    ]);
    assert.deepEqual(parseInline("[the SRD](https://example.com/srd)", guide), [{ kind: "link", href: "https://example.com/srd", children: [{ kind: "text", text: "the SRD" }] }]);
    assert.ok(!JSON.stringify(parseInline("[click](javascript:alert(1))", guide)).includes('"link"'));
    // The journal still takes only https.
    assert.deepEqual(parseInline("[Areas](#areas)", { journal: true }), [{ kind: "text", text: "[Areas](#areas)" }]);
  });

  test("an image alone on its line is an image, with its path as written", () => {
    assert.deepEqual(parseMarkdown("Text.\n![The fog tool.](dm-guide/fog.webp)\nMore.", guide), [
      { kind: "paragraph", content: [{ kind: "text", text: "Text." }] },
      { kind: "image", src: "dm-guide/fog.webp", alt: "The fog tool." },
      { kind: "paragraph", content: [{ kind: "text", text: "More." }] },
    ]);
    // A scheme, a query or text around it leave the line as text.
    for (const line of ["![x](https://example.com/a.webp)", "![x](dm-guide/a.webp?v=1)", "see ![x](dm-guide/a.webp)"]) {
      assert.equal(parseMarkdown(line, guide)[0]!.kind, "paragraph", line);
    }
    assert.equal(parseMarkdown("![x](dm-guide/a.webp)", { journal: true })[0]!.kind, "paragraph");
  });

  test("bullets indented under an item belong to it", () => {
    assert.deepEqual(parseMarkdown("- [Quick start](#quick-start)\n- Making maps\n  - [Scenes](#scenes)\n  - [Fog](#fog)\n- Last", guide), [
      {
        kind: "list",
        items: [
          [{ kind: "link", href: "#quick-start", children: [{ kind: "text", text: "Quick start" }] }],
          [{ kind: "text", text: "Making maps" }],
          [{ kind: "text", text: "Last" }],
        ],
        sub: [[], [[{ kind: "link", href: "#scenes", children: [{ kind: "text", text: "Scenes" }] }], [{ kind: "link", href: "#fog", children: [{ kind: "text", text: "Fog" }] }]], []],
      },
    ]);
    // A list with none has no `sub`, as the journal's lists have none.
    assert.deepEqual(parseMarkdown("- a\n- b", guide), [{ kind: "list", items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] }]);
  });

  test("a quote that opens with [!TIP] or [!NOTE] alone is an alert of that kind, holding the rest", () => {
    assert.deepEqual(parseMarkdown("> [!TIP]\n> Undo takes it **all** back.", guide), [
      { kind: "quote", alert: "tip", blocks: [{ kind: "paragraph", content: [{ kind: "text", text: "Undo takes it " }, { kind: "bold", children: [{ kind: "text", text: "all" }] }, { kind: "text", text: " back." }] }] },
    ]);
    // GitHub reads the marker in any case, and a blank quote line still splits the alert's paragraphs.
    const [note] = parseMarkdown(">  [!note]\n> One.\n>\n> - a list", guide);
    assert.equal(note?.kind === "quote" && note.alert, "note");
    assert.deepEqual(
      note?.kind === "quote" ? note.blocks.map((b) => b.kind) : [],
      ["paragraph", "list"],
    );
  });

  test("anything else stays a plain quote that shows its marker", () => {
    const plain = (md: string, options: MarkdownOptions = guide) => {
      const [q] = parseMarkdown(md, options);
      assert.equal(q?.kind, "quote", md);
      assert.equal(q?.kind === "quote" ? q.alert : "none", undefined, md);
      return q?.kind === "quote" ? q.blocks.map((b) => (b.kind === "paragraph" ? inlineText(b.content) : b.kind)) : [];
    };
    // GitHub's other kinds, which the guide does not use.
    assert.deepEqual(plain("> [!WARNING]\n> Careful."), ["[!WARNING] Careful."]);
    // The marker with text on its line, or with nothing after it.
    assert.deepEqual(plain("> [!TIP] Inline."), ["[!TIP] Inline."]);
    assert.deepEqual(plain("> [!TIP]\n>"), ["[!TIP]"]);
    // A journal page never has alerts.
    assert.deepEqual(plain("> [!TIP]\n> Text.", { journal: true }), ["[!TIP] Text."]);
    // Nor does a quote inside a quote, as on GitHub.
    const [outer] = parseMarkdown("> > [!NOTE]\n> > Inner.", guide);
    const inner = outer?.kind === "quote" ? outer.blocks[0] : undefined;
    assert.equal(outer?.kind === "quote" && outer.alert, undefined);
    assert.equal(inner?.kind, "quote");
    assert.equal(inner?.kind === "quote" ? inner.alert : "none", undefined);
  });

  test("the stat blocks read no quotes at all, alerts included", () => {
    assert.deepEqual(parseMarkdown("> [!TIP]\n> Text."), [{ kind: "paragraph", content: [{ kind: "text", text: "> [!TIP] > Text." }] }]);
  });

  test("a code span names keys when it is one character, a key's name or a chord", () => {
    for (const [code, keys] of [
      ["N", ["N"]],
      ["?", ["?"]],
      ["/", ["/"]],
      ["0", ["0"]],
      ["+", ["+"]],
      ["-", ["-"]],
      ["Escape", ["Escape"]],
      ["Page Up", ["Page Up"]],
      ["Ctrl+Z", ["Ctrl", "Z"]],
      ["Ctrl+Shift+Z", ["Ctrl", "Shift", "Z"]],
      ["Cmd+Delete", ["Cmd", "Delete"]],
    ] as const) {
      assert.deepEqual(keyChord(code), keys, code);
    }
  });

  test("anything else in a code span stays code: searches, entries, formulas and file names", () => {
    for (const code of ["goblin", "-7", "+3", "8d6 fire", "cr 1-3", "crypt_30x20.jpg", "Ctrl++", "Z+Ctrl", "Ctrl+", "Ctrl+Zz", " ", "ab"]) {
      assert.equal(keyChord(code), null, code);
    }
  });
});
