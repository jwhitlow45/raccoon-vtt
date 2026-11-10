import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DungeonEdits } from "../dungeon/edits.ts";
import { squareWingBase } from "../dungeon/handPlans.ts";
import { wingPreviewOf } from "../dungeon/scratch.ts";
import { DEFAULT_SETTINGS } from "../dungeon/settings.ts";

const { wingPlanner } = await import("./WingPane.tsx");

/*
 * The wing pane's parts that run without a page (docs/design: dungeon
 * generator phase 3, 3.3 and 4.2): its planner, as the pane plans and
 * edits a wing with it.
 */

const SEED = "1Q8V2DR4HJ0Y7ZB3";

test("on a small area a room edit holds: the pane freezes the layout its plan froze, the choices clamped to the area", async () => {
  // The pane's choices start at the defaults sized to the area, and 30 by 30 or 20 by 30 holds fewer than their 12 rooms (DG3 review round 1).
  for (const [w, h] of [
    [30, 30],
    [20, 30],
  ] as const) {
    const base = { ...squareWingBase(), area: { x: 30, y: 2, w, h } };
    const settings = { ...DEFAULT_SETTINGS, w, h };
    const planner = wingPlanner(
      () => null,
      () => undefined,
      async (s, seed, context, key, edits) => wingPreviewOf(s, seed, base, context, key, edits),
    );
    const first = await planner({ settings, seed: SEED, base, feetPerCell: 5 });
    assert.ok(first.ok && first.layout && first.facts && first.facts.length >= 2, `${w} by ${h}: ${JSON.stringify(first.ok ? "" : first)}`);
    assert.notEqual(first.layout.settings, JSON.stringify(settings), "not vacuous: the pane's own choices are not the ones its plan read");
    const room = first.facts[1]!;
    const edits: DungeonEdits = { layout: first.layout, rooms: { [room.room]: { lit: !room.lit } } };
    const again = await planner({ settings, seed: SEED, base, feetPerCell: 5, edits });
    assert.ok(again.ok && again.facts);
    assert.equal(again.facts.find((f) => f.room === room.room)?.lit, !room.lit, `${w} by ${h}: the edit holds`);
  }
});

test("the planner posts the base again when its join changes under the same hash, as Corridor width does, and not otherwise", async () => {
  const base = squareWingBase();
  const posted: unknown[] = [];
  const planner = wingPlanner(
    () => null,
    (b) => posted.push(b.join),
    async (s, seed, context, key, edits) => wingPreviewOf(s, seed, base, context, key, edits),
  );
  const settings = { ...DEFAULT_SETTINGS, w: base.area.w, h: base.area.h };
  await planner({ settings, seed: SEED, base, feetPerCell: 5 });
  await planner({ settings: { ...settings, theme: "crypt" }, seed: SEED, base, feetPerCell: 5 });
  assert.equal(posted.length, 1, "a change of choice plans on the base posted");
  const wide = squareWingBase({ wide: true });
  await planner({ settings: { ...settings, wide: true }, seed: SEED, base: { ...base, join: wide.join }, feetPerCell: 5 });
  assert.deepEqual(posted, [base.join, wide.join]);
});
