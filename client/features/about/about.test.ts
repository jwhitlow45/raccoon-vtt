import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CREDITS, TOKEN_ICONS } from "#shared/credits.ts";
import { creditSections, listText, tokenIconsSection } from "./credits.ts";
import { parseInline, parseMarkdown, plainText } from "./notice.ts";

const NOTICE = readFileSync(new URL("../../../shared/srd/NOTICE.md", import.meta.url), "utf8");
const ATTRIBUTION =
  "This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.";

describe("SRD notice", () => {
  test("renders Wizards' attribution word for word, with live links", () => {
    const blocks = parseMarkdown(NOTICE);
    const paragraph = blocks.find((b) => b.kind === "paragraph");
    assert.ok(paragraph && paragraph.kind === "paragraph");
    assert.equal(plainText(paragraph.inline), ATTRIBUTION);
    const links = paragraph.inline.filter((p) => p.kind === "link").map((p) => (p.kind === "link" ? p.href : ""));
    assert.deepEqual(links, ["https://www.dndbeyond.com/srd", "https://creativecommons.org/licenses/by/4.0/legalcode"]);
  });

  test("keeps every word of the file", () => {
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    const source = NOTICE.replace(/`/g, "").replace(/^\s*(#+|-)\s/gm, "");
    const rendered = parseMarkdown(NOTICE)
      .flatMap((b) => (b.kind === "list" ? b.items.map(plainText) : [plainText(b.inline)]))
      .join(" ");
    assert.deepEqual(words(rendered), words(source));
  });

  test("headings, lists and code", () => {
    const blocks = parseMarkdown("# Title\n\nSome `code` here.\n\n- one\n- two\n  wrapped\n");
    assert.deepEqual(blocks.map((b) => b.kind), ["heading", "paragraph", "list"]);
    const list = blocks[2];
    assert.ok(list?.kind === "list");
    assert.equal(plainText(list.items[1]!), "two wrapped");
    assert.deepEqual(parseInline("see [the page](https://example.org/x)."), [
      { kind: "text", text: "see " },
      { kind: "link", text: "the page", href: "https://example.org/x" },
      { kind: "text", text: "." },
    ]);
  });

  test("says fifth edition, never the trademark", () => {
    assert.match(NOTICE, /compatible with fifth edition/);
    assert.doesNotMatch(NOTICE, /D\s*&\s*D|Dungeons\s*(?:&|and)\s*Dragons/i);
  });
});

describe("credits", () => {
  test("every credit appears, and every CC BY work carries its author, source, license and changes", () => {
    const sections = creditSections();
    assert.equal(sections.reduce((n, s) => n + s.rows.length, 0), CREDITS.reduce((n, g) => n + g.credits.length, 0));
    for (const section of sections) {
      for (const row of section.rows) {
        if (!row.license.id.startsWith("CC-BY")) continue;
        assert.ok(row.author, row.title);
        assert.ok(row.sourceUrl?.startsWith("https://"), row.title);
        assert.ok(row.license.url?.startsWith("https://creativecommons.org/"), row.title);
        assert.ok(row.changes ?? section.changes, `${row.title} says what changed`);
      }
    }
  });

  test("a change shared by a whole group is said once", () => {
    const icons = creditSections().find((s) => s.id === "icons");
    assert.ok(icons?.changes);
    assert.ok(icons.rows.every((r) => r.changes === null));
  });

  test("the X-card credits John Stavropoulos with the link and the license its text asks for (docs/design-v1-dm-tools.md 3.11)", () => {
    const safety = creditSections().find((s) => s.id === "safety");
    const xcard = safety?.rows.find((r) => r.title === "X-Card");
    assert.ok(xcard, "the About page lists the X-card");
    assert.equal(xcard.author, "John Stavropoulos");
    assert.equal(xcard.sourceUrl, "https://tinyurl.com/x-card-rpg");
    assert.deepEqual([xcard.license.name, xcard.license.url], ["CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/"]);
    assert.ok(readFileSync(new URL("../../../CREDITS.md", import.meta.url), "utf8").includes("John Stavropoulos"), "CREDITS.md credits it too");
  });

  test("a source inside this repository is not made a link", () => {
    const appIcon = creditSections().find((s) => s.id === "app-icon");
    assert.equal(appIcon?.rows[0]?.sourceUrl, null);
  });
});

describe("token icons credit", () => {
  const section = tokenIconsSection();

  test("names the authors as game-icons.net asks, and links the site", () => {
    assert.equal(section.heading, "Token icons");
    assert.equal(section.madeBy, "Icons made by Lorc, Delapouite and 34 others.");
    assert.equal(section.site, "https://game-icons.net");
    assert.equal(section.changes, "Black background square removed.");
  });

  test("each license with its link and how many icons it covers", () => {
    assert.deepEqual(
      section.licenses.map((l) => [l.name, l.url, l.icons, l.authors.length]),
      [
        ["CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/", 4055, 33],
        ["CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", 125, 3],
      ],
    );
    assert.equal(listText(section.licenses[1]!.authors), "Various artists, Viscious Speed and Zeromancer");
  });

  test("every author with their count, most icons first", () => {
    assert.equal(section.authors.length, 36);
    assert.equal(section.authors.reduce((n, a) => n + a.icons, 0), 4180);
    assert.deepEqual(section.authors.slice(0, 2).map((a) => [a.name, a.icons]), [["Delapouite", 2022], ["Lorc", 1429]]);
    for (let i = 1; i < section.authors.length; i++) assert.ok(section.authors[i - 1]!.icons >= section.authors[i]!.icons);
    for (const author of section.authors) assert.ok(author.url === null || /^https?:\/\//.test(author.url), author.name);
  });

  test("a set with one license and one lead author reads as a sentence", () => {
    const one = tokenIconsSection({
      ...TOKEN_ICONS,
      leadAuthors: ["lorc"],
      authors: [
        { id: "lorc", name: "Lorc", license: "CC-BY-3.0", icons: 3 },
        { id: "skoll", name: "Skoll", license: "CC-BY-3.0", icons: 1 },
      ],
    });
    assert.equal(one.madeBy, "Icons made by Lorc and 1 other.");
    assert.equal(one.licenses.length, 1);
  });
});
