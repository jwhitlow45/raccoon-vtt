import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rng, token } from "#shared/testutil.ts";
import { groundGroups, isometric, K, toView, TOP_DOWN, type Turn } from "../lib/view.ts";
import { readFileSync } from "node:fs";
import { boxGround, drawsHere, liftInPlane, liftView, pressCells, pressRects, viewPointOf } from "./isoPlace.ts";
import { flatPressTokens } from "./relief/renderCache.ts";

const TURNS: readonly Turn[] = [0, 1, 2, 3];

/** A Konva group's local-to-parent map: translate, then rotate by degrees, then scale, as Konva composes them. */
function konvaMap(attrs: { x?: number; y?: number; rotation?: number; scaleY?: number }) {
  const r = ((attrs.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const sy = attrs.scaleY ?? 1;
  return (p: { x: number; y: number }) => {
    const y = p.y * sy;
    return { x: (attrs.x ?? 0) + c * p.x - s * y, y: (attrs.y ?? 0) + s * p.x + c * y };
  };
}

describe("where marks go in Isometric", () => {
  test("a lift in the ground plane raises what it holds by K cells of view per cell of height, at every turn", () => {
    const random = rng(3003);
    for (const turn of TURNS) {
      const g = groundGroups(turn);
      const outer = konvaMap({ scaleY: g.outer.scaleY });
      const inner = konvaMap({ rotation: g.inner.rotation });
      for (let i = 0; i < 200; i++) {
        const p = { x: random() * 60 - 10, y: random() * 60 - 10 };
        const z = random() * 40 - 20;
        const d = liftInPlane(turn, z);
        // Through the drag layer's groups: the plane, then the lift inside it.
        const drawn = outer(inner({ x: p.x + d.x, y: p.y + d.y }));
        const want = toView(isometric(turn), p, z);
        assert.ok(Math.abs(drawn.x - want.x) < 1e-9 && Math.abs(drawn.y - want.y) < 1e-9, `turn ${turn} z ${z}`);
      }
    }
    assert.deepEqual(liftInPlane(2, 0), { x: 0, y: 0 });
  });

  test("from the overlay, a lifted plane draws a point where toView puts it at that height", () => {
    for (const turn of TURNS) {
      const g = groundGroups(turn);
      const lift = konvaMap({ y: -liftView(3) });
      const outer = konvaMap({ scaleY: g.outer.scaleY });
      const inner = konvaMap({ rotation: g.inner.rotation });
      const p = { x: 7.25, y: 3.5 };
      const drawn = lift(outer(inner(p)));
      const want = toView(isometric(turn), p, 3);
      assert.ok(Math.abs(drawn.x - want.x) < 1e-9 && Math.abs(drawn.y - want.y) < 1e-9);
    }
    assert.equal(liftView(2), 2 * K);
  });

  test("a point's view point stands on its drawn ground, or a given height, and is itself in Top-down", () => {
    const iso = { turn: 1 as Turn, ground: (x: number, y: number) => (Math.floor(x) === 4 && Math.floor(y) === 2 ? 2 : 0) };
    assert.deepEqual(viewPointOf(iso, { x: 4.5, y: 2.5 }), toView(isometric(1), { x: 4.5, y: 2.5 }, 2));
    assert.deepEqual(viewPointOf(iso, { x: 4.5, y: 2.5 }, 0), toView(isometric(1), { x: 4.5, y: 2.5 }, 0));
    assert.deepEqual(viewPointOf(null, { x: 4.5, y: 2.5 }), toView(TOP_DOWN, { x: 4.5, y: 2.5 }));
  });

  test("a box's ground is the highest drawn ground of the cells it covers, its far edges left out", () => {
    const heights: Record<string, number> = { "3,3": 1, "4,4": 2, "5,3": 9, "3,5": 9 };
    const iso = { ground: (x: number, y: number) => heights[`${Math.floor(x)},${Math.floor(y)}`] ?? 0 };
    assert.equal(boxGround(iso, { x0: 3, y0: 3, x1: 5, y1: 5 }), 2, "cells 5,3 and 3,5 lie past the far edges");
    assert.equal(boxGround(iso, { x0: 3, y0: 3, x1: 4, y1: 4 }), 1);
    assert.equal(boxGround(iso, { x0: 3.5, y0: 3.5, x1: 3.5, y1: 3.5 }), 1, "a box with no area reads the cell it lies in");
    assert.equal(boxGround(iso, { x0: 0, y0: 0, x1: 2, y1: 2 }), 0);
  });

  test("a token dragged wholly inside a 10 ft pit keeps its marks down in it, and one half out of it stands at the rim", () => {
    const pit = { ground: (x: number, y: number) => (x >= 2 && x < 6 && y >= 2 && y < 6 ? -2 : 0) };
    // A Large's footprint, as DragMarks.tsx and MoveLayer.tsx read it at each spot of the drag.
    assert.equal(boxGround(pit, { x0: 3, y0: 3, x1: 5, y1: 5 }), -2);
    assert.equal(boxGround(pit, { x0: 5, y0: 3, x1: 7, y1: 5 }), 0);
  });

  test("a flat Large straddling a 10 ft ledge takes a press on each part of its picture at that part's own drawn ground (ISO34-ASTRA-14)", () => {
    // A Large at 6, 6, partly fogged, so it lies flat: of its cells only 7, 6 is a seen 10 ft top.
    const ground = (x: number, y: number) => (Math.floor(x) === 7 && Math.floor(y) === 6 ? 2 : 0);
    const cells = pressCells({ x: 6, y: 6 }, { w: 2, h: 2 }, ground);
    assert.deepEqual(cells, [
      { x: 0, y: 0, w: 1, h: 1, z: 0 },
      { x: 1, y: 0, w: 1, h: 1, z: 2 },
      { x: 0, y: 1, w: 1, h: 1, z: 0 },
      { x: 1, y: 1, w: 1, h: 1, z: 0 },
    ]);
    for (const turn of TURNS) {
      const rects = pressRects(turn, cells);
      // A point of the picture draws where the ground stage lays it: its own cell's height.
      for (const p of [{ x: 6.5, y: 7.5 }, { x: 7.5, y: 6.5 }, { x: 6.2, y: 6.8 }, { x: 7.9, y: 7.9 }]) {
        const d = liftInPlane(turn, ground(p.x, p.y));
        const local = { x: p.x - 6 + d.x, y: p.y - 6 + d.y };
        assert.ok(rects.some((r) => local.x >= r.x && local.x <= r.x + r.w && local.y >= r.y && local.y <= r.y + r.h), `turn ${turn}: ${JSON.stringify(p)}`);
      }
    }
    // A Tiny's half cell is one piece, and a footprint off the grid lines cuts where the cells do.
    assert.deepEqual(pressCells({ x: 6.5, y: 6 }, { w: 0.5, h: 0.5 }, ground), [{ x: 0, y: 0, w: 0.5, h: 0.5, z: 0 }]);
    assert.deepEqual(pressCells({ x: 6.5, y: 6 }, { w: 1, h: 1 }, ground).map((c) => [c.x, c.w, c.z]), [[0, 0.5, 0], [0.5, 0.5, 2]]);
    // The node presses by those pieces, and the board gives a flat creature its own.
    const node = readFileSync(new URL("./TokenNode.tsx", import.meta.url), "utf8");
    assert.match(node, /<FootprintPress rects=\{pressRects\(iso\.turn, iso\.press\)\} \/>/);
    const placed = flatPressTokens(new Map(), [token("flat", { x: 6, y: 6, size: "large" })], 0, () => 2, ground);
    assert.deepEqual(placed.get("flat")!.press, cells);
    const board = readFileSync(new URL("./relief/IsoBoard.tsx", import.meta.url), "utf8");
    assert.match(board, /flatPressTokens\(flatCache\.current, flat, turn, flatGround, groundAt, grid\)/);
    assert.match(board, /renderToken\(t, flatIsoOf\.get\(t\.id\)!\)/);
  });

  test("a thing under the stand rule draws in exactly one place: flat on the ground stage, or upright on the overlay", () => {
    for (const stands of [true, false]) {
      assert.equal(drawsHere(null, stands), true, "Top-down draws everything");
      const places = (["ground", "moving", "upright"] as const).filter((place) => drawsHere({ place }, stands));
      assert.deepEqual(places, [stands ? "upright" : "ground"]);
    }
  });
});
