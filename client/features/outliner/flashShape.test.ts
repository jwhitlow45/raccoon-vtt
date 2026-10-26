import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isometric, toView, type Turn } from "../../lib/view.ts";

const { flashShape } = await import("./FlashLayer.tsx");

/** A ledge along x = 5: west of it 10 ft, 2 cells of height. */
const ledge = (x: number) => (x < 5 ? 2 : 0);
const RECT = { x: 3, y: 2, width: 4, height: 2 };

/** Whether a point lies inside a convex polygon given as flat points, its edge included. */
function inside(poly: readonly number[], p: { x: number; y: number }): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const ax = poly[i]!;
    const ay = poly[i + 1]!;
    const bx = poly[(i + 2) % poly.length]!;
    const by = poly[(i + 3) % poly.length]!;
    const c = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

for (const turn of [0, 1, 2, 3] as Turn[]) {
  test(`the outliner's flash round a drawing across a ledge bounds every cell of it at its own drawn height (ISO34-FV-4's class), turn ${turn}`, () => {
    const shape = flashShape({ turn, ground: ledge }, { rect: RECT }, 40);
    assert.equal(shape.kind, "hull");
    const view = isometric(turn);
    for (let cy = RECT.y; cy < RECT.y + RECT.height; cy++) {
      for (let cx = RECT.x; cx < RECT.x + RECT.width; cx++) {
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const corner = toView(view, { x: cx + dx, y: cy + dy }, ledge(cx + 0.5));
          assert.ok(shape.kind === "hull" && inside(shape.points, corner), `cell ${cx}, ${cy} corner ${dx}, ${dy}`);
        }
      }
    }
  });

  test(`a door's flash on a ledge's edge lies on the higher side, where its piece stands, turn ${turn}`, () => {
    assert.deepEqual(flashShape({ turn, ground: ledge }, { rect: RECT, segment: { a: { x: 5, y: 2 }, b: { x: 5, y: 3 } } }, 40), { kind: "line", points: [5, 2, 5, 3], z: 2 });
    assert.equal((flashShape({ turn, ground: ledge }, { rect: RECT, segment: { a: { x: 7, y: 2 }, b: { x: 7, y: 3 } } }, 40) as { z: number }).z, 0);
  });
}

test("a flash round cells on one ground is the padded box at that ground, and in Top-down at 0", () => {
  const top = flashShape({ turn: 1, ground: () => 2 }, { rect: RECT }, 40);
  assert.deepEqual(top, { kind: "rect", x: 3 - 0.15, y: 2 - 0.15, width: 4.3, height: 2.3, z: 2 });
  assert.deepEqual(flashShape(null, { rect: RECT }, 40), { kind: "rect", x: 3 - 0.15, y: 2 - 0.15, width: 4.3, height: 2.3, z: 0 });
  assert.deepEqual(flashShape(null, { rect: RECT, segment: { a: { x: 5, y: 2 }, b: { x: 5, y: 3 } } }, 40), { kind: "line", points: [5, 2, 5, 3], z: 0 });
});
