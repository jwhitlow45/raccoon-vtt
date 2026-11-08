import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PLACED_LIGHTS } from "../vision/presets.ts";
import { paintedOf, samples } from "./plan.samples.ts";
import { stampSize } from "./props.ts";
import { litCount, THEMES } from "./settings.ts";
import { THEME_SPECS } from "./themes.ts";

/*
 * Lit rooms (phase 2, 5.5, D-261107-200): each a theme light against the
 * room's edge, on the free wall lattice half a square from the wall, its
 * picture at its middle, its radii a Lights preset.
 */

describe("lit rooms", () => {
  test("each theme's light: in a kept room, on the lattice, half a square from the wall, its preset's name and its picture there", () => {
    for (const theme of THEMES) {
      const spec = THEME_SPECS[theme];
      assert.ok(PLACED_LIGHTS.some((p) => p.name === spec.light.preset), `${spec.light.preset} is a placed light`);
      for (const { p, seed } of samples(140 + theme.length, 8, { theme, lit: 50, w: 60, h: 60, rooms: 16 })) {
        const W = p.plan.w;
        const painted = paintedOf(p);
        const rooms = new Set<number>();
        assert.ok(p.plan.lights.length <= litCount(50, p.kept.length));
        for (const l of p.plan.lights) {
          assert.equal(l.preset, spec.light.preset);
          assert.equal(l.label, spec.light.label);
          assert.equal(l.stamp, spec.light.stamp);
          assert.ok(Number.isInteger(l.x * 64) && Number.isInteger(l.y * 64), "on the 1/64 lattice");
          assert.equal(l.x % 1, 0.5);
          assert.equal(l.y % 1, 0.5);
          const k = Math.floor(l.y) * W + Math.floor(l.x);
          const i = p.board.roomAt[k]! - 1;
          assert.ok(i >= 0 && painted.has(k), `${seed}: a light off a room's floor`);
          assert.ok(!rooms.has(i), `${seed}: two lights in a room`);
          rooms.add(i);
          // Half a square from a wall: its square touches rock or the room's edge.
          assert.ok([k - 1, k + 1, k - W, k + W].some((n) => !painted.has(n) || p.board.roomAt[n] !== i + 1), `${seed}: a light in the middle of a room`);
          const size = stampSize(spec.light.stamp)!;
          assert.ok(p.plan.stamps.some((st) => st.key === l.stamp && st.x === l.x && st.y === l.y && st.w === size.w && st.h === size.h), `${seed}: a light without its picture`);
        }
        // A share the rooms have spots for lights them all.
        if (p.kept.length >= 4) assert.equal(p.plan.lights.length, litCount(50, p.kept.length), `${seed}: ${p.plan.lights.length} lights`);
      }
    }
  });

  test("the entrance is lit as often as any room, and None lights nothing", () => {
    let entrance = 0;
    let lit = 0;
    let rooms = 0;
    for (const { p } of samples(150, 60, { lit: 25 })) {
      const e = p.board.rooms[p.entrance]!;
      if (p.plan.lights.some((l) => Math.floor(l.x) >= e.x && Math.floor(l.x) < e.x + e.w && Math.floor(l.y) >= e.y && Math.floor(l.y) < e.y + e.h)) entrance++;
      lit += p.plan.lights.length;
      rooms += p.kept.length;
    }
    assert.ok(entrance > 0 && Math.abs(entrance / 60 - lit / rooms) < 0.2, `entrance lit in ${entrance} of 60, rooms ${lit} of ${rooms}`);
    for (const { p } of samples(151, 10, { lit: 0 })) assert.deepEqual(p.plan.lights, []);
  });
});
