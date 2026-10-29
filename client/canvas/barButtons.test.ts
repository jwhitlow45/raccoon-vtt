import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { barButtons, barCapacity, barShort, critSent, groupRestButtons, isCompanion, nextRestMode, restButtons, restFit, restStatus, SPAN_SHORT_BAR_PX, type BarButtonInput, type BarRoom, type EntryStatus, type RestFit, type RestStatusInput } from "./barButtons.ts";
import { deadCase, type HpTarget } from "../features/tokens/groupHp.ts";
import { parseHpInput } from "../features/tokens/hpInput.ts";
import { DEFAULT_SPOT, freeArea, placeBar, spanRoomAtWorst, type Chrome } from "./barDock.ts";

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
      // The expanded reach, F - 128, holds the full layout there now (docs/design-v1-bar-compact.md 9.1, BC-OPUS-9): 312, 264 and 211.
      { width: 300, height: 649, band: 0, short: false, label: "390 x 844 at 130%" },
      { width: 300, height: 649, band: 48, short: false, label: "390 x 844 at 130% with the band" },
      { width: 320, height: 548, band: 0, short: false, label: "320 x 548" },
    ];
    for (const c of cases) {
      const room = (y: number): BarRoom => ({ ...desk(c.height), layout: { width: c.width, height: c.height }, viewport: { width: c.width, height: c.height }, chrome: { ...chrome({ side: 0, bottom: 34 }), top: 52 + 47 + c.band }, anchor: { x: c.width / 2, y } });
      // A token near the top, mid-screen and near the foot.
      const answers = [160 + c.band, c.height / 2, c.height - 140].map((y) => barShort(room(y)));
      assert.deepEqual(answers, [c.short, c.short, c.short], `${c.label}: the token's place changed the layout, or it is ${c.short ? "full" : "short"}`);
      assert.equal(barShort({ ...room(c.height / 2), anchor: null }), c.short, `${c.label}: it needs no token to say so`);
      // The resting strip stands in one place whatever the token, and the capacity is its expanded reach, which reads no token.
      const capacity = barCapacity(room(c.height / 2))!;
      const mid = placeBar({ ...room(c.height / 2), height: Number.POSITIVE_INFINITY });
      for (let y = 120; y < c.height - 120; y += 20) {
        assert.deepEqual(placeBar({ ...room(y), height: Number.POSITIVE_INFINITY }), mid, `${c.label}: a token at ${y} moved the strip`);
      }
      assert.equal(capacity, c.height - (52 + 47 + c.band) - 94 - 16 - 128, `${c.label}: the expanded reach`);
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

describe("an upright phone's capacity follows the mode its frame draws in (docs/design-v1-bar-compact.md 2 and 9.4)", () => {
  // 320 x 568 at 130%: the free area runs 60 to 369, 309 tall, and a 170 px roll card at the foot takes it to 139.
  // The token stands low, where today's bar would get more room than the screen's least, so the capacity shows it reads the screen alone.
  const layout = { width: 246, height: 437 };
  const room: BarRoom = { ...desk(437), layout, viewport: layout, chrome: chrome({ side: 0, bottom: 0 }), foot: 170, anchor: { x: 123, y: 300 } };
  const free = freeArea(layout, room.chrome, room.foot);

  test("the first render with a card standing, no mode held yet, gets the strip's layout, as placeBar's opening rule gives the strip (review BC-OPUS-33)", () => {
    assert.equal(free.height, 139);
    const standing: BarRoom = { ...room, cardAt: "foot" };
    assert.equal(placeBar({ ...standing, height: 200 })?.mode, "span");
    assert.equal(barCapacity(standing), spanRoomAtWorst(free, layout));
    // Counted as today, the card's foot makes the bar compact, with the overlay's own capacity.
    assert.equal(placeBar({ ...room, height: 200 })?.mode, "compact");
    assert.notEqual(barCapacity(room), spanRoomAtWorst(free, layout));
  });

  test("a card summoned onto the toolbar or the screen counts its foot, as the opening rule does", () => {
    for (const cardAt of ["toolbar", "screen"] as const) {
      assert.equal(placeBar({ ...room, cardAt, height: 200 })?.mode, "compact", cardAt);
      assert.equal(barCapacity({ ...room, cardAt }), barCapacity(room), cardAt);
    }
  });

  test("an upright phone's capacity is the expanded bar's reach: two thirds of the screen at most, and the free area less 128 (5.1, 9.1)", () => {
    const phone = { width: 390, height: 844 };
    const upright: BarRoom = { ...desk(844), layout: phone, viewport: phone, chrome: chrome({ side: 0, bottom: 0 }), foot: 0 };
    const uprightFree = freeArea(phone, upright.chrome, 0);
    // 716 tall, so 588 by the free area alone, and 563 by two thirds of the screen.
    assert.equal(uprightFree.height, 716);
    assert.equal(barCapacity(upright), Math.min(Math.round((844 * 2) / 3), 716 - 128));
    assert.equal(barCapacity(upright), spanRoomAtWorst(uprightFree, phone));
  });

  test("a held strip whose roll card folds for it reads the free area the strip places by, without the card (review BB-OPUS-3)", () => {
    // The card yields (stripSqueezed), so the strip stands on the toolbar: restFoot 0, as expandOffered and expandedRoom read it.
    const folded: BarRoom = { ...room, heldMode: "span", restFoot: 0 };
    const stripFree = freeArea(layout, room.chrome, 0);
    assert.equal(stripFree.height, 309);
    assert.equal(barCapacity(folded), spanRoomAtWorst(stripFree, layout));
    assert.equal(barCapacity(folded), 181);
    // Without a fold, the card's foot counts.
    assert.equal(barCapacity({ ...room, heldMode: "span" }), spanRoomAtWorst(free, layout));
  });

  test("a held strip keeps the strip's layout as its free area falls under 148, and lets go of it on its side (review BC-OPUS-32)", () => {
    const held: BarRoom = { ...room, heldMode: "span" };
    assert.equal(barCapacity(held), spanRoomAtWorst(free, layout));
    const side: BarRoom = { ...held, layout: { width: 437, height: 246 }, viewport: { width: 437, height: 246 }, foot: 0 };
    assert.equal(barCapacity(side), barCapacity({ ...side, heldMode: null }));
  });
});

describe("the strip's candidates by role and token (docs/design-v1-bar-compact.md 3.3 and 9.4)", () => {
  test("the DM on a creature with HP: the lead, Conditions, Roll, Multi-select and Hidden, with the passing actions by Roll's place", () => {
    assert.deepEqual(restButtons({ ...DM, lead: true }), ["mode", "conditions", "roll", "multiSelect", "hidden"]);
    assert.deepEqual(restButtons({ ...DM, lead: true, undoMove: true, movedThisTurn: true }), ["mode", "conditions", "undoMove", "countLeg", "roll", "multiSelect", "hidden"]);
  });

  test("an owner: the lead, Conditions, Roll and Multi-select, the door and Undo move by Roll's place, and Uses after Multi-select (D-261024-11)", () => {
    assert.deepEqual(restButtons({ ...OWNER, lead: true }), ["mode", "conditions", "roll", "multiSelect"]);
    assert.deepEqual(restButtons({ ...OWNER, lead: true, undoMove: true, door: true }), ["mode", "conditions", "undoMove", "door", "roll", "multiSelect"]);
    assert.deepEqual(restButtons({ ...OWNER, lead: true, uses: "yes" }), ["mode", "conditions", "roll", "multiSelect", "uses"]);
    // Held while its block loads, as lane B's rule says, so the fit counts it.
    assert.deepEqual(restButtons({ ...OWNER, lead: true, uses: "loading" }), ["mode", "conditions", "roll", "multiSelect", "uses"]);
    assert.deepEqual(restButtons({ ...DM, lead: true, uses: "yes" }), ["mode", "conditions", "roll", "multiSelect", "uses", "hidden"]);
  });

  test("a player on another's creature: Multi-select and Details, or the lead and Multi-select where players apply damage", () => {
    assert.deepEqual(restButtons({ ...NOTHING, lead: false }), ["multiSelect", "details"]);
    assert.deepEqual(restButtons({ ...NOTHING, lead: false, undoMove: true }), ["undoMove", "multiSelect", "details"]);
    assert.deepEqual(restButtons({ ...NOTHING, lead: true }), ["mode", "multiSelect"]);
  });

  test("a token with no HP: no lead, and Details last", () => {
    assert.deepEqual(restButtons({ ...DM, lead: false }), ["conditions", "roll", "multiSelect", "hidden", "details"]);
    assert.deepEqual(restButtons({ ...OWNER, lead: false }), ["conditions", "roll", "multiSelect", "details"]);
  });

  test("Light, Attach, Get off, Locked, Duplicate, Delete and Dismiss stay behind Expand", () => {
    const rare = ["light", "attach", "detach", "locked", "duplicate", "delete", "dismiss"];
    for (const who of [DM, OWNER, NOTHING]) {
      for (const lead of [true, false]) {
        const ids = restButtons({ ...who, lead, light: true, companion: true, attach: ["detach", "attach"] });
        assert.deepEqual(ids.filter((id) => rare.includes(id)), [], `${JSON.stringify(who)} ${lead}`);
      }
    }
  });

  test("a group: its lead, Conditions, Roll (the DM), Multi-select and Hidden (the DM), and Undo move by Roll's place", () => {
    assert.deepEqual(groupRestButtons({ dm: true, lead: true, conditions: true, undoMove: false }), ["mode", "conditions", "roll", "multiSelect", "hidden"]);
    assert.deepEqual(groupRestButtons({ dm: false, lead: true, conditions: true, undoMove: false }), ["mode", "conditions", "multiSelect"]);
    assert.deepEqual(groupRestButtons({ dm: false, lead: false, conditions: false, undoMove: false }), ["multiSelect"]);
    assert.deepEqual(groupRestButtons({ dm: true, lead: true, conditions: true, undoMove: true }), ["mode", "conditions", "undoMove", "roll", "multiSelect", "hidden"]);
    assert.deepEqual(groupRestButtons({ dm: false, lead: true, conditions: true, undoMove: true }), ["mode", "conditions", "undoMove", "multiSelect"]);
  });

  test("the mode toggle switches Damage and Heal, and takes Set or Temp back to Damage", () => {
    assert.equal(nextRestMode("damage"), "heal");
    assert.equal(nextRestMode("heal"), "damage");
    assert.equal(nextRestMode("set"), "damage");
    assert.equal(nextRestMode("temp"), "damage");
  });
});

/*
 * A stand-in for the browser's measure: 7 px a letter, near the 13 px
 * status font's digits (Appendix B.4), wrapped at spaces as the note's
 * text wraps, a word longer than a line broken where it must.
 */
function linesAt(text: string, width: number): number {
  const perLine = Math.floor(width / 7);
  let lines = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    let w = [...word].length;
    if (used > 0 && used + 1 + w <= perLine) {
      used += 1 + w;
      continue;
    }
    if (used > 0) lines++;
    while (w > perLine) {
      w -= perLine;
      lines++;
    }
    used = w;
  }
  return lines;
}

