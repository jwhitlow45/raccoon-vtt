import { orient2d } from "robust-predicates";
import type { Bounds } from "./geom.ts";

/**
 * The exact half of the wall geometry (docs/design-v1-maps-vision.md
 * sections 2.1 and 4.3.4): the orientation predicate, the split of a wall
 * set at every crossing with its counting pass, clipping to a sweep's box,
 * the step that moves an eye off a wall, and the polygon scanline helpers.
 *
 * Sight's "seen" marks are stored facts that replay rebuilds, so everything
 * here uses only +, -, *, / and comparisons, which IEEE 754 rounds the same
 * way in every engine, plus Math.floor, abs, min and max. No atan2, sin,
 * cos, sqrt, hypot, pow or exp, here or in anything this file imports (a
 * test checks). That is why it imports nothing from walls.ts.
 *
 * Coordinates are cells. Stored segments (grid edges, free walls, pillar
 * sides) have every end on the 1/64 lattice, so in lattice units (cells
 * times 64, an exact scaling) they are whole numbers below 2^16, and their
 * cross products are exact in plain doubles. Points off the lattice, such
 * as an eye or a token's center, go through `orient`, which is exact for
 * any doubles.
 */

/** What a segment blocks. A segment carries any mix of these bits. */
export const AREAS = 1;
export const MOVEMENT = 2;
export const SIGHT = 4;
/**
 * Would block sight with every door closed and every secret door hidden.
 * The sight cap counts these whatever the door states, so a door a player
 * opens or closes never reaches it (section 2.1).
 */
export const SIGHT_POTENTIAL = 8;

/** Free wall coordinates are multiples of 1 / LATTICE cell (model.ts FREE_WALL_LATTICE). */
export const LATTICE = 64;
/** The largest coordinate a stored segment may have: a build edge sits at most at 1024 (walls.ts MAX_BUILD_COORD + 1). */
export const MAX_COORD = 1024;

/**
 * An eye or a light closer than this to a stored sight segment is stepped
 * off it (section 4.3.2). Far more than any rounding in a split piece, so no
 * piece can pass through or behind a stepped eye.
 */
export const WALL_MARGIN = 1 / 4096;

// ---------------------------------------------------------------------------
// The exact predicate

/**
 * The exact sign of the cross product (b - a) x (c - a), for any doubles:
 * 1 when c lies clockwise of a to b on the y-down map (counterclockwise in
 * y-up axes), -1 the other way, 0 exactly on the line. Shewchuk's adaptive
 * arithmetic (robust-predicates), which uses only +, - and *. Its own sign
 * convention is the opposite one, hence the flip.
 */
export function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): -1 | 0 | 1 {
  const d = orient2d(ax, ay, bx, by, cx, cy);
  return d < 0 ? 1 : d > 0 ? -1 : 0;
}

/** Whether (px, py) lies on the closed segment from a to b. Exact. */
export function onSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (px < (ax < bx ? ax : bx) || px > (ax < bx ? bx : ax) || py < (ay < by ? ay : by) || py > (ay < by ? by : ay)) return false;
  return orient(ax, ay, bx, by, px, py) === 0;
}

/** How two closed segments meet: not at all, at one or more shared points without crossing, or crossing at one interior point. */
export const APART = 0;
export const TOUCH = 1;
export const CROSS = 2;

/**
 * Whether the closed segments ab and cd meet, and how. Exact for any
 * doubles. A shared end, an end on the other's interior, and collinear
 * overlap are all TOUCH. CROSS is a single point interior to both.
 */
export function contact(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): 0 | 1 | 2 {
  if (
    (ax < bx ? bx : ax) < (cx < dx ? cx : dx) ||
    (cx < dx ? dx : cx) < (ax < bx ? ax : bx) ||
    (ay < by ? by : ay) < (cy < dy ? cy : dy) ||
    (cy < dy ? dy : cy) < (ay < by ? ay : by)
  ) {
    return APART;
  }
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 * o2 < 0 && o3 * o4 < 0) return CROSS;
  if (o1 === 0 && onSegment(cx, cy, ax, ay, bx, by)) return TOUCH;
  if (o2 === 0 && onSegment(dx, dy, ax, ay, bx, by)) return TOUCH;
  if (o3 === 0 && onSegment(ax, ay, cx, cy, dx, dy)) return TOUCH;
  if (o4 === 0 && onSegment(bx, by, cx, cy, dx, dy)) return TOUCH;
  return APART;
}

/**
 * Whether (px, py) is within `margin` of the closed segment ab, its interior
 * or an end. Compares squared lengths, so it needs no square root. Not
 * exact, since the margin is a tolerance rather than a side, but made of
 * plain operations, so it gives the same answer everywhere.
 */
export function nearSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, margin: number = WALL_MARGIN): boolean {
  const ex = bx - ax;
  const ey = by - ay;
  const qx = px - ax;
  const qy = py - ay;
  const m2 = margin * margin;
  const dot = qx * ex + qy * ey;
  if (dot <= 0) return qx * qx + qy * qy <= m2;
  const len2 = ex * ex + ey * ey;
  if (dot >= len2) {
    const rx = px - bx;
    const ry = py - by;
    return rx * rx + ry * ry <= m2;
  }
  const cross = qx * ey - qy * ex;
  return cross * cross <= m2 * len2;
}

// ---------------------------------------------------------------------------
// Candidate segments and the split

/**
 * The segments a derived wall set starts from, before the split: grid edges
 * (merged into runs), free walls and pillar sides, every end on the 1/64
 * lattice. These are the stored segments of section 2.1, which every touch
 * and side decision reads. walls.ts builds them.
 */
