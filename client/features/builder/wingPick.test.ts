import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tileKey, wallChunk } from "#shared/keys.ts";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FreeWall, type RoomState, type Scene, type TerrainId } from "#shared/model.ts";
import { encodeHeights } from "#shared/heightCodec.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexCenter, hexKey, hexNeighbors, sameHex, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { room, scene } from "#shared/testutil.ts";
import { encodeTileFrom } from "../../lib/fogTiles.ts";
import {
  areaBetween,
  areaLine,
  dragHint,
  hexAreaCovers,
  hexAreaOutline,
  JOIN_WORDS,
  judgeJoin,
  readyHint,
  sideEnds,
  tapAt,
  WING_OFF,
  WING_REVEALED,
  WING_SIGHT,
  wingOff,
  wingWarnings,
  type WingJoin,
  type WingTap,
} from "./wingPick.ts";

/*
 * Add a wing's picks (docs/design: dungeon generator phase 3, 3.1 and 3.2):
 * the area a drag draws, the wall a tap joins on squares and hexes, Narrow
 * and Wide, and the two warnings.
 */

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };

// ------------------------------------------------------------ fixtures

type Cells = Record<string, TerrainId>;

function chunksOf(sceneId: string, input: { cells?: Cells; edges?: Record<string, EdgeFeature>; walls?: FreeWall[]; heights?: Record<string, number> }): Record<string, BuildChunk> {
  const out: Record<string, BuildChunk> = {};
  const at = (cx: number, cy: number) => (out[`${sceneId}:${cx},${cy}`] ??= { sceneId, cx, cy, rev: 1, cells: {}, edges: {} });
  const chunkOfCell = (key: string) => {
    const [x, y] = key.split(",").map(Number) as [number, number];
    return at(Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS));
  };
  for (const [key, t] of Object.entries(input.cells ?? {})) chunkOfCell(key).cells[key] = t;
  for (const [key, f] of Object.entries(input.edges ?? {})) chunkOfCell(key).edges[key] = f;
  for (const wall of input.walls ?? []) {
    const { cx, cy } = wallChunk(wall);
    (at(cx, cy).walls ??= []).push(wall);
  }
  const heights = new Map<BuildChunk, Int16Array>();
  for (const [key, ft] of Object.entries(input.heights ?? {})) {
    const chunk = chunkOfCell(key);
    const [x, y] = key.split(",").map(Number) as [number, number];
    const list = heights.get(chunk) ?? new Int16Array(CHUNK_CELLS * CHUNK_CELLS);
    list[(y - chunk.cy * CHUNK_CELLS) * CHUNK_CELLS + (x - chunk.cx * CHUNK_CELLS)] = ft;
    heights.set(chunk, list);
  }
  for (const [chunk, list] of heights) {
    const encoded = encodeHeights(list);
    if (encoded) chunk.heights = encoded;
  }
  return out;
}

function rect(x0: number, y0: number, w: number, h: number, t: TerrainId = "stone"): Cells {
  const out: Cells = {};
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out[`${x},${y}`] = t;
  return out;
}

const SQUARE_SCENE: Scene = scene("s1", { bounds: { w: 60, h: 60 } });

function squareRoom(input: Parameters<typeof chunksOf>[1], over: Partial<Scene> = {}): { view: RoomState; scene: Scene } {
  const s = { ...SQUARE_SCENE, ...over };
  return { view: room({ scenes: { s1: s }, buildChunks: chunksOf("s1", input) }), scene: s };
}

let nextId = 0;
const wallId = () => `w${String(nextId++).padStart(11, "0")}`;

