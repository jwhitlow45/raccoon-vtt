import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FOG_SUBCELLS, type BuildChunk, type EdgeFeature, type FogTile, type FreeWall, type WallFeature } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { rng } from "#shared/testutil.ts";
import { isometric, toView, type Turn } from "../../lib/view.ts";
import { FogView } from "./fogView.ts";
import { boundsOf, WALL_RISE, wallItems, type WallItem } from "./pieces.ts";
import { pillarPieces, wallPieces, type WallPiece } from "./runs.ts";

const SCENE = { id: "s1", autoWalls: "off" as const, bounds: { w: 16, h: 16 } };
const WALL: WallFeature = { kind: "wall" };

function build(edges: Record<string, EdgeFeature>, walls: FreeWall[] = [], extra: Partial<BuildChunk> = {}): Record<string, BuildChunk> {
  return { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges, ...(walls.length ? { walls } : {}), ...extra } };
}

/** A free wall, its ends put on the 1/64 lattice free walls are stored on. */
function free(id: string, a: [number, number], b: [number, number], f: WallFeature = WALL): FreeWall {
  const lattice = (v: number) => Math.round(v * 64) / 64;
  return { id: id.padEnd(12, "x"), a: [lattice(a[0]), lattice(a[1])], b: [lattice(b[0]), lattice(b[1])], f };
}

