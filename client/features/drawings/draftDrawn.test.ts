import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FOG_SUBCELLS } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { liftInPlane } from "../../canvas/isoPlace.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import { isometric, toView, type Turn } from "../../lib/view.ts";

const { draftDrawn } = await import("./DrawingLayer.tsx");

/** A ledge along x = 5: west of it 10 ft, 2 cells of height. */
const ground = (x: number) => (x < 5 ? 2 : 0);
const ALL = new FogView(null, "s1", { w: 16, h: 16 });

/** Fog with every sub-cell of cells 0 to 9 on rows 0 to 9 revealed but these. */
function fogBut(hidden: readonly (readonly [number, number])[]): FogView {
  const bits = new Uint8Array(TILE_BYTES);
  for (let sy = 0; sy < 10 * FOG_SUBCELLS; sy++) {
    for (let sx = 0; sx < 10 * FOG_SUBCELLS; sx++) {
      if (hidden.some(([hx, hy]) => hx === sx && hy === sy)) continue;
      const i = sy * TILE_SUB + sx;
      bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
    }
  }
  return new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
}

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

for (const turn of [0, 1, 2, 3] as Turn[]) {
  const view = isometric(turn);
  test(`a stroke drawn across a ledge in Isometric draws each point at its own drawn ground, under the finger (ISO34-OPUS-8), turn ${turn}`, () => {
    const points = [3.5, 4.5, 4.5, 4.5, 6.5, 4.5, 7.5, 5];
    const at = draftDrawn({ fog: ALL, turn, ground }, { kind: "free", points }, null, 4, 40);
    assert.equal(at.kind, "free");
    for (let i = 0; i < points.length; i += 2) {
      const p = { x: points[i]!, y: points[i + 1]! };
      assert.ok(close(toView(view, { x: at.points[i]!, y: at.points[i + 1]! }, 0), toView(view, p, ground(p.x))), `point ${i / 2}`);
    }
    assert.equal(at.clip, null, "the DM's draft draws whole");
  });

  test(`a rectangle or an ellipse drawn across a ledge in Isometric is its outline, each point lifted by its own ground, and a polygon's handles ride its corners, turn ${turn}`, () => {
    const rect = draftDrawn({ fog: ALL, turn, ground }, { kind: "rect", points: [3, 2, 7, 4] }, null, 4, 40);
    assert.equal(rect.kind, "polygon");
    const corners = [[3, 2], [7, 2], [7, 4], [3, 4]] as const;
    corners.forEach(([x, y], i) => assert.ok(close(toView(view, { x: rect.points[2 * i]!, y: rect.points[2 * i + 1]! }, 0), toView(view, { x, y }, ground(x))), `corner ${i}`));
    const ellipse = draftDrawn({ fog: ALL, turn, ground }, { kind: "ellipse", points: [3, 2, 7, 4] }, null, 4, 40);
    assert.equal(ellipse.kind, "polygon");
    assert.ok(ellipse.points.length >= 64);
    const poly = draftDrawn({ fog: ALL, turn, ground }, { kind: "polygon", points: [3, 2, 7, 2, 6, 5] }, null, 4, 40);
    assert.equal(poly.kind, "line");
    assert.deepEqual(poly.handles, poly.points);
    const dot = draftDrawn({ fog: ALL, turn, ground }, null, { x: 4, y: 3 }, 4, 40).dot!;
    assert.ok(close(toView(view, dot, 0), toView(view, { x: 4, y: 3 }, 2)), "the text's dot stands on the platform");
  });

  test(`a player's draft beside fog draws only on revealed tops: its stroke's width, an arrowhead and a polygon's handle count (ISO34-ASTRA-8), turn ${turn}`, () => {
    // Sub-cell (28, 9), in cell 7, 2, is fogged, a quarter of a cell north of the stroke's line at y = 2.5.
    const fog = fogBut([[28, 9]]);
    const iso = { fog, turn, ground };
    // 8 px of width is 0.4 cells: the line's center misses the fogged sub-cell, its half width does not.
    const width = 8;
    const line = draftDrawn(iso, { kind: "line", points: [6, 2.6, 7.6, 2.6] }, null, width, 40);
    assert.ok(line.clip, "a line a hair from fog clips");
    const fogged = { x: 28 / FOG_SUBCELLS, y: 9 / FOG_SUBCELLS };
    for (const r of line.clip!) {
      // Lifted by the ground east of the ledge, 0: the clip lies on the cells themselves.
      assert.ok(!(r.y === fogged.y && r.x <= fogged.x && r.x + r.w > fogged.x), `a clip piece took in the fogged sub-cell: ${JSON.stringify(r)}`);
    }
    // An arrow 0.4 cells south of it: its line's half width misses, its head, 4 strokes wide, does not.
    assert.ok(draftDrawn(iso, { kind: "arrow", points: [6, 2.9, 7.1, 2.9] }, null, 4, 40).clip, "an arrow's head");
    // A polygon whose first corner sits 6 px south of the fogged sub-cell at 40 px a cell: its handle is 7 px round.
    assert.ok(draftDrawn(iso, { kind: "polygon", points: [7.125, 2.5 + 6 / 40, 8.5, 4, 8, 5] }, null, 1, 40).clip, "a polygon's handle");
    // Well away from fog and the ledge, it draws whole.
    assert.equal(draftDrawn(iso, { kind: "line", points: [7, 6, 8, 7] }, null, width, 40).clip, null);
    // Across the ledge, each piece lifts by its ground: the west piece by the platform's.
    const ledge = draftDrawn(iso, { kind: "line", points: [4, 7, 6, 7] }, null, width, 40).clip!;
    // Its box starts 1.4 cells west of the line, at sub-cell 2.5.
    const up = liftInPlane(turn, 2);
    assert.ok(ledge.some((r) => Math.abs(r.x - (2.5 + up.x)) < 1e-9 && Math.abs(r.w - 2.5) < 1e-9 && Math.abs(((r.y - up.y) * FOG_SUBCELLS) % 1) < 1e-9), "a piece on the platform's top");
    assert.ok(ledge.some((r) => r.x === 5), "and one on the ground east of the ledge, where it lies");
  });
}

test("a free stroke's curve bows past its points, so a player's clips where only the bow reaches fog", () => {
  // Through (2, 6), (6, 6) and (6.4, 2): the curve into (6, 6) dips 0.3 cells south of y = 6 near x = 4.7, over sub-cell (18, 25).
  const fog = fogBut([[18, 25]]);
  const flat = { fog, turn: 0 as Turn, ground: () => 0 };
  assert.ok(draftDrawn(flat, { kind: "free", points: [2, 6, 6, 6, 6.4, 2] }, null, 1, 200).clip);
  assert.equal(draftDrawn(flat, { kind: "line", points: [2, 6, 6, 6, 6.4, 2] }, null, 1, 200).clip, null, "a straight line through the same points draws whole");
});

test("in Top-down a draft draws as it is, unclipped: the board layer under the fog clips it", () => {
  const at = draftDrawn(null, { kind: "rect", points: [6, 2, 8, 3] }, { x: 1, y: 1 }, 4, 40);
  assert.deepEqual(at, { kind: "rect", points: [6, 2, 8, 3], handles: [], dot: { x: 1, y: 1 }, clip: null });
});
