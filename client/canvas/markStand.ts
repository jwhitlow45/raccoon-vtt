import { FOG_SUBCELLS } from "#shared/model.ts";
import { pillReach, type PillProps } from "../features/measure/pillPlace.ts";
import { liftInPlane } from "./isoPlace.ts";
import type { IsoGround } from "./relief/context.ts";
import type { CellBox, FogView } from "./relief/fogView.ts";
import { boxStands, lineStands, strokeSubcells } from "./relief/stand.ts";
import { cellPolygon, cellsMeeting } from "../lib/groundCells.ts";

/**
 * The stand rule (docs/design-v1-isometric-view.md 5.2, D-261026-5) for the
 * board's marks that Top-down draws under the fog: an area's or a trap's
 * pill and badge, a text drawing, and a moving tether or aura. A player
 * never sees more in Isometric than Top-down shows, so each stands only
 * where every fog sub-cell under its Top-down box is revealed to that
 * viewer, and otherwise lies flat on the ground stage under the fog. What
 * moves with a dragged token cannot lie under the fog, so it draws clipped
 * to the revealed sub-cells instead (5.1), which shows nothing over a
 * fogged one. Everything on the DM's device, or on a scene without fog,
 * stands (`FogView.all`).
 */

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Whether a pill stands: by the box Top-down draws it in at this zoom,
 * anywhere its slide along the screen's edge can put it (pillPlace.ts
 * pillReach), its outline included. A pointed pill slides only along its
 * edge, which its reach spans. A plain pill can slide anywhere the screen's edge pushes it, so
 * it never stands over a player's fog: it fails closed.
 */
export function pillStands(fog: FogView, pill: Omit<PillProps, "color">): boolean {
  if (fog.all) return true;
  if (!pill.above && !pill.below) return false;
  // Its outline, 1.5 px wide, is centered on the box's edge.
  const edge = 1 / pill.scale;
  const r = pillReach(pill);
  return boxStands(fog, { x0: r.x0 - edge, y0: r.y0 - edge, x1: r.x1 + edge, y1: r.y1 + edge });
}

/** Whether a box in cells stands: a badge's, a text drawing's. */
export function markStands(fog: FogView, box: CellBox): boolean {
  return boxStands(fog, box);
}

/** How a moving line shows: whole, or only inside the revealed sub-cells it crosses, each a rectangle in cells. */
export type LineShow = { whole: true } | { whole: false; clip: Rect[] };

/**
 * How a tether moving with a dragged token shows (5.1): whole when every
 * sub-cell its stroke can paint is revealed, its half width `r` in cells
 * and its round caps included (stand.ts lineStands), else clipped to the
 * revealed ones among them, so it draws nothing over a fogged sub-cell.
 */
export function tetherShows(fog: FogView, a: { x: number; y: number }, b: { x: number; y: number }, r: number): LineShow {
  if (lineStands(fog, a, b, r)) return { whole: true };
  const clip: Rect[] = [];
  const k = 1 / FOG_SUBCELLS;
  strokeSubcells(a, b, r, (sx, sy) => {
    if (fog.revealed(sx, sy)) clip.push({ x: sx * k, y: sy * k, w: k, h: k });
    return true;
  });
  return { whole: false, clip };
}

/**
 * The revealed sub-cells of an aura's box, as rectangles in cells: where an
 * area moving with a dragged token shows (5.1). Null when it shows whole:
 * a viewer who sees all the ground, or a box with every sub-cell revealed.
 */
export function auraClip(fog: FogView, box: CellBox): Rect[] | null {
  if (fog.all || fog.boxClear(box)) return null;
  return fog.revealedRects(box);
}

/**
 * A part of a mark as the ground stage lays it: the mark, in cells, drawn
 * inside `clip` (whole when null), or on hexes inside `polys`, and lifted
 * by `lift`, in the ground plane's units.
 */
export type GroundPiece = { lift: { x: number; y: number }; clip: Rect[] | null; polys?: { x: number; y: number }[][] };

/**
 * How a mark moving in the drag layer lies on the drawn ground, as the
 * ground stage would lay it (a stroke being drawn): the cells its box
 * touches, grouped by drawn ground, each group the mark clipped to those
 * cells and lifted by their ground, so every part of it draws at its own
 * cell's height. For a player only the revealed sub-cells count: it draws
 * nothing over a fogged sub-cell, and no fogged part of it lands on a
 * revealed top, since each part is cut from the mark where it lies before
 * it is lifted (ISO34-ASTRA-10). One piece, whole, when the box lies on one
 * ground with every sub-cell of it revealed.
 */
