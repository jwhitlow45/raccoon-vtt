import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SQUARES, type Grid } from "#shared/rules/grid.ts";
import { cornerAt, hexCorners, hexInScene, type HexGrid } from "#shared/rules/hex.ts";
import { mulberry32 } from "../../features/areas/volumeTesting.ts";
import { theme } from "../../lib/theme.ts";
import { isometric, toView, toWorld, type Turn, type ViewPoint } from "../../lib/view.ts";
import { ReliefIndex, type Item } from "./buckets.ts";
import { drawRun, type DrawContext } from "./drawRelief.ts";
import type { PieceSource } from "./pieces.ts";

/*
 * The relief's terrain against an independent oracle
 * (docs/design-v1-iso-hex-relief.md 10.4). The oracle intersects each
 * screen point's ray with every cell's prism, a canonical polygon from
 * hex.ts or a unit square, up from minus infinity to its drawn height,
 * and takes the nearest hit: no key, no faces list, no walk. The board's
 * own drawing (ReliefIndex.layout and drawRun) runs on a canvas that
 * rasterizes exactly at those points: every fill, clip and ground copy
 * tested point by point, nonzero winding, no antialiasing. At each point
 * the last opaque paint must be the oracle's surface: a top or a floor
 * copies the ground pixel of the very world point the ray met, so a
 * floor seen through a neighbor's opening shows its own color, and a side
 * shows its owner's tone. A floor takes exactly one pit shade, its own.
 */

type Pt = { x: number; y: number };
type Sub = Pt[];
type Paint = { kind: "fill"; style: string } | { kind: "copy"; src: Pt };

const OVERLAY = new Set<string>([theme.relief.lit, theme.relief.shaded, theme.relief.edge, theme.relief.pitShade, theme.relief.wallTint]);

/** Winding number of a closed polygon around a point. */
function winding(poly: Sub, p: Pt): number {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
  }
  return w;
}

function inPath(path: readonly Sub[], p: Pt): boolean {
  let w = 0;
  for (const s of path) if (s.length > 2) w += winding(s, p);
  return w !== 0;
}

