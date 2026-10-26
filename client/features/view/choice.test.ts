import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isometric, TOP_DOWN, type Turn } from "../../lib/view.ts";
import {
  choiceOf,
  choiceWords,
  followSaid,
  ISO_TEST_FLAG,
  isoOffered,
  kindSaid,
  menuLine,
  otherViewPress,
  pickOf,
  suggestionHelp,
  topDownLine,
  topDownTool,
  turnedSaid,
  turnRefused,
  turnsReason,
  turnsReasons,
  viewButtonLabel,
  VIEW_CHOICES,
  viewSaid,
  wantedKind,
  type ViewState,
} from "./choice.ts";
import { FOLLOW_THE_SCENE, withPick } from "./store.ts";

/** The module as a page loads it, with the globals set at that moment. */
const loaded = (tag: string) => import(`./choice.ts?${tag}`) as Promise<typeof import("./choice.ts")>;

const state = (over: Partial<ViewState> = {}): ViewState => ({ sceneId: "s1", shown: TOP_DOWN, pick: null, wanted: "topDown", forcedBy: null, ...over });

describe("the view choice (docs/design-v1-isometric-view.md 7, 8)", () => {
  test("Isometric is offered only once isoReady is on, or on a page a test opened with the flag", async () => {
    assert.equal(isoOffered, false, "no page offers it yet");
    (globalThis as Record<string, unknown>)[ISO_TEST_FLAG] = true;
    try {
      const flagged = await loaded("flagged");
      assert.equal(flagged.isoOffered, true);
    } finally {
      delete (globalThis as Record<string, unknown>)[ISO_TEST_FLAG];
    }
    (globalThis as Record<string, unknown>)[ISO_TEST_FLAG] = "true";
    try {
      const loose = await loaded("loose");
      assert.equal(loose.isoOffered, false, "only the value true");
    } finally {
      delete (globalThis as Record<string, unknown>)[ISO_TEST_FLAG];
    }
  });

  test("the four tools that show Top-down while in use say so, each in its own words, and no other tool does", () => {
    assert.equal(topDownLine("build"), "The map builder works top-down. Isometric comes back when you switch tools.");
    assert.equal(topDownLine("fog"), "Fog works top-down. Isometric comes back when you switch tools.");
    assert.equal(topDownLine("grid"), "Line up grid works top-down. Isometric comes back when you switch tools.");
    assert.equal(topDownLine("trap"), "Traps work top-down. Isometric comes back when you switch tools.");
    for (const tool of ["select", "ruler", "area", "draw", "ping", "pin", "add-token", "constructor", "__proto__", "toString", "", null, undefined]) {
      assert.equal(topDownTool(tool), null, String(tool));
      assert.equal(topDownLine(tool), null, String(tool));
    }
  });

  test("the menu promises Isometric back only to a user who wants it", () => {
    const line = "The map builder works top-down. Isometric comes back when you switch tools.";
    assert.equal(menuLine({ forcedBy: "build", wanted: "isometric" }), line);
    assert.equal(menuLine({ forcedBy: "build", wanted: "topDown" }), null, "a Top-down pick keeps Top-down after the tool");
    assert.equal(menuLine({ forcedBy: null, wanted: "isometric" }), null);
  });

  test("the popover's turns say why they are disabled in Top-down, and nothing while they turn", () => {
    assert.equal(turnsReason({ shown: TOP_DOWN, forcedBy: null, wanted: "topDown" }), "Turning works in Isometric.");
    assert.equal(turnsReason({ shown: TOP_DOWN, forcedBy: "fog", wanted: "isometric" }), "Fog works top-down. Isometric comes back when you switch tools.");
    assert.equal(turnsReason({ shown: TOP_DOWN, forcedBy: "fog", wanted: "topDown" }), "Turning works in Isometric.");
    assert.equal(turnsReason({ shown: isometric(1), forcedBy: null, wanted: "isometric" }), null);
  });

  test("the popover holds a place for every reason its turns can give under the tool, so a pick never resizes it", () => {
    for (const forcedBy of [null, "build", "fog", "grid", "trap", "select"]) {
      const holds = turnsReasons(forcedBy);
      for (const shown of [TOP_DOWN, isometric(0), isometric(3)]) {
        for (const wanted of ["topDown", "isometric"] as const) {
          // A tool that shows Top-down never shows Isometric.
          if (topDownLine(forcedBy) !== null && shown.kind === "isometric") continue;
          const reason = turnsReason({ shown, forcedBy, wanted });
          assert.ok(reason === null || holds.includes(reason), `${forcedBy} ${shown.kind} ${wanted}: "${reason}" has no place held`);
        }
      }
    }
    assert.deepEqual(turnsReasons(null), ["Turning works in Isometric."]);
  });

  test("the words shown are the design's", () => {
    assert.equal(viewButtonLabel(TOP_DOWN), "View: Top-down");
    assert.equal(viewButtonLabel(isometric(2)), "View: Isometric");
    assert.equal(suggestionHelp("isometric"), "This scene suggests Isometric.");
    assert.equal(suggestionHelp(undefined), "This scene suggests Top-down.");
    assert.equal(kindSaid("isometric"), "Isometric view.");
    assert.equal(kindSaid("topDown"), "Top-down view.");
    assert.equal(followSaid("isometric"), "Following the scene: isometric.");
    assert.equal(followSaid("topDown"), "Following the scene: top-down.");
    assert.equal(turnedSaid(1, 1), "Turned right. The map's top edge faces down and to the right.");
    assert.equal(turnedSaid(1, 2), "Turned right. The map's top edge faces down and to the left.");
    assert.equal(turnedSaid(-1, 3), "Turned left. The map's top edge faces up and to the left.");
    assert.equal(turnedSaid(-1, 0), "Turned left. The map's top edge faces up and to the right.");
  });

  test("the radio group's choice is the pick, Follow the scene for none, and back", () => {
    for (const pick of [null, "topDown", "isometric"] as const) assert.equal(pickOf(choiceOf(pick)), pick);
    assert.equal(choiceOf(null), "follow");
    assert.deepEqual(VIEW_CHOICES.map(choiceWords), ["Follow the scene", "Top-down", "Isometric"]);
    assert.equal(wantedKind(FOLLOW_THE_SCENE, "isometric"), "isometric");
    assert.equal(wantedKind(withPick(FOLLOW_THE_SCENE, "topDown"), "isometric"), "topDown", "a pick beats the suggestion");
    assert.equal(wantedKind(FOLLOW_THE_SCENE, undefined), "topDown");
  });

  test("the status says each change once: a view, Follow the scene, a turn each way, and a tool's line per tool choice", () => {
    const iso = (turn: Turn, over: Partial<ViewState> = {}) => state({ shown: isometric(turn), wanted: "isometric", ...over });
    assert.equal(viewSaid(state(), state()), null, "no change");
    assert.equal(viewSaid(state(), iso(0, { pick: "isometric" })), "Isometric view.");
    assert.equal(viewSaid(iso(0, { pick: "isometric" }), state({ pick: "topDown" })), "Top-down view.");
    assert.equal(viewSaid(state({ pick: "topDown" }), iso(0)), "Following the scene: isometric.");
    assert.equal(viewSaid(iso(1, { pick: "isometric" }), iso(1)), "Following the scene: isometric.", "Follow the scene picked while the view stays");
    assert.equal(viewSaid(iso(0), iso(1)), "Turned right. The map's top edge faces down and to the right.");
    assert.equal(viewSaid(iso(0), iso(3)), "Turned left. The map's top edge faces up and to the left.");
    assert.equal(viewSaid(iso(3), iso(0)), "Turned right. The map's top edge faces up and to the right.");
    assert.equal(viewSaid(iso(0), iso(2, { sceneId: "s2" })), null, "another scene's own turn is no turn of the map");
    assert.equal(viewSaid(iso(0), state({ sceneId: "s2" })), "Top-down view.", "another scene's view is said");

    const building = state({ wanted: "isometric", forcedBy: "build" });
    assert.equal(viewSaid(iso(0), building), "The map builder works top-down. Isometric comes back when you switch tools.");
    assert.equal(viewSaid(building, building), null, "once per tool choice");
    assert.equal(viewSaid(building, state({ wanted: "isometric", forcedBy: "fog" })), "Fog works top-down. Isometric comes back when you switch tools.");
    assert.equal(viewSaid(building, iso(0)), "Isometric view.", "back with another tool");
    assert.equal(viewSaid(state(), state({ forcedBy: "build" })), null, "a tool that changes nothing says nothing");
  });

  test("I picks the other view than the one wanted, and with a tool that shows Top-down says the tool's line where the pick is Isometric", () => {
    assert.deepEqual(otherViewPress(FOLLOW_THE_SCENE, undefined, "select"), { pick: "isometric", toast: null });
    assert.deepEqual(otherViewPress(FOLLOW_THE_SCENE, "isometric", "select"), { pick: "topDown", toast: null }, "following an Isometric scene");
    assert.deepEqual(otherViewPress(withPick(FOLLOW_THE_SCENE, "topDown"), "isometric", "ruler"), { pick: "isometric", toast: null });
    assert.deepEqual(otherViewPress(FOLLOW_THE_SCENE, undefined, "build"), { pick: "isometric", toast: "The map builder works top-down. Isometric comes back when you switch tools." });
    assert.deepEqual(otherViewPress(withPick(FOLLOW_THE_SCENE, "isometric"), undefined, "trap"), { pick: "topDown", toast: null }, "the board already shows Top-down");
  });

  test("Q and E in Top-down say turning needs Isometric, or the tool's line while a tool hides the Isometric wanted", () => {
    assert.equal(turnRefused(FOLLOW_THE_SCENE, undefined, "select"), "Turning needs the isometric view.");
    assert.equal(turnRefused(FOLLOW_THE_SCENE, undefined, "fog"), "Turning needs the isometric view.", "Top-down is wanted anyway");
    assert.equal(turnRefused(FOLLOW_THE_SCENE, "isometric", "grid"), "Line up grid works top-down. Isometric comes back when you switch tools.");
    assert.equal(turnRefused(withPick(FOLLOW_THE_SCENE, "isometric"), undefined, "trap"), "Traps work top-down. Isometric comes back when you switch tools.");
  });
});
