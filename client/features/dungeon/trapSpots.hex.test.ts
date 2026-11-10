import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wallChunk } from "#shared/keys.ts";
import { endsKey, hexSide, NO_SPACE, wallPlaceholder } from "./hexWalls.ts";
import { planDungeon, type Planned } from "./plan.ts";
import { clampSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { COLLAPSING_ROOF, FALLING_NET, FIRE_STATUE, HIDDEN_PIT, POISONED_DARTS, POISONED_NEEDLE, ROLLING_STONE, SPIKED_PIT } from "./trapSpots.ts";

/*
 * Traps on hexes (phase 3, 2.4): pits, darts and what a roof hits are
 * scene keys, mirrored on Hex columns, a net's or a roof's wire runs
 * through a corridor hex's center between two opposite walled sides'
 * midpoints, a Poisoned Needle names a locked leaf (the middle one on
 * Wide), and no Rolling Stone or statue stands on hexes.
 */

const SEEDS = ["1K7QH2MXA9F3TWQ5", "1Q8V2DR4HJ0Y7ZB3", "1M3T9WCEX5PK2AGN", "1A0B1C2D3E4F5G6H", "1ZZZZZZZZZZZZZZZ", "1000000000000001", "1VVVVWWWWXXXXYYY", "1RS7TV8WX9YZ0123", "1HJKMNPQRST45678", "1D6E7F8G9H0J1K2M"];

/** A scene key's lattice cell. */
function cellOf(p: Planned, x: number, y: number): number {
  const [lx, ly] = p.plan.grid === "hexColumns" ? [y, x] : [x, y];
  return ly * p.lattice.W + lx;
}

const mid = (a: readonly [number, number], b: readonly [number, number]) => [Math.round(((a[0] + b[0]) / 2) * 64) / 64, Math.round(((a[1] + b[1]) / 2) * 64) / 64] as const;

describe("hex traps", () => {
  for (const grid of ["hexRows", "hexColumns"] as const) {
    test(`${grid === "hexRows" ? "Hex rows" : "Hex columns"}: zones on the scene's keys, wires across walled sides, needles on locked leaves, no stone or statue`, () => {
      const seen = new Set<string>();
      for (const wide of [false, true]) {
        for (const seed of SEEDS) {
          const s = clampSettings({ ...DEFAULT_SETTINGS, w: 60, h: 60, rooms: 16, traps: 6, wide, band: "11-16", theme: "crypt" }, grid);
          const p = planDungeon(s, seed, { feetPerCell: 5, grid });
          const L = p.lattice;
          const walls = new Map(p.plan.walls!.map((w, i) => [endsKey(w.a, w.b), i]));
          for (const t of p.plan.traps) {
            seen.add(t.preset);
            assert.ok(t.preset !== ROLLING_STONE && t.preset !== FIRE_STATUE, `${t.preset} stands on hexes`);
            const z = t.zone;
            if ("cells" in z) {
              for (const r of [...z.cells, ...(t.hits ?? [])]) {
                for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) assert.notEqual(p.space[cellOf(p, x, y)], NO_SPACE, `${t.preset} covers floor at ${x},${y}`);
              }
            } else if ("wire" in z) {
              assert.ok(t.preset === FALLING_NET || t.preset === COLLAPSING_ROOF);
              assert.ok(!wide || t.preset !== FALLING_NET, "nets are Narrow");
              let across = false;
              for (let k = 0; k < p.space.length && !across; k++) {
                if (p.space[k] === NO_SPACE) continue;
                for (let d = 0; d < 3 && !across; d++) {
                  const [a1, b1] = hexSide(L, k, d);
                  const [a2, b2] = hexSide(L, k, d + 3);
                  const ends = [mid(a1, b1).join(), mid(a2, b2).join()].sort();
                  if (ends.join("|") !== [z.wire.a.join(), z.wire.b.join()].sort().join("|")) continue;
                  across = walls.has(endsKey(a1, b1)) && walls.has(endsKey(a2, b2));
                }
              }
              assert.ok(across, `${t.preset}'s wire runs between two walled opposite sides`);
            } else {
              assert.equal(t.preset, POISONED_NEEDLE);
              assert.ok("id" in z.door);
              const leaf = t.leaf!;
              const wall = p.plan.walls![leaf]!;
              assert.equal(wall.f, "locked");
              assert.equal(z.door.id, wallPlaceholder(leaf));
              assert.deepEqual(wallChunk(wall), { cx: z.door.cx, cy: z.door.cy });
              const j = p.leaves.findIndex((leaves) => leaves.includes(leaf));
              assert.equal(p.leaves[j]![0], leaf, "the middle leaf on Wide, the only one on Narrow");
              assert.equal(p.leaves[j]!.length, wide ? 3 : 1);
            }
          }
        }
      }
      for (const preset of [HIDDEN_PIT, SPIKED_PIT, FALLING_NET, POISONED_NEEDLE, COLLAPSING_ROOF, POISONED_DARTS]) assert.ok(seen.has(preset), `the sample holds a ${preset}`);
    });
  }
});
