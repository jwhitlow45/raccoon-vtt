import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cornerAt, hexCorners, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";

/**
 * The export's grid (render.ts traceGrid) on a hex scene draws the board's
 * hex sides over the whole scene (docs/design-v1-hex-grids.md HX-D13), and a
 * square scene's lines stay as they were.
 */
describe("the exported grid", () => {
  test("a hex scene draws each side of every scene hex once, at the rules' corners, and no square line", async () => {
    await import("../../components/testing/register.ts");
    const { traceGrid } = await import("./render.ts");
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      const bounds = { w: 30, h: 20 };
      const sides = new Set<string>();
      let from: { x: number; y: number } | null = null;
      const key = (p: { x: number; y: number }) => `${Math.round(p.x * 64)},${Math.round(p.y * 64)}`;
      traceGrid({ bounds, gridShape: orient === "rows" ? "hexRows" : "hexColumns" }, 70, {
        moveTo: (x, y) => void (from = { x, y }),
        lineTo: (x, y) => {
          const side = [key(from!), key({ x, y })].sort().join("|");
          assert.ok(!sides.has(side), `${side} drawn once`);
          sides.add(side);
          from = { x, y };
        },
      });
      // Every side of every hex wholly inside the scene, by its corners.
      const want = new Set<string>();
      for (const h of sceneHexes(g, bounds)) {
        const corners = hexCorners(g, h).map((c) => key(cornerAt(g, c)));
        for (let i = 0; i < 6; i++) want.add([corners[i]!, corners[(i + 1) % 6]!].sort().join("|"));
      }
      assert.deepEqual([...sides].sort(), [...want].sort(), orient);
    }
  });

  test("a square scene draws its lines x = 0..w and y = 0..h", async () => {
    await import("../../components/testing/register.ts");
    const { traceGrid } = await import("./render.ts");
    const lines: string[] = [];
    traceGrid({ bounds: { w: 3, h: 2 } }, 70, { moveTo: (x, y) => void lines.push(`M${x},${y}`), lineTo: (x, y) => void lines.push(`L${x},${y}`) });
    assert.deepEqual(lines, ["M0,0", "L0,2", "M1,0", "L1,2", "M2,0", "L2,2", "M3,0", "L3,2", "M0,0", "L3,0", "M0,1", "L3,1", "M0,2", "L3,2"]);
  });
});
