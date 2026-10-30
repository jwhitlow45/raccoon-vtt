import { CHUNK_CELLS, FOG_SUBCELLS, type BuildChunk, type WallFeature } from "#shared/model.ts";
import { isHex, SQUARES, type Grid } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import type { WallSet } from "#shared/rules/walls.ts";
import type { Point } from "../../lib/camera.ts";
import { cellAtPoint, cellCenter, cellPolygon, cellsMeeting, neighborsOf, polygonSide, type GroundCell } from "../../lib/groundCells.ts";
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
 *
 * On hexes every wall is also cut at each canonical hex side it crosses,
 * the scene's or the lattice's past its edge, so each run lies in one hex
 * or along one side, and stands on that hex's ground
 * (docs/design-v1-iso-hex-relief.md 6.1). A run past the scene's last
 * whole hexes has an off-scene host whose ground is 0.
 */

/**
 * How a piece stands: a wall in stone, a closed door's leaf in wood, a
 * window's pane, a pillar's stone drum (pillarPieces). An open door lies
 * flat on the ground.
 */
export type WallKind = "wall" | "door" | "window" | "pillar";

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
  /** An automatic wall nobody drew (WallEdge.auto), which stands level with the room's other walls beside raised ground (pieces.ts wallItems). */
  auto: boolean;
  /**
   * On hexes, the hex the run lies in, or the two either side of the side
   * it runs along, the owner first by the lattice's tie order: its bucket
   * is the owner's whatever the turn, and it sorts with the nearer host.
   */
  hosts?: readonly { cell: GroundCell; center: Point }[];
};

/** What stands for a feature, or null for one that lies flat. A secret door not yet found stands as the wall the players got. */
export function wallKind(f: WallFeature): WallKind | null {
  if (f.kind === "wall" || f.kind === "window") return f.kind;
  if (f.secret && !f.discovered) return "wall";
  return f.state === "open" ? null : "door";
}

type Segment = { id: string; kind: WallKind; ax: number; ay: number; bx: number; by: number; grid: boolean; auto: boolean; cuts: number[] };

const EPS = 1e-9;

/** Every standing wall piece of a scene for this viewer. */
export function wallPieces(walls: WallSet, fog: FogView, grid: Grid = SQUARES): WallPiece[] {
  const segments: Segment[] = [];
  for (const e of walls.edges) {
    const kind = wallKind(e.feature);
    if (!kind) continue;
    const bx = e.side === "n" ? e.x + 1 : e.x;
    const by = e.side === "n" ? e.y : e.y + 1;
    segments.push({ id: `e${e.x},${e.y}${e.side}`, kind, ax: e.x, ay: e.y, bx, by, grid: true, auto: e.auto, cuts: [] });
  }
  const free: Segment[] = [];
  for (const ref of walls.free) {
    const kind = wallKind(ref.wall.f);
    if (!kind) continue;
    const [ax, ay] = ref.wall.a;
    const [bx, by] = ref.wall.b;
    if (Math.abs(ax - bx) < EPS && Math.abs(ay - by) < EPS) continue;
    free.push({ id: `f${ref.cx},${ref.cy}:${ref.wall.id}`, kind, ax, ay, bx, by, grid: false, auto: false, cuts: [] });
  }
  splitCrossings(free);
  segments.push(...free);
  const out: WallPiece[] = [];
  const hex = isHex(grid) ? grid : null;
  for (const s of segments) {
    if (hex) s.cuts.push(...hexSideCuts(hex, s));
    piecesOf(s, fog, out, hex);
  }
  return out;
}

/** Where a segment crosses or touches a canonical hex side, as parameters along it: every side of every hex its box meets, past the scene too. */
export function hexSideCuts(grid: HexGrid, s: { ax: number; ay: number; bx: number; by: number }): number[] {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return [];
  const box = { x0: Math.min(s.ax, s.bx) - EPS, y0: Math.min(s.ay, s.by) - EPS, x1: Math.max(s.ax, s.bx) + EPS, y1: Math.max(s.ay, s.by) + EPS };
  const out: number[] = [];
  const add = (t: number) => {
    if (t > EPS && t < 1 - EPS) out.push(t);
  };
  for (const cell of cellsMeeting(grid, box, null)) {
    const poly = cellPolygon(grid, cell);
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]!;
      const q = poly[(k + 1) % poly.length]!;
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const den = dx * ey - dy * ex;
      const px = p.x - s.ax;
      const py = p.y - s.ay;
      if (Math.abs(den) < 1e-12) {
        // Along the side: the side's ends cut it, so a wall down one side and on past it parts at the corner.
        if (Math.abs(px * dy - py * dx) > 1e-9) continue;
        add((px * dx + py * dy) / len2);
        add(((q.x - s.ax) * dx + (q.y - s.ay) * dy) / len2);
        continue;
      }
      const t = (px * ey - py * ex) / den;
      const u = (px * dy - py * dx) / den;
      if (u < -EPS || u > 1 + EPS) continue;
      add(t);
    }
  }
  return out;
}

