import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cornerAt, hexCenter, hexCorners, HEX_R, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { rng } from "#shared/testutil.ts";
import { isometric, toWorld, type ViewPoint } from "../../lib/view.ts";
import { hexesInView } from "./hexSpans.ts";

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
