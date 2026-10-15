import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APART,
  AREAS,
  type Candidates,
  clipToBox,
  contact,
  countSplit,
  CROSS,
  MOVEMENT,
  nearSegment,
  onSegment,
  orient,
  type Pieces,
  SegmentIndex,
  SIGHT,
  splitSegments,
  stepOffWalls,
  TOUCH,
  WALL_MARGIN,
} from "./segments.ts";

/** Candidates from `[ax, ay, bx, by, tags, free]` rows. */
function cands(rows: readonly (readonly [number, number, number, number, number, 0 | 1])[]): Candidates {
  return {
    xy: Float64Array.from(rows.flatMap((r) => [r[0], r[1], r[2], r[3]])),
    tags: Uint8Array.from(rows.map((r) => r[4])),
    free: Uint8Array.from(rows.map((r) => r[5])),
    n: rows.length,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BIG = { pairs: 1e9, pieces: 1e9 };

function seg(p: Pieces | Candidates, k: number): [number, number, number, number] {
  return [p.xy[4 * k]!, p.xy[4 * k + 1]!, p.xy[4 * k + 2]!, p.xy[4 * k + 3]!];
}

/** Whether two segments share a stretch of line longer than a point. */
function overlapAlongLine(s: number[], t: number[]): boolean {
  const [ax, ay, bx, by] = s as [number, number, number, number];
  const [cx, cy, dx, dy] = t as [number, number, number, number];
  if (orient(ax, ay, bx, by, cx, cy) !== 0 || orient(ax, ay, bx, by, dx, dy) !== 0) return false;
  const alongX = Math.abs(bx - ax) >= Math.abs(by - ay);
  const [s0, s1] = alongX ? [Math.min(ax, bx), Math.max(ax, bx)] : [Math.min(ay, by), Math.max(ay, by)];
  const [t0, t1] = alongX ? [Math.min(cx, dx), Math.max(cx, dx)] : [Math.min(cy, dy), Math.max(cy, dy)];
  return Math.max(s0, t0) < Math.min(s1, t1);
}

/** Fails when two pieces cross or overlap along a line. */
function assertCrossingFree(p: Pieces, label: string): void {
  for (let i = 0; i < p.n; i++) {
    const s = seg(p, i);
    assert.ok(s[0] !== s[2] || s[1] !== s[3], `${label}: piece ${i} has no length`);
    for (let j = i + 1; j < p.n; j++) {
      const t = seg(p, j);
      const c = contact(...s, ...t);
      assert.notEqual(c, CROSS, `${label}: pieces ${s} and ${t} cross`);
      if (c === TOUCH) assert.ok(!overlapAlongLine(s, t), `${label}: pieces ${s} and ${t} overlap`);
    }
  }
}

/** Every piece lies on the stored segments under it and carries exactly their tags, and the pieces cover every stored segment. */
function assertSameGeometry(c: Candidates, p: Pieces, rand: () => number, label: string): void {
  const tol = 1e-9;
  for (let k = 0; k < p.n; k++) {
    const [ax, ay, bx, by] = seg(p, k);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    let tags = 0;
    for (let s = 0; s < c.n; s++) if (nearSegment(mx, my, ...seg(c, s), tol)) tags |= c.tags[s]!;
    assert.equal(p.tags[k], tags, `${label}: piece ${[ax, ay, bx, by]} has tags ${p.tags[k]}, the walls under it ${tags}`);
  }
  for (let s = 0; s < c.n; s++) {
    const [ax, ay, bx, by] = seg(c, s);
    for (let trial = 0; trial < 4; trial++) {
      const t = rand();
      const x = ax + t * (bx - ax);
      const y = ay + t * (by - ay);
      let covered = false;
      for (let k = 0; k < p.n && !covered; k++) covered = nearSegment(x, y, ...seg(p, k), tol) && (p.tags[k]! & c.tags[s]!) === c.tags[s];
      assert.ok(covered, `${label}: ${[x, y]} on ${[ax, ay, bx, by]} is on no piece`);
    }
  }
}

/** A lattice coordinate: a multiple of 1/64, or of a coarser step so walls meet at shared points more often. */
function lattice(rand: () => number, max: number, step: number): number {
  return Math.floor(rand() * (max / step + 1)) * step;
}

/** Random free walls of at most 8 cells, every end on the lattice, inside [0, size]. */
function randomFree(rand: () => number, size: number, count: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  while (out.length < count) {
    const step = rand() < 0.5 ? 1 / 8 : 1 / 64;
    const ax = lattice(rand, size, step);
    const ay = lattice(rand, size, step);
    const bx = Math.min(size, Math.max(0, ax + lattice(rand, 8, step) - 4));
    const by = Math.min(size, Math.max(0, ay + lattice(rand, 8, step) - 4));
    if (ax === bx && ay === by) continue;
    if ((bx - ax) ** 2 + (by - ay) ** 2 > 64) continue;
    out.push([ax, ay, bx, by]);
  }
  return out;
}

function randomScene(rand: () => number, size: number): Candidates {
  const rows: [number, number, number, number, number, 0 | 1][] = [];
  // Grid runs and unit edges that never cross each other, as walls.ts makes them.
  for (let y = 1; y < size; y += 3) rows.push([0, y, size, y, AREAS | MOVEMENT | SIGHT, 0]);
  for (let x = 2; x < size; x += 4) for (let y = 0; y < size; y++) if (y % 3 !== 1 && y % 3 !== 0) rows.push([x, y, x, y + 1, AREAS | MOVEMENT, 0]);
  // Pillar squares.
  for (let p = 0; p < 3; p++) {
    const x = Math.floor(rand() * size);
    const y = Math.floor(rand() * size);
    const lo = 9 / 64;
    const hi = 55 / 64;
    rows.push([x + lo, y + lo, x + hi, y + lo, MOVEMENT | SIGHT, 0], [x + hi, y + lo, x + hi, y + hi, MOVEMENT | SIGHT, 0]);
    rows.push([x + hi, y + hi, x + lo, y + hi, MOVEMENT | SIGHT, 0], [x + lo, y + hi, x + lo, y + lo, MOVEMENT | SIGHT, 0]);
  }
  for (const [ax, ay, bx, by] of randomFree(rand, size, 18)) rows.push([ax, ay, bx, by, rand() < 0.7 ? AREAS | MOVEMENT | SIGHT : AREAS | MOVEMENT, 1]);
  // Free walls along grid lines and along each other, collinear overlaps the split must merge.
  rows.push([1, 1, 3.5, 1, SIGHT, 1], [0.5, 4, 0.5, 6, AREAS, 1], [0.5, 5, 0.5, 9, MOVEMENT, 1], [0.5, 4, 0.5, 6, SIGHT, 1]);
  return cands(rows);
}

describe("orient", () => {
  test("gives the exact side for any doubles, clockwise on the y-down map as 1", () => {
    assert.equal(orient(0, 0, 1, 0, 0, 1), 1);
    assert.equal(orient(0, 0, 1, 0, 0, -1), -1);
    assert.equal(orient(0, 0, 1, 0, 5, 0), 0);
    // A point a hair off a lattice line, where plain arithmetic rounds to zero.
    assert.equal(orient(0, 0, 3, 1, 1.5, 0.5 + 1e-15), 1);
    assert.equal(orient(0, 0, 3, 1, 1.5, 0.5 - 1e-15), -1);
    // 0.1 + 0.2 is not 0.3 in doubles, so these three points are not collinear, and the sign says which way.
    assert.equal(orient(0, 0, 0.1, 0.2, 0.30000000000000004, 0.6000000000000001), orient(0, 0, 1, 2, 3.0000000000000004, 6.000000000000001));
  });

  test("onSegment and contact decide touches exactly", () => {
    assert.ok(onSegment(1.5, 0.5, 0, 0, 3, 1));
    assert.ok(!onSegment(1.5, 0.5 + 1e-15, 0, 0, 3, 1));
    assert.ok(onSegment(3, 1, 0, 0, 3, 1));
    assert.ok(!onSegment(6, 2, 0, 0, 3, 1));
    assert.equal(contact(0, 0, 2, 2, 0, 2, 2, 0), CROSS);
    assert.equal(contact(0, 0, 2, 2, 1, 1, 3, 0), TOUCH);
    assert.equal(contact(0, 0, 2, 2, 2, 2, 3, 0), TOUCH);
    assert.equal(contact(0, 0, 2, 0, 1, 0, 3, 0), TOUCH);
    assert.equal(contact(0, 0, 2, 0, 3, 0, 4, 0), APART);
    assert.equal(contact(0, 0, 2, 0, 0, 1, 2, 1), APART);
    assert.equal(contact(1.5, 0.5 + 1e-15, 1.5, 2, 0, 0, 3, 1), APART);
  });

  test("nearSegment measures to the interior and to the ends", () => {
    assert.ok(nearSegment(1, WALL_MARGIN, 0, 0, 2, 0));
    assert.ok(!nearSegment(1, WALL_MARGIN * 1.01, 0, 0, 2, 0));
    assert.ok(nearSegment(2 + WALL_MARGIN * 0.7, WALL_MARGIN * 0.7, 0, 0, 2, 0));
    assert.ok(!nearSegment(2 + WALL_MARGIN * 0.75, WALL_MARGIN * 0.75, 0, 0, 2, 0));
    assert.ok(nearSegment(1.5, 0.5, 0, 0, 3, 1));
  });
});

describe("splitSegments", () => {
  test("two crossing free walls become four pieces meeting at their crossing", () => {
    const c = cands([
      [0, 0, 2, 2, SIGHT, 1],
      [0, 2, 2, 0, AREAS, 1],
    ]);
    const p = splitSegments(c);
    assert.equal(p.n, 4);
    for (let k = 0; k < 4; k++) assert.ok(seg(p, k).includes(1));
    assertCrossingFree(p, "x");
    assert.deepEqual(countSplit(c, BIG), { pairs: 1, pieces: 2, over: null });
  });

  test("walls through one point off the lattice all split at the same double", () => {
    // Three walls through (1/3, 1/3), which no double holds exactly.
    const c = cands([
      [0, 0, 1, 1, SIGHT, 1],
      [0, 1 / 2, 1 / 2, 1 / 4, SIGHT, 1],
      [0, 1, 1 / 2, 0, SIGHT, 1],
    ]);
    const p = splitSegments(c);
    const ends = new Set<string>();
    for (let k = 0; k < p.n; k++) {
      const [ax, ay, bx, by] = seg(p, k);
      for (const [x, y] of [
        [ax, ay],
        [bx, by],
      ] as const) {
        if (Math.abs(x - 1 / 3) < 1e-9 && Math.abs(y - 1 / 3) < 1e-9) ends.add(`${x},${y}`);
      }
    }
    assert.equal(ends.size, 1, "one shared point");
    assert.equal(p.n, 6);
    assertCrossingFree(p, "concurrent");
  });

  test("a free wall ending on another's interior splits it there", () => {
    const c = cands([
      [0, 1, 4, 1, AREAS, 0],
      [2, 1, 3, 3, SIGHT, 1],
      [1, 0, 1.5, 1, SIGHT, 1],
    ]);
    const p = splitSegments(c);
    // The grid run is cut at 1 and 2 where the free walls end on it.
    const run = Array.from({ length: p.n }, (_, k) => seg(p, k)).filter((s) => s[1] === 1 && s[3] === 1);
    assert.deepEqual(
      run.map((s) => [s[0], s[2]]),
      [
        [0, 1.5],
        [1.5, 2],
        [2, 4],
      ],
    );
    assert.equal(countSplit(c, BIG).pieces, 2);
  });

  test("collinear overlaps become one partition of the line with every tag over each piece", () => {
    const c = cands([
      [0, 0, 0, 10, AREAS, 0],
      [0, 2, 0, 4, SIGHT, 1],
      [0, 3, 0, 6, MOVEMENT, 1],
      [0, 3, 0, 6, MOVEMENT, 1],
      [0, 6, 0, 3, MOVEMENT, 1],
    ]);
    const p = splitSegments(c);
    const pieces = Array.from({ length: p.n }, (_, k) => [...seg(p, k), p.tags[k]!]).sort((a, b) => Math.min(a[1]!, a[3]!) - Math.min(b[1]!, b[3]!));
    assert.deepEqual(
      pieces.map((s) => [Math.min(s[1]!, s[3]!), Math.max(s[1]!, s[3]!), s[4]]),
      [
        [0, 2, AREAS],
        [2, 3, AREAS | SIGHT],
        [3, 4, AREAS | SIGHT | MOVEMENT],
        [4, 6, AREAS | MOVEMENT],
        [6, 10, AREAS],
      ],
    );
    assertCrossingFree(p, "collinear");
    const count = countSplit(c, BIG);
    assert.ok(p.n - c.n <= count.pieces);
  });

  test("grid segments and pillar sides that only meet each other are left whole", () => {
    const c = cands([
      [0, 0, 5, 0, AREAS, 0],
      [2, 0, 2, 3, AREAS, 0],
      [1 + 9 / 64, 1 + 9 / 64, 1 + 55 / 64, 1 + 9 / 64, SIGHT, 0],
    ]);
    assert.deepEqual(countSplit(c, BIG), { pairs: 0, pieces: 0, over: null });
    const p = splitSegments(c);
    assert.deepEqual(Array.from(p.xy), Array.from(c.xy));
  });

  test("random scenes split into pieces that never cross, cover the walls, and stay within the counts", () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 40; trial++) {
      const c = randomScene(rand, 12);
      const p = splitSegments(c);
      assertCrossingFree(p, `trial ${trial}`);
      assertSameGeometry(c, p, rand, `trial ${trial}`);
      const count = countSplit(c, BIG);
      assert.ok(p.n - c.n <= count.pieces, `trial ${trial}: ${p.n - c.n} pieces added, ${count.pieces} counted`);
    }
  });

  test("the same walls in any order split into the same pieces", () => {
    const rand = mulberry32(11);
    const c = randomScene(rand, 10);
    const key = (p: Pieces) =>
      Array.from({ length: p.n }, (_, k) => {
        const [ax, ay, bx, by] = seg(p, k);
        const flip = ax > bx || (ax === bx && ay > by);
        return `${flip ? [bx, by, ax, ay] : [ax, ay, bx, by]}:${p.tags[k]}`;
      })
        .sort()
        .join(";");
    const order = Array.from({ length: c.n }, (_, k) => k).reverse();
    const reversed: Candidates = {
      xy: Float64Array.from(order.flatMap((k) => seg(c, k))),
      tags: Uint8Array.from(order, (k) => c.tags[k]!),
      free: Uint8Array.from(order, (k) => c.free[k]!),
      n: c.n,
    };
    assert.equal(key(splitSegments(reversed)), key(splitSegments(c)));
  });
});

