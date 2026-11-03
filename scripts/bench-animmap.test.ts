import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gateFailures, quantile, type Row } from "./bench-animmap.ts";

/*
 * The animated maps bench's gates (docs/design/design-v1-animated-maps.md
 * 6.1): a pan's and a drag's p95 frame at most 2 ms over the still, a video
 * draw's median at most 1.5 ms and p95 at most 4 ms, at most 32 video draws
 * in any second and none hidden or on Still, and the heap and element count
 * within 5% over the session.
 */

function rows(scene: "square" | "hex", over: { pan?: number; drag?: number; median?: number; p95?: number; most?: number; hidden?: number; still?: number } = {}): Row[] {
  return [
    { row: "pan, still", scene, value: 17, unit: "ms p95" },
    { row: "pan, moving", scene, value: 17 + (over.pan ?? 0), unit: "ms p95" },
    { row: "drag, still", scene, value: 17, unit: "ms p95" },
    { row: "drag, moving", scene, value: 17 + (over.drag ?? 0), unit: "ms p95" },
    { row: "draw median", scene, value: over.median ?? 0.6, unit: "ms" },
    { row: "draw p95", scene, value: over.p95 ?? 1.2, unit: "ms" },
    { row: "most a second", scene, value: over.most ?? 30, unit: "draws" },
    { row: "draws hidden", scene, value: over.hidden ?? 0, unit: "draws" },
    { row: "draws on Still", scene, value: over.still ?? 0, unit: "draws" },
  ];
}

const session = (heap = 0.01, elements = 0): Row[] => [
  { row: "heap drift", scene: "session", value: heap, unit: "share" },
  { row: "element drift", scene: "session", value: elements, unit: "share" },
];

describe("the animated maps bench's gates", () => {
  test("a run within budget passes", () => {
    assert.deepEqual(gateFailures([...rows("square", { pan: 2, drag: 2, median: 1.5, p95: 4, most: 32 }), ...rows("hex"), ...session(0.05, -0.05)]), []);
  });

  test("each budget fails on its own, by scene", () => {
    assert.deepEqual(gateFailures(rows("hex", { pan: 2.5 })), ["hex pan: p95 2.5 ms over the still"]);
    assert.deepEqual(gateFailures(rows("square", { drag: 3 })), ["square drag: p95 3.0 ms over the still"]);
    assert.deepEqual(gateFailures(rows("hex", { median: 1.6 })), ["hex: a video draw's median 1.60 ms"]);
    assert.deepEqual(gateFailures(rows("hex", { p95: 4.1 })), ["hex: a video draw's p95 4.10 ms"]);
    assert.deepEqual(gateFailures(rows("square", { most: 33 })), ["square: 33 video draws in one second"]);
    assert.deepEqual(gateFailures(rows("square", { hidden: 1 })), ["square: 1 draws hidden"]);
    assert.deepEqual(gateFailures(rows("square", { still: 2 })), ["square: 2 draws on Still"]);
    assert.deepEqual(gateFailures(session(0.06)), ["session: heap drift 6.0%"]);
    assert.deepEqual(gateFailures(session(0, -0.07)), ["session: element drift -7.0%"]);
  });

  test("quantiles of the frames and draws", () => {
    assert.equal(quantile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95), 96);
    assert.equal(quantile([3, 1, 2], 0.5), 2);
    assert.equal(quantile([], 0.5), 0);
  });
});
