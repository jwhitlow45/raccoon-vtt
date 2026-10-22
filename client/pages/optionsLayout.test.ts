import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../lib/theme.ts";
import {
  fitRow,
  FIRST_LAST_TOOL,
  heldFit,
  lastToolAfter,
  lastToolIn,
  MERGE_MIN,
  MERGE_MIN_DM,
  mergedEdges,
  mergedRoom,
  MORE_ROOM,
  optionsArrangement,
  PAIR,
  PART_DIVIDER,
  POPOVER_MIN,
  SLOT_GAP,
  toolbarShape,
  toolPopoverFrame,
  tuckAfter,
  type ArrangementInput,
  type FitSlot,
  type RowFit,
} from "./optionsLayout.ts";

const PLAYER = ["select", "ruler", "area", "draw", "ping"].map((id) => ({ id }));
const PLAYER_NO_DRAW = PLAYER.filter((t) => t.id !== "draw");
const DM = ["select", "ruler", "area", "fog", "draw", "ping", "add-token", "pin", "build", "grid"].map((id) => ({ id }));

/** A window at an interface size with its side insets, as the sweeps of 4.3 use them. */
function at(w: number, h: number, scale: number, side: number, tools: readonly { id: string }[], extra: Partial<ArrangementInput> = {}): ArrangementInput {
  const width = w / scale;
  const wide = width >= 900;
  return { width, height: h / scale, sidePanel: false, safeLeft: side, safeRight: side, toolbar: toolbarShape(tools, wide), named: true, dm: tools.some((t) => t.id === "build"), ...extra };
}

function placeOf(input: ArrangementInput): string {
  const p = optionsArrangement(input);
  return `${p.arrangement}, ${Math.round(p.room)}`;
}