describe("countSplit", () => {
  test("counts each pair of a free wall and a segment that share a cell row and overlap along x once", () => {
    const rand = mulberry32(3);
    for (let trial = 0; trial < 30; trial++) {
      const c = randomScene(rand, 12);
      const box = (k: number) => {
        const [ax, ay, bx, by] = seg(c, k);
        return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
      };
      // Only segments that meet the box around every free wall can pair with one.
      const free = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let k = 0; k < c.n; k++) {
        if (c.free[k] !== 1) continue;
        const b = box(k);
        free.x0 = Math.min(free.x0, b.x0);
        free.y0 = Math.min(free.y0, b.y0);
        free.x1 = Math.max(free.x1, b.x1);
        free.y1 = Math.max(free.y1, b.y1);
      }
      const nearFree = (b: ReturnType<typeof box>) => b.x1 >= free.x0 && b.x0 <= free.x1 && b.y1 >= free.y0 && b.y0 <= free.y1;
      let expected = 0;
      let meeting = 0;
      for (let i = 0; i < c.n; i++) {
        for (let j = i + 1; j < c.n; j++) {
          if (c.free[i] !== 1 && c.free[j] !== 1) continue;
          const s = box(i);
          const t = box(j);
          if (!nearFree(s) || !nearFree(t)) continue;
          const shareRow = Math.floor(s.y0) <= Math.floor(t.y1) && Math.floor(t.y0) <= Math.floor(s.y1);
          if (!shareRow || s.x0 > t.x1 || t.x0 > s.x1) continue;
          expected++;
          if (s.y0 <= t.y1 && t.y0 <= s.y1) meeting++;
        }
      }
      assert.ok(meeting > 0 && meeting < expected, `trial ${trial}: the scene compares pairs that cannot meet`);
      assert.equal(countSplit(c, BIG).pairs, expected, `trial ${trial}`);
    }
  });

  test("walls on a row's lattice lines that overlap along x reach the pairs cap, though none meet another line's", () => {
    // 55 coincident walls on each of one cell row's 64 lattice lines: 95,040 pairs meet, and 6 million are compared.
    const rows: [number, number, number, number, number, 0 | 1][] = [];
    for (let k = 0; k < 3_520; k++) rows.push([50, 50 + (k % 64) / 64, 58, 50 + (k % 64) / 64, SIGHT, 1]);
    assert.deepEqual(countSplit(cands(rows), { pairs: 100_000, pieces: 10_000 }), { pairs: 100_001, pieces: 0, over: "pairs" });
  });

  test("a dense pile of free walls in one cell passes the pairs cap and stops there", () => {
    const rows: [number, number, number, number, number, 0 | 1][] = [];
    for (let k = 0; k < 600; k++) rows.push([10 + (k % 64) / 64, 10, 10 + ((k * 7) % 64) / 64, 11, SIGHT, 1]);
    const count = countSplit(cands(rows), { pairs: 100_000, pieces: 10_000 });
    assert.equal(count.over, "pieces");
    const tight = countSplit(cands(rows), { pairs: 1_000, pieces: 1e9 });
    assert.deepEqual(tight, { pairs: 1_001, pieces: tight.pieces, over: "pairs" });
  });

  test("a lattice of crossing walls passes the pieces cap", () => {
    const rows: [number, number, number, number, number, 0 | 1][] = [];
    for (let k = 0; k < 120; k++) rows.push([0, k / 16, 8, k / 16 + 0.5, SIGHT, 1], [k / 16, 0, k / 16 + 0.5, 8, SIGHT, 1]);
    const count = countSplit(cands(rows), { pairs: 100_000, pieces: 10_000 });
    assert.equal(count.over, "pieces");
    assert.ok(count.pieces > 10_000 && count.pieces <= 10_002);
  });

  test("tiny walls side by side in one cell add no pieces, and every pair compared along x counts", () => {
    const rows: [number, number, number, number, number, 0 | 1][] = [];
    for (let y = 0; y <= 64; y += 2) for (let x = 0; x < 64; x += 2) rows.push([5 + x / 64, 5 + y / 64, 5 + (x + 1) / 64, 5 + y / 64, SIGHT, 1]);
    // The 32 lines in row 5 put 32 walls over each of 32 spans: 32 x (32 x 31 / 2) pairs. The line at y = 6 is a row of its own.
    assert.deepEqual(countSplit(cands(rows), BIG), { pairs: 15_872, pieces: 0, over: null });
  });
});

