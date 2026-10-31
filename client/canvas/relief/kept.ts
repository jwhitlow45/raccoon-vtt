import { screenToView, type Camera, type Size } from "../../lib/camera.ts";
import { meets, type Item } from "./buckets.ts";
import { tonedBoxes, type DrawContext } from "./drawRelief.ts";
import type { VBox } from "./pieces.ts";
import type { KeptHost, KeptLayer } from "./scheduler.ts";

/**
 * The kept relief picture (docs/design-v1-relief-pan.md 5): the relief
 * layer's own canvas keeps its pixels between draws. A draw whose only
 * marks came from the camera, at the same scale, turn, canvas size, pixel
 * ratio and stage key, copies the canvas onto itself by the move in whole
 * device pixels and paints only what the move uncovers, plus the cells
 * whose ground copy can change (5.3). Anything else repaints whole, as
 * every draw did before.
 */

/** What the relief's pixels were drawn at: the stage's camera on the device grid, and everything else a copy needs to match. */
export type KeptAt = {
  x: number;
  y: number;
  scale: number;
  turn: number;
  /** The canvas in device pixels. */
  width: number;
  height: number;
  ratio: number;
  /** The stage key (Stage.tsx stageKey): a remount, a new pixel ratio. */
  key: string;
};

export type DrawPlan =
  | { kind: "whole"; why: WholeWhy }
  | { kind: "scroll"; dx: number; dy: number; bands: VBox[] };

/** Why a draw repaints whole, for the tests and the bench. */
export type WholeWhy = "probe" | "first" | "content" | "view" | "off-grid" | "jump" | "repair";

/** How far a whole device pixel may be off before a move counts as off the grid: float rounding of `round(x·r)/r`, never a real fraction. */
const GRID_EPSILON = 1e-6;

/**
 * Whether the next draw scrolls, and by how much. `clean` says the relief
 * had only camera marks since it last drew and the ground drew only for
 * the camera (scheduler.ts), `scrolling` that the self-copy probe passed.
 */
export function planDraw(kept: KeptAt | null, now: KeptAt, clean: boolean, scrolling: boolean): DrawPlan {
  if (!scrolling) return { kind: "whole", why: "probe" };
  if (!kept) return { kind: "whole", why: "first" };
  if (!clean) return { kind: "whole", why: "content" };
  if (kept.scale !== now.scale || kept.turn !== now.turn || kept.width !== now.width || kept.height !== now.height || kept.ratio !== now.ratio || kept.key !== now.key) return { kind: "whole", why: "view" };
  const fx = (now.x - kept.x) * now.ratio;
  const fy = (now.y - kept.y) * now.ratio;
  const dx = Math.round(fx);
  const dy = Math.round(fy);
  if (Math.abs(fx - dx) > GRID_EPSILON || Math.abs(fy - dy) > GRID_EPSILON) return { kind: "whole", why: "off-grid" };
  if (Math.abs(dx) >= now.width || Math.abs(dy) >= now.height) return { kind: "whole", why: "jump" };
  return { kind: "scroll", dx, dy, bands: bandsOf(dx, dy, now.width, now.height) };
}

/** What a move by (dx, dy) device pixels uncovers on a canvas of w by h: a band at the side it moved from on each axis it moved on. */
export function bandsOf(dx: number, dy: number, w: number, h: number): VBox[] {
  const out: VBox[] = [];
  if (dx > 0) out.push({ x0: 0, y0: 0, x1: dx, y1: h });
  else if (dx < 0) out.push({ x0: w + dx, y0: 0, x1: w, y1: h });
  if (dy > 0) out.push({ x0: 0, y0: 0, x1: w, y1: dy });
  else if (dy < 0) out.push({ x0: 0, y0: h + dy, x1: w, y1: h });
  return out;
}

/**
 * A camera with its translation on the device grid of a canvas at pixel
 * ratio `r`: `round(x·r)/r`, so any move between two such cameras is whole
 * device pixels and a scroll copies exactly, at a ratio of 1.5 too, where a
 * whole CSS pixel is a pixel and a half (D-261030-542).
 */
export function onDeviceGrid<C extends { x: number; y: number; scale: number }>(c: C, r: number): { x: number; y: number; scale: number } {
  return { x: Math.round(c.x * r) / r, y: Math.round(c.y * r) / r, scale: c.scale };
}

/**
 * Draws, in order, the children whose painted box (`boxOf`, device pixels)
 * meets one of the regions, each region tested on its own. A child with no
 * box (null) cannot be bounded and always draws.
 */