/** A 2D context that rasterizes at sample points only, recording each point's paints in order. */
/** A path made apart from the context, in its own units, as the drawing keeps its shapes' (a browser's Path2D). */
class TestPath2D {
  readonly subs: Pt[][] = [];
  #cur: Pt[] | null = null;
  moveTo(x: number, y: number): void {
    this.#cur = [{ x, y }];
    this.subs.push(this.#cur);
  }
  lineTo(x: number, y: number): void {
    if (!this.#cur) {
      this.#cur = [];
      this.subs.push(this.#cur);
    }
    this.#cur.push({ x, y });
  }
  closePath(): void {
    this.#cur = null;
  }
}
// The drawing makes its kept paths with the browser's Path2D, which node lacks.
(globalThis as { Path2D?: unknown }).Path2D = TestPath2D;

function sampler(points: readonly Pt[]): { g: CanvasRenderingContext2D; paints: Paint[][] } {
  const paints: Paint[][] = points.map(() => []);
  /** A pattern of the ground: its own transform from pattern space, the ground's device pixels, to user space. */
  type Pattern = { m: number[]; setTransform(t: { a: number; b: number; c: number; d: number; e: number; f: number }): void };
  type State = { m: number[]; clips: Sub[][]; fill: string | Pattern };
  let st: State = { m: [1, 0, 0, 1, 0, 0], clips: [], fill: "" };
  const stack: State[] = [];
  let path: Sub[] = [];
  let cur: Sub | null = null;
  const tx = (x: number, y: number): Pt => ({ x: st.m[0]! * x + st.m[2]! * y + st.m[4]!, y: st.m[1]! * x + st.m[3]! * y + st.m[5]! });
  const clipped = (p: Pt) => st.clips.every((c) => inPath(c, p));
  /** A kept path's subpaths through the transform as it is now, as a canvas reads one when it fills, or the path being built. */
  const subsOf = (p: unknown): Sub[] => (p instanceof TestPath2D ? p.subs.map((sub) => sub.map((q) => tx(q.x, q.y))) : path);
  const g = {
    get fillStyle() {
      return st.fill;
    },
    set fillStyle(v: string | Pattern) {
      st.fill = v;
    },
    strokeStyle: "",
    lineWidth: 1,
    lineJoin: "",
    lineCap: "",
    globalAlpha: 1,
    setLineDash() {},
    save() {
      stack.push({ m: [...st.m], clips: [...st.clips], fill: st.fill });
    },
    restore() {
      st = stack.pop()!;
    },
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      st.m = [a, b, c, d, e, f];
    },
    beginPath() {
      path = [];
      cur = null;
    },
    moveTo(x: number, y: number) {
      cur = [tx(x, y)];
      path.push(cur);
    },
    lineTo(x: number, y: number) {
      if (!cur) {
        cur = [];
        path.push(cur);
      }
      cur.push(tx(x, y));
    },
    closePath() {
      cur = null;
    },
    clip(p?: unknown) {
      st.clips = [...st.clips, subsOf(p).map((s) => [...s])];
    },
    fill(at?: unknown) {
      const fill = st.fill;
      const subs = subsOf(at);
      points.forEach((p, i) => {
        if (!clipped(p) || !inPath(subs, p)) return;
        if (typeof fill === "string") {
          paints[i]!.push({ kind: "fill", style: fill });
          return;
        }
        // The ground pixel a pattern shows at p: p through the inverse of the context's transform after the pattern's.
        const [a, b, c, d, e, f] = compose(st.m, fill.m);
        const det = a * d - b * c;
        const x = p.x - e;
        const y = p.y - f;
        paints[i]!.push({ kind: "copy", src: { x: (d * x - c * y) / det, y: (a * y - b * x) / det } });
      });
    },
    stroke() {},
    fillRect(x: number, y: number, w: number, h: number) {
      const a = tx(x, y);
      const b = tx(x + w, y + h);
      points.forEach((p, i) => {
        if (clipped(p) && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) paints[i]!.push({ kind: "fill", style: typeof st.fill === "string" ? st.fill : "pattern" });
      });
    },
    drawImage(_img: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number) {
      const a = tx(dx, dy);
      const b = tx(dx + sw, dy + sh);
      points.forEach((p, i) => {
        if (!clipped(p) || p.x < a.x || p.x > b.x || p.y < a.y || p.y > b.y) return;
        paints[i]!.push({ kind: "copy", src: { x: p.x - dx + sx, y: p.y - dy + sy } });
      });
    },
    ellipse() {
      throw new Error("no pillars here");
    },
    createPattern(img: unknown): Pattern | null {
      // Only the ground stage's canvas is copied as a pattern here: textures stay off in these scenes.
      if (!img || typeof img !== "object" || !("width" in img)) return null;
      const pattern: Pattern = {
        m: [1, 0, 0, 1, 0, 0],
        setTransform(t) {
          pattern.m = [t.a, t.b, t.c, t.d, t.e, t.f];
        },
      };
      return pattern;
    },
  };
  return { g: g as unknown as CanvasRenderingContext2D, paints };
}

/** Each cell's own side color, distinct in every channel step, and with the light mixed in still distinct. */
function lookOf(col: number, row: number): string {
  return `rgb(${20 + 3 * (col + 2)}, ${20 + 3 * (row + 2)}, 200)`;
}

/** An rgb() color with an rgba() one laid over it, as a canvas mixes them, worked here apart from the drawing's own code. */
function mixed(base: string, over: string): string {
  const b = base.match(/[\d.]+/g)!.map(Number);
  const o = over.match(/[\d.]+/g)!.map(Number);
  const a = o[3]!;
  return `rgb(${[0, 1, 2].map((i) => Math.round(b[i]! * (1 - a) + o[i]! * a)).join(", ")})`;
}

/** The matrix `m` then `n` applies after it, as a canvas composes its transform with a pattern's: m times n. */
function compose(m: readonly number[], n: readonly number[]): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const [p, q, r, s, t, u] = n as [number, number, number, number, number, number];
  return [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f];
}

/** The oracle's polygon of a cell: hex.ts's canonical corners, or the unit square. */
function oraclePoly(grid: Grid, col: number, row: number): Pt[] {
  if (grid.shape === "squares") return [{ x: col, y: row }, { x: col + 1, y: row }, { x: col + 1, y: row + 1 }, { x: col, y: row + 1 }];
  return hexCorners(grid, { col, row }).map((k) => cornerAt(grid, k));
}

