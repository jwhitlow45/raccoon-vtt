import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setBoardInterfaceScale } from "../../lib/boardScale.ts";
import type { Box } from "../../lib/boardText.ts";

const { boardViewOf } = await import("../../canvas/boardView.ts");
const { leaningTag, pillGeometry, pillPlace, pillStackPlace } = await import("./Pill.tsx");
const { theme } = await import("../../lib/theme.ts");

/*
 * The board's readouts (docs/design-v1-look-pass-2.md 2.11): one size at
 * every zoom, grown with the interface size, kept inside the map the bars
 * leave clear, and a drag's label and its warnings placed as one stack.
 */

/** Runs `fn` at an interface size, then puts 100% back. */
function at<T>(ui: number, fn: () => T): T {
  setBoardInterfaceScale(ui);
  try {
    return fn();
  } finally {
    setBoardInterfaceScale(1);
  }
}

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} against ${b}`);
const inside = (box: Box, view: Box, what: string) =>
  assert.ok(box.x0 >= view.x0 - 1e-9 && box.y0 >= view.y0 - 1e-9 && box.x1 <= view.x1 + 1e-9 && box.y1 <= view.y1 + 1e-9, `${what}: ${JSON.stringify(box)} leaves ${JSON.stringify(view)}`);
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe("a readout's size", () => {
  test("a ruler's total grows with the interface size and keeps one size at every zoom", () => {
    const base = pillGeometry({ value: "30 ft", scale: 40, size: "screen" });
    for (const ui of [0.85, 1.15, 1.3]) {
      const g = at(ui, () => pillGeometry({ value: "30 ft", scale: 40, size: "screen" }));
      const zoomed = at(ui, () => pillGeometry({ value: "30 ft", scale: 90, size: "screen" }));
      assert.equal(g.fontSize, Math.round(15 * ui * 2) / 2, `the text at ${ui}`);
      assert.ok(Math.abs(g.height / base.height - ui) < 0.03, `the height at ${ui}: ${g.height} against ${base.height}`);
      assert.ok(Math.abs(g.width / base.width - ui) < 0.06, `the width at ${ui}: ${g.width} against ${base.width}`);
      assert.deepEqual(zoomed, g, "the zoom changes nothing");
    }
  });

  test("a small readout's padding and a pointed pill's pointer grow with it", () => {
    const base = pillGeometry({ value: "No way through", scale: 40, size: "screen", small: true, above: true });
    const big = at(1.3, () => pillGeometry({ value: "No way through", scale: 40, size: "screen", small: true, above: true }));
    assert.equal(base.padding, 4);
    assert.equal(big.padding, 5);
    assert.equal(base.pointer, 6);
    assert.equal(big.pointer, 8);
    // The box token labels keep off is the box drawn: the pointer counts in it.
    const box = at(1.3, () => pillPlace({ x: 10, y: 10, scale: 40, value: "No way through", size: "screen", small: true, above: true }, null).box);
    near((box.y1 - box.y0) * 40, big.height + big.pointer, "the pointed box's height");
  });

  test("a map pill keeps following the map, its size already holding the interface size", () => {
    const base = pillGeometry({ name: "Fireball", scale: 40, size: "map", small: true });
    const big = at(1.3, () => pillGeometry({ name: "Fireball", scale: 40, size: "map", small: true }));
    assert.equal(base.fontSize, 12);
    assert.equal(big.fontSize, 15.5);
  });
});

describe("where a readout slides", () => {
  // A 390 x 844 phone: the map's camera, and the bars over it.
  const cam = { x: 0, y: 100, scale: 20 };
  const size = { width: 390, height: 844 };
  const insets = { top: 52, right: 0, bottom: 113, left: 0 };

  test("the board's view is the canvas less the bars, in cells", () => {
    const view = boardViewOf(cam, size, insets);
    near(view.x0, 0, "left");
    near(view.y0, (52 - 100) / 20, "top: under the top bar");
    near(view.x1, 390 / 20, "right");
    near(view.y1, (844 - 113 - 100) / 20, "bottom: over the toolbar and the tool's options");
    const bare = boardViewOf(cam, size, { top: 0, right: 0, bottom: 0, left: 0 });
    near(bare.y0, -100 / 20, "no bars, the canvas's edge");
  });

  test("a total at the top bar slides under it, not under the bar, at 100% and 130%", () => {
    const view = boardViewOf(cam, size, insets);
    for (const ui of [1, 1.3]) {
      const place = at(ui, () => pillPlace({ x: 5, y: -3.5, scale: 20, value: "45 ft", size: "screen", offsetPx: 18 }, view));
      inside(place.box, view, `at ${ui}`);
      near(place.box.y0, view.y0 + 4 / 20, `its top 4 px under the bar at ${ui}`);
    }
  });
});

describe("a stack of readouts", () => {
  const cam = { x: 0, y: 0, scale: 20 };
  const view = boardViewOf(cam, { width: 390, height: 844 }, { top: 52, right: 0, bottom: 113, left: 0 });
  const label = { value: "35 ft · 5 ft left\n+5 ft for difficult terrain", size: "screen" as const, color: "#fff" };
  const ends = { value: "Ends in Goblin 2's space", size: "screen" as const, color: "#fa0", small: true };
  const crosses = { value: "Crosses Hidden Pit", size: "screen" as const, color: "#fa0", small: true };

  /** Each pill's box in a stack's place, from its corner and its own size. */
  function boxes(input: Parameters<typeof pillStackPlace>[0], ui: number): Box[] {
    return at(ui, () => {
      const place = pillStackPlace(input, view);
      return input.pills.map((p, i) => {
        const g = pillGeometry({ ...p, scale: input.scale });
        const c = place.places[i]!;
        return { x0: c.x, y0: c.y, x1: c.x + g.width / input.scale, y1: c.y + g.height / input.scale };
      });
    });
  }

  test("stands label first, each warning under the last, all at one left edge", () => {
    const [a, b, c] = boxes({ x: 5, y: 10, scale: 20, offsetPx: 4, pills: [label, ends, crosses] }, 1);
    near(a!.x0, 5 + 4 / 20, "the label's corner is the point and the offset");
    near(b!.y0, a!.y1 + 4 / 20, "a 4 px gap");
    near(c!.y0, b!.y1 + 4 / 20, "a 4 px gap");
    assert.equal(a!.x0, b!.x0);
    assert.equal(b!.x0, c!.x0);
  });

  for (const ui of [1, 1.3]) {
    test(`clamped as one box at the bottom-right corner at ${Math.round(ui * 100)}%: no warning leaves the view or lands on the label`, () => {
      // The drop at the map's bottom-right corner, under the toolbar.
      const corner = { x: view.x1 - 0.2, y: view.y1 - 0.2 };
      const placed = boxes({ ...corner, scale: 20, offsetPx: 4, pills: [label, ends, crosses] }, ui);
      for (const [i, box] of placed.entries()) inside(box, view, `pill ${i}`);
      for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!overlaps(placed[i]!, placed[j]!), `pills ${i} and ${j} overlap`);
      const whole = at(ui, () => pillStackPlace({ ...corner, scale: 20, offsetPx: 4, pills: [label, ends, crosses] }, view).box);
      near(whole.y1, view.y1 - 4 / 20, "the stack's foot 4 px over the bars");
      near(whole.x1, Math.max(...placed.map((b) => b.x1)), "as wide as its widest pill");
      near(whole.x1, view.x1 - 4 / 20, "its widest pill 4 px in from the edge");
    });
  }

  test("held at the other edges as one box too", () => {
    for (const point of [
      { x: view.x0 - 3, y: 20 },
      { x: 8, y: view.y0 - 3 },
      { x: view.x0 - 3, y: view.y0 - 3 },
    ]) {
      const placed = boxes({ ...point, scale: 20, offsetPx: 4, pills: [label, ends, crosses] }, 1.3);
      for (const [i, box] of placed.entries()) inside(box, view, `pill ${i} from ${JSON.stringify(point)}`);
      assert.ok(placed[1]!.y0 > placed[0]!.y1 && placed[2]!.y0 > placed[1]!.y1, "the order holds");
    }
  });

  test("a pill with no words takes no room", () => {
    const [a, b] = boxes({ x: 5, y: 10, scale: 20, offsetPx: 4, pills: [label, { size: "screen", color: "#fa0", small: true }, ends] }, 1).filter((_, i) => i !== 1);
    near(b!.y0, a!.y1 + 4 / 20, "the next one keeps the one gap");
  });
});

describe("a pointed pill at the screen's edge (docs/design-v1-polish.md R4)", () => {
  // A 390 x 844 phone at 40 px a cell, with its bars over the map.
  const scale = 40;
  const view = boardViewOf({ x: 0, y: 0, scale }, { width: 390, height: 844 }, { top: 52, right: 0, bottom: 113, left: 0 });
  const name = { name: "Poisoned needle in the lock", size: "map" as const, small: true, maxLines: 1 as const, scale };

  /** Where the pointer's tip stands, in cells: the Label's point, leaned along the body's edge. */
  const tipOf = (place: ReturnType<typeof pillPlace>) => place.x + place.lean / scale;

  for (const ui of [1, 1.3]) {
    for (const side of ["left", "right"] as const) {
      for (const way of ["above", "below"] as const) {
        test(`${way} a point 10 px from the ${side} edge at ${Math.round(ui * 100)}%: the body inside the view, the pointer's tip on the point`, () => {
          const point = { x: side === "left" ? view.x0 + 10 / scale : view.x1 - 10 / scale, y: (view.y0 + view.y1) / 2 };
          const place = at(ui, () => pillPlace({ ...name, ...point, [way]: true }, view));
          const g = at(ui, () => pillGeometry({ ...name, ...point, [way]: true }));
          inside(place.box, view, "the body");
          near(tipOf(place), point.x, "the tip's x");
          near(place.y, point.y, "the tip's y: a pointed pill never slides up or down");
          near((place.box.x1 - place.box.x0) * scale, g.width, "the name keeps its width");
          // The tip stays on the straight part of the edge, clear of the rounded corners.
          assert.ok(Math.abs(place.lean) <= g.width / 2 - theme.radius.sm + 1e-9, `the lean ${place.lean} reaches into a corner of ${g.width}`);
          assert.ok(Math.abs(place.lean) > 0, "it slid, so the pointer leans");
        });
      }
    }
  }

  test("away from the edges it stands centered on its point, its pointer in the middle", () => {
    const point = { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 };
    const place = pillPlace({ ...name, ...point, above: true }, view);
    near((place.box.x0 + place.box.x1) / 2, point.x, "centered");
    near(place.x, point.x, "the Label at the point");
    assert.equal(place.lean, 0);
  });

  test("a point past the edge keeps the pointer on it, the body following it out rather than leaving it", () => {
    const point = { x: view.x1 + 1, y: (view.y0 + view.y1) / 2 };
    const place = pillPlace({ ...name, ...point, above: true }, view);
    const g = pillGeometry({ ...name, ...point, above: true });
    near(tipOf(place), point.x, "the tip's x");
    near(place.box.x1, point.x + theme.radius.sm / scale, "the body stops a corner past it");
    near(place.lean, g.width / 2 - theme.radius.sm, "the pointer at the straight edge's end");
  });

  test("with no view it stays centered, as the label pass reads it", () => {
    const place = pillPlace({ ...name, x: view.x1, y: 5, above: true }, null);
    near((place.box.x0 + place.box.x1) / 2, view.x1, "centered");
    assert.equal(place.lean, 0);
  });
});

