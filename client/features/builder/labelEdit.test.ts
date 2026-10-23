import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { apply, DM, env, room } from "#shared/testutil.ts";
import {
  CONFIRM_MS,
  LABEL_SIZES,
  PANE_WIDTH,
  cleanLabelText,
  commitDraft,
  deleteArmed,
  labelPaneAllowed,
  labelTapOutcome,
  paneEscape,
  PANE_MIN_HEIGHT,
  panePlacement,
  paneSizes,
  sheetPanAnchor,
  tapDelete,
} from "./labelEdit.ts";
import { LANE_WIDTH, paneLaneBox, SUMMARY_ROW } from "../../canvas/barDock.ts";

const dm = { role: "dm" as const, tool: "select", mode: "paint" as const };

describe("labelTapOutcome", () => {
  test("a DM's tap on a label opens its pane with the Select tool and in the builder's Label mode", () => {
    assert.deepEqual(labelTapOutcome({ ...dm, hit: "l1", open: null }), { kind: "open", labelId: "l1" });
    assert.deepEqual(labelTapOutcome({ ...dm, tool: "build", mode: "label", hit: "l1", open: null }), { kind: "open", labelId: "l1" });
  });

  test("a tap on another label moves the pane to it", () => {
    assert.deepEqual(labelTapOutcome({ ...dm, hit: "l2", open: "l1" }), { kind: "open", labelId: "l2" });
  });

  test("a tap away closes an open pane, and is the tool's own when none is open", () => {
    assert.deepEqual(labelTapOutcome({ ...dm, hit: null, open: "l1" }), { kind: "close" });
    assert.deepEqual(labelTapOutcome({ ...dm, hit: null, open: null }), { kind: "pass" });
    assert.deepEqual(labelTapOutcome({ ...dm, tool: "build", mode: "label", hit: null, open: null }), { kind: "pass" });
  });

  test("the builder's other modes keep their taps, so a tap on a label paints or erases there", () => {
    for (const mode of ["paint", "rect", "poly", "erase", "eraseRect", "edge"] as const) {
      assert.deepEqual(labelTapOutcome({ ...dm, tool: "build", mode, hit: "l1", open: null }), { kind: "pass" }, mode);
    }
  });

  test("other tools keep their taps", () => {
    for (const tool of ["fog", "draw", "ruler", "area", "ping", "grid", "place"]) {
      assert.deepEqual(labelTapOutcome({ ...dm, tool, hit: "l1", open: null }), { kind: "pass" }, tool);
    }
  });

  test("a player never opens a pane, in any tool", () => {
    assert.deepEqual(labelTapOutcome({ ...dm, role: "player", hit: "l1", open: null }), { kind: "pass" });
    assert.deepEqual(labelTapOutcome({ role: "player", tool: "build", mode: "label", hit: "l1", open: null }), { kind: "pass" });
    assert.equal(labelPaneAllowed({ role: "player", tool: "select", mode: "label" }), false);
  });
});

describe("paneSizes", () => {
  test("a label of a listed size gets the list as it is", () => {
    for (const o of LABEL_SIZES) assert.deepEqual(paneSizes(o.value), LABEL_SIZES.map((s) => ({ value: s.value, label: s.label })));
  });

  test("a listed size off by a rounding error shows as that size, with the label's own value", () => {
    const sizes = paneSizes(0.7 + 1e-9);
    assert.deepEqual(
      sizes.map((o) => o.label),
      ["S", "M", "L"],
    );
    assert.equal(sizes[1]?.value, 0.7 + 1e-9);
  });

  test("a size the list lacks stays a choice, in order", () => {
    assert.deepEqual(
      paneSizes(2).map((o) => o.label),
      ["S", "M", "L", "2"],
    );
    assert.deepEqual(
      paneSizes(0.555).map((o) => [o.value, o.label]),
      [
        [0.45, "S"],
        [0.555, "0.56"],
        [0.7, "M"],
        [1.1, "L"],
      ],
    );
  });
});

describe("commitDraft", () => {
  const label = { x: 3.5, y: 4.25, text: "Crypt", size: 0.7 };

  test("an edit keeps the label where it is", () => {
    assert.deepEqual(commitDraft(label, { text: " Old crypt ", size: 1.1 }), { kind: "update", label: { x: 3.5, y: 4.25, text: "Old crypt", size: 1.1 } });
  });

  test("no change sends nothing", () => {
    assert.deepEqual(commitDraft(label, { text: "Crypt  ", size: 0.7 }), { kind: "unchanged" });
  });

  test("a label cannot be left without text", () => {
    assert.deepEqual(commitDraft(label, { text: "   ", size: 0.7 }), { kind: "empty" });
  });

  test("text past the protocol's 80 characters is refused", () => {
    assert.deepEqual(commitDraft(label, { text: "x".repeat(81), size: 0.7 }), { kind: "tooLong" });
    assert.equal(commitDraft(label, { text: "x".repeat(80), size: 0.7 }).kind, "update");
  });

  test("pasted control characters become spaces", () => {
    assert.equal(cleanLabelText("Trap\tdoor\n"), "Trap door");
    assert.equal(cleanLabelText("a\u2028b"), "a b");
  });
});