/** Where a line a + t·d lies inside a convex polygon, by its own clipping against each side's half-plane. */
function clipLine(poly: Pt[], a: Pt, d: Pt): [number, number] | null {
  let area = 0;
  for (let i = 0; i < poly.length; i++) area += poly[i]!.x * poly[(i + 1) % poly.length]!.y - poly[(i + 1) % poly.length]!.x * poly[i]!.y;
  const sign = area > 0 ? 1 : -1;
  let lo = -1e9;
  let hi = 1e9;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    // Inward normal of side p -> q.
    const nx = -sign * (q.y - p.y);
    const ny = sign * (q.x - p.x);
    const num = nx * (a.x - p.x) + ny * (a.y - p.y);
    const den = nx * d.x + ny * d.y;
    if (Math.abs(den) < 1e-15) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
  }
  return lo <= hi ? [lo, hi] : null;
}

type Scene = { grid: Grid; w: number; h: number; ground: Map<string, number> };

function inScene(s: Scene, col: number, row: number): boolean {
  return s.grid.shape === "squares" ? col >= 0 && row >= 0 && col < s.w && row < s.h : hexInScene(s.grid, s, { col, row });
}

function groundOf(s: Scene, col: number, row: number): number {
  return inScene(s, col, row) ? (s.ground.get(`${col},${row}`) ?? 0) : 0;
}

type Hit = { z: number; col: number; row: number; side: boolean; from: { col: number; row: number } | null; tie: boolean };

/** The nearest prism hit along the ray under view point v: the highest z at which the ray is inside a cell's polygon at or below its ground. */
function oracle(s: Scene, turn: Turn, v: Pt): Hit | null {
  const view = isometric(turn);
  const a = toWorld(view, v as ViewPoint, 0);
  const one = toWorld(view, v as ViewPoint, 1);
  const d = { x: one.x - a.x, y: one.y - a.y };
  const hits: Hit[] = [];
  const spans: { col: number; row: number; lo: number; hi: number }[] = [];
  for (let row = -3; row < s.h + 6; row++) {
    for (let col = -3; col < s.w + 6; col++) {
      const iv = clipLine(oraclePoly(s.grid, col, row), a, d);
      if (!iv || iv[1] - iv[0] < 1e-12) continue;
      spans.push({ col, row, lo: iv[0], hi: iv[1] });
      const g = groundOf(s, col, row);
      const z = Math.min(g, iv[1]);
      if (z < iv[0]) continue;
      hits.push({ z, col, row, side: g >= iv[1], from: null, tie: false });
    }
  }
  if (hits.length === 0) return null;
  hits.sort((p, q) => q.z - p.z);
  const best = hits[0]!;
  best.tie = hits.length > 1 && hits[1]!.z > best.z - 1e-7;
  if (best.side) {
    const from = spans.find((sp) => Math.abs(sp.lo - best.z) < 1e-9 && sp.hi > best.z);
    best.from = from ? { col: from.col, row: from.row } : null;
    if (!from) best.tie = true;
  }
  return best;
}

const CAM = { x: 400, y: 400, scale: 1 };

function draw(items: Item[], points: Pt[], turn: Turn, relief: ReliefIndex): Paint[][] {
  const { g, paints } = sampler(points);
  const dc: DrawContext = {
    turn,
    camera: CAM,
    pixelRatio: 1,
    ground: { width: 4000, height: 4000 } as HTMLCanvasElement,
    textures: {},
    view: { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 },
    openings: (r, box, asker) => relief.openingsMeeting(r, turn, box, asker),
  };
  for (const item of items) if (item.kind === "run") drawRun(g, item.pieces, dc);
  return paints;
}

function source(s: Scene): PieceSource {
  return {
    ground: (x, y) => groundOf(s, x, y),
    terrain: () => null,
    look: (x, y) => ({ texture: null, color: lookOf(x, y) }),
    bounds: { w: s.w, h: s.h },
    grid: s.grid,
  };
}

function relieve(s: Scene): ReliefIndex {
  const relief = new ReliefIndex();
  relief.sync({ sceneId: "s1", bounds: { w: s.w, h: s.h }, chunks: {}, tiles: null, walls: new Map(), global: s, src: source(s), grid: s.grid });
  return relief;
}