describe("clipToBox", () => {
  test("cuts segments where they meet the box, and leaves out what lies along a side", () => {
    const box = { x0: 1, y0: 1, x1: 3, y1: 3 };
    const out = clipToBox(Float64Array.from([0, 2, 4, 2, 2, 0, 2, 2, 0, 0, 4, 4, 1, 0, 1, 4, 5, 5, 6, 6, 0, 0, 1, 1, 1.5, 1.5, 2.5, 1.5]), box);
    assert.deepEqual(Array.from(out), [1, 2, 3, 2, 2, 1, 2, 2, 1, 1, 3, 3, 1.5, 1.5, 2.5, 1.5]);
  });

  test("clipped pieces stay in the box, on their walls, touch the box only at their ends, and never cross", () => {
    const rand = mulberry32(5);
    for (let trial = 0; trial < 30; trial++) {
      const c = randomScene(rand, 12);
      const p = splitSegments(c);
      const flat = p.xy;
      const onLattice = trial % 2 === 0;
      const x0 = onLattice ? Math.floor(rand() * 6 * 64) / 64 : rand() * 6;
      const y0 = onLattice ? Math.floor(rand() * 6 * 64) / 64 : rand() * 6;
      const box = { x0, y0, x1: x0 + 1 + (onLattice ? Math.floor(rand() * 5 * 64) / 64 : rand() * 5), y1: y0 + 1 + (onLattice ? Math.floor(rand() * 5 * 64) / 64 : rand() * 5) };
      const out = clipToBox(flat, box);
      const clipped: Pieces = { xy: out, tags: new Uint8Array(out.length / 4), n: out.length / 4 };
      assertCrossingFree(clipped, `trial ${trial}`);
      for (let k = 0; k < clipped.n; k++) {
        const [ax, ay, bx, by] = seg(clipped, k);
        for (const v of [ax, bx]) assert.ok(v >= box.x0 && v <= box.x1);
        for (const v of [ay, by]) assert.ok(v >= box.y0 && v <= box.y1);
        const onWall = Array.from({ length: p.n }, (_, m) => seg(p, m)).some((s) => nearSegment(ax, ay, ...s, 1e-9) && nearSegment(bx, by, ...s, 1e-9));
        assert.ok(onWall, `trial ${trial}: ${[ax, ay, bx, by]} is on no piece`);
        // Only the ends may lie on the box's sides.
        assert.ok(!(ax === bx && (ax === box.x0 || ax === box.x1)) && !(ay === by && (ay === box.y0 || ay === box.y1)), "along a side");
      }
    }
  });
});

