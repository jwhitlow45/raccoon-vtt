import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FREE_WALL_LATTICE, MAX_FREE_WALL_CELLS } from "#shared/model.ts";
import { clientOpSchema, MAX_BUILD_CELLS, type ClientOp } from "#shared/protocol.ts";
import { cornerAt, hexCenter, hexCorners, hexDistance, hexKey, parseHexKey, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { apply, rng, room, scene } from "#shared/testutil.ts";
import { hexBrush, hexEraseOps, hexesInRect, hexRoughOps, hexStroke, lineFeature, wallLineOps, wallPieces, wallPoint } from "./hexBuild.ts";

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const BOUNDS = { w: 30, h: 20 };
const onLattice = (v: number) => Number.isInteger(v * FREE_WALL_LATTICE);

describe("Wall lines snap to hex corners (HX-D7)", () => {
  test("a point lands on the nearest hex corner of the scene, on either orientation, as a brute force over every corner near it finds", () => {
    const random = rng(61);
    for (const g of [ROWS, COLUMNS]) {
      for (let i = 0; i < 2000; i++) {
        const p = { x: 2 + random() * 26, y: 2 + random() * 16 };
        const got = wallPoint(g, p, true, BOUNDS);
        let best = Infinity;
        for (const h of sceneHexes(g, BOUNDS)) {
          const c = hexCenter(g, h);
          if (Math.abs(c.x - p.x) > 2 || Math.abs(c.y - p.y) > 2) continue;
          for (const k of hexCorners(g, h)) {
            const q = cornerAt(g, k);
            best = Math.min(best, (q.x - p.x) ** 2 + (q.y - p.y) ** 2);
          }
        }
        const d = (got.x - p.x) ** 2 + (got.y - p.y) ** 2;
        assert.ok(Math.abs(d - best) < 1e-9, `${g.orient} ${p.x},${p.y}: ${got.x},${got.y} at ${d}, nearest at ${best}`);
        assert.ok(onLattice(got.x) && onLattice(got.y));
      }
    }
  });

  test("two taps beside one corner give its one point, whichever hex they fall in", () => {
    const corner = cornerAt(ROWS, { hex: { col: 5, row: 4 }, k: 1 });
    const a = wallPoint(ROWS, { x: corner.x - 0.1, y: corner.y - 0.05 }, true, BOUNDS);
    const b = wallPoint(ROWS, { x: corner.x + 0.1, y: corner.y + 0.08 }, true, BOUNDS);
    assert.deepEqual(a, corner);
    assert.deepEqual(b, corner);
  });

  test("with Snap to hex corners off a point keeps its place on the 1/64 lattice, and stays in the scene", () => {
    assert.deepEqual(wallPoint(ROWS, { x: 3.3, y: 4.71 }, false, BOUNDS), { x: 211 / 64, y: 301 / 64 });
    assert.deepEqual(wallPoint(ROWS, { x: -2, y: 25 }, false, BOUNDS), { x: 0, y: 20 });
    const edge = wallPoint(COLUMNS, { x: 29.99, y: 19.99 }, true, BOUNDS);
    assert.ok(edge.x <= 30 && edge.y <= 20);
  });
});

describe("a Wall line's runs (HX-D7: split past 8 cells)", () => {
  test("a run past 8 cells splits into even pieces, each within the cap and on the lattice, end to end", () => {
    const random = rng(62);
    for (let i = 0; i < 500; i++) {
      const a = { x: Math.round(random() * 200 * 64) / 64, y: Math.round(random() * 200 * 64) / 64 };
      const b = { x: Math.round(random() * 200 * 64) / 64, y: Math.round(random() * 200 * 64) / 64 };
      const pieces = wallPieces(a, b);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const fewest = Math.ceil(length / MAX_FREE_WALL_CELLS);
      assert.ok(length === 0 ? pieces.length === 0 : pieces.length === fewest || pieces.length === fewest + 1, `${pieces.length} pieces for ${length}`);
      for (const [p, q] of pieces) {
        assert.ok((q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= MAX_FREE_WALL_CELLS ** 2);
        assert.ok([p.x, p.y, q.x, q.y].every(onLattice));
      }
      if (pieces.length > 0) {
        assert.deepEqual(pieces[0]![0], a);
        assert.deepEqual(pieces[pieces.length - 1]![1], b);
        for (let k = 1; k < pieces.length; k++) assert.deepEqual(pieces[k]![0], pieces[k - 1]![1]);
      }
    }
  });

  test("a run of exactly 8 cells stays one wall, and one of 8 and a bit is two", () => {
    assert.equal(wallPieces({ x: 1, y: 1 }, { x: 9, y: 1 }).length, 1);
    assert.equal(wallPieces({ x: 1, y: 1 }, { x: 9 + 1 / 64, y: 1 }).length, 2);
    assert.equal(wallPieces({ x: 1, y: 1 }, { x: 1, y: 1 }).length, 0);
  });

  test("a line's ops put one free wall per piece, with the choice's feature, and the protocol takes them", () => {
    let n = 0;
    const points = [cornerAt(ROWS, { hex: { col: 1, row: 1 }, k: 0 }), cornerAt(ROWS, { hex: { col: 12, row: 1 }, k: 0 }), cornerAt(ROWS, { hex: { col: 12, row: 6 }, k: 1 })];
    const ops = wallLineOps("s1", points, lineFeature("door", false)!, () => `w${String(n++).padStart(11, "0")}`);
    assert.equal(ops.length, 1);
    const op = ops[0] as Extract<ClientOp, { t: "build.walls" }>;
    assert.equal(op.put?.length, 2 + 1, "11 cells along the row in two pieces, then the run down in one");
    for (const w of op.put ?? []) assert.deepEqual(w.f, { kind: "door", state: "closed", secret: false, discovered: false });
    for (const o of ops) clientOpSchema.parse(o);
  });

  test("the choices draw walls, doors, secret doors and windows, No wall draws walls and Remove draws nothing", () => {
    assert.deepEqual(lineFeature("wall", false), { kind: "wall" });
    assert.deepEqual(lineFeature("none", false), { kind: "wall" });
    assert.deepEqual(lineFeature("window", true), { kind: "window" });
    assert.deepEqual(lineFeature("secret", true), { kind: "door", state: "closed", secret: true, discovered: true });
    assert.deepEqual(lineFeature("secret", false), { kind: "door", state: "closed", secret: true, discovered: false });
    assert.equal(lineFeature("clear", false), null);
  });

  test("a long line goes in several ops of the protocol's size", () => {
    const zigzag = Array.from({ length: 401 }, (_, i) => ({ x: 1 + (i % 2), y: 1 + (i % 2) }));
    const ops = wallLineOps("s1", zigzag, { kind: "wall" });
    assert.ok(ops.length > 1);
    assert.equal(ops.reduce((sum, o) => sum + ((o as Extract<ClientOp, { t: "build.walls" }>).put?.length ?? 0), 0), 400);
    for (const o of ops) clientOpSchema.parse(o);
  });
});

describe("the brush and the area by hexes (HX-D9)", () => {
  test("a brush of 1, 2 and 3 takes the hex under it, and those within one and two steps", () => {
    for (const g of [ROWS, COLUMNS]) {
      const p = hexCenter(g, { col: 10, row: 10 });
      assert.deepEqual(hexBrush(g, p, 1, BOUNDS), ["10,10"]);
      assert.equal(hexBrush(g, p, 2, BOUNDS).length, 7);
      const three = hexBrush(g, p, 3, BOUNDS);
      assert.equal(three.length, 19);
      for (const key of three) assert.ok(hexDistance(g, parseHexKey(key)!, { col: 10, row: 10 }) <= 2);
    }
  });

  test("a brush at the scene's edge keeps to the scene's hexes", () => {
    const keys = hexBrush(ROWS, hexCenter(ROWS, { col: 0, row: 0 }), 2, BOUNDS);
    assert.deepEqual(keys.sort(), ["0,0", "0,1", "1,0"].sort());
  });

  test("a stroke adds each hex once", () => {
    const seen = new Set<string>();
    const first = hexStroke(ROWS, null, { x: 2, y: 2 }, 1, BOUNDS, seen);
    const more = hexStroke(ROWS, { x: 2, y: 2 }, { x: 8, y: 2 }, 1, BOUNDS, seen);
    assert.equal(new Set([...first, ...more]).size, first.length + more.length);
    assert.ok(more.length >= 5);
  });

  test("an area takes the scene's hexes whose centers lie in it, as a search of every hex finds", () => {
    const random = rng(63);
    for (const g of [ROWS, COLUMNS]) {
      for (let i = 0; i < 200; i++) {
        const a = { x: random() * 32 - 1, y: random() * 22 - 1 };
        const b = { x: random() * 32 - 1, y: random() * 22 - 1 };
        const want = sceneHexes(g, BOUNDS)
          .filter((h) => {
            const c = hexCenter(g, h);
            return c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x) && c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y);
          })
          .map(hexKey)
          .sort();
        assert.deepEqual([...hexesInRect(g, a, b, BOUNDS)].sort(), want);
      }
    }
  });
});

