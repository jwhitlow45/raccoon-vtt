import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bends, Router, TURN_COST, type RouteOptions, type XY } from "./corridors.ts";
import { Board, placeDoorway, type Rect } from "./layout.ts";
import { Stream } from "./random.ts";

/*
 * The corridor search (docs/design/design-v1-dungeon-generator.md 5.3 step
 * 6 and 5.4) on boards made by hand.
 */

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const options = (left: number, turn = TURN_COST, wide = false): RouteOptions => ({ wide, turn, budget: { left } });

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
    // A corridor laid two rows down: with cheap turns the way joins it.
    const { board, da, db, router } = pair();
    for (let x = 12; x < 38; x++) board.laid[board.cell(x, 19)] = 1;
    const found = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000, 2));
    assert.ok(found.ok);
    assert.ok(found.cells.filter((k) => board.laid[k] === 1).length >= 20);
    // At a turn's full cost the four turns cost more than the laid squares save, so it keeps its own straight way.
    const straight = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000));
    assert.ok(straight.ok);
    assert.ok(straight.cells.every((k) => Math.floor(k / board.W) === 17));
  });

  test("a corridor joins one laid beside its way rather than running alongside it as one wide patch", () => {
    const { board, da, db, router } = pair();
    for (let x = 12; x < 38; x++) board.laid[board.cell(x, 18)] = 1;
    const found = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000));
    assert.ok(found.ok);
    assert.ok(found.cells.filter((k) => board.laid[k] === 1).length >= 20, "along the laid corridor");
    assert.ok(!found.cells.some((k) => Math.floor(k / board.W) === 17 && k % board.W > 13 && k % board.W < 36), "not beside it");
  });

  test("on Wide move a 2 by 2 block, so the corridor is two squares across", () => {
    const board = new Board(60, 40, [rect(5, 15, 6, 6), rect(40, 15, 6, 6)]);
    const da = placeDoorway(board, 0, ["e"], board.rooms[1]!, 2, 0)!;
    const db = placeDoorway(board, 1, ["w"], board.rooms[0]!, 2, 0)!;
    const found = new Router(board).route(da, { anchor: board.anchor(db), side: db.side }, options(100_000, TURN_COST, true));
    assert.ok(found.ok);
    const rows = new Set(found.cells.map((k) => Math.floor(k / board.W)));
    assert.deepEqual([...rows].sort(), [17, 18]);
    for (const k of [...da.outside, ...db.outside]) assert.ok(found.cells.includes(k));
  });

  test("a turn costs enough that a way takes one bend where it can", () => {
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

  test("a corridor passes its waypoints in order, never crossing or running beside itself", () => {
    // Doorways facing across 30 squares of rock, waypoints alternating 3 squares off the line.
    const { board, da, db, router } = pair();
    const points: XY[] = [[16, 14], [22, 20], [28, 14], [34, 20]];
    const found = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000), () => points);
    assert.ok(found.ok);
    const at = (x: number, y: number) => found.chain.indexOf(board.cell(x, y));
    const order = points.map(([x, y]) => at(x, y));
    assert.ok(order.every((i) => i > 0), `every waypoint passed: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in order");
    assert.equal(new Set(found.chain).size, found.chain.length, "no square twice");
    assert.equal(found.cells.length, found.chain.length);
    // Each square touches only the squares before and after it on the way: no wide patch.
    const index = new Map(found.chain.map((k, i) => [k, i]));
    found.chain.forEach((k, i) => {
      for (const n of [k - 1, k + 1, k - board.W, k + board.W]) {
        const j = index.get(n);
        if (j !== undefined) assert.equal(Math.abs(i - j), 1, `squares ${i} and ${j} touch`);
      }
    });
    assert.equal(found.cells[0], da.outside[0]);
    assert.equal(found.cells.at(-1), db.outside[0]);
  });

  test("a waypoint on a closed square moves to an open one, and one no leg can reach is passed over", () => {
    // The second waypoint touches a room's side: it moves to the nearest open square, a row up.
    const { board, da, db, router } = pair([rect(24, 22, 4, 4)]);
    const through = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000), () => [[16, 14], [25, 21], [32, 14]]);
    assert.ok(through.ok);
    for (const [x, y] of [[16, 14], [25, 20], [32, 14]] as const) assert.ok(through.chain.includes(board.cell(x, y)), `through ${x},${y}`);
    for (const k of through.cells) assert.equal(board.roomAt[k], 0);
    // A waypoint in a pocket four rooms close: no leg reaches it, so the corridor goes on to the next.
    const pocket = pair([rect(26, 0, 9, 3), rect(26, 8, 9, 3), rect(24, 0, 2, 11), rect(35, 0, 2, 11)]);
    const past = pocket.router.route(pocket.da, { anchor: pocket.board.anchor(pocket.db), side: pocket.db.side }, options(100_000), () => [[29, 5], [25, 25]]);
    assert.ok(past.ok);
    assert.ok(past.chain.includes(pocket.board.cell(25, 25)) && !past.chain.includes(pocket.board.cell(29, 5)));
  });

  test("a leg never runs beside an earlier one, and a waypoint up a dead end is taken back so the goal is tried from the one before", () => {
    // Out to the east, then back west a row down: that second leg would run beside the first, so its waypoint is passed over.
    const { board, da, db, router } = pair();
    const back = router.route(da, { anchor: board.anchor(db), side: db.side }, options(100_000), () => [[30, 17], [20, 18]]);
    assert.ok(back.ok);
    assert.ok(back.cells.every((k) => Math.floor(k / board.W) === 17), "straight along the row, the way back passed over");
    // A slot between two rooms, shut at its top: the corridor reaches the waypoint up it but cannot come out, so the goal is tried from the waypoint before.
    const slot = pair([rect(30, 5, 3, 8), rect(36, 5, 3, 8), rect(30, 2, 9, 2)]);
    const taken = slot.router.route(slot.da, { anchor: slot.board.anchor(slot.db), side: slot.db.side }, options(100_000), () => [[20, 14], [34, 6]]);
    assert.ok(taken.ok);
    assert.ok(taken.chain.includes(slot.board.cell(20, 14)), "through the first waypoint");
    assert.ok(!taken.chain.includes(slot.board.cell(34, 6)), "not up the slot");
    assert.equal(taken.cells.at(-1), slot.db.outside[0]);
  });

  test("Straight takes no waypoints, Bending one or two, Winding one every few squares on alternate sides, each set off by 2 or more", () => {
    const rng = new Stream(new Uint8Array(32), new Uint8Array(12));
    const a: XY = [10, 20];
    for (const length of [3, 5, 6, 9, 12, 17, 18, 30, 60]) {
      const b: XY = [10 + length, 20];
      assert.deepEqual(bends(rng, "straight", a, b), []);
      const bending = bends(rng, "bending", a, b);
      assert.equal(bending.length, length < 6 ? 0 : length < 18 ? 1 : 2, `bending at ${length}`);
      const winding = bends(rng, "winding", a, b);
      assert.equal(winding.length, Math.min(12, Math.max(0, Math.floor(length / 3) - 1)), `winding at ${length}`);
      for (const [i, [x, y]] of [...bending, ...winding].entries()) {
        assert.ok(Math.abs(y - 20) >= 2, `set off at ${length}: ${i}`);
        assert.ok(x > 10 && x < 10 + length);
      }
      // Winding alternates sides, and its last point leaves 3 squares before the far end.
      winding.forEach(([, y], i) => i > 0 && assert.notEqual(Math.sign(y - 20), Math.sign(winding[i - 1]![1] - 20)));
      if (winding.length > 0) assert.ok(winding.at(-1)![0] <= 10 + length - 3);
      // A way down the map sets its points off across, to the sides.
      for (const [x] of bends(rng, "winding", a, [10, 20 + length])) assert.ok(Math.abs(x - 10) >= 2);
    }
  });
});
