import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handoutFileName } from "./download.ts";

describe("handoutFileName", () => {
  test("the title, with the extension of the image's type", () => {
    assert.equal(handoutFileName("Map of the crypt", "image/webp"), "Map of the crypt.webp");
    assert.equal(handoutFileName("Letter", "image/png"), "Letter.png");
    assert.equal(handoutFileName("Letter", "image/jpeg"), "Letter.jpg");
    assert.equal(handoutFileName("Letter", "IMAGE/WEBP; charset=binary"), "Letter.webp");
  });

  test("a type that says nothing usable saves as WebP, as the server stores every image", () => {
    assert.equal(handoutFileName("Letter", ""), "Letter.webp");
    assert.equal(handoutFileName("Letter", "application/octet-stream"), "Letter.webp");
  });

  test("characters a file system refuses become spaces, and the ends lose spaces and dots", () => {
    assert.equal(handoutFileName('The "Lost" Mine: part 1/2?', "image/webp"), "The Lost Mine part 1 2.webp");
    assert.equal(handoutFileName("a\\b<c>d|e*f", "image/webp"), "a b c d e f.webp");
    assert.equal(handoutFileName("  ..Secret door.. ", "image/webp"), "Secret door.webp");
    assert.equal(handoutFileName("line\none\ttab", "image/webp"), "line one tab.webp");
  });

  test("an empty title, or one with nothing left, saves as handout", () => {
    assert.equal(handoutFileName("", "image/webp"), "handout.webp");
    assert.equal(handoutFileName(" ?*/ ", "image/webp"), "handout.webp");
    assert.equal(handoutFileName("...", "image/webp"), "handout.webp");
  });

  test("a Windows device name gets a word after it", () => {
    assert.equal(handoutFileName("CON", "image/webp"), "CON handout.webp");
    assert.equal(handoutFileName("lpt1", "image/webp"), "lpt1 handout.webp");
    assert.equal(handoutFileName("Console", "image/webp"), "Console.webp");
  });

  test("a long title is cut to 100 characters, never inside an emoji", () => {
    const long = `${"a".repeat(99)}🐉 and more`;
    assert.equal(handoutFileName(long, "image/webp"), `${"a".repeat(99)}🐉.webp`);
    assert.equal(handoutFileName("x".repeat(300), "image/webp").length, 100 + ".webp".length);
  });
});
