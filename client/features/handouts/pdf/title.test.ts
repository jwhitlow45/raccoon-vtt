import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { textSchemas } from "#shared/protocol.ts";
import { cleanTitle, pdfTitle, titleProblem } from "./title.ts";

const DRAGON = "\u{1F409}";
const passes = (title: string) => assert.ok(textSchemas.name.safeParse(title).success, JSON.stringify(title));

describe("a PDF handout's title (docs/design-v1-pdf-handouts.md 4.1.3)", () => {
  test("the XMP title before the Info title, then the file's name, then Handout", () => {
    assert.equal(pdfTitle({ xmp: "Strange letter", info: "Old name" }, "letter.pdf"), "Strange letter");
    assert.equal(pdfTitle({ xmp: null, info: "Old name" }, "letter.pdf"), "Old name");
    assert.equal(pdfTitle({ xmp: null, info: null }, "strange_letter-v2.pdf"), "strange letter v2");
    assert.equal(pdfTitle({ xmp: null, info: null }, ".pdf"), "Handout");
    assert.equal(pdfTitle({ xmp: null, info: null }, ""), "Handout");
  });

  test("a title that is empty after cleaning, a placeholder or a file path gives way to the file's name", () => {
    for (const junk of ["", "   ", "\u202E\u2066", "Untitled", "untitled document", "UNTITLED", "C:\\Users\\dm\\letter.docx", "/home/dm/Letter", "Microsoft Word - "]) {
      assert.equal(pdfTitle({ xmp: junk, info: junk }, "Strange letter.pdf"), "Strange letter", JSON.stringify(junk));
    }
  });

  test("cleaning: control and direction characters, whitespace, an Office prefix and a document's extension", () => {
    assert.equal(cleanTitle("Microsoft Word - Strange letter.docx"), "Strange letter");
    assert.equal(cleanTitle("Microsoft PowerPoint - Maps.pdf"), "Maps");
    assert.equal(cleanTitle("Strange\nletter\t\u2028 to\u0000 Pip"), "Strange letter to Pip");
    assert.equal(cleanTitle("Ana\u202Eesoj\u2066"), "Anaesoj");
    assert.equal(cleanTitle("Notes.pages"), "Notes");
    assert.equal(cleanTitle("Report.final"), "Report.final", "only a document's extension is dropped");
  });

  test("cut to 80 UTF-16 units without splitting a character", () => {
    const fortyOne = DRAGON.repeat(41);
    assert.equal(cleanTitle(fortyOne), DRAGON.repeat(40));
    assert.equal(cleanTitle(fortyOne).length, 80);
    const odd = `x${DRAGON.repeat(80)}`;
    assert.equal(cleanTitle(odd), `x${DRAGON.repeat(39)}`, "the 80th unit would be half a dragon, so it goes");
    assert.equal(cleanTitle(DRAGON.repeat(80)).length, 80);
    assert.equal(cleanTitle(`${"a".repeat(79)} ${"b".repeat(10)}`), "a".repeat(79), "no space left at the end");
    // Half a character left by a cut elsewhere goes too.
    assert.equal(cleanTitle(`Map ${DRAGON.slice(0, 1)}`), "Map");
  });

  test("a file name with text direction characters", () => {
    assert.equal(pdfTitle({ xmp: null, info: null }, "\u202Egnp.\u202Cletter.pdf"), "gnp.letter");
  });

  test("every result passes the name schema", () => {
    const sources = [null, "", "Strange letter", DRAGON.repeat(41), `x${DRAGON.repeat(80)}`, "Untitled", "a\u0000b\u202Ec", " ".repeat(200), "Microsoft Excel - .xlsx", "\u2028\u2029"];
    const files = ["", ".pdf", "letter.pdf", `${DRAGON.repeat(60)}.pdf`, "\u202E\u0000.pdf", "a/b\\c.pdf"];
    for (const xmp of sources) for (const info of sources) for (const file of files) passes(pdfTitle({ xmp, info }, file));
  });
});

describe("a typed title (docs/design-v1-pdf-handouts.md 4.1.5)", () => {
  test("checked against the name schema, with its reason in words", () => {
    assert.equal(titleProblem("Strange letter"), null);
    assert.equal(titleProblem("  "), "Give the handout a title.");
    assert.equal(titleProblem("x".repeat(81)), "A title is at most 80 characters.");
    assert.match(titleProblem("two\nlines") ?? "", /line breaks/);
    assert.match(titleProblem("Ana\u202E") ?? "", /direction/);
  });
});