/** Fog revealing exactly the sub-cells listed, as [sx, sy]. */
function fogOf(subcells: readonly (readonly [number, number])[]): FogView {
  const bits = new Uint8Array(TILE_BYTES);
  for (const [sx, sy] of subcells) {
    const i = sy * TILE_SUB + sx;
    bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
  }
  const tiles: Record<string, FogTile> = { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
  return new FogView(tiles, "s1", SCENE.bounds);
}

const ALL = new FogView(null, "s1", SCENE.bounds);
const length = (p: WallPiece) => Math.hypot(p.bx - p.ax, p.by - p.ay);

describe("standing wall runs", () => {
  test("security: an edge with one sub-cell revealed on each side, or on one side only, stands a quarter of its length", () => {
    const walls = sceneWalls(SCENE, build({ "3,4,n": WALL }));
    // The edge runs from 3, 4 to 4, 4. Sub-cells above it are row 15, below it row 16.
    for (const fog of [fogOf([[13, 15], [13, 16]]), fogOf([[13, 15]]), fogOf([[13, 16]])]) {
      const pieces = wallPieces(walls, fog);
      assert.equal(pieces.length, 1);
      assert.ok(Math.abs(length(pieces[0]!) - 1 / FOG_SUBCELLS) < 1e-9);
      assert.deepEqual([pieces[0]!.ax, pieces[0]!.bx], [3.25, 3.5]);
    }
    assert.equal(wallPieces(walls, fogOf([[12, 14], [13, 17]])).length, 0, "fog right beside the edge on both sides");
  });

  test("the DM sees every wall stand, one piece per wall cell", () => {
    const pieces = wallPieces(sceneWalls(SCENE, build({ "3,4,n": WALL, "4,4,n": WALL, "5,4,w": WALL })), ALL);
    assert.equal(pieces.length, 3);
    for (const p of pieces) assert.ok(Math.abs(length(p) - 1) < 1e-9);
  });

  test("runs that stand apart within one cell stay apart, so a fogged run between them never stands", () => {
    const pieces = wallPieces(sceneWalls(SCENE, build({ "3,4,n": WALL })), fogOf([[12, 16], [15, 16]]));
    assert.deepEqual(
      pieces.map((p) => [p.ax, p.bx]),
      [
        [3, 3.25],
        [3.75, 4],
      ],
    );
  });

  test("a ledge and a pillar in the derived set make no wall piece", () => {
    const heights = new Int16Array(256);
    heights[4 * 16 + 4] = 10;
    const chunks = build({}, [], { cells: { "6,6": "pillar" }, heights: encodeHeights(Array.from(heights)) });
    const walls = sceneWalls(SCENE, chunks);
    assert.ok(walls.stored.n > 0, "the derived set holds the ledge and the pillar");
    assert.equal(wallPieces(walls, ALL).length, 0);
  });

  test("doors and windows: a closed door stands in wood, an open door lies flat, a window stands as a pane, a secret door not yet found stands as a wall", () => {
    const door = (state: "open" | "closed" | "locked", secret = false, discovered = false): EdgeFeature => ({ kind: "door", state, secret, discovered });
    const pieces = wallPieces(sceneWalls(SCENE, build({ "1,1,n": door("closed"), "2,1,n": door("open"), "3,1,n": { kind: "window" }, "4,1,n": door("locked", true), "5,1,n": door("open", true, true), "6,1,n": door("locked") })), ALL);
    assert.deepEqual(
      pieces.map((p) => [p.ax, p.kind]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [1, "door"],
        [3, "window"],
        [4, "wall"],
        [6, "door"],
      ],
    );
  });

  test("two free walls crossing in an X, and meeting in a T, are split where they meet, so no two pieces cross", () => {
    for (const walls of [
      [free("a", [2, 2], [4, 4]), free("b", [2, 4], [4, 2])],
      [free("a", [2, 3], [4, 3]), free("b", [3, 3], [3, 5])],
      [free("a", [2.1, 2.3], [5.7, 4.9]), free("b", [2.2, 4.6], [5.1, 2.05], { kind: "window" })],
    ]) {
      const pieces = wallPieces(sceneWalls(SCENE, build({}, walls)), ALL);
      for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 1; j < pieces.length; j++) assert.ok(!properlyCross(pieces[i]!, pieces[j]!), `${pieces[i]!.id} crosses ${pieces[j]!.id}`);
      }
      // Each piece lies within one cell, keeping its wall's feature.
      for (const p of pieces) {
        assert.ok(Math.floor(Math.min(p.ax, p.bx) + 1e-9) <= p.cx && Math.max(p.ax, p.bx) - 1e-9 <= p.cx + 1);
        assert.ok(Math.floor(Math.min(p.ay, p.by) + 1e-9) <= p.cy && Math.max(p.ay, p.by) - 1e-9 <= p.cy + 1);
      }
      assert.ok(pieces.some((p) => p.id.startsWith("f0,0:b")));
    }
  });

  test("a free wall's run inside one sub-cell stands by that sub-cell alone", () => {
    // A short diagonal inside the sub-cell at 9, 9 (cells 2.25 to 2.5).
    const walls = sceneWalls(SCENE, build({}, [free("a", [2.3, 2.3], [2.45, 2.4])]));
    assert.equal(walls.free.length, 1);
    assert.equal(wallPieces(walls, fogOf([[9, 9]])).length, 1);
    assert.equal(wallPieces(walls, fogOf([[8, 9], [10, 9], [9, 8], [9, 10]])).length, 0);
  });

  test("security: a pillar stands only where every sub-cell of its cell is revealed, and the DM sees every pillar stand", () => {
    const chunks = build({}, [], { cells: { "2,2": "pillar", "5,5": "pillar", "6,6": "stone" } });
    const whole: [number, number][] = [];
    for (let sy = 8; sy < 12; sy++) for (let sx = 8; sx < 12; sx++) whole.push([sx, sy]);
    // Cell 5, 5 with all but one sub-cell revealed.
    const most: [number, number][] = [];
    for (let sy = 20; sy < 24; sy++) for (let sx = 20; sx < 24; sx++) if (sx + sy > 40) most.push([sx, sy]);
    assert.deepEqual(
      pillarPieces(chunks, "s1", SCENE.bounds, fogOf([...whole, ...most])).map((p) => p.id),
      ["p2,2"],
    );
    assert.deepEqual(pillarPieces(chunks, "s1", SCENE.bounds, ALL).map((p) => p.id).sort(), ["p2,2", "p5,5"]);
    assert.equal(pillarPieces(chunks, "s1", { w: 4, h: 4 }, ALL).length, 1, "a pillar past the scene's edge does not stand");
  });

  test("property: every standing piece's runs each have a revealed sub-cell beside them, and every run with one stands", () => {
    const random = rng(26110);
    for (let round = 0; round < 60; round++) {
      const open: [number, number][] = [];
      for (let i = 0; i < 400; i++) open.push([Math.floor(random() * 64), Math.floor(random() * 64)]);
      const fog = fogOf(open);
      const edges: Record<string, EdgeFeature> = {};
      for (let i = 0; i < 30; i++) edges[`${Math.floor(random() * 15)},${Math.floor(random() * 15)},${random() < 0.5 ? "n" : "w"}`] = WALL;
      const walls = wallPieces(sceneWalls(SCENE, build(edges)), fog);
      const standing = new Set<string>();
      for (const p of walls) {
        // Walk the piece in quarter runs: each must have a revealed side.
        const n = Math.round(length(p) * FOG_SUBCELLS);
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const mx = p.ax + (p.bx - p.ax) * t;
          const my = p.ay + (p.by - p.ay) * t;
          const sides = p.ay === p.by ? [[Math.floor(mx * 4), p.ay * 4 - 1], [Math.floor(mx * 4), p.ay * 4]] : [[p.ax * 4 - 1, Math.floor(my * 4)], [p.ax * 4, Math.floor(my * 4)]];
          assert.ok(sides.some(([sx, sy]) => fog.revealed(sx!, sy!)), `round ${round}: ${p.id} run ${k} stands with fog on both sides`);
          standing.add(`${Math.floor(mx * 4)},${Math.floor(my * 4)},${p.ay === p.by ? "h" : "v"}`);
        }
      }
      for (const key of Object.keys(edges)) {
        const [x, y, side] = key.split(",");
        for (let k = 0; k < 4; k++) {
          const sides = side === "n" ? [[Number(x) * 4 + k, Number(y) * 4 - 1], [Number(x) * 4 + k, Number(y) * 4]] : [[Number(x) * 4 - 1, Number(y) * 4 + k], [Number(x) * 4, Number(y) * 4 + k]];
          if (!sides.some(([sx, sy]) => fog.revealed(sx!, sy!))) continue;
          const run = side === "n" ? `${Number(x) * 4 + k},${Number(y) * 4},h` : `${Number(x) * 4},${Number(y) * 4 + k},v`;
          assert.ok(standing.has(run), `round ${round}: ${key} run ${k} has a revealed side but lies flat`);
        }
      }
    }
  });
});

