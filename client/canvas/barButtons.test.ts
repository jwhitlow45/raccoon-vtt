import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { barButtons, barCapacity, barShort, isCompanion, restFit, SPAN_SHORT_BAR_PX, type BarButtonInput, type BarRoom } from "./barButtons.ts";
import { DEFAULT_SPOT, placeBar, type Chrome } from "./barDock.ts";

const NOTHING: BarButtonInput = { dm: false, owner: false, undoMove: false, movedThisTurn: false, door: false, light: false, companion: false, attach: [] };
const DM: BarButtonInput = { ...NOTHING, dm: true };
const OWNER: BarButtonInput = { ...NOTHING, owner: true };

describe("the bar's rows", () => {
  test("Uses after Roll for the DM and an owner on a creature with combat uses, held while its block loads (docs/design-v1-combat-controls.md 6)", () => {
    assert.deepEqual(barButtons({ ...DM, uses: "yes", light: true }).play, ["conditions", "hidden", "multiSelect", "roll", "uses", "light"]);
    assert.deepEqual(barButtons({ ...OWNER, uses: "loading" }).play, ["conditions", "multiSelect", "roll", "uses"]);
    assert.deepEqual(barButtons({ ...DM, uses: "no" }).play, ["conditions", "hidden", "multiSelect", "roll"]);
    assert.deepEqual(barButtons({ ...NOTHING, uses: "yes" }).play, ["multiSelect"], "another player's creature shows none");
  });


  test("the DM on a monster, alive or dead: the steady line with Roll after Multi-select, then the setup and destructive row, with no Move bar or Reset bar position", () => {
    assert.deepEqual(barButtons(DM), {
      passing: [],
      play: ["conditions", "hidden", "multiSelect", "roll"],
      less: ["locked", "duplicate", "delete"],
    });
    assert.deepEqual(barButtons({ ...DM, undoMove: true, movedThisTurn: true, light: true }), {
      passing: ["undoMove", "countLeg"],
      play: ["conditions", "hidden", "multiSelect", "roll", "light"],
      less: ["locked", "duplicate", "delete"],
    });
  });

  test("the DM on a creature a player plays, such as a companion: Roll after Multi-select in Request a roll's place, and Delete, never Dismiss", () => {
    const rows = barButtons({ ...DM, companion: true, light: true });
    assert.deepEqual(rows.play, ["conditions", "hidden", "multiSelect", "roll", "light"]);
    assert.equal([...rows.passing, ...rows.play, ...rows.less].includes("requestRoll" as never), false);
    assert.deepEqual(rows.less, ["locked", "duplicate", "delete"]);
  });

  test("a player on their own character: Undo move, Doesn't count and the door on the passing line, then Conditions, Multi-select, Roll and Light, and no less-often row", () => {
    assert.deepEqual(barButtons(OWNER), { passing: [], play: ["conditions", "multiSelect", "roll"], less: [] });
    assert.deepEqual(barButtons({ ...OWNER, undoMove: true, movedThisTurn: true, door: true, light: true }), {
      passing: ["undoMove", "countLeg", "door"],
      play: ["conditions", "multiSelect", "roll", "light"],
      less: [],
    });
  });

  test("Attach follows Light on the steady line, and Get off comes before it on a carried token (docs/design-v1-attach.md 4.1, 4.3)", () => {
    assert.deepEqual(barButtons({ ...DM, light: true, attach: ["attach"] }).play, ["conditions", "hidden", "multiSelect", "roll", "light", "attach"]);
    assert.deepEqual(barButtons({ ...OWNER, attach: ["detach"] }).play, ["conditions", "multiSelect", "roll", "detach"]);
    assert.deepEqual(barButtons({ ...OWNER, attach: ["detach", "attach"] }).play, ["conditions", "multiSelect", "roll", "detach", "attach"]);
    // A player who may move another's token may attach it, or let it go, without owning it.
    assert.deepEqual(barButtons({ ...NOTHING, attach: ["attach"] }).play, ["multiSelect", "attach"]);
    assert.equal(barButtons(DM).play.includes("attach"), false);
  });

  test("a player on their companion: Dismiss in Delete's place", () => {
    assert.deepEqual(barButtons({ ...OWNER, companion: true }).less, ["dismiss"]);
  });

  test("a player on another's creature: Undo move when they could move it, and Multi-select, with no Roll", () => {
    assert.deepEqual(barButtons(NOTHING), { passing: [], play: ["multiSelect"], less: [] });
    assert.deepEqual(barButtons({ ...NOTHING, undoMove: true, movedThisTurn: true, door: true, light: true, companion: true }), {
      passing: ["undoMove"],
      play: ["multiSelect"],
      less: [],
    });
  });

  test("Conditions, Hidden and Multi-select lead the steady line for every viewer, and nothing that comes and goes joins it", () => {
    const passingIds = ["undoMove", "countLeg", "door"];
    for (const who of [DM, OWNER, NOTHING]) {
      for (const extra of [{}, { undoMove: true, movedThisTurn: true, door: true }, { companion: true, light: true }]) {
        const rows = barButtons({ ...who, ...extra });
        const lead = rows.play.filter((id) => id === "conditions" || id === "hidden" || id === "multiSelect");
        assert.deepEqual(rows.play.slice(0, lead.length), lead);
        assert.equal(rows.play.some((id) => passingIds.includes(id)), false);
      }
    }
  });

  test("Roll comes right after Multi-select for the DM and an owner, on every creature, and never for anyone else", () => {
    for (const extra of [{}, { companion: true }, { light: true, undoMove: true, movedThisTurn: true }]) {
      for (const who of [DM, OWNER]) {
        const play = barButtons({ ...who, ...extra }).play;
        assert.equal(play[play.indexOf("multiSelect") + 1], "roll");
      }
      assert.equal(barButtons({ ...NOTHING, ...extra }).play.includes("roll"), false);
    }
  });

  test("a door is offered only on a player's own token, and Details is in neither row", () => {
    assert.equal(barButtons({ ...DM, door: true }).passing.includes("door"), false);
    for (const input of [DM, OWNER, NOTHING, { ...DM, undoMove: true, light: true, companion: true }]) {
      const rows = barButtons(input);
      assert.equal([...rows.passing, ...rows.play, ...rows.less].includes("details" as never), false);
    }
  });

  test("a companion is told by its field", () => {
    assert.equal(isCompanion({ id: "t" }), false);
    assert.equal(isCompanion({ companion: undefined }), false);
    assert.equal(isCompanion({ companion: { of: "c1", turn: "shared" } }), true);
  });
});

