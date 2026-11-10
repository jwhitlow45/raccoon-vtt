import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cornerAt, hexCorners, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { rng } from "#shared/testutil.ts";
import { GRID_TILE, hexLineTiles, squareLines, type LinePath, type Matrix } from "./gridTiles.ts";
import { hexesInView, hexRowSpans, strokeHexLines } from "./hexSpans.ts";

/*
 * The grid's lines kept in world cells and placed by the camera's matrix
 * (FU52PERF-LEFT): the tiles together draw the same strokes the walk over
 * the hexes in view drew, each side once, and a camera move builds only
 * tiles it has not seen.
 */

/** A path that keeps its strokes, each a polyline of points, and takes another's through a matrix as Path2D does. */
class Recorder implements LinePath<Recorder> {
  strokes: { x: number; y: number }[][] = [];
  moveTo(x: number, y: number): void {
    this.strokes.push([{ x, y }]);
  }
  lineTo(x: number, y: number): void {
    this.strokes[this.strokes.length - 1]!.push({ x, y });
  }
  addPath(path: Recorder, m: Matrix): void {
    for (const s of path.strokes) this.strokes.push(s.map((p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f })));
  }
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const key = (p: { x: number; y: number }) => `${(Math.round(p.x * 64) / 64).toFixed(6)},${(Math.round(p.y * 64) / 64).toFixed(6)}`;

