import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DDB_LINK_ERROR, ddbCharacterId, ddbCharacterUrl, ddbSheetUrl } from "./link.ts";

/** A D&D Beyond character's number from what a player pastes (docs/design-v1-pc-stats.md 6.3). */

describe("ddbCharacterId", () => {
  test("a number of 1 to 12 digits, or the digits after /characters/ on the named hosts", () => {
    assert.equal(ddbCharacterId(" 12345678 "), "12345678");
    assert.equal(ddbCharacterId("https://www.dndbeyond.com/characters/12345678"), "12345678");
    assert.equal(ddbCharacterId("https://dndbeyond.com/characters/12345678/AbCdEf"), "12345678");
    assert.equal(ddbCharacterId("https://ddb.ac/characters/12345678/xyz"), "12345678");
    assert.equal(ddbCharacterId("dndbeyond.com/characters/12345678"), "12345678", "the share box can drop the scheme");
    assert.equal(ddbCharacterUrl("12345678"), "https://character-service.dndbeyond.com/character/v5/character/12345678");
  });

  test("anything else, a path trick or another host included, is not a link", () => {
    for (const bad of [
      "",
      "1234567890123",
      "http://www.dndbeyond.com/characters/1",
      "https://www.dndbeyond.com.evil.example/characters/1",
      "https://evil.example/www.dndbeyond.com/characters/1",
      "https://www.dndbeyond.com/monsters/1",
      "https://user@www.dndbeyond.com/characters/1",
      "https://www.dndbeyond.com:8443/characters/1",
      "https://www.dndbeyond.com/x/characters/1",
      "javascript:alert(1)",
      "12a",
    ]) {
      assert.equal(ddbCharacterId(bad), null, bad);
    }
    assert.match(DDB_LINK_ERROR, /^That is not a D&D Beyond character link\./);
  });
});

describe("the addresses built from the digits", () => {
  test("the one the server fetches and the sheet link", () => {
    assert.equal(ddbSheetUrl("12345678"), "https://www.dndbeyond.com/characters/12345678");
  });
});
