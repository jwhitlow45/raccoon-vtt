import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FogOp, FreeWall, WallFeature } from "../model.ts";
import { decodeTile, isSubcellFogged, rasterizeFogOps } from "./fog.ts";
import { cornerAt, hexAt, hexCenter, hexCorners, hexInScene, hexKey, hexNeighbors, hexSubcells, sceneHexes, type Hex, type HexGrid } from "./hex.ts";
import { deriveWalls, floodHexRoom, indexBuild, type WallSet } from "./walls.ts";

/**
 * Reveal room on a hex scene (docs/design-v1-hex-grids.md HX-D10, phase
 * H3): the hexes reachable from the tapped one, a step blocked where a
 * movement wall touches the line between two centers, and the fog a flood
 * writes read by the hexes' sub-cells.
 */

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };
const BOUNDS = { w: 20, h: 16 };
const CLOSED: WallFeature = { kind: "door", state: "closed", secret: false, discovered: false };

/** The hex across side `i` of a hex: the side from its corner i to corner i + 1, found past the side's middle. */
function across(g: HexGrid, h: Hex, i: number): Hex {
  const corners = hexCorners(g, h).map((c) => cornerAt(g, c));
  const a = corners[i]!;
  const b = corners[(i + 1) % 6]!;
  const c = hexCenter(g, h);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return hexAt(g, { x: 2 * mid.x - c.x, y: 2 * mid.y - c.y });
}

/** The sides of a set of hexes that face a hex outside it, each as its two corners and the hex beyond. */
function boundary(g: HexGrid, hexes: readonly Hex[], keepEdge = true): { a: { x: number; y: number }; b: { x: number; y: number }; beyond: Hex; from: Hex }[] {
  const set = new Set(hexes.map(hexKey));
  const out: { a: { x: number; y: number }; b: { x: number; y: number }; beyond: Hex; from: Hex }[] = [];
  for (const h of hexes) {
    const corners = hexCorners(g, h).map((c) => cornerAt(g, c));
    for (let i = 0; i < 6; i++) {
      const beyond = across(g, h, i);
      if (set.has(hexKey(beyond))) continue;
      if (!keepEdge && !hexInScene(g, BOUNDS, beyond)) continue;
      out.push({ a: corners[i]!, b: corners[(i + 1) % 6]!, beyond, from: h });
    }
  }
  return out;
}

let serial = 0;
function wall(a: { x: number; y: number }, b: { x: number; y: number }, f: WallFeature = { kind: "wall" }): FreeWall {
  return { id: `w${String(serial++).padStart(11, "0")}`, a: [a.x, a.y], b: [b.x, b.y], f };
}

function wallsOf(walls: FreeWall[]): WallSet {
  return deriveWalls(indexBuild([{ sceneId: "s", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls }]), `v${serial++}`, { bounds: BOUNDS });
}

/** A hex and its six neighbors, as a Huge creature stands. */
function seven(g: HexGrid, middle: Hex): Hex[] {
  return [middle, ...hexNeighbors(g, middle)];
}

const keys = (hexes: readonly Hex[]) => hexes.map(hexKey).sort();

