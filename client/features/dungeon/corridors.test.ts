import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Router, TURN_COST, type RouteOptions } from "./corridors.ts";
import { Board, placeDoorway, type Rect } from "./layout.ts";

/*
 * The corridor search (docs/design/design-v1-dungeon-generator.md 5.3 step
 * 6 and 5.4) on boards made by hand.
 */

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const options = (left: number, turn = TURN_COST.straight, wide = false): RouteOptions => ({ wide, turn, noise: null, budget: { left } });

/** Two rooms on one row, a doorway each facing the other, and any rooms between. */
function pair(between: Rect[] = [], W = 60, H = 40) {
  const a = rect(5, 15, 5, 5);
  const b = rect(40, 15, 5, 5);
  const board = new Board(W, H, [a, b, ...between]);
  const da = placeDoorway(board, 0, ["e"], b, 1, 0)!;
  const db = placeDoorway(board, 1, ["w"], a, 1, 0)!;
  return { board, da, db, router: new Router(board) };
}

describe("corridors", () => {
  test("run straight between doorways that face each other, leaving the first and ending on the second", () => {
    const { board, da, db, router } = pair();
    const found = router.route(da, { anchor: board.anchor(db), side: db.side }, options(10_000));
    assert.ok(found.ok);
    assert.equal(found.cells[0], da.outside[0]);
    assert.equal(found.cells.at(-1), db.outside[0]);
    assert.equal(found.cells.length, 40 - 10 + 1 - 1);
    assert.ok(found.cells.every((k) => Math.floor(k / board.W) === 17));
  });

  test("spend the budget one expansion each, and fail with it empty", () => {
    const { board, da, db, router } = pair();
    const budget = options(10_000);
    assert.ok(router.route(da, { anchor: board.anchor(db), side: db.side }, budget).ok);
    const spent = 10_000 - budget.budget.left;
    assert.ok(spent >= 30);
    assert.deepEqual(router.route(da, { anchor: board.anchor(db), side: db.side }, options(spent - 1)), { ok: false, why: "budget" });
    assert.ok(router.route(da, { anchor: board.anchor(db), side: db.side }, options(spent)).ok);
  });

  test("keep to the ends' box grown by 12 squares first, then take the whole map", () => {
    // A long room between them, open only far below the box.
    const { board, da, db, router } = pair([rect(24, 3, 3, 32)]);
    const found = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000));
    assert.ok(found.ok);
    assert.ok(found.cells.some((k) => Math.floor(k / board.W) > 17 + 12));
    // Every square of it keeps off rooms and the squares touching them, but for the two doorways' outside squares.
    for (const k of found.cells) assert.ok(board.roomAt[k] === 0 && (!board.halo(k) || k === da.outside[0] || k === db.outside[0]));
  });

  test("fail when no way exists, and corridors already laid cost less, so later ones join them", () => {
    const shut = pair([rect(24, 2, 3, 36)]);
    assert.deepEqual(shut.router.route(shut.da, { anchor: shut.board.anchor(shut.db), side: shut.db.side }, options(100_000)), { ok: false, why: "none" });
    // A corridor laid two rows down: with Bending's cheap turns the way joins it.
    const { board, da, db, router } = pair();
    for (let x = 12; x < 38; x++) board.laid[board.cell(x, 19)] = 1;
    const found = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000, TURN_COST.bending));
    assert.ok(found.ok);
    assert.ok(found.cells.filter((k) => board.laid[k] === 1).length >= 20);
    // Straight's four turns cost more than the laid squares save, so it keeps its own straight way.
    const straight = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000, TURN_COST.straight));
    assert.ok(straight.ok);
    assert.ok(straight.cells.every((k) => Math.floor(k / board.W) === 17));
  });

  test("on Wide move a 2 by 2 block, so the corridor is two squares across", () => {
    const board = new Board(60, 40, [rect(5, 15, 6, 6), rect(40, 15, 6, 6)]);
    const da = placeDoorway(board, 0, ["e"], board.rooms[1]!, 2, 0)!;
    const db = placeDoorway(board, 1, ["w"], board.rooms[0]!, 2, 0)!;
    const found = new Router(board).route(da, { anchor: board.anchor(db), side: db.side }, options(100_000, TURN_COST.straight, true));
    assert.ok(found.ok);
    const rows = new Set(found.cells.map((k) => Math.floor(k / board.W)));
    assert.deepEqual([...rows].sort(), [17, 18]);
    for (const k of [...da.outside, ...db.outside]) assert.ok(found.cells.includes(k));
  });

  test("turns cost by style: Straight takes one bend where it can", () => {
    // Doorways a row apart: Straight keeps one long stretch, never a staircase.
    const a = rect(5, 10, 5, 5);
    const b = rect(40, 22, 5, 5);
    const board = new Board(60, 40, [a, b]);
    const da = placeDoorway(board, 0, ["e"], b, 1, 0)!;
    const db = placeDoorway(board, 1, ["n"], a, 1, 0)!;
    const found = new Router(board).route(da, { anchor: board.anchor(db), side: db.side }, options(100_000));
    assert.ok(found.ok);
    let turns = 0;
    for (let i = 2; i < found.cells.length; i++) if (found.cells[i]! - found.cells[i - 1]! !== found.cells[i - 1]! - found.cells[i - 2]!) turns++;
    assert.equal(turns, 1);
  });
});
