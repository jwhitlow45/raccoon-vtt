import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rng } from "#shared/testutil.ts";
import { groundGroups, isometric, K, toView, TOP_DOWN, type Turn } from "../lib/view.ts";
import { boxGround, drawsHere, liftInPlane, liftView, viewPointOf } from "./isoPlace.ts";

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

  test("a thing under the stand rule draws in exactly one place: flat on the ground stage, or upright on the overlay", () => {
    for (const stands of [true, false]) {
      assert.equal(drawsHere(null, stands), true, "Top-down draws everything");
      const places = (["ground", "moving", "upright"] as const).filter((place) => drawsHere({ place }, stands));
      assert.deepEqual(places, [stands ? "upright" : "ground"]);
    }
  });
});
