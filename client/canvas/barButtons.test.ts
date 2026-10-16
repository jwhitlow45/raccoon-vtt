import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { barButtons, barCapacity, barShort, isCompanion, type BarButtonInput, type BarRoom } from "./barButtons.ts";
import { DEFAULT_SPOT, placeBar, type Chrome } from "./barDock.ts";

const NOTHING: BarButtonInput = { dm: false, owner: false, undoMove: false, movedThisTurn: false, door: false, light: false, played: false, companion: false, docked: true, moved: false };
const DM: BarButtonInput = { ...NOTHING, dm: true };
const OWNER: BarButtonInput = { ...NOTHING, owner: true };

describe("the bar's two rows", () => {
  test("the DM on a monster, alive or dead, docked: play first, then the setup and destructive row", () => {
    assert.deepEqual(barButtons(DM), {
      play: ["conditions", "hidden", "selectSeveral"],
      less: ["locked", "duplicate", "delete", "moveBar"],
    });
    assert.deepEqual(barButtons({ ...DM, undoMove: true, movedThisTurn: true, light: true, moved: true }), {
      play: ["undoMove", "countLeg", "conditions", "hidden", "light", "selectSeveral"],
      less: ["locked", "duplicate", "delete", "moveBar", "resetBar"],
    });
  });

  test("the DM on a creature a player plays, such as a companion: Request a roll after Conditions, and Delete, never Dismiss", () => {
    const rows = barButtons({ ...DM, played: true, companion: true });
    assert.deepEqual(rows.play, ["conditions", "requestRoll", "hidden", "selectSeveral"]);
    assert.deepEqual(rows.less, ["locked", "duplicate", "delete", "moveBar"]);
  });

  test("a player on their own character: Undo move, Doesn't count, the door, Conditions, Light, Select several, then Move bar", () => {
    assert.deepEqual(barButtons(OWNER), { play: ["conditions", "selectSeveral"], less: ["moveBar"] });
    assert.deepEqual(barButtons({ ...OWNER, undoMove: true, movedThisTurn: true, door: true, light: true, moved: true }), {
      play: ["undoMove", "countLeg", "door", "conditions", "light", "selectSeveral"],
      less: ["moveBar", "resetBar"],
    });
  });

  test("a player on their companion: Dismiss in Delete's place", () => {
    assert.deepEqual(barButtons({ ...OWNER, companion: true }).less, ["dismiss", "moveBar"]);
  });

  test("a player on another's creature: Undo move when they could move it, Select several, Move bar", () => {
    assert.deepEqual(barButtons(NOTHING), { play: ["selectSeveral"], less: ["moveBar"] });
    assert.deepEqual(barButtons({ ...NOTHING, undoMove: true, movedThisTurn: true, door: true, light: true, played: true, companion: true }), {
      play: ["undoMove", "selectSeveral"],
      less: ["moveBar"],
    });
  });

  test("spanning, no Move bar or Reset", () => {
    assert.deepEqual(barButtons({ ...DM, docked: false, moved: true }).less, ["locked", "duplicate", "delete"]);
    assert.deepEqual(barButtons({ ...OWNER, docked: false }).less, []);
  });

  test("a door is offered only on a player's own token, and Details is in neither row", () => {
    assert.equal(barButtons({ ...DM, door: true }).play.includes("door"), false);
    for (const input of [DM, OWNER, NOTHING, { ...DM, undoMove: true, light: true, played: true }]) {
      const rows = barButtons(input);
      assert.equal([...rows.play, ...rows.less].includes("details" as never), false);
    }
  });

  test("a companion is told by its field", () => {
    assert.equal(isCompanion({ id: "t" }), false);
    assert.equal(isCompanion({ companion: undefined }), false);
    assert.equal(isCompanion({ companion: { of: "c1", turn: "shared" } }), true);
  });
});

/** A phone's chrome at full size, without Select several's bar: the top bar, the toolbar and the safe areas. */
function chrome(input: { side: number; bottom: number; sheet?: number }): Chrome {
  const toolbar = 60 + input.bottom;
  return { top: 52, bottom: toolbar, controls: toolbar, toolbar, safe: { top: 0, right: input.side, bottom: input.bottom, left: input.side }, sheet: input.sheet ?? 0, rail: 0 };
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

  test("a docked bar on a desktop is short while tall alert cards push it down, and not once they go", () => {
    const column = { top: 60, content: 640, first: 400 };
    assert.equal(barCapacity(desk(800, column)), 264);
    assert.equal(barShort(desk(800, column)), true);
    assert.equal(barShort(desk(800, null)), false);
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