export type Candidates = {
  /** `[ax, ay, bx, by]` per segment, in cells. */
  readonly xy: Float64Array;
  /** What each segment blocks (AREAS, MOVEMENT, SIGHT, SIGHT_POTENTIAL). */
  readonly tags: Uint8Array;
  /**
   * 1 for a free wall, which may cross or touch anything. 0 for a grid
   * segment or a pillar side: those meet each other only at grid points or
   * not at all, so they are split only where a free wall meets them.
   */
  readonly free: Uint8Array;
  readonly n: number;
};

/** Split pieces: no two cross, and no two overlap along a line. */
export type Pieces = {
  readonly xy: Float64Array;
  readonly tags: Uint8Array;
  readonly n: number;
};

export type SplitCaps = { pairs: number; pieces: number };

export type SplitCount = {
  /**
   * Candidate pairs: a free wall and another segment that share a cell row
   * and overlap along x. The pass compares each once, whether or not they
   * meet, so this is its work.
   */
  pairs: number;
  /** Pieces their crossings and touches would add, an upper bound on what the split adds. */
  pieces: number;
  /** The cap passed, if any. Counting stops as soon as one is, so the counts then stop just past it. */
  over: "pairs" | "pieces" | null;
};

/*
 * Visits every candidate pair once: a free wall and another segment that
 * share a cell row and whose closed x ranges overlap. The buckets are cell
 * rows. Each segment goes in every row its box covers (floor of its top to
 * floor of its bottom, so two segments that only meet on a cell boundary
 * still share a row), and a pair belongs to the lower of the two start
 * rows, the one row where at least one of them starts. Within a row, a
 * sweep along x compares a segment with every one still open at its left
 * end, and each comparison is one visit. `boxes` says whether their y
 * ranges overlap as well, which two segments need in order to meet.
 *
 * The visits are the pass's work beyond filing each segment into its
 * rows, and the pairs cap counts every one, met or not. Walls in one row
 * that overlap along x on different lattice lines never meet but are still
 * compared: 55 coincident walls on each of a row's 64 lines are 6 million
 * comparisons and only 95,040 meetings. Counting comparisons rather than
 * meetings is what makes the cap bound the time.
 *
 * `visit` returns false to stop.
 */
function forEachPair(c: Candidates, visit: (i: number, j: number, boxes: boolean) => boolean): void {
  const { xy, free, n } = c;
  // The rows and columns any free wall reaches. Nothing else can pair.
  let fx0 = Infinity;
  let fy0 = Infinity;
  let fx1 = -Infinity;
  let fy1 = -Infinity;
  let anyFree = false;
  for (let i = 0; i < n; i++) {
    if (free[i] !== 1) continue;
    anyFree = true;
    const ax = xy[4 * i]!;
    const ay = xy[4 * i + 1]!;
    const bx = xy[4 * i + 2]!;
    const by = xy[4 * i + 3]!;
    fx0 = Math.min(fx0, ax, bx);
    fx1 = Math.max(fx1, ax, bx);
    fy0 = Math.min(fy0, ay, by);
    fy1 = Math.max(fy1, ay, by);
  }
  if (!anyFree) return;
  const row0 = Math.floor(fy0);
  const rows = Math.floor(fy1) - row0 + 1;

  const lo = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    const ax = xy[4 * i]!;
    const ay = xy[4 * i + 1]!;
    const bx = xy[4 * i + 2]!;
    const by = xy[4 * i + 3]!;
    lo[4 * i] = ax < bx ? ax : bx;
    lo[4 * i + 1] = ay < by ? ay : by;
    lo[4 * i + 2] = ax < bx ? bx : ax;
    lo[4 * i + 3] = ay < by ? by : ay;
  }
  // The rows some free wall is in. A pair needs a free wall in its row, so no row without one gets a bucket.
  const freeRow = new Uint8Array(rows);
  for (let i = 0; i < n; i++) {
    if (free[i] !== 1) continue;
    const y0 = xy[4 * i + 1]!;
    const y1 = xy[4 * i + 3]!;
    for (let r = Math.floor(y0 < y1 ? y0 : y1) - row0; r <= Math.floor(y0 < y1 ? y1 : y0) - row0; r++) freeRow[r] = 1;
  }
  // The rows each segment is in, relative to row0. A segment that misses the free walls' box, or every row with a free wall, can pair with nothing, so it is in none.
  const first = new Int32Array(n);
  const last = new Int32Array(n);
  const offsets = new Int32Array(rows + 1);
  for (let i = 0; i < n; i++) {
    const x0 = lo[4 * i]!;
    const y0 = lo[4 * i + 1]!;
    const x1 = lo[4 * i + 2]!;
    const y1 = lo[4 * i + 3]!;
    if (x1 < fx0 || x0 > fx1 || y1 < fy0 || y0 > fy1) {
      first[i] = 1;
      last[i] = 0;
      continue;
    }
    first[i] = Math.max(row0, Math.floor(y0)) - row0;
    last[i] = Math.min(row0 + rows - 1, Math.floor(y1)) - row0;
    let filed = 0;
    for (let r = first[i]!; r <= last[i]!; r++) {
      if (freeRow[r] !== 1) continue;
      offsets[r + 1]!++;
      filed++;
    }
    if (filed === 0) {
      first[i] = 1;
      last[i] = 0;
    }
  }
  for (let r = 0; r < rows; r++) offsets[r + 1]! += offsets[r]!;
  /*
   * One sort for every row: the segments that can pair, in order of x0 and
   * then of number, filled into their rows in that order so each row's
   * bucket comes out sorted. x0 in lattice units is a whole number below
   * 2^17, so a counting sort on it does this in one pass. A comparison sort
   * of a 200 x 200 build's segments took longer than the rest of the pass.
   */
  let minX = Infinity;
  for (let i = 0; i < n; i++) if (first[i]! <= last[i]! && lo[4 * i]! < minX) minX = lo[4 * i]!;
  const base = minX * LATTICE;
  const span = fx1 * LATTICE - base + 1;
  const byX = new Int32Array(span + 1);
  for (let i = 0; i < n; i++) if (first[i]! <= last[i]!) byX[lo[4 * i]! * LATTICE - base + 1]!++;
  for (let x = 0; x < span; x++) byX[x + 1]! += byX[x]!;
  const order = new Int32Array(byX[span]!);
  for (let i = 0; i < n; i++) if (first[i]! <= last[i]!) order[byX[lo[4 * i]! * LATTICE - base]!++] = i;
  const items = new Int32Array(offsets[rows]!);
  const fill = offsets.slice(0, rows);
  for (const i of order) for (let r = first[i]!; r <= last[i]!; r++) if (freeRow[r] === 1) items[fill[r]!++] = i;

  /*
   * Compares segment i with every segment in `list` still open at its left
   * end, dropping those that closed before it. False when `visit` stops.
   */
  const scan = (list: number[], i: number): boolean => {
    const x0 = lo[4 * i]!;
    const y0 = lo[4 * i + 1]!;
    const y1 = lo[4 * i + 3]!;
    for (let m = 0; m < list.length; ) {
      const j = list[m]!;
      if (lo[4 * j + 2]! < x0) {
        list[m] = list[list.length - 1]!;
        list.pop();
        continue;
      }
      m++;
      if (!visit(j, i, lo[4 * j + 1]! <= y1 && y0 <= lo[4 * j + 3]!)) return false;
    }
    return true;
  };
  // Active lists, by whether a segment is free and whether it starts in this row. A pair needs a free wall, and one of the two must start in the row.
  const freeHere: number[] = [];
  const fixedHere: number[] = [];
  const freeAbove: number[] = [];
  const fixedAbove: number[] = [];
  for (let r = 0; r < rows; r++) {
    freeHere.length = fixedHere.length = freeAbove.length = fixedAbove.length = 0;
    for (let k = offsets[r]!; k < offsets[r + 1]!; k++) {
      const i = items[k]!;
      const here = Math.floor(lo[4 * i + 1]!) - row0 === r;
      if (free[i] === 1) {
        if (!scan(freeHere, i) || !scan(fixedHere, i)) return;
        if (here && (!scan(freeAbove, i) || !scan(fixedAbove, i))) return;
        (here ? freeHere : freeAbove).push(i);
      } else {
        if (!scan(freeHere, i)) return;
        if (here && !scan(freeAbove, i)) return;
        (here ? fixedHere : fixedAbove).push(i);
      }
    }
  }
}

