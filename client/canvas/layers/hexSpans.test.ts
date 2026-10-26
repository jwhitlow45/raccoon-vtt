import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cornerAt, hexCenter, hexCorners, HEX_R, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { rng } from "#shared/testutil.ts";
import { isometric, toWorld, type ViewPoint } from "../../lib/view.ts";
import { hexesInView, hexLinesInView, hexRowSpans, strokeHexLines } from "./hexSpans.ts";

/** Whether a point lies inside a convex polygon, either winding. */
function inside(poly: readonly { x: number; y: number }[], p: { x: number; y: number }): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

describe("hex row spans", () => {
  test("every hex whose center lies in the canvas's ground polygon is listed, and each one listed reaches it", () => {
    const random = rng(26112);
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      const bounds = { w: 60, h: 50 };
      const all = sceneHexes(g, bounds);
      for (let round = 0; round < 20; round++) {
        const turn = Math.floor(random() * 4) as 0 | 1 | 2 | 3;
        // A canvas's corners in view units, seen on the ground.
        const u0 = random() * 40 - 20;
        const v0 = random() * 30;
        const w = 4 + random() * 20;
        const h = 4 + random() * 20;
        const corners = [
          [u0, v0],
          [u0 + w, v0],
          [u0 + w, v0 + h],
          [u0, v0 + h],
        ].map(([u, v]) => toWorld(isometric(turn), { x: u!, y: v! } as ViewPoint));
        const listed = hexesInView(g, bounds, corners);
        const keys = new Set(listed.map((h) => `${h.col},${h.row}`));
        assert.equal(keys.size, listed.length, "no hex twice");
        // A hex any of whose corners or whose center lies in view must draw, so the lines reach the canvas's edge.
        for (const hex of all) {
          const points = [hexCenter(g, hex), ...hexCorners(g, hex).map((c) => cornerAt(g, c))];
          if (points.some((p) => inside(corners, p))) assert.ok(keys.has(`${hex.col},${hex.row}`), `${orient} round ${round}: ${hex.col},${hex.row} left out`);
        }
        for (const hex of listed) {
          const c = hexCenter(g, hex);
          // Within a hex's reach of the polygon: its center inside the polygon grown by a cell.
          const near = corners.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 1 + 2 * HEX_R) || inside(corners, c) || nearEdge(corners, c, 1 + HEX_R);
          assert.ok(near, `${orient} round ${round}: ${hex.col},${hex.row} is far from the view`);
        }
        // Far fewer than the polygon's bounding box holds, for a view turned 45 degrees.
        if (listed.length > 50) {
          const xs = corners.map((p) => p.x);
          const ys = corners.map((p) => p.y);
          const boxed = all.filter((hex) => {
            const c = hexCenter(g, hex);
            return c.x >= Math.min(...xs) && c.x <= Math.max(...xs) && c.y >= Math.min(...ys) && c.y <= Math.max(...ys);
          }).length;
          assert.ok(listed.length < boxed, `${listed.length} listed against ${boxed} in the box`);
        }
      }
    }
  });
});

function nearEdge(poly: readonly { x: number; y: number }[], p: { x: number; y: number }, reach: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    if (Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) <= reach) return true;
  }
  return false;
}

describe("hex lines (hex grids HX-D18)", () => {
  /** A sink that keeps each side drawn, its ends rounded so one side drawn from either hex is one key. */
  function sides() {
    const out: string[] = [];
    let at = { x: 0, y: 0 };
    const key = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    return {
      out,
      moveTo(x: number, y: number) {
        at = { x, y };
      },
      lineTo(x: number, y: number) {
        const a = key(at);
        const b = key({ x, y });
        out.push(a < b ? `${a}|${b}` : `${b}|${a}`);
        at = { x, y };
      },
    };
  }

  /** A hex's six sides as keys, from its corners worked out by the rules (hex.ts cornerAt), to 1/64 of a cell. */
  function hexSides(g: HexGrid, h: { col: number; row: number }): string[] {
    const pts = hexCorners(g, h).map((c) => cornerAt(g, c));
    const near = (p: { x: number; y: number }) => `${(Math.round(p.x * 64) / 64).toFixed(6)},${(Math.round(p.y * 64) / 64).toFixed(6)}`;
    return pts.map((p, i) => {
      const q = pts[(i + 1) % 6]!;
      const a = near(p);
      const b = near(q);
      return a < b ? `${a}|${b}` : `${b}|${a}`;
    });
  }

  test("each side of each hex in view is drawn once, the shared ones by one hex, rows and columns alike", () => {
    const random = rng(26118);
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      for (let round = 0; round < 30; round++) {
        const bounds = { w: 3 + Math.floor(random() * 30), h: 3 + Math.floor(random() * 30) };
        const x0 = random() * bounds.w;
        const y0 = random() * bounds.h;
        const view = [
          { x: x0, y: y0 },
          { x: x0 + 1 + random() * 12, y: y0 },
          { x: x0 + 1 + random() * 12, y: y0 + 1 + random() * 12 },
          { x: x0, y: y0 + 1 + random() * 12 },
        ];
        const spans = hexRowSpans(g, bounds, view);
        const hexes = hexesInView(g, bounds, view);
        const sink = sides();
        const count = strokeHexLines(g, spans, sink);
        assert.equal(count, sink.out.length);
        assert.equal(new Set(sink.out).size, sink.out.length, `${orient} round ${round}: a side drawn twice`);
        // Drawn from centers, a side lies within a hair of the rules' rounded corners: snap both to 1/64 to compare.
        const snapped = new Set(sink.out.map((k) => k.split("|").map((p) => p.split(",").map((v) => (Math.round(Number(v) * 64) / 64).toFixed(6)).join(",")).sort().join("|")));
        const wanted = new Set(hexes.flatMap((h) => hexSides(g, h)));
        assert.deepEqual([...snapped].sort(), [...wanted].sort(), `${orient} round ${round}: the sides of the hexes in view, no more`);
      }
    }
  });

  test("a 30 by 20 hex rows mat draws 22 rows, 30 hexes in even rows and 29 in odd, and its columns mirror it", () => {
    const whole = (b: { w: number; h: number }) => [{ x: -1, y: -1 }, { x: b.w + 1, y: -1 }, { x: b.w + 1, y: b.h + 1 }, { x: -1, y: b.h + 1 }];
    const rows = hexRowSpans({ shape: "hex", orient: "rows" }, { w: 30, h: 20 }, whole({ w: 30, h: 20 }));
    assert.equal(rows.length, 22);
    for (const s of rows) assert.deepEqual([s.c0, s.c1], [0, s.r % 2 === 0 ? 29 : 28], `row ${s.r}`);
    const columns = hexRowSpans({ shape: "hex", orient: "columns" }, { w: 20, h: 30 }, whole({ w: 20, h: 30 }));
    assert.deepEqual(columns, rows);
  });

  test("lines skip while a hex is under 6 px, as a 200 by 200 scene fitted on a phone is, and draw from 6 px", () => {
    const g: HexGrid = { shape: "hex", orient: "rows" };
    const bounds = { w: 200, h: 200 };
    const corners = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }];
    // A 390 px wide phone fits 200 cells at under 2 px a cell.
    assert.equal(hexLinesInView(g, bounds, { corners, pxPerCell: 390 / 200 }, sides()), 0);
    assert.equal(hexLinesInView(g, bounds, { corners, pxPerCell: 5.99 }, sides()), 0);
    assert.ok(hexLinesInView(g, bounds, { corners: corners.map((p) => ({ x: p.x / 4, y: p.y / 4 })), pxPerCell: 6 }, sides()) > 0);
  });
});