/** The hexes a run stands in: the canonical polygon that holds its middle, and on a side both hexes beside it, the owner first by the lattice's tie order. */
export function runHosts(grid: HexGrid, a: Point, b: Point): { cell: GroundCell; center: Point }[] {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const host = cellAtPoint(grid, mid);
  const hosts: GroundCell[] = [host];
  if (polygonSide(cellPolygon(grid, host), mid, 1e-9) === 0) {
    for (const n of neighborsOf(grid, host)) {
      if (polygonSide(cellPolygon(grid, n), mid, 1e-9) === 0 && polygonSide(cellPolygon(grid, n), a, 1e-9) === 0 && polygonSide(cellPolygon(grid, n), b, 1e-9) === 0) {
        hosts.push(n);
        break;
      }
    }
  }
  const lat = (c: GroundCell) => (grid.orient === "rows" ? [c.row, c.col] : [c.col, c.row]);
  hosts.sort((p, q) => lat(p)[0]! - lat(q)[0]! || lat(p)[1]! - lat(q)[1]!);
  return hosts.map((cell) => ({ cell, center: cellCenter(grid, cell) }));
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
 * The stretches of a wall from `a` to `b` that stand for this viewer, as
 * parameters along it, cut into runs as `wallPieces` cuts them and each
 * judged by `runStands`: what a door's piece draws upright, so its tap and
 * its pill stand where it does (doors/tap.ts, DoorPill.tsx).
 */
export function standingStretches(fog: FogView, a: { x: number; y: number }, b: { x: number; y: number }): [number, number][] {
  if (fog.all) return [[0, 1]];
  const ts = cutsOf({ id: "", kind: "wall", ax: a.x, ay: a.y, bx: b.x, by: b.y, grid: true, auto: false, cuts: [] });
  const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const t0 = ts[i]!;
    const t1 = ts[i + 1]!;
    const p = at(t0);
    const q = at(t1);
    if (!runStands(fog, p.x, p.y, q.x, q.y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - t0) < EPS) last[1] = t1;
    else out.push([t0, t1]);
  }
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

function piecesOf(s: Segment, fog: FogView, out: WallPiece[], hex: HexGrid | null): void {
  const ts = cutsOf(s);
  const at = (t: number) => ({ x: s.ax + (s.bx - s.ax) * t, y: s.ay + (s.by - s.ay) * t });
  // The open piece: where it starts and the cell it is in.
  let start = -1;
  let cell = "";
  const close = (endT: number) => {
    if (start < 0) return;
    const a = at(ts[start]!);
    const b = at(endT);
    if (hex) {
      const hosts = runHosts(hex, a, b);
      const owner = hosts[0]!.cell;
      out.push({ id: `${s.id}@${start}`, kind: s.kind, ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: owner.col, cy: owner.row, beside: null, auto: s.auto, hosts });
      start = -1;
      return;
    }
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
      auto: s.auto,
    });
    start = -1;
  };
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = at(ts[i]!);
    const b = at(ts[i + 1]!);
    // A grid edge is one cell's side, so its runs share a cell, and a free wall's run is in the cell that holds its midpoint. On hexes a run's hosts say where it stands.
    const runCell = hex
      ? runHosts(hex, a, b)
          .map((h) => `${h.cell.col},${h.cell.row}`)
          .join("|")
      : s.grid
        ? ""
        : `${Math.floor((a.x + b.x) / 2)},${Math.floor((a.y + b.y) / 2)}`;
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

/**
 * The pillars that stand (5.5): each pillar cell of the scene whose every
 * sub-cell this viewer has revealed, by the stand rule. The rest lie flat
 * on the ground stage under the fog (builder/draw.ts `standing`).
 */
export function pillarPieces(chunks: Readonly<Record<string, BuildChunk | undefined>>, sceneId: string, bounds: { w: number; h: number }, fog: FogView): WallPiece[] {
  const out: WallPiece[] = [];
  for (const chunk of Object.values(chunks)) {
    if (!chunk || chunk.sceneId !== sceneId) continue;
    for (const [key, terrain] of Object.entries(chunk.cells)) {
      if (terrain !== "pillar") continue;
      const [xs, ys] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= bounds.w || y >= bounds.h) continue;
      // A cell key outside its chunk is not this chunk's to draw.
      if (Math.floor(x / CHUNK_CELLS) !== chunk.cx || Math.floor(y / CHUNK_CELLS) !== chunk.cy) continue;
      if (!fog.boxClear({ x0: x, y0: y, x1: x + 1, y1: y + 1 })) continue;
      out.push({ id: `p${x},${y}`, kind: "pillar", ax: x, ay: y, bx: x + 1, by: y + 1, cx: x, cy: y, beside: null, auto: false });
    }
  }
  return out;
}
