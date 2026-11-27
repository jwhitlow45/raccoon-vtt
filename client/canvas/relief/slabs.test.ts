import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, EdgeFeature, TerrainId } from "#shared/model.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { rng } from "#shared/testutil.ts";
import { depth, isometric, K, toView, type Turn } from "../../lib/view.ts";
import { theme } from "../../lib/theme.ts";
import { groupWalls, ReliefIndex } from "./buckets.ts";
import { drawRun, type DrawContext } from "./drawRelief.ts";
import { FogView } from "./fogView.ts";
import { tintedPatternOf } from "./looks.ts";
import { boundsOf, cellPieces, facesOf, keyOf, slabCorners, slabWork, WALL_RISE, WALL_THICK, wallItems, type CellPiece, type PieceSource, type WallItem } from "./pieces.ts";
import { wallPieces, type WallPiece } from "./runs.ts";

/*
 * Lane D3 of docs/design/design-v1-iso-depth.md: the outline rule (5.1),
 * wall slabs with their ends and joins (5.6), the bounds that hold them (6)
 * and tints baked into textures (7).
 */

const TURNS: readonly Turn[] = [0, 1, 2, 3];
const HEX_ROWS: HexGrid = { shape: "hex", orient: "rows" };
const H = WALL_THICK / 2;
type Pt = { x: number; y: number };

/** A pattern the recorder made: from a baked canvas or from an image, and the last transform set on it. */
type FakePattern = { baked: boolean; m: unknown; setTransform(m: unknown): void };

/** A stand-in for OffscreenCanvas, so a tint can be baked under node: it records what is drawn on it. */
class FakeCanvas {
  width: number;
  height: number;
  readonly drawn: string[] = [];
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext(): unknown {
    const drawn = this.drawn;
    let fill = "";
    return {
      drawImage: () => drawn.push("image"),
      fillRect: () => drawn.push(`rect ${fill}`),
      set fillStyle(v: string) {
        fill = v;
      },
    };
  }
}

/** Runs `f` with a canvas to bake on, as a browser has. */
function withCanvas<T>(f: () => T): T {
  const g = globalThis as { OffscreenCanvas?: unknown; DOMMatrix?: unknown };
  const had = [g.OffscreenCanvas, g.DOMMatrix];
  g.OffscreenCanvas = FakeCanvas;
  g.DOMMatrix = class {
    readonly m: number[];
    constructor(m: number[]) {
      this.m = m;
    }
  };
  try {
    return f();
  } finally {
    [g.OffscreenCanvas, g.DOMMatrix] = had;
  }
}

/** A fill or stroke: its style, the lines of its path, and the pattern with its transform as it was at the fill (a pattern is shared and set again for each face). */
type Paint = { style: string; lines: Pt[][]; pattern?: FakePattern; m?: unknown };

/** A 2D context that records each fill and stroke with the lines of its path, closed lines ending where they began. */
function recorder(): { g: CanvasRenderingContext2D; fills: Paint[]; strokes: Paint[] } {
  const fills: Paint[] = [];
  const strokes: Paint[] = [];
  let lines: Pt[][] = [];
  let cur: Pt[] | null = null;
  let fill = "";
  let pattern: FakePattern | undefined;
  let stroke = "";
  const g = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === "beginPath")
          return () => {
            lines = [];
            cur = null;
          };
        if (name === "moveTo")
          return (x: number, y: number) => {
            cur = [{ x, y }];
            lines.push(cur);
          };
        if (name === "lineTo") return (x: number, y: number) => cur!.push({ x, y });
        if (name === "closePath")
          return () => {
            if (cur) cur.push(cur[0]!);
            cur = null;
          };
        if (name === "fill") return () => fills.push({ style: fill, lines: lines.map((l) => [...l]), ...(pattern ? { pattern, m: pattern.m } : {}) });
        if (name === "stroke") return () => strokes.push({ style: stroke, lines: lines.map((l) => [...l]) });
        if (name === "createPattern")
          return (src: unknown): FakePattern => ({
            baked: src instanceof FakeCanvas,
            m: null,
            setTransform(m: unknown) {
              this.m = m;
            },
          });
        return () => undefined;
      },
      set: (_t, name, v) => {
        if (name === "fillStyle") {
          fill = typeof v === "string" ? v : (v as FakePattern).baked ? "baked" : "pattern";
          pattern = typeof v === "string" ? undefined : (v as FakePattern);
        }
        if (name === "strokeStyle") stroke = v as string;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { g, fills, strokes };
}

function dc(turn: Turn, textures: DrawContext["textures"] = {}): DrawContext {
  return { turn, camera: { x: 0, y: 0, scale: 1 }, pixelRatio: 1, ground: null, textures, view: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 } };
}

/** A decoded texture, as far as the drawing reads one. */
const image = (w = 256) => ({ naturalWidth: w, naturalHeight: w, complete: true }) as HTMLImageElement;

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Every segment of some lines, its ends in order. */
function segments(lines: readonly (readonly Pt[])[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) out.push([l[i - 1]!, l[i]!]);
  return out;
}

/** The upright edges among segments drawn in view units, by their top's place, each once: on squares no other edge of a side is upright on screen. */
function uprights(lines: readonly (readonly Pt[])[]): string[] {
  const set = new Set<string>();
  for (const [a, b] of segments(lines)) if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) > 1e-9) set.add(`${round(a.x)},${round(Math.min(a.y, b.y))}`);
  return [...set].sort();
}

/** Where a ground point's upright edge from height z0 to z1 draws, by its top, as `uprights` names it. */
function uprightAt(turn: Turn, p: Pt, z1: number): string {
  const v = toView(isometric(turn), p, z1);
  return `${round(v.x)},${round(v.y)}`;
}

function source(ground: Record<string, number>, terrain: Record<string, TerrainId> = {}, bounds = { w: 32, h: 32 }): PieceSource {
  return {
    ground: (x, y) => ground[`${x},${y}`] ?? 0,
    terrain: (x, y) => terrain[`${x},${y}`] ?? null,
    look: (_x, _y, t) => (t === "wood" ? { texture: null, color: "#8a6440" } : { texture: null, color: "#777777" }),
    bounds,
  };
}

/** The cell pieces of the first chunk. */
const cellsOf = (src: PieceSource) => cellPieces(src, 0, 0, undefined);

/** A box of cells at one height. */
function box(x0: number, y0: number, x1: number, y1: number, z: number, into: Record<string, number> = {}): Record<string, number> {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) into[`${x},${y}`] = z;
  return into;
}

/** The edge-colored strokes of drawing every cell piece, in the draw's order (none in this scene overlap in depth). */
function edgeLines(pieces: readonly CellPiece[], turn: Turn): Pt[][] {
  const r = recorder();
  const keyed = [...pieces].sort((a, b) => depth(turn, a.center.x, a.center.y) - depth(turn, b.center.x, b.center.y));
  for (const p of keyed) drawRun(r.g, [p], dc(turn));
  return r.strokes.filter((s) => s.style === theme.relief.edge).flatMap((s) => s.lines);
}