describe("where the options stand (4.1, 4.3)", () => {
  test("every row of the worked rooms", () => {
    const rows: [string, ArrangementInput, string, ArrangementInput, string][] = [
      ["844 x 390", at(844, 390, 1, 47, PLAYER), "merged, 358", at(844, 390, 1, 47, DM), "pair, 538"],
      ["844 x 390 at 130%", at(844, 390, 1.3, 47, PLAYER), "pair, 343", at(844, 390, 1.3, 47, DM), "pair, 343"],
      ["667 x 375", at(667, 375, 1, 0, PLAYER), "merged, 275", at(667, 375, 1, 0, DM), "pair, 455"],
      ["667 x 375 at 130%", at(667, 375, 1.3, 0, PLAYER), "pair, 301", at(667, 375, 1.3, 0, DM), "pair, 301"],
      ["568 x 320", at(568, 320, 1, 0, PLAYER), "pair, 356", at(568, 320, 1, 0, DM), "pair, 356"],
      ["480 x 320", at(480, 320, 1, 47, PLAYER), "stacked, 370", at(480, 320, 1, 47, DM), "stacked, 370"],
      ["480 x 320 at 130%", at(480, 320, 1.3, 47, PLAYER), "stacked, 259", at(480, 320, 1.3, 47, DM), "stacked, 259"],
      ["932 x 430, side panel hidden", at(932, 430, 1, 59, PLAYER), "merged, 422", at(932, 430, 1, 59, DM), "pair, 602"],
      ["932 x 430, side panel shown", at(932, 430, 1, 59, PLAYER, { sidePanel: true }), "pair, 366", at(932, 430, 1, 59, DM, { sidePanel: true }), "pair, 366"],
      ["932 x 430 at 130%", at(932, 430, 1.3, 59, PLAYER), "pair, 387", at(932, 430, 1.3, 59, DM), "pair, 387"],
      ["1280 x 480, a mouse", at(1280, 480, 1, 0, PLAYER, { named: false }), "merged, 960", at(1280, 480, 1, 0, DM, { named: false }), "merged, 715"],
      ["390 x 844", at(390, 844, 1, 0, PLAYER), "stacked, 374", at(390, 844, 1, 0, DM), "stacked, 374"],
      ["320 x 568", at(320, 568, 1, 0, PLAYER), "stacked, 304", at(320, 568, 1, 0, DM), "stacked, 304"],
      ["820 x 1180", at(820, 1180, 1, 0, PLAYER), "stacked, 804", at(820, 1180, 1, 0, DM), "stacked, 804"],
      ["390 x 844 at 130%", at(390, 844, 1.3, 0, PLAYER), "stacked, 284", at(390, 844, 1.3, 0, DM), "stacked, 284"],
      ["320 x 568 at 130%", at(320, 568, 1.3, 0, PLAYER), "stacked, 230", at(320, 568, 1.3, 0, DM), "stacked, 230"],
      ["820 x 1180 at 130%", at(820, 1180, 1.3, 0, PLAYER), "stacked, 615", at(820, 1180, 1.3, 0, DM), "stacked, 615"],
      ["1280 x 800", at(1280, 800, 1, 0, PLAYER, { sidePanel: true }), "floating, 622", at(1280, 800, 1, 0, DM, { sidePanel: true }), "floating, 622"],
      ["1180 x 820", at(1180, 820, 1, 0, PLAYER, { sidePanel: true }), "floating, 622", at(1180, 820, 1, 0, DM, { sidePanel: true }), "floating, 622"],
      ["1280 x 800 at 130%", at(1280, 800, 1.3, 0, PLAYER, { sidePanel: true }), "floating, 591", at(1280, 800, 1.3, 0, DM, { sidePanel: true }), "floating, 591"],
    ];
    for (const [name, player, p, dm, d] of rows) {
      assert.equal(placeOf(player), p, `${name}, a player`);
      assert.equal(placeOf(dm), d, `${name}, the DM`);
    }
  });

  test("the merged rooms that fall short: 163 for a player at 844 x 390 at 130%, 233 for a DM at 844 x 390, 117 at 932 x 430", () => {
    const merged = (input: ArrangementInput) => Math.round(mergedRoom(input, input.toolbar));
    assert.equal(merged(at(844, 390, 1.3, 47, PLAYER)), 163);
    assert.equal(merged(at(844, 390, 1, 47, DM)), 233);
    assert.equal(merged(at(667, 375, 1, 0, DM)), 150);
    assert.equal(merged(at(480, 320, 1, 47, PLAYER)), -6);
    assert.equal(Math.round(mergedRoom(at(480, 320, 1, 47, PLAYER), PAIR)), 174);
    assert.equal(Math.round(mergedRoom(at(480, 320, 1.3, 47, PLAYER), PAIR)), 63);
    assert.equal(merged(at(932, 430, 1, 59, DM)), 117);
    assert.equal(merged(at(932, 430, 1, 59, PLAYER, { sidePanel: true })), 186);
    assert.equal(merged(at(932, 430, 1.3, 59, PLAYER)), 207);
    assert.equal(merged(at(568, 320, 1, 0, PLAYER)), 176);
    assert.equal(merged(at(667, 375, 1.3, 0, PLAYER)), 121);
  });

  test("the floor is Draw's priority-1 set as the kit draws it", () => {
    // A value chip (features/measure/controls.tsx chipLook): its 1 px borders, 12 px before its content, 6 px after, a 4 px gap and the 16 px caret.
    const chip = (content: number) => 2 * theme.line.border + theme.space(3) + theme.space(1.5) + theme.space(1) + theme.icon.sm + content;
    // "Eraser", the widest drawing tool's name, at 14 px weight 600 as Chrome draws it in Inter: the tool chip measures 83.5 in the dev room.
    const eraser = 43.5;
    const set = chip(eraser) + SLOT_GAP + chip(theme.layout.options.disk) + SLOT_GAP + chip(theme.icon.lg) + MORE_ROOM;
    assert.equal(MERGE_MIN, Math.ceil(set));
  });

  test("the DM's floor is the narrowest pair room a phone gives: under it a DM takes the pair, or the stacked row where the pair has less", () => {
    assert.equal(MERGE_MIN_DM, 301);
    // Sideways Android phones whose whole DM toolbar would leave 283 and 279 px.
    assert.equal(placeOf(at(800, 360, 1, 0, DM)), "pair, 588");
    assert.equal(placeOf(at(915, 412, 1.15, 0, DM)), "pair, 584");
    assert.equal(placeOf(at(740, 360, 0.85, 0, DM)), "merged, 354");
    assert.equal(placeOf(at(667, 375, 1.3, 0, DM)), "pair, 301", "the narrowest pair room holds");
    // A 568 px phone at 115%: the pair's 282 is under the DM's floor, not a player's.
    assert.equal(placeOf(at(568, 320, 1.15, 0, DM)), "stacked, 478");
    assert.equal(placeOf(at(568, 320, 1.15, 0, PLAYER)), "pair, 282");
    assert.equal(placeOf(at(800, 360, 1, 0, PLAYER)), "merged, 408");
  });

  test("a room one under the floor falls back and one at the floor merges", () => {
    // 844 x 390 for a player has 358: widen the left inset until the room is exactly the floor, then one more px.
    const base = at(844, 390, 1, 47, PLAYER);
    const exact = { ...base, safeLeft: base.safeLeft + (358 - MERGE_MIN) };
    assert.equal(optionsArrangement(exact).arrangement, "merged");
    assert.equal(optionsArrangement(exact).room, MERGE_MIN);
    const short = { ...exact, safeLeft: exact.safeLeft + 1 };
    assert.equal(optionsArrangement(short).arrangement, "pair", "one under the floor falls back to the pair, whose room is larger");
  });

  test("a layout 499 tall merges and 500 does not, and a square one never does", () => {
    assert.equal(optionsArrangement({ ...at(844, 499, 1, 47, PLAYER) }).arrangement, "merged");
    assert.equal(optionsArrangement({ ...at(844, 500, 1, 47, PLAYER) }).arrangement, "stacked");
    assert.equal(optionsArrangement({ ...at(480, 480, 1, 0, PLAYER) }).arrangement, "stacked");
  });

  test("the side panel shown takes its width and the right inset, and Panels leaves the toolbar", () => {
    const hidden = mergedRoom(at(932, 430, 1, 59, PLAYER), PAIR);
    const shown = mergedRoom(at(932, 430, 1, 59, PLAYER, { sidePanel: true }), PAIR);
    // 360 for the panel, 59 back from the right inset and 65 back from Panels.
    assert.equal(hidden - shown, 360 - 59 - 65);
  });

  test("the row's element stands 6 px after the last tool and 8 px before Panels, and its controls have the room", () => {
    const input = at(844, 390, 1, 47, PLAYER);
    const edges = mergedEdges(input, input.toolbar);
    // 4 px of padding, five 56 px tools and their gaps, then 6 px.
    assert.deepEqual(edges, { left: 4 + 296 + 6, right: 4 + 65 + 8 });
    // Less its 1 px divider and 8 px padding, the element holds the room.
    assert.equal(844 - 47 - 47 - edges.left - edges.right - 1 - 8, optionsArrangement(input).room);
    const shown = at(932, 430, 1, 59, PLAYER, { sidePanel: true });
    assert.equal(mergedEdges(shown, PAIR).right, 4 + 8, "no Panels beside the side panel");
  });

  test("labelled buttons are 56 px and a mouse's icons 44", () => {
    const named = optionsArrangement(at(1280, 480, 1, 0, PLAYER)).room;
    const icons = optionsArrangement(at(1280, 480, 1, 0, PLAYER, { named: false })).room;
    // Five tools and Panels, each 12 px narrower.
    assert.equal(icons - named, 6 * 12);
  });

  test("a DM's phone toolbar groups the setup tools behind Setup, a computer's keeps all ten, and a player's has no divider", () => {
    assert.deepEqual(toolbarShape(DM, false), { buttons: 7, divider: true });
    assert.deepEqual(toolbarShape(DM, true), { buttons: 10, divider: true });
    assert.deepEqual(toolbarShape(PLAYER, false), { buttons: 5, divider: false });
    assert.deepEqual(toolbarShape(PLAYER, true), { buttons: 5, divider: false });
  });

  test("a player without Draw has one button fewer, 60 px more room, and can merge where five tools could not", () => {
    const five = optionsArrangement(at(844, 390, 1.3, 47, PLAYER));
    const four = optionsArrangement(at(844, 390, 1.3, 47, PLAYER_NO_DRAW));
    assert.equal(five.arrangement, "pair");
    assert.equal(Math.round(optionsArrangement(at(844, 390, 1, 47, PLAYER_NO_DRAW)).room - optionsArrangement(at(844, 390, 1, 47, PLAYER)).room), 60);
    assert.equal(four.arrangement, "pair", "163 + 60 is still under 256");
    assert.equal(optionsArrangement(at(667, 375, 1, 0, PLAYER_NO_DRAW)).room, 335);
  });
});

