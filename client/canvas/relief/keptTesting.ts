/*
 * A canvas for the kept picture's tests (docs/design-v1-relief-pan.md 10.2):
 * a grid of device pixels, each holding the paints it took in order, folded
 * into one number, so two pictures agree only where every pixel took the
 * same paints in the same order. A fill paints the pixels whose centers lie
 * in its path and, standing in for antialiasing, every pixel whose square
 * its edge crosses (centers within 0.71 px of an edge). A stroke paints the
 * pixels whose centers lie within half its width and 0.71 px of its path.
 * Clips, `clearRect`, a copy of the canvas onto itself, and patterns of a
 * ground canvas (transparent past its edges) follow the 2D context's rules.
 */

import type { Grid } from "#shared/rules/grid.ts";
import { hexInScene } from "#shared/rules/hex.ts";
import type { BandPart } from "../../features/areas/volume.ts";
import { screenToView, type Camera } from "../../lib/camera.ts";
import { isometric, toView, type Turn } from "../../lib/view.ts";
import { ReliefIndex, type DrawPiece, type Item, type StandeeIn, type VolumePiece } from "./buckets.ts";
import { drawRun, NO_AREA_PITS, runPaintedBox, standeePaintedBox, type DrawContext } from "./drawRelief.ts";
import { keptHost, onDeviceGrid } from "./kept.ts";
import type { VBox } from "./pieces.ts";
import { FrameScheduler, type KeptHost, type KeptLayer } from "./scheduler.ts";
import { standeeShape } from "./standee.ts";


type Pt = { x: number; y: number };
type M = [number, number, number, number, number, number];

/** The pixels within this distance of an edge take its paint: a pixel's square meets the edge. */
const FRINGE = Math.SQRT1_2;

