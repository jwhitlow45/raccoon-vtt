import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { endOf } = await import("./RulerLayer.tsx");

test("a drag's label stack hangs at the highest drawn ground under the footprint, a Large across a ledge on its upper side (ISO34-FV-4)", () => {
  // A ledge along x = 6: west of it 10 ft. The Large's middle lies on the lower side.
  const iso = { turn: 0 as const, ground: (x: number) => (x < 6 ? 2 : 0) } as never;
  assert.deepEqual(endOf(iso, { x: 5, y: 3 }, { w: 2, h: 2 }), { x: 6, y: 4, z: 2 });
  assert.deepEqual(endOf(iso, { x: 7, y: 3 }, { w: 2, h: 2 }), { x: 8, y: 4, z: 0 });
  assert.deepEqual(endOf(null, { x: 3, y: 3 }, { w: 2, h: 2 }), { x: 5, y: 5 }, "off the bottom right corner in Top-down");
});
