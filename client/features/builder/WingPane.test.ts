import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DungeonEdits } from "../dungeon/edits.ts";
import { squareWingBase } from "../dungeon/handPlans.ts";
import { wingPreviewOf } from "../dungeon/scratch.ts";
import { DEFAULT_SETTINGS } from "../dungeon/settings.ts";
import { readFileSync } from "node:fs";

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

test("DSTOCK-W: a wing whose creatures pass the scene's 500 tokens keeps its ghost, facts and room panel, shows the limit and keeps Add off (STOCK-ASTRA-02)", async () => {
  const { loadMonsters } = await import("#shared/srd/monsters.ts");
  const { stockPool } = await import("../dungeon/stockPools.ts");
  const { WING_SETTINGS } = await import("../dungeon/handPlans.ts");
  const { overLimitBy } = await import("../dungeon/stockSource.ts");
  const { token } = await import("#shared/testutil.ts");
  const open = squareWingBase();
  const sceneId = open.scene.id;
  // 498 tokens stand on the scene, stacked in its corner, so 2 are left for the wing's creatures.
  const tokens = Object.fromEntries(Array.from({ length: 498 }, (_, i) => [`t${i}`, token(`t${i}`, { sceneId, x: 0, y: 0 })]));
  const base = { ...open, state: { ...open.state, tokens: { ...open.state.tokens, ...tokens } } };
  const settings = { ...WING_SETTINGS, traps: 0 };
  const seed = "1Q8V2DR4HJ0Y7ZB3";
  const plain = wingPreviewOf(settings, seed, base, { feetPerCell: 5 }, null);
  assert.ok(plain.ok, "the unstocked wing fits");
  const stock = { choices: { monsters: 100, difficulty: "moderate" as const }, party: [{ count: 4, level: 3 }], pool: stockPool(await loadMonsters(), "dungeon", { srdImages: {} }), tokensLeft: 2 };
  const planner = wingPlanner(
    () => null,
    () => undefined,
    async (s, sd, context, key, edits, st) => wingPreviewOf(s, sd, base, context, key, edits, st),
  );
  const plan = await planner({ settings, seed, base, feetPerCell: 5, stock });
  assert.ok(plan.ok, "the stocked wing is still a plan, not the scene too full");
  assert.equal(plan.unstocked, true);
  assert.ok((plan.facts ?? []).some((f) => f.monsters?.on), "its room facts keep the fights");
  assert.ok(plan.made !== null && plan.made.ops.every((op) => !(op.t === "token.create" && op.token.kind === "monster")), "no creature lands");
  assert.ok(overLimitBy(plan.facts ?? [], null, 2, plan.stones ?? 0) > 0, "the limit line shows");
  assert.match(pane, /const unstocked = share > 0 && plan\?\.ok === true && plan\.unstocked === true;\s*const stockWaits = share > 0 && \(source\.pool === null \|\| overBy > 0 \|\| unstocked\);/);
});

