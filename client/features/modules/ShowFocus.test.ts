import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * After a Show (docs/design/design-v1-features.md 6): the part a Hidden on
 * this device button names, read from its words, and what the live region
 * then says. Where focus goes is the e2e's (features.e2e.ts ft-1).
 */

const { partOfShow, shownWords } = await import("./ShowFocus.tsx");

describe("after a Show", () => {
  test("a button's words name its part, the first named where a need comes with it", () => {
    assert.equal(partOfShow("Show Sound"), "sound");
    assert.equal(partOfShow("Show Dungeon generator and Map builder"), "dungeon");
    assert.equal(partOfShow("Show Map builder"), "builder");
    assert.equal(partOfShow("Show Ping and laser"), "ping", "a name with its own and is read whole");
    assert.equal(partOfShow("Show the shortcuts"), null);
    assert.equal(partOfShow("Sound"), null);
  });

  test("the polite line", () => {
    assert.equal(shownWords("Sound"), "Sound shows again.");
  });
});
