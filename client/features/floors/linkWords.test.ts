import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import * as words from "./linkWords.ts";

/*
 * The words stairs and ladders show (docs/design/design-v1-floors.md phase
 * 2, 6.3, 7, 10, 11), held to the design's exact text.
 */

describe("stairs' words", () => {
  test("the bar's button, its name and tooltip, and the off reasons", () => {
    assert.equal(words.climbWords("up"), "Go up");
    assert.equal(words.climbWords("down"), "Go down");
    assert.equal(words.climbName("up", "stairs", "Upper floor"), "Go up the stairs to Upper floor");
    assert.equal(words.climbName("down", "ladder", null), "Go down the ladder");
    assert.equal(words.climbTip("up", "stairs", "}"), "Go up the stairs (})");
    assert.equal(words.climbTip("down", "stairs", null), "Go down the stairs");
    assert.equal(words.climbOffReason("locked", "stairs"), "It's locked.");
    assert.equal(words.climbOffReason("squeeze", "stairs"), "Too big for these stairs. Squeeze to fit.");
    assert.equal(words.climbOffReason("tooBig", "ladder"), "Too big for this ladder.");
    assert.equal(words.climbOffReason("tooBig", "stairs"), LINK_WORDS.tooBig("stairs"));
    assert.equal(words.notOnStairs("Thorn"), "Thorn isn't at stairs, a ladder or an opening.");
  });

  test("the board's names: the far floor where held, else the kind and the way", () => {
    assert.equal(words.linkName("up", "stairs", "Upper floor"), "Up to Upper floor");
    assert.equal(words.linkName("up", "stairs", null), "Stairs up");
    assert.equal(words.linkName("down", "ladder", null), "Ladder down");
    assert.equal(words.linkNameNotReached("up", "Attic"), "Up to Attic · Not reached yet");
  });

  test("the builder's mode, hint, choices and pane", () => {
    assert.equal(words.LINK_MODE, "Between floors");
    assert.equal(words.linkHint("stairs", false), "Drag over squares to place stairs.");
    assert.equal(words.linkHint("ladder", true), "Drag over hexes to place a ladder.");
    for (const kind of ["stairs", "ladder"] as const) for (const hexes of [true, false]) assert.ok(words.linkHint(kind, hexes).length < 45);
    assert.equal(words.toChoice("up", "Upper floor"), "Up to Upper floor");
    assert.equal(words.toChoice("down", "Cellar"), "Down to Cellar");
    assert.equal(words.paneTitle("up", "stairs", "Upper floor"), "Stairs up to Upper floor");
    assert.equal(words.lockedHelp("stairs"), "Go up and Go down are off while they're locked. A party member who climbs opens the floor to players.");
    assert.equal(words.notReachedLine("Attic", "up", "ladder"), 'Players haven\'t reached Attic, so they see "Ladder up" here.');
    assert.equal(words.goToFloor("Upper floor"), "Go to Upper floor");
    assert.equal(words.removeWords("stairs"), "Remove stairs");
    assert.equal(words.REMOVE_BOTH, "Remove both ends");
  });

  test("the undo labels after Undo", () => {
    assert.equal(words.climbLabel("Thorn", "up", "stairs"), "moving Thorn up the stairs");
    assert.equal(words.LINK_LABELS.placed("stairs", "Upper floor"), "placing stairs to Upper floor");
    assert.equal(words.LINK_LABELS.removed("stairs", "Upper floor"), "removing stairs to Upper floor");
    assert.equal(words.LINK_LABELS.lock("stairs", true), "locking the stairs");
    assert.equal(words.LINK_LABELS.kind("stairs"), "changing stairs to a ladder");
  });
});