describe("the outline rule on squares (5.1)", () => {
  test("a long raised side strokes its upright edges at its two ends and at the corner only, at every turn, where each square stroked its own before", () => {
    const pieces = cellsOf(source(box(3, 5, 9, 6, 2)));
    for (const turn of TURNS) {
      const ups = uprights(edgeLines(pieces, turn));
      // A bar six squares long shows one long side and one end: the long side's two ends, one shared with the end's.
      assert.equal(ups.length, 3, `turn ${turn}: ${ups.join(" ")}`);
    }
  });

  test("a concave corner, a change of foot and a change of look keep their upright line", () => {
    // An L of raised squares: its inner corner at (4, 6).
    const l = cellsOf(source({ ...box(3, 5, 7, 6, 2), ...box(3, 6, 4, 9, 2) }));
    assert.ok(uprights(edgeLines(l, 0)).includes(uprightAt(0, { x: 4, y: 6 }, 2)), "the concave corner");
    // A raised row with lower ground in front of half of it: its south side's foot changes at x = 6.
    const foot = cellsOf(source({ ...box(3, 5, 9, 6, 2), ...box(6, 6, 9, 7, 1) }));
    assert.ok(uprights(edgeLines(foot, 0)).includes(uprightAt(0, { x: 6, y: 6 }, 2)), "where the foot changes");
    // A raised row of stone then wood: its look changes at x = 6.
    const wood: Record<string, TerrainId> = { "6,5": "wood", "7,5": "wood", "8,5": "wood" };
    const look = cellsOf(source(box(3, 5, 9, 6, 2), wood));
    assert.ok(uprights(edgeLines(look, 0)).includes(uprightAt(0, { x: 6, y: 6 }, 2)), "where the look changes");
    const plain = cellsOf(source(box(3, 5, 9, 6, 2)));
    assert.ok(!uprights(edgeLines(plain, 0)).includes(uprightAt(0, { x: 6, y: 6 }, 2)), "and none on a plain row there");
  });

  test("a side whose line meets a stepping stair joins nothing there, its faces being cut by the treads", () => {
    // A raised row at 1 cell to x 5, the stair at (6, 5) stored at 1 and climbing east from 0 to 2 with the detail on.
    const src: PieceSource = { ...source(box(3, 5, 7, 6, 1)), detail: true, runs: { at: (x: number, y: number) => (x === 6 && y === 5 ? { d: "e", lo: 0, hi: 2 } : undefined), chunkSig: () => "6,5,e,0,2;", levels: () => [] } as unknown as PieceSource["runs"] };
    const p = cellsOf(src).find((c) => c.x === 5 && c.y === 5)!;
    // Its north and south sides' east ends meet the stair's sides.
    assert.equal((p.joins?.[0] ?? 0) & 2, 0);
    assert.equal((p.joins?.[2] ?? 0) & 2, 0);
    assert.equal((p.joins?.[0] ?? 0) & 1, 1, "and its west ends join the row");
  });

  test("property: a side's end joins exactly when the square along its line shows the same face at every turn, and the join is mutual", () => {
    const random = rng(26116);
    const heights = [-1, 0, 1, 2];
    for (let r = 0; r < 60; r++) {
      const ground: Record<string, number> = {};
      const terrain: Record<string, TerrainId> = {};
      for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
          ground[`${x},${y}`] = heights[Math.floor(random() * heights.length)]!;
          if (random() < 0.2) terrain[`${x},${y}`] = "wood";
        }
      }
      const pieces = cellsOf(source(ground, terrain, { w: 10, h: 10 }));
      const at = new Map(pieces.map((p) => [`${p.x},${p.y}`, p]));
      for (const p of pieces) {
        for (let i = 0; i < 4; i++) {
          for (const [end, bit, back] of [
            ["a", 1, 2],
            ["b", 2, 1],
          ] as const) {
            const side = p.sides[i]!;
            const e = end === "a" ? side.a : side.b;
            const mx = (side.a.x + side.b.x) / 2;
            const my = (side.a.y + side.b.y) / 2;
            const q = at.get(`${p.x + Math.sign(e.x - mx)},${p.y + Math.sign(e.y - my)}`);
            const joined = ((p.joins?.[i] ?? 0) & bit) !== 0;
            if (!q) {
              assert.equal(joined, false);
              continue;
            }
            assert.equal(((q.joins?.[i] ?? 0) & back) !== 0, joined, `mutual at ${p.id} side ${i}`);
            const same = TURNS.every((turn) => {
              const f = facesOf(p, turn).find((x) => x.side === i);
              const g = facesOf(q, turn).find((x) => x.side === i);
              return (!f && !g) || (f !== undefined && g !== undefined && f.z0 === g.z0 && f.z1 === g.z1);
            });
            if (joined) assert.ok(same && p.look.color === q.look.color, `${p.id} side ${i} joins a different face`);
          }
        }
      }
    }
  });

  test("a top's rim takes the edge's line and every square inside it a faint one, grid on or off; a hex top keeps its whole outline", () => {
    const pieces = cellsOf(source(box(3, 5, 5, 6, 2)));
    const r = recorder();
    drawRun(r.g, pieces, dc(0));
    const faint = r.strokes.filter((s) => s.style === theme.relief.squareLine);
    assert.equal(faint.length, 1, "one faint stroke for the batch");
    assert.equal(segments(faint[0]!.lines).length, 8, "both squares' four sides");
    const rim = r.strokes.at(-1)!;
    assert.equal(rim.style, theme.relief.edge);
    assert.equal(segments(rim.lines).length, 6, "the two squares' outside, not the side between them");
    const hex = cellPieces({ ...source({ "3,3": 2 }), grid: HEX_ROWS }, 0, 0, undefined);
    const rh = recorder();
    drawRun(rh.g, hex, dc(0));
    assert.equal(rh.strokes.filter((s) => s.style === theme.relief.squareLine).length, 0);
    assert.equal(rh.strokes.at(-1)!.style, theme.relief.edge);
    assert.equal(hex[0]!.joins, undefined, "a hex joins nothing until lane D4");
  });
});

const SCENE = { id: "s1", autoWalls: "off" as const, bounds: { w: 16, h: 16 } };
const ALL = new FogView(null, "s1", SCENE.bounds);
const WALL: EdgeFeature = { kind: "wall" };
const DOOR: EdgeFeature = { kind: "door", state: "closed", secret: false, discovered: false };

function wallsOf(edges: Record<string, EdgeFeature>, ground: (x: number, y: number) => number = () => 0, detail = true): WallItem[] {
  const chunks: Record<string, BuildChunk> = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges } };
  return wallItems({ ground, detail }, wallPieces(sceneWalls(SCENE, chunks), ALL));
}

/** The wall item along a grid edge `x,y,side`. */
const on = (items: readonly WallItem[], key: string) => items.find((w) => w.piece.id.startsWith(`e${key.replace(/,([nw])$/, "$1")}@`))!;

