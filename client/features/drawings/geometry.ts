import type { Drawing, DrawingKind } from "#shared/model.ts";
import { MAX_DRAWING_POINTS } from "#shared/protocol.ts";
import { distToSegment } from "#shared/rules/geom.ts";

/**
 * Drawing geometry (design section 6, `Drawing`): simplifying freehand
 * strokes before they are sent, the sizes a style stands for, and hit
 * testing for the eraser. No React or Konva, so it is tested under Node.
 *
 * Points are flat `[x0, y0, x1, y1, ...]` in cells. Line, arrow, rectangle
 * and ellipse store two corners. A polygon stores its vertices, a freehand
 * stroke its simplified points, and text its anchor (top-left).
 *
 * `style.width` is in twentieths of a cell, so drawings scale with the map
 * like everything else on it. Text uses the same number for its size: a
 * text's height in cells is `width / 5`.
 */

export type Pt = { x: number; y: number };

export function strokeCells(width: number): number {
  return Math.max(0, width) / 20;
}

export function textCells(width: number): number {
  return Math.max(1, width) / 5;
}

/**
 * Douglas-Peucker on a flat point list: keeps the first and last points and
 * every point farther than `epsilon` from the simplified line. Iterative,
 * so a long stroke cannot overflow the stack.
 */
export function simplify(points: readonly number[], epsilon: number): number[] {
  const n = Math.floor(points.length / 2);
  if (n <= 2) return points.slice(0, n * 2);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const ax = points[2 * a]!;
    const ay = points[2 * a + 1]!;
    const bx = points[2 * b]!;
    const by = points[2 * b + 1]!;
    let worst = -1;
    let worstDist = epsilon;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(points[2 * i]!, points[2 * i + 1]!, ax, ay, bx, by);
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[2 * i]!, points[2 * i + 1]!);
  return out;
}

/**
 * A freehand stroke ready to send: simplified at `epsilon`, then, if it is
 * still over the protocol's 2,000 numbers, simplified again with a doubled
 * tolerance until it fits. The very last resort keeps every k-th point, which
 * no ordinary stroke ever reaches.
 */
export function simplifyStroke(points: readonly number[], epsilon: number, maxValues: number = MAX_DRAWING_POINTS): number[] {
  let eps = epsilon;
  let out = simplify(points, eps);
  for (let i = 0; i < 24 && out.length > maxValues; i++) {
    eps *= 2;
    out = simplify(points, eps);
  }
  if (out.length <= maxValues) return out;
  const n = out.length / 2;
  const step = Math.ceil(n / (maxValues / 2 - 1));
  const thinned: number[] = [];
  for (let i = 0; i < n - 1; i += step) thinned.push(out[2 * i]!, out[2 * i + 1]!);
  thinned.push(out[out.length - 2]!, out[out.length - 1]!);
  return thinned;
}

/** Shapes that close and can take a fill. */
export function fillable(kind: DrawingKind): boolean {
  return kind === "rect" || kind === "ellipse" || kind === "polygon";
}

export function bounds(points: readonly number[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    x0 = Math.min(x0, points[i]!);
    x1 = Math.max(x1, points[i]!);
    y0 = Math.min(y0, points[i + 1]!);
    y1 = Math.max(y1, points[i + 1]!);
  }
  return { x0, y0, x1, y1 };
}

function polylineDistance(points: readonly number[], p: Pt, closed: boolean): number {
  const n = Math.floor(points.length / 2);
  if (n === 1) return Math.hypot(p.x - points[0]!, p.y - points[1]!);
  let best = Infinity;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    best = Math.min(best, distToSegment(p.x, p.y, points[2 * i]!, points[2 * i + 1]!, points[2 * j]!, points[2 * j + 1]!));
  }
  return best;
}

