import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkSummary, handoutsSummary, screensSummary } from "./summaries.ts";
import { displaysSummary } from "./tableDisplay.ts";

/* The DM panel's folded summaries (docs/design/design-v1-panel-groups.md 6.2 and 10), each branch. */

describe("the DM panel's folded summaries", () => {
  test("Handouts says how many show", () => {
    assert.equal(handoutsSummary(0), "None showing");
    assert.equal(handoutsSummary(1), "1 showing");
    assert.equal(handoutsSummary(2), "2 showing");
  });

  test("Players' screens leads with the players' scene only while the DM looks at another, then Follow me, then a blackout", () => {
    const here = { onPlayerScene: true, playerSceneName: "Crypt", follow: false, blackout: false };
    assert.equal(screensSummary(here), "Follow me off");
    assert.equal(screensSummary({ ...here, follow: true }), "Follow me on");
    assert.equal(screensSummary({ ...here, blackout: true }), "Follow me off · Players see black");
    assert.equal(screensSummary({ ...here, onPlayerScene: false }), "Players on Crypt · Follow me off");
    assert.equal(screensSummary({ ...here, onPlayerScene: false, playerSceneName: null }), "Players on another scene · Follow me off");
    assert.equal(screensSummary({ onPlayerScene: false, playerSceneName: "Crypt", follow: true, blackout: true }), "Players on Crypt · Follow me on · Players see black");
  });

  test("Check their view names Party sight only while it is on", () => {
    assert.equal(checkSummary(true), "Party sight on");
    assert.equal(checkSummary(false), undefined);
  });

  test("Table display counts its displays in a word or two, where the open line is a sentence", () => {
    assert.equal(displaysSummary(0), "No display");
    assert.equal(displaysSummary(-1), "No display");
    assert.equal(displaysSummary(1), "1 display");
    assert.equal(displaysSummary(2), "2 displays");
  });
});
