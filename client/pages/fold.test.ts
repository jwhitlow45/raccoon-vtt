import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_CHROME } from "../canvas/barDock.ts";
import { alertsSummary, dockFits, foldsUnderSheet, sideSheetRoom, type ColumnAlert } from "./fold.ts";

describe("foldsUnderSheet", () => {
  test("a phone in portrait folds while a sheet is open", () => {
    assert.equal(foldsUnderSheet({ width: 390, height: 844, sheetOpen: true }), true);
    assert.equal(foldsUnderSheet({ width: 320, height: 480, sheetOpen: true }), true);
  });

  test("nothing folds without a sheet", () => {
    assert.equal(foldsUnderSheet({ width: 390, height: 844, sheetOpen: false }), false);
  });

  test("landscape keeps everything: the sheet docks on the right beside the map", () => {
    assert.equal(foldsUnderSheet({ width: 844, height: 390, sheetOpen: true }), false);
    assert.equal(foldsUnderSheet({ width: 667, height: 375, sheetOpen: true }), false);
  });

  test("landscape folds too where the sheet opens over the whole screen, the very short mode", () => {
    assert.equal(foldsUnderSheet({ width: 369, height: 246, sheetOpen: true, full: true }), true);
    assert.equal(foldsUnderSheet({ width: 649, height: 300, sheetOpen: true, full: false }), false);
    assert.equal(foldsUnderSheet({ width: 369, height: 246, sheetOpen: false, full: true }), false, "a hidden sheet folds nothing");
    assert.equal(foldsUnderSheet({ width: 932, height: 430, sheetOpen: true, full: true }), false, "from 900 px there are no sheets");
  });

  test("a square layout counts as portrait, as the roll desk's rule does", () => {
    assert.equal(foldsUnderSheet({ width: 600, height: 600, sheetOpen: true }), true);
  });

  test("from 900 px wide there are no sheets to fold under", () => {
    assert.equal(foldsUnderSheet({ width: 1280, height: 800, sheetOpen: true }), false);
    assert.equal(foldsUnderSheet({ width: 900, height: 1200, sheetOpen: true }), false);
  });

  test("a docked window beside a sideways sheet folds under 182 px of room, one header row with the grip's dots, and not at 182 (docs/design-v1-token-window.md 7.1)", () => {
    assert.equal(foldsUnderSheet({ width: 480, height: 320, sheetOpen: true, sideRoom: 129 }), true);
    assert.equal(foldsUnderSheet({ width: 480, height: 320, sheetOpen: true, sideRoom: 181 }), true);
    assert.equal(foldsUnderSheet({ width: 480, height: 320, sheetOpen: true, sideRoom: 182 }), false);
    assert.equal(foldsUnderSheet({ width: 667, height: 375, sheetOpen: true, sideRoom: 189 }), false);
    assert.equal(foldsUnderSheet({ width: 844, height: 390, sheetOpen: true, sideRoom: 246 }), false);
    assert.equal(foldsUnderSheet({ width: 480, height: 320, sheetOpen: false, sideRoom: 129 }), false, "a closed sheet folds nothing");
  });

  test("the room a sideways sheet leaves: the free area's width beside it, none without one", () => {
    // 480 x 320 with 47 px insets: the sheet takes its 60%, 288 px, and covers the right inset.
    const chrome = { ...DEFAULT_CHROME, safe: { top: 0, right: 47, bottom: 21, left: 47 }, sheet: 288 };
    assert.equal(sideSheetRoom({ width: 480, height: 320 }, chrome), 480 - 288 - 47 - 16);
    assert.equal(sideSheetRoom({ width: 480, height: 320 }, { ...chrome, sheet: 0 }), undefined);
    assert.equal(sideSheetRoom({ width: 480, height: 320 }, null), undefined);
  });
});

const prompt = (id: string, who: string): ColumnAlert => ({ id, kind: "concentration", who, says: `Concentration save for ${who}.` });
const timeUp: ColumnAlert = { id: "t", kind: "timeUp", says: "Time is up for your turn." };
const notice = (id: string, text: string): ColumnAlert => ({ id, kind: "notice", text, says: text });