// ------------------------------------------------------------ the fit

function slot(id: string, priority: number, full: number, extra: Partial<FitSlot> = {}): FitSlot {
  return { id, priority, full, ...extra };
}

function ids(fit: RowFit): string {
  return fit.row.map((p) => (p.form === "full" ? p.id : `${p.id}:${p.form}`)).join(" ") + (fit.hasMore ? " …" : "");
}

describe("the fit (6.3)", () => {
  test("everything fits in its full form: no ⋯", () => {
    const fit = fitRow({ room: 200, slots: [slot("a", 1, 60), slot("b", 2, 60), slot("c", 3, 60)], alwaysMore: false, pins: [] });
    assert.equal(ids(fit), "a b c");
    assert.deepEqual(fit.more, []);
  });

  test("everything fits once compact forms are taken, lowest priority first: the DM's Ruler keeps its kept rulers' chip in short words at 374, and Clear's eraser alone at 344", () => {
    // The DM's Ruler row with two kept rulers, as Inter draws it in the dev room: Shared and Clear with their icons, "Kept rulers (2)" or "Kept (2)", and Clear's eraser alone at 44.
    const slots = [slot("shared", 1, 98), slot("keep", 2, 60.6), slot("clear", 2, 86, { compact: 44 }), slot("kept", 3, 146, { compact: 94 })];
    assert.equal(ids(fitRow({ room: 403, slots, alwaysMore: false, pins: [] })), "shared keep clear kept");
    assert.equal(ids(fitRow({ room: 374, slots, alwaysMore: false, pins: [] })), "shared keep clear kept:compact");
    assert.equal(ids(fitRow({ room: 358, slots, alwaysMore: false, pins: [] })), "shared keep clear kept:compact");
    // At 344, a 360 px phone's row, and 343, the pair at 130%, the short words leave the row 7 or 8 px over: Clear's eraser alone takes the row to 308.6, so nothing waits.
    for (const room of [344, 343]) {
      const fit = fitRow({ room, slots, alwaysMore: false, pins: [] });
      assert.equal(ids(fit), "shared keep clear:compact kept:compact", `at ${room}`);
      assert.deepEqual(fit.more, [], `at ${room}`);
    }
  });

  test("the DM's Ruler with Measure and kept rulers keeps all five at 344, a 360 px phone's row, with Measure's short words (MV-360)", () => {
    // As Inter draws them in the dev room: Measure's chip 73.2 px with "Line" or "Walk", where "Straight" or "Walking" took 94.2, and "Kept (2)" 94, "Kept (12)" 100.4.
    const row = (measure: number, kept: number) => [slot("shared", 1, 98, { compact: 44 }), slot("measure", 4, 163.6, { compact: measure }), slot("keep", 2, 60.6), slot("clear", 2, 86, { compact: 44 }), slot("kept", 3, 146, { compact: kept })];
    for (const kept of [94, 100.4]) {
      const fit = fitRow({ room: 344, slots: row(73.2, kept), alwaysMore: false, pins: [] });
      assert.equal(ids(fit), "shared:compact measure:compact keep clear:compact kept:compact", `with the kept chip at ${kept}`);
      assert.deepEqual(fit.more, []);
    }
    assert.notDeepEqual(fitRow({ room: 344, slots: row(94.2, 94), alwaysMore: false, pins: [] }).more, [], "the whole words left the row over");
  });

  test("content always in ⋯ skips the first pass and keeps ⋯", () => {
    const fit = fitRow({ room: 200, slots: [slot("a", 1, 60), slot("b", 2, 60)], alwaysMore: true, pins: [] });
    assert.equal(ids(fit), "a b …");
    assert.deepEqual(fit.more, []);
  });

  test("by priority, ties in display order, and a smaller slot later in the order fits after a larger one waited", () => {
    // Room 200 less ⋯'s 48 leaves 152.
    const slots = [slot("big", 2, 100), slot("first", 1, 60), slot("small", 3, 40), slot("tie", 2, 60)];
    const fit = fitRow({ room: 200, slots, alwaysMore: false, pins: [] });
    // first (60), then the priority 2 slots in display order: big (100) does not fit beside it, tie (60) does, then small (40) does not.
    assert.equal(ids(fit), "first tie …");
    assert.deepEqual(fit.more, ["big", "small"], "tie, later and smaller, fits after big waited");
  });

  test("in the second pass compact forms are taken one at a time, lowest priority and last first, only while a priority-1 slot waits", () => {
    const slots = [slot("p1a", 1, 100), slot("p1b", 1, 100, { compact: 50 }), slot("p2", 2, 80, { compact: 40 }), slot("p3", 3, 80, { compact: 40 })];
    // All four compact need 242, so the first pass fails at 230. Less ⋯ that leaves 182: the two priority-1 slots need 204, so compact forms are taken: p3 first, then p2, then p1b.
    const fit = fitRow({ room: 230, slots, alwaysMore: false, pins: [] });
    assert.equal(ids(fit), "p1a p1b:compact …");
    assert.deepEqual(fit.more, ["p2", "p3"], "p3 and p2 took their compact forms first and still wait");
    // A waiting slot of priority 2 never makes another compact.
    const two = fitRow({ room: 248, slots: [slot("p1", 1, 150), slot("p2", 2, 100), slot("p3", 3, 40, { compact: 20 })], alwaysMore: false, pins: [] });
    assert.equal(ids(two), "p1 p3 …");
    assert.deepEqual(two.more, ["p2"]);
  });

  test("a priority-1 slot waits in ⋯ when nothing more compacts, leading it", () => {
    const fit = fitRow({ room: 200, slots: [slot("mode", 1, 120), slot("height", 1, 140), slot("undo", 2, 44)], alwaysMore: true, pins: [] });
    assert.equal(ids(fit), "mode …");
    assert.deepEqual(fit.more, ["height", "undo"]);
  });

  test("a slot waits in its chip's popover, and the chip shows its value where the row holds it", () => {
    // Area's placing row as Inter draws it in the dev room: the shape chip at its widest value, Emanation, and "Emanation 1,000 ft" with the size.
    const slots = [
      slot("shape", 1, 111.4, { compact: 60, glyph: 135.4, hosts: { id: "size", words: 166, glyph: 190 } }),
      slot("size", 3, 149.9, { home: "shape" }),
      slot("place", 1, 63.2),
      slot("shared", 4, 98),
      slot("cancel", 2, 73),
      slot("spell", 5, 96, { home: "shape", max: 170 }),
    ];
    const roomy = fitRow({ room: 622, slots, alwaysMore: true, pins: [] });
    assert.equal(ids(roomy), "shape:glyph size place shared cancel …", "a computer's row, the spell in the shape popover");
    assert.deepEqual(roomy.homes, { shape: ["spell"] });
    const stacked = fitRow({ room: 374, slots, alwaysMore: true, pins: [] });
    assert.equal(ids(stacked), "shape:hosts place cancel …", "Sphere 20 ft, where the glyph does not fit too");
    assert.deepEqual(stacked.homes, { shape: ["size", "spell"] });
    assert.deepEqual(stacked.more, ["shared"]);
    const pair = fitRow({ room: 343, slots, alwaysMore: true, pins: [] });
    assert.equal(ids(pair), "shape:glyph place cancel …", "the value only where it fits, and the glyph from what is left");
  });

  test("a flexible field fits at its least and grows into the rest, up to its own width", () => {
    const slots = [slot("a", 1, 100), slot("field", 1, 96, { max: 200 })];
    assert.equal(fitRow({ room: 250, slots, alwaysMore: false, pins: [] }).row[1]?.width, 250 - 100 - SLOT_GAP);
    assert.equal(fitRow({ room: 400, slots, alwaysMore: false, pins: [] }).row[1]?.width, 200);
    assert.equal(fitRow({ room: 200, slots, alwaysMore: false, pins: [] }).row[1]?.width, 96);
  });

  test("a chip in its words form gains its glyph from the room left, never at the cost of a control", () => {
    const slots = [slot("shape", 2, 80, { compact: 44, glyph: 106 }), slot("undo", 3, 62)];
    assert.equal(ids(fitRow({ room: 172, slots, alwaysMore: false, pins: [] })), "shape:glyph undo");
    assert.equal(ids(fitRow({ room: 150, slots, alwaysMore: false, pins: [] })), "shape undo");
    // A waiting slot comes back in its compact form where the row holds that much.
    const back = fitRow({ room: 200, slots: [slot("a", 1, 100), slot("chip", 2, 80, { compact: 44 })], alwaysMore: true, pins: [] });
    assert.equal(ids(back), "a chip:compact …");
  });

  test("a line stands before another part's first inline slot", () => {
    const slots = [slot("mode", 1, 100), slot("tint", 2, 60, { part: "stamp" })];
    assert.equal(ids(fitRow({ room: 100 + SLOT_GAP + PART_DIVIDER + 60, slots, alwaysMore: false, pins: [] })), "mode tint");
    assert.equal(ids(fitRow({ room: 100 + SLOT_GAP + 60, slots, alwaysMore: false, pins: [] })).includes("tint"), false, "the line takes its room");
  });

  test("pins go inline first, and a pin the room cannot hold beside ⋯ breaks", () => {
    const slots = [slot("a", 1, 100), slot("b", 1, 100), slot("focused", 4, 60)];
    const fit = fitRow({ room: 260, slots, alwaysMore: true, pins: ["focused"] });
    assert.equal(ids(fit), "a focused …");
    assert.deepEqual(fit.broken, []);
    const narrow = fitRow({ room: 100, slots: [slot("wide", 1, 120)], alwaysMore: true, pins: ["wide"] });
    assert.deepEqual(narrow.broken, ["wide"]);
    assert.deepEqual(narrow.more, ["wide"]);
  });

  test("the same input gives the same output", () => {
    const input = { room: 300, slots: [slot("a", 1, 100), slot("b", 2, 120, { compact: 50 }), slot("c", 3, 80)], alwaysMore: false, pins: [] };
    assert.deepEqual(fitRow(input), fitRow(structuredClone(input)));
  });
});

