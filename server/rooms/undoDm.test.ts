import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Token } from "#shared/model.ts";
import { DM, member, room, token } from "#shared/testutil.ts";
import { UndoTable } from "./undoTesting.ts";

/*
 * The DM's undo of moves between squares (docs/design/design-v1-snap-off.md
 * 5.5): where a token is drawn in its box is part of its pose, so a Play
 * undo puts it back with the place while keeping the DM's later edits of
 * anything else, as it does a squeeze.
 */

const gob = (over: Partial<Token> = {}) => token("gob", { name: "Goblin", x: 3, y: 3, ...over });
const table = (over: Partial<Token> = {}) => new UndoTable(room({ members: { dm1: member("dm1", "dm") }, tokens: { gob: gob(over) } }));
const spot = (t: Token) => [t.x, t.y, t.nudge ?? null];

describe("the DM's undo of a placement (5.5)", () => {
  test("a free move undoes to the square it left, and an ordinary move undoes to the placement it left", () => {
    const free = table();
    assert.equal(free.play(DM, { t: "token.move", tokenId: "gob", x: 6, y: 3, drawnAt: { x: 6.125, y: 3.375 } }), "ok");
    assert.deepEqual(spot(free.t("gob")), [6, 3, { x: 1, y: 3 }]);
    assert.equal(free.undo(DM), "ok");
    assert.deepEqual(spot(free.t("gob")), [3, 3, null]);
    assert.equal(free.redo(DM), "ok");
    assert.deepEqual(spot(free.t("gob")), [6, 3, { x: 1, y: 3 }]);

    const placed = table({ nudge: { x: -3, y: 2 } });
    assert.equal(placed.play(DM, { t: "token.move", tokenId: "gob", x: 7, y: 3 }), "ok");
    assert.equal(placed.undo(DM), "ok");
    assert.deepEqual(spot(placed.t("gob")), [3, 3, { x: -3, y: 2 }], "the nudge back");
  });

  test("a note made since stays, and the placement still comes back with the place", () => {
    const t = table({ nudge: { x: 2, y: 0 } });
    assert.equal(t.play(DM, { t: "token.move", tokenId: "gob", x: 8, y: 4 }), "ok");
    assert.equal(t.play(DM, { t: "token.update", tokenId: "gob", patch: { notes: "Wounded" } }), "ok");
    assert.equal(t.undo(DM), "ok", "the move, under the note");
    assert.deepEqual(spot(t.t("gob")), [3, 3, { x: 2, y: 0 }]);
    assert.equal(t.t("gob").notes, "Wounded");
  });

  test("Snap to grid and its undo", () => {
    const t = table({ nudge: { x: 1, y: 1 } });
    assert.equal(t.play(DM, { t: "token.update", tokenId: "gob", patch: { drawnAt: null } }), "ok");
    assert.equal(t.t("gob").nudge, undefined);
    assert.equal(t.undo(DM), "ok");
    assert.deepEqual(t.t("gob").nudge, { x: 1, y: 1 });
  });
});