/** A closed hex room: the hexes of a rectangle of keys, a wall on every side toward a hex outside it, `open` sides left out. */
function hexRoom(g: HexGrid, x0: number, y0: number, w: number, rows: number, opts: { open?: (h: Hex, d: number) => boolean; door?: (h: Hex, d: number) => boolean } = {}): FreeWall[] {
  const walls: FreeWall[] = [];
  const inRoom = (h: Hex) => h.col >= x0 && h.col < x0 + w && h.row >= y0 && h.row < y0 + rows;
  for (let row = y0; row < y0 + rows; row++) {
    for (let col = x0; col < x0 + w; col++) {
      const hex = { col, row };
      hexNeighbors(g, hex).forEach((n, d) => {
        if (inRoom(n) || opts.open?.(hex, d)) return;
        const [a, b] = sideEnds(g, hex, d);
        // Each side once: from the hex inside, whose neighbor is outside.
        walls.push({ id: wallId(), a: [a.x, a.y], b: [b.x, b.y], f: opts.door?.(hex, d) ? { kind: "door", state: "closed", secret: false, discovered: false } : { kind: "wall" } });
      });
    }
  }
  return walls;
}

function hexScene(g: HexGrid, walls: FreeWall[], over: Partial<Scene> = {}): { view: RoomState; scene: Scene } {
  const s = scene("s1", { bounds: { w: 40, h: 40 }, gridShape: g.orient === "rows" ? "hexRows" : "hexColumns", ...over });
  return { view: room({ scenes: { s1: s }, buildChunks: chunksOf("s1", { walls }) }), scene: s };
}

/** The tap of the wall on the side of `h` toward direction d. */
function wallTap(view: RoomState, g: HexGrid, h: Hex, d: number): WingTap {
  const [a, b] = sideEnds(g, h, d);
  for (const chunk of Object.values(view.buildChunks)) {
    const wall = chunk?.walls?.find((w) => (w.a[0] === a.x && w.a[1] === a.y && w.b[0] === b.x && w.b[1] === b.y) || (w.a[0] === b.x && w.a[1] === b.y && w.b[0] === a.x && w.b[1] === a.y));
    if (wall && chunk) return { grid: "hex", cx: chunk.cx, cy: chunk.cy, id: wall.id };
  }
  throw new Error(`no wall on ${hexKey(h)} toward ${d}`);
}

function joined(result: ReturnType<typeof judgeJoin>): WingJoin {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { ok: true; value: WingJoin }).value;
}

function problem(result: ReturnType<typeof judgeJoin>): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  return (result as { ok: false; problem: string }).problem;
}

// ------------------------------------------------------------ the mode and its words

describe("the wing mode's words", () => {
  test("off on a scene whose automatic walls are off, on everywhere else", () => {
    assert.equal(wingOff({ autoWalls: "off" }), WING_OFF);
    assert.equal(wingOff({ autoWalls: "floor" }), null);
    assert.equal(wingOff({ autoWalls: "all" }), null);
    assert.equal(wingOff({}), null, "a scene from before automatic walls reads as all");
    assert.equal(WING_OFF, "Automatic walls are off on this scene, so a wing would stand without walls. Turn them on in Map and grid to add one.");
  });

  test("the hint moves on from the drag to the tap to the area and join, in each grid's words", () => {
    assert.equal(dragHint(SQUARES), "Drag the wing's area over empty ground, up to 100 by 100.");
    assert.equal(dragHint(ROWS), "Drag the wing's area over empty ground, up to 100 hexes across and 100 rows down.");
    assert.equal(dragHint(COLUMNS), "Drag the wing's area over empty ground, up to 100 columns across and 100 hexes down.");
    assert.equal(readyHint(SQUARES, { x: 0, y: 0, w: 30, h: 44 }), "Area 30 by 44 squares, joined at the ringed wall.");
    assert.equal(readyHint(ROWS, { x: 0, y: 0, w: 30, h: 50 }), "Area 30 hexes across and 50 rows down, joined at the ringed wall.");
    assert.equal(readyHint(COLUMNS, { x: 0, y: 0, w: 50, h: 30 }), "Area 50 columns across and 30 hexes down, joined at the ringed wall.");
    assert.equal(areaLine(SQUARES, { x: 0, y: 0, w: 30, h: 44 }, 5), "Area 30 by 44 squares (150 by 220 ft)");
    assert.equal(areaLine(ROWS, { x: 0, y: 0, w: 30, h: 50 }, 5), "Area 30 hexes across and 50 rows down");
  });
});