function insidePolygon(points: readonly number[], p: Pt): boolean {
  const n = Math.floor(points.length / 2);
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[2 * i]!;
    const yi = points[2 * i + 1]!;
    const xj = points[2 * j]!;
    const yj = points[2 * j + 1]!;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A line's width in cells at a font size in cells, as the map draws it:
 * measured by the browser where it can, else from `estimateEm`.
 */
export type TextMeasure = (line: string, fontSize: number) => number;

/**
 * A line's width in ems of a bold sans-serif, a tenth generous, for when
 * nothing can measure it: wide letters (W, M, m), capitals, narrow ones
 * (i, l, punctuation) and spaces each get their own width, because "WWW"
 * is three times as wide as "iii" and a flat width per character missed
 * the end of wide words.
 */
export function estimateEm(line: string): number {
  let em = 0;
  for (const ch of line) {
    if (/[WMmw@%]/.test(ch)) em += 1;
    else if (/[iljtfrI!.,:;'|]/.test(ch)) em += 0.34;
    else if (ch === " ") em += 0.3;
    else if (/[A-Z0-9]/.test(ch)) em += 0.74;
    else if (/[a-z]/.test(ch)) em += 0.62;
    else em += 1;
  }
  return em * 1.1;
}

const estimate: TextMeasure = (line, fontSize) => estimateEm(line) * fontSize;

/**
 * The box a text drawing covers: one line per newline, each the font size
 * tall (Konva's default line height), as wide as its longest line. The
 * height keeps a fifth of slack for descenders.
 */
export function textBox(d: Pick<Drawing, "points" | "text" | "style">, measure: TextMeasure = estimate): { x: number; y: number; w: number; h: number } {
  const h = textCells(d.style.width);
  const lines = (d.text ?? "").split("\n");
  const widest = Math.max(0.6 * h, ...lines.map((l) => measure(l, h)));
  return { x: d.points[0] ?? 0, y: d.points[1] ?? 0, w: widest, h: h * lines.length * 1.2 };
}

/**
 * Whether a point (cells) touches a drawing, within `tolerance` cells of
 * its stroke. A filled shape counts anywhere inside it.
 */
export function hitDrawing(d: Pick<Drawing, "kind" | "points" | "style" | "text">, p: Pt, tolerance: number, measure?: TextMeasure): boolean {
  const reach = tolerance + strokeCells(d.style.width) / 2;
  const pts = d.points;
  switch (d.kind) {
    case "free":
    case "line":
    case "arrow":
      return polylineDistance(pts, p, false) <= reach;
    case "polygon":
      return polylineDistance(pts, p, true) <= reach || (!!d.style.fill && insidePolygon(pts, p));
    case "rect": {
      const b = bounds(pts);
      const corners = [b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1];
      return polylineDistance(corners, p, true) <= reach || (!!d.style.fill && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
    }
    case "ellipse": {
      const b = bounds(pts);
      const rx = (b.x1 - b.x0) / 2;
      const ry = (b.y1 - b.y0) / 2;
      const cx = b.x0 + rx;
      const cy = b.y0 + ry;
      if (rx <= 0 || ry <= 0) return polylineDistance(pts, p, false) <= reach;
      const k = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      // Distance to the outline, close enough for a fingertip: the radial gap scaled by the nearer radius.
      if (Math.abs(k - 1) * Math.min(rx, ry) <= reach) return true;
      return !!d.style.fill && k <= 1;
    }
    case "text": {
      const box = textBox(d, measure);
      return p.x >= box.x - tolerance && p.x <= box.x + box.w + tolerance && p.y >= box.y - tolerance && p.y <= box.y + box.h + tolerance;
    }
    case "ruler":
      // A kept ruler belongs to the ruler tool, which removes it from its own list.
      return false;
  }
}

/** The topmost drawing under a point among those `can` allows, or null. Later drawings draw on top. */
export function drawingAt<D extends Pick<Drawing, "id" | "kind" | "points" | "style" | "text">>(
  drawings: readonly D[],
  p: Pt,
  tolerance: number,
  can: (d: D) => boolean,
  measure?: TextMeasure,
): D | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i]!;
    if (can(d) && hitDrawing(d, p, tolerance, measure)) return d;
  }
  return null;
}

/**
 * What an eraser stroke touches: the topmost drawing it may erase, or else
 * the topmost one it may not (another player's), so the tool can say why
 * nothing went. Drawings already erased in this stroke are passed over.
 */
export function eraseTarget<D extends Pick<Drawing, "id" | "kind" | "points" | "style" | "text">>(
  drawings: readonly D[],
  p: Pt,
  tolerance: number,
  mayErase: (d: D) => boolean,
  erased: ReadonlySet<string>,
  measure?: TextMeasure,
): { erase: D } | { refused: D } | null {
  const erase = drawingAt(drawings, p, tolerance, (d) => mayErase(d) && !erased.has(d.id), measure);
  if (erase) return { erase };
  const refused = drawingAt(drawings, p, tolerance, (d) => !mayErase(d), measure);
  return refused ? { refused } : null;
}

/** An 8-digit hex fill from a stroke color: the same hue, translucent, so a filled shape keeps the map visible. */
export function fillFor(stroke: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(stroke) ? `${stroke}55` : stroke;
}