describe("undo and redo of what the pane sends", () => {
  // The server's undo keeps the reducer's inverse of each op (server/rooms/undo.ts).
  const placed = apply(room(), { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: 3.5, y: 4.25, text: "Crypt", size: 0.7 } });
  const label = placed.labels["l1"]!;

  /** A label's content, leaving out `rev`, which every write moves forward, a restore's too. */
  const content = (l: { rev: number } | undefined) => (l ? { ...l, rev: 0 } : l);

  function roundTrip(op: Op) {
    const done = applyOp(placed, op, DM, env(2));
    assert.ok(done.ok && done.inverse);
    const undone = applyOp(done.state, { t: "sys.restore", entries: done.inverse, from: "undo" }, DM, env(3));
    assert.ok(undone.ok && undone.inverse);
    assert.deepEqual(content(undone.state.labels["l1"]), content(label));
    const redone = applyOp(undone.state, { t: "sys.restore", entries: undone.inverse, from: "redo" }, DM, env(4));
    assert.ok(redone.ok);
    assert.deepEqual(content(redone.state.labels["l1"]), content(done.state.labels["l1"]));
    return done.state;
  }

  test("an edit from Done", () => {
    const commit = commitDraft(label, { text: "Old crypt", size: 1.1 });
    assert.equal(commit.kind, "update");
    if (commit.kind !== "update") return;
    const after = roundTrip({ t: "build.label", sceneId: "s1", labelId: "l1", label: commit.label });
    assert.equal(after.labels["l1"]?.text, "Old crypt");
  });

  test("a delete", () => {
    const after = roundTrip({ t: "build.label", sceneId: "s1", labelId: "l1", label: null });
    assert.equal(after.labels["l1"], undefined);
  });
});

describe("delete confirm", () => {
  test("the first tap arms, a second within the window deletes", () => {
    const first = tapDelete(null, 1_000);
    assert.deepEqual(first, { armedAt: 1_000, confirmed: false });
    assert.equal(deleteArmed(first.armedAt, 1_000 + CONFIRM_MS - 1), true);
    assert.deepEqual(tapDelete(first.armedAt, 1_000 + CONFIRM_MS - 1), { armedAt: null, confirmed: true });
  });

  test("a second tap after the window arms again instead", () => {
    assert.equal(deleteArmed(1_000, 1_000 + CONFIRM_MS), false);
    assert.deepEqual(tapDelete(1_000, 1_000 + CONFIRM_MS), { armedAt: 1_000 + CONFIRM_MS, confirmed: false });
  });

  test("a clock that went back does not count as armed", () => {
    assert.equal(deleteArmed(5_000, 4_000), false);
  });
});

describe("paneEscape", () => {
  const base = { key: "Escape", handled: false, dialogOpen: false, editingElsewhere: false };
  test("Escape closes the pane, from the map or from inside the pane", () => {
    assert.equal(paneEscape(base), true);
  });
  test("a dialog, a field elsewhere or a sheet the room already closed keep it", () => {
    assert.equal(paneEscape({ ...base, dialogOpen: true }), false);
    assert.equal(paneEscape({ ...base, editingElsewhere: true }), false);
    assert.equal(paneEscape({ ...base, handled: true }), false);
    assert.equal(paneEscape({ ...base, key: "Enter" }), false);
  });
});