/** Whether two segments cross at a point inside both, not at an end. */
function properlyCross(p: WallPiece, q: WallPiece): boolean {
  const d = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(p.ax, p.ay, p.bx, p.by, q.ax, q.ay);
  const d2 = d(p.ax, p.ay, p.bx, p.by, q.bx, q.by);
  const d3 = d(q.ax, q.ay, q.bx, q.by, p.ax, p.ay);
  const d4 = d(q.ax, q.ay, q.bx, q.by, p.bx, p.by);
  const eps = 1e-9;
  return d1 * d2 < -eps && d3 * d4 < -eps;
}

describe("automatic walls beside raised ground", () => {
  const ROOM = { ...SCENE, autoWalls: "all" as const };
  const DOOR: EdgeFeature = { kind: "door", state: "closed", secret: false, discovered: false };

  /**
   * A room painted in stone from 2, 2 to 5, 5, so automatic walls ring it,
   * with ground in feet by cell and edge features as given, and the items
   * its walls stand as, read through drawn ground in cells.
   */
  function room(feet: Record<string, number>, edges: Record<string, EdgeFeature> = {}, feetPerCell = 5): WallItem[] {
    const cells: Record<string, "stone"> = {};
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) cells[`${x},${y}`] = "stone";
    const heights = new Int16Array(256);
    for (const [key, ft] of Object.entries(feet)) {
      const [x, y] = key.split(",").map(Number);
      heights[y! * 16 + x!] = ft;
    }
    const walls = sceneWalls(ROOM, build(edges, [], { cells, heights: encodeHeights(Array.from(heights)) }));
    const ground = (x: number, y: number) => (x >= 0 && y >= 0 && x < 16 && y < 16 ? heights[y * 16 + x]! / feetPerCell : 0);
    return wallItems({ ground }, wallPieces(walls, ALL));
  }

  const itemOn = (items: WallItem[], edge: string) => items.find((w) => w.piece.id.startsWith(`e${edge}@`));
  const top = (w: WallItem) => w.base + w.rise;

  /** The view box of a wall piece's line standing from z0 to z1, projected on its own. */
  function box(w: WallItem, turn: Turn, z0: number, z1: number) {
    const view = isometric(turn);
    const points = [z0, z1].flatMap((z) => [toView(view, { x: w.piece.ax, y: w.piece.ay }, z), toView(view, { x: w.piece.bx, y: w.piece.by }, z)]);
    return { x0: Math.min(...points.map((p) => p.x)), y0: Math.min(...points.map((p) => p.y)), x1: Math.max(...points.map((p) => p.x)), y1: Math.max(...points.map((p) => p.y)) };
  }

  test("beside a column taller than a wall, an automatic wall stands nothing, on both of the column's outer edges", () => {
    const items = room({ "2,2": 15 });
    assert.equal(itemOn(items, "2,2n"), undefined);
    assert.equal(itemOn(items, "2,2w"), undefined);
    assert.ok(items.some((w) => w.piece.auto), "the room's other automatic walls stand");
  });

  test("beside ground exactly a wall's height, 5 ft on a scene of 10 ft cells, an automatic wall stands nothing", () => {
    assert.equal(itemOn(room({ "3,2": 5 }, {}, 10), "3,2n"), undefined);
  });

  test("beside a platform lower than a wall, an automatic wall stands the rest, its top level with the wall on flat ground beside it, and its bounds are what it stands", () => {
    const items = room({ "4,2": 1 });
    const low = itemOn(items, "4,2n")!;
    const flat = itemOn(items, "3,2n")!;
    assert.ok(low.piece.auto && flat.piece.auto);
    assert.equal(low.base, 0.2);
    assert.ok(Math.abs(low.rise - 0.3) < 1e-9, `rise ${low.rise}`);
    assert.deepEqual([flat.base, flat.rise], [0, WALL_RISE]);
    assert.ok(Math.abs(top(low) - top(flat)) < 1e-9, `tops ${top(low)} and ${top(flat)}`);
    for (const turn of [0, 1, 2, 3] as const) {
      const got = boundsOf(low, turn);
      const want = box(low, turn, 0.2, 0.5);
      for (const k of ["x0", "y0", "x1", "y1"] as const) assert.ok(Math.abs(got[k] - want[k]) < 1e-9, `turn ${turn} ${k}: ${got[k]} against ${want[k]}`);
    }
  });

  test("a wall the DM drew on a column's edge stands on the column, as before", () => {
    const drawn = itemOn(room({ "2,2": 15 }, { "2,2,n": WALL }), "2,2n")!;
    assert.equal(drawn.piece.auto, false);
    assert.deepEqual([drawn.base, drawn.rise], [3, WALL_RISE]);
    const want = box(drawn, 0, 3, 3 + WALL_RISE);
    assert.deepEqual(boundsOf(drawn, 0), want);
  });

  test("a door on a raised edge stands on the higher ground, as before", () => {
    const door = itemOn(room({ "4,2": 10 }, { "4,2,n": DOOR }), "4,2n")!;
    assert.equal(door.piece.kind, "door");
    assert.deepEqual([door.base, door.rise], [2, WALL_RISE]);
  });

  test("beside a pit, and around a sunken room, an automatic wall stands on the ground at 0 as before", () => {
    const pit = itemOn(room({ "3,2": -10 }), "3,2n")!;
    assert.deepEqual([pit.base, pit.rise], [0, WALL_RISE]);
    const sunken: Record<string, number> = {};
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) sunken[`${x},${y}`] = -10;
    const items = room(sunken);
    assert.equal(items.length, 16, "every edge around the room stands");
    for (const w of items) assert.deepEqual([w.base, w.rise], [0, WALL_RISE], w.piece.id);
  });
});
