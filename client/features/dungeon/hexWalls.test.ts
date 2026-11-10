import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HEX_R } from "#shared/rules/hex.ts";
import { CORRIDOR_SPACE, endsKey, hexSide, hexWalls, NO_SPACE, RUN_SPACE, wallPlaceholder, type WallDoorway } from "./hexWalls.ts";
import { latticeFor, type Lattice } from "./lattice.ts";
import { Board, placeDoorway, type Rect } from "./layout.ts";

/*
 * The hex wall pass (phase 3, 2.2, D-261110-086): one wall or leaf per side
 * between spaces and toward the outside, a doorway's sides leaves in one
 * state, nothing inside a run, a far landing open to the corridors, and the
 * way in's one border side open.
 */

const ROWS = latticeFor("hexRows", { w: 20, h: 20 });

function spaces(L: Lattice, cells: Record<number, number>): Int32Array {
  const space = new Int32Array(L.W * L.H).fill(NO_SPACE);
  for (const [k, v] of Object.entries(cells)) space[Number(k)] = v;
  return space;
}

const at = (L: Lattice, x: number, y: number) => y * L.W + x;
const keysOf = (walls: { a: [number, number]; b: [number, number] }[]) => walls.map((w) => endsKey(w.a, w.b));
const sideKey = (L: Lattice, k: number, d: number) => endsKey(...hexSide(L, k, d));