describe("a pointed pill's outline", () => {
  /** The outline's points as leaningTag draws them, from a context that records them. */
  function outline(attrs: { width: number; height: number; pointerDirection: "up" | "down"; lean: number }) {
    const points: { x: number; y: number }[] = [];
    const context = { beginPath() {}, moveTo: (x: number, y: number) => points.push({ x, y }), lineTo: (x: number, y: number) => points.push({ x, y }), arc() {}, closePath() {}, fillStrokeShape() {} };
    const all: Record<string, unknown> = { pointerWidth: 10, pointerHeight: 6, ...attrs };
    const shape = { width: () => attrs.width, height: () => attrs.height, getAttr: (key: string) => all[key] };
    leaningTag(context as never, shape as never);
    return points;
  }

  for (const pointerDirection of ["up", "down"] as const) {
    test(`pointing ${pointerDirection}, its tip stands \`lean\` from the middle, its base on the straight edge`, () => {
      const height = 24;
      const edgeY = pointerDirection === "up" ? 0 : height;
      const tipY = pointerDirection === "up" ? -6 : height + 6;
      for (const lean of [0, 20, -20, 44, -44]) {
        const points = outline({ width: 100, height, pointerDirection, lean });
        const i = points.findIndex((p) => p.y === tipY);
        assert.ok(i > 0, `no tip at ${lean}`);
        near(points[i]!.x, 50 + lean, `the tip at ${lean}`);
        // The pointer is drawn base end, tip, base end.
        const base = [points[i - 1]!, points[i + 1]!];
        for (const p of base) {
          assert.equal(p.y, edgeY, `the base end ${JSON.stringify(p)} is off the edge at ${lean}`);
          assert.ok(p.x >= theme.radius.sm - 1e-9 && p.x <= 100 - theme.radius.sm + 1e-9, `the base end ${p.x} leaves the straight edge at ${lean}`);
        }
        near(Math.abs(base[0]!.x - base[1]!.x), 10, `the base keeps its width at ${lean}`);
      }
    });
  }
});