/** Each side of the strokes, its ends snapped to 1/64 of a cell so a side drawn from either hex is one key. */
function sidesOf(strokes: readonly { x: number; y: number }[][]): string[] {
  const out: string[] = [];
  for (const s of strokes) {
    for (let i = 1; i < s.length; i++) {
      const a = key(s[i - 1]!);
      const b = key(s[i]!);
      out.push(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
  }
  return out;
}

function hexSides(g: HexGrid, h: { col: number; row: number }): string[] {
  const pts = hexCorners(g, h).map((c) => cornerAt(g, c));
  return pts.map((p, i) => {
    const a = key(p);
    const b = key(pts[(i + 1) % 6]!);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  });
}

const strokeKey = (s: readonly { x: number; y: number }[]) => s.map((p) => `${p.x},${p.y}`).join(" ");
const whole = (b: { w: number; h: number }) => [{ x: -1, y: -1 }, { x: b.w + 1, y: -1 }, { x: b.w + 1, y: b.h + 1 }, { x: -1, y: b.h + 1 }];

describe("grid lines kept in tiles (FU52PERF-LEFT)", () => {
  test("over a whole scene the tiles draw the very strokes the walk over its hexes draws, so joins and sides match, rows and columns alike", () => {
    const random = rng(53038);
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      for (let round = 0; round < 12; round++) {
        const bounds = { w: 2 + Math.floor(random() * 40), h: 2 + Math.floor(random() * 40) };
        const tiles = hexLineTiles(g, bounds, () => new Recorder());
        const out = new Recorder();
        tiles.inView({ corners: whole(bounds), pxPerCell: 40 }, out, IDENTITY);
        const walked = new Recorder();
        strokeHexLines(g, hexRowSpans(g, bounds, whole(bounds)), walked);
        assert.deepEqual(out.strokes.map(strokeKey).sort(), walked.strokes.map(strokeKey).sort(), `${orient} ${bounds.w} by ${bounds.h}`);
        const sides = sidesOf(out.strokes);
        assert.equal(new Set(sides).size, sides.length, `${orient} ${bounds.w} by ${bounds.h}: a side drawn twice`);
        assert.deepEqual(new Set(sides), new Set(sceneHexes(g, bounds).flatMap((h) => hexSides(g, h))));
      }
    }
  });

  test("in any view the tiles draw every side of every hex in view, each once, placed by the camera's matrix", () => {
    const random = rng(53039);
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      for (let round = 0; round < 40; round++) {
        const bounds = { w: 3 + Math.floor(random() * 60), h: 3 + Math.floor(random() * 60) };
        const x0 = random() * bounds.w - 4;
        const y0 = random() * bounds.h - 4;
        const turn = random() * Math.PI * 2;
        const [u, v] = [1 + random() * 20, 1 + random() * 20];
        const corners = [
          [0, 0],
          [u, 0],
          [u, v],
          [0, v],
        ].map(([a, b]) => ({ x: x0 + a! * Math.cos(turn) - b! * Math.sin(turn), y: y0 + a! * Math.sin(turn) + b! * Math.cos(turn) }));
        const m: Matrix = { a: 30, b: 4, c: -7, d: 15, e: 211, f: -96 };
        const out = new Recorder();
        hexLineTiles(g, bounds, () => new Recorder()).inView({ corners, pxPerCell: 12 }, out, m);
        // Back from the screen to the ground, to compare with the rules' corners.
        const det = m.a * m.d - m.b * m.c;
        const back = out.strokes.map((s) => s.map((p) => ({ x: (m.d * (p.x - m.e) - m.c * (p.y - m.f)) / det, y: (m.a * (p.y - m.f) - m.b * (p.x - m.e)) / det })));
        const sides = sidesOf(back);
        assert.equal(new Set(sides).size, sides.length, `${orient} round ${round}: a side drawn twice`);
        const drawn = new Set(sides);
        for (const h of hexesInView(g, bounds, corners)) {
          for (const side of hexSides(g, h)) assert.ok(drawn.has(side), `${orient} round ${round}: hex ${h.col},${h.row} misses ${side}`);
        }
      }
    }
  });

  test("a move builds only the tiles it brings into view, and the same view again builds none", () => {
    const g: HexGrid = { shape: "hex", orient: "rows" };
    const bounds = { w: 120, h: 120 };
    let made = 0;
    const tiles = hexLineTiles(g, bounds, () => (made++, new Recorder()));
    const view = (x: number, y: number) => [{ x, y }, { x: x + 12, y }, { x: x + 12, y: y + 20 }, { x, y: y + 20 }];
    const first = tiles.inView({ corners: view(30, 30), pxPerCell: 40 }, new Recorder(), IDENTITY);
    assert.equal(made, first);
    assert.equal(tiles.built(), first);
    tiles.inView({ corners: view(30, 30), pxPerCell: 40 }, new Recorder(), { ...IDENTITY, e: 5 });
    assert.equal(made, first, "the same view builds nothing");
    // A step of a fifth of a tile reaches at most one more column and row of tiles.
    tiles.inView({ corners: view(30 + GRID_TILE / 5, 30 + GRID_TILE / 5), pxPerCell: 40 }, new Recorder(), IDENTITY);
    assert.ok(made - first <= 6, `${made - first} tiles built for a short step`);
    tiles.inView({ corners: view(30, 30), pxPerCell: 40 }, new Recorder(), IDENTITY);
    assert.equal(tiles.built(), made, "going back builds nothing");
  });

  test("lines skip while a hex is under 6 px, and build nothing", () => {
    const g: HexGrid = { shape: "hex", orient: "columns" };
    const bounds = { w: 200, h: 200 };
    const tiles = hexLineTiles(g, bounds, () => new Recorder());
    const out = new Recorder();
    assert.equal(tiles.inView({ corners: whole(bounds), pxPerCell: 5.99 }, out, IDENTITY), 0);
    assert.equal(out.strokes.length, 0);
    assert.equal(tiles.built(), 0);
  });

  test("a squares scene's lines are its columns' and rows' lines, edge to edge", () => {
    const out = squareLines({ w: 3, h: 2 }, new Recorder());
    assert.deepEqual(out.strokes.map(strokeKey), ["0,0 0,2", "1,0 1,2", "2,0 2,2", "3,0 3,2", "0,0 3,0", "0,1 3,1", "0,2 3,2"]);
  });
});