// ------------------------------------------------------------ the area

describe("the area a drag draws", () => {
  const B = { w: 150, h: 150 };
  test("from the cell the drag began on to the one it is over", () => {
    assert.deepEqual(areaBetween(SQUARES, { x: 10.5, y: 20.5 }, { x: 39.5, y: 63.5 }, B), { x: 10, y: 20, w: 30, h: 44 });
    assert.deepEqual(areaBetween(SQUARES, { x: 39.5, y: 63.5 }, { x: 10.5, y: 20.5 }, B), { x: 10, y: 20, w: 30, h: 44 });
  });

  test("at least 12 a side, growing the way the drag went", () => {
    assert.deepEqual(areaBetween(SQUARES, { x: 30.5, y: 30.5 }, { x: 32.5, y: 31.5 }, B), { x: 30, y: 30, w: 12, h: 12 });
    assert.deepEqual(areaBetween(SQUARES, { x: 30.5, y: 30.5 }, { x: 28.5, y: 27.5 }, B), { x: 19, y: 19, w: 12, h: 12 });
  });

  test("at most 100 a side, the far end given up, so a 101st cell is never drawn", () => {
    assert.deepEqual(areaBetween(SQUARES, { x: 5.5, y: 5.5 }, { x: 105.5, y: 40.5 }, B), { x: 5, y: 5, w: 100, h: 36 });
    assert.deepEqual(areaBetween(SQUARES, { x: 140.5, y: 5.5 }, { x: 5.5, y: 5.5 }, B), { x: 41, y: 5, w: 100, h: 12 });
  });

  test("kept on the scene, a scene under 12 across giving all it has", () => {
    assert.deepEqual(areaBetween(SQUARES, { x: 145.5, y: 145.5 }, { x: 148.5, y: 149.5 }, B), { x: 138, y: 138, w: 12, h: 12 });
    assert.deepEqual(areaBetween(SQUARES, { x: 2.5, y: 2.5 }, { x: 3.5, y: 3.5 }, { w: 8, h: 40 }), { x: 0, y: 2, w: 8, h: 12 });
  });

  test("on hexes, of hex keys, 100 hexes across and 100 rows down at most: 88 cells down hold more rows than that", () => {
    const g = ROWS;
    const big = { w: 120, h: 88 };
    const from = hexCenter(g, { col: 0, row: 0 });
    const to = hexCenter(g, { col: 110, row: 101 });
    assert.deepEqual(areaBetween(g, from, to, big), { x: 0, y: 0, w: 100, h: 100 });
    assert.deepEqual(areaBetween(g, hexCenter(g, { col: 3, row: 4 }), hexCenter(g, { col: 32, row: 53 }), big), { x: 3, y: 4, w: 30, h: 50 });
  });
});

describe("a hex area covers no build", () => {
  test("a wall through the area covers it, one along its edge does not", () => {
    const walls = hexRoom(ROWS, 10, 10, 3, 3);
    const { view, scene: s } = hexScene(ROWS, walls);
    assert.equal(hexAreaCovers(view, s, { x: 8, y: 8, w: 12, h: 12 }), true, "the room's walls run through it");
    assert.equal(hexAreaCovers(view, s, { x: 10, y: 10, w: 3, h: 3 }), false, "the room's own hexes, its walls all along the edge");
    assert.equal(hexAreaCovers(view, s, { x: 20, y: 20, w: 12, h: 12 }), false);
  });

  test("a height, a stair or difficult ground mark, a label, light or stamp in it covers it", () => {
    const s = scene("s1", { bounds: { w: 40, h: 40 }, gridShape: "hexRows" });
    const area = { x: 20, y: 20, w: 12, h: 12 };
    const raised = room({ scenes: { s1: s }, buildChunks: chunksOf("s1", { heights: { "25,25": 5 } }) });
    assert.equal(hexAreaCovers(raised, s, area), true);
    const c = hexCenter(ROWS, { col: 25, row: 25 });
    const lit = room({ scenes: { s1: s }, lights: { l1: { id: "l1", rev: 1, sceneId: "s1", x: c.x, y: c.y, bright: 20, dim: 20, color: "#ffffff", on: true } as never } });
    assert.equal(hexAreaCovers(lit, s, area), true);
    assert.equal(hexAreaCovers(lit, s, { x: 2, y: 2, w: 12, h: 12 }), false);
  });

  test("its outline runs along the sides toward hexes outside it", () => {
    const sides = hexAreaOutline(ROWS, { x: 2, y: 2, w: 3, h: 2 }, { w: 40, h: 40 });
    // Six hexes of two rows: 36 sides less the 9 they share, each counted from both of its hexes.
    assert.equal(sides.length, 18);
  });
});