test("DSTOCK-W: a token deleted from the 498 lets all three creatures land, the scene's tokens read again under the same hash, and a wing that stays unstocked within the count says so (STOCK-ASTRA-05, STOCK-O-05)", async () => {
  const { loadMonsters } = await import("#shared/srd/monsters.ts");
  const { stockPool } = await import("../dungeon/stockPools.ts");
  const { WING_SETTINGS } = await import("../dungeon/handPlans.ts");
  const { overLimitBy } = await import("../dungeon/stockSource.ts");
  const { limitWords } = await import("../dungeon/Choices.tsx");
  const { NO_ROOM_FOR_MONSTERS } = await import("../dungeon/words.ts");
  const { withTokens } = await import("./WingPane.tsx");
  const { token } = await import("#shared/testutil.ts");
  const open = squareWingBase();
  const sceneId = open.scene.id;
  const tokens = Object.fromEntries(Array.from({ length: 498 }, (_, i) => [`t${i}`, token(`t${i}`, { sceneId, x: 0, y: 0 })]));
  const stale = { ...open, state: { ...open.state, tokens: { ...open.state.tokens, ...tokens } } };
  const settings = { ...WING_SETTINGS, traps: 0 };
  const seed = "1Q8V2DR4HJ0Y7ZB3";
  const pool = stockPool(await loadMonsters(), "dungeon", { srdImages: {} });
  const stock = (tokensLeft: number) => ({ choices: { monsters: 100, difficulty: "moderate" as const }, party: [{ count: 4, level: 3 }], pool, tokensLeft });
  // The worker plans on the base it was posted last, as dungeon/worker.ts holds it.
  let held = stale;
  const planner = wingPlanner(
    () => null,
    (b) => (held = b),
    async (s, sd, context, key, edits, st) => wingPreviewOf(s, sd, held, context, key, edits, st),
  );
  const monsters = (plan: Awaited<ReturnType<typeof planner>>) => (plan.ok && plan.made ? plan.made.ops.filter((op) => op.t === "token.create" && op.token.kind === "monster").length : -1);
  const left = { ...stale.state.tokens };
  delete left.t0;
  // Kept from before the delete, the base still holds 498: three creatures fit the live count of 3 and still do not land.
  const kept = await planner({ settings, seed, base: stale, feetPerCell: 5, stock: stock(3) });
  assert.ok(kept.ok && kept.unstocked === true, "not vacuous: the stale base leaves the wing unstocked");
  const over = overLimitBy(kept.facts ?? [], null, 3, kept.stones ?? 0);
  assert.equal(over, 0, "within the count, so the over-limit line is not shown");
  assert.equal(limitWords(over, kept.unstocked === true), NO_ROOM_FOR_MONSTERS, "the Monsters line says why Add is off");
  assert.equal(limitWords(0), "");
  const fresh = withTokens(stale, left);
  assert.equal(fresh.hash, stale.hash, "the hash holds, so the edits do");
  assert.equal(withTokens(fresh, left), fresh, "the same tokens keep the base");
  const plan = await planner({ settings, seed, base: fresh, feetPerCell: 5, stock: stock(3) });
  assert.equal(held, fresh, "the base with the tokens read again is posted");
  assert.ok(plan.ok && plan.unstocked !== true, "the wing is stocked again");
  assert.equal(monsters(plan), 3, "all three creatures land");
  assert.match(pane, /const base = useMemo\(\(\) => \{\s*const tokens = roomStore\.getState\(\)\.floorView\?\.tokens;\s*return read && tokens \? withTokens\(read, tokens\) : read;[\s\S]{0,80}\}, \[roomStore, read, tokensLeft\]\);/);
  assert.match(pane, /const noRoom = unstocked && overBy === 0;/);
  assert.equal(pane.match(/<LimitLine over=\{overBy\} full=\{noRoom\} \/>/g)?.length, 2, "both Monsters lines, the room panel's too");
});

test("DSTOCK-W: a token added inside an edited room moves the base's hash, so its edits drop, and the same cells keep it (STOCK-ASTRA-06)", async () => {
  const { loadMonsters } = await import("#shared/srd/monsters.ts");
  const { stockPool } = await import("../dungeon/stockPools.ts");
  const { WING_SETTINGS } = await import("../dungeon/handPlans.ts");
  const { editsHold } = await import("../dungeon/edits.ts");
  const { withTokens } = await import("./WingPane.tsx");
  const { token } = await import("#shared/testutil.ts");
  const base = squareWingBase();
  const sceneId = base.scene.id;
  const settings = { ...WING_SETTINGS, traps: 0 };
  const stock = { choices: { monsters: 100, difficulty: "moderate" as const }, party: [{ count: 4, level: 3 }], pool: stockPool(await loadMonsters(), "dungeon", { srdImages: {} }), tokensLeft: 500 };
  const rect = (r: { x: number; y: number; w: number; h: number }) => [r.x, r.y, r.w, r.h];
  const first = wingPreviewOf(settings, SEED, base, { feetPerCell: 5 }, null, null, stock);
  assert.ok(first.ok);
  const edited = first.plan.rooms.findIndex((r) => 47 >= r.x && 47 < r.x + r.w && 7 >= r.y && 7 < r.y + r.h);
  assert.ok(edited >= 0, "a room stands on (47, 7)");
  assert.deepEqual(rect(first.plan.rooms[edited]!), [43, 5, 9, 4]);
  const edits: DungeonEdits = { layout: first.layout, rooms: { [edited]: { lit: !first.plan.rooms[edited]!.entrance } } };
  assert.ok(editsHold(edits, settings, SEED, base.hash), "not vacuous: the edits hold on the base they were made on");
  // A token in the edited room: the planner avoids its cell, so the room moves, and the edits must not follow it.
  const added = withTokens(base, { ...base.state.tokens, t1: token("t1", { sceneId, x: 47, y: 7 }) });
  const moved = wingPreviewOf(settings, SEED, added, { feetPerCell: 5 }, null, null, stock);
  assert.ok(moved.ok);
  assert.notDeepEqual(rect(moved.plan.rooms[edited]!), [43, 5, 9, 4], "not vacuous: the token moves the room");
  assert.notEqual(added.hash, base.hash, "the hash moves");
  assert.ok(!editsHold(edits, settings, SEED, added.hash), "so the edits drop, as baseChanged drops them in the pane");
  // A second token on the same cell gives the planner nothing new, so the hash and the edits hold.
  const stacked = withTokens(added, { ...added.state.tokens, t2: token("t2", { sceneId, x: 47, y: 7 }) });
  assert.equal(stacked.hash, added.hash);
  assert.equal(withTokens(stacked, added.state.tokens).hash, added.hash, "and deleting it again changes nothing");
});