/** A path made apart from the context, in its own units, as the browser's Path2D (node has none). */
export class TestPath2D {
  readonly subs: { pts: Pt[]; closed: boolean }[] = [];
  #cur: { pts: Pt[]; closed: boolean } | null = null;
  moveTo(x: number, y: number): void {
    this.#cur = { pts: [{ x, y }], closed: false };
    this.subs.push(this.#cur);
  }
  lineTo(x: number, y: number): void {
    if (!this.#cur) this.moveTo(x, y);
    else this.#cur.pts.push({ x, y });
  }
  closePath(): void {
    if (this.#cur) this.#cur.closed = true;
    this.#cur = null;
  }
}

export function installPath2D(): void {
  (globalThis as { Path2D?: unknown }).Path2D = TestPath2D;
}

/** A ground canvas: its size in device pixels, and the value of each of its pixels. */
export type TestGround = { width: number; height: number; at(x: number, y: number): number };

type Pattern = { ground: TestGround; m: M; setTransform(t: { a: number; b: number; c: number; d: number; e: number; f: number }): void };

type State = { m: M; clip: Uint8Array | null; fill: string | Pattern; stroke: string; width: number; alpha: number; op: string };

const tokens = new Map<string, number>();
function token(s: string): number {
  let t = tokens.get(s);
  if (t === undefined) tokens.set(s, (t = tokens.size + 1));
  return t;
}

/** Folds one paint into a pixel's value. */
function fold(v: number, paint: number): number {
  return (Math.imul(v ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(paint, 0xc2b2ae35)) | 0 || 1;
}

function apply(m: M, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function invert(m: M): M {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function times(m: M, n: M): M {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l));
  const x = a.x + t * dx - p.x;
  const y = a.y + t * dy - p.y;
  return x * x + y * y;
}

/**
 * A device-pixel canvas with the 2D context's calls the relief draws with.
 * `values` holds each pixel's folded paints, 0 where nothing painted.
 */
export class TestCanvas {
  readonly width: number;
  readonly height: number;
  values: Int32Array;
  /** Pixels a draw painted, counted for the bounded-paint invariant. */
  painted = 0;
  readonly canvas: { width: number; height: number };
  #st: State = { m: [1, 0, 0, 1, 0, 0], clip: null, fill: "#000", stroke: "#000", width: 1, alpha: 1, op: "source-over" };
  readonly #stack: State[] = [];
  #path: { pts: Pt[]; closed: boolean }[] = [];
  #cur: { pts: Pt[]; closed: boolean } | null = null;
  /** What `getImageData` reads: the color each single paint over clear shows, for the self-copy probe. */
  readonly #colors = new Map<number, [number, number, number, number]>();
  /** A copy of the canvas onto itself that reads as it writes, forward, as a browser that copies wrong would. */
  brokenCopy = false;
  /** A readback that throws, as a tainted canvas does. */
  throwOnRead = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.values = new Int32Array(width * height);
    this.canvas = this as unknown as { width: number; height: number };
    for (const [c, rgba] of [
      ["#ff0000", [255, 0, 0, 255]],
      ["#0000ff", [0, 0, 255, 255]],
    ] as const) this.#colors.set(fold(0, token(`${c}|1`)), [...rgba]);
  }

  get g(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }

  get fillStyle(): string | Pattern {
    return this.#st.fill;
  }
  set fillStyle(v: string | Pattern) {
    this.#st.fill = v;
  }
  get strokeStyle(): string {
    return this.#st.stroke;
  }
  set strokeStyle(v: string) {
    this.#st.stroke = v;
  }
  get lineWidth(): number {
    return this.#st.width;
  }
  set lineWidth(v: number) {
    this.#st.width = v;
  }
  get globalAlpha(): number {
    return this.#st.alpha;
  }
  set globalAlpha(v: number) {
    this.#st.alpha = v;
  }
  get globalCompositeOperation(): string {
    return this.#st.op;
  }
  set globalCompositeOperation(v: string) {
    this.#st.op = v;
  }
  lineJoin = "miter";
  lineCap = "butt";
  setLineDash(): void {}

  save(): void {
    this.#stack.push({ ...this.#st, m: [...this.#st.m] as M });
  }
  restore(): void {
    const s = this.#stack.pop();
    if (s) this.#st = s;
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#st.m = [a, b, c, d, e, f];
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#st.m = times(this.#st.m, [a, b, c, d, e, f]);
  }
  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0);
  }
  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y);
  }

  beginPath(): void {
    this.#path = [];
    this.#cur = null;
  }
  moveTo(x: number, y: number): void {
    this.#cur = { pts: [apply(this.#st.m, x, y)], closed: false };
    this.#path.push(this.#cur);
  }
  lineTo(x: number, y: number): void {
    if (!this.#cur) return this.moveTo(x, y);
    this.#cur.pts.push(apply(this.#st.m, x, y));
  }
  closePath(): void {
    if (this.#cur) this.#cur.closed = true;
    this.#cur = null;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, _rot: number, a0: number, a1: number, ccw = false): void {
    const n = 24;
    let span = a1 - a0;
    if (ccw && span > 0) span -= Math.PI * 2;
    if (!ccw && span < 0) span += Math.PI * 2;
    if (Math.abs(span) >= Math.PI * 2) span = Math.sign(span || 1) * Math.PI * 2;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (span * i) / n;
      const x = cx + rx * Math.cos(a);
      const y = cy + ry * Math.sin(a);
      if (i === 0 && !this.#cur) this.moveTo(x, y);
      else this.lineTo(x, y);
    }
  }

  /** A path argument's subpaths in device pixels, or the context's own path. */
  #subs(p: unknown): { pts: Pt[]; closed: boolean }[] {
    if (p instanceof TestPath2D) return p.subs.map((s) => ({ pts: s.pts.map((q) => apply(this.#st.m, q.x, q.y)), closed: s.closed }));
    return this.#path;
  }

  /** A mark per pixel, each cover's own generation, so a cover lists its pixels once without a mask of its own. */
  #gen = 0;

  #start(): { list: number[]; gen: number; mark: Int32Array } {
    return { list: [], gen: ++this.#gen, mark: this.#marks() };
  }

  #marksArray: Int32Array | null = null;
  #marks(): Int32Array {
    return (this.#marksArray ??= new Int32Array(this.width * this.height));
  }

  /** The pixels inside subpaths by the rule, with the fringe its edges cross when `fringe`, each once. */
  #cover(subs: readonly { pts: Pt[] }[], rule: string, fringe: boolean): number[] {
    const { list, gen, mark } = this.#start();
    const add = (i: number) => {
      if (mark[i] === gen) return;
      mark[i] = gen;
      list.push(i);
    };
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const s of subs) for (const p of s.pts) {
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    if (!(y1 >= y0)) return list;
    const r0 = Math.max(0, Math.floor(y0 - 1));
    const r1 = Math.min(this.height - 1, Math.ceil(y1 + 1));
    const hits: { x: number; w: number }[] = [];
    for (let row = r0; row <= r1; row++) {
      const cy = row + 0.5;
      hits.length = 0;
      for (const s of subs) {
        const n = s.pts.length;
        if (n < 2) continue;
        for (let i = 0; i < n; i++) {
          const a = s.pts[i]!;
          const b = s.pts[(i + 1) % n]!;
          if (a.y <= cy ? b.y > cy : b.y <= cy) hits.push({ x: a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y), w: b.y > a.y ? 1 : -1 });
        }
      }
      hits.sort((p, q) => p.x - q.x);
      let wind = 0;
      for (let i = 0; i + 1 < hits.length; i++) {
        wind += hits[i]!.w;
        const inside = rule === "evenodd" ? i % 2 === 0 : wind !== 0;
        if (!inside) continue;
        const from = Math.max(0, Math.ceil(hits[i]!.x - 0.5));
        const to = Math.min(this.width - 1, Math.floor(hits[i + 1]!.x - 0.5));
        for (let col = from; col <= to; col++) add(row * this.width + col);
      }
    }
    if (fringe) for (const s of subs) this.#band(s.pts, true, FRINGE, add);
    return list;
  }

  /** Adds the pixels within `reach` of a polyline. */
  #band(pts: readonly Pt[], closed: boolean, reach: number, add: (i: number) => void): void {
    const n = pts.length;
    const r2 = reach * reach;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      const c0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - reach - 0.5));
      const c1 = Math.min(this.width - 1, Math.ceil(Math.max(a.x, b.x) + reach - 0.5));
      const rr0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - reach - 0.5));
      const rr1 = Math.min(this.height - 1, Math.ceil(Math.max(a.y, b.y) + reach - 0.5));
      for (let row = rr0; row <= rr1; row++) for (let col = c0; col <= c1; col++) if (segDist2({ x: col + 0.5, y: row + 0.5 }, a, b) < r2) add(row * this.width + col);
    }
  }

  /** Pixels a draw wrote, paint or clear, since `touched` was last reset: what a scroll must keep inside its regions. */
  touched = new Set<number>();
  /** A pixel whose paints are logged, for a failure's story. */
  trace: { at: number; log: string[] } | null = null;

  #paint(cover: readonly number[], style: string | Pattern): void {
    const clip = this.#st.clip;
    const alpha = this.#st.alpha;
    const pattern = typeof style === "string" ? null : style;
    const t = pattern ? 0 : token(`${style as string}|${alpha}`);
    const toGround = pattern ? invert(times(this.#st.m, pattern.m)) : null;
    for (const i of cover) {
      if (clip && !clip[i]) continue;
      let paint = t;
      if (pattern && toGround) {
        const p = apply(toGround, (i % this.width) + 0.5, Math.floor(i / this.width) + 0.5);
        const gx = Math.floor(p.x);
        const gy = Math.floor(p.y);
        if (gx < 0 || gy < 0 || gx >= pattern.ground.width || gy >= pattern.ground.height) continue;
        paint = token(`ground ${pattern.ground.at(gx, gy)}|${alpha}`);
      }
      this.values[i] = fold(this.values[i]!, paint);
      if (this.trace?.at === i) this.trace.log.push(`paint ${pattern ? `ground ${paint}` : (style as string)} alpha ${alpha}`);
      this.painted++;
      this.touched.add(i);
    }
  }

  fill(a?: unknown, b?: unknown): void {
    const path = typeof a === "string" || a === undefined ? undefined : a;
    const rule = typeof a === "string" ? a : typeof b === "string" ? b : "nonzero";
    this.#paint(this.#cover(this.#subs(path), rule, true), this.#st.fill);
  }

  stroke(p?: unknown): void {
    const { list, gen, mark } = this.#start();
    const add = (i: number) => {
      if (mark[i] === gen) return;
      mark[i] = gen;
      list.push(i);
    };
    // The width in device pixels: the transform only scales evenly here.
    const k = Math.hypot(this.#st.m[0], this.#st.m[1]);
    for (const s of this.#subs(p)) this.#band(s.pts, s.closed, (this.#st.width * k) / 2 + FRINGE, add);
    this.#paint(list, this.#st.stroke);
  }

  clip(a?: unknown, b?: unknown): void {
    const path = typeof a === "string" || a === undefined ? undefined : a;
    const rule = typeof a === "string" ? a : typeof b === "string" ? b : "nonzero";
    const mask = new Uint8Array(this.width * this.height);
    for (const i of this.#cover(this.#subs(path), rule, false)) mask[i] = 1;
    const was = this.#st.clip;
    if (was) for (let i = 0; i < mask.length; i++) mask[i] = mask[i]! & was[i]!;
    this.#st.clip = mask;
  }

  #rectCover(x: number, y: number, w: number, h: number): number[] {
    const a = apply(this.#st.m, x, y);
    const b = apply(this.#st.m, x + w, y + h);
    const out: number[] = [];
    for (let row = Math.max(0, Math.ceil(Math.min(a.y, b.y) - 0.5)); row <= Math.min(this.height - 1, Math.floor(Math.max(a.y, b.y) - 0.5)); row++) {
      for (let col = Math.max(0, Math.ceil(Math.min(a.x, b.x) - 0.5)); col <= Math.min(this.width - 1, Math.floor(Math.max(a.x, b.x) - 0.5)); col++) out.push(row * this.width + col);
    }
    return out;
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const clip = this.#st.clip;
    for (const i of this.#rectCover(x, y, w, h)) {
      if (clip && !clip[i]) continue;
      this.values[i] = 0;
      if (this.trace?.at === i) this.trace.log.push("clear");
      this.touched.add(i);
    }
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.#paint(this.#rectCover(x, y, w, h), this.#st.fill);
  }

  /** Only a copy of this canvas onto itself, in device pixels, as the kept picture's scroll makes it. */
  drawImage(img: unknown, dx: number, dy: number): void {
    if (img !== this) throw new Error("only a copy onto itself");
    const m = this.#st.m;
    if (m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1) throw new Error("a copy in device pixels only");
    const ox = Math.round(dx + m[4]);
    const oy = Math.round(dy + m[5]);
    const src = this.values;
    const copy = this.#st.op === "copy";
    // A broken copy walks forward through the one buffer, so a pixel it wrote is read again further on.
    const out = this.brokenCopy ? src : copy ? new Int32Array(src.length) : new Int32Array(src);
    const clip = this.#st.clip;
    for (let row = 0; row < this.height; row++) {
      const sy = row - oy;
      for (let col = 0; col < this.width; col++) {
        const i = row * this.width + col;
        if (clip && !clip[i]) {
          if (copy && !this.brokenCopy) out[i] = src[i]!;
          continue;
        }
        const sx = col - ox;
        if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) {
          if (copy) out[i] = 0;
          continue;
        }
        out[i] = (this.brokenCopy ? out : src)[sy * this.width + sx]!;
      }
    }
    this.values = out;
  }

  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } {
    if (this.throwOnRead) throw new Error("tainted");
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const v = this.values[(y + row) * this.width + (x + col)]!;
        const rgba = v === 0 ? [0, 0, 0, 0] : (this.#colors.get(v) ?? [1, 2, 3, 255]);
        data.set(rgba, (row * w + col) * 4);
      }
    }
    return { data };
  }

  createPattern(img: unknown): Pattern | null {
    if (!img || typeof img !== "object" || !("at" in img)) return null;
    const pattern: Pattern = {
      ground: img as TestGround,
      m: [1, 0, 0, 1, 0, 0],
      setTransform(t) {
        pattern.m = [t.a, t.b, t.c, t.d, t.e, t.f];
      },
    };
    return pattern;
  }

  /** The pixels where two canvases differ, as "x,y" strings, at most `max`. */
  diff(other: TestCanvas, max = 8): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.values.length && out.length < max; i++) if (this.values[i] !== other.values[i]) out.push(`${i % this.width},${Math.floor(i / this.width)}`);
    return out;
  }
}