describe("panePlacement", () => {
  const insets = { top: 52, right: 0, bottom: 120, left: 0 };

  test("a phone gets a bottom sheet above the bars", () => {
    const p = panePlacement({ viewport: { width: 390, height: 844 }, insets, box: { x0: 100, y0: 300, x1: 200, y1: 330 }, height: 200, lane: null });
    assert.deepEqual(p, { kind: "sheet", bottom: 120, maxHeight: 844 - 120 - 8 - (52 + 8) });
  });

  test("a wide screen hangs it under the label, centered on it", () => {
    const p = panePlacement({ viewport: { width: 1280, height: 800 }, insets, box: { x0: 500, y0: 200, x1: 600, y1: 230 }, height: 200, lane: null });
    assert.deepEqual(p, { kind: "card", left: 550 - PANE_WIDTH / 2, top: 240, width: PANE_WIDTH, maxHeight: 800 - 120 - 8 - 240 });
  });

  test("near the bottom it goes over the label instead", () => {
    const p = panePlacement({ viewport: { width: 1280, height: 800 }, insets, box: { x0: 500, y0: 600, x1: 600, y1: 630 }, height: 200, lane: null });
    assert.equal(p.kind, "card");
    if (p.kind !== "card") return;
    assert.equal(p.top, 600 - 10 - 200);
  });

  test("it stays on screen beside an edge, and below the top bar for a label scrolled off the top", () => {
    const p = panePlacement({ viewport: { width: 1280, height: 800 }, insets, box: { x0: -80, y0: -60, x1: -20, y1: -40 }, height: 200, lane: null });
    assert.equal(p.kind, "card");
    if (p.kind !== "card") return;
    assert.equal(p.left, 8);
    assert.equal(p.top, 60);
  });

  test("a bottom sheet the bars leave less than its least height stands over the top bars, never past the screen's top (FU20B-PANE-480)", () => {
    // 480 x 320 at 130% with the Trap tool: 369 x 246 layout px, a 53 px top bar, and 99 px of toolbar and tool's options, so 78 px between the bars.
    const short = { top: 53, right: 0, bottom: 99, left: 0 };
    const box = { x0: 60, y0: 120, x1: 90, y1: 150 };
    assert.deepEqual(panePlacement({ viewport: { width: 369, height: 246 }, insets: short, box, height: 400, lane: null }), { kind: "sheet", bottom: 99, maxHeight: PANE_MIN_HEIGHT, overBars: true });
    // Exactly its least height between the bars: it keeps under them.
    const exact = { ...short, bottom: 246 - 53 - 16 - PANE_MIN_HEIGHT };
    assert.deepEqual(panePlacement({ viewport: { width: 369, height: 246 }, insets: exact, box, height: 400, lane: null }), { kind: "sheet", bottom: exact.bottom, maxHeight: PANE_MIN_HEIGHT });
    // Shorter still above the bottom bars than its least height: it stops at the screen's top.
    assert.deepEqual(panePlacement({ viewport: { width: 369, height: 200 }, insets: short, box, height: 400, lane: null }), { kind: "sheet", bottom: 99, maxHeight: 200 - 99, overBars: true });
  });

  test("a pane taller than either side takes the roomier one and scrolls", () => {
    const p = panePlacement({ viewport: { width: 700, height: 500 }, insets, box: { x0: 300, y0: 150, x1: 400, y1: 170 }, height: 400, lane: null });
    assert.equal(p.kind, "card");
    if (p.kind !== "card") return;
    assert.equal(p.top, 180);
    assert.equal(p.maxHeight, 500 - 120 - 8 - 180);
  });
});