/** A phone's chrome at full size, without Multi-select's bar: the top bar, the toolbar and the safe areas. */
function chrome(input: { side: number; bottom: number; sheet?: number }): Chrome {
  const toolbar = 60 + input.bottom;
  return { top: 52, bottom: toolbar, controls: toolbar, toolbar, safe: { top: 0, right: input.side, bottom: input.bottom, left: input.side }, sheet: input.sheet ?? 0 };
}

const desk = (height: number, column: BarRoom["column"] = null): BarRoom => ({
  layout: { width: 1280, height },
  viewport: { width: 920, height },
  chrome: chrome({ side: 0, bottom: 0 }),
  foot: 0,
  anchor: null,
  spot: DEFAULT_SPOT,
  column,
});

describe("a short bar", () => {
  test("is a capacity under 300", () => {
    assert.equal(barCapacity(desk(427)), 299);
    assert.equal(barShort(desk(427)), true);
    assert.equal(barCapacity(desk(428)), 300);
    assert.equal(barShort(desk(428)), false);
    assert.equal(barShort(desk(800)), false);
  });

  test("a phone held sideways at 844 x 390 (241) and a large one at 932 x 430 (281), with their insets", () => {
    const phone: BarRoom = { ...desk(390), layout: { width: 844, height: 390 }, viewport: { width: 844, height: 390 }, chrome: chrome({ side: 47, bottom: 21 }) };
    assert.equal(barCapacity(phone), 241);
    assert.equal(barShort(phone), true);
    // The wide layout: the side panel takes 360 of 932, and its own 59 px inset with it.
    const large: BarRoom = { ...desk(430), layout: { width: 932, height: 430 }, viewport: { width: 572, height: 430 }, chrome: { ...chrome({ side: 59, bottom: 21 }), safe: { top: 0, right: 0, bottom: 21, left: 59 } } };
    assert.equal(barCapacity(large), 281);
    assert.equal(barShort(large), true);
  });

  test("at 130%: 844 x 390 docks at 151, and 480 x 320 opens compact and is short", () => {
    const at130: BarRoom = { ...desk(300), layout: { width: 649, height: 300 }, viewport: { width: 649, height: 300 }, chrome: chrome({ side: 47, bottom: 21 }) };
    assert.equal(barCapacity(at130), 151);
    const small: BarRoom = { ...desk(246), layout: { width: 369, height: 246 }, viewport: { width: 369, height: 246 }, chrome: chrome({ side: 47, bottom: 21 }) };
    assert.equal(placeBar({ ...small, height: 200 })?.mode, "compact");
    assert.equal(barShort(small), true);
  });

  test("a resized window's height caps its capacity: 299 is short and 300 not, a cap above the room leaves the room deciding, and a touch device or the compact overlay ignores it (docs/design-v1-token-window.md 5.8)", () => {
    const desk800 = { ...desk(800), width: 316 };
    assert.equal(barCapacity({ ...desk800, resizable: true, size: { h: 299 } }), 299);
    assert.equal(barShort({ ...desk800, resizable: true, size: { h: 299 } }), true);
    assert.equal(barCapacity({ ...desk800, resizable: true, size: { h: 300 } }), 300);
    assert.equal(barShort({ ...desk800, resizable: true, size: { h: 300 } }), false);
    // The room, less the handle's 4 px at the top.
    assert.equal(barCapacity({ ...desk800, resizable: true, size: { h: 4096 } }), 800 - 52 - 60 - 16 - 4);
    assert.equal(barCapacity({ ...desk800, resizable: false, size: { h: 200 } }), 800 - 52 - 60 - 16);
    const small: BarRoom = { ...desk(246), layout: { width: 369, height: 246 }, viewport: { width: 369, height: 246 }, chrome: chrome({ side: 47, bottom: 21 }) };
    assert.equal(barCapacity({ ...small, resizable: true, size: { h: 40 } }), barCapacity(small));
  });

  test("a docked bar on a desktop is short while tall alert cards push it down, and not once they go", () => {
    const column = { top: 60, content: 640, first: 400 };
    // Less the room kept for the column's fade under its first card (barDock.ts COLUMN_FADE).
    assert.equal(barCapacity(desk(800, column)), 264 - 48);
    assert.equal(barShort(desk(800, column)), true);
    assert.equal(barShort(desk(800, null)), false);
  });

  test("a spanning bar is short or not by the screen alone, wherever its token stands, from the room a token mid-screen leaves, so Apply keeps one place in view", () => {
    // Phones held upright, with a notch and a home bar, out of a fight and with the 48 px turn band.
    const cases = [
      { width: 390, height: 844, band: 0, short: false, label: "390 x 844" },
      { width: 390, height: 844, band: 48, short: false, label: "390 x 844 with the band" },
      { width: 300, height: 649, band: 0, short: true, label: "390 x 844 at 130%" },
      { width: 300, height: 649, band: 48, short: true, label: "390 x 844 at 130% with the band" },
      { width: 320, height: 548, band: 0, short: true, label: "320 x 548" },
    ];
    for (const c of cases) {
      const room = (y: number): BarRoom => ({ ...desk(c.height), layout: { width: c.width, height: c.height }, viewport: { width: c.width, height: c.height }, chrome: { ...chrome({ side: 0, bottom: 34 }), top: 52 + 47 + c.band }, anchor: { x: c.width / 2, y } });
      // A token near the top, mid-screen and near the foot.
      const answers = [160 + c.band, c.height / 2, c.height - 140].map((y) => barShort(room(y)));
      assert.deepEqual(answers, [c.short, c.short, c.short], `${c.label}: the token's place changed the layout, or it is ${c.short ? "full" : "short"}`);
      assert.equal(barShort({ ...room(c.height / 2), anchor: null }), c.short, `${c.label}: it needs no token to say so`);
      // The capacity is the least room any token's bar gets: no token leaves its bar less.
      const capacity = barCapacity(room(c.height / 2))!;
      for (let y = 120; y < c.height - 120; y += 20) {
        const placed = placeBar({ ...room(y), height: Number.POSITIVE_INFINITY });
        assert.ok(placed && placed.hang.room >= capacity - 1, `${c.label}: a token at ${y} leaves its bar ${placed?.hang.room} px, under the capacity ${capacity}`);
      }
      // Where it is full, that least room still shows the full layout's Apply.
      if (!c.short) assert.ok(capacity >= SPAN_SHORT_BAR_PX, `${c.label}: ${capacity} px leaves Apply out of view`);
    }
  });

  test("a moved bar hung by its bottom, under alerts, gives one answer whatever its content, so More stats never flips it", () => {
    const room: BarRoom = { ...desk(800, { top: 60, content: 640, first: 380 }), spot: { corner: "br", x: 40, y: 60 } };
    const small = { ...room, height: 220 };
    const tall = { ...room, height: 350 };
    // The content does move such a bar: shareLane keeps a taller content's height by moving it down.
    assert.notEqual(placeBar(small)?.hang.room, placeBar(tall)?.hang.room);
    assert.equal(barShort(small), barShort(tall));
    assert.equal(barCapacity(small), barCapacity(tall));
  });
});