// ------------------------------------------------------------ joins on squares

describe("a join on squares", () => {
  const ROOM = rect(5, 5, 5, 5);
  const AREA = { x: 20, y: 0, w: 20, h: 20 };
  const judge = (input: Parameters<typeof chunksOf>[1], key: string, wide = false, over: Partial<Scene> = {}) => {
    const { view, scene: s } = squareRoom(input, over);
    return judgeJoin(view, s, { grid: "squares", key }, AREA, wide);
  };

  test("an automatic wall between floor and unpainted ground, the painted side inside", () => {
    const j = joined(judge({ cells: ROOM }, "10,7,w"));
    assert.deepEqual(j.leaves, [{ inside: "9,7", outside: "10,7", a: { x: 10, y: 7 }, b: { x: 10, y: 8 } }]);
    assert.deepEqual(j.expect, { grid: "squares", edges: [{ key: "10,7,w", feature: null, ground: 0 }] });
    assert.equal(joined(judge({ cells: ROOM }, "7,5,n")).leaves[0]!.inside, "7,5", "a north wall, the inside below");
    assert.equal(joined(judge({ cells: ROOM }, "5,7,w")).leaves[0]!.outside, "4,7", "a west wall, the outside to the left");
  });

  test("a drawn wall, and a door that keeps its state", () => {
    assert.deepEqual(joined(judge({ cells: ROOM, edges: { "10,7,w": { kind: "wall" } } }, "10,7,w")).expect, { grid: "squares", edges: [{ key: "10,7,w", feature: { kind: "wall" }, ground: 0 }] });
    const door: EdgeFeature = { kind: "door", state: "locked", secret: false, discovered: false };
    assert.deepEqual((joined(judge({ cells: ROOM, edges: { "10,7,w": door } }, "10,7,w")).expect as { edges: { feature: unknown }[] }).edges[0]!.feature, door);
  });

  test("a window, No wall, floor both sides and ground both sides are no join", () => {
    assert.equal(problem(judge({ cells: ROOM, edges: { "10,7,w": { kind: "window" } } }, "10,7,w")), JOIN_WORDS.window);
    assert.equal(problem(judge({ cells: ROOM, edges: { "10,7,w": { kind: "none" } } }, "10,7,w")), JOIN_WORDS.squaresNone);
    assert.equal(problem(judge({ cells: ROOM }, "7,7,w")), JOIN_WORDS.squaresNone);
    assert.equal(problem(judge({ cells: ROOM }, "30,30,w")), JOIN_WORDS.squaresNone);
    assert.equal(problem(judge({ cells: { ...ROOM, ...rect(10, 7, 1, 1, "water") } }, "10,7,w")), JOIN_WORDS.squaresNone, "water beyond is painted ground, not empty");
  });

  test("a tap nearer a free wall than a grid edge says squares join grid lines", () => {
    const free: FreeWall = { id: wallId(), a: [10.25, 6], b: [10.25, 9], f: { kind: "wall" } };
    const { view, scene: s } = squareRoom({ cells: ROOM, walls: [free] });
    assert.deepEqual(tapAt(view, s, { x: 10.3, y: 7.5 }, 0.5), { ok: false, problem: JOIN_WORDS.squaresFree });
    assert.deepEqual(tapAt(view, s, { x: 9.95, y: 7.5 }, 0.5), { ok: true, value: { grid: "squares", key: "10,7,w" } });
    assert.equal(tapAt(view, s, { x: 30.5, y: 30.5 }, 0.2), null, "nothing within reach");
  });

  test("on a scene whose walls follow floor terrain the floor inside stands at 0 ft, raised or sunk refused", () => {
    for (const ft of [5, -5, -10]) {
      assert.equal(problem(judge({ cells: ROOM, heights: { "9,7": ft } }, "10,7,w", false, { autoWalls: "floor" })), JOIN_WORDS.floorRaised, `${ft} ft`);
    }
    assert.equal(joined(judge({ cells: ROOM }, "10,7,w", false, { autoWalls: "floor" })).leaves.length, 1);
    // On "all" a raised join gets a run instead.
    assert.deepEqual(joined(judge({ cells: ROOM, heights: { "9,7": 5 } }, "10,7,w")).expect, { grid: "squares", edges: [{ key: "10,7,w", feature: null, ground: 5 }] });
  });

  test("Wide takes the next edge along the wall to the right as seen from outside, else the left, else says so", () => {
    // East wall, outside to the east, facing west: right is north.
    assert.deepEqual(joined(judge({ cells: ROOM }, "10,7,w", true)).leaves.map((l) => l.inside), ["9,6", "9,7"]);
    // At the room's top corner north has no floor inside, so the edge south of it.
    assert.deepEqual(joined(judge({ cells: ROOM }, "10,5,w", true)).leaves.map((l) => l.inside), ["9,5", "9,6"]);
    // North wall, outside above, facing south: right is west.
    assert.deepEqual(joined(judge({ cells: ROOM }, "7,5,n", true)).leaves.map((l) => l.inside), ["6,5", "7,5"]);
    // South wall, outside below, facing north: right is east.
    assert.deepEqual(joined(judge({ cells: ROOM }, "7,10,n", true)).leaves.map((l) => l.inside), ["7,9", "8,9"]);
    assert.equal(problem(judge({ cells: rect(5, 5, 5, 1) }, "10,5,w", true)), JOIN_WORDS.wideSquares);
  });

  test("Wide on a scene that walls floor terrain holds both inside cells to 0 ft", () => {
    assert.equal(problem(judge({ cells: ROOM, heights: { "9,6": 5 } }, "10,7,w", true, { autoWalls: "floor" })), JOIN_WORDS.floorRaised);
  });
});