describe("stepOffWalls", () => {
  function index(rows: readonly (readonly [number, number, number, number])[]): SegmentIndex {
    return new SegmentIndex(Float64Array.from(rows.flat()), new Uint8Array(rows.length).fill(SIGHT));
  }

  /** The step's promises: off every wall by the margin, and no wall crossed on the way. */
  function assertClear(idx: SegmentIndex, from: { x: number; y: number }, to: { x: number; y: number }): void {
    const xy = idx.xy;
    for (let k = 0; k < xy.length / 4; k++) {
      const s = [xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!] as const;
      assert.ok(!nearSegment(to.x, to.y, ...s), `${to.x},${to.y} is near ${s}`);
      assert.notEqual(contact(from.x, from.y, to.x, to.y, ...s), CROSS, `the step crosses ${s}`);
    }
    const d = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    assert.ok(d < 1 / 32 && d >= 1 / 512);
  }

  test("a point near no wall stays where it is", () => {
    const idx = index([[2, 0, 2, 4]]);
    assert.deepEqual(stepOffWalls(1, 1, idx, SIGHT), { x: 1, y: 1 });
    // The two eyes beside a wall that rounding once carried across it: both are farther than the margin, so nothing moves.
    assert.deepEqual(stepOffWalls(1.0149, 4.5, index([[65 / 64, 0, 65 / 64, 8]]), SIGHT), { x: 1.0149, y: 4.5 });
    assert.deepEqual(stepOffWalls(0.995, 0.5, index([[1, 0, 1, 2]]), SIGHT), { x: 0.995, y: 0.5 });
  });

  test("an eye near a wall but not on it keeps its side", () => {
    const idx = index([[2, 0, 2, 4]]);
    const west = { x: 2 - 1 / 8192, y: 1.3 };
    const a = stepOffWalls(west.x, west.y, idx, SIGHT)!;
    assert.ok(a.x < 2);
    assertClear(idx, west, a);
    const east = { x: 2 + 1 / 8192, y: 1.3 };
    const b = stepOffWalls(east.x, east.y, idx, SIGHT)!;
    assert.ok(b.x > 2);
    assertClear(idx, east, b);
  });

  test("an eye exactly on a wall goes to one fixed side", () => {
    const idx = index([[2, 0, 2, 4]]);
    const a = stepOffWalls(2, 1.3, idx, SIGHT)!;
    assert.deepEqual(a, { x: 2 + 1 / 128, y: 1.3 + 1 / 64 });
    assertClear(idx, { x: 2, y: 1.3 }, a);
  });

  test("a point exactly on a wall goes to the side it prefers, unless the preferred point is on the wall's line too", () => {
    const idx = index([[2, 0, 2, 4]]);
    const on = { x: 2, y: 1.3 };
    const west = stepOffWalls(on.x, on.y, idx, SIGHT, { x: 1.5, y: 1.3 })!;
    assert.ok(west.x < 2);
    assertClear(idx, on, west);
    const east = stepOffWalls(on.x, on.y, idx, SIGHT, { x: 2.5, y: 3 })!;
    assert.ok(east.x > 2);
    assertClear(idx, on, east);
    // A preferred point on the wall's own line picks no side, only the way to try first.
    const along = stepOffWalls(on.x, on.y, idx, SIGHT, { x: 2, y: 3.5 })!;
    assert.notEqual(orient(2, 0, 2, 4, along.x, along.y), 0);
    assertClear(idx, on, along);
    // Near a wall but not on it, a point keeps its own side whatever it prefers.
    assert.ok(stepOffWalls(2 - 1 / 8192, 1.3, idx, SIGHT, { x: 3, y: 1.3 })!.x < 2);
  });

  test("walls 1/64 cell apart: the step lands between them", () => {
    const idx = index([
      [2, 0, 2, 4],
      [2 + 1 / 64, 0, 2 + 1 / 64, 4],
      [0, 1, 4, 1],
    ]);
    const from = { x: 2, y: 1 };
    const a = stepOffWalls(from.x, from.y, idx, SIGHT)!;
    assert.ok(a.x > 2 && a.x < 2 + 1 / 64);
    assertClear(idx, from, a);
  });

  test("junctions of three and four walls", () => {
    const four = index([
      [0, 2, 2, 2],
      [2, 2, 4, 2],
      [2, 0, 2, 2],
      [2, 2, 2, 4],
    ]);
    const a = stepOffWalls(2, 2, four, SIGHT)!;
    assertClear(four, { x: 2, y: 2 }, a);
    const three = index([
      [0, 2, 2, 2],
      [2, 2, 4, 2],
      [2, 2, 3, 4],
    ]);
    const b = stepOffWalls(2, 2, three, SIGHT)!;
    assertClear(three, { x: 2, y: 2 }, b);
  });

  test("a wall parallel to the first direction is never slid along", () => {
    const idx = index([[0, 0, 2, 4]]);
    const a = stepOffWalls(1, 2, idx, SIGHT)!;
    assert.notEqual(orient(0, 0, 2, 4, a.x, a.y), 0);
    assert.deepEqual(a, { x: 1, y: 2 + 1 / 64 });
    assertClear(idx, { x: 1, y: 2 }, a);
  });

  test("an eye on a wall's end", () => {
    const idx = index([
      [0, 0, 2, 0],
      [2, 0, 2, -3],
    ]);
    const a = stepOffWalls(2, 0, idx, SIGHT)!;
    assertClear(idx, { x: 2, y: 0 }, a);
  });

  test("an eye on a stored wall that another wall splits steps the same with or without that wall", () => {
    const wall = [0, 0, 3, 1] as const;
    // From (1, 1) to (1.25, 0.25): crosses the wall at (1.2, 0.4), off the lattice.
    const splitter = [1, 1, 1.25, 0.25] as const;
    for (const eye of [
      { x: 1.5, y: 0.5 },
      { x: 1.5, y: 0.5 + 1e-15 },
      { x: 1.5, y: 0.5 - 1e-15 },
    ]) {
      const alone = stepOffWalls(eye.x, eye.y, index([wall]), SIGHT)!;
      const split = stepOffWalls(eye.x, eye.y, index([wall, splitter]), SIGHT)!;
      assert.deepEqual(split, alone);
      const side = orient(...wall, eye.x, eye.y);
      if (side !== 0) assert.equal(orient(...wall, alone.x, alone.y), side, `${eye.y} keeps its side`);
      assertClear(index([wall, splitter]), eye, alone);
    }
  });

  test("fails closed when every step lands near a wall or crosses one", () => {
    // A mesh of walls 1/1024 apart around the eye: test data, finer than any stored wall can be.
    const rows: [number, number, number, number][] = [];
    for (let k = -40; k <= 40; k++) {
      rows.push([2 + k / 1024, 1.9, 2 + k / 1024, 2.1], [1.9, 2 + k / 1024, 2.1, 2 + k / 1024]);
    }
    assert.equal(stepOffWalls(2, 2, index(rows), SIGHT), null);
  });

  test("only the segments in the mask count", () => {
    const idx = new SegmentIndex(Float64Array.from([2, 0, 2, 4]), Uint8Array.from([AREAS]));
    assert.deepEqual(stepOffWalls(2, 1, idx, SIGHT), { x: 2, y: 1 });
  });
});