/** The strip at 320 x 568 at 130% (B.4): a 109 px title, a 206 px note. */
const AT320: RestFit = { line: (t) => linesAt(t, 109) <= 1, title: (t) => linesAt(t, 109) <= 2, note: (t) => linesAt(t, 206) <= 2 };
/** The strip at 390 x 844: a 252 px title. */
const AT390: RestFit = { line: (t) => linesAt(t, 252) <= 1, title: (t) => linesAt(t, 252) <= 2, note: (t) => linesAt(t, 350) <= 2 };

const QUIET: EntryStatus = { error: null, dead: null, preview: null, typed: false, crit: false, reach: 1, left: [], standing: null };
const status = (over: Partial<RestStatusInput>, fit: RestFit = AT390) => restStatus({ ...QUIET, critInRow: false, idle: ["AC 14", "HP 24/24"], fit, ...over });
/** What the strip shows, wherever it shows it. */
const said = (over: Partial<RestStatusInput>, fit: RestFit = AT390) => {
  const s = status(over, fit);
  return s.sentence?.text ?? s.line.text;
};
const LONG = "Aldric Thornwood, Sworn Warden of the Sunken Citadel and Keeper of the Last Fire";

function hpTarget(name: string, over: Partial<HpTarget> = {}): HpTarget {
  return { holder: `token:${name}`, target: { tokenId: name }, name, access: "all", atZero: false, dead: false, max: 7, ...over };
}

