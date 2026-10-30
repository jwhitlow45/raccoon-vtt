import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReactElement } from "react";
import type { Affine } from "../../canvas/fogSeam.ts";
import { PARTY_PALETTE, VEIL_PALETTE } from "./sightRaster.ts";

const { SightSurface, sightPaint } = await import("./SightOverlay.tsx");
type Rect = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };

/** Exact area of a transformed rectangle inside one device pixel. */
function coverage(t: Affine, r: Rect, x: number, y: number): number {
  let poly: Point[] = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([u, v]) => ({ x: t.a * u! + t.c * v! + t.e, y: t.b * u! + t.d * v! + t.f }));
  for (const [axis, edge, sign] of [["x", x, 1], ["x", x + 1, -1], ["y", y, 1], ["y", y + 1, -1]] as const) {
    const next: Point[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const insideA = (a[axis] - edge) * sign >= 0;
      const insideB = (b[axis] - edge) * sign >= 0;
      if (insideA) next.push(a);
      if (insideA !== insideB) {
        const f = (edge - a[axis]) / (b[axis] - a[axis]);
        next.push({ x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) });
      }
    }
    poly = next;
  }
  return Math.abs(poly.reduce((sum, p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return sum + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
}

test("FOGEDGE-ISO-SIGHT: partial edge pixels receive one full unseen tint at every turn and ratio", () => {
  for (const mode of ["veil", "party"] as const) {
    const expected = (mode === "party" ? PARTY_PALETTE : VEIL_PALETTE)[0][3] / 255;
    for (const turn of [0, 1, 2, 3]) for (const ratio of [1, 1.25, 2, 3]) {
      const angle = (45 + turn * 90) * Math.PI / 180;
      const scale = 23.37 * ratio;
      const t = { a: Math.cos(angle) * scale, b: Math.sin(angle) * scale / 2, c: -Math.sin(angle) * scale, d: Math.cos(angle) * scale / 2, e: 100.37, f: 50.13 };
      const paint = sightPaint(mode, true);
      const props = { drawn: { ok: true, canvas: {} as HTMLCanvasElement, palette: paint.palette }, w: 8, h: 6, version: 0, isometric: true, opacity: paint.opacity };
      const tree = SightSurface(props) as ReactElement<{ children?: ReactElement; opacity?: number; isolated?: boolean; sceneFunc?: (ctx: unknown) => void }>;
      const shape = (tree.props.children ?? tree) as ReactElement<{ sceneFunc(ctx: unknown): void }>;
      const groupOpacity = tree.props.opacity ?? 1;
      const isolated = tree.props.isolated === true;
      const path: Rect[] = [];
      let hole: Rect | undefined;
      let frameAlpha = 0;
      const g = {
        fillStyle: "", imageSmoothingEnabled: false,
        save() {}, restore() {}, getTransform: () => t,
        beginPath: () => { path.length = 0; },
        rect: (x: number, y: number, w: number, h: number) => path.push({ x, y, w, h }),
        fill: () => { hole = path[1]; frameAlpha = Number(g.fillStyle.match(/, ([\d.]+)\)$/)?.[1]); },
        clip() { assert.fail("slanted edges must not clip the raster"); },
        drawImage() {},
      };
      shape.props.sceneFunc({ _context: g });
      assert.ok(hole);
      let checked = 0;
      // Pixels around each scene edge, including the reported west-edge sample.
      for (const [wx, wy] of [[0, 3], [8, 3], [4, 0], [4, 6]]) {
        const px = Math.floor(t.a * wx! + t.c * wy! + t.e);
        const py = Math.floor(t.b * wx! + t.d * wy! + t.f);
        for (let x = px - 1; x <= px + 1; x++) for (let y = py - 1; y <= py + 1; y++) {
          const imageCover = coverage(t, { x: 0, y: 0, w: 8, h: 6 }, x, y);
          if (imageCover <= 0.01 || imageCover >= 0.99) continue;
          const frame = (1 - coverage(t, hole, x, y)) * frameAlpha * (isolated ? 1 : groupOpacity);
          const image = imageCover * paint.palette[0][3] / 255 * (isolated ? 1 : groupOpacity);
          const combined = (image + frame * (1 - image)) * (isolated ? groupOpacity : 1);
          assert.ok(Math.abs(combined - expected) < 1 / 255, `${mode}, turn ${turn}, ratio ${ratio}: alpha ${combined} wanted ${expected}`);
          checked++;
        }
      }
      assert.ok(checked > 0);
    }
  }
});

test("FOGEDGE-ISO-SIGHT: isolated colors preserve sight levels and Top-down keeps its exact palette", () => {
  for (const mode of ["veil", "party"] as const) {
    const original = mode === "party" ? PARTY_PALETTE : VEIL_PALETTE;
    assert.deepEqual(sightPaint(mode, false), { palette: original, opacity: 1 });
    const paint = sightPaint(mode, true);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(paint.palette[i]!.slice(0, 3), original[i]!.slice(0, 3));
      assert.ok(Math.abs(Math.round(paint.palette[i]![3]) * paint.opacity - original[i]![3]) < 0.5);
    }
  }
});