/** Checks one scene at one turn at `n` random points near its raised and lowered cells, returning the failures. A turn reuses the scene's index, as the board's does. */
function check(s: Scene, turn: Turn, rand: () => number, n: number, relief = relieve(s)): string[] {
  const items = relief.layout(turn, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, []);
  const view = isometric(turn);
  const cells = [...s.ground.entries()].filter(([, z]) => z !== 0);
  if (cells.length === 0) return [];
  const views: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const [key, z] = cells[Math.floor(rand() * cells.length)]!;
    const [col, row] = key.split(",").map(Number) as [number, number];
    const poly = oraclePoly(s.grid, col, row);
    const c = poly.reduce((m, p) => ({ x: m.x + p.x / poly.length, y: m.y + p.y / poly.length }), { x: 0, y: 0 });
    // A point near the cell's middle at some height between 0 and its ground, then jittered on screen by up to a cell.
    const h = rand() * z;
    const at = { x: c.x + (rand() - 0.5) * 1.6, y: c.y + (rand() - 0.5) * 1.6 };
    views.push(toView(view, at, h));
  }
  const devices = views.map((v) => ({ x: v.x * CAM.scale + CAM.x, y: v.y * CAM.scale + CAM.y }));
  const paints = draw(items, devices, turn, relief);
  const fails: string[] = [];
  views.forEach((v, i) => {
    const hit = oracle(s, turn, v);
    if (!hit || hit.tie) return;
    const list = paints[i]!;
    let last = -1;
    for (let k = list.length - 1; k >= 0; k--) {
      const p = list[k]!;
      if (p.kind === "copy" || !OVERLAY.has(p.style)) {
        last = k;
        break;
      }
    }
    const shades = list.slice(last + 1).filter((p) => p.kind === "fill" && p.style === theme.relief.pitShade).length;
    const at = `turn ${turn} view (${v.x.toFixed(6)}, ${v.y.toFixed(6)}) oracle ${hit.side ? "side" : "top"} of ${hit.col},${hit.row} at z ${hit.z.toFixed(6)}`;
    const g = groundOf(s, hit.col, hit.row);
    if (!hit.side) {
      if (g === 0) {
        if (last >= 0) fails.push(`${at}: flat ground at 0 shows, but ${JSON.stringify(list[last])} was painted over it`);
        return;
      }
      const want = toWorld(view, v as ViewPoint, hit.z);
      const p = list[last];
      if (!p || p.kind !== "copy") {
        fails.push(`${at}: a ${g > 0 ? "top" : "floor"} shows, but the last paint is ${JSON.stringify(p)}`);
        return;
      }
      const got = toWorld(view, { x: (p.src.x - CAM.x) / CAM.scale, y: (p.src.y - CAM.y) / CAM.scale } as ViewPoint, 0);
      if (Math.hypot(got.x - want.x, got.y - want.y) > 1e-6) fails.push(`${at}: copied the ground at (${got.x.toFixed(4)}, ${got.y.toFixed(4)}), not (${want.x.toFixed(4)}, ${want.y.toFixed(4)})`);
      if (shades !== (g < 0 ? 1 : 0)) fails.push(`${at}: ${shades} pit shades over it`);
      return;
    }
    // A side above 0 is the higher cell's near side, one below 0 the pit's far side: whichever draws it wears its own look.
    const owner = hit.z > 0 ? { col: hit.col, row: hit.row } : hit.from;
    if (!owner) return;
    const want = lookOf(owner.col, owner.row);
    const p = list[last];
    // A plain look and the light from the left fill as one color, mixed.
    const worn = [want, mixed(want, theme.relief.lit), mixed(want, theme.relief.shaded)];
    if (!p || p.kind !== "fill" || !worn.includes(p.style)) fails.push(`${at}: a side of ${want} shows, but the last paint is ${JSON.stringify(p)}`);
  });
  return fails;
}

function randomScene(grid: Grid, rand: () => number, mode: "mixed" | "pits" | "equalPits"): Scene {
  const w = 8 + Math.floor(rand() * 17);
  const h = 8 + Math.floor(rand() * 17);
  const ground = new Map<string, number>();
  const density = 0.15 + rand() * 0.5;
  for (let row = -1; row < h + 4; row++) {
    for (let col = -1; col < w + 4; col++) {
      if (rand() > density) continue;
      let z: number;
      if (mode === "equalPits") z = -1.5;
      else if (mode === "pits") z = -(1 + Math.floor(rand() * 4)) / 2;
      else z = (Math.floor(rand() * 9) - 4) / 2;
      // Cells past the scene carry heights the board must never draw.
      ground.set(`${col},${row}`, z);
    }
  }
  return { grid, w, h, ground };
}