describe("the strip's status line (docs/design-v1-bar-compact.md 3.3)", () => {
  test("the first that applies: an error, a dead line, the preview, a kept crit, a group's standing note, then the vitals", () => {
    const all: Partial<RestStatusInput> = { error: "Use a positive number, or start with + or -.", dead: { kind: "heal", name: "Thorn", dm: true }, preview: "7 damage", typed: true, crit: true, standing: "Damage and healing only, since some of them are not yours." };
    assert.equal(said(all), "Use a positive number, or start with + or -.");
    assert.equal(status(all).line.error || status(all).sentence?.error, true, "an error shows in the error tone");
    assert.equal(said({ ...all, error: null }), "Healing does nothing while Thorn is dead. Revive first.");
    assert.equal(said({ ...all, error: null, dead: null }), "7 damage, Critical Hit");
    assert.equal(said({ ...all, error: null, dead: null, preview: null, typed: false }), "Critical Hit");
    assert.equal(said({ ...all, error: null, dead: null, preview: null, typed: false, crit: false }), "Damage and healing only, since some of them are not yours.");
    assert.equal(said({}), "AC 14 · HP 24/24");
    assert.equal(status({}).line.error, false);
  });

  test("a kept crit with valid text is named while the Crit toggle is not in the row, and not where it is", () => {
    assert.equal(said({ preview: "7 damage", typed: true, crit: true }, AT320), "7 damage, Critical Hit");
    assert.equal(said({ preview: "7 damage", typed: true, crit: true, critInRow: true }), "7 damage");
    assert.equal(said({ typed: false, crit: true, critInRow: true }), "AC 14 · HP 24/24");
    // Text that does not parse yet: the field is not empty, so no "Critical Hit" line, and the vitals stay.
    assert.equal(said({ typed: true, crit: true }), "AC 14 · HP 24/24");
  });

  test("a sentence that fits one line stands under the name, which stays", () => {
    assert.deepEqual(status({ preview: "7 damage", typed: true }), { line: { text: "7 damage", error: false }, sentence: null, full: "7 damage" });
    // A group's standing note waits while text that does not parse yet is in the field.
    assert.equal(said({ standing: "Damage and healing only, since some of them are not yours.", typed: true }), "AC 14 · HP 24/24");
  });

  test("a crit kept into Heal, or once the target is above 0 HP, is never sent, so never named", () => {
    const heal = parseHpInput("5", "heal");
    assert.equal(critSent({ crit: true, atZero: true, mode: "heal", preview: heal }), false);
    assert.equal(critSent({ crit: true, atZero: true, mode: "heal", preview: null }), false);
    // Typed math under Damage that heals.
    assert.equal(critSent({ crit: true, atZero: true, mode: "damage", preview: parseHpInput("+5", "damage") }), false);
    assert.equal(critSent({ crit: true, atZero: false, mode: "damage", preview: parseHpInput("7", "damage") }), false);
    assert.equal(critSent({ crit: true, atZero: true, mode: "damage", preview: parseHpInput("7", "damage") }), true);
    assert.equal(critSent({ crit: true, atZero: true, mode: "heal", preview: parseHpInput("-7", "heal") }), true);
    assert.equal(critSent({ crit: false, atZero: true, mode: "damage", preview: null }), false);
    for (const preview of [heal, null]) {
      const crit = critSent({ crit: true, atZero: true, mode: "heal", preview });
      assert.equal(said({ preview: preview?.ok ? preview.summary : null, typed: preview !== null, crit }).includes("Critical Hit"), false);
    }
  });

  test("a group's preview names whom it leaves out, after the crit, and its standing note shows with the field empty", () => {
    assert.equal(said({ preview: "7 damage", typed: true, reach: 3, left: ["Goblin 2"] }), "7 damage, to each of 3, not Goblin 2");
    assert.equal(said({ preview: "7 damage", typed: true, reach: 3, left: ["Goblin 2"], crit: true }), "7 damage, Critical Hit, to each of 3, not Goblin 2");
    assert.equal(said({ preview: "Heal 5", typed: true, reach: 2, left: ["Goblin 2", "Goblin 3"] }), "Heal 5, to each of 2, not Goblin 2, Goblin 3");
    assert.equal(said({ standing: "Leaves out Goblin 2: you cannot change their HP." }), "Leaves out Goblin 2: you cannot change their HP.");
    assert.equal(said({ standing: "Leaves out Goblin 2: you cannot change their HP.", preview: "7 damage", typed: true, reach: 3, left: ["Goblin 2"] }), "7 damage, to each of 3, not Goblin 2");
  });

  test("FL3-OPUS-4: group reach and exclusions precede defense words", () => {
    assert.equal(status({ preview: "10 Fire damage", defenseWords: ["Goblin: Resists Fire: 5"], typed: true, reach: 3, left: ["Goblin 2"], crit: true }).full,
      "10 Fire damage, Critical Hit, to each of 3, not Goblin 2. Goblin: Resists Fire: 5");
  });

  test("at 320 x 568 at 130%, the group's preview takes the note, its full sentence kept, and the line keeps the vitals", () => {
    const s = status({ preview: "7 damage", typed: true, reach: 3, left: ["Goblin 2"] }, AT320);
    assert.equal(s.sentence?.place, "note");
    assert.equal(s.sentence?.text, "7 damage, to each of 3, not Goblin 2");
    assert.equal(s.full, "7 damage, to each of 3, not Goblin 2");
    assert.equal(s.line.text, "HP 24/24");
    // One that fits the title's two lines takes them in the name's place.
    const crit = status({ preview: "7 damage", typed: true, crit: true }, AT320);
    assert.deepEqual(crit.sentence, { text: "7 damage, Critical Hit", error: false, place: "title" });
  });

  test("the vitals give up AC first where they do not fit one line", () => {
    assert.equal(said({}, AT320), "HP 24/24");
    assert.equal(said({ idle: ["AC 14", "Healthy"] }, AT390), "AC 14 · Healthy");
    assert.equal(said({ idle: ["Dying"] }, AT320), "Dying");
    assert.equal(said({ idle: [] }), "");
  });

  test("the strip's dead lines name the creature once, and a group's follow with whom it leaves out", () => {
    const dm = { revives: false, dm: true };
    const player = { revives: false, dm: false };
    const thorn = [hpTarget("Thorn", { dead: true })];
    assert.deepEqual(deadCase(thorn, { kind: "heal" }, dm), { kind: "heal", name: "Thorn", dm: true });
    assert.equal(said({ dead: deadCase(thorn, { kind: "heal" }, dm) }), "Healing does nothing while Thorn is dead. Revive first.");
    assert.equal(said({ dead: deadCase(thorn, { kind: "heal" }, player) }), "Healing does nothing while Thorn is dead.");
    assert.equal(said({ dead: deadCase(thorn, { kind: "set", cur: 5 }, dm) }), "Thorn stays dead at the new HP. Only Revive brings them back.");
    assert.equal(deadCase(thorn, { kind: "damage" }, dm), null);
    assert.equal(deadCase(thorn, { kind: "temp" }, dm), null);
    // A group heal with a dead creature and Goblin 2 left out.
    const group = [hpTarget("Goblin 1", { dead: true }), hpTarget("Goblin 3"), hpTarget("Goblin 2", { access: "none" })];
    assert.equal(said({ dead: deadCase(group, { kind: "heal" }, dm), left: ["Goblin 2"] }), "Healing does nothing to the 1 dead. Leaves out Goblin 2.");
    assert.equal(said({ dead: deadCase(group, { kind: "set" }, dm) }), "1 dead stays dead. Only Revive brings them back.");
    const two = [hpTarget("Goblin 1", { dead: true }), hpTarget("Goblin 3", { dead: true })];
    assert.equal(said({ dead: deadCase(two, { kind: "set" }, dm) }), "2 dead stay dead. Only Revive brings them back.");
    // With healing bringing back the dead, a heal or a set above 0 counts those it brings back, and a maximum of 0 brings none.
    const revives = { revives: true, dm: true };
    assert.equal(said({ dead: deadCase(two, { kind: "heal" }, revives) }), "Brings back 2 dead creatures.");
    assert.equal(said({ dead: deadCase(thorn, { kind: "set", cur: 5 }, revives) }), "Brings back 1 dead creature.");
    assert.equal(deadCase(thorn, { kind: "set", cur: 0 }, revives), null);
    assert.equal(deadCase([hpTarget("Thorn", { dead: true, max: 0 })], { kind: "heal" }, revives), null);
    // Two tokens of one character count once, and a creature left out is not among the dead.
    const shared = [hpTarget("Thorn", { dead: true, holder: "character:t" }), hpTarget("Thorn copy", { dead: true, holder: "character:t" })];
    assert.deepEqual(deadCase(shared, { kind: "heal" }, dm), { kind: "heal", name: "Thorn", dm: true });
    assert.equal(deadCase([hpTarget("Goblin 2", { dead: true, access: "none" })], { kind: "heal" }, dm), null);
  });

  test("an 80-letter name in the note at 320 x 568 at 130%: two lines at most, the name cut by width from its end, the warning and recovery whole", () => {
    const cases: { over: Partial<RestStatusInput>; keeps: (cut: string) => string }[] = [
      { over: { dead: { kind: "heal", name: LONG, dm: true } }, keeps: (n) => `Healing does nothing while ${n} is dead. Revive first.` },
      { over: { dead: { kind: "heal", name: LONG, dm: false } }, keeps: (n) => `Healing does nothing while ${n} is dead.` },
      { over: { dead: { kind: "set", name: LONG } }, keeps: (n) => `${n} stays dead at the new HP. Only Revive brings them back.` },
      { over: { preview: "7 damage", typed: true, crit: true, reach: 3, left: [LONG] }, keeps: (n) => `7 damage, Critical Hit, to each of 3, not ${n}` },
    ];
    for (const { over, keeps } of cases) {
      const s = status(over, AT320);
      assert.equal(s.sentence?.place, "note");
      const text = s.sentence!.text;
      assert.ok(linesAt(text, 206) <= 2, `${text} passes two lines`);
      assert.equal(s.full, keeps(LONG));
      // The name is cut to its most letters that still fit: one more letter passes two lines.
      const cutTo = (k: number) => `${[...LONG].slice(0, k).join("").trimEnd()}…`;
      const letters = [...LONG].findLastIndex((_, i) => keeps(cutTo(i + 1)) === text) + 1;
      assert.ok(letters >= 1 && letters < LONG.length, `${text} keeps a cut of the name`);
      assert.ok(linesAt(keeps(cutTo(letters + 1)), 206) > 2, `${text} could keep another letter`);
    }
  });

  test("on the 94 px strip and with every group line, the note keeps two lines, left-out names becoming a count only where a cut name will not do", () => {
    // Several left out are counted at once where their names pass two lines.
    const many = status({ preview: "7 damage", typed: true, crit: true, reach: 12, left: Array.from({ length: 12 }, (_, i) => `Goblin Warrior ${i + 1}`) }, AT320);
    assert.equal(many.sentence?.text, "7 damage, Critical Hit, to each of 12, not 12 of them");
    const heal = status({ dead: { kind: "healMany", count: 12 }, left: Array.from({ length: 12 }, (_, i) => `Goblin Warrior ${i + 1}`) }, AT320);
    assert.equal(heal.sentence?.text, "Healing does nothing to the 12 dead. Leaves out 12.");
    // One left out with a short name keeps it whole.
    assert.equal(status({ dead: { kind: "healMany", count: 1 }, left: ["Goblin 2"] }, AT320).sentence?.text, "Healing does nothing to the 1 dead. Leaves out Goblin 2.");
    // A note so narrow that no cut of the one name fits counts it instead.
    const narrow: RestFit = { line: () => false, title: () => false, note: (t) => linesAt(t, 130) <= 2 };
    assert.equal(status({ dead: { kind: "healMany", count: 1 }, left: [LONG] }, narrow).sentence?.text, "Healing does nothing to the 1 dead. Leaves out 1.");
    // A dead creature's name and one left out: the dead name is cut, the left-out name never by the same letters.
    const both = status({ dead: { kind: "heal", name: LONG, dm: false }, left: ["Goblin 2"] }, { ...AT320, note: (t) => linesAt(t, 350) <= 2 }).sentence!.text;
    assert.ok(both.endsWith(" Leaves out Goblin 2."), both);
    assert.ok(both.startsWith("Healing does nothing while Aldric"), both);
    // Where no cut of the dead name fits beside the names left out, they become a count, and the name keeps what then fits.
    const counted = status({ dead: { kind: "heal", name: LONG, dm: false }, left: ["Goblin Warrior 2"] }, { ...AT320, note: (t) => linesAt(t, 200) <= 2 }).sentence!.text;
    assert.equal(counted, "Healing does nothing while Aldr… is dead. Leaves out 1.");
  });
});