describe("panePlacement beside the alerts lane (docs/design-v1-look-pass-2.md 2.8)", () => {
  // The lane as the panes read it: the chrome and the column's facts in the zoomed layout px the panes are placed in.
  const chrome = { top: 52, bottom: 60, controls: 60, toolbar: 60, safe: { top: 0, right: 0, bottom: 0, left: 0 }, sheet: 0 };
  const insets = { top: 52, right: 0, bottom: 60, left: 0 };
  const column = { top: 60, content: 180, first: 160 };
  const laneOf = (viewport: { width: number; height: number }) => paneLaneBox({ viewport, chrome, column, folded: false });

  test("with no column, nothing changes", () => {
    const viewport = { width: 1440, height: 900 };
    const box = { x0: 1200, y0: 100, x1: 1260, y1: 160 };
    assert.deepEqual(panePlacement({ viewport, insets, box, height: 300, lane: null }), { kind: "card", left: 1230 - PANE_WIDTH / 2, top: 170, width: PANE_WIDTH, maxHeight: 900 - 60 - 8 - 170 });
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 844, height: 390 },
    { width: 820, height: 1180 },
  ]) {
    test(`at ${viewport.width} x ${viewport.height}, a card by a thing under the cards keeps its right edge 8 px left of the lane`, () => {
      const lane = laneOf(viewport);
      assert.ok(lane);
      // The lane is the token window's: the free area's right 312 px.
      assert.equal(lane.left, viewport.width - 8 - LANE_WIDTH);
      const box = { x0: viewport.width - 120, y0: 70, x1: viewport.width - 60, y1: 110 };
      const p = panePlacement({ viewport, insets, box, height: 200, lane });
      assert.equal(p.kind, "card");
      if (p.kind !== "card") return;
      assert.equal(p.lane, "beside");
      assert.equal(p.left + p.width, lane.left - 8);
      assert.equal(p.width, PANE_WIDTH);
      // Beside, it stands as high as the bars let it, by its thing.
      assert.equal(p.top, 120);
    });
  }

  test("a card by a thing left of the lane stays where it was, beside", () => {
    const viewport = { width: 1440, height: 900 };
    const lane = laneOf(viewport);
    const box = { x0: 300, y0: 100, x1: 360, y1: 160 };
    const p = panePlacement({ viewport, insets, box, height: 200, lane });
    assert.deepEqual(p, { kind: "card", left: 330 - PANE_WIDTH / 2, top: 170, width: PANE_WIDTH, maxHeight: 900 - 60 - 8 - 170, lane: "beside" });
  });

  test("at 600 px at 130% (a 780 x 1040 tablet) the lane leaves no room beside it, so the card keeps under the column's summary row", () => {
    const viewport = { width: 600, height: 800 };
    const lane = laneOf(viewport);
    assert.ok(lane);
    assert.equal(lane.left, 600 - 8 - LANE_WIDTH);
    assert.equal(lane.top, 60);
    const box = { x0: 400, y0: 40, x1: 460, y1: 70 };
    const p = panePlacement({ viewport, insets, box, height: 200, lane });
    assert.equal(p.kind, "card");
    if (p.kind !== "card") return;
    assert.equal(p.lane, "summary");
    // Under the row's 44 px and the 8 px margin, where without the lane it would hang 10 px under its thing.
    assert.equal(p.top, 60 + SUMMARY_ROW + 8);
    const without = panePlacement({ viewport, insets, box, height: 200, lane: null });
    assert.equal(without.kind === "card" ? without.top : null, 80);
    // Over its thing near the foot, it still stops under the row.
    const low = panePlacement({ viewport, insets, box: { x0: 400, y0: 300, x1: 460, y1: 330 }, height: 600, lane });
    assert.equal(low.kind, "card");
    if (low.kind !== "card") return;
    assert.ok(low.top >= 60 + SUMMARY_ROW + 8, `the card reaches over the row: ${JSON.stringify(low)}`);
  });

  test("a summary row that rose over the bars moves the card's limit with it", () => {
    const viewport = { width: 600, height: 800 };
    // A thing near the top, so the card's top is the limit, not its place under the thing.
    const box = { x0: 400, y0: 0, x1: 460, y1: 10 };
    const topOf = (row: number | undefined) => {
      const lane = paneLaneBox({ viewport, chrome, column: row === undefined ? column : { ...column, row }, folded: false });
      const p = panePlacement({ viewport, insets, box, height: 200, lane });
      return p.kind === "card" ? p.top : null;
    };
    assert.equal(topOf(20), 20 + SUMMARY_ROW + 8, "under the risen row, which stands over the top bar");
    assert.equal(topOf(60), 60 + SUMMARY_ROW + 8, "under the row in its usual place");
    const without = panePlacement({ viewport, insets, box, height: 200, lane: null });
    assert.equal(without.kind === "card" ? without.top : null, 52 + 8, "without the lane, only the top bar holds it");
  });

  test("a phone keeps its bottom sheet, which leaves the column to fold under it", () => {
    const viewport = { width: 390, height: 844 };
    const p = panePlacement({ viewport, insets, box: { x0: 300, y0: 80, x1: 340, y1: 120 }, height: 200, lane: laneOf(viewport) });
    assert.deepEqual(p, { kind: "sheet", bottom: 60, maxHeight: 844 - 60 - 52 - 16 });
  });
});

describe("sheetPanAnchor", () => {
  const viewport = { width: 390, height: 844 };
  const insets = { top: 52, right: 0, bottom: 280, left: 0 };

  test("a label the sheet would cover moves to the middle of the map left above it", () => {
    const anchor = sheetPanAnchor({ viewport, insets, sheetHeight: 214, box: { x0: 150, y0: 500, x1: 230, y1: 520 } });
    const top = 52 + 8;
    const bottom = 844 - 280 - 214 - 8;
    assert.deepEqual(anchor, { x: 0.5, y: (top + bottom) / 2 / 844 });
  });

  test("a label already in view stays put", () => {
    assert.equal(sheetPanAnchor({ viewport, insets, sheetHeight: 214, box: { x0: 150, y0: 200, x1: 230, y1: 220 } }), null);
  });

  test("a label off the side moves into view", () => {
    assert.notEqual(sheetPanAnchor({ viewport, insets, sheetHeight: 214, box: { x0: 370, y0: 200, x1: 450, y1: 220 } }), null);
  });

  test("no room left above the sheet asks for nothing", () => {
    assert.equal(sheetPanAnchor({ viewport, insets, sheetHeight: 600, box: { x0: 150, y0: 500, x1: 230, y1: 520 } }), null);
  });
});