// ------------------------------------------------------------ joins on hexes

describe("a join on hexes", () => {
  for (const g of [ROWS, COLUMNS]) {
    describe(g.orient, () => {
      const AREA = { x: 22, y: 22, w: 12, h: 12 };
      // Hex columns read as mirrored rows (hex.ts), so the same room's hexes swap their column and row there, and each direction names the mirrored neighbor.
      const at = (col: number, row: number): Hex => (g.orient === "rows" ? { col, row } : { col: row, row: col });

      test("a one-side wall of a closed room, top, bottom, east and west at both parities, the room's side inside", () => {
        const walls = hexRoom(g, 10, 10, 4, 4);
        const { view, scene: s } = hexScene(g, walls);
        // Directions on the rows lattice: 0 east, 3 west, 4 and 5 the upper slants, 1 and 2 the lower (mirrored on columns).
        for (const [h, d] of [
          [at(13, 10), 0],
          [at(13, 11), 0],
          [at(10, 10), 3],
          [at(10, 11), 3],
          [at(11, 10), 5],
          [at(11, 13), 1],
          [at(12, 10), 4],
          [at(12, 13), 2],
        ] as const) {
          const j = joined(judgeJoin(view, s, wallTap(view, g, h, d), AREA, false));
          assert.equal(j.leaves.length, 1);
          assert.equal(j.leaves[0]!.inside, hexKey(h), `${hexKey(h)} toward ${d}`);
          assert.equal(j.leaves[0]!.outside, hexKey(hexNeighbors(g, h)[d]!));
          assert.equal(j.expect.grid, "hex");
        }
      });

      test("waits for the area, since the outside is the side that reaches it", () => {
        const { view, scene: s } = hexScene(g, hexRoom(g, 10, 10, 4, 4));
        assert.deepEqual(judgeJoin(view, s, wallTap(view, g, at(13, 11), 0), null, false), { ok: "area" });
      });

      test("a room open somewhere else, a wall with nothing beyond, a longer wall and a window say so", () => {
        const open = hexRoom(g, 10, 10, 4, 4, { open: (h, d) => sameHex(h, at(10, 12)) && d === 3 });
        const a = hexScene(g, open);
        assert.equal(problem(judgeJoin(a.view, a.scene, wallTap(a.view, g, at(13, 11), 0), AREA, false)), JOIN_WORDS.hexOpen);
        // Open, and the area shut away in a room of its own: neither side reaches it, but the room's opening is what to say.
        const openShut = hexScene(g, [...open, ...hexRoom(g, 20, 20, 16, 16)]);
        assert.equal(problem(judgeJoin(openShut.view, openShut.scene, wallTap(openShut.view, g, at(13, 11), 0), AREA, false)), JOIN_WORDS.hexOpen);

        // The area inside another closed room: neither side's flood reaches it.
        const shut = [...hexRoom(g, 10, 10, 4, 4), ...hexRoom(g, 20, 20, 16, 16)];
        const b = hexScene(g, shut);
        assert.equal(problem(judgeJoin(b.view, b.scene, wallTap(b.view, g, at(13, 11), 0), AREA, false)), JOIN_WORDS.hexBeyond);

        const [p, q] = sideEnds(g, at(13, 11), 0);
        const long: FreeWall = { id: wallId(), a: [p.x, p.y], b: [q.x + (q.x - p.x), q.y + (q.y - p.y)], f: { kind: "wall" } };
        const c = hexScene(g, [long]);
        assert.equal(problem(judgeJoin(c.view, c.scene, { grid: "hex", ...wallChunk(long), id: long.id }, AREA, false)), JOIN_WORDS.hexLong);

        const window: FreeWall = { id: wallId(), a: [p.x, p.y], b: [q.x, q.y], f: { kind: "window" } };
        const d = hexScene(g, [window]);
        assert.equal(problem(judgeJoin(d.view, d.scene, { grid: "hex", ...wallChunk(window), id: window.id }, AREA, false)), JOIN_WORDS.window);
      });

      test("a door one side long joins, and an open door bounds the room as a closed one does", () => {
        const walls = hexRoom(g, 10, 10, 4, 4, { door: (h, d) => (sameHex(h, at(13, 11)) && d === 0) || (sameHex(h, at(10, 12)) && d === 3) });
        for (const w of walls) if (w.f.kind === "door" && !(w.a[0] === sideEnds(g, at(13, 11), 0)[0].x && w.a[1] === sideEnds(g, at(13, 11), 0)[0].y)) w.f = { ...w.f, state: "open" };
        const { view, scene: s } = hexScene(g, walls);
        const j = joined(judgeJoin(view, s, wallTap(view, g, at(13, 11), 0), AREA, false));
        assert.equal((j.expect as { walls: { f: { kind: string } }[] }).walls[0]!.f.kind, "door");
      });

      test("Wide takes three sides between two inside hexes and two outside, the tapped side in the middle where it can be", () => {
        const walls = hexRoom(g, 10, 10, 4, 4);
        const { view, scene: s } = hexScene(g, walls);
        for (const [h, d] of [
          [at(11, 10), 5],
          [at(12, 13), 2],
          [at(13, 10), 0],
          [at(13, 11), 0],
          [at(10, 11), 3],
          [at(10, 12), 3],
        ] as const) {
          const j = joined(judgeJoin(view, s, wallTap(view, g, h, d), AREA, true));
          assert.equal(j.leaves.length, 3, `${hexKey(h)} toward ${d}`);
          assert.equal(new Set(j.leaves.map((l) => l.inside)).size, 2);
          assert.equal(new Set(j.leaves.map((l) => l.outside)).size, 2);
          assert.ok(j.leaves.some((l) => l.inside === hexKey(h) && l.outside === hexKey(hexNeighbors(g, h)[d]!)), "the tapped side among them");
        }
        // On the top wall the tapped side has one shared neighbor in the room and one outside it, so it is the middle.
        const top = joined(judgeJoin(view, s, wallTap(view, g, at(11, 10), 5), AREA, true));
        assert.deepEqual(top.leaves[1]!.inside, hexKey(at(11, 10)));
      });

      test("Wide in a room one hex wide has no second inside hex, and says so", () => {
        const { view, scene: s } = hexScene(g, hexRoom(g, 10, 10, 1, 1));
        assert.equal(problem(judgeJoin(view, s, wallTap(view, g, at(10, 10), 0), AREA, true)), JOIN_WORDS.wideHex);
      });
    });
  }
});

