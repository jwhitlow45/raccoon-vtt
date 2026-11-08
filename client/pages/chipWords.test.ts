import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHIP_WORDS, DM_MENU_HEADINGS, DM_MENU_SECTIONS, audienceDescription, audienceDetail, notReached, playersOn, recentDetail } from "./chipWords.ts";

describe("the chips' words (docs/design/design-v1-qol.md 4, Words)", () => {
  test("a recent handout names its audience, by name up to two players and by count past them, its description naming them all", () => {
    assert.equal(audienceDetail("all"), "to everyone");
    assert.equal(audienceDetail(["Pat"]), "to Pat");
    assert.equal(audienceDetail(["Pat", "Ana"]), "to Pat and Ana");
    assert.equal(audienceDetail(["Pat", "Ana", "Bree"]), "to 3 players");
    assert.equal(audienceDescription(["Pat"]), "Shows it to Pat again.");
    assert.equal(audienceDescription(["Pat", "Ana", "Bree"]), "Shows it to Pat, Ana and Bree again.");
    assert.equal(audienceDescription("all"), "Shows it to everyone again.");
  });

  test("a document is named as the whole document, never a page of it (design-v1-qol.md 3, Q11)", () => {
    assert.equal(recentDetail("doc", "all"), "Document · to everyone");
    assert.equal(recentDetail("image", ["Pat"]), "to Pat");
  });

  test("every section has its heading, and no word carries an em dash or a semicolon", () => {
    assert.deepEqual(Object.keys(DM_MENU_HEADINGS).sort(), [...DM_MENU_SECTIONS].sort());
    for (const word of [...Object.values(CHIP_WORDS), ...Object.values(DM_MENU_HEADINGS)]) assert.doesNotMatch(word, /[\u2014;]/, word);
  });

  test("the words that name a floor (design-v1-floors.md 18.6)", () => {
    assert.equal(notReached("Attic"), "Players haven't reached Attic, so their maps stay.");
    assert.equal(CHIP_WORDS.liftRefusedFloor, "Not shown: the players are on another floor now. The blackout stays on.");
    assert.equal(playersOn("another floor"), "They are on another floor.");
    assert.equal(playersOn("Tower · Ground floor"), "They are on Tower · Ground floor.");
  });
});