/** Sign of a cross product of whole numbers below 2^17, exact in doubles. */
function sign(v: number): -1 | 0 | 1 {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/*
 * Where two candidate segments meet, in lattice units: a callback gets each
 * split point for each segment, and the return value is how many pieces the
 * meeting adds (2 for a crossing, 1 for each end that lies inside the other
 * segment). Collinear segments that overlap also report the overlap, so
 * the split can partition their shared line once.
 */
type MeetSink = {
  at(seg: number, x: number, y: number): void;
  overlap(i: number, j: number): void;
};

function meet(L: Float64Array, free: Uint8Array, i: number, j: number, sink: MeetSink | null): number {
  const ax = L[4 * i]!;
  const ay = L[4 * i + 1]!;
  const bx = L[4 * i + 2]!;
  const by = L[4 * i + 3]!;
  const cx = L[4 * j]!;
  const cy = L[4 * j + 1]!;
  const dx = L[4 * j + 2]!;
  const dy = L[4 * j + 3]!;
  const ex = bx - ax;
  const ey = by - ay;
  const fx = dx - cx;
  const fy = dy - cy;
  const o1 = sign(ex * (cy - ay) - ey * (cx - ax));
  const o2 = sign(ex * (dy - ay) - ey * (dx - ax));
  if (o1 === 0 && o2 === 0) return collinear(ax, ay, bx, by, cx, cy, dx, dy, i, j, sink);
  const o3 = sign(fx * (ay - cy) - fy * (ax - cx));
  const o4 = sign(fx * (by - cy) - fy * (bx - cx));
  if (o1 * o2 < 0 && o3 * o4 < 0) {
    if (sink) {
      /*
       * The crossing, parametrized on a free wall (at most 8 cells, 512
       * lattice units, per axis): x = (ax * den + num * ex) / den with den
       * and num whole numbers, so the numerator stays below 2^44 and is
       * exact, and the one division rounds correctly. The double is then
       * the nearest one to the exact point, whichever pair produced it, so
       * three walls through one point all split at the same double.
       */
      const s = free[i] === 1;
      const [px, py, qx, qy, ux, uy, vx, vy] = s ? [ax, ay, ex, ey, cx, cy, fx, fy] : [cx, cy, fx, fy, ax, ay, ex, ey];
      const den = qx * vy - qy * vx;
      const num = (ux - px) * vy - (uy - py) * vx;
      const x = (px * den + num * qx) / den;
      const y = (py * den + num * qy) / den;
      sink.at(i, x, y);
      sink.at(j, x, y);
    }
    return 2;
  }
  let added = 0;
  const inside = (px: number, py: number, sx: number, sy: number, tx: number, ty: number) =>
    !(px === sx && py === sy) && !(px === tx && py === ty) && px >= Math.min(sx, tx) && px <= Math.max(sx, tx) && py >= Math.min(sy, ty) && py <= Math.max(sy, ty);
  if (o1 === 0 && inside(cx, cy, ax, ay, bx, by)) {
    sink?.at(i, cx, cy);
    added++;
  }
  if (o2 === 0 && inside(dx, dy, ax, ay, bx, by)) {
    sink?.at(i, dx, dy);
    added++;
  }
  if (o3 === 0 && inside(ax, ay, cx, cy, dx, dy)) {
    sink?.at(j, ax, ay);
    added++;
  }
  if (o4 === 0 && inside(bx, by, cx, cy, dx, dy)) {
    sink?.at(j, bx, by);
    added++;
  }
  return added;
}

function collinear(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, i: number, j: number, sink: MeetSink | null): number {
  const alongX = Math.abs(bx - ax) >= Math.abs(by - ay);
  const s0 = alongX ? Math.min(ax, bx) : Math.min(ay, by);
  const s1 = alongX ? Math.max(ax, bx) : Math.max(ay, by);
  const t0 = alongX ? Math.min(cx, dx) : Math.min(cy, dy);
  const t1 = alongX ? Math.max(cx, dx) : Math.max(cy, dy);
  // Collinear segments meeting at one shared end need nothing.
  if (!(Math.max(s0, t0) < Math.min(s1, t1))) return 0;
  sink?.overlap(i, j);
  let added = 0;
  const c = alongX ? cx : cy;
  const d = alongX ? dx : dy;
  const a = alongX ? ax : ay;
  const b = alongX ? bx : by;
  if (s0 < c && c < s1) {
    sink?.at(i, cx, cy);
    added++;
  }
  if (s0 < d && d < s1) {
    sink?.at(i, dx, dy);
    added++;
  }
  if (t0 < a && a < t1) {
    sink?.at(j, ax, ay);
    added++;
  }
  if (t0 < b && b < t1) {
    sink?.at(j, bx, by);
    added++;
  }
  return added;
}

function latticeOf(c: Candidates): Float64Array {
  const L = new Float64Array(c.n * 4);
  for (let k = 0; k < c.n * 4; k++) L[k] = c.xy[k]! * LATTICE;
  return L;
}

/**
 * The split's counting pass (section 2.1): counts the candidate pairs and
 * the pieces their crossings would add, without building any piece, and
 * stops as soon as a count passes its cap. The limits step runs it on every
 * op that writes geometry, so every stored scene splits within the caps,
 * and the split itself compares no more pairs than were counted here.
 */
export function countSplit(c: Candidates, caps: SplitCaps): SplitCount {
  const L = latticeOf(c);
  let pairs = 0;
  let pieces = 0;
  let over: SplitCount["over"] = null;
  forEachPair(c, (i, j, boxes) => {
    if (++pairs > caps.pairs) {
      over = "pairs";
      return false;
    }
    if (!boxes) return true;
    pieces += meet(L, c.free, i, j, null);
    if (pieces > caps.pieces) {
      over = "pieces";
      return false;
    }
    return true;
  });
  return { pairs, pieces, over };
}

/** Growable flat storage for split points and pieces. */
class Floats {
  data = new Float64Array(64);
  length = 0;
  #room(count: number): void {
    if (this.length + count <= this.data.length) return;
    const next = new Float64Array(Math.max(this.data.length * 2, this.length + count));
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
  push2(a: number, b: number): void {
    this.#room(2);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }
  push4(a: number, b: number, c: number, d: number): void {
    this.#room(4);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
    this.data[this.length++] = d;
  }
}

/*
 * Orders points along a segment's own direction: by its main axis, and on
 * a tie (rounded crossings a hair apart) by its other axis, both in the
 * direction from its first end to its second.
 */
function alongComparer(ex: number, ey: number): (a: number, b: number, P: Float64Array) => number {
  const main = Math.abs(ex) >= Math.abs(ey) ? 0 : 1;
  const mainSign = (main === 0 ? ex : ey) < 0 ? -1 : 1;
  const otherSign = (main === 0 ? ey : ex) < 0 ? -1 : 1;
  return (a, b, P) => {
    const d = (P[2 * a + main]! - P[2 * b + main]!) * mainSign;
    if (d !== 0) return d;
    return (P[2 * a + 1 - main]! - P[2 * b + 1 - main]!) * otherSign;
  };
}

/**
 * Splits the candidates at every point where a free wall crosses or touches
 * another segment, and partitions every line where collinear segments
 * overlap once, each piece carrying the tags of every segment over it. The
 * result has no two pieces crossing and none overlapping, so any subset of
 * it can go to a sweep.
 *
 * Grid segments meet only at grid points, where walls.ts has already cut
 * them, and keep the T junctions they had (an end on another's interior),
 * which a sweep handles. Every split point is either a lattice point or the
 * correctly rounded crossing of two lattice segments, so one point is one
 * double, and the pieces that end there share it exactly.
 *
 * Callers run `countSplit` first: this does the work the counts describe.
 */
export function splitSegments(c: Candidates): Pieces {
  const L = latticeOf(c);
  const pointSeg: number[] = [];
  const points = new Floats();
  const parent = new Int32Array(c.n).fill(-1);
  const find = (k: number): number => {
    let r = k;
    while (parent[r]! >= 0) r = parent[r]!;
    while (parent[k]! >= 0) {
      const next = parent[k]!;
      parent[k] = r;
      k = next;
    }
    return r;
  };
  let grouped = false;
  const sink: MeetSink = {
    at(seg, x, y) {
      pointSeg.push(seg);
      points.push2(x / LATTICE, y / LATTICE);
    },
    overlap(i, j) {
      grouped = true;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    },
  };
  forEachPair(c, (i, j, boxes) => {
    if (boxes) meet(L, c.free, i, j, sink);
    return true;
  });

  // Split points grouped by segment.
  const firstPoint = new Int32Array(c.n + 1);
  for (const s of pointSeg) firstPoint[s + 1]!++;
  for (let k = 0; k < c.n; k++) firstPoint[k + 1]! += firstPoint[k]!;
  const byPoint = new Int32Array(pointSeg.length);
  {
    const fill = firstPoint.slice(0, c.n);
    for (let p = 0; p < pointSeg.length; p++) byPoint[fill[pointSeg[p]!]!++] = p;
  }
  const P = points.data;

  const outXy = new Floats();
  const outTags: number[] = [];
  const emit = (ax: number, ay: number, bx: number, by: number, tags: number) => {
    if (ax === bx && ay === by) return;
    outXy.push4(ax, ay, bx, by);
    outTags.push(tags);
  };

  /*
   * Collinear groups, partitioned once below, keyed by their smallest
   * member, which union keeps as the root, so the groups come out in order
   * of it. A segment alone is in no group.
   */
  const members = new Map<number, number[]>();
  const inGroup = new Uint8Array(c.n);
  if (grouped) {
    for (let k = 0; k < c.n; k++) {
      if (parent[k]! < 0) continue;
      inGroup[k] = 1;
      inGroup[find(k)] = 1;
    }
    for (let k = 0; k < c.n; k++) {
      if (inGroup[k] !== 1) continue;
      const root = find(k);
      let list = members.get(root);
      if (!list) members.set(root, (list = []));
      list.push(k);
    }
  }

  for (let k = 0; k < c.n; k++) {
    if (inGroup[k] === 1) continue;
    const ax = c.xy[4 * k]!;
    const ay = c.xy[4 * k + 1]!;
    const bx = c.xy[4 * k + 2]!;
    const by = c.xy[4 * k + 3]!;
    const tags = c.tags[k]!;
    const from = firstPoint[k]!;
    const to = firstPoint[k + 1]!;
    if (from === to) {
      emit(ax, ay, bx, by, tags);
      continue;
    }
    const order: number[] = [];
    for (let q = from; q < to; q++) order.push(byPoint[q]!);
    const cmp = alongComparer(bx - ax, by - ay);
    order.sort((p, q) => cmp(p, q, P));
    let px = ax;
    let py = ay;
    for (const p of order) {
      const x = P[2 * p]!;
      const y = P[2 * p + 1]!;
      if ((x === px && y === py) || (x === bx && y === by)) continue;
      emit(px, py, x, y, tags);
      px = x;
      py = y;
    }
    emit(px, py, bx, by, tags);
  }

  for (const list of members.values()) partitionLine(c, list, firstPoint, byPoint, P, emit);

  return { xy: outXy.data.slice(0, outXy.length), tags: Uint8Array.from(outTags), n: outTags.length };
}

/*
 * Collinear segments that overlap become one partition of their line: every
 * end and every split point of every member cuts it, and each piece carries
 * the tags of the members over it, counted per tag bit while sweeping along
 * the line. The group's union is one interval, since each member overlaps
 * another along a length.
 */
function partitionLine(
  c: Candidates,
  list: readonly number[],
  firstPoint: Int32Array,
  byPoint: Int32Array,
  P: Float64Array,
  emit: (ax: number, ay: number, bx: number, by: number, tags: number) => void,
): void {
  const k0 = list[0]!;
  const ex = c.xy[4 * k0 + 2]! - c.xy[4 * k0]!;
  const ey = c.xy[4 * k0 + 3]! - c.xy[4 * k0 + 1]!;
  const main = Math.abs(ex) >= Math.abs(ey) ? 0 : 1;
  const mainSign = (main === 0 ? ex : ey) < 0 ? -1 : 1;
  const otherSign = (main === 0 ? ey : ex) < 0 ? -1 : 1;
  // Points: x, y, and for a member's end, +1 at its start or -1 at its end with its tags.
  type Stop = { x: number; y: number; delta: number; tags: number };
  const stops: Stop[] = [];
  for (const k of list) {
    const ax = c.xy[4 * k]!;
    const ay = c.xy[4 * k + 1]!;
    const bx = c.xy[4 * k + 2]!;
    const by = c.xy[4 * k + 3]!;
    const aFirst = ((main === 0 ? ax - bx : ay - by) * mainSign || (main === 0 ? ay - by : ax - bx) * otherSign) < 0;
    stops.push({ x: ax, y: ay, delta: aFirst ? 1 : -1, tags: c.tags[k]! });
    stops.push({ x: bx, y: by, delta: aFirst ? -1 : 1, tags: c.tags[k]! });
    for (let p = firstPoint[k]!; p < firstPoint[k + 1]!; p++) {
      const q = byPoint[p]!;
      stops.push({ x: P[2 * q]!, y: P[2 * q + 1]!, delta: 0, tags: 0 });
    }
  }
  stops.sort((s, t) => {
    const d = ((main === 0 ? s.x - t.x : s.y - t.y) || 0) * mainSign;
    if (d !== 0) return d;
    return ((main === 0 ? s.y - t.y : s.x - t.x) || 0) * otherSign;
  });
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  let open = 0;
  let px = 0;
  let py = 0;
  let started = false;
  for (let s = 0; s < stops.length; ) {
    const x = stops[s]!.x;
    const y = stops[s]!.y;
    if (started && open > 0) {
      let tags = 0;
      for (let bit = 0; bit < 8; bit++) if (counts[bit]! > 0) tags |= 1 << bit;
      emit(px, py, x, y, tags);
    }
    // Every stop at this exact point applies at once.
    for (; s < stops.length && stops[s]!.x === x && stops[s]!.y === y; s++) {
      const stop = stops[s]!;
      if (stop.delta === 0) continue;
      open += stop.delta;
      for (let bit = 0; bit < 8; bit++) if (stop.tags & (1 << bit)) counts[bit]! += stop.delta;
    }
    px = x;
    py = y;
    started = true;
  }
}

/** The pieces carrying any of `mask`, flat, ready for a sweep. */
export function piecesWith(pieces: Pieces, mask: number): Float64Array {
  let count = 0;
  for (let k = 0; k < pieces.n; k++) if (pieces.tags[k]! & mask) count++;
  const out = new Float64Array(count * 4);
  let m = 0;
  for (let k = 0; k < pieces.n; k++) {
    if (!(pieces.tags[k]! & mask)) continue;
    out[m++] = pieces.xy[4 * k]!;
    out[m++] = pieces.xy[4 * k + 1]!;
    out[m++] = pieces.xy[4 * k + 2]!;
    out[m++] = pieces.xy[4 * k + 3]!;
  }
  return out;
}

/** The box around flat segments, or null when there are none. */
export function boundsOf(segs: Float64Array): Bounds | null {
  if (segs.length < 4) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < segs.length; k += 2) {
    const x = segs[k]!;
    const y = segs[k + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// A sweep's own box

/**
 * Every segment that meets `box`, clipped to it, for a sweep that closes
 * its polygon with the box's four sides (section 2.1, "A sweep's own box").
 * A segment crossing the box would cross those sides, so it is cut where it
 * meets them: one coordinate is the side's exactly and the other is solved
 * with a division and clamped into the box, so the clipped piece touches
 * the box only at its ends. A segment lying along a side, or meeting the
 * box at one point, is left out: the side blocks there anyway.
 *
 * Give a box whose sides lie on the 1/64 lattice where possible: lattice
 * ends then sit on a side exactly or a whole lattice step from it, and
 * rounded split points never sit a hair from one, so two pieces sharing an
 * end outside the box cannot swap order where they enter it.
 */
export function clipToBox(segs: Float64Array, box: Bounds): Float64Array {
  const { x0, y0, x1, y1 } = box;
  const out = new Floats();
  for (let k = 0; k + 3 < segs.length; k += 4) {
    const ax = segs[k]!;
    const ay = segs[k + 1]!;
    const bx = segs[k + 2]!;
    const by = segs[k + 3]!;
    if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue;
    const dx = bx - ax;
    const dy = by - ay;
    // The parameter range inside the box, and which side bounds each end (0 none, 1 x, 2 y).
    let tIn = 0;
    let tOut = 1;
    let sideIn = 0;
    let sideOut = 0;
    let inX = 0;
    let inY = 0;
    let outX = 0;
    let outY = 0;
    let empty = false;
    for (const [d, a, lo, hi, side] of [
      [dx, ax, x0, x1, 1],
      [dy, ay, y0, y1, 2],
    ] as const) {
      if (d === 0) {
        if (a < lo || a > hi) empty = true;
        continue;
      }
      const tLo = (lo - a) / d;
      const tHi = (hi - a) / d;
      const enter = d > 0 ? tLo : tHi;
      const leave = d > 0 ? tHi : tLo;
      if (enter > tIn) {
        tIn = enter;
        sideIn = side;
        if (side === 1) inX = d > 0 ? lo : hi;
        else inY = d > 0 ? lo : hi;
      }
      if (leave < tOut) {
        tOut = leave;
        sideOut = side;
        if (side === 1) outX = d > 0 ? hi : lo;
        else outY = d > 0 ? hi : lo;
      }
    }
    if (empty || !(tIn < tOut)) continue;
    const at = (side: number, sx: number, sy: number, fx: number, fy: number): [number, number] => {
      if (side === 1) return [sx, clampTo(ay + ((sx - ax) * dy) / dx, y0, y1)];
      if (side === 2) return [clampTo(ax + ((sy - ay) * dx) / dy, x0, x1), sy];
      return [fx, fy];
    };
    const [px, py] = at(sideIn, inX, inY, ax, ay);
    const [qx, qy] = at(sideOut, outX, outY, bx, by);
    if (px === qx && py === qy) continue;
    // Along a side: the box's own side blocks there.
    if ((px === qx && (px === x0 || px === x1)) || (py === qy && (py === y0 || py === y1))) continue;
    out.push4(px, py, qx, qy);
  }
  return out.data.slice(0, out.length);
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// A per-cell index of segments

/**
 * Segments bucketed by the cells their boxes cover (floor of the low corner
 * to floor of the high corner, so a segment on a cell boundary is in the
 * cells on both sides of it when queried the same way). Wave 4's movement
 * test and the step off a wall read stored segments through it.
 */
export class SegmentIndex {
  readonly xy: Float64Array;
  readonly tags: Uint8Array;
  readonly #gx: number;
  readonly #gy: number;
  readonly #w: number;
  readonly #h: number;
  readonly #offsets: Int32Array;
  readonly #items: Int32Array;
  readonly #stamp: Uint32Array;
  #query = 0;

  constructor(xy: Float64Array, tags: Uint8Array) {
    this.xy = xy;
    this.tags = tags;
    const n = tags.length;
    const box = boundsOf(xy);
    this.#gx = box ? Math.floor(box.x0) : 0;
    this.#gy = box ? Math.floor(box.y0) : 0;
    this.#w = box ? Math.floor(box.x1) - this.#gx + 1 : 0;
    this.#h = box ? Math.floor(box.y1) - this.#gy + 1 : 0;
    const offsets = new Int32Array(this.#w * this.#h + 1);
    const each = (k: number, fn: (cell: number) => void) => {
      const ax = xy[4 * k]!;
      const ay = xy[4 * k + 1]!;
      const bx = xy[4 * k + 2]!;
      const by = xy[4 * k + 3]!;
      const c0 = Math.floor(Math.min(ax, bx)) - this.#gx;
      const c1 = Math.floor(Math.max(ax, bx)) - this.#gx;
      const r0 = Math.floor(Math.min(ay, by)) - this.#gy;
      const r1 = Math.floor(Math.max(ay, by)) - this.#gy;
      for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) fn(r * this.#w + col);
    };
    for (let k = 0; k < n; k++) each(k, (cell) => offsets[cell + 1]!++);
    for (let cell = 0; cell < this.#w * this.#h; cell++) offsets[cell + 1]! += offsets[cell]!;
    const items = new Int32Array(offsets[this.#w * this.#h]!);
    const fill = offsets.slice(0, this.#w * this.#h);
    for (let k = 0; k < n; k++) each(k, (cell) => (items[fill[cell]!++] = k));
    this.#offsets = offsets;
    this.#items = items;
    this.#stamp = new Uint32Array(n);
  }

  /** Calls `visit` once for each segment carrying any of `mask` whose cells meet the closed box. */
  query(x0: number, y0: number, x1: number, y1: number, mask: number, visit: (k: number) => void): void {
    if (this.#w === 0) return;
    const c0 = Math.max(0, Math.floor(x0) - this.#gx);
    const c1 = Math.min(this.#w - 1, Math.floor(x1) - this.#gx);
    const r0 = Math.max(0, Math.floor(y0) - this.#gy);
    const r1 = Math.min(this.#h - 1, Math.floor(y1) - this.#gy);
    if (c0 > c1 || r0 > r1) return;
    const stamp = ++this.#query;
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const cell = r * this.#w + col;
        for (let p = this.#offsets[cell]!; p < this.#offsets[cell + 1]!; p++) {
          const k = this.#items[p]!;
          if (this.#stamp[k] === stamp || !(this.tags[k]! & mask)) continue;
          this.#stamp[k] = stamp;
          visit(k);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stepping an eye off a wall

/*
 * The sixteen directions (a, b) of whole numbers with the larger of |a| and
 * |b| at most 2 and no common factor, clockwise on the y-down map from
 * (1, 2). The order fixes which side an eye exactly on a wall goes to.
 */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 2],
  [0, 1],
  [-1, 2],
  [-1, 1],
  [-2, 1],
  [-1, 0],
  [-2, -1],
  [-1, -1],
  [-1, -2],
  [0, -1],
  [1, -2],
  [1, -1],
  [2, -1],
  [1, 0],
  [2, 1],
  [1, 1],
];
const STEPS = [1 / 64, 1 / 128, 1 / 256];

/**
 * Moves a point (an eye, a light, or an area's origin) off the stored
 * segments it is within WALL_MARGIN of, with a bounded step that never
 * crosses a wall or lands near one (section 4.3.2). Returns the point itself
 * when it is near nothing, the stepped point, or null when none of the 48
 * tries qualifies and the source must fail closed.
 *
 * `index` holds the stored segments (never split pieces, whose rounded ends
 * may sit a hair off their wall), and `mask` picks the set, SIGHT for an
 * eye. Every side decision uses the exact predicate. A point near a wall
 * but not on it moves only away from that wall's line, on its own side, so
 * no step carries it across. A point exactly on a wall's line goes to the
 * side `prefer` is on, when given and not on that line too, and otherwise
 * to either side. The directions are tried in a fixed order, or with
 * `prefer` those nearest the way to it first, so an area's origin on a wall
 * steps toward the creature it starts from where the walls allow.
 */
export function stepOffWalls(px: number, py: number, index: SegmentIndex, mask: number, prefer?: { x: number; y: number }): { x: number; y: number } | null {
  const xy = index.xy;
  const M = WALL_MARGIN;
  const near: { k: number; side: -1 | 0 | 1 }[] = [];
  index.query(px - M, py - M, px + M, py + M, mask, (k) => {
    const ax = xy[4 * k]!;
    const ay = xy[4 * k + 1]!;
    const bx = xy[4 * k + 2]!;
    const by = xy[4 * k + 3]!;
    if (!nearSegment(px, py, ax, ay, bx, by)) return;
    const side = orient(ax, ay, bx, by, px, py);
    near.push({ k, side: side === 0 && prefer ? orient(ax, ay, bx, by, prefer.x, prefer.y) : side });
  });
  if (near.length === 0) return { x: px, y: py };
  const nearSet = new Set(near.map((n) => n.k));
  for (const [a, b] of prefer ? towards(prefer.x - px, prefer.y - py) : DIRECTIONS) {
    let allowed = true;
    for (const { k, side } of near) {
      // The segment's direction is lattice-sized and (a, b) whole, so this cross product is exact.
      const turn = sign((xy[4 * k + 2]! - xy[4 * k]!) * b - (xy[4 * k + 3]! - xy[4 * k + 1]!) * a);
      if (turn === 0 || (side !== 0 && turn !== side)) {
        allowed = false;
        break;
      }
    }
    if (!allowed) continue;
    const scale = Math.max(Math.abs(a), Math.abs(b));
    for (const step of STEPS) {
      const t = step / scale;
      const qx = px + a * t;
      const qy = py + b * t;
      if (clearStep(px, py, qx, qy, index, mask, nearSet)) return { x: qx, y: qy };
    }
  }
  return null;
}

/*
 * DIRECTIONS by how nearly each points along (dx, dy), the fixed order
 * breaking ties. The key is the cosine's sign times its square, which
 * orders them the same as the cosine and needs no square root.
 */
function towards(dx: number, dy: number): (readonly [number, number])[] {
  const keyed = DIRECTIONS.map((d, i) => {
    const dot = d[0] * dx + d[1] * dy;
    return { d, i, key: (dot * Math.abs(dot)) / (d[0] * d[0] + d[1] * d[1]) };
  });
  keyed.sort((p, q) => q.key - p.key || p.i - q.i);
  return keyed.map((k) => k.d);
}

function clearStep(px: number, py: number, qx: number, qy: number, index: SegmentIndex, mask: number, near: ReadonlySet<number>): boolean {
  const xy = index.xy;
  const M = WALL_MARGIN;
  let ok = true;
  index.query(Math.min(px, qx) - M, Math.min(py, qy) - M, Math.max(px, qx) + M, Math.max(py, qy) + M, mask, (k) => {
    if (!ok) return;
    const ax = xy[4 * k]!;
    const ay = xy[4 * k + 1]!;
    const bx = xy[4 * k + 2]!;
    const by = xy[4 * k + 3]!;
    if (nearSegment(qx, qy, ax, ay, bx, by)) {
      ok = false;
      return;
    }
    const meets = contact(px, py, qx, qy, ax, ay, bx, by);
    if (meets === CROSS || (meets === TOUCH && !near.has(k))) ok = false;
  });
  return ok;
}

// ---------------------------------------------------------------------------
// Polygons, as areas of effect and sight rasterize them

/** Flat polygon `[x0, y0, x1, y1, ...]` in cells. */
export type Polygon = Float64Array;

/**
 * Even-odd point-in-polygon. The crossing test is written exactly as in
 * `crossingsAt`, so the two always agree on the same point.
 */
export function pointInPolygon(poly: Polygon, x: number, y: number): boolean {
  const n = poly.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i]!;
    const yi = poly[2 * i + 1]!;
    const xj = poly[2 * j]!;
    const yj = poly[2 * j + 1]!;
    if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

/**
 * A polygon with its edges bucketed by cell row, so the crossings of one
 * horizontal line cost only the edges near that row.
 */
export type PolygonIndex = {
  poly: Polygon;
  row0: number;
  rows: number;
  /** Start of each row's bucket in `edges`, `rows + 1` entries. */
  offsets: Int32Array;
  /** Vertex indices i: the edge runs from vertex i - 1 (wrapping) to vertex i. */
  edges: Int32Array;
};

export function indexPolygon(poly: Polygon, row0: number, rows: number): PolygonIndex {
  const n = poly.length >> 1;
  const offsets = new Int32Array(rows + 1);
  const rowSpan = (i: number): [number, number] => {
    const yi = poly[2 * i + 1]!;
    const yj = poly[2 * (i === 0 ? n - 1 : i - 1) + 1]!;
    // A horizontal edge never crosses a horizontal line, so it needs no bucket.
    if (yi === yj) return [1, 0];
    return [Math.max(row0, Math.floor(Math.min(yi, yj))), Math.min(row0 + rows - 1, Math.floor(Math.max(yi, yj)))];
  };
  for (let i = 0; i < n; i++) {
    const [lo, hi] = rowSpan(i);
    for (let r = lo; r <= hi; r++) offsets[r - row0 + 1]!++;
  }
  for (let r = 0; r < rows; r++) offsets[r + 1]! += offsets[r]!;
  const edges = new Int32Array(offsets[rows]!);
  const fill = offsets.slice(0, rows);
  for (let i = 0; i < n; i++) {
    const [lo, hi] = rowSpan(i);
    for (let r = lo; r <= hi; r++) edges[fill[r - row0]!++] = i;
  }
  return { poly, row0, rows, offsets, edges };
}

/** The sorted x positions where the horizontal line at `y` crosses the polygon. */
export function crossingsAt(index: PolygonIndex, y: number): Float64Array {
  const { poly, offsets, edges } = index;
  const n = poly.length >> 1;
  const r = Math.floor(y) - index.row0;
  if (r < 0 || r >= index.rows) return crossingsSlow(poly, y);
  const out = new Float64Array(offsets[r + 1]! - offsets[r]!);
  let m = 0;
  for (let k = offsets[r]!; k < offsets[r + 1]!; k++) {
    const i = edges[k]!;
    const j = i === 0 ? n - 1 : i - 1;
    const xi = poly[2 * i]!;
    const yi = poly[2 * i + 1]!;
    const xj = poly[2 * j]!;
    const yj = poly[2 * j + 1]!;
    if (yi > y !== yj > y) out[m++] = xi + ((y - yi) * (xj - xi)) / (yj - yi);
  }
  return out.subarray(0, m).sort();
}

function crossingsSlow(poly: Polygon, y: number): Float64Array {
  const n = poly.length >> 1;
  const out: number[] = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i]!;
    const yi = poly[2 * i + 1]!;
    const xj = poly[2 * j]!;
    const yj = poly[2 * j + 1]!;
    if (yi > y !== yj > y) out.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  return Float64Array.from(out).sort();
}

/** Inside when an odd number of crossings lie to the right of x. */
export function insideCrossings(xs: Float64Array, x: number): boolean {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! > x) hi = mid;
    else lo = mid + 1;
  }
  return ((xs.length - lo) & 1) === 1;
}
