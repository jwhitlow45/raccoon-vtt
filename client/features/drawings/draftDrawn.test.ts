import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FOG_SUBCELLS } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { liftInPlane } from "../../canvas/isoPlace.ts";
import type { GroundPiece } from "../../canvas/markStand.ts";
import { FogView } from "../../canvas/relief/fogView.ts";
import { isometric, toView, type Turn } from "../../lib/view.ts";

const { draftDrawn } = await import("./DrawingLayer.tsx");

/** A ledge along x = 5: west of it 10 ft, 2 cells of height. */
const ground = (x: number) => (x < 5 ? 2 : 0);
const ALL = new FogView(null, "s1", { w: 16, h: 16 });

/** Fog on a 16 by 16 scene: every sub-cell of cells 0 to 9 on rows 0 to 9 revealed but `hidden`, or only the sub-cells of the cells in `only`. */
function fogOf(hidden: readonly (readonly [number, number])[], only?: readonly (readonly [number, number])[]): FogView {
  const bits = new Uint8Array(TILE_BYTES);
  for (let sy = 0; sy < 10 * FOG_SUBCELLS; sy++) {
    for (let sx = 0; sx < 10 * FOG_SUBCELLS; sx++) {
      if (hidden.some(([hx, hy]) => hx === sx && hy === sy)) continue;
      if (only && !only.some(([cx, cy]) => Math.floor(sx / FOG_SUBCELLS) === cx && Math.floor(sy / FOG_SUBCELLS) === cy)) continue;
      const i = sy * TILE_SUB + sx;
      bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
    }
  }
  return new FogView({ [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } }, "s1", { w: 16, h: 16 });
}