for (const g of [ROWS, COLUMNS]) {
  const name = g.orient === "rows" ? "hex rows" : "hex columns";
  const middle: Hex = { col: 6, row: 6 };
  const room = seven(g, middle);
  const sides = boundary(g, room);
  const every = sceneHexes(g, BOUNDS);

  describe(`Reveal room on ${name}`, () => {
    test("a room closed by free walls, each its own wall end to end at the corners, floods exactly its hexes from any point inside", () => {
      const walls = wallsOf(sides.map((s) => wall(s.a, s.b)));
      assert.equal(sides.length, 18);
      for (const h of room) {
        const c = hexCenter(g, h);
        for (const p of [c, { x: c.x + 0.2, y: c.y - 0.15 }]) {
          const flood = floodHexRoom(walls, g, BOUNDS, p);
          assert.deepEqual(flood.cells.slice().sort(), keys(room), `from ${hexKey(h)}`);
          assert.equal(flood.truncated, false);
        }
      }
      const outside = floodHexRoom(walls, g, BOUNDS, hexCenter(g, { col: 1, row: 1 }));
      assert.equal(outside.cells.length, every.length - room.length, "the ground outside is one room too");
      assert.ok(!outside.cells.some((k) => room.some((h) => hexKey(h) === k)));
    });

    test("a door open and shut: closed, locked and windows bound the room, an open door joins it to the rest", () => {
      const [door, ...rest] = sides;
      const flood = (f: WallFeature) => floodHexRoom(wallsOf([wall(door!.a, door!.b, f), ...rest.map((s) => wall(s.a, s.b))]), g, BOUNDS, hexCenter(g, middle)).cells.length;
      assert.equal(flood(CLOSED), 7);
      assert.equal(flood({ ...CLOSED, state: "locked" }), 7);
      assert.equal(flood({ kind: "window" }), 7);
      assert.equal(flood({ ...CLOSED, state: "open" }), every.length, "through the open door to the whole scene");
      assert.equal(flood({ ...CLOSED, state: "open", secret: true, discovered: true }), every.length, "a secret door found and open");
      assert.equal(flood({ ...CLOSED, state: "open", secret: true, discovered: false }), 7, "a secret door not yet found is a movement wall, open or not");
    });

    test("a room open to the map's edge runs to it, and with no walls the room is the whole scene", () => {
      const open = floodHexRoom(wallsOf([]), g, BOUNDS, hexCenter(g, middle));
      assert.deepEqual(open.cells.slice().sort(), keys(every));
      // A corner of the scene walled off on its inner sides only: the scene's edge closes the rest.
      const corner = every.filter((h) => h.col <= 2 && h.row <= 2);
      const inner = boundary(g, corner, false);
      assert.ok(inner.length < boundary(g, corner).length, "some of its sides face the scene's edge");
      const walls = wallsOf(inner.map((s) => wall(s.a, s.b)));
      assert.deepEqual(floodHexRoom(walls, g, BOUNDS, hexCenter(g, { col: 0, row: 0 })).cells.slice().sort(), keys(corner));
      assert.ok(floodHexRoom(walls, g, BOUNDS, hexCenter(g, { col: 0, row: 0 })).cells.every((k) => hexInScene(g, BOUNDS, { col: Number(k.split(",")[0]), row: Number(k.split(",")[1]) })));
    });

    test("a flood never passes between two wall ends that only touch, where the line between two centers crosses them", () => {
      // The side between the middle hex and its first neighbor (east on rows, south on columns), drawn as two walls
      // whose ends meet at the lattice point nearest where the line between the two centers crosses the side, as a
      // wall traced with Snap off can be. Neither runs the side's whole length, and the east hex is walled off from
      // the rest of the room, so only that joint stands between the middle hex and it.
      const east = hexNeighbors(g, middle)[0]!;
      const side = boundary(g, [middle]).find((s) => hexKey(s.beyond) === hexKey(east))!;
      const a = hexCenter(g, middle);
      const lat = (v: number) => Math.round(v * 64) / 64;
      const upright = side.a.x === side.b.x;
      assert.equal(upright, g.orient === "rows", "the side runs square to the line between the centers");
      const joint = upright ? { x: side.a.x, y: lat(a.y) } : { x: lat(a.x), y: side.a.y };
      const nudge = upright ? { x: 0, y: 1 / 64 } : { x: 1 / 64, y: 0 };
      const away = (upright ? joint.y > a.y : joint.x > a.x) ? -1 : 1;
      const apart = { x: joint.x + away * nudge.x, y: joint.y + away * nudge.y };
      const rest = room.filter((h) => hexKey(h) !== hexKey(east) && hexKey(h) !== hexKey(middle));
      const cut = boundary(g, [east]).filter((s) => rest.some((h) => hexKey(h) === hexKey(s.beyond)));
      assert.equal(cut.length, 2, "the east hex's two sides on the rest of the room");
      const around = [...sides, ...cut].map((s) => wall(s.a, s.b));
      const touching = floodHexRoom(wallsOf([...around, wall(side.a, joint), wall(joint, side.b)]), g, BOUNDS, a);
      assert.ok(!touching.cells.includes(hexKey(east)), `the east hex stays out: ${touching.cells.join(" ")}`);
      assert.equal(touching.cells.length, 6);
      // The same two walls a lattice step apart, the line between the centers running through the gap.
      const along = (p: { x: number; y: number }) => (upright ? p.y : p.x);
      const [lo, hi] = along(side.a) < along(side.b) ? [side.a, side.b] : [side.b, side.a];
      const [near, far] = along(joint) < along(apart) ? [joint, apart] : [apart, joint];
      assert.ok(along(near) < along(a) && along(a) < along(far), "the gap holds the line");
      const gap = floodHexRoom(wallsOf([...around, wall(lo, near), wall(far, hi)]), g, BOUNDS, a);
      assert.ok(gap.cells.includes(hexKey(east)), "and with a gap between their ends it floods in");
    });

    test("a point in no hex of the scene has no room, and the fill stops at the limit", () => {
      const walls = wallsOf([]);
      assert.deepEqual(floodHexRoom(walls, g, BOUNDS, { x: -1, y: -1 }), { cells: [], truncated: false });
      const far = g.orient === "rows" ? { x: BOUNDS.w - 0.1, y: hexCenter(g, { col: 0, row: 1 }).y } : { x: hexCenter(g, { col: 1, row: 0 }).x, y: BOUNDS.h - 0.1 };
      assert.equal(hexInScene(g, BOUNDS, hexAt(g, far)), false, "the half hex past an odd line's end");
      assert.deepEqual(floodHexRoom(walls, g, BOUNDS, far), { cells: [], truncated: false });
      const capped = floodHexRoom(walls, g, BOUNDS, hexCenter(g, middle), { maxCells: 5 });
      assert.equal(capped.cells.length, 5);
      assert.equal(capped.truncated, true);
    });

    test("the fog of a flood reveals its hexes by their sub-cells, and no sub-cell of another hex", () => {
      const walls = wallsOf(sides.map((s) => wall(s.a, s.b)));
      const cells = floodHexRoom(walls, g, BOUNDS, hexCenter(g, middle)).cells;
      const op: FogOp = { id: "f", mode: "reveal", shape: { kind: "cells", cells } };
      const tiles = Object.fromEntries(Object.entries(rasterizeFogOps({}, "s", BOUNDS, [op], g)).flatMap(([k, t]) => (t ? [[k, t]] : [])));
      let revealed = 0;
      for (const t of Object.values(tiles)) for (const byte of decodeTile(t.bits) ?? []) for (let b = 0; b < 8; b++) revealed += (byte >> b) & 1;
      const subs = room.flatMap((h) => hexSubcells(g, h));
      assert.equal(revealed, subs.length, "exactly the room's sub-cells");
      for (const [sx, sy] of subs) assert.equal(isSubcellFogged(tiles, "s", sx, sy), false);
      for (const h of boundary(g, room).map((s) => s.beyond)) for (const [sx, sy] of hexSubcells(g, h)) assert.equal(isSubcellFogged(tiles, "s", sx, sy), true, `${hexKey(h)} stays fogged`);
      const hidden = rasterizeFogOps(tiles, "s", BOUNDS, [{ ...op, mode: "hide" }], g);
      assert.ok(Object.values(hidden).every((t) => t === null), "and a hide of the same hexes fogs them all again");
    });

    test("a key naming no hex of the scene reveals nothing, the half hex past an odd line's end included", () => {
      const half = g.orient === "rows" ? { col: BOUNDS.w - 1, row: 1 } : { col: 1, row: BOUNDS.h - 1 };
      assert.equal(hexInScene(g, BOUNDS, half), false);
      for (const key of [hexKey(half), "-1,3", "3,-1", "300,4", "x"]) {
        assert.deepEqual(rasterizeFogOps({}, "s", BOUNDS, [{ id: "f", mode: "reveal", shape: { kind: "cells", cells: [key] } }], g), {}, key);
      }
    });
  });
}

describe("Reveal room's cells on squares", () => {
  test("still read as squares, with or without a grid passed", () => {
    const op: FogOp = { id: "f", mode: "reveal", shape: { kind: "cells", cells: ["1,1"] } };
    const plain = rasterizeFogOps({}, "s", BOUNDS, [op]);
    assert.deepEqual(rasterizeFogOps({}, "s", BOUNDS, [op], { shape: "squares" }), plain);
    const tiles = Object.fromEntries(Object.entries(plain).flatMap(([k, t]) => (t ? [[k, t]] : [])));
    for (let sy = 4; sy < 8; sy++) for (let sx = 4; sx < 8; sx++) assert.equal(isSubcellFogged(tiles, "s", sx, sy), false);
    assert.equal(isSubcellFogged(tiles, "s", 8, 4), true);
  });
});