/**
 * Area's row with the From control (docs/design-v1-area-from-character.md
 * 3.6 and Appendix A): each room's row from the widths the dev room's
 * measuring layer gives in Inter at 1280 x 800, for a short name and one
 * at the name cap, as the toggle and as the chip, and the disabled "From
 * you". From, Shape and Place stand inline in every room.
 */
describe("Area with the From control (Appendix A)", () => {
  const FROM = {
    toggle: 104.4,
    capped: 131.8,
    chip: 118.4,
    chipCapped: 145.8,
    you: 88.9,
  } as const;
  type Form = keyof typeof FROM;
  const shape = (hosts: boolean) => slot("shape", 1, 111.4, { compact: 60, glyph: 135.4, ...(hosts ? { hosts: { id: "size", words: 166, glyph: 190 } } : {}) });
  const from = (form: Form) => slot("from", 1, FROM[form], { compact: theme.touch });
  const placing = (form: Form) => [
    from(form),
    shape(true),
    slot("size", 3, 149.9, { home: "shape" }),
    slot("place", 1, 63.2),
    slot("shared", 4, 98),
    slot("cancel", 2, 73),
    slot("spell", 5, 96, { home: "shape", max: 170 }),
  ];
  const idle = (form: Form) => [from(form), shape(false), slot("spell", 3, 96, { home: "shape", max: 170 })];
  const rows = (state: "placing" | "idle", form: Form, bands: readonly (readonly [readonly number[], string])[]) => {
    for (const [rooms, row] of bands) {
      for (const room of rooms) {
        const fit = fitRow({ room, slots: state === "placing" ? placing(form) : idle(form), alwaysMore: state === "placing", pins: [] });
        assert.equal(ids(fit), row, `${state}, ${form}, ${room}`);
        for (const id of ["from", "shape", ...(state === "placing" ? ["place"] : [])]) assert.ok(fit.row.some((p) => p.id === id), `${id} inline at ${room}`);
      }
    }
  };

  test("placing, the toggle with a short name: Cancel and Shared wait behind ⋯ where the row is tight", () => {
    rows("placing", "toggle", [
      [[230, 259, 275], "from:compact shape:compact place …"],
      [[284, 301, 304], "from shape:compact place …"],
      [[343, 356, 358], "from shape place …"],
      [[366, 370, 374, 387], "from shape:glyph place …"],
      [[422], "from shape place cancel …"],
      [[455], "from shape:glyph place cancel …"],
      [[538], "from shape:glyph place shared cancel …"],
      [[591, 602, 615, 622], "from shape:glyph size place cancel …"],
      [[715], "from shape:glyph size place shared cancel …"],
      [[804, 960], "from shape:glyph size place shared cancel spell …"],
    ]);
  });

  test("placing, a name at the cap, as the toggle and as the chip", () => {
    rows("placing", "capped", [
      [[230, 259, 275, 284], "from:compact shape:compact place …"],
      [[301, 304], "from:compact shape:compact place cancel …"],
      [[343, 356, 358], "from shape:compact place …"],
      [[366, 370, 374], "from shape place …"],
      [[387], "from shape:glyph place …"],
      [[422], "from shape:hosts place …"],
      [[455], "from shape place cancel …"],
      [[538], "from shape:hostsGlyph place cancel …"],
      [[591], "from shape:glyph place shared cancel …"],
      [[602, 615], "from shape size place cancel …"],
      [[622], "from shape:glyph size place cancel …"],
      [[715], "from shape size place shared cancel …"],
      [[804], "from shape size place shared cancel spell …"],
      [[960], "from shape:glyph size place shared cancel spell …"],
    ]);
    rows("placing", "chipCapped", [
      [[230, 259, 275, 284], "from:compact shape:compact place …"],
      [[301, 304], "from:compact shape:compact place cancel …"],
      [[343, 356, 358, 366, 370, 374], "from shape:compact place …"],
      [[387], "from shape place …"],
      [[422], "from shape:glyph place …"],
      [[455], "from shape place cancel …"],
      [[538], "from shape:hostsGlyph place cancel …"],
      [[591, 602], "from shape:glyph place shared cancel …"],
      [[615, 622], "from shape size place cancel …"],
      [[715], "from shape size place shared cancel …"],
      [[804], "from shape:glyph size place shared cancel …"],
      [[960], "from shape:glyph size place shared cancel spell …"],
    ]);
  });

  test("placing, the chip with a short name, and the disabled From you", () => {
    rows("placing", "chip", [
      [[230, 259, 275, 284], "from:compact shape:compact place …"],
      [[301, 304, 343], "from shape:compact place …"],
      [[356, 358, 366, 370], "from shape place …"],
      [[374, 387], "from shape:glyph place …"],
      [[422], "from shape:hosts place …"],
      [[455], "from shape:glyph place cancel …"],
      [[538], "from shape place shared cancel …"],
      [[591, 602], "from shape size place cancel …"],
      [[615, 622], "from shape:glyph size place cancel …"],
      [[715], "from shape:glyph size place shared cancel …"],
      [[804], "from shape size place shared cancel spell …"],
      [[960], "from shape:glyph size place shared cancel spell …"],
    ]);
    rows("placing", "you", [
      [[230, 259], "from:compact shape:compact place …"],
      [[275, 284, 301, 304], "from shape:compact place …"],
      [[343], "from shape place …"],
      [[356, 358, 366, 370, 374], "from shape:glyph place …"],
      [[387], "from shape:hosts place …"],
      [[422], "from shape:glyph place cancel …"],
      [[455], "from shape:hosts place cancel …"],
      [[538], "from shape:glyph place shared cancel …"],
      [[591, 602, 615, 622], "from shape:glyph size place cancel …"],
      [[715], "from shape:glyph size place shared cancel …"],
      [[804, 960], "from shape:glyph size place shared cancel spell …"],
    ]);
  });

  test("idle, with no ⋯: the square, the shape and the spell field, which grows into what is left", () => {
    const rest = [366, 370, 374, 387, 422, 455, 538, 591, 602, 615, 622, 715, 804, 960];
    rows("idle", "toggle", [
      [[230, 259], "from:compact shape:compact spell"],
      [[275, 284, 301, 304], "from shape:compact spell"],
      [[343], "from shape spell"],
      [[356, 358, ...rest], "from shape:glyph spell"],
    ]);
    rows("idle", "capped", [
      [[230, 259, 275, 284], "from:compact shape:compact spell"],
      [[301, 304, 343], "from shape:compact spell"],
      [[356, 358, 366, 370], "from shape spell"],
      [[374, 387, 422, 455, 538, 591, 602, 615, 622, 715, 804, 960], "from shape:glyph spell"],
    ]);
    rows("idle", "chip", [
      [[230, 259, 275], "from:compact shape:compact spell"],
      [[284, 301, 304], "from shape:compact spell"],
      [[343, 356], "from shape spell"],
      [[358, ...rest], "from shape:glyph spell"],
    ]);
    rows("idle", "chipCapped", [
      [[230, 259, 275, 284, 301, 304], "from:compact shape:compact spell"],
      [[343, 356, 358], "from shape:compact spell"],
      [[366, 370, 374], "from shape spell"],
      [[387, 422, 455, 538, 591, 602, 615, 622, 715, 804, 960], "from shape:glyph spell"],
    ]);
    rows("idle", "you", [
      [[230], "from:compact shape:compact spell"],
      [[259, 275, 284, 301, 304], "from shape:compact spell"],
      [[343, 356, 358, ...rest], "from shape:glyph spell"],
    ]);
  });

  test("Area's priority-1 set with ⋯ stays under the floor, so From, Shape and Place are inline in the narrowest stacked room", () => {
    const set = theme.touch + 60 + 62.9 + 2 * SLOT_GAP + MORE_ROOM;
    assert.ok(set <= 230, `${set}`);
    assert.ok(set < MERGE_MIN);
  });
});