/** A slab's box on the ground, as [x0, y0, x1, y1]. */
function slabBox(w: WallItem): [number, number, number, number] {
  const c = slabCorners(w.slab!.a, w.slab!.b, H, 0);
  return [Math.min(...c.map((p) => p.x)), Math.min(...c.map((p) => p.y)), Math.max(...c.map((p) => p.x)), Math.max(...c.map((p) => p.y))].map(round) as [number, number, number, number];
}

type Box = [number, number, number, number];

/** The area two ground boxes share. */
function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

/** The edge two ground boxes share where they touch side to side, of some length, or null. */
function touching(a: Box, b: Box): [Pt, Pt] | null {
  const eq = (p: number, q: number) => Math.abs(p - q) < 1e-9;
  const lo = (i: 0 | 1) => Math.max(a[i], b[i]);
  const hi = (i: 0 | 1) => Math.min(a[i + 2]!, b[i + 2]!);
  for (const x of [a[2], a[0]]) if ((eq(x, b[0]) || eq(x, b[2])) && hi(1) - lo(1) > 1e-9) return [{ x, y: lo(1) }, { x, y: hi(1) }];
  for (const y of [a[3], a[1]]) if ((eq(y, b[1]) || eq(y, b[3])) && hi(0) - lo(0) > 1e-9) return [{ x: lo(0), y }, { x: hi(0), y }];
  return null;
}

/** Whether a point on the ground lies on a box's edge or inside it. */
function touchesAt(b: Box, p: Pt): boolean {
  return p.x >= b[0] - 1e-9 && p.x <= b[2] + 1e-9 && p.y >= b[1] - 1e-9 && p.y <= b[3] + 1e-9;
}

/** A slab's length along its line. */
const slabLength = (w: WallItem) => Math.hypot(w.slab!.b.x - w.slab!.a.x, w.slab!.b.y - w.slab!.a.y);

/** The standing items of free walls, each `[a, b]`, on one chunk of a scene seen whole. */
function freeWalls(walls: [[number, number], [number, number]][]): WallItem[] {
  const chunks: Record<string, BuildChunk> = {
    "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: walls.map(([a, b], i) => ({ id: `w${String(i).padStart(11, "x")}`, a, b, f: { kind: "wall" as const } })) },
  };
  return wallItems({ ground: () => 0, detail: true }, wallPieces(sceneWalls(SCENE, chunks), ALL));
}

/** How much of the ground segment from p to q at height z the stroked lines run along on screen, in cells of that segment. */
function strokedAlong(lines: readonly (readonly Pt[])[], turn: Turn, p: Pt, q: Pt, z: number): number {
  const view = isometric(turn);
  const P = toView(view, p, z);
  const Q = toView(view, q, z);
  const len = Math.hypot(Q.x - P.x, Q.y - P.y);
  const ux = (Q.x - P.x) / len;
  const uy = (Q.y - P.y) / len;
  let total = 0;
  for (const [s, t] of segments(lines)) {
    const off = (v: Pt) => (v.x - P.x) * uy - (v.y - P.y) * ux;
    if (Math.abs(off(s)) > 1e-9 || Math.abs(off(t)) > 1e-9) continue;
    const at = (v: Pt) => (v.x - P.x) * ux + (v.y - P.y) * uy;
    total += Math.max(0, Math.min(len, Math.max(at(s), at(t))) - Math.max(0, Math.min(at(s), at(t))));
  }
  // In ground cells, so a caller compares it with a length on the ground.
  return round((total / len) * Math.hypot(q.x - p.x, q.y - p.y));
}

const close = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

