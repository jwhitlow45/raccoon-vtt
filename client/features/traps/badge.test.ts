import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rng } from "#shared/testutil.ts";
import { BADGE_PX, trapBadgeBox } from "./badge.ts";

describe("a trap badge's box", () => {
  test("holds the disc, its outline and the eye as TrapLayer.tsx draws them, at any zoom", () => {
    const random = rng(4401);
    for (let i = 0; i < 300; i++) {
      const scale = 4 + random() * 120;
      const at = { x: random() * 30, y: random() * 30 };
      const found = random() < 0.5;
      const box = trapBadgeBox(at, scale, found);
      const s = 1 / scale;
      const r = (BADGE_PX / 2) * s;
      // The disc with half its 1.5 px outline outside, and the eye's disc.
      const discs = [{ x: at.x, y: at.y, r: r + 0.75 * s }, ...(found ? [{ x: at.x + r * 1.15, y: at.y - r * 0.85, r: r * 0.6 }] : [])];
      for (const d of discs) {
        for (let k = 0; k < 64; k++) {
          const a = (k / 64) * Math.PI * 2;
          const x = d.x + d.r * Math.cos(a);
          const y = d.y + d.r * Math.sin(a);
          assert.ok(x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1, `scale ${scale}: a drawn point lies outside the box`);
        }
      }
    }
  });
});
