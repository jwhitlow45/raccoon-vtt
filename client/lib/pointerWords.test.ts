import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pointerWords } from "./pointerWords.ts";

describe("pointerWords", () => {
  test("a phone keeps its tap words", () => {
    assert.equal(pointerWords("Tap the map to place it. Tap again to end the fight.", true), "Tap the map to place it. Tap again to end the fight.");
  });

  test("a mouse reads click for each form of tap, keeping the case", () => {
    assert.equal(pointerWords("Tap a token to cast from it, or tap the map. Tap an area on the map to pick it.", false), "Click a token to cast from it, or click the map. Click an area on the map to pick it.");
    assert.equal(pointerWords("Double-tap to keep it. Your taps move the view.", false), "Double-click to keep it. Your clicks move the view.");
  });

  test("a word that only holds the letters is left alone", () => {
    assert.equal(pointerWords("Tapestry and tape", false), "Tapestry and tape");
  });
});
