import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setBoardInterfaceScale } from "../../lib/boardScale.ts";
import type { Box } from "../../lib/boardText.ts";

const { boardViewOf, pillGeometry, pillPlace, pillStackPlace } = await import("./Pill.tsx");

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
