import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, EdgeFeature, TerrainId } from "#shared/model.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { rng } from "#shared/testutil.ts";
import { depth, isometric, toView, type Turn } from "../../lib/view.ts";
import { theme } from "../../lib/theme.ts";
import { groupWalls, ReliefIndex } from "./buckets.ts";
import { drawRun, type DrawContext } from "./drawRelief.ts";
import { FogView } from "./fogView.ts";
import { tintedPatternOf } from "./looks.ts";
import { boundsOf, cellPieces, facesOf, keyOf, slabCorners, WALL_THICK, wallItems, type CellPiece, type PieceSource, type WallItem } from "./pieces.ts";
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

type Paint = { style: string; lines: Pt[][]; pattern?: FakePattern };

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
        if (name === "fill") return () => fills.push({ style: fill, lines: lines.map((l) => [...l]), ...(pattern ? { pattern } : {}) });
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

  test("a slab draws its long sides in stone with the tint baked in and its light, its narrow end and cap one flat fill each, and one stroke", () => {
    withCanvas(() => {
      const stone = image();
      const items = wallsOf({ "1,4,n": WALL });
      for (const turn of TURNS) {
        const r = recorder();
        drawRun(r.g, items, dc(turn, { stone }));
        // One long side and one end face the viewer, then the cap.
        assert.deepEqual(
          r.fills.map((f) => (f.style === "baked" || f.style === "pattern" ? f.style : f.style === theme.relief.lit || f.style === theme.relief.shaded ? "light" : "flat")).sort(),
          ["baked", "flat", "flat", "light"],
          `turn ${turn}`,
        );
        assert.equal(r.strokes.length, 1);
      }
      // Two collinear slabs show their texture as one: at the joint both patterns place the same texel.
      const two = wallsOf({ "1,4,n": WALL, "2,4,n": WALL });
      const origins = two.map((w) => {
        const r = recorder();
        drawRun(r.g, [w], dc(0, { stone }));
        const m = (r.fills.find((f) => f.style === "baked")!.pattern!.m as { m: number[] }).m;
        // Where the texture's column 0 lies along the line, in view units from the joint at x = 2.
        const joint = toView(isometric(0), { x: 2, y: 4 + H }, 0.5);
        return round(((joint.x - m[4]!) / m[0]!) % 256);
      });
      assert.equal(origins[0], origins[1]);
    });
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
      // Below the detail a door is one stained plane.
      const plane = recorder();
      drawRun(plane.g, wallsOf({ "1,4,n": DOOR }, () => 0, false), dc(0, { wood }));
      assert.equal(plane.fills.length, 2);
      assert.equal(plane.fills[0]!.style, "baked");
      assert.ok(([theme.relief.lit, theme.relief.shaded] as string[]).includes(plane.fills[1]!.style));
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
