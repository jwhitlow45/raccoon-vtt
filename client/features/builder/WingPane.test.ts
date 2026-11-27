import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DungeonEdits } from "../dungeon/edits.ts";
import { squareWingBase } from "../dungeon/handPlans.ts";
import { wingPreviewOf } from "../dungeon/scratch.ts";
import { DEFAULT_SETTINGS } from "../dungeon/settings.ts";

const { forgetQuestion, problemWords, wingPlanner } = await import("./WingPane.tsx");

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

test("closing the pane while the forget question shows answers it as Cancel, so the send goes on, and a late tap does nothing", async () => {
  // DG3 review round 1: the question's answer lived only in the pane, so closing the pane left the send waiting for ever.
  const shown: (((yes: boolean) => void) | null)[] = [];
  const question = forgetQuestion((answer) => shown.push(answer));
  const asked = question.ask();
  assert.equal(shown.length, 1);
  const goAhead = shown[0]!;
  question.close();
  // A question left waiting would hold the send for ever, so the test waits only a moment for the answer.
  assert.equal(await Promise.race([asked, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 100))]), false);
  goAhead(true);
  assert.equal(shown.length, 1, "nothing shown once the pane is gone");

  const again = forgetQuestion((answer) => shown.push(answer));
  const yes = again.ask();
  shown.at(-1)!(true);
  assert.equal(await yes, true);
  assert.equal(shown.at(-1), null, "the question goes once answered");
  again.close();
});

test("no way from the area names Reroll first, since another layout often finds one where the area already meets the wall", () => {
  // LP37 polish: about one seed in six found no way that a Reroll then found.
  for (const hex of [false, true]) assert.match(problemWords("noWay", hex), /^No way from the area to that wall\. Reroll, /);
});

/*
 * DSTOCK (docs/design/design-v1-dungeon-stock.md 1 and 4, D-261127-218 to
 * 220): the pane holds its own stock from None, the planner carries the
 * stock to the worker, and a stock or party change keeps the room edits
 * unless the band moves.
 */
test("DSTOCK-W: the planner sends the stock with the plan and hands back the stones the claim check reserves", async () => {
  const base = squareWingBase();
  const settings = { ...DEFAULT_SETTINGS, w: base.area.w, h: base.area.h };
  const asked: unknown[] = [];
  const planner = wingPlanner(
    () => null,
    () => undefined,
    async (s, seed, context, key, edits, stock) => {
      asked.push(stock);
      return wingPreviewOf(s, seed, base, context, key, edits, stock);
    },
  );
  const stock = { choices: { monsters: 50, difficulty: "moderate" as const }, party: [{ count: 4, level: 3 }], pool: [], tokensLeft: 480 };
  const plan = await planner({ settings, seed: SEED, base, feetPerCell: 5, stock });
  assert.deepEqual(asked, [stock]);
  assert.ok(plan.ok && typeof plan.stones === "number");
  await planner({ settings, seed: SEED, base, feetPerCell: 5 });
  assert.deepEqual(asked[1], null, "no stock is null, as the worker takes it");
});

const { readFileSync } = await import("node:fs");
const pane = readFileSync(new URL("./WingPane.tsx", import.meta.url), "utf8");

test("DSTOCK-W: the pane's stock starts at None each time it opens, and Bring them back restores the band, stock and party", () => {
  assert.match(pane, /useState<StockChoices>\(DEFAULT_STOCK\)/);
  assert.match(pane, /type WingBefore = \{ settings: DungeonSettings; seed: Seed; stock: StockChoices; ownBand: DungeonSettings\["band"\]; party: PartyGroup\[\] \| null \}/);
  const back = pane.slice(pane.indexOf("const bringBack"), pane.indexOf('editStep({ k: "bringBack" })'));
  for (const restored of ["setSettingsNow(back.before.settings)", "setStockNow(back.before.stock)", "setOwnBand(back.before.ownBand)", "setEditedParty(back.before.party)"]) assert.ok(back.includes(restored), restored);
});

test("DSTOCK-W: a stock or party change drops the edits only when the band moves, and Add the wing checks the creature limit again on the live scene", () => {
  const restock = pane.slice(pane.indexOf("const restock"), pane.indexOf("const editParty"));
  assert.match(restock, /if \(changed\.drop\) editStep\(\{ k: "change", before: before\(\) \}\);/);
  assert.match(pane, /onChange: \(next\) => restock\(next, groups, false\)/);
  assert.match(pane, /const ready = [^\n]*&& !stockWaits;/);
  const add = pane.slice(pane.indexOf("const add = async"), pane.indexOf("setSaid(null)"));
  assert.match(add, /const live = tokensLeftNow\(roomStore, scene\.id\);\s*if \(share > 0 && live !== null && overLimitBy\(plan\.facts \?\? \[\], edits\.edits\?\.rooms \?\? null, live, plan\.stones \?\? 0\) > 0\) return;/);
  assert.match(pane, /\}, \[planner, base, settings, seed, feetPerCell, builder, edits\.edits, stocked\]\);/);
});