// ------------------------------------------------------------------ the rig

type Shape = { art: VBox; ring: VBox; frame: VBox; bounds: VBox };

/** A scene for the rig: its grid, size and each cell's ground in cells. */
export type RigScene = { grid: Grid; w: number; h: number; ground: Map<string, number> };

/** A creature standing on the rig's relief. */
export type RigStandee = { id: string; x: number; y: number; size: number; look: number };

/** An area standing on the rig's relief: one cube band over a cell. */
export type RigArea = { id: string; x: number; y: number; z0: number; z1: number; selected: boolean };

/** How the rig's board lays out: in steps of this many CSS pixels, a step to spare on every side, as the board's cull box. */
export const RIG_STEP_PX = 24;

/**
 * The isometric board's relief as the kept picture's tests drive it: the
 * real ReliefIndex layout and drawRun, the real FrameScheduler and its kept
 * picture, standees drawn inside their StandeeShape boxes, a ground canvas
 * of its real extent whose pixels follow the camera, and the layout's cull
 * box with the board's render delay. `whole()` draws the same state from
 * nothing, for comparison.
 */
export class KeptRig {
  readonly canvas: TestCanvas;
  readonly ratio: number;
  /** The canvas in CSS pixels. */
  readonly size: { width: number; height: number };
  scene: RigScene;
  turn: Turn = 0;
  /** The camera on the stage: on the device grid. */
  camera: Camera;
  /** The ground canvas's extra height past the view, in CSS pixels. */
  margin: number;
  standees: RigStandee[] = [];
  areas: RigArea[] = [];
  /** Bumped by anything that changes the ground's pixels: a fog reveal, a map set. */
  groundLook = 0;
  /** Bumped by a texture arriving: what every standee and side shows. */
  look = 0;
  /** The ground layer's draws on every path, as its Konva `draw` event counts them. */
  groundDraws = 0;
  readonly scheduler: FrameScheduler;
  readonly #queue: ((t: number) => void)[] = [];
  #relief: ReliefIndex;
  /** The layout the board last rendered, and its cull box. */
  items: Item[] = [];
  rendered: { key: string; box: VBox } = { key: "", box: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  /** A relayout the board's render has yet to commit: a cull step, committed a task after its move. */
  pendingLayout = false;
  readonly #dc: DrawContext;
  #host!: KeptHost;
  /** Children the scroll path drew, for the skip rule. */
  childDraws = 0;
  /** The ground canvas as the pattern reads it, at the camera it last drew. */
  readonly #ground: TestGround & { cam: Camera; look: number };
  readonly #reliefLayer: { getCanvas(): unknown; drawScene(c?: unknown, t?: unknown): unknown; draw(): void; batchDraw(): unknown; _fire(): void };
  readonly #groundLayer: { draw(): void; batchDraw(): unknown };
  key = "k";

  constructor(scene: RigScene, opts: { width: number; height: number; ratio: number; camera: Camera; margin: number }) {
    this.scene = scene;
    this.ratio = opts.ratio;
    this.size = { width: opts.width / opts.ratio, height: opts.height / opts.ratio };
    this.canvas = new TestCanvas(opts.width, opts.height);
    this.camera = onDeviceGrid(opts.camera, opts.ratio);
    this.margin = opts.margin;
    this.#relief = this.#sync();
    const rig = this;
    const ground: TestGround & { cam: Camera; look: number } = {
      cam: this.camera,
      look: 0,
      get width() {
        return opts.width;
      },
      get height() {
        return Math.round((rig.size.height + rig.margin) * rig.ratio);
      },
      at(gx, gy) {
        // The map under a ground pixel at the camera the ground last drew: a texture fixed to the world, in blocks of 3 device pixels.
        const u = Math.floor((gx - Math.round(ground.cam.x * rig.ratio)) / 3);
        const v = Math.floor((gy - Math.round(ground.cam.y * rig.ratio)) / 3);
        return (u * 73856093) ^ (v * 19349663) ^ (ground.cam.scale * 1000) ^ (ground.look * 83492791);
      },
    };
    this.#ground = ground;
    this.#dc = { turn: 0, camera: this.camera, pixelRatio: this.ratio, ground: ground as unknown as HTMLCanvasElement, textures: {}, view: { x0: 0, y0: 0, x1: 0, y1: 0 } };
    const canvasOf = {
      getContext: () => ({ _context: this.canvas.g }),
      get width() {
        return rig.canvas.width;
      },
      get height() {
        return rig.canvas.height;
      },
      getPixelRatio: () => this.ratio,
    };
    class ReliefLayer {
      getCanvas() {
        return canvasOf;
      }
      // Konva's own drawScene: clear before draw, then every child in order.
      drawScene(can?: unknown) {
        const target = (can as { g?: CanvasRenderingContext2D } | undefined)?.g ?? rig.canvas.g;
        target.clearRect(0, 0, 1e6, 1e6);
        for (const item of rig.items) rig.#drawItem(target, item);
        return this;
      }
      draw() {
        this.drawScene();
      }
      batchDraw() {
        return this;
      }
      _fire() {}
    }
    this.#reliefLayer = new ReliefLayer();
    this.#groundLayer = {
      draw: () => {
        this.groundDraws++;
        ground.cam = this.camera;
        ground.look = this.groundLook;
      },
      batchDraw: () => this.#groundLayer,
    };
    this.scheduler = new FrameScheduler(this.#groundLayer, this.#reliefLayer, { request: (run) => this.#queue.push(run), cancel: () => {} }, () => 0);
    this.#host = keptHost<Item>({
      layer: this.#reliefLayer as unknown as KeptLayer,
      camera: () => this.camera,
      size: () => this.size,
      turn: () => this.turn,
      key: () => this.key,
      groundVersion: () => this.groundDraws,
      dc: () => this.#dc,
      items: () => this.items,
      children: () => this.items,
      boxOf: (item, d) => this.#boxOf(item, d),
      drawChild: (item) => {
        this.childDraws++;
        this.#drawItem(this.canvas.g, item);
      },
    });
    this.scheduler.keep(this.#host);
    this.layout();
    this.mark("relief");
  }