describe("the walking ruler over stairs (phase 3, 4.1 and 4.2)", () => {
  test("the stairs button's words and name, the carried line and the hints", () => {
    assert.deepEqual(
      [words.rulerStairsWords("up", "stairs"), words.rulerStairsWords("down", "stairs"), words.rulerStairsWords("up", "ladder"), words.rulerStairsWords("down", "ladder")],
      ["Up the stairs", "Down the stairs", "Up the ladder", "Down the ladder"],
    );
    assert.equal(words.rulerStairsName("up", "stairs", "Upper floor"), "Measure on up the stairs to Upper floor");
    assert.equal(words.rulerStairsName("down", "ladder", "Cellar"), "Measure on down the ladder to Cellar");
    assert.equal(words.beforeFloorLine("25 ft"), "25 ft before this floor");
    assert.equal(words.CARRIED_NO_KEEP, "A ruler over stairs can't be kept.");
    assert.equal(words.CARRIED_WALKS, "A ruler over stairs walks.");
    assert.equal(words.SHARE_BEFORE_STAIRS, "Share it before it takes the stairs.");
    assert.equal(words.CARRIED_TOO_LONG, "A ruler over stairs can't take more stops. Clear it to measure again.");
  });
});

describe("openings' words and hidden stairs (phase 4, 3, 5, 7.4 and 8.1)", () => {
  test("Fly up and Fly down: the button's words, its name with and without the far floor, its tooltip with the floor and the key", () => {
    assert.equal(words.climbWords("up", "opening"), "Fly up");
    assert.equal(words.climbWords("down", "opening"), "Fly down");
    assert.equal(words.climbWords("down", "ladder"), "Go down");
    assert.equal(words.climbName("down", "opening", "Ground floor"), "Fly down to Ground floor");
    assert.equal(words.climbName("up", "opening", null), "Fly up through the opening");
    assert.equal(words.climbTip("down", "opening", "{", "Ground floor"), "Fly down to Ground floor ({)");
    assert.equal(words.climbTip("up", "opening", null, "Upper floor"), "Fly up to Upper floor");
    assert.equal(words.climbTip("up", "stairs", "}", "Upper floor"), "Go up the stairs (})", "stairs' tooltip names no floor, as before");
    assert.equal(words.FLY_ONLY, "Only a creature in the air goes through an opening.");
    // The off reasons are the server's own, by kind (shared/rules/floorLinks.ts LINK_WORDS).
    assert.equal(words.climbOffReason("squeeze", "opening"), LINK_WORDS.tooBigSqueeze("opening"));
    assert.equal(words.climbOffReason("tooBig", "opening"), LINK_WORDS.tooBig("opening"));
  });

  test("the board's names, marks and chip", () => {
    assert.equal(words.linkName("down", "opening", "Ground floor"), "Down to Ground floor");
    assert.equal(words.linkName("down", "opening", null), "Opening down");
    assert.equal(words.linkName("up", "opening", null), "Opening up");
    assert.equal(words.linkMarksLine({ hidden: true, notReached: false }), "Hidden");
    assert.equal(words.linkMarksLine({ hidden: true, notReached: true }), "Hidden · Not reached yet");
    assert.equal(words.linkMarksLine({ hidden: false, notReached: true }), "Not reached yet");
    assert.equal(words.linkMarksLine({ hidden: false, notReached: false }), null);
    assert.equal(words.dropChip(10), "10 ft down");
    assert.equal(words.windowLoading("Ground floor"), "Loading Ground floor…");
  });

  test("the builder's kind, hint and pane for an opening, and the Hidden switch", () => {
    assert.equal(words.KIND_NAMES.opening, "Opening");
    assert.equal(words.linkHint("opening", false), "Drag over squares to place an opening.");
    assert.equal(words.linkHint("opening", true), "Drag over hexes to place an opening.");
    for (const hexes of [true, false]) assert.ok(words.linkHint("opening", hexes).length < 45);
    assert.equal(words.paneTitle("down", "opening", "Ground floor"), "Opening down to Ground floor");
    assert.deepEqual(["stairs", "ladder", "opening"].map((k) => words.paneName(k as "stairs")), ["Edit stairs", "Edit ladder", "Edit opening"]);
    assert.deepEqual(words.PANE_KINDS, ["stairs", "ladder"]);
    assert.equal(words.removeWords("opening"), "Remove opening");
    assert.equal(words.removeWords("ladder"), "Remove ladder");
    assert.equal(words.HIDDEN_SWITCH, "Hidden from players");
    assert.equal(words.hiddenHelp("stairs"), "Players see nothing of these stairs until you turn this off.");
    assert.equal(words.hiddenHelp("ladder"), "Players see nothing of this ladder until you turn this off.");
    assert.equal(words.notReachedLine("Cellar", "down", "opening"), 'Players haven\'t reached Cellar, so they see "Opening down" here.');
  });
});