describe("the ops a hex gesture sends", () => {
  const hexRoom = () => room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: BOUNDS }) } });

  test("difficult ground leaves out the hexes already so", () => {
    const marked = apply(hexRoom(), { t: "build.rough", sceneId: "s1", cells: ["3,3"], on: true });
    assert.deepEqual(hexRoughOps(marked, "s1", ["3,3", "4,3"], true), [{ t: "build.rough", sceneId: "s1", cells: ["4,3"], on: true }]);
    assert.deepEqual(hexRoughOps(marked, "s1", ["3,3", "4,3"], false), [{ t: "build.rough", sceneId: "s1", cells: ["3,3"], on: false }]);
  });

  test("Erase sends only the hexes with something to take, chunked to the protocol's size", () => {
    let state = apply(hexRoom(), { t: "build.rough", sceneId: "s1", cells: ["3,3"], on: true });
    const c = hexCenter(ROWS, { col: 6, row: 2 });
    state = apply(state, { t: "build.walls", sceneId: "s1", put: [{ id: "w00000000001", a: [Math.round((c.x - 0.25) * 64) / 64, Math.round(c.y * 64) / 64], b: [Math.round((c.x + 0.25) * 64) / 64, Math.round(c.y * 64) / 64], f: { kind: "wall" } }] });
    assert.deepEqual(hexEraseOps(state, ROWS, "s1", ["3,3", "6,2", "9,9"]), [{ t: "build.erase", sceneId: "s1", cells: ["3,3", "6,2"] }]);
    const many = Array.from({ length: MAX_BUILD_CELLS + 1 }, () => "3,3");
    assert.equal(hexEraseOps(state, ROWS, "s1", many).length, 2);
  });
});