// ------------------------------------------------------------ the warnings

describe("the warnings", () => {
  const AREA = { x: 20, y: 4, w: 12, h: 12 };
  const ROOM = rect(5, 5, 5, 5);
  /** The players' scene with fog and vision on, the join at the room's east wall. */
  function base(over: Partial<RoomState> = {}): { view: RoomState; scene: Scene; join: WingJoin } {
    const s = scene("s1", { bounds: { w: 60, h: 60 }, fogEnabled: true, vision: { on: true, light: "bright" } });
    const view = room({ scenes: { s1: s }, buildChunks: chunksOf("s1", { cells: ROOM }), ...over });
    view.meta = { ...view.meta, playerSceneId: "s1" };
    return { view, scene: s, join: joined(judgeJoin(view, s, { grid: "squares", key: "10,7,w" }, AREA, false)) };
  }
  /** A fog tile with only one cell's sub-cells set. */
  const tileWith = (x: number, y: number) => ({
    [tileKey("s1", Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS))]: {
      sceneId: "s1",
      tx: Math.floor(x / CHUNK_CELLS),
      ty: Math.floor(y / CHUNK_CELLS),
      rev: 1,
      bits: encodeTileFrom((sx, sy) => Math.floor(sx / 4) === x % CHUNK_CELLS && Math.floor(sy / 4) === y % CHUNK_CELLS),
    },
  });

  test("none while nothing of the area or the join is revealed or seen", () => {
    const { view, scene: s, join } = base();
    assert.deepEqual(wingWarnings(view, s, AREA, join), []);
  });

  test("revealed ground in the area, or only the join's inside cell revealed with the area dark", () => {
    const inArea = base({ fogTiles: tileWith(25, 8) });
    assert.deepEqual(wingWarnings(inArea.view, inArea.scene, AREA, inArea.join), [WING_REVEALED]);
    const inside = base({ fogTiles: tileWith(9, 7) });
    assert.deepEqual(wingWarnings(inside.view, inside.scene, AREA, inside.join), [WING_REVEALED], "the new door shows by its inside cell");
    const outside = base({ exploredTiles: tileWith(10, 7) });
    assert.deepEqual(wingWarnings(outside.view, outside.scene, AREA, outside.join), [WING_REVEALED], "ground the party explored counts");
    const elsewhere = base({ fogTiles: tileWith(40, 40) });
    assert.deepEqual(wingWarnings(elsewhere.view, elsewhere.scene, AREA, elsewhere.join), []);
  });

  test("the party's sight over the join or the area", () => {
    const seen = base();
    const sighted = { ...seen.view, sight: { [tileKey("s1", 0, 0)]: { f: 1 } } } as RoomState;
    assert.deepEqual(wingWarnings(sighted, seen.scene, AREA, seen.join), [WING_SIGHT]);
    const away = { ...seen.view, sight: { [tileKey("s1", 3, 3)]: { f: 1 } } } as RoomState;
    assert.deepEqual(wingWarnings(away, seen.scene, AREA, seen.join), []);
  });

  test("none on a scene without fog, whose own line says players see it all", () => {
    const { view, scene: s, join } = base({ fogTiles: tileWith(25, 8) });
    assert.deepEqual(wingWarnings(view, { ...s, fogEnabled: false }, AREA, join), []);
  });
});
