import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { SQUARES } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { hexOutline } from "../../lib/scene.ts";
import { rectHexes } from "#shared/rules/traps.ts";
import type { BuildChunk } from "#shared/model.ts";
import type { PillSpec } from "../../canvas/boardView.ts";
import { segmentDistance } from "../doors/doors.ts";
import { trap as makeTrap } from "#shared/testutil.ts";
import { viewPill } from "../../canvas/relief/isoText.ts";
import { isometric } from "../../lib/view.ts";
import { pillInkReach, pillPlace } from "../measure/pillPlace.ts";

const { trapNamePill, isoTrapNamePill } = await import("./TrapLayer.tsx");

before(() => {
  const context = { font: "", measureText: (text: string) => ({ width: text.length * 7 }) };
  (globalThis as { document?: unknown }).document = { createElement: () => ({ getContext: () => context }) };
});

const scale = 40;
const ground = () => 0;

for (const turn of [0, 1, 2, 3] as const) {
  for (const kind of ["wire", "L zone"] as const) test(`FU40B-SOL-02: a crowded ${kind} name keeps its anchor on the trap at turn ${turn}`, () => {
    const trap = makeTrap("trap", { zone: kind === "wire" ? { wire: { a: [0, 0], b: [20, 20] } } : { cells: [{ x: 0, y: 0, w: 1, h: 10 }, { x: 1, y: 9, w: 9, h: 1 }] } });
    const original = trapNamePill(SQUARES, trap, {}, scale, true)!;
    const view = isometric(turn);
    const occupied = pillInkReach({ ...viewPill(original, view, ground), scale });
    const chosen = isoTrapNamePill(original, SQUARES, trap, {}, { view, ground, boxes: [occupied] }, scale, () => true);
    assert.notDeepEqual(chosen, original, "the original name must be obstructed so a fallback is exercised");
    const candidates: PillSpec[] = [];
    isoTrapNamePill(original, SQUARES, trap, {}, { view, ground, boxes: [] }, scale, (p) => { candidates.push(p); return false; });
    assert.ok(candidates.length >= 10, "both sides of the shape must offer alternative anchors");
    for (const anchor of [...candidates, chosen]) if (kind === "wire") {
      assert.ok(Math.abs(anchor.x - anchor.y) < 1e-9, `the diagonal wire cannot be named from (${anchor.x},${anchor.y}), ${Math.abs(anchor.x - anchor.y) / Math.sqrt(2)} cells off it`);
      assert.ok(anchor.x >= 0 && anchor.x <= 20);
    } else {
      const onTop = (anchor.y === 0 && anchor.x >= 0 && anchor.x <= 1) || (anchor.y === 9 && anchor.x >= 1 && anchor.x <= 10);
      const onBottom = anchor.y === 10 && anchor.x >= 0 && anchor.x <= 10;
      assert.ok(onTop || onBottom, `(${anchor.x},${anchor.y}) must lie on the L's occupied top or bottom edge`);
    }
    const projected = viewPill(chosen, view, ground);
    const placed = pillPlace({ ...projected, scale }, null);
    assert.equal(placed.x, projected.x, "the name stays centered above or below its actual anchor in view space");
    const offset = (chosen.offsetPx ?? 0) / scale;
    assert.ok(Math.abs(placed.y - projected.y - (chosen.above ? -offset : offset)) < 1e-9);
  });
}

for (const orient of ["rows", "columns"] as const) for (const turn of [0, 1, 2, 3] as const) {
  test(`FU40B-SOL-02: hex ${orient} name candidates stay on occupied edges at turn ${turn}`, () => {
    const grid: HexGrid = { shape: "hex", orient };
    const cells = [{ x: 0, y: 0, w: 1, h: 5 }, { x: 1, y: 4, w: 4, h: 1 }];
    const trap = makeTrap("hex trap", { zone: { cells } });
    const original = trapNamePill(grid, trap, {}, scale, true)!;
    const candidates: PillSpec[] = [];
    isoTrapNamePill(original, grid, trap, {}, { view: isometric(turn), ground, boxes: [] }, scale, (p) => { candidates.push(p); return false; });
    const edges = rectHexes(cells).flatMap((h) => {
      const outline = hexOutline(grid, [h]);
      const points = outline.flatMap((x, i) => i % 2 ? [] : [{ x, y: outline[i + 1]! }]);
      return points.map((a, i) => ({ a, b: points[(i + 1) % points.length]! }));
    });
    assert.ok(candidates.length >= 8, "the L-shaped hex zone offers multiple occupied boundaries");
    for (const p of candidates) assert.ok(edges.some(({ a, b }) => segmentDistance(p, a, b) < 1e-9), `(${p.x},${p.y}) is not on an occupied hex edge`);
  });
}

for (const turn of [0, 1, 2, 3] as const) test(`FU40B-SOL-02: diagonal door candidates also remain on their segment at turn ${turn}`, () => {
  const chunks: Record<string, BuildChunk> = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: {}, walls: [{ id: "door", a: [0, 0], b: [2, 2], f: { kind: "door", state: "closed", secret: false, discovered: false } }] } };
  const trap = makeTrap("door trap", { zone: { door: { cx: 0, cy: 0, id: "door" } } });
  const original = trapNamePill(SQUARES, trap, chunks, scale, true)!;
  const candidates: PillSpec[] = [];
  isoTrapNamePill(original, SQUARES, trap, chunks, { view: isometric(turn), ground, boxes: [] }, scale, (p) => { candidates.push(p); return false; });
  assert.equal(candidates.length, 11);
  for (const p of candidates) assert.ok(segmentDistance(p, { x: 0, y: 0 }, { x: 2, y: 2 }) < 1e-9, `(${p.x},${p.y}) is not on its door`);
});

test("FU40B-SOL-02: fogged replacement anchors leave the permitted original name alone", () => {
  const grid: HexGrid = { shape: "hex", orient: "rows" };
  const trap = makeTrap("hex trap", { zone: { cells: [{ x: 0, y: 0, w: 1, h: 5 }, { x: 1, y: 4, w: 4, h: 1 }] } });
  const original = trapNamePill(grid, trap, {}, scale, true)!;
  const chosen = isoTrapNamePill(original, grid, trap, {}, { view: isometric(0), ground, boxes: [] }, scale, (p) => p.x === original.x && p.y === original.y);
  assert.deepEqual(chosen, original, "an unavailable boundary cannot move the name into fog");
});