describe("what holds still (6.4)", () => {
  test("with ⋯ open, a slot that appears joins its home, one that goes leaves, and ⋯ stays", () => {
    const before = fitRow({ room: 260, slots: [slot("a", 1, 100), slot("b", 2, 100), slot("c", 3, 60)], alwaysMore: false, pins: [] });
    assert.equal(ids(before), "a b …");
    assert.deepEqual(before.more, ["c"]);
    // c goes, a new d appears, and the room grows: nothing crosses.
    const held = heldFit(before, { room: 600, slots: [slot("a", 1, 100), slot("b", 2, 100), slot("d", 1, 40)], alwaysMore: false, pins: [] });
    assert.equal(ids(held), "a b …");
    assert.deepEqual(held.more, ["d"]);
    // Everything that waited goes: ⋯ still shows until the popover closes.
    const empty = heldFit(before, { room: 600, slots: [slot("a", 1, 100), slot("b", 2, 100)], alwaysMore: false, pins: [] });
    assert.equal(ids(empty), "a b …");
    assert.deepEqual(empty.more, []);
  });

  test("a held row the room no longer holds refits, and ⋯ stays", () => {
    const before = fitRow({ room: 400, slots: [slot("a", 1, 150), slot("b", 2, 150)], alwaysMore: true, pins: [] });
    const narrow = heldFit(before, { room: 220, slots: [slot("a", 1, 150), slot("b", 2, 150)], alwaysMore: true, pins: [] });
    assert.equal(ids(narrow), "a …");
    assert.equal(narrow.hasMore, true);
  });

  test("a slot appearing with a chip home joins that chip, and one that waited in a chip stays there", () => {
    const before = fitRow({ room: 300, slots: [slot("shape", 1, 70), slot("place", 1, 63), slot("size", 3, 152, { home: "shape" })], alwaysMore: true, pins: [] });
    assert.deepEqual(before.homes, { shape: ["size"] });
    const held = heldFit(before, { room: 300, slots: [slot("shape", 1, 70), slot("place", 1, 63), slot("size", 3, 152, { home: "shape" }), slot("spell", 5, 96, { home: "shape" })], alwaysMore: true, pins: [] });
    assert.deepEqual(held.homes, { shape: ["size", "spell"] });
  });

  test("while a press on the row is down, nothing crosses, and ⋯ shows only for a slot that appeared", () => {
    const before = fitRow({ room: 400, slots: [slot("keep", 2, 60), slot("clear", 2, 62)], alwaysMore: false, pins: [] });
    assert.equal(ids(before), "keep clear");
    const same = heldFit(before, { room: 400, slots: [slot("keep", 2, 60), slot("clear", 2, 62)], alwaysMore: false, pins: [] }, false);
    assert.equal(ids(same), "keep clear");
    const grew = heldFit(before, { room: 400, slots: [slot("keep", 2, 60), slot("clear", 2, 62), slot("kept", 3, 140)], alwaysMore: false, pins: [] }, false);
    assert.equal(ids(grew), "keep clear …", "the kept rulers' chip waits until the press ends");
    assert.deepEqual(grew.more, ["kept"]);
  });

  test("a held row is checked as it draws, so it never outgrows its room", () => {
    // The row as drawn: its widths as returned, a gap between each, and ⋯ with its gap where it shows.
    const drawn = (fit: RowFit) => fit.row.reduce((sum, p, i) => sum + p.width + (i > 0 ? SLOT_GAP : 0), 0) + (fit.hasMore ? MORE_ROOM : 0);
    // A flexible field grown to 170 beside a 72 px button and ⋯ in 294, then narrowed to 220 with ⋯ open: it gives back what it grew.
    const field = [slot("button", 1, 72), slot("field", 2, 96, { max: 170 })];
    const grown = fitRow({ room: 294, slots: field, alwaysMore: true, pins: [] });
    assert.equal(grown.row[1]?.width, 170);
    const narrowed = heldFit(grown, { room: 220, slots: field, alwaysMore: true, pins: [] });
    assert.equal(ids(narrowed), "button field …", "nothing crosses");
    assert.equal(narrowed.row[1]?.width, 96);
    assert.ok(drawn(narrowed) <= 220, `${drawn(narrowed)} in 220`);
    // A refit with ⋯ open keeps ⋯'s room: two 150 px slots in 320 do not both stay beside it.
    const before = fitRow({ room: 400, slots: [slot("a", 1, 150), slot("b", 2, 150), slot("c", 3, 100)], alwaysMore: false, pins: [] });
    assert.equal(ids(before), "a b …");
    const refit = heldFit(before, { room: 320, slots: [slot("a", 1, 150), slot("b", 2, 150)], alwaysMore: false, pins: [] });
    assert.equal(ids(refit), "a …");
    assert.ok(drawn(refit) <= 320, `${drawn(refit)} in 320`);
    // During a press, a slot that appears brings ⋯, whose room the held row then needs: two 120 px slots in 270 give way.
    const pressed = fitRow({ room: 270, slots: [slot("keep", 2, 120), slot("clear", 2, 120)], alwaysMore: false, pins: [] });
    assert.equal(ids(pressed), "keep clear");
    const appeared = heldFit(pressed, { room: 270, slots: [slot("keep", 2, 120), slot("clear", 2, 120), slot("kept", 3, 140)], alwaysMore: false, pins: [] }, false);
    assert.equal(appeared.hasMore, true);
    assert.ok(drawn(appeared) <= 270, `${drawn(appeared)} in 270`);
  });

  test("⋯ and its gap take 48 px", () => {
    assert.equal(MORE_ROOM, 48);
  });
});