/** The piece a source point draws in, if any: the one whose clip holds it, or the one whole piece. */
function pieceAt(pieces: readonly GroundPiece[], p: { x: number; y: number }): GroundPiece | undefined {
  return pieces.find((piece) => piece.clip === null || piece.clip.some((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h));
}

/** Points along a polyline, densely. */
function along(points: readonly number[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i + 3 < points.length; i += 2) {
    for (let k = 0; k <= 200; k++) {
      const t = k / 200;
      out.push({ x: points[i]! + (points[i + 2]! - points[i]!) * t, y: points[i + 1]! + (points[i + 3]! - points[i + 1]!) * t });
    }
  }
  return out;
}

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

for (const turn of [0, 1, 2, 3] as Turn[]) {
  const view = isometric(turn);
  test(`a stroke drawn across a ledge in Isometric draws each part on its own cell's drawn ground, under the finger, as it will lie stored (ISO34-OPUS-8), turn ${turn}`, () => {
    const points = [3.5, 4.5, 4.5, 4.5, 6.5, 4.5, 7.5, 5];
    for (const fog of [ALL, fogOf([])]) {
      const at = draftDrawn({ fog, turn, ground }, { kind: "free", points }, null, 4, 40);
      assert.deepEqual(at.points, points, "its points stay where they are on the map");
      for (const p of along(points)) {
        const piece = pieceAt(at.pieces, p)!;
        assert.ok(piece, JSON.stringify(p));
        const shown = toView(view, { x: p.x + piece.lift.x, y: p.y + piece.lift.y }, 0);
        assert.ok(close(shown, toView(view, p, ground(p.x))), `${JSON.stringify(p)}: at its ground`);
      }
    }
  });

  test(`a rectangle or an ellipse keeps its shape across a ledge, cut at the ledge, and a polygon's handles ride its corners, turn ${turn}`, () => {
    const rect = draftDrawn({ fog: ALL, turn, ground }, { kind: "rect", points: [3, 2, 7, 4] }, null, 4, 40);
    assert.equal(rect.kind, "rect");
    assert.deepEqual(rect.pieces.map((p) => p.lift), [liftInPlane(turn, 2), { x: 0, y: 0 }]);
    assert.equal(draftDrawn({ fog: ALL, turn, ground }, { kind: "ellipse", points: [6, 2, 8, 4] }, null, 4, 40).pieces.length, 1, "on one ground, one piece");
    const poly = draftDrawn({ fog: ALL, turn, ground }, { kind: "polygon", points: [3, 2, 7, 2, 6, 5] }, null, 4, 40);
    assert.equal(poly.kind, "line");
    assert.deepEqual(poly.handles, poly.points);
    const dot = draftDrawn({ fog: ALL, turn, ground }, null, { x: 4, y: 3 }, 4, 40);
    const piece = pieceAt(dot.pieces, dot.dot!)!;
    assert.ok(close(piece.lift, liftInPlane(turn, 2)), "the text's dot stands on the platform");
  });

  test(`a player's draft beside fog draws nothing over it: its stroke's width, an arrowhead and a polygon's handle count (ISO34-ASTRA-8), turn ${turn}`, () => {
    // Sub-cell (28, 9), in cell 7, 2, is fogged: x 7 to 7.25, y 2.25 to 2.5.
    const fog = fogOf([[28, 9]]);
    const iso = { fog, turn, ground };
    const fogged = { x: 7.1, y: 2.4 };
    // 8 px of width is 0.4 cells: the line's center misses the fogged sub-cell, its half width does not.
    const line = draftDrawn(iso, { kind: "line", points: [6, 2.6, 7.6, 2.6] }, null, 8, 40);
    assert.ok(line.pieces.every((p) => p.clip !== null), "a line a hair from fog is cut");
    assert.equal(pieceAt(line.pieces, fogged), undefined, "no piece takes in the fogged sub-cell");
    assert.ok(pieceAt(line.pieces, { x: 7.3, y: 2.4 }), "while the revealed one beside it shows");
    // An arrow 0.4 cells south of it: its line's half width misses, its head, 4 strokes wide, does not.
    assert.equal(pieceAt(draftDrawn(iso, { kind: "arrow", points: [6, 2.9, 7.1, 2.9] }, null, 4, 40).pieces, fogged), undefined, "an arrow's head");
    // A polygon whose first corner sits 6 px south of the fogged sub-cell at 40 px a cell: its handle is 7 px round.
    assert.equal(pieceAt(draftDrawn(iso, { kind: "polygon", points: [7.125, 2.5 + 6 / 40, 8.5, 4, 8, 5] }, null, 1, 40).pieces, fogged), undefined, "a polygon's handle");
    // Well away from fog and the ledge, it draws whole.
    assert.deepEqual(draftDrawn(iso, { kind: "line", points: [7, 6, 8, 7] }, null, 8, 40).pieces, [{ lift: { x: 0, y: 0 }, clip: null }]);
  });

  test(`a player's stroke wholly over fog shows nothing on a revealed raised top, though the top's drawn place covers it on screen (ISO34-ASTRA-10), turn ${turn}`, () => {
    // Only cell 6, 6 is revealed, on a 10 ft platform: the player's drawn ground is 2 there and 0 elsewhere.
    const fog = fogOf([], [[6, 6]]);
    const seenGround = (x: number, y: number) => (Math.floor(x) === 6 && Math.floor(y) === 6 ? 2 : 0);
    const iso = { fog, turn, ground: seenGround };
    const polygon = [2, 6, 6, 2, 10, 8];
    const at = draftDrawn(iso, { kind: "polygon", points: polygon }, null, 4, 40);
    for (const piece of at.pieces) for (const r of piece.clip ?? []) assert.ok(r.x >= 6 && r.x + r.w <= 7 && r.y >= 6 && r.y + r.h <= 7, `only cell 6, 6: ${JSON.stringify(r)}`);
    // The stroke never crosses that cell, so nothing of it draws: (4, 4) on its first segment among them.
    for (const p of along(polygon.slice(0, 6))) assert.equal(pieceAt(at.pieces, p), undefined, JSON.stringify(p));
    // A stroke across the cell shows there, on the platform's top.
    const across = draftDrawn(iso, { kind: "line", points: [5.5, 6.5, 7.5, 6.5] }, null, 4, 40);
    assert.ok(close(pieceAt(across.pieces, { x: 6.5, y: 6.5 })!.lift, liftInPlane(turn, 2)));
    assert.equal(pieceAt(across.pieces, { x: 5.6, y: 6.5 }), undefined);
  });
}

test("a free stroke's curve bows past its points, so a player's is cut where only the bow reaches fog", () => {
  // Through (2, 6), (6, 6) and (6.4, 2): the curve into (6, 6) dips 0.3 cells south of y = 6 near x = 4.7, over sub-cell (18, 25).
  const fog = fogOf([[18, 25]]);
  const flat = { fog, turn: 0 as Turn, ground: () => 0 };
  assert.equal(pieceAt(draftDrawn(flat, { kind: "free", points: [2, 6, 6, 6, 6.4, 2] }, null, 1, 200).pieces, { x: 4.6, y: 6.3 }), undefined);
  assert.deepEqual(draftDrawn(flat, { kind: "line", points: [2, 6, 6, 6, 6.4, 2] }, null, 1, 200).pieces, [{ lift: { x: 0, y: 0 }, clip: null }], "a straight line through the same points draws whole");
});

test("in Top-down a draft draws as it is, whole: the board layer under the fog clips it", () => {
  const at = draftDrawn(null, { kind: "rect", points: [6, 2, 8, 3] }, { x: 1, y: 1 }, 4, 40);
  assert.deepEqual(at, { kind: "rect", points: [6, 2, 8, 3], handles: [], dot: { x: 1, y: 1 }, pieces: [{ lift: { x: 0, y: 0 }, clip: null }] });
});