describe("alertsSummary", () => {
  test("nothing waits, no summary", () => {
    assert.equal(alertsSummary(null, []), null);
  });

  test("a roll waiting for this viewer comes first, and a tap answers it", () => {
    const s = alertsSummary({ text: "Roll asked", name: "the DM asks for a Wisdom check", waiting: true, requests: 2 }, [prompt("p1", "Thorn"), timeUp]);
    assert.deepEqual(s, {
      text: "Roll asked",
      more: "+2",
      name: "Roll asked +2: the DM asks for a Wisdom check, Thorn makes a Concentration save, time is up. Close the sheet to answer.",
      first: { kind: "rolls", id: "rolls" },
    });
  });

  test("concentration, then the time-up, then rolls that do not wait for this viewer, then notices newest first", () => {
    const s = alertsSummary({ text: "Rolls 1/3", name: "rolls 1 of 3 answered", waiting: false, requests: 2 }, [
      notice("n1", "Bless ended on Thorn."),
      timeUp,
      prompt("p1", "Thorn"),
      notice("n2", "Hex ended on Goblin."),
      prompt("p2", "Goblin"),
    ]);
    assert.equal(s?.text, "Concentration save");
    assert.equal(s?.more, "+5");
    assert.equal(
      s?.name,
      "Concentration save +5: Thorn makes a Concentration save, Goblin makes a Concentration save, time is up, rolls 1 of 3 answered, Hex ended on Goblin, Bless ended on Thorn. Close the sheet to see them.",
    );
    assert.deepEqual(s?.first, { kind: "concentration", id: "p1" });
  });

  test("the time-up outranks the rolls that do not wait", () => {
    const s = alertsSummary({ text: "Rolls 0/2", name: "rolls 0 of 2 answered", waiting: false, requests: 1 }, [timeUp]);
    assert.equal(s?.text, "Time is up");
    assert.equal(s?.name, "Time is up +1: time is up, rolls 0 of 2 answered. Close the sheet to see them.");
  });

  test("a lone notice names itself without its stop, and says it", () => {
    const s = alertsSummary(null, [notice("n1", "Bless ended on Thorn.")]);
    assert.deepEqual(s, { text: "Bless ended on Thorn", more: "", name: "Bless ended on Thorn: Bless ended on Thorn. Close the sheet to see it.", first: { kind: "notice", id: "n1" } });
  });

  test("the rolls alone say see them when they stand for several requests, and see it for one (LPD-DMPHONE-8)", () => {
    const desk = (requests: number) => alertsSummary({ text: "Rolls 1/4", name: "rolls 1 of 4 answered", waiting: false, requests }, []);
    assert.equal(desk(4)?.name, "Rolls 1/4: rolls 1 of 4 answered. Close the sheet to see them.");
    assert.equal(desk(1)?.name, "Rolls 1/4: rolls 1 of 4 answered. Close the sheet to see it.", "one request asking four creatures is one thing to see");
    const waiting = alertsSummary({ text: "Roll asked", name: "the DM asks for a Wisdom check and 1 more roll", waiting: true, requests: 2 }, []);
    assert.equal(waiting?.name, "Roll asked: the DM asks for a Wisdom check and 1 more roll. Close the sheet to answer.", "a roll to answer still says answer");
  });

  test("for the column's summary row beside the docked bar, each advice says to hide the bar", () => {
    const answer = alertsSummary({ text: "Roll asked", name: "the DM asks for a Wisdom check", waiting: true, requests: 1 }, [], "bar");
    assert.equal(answer?.name, "Roll asked: the DM asks for a Wisdom check. Hide the bar to answer.");
    const them = alertsSummary(null, [prompt("p1", "Thorn"), timeUp], "bar");
    assert.equal(them?.name, "Concentration save +1: Thorn makes a Concentration save, time is up. Hide the bar to see them.");
    const it = alertsSummary(null, [notice("n1", "Bless ended on Thorn.")], "bar");
    assert.equal(it?.name, "Bless ended on Thorn: Bless ended on Thorn. Hide the bar to see it.");
    // The sheet's three wordings stay as they were.
    assert.match(alertsSummary({ text: "Roll asked", name: "a roll", waiting: true, requests: 1 }, [])?.name ?? "", /Close the sheet to answer\.$/);
    assert.match(alertsSummary(null, [prompt("p1", "Thorn"), timeUp])?.name ?? "", /Close the sheet to see them\.$/);
    assert.match(alertsSummary(null, [timeUp])?.name ?? "", /Close the sheet to see it\.$/);
  });

  test("for the column's summary row on a screen whose tool options leave it under one card, each advice says to tap it", () => {
    const answer = alertsSummary({ text: "Roll asked", name: "the DM asks for a Wisdom check", waiting: true, requests: 1 }, [], "room");
    assert.equal(answer?.name, "Roll asked: the DM asks for a Wisdom check. Tap to answer.");
    const them = alertsSummary(null, [prompt("p1", "Thorn"), timeUp], "room");
    assert.equal(them?.name, "Concentration save +1: Thorn makes a Concentration save, time is up. Tap to see them.");
    const it = alertsSummary(null, [notice("n1", "Bless ended on Thorn.")], "room");
    assert.equal(it?.name, "Bless ended on Thorn: Bless ended on Thorn. Tap to see it.");
  });

  test("the newest notice leads when nothing else waits", () => {
    const s = alertsSummary(null, [notice("n1", "Bless ended on Thorn."), notice("n2", "Hex ended on Goblin.")]);
    assert.equal(s?.text, "Hex ended on Goblin");
    assert.deepEqual(s?.first, { kind: "notice", id: "n2" });
  });

  test("every name starts with the visible text and its count", () => {
    const s = alertsSummary(null, [prompt("p1", "Thorn"), prompt("p2", "Vex"), prompt("p3", "Goblin")]);
    assert.ok(s?.name.startsWith(`${s.text} ${s.more}`));
    assert.equal(s?.more, "+2");
  });
});

describe("dockFits", () => {
  // The bars and the turn band take 100 layout px in a fight, the toolbar 60 (3.2.1).
  const fight = { insetTop: 100, insetBottom: 60 };

  test("320 x 480 at 130% in a fight, no safe areas: the dock fits over a 153 px sheet", () => {
    assert.equal(dockFits({ height: 480 / 1.3, safeTop: 0, safeBottom: 0, ...fight }), true);
  });

  test("the same with 44 and 34 px safe areas leaves 131 px, short of the dock and the sheet's 120", () => {
    assert.equal(dockFits({ height: 480 / 1.3, safeTop: 44, safeBottom: 34, ...fight }), false);
  });

  test("real phones fit it at every interface size", () => {
    for (const scale of [0.85, 1, 1.15, 1.3]) {
      assert.equal(dockFits({ height: 667 / scale, safeTop: 0, safeBottom: 0, ...fight }), true, `375 x 667 at ${scale}`);
      assert.equal(dockFits({ height: 812 / scale, safeTop: 47, safeBottom: 34, ...fight }), true, `375 x 812 at ${scale}`);
    }
  });
});