describe("the last tool (5.2)", () => {
  test("starts as the Ruler, is never Select, and follows every way a tool becomes active", () => {
    assert.equal(FIRST_LAST_TOOL, "ruler");
    let last = FIRST_LAST_TOOL;
    for (const [active, expected] of [
      ["select", "ruler"],
      ["fog", "fog"],
      ["select", "fog"],
      ["build", "build"],
      ["area", "area"],
    ] as const) {
      last = lastToolAfter(last, active);
      assert.equal(last, expected, `after ${active}`);
    }
  });

  test("goes back to the Ruler once its tool leaves the role's list", () => {
    assert.equal(lastToolIn("draw", PLAYER), "draw");
    assert.equal(lastToolIn("draw", PLAYER_NO_DRAW), "ruler");
    assert.equal(lastToolIn("fog", PLAYER), "ruler", "a role change to a player");
  });
});

describe("tuck (5.4, 5.5)", () => {
  test("a press on the active tool's button or tile tucks, and the next shows", () => {
    let tucked: string | null = null;
    tucked = tuckAfter(tucked, "draw", { kind: "press", tool: "draw" });
    assert.equal(tucked, "draw");
    tucked = tuckAfter(tucked, "draw", { kind: "press", tool: "draw" });
    assert.equal(tucked, null);
  });

  test("the active tool's key and the options-hidden pill show the options and never tuck", () => {
    assert.equal(tuckAfter("draw", "draw", { kind: "show", tool: "draw" }), null);
    assert.equal(tuckAfter(null, "draw", { kind: "show", tool: "draw" }), null, "a held key never hides them");
  });

  test("another tool ends the tuck, and Select has none", () => {
    assert.equal(tuckAfter("draw", "draw", { kind: "tool", tool: "ruler" }), null);
    assert.equal(tuckAfter(null, "select", { kind: "press", tool: "select" }), null);
    assert.equal(tuckAfter("build", "build", { kind: "press", tool: "ruler" }), null, "a press on another tool's button changes the tool");
  });

  test("a change of arrangement is no event: the tuck holds", () => {
    // Nothing in the arrangement reaches tuckAfter, so the tool's tuck is what it was.
    assert.equal(tuckAfter("ruler", "ruler", { kind: "tool", tool: "ruler" }), "ruler");
  });
});

describe("the popovers' frame (7.3)", () => {
  const safe = { top: 47, right: 0, bottom: 34, left: 0 };

  test("the bound starts under the top bars, or under a lasting notice below them", () => {
    const frame = toolPopoverFrame({ mapWidth: 390, height: 844, safe, top: 99, lasting: null });
    assert.deepEqual(frame.bound, { left: 0, right: 390, top: 99, bottom: 810 });
    assert.equal(toolPopoverFrame({ mapWidth: 390, height: 844, safe, top: 99, lasting: 150 }).bound.top, 150);
    assert.equal(toolPopoverFrame({ mapWidth: 390, height: 844, safe, top: 99, lasting: 60 }).bound.top, 99, "a notice under the bars is no lower than them");
  });

  test("the rise region reaches the top safe area, over the bars and the notices", () => {
    const frame = toolPopoverFrame({ mapWidth: 844, height: 390, safe: { top: 0, right: 47, bottom: 21, left: 47 }, top: 100, lasting: 140 });
    assert.deepEqual(frame.rise, { left: 47, right: 797, top: 0, bottom: 369 });
  });

  test("its least height is the title and one 44 px row", () => {
    assert.equal(POPOVER_MIN, 24 + 2 + 16 + 8 + 44);
  });
});