/*
 * The strip's drawn widths in layout px at 100% (docs/design-v1-bar-compact.md
 * Appendix B.2). The lead is the toggle, Apply and their two 4 px gaps, its
 * field counted apart at its 56 px least: 174 in all.
 */
const DRAWN = { mode: 118, crit: 51, roll: 51, useRoll: 65, uses: 60, details: 72, hidden: 98, conditions: 99, multiSelect: 108, countLeg: 121, undoMove: 44 } as const;
const GAP = 4;
const FIELD_MIN = 56;
/** The quick row's inner width at each phone (B.2). */
const INNER = { p390: 348, p375: 333, p440: 398, p320at130: 205, p390at130: 258, p320: 278 } as const;
const pick = (...ids: (keyof typeof DRAWN)[]) => Object.fromEntries(ids.map((id) => [id, DRAWN[id]]));

describe("the resting strip's quick row (docs/design-v1-bar-compact.md 3.3)", () => {
  test("the measured fits of B.2 for the DM or an owner on a creature with HP, at the six phone sizes", () => {
    const owner = pick("mode", "conditions", "roll", "multiSelect");
    assert.deepEqual(restFit(owner, INNER.p390, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    assert.deepEqual(restFit(owner, INNER.p375, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    assert.deepEqual(restFit({ ...owner, uses: DRAWN.uses }, INNER.p440, GAP, FIELD_MIN), ["mode", "conditions", "roll", "uses"]);
    assert.deepEqual(restFit(owner, INNER.p320at130, GAP, FIELD_MIN), ["mode"]);
    // Conditions (99) is skipped, and Roll after it still fits.
    assert.deepEqual(restFit(owner, INNER.p390at130, GAP, FIELD_MIN), ["mode", "roll"]);
    assert.deepEqual(restFit(owner, INNER.p320, GAP, FIELD_MIN), ["mode", "conditions"]);
  });

  test("fitting goes by its own order, apart from the order shown: Crit and Conditions before Roll's place, then Use 9, Multi-select, Uses, Hidden and Details", () => {
    const all = pick("mode", "crit", "useRoll", "conditions", "roll", "multiSelect", "uses", "hidden", "details");
    // At 0 HP: Crit comes before Conditions, and Roll no longer fits at 390.
    assert.deepEqual(restFit(pick("mode", "crit", "conditions", "roll"), INNER.p390, GAP, FIELD_MIN), ["mode", "crit", "conditions"]);
    assert.deepEqual(restFit(pick("mode", "crit", "conditions", "roll"), INNER.p440, GAP, FIELD_MIN), ["mode", "crit", "conditions", "roll"]);
    // Use 9 shows before Conditions but fits after Roll: a room that takes only one of them keeps Conditions and Roll.
    assert.deepEqual(restFit(pick("mode", "useRoll", "conditions", "roll"), 340, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    assert.deepEqual(restFit(pick("mode", "useRoll", "conditions", "roll"), 401, GAP, FIELD_MIN), ["mode", "useRoll", "conditions", "roll"]);
    // With room for all, every candidate shows, in the order shown.
    assert.deepEqual(restFit(all, 2000, GAP, FIELD_MIN), ["mode", "crit", "useRoll", "conditions", "roll", "multiSelect", "uses", "hidden", "details"]);
  });

  test("a passing action takes Roll's place where it fits whole there, and never puts Conditions out", () => {
    // Undo move as its 44 px arrow, at 390 and 375 (D-261024-12).
    const undo = pick("mode", "conditions", "undoMove", "roll", "multiSelect");
    assert.deepEqual(restFit(undo, INNER.p390, GAP, FIELD_MIN), ["mode", "conditions", "undoMove"]);
    assert.deepEqual(restFit(undo, INNER.p375, GAP, FIELD_MIN), ["mode", "conditions", "undoMove"]);
    // Doesn't count (121) does not fit Roll's place at 390, so Roll stays.
    assert.deepEqual(restFit(pick("mode", "conditions", "countLeg", "roll"), INNER.p390, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    // Nothing fits after the lead at 320 x 568 at 130%: Undo move waits behind Expand.
    assert.deepEqual(restFit(undo, INNER.p320at130, GAP, FIELD_MIN), ["mode"]);
    // Only the first passing action is offered the place: Doesn't count never stands in for an Undo move that does not fit.
    assert.deepEqual(restFit({ ...pick("mode", "conditions", "roll"), undoMove: 103, countLeg: 40 }, INNER.p375, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    // With no Roll, as for a player on another's creature, the passing action still takes the place.
    assert.deepEqual(restFit(pick("undoMove", "multiSelect", "details"), INNER.p390, GAP, FIELD_MIN), ["undoMove", "multiSelect", "details"]);
    // Whatever passes, Conditions shows wherever it does without one.
    for (const room of Object.values(INNER)) {
      for (const passing of ["undoMove", "countLeg"] as const) {
        const without = restFit(pick("mode", "crit", "conditions", "roll"), room, GAP, FIELD_MIN).includes("conditions");
        assert.equal(restFit(pick("mode", "crit", "conditions", passing, "roll"), room, GAP, FIELD_MIN).includes("conditions"), without, `${passing} at ${room}`);
      }
    }
  });

  test("one that does not fit is skipped, and a narrower one after it may still fit", () => {
    // At 440, Multi-select (108) does not fit the 66 px Roll leaves, and Uses (60) does.
    assert.deepEqual(restFit(pick("mode", "conditions", "roll", "multiSelect", "uses"), INNER.p440, GAP, FIELD_MIN), ["mode", "conditions", "roll", "uses"]);
    // The DM on the barrel at 375: Conditions, Doesn't count in Roll's place, then Hidden in the room Multi-select leaves.
    assert.deepEqual(restFit({ ...pick("conditions", "roll", "multiSelect", "hidden", "details"), countLeg: 121 }, INNER.p375, GAP, FIELD_MIN), ["conditions", "countLeg", "hidden"]);
  });

  test("the field counts at its 56 px least: at 72, Roll no longer fits at 375 (R14)", () => {
    const owner = pick("mode", "conditions", "roll");
    assert.deepEqual(restFit(owner, INNER.p375, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    assert.deepEqual(restFit(owner, INNER.p375, GAP, 72), ["mode", "conditions"]);
  });

  test("a candidate fits whole or not at all, gaps counted between candidates only", () => {
    // 174 + 4 + 99 + 4 + 51 = 332.
    const owner = pick("mode", "conditions", "roll");
    assert.deepEqual(restFit(owner, 332, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    assert.deepEqual(restFit(owner, 331.9, GAP, FIELD_MIN), ["mode", "conditions"]);
    // With no lead, the first candidate takes no gap before it.
    assert.deepEqual(restFit(pick("multiSelect"), 108, GAP, FIELD_MIN), ["multiSelect"]);
    assert.deepEqual(restFit(pick("multiSelect"), 107.9, GAP, FIELD_MIN), []);
  });

  test("no room: the lead alone shows, its field giving up room, and with no lead nothing does", () => {
    assert.deepEqual(restFit(pick("mode", "conditions", "roll"), 100, GAP, FIELD_MIN), ["mode"]);
    assert.deepEqual(restFit(pick("mode", "conditions", "roll"), 0, GAP, FIELD_MIN), ["mode"]);
    assert.deepEqual(restFit(pick("conditions", "roll", "multiSelect"), 0, GAP, FIELD_MIN), []);
    assert.deepEqual(restFit({}, INNER.p390, GAP, FIELD_MIN), []);
  });

  test("an id the strip does not know fits after the known ones, in the order given", () => {
    assert.deepEqual(restFit({ mode: 118, extra: 40, conditions: 99, other: 30 }, 360, GAP, FIELD_MIN), ["mode", "conditions", "extra", "other"]);
    // It never takes room from a known one: here only Conditions fits after the lead.
    assert.deepEqual(restFit({ extra: 60, mode: 118, conditions: 99 }, 280, GAP, FIELD_MIN), ["mode", "conditions"]);
  });
});

describe("a quick row candidate that draws nothing", () => {
  test("is left out, so an empty passing action never takes Roll's place", () => {
    // A door button with no door in reach, or Doesn't count on a resize's leg, draws nothing.
    assert.deepEqual(restFit({ ...pick("mode", "conditions", "roll"), door: 0 }, INNER.p375, GAP, FIELD_MIN), ["mode", "conditions", "roll"]);
    assert.deepEqual(restFit({ ...pick("mode", "conditions", "roll"), countLeg: 0, door: 60 }, INNER.p390, GAP, FIELD_MIN), ["mode", "conditions", "door"]);
    assert.deepEqual(restFit({ multiSelect: 0, details: 72 }, INNER.p390, GAP, FIELD_MIN), ["details"]);
    // The lead shows whatever its measure.
    assert.deepEqual(restFit({ mode: 0 }, INNER.p390, GAP, FIELD_MIN), ["mode"]);
  });
});