describe("SegmentIndex", () => {
  test("finds each segment whose cells meet a box once, a segment on a cell line from both sides", () => {
    const idx = new SegmentIndex(Float64Array.from([0, 2, 5, 2, 1.5, 0.5, 4.5, 3.5, 9, 9, 10, 9]), Uint8Array.from([SIGHT, SIGHT, AREAS]));
    const found = (x0: number, y0: number, x1: number, y1: number, mask = SIGHT) => {
      const out: number[] = [];
      idx.query(x0, y0, x1, y1, mask, (k) => out.push(k));
      return out.sort();
    };
    assert.deepEqual(found(0, 0, 10, 10), [0, 1]);
    assert.deepEqual(found(0, 0, 10, 10, AREAS), [2]);
    assert.deepEqual(found(0.2, 1.2, 0.8, 1.8), []);
    assert.deepEqual(found(0.2, 1.2, 0.8, 2), [0]);
    assert.deepEqual(found(0.2, 2.2, 0.8, 2.8), [0]);
  });
});

describe("determinism", () => {
  /*
   * Sight's "seen" marks are stored facts, so the code behind them may use
   * only arithmetic that every engine rounds alike (docs/design-v1-maps-vision.md
   * 4.3.4). This file and vision.ts, and everything they import other than
   * types, must not call these. heights.test.ts checks heights.ts the same way.
   */
  const banned = /Math\.(atan2|sin|cos|sqrt|hypot|pow|exp)\b|\*\*/;

  function closure(entry: string): string[] {
    const require = createRequire(entry);
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      const imports = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g;
      for (const m of source.matchAll(imports)) {
        if (m[1]) continue;
        const spec = m[2]!;
        let target: string;
        if (spec.startsWith(".")) target = resolve(dirname(file), spec);
        else target = file.includes("node_modules") ? resolve(dirname(file), spec) : require.resolve(spec);
        queue.push(target);
      }
    }
    return [...seen];
  }

  test("segments.ts and its imports call no function engines may round differently", () => {
    const files = closure(fileURLToPath(new URL("./segments.ts", import.meta.url)));
    assert.ok(files.some((f) => f.includes("robust-predicates")), "the predicate's own source is checked");
    for (const file of files) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const hit = source.match(banned);
      assert.equal(hit, null, `${file} uses ${hit?.[0]}`);
    }
  });

  test("vision.ts and its imports call none either, and take the wall set without importing walls.ts", () => {
    const files = closure(fileURLToPath(new URL("./vision.ts", import.meta.url)));
    for (const name of ["segments.ts", "heights.ts", "footprint.ts", "robust-predicates"]) assert.ok(files.some((f) => f.includes(name)), `${name} is checked`);
    assert.ok(!files.some((f) => f.endsWith("/walls.ts")), "walls.ts sweeps areas with atan2, so sight receives its wall set instead");
    for (const file of files) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const hit = source.match(banned);
      assert.equal(hit, null, `${file} uses ${hit?.[0]}`);
    }
  });
});
