import { FOG_SUBCELLS, type WallFeature } from "#shared/model.ts";
import type { WallSet } from "#shared/rules/walls.ts";
import type { FogView } from "./fogView.ts";

/**
 * Standing walls (docs/design-v1-isometric-view.md 5.5). The pieces are the
 * derived set's walls, doors and windows (shared/rules/walls.ts
 * deriveWalls), so automatic walls stand and "no wall" marks do not, and
 * its raised edges and pillars are not walls. Free walls are split where
 * they cross, keeping their features.
 *
 * Each segment is cut at sub-cell lines into quarter-cell runs. For a
 * player, a run stands only where a fog sub-cell beside it, on either side,
 * is revealed, since Top-down shows that half of the line there. A free
 * wall's run inside one sub-cell stands by that sub-cell. A run that does
 * not stand has fog on both sides, where Top-down's line lies under opaque
 * fog, so it is drawn nowhere. Neighboring standing runs of one segment
 * merge within each cell.
 */

/** How a piece stands: a wall in stone, a closed door's leaf in wood, a window's pane. An open door lies flat on the ground. */
export type WallKind = "wall" | "door" | "window";

export type WallPiece = {
  /** Stable across rebuilds: the segment and where along it the piece starts. */
  id: string;
  kind: WallKind;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** The cell that holds the piece's midpoint, its bucket's. */
  cx: number;
  cy: number;
  /** The cells either side of a grid edge, whose higher ground the piece stands on. Null for a free wall, which stands on its own cell's. */
  beside: readonly [number, number, number, number] | null;
};

/** What stands for a feature, or null for one that lies flat. A secret door not yet found stands as the wall the players got. */
export function wallKind(f: WallFeature): WallKind | null {
  if (f.kind === "wall" || f.kind === "window") return f.kind;
  if (f.secret && !f.discovered) return "wall";
  return f.state === "open" ? null : "door";
}

type Segment = { id: string; kind: WallKind; ax: number; ay: number; bx: number; by: number; grid: boolean; cuts: number[] };

const EPS = 1e-9;

/** Every standing wall piece of a scene for this viewer. */
export function wallPieces(walls: WallSet, fog: FogView): WallPiece[] {
  const segments: Segment[] = [];
  for (const e of walls.edges) {
    const kind = wallKind(e.feature);
    if (!kind) continue;
    const bx = e.side === "n" ? e.x + 1 : e.x;
    const by = e.side === "n" ? e.y : e.y + 1;
    segments.push({ id: `e${e.x},${e.y}${e.side}`, kind, ax: e.x, ay: e.y, bx, by, grid: true, cuts: [] });
  }
  const free: Segment[] = [];
  for (const ref of walls.free) {
    const kind = wallKind(ref.wall.f);
    if (!kind) continue;
    const [ax, ay] = ref.wall.a;
    const [bx, by] = ref.wall.b;
    if (Math.abs(ax - bx) < EPS && Math.abs(ay - by) < EPS) continue;
    free.push({ id: `f${ref.cx},${ref.cy}:${ref.wall.id}`, kind, ax, ay, bx, by, grid: false, cuts: [] });
  }
  splitCrossings(free);
  segments.push(...free);
  const out: WallPiece[] = [];
  for (const s of segments) piecesOf(s, fog, out);
  return out;
}

/**
 * Adds a cut to each pair of free walls where they cross or one ends on
 * the other, so no two pieces cross. Only walls whose boxes share a cell
 * are compared, and free walls are at most 8 cells long, so each meets few.
 */
function splitCrossings(free: Segment[]): void {
  const byCell = new Map<string, number[]>();
  free.forEach((s, i) => {
    for (let y = Math.floor(Math.min(s.ay, s.by)); y <= Math.floor(Math.max(s.ay, s.by)); y++) {
      for (let x = Math.floor(Math.min(s.ax, s.bx)); x <= Math.floor(Math.max(s.ax, s.bx)); x++) {
        const key = `${x},${y}`;
        const list = byCell.get(key);
        if (list) list.push(i);
        else byCell.set(key, [i]);
      }
    }
  });
  const done = new Set<number>();
  for (const list of byCell.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p]!;
        const j = list[q]!;
        const pair = i * free.length + j;
        if (done.has(pair)) continue;
        done.add(pair);
        const hit = crossing(free[i]!, free[j]!);
        if (!hit) continue;
        free[i]!.cuts.push(hit[0]);
        free[j]!.cuts.push(hit[1]);
      }
    }
  }
}

