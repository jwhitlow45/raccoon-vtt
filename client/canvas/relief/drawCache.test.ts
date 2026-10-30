import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HexGrid } from "#shared/rules/hex.ts";
import { theme } from "../../lib/theme.ts";
import type { Turn } from "../../lib/view.ts";
import { blended, drawRun, type DrawContext, type GroundCopy } from "./drawRelief.ts";
import { cellPieces, type CellPiece, type PieceSource } from "./pieces.ts";

/*
 * What the relief keeps between draws (docs/design-v1-iso-hex-relief.md 9),
 * and what makes each keeping go: a piece's drawing turn by turn (made anew
 * for a new piece, which the index builds whenever grid, bounds, heights,
 * fog or looks change, and read at every zoom in view units), the ground's
 * pattern (made again for each ground draw, which a map, fog or camera
 * change brings, and for a new canvas), and a side's mixed light (by its
 * tone and by the light).
 */

type Op = { name: string; style?: unknown; pts?: { x: number; y: number }[] };

/** A canvas that writes down its fills and strokes, with each path's points in device pixels, and counts the patterns it makes. */
function canvas(): { g: CanvasRenderingContext2D; ops: Op[]; patterns: unknown[] } {
  const ops: Op[] = [];
  const patterns: unknown[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let path: { x: number; y: number }[] = [];
  let fill: unknown = "";
  const tx = (x: number, y: number) => ({ x: m[0]! * x + m[2]! * y + m[4]!, y: m[1]! * x + m[3]! * y + m[5]! });
  const g = {
    get fillStyle() {
      return fill;
    },
    set fillStyle(v: unknown) {
      fill = v;
    },
    strokeStyle: "",
    lineWidth: 1,
    save: () => stack.push([...m]),
    restore: () => {
      m = stack.pop()!;
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      m = [a, b, c, d, e, f];
    },
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => path.push(tx(x, y)),
    lineTo: (x: number, y: number) => path.push(tx(x, y)),
    closePath: () => {},
    clip: () => ops.push({ name: "clip" }),
    // A pattern is written down as such: each canvas makes its own.
    fill: () => ops.push({ name: "fill", style: typeof fill === "string" ? fill : "pattern", pts: [...path] }),
    stroke: () => ops.push({ name: "stroke", pts: [...path] }),
    fillRect: () => ops.push({ name: "fillRect" }),
    drawImage: () => ops.push({ name: "drawImage" }),
    createPattern: (img: unknown) => {
      const p = { img, setTransform() {} };
      patterns.push(p);
      return p;
    },
  };
  return { g: g as unknown as CanvasRenderingContext2D, ops, patterns };
}

const ROWS: HexGrid = { shape: "hex", orient: "rows" };
const GROUND = { width: 2000, height: 2000 } as HTMLCanvasElement;

function dcOf(turn: Turn, scale = 10, copy?: GroundCopy, ground: HTMLCanvasElement = GROUND): DrawContext {
  return { turn, camera: { x: 500, y: 500, scale }, pixelRatio: 1, ground, textures: {}, view: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, groundCopy: copy };
}

/** The pieces of one chunk, every cell at `z` but (4,4) at `top`, its look `color`. */
function piecesOf(z: number, top: number, color = "#777777"): CellPiece[] {
  const src: PieceSource = {
    ground: (x, y) => (x === 4 && y === 4 ? top : z),
    terrain: () => null,
    look: () => ({ texture: null, color }),
    bounds: { w: 8, h: 8 },
    grid: ROWS,
  };
  return cellPieces(src, 0, 0, undefined);
}

/** The highest device point a draw filled, for a piece's top: the lift shows as how far up it reaches. */
function highest(ops: Op[]): number {
  return Math.min(...ops.filter((o) => o.name === "fill" && o.pts && o.pts.length > 0).flatMap((o) => o.pts!.map((p) => p.y)));
}

describe("a piece's drawing, kept turn by turn", () => {
  test("the same piece drawn at another turn draws that turn's shape, not the one kept from the first", () => {
    const pieces = piecesOf(0, 2).filter((p) => p.x === 4 && p.y === 4);
    const first = canvas();
    drawRun(first.g, pieces, dcOf(0));
    const again = canvas();
    drawRun(again.g, pieces, dcOf(1));
    const fresh = canvas();
    drawRun(fresh.g, piecesOf(0, 2).filter((p) => p.x === 4 && p.y === 4), dcOf(1));
    assert.deepEqual(again.ops, fresh.ops);
    assert.notDeepEqual(again.ops, first.ops);
  });

  test("a piece the index builds anew, as a height, fog, look, grid or bounds change makes it, draws its own height and look", () => {
    const low = piecesOf(0, 1, "#336699").filter((p) => p.x === 4 && p.y === 4);
    const high = piecesOf(0, 3, "#996633").filter((p) => p.x === 4 && p.y === 4);
    const a = canvas();
    drawRun(a.g, low, dcOf(0));
    const b = canvas();
    drawRun(b.g, high, dcOf(0));
    // Two cells K view units apart in lift per cell of height: 2 cells more at 10 px a unit.
    assert.ok(Math.abs(highest(a.ops) - highest(b.ops) - 2 * 0.8660254037844386 * 10) < 1e-6, `${highest(a.ops)} then ${highest(b.ops)}`);
    assert.ok(b.ops.some((o) => o.style === blended("#996633", theme.relief.lit) || o.style === blended("#996633", theme.relief.shaded)));
    assert.ok(!b.ops.some((o) => o.style === blended("#336699", theme.relief.lit) || o.style === blended("#336699", theme.relief.shaded)));
  });

  test("a zoom draws the kept shape at the new scale: the shapes are in view units", () => {
    const pieces = piecesOf(0, 2).filter((p) => p.x === 4 && p.y === 4);
    const near = canvas();
    drawRun(near.g, pieces, dcOf(0, 20));
    const far = canvas();
    drawRun(far.g, pieces, dcOf(0, 10));
    const at = (ops: Op[], scale: number) => ops.filter((o) => o.pts).flatMap((o) => o.pts!.map((p) => ({ x: (p.x - 500) / scale, y: (p.y - 500) / scale })));
    const n = at(near.ops, 20);
    const f = at(far.ops, 10);
    assert.equal(n.length, f.length);
    n.forEach((p, i) => assert.ok(Math.abs(p.x - f[i]!.x) < 1e-9 && Math.abs(p.y - f[i]!.y) < 1e-9));
  });
});

describe("the ground's pattern, one for each ground drawn", () => {
  test("every top of a relief draw fills from one pattern, made again only once the ground draws again or its canvas changes", () => {
    // Two heights, so tops at each fill apart, all from one pattern.
    const pieces = piecesOf(1, 2);
    const copy: GroundCopy = { version: 0, made: -1, canvas: null, pattern: null };
    const first = canvas();
    drawRun(first.g, pieces, dcOf(0, 10, copy));
    assert.equal(first.patterns.length, 1);
    assert.equal(first.ops.filter((o) => o.name === "clip" || o.name === "drawImage").length, 0, "a fill, with no clip or image copy");
    const same = canvas();
    drawRun(same.g, pieces, dcOf(0, 10, copy));
    assert.equal(same.patterns.length, 0, "the ground has not drawn since: the same pattern");
    copy.version++;
    const drawn = canvas();
    drawRun(drawn.g, pieces, dcOf(0, 10, copy));
    assert.equal(drawn.patterns.length, 1, "the ground drew since: a pattern of what it holds now");
    const other = { width: 2000, height: 2000 } as HTMLCanvasElement;
    const moved = canvas();
    drawRun(moved.g, pieces, dcOf(0, 10, copy, other));
    assert.equal(moved.patterns.length, 1, "another canvas: a pattern of it");
    assert.equal((moved.patterns[0] as { img: unknown }).img, other);
  });

  test("with no ground canvas, or one of no size, tops fill with their tone and no pattern is made", () => {
    const pieces = piecesOf(0, 2).filter((p) => p.x === 4 && p.y === 4);
    const none = canvas();
    drawRun(none.g, pieces, { ...dcOf(0), ground: null });
    assert.equal(none.patterns.length, 0);
    const empty = canvas();
    drawRun(empty.g, pieces, { ...dcOf(0), ground: { width: 0, height: 0 } as HTMLCanvasElement });
    assert.equal(empty.patterns.length, 0);
    assert.ok(empty.ops.some((o) => o.name === "fill" && o.style === "#777777"));
  });
});

describe("a top's tone under its copy, only where the copy runs out", () => {
  test("a top whose ground at 0 lies on the canvas fills from the pattern alone, though the top itself reaches past the canvas's edge", () => {
    const pieces = piecesOf(0, 2).filter((p) => p.x === 4 && p.y === 4);
    const at = (y: number) => {
      const c = canvas();
      drawRun(c.g, pieces, { ...dcOf(0, 10), camera: { x: 500, y, scale: 10 } });
      return c.ops;
    };
    const top = Math.min(...at(500).filter((o) => o.style === "pattern").flatMap((o) => o.pts!.map((p) => p.y))) - 500;
    // The top 2 cells up, K view units a cell at 10 px a unit: its ground at 0 lies this far below it.
    const lift = 2 * 0.8660254037844386 * 10;
    const toned = (ops: Op[]) => ops.filter((o) => o.name === "fill" && o.style === "#777777").length;
    assert.equal(toned(at(-top - 5)), 0, "the top 5 px past the canvas's top, its ground on it: the pattern alone");
    assert.ok(at(-top - 5).some((o) => o.style === "pattern"));
    assert.equal(toned(at(-top - lift - 5)), 1, "its ground past the canvas's top too: the tone under the copy");
  });
});

describe("a side's tone and light, mixed", () => {
  test("by its tone and by the light: lit and shaded differ on one tone, and two tones differ under one light", () => {
    const lit = blended("#808080", theme.relief.lit);
    const shaded = blended("#808080", theme.relief.shaded);
    assert.equal(lit, "rgb(143, 143, 143)");
    assert.equal(shaded, "rgb(90, 90, 90)");
    assert.equal(blended("#000000", theme.relief.lit), "rgb(31, 31, 31)");
    assert.equal(blended("rgb(10, 20, 30)", theme.relief.shaded), "rgb(7, 14, 21)");
  });

  test("a tone it cannot read, or one not opaque, is not mixed: the side fills twice as before", () => {
    assert.equal(blended("look", theme.relief.lit), null);
    assert.equal(blended("rgba(10, 20, 30, 0.5)", theme.relief.lit), null);
    assert.equal(blended("#123", theme.relief.shaded), "rgb(12, 24, 36)");
  });
});
