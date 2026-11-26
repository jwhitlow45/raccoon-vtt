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
import { boxCoversOutline, cornersOf, drawnBox, outlineOf } from "../floors/linkMarks.ts";

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

for (const orient of ["rows", "columns"] as const) {
  test(`FU40B-OPUS-7: a multi-hex trap's name on hex ${orient} sits on its outline, so an unobstructed isometric name keeps the anchor Top-down draws`, () => {
    const grid: HexGrid = { shape: "hex", orient };
    for (const cells of [[{ x: 0, y: 0, w: 2, h: 1 }], [{ x: 2, y: 3, w: 4, h: 2 }], [{ x: 0, y: 0, w: 1, h: 5 }, { x: 1, y: 4, w: 4, h: 1 }]]) {
      const trap = makeTrap("hex trap", { zone: { cells } });
      const original = trapNamePill(grid, trap, {}, scale, true)!;
      const sides = rectHexes(cells).flatMap((h) => {
        const outline = hexOutline(grid, [h]);
        const points = outline.flatMap((x, i) => (i % 2 ? [] : [{ x, y: outline[i + 1]! }]));
        return points.map((a, i) => ({ a, b: points[(i + 1) % points.length]! }));
      });
      assert.ok(sides.some(({ a, b }) => segmentDistance(original, a, b) < 1e-9), `(${original.x},${original.y}) is not on a hex side`);
      const top = Math.min(...sides.map(({ a }) => a.y));
      assert.ok(Math.abs(original.y - top) < 1e-9, "on the zone's top");
      if (orient === "columns") assert.ok(sides.some(({ a, b }) => Math.abs(a.y - b.y) < 1e-9 && Math.abs((a.x + b.x) / 2 - original.x) < 1e-9), "at the middle of a level top side");
      for (const turn of [0, 1, 2, 3] as const) {
        const chosen = isoTrapNamePill(original, grid, trap, {}, { view: isometric(turn), ground, boxes: [] }, scale, () => true);
        assert.deepEqual(chosen, original, `turn ${turn}`);
      }
    }
  });
}

/*
 * Isometric: the name stands upright over the turned ground, so a spot clear
 * of a floor link's frame in Top-down can cover it on screen (QF-ASTRA-02).
 * Frames are tried at every place round a trap, at all four turns: where the
 * old pick covers one, the new pick must not, whenever another candidate is clear.
 */
for (const turn of [0, 1, 2, 3] as const) test(`QF-ASTRA-02: an isometric trap name keeps off the frame of a floor link beside it at turn ${turn}`, () => {
  const trap = makeTrap("Hidden Pit by the stairs", { zone: { cells: [{ x: 6, y: 6, w: 2, h: 1 }] } });
  const original = trapNamePill(SQUARES, trap, {}, scale, true)!;
  const view = isometric(turn);
  const space = { turn, ground };
  const names = { view, ground, boxes: [] };
  const covers = (p: PillSpec, frames: ReturnType<typeof outlineOf>[]) => frames.some((o) => boxCoversOutline(drawnBox(p, scale, space, true, true), cornersOf(o), space));
  let tried = 0;
  let fixed = 0;
  let leant = 0;
  const cases: { x: number; y: number; w: number; h: number }[][] = [];
  for (let x = 2; x <= 12; x++) for (let y = 2; y <= 10; y++) for (const [w, h] of [[2, 1], [1, 2], [2, 2]] as const) if (!(x < 8 && x + w > 6 && y < 7 && y + h > 6)) cases.push([{ x, y, w, h }]);
  // A pair on either side of the trap, as a hole and stairs beside a pit are.
  for (let a = 3; a <= 5; a++) for (let b = 9; b <= 10; b++) for (let dy = -2; dy <= 1; dy++) cases.push([{ x: a, y: 6 + dy, w: 2, h: 2 }, { x: b, y: 6 + dy, w: 2, h: 2 }]);
  for (let a = 3; a <= 5; a++) for (let b = 7; b <= 8; b++) for (let dx = -2; dx <= 1; dx++) cases.push([{ x: 6 + dx, y: a, w: 2, h: 2 }, { x: 6 + dx, y: b, w: 2, h: 2 }]);
  for (const rects of cases) {
    const frames = rects.map((r) => outlineOf(SQUARES, r));
    const before = isoTrapNamePill(original, SQUARES, trap, {}, names, scale, () => true);
    if (!covers(before, frames)) continue;
    tried++;
    const after = isoTrapNamePill(original, SQUARES, trap, {}, names, scale, () => true, frames, space);
    const spots: PillSpec[] = [];
    isoTrapNamePill(original, SQUARES, trap, {}, names, scale, (p) => { spots.push(p); return false; });
    const leaning = spots.flatMap((p) => [{ ...p, side: "right" as const }, { ...p, side: "left" as const }]);
    if (spots.some((p) => !covers(p, frames)) || leaning.some((p) => !covers(p, frames))) {
      assert.ok(!covers(after, frames), `frames ${JSON.stringify(rects)}: the name at ${JSON.stringify(after)} covers it though ${spots.length} spots were offered`);
      fixed++;
      if (spots.every((p) => covers(p, frames))) leant++;
    }
  }
  assert.ok(tried > 0 && fixed > 0, `the old pick covered a frame in ${tried} places and the new one cleared ${fixed}`);
  assert.ok(leant > 0, "some frame is met from every spot on the trap's edges and only a leaning name clears it");
});