export function drawChildrenMeeting<T>(children: readonly T[], boxOf: (child: T) => VBox | null, regions: readonly VBox[], draw: (child: T) => void): void {
  for (const child of children) {
    const box = boxOf(child);
    if (box === null || meetsAny(box, regions)) draw(child);
  }
}

/** A box moved by (dx, dy). */
export function moved(b: VBox, dx: number, dy: number): VBox {
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
}

/** A box grown out to whole device pixels and kept on a w by h canvas, or null when nothing of it is on it. */
export function onCanvas(b: VBox, w: number, h: number): VBox | null {
  const x0 = Math.max(0, Math.floor(b.x0));
  const y0 = Math.max(0, Math.floor(b.y0));
  const x1 = Math.min(w, Math.ceil(b.x1));
  const y1 = Math.min(h, Math.ceil(b.y1));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** Whether a box meets any of the regions. */
export function meetsAny(b: VBox, regions: readonly VBox[]): boolean {
  for (const r of regions) if (meets(b, r)) return true;
  return false;
}

/** Past this many repair boxes a scroll repairs whole rows instead, so its clip and its box tests stay few (review HXPERF2B-OPUS-05). */
export const MAX_REPAIR_BOXES = 32;

/** A scroll whose regions would cover more than this share of the canvas repaints whole instead, which costs no more. */
export const MAX_SCROLL_SHARE = 0.5;

/**
 * The regions a scroll repairs toned cells through: the boxes themselves
 * when they are few, else rows the canvas's width covering every box, their
 * spans joined, and one row from the first to the last when even those are
 * too many: the bands of 5.3 by another road. A row holds every pixel of
 * the boxes it covers, so the repair stays exact, only wider.
 */
export function repairRegions(boxes: readonly VBox[], width: number): VBox[] {
  if (boxes.length <= MAX_REPAIR_BOXES) return [...boxes];
  const spans = boxes.map((b) => [b.y0, b.y1] as const).sort((p, q) => p[0] - q[0]);
  const rows: VBox[] = [];
  for (const [y0, y1] of spans) {
    const last = rows.at(-1);
    if (last && y0 <= last.y1) last.y1 = Math.max(last.y1, y1);
    else rows.push({ x0: 0, y0, x1: width, y1 });
  }
  if (rows.length <= MAX_REPAIR_BOXES) return rows;
  return [{ x0: 0, y0: rows[0]!.y0, x1: width, y1: rows.at(-1)!.y1 }];
}

/** The pixels a set of boxes covers, overlaps counted once: what a scroll paints, for the bench. */
export function unionArea(boxes: readonly VBox[]): number {
  if (boxes.length === 0) return 0;
  // Coordinates are whole device pixels (onCanvas), so slabs between the distinct x edges add up exactly.
  const xs = [...new Set(boxes.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i]!;
    const b = xs[i + 1]!;
    const spans = boxes.filter((r) => r.x0 <= a && r.x1 >= b).map((r) => [r.y0, r.y1] as const).sort((p, q) => p[0] - q[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [y0, y1] of spans) {
      if (y1 <= end) continue;
      covered += y1 - Math.max(y0, end);
      end = y1;
    }
    area += covered * (b - a);
  }
  return area;
}

/**
 * The self-copy probe (D-261030-537): paints a red and a blue column, two
 * device pixels tall, copies the canvas onto itself one device pixel to the
 * right, reads three columns back and clears them. A browser that copies a
 * canvas onto itself as it should gives red then blue at columns 1 and 2.
 * "again" when it could not tell (a readback that threw), so the next draw
 * probes again.
 */
export function probeSelfCopy(g: CanvasRenderingContext2D): "ok" | "off" | "again" {
  g.save();
  try {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.clearRect(0, 0, 3, 2);
    g.fillStyle = "#ff0000";
    g.fillRect(0, 0, 1, 2);
    g.fillStyle = "#0000ff";
    g.fillRect(1, 0, 1, 2);
    g.globalCompositeOperation = "copy";
    g.drawImage(g.canvas, 1, 0);
    g.globalCompositeOperation = "source-over";
    const d = g.getImageData(0, 0, 3, 2).data;
    g.clearRect(0, 0, 3, 2);
    const at = (x: number, y: number) => {
      const i = (y * 3 + x) * 4;
      return [d[i], d[i + 1], d[i + 2], d[i + 3]].join(",");
    };
    const red = "255,0,0,255";
    const blue = "0,0,255,255";
    return at(1, 0) === red && at(1, 1) === red && at(2, 0) === blue && at(2, 1) === blue ? "ok" : "off";
  } catch {
    return "again";
  } finally {
    g.restore();
  }
}

/** What a kept picture has done, for the bench and the tests: draws by kind and the share of the canvas each scroll painted. */
export type KeptStats = {
  whole: number;
  scrolls: number;
  /** Sums over scrolls of the painted share of the canvas: the bands, the ground-edge repair, and their union. */
  bands: number;
  repair: number;
  union: number;
  /** Toned boxes carried, summed over draws. */
  toned: number;
  why: Partial<Record<WholeWhy, number>>;
};

export function emptyStats(): KeptStats {
  return { whole: 0, scrolls: 0, bands: 0, repair: 0, union: 0, toned: 0, why: {} };
}

/** The canvas a kept draw paints on: a 2D context and its size in device pixels. */
export type KeptCanvas = { g: CanvasRenderingContext2D; width: number; height: number; ratio: number };

/** What the kept picture needs from the board for one draw on its own canvas. */
export type KeptDraw = {
  /** Where it is now, read from the stage as it draws. */
  at: KeptAt;
  /** The relief and ground marks since the last draw were all the camera's (scheduler.ts). */
  clean: boolean;
  /** Draws the whole view, recording the toned cells' boxes into `toned`. */
  whole(toned: VBox[]): void;
  /** The toned cells' boxes at the camera now, from a pass of box tests over the layout. */
  tonedNow(): VBox[];
  /** Draws what meets `regions`, clipped to them already. */
  regions(regions: readonly VBox[]): void;
};

/**
 * What the self-copy probe found, kept for every relief canvas that shares
 * it. A copy onto itself is the browser's own behavior, so one answer holds
 * for the page, and a board mounted again (a stage-key remount, the round
 * trip to the map builder) skips the probe's readback, which waits on the
 * GPU (review HXPERF2B-OPUS-06). Empty until a probe answers: a 0 by 0 draw
 * or a thrown readback leaves the probe to the next draw with a size.
 */
export type ProbeMemo = { answer: "ok" | "off" | null };

/** The page's own probe answer, which every kept picture shares unless a test hands it another. */
export const PAGE_PROBE: ProbeMemo = { answer: null };

/**
 * The relief's picture as kept between draws. One per relief canvas: the
 * scheduler (scheduler.ts) makes it with the layer and drives it from the
 * layer's `drawScene`.
 */
export class KeptRelief {
  #at: KeptAt | null = null;
  #toned: VBox[] = [];
  #probe: "pending" | "ok" | "off" = "pending";
  readonly #memo: ProbeMemo;
  readonly stats: KeptStats = emptyStats();
  /**
   * Whether a scroll measures the share of the canvas it paints into
   * `stats`. Off in production and in timed bench frames: the unions cost
   * more than the scroll (review HXPERF2B-ASTRA-02). The tests and the
   * bench's untimed counts turn it on.
   */
  measure = false;
  /** The share of the canvas past which a scroll repaints whole instead (MAX_SCROLL_SHARE). */
  maxShare = MAX_SCROLL_SHARE;

  constructor(memo: ProbeMemo = PAGE_PROBE) {
    this.#memo = memo;
  }

  /** Whether scrolling is on: the probe passed. False before it has run and after a wrong read. */
  get scrolling(): boolean {
    return this.#probe === "ok";
  }

  /** The probe's state, for the tests. */
  get probe(): "pending" | "ok" | "off" {
    return this.#probe;
  }

  /** Forgets the picture: the canvas went to 0 by 0, or drew somewhere this cannot follow. */
  forget(): void {
    this.#at = null;
    this.#toned = [];
  }

  /**
   * Runs the probe when it still waits, on a canvas with room for it,
   * unless the page has its answer already. Its paint and clear spoil the
   * corner it used, so the draw after it repaints whole.
   */
  probeOn(c: KeptCanvas): void {
    if (this.#probe !== "pending" || c.width < 3 || c.height < 2) return;
    if (this.#memo.answer) {
      this.#probe = this.#memo.answer;
      return;
    }
    const read = probeSelfCopy(c.g);
    if (read !== "again") this.#probe = this.#memo.answer = read;
    this.forget();
  }

  /** One draw on the relief's own canvas: a scroll when it can, else the whole view. Returns what it did. */
  draw(c: KeptCanvas, d: KeptDraw): DrawPlan {
    if (c.width === 0 || c.height === 0) {
      this.forget();
      d.whole([]);
      return { kind: "whole", why: "first" };
    }
    this.probeOn(c);
    let plan = planDraw(this.#at, d.at, d.clean, this.scrolling);
    let scroll: { now: VBox[]; repair: VBox[]; regions: VBox[] } | null = null;
    if (plan.kind === "scroll") {
      const now = d.tonedNow();
      const boxes: VBox[] = [];
      for (const b of this.#toned) {
        const r = onCanvas(moved(b, plan.dx, plan.dy), c.width, c.height);
        if (r) boxes.push(r);
      }
      for (const b of now) {
        const r = onCanvas(b, c.width, c.height);
        if (r) boxes.push(r);
      }
      const repair = repairRegions(boxes, c.width);
      const regions = [...plan.bands, ...repair];
      // A scroll never costs more than the whole draw it stands in for. The regions are at most MAX_REPAIR_BOXES and two bands, so their union is cheap.
      if (unionArea(regions) > this.maxShare * c.width * c.height) plan = { kind: "whole", why: "repair" };
      else scroll = { now, repair, regions };
    }
    if (plan.kind === "whole") {
      const toned: VBox[] = [];
      d.whole(toned);
      this.#toned = toned;
      this.stats.whole++;
      this.stats.why[plan.why] = (this.stats.why[plan.why] ?? 0) + 1;
    } else {
      // Set whenever the plan stayed a scroll.
      const { now, repair, regions } = scroll!;
      scrollCanvas(c, plan.dx, plan.dy, regions);
      d.regions(regions);
      c.g.restore();
      this.#toned = now;
      this.stats.scrolls++;
      if (this.measure) {
        const area = c.width * c.height;
        this.stats.bands += unionArea(plan.bands) / area;
        this.stats.repair += unionArea(repair) / area;
        this.stats.union += unionArea(regions) / area;
      }
    }
    this.stats.toned += this.#toned.length;
    this.#at = d.at;
    return plan;
  }
}

/**
 * Copies the canvas onto itself by (dx, dy) and clears the regions, leaving
 * the context clipped to them in Konva's own transform (device pixels per
 * CSS pixel), saved once: the caller draws, then restores.
 */
function scrollCanvas(c: KeptCanvas, dx: number, dy: number, regions: readonly VBox[]): void {
  const g = c.g;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = "copy";
  g.drawImage(g.canvas, dx, dy);
  g.globalCompositeOperation = "source-over";
  g.beginPath();
  for (const r of regions) g.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
  g.clip();
  g.clearRect(0, 0, c.width, c.height);
  g.setTransform(c.ratio, 0, 0, c.ratio, 0, 0);
}

/** What the board gives its kept picture (IsoBoard.tsx, and the tests' rig): its stage's camera, its draw context, its layout and the relief root's children. */
export type KeptBoard<T> = {
  layer: KeptLayer;
  /** The main stage's camera, as it draws. */
  camera(): Camera;
  /** The canvas in CSS pixels. */
  size(): Size;
  turn(): number;
  key(): string;
  groundVersion(): number;
  dc(): DrawContext | null;
  items(): readonly Item[];
  children(): readonly T[];
  /** A child's painted bounds in device pixels, or null when it cannot be bounded. */
  boxOf(child: T, dc: DrawContext): VBox | null;
  drawChild(child: T, canvas: unknown): void;
};

/**
 * The board's side of the kept picture (scheduler.ts KeptHost). Every
 * camera-derived field of the draw context is set from the stage as it
 * draws, on the whole path too, so a whole repaint between renders culls by
 * the view on screen (docs/design-v1-relief-pan.md 5.2).
 */
export function keptHost<T>(b: KeptBoard<T>): KeptHost {
  return {
    layer: b.layer,
    at: (c) => ({ ...b.camera(), turn: b.turn(), width: c.width, height: c.height, ratio: c.ratio, key: b.key() }),
    groundVersion: () => b.groundVersion(),
    prepare: (ratio, regions, toned) => {
      const d = b.dc();
      if (!d) return;
      d.camera = b.camera();
      d.pixelRatio = ratio;
      d.view = screenBox(d.camera, b.size());
      d.regions = regions;
      d.toned = toned;
    },
    tonedNow: () => {
      const out: VBox[] = [];
      const d = b.dc();
      if (d) for (const item of b.items()) if (item.kind === "run") tonedBoxes(item.pieces, d, out);
      return out;
    },
    drawChildren: (canvas, regions) => {
      const d = b.dc();
      if (d) drawChildrenMeeting(b.children(), (child) => b.boxOf(child, d), regions, (child) => b.drawChild(child, canvas));
    },
  };
}

/** The canvas's view box in view units at a camera. */
export function screenBox(camera: Camera, size: Size): VBox {
  const a = screenToView(camera, { x: 0, y: 0 });
  const z = screenToView(camera, { x: size.width, y: size.height });
  return { x0: a.x, y0: a.y, x1: z.x, y1: z.y };
}