describe("the hex wall pass", () => {
  test("a lone floor hex is walled on all six sides, each wall one hex side long with its own ends", () => {
    const k = at(ROWS, 5, 5);
    const { walls } = hexWalls({ lattice: ROWS, space: spaces(ROWS, { [k]: 0 }), doorways: [], far: new Set(), wayIn: [] });
    assert.equal(walls.length, 6);
    assert.equal(new Set(keysOf(walls)).size, 6, "none twice");
    for (const w of walls) {
      assert.ok(Math.abs(Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) - HEX_R) < 1 / 32, "a hex side");
      assert.ok(Number.isInteger(w.a[0] * 64) && Number.isInteger(w.b[1] * 64), "on the 1/64 lattice");
      assert.equal(w.f, "wall");
    }
    for (let d = 0; d < 6; d++) assert.ok(keysOf(walls).includes(sideKey(ROWS, k, d)));
  });

  test("hexes of one space share no wall, two spaces one wall between, sorted by their ends", () => {
    const a = at(ROWS, 5, 5);
    const b = at(ROWS, 6, 5);
    const same = hexWalls({ lattice: ROWS, space: spaces(ROWS, { [a]: CORRIDOR_SPACE, [b]: CORRIDOR_SPACE }), doorways: [], far: new Set(), wayIn: [] });
    assert.equal(same.walls.length, 10);
    assert.ok(!keysOf(same.walls).includes(sideKey(ROWS, a, 0)));
    const apart = hexWalls({ lattice: ROWS, space: spaces(ROWS, { [a]: 0, [b]: 1 }), doorways: [], far: new Set(), wayIn: [] });
    assert.equal(apart.walls.length, 11);
    assert.equal(keysOf(apart.walls).filter((key) => key === sideKey(ROWS, a, 0)).length, 1);
    const sorted = [...apart.walls].sort((p, q) => p.a[0] - q.a[0] || p.a[1] - q.a[1] || p.b[0] - q.b[0] || p.b[1] - q.b[1]);
    assert.deepEqual(apart.walls, sorted);
  });

  test("a doorway's side is a leaf in the doorway's state, and on a cave stays open", () => {
    const room = at(ROWS, 5, 5);
    const out = at(ROWS, 6, 5);
    const space = spaces(ROWS, { [room]: 0, [out]: CORRIDOR_SPACE });
    for (const state of ["closed", "locked", "secret"] as const) {
      const { walls, leaves } = hexWalls({ lattice: ROWS, space, doorways: [{ inside: [room], outside: [out], state }], far: new Set(), wayIn: [] });
      const leaf = walls.filter((w) => w.f !== "wall");
      assert.equal(leaf.length, 1);
      assert.equal(leaf[0]!.f, state);
      assert.equal(endsKey(leaf[0]!.a, leaf[0]!.b), sideKey(ROWS, room, 0));
      assert.deepEqual(leaves, [[walls.indexOf(leaf[0]!)]]);
    }
    const cave = hexWalls({ lattice: ROWS, space, doorways: [{ inside: [room], outside: [out], state: "open" }], far: new Set(), wayIn: [] });
    assert.ok(!keysOf(cave.walls).includes(sideKey(ROWS, room, 0)));
  });

  test("a Wide doorway on every side and row parity takes three leaves in one state, the middle one first", () => {
    for (const y0 of [6, 7]) {
      const board = new Board(ROWS.W, ROWS.H, [{ x: 6, y: y0, w: 6, h: 5 }], ROWS);
      for (const [i, side] of (["n", "e", "s", "w"] as const).entries()) {
        const target: Rect = side === "n" ? { x: 8, y: 0, w: 1, h: 1 } : side === "s" ? { x: 8, y: ROWS.H - 1, w: 1, h: 1 } : side === "w" ? { x: 0, y: y0 + 2, w: 1, h: 1 } : { x: ROWS.W - 1, y: y0 + 2, w: 1, h: 1 };
        const d = placeDoorway(board, 0, [side], target, 2, i)!;
        const cells: Record<number, number> = {};
        for (let y = y0; y < y0 + 5; y++) for (let x = 6; x < 12; x++) cells[at(ROWS, x, y)] = 0;
        for (const k of d.outside) cells[k] = CORRIDOR_SPACE;
        const doorway: WallDoorway = { inside: d.inside, outside: d.outside, state: "locked" };
        const { walls, leaves } = hexWalls({ lattice: ROWS, space: spaces(ROWS, cells), doorways: [doorway], far: new Set(), wayIn: [] });
        const leafs = walls.filter((w) => w.f !== "wall");
        assert.equal(leafs.length, 3, `${side} at row ${y0}: ${leafs.length} leaves`);
        assert.ok(leafs.every((w) => w.f === "locked"));
        assert.equal(leaves[0]!.length, 3);
        // The middle leaf lies between two lanes, so a Large creature crosses it: its inside and outside hexes are of different lanes.
        const middle = walls[leaves[0]![0]!]!;
        const crossing = [0, 1].flatMap((li) => [0, 1].filter((lo) => li !== lo).map((lo) => [d.inside[li]!, d.outside[lo]!] as const)).find(([p, q]) => ROWS.halo(p).includes(q));
        assert.ok(crossing, `${side} at row ${y0} has a crossing side`);
        const dir = [0, 1, 2, 3, 4, 5].find((dd) => ROWS.step(crossing[0], dd, 1) === crossing[1])!;
        assert.equal(endsKey(middle.a, middle.b), sideKey(ROWS, crossing[0], dir), `${side} at row ${y0}: the middle leaf first`);
        board.removeDoorway(d);
      }
    }
  });

  test("no wall stands inside a run, a near landing is walled from the corridor, and a far landing opens to it and to another run's far landing", () => {
    // A run along a row: near landing 5, a stair 6, far landing 7, then a corridor hex 8, and a second run's far landing below the corridor.
    const [near, stair, far, corridor] = [5, 6, 7, 8].map((x) => at(ROWS, x, 5));
    const beside = at(ROWS, 5, 4);
    const otherFar = at(ROWS, 8, 6);
    const space = spaces(ROWS, { [near]: RUN_SPACE + 1, [stair]: RUN_SPACE + 1, [far]: RUN_SPACE + 1, [corridor]: CORRIDOR_SPACE, [beside]: CORRIDOR_SPACE, [otherFar]: RUN_SPACE + 2 });
    const { walls } = hexWalls({ lattice: ROWS, space, doorways: [], far: new Set([far, otherFar]), wayIn: [] });
    const keys = keysOf(walls);
    assert.ok(!keys.includes(sideKey(ROWS, near, 0)) && !keys.includes(sideKey(ROWS, stair, 0)), "inside the run");
    assert.ok(!keys.includes(sideKey(ROWS, far, 0)), "far landing to corridor");
    const toOther = [0, 1, 2, 3, 4, 5].find((d) => ROWS.step(corridor, d, 1) === otherFar)!;
    assert.ok(!keys.includes(sideKey(ROWS, corridor, toOther)), "corridor to another run's far landing");
    const farToOther = [0, 1, 2, 3, 4, 5].find((d) => ROWS.step(far, d, 1) === otherFar);
    if (farToOther !== undefined) assert.ok(!keys.includes(sideKey(ROWS, far, farToOther)), "far landing to far landing");
    const nearToBeside = [0, 1, 2, 3, 4, 5].find((d) => ROWS.step(near, d, 1) === beside)!;
    assert.ok(keys.includes(sideKey(ROWS, near, nearToBeside)), "near landing to the corridor beside it");
  });

  test("every side toward the outside is walled but the way in's border side, on an even row's end", () => {
    const even = at(ROWS, 0, 4);
    const odd = at(ROWS, 0, 5);
    const space = spaces(ROWS, { [even]: CORRIDOR_SPACE, [odd]: CORRIDOR_SPACE });
    const open = hexWalls({ lattice: ROWS, space, doorways: [], far: new Set(), wayIn: [{ cell: even, dir: 3 }] });
    const keys = keysOf(open.walls);
    assert.ok(!keys.includes(sideKey(ROWS, even, 3)), "the way in opens off the map");
    assert.ok(keys.includes(sideKey(ROWS, even, 4)) && keys.includes(sideKey(ROWS, even, 2)), "its slants toward the outside are walled");
    assert.ok(keys.includes(sideKey(ROWS, odd, 3)), "an odd row's end faces a sliver of the scene and is walled");
    const shut = hexWalls({ lattice: ROWS, space, doorways: [], far: new Set(), wayIn: [] });
    assert.ok(keysOf(shut.walls).includes(sideKey(ROWS, even, 3)), "without a way in the border side is walled too");
  });

  test("a side already holding a wall is left alone, and a join's leaf stands toward a room that is not the wing's floor", () => {
    const out = at(ROWS, 6, 5);
    const room = at(ROWS, 5, 5);
    const space = spaces(ROWS, { [out]: CORRIDOR_SPACE });
    const skip = new Set([sideKey(ROWS, out, 0), sideKey(ROWS, out, 3)]);
    const skipped = hexWalls({ lattice: ROWS, space, doorways: [], far: new Set(), wayIn: [], skip });
    assert.equal(skipped.walls.length, 4);
    const joined = hexWalls({ lattice: ROWS, space, doorways: [{ inside: [room], outside: [out], state: "closed" }], far: new Set(), wayIn: [], skip: new Set([sideKey(ROWS, out, 0)]) });
    const leaf = joined.walls.find((w) => w.f === "closed");
    assert.ok(leaf);
    assert.equal(endsKey(leaf.a, leaf.b), sideKey(ROWS, out, 3));
  });

  test("Hex columns wall the mirrored sides", () => {
    const L = latticeFor("hexColumns", { w: 20, h: 20 });
    const k = at(L, 5, 5);
    const { walls } = hexWalls({ lattice: L, space: spaces(L, { [k]: 0 }), doorways: [], far: new Set(), wayIn: [] });
    const rowsSide = hexSide(ROWS, at(ROWS, 5, 5), 0);
    const colsSide = hexSide(L, k, 0);
    assert.equal(endsKey(...colsSide), endsKey([rowsSide[0][1], rowsSide[0][0]], [rowsSide[1][1], rowsSide[1][0]]));
    assert.equal(walls.length, 6);
  });

  test("wall placeholders are free wall ids, one per index", () => {
    const ids = [0, 1, 35, 36, 5000].map(wallPlaceholder);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(new Set(ids).size, ids.length);
  });
});