describe("wall slabs (5.6)", () => {
  test("a long straight wall's slabs meet with no end face and no line, and its free ends carry on half a thickness", () => {
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 1; x < 7; x++) edges[`${x},4,n`] = WALL;
    const items = wallsOf(edges);
    const first = on(items, "1,4,n").slab!;
    const middle = on(items, "3,4,n").slab!;
    const last = on(items, "6,4,n").slab!;
    assert.ok(close(first.a, { x: 1 - H, y: 4 }) && close(first.b, { x: 2, y: 4 }));
    assert.ok(close(last.b, { x: 7 + H, y: 4 }));
    assert.deepEqual([middle.face, middle.line], [
      [false, false],
      [false, false],
    ]);
    assert.deepEqual([first.face, first.line], [
      [true, false],
      [true, false],
    ]);
    for (const turn of TURNS) {
      const r = recorder();
      for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(r.g, [w], dc(turn));
      // The wall's own two ends, each a near and a far corner, and only those: no line at the four joints.
      const ups = uprights(r.strokes.flatMap((s) => s.lines));
      const atEnds = ups.filter((u) => [1 - H, 7 + H].some((x) => [4 - H, 4 + H].some((y) => uprightAt(turn, { x, y }, 0.5) === u)));
      assert.equal(ups.length, atEnds.length, `turn ${turn}: ${ups.join(" ")}`);
      assert.ok(ups.length >= 2, `turn ${turn}: the ends' corners`);
    }
  });

  test("at an L corner one slab covers the corner and the other stops at its side: no notch and no overlap, and the nearer draws last at every turn", () => {
    // The four corners of a room's cell, each an L.
    const ls: [string, string, Pt][] = [
      ["5,5,n", "5,5,w", { x: 5, y: 5 }],
      ["5,5,n", "6,5,w", { x: 6, y: 5 }],
      ["5,6,n", "6,5,w", { x: 6, y: 6 }],
      ["5,6,n", "5,5,w", { x: 5, y: 6 }],
    ];
    for (const [k1, k2, corner] of ls) {
      const items = wallsOf({ [k1]: WALL, [k2]: WALL });
      const [p, q] = [on(items, k1), on(items, k2)];
      const boxes = [slabBox(p), slabBox(q)];
      // The corner square lies inside one slab's box.
      const square = [corner.x - H, corner.y - H, corner.x + H, corner.y + H].map(round);
      assert.ok(
        boxes.some((b) => b[0] <= square[0]! && b[1] <= square[1]! && b[2] >= square[2]! && b[3] >= square[3]!),
        `${k1} ${k2}: the corner covered`,
      );
      const [a, b] = [boxes[0]!, boxes[1]!];
      const overlap = Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!) > 1e-9 && Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!) > 1e-9;
      assert.ok(!overlap, `${k1} ${k2}: the slabs do not overlap`);
      const stops = [p, q].find((w) => w.slab!.lean.x !== 0 || w.slab!.lean.y !== 0)!;
      const covers = stops === p ? q : p;
      for (const turn of TURNS) {
        const nearer = depth(turn, stops.slab!.lean.x, stops.slab!.lean.y) > 0;
        assert.equal(keyOf(stops, turn) > keyOf(covers, turn), nearer, `${k1} ${k2} turn ${turn}`);
      }
    }
  });

  test("a wall ending on another's middle stops at its side, a wall beside a door stops at its post, and one beside a wall of another height shows its end", () => {
    const t = wallsOf({ "1,4,n": WALL, "2,4,n": WALL, "2,4,w": WALL });
    const stem = on(t, "2,4,w");
    assert.ok(close(stem.slab!.a, { x: 2, y: 4 + H }), "the stem stops at the through wall's side");
    for (const through of [on(t, "1,4,n"), on(t, "2,4,n")]) {
      for (const turn of TURNS) {
        // The stem lies in front of the wall it meets exactly when it runs toward the viewer from it.
        assert.equal(keyOf(stem, turn) > keyOf(through, turn), depth(turn, 0, 1) > 0, `turn ${turn} against ${through.id}`);
      }
    }
    const door = wallsOf({ "1,4,n": WALL, "2,4,n": DOOR });
    const beside = on(door, "1,4,n").slab!;
    assert.ok(close(beside.b, { x: 2, y: 4 }));
    assert.deepEqual([beside.face[1], beside.line[1]], [false, true]);
    // The second wall stands on 1 cell of ground north of it.
    const step = wallsOf({ "1,4,n": WALL, "2,4,n": WALL }, (x, y) => (x === 2 && y === 3 ? 1 : 0));
    const low = on(step, "1,4,n").slab!;
    assert.ok(close(low.b, { x: 2, y: 4 }));
    assert.deepEqual([low.face[1], low.line[1]], [true, true]);
  });

  test("below the detail and on hexes a wall stays a plane, and a slab reads only standing pieces: a hidden neighbor leaves a free end", () => {
    assert.equal(on(wallsOf({ "1,4,n": WALL }, () => 0, false), "1,4,n").slab, undefined);
    const hexScene = { ...SCENE, gridShape: "hexRows" as const, bounds: { w: 20, h: 20 } };
    const chunks: Record<string, BuildChunk> = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls: [{ id: "w1xxxxxxxxxx", a: [2, 2], b: [6, 2], f: { kind: "wall" } }] } };
    const hex = wallItems({ ground: () => 0, detail: true }, wallPieces(sceneWalls(hexScene, chunks), new FogView(null, "s1", hexScene.bounds), HEX_ROWS));
    assert.ok(hex.length > 0 && hex.every((w) => w.slab === undefined));
    // Only the first piece's bucket, the second piece unseen: the first one's end is free.
    const both = wallPieces(sceneWalls(SCENE, { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "1,4,n": WALL, "2,4,n": WALL } } }), ALL);
    const alone = wallItems({ ground: () => 0, detail: true }, [both[0]!], [both[0]!]);
    assert.ok(close(alone[0]!.slab!.b, { x: 2 + H, y: 4 }));
    const joined = wallItems({ ground: () => 0, detail: true }, [both[0]!], both);
    assert.ok(close(joined[0]!.slab!.b, { x: 2, y: 4 }));
  });

  test("a slab draws every face toward the viewer in stone with the tint and its light baked in, its narrow end too, its cap in lighter baked stone, one fill each, and one stroke", () => {
    withCanvas(() => {
      const stone = image();
      const items = wallsOf({ "1,4,n": WALL });
      for (const turn of TURNS) {
        const r = recorder();
        drawRun(r.g, items, dc(turn, { stone }));
        // One long side and one end face the viewer, each in stone with its light, then the cap.
        assert.deepEqual(
          r.fills.map((f) => (f.style === "baked" || f.style === "pattern" ? f.style : f.style === theme.relief.lit || f.style === theme.relief.shaded ? "light" : "flat")).sort(),
          ["baked", "baked", "baked"],
          `turn ${turn}`,
        );
        // The cap lies on the ground plane: its texture's rows run along the ground, not straight down the screen as a side's do.
        const cap = r.fills.at(-1)!;
        assert.notEqual((cap.m as { m: number[] }).m[2], 0, `turn ${turn}: the cap's texture lies flat`);
        assert.equal(r.strokes.length, 1);
      }
      // Two collinear slabs show their texture as one: at the joint both patterns place the same texel.
      const two = wallsOf({ "1,4,n": WALL, "2,4,n": WALL });
      const origins = two.map((w) => {
        const r = recorder();
        drawRun(r.g, [w], dc(0, { stone }));
        const m = (r.fills.find((f) => f.style === "baked")!.m as { m: number[] }).m;
        // Where the texture's column 0 lies along the line, in view units from the joint at x = 2.
        const joint = toView(isometric(0), { x: 2, y: 4 + H }, 0.5);
        return round(((joint.x - m[4]!) / m[0]!) % 256);
      });
      assert.equal(origins[0], origins[1]);
    });
  });

  test("an L, a T and a crossing of slabs of one height meet with no gap and no overlap, and no line where their caps and sides touch (ISOWALL)", () => {
    const cases: [string, Record<string, EdgeFeature>, Pt][] = [
      ["L", { "5,5,n": WALL, "5,5,w": WALL }, { x: 5, y: 5 }],
      ["L", { "5,6,n": WALL, "6,5,w": WALL }, { x: 6, y: 6 }],
      ["T", { "3,4,n": WALL, "4,4,n": WALL, "4,4,w": WALL }, { x: 4, y: 4 }],
      ["T", { "3,4,n": WALL, "4,4,n": WALL, "4,3,w": WALL }, { x: 4, y: 4 }],
      ["crossing", { "3,4,n": WALL, "4,4,n": WALL, "4,3,w": WALL, "4,4,w": WALL }, { x: 4, y: 4 }],
    ];
    for (const [name, edges, at] of cases) {
      const items = wallsOf(edges);
      const boxes = items.map(slabBox);
      // No two slabs stand inside each other, and together they cover the square where the walls meet.
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!(overlapArea(boxes[i]!, boxes[j]!) > 1e-9), `${name}: ${items[i]!.id} and ${items[j]!.id} overlap`);
      const square: Box = [at.x - H, at.y - H, at.x + H, at.y + H].map(round) as Box;
      assert.ok(Math.abs(boxes.reduce((sum, b) => sum + overlapArea(b, square), 0) - (2 * H) ** 2) < 1e-9, `${name}: the meeting square covered once`);
      if (name === "crossing") {
        // One wall runs through: its two pieces end at the crossing, and the other's stop half a thickness short.
        const ends = items.map((w) => Math.min(Math.hypot(w.slab!.a.x - at.x, w.slab!.a.y - at.y), Math.hypot(w.slab!.b.x - at.x, w.slab!.b.y - at.y)));
        assert.deepEqual(ends.map(round).sort(), [0, 0, round(H), round(H)], name);
      }
      for (const turn of TURNS) {
        const r = recorder();
        for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(r.g, [w], dc(turn));
        const lines = r.strokes.flatMap((st) => st.lines);
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const shared = touching(boxes[i]!, boxes[j]!);
            if (!shared) continue;
            assert.equal(strokedAlong(lines, turn, shared[0], shared[1], 0.5), 0, `${name} turn ${turn}: a line across the caps where ${items[i]!.id} meets ${items[j]!.id}`);
          }
        }
      }
    }
  });

  test("at an L the corner's end face lies in one plane with the other slab's outer side: no upright line between them, and one texture laid across both from one origin (ISOWALL)", () => {
    withCanvas(() => {
      const stone = image();
      let seen = 0;
      // A free wall runs from the end it was drawn from, so an L of free walls can wind either way round its corner.
      const free = (a: [number, number], b: [number, number], c: [number, number]) => {
        const chunks: Record<string, BuildChunk> = {
          "s1:0,0": {
            sceneId: "s1",
            cx: 0,
            cy: 0,
            rev: 1,
            cells: {},
            edges: {},
            walls: [
              { id: "w1xxxxxxxxxx", a, b, f: { kind: "wall" } },
              { id: "w2xxxxxxxxxx", a: b, b: c, f: { kind: "wall" } },
            ],
          },
        };
        return wallItems({ ground: () => 0, detail: true }, wallPieces(sceneWalls(SCENE, chunks), ALL));
      };
      for (const [k1, k2, items] of [
        ["5,5,n", "5,5,w", wallsOf({ "5,5,n": WALL, "5,5,w": WALL })],
        ["5,5,n", "6,5,w", wallsOf({ "5,5,n": WALL, "6,5,w": WALL })],
        ["5,6,n", "6,5,w", wallsOf({ "5,6,n": WALL, "6,5,w": WALL })],
        ["5,6,n", "5,5,w", wallsOf({ "5,6,n": WALL, "5,5,w": WALL })],
        ["free", "clockwise", free([3, 5], [5, 5], [5, 7])],
        ["free", "back", free([5, 7], [5, 5], [3, 5])],
        ["free", "up", free([5, 3], [5, 5], [3, 5])],
      ] as const) {
        // The two pieces that meet at the corner, a free wall being cut into a piece a cell.
        const corner = k1 === "free" ? { x: 5, y: 5 } : null;
        const pair = corner ? items.filter((w) => close({ x: w.piece.ax, y: w.piece.ay }, corner) || close({ x: w.piece.bx, y: w.piece.by }, corner)) : items;
        assert.equal(pair.length, 2, `${k1} ${k2}`);
        const boxes = pair.map(slabBox);
        const all: Box = [Math.min(boxes[0]![0], boxes[1]![0]), Math.min(boxes[0]![1], boxes[1]![1]), Math.max(boxes[0]![2], boxes[1]![2]), Math.max(boxes[0]![3], boxes[1]![3])];
        const shared = touching(boxes[0]!, boxes[1]!)!;
        // Of the shared edge's two ends, the one on the corner's outside is where the end face meets the other's side.
        const seam = shared.find((p) => [all[0], all[2]].some((v) => Math.abs(p.x - v) < 1e-9) || [all[1], all[3]].some((v) => Math.abs(p.y - v) < 1e-9))!;
        for (const turn of TURNS) {
          const r = recorder();
          for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(r.g, [w], dc(turn, { stone }));
          assert.ok(!uprights(r.strokes.flatMap((st) => st.lines)).includes(uprightAt(turn, seam, 0.5)), `${k1} ${k2} turn ${turn}: no line up the seam`);
          // Sides whose tops run on along one line on screen lie in one plane: where two meet, their textures match.
          const sides = r.fills.filter((f) => f.style === "baked" && (f.m as { m: number[] }).m[2] === 0);
          for (let i = 0; i < sides.length; i++) {
            for (let j = i + 1; j < sides.length; j++) {
              const [a1, b1] = [sides[i]!.lines[0]![0]!, sides[i]!.lines[0]![1]!];
              const [a2, b2] = [sides[j]!.lines[0]![0]!, sides[j]!.lines[0]![1]!];
              const cross = (p: Pt) => (b1.x - a1.x) * (p.y - a1.y) - (b1.y - a1.y) * (p.x - a1.x);
              if (Math.abs(cross(a2)) > 1e-9 || Math.abs(cross(b2)) > 1e-9 || ![a2, b2].some((p) => close(p, a1) || close(p, b1))) continue;
              seen++;
              const m1 = (sides[i]!.m as { m: number[] }).m.map(round);
              const m2 = (sides[j]!.m as { m: number[] }).m.map(round);
              assert.deepEqual(m1, m2, `${k1} ${k2} turn ${turn}: one texture across the corner`);
            }
          }
        }
      }
      assert.ok(seen >= 7, `the corner's end face and the other's side both showing at some turn of each L: ${seen}`);
    });
  });

  test("a free end and the end of an L's corner draw their end face in the stone, never a flat tone (ISOWALL)", () => {
    withCanvas(() => {
      const stone = image();
      const cases: Record<string, EdgeFeature>[] = [{ "1,4,n": WALL }, { "5,5,n": WALL, "5,5,w": WALL }, { "3,4,n": WALL, "4,4,n": WALL, "4,4,w": WALL }];
      for (const edges of cases) {
        const items = wallsOf(edges);
        for (const turn of TURNS) {
          const r = recorder();
          for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(r.g, [w], dc(turn, { stone }));
          const flat = r.fills.filter((f) => f.style !== "baked" && f.style !== theme.relief.lit && f.style !== theme.relief.shaded);
          assert.deepEqual(flat, [], `${Object.keys(edges).join(" ")} turn ${turn}`);
          // Every end face toward the viewer draws: one baked fill a face facing the viewer, and the caps.
          const ends = items.flatMap((w) => [0, 1].filter((e) => w.slab!.face[e]).map((e) => ({ w, e })));
          const facing = ends.filter(({ w, e }) => {
            const s = w.slab!;
            const out = e === 0 ? { x: s.a.x - s.b.x, y: s.a.y - s.b.y } : { x: s.b.x - s.a.x, y: s.b.y - s.a.y };
            return depth(turn, out.x, out.y) > 1e-12;
          });
          const longs = items.length; // one long side of each slab faces the viewer on squares
          assert.equal(r.fills.filter((f) => f.style === "baked").length, longs + facing.length + items.length, `${Object.keys(edges).join(" ")} turn ${turn}: sides, end faces and caps`);
        }
      }
    });
  });

  test("where slabs meet, the lines that stay are drawn: the outer corner, the inside corner, and every top edge but the stretch another slab stands against (ISOWALL-S-1)", () => {
    // Each: the walls, the corner or junction, the slab that runs on there and the side the other leaves it by, the stem's direction.
    const cases: [string, Record<string, EdgeFeature>, Pt, Pt][] = [
      ["L", { "5,5,n": WALL, "5,5,w": WALL }, { x: 5, y: 5 }, { x: 0, y: 1 }],
      ["L", { "5,6,n": WALL, "6,5,w": WALL }, { x: 6, y: 6 }, { x: 0, y: -1 }],
      ["T", { "3,4,n": WALL, "4,4,n": WALL, "4,4,w": WALL }, { x: 4, y: 4 }, { x: 0, y: 1 }],
      ["T", { "3,4,n": WALL, "4,4,n": WALL, "4,3,w": WALL }, { x: 4, y: 4 }, { x: 0, y: -1 }],
    ];
    for (const [name, edges, at, stem] of cases) {
      const items = wallsOf(edges);
      const boxes = items.map(slabBox);
      // The slabs along the x axis are the ones the stem meets; their union's edge on the stem's side.
      const runs = boxes.filter((b) => b[3] - b[1] < 2 * H + 1e-9);
      const x0 = Math.min(...runs.map((b) => b[0]));
      const x1 = Math.max(...runs.map((b) => b[2]));
      const sideY = round(at.y + H * stem.y);
      const stems = boxes.filter((b) => b[3] - b[1] > 2 * H + 1e-9);
      const st = stems[0]!;
      for (const turn of TURNS) {
        const r = recorder();
        for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(r.g, [w], dc(turn));
        const lines = r.strokes.flatMap((x) => x.lines);
        const ups = uprights(lines);
        // The top along the stem's side: all of it but the stem's width.
        assert.equal(strokedAlong(lines, turn, { x: x0, y: sideY }, { x: x1, y: sideY }, 0.5), round(x1 - x0 - 2 * H), `${name} turn ${turn}: the top on the stem's side`);
        // The stem's two side tops, whole.
        for (const x of [st[0], st[2]]) assert.equal(strokedAlong(lines, turn, { x, y: st[1] }, { x, y: st[3] }, 0.5), round(st[3] - st[1]), `${name} turn ${turn}: the stem's side top at x ${x}`);
        // Each inside corner keeps its upright wherever the stem's side there faces the viewer.
        for (const sx of [-1, 1]) {
          const crease = { x: at.x + sx * H, y: sideY };
          const shows = depth(turn, sx, 0) > 1e-12;
          const isCrease = name === "T" || sx > 0 === (at.x < x1 - 1);
          if (!isCrease) continue;
          assert.equal(ups.includes(uprightAt(turn, crease, 0.5)), shows, `${name} turn ${turn}: the inside corner at x ${crease.x}`);
        }
        // The top on the far side from the stem, whole.
        const farY = round(at.y - H * stem.y);
        assert.equal(strokedAlong(lines, turn, { x: x0, y: farY }, { x: x1, y: farY }, 0.5), round(x1 - x0), `${name} turn ${turn}: the top on the far side`);
        if (name === "L") {
          // The corner's outer upright, wherever one of its two faces faces the viewer.
          const ox = at.x - H * (x1 > at.x + 1 ? 1 : -1);
          const oy = at.y - H * stem.y;
          const shows = depth(turn, ox - at.x, 0) > 1e-12 || depth(turn, 0, oy - at.y) > 1e-12;
          assert.equal(ups.includes(uprightAt(turn, { x: ox, y: oy }, 0.5)), shows, `${name} turn ${turn}: the outer corner`);
        }
      }
    }
  });

  test("a free wall's short piece at a corner leaves no line across the joined tops, its neighbor carrying the covered stretch (ISOWALL-SOL-1)", () => {
    const items = freeWalls([
      [
        [3, 5],
        [5.015625, 5],
      ],
      [
        [5.015625, 5],
        [5.015625, 7],
      ],
    ]);
    const y = 5 + H;
    for (const turn of TURNS) {
      const r = recorder();
      for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(r.g, [w], dc(turn));
      const lines = r.strokes.flatMap((x) => x.lines);
      assert.equal(strokedAlong(lines, turn, { x: 5.015625 - H, y }, { x: 5.015625 + H, y }, 0.5), 0, `turn ${turn}: a line across the joined tops`);
      assert.equal(strokedAlong(lines, turn, { x: 3 - H, y }, { x: 5.015625 - H, y }, 0.5), round(2.015625), `turn ${turn}: the rest of the top on that side`);
    }
    for (const w of items) for (const s of [0, 1] as const) assert.ok(w.slab!.gap[0][s] + w.slab!.gap[1][s] <= slabLength(w) + 1e-9, `${w.id}: its gaps fit in it`);
  });

  test("property: random fractional free-wall Ls, Ts and crossings stroke no shared edge, never a line backward, and every outer top edge once (ISOWALL-SOL-1)", () => {
    const random = rng(26127);
    const lattice = (v: number) => Math.round(v * 64) / 64;
    for (let n = 0; n < 300; n++) {
      const at = { x: lattice(4 + random() * 2), y: lattice(4 + random() * 2) };
      const arm = () => lattice(0.02 + random() * 1.5);
      const kind = n % 3;
      const flip = (w: [[number, number], [number, number]]) => (random() < 0.5 ? w : ([w[1], w[0]] as [[number, number], [number, number]]));
      const horizontal: [[number, number], [number, number]] = [
        [at.x - (kind === 0 ? 0 : arm()), at.y],
        [at.x + arm(), at.y],
      ];
      const vertical: [[number, number], [number, number]] = [
        [at.x, at.y - (kind === 2 ? arm() : 0)],
        [at.x, at.y + arm()],
      ];
      const items = freeWalls([flip(horizontal), flip(vertical)]);
      const label = `${["L", "T", "crossing"][kind]} at ${at.x},${at.y}: ${JSON.stringify([horizontal, vertical])}`;
      const boxes = items.filter((w) => w.slab).map(slabBox);
      for (const w of items) {
        if (!w.slab) continue;
        for (const s of [0, 1] as const) {
          assert.ok(w.slab.gap[0][s] >= 0 && w.slab.gap[1][s] >= 0 && w.slab.gap[0][s] + w.slab.gap[1][s] <= slabLength(w) + 1e-9, `${label}: ${w.id} strokes backward`);
        }
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!(overlapArea(boxes[i]!, boxes[j]!) > 1e-9), `${label}: two slabs overlap`);
      for (const turn of TURNS) {
        const r = recorder();
        for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(r.g, [w], dc(turn));
        const lines = r.strokes.flatMap((x) => x.lines);
        for (const [i, b] of boxes.entries()) {
          const edges: [Pt, Pt][] = [
            [{ x: b[0], y: b[1] }, { x: b[2], y: b[1] }],
            [{ x: b[0], y: b[3] }, { x: b[2], y: b[3] }],
            [{ x: b[0], y: b[1] }, { x: b[0], y: b[3] }],
            [{ x: b[2], y: b[1] }, { x: b[2], y: b[3] }],
          ];
          for (const [e0, e1] of edges) {
            // Where another slab touches this edge, the edge lies inside the stone: no line. Elsewhere it is the outline: one line, whole.
            const along = e0.y === e1.y ? "x" : "y";
            const cuts = new Set<number>([e0[along], e1[along]]);
            for (const [j, o] of boxes.entries()) {
              if (j === i) continue;
              const shared = touching(b, o);
              if (shared && shared[0][along === "x" ? "y" : "x"] === e0[along === "x" ? "y" : "x"] && shared[0][along === "x" ? "y" : "x"] === shared[1][along === "x" ? "y" : "x"]) for (const p of shared) cuts.add(p[along]);
            }
            const stops = [...cuts].filter((v) => v >= e0[along] - 1e-9 && v <= e1[along] + 1e-9).sort((p, q) => p - q);
            for (let k = 0; k + 1 < stops.length; k++) {
              const lo = stops[k]!;
              const hi = stops[k + 1]!;
              if (hi - lo < 1e-6) continue;
              const pa = along === "x" ? { x: lo, y: e0.y } : { x: e0.x, y: lo };
              const pb = along === "x" ? { x: hi, y: e0.y } : { x: e0.x, y: hi };
              const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
              const inside = boxes.some((o, j) => j !== i && touchesAt(o, mid));
              const want = inside ? 0 : round(hi - lo);
              assert.equal(strokedAlong(lines, turn, pa, pb, 0.5), want, `${label} turn ${turn}: the top edge from ${lo} to ${hi} (${along}) of slab ${i}`);
            }
          }
        }
      }
    }
  });

  test("a long run of free walls a sixty-fourth of a cell each reads a few ends a piece, however long the run (ISOWALL-SOL-2)", () => {
    const perPiece: number[] = [];
    for (const n of [1000, 3000]) {
      const chunks: Record<string, BuildChunk> = {};
      for (let i = 0; i < n; i++) {
        const x = 1 + i / 64;
        const cx = Math.floor(x / 16);
        const chunk = (chunks[`s1:${cx},0`] ??= { sceneId: "s1", cx, cy: 0, rev: 1, cells: {}, edges: {}, walls: [] });
        chunk.walls!.push({ id: `c${String(i).padStart(11, "0")}`, a: [x, 4], b: [x + 1 / 64, 4], f: { kind: "wall" } });
      }
      const scene = { ...SCENE, bounds: { w: 64, h: 16 } };
      const pieces = wallPieces(sceneWalls(scene, chunks), new FogView(null, "s1", scene.bounds));
      assert.equal(pieces.length, n);
      slabWork.ends = 0;
      const items = wallItems({ ground: () => 0, detail: true }, pieces);
      perPiece.push(slabWork.ends / n);
      // The run is one wall: no line across it, and its two free ends square.
      assert.ok(items.every((w) => w.slab), `${n}: every piece a slab`);
      assert.ok(items.filter((w) => w.slab!.face[0] || w.slab!.face[1]).length === 2, `${n}: two free ends`);
    }
    // Each piece reads its own two ends and those within a thickness of them, each of those looking half a thickness on: at 1/64 cell a piece, about 90 ends. The work grows with the run's length and no faster.
    assert.ok(perPiece.every((k) => k <= 120), `ends read a piece: ${perPiece.join(", ")}`);
    assert.ok(Math.abs(perPiece[1]! - perPiece[0]!) < 1, `the same ends a piece at 1,000 and 3,000: ${perPiece.join(", ")}`);
  });

  test("a crossing that is not square keeps both walls running through it (D-261127-575)", () => {
    const items = freeWalls([
      [
        [2, 2],
        [6, 4],
      ],
      [
        [2, 4],
        [6, 2],
      ],
    ]);
    const at = { x: 4, y: 3 };
    const near = items.filter((w) => [w.piece.ax, w.piece.bx].some((x, i) => close({ x, y: i === 0 ? w.piece.ay : w.piece.by }, at)));
    assert.equal(near.length, 4);
    for (const w of near) {
      const d = Math.min(Math.hypot(w.slab!.a.x - at.x, w.slab!.a.y - at.y), Math.hypot(w.slab!.b.x - at.x, w.slab!.b.y - at.y));
      assert.ok(d < 1e-9, `${w.id}: runs to the crossing (${d})`);
    }
  });

  test("a diagonal wall facing the viewer square takes one light along its whole length, however its pieces split (ISOWALL)", () => {
    // Two free walls crossing, each cut into pieces at the crossing and at sub-cell lines.
    const chunks: Record<string, BuildChunk> = {
      "s1:0,0": {
        sceneId: "s1",
        cx: 0,
        cy: 0,
        rev: 1,
        cells: {},
        edges: {},
        walls: [
          { id: "w1xxxxxxxxxx", a: [2, 6], b: [6, 2], f: { kind: "wall" } },
          { id: "w2xxxxxxxxxx", a: [2, 2], b: [6, 6], f: { kind: "wall" } },
        ],
      },
    };
    const items = wallItems({ ground: () => 0, detail: true }, wallPieces(sceneWalls(SCENE, chunks), ALL));
    let square = 0;
    for (const turn of TURNS) {
      for (const id of ["w1", "w2"]) {
        const lights = new Set<string>();
        for (const w of items.filter((i) => i.piece.id.includes(id) && i.slab)) {
          const r = recorder();
          drawRun(r.g, [w], dc(turn));
          // The long side square to the viewer: a face (its second edge upright, the wall's height) whose top runs level across the screen. Untextured, its tone holds its light.
          for (const f of r.fills) {
            const [a, b, c] = f.lines[0] ?? [];
            if (a && b && c && Math.abs(b.x - c.x) < 1e-9 && Math.abs(c.y - b.y - K * WALL_RISE) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.x - b.x) > 0.2) lights.add(f.style);
          }
        }
        assert.ok(lights.size <= 1, `${id} turn ${turn}: ${[...lights].join(" | ")}`);
        square += lights.size;
      }
    }
    assert.ok(square >= 4, "each wall square to the viewer at two turns");
  });

  test("property: every vertex a slab draws lies inside its bounds, which do not change with the detail, at every turn", () => {
    const random = rng(26117);
    for (let r = 0; r < 30; r++) {
      const edges: Record<string, EdgeFeature> = {};
      for (let i = 0; i < 14; i++) edges[`${1 + Math.floor(random() * 12)},${1 + Math.floor(random() * 12)},${random() < 0.5 ? "n" : "w"}`] = random() < 0.15 ? DOOR : WALL;
      const ground = (x: number, y: number) => ((x * 7 + y * 3 + r) % 5 === 0 ? 1 : 0);
      const on = wallsOf(edges, ground, true);
      const off = wallsOf(edges, ground, false);
      for (const turn of TURNS) {
        for (const w of on) {
          const b = boundsOf(w, turn);
          const flat = off.find((o) => o.id === w.id);
          if (flat) assert.deepEqual(boundsOf(flat, turn), b, `${w.id}: bounds the same at both details`);
          if (!w.slab) continue;
          const rec = recorder();
          drawRun(rec.g, [w], dc(turn));
          for (const paint of [...rec.fills, ...rec.strokes]) {
            for (const l of paint.lines) for (const v of l) assert.ok(v.x >= b.x0 - 1e-9 && v.x <= b.x1 + 1e-9 && v.y >= b.y0 - 1e-9 && v.y <= b.y1 + 1e-9, `${w.id} turn ${turn}`);
          }
        }
      }
    }
  });
});