export function groundPieces(iso: Pick<IsoGround, "fog" | "turn" | "ground" | "surface">, box: CellBox): GroundPiece[] {
  if (iso.surface) return hexGroundPieces(iso, iso.surface, box);
  const { fog } = iso;
  const cellAt = (x: number, y: number) => iso.ground(x + 0.5, y + 0.5);
  const clear = fog.boxClear(box);
  const cx0 = Math.floor(box.x0);
  const cy0 = Math.floor(box.y0);
  const cx1 = Math.max(cx0 + 1, Math.ceil(box.x1));
  const cy1 = Math.max(cy0 + 1, Math.ceil(box.y1));
  if (clear) {
    const first = cellAt(cx0, cy0);
    let flat = true;
    for (let y = cy0; flat && y < cy1; y++) for (let x = cx0; flat && x < cx1; x++) flat = cellAt(x, y) === first;
    if (flat) return [{ lift: liftInPlane(iso.turn, first), clip: null }];
  }
  // Each row of the box's cells where all of it shows, else each row's run of revealed sub-cells.
  const rows: Rect[] = [];
  if (clear) for (let y = cy0; y < cy1; y++) rows.push({ x: box.x0, y: Math.max(y, box.y0), w: box.x1 - box.x0, h: Math.min(y + 1, box.y1) - Math.max(y, box.y0) });
  else rows.push(...fog.revealedRects(box));
  const byGround = new Map<number, Rect[]>();
  for (const r of rows) {
    const cy = Math.floor(r.y);
    const end = r.x + r.w;
    let a = r.x;
    while (a < end) {
      const g = cellAt(Math.floor(a), cy);
      let b = Math.min(end, Math.floor(a) + 1);
      while (b < end && cellAt(b, cy) === g) b = Math.min(end, b + 1);
      let list = byGround.get(g);
      if (!list) byGround.set(g, (list = []));
      list.push({ x: a, y: r.y, w: b - a, h: r.h });
      a = b;
    }
  }
  return [...byGround].map(([g, clip]) => ({ lift: liftInPlane(iso.turn, g), clip }));
}

/**
 * `groundPieces` on hexes (docs/design-v1-iso-hex-relief.md 7): the box cut
 * by the canonical hex polygons it meets, each part then cut to the
 * revealed sub-cells (for a viewer who sees it all, the box), and the parts
 * grouped by their hex's drawn ground and lifted by it. A square cell's
 * center or a quarter-cell's middle would lift a part by a neighbor's
 * ground across a slanted side.
 */
function hexGroundPieces(iso: Pick<IsoGround, "fog" | "turn">, surface: NonNullable<IsoGround["surface"]>, box: CellBox): GroundPiece[] {
  const { fog } = iso;
  const clear = fog.boxClear(box);
  const byGround = new Map<number, { x: number; y: number }[][]>();
  for (const c of cellsMeeting(surface.grid, box, null)) {
    const poly = cellPolygon(surface.grid, c);
    // The hex's share of the box, and the fog asked about that alone, so a long stroke over patchy fog costs each hex its own few sub-cells.
    const hb = cutBox({ x0: Math.min(...poly.map((p) => p.x)), y0: Math.min(...poly.map((p) => p.y)), x1: Math.max(...poly.map((p) => p.x)), y1: Math.max(...poly.map((p) => p.y)) }, box);
    if (!hb) continue;
    // The revealed sub-cells come whole: each is cut to the hex's share, so no part reaches past what the mark can paint.
    const shown: Rect[] =
      clear || fog.boxClear(hb)
        ? [{ x: hb.x0, y: hb.y0, w: hb.x1 - hb.x0, h: hb.y1 - hb.y0 }]
        : fog.revealedRects(hb).flatMap((r) => {
            const cut = cutBox({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }, hb);
            return cut ? [{ x: cut.x0, y: cut.y0, w: cut.x1 - cut.x0, h: cut.y1 - cut.y0 }] : [];
          });
    const g = surface.atCell(c);
    for (const r of shown) {
      const part = clipToRect(poly, r);
      // A hex that only touches the box, or a fog rectangle, leaves a part with no area.
      if (part.length < 3 || Math.abs(areaOf(part)) < 1e-12) continue;
      let list = byGround.get(g);
      if (!list) byGround.set(g, (list = []));
      list.push(part);
    }
  }
  if (clear && byGround.size === 1) return [{ lift: liftInPlane(iso.turn, [...byGround.keys()][0]!), clip: null }];
  return [...byGround].map(([g, polys]) => ({ lift: liftInPlane(iso.turn, g), clip: null, polys }));
}

/** Where two boxes overlap, or null where they only touch or miss. */
function cutBox(a: CellBox, b: CellBox): CellBox | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** A convex polygon cut to a rectangle, side by side (Sutherland and Hodgman): empty when they do not meet. */
function clipToRect(poly: readonly { x: number; y: number }[], r: Rect): { x: number; y: number }[] {
  let pts: { x: number; y: number }[] = [...poly];
  const edges: [(p: { x: number; y: number }) => number, "x" | "y", number][] = [
    [(p) => p.x - r.x, "x", r.x],
    [(p) => r.x + r.w - p.x, "x", r.x + r.w],
    [(p) => p.y - r.y, "y", r.y],
    [(p) => r.y + r.h - p.y, "y", r.y + r.h],
  ];
  for (const [inside, axis, at] of edges) {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      const dp = inside(p);
      const dq = inside(q);
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq);
        const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
        // Exactly on the rectangle's side, so two parts meet along it without a hair between.
        m[axis] = at;
        out.push(m);
      }
    }
    pts = out;
    if (pts.length === 0) return pts;
  }
  return pts;
}

/** A polygon's signed area. */
function areaOf(poly: readonly { x: number; y: number }[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
