import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoutePiece } from "#shared/rules/route.ts";
import { walkPreview } from "./preview.ts";
import { line, thorn, world } from "./testing.ts";

/** A lone drag's picture and frames (docs/design-v1-movement.md 3.1, review MV-O-6 and MV-O-9). */

describe("the picture of a drag's walk", () => {
  test("a route past 64 pieces is drawn and read to where it is cut, so its frames stay within the cap", () => {
    const view = world({ blockMovement: false });
    const token = thorn({ x: 0, y: 0 });
    const zigzag = Array.from({ length: 70 }, (_, i): RoutePiece => [i % 2 === 0 ? 1 : 0, i + 1, 0, 0]);
    const preview = walkPreview({ view, token, target: { x: 1, y: 70 }, answer: { kind: "route", route: { pieces: zigzag, points: [], endsBlocked: false } }, held: null, world: null, role: "player" });
    assert.deepEqual(preview.to, { x: zigzag[63]![0], y: zigzag[63]![1] });
    assert.equal(preview.corners.length, 63, "one corner short of the 64 pieces, 126 numbers in a frame");
    // Each piece of the zigzag is one square down and one across: 5 ft under every diagonal 5 ft.
    assert.equal(preview.read.dragFt, 64 * 5);
  });

  test("a walk held at a wall is drawn and read to the wall, not through it", () => {
    const view = world({ edges: line("w", 6, 0, 30) });
    const token = thorn({ x: 2, y: 5 });
    const held = { x: 5, y: 5 };
    const preview = walkPreview({ view, token, target: { x: 9, y: 5 }, answer: { kind: "none", capped: false }, held, world: null, role: "player" });
    assert.deepEqual([preview.to, preview.corners, preview.read.dragFt], [held, [], 15]);
    const free = walkPreview({ view, token, target: { x: 9, y: 5 }, answer: { kind: "none", capped: false }, held: null, world: null, role: "player" });
    assert.deepEqual([free.to, free.read.dragFt], [{ x: 9, y: 5 }, 35], "nothing held: the finger's spot");
  });
});