describe("tints baked into textures (7)", () => {
  test("a texture and a tint bake once into a pattern of their own, not before the image decodes, and the fill takes it in one call", () => {
    withCanvas(() => {
      const r = recorder();
      const img = image(128);
      const p = tintedPatternOf(r.g, img, "rgba(1, 2, 3, 0.5)") as unknown as FakePattern;
      assert.ok(p.baked);
      assert.equal(tintedPatternOf(r.g, img, "rgba(1, 2, 3, 0.5)"), p as unknown as CanvasPattern, "kept for the image and tint");
      assert.notEqual(tintedPatternOf(r.g, img, "rgba(4, 5, 6, 0.5)"), p as unknown as CanvasPattern, "another tint, another pattern");
      assert.equal(tintedPatternOf(r.g, { naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement, "x"), null, "nothing to bake yet");
    });
    const g = globalThis as { OffscreenCanvas?: unknown };
    const had = g.OffscreenCanvas;
    g.OffscreenCanvas = undefined;
    try {
      assert.equal(tintedPatternOf(recorder().g, image(64), "rgba(1, 2, 3, 0.5)"), null, "no canvas, no bake: the caller lays the tint over");
    } finally {
      g.OffscreenCanvas = had;
    }
  });

  test("a face's light bakes in with its tint, a pattern for each light, made once (ISOWALL)", () => {
    withCanvas(() => {
      const stone = image();
      const r = recorder();
      const lit = tintedPatternOf(r.g, stone, theme.relief.wallTint, theme.relief.lit);
      const shaded = tintedPatternOf(r.g, stone, theme.relief.wallTint, theme.relief.shaded);
      const plain = tintedPatternOf(r.g, stone, theme.relief.wallTint);
      assert.ok(lit && shaded && plain && lit !== shaded && lit !== plain && shaded !== plain);
      assert.equal(tintedPatternOf(r.g, stone, theme.relief.wallTint, theme.relief.lit), lit);
      // A slab lit on one face and shaded on another fills each from its own pattern.
      const items = wallsOf({ "1,4,n": WALL, "1,4,w": WALL });
      for (const turn of TURNS) {
        const rec = recorder();
        for (const w of [...items].sort((p, q) => keyOf(p, turn) - keyOf(q, turn))) drawRun(rec.g, [w], dc(turn, { stone }));
        const sides = rec.fills.filter((f) => f.style === "baked" && (f.m as { m: number[] }).m[2] === 0);
        assert.ok(sides.length >= 2, `turn ${turn}`);
        assert.ok(sides.every((f) => f.pattern === lit || f.pattern === shaded), `turn ${turn}: each side from a lit or a shaded pattern`);
        assert.ok(sides.some((f) => f.pattern === lit) && sides.some((f) => f.pattern === shaded), `turn ${turn}: both lights show`);
      }
    });
  });

  test("a closed door's leaf wears its stain baked into the wood, and its cap the stained tone", () => {
    withCanvas(() => {
      const wood = image();
      const items = wallsOf({ "1,4,n": DOOR });
      for (const turn of TURNS) {
        const r = recorder();
        drawRun(r.g, items, dc(turn, { wood }));
        assert.ok(r.fills.some((f) => f.style === "baked"), `turn ${turn}: the stained leaf`);
        assert.ok(!r.fills.some((f) => f.style === "pattern" || f.style === theme.relief.doorStain), `turn ${turn}: no raw wood, no stain laid over`);
        assert.ok(r.fills.length <= 12, `turn ${turn}: ${r.fills.length} fills`);
      }
      // Below the detail a door is one stained plane, its light baked in with the stain.
      const plane = recorder();
      drawRun(plane.g, wallsOf({ "1,4,n": DOOR }, () => 0, false), dc(0, { wood }));
      assert.equal(plane.fills.length, 1);
      assert.equal(plane.fills[0]!.style, "baked");
    });
  });
});

describe("what a bucket reads for joins (buckets.ts)", () => {
  test("an edit in a diagonal chunk rebuilds the bucket whose side ends read it, as a fresh index finds them", () => {
    const bounds = { w: 48, h: 48 };
    // The bucket at 1,1 holds a raised row along y = 16 to x 31, and the east end of (31, 16)'s north side reads (32, 16) and (32, 15): chunk 2,0 is its diagonal.
    const ground: Record<string, number> = box(26, 16, 33, 17, 2);
    const chunk = (cx: number, cy: number): BuildChunk => ({ sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
    const chunks: Record<string, BuildChunk> = {};
    for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) chunks[`s1:${cx},${cy}`] = chunk(cx, cy);
    const global = {};
    const input = (c: Record<string, BuildChunk>) => ({ sceneId: "s1", bounds, chunks: c, tiles: null, walls: new Map(), global, src: source(ground, {}, bounds) });
    const relief = new ReliefIndex();
    relief.sync(input(chunks));
    assert.equal((relief.cellAt(31, 16)!.joins?.[0] ?? 0) & 2, 2, "joined at first");
    // The store replaces the chunk it edits.
    ground["32,15"] = 1;
    const edited = { ...chunks, "s1:2,0": chunk(2, 0) };
    relief.sync(input(edited));
    const fresh = new ReliefIndex();
    fresh.sync(input(edited));
    assert.equal((fresh.cellAt(31, 16)!.joins?.[0] ?? 0) & 2, 0, "the foot beyond now differs");
    assert.deepEqual(relief.cellAt(31, 16)!.joins, fresh.cellAt(31, 16)!.joins);
  });

  test("a wall beside a bucket's edge joins its neighbor bucket's wall, and parts from it when that wall goes", () => {
    const bounds = { w: 48, h: 48 };
    const all = new FogView(null, "s1", bounds);
    const scene = { ...SCENE, bounds };
    const piecesOf = (edges: Record<string, EdgeFeature>) => wallPieces(sceneWalls(scene, { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: Object.fromEntries(Object.entries(edges).filter(([k]) => Number(k.split(",")[0]) < 16)) }, "s1:1,0": { sceneId: "s1", cx: 1, cy: 0, rev: 1, cells: {}, edges: Object.fromEntries(Object.entries(edges).filter(([k]) => Number(k.split(",")[0]) >= 16)) } }), all);
    const relief = new ReliefIndex();
    const ground = {};
    let prev: Map<string, readonly WallPiece[]> | null = null;
    const sync = (edges: Record<string, EdgeFeature>) => {
      prev = groupWalls(piecesOf(edges), prev, bounds);
      relief.sync({ sceneId: "s1", bounds, chunks: {}, tiles: null, walls: prev, global: ground, src: { ...source(ground, {}, bounds), detail: true } });
    };
    const slabAt = () => {
      const run = relief.layout(0, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, []).flatMap((i) => (i.kind === "run" ? i.pieces : []));
      return (run.find((p) => p.kind === "wall" && p.piece.ax === 15) as WallItem).slab!;
    };
    sync({ "15,4,n": WALL, "16,4,n": WALL });
    assert.ok(close(slabAt().b, { x: 16, y: 4 }), "joined across the buckets");
    sync({ "15,4,n": WALL });
    assert.ok(close(slabAt().b, { x: 16 + H, y: 4 }), "a free end once the other goes");
  });
});
