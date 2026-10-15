import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Drawing } from "#shared/model.ts";
import { drawingAt, eraseTarget, estimateEm, hitDrawing, simplify, simplifyStroke, textBox } from "./geometry.ts";

describe("Douglas-Peucker", () => {
  test("a straight run collapses to its ends", () => {
    const line = [0, 0, 1, 0, 2, 0, 3, 0, 4, 0];
    assert.deepEqual(simplify(line, 0.01), [0, 0, 4, 0]);
  });

  test("corners farther than the tolerance stay, small wiggles go", () => {
    const pts = [0, 0, 1, 0.01, 2, -0.01, 3, 0, 3, 1, 3.01, 2, 3, 3];
    assert.deepEqual(simplify(pts, 0.1), [0, 0, 3, 0, 3, 3]);
    // With a tolerance finer than the wiggles, every point is kept.
    assert.equal(simplify(pts, 0.001).length, pts.length);
  });

  test("short inputs come back as they are", () => {
    assert.deepEqual(simplify([1, 2], 1), [1, 2]);
    assert.deepEqual(simplify([1, 2, 3, 4], 1), [1, 2, 3, 4]);
  });

  test("every kept point is within tolerance of the result", () => {
    const pts: number[] = [];
    for (let i = 0; i < 500; i++) pts.push(i / 10, Math.sin(i / 15) * 3);
    const eps = 0.05;
    const out = simplify(pts, eps);
    assert.ok(out.length < pts.length / 4, `${out.length} of ${pts.length}`);
    for (let i = 0; i < pts.length; i += 2) {
      let best = Infinity;
      for (let j = 0; j + 3 < out.length; j += 2) {
        const [ax, ay, bx, by] = [out[j]!, out[j + 1]!, out[j + 2]!, out[j + 3]!];
        const t = Math.max(0, Math.min(1, ((pts[i]! - ax) * (bx - ax) + (pts[i + 1]! - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
        best = Math.min(best, Math.hypot(pts[i]! - (ax + t * (bx - ax)), pts[i + 1]! - (ay + t * (by - ay))));
      }
      assert.ok(best <= eps + 1e-9);
    }
  });

  test("a stroke is capped at 2,000 numbers", () => {
    const pts: number[] = [];
    // A dense scribble no tolerance flattens much.
    for (let i = 0; i < 20_000; i++) pts.push(Math.cos(i * 0.7) * 10 + i * 0.001, Math.sin(i * 1.3) * 10);
    const out = simplifyStroke(pts, 0.001);
    assert.ok(out.length <= 2_000, String(out.length));
    assert.ok(out.length >= 4);
    assert.deepEqual(out.slice(0, 2), pts.slice(0, 2));
    assert.deepEqual(out.slice(-2), pts.slice(-2));
  });
});

describe("eraser hits", () => {
  const style = { stroke: "#ffffff", width: 4, opacity: 1 };
  const d = (over: Partial<Drawing>): Drawing =>
    ({ id: "d", rev: 1, sceneId: "s", kind: "line", points: [0, 0, 10, 0], style, ownerId: "m", visibility: "all", ...over }) as Drawing;

  test("lines are hit near the stroke only", () => {
    assert.ok(hitDrawing(d({}), { x: 5, y: 0.2 }, 0.2));
    assert.ok(!hitDrawing(d({}), { x: 5, y: 1 }, 0.2));
  });

  test("filled shapes are hit inside, outlines only on the edge", () => {
    const rect = d({ kind: "rect", points: [0, 0, 4, 4] });
    assert.ok(!hitDrawing(rect, { x: 2, y: 2 }, 0.2));
    assert.ok(hitDrawing(rect, { x: 4.1, y: 2 }, 0.2));
    assert.ok(hitDrawing({ ...rect, style: { ...style, fill: "#ffffff55" } }, { x: 2, y: 2 }, 0.2));
    const ellipse = d({ kind: "ellipse", points: [0, 0, 4, 2] });
    assert.ok(hitDrawing(ellipse, { x: 4, y: 1 }, 0.2));
    assert.ok(!hitDrawing(ellipse, { x: 2, y: 1 }, 0.2));
  });

  test("the topmost drawing the eraser may touch wins", () => {
    const mine = d({ id: "mine", ownerId: "me" });
    const theirs = d({ id: "theirs", ownerId: "them" });
    assert.equal(drawingAt([mine, theirs], { x: 3, y: 0 }, 0.2, (x) => x.ownerId === "me")?.id, "mine");
    assert.equal(drawingAt([mine, theirs], { x: 3, y: 0 }, 0.2, () => true)?.id, "theirs");
  });

  test("an eraser over only someone else's drawing reports it, so the tool can say why nothing went", () => {
    const mine = d({ id: "mine", ownerId: "me" });
    const theirs = d({ id: "theirs", ownerId: "them" });
    const mayErase = (x: Drawing) => x.ownerId === "me";
    assert.deepEqual(eraseTarget([mine, theirs], { x: 3, y: 0 }, 0.2, mayErase, new Set()), { erase: mine });
    assert.deepEqual(eraseTarget([theirs], { x: 3, y: 0 }, 0.2, mayErase, new Set()), { refused: theirs });
    assert.deepEqual(eraseTarget([mine, theirs], { x: 3, y: 0 }, 0.2, mayErase, new Set(["mine"])), { refused: theirs });
    assert.equal(eraseTarget([mine], { x: 3, y: 0 }, 0.2, mayErase, new Set(["mine"])), null);
    assert.equal(eraseTarget([theirs], { x: 3, y: 5 }, 0.2, mayErase, new Set()), null);
  });
});

describe("the eraser on text", () => {
  // Thick text: font size 1.6 cells. Chrome on a Mac draws "WWW mmm Thick" 15.4 cells wide.
  const text = { kind: "text" as const, points: [3, 16], style: { stroke: "#fff", width: 8, opacity: 1 }, text: "WWW mmm Thick" };

  test("reaches the far end of wide letters, which a flat width per character fell short of", () => {
    assert.ok(hitDrawing(text, { x: 3 + 15, y: 16.8 }, 0.1));
    assert.ok(!hitDrawing(text, { x: 3 + 17, y: 16.8 }, 0.1));
  });

  test("uses the browser's measurement when it has one", () => {
    assert.equal(textBox(text, (_line, size) => 5 * size).w, 8);
    assert.ok(hitDrawing({ ...text, text: "iii" }, { x: 3 + 4.5, y: 16.5 }, 0.1, () => 4.8));
    assert.ok(!hitDrawing({ ...text, text: "iii" }, { x: 3 + 4.5, y: 16.5 }, 0.1, () => 1.6));
  });

  test("the estimate knows wide letters from narrow ones, and every line counts", () => {
    assert.ok(estimateEm("WWW") > 2 * estimateEm("iii"));
    const two = textBox({ ...text, text: "a\nWWWWWW" });
    assert.ok(two.w >= 6 * 1.6 && two.h >= 2 * 1.6);
  });
});