  #prepare(ratio: number, regions: readonly VBox[] | null, toned: VBox[] | undefined): void {
    this.#host.prepare(ratio, regions, toned);
  }

  #sync(): ReliefIndex {
    const s = this.scene;
    const inScene = (x: number, y: number) => (s.grid.shape === "squares" ? x >= 0 && y >= 0 && x < s.w && y < s.h : hexInScene(s.grid, s, { col: x, row: y }));
    const relief = new ReliefIndex();
    relief.sync({
      sceneId: "s1",
      bounds: { w: s.w, h: s.h },
      chunks: {},
      tiles: null,
      walls: new Map(),
      global: { look: this.look },
      grid: s.grid,
      src: {
        ground: (x, y) => (inScene(x, y) ? (s.ground.get(`${x},${y}`) ?? 0) : 0),
        terrain: () => null,
        look: (x, y) => ({ texture: null, color: `rgb(${(x * 37 + this.look * 11) % 250}, ${(y * 53) % 250}, 120)` }),
        bounds: { w: s.w, h: s.h },
        grid: s.grid,
      },
    });
    return relief;
  }

  /** The cull box at the camera, in the board's steps. */
  cull(cam: Camera = this.camera): { key: string; box: VBox; view: VBox } {
    const step = RIG_STEP_PX / cam.scale;
    const tl = screenToView(cam, { x: 0, y: 0 });
    const br = screenToView(cam, { x: this.size.width, y: this.size.height });
    const box = { x0: (Math.floor(tl.x / step) - 1) * step, y0: (Math.floor(tl.y / step) - 1) * step, x1: (Math.ceil(br.x / step) + 1) * step, y1: (Math.ceil(br.y / step) + 1) * step };
    return { box, key: `${box.x0},${box.y0},${box.x1},${box.y1}`, view: { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y } };
  }

  #standeeShapes(): Map<string, Shape> {
    const out = new Map<string, Shape>();
    for (const t of this.standees) {
      const shape = standeeShape(this.turn, { x: t.x, y: t.y, w: t.size, h: t.size }, this.groundAt(t.x, t.y), this.groundAt(t.x, t.y), this.camera.scale, this.size.height);
      out.set(t.id, { art: shape.art, ring: shape.ring, frame: shape.frame, bounds: shape.bounds });
    }
    return out;
  }

  groundAt(x: number, y: number): number {
    return Math.max(0, this.scene.ground.get(`${Math.floor(x)},${Math.floor(y)}`) ?? 0);
  }

  #shapes = new Map<string, Shape>();

  /** Lays out again at the camera and turn now, as the board's render does. */
  layout(): void {
    this.#shapes = this.#standeeShapes();
    const standees: StandeeIn[] = this.standees.map((t) => {
      const shape = this.#shapes.get(t.id)!;
      return { id: t.id, x: t.x + t.size / 2, y: t.y + t.size / 2, cells: [{ col: Math.floor(t.x), row: Math.floor(t.y) }], base: this.groundAt(t.x, t.y), holder: null, bounds: shape.bounds, art: shape.art };
    });
    const cull = this.cull();
    // The board's render sets the draw context at its own camera, which a draw sets again from the stage.
    const relief = this.#relief;
    const turn = this.turn;
    Object.assign(this.#dc, { turn, camera: this.camera, view: cull.view, openings: (region: Parameters<NonNullable<DrawContext["openings"]>>[0], box: VBox, asker: object) => relief.openingsMeeting(region, turn, box, asker) });
    this.items = relief.layout(this.turn, cull.box, standees, this.areas.map((a) => this.#volume(a)));
    this.rendered = { key: cull.key, box: cull.box };
    this.pendingLayout = false;
  }

  #volume(a: RigArea): VolumePiece {
    const loop = (z: number) => Float64Array.of(a.x, a.y, z, a.x + 1, a.y, z, a.x + 1, a.y + 1, z, a.x, a.y + 1, z);
    const line = Float64Array.of(a.x, a.y, a.z1, a.x + 1, a.y, a.z1, a.x + 1, a.y + 1, a.z1);
    const none = new Float64Array(0);
    const part: BandPart = { far: [loop(a.z0)], near: [loop(a.z1)], farAt: none, nearAt: none, outline: line, hidden: none, guide: none, guideHidden: none };
    const view = isometric(this.turn);
    const box: VBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const [x, y] of [[a.x, a.y], [a.x + 1, a.y], [a.x + 1, a.y + 1], [a.x, a.y + 1]] as const) {
      for (const z of [a.z0, a.z1]) {
        const p = toView(view, { x, y }, z);
        box.x0 = Math.min(box.x0, p.x);
        box.y0 = Math.min(box.y0, p.y);
        box.x1 = Math.max(box.x1, p.x);
        box.y1 = Math.max(box.y1, p.y);
      }
    }
    const c = toView(view, { x: a.x + 0.5, y: a.y + 0.5 }, 0);
    return { kind: "volume", id: `v${a.id}:0`, area: a.id, band: 0, key: c.y, draws: [{ band: 0, high: part, low: part, box }], bounds: box, look: { color: "#3fa7ff", dm: false, selected: a.selected, preview: false }, pits: NO_AREA_PITS };
  }

  #boxOf(item: Item, d: DrawContext): VBox | null {
    if (item.kind === "run") return runPaintedBox(item.pieces, d);
    const shape = this.#shapes.get(item.id);
    return shape ? standeePaintedBox(shape, d) : null;
  }

  #drawItem(g: CanvasRenderingContext2D, item: Item): void {
    if (item.kind === "run") return drawRun(g, item.pieces as DrawPiece[], this.#dc);
    const t = this.standees.find((s) => s.id === item.id)!;
    const shape = this.#shapes.get(item.id)!;
    const k = this.ratio * this.camera.scale;
    g.save();
    g.setTransform(k, 0, 0, k, this.ratio * this.camera.x, this.ratio * this.camera.y);
    g.fillStyle = `standee ${t.id} ${t.look} ${this.look}`;
    g.beginPath();
    g.rect(shape.art.x0, shape.art.y0, shape.art.x1 - shape.art.x0, shape.art.y1 - shape.art.y0);
    g.fill();
    // Its ring, 2 px wide, inside its bounds.
    g.strokeStyle = `ring ${t.id}`;
    g.lineWidth = 2 / this.camera.scale;
    g.beginPath();
    const r = shape.ring;
    g.ellipse((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2, 0, 0, Math.PI * 2);
    g.stroke();
    // Its name plate, low in its decor's reach, as a label under it draws.
    const b = shape.bounds;
    g.fillStyle = `plate ${t.id} ${t.look}`;
    g.beginPath();
    g.rect((b.x0 + r.x0) / 2, (r.y1 + b.y1) / 2, (r.x1 - r.x0) * 1.5, (b.y1 - r.y1) / 3);
    g.fill();
    g.restore();
  }

  /** Marks a layer outside the camera's move: content. */
  mark(which: "ground" | "relief"): void {
    this.scheduler.mark(which);
  }

  /** Moves the camera by CSS pixels, through the scheduler's camera move, and answers how it stands to the rendered layout. */
  pan(dx: number, dy: number): "inside" | "step" | "out" {
    const next = onDeviceGrid({ x: this.camera.x + dx, y: this.camera.y + dy, scale: this.camera.scale }, this.ratio);
    this.scheduler.moveCamera(() => {
      this.camera = next;
      this.scheduler.mark("ground");
      this.scheduler.mark("relief");
    });
    const now = this.cull();
    if (now.key === this.rendered.key) return "inside";
    const v = now.view;
    const b = this.rendered.box;
    return v.x0 >= b.x0 && v.y0 >= b.y0 && v.x1 <= b.x1 && v.y1 <= b.y1 ? "step" : "out";
  }

  /** The board's render commits: the layout again, and react-konva's marks on the relief. */
  commit(): void {
    this.layout();
    this.mark("relief");
  }

  /** Runs the waiting frame. */
  frame(): void {
    for (const run of this.#queue.splice(0)) run(0);
  }

  /** The same state drawn whole on a fresh canvas. */
  whole(): TestCanvas {
    const c = new TestCanvas(this.canvas.width, this.canvas.height);
    this.#prepare(this.ratio, null, undefined);
    for (const item of this.items) this.#drawItem(c.g, item);
    return c;
  }

  /** The toned cells' boxes at the camera now. */
  tonedNow(): VBox[] {
    this.#prepare(this.ratio, null, undefined);
    return this.#host.tonedNow();
  }

  /** The layout's runs drawn into a canvas with a scroll's regions, as the scroll path draws them. */
  drawRuns(c: TestCanvas, regions: readonly VBox[]): void {
    this.#prepare(this.ratio, regions, undefined);
    for (const item of this.items) if (item.kind === "run") drawRun(c.g, item.pieces as DrawPiece[], this.#dc);
  }

  /** The relief layer's drawScene into another canvas, as `toDataURL` calls it. */
  drawInto(c: TestCanvas): void {
    this.#reliefLayer.drawScene({ g: c.g, getPixelRatio: () => this.ratio });
  }

  /** The whole draw's paints at one pixel, for a failure's story. */
  wholeTraced(at: number): string[] {
    const c = new TestCanvas(this.canvas.width, this.canvas.height);
    c.trace = { at, log: [] };
    this.#prepare(this.ratio, null, undefined);
    for (const item of this.items) this.#drawItem(c.g, item);
    return c.trace.log;
  }

  /** The scene's ground changed: the relief syncs again. */
  resync(): void {
    this.#relief = this.#sync();
  }
}

