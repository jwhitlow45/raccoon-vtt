import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { edgeCells } from "./wing.ts";
import { editLayout, type RoomEdit } from "./edits.ts";
import { planFitted, type Planned } from "./plan.ts";
import { CROCKFORD, versionChar, type Seed } from "./seed.ts";
import { clampSettings, DEFAULT_SETTINGS, type GridKind } from "./settings.ts";
import { FIRE_STATUE, HIDDEN_PIT, POISONED_NEEDLE, SPIKED_PIT } from "./trapSpots.ts";

/*
 * Trap, Lit and dressing pins reconcile after the whole pipeline (phase 3,
 * 4.3, D-261110-237 and 242): whatever one room's pins do, every other
 * room's traps, light and props, and every trap in the corridors, stay
 * exactly as they were.
 */

const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));
const editArb: fc.Arbitrary<RoomEdit> = fc.record(
  {
    trap: fc.constantFrom(null, HIDDEN_PIT, SPIKED_PIT, POISONED_NEEDLE, FIRE_STATUE),
    lit: fc.boolean(),
    dressing: fc.constantFrom("none", "some", "full"),
    propsDraw: fc.integer({ min: 0, max: 20 }),
  } as const,
  { requiredKeys: [] },
);

/** Each thing in the plan by the room it stands in, -1 for the corridors. */
function contents(p: Planned): Map<number, string[]> {
  const L = p.lattice;
  const out = new Map<number, string[]>();
  const add = (room: number, what: unknown) => out.set(room, [...(out.get(room) ?? []), JSON.stringify(what)]);
  const hex = p.plan.grid !== undefined;
  const cellRoom = (k: number) => (k < 0 ? -1 : hex ? (p.space[k]! >= 0 && p.space[k]! < 100_000 ? p.space[k]! : -1) : p.board.roomAt[k]! - 1);
  const keyCell = (x: number, y: number) => (p.plan.grid === "hexColumns" ? x * L.W + y : y * L.W + x);
  // On hexes lights and stamps stand on hex centers, so a point names its hex exactly.
  const centers = new Map<string, number>();
  if (hex) for (let k = 0; k < L.W * L.H; k++) centers.set(L.pointOf(k % L.W, Math.floor(k / L.W)).join(), k);
  const pointRoom = (x: number, y: number) => (hex ? cellRoom(centers.get(`${x},${y}`) ?? -1) : cellRoom(Math.floor(y) * L.W + Math.floor(x)));
  for (const t of p.plan.traps) {
    const z = t.zone;
    let room = -1;
    if (t.leaf !== undefined) room = p.board.doorways.filter((d) => !d.removed)[p.leaves.findIndex((l) => l.includes(t.leaf!))]?.room ?? -1;
    else if ("cells" in z) room = cellRoom(keyCell(z.cells[0]!.x, z.cells[0]!.y));
    else if ("door" in z && "edge" in z.door) room = Math.max(...edgeCells(z.door.edge).map(([x, y]) => cellRoom(y * L.W + x)));
    add(room, t);
  }
  for (const l of p.plan.lights) add(pointRoom(l.x, l.y), l);
  for (const st of p.plan.stamps) add(pointRoom(st.x, st.y), st);
  return out;
}

describe("trap, Lit and dressing pins", () => {
  test("change only their own room's contents", () => {
    holds(
      fc.property(fc.constantFrom<GridKind>("squares", "hexRows", "hexColumns"), seedArb, fc.nat(), editArb, fc.constantFrom("dungeon", "crypt", "mine", "sewer"), fc.boolean(), (grid, seed, pick, edit, theme, wide) => {
        const s = clampSettings({ ...DEFAULT_SETTINGS, w: 60, h: 60, rooms: 14, traps: 6, lit: 50, dressing: "full", theme, wide }, grid);
        const ctx = grid === "squares" ? { feetPerCell: 5 } : { feetPerCell: 5, grid };
        const base = planFitted(s, seed, ctx);
        const room = base.kept[pick % base.kept.length]!;
        const after = planFitted(s, seed, ctx, { edits: { layout: editLayout(s, seed, base.fitted, null), rooms: { [room]: edit } } });
        const was = contents(base);
        const now = contents(after);
        for (const i of new Set([...was.keys(), ...now.keys()])) {
          if (i === room) continue;
          assert.deepEqual(now.get(i) ?? [], was.get(i) ?? [], `room ${i} (pinned ${room}: ${JSON.stringify(edit)})`);
        }
      }),
      25,
    );
  });
});