/** Where two segments meet, as the parameter along each, or null when they do not meet or run along each other. */
function crossing(s: Segment, t: Segment): [number, number] | null {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const ex = t.bx - t.ax;
  const ey = t.by - t.ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < EPS) return null;
  const u = ((t.ax - s.ax) * ey - (t.ay - s.ay) * ex) / den;
  const v = ((t.ax - s.ax) * dy - (t.ay - s.ay) * dx) / den;
  if (u < -EPS || u > 1 + EPS || v < -EPS || v > 1 + EPS) return null;
  return [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))];
}

/** The parameters where a segment crosses a sub-cell line on either axis, with its ends and its crossings. */
function cutsOf(s: Segment): number[] {
  const ts = [0, 1, ...s.cuts];
  const axis = (a: number, b: number) => {
    if (Math.abs(b - a) < EPS) return;
    const lo = Math.min(a, b) * FOG_SUBCELLS;
    const hi = Math.max(a, b) * FOG_SUBCELLS;
    for (let k = Math.floor(lo) + 1; k < hi - EPS; k++) if (k > lo + EPS) ts.push((k / FOG_SUBCELLS - a) / (b - a));
  };
  axis(s.ax, s.bx);
  axis(s.ay, s.by);
  ts.sort((p, q) => p - q);
  const out: number[] = [];
  for (const t of ts) if (out.length === 0 || t - out[out.length - 1]! > EPS) out.push(t);
  return out;
}

/**
 * Whether one run stands: on a sub-cell line, when the sub-cell either side
 * of it is revealed, and otherwise when the sub-cell it lies in is.
 */
function runStands(fog: FogView, x0: number, y0: number, x1: number, y1: number): boolean {
  if (fog.all) return true;
  const mx = ((x0 + x1) / 2) * FOG_SUBCELLS;
  const my = ((y0 + y1) / 2) * FOG_SUBCELLS;
  const onLine = (v: number) => Math.abs(v - Math.round(v)) < EPS;
  if (Math.abs(x1 - x0) < EPS && onLine(x0 * FOG_SUBCELLS)) {
    const sx = Math.round(x0 * FOG_SUBCELLS);
    const sy = Math.floor(my);
    return fog.revealed(sx - 1, sy) || fog.revealed(sx, sy);
  }
  if (Math.abs(y1 - y0) < EPS && onLine(y0 * FOG_SUBCELLS)) {
    const sy = Math.round(y0 * FOG_SUBCELLS);
    const sx = Math.floor(mx);
    return fog.revealed(sx, sy - 1) || fog.revealed(sx, sy);
  }
  return fog.revealed(Math.floor(mx), Math.floor(my));
}

function piecesOf(s: Segment, fog: FogView, out: WallPiece[]): void {
  const ts = cutsOf(s);
  const at = (t: number) => ({ x: s.ax + (s.bx - s.ax) * t, y: s.ay + (s.by - s.ay) * t });
  // The open piece: where it starts and the cell it is in.
  let start = -1;
  let cell = "";
  const close = (endT: number) => {
    if (start < 0) return;
    const a = at(ts[start]!);
    const b = at(endT);
    const cx = Math.floor((a.x + b.x) / 2);
    const cy = Math.floor((a.y + b.y) / 2);
    out.push({
      id: `${s.id}@${start}`,
      kind: s.kind,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      cx,
      cy,
      beside: s.grid ? (s.ay === s.by ? [cx, s.ay - 1, cx, s.ay] : [s.ax - 1, cy, s.ax, cy]) : null,
    });
    start = -1;
  };
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = at(ts[i]!);
    const b = at(ts[i + 1]!);
    // A grid edge is one cell's side, so its runs share a cell, and a free wall's run is in the cell that holds its midpoint.
    const runCell = s.grid ? "" : `${Math.floor((a.x + b.x) / 2)},${Math.floor((a.y + b.y) / 2)}`;
    const stands = runStands(fog, a.x, a.y, b.x, b.y);
    // Where another free wall crosses, the piece ends, so the split survives the merge.
    const crossed = s.cuts.some((t) => Math.abs(t - ts[i]!) <= EPS);
    if (start >= 0 && (!stands || runCell !== cell || crossed)) close(ts[i]!);
    if (stands && start < 0) {
      start = i;
      cell = runCell;
    }
  }
  close(ts[ts.length - 1]!);
}