const GRIDS: readonly [string, Grid][] = [
  ["hex rows", { shape: "hex", orient: "rows" } as HexGrid],
  ["hex columns", { shape: "hex", orient: "columns" } as HexGrid],
  ["squares", SQUARES],
];

describe("the relief's terrain against a ray oracle (design 10.4)", () => {
  for (const [name, grid] of GRIDS) {
    const maps = grid.shape === "squares" ? 600 : 2000;
    test(`${name}: ${maps} random height maps, every turn, raised hexes and pits, the last opaque paint is the nearest prism hit`, () => {
      const seed = grid.shape === "squares" ? 0x51 : grid.orient === "rows" ? 0x68153046 : 0x68153047;
      const rand = mulberry32(seed);
      let checked = 0;
      for (let m = 0; m < maps; m++) {
        const mode = m % 5 === 3 ? "pits" : m % 5 === 4 ? "equalPits" : "mixed";
        const s = randomScene(grid, rand, mode);
        const relief = relieve(s);
        for (const turn of [0, 1, 2, 3] as Turn[]) {
          const fails = check(s, turn, rand, 6, relief);
          checked += 6;
          if (fails.length > 0) {
            const cells = [...s.ground].filter(([k]) => inScene(s, ...(k.split(",").map(Number) as [number, number]))).map(([k, z]) => `${k}=${z}`);
            assert.fail(`seed ${seed} map ${m} (${s.w} by ${s.h}, ${mode}): ${fails[0]}\ncells ${cells.join(" ")}`);
          }
        }
      }
      assert.ok(checked >= maps * 24);
    });
  }

  test("all hexes at -1: the floor of (3,3) shows through the opening of (5,4) on rows and (4,5) on columns at turn 0", () => {
    for (const [grid, opening] of [
      [{ shape: "hex", orient: "rows" } as HexGrid, { col: 5, row: 4 }],
      [{ shape: "hex", orient: "columns" } as HexGrid, { col: 4, row: 5 }],
    ] as const) {
      const s: Scene = { grid, w: 10, h: 10, ground: new Map() };
      for (let row = 0; row < 12; row++) for (let col = 0; col < 12; col++) s.ground.set(`${col},${row}`, -1);
      const relief = relieve(s);
      assert.equal(relief.regions.length, 1, "one connected region");
      const items = relief.layout(0, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, []);
      // Points inside the opening of the named hex at 0 whose ray meets the floor of (3,3) at -1.
      const view = isometric(0);
      const rand = mulberry32(7);
      const views: Pt[] = [];
      for (let i = 0; i < 4000 && views.length < 12; i++) {
        const poly = oraclePoly(grid, opening.col, opening.row);
        const c = poly.reduce((m, p) => ({ x: m.x + p.x / 6, y: m.y + p.y / 6 }), { x: 0, y: 0 });
        const p = { x: c.x + (rand() - 0.5) * 1.2, y: c.y + (rand() - 0.5) * 1.2 };
        if (winding(poly, p) === 0) continue;
        const v = { x: 0.7071067811865476 * (p.x - p.y), y: (0.7071067811865476 * (p.x + p.y)) / 2 };
        const hit = oracle(s, 0, v);
        if (hit && !hit.tie && !hit.side && hit.col === 3 && hit.row === 3) views.push(v);
      }
      assert.ok(views.length > 0, `${grid.orient}: some rays through the opening meet the floor of (3,3)`);
      const paints = draw(items, views.map((v) => ({ x: v.x + CAM.x, y: v.y + CAM.y })), 0, relief);
      views.forEach((v, i) => {
        const copy = [...paints[i]!].reverse().find((p) => p.kind === "copy");
        assert.ok(copy?.kind === "copy");
        const got = toWorld(view, { x: copy.src.x - CAM.x, y: copy.src.y - CAM.y } as ViewPoint, 0);
        const want = toWorld(view, v as ViewPoint, -1);
        assert.ok(Math.hypot(got.x - want.x, got.y - want.y) < 1e-6, `${grid.orient}: shows the floor's own pixel`);
      });
    }
  });
});
