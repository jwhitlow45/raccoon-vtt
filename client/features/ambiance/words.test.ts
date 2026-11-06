import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { backgroundCount, EMPTY_LINE, soundSummary, timeSummary, weatherRowLabel } from "./words.ts";

/* Ambiance's folded summaries and the Weather row's name (docs/design/design-v1-panel-groups.md 4.2 and 9), each branch. */

const track = (over: Partial<Parameters<typeof soundSummary>[0] & object> = {}) => ({ name: "Harbor at dusk", paused: false, playlistName: "Tavern night", place: 2, count: 12, single: false, ...over });

describe("Ambiance's words", () => {
  test("Time: the chip's text, Hidden while players don't see it, or Not started", () => {
    assert.equal(timeSummary({ chip: "Day 3, 8:00 PM", shown: true }), "Day 3, 8:00 PM");
    assert.equal(timeSummary({ chip: "Deepwinter 4, 6:10 AM", shown: false }), "Deepwinter 4, 6:10 AM · Hidden");
    assert.equal(timeSummary(null), "Not started");
  });

  test("Sound: a playlist's run line, a single track's name, Paused, then the background count, and never an effect", () => {
    assert.equal(soundSummary(track(), 2), "Tavern night · 2 of 12 · 2 background sounds");
    assert.equal(soundSummary(track({ playlistName: null }), 0), "2 of 12", "a run whose playlist went");
    assert.equal(soundSummary(track({ single: true, paused: true }), 0), "Harbor at dusk · Paused");
    assert.equal(soundSummary(track({ paused: true }), 1), "Tavern night · 2 of 12 · Paused · 1 background sound");
    assert.equal(soundSummary(null, 1), "1 background sound");
    assert.equal(soundSummary(null, 3), "3 background sounds");
    assert.equal(soundSummary(null, 0), "Nothing is playing");
  });

  test("the background count", () => {
    assert.equal(backgroundCount(1), "1 background sound");
    assert.equal(backgroundCount(4), "4 background sounds");
  });

  test("the Weather row's name says the weather and where it opens", () => {
    assert.equal(weatherRowLabel({ name: "Goblin cave", summary: "Heavy rain · Strong wind" }), "Weather: Heavy rain · Strong wind, in Goblin cave's settings");
    assert.equal(weatherRowLabel(null), "Weather: no scene, in Scenes");
  });

  test("a player's empty Ambiance", () => {
    assert.equal(EMPTY_LINE, "The DM isn't sharing the date and time or playing sound now.");
  });
});
