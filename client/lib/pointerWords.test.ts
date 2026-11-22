import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pointerWords } from "./pointerWords.ts";

describe("pointerWords", () => {
  test("a phone keeps its tap words", () => {
    assert.equal(pointerWords("Tap the map to place it. Tap again to end the fight.", {}, true), "Tap the map to place it. Tap again to end the fight.");
  });

  test("a mouse reads click for each form of tap, keeping the case", () => {
    assert.equal(pointerWords("Tap a token to cast from it, or tap the map. Tap an area on the map to pick it.", {}, false), "Click a token to cast from it, or click the map. Click an area on the map to pick it.");
    assert.equal(pointerWords("Double-tap to keep it. Your taps move the view.", {}, false), "Double-click to keep it. Your clicks move the view.");
  });

  test("a word that only holds the letters is left alone", () => {
    assert.equal(pointerWords("Tapestry and tape", {}, false), "Tapestry and tape");
  });

  test("names go in after the words are chosen, so a creature named Tap reads as named", () => {
    assert.equal(pointerWords("Tap the map to place {what}.", { what: "Tap Room" }, false), "Click the map to place Tap Room.");
    assert.equal(pointerWords("{name} is picked. Tap more rows.", { name: "Tap" }, false), "Tap is picked. Click more rows.");
    assert.equal(pointerWords("{name} is picked. Tap more rows.", { name: "Tap" }, true), "Tap is picked. Tap more rows.");
    assert.equal(pointerWords("Cast by {a}.", { a: "{b}", b: "x" }, false), "Cast by {b}.", "a name is never read for holes");
    assert.equal(pointerWords("Keep {constructor} and {toString} as written.", {}, false), "Keep {constructor} and {toString} as written.", "only the names given fill a hole");
  });
});
