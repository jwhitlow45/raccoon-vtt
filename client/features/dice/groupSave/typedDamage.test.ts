import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor, castAsk, customMonster, DM, effect, room, token } from "#shared/testutil.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { reads } from "#shared/reads.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import type { DiceView } from "../creature.ts";
import { mark, newPage, setAmount } from "./chain.ts";
import { amountsOf, applyWaits, buildPlan, pageBound, rowOutcome } from "./plan.ts";
import { groupRows } from "./rows.ts";

function setup() {
  const view = room({
    monsters: { frost: customMonster("frost", { resistances: "Cold", immunities: "Fire", vulnerabilities: "Radiant" }) },
    tokens: { a: token("a", { actor: { inline: actor({ monsterId: "frost", hp: { cur: 100, max: 100, temp: 2 } }) } }) },
  });
  const dice: DiceView = { view, you: DM, srd: { monsters: [], rolls: {} } };
  const rows = groupRows(dice, ["a"], { kind: "save", ability: "dex" }, false);
  const page = mark({ ...newPage({ id: "p", sceneId: "s1", source: { kind: "selection", tokenIds: ["a"] }, test: { kind: "save", ability: "dex" }, dc: 15, secret: false, spell: true, switches: { dcShown: true, resultShown: true }, outcome: { damage: "15 cold + 9 fire + 5 radiant", onPass: "half" } }), rows, phase: "rolled" as const }, rows[0]!.holder, "pass");
  return { dice, page, row: rows[0]!, parts: amountsOf(page)! };
}

describe("FL-3 group save typed server damage", () => {
  test("typed outcomes wait for the server instead of predicting from incomplete defense reads", () => {
    const { dice, page, parts } = setup();
    const plan = buildPlan(page, dice, parts, { plan: "plan", newId: () => "e" })!;
    assert.deepEqual(reads(plan, dice.view), { never: true });
  });
  test("a save sends raw parts and its save choices, and the server applies each defense once", () => {
    const { dice, page, row, parts } = setup();
    assert.equal(rowOutcome(page, row, dice, parts).amount, 7);
    const plan = buildPlan(page, dice, parts, { plan: "plan", newId: () => "e" })!;
    assert.deepEqual(plan.targets[0]!.damage?.parts, parts);
    assert.equal(plan.targets[0]!.amount, undefined);
    assert.equal(plan.targets[0]!.types, undefined);
    const result = applyOp(dice.view, clientOpSchema.parse(plan), DM, { seq: 1, at: "2026-10-29T00:00:00Z" });
    assert.ok(result.ok);
    const target = result.state.tokens.a!.actor;
    assert.ok("inline" in target);
    assert.deepEqual(target.inline.hp, { cur: 95, max: 100, temp: 0 });
    assert.deepEqual(target.inline.hurt, ["cold", "radiant"]);
  });

  test("typed row damage replaces the saved amount, applies defenses, and resets to the shared damage", () => {
    const { dice, page, row, parts } = setup();
    const typed = setAmount(page, row.holder, "11 cold + 3 radiant");
    const outcome = rowOutcome(typed, row, dice, parts);
    assert.equal(outcome.amount, 11, "5 Cold and 6 Radiant, with no second save adjustment");
    assert.match(outcome.words, /Resists Cold/);
    assert.match(outcome.words, /Vulnerable to Radiant/);
    const plan = buildPlan(typed, dice, parts, { plan: "plan", newId: () => "e" })!;
    const result = applyOp(dice.view, clientOpSchema.parse(plan), DM, { seq: 1, at: "2026-10-29T00:00:00Z" });
    assert.ok(result.ok);
    const target = result.state.tokens.a!.actor;
    assert.ok("inline" in target);
    assert.equal(target.inline.hp.cur, 91);
    assert.equal(rowOutcome(setAmount(typed, row.holder, null), row, dice, parts).amount, 7);
    assert.equal(buildPlan(setAmount(typed, row.holder, "5"), dice, parts, { plan: "plain", newId: () => "e" })!.targets[0]!.amount, 5);
    assert.equal(buildPlan(setAmount(typed, row.holder, "0"), dice, parts, { plan: "zero", newId: () => "e" }), null);
  });

  test("an invalid override blocks Apply until fixed or cleared, and skipped rows do not block", () => {
    const { dice, page, row, parts } = setup();
    for (const text of ["11 frost", "2d6 cold", "-2", "+5", "100000 cold + 1 fire"]) {
      const typed = setAmount(page, row.holder, text);
      assert.ok(applyWaits(typed, dice, parts), text);
      assert.equal(buildPlan(typed, dice, parts, { plan: "bad", newId: () => "e" }), null);
      assert.equal(applyWaits(mark(typed, row.holder, "skip"), dice, parts), null);
    }
    assert.equal(applyWaits(setAmount(page, row.holder, ""), dice, parts), null);
  });

  test("save context preserves Evasion and selected qualified defenses, with current server effects", () => {
    const { dice, page, row, parts } = setup();
    const evading = { ...page, states: { ...page.states, [row.holder]: { ...page.states[row.holder]!, evasion: true } } };
    const plan = buildPlan(evading, dice, parts, { plan: "evade", newId: () => "e" })!;
    assert.ok(plan, "zero previews still send incoming damage for server resolution");
    const dodged = applyOp(dice.view, clientOpSchema.parse(plan), DM, { seq: 1, at: "2026-10-29T00:00:00Z" });
    assert.ok(dodged.ok);
    assert.deepEqual(dodged.state.tokens.a!.actor, dice.view.tokens.a!.actor, "Evasion takes no damage on a pass");
    const changed = structuredClone(dice.view);
    const target = changed.tokens.a!.actor;
    assert.ok("inline" in target);
    target.inline.effects = [effect("stunned", { key: "stunned" })];
    const result = applyOp(changed, clientOpSchema.parse(plan), DM, { seq: 1, at: "2026-10-29T00:00:00Z" });
    assert.ok(result.ok);
    const applied = result.state.tokens.a!.actor;
    assert.ok("inline" in applied);
    assert.equal(applied.inline.hp.cur, 95, "incapacitation at Apply disables Evasion");
    const qualified = structuredClone(dice);
    qualified.view.monsters.frost!.resistances = "Cold from Spells";
    const opts = rowOutcome(page, row, qualified, parts).qualified;
    assert.equal(opts.length, 1);
    const selected = { ...page, states: { ...page.states, [row.holder]: { ...page.states[row.holder]!, qualifiedOn: [opts[0]!.key] } } };
    const selectedPlan = buildPlan(selected, qualified, parts, { plan: "qualified", newId: () => "e" })!;
    const hit = applyOp(qualified.view, clientOpSchema.parse(selectedPlan), DM, { seq: 1, at: "2026-10-29T00:00:00Z" });
    assert.ok(hit.ok);
    const defended = hit.state.tokens.a!.actor;
    assert.ok("inline" in defended);
    assert.equal(defended.inline.hp.cur, 95);
  });

  test("bounds include every row's typed parts before Apply", () => {
    const { page, row, dice, parts } = setup();
    const huge = setAmount(page, row.holder, Array.from({ length: 101 }, () => "1 cold").join(" + "));
    assert.ok(applyWaits(huge, dice, parts));
    assert.ok(pageBound(huge, page.rows));
    assert.ok(pageBound({ ...page, outcome: { ...page.outcome, damage: Array.from({ length: 101 }, () => "1 cold").join(" + ") } }, page.rows));
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...row, holder: `token:t${i}`, target: { tokenId: `t${i}` } }));
    const many = { ...page, rows, outcome: { ...page.outcome, damage: Array.from({ length: 100 }, () => "1 cold").join(" + ") } };
    assert.ok(pageBound(many, rows));
  });

  test("negative rolled parts contribute zero in both the preview and the server result", () => {
    const { dice, page, row } = setup();
    const rolled = [{ amount: -2, type: "cold" as const }, { amount: 9, type: "radiant" as const }];
    const preview = rowOutcome(page, row, dice, rolled);
    assert.equal(preview.amount, 8);
    const plan = buildPlan(page, dice, rolled, { plan: "rolled", newId: () => "e" })!;
    assert.deepEqual(plan.targets[0]!.damage?.parts, [{ amount: 0, type: "cold" }, { amount: 9, type: "radiant" }]);
  });

  test("the byte bound includes false save choices and the cast or trap being settled", () => {
    const { dice, page, row, parts } = setup();
    const target = dice.view.tokens.a!.actor;
    assert.ok("inline" in target);
    target.inline.legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };
    for (const base of [page, { ...page, cast: { ask: castAsk("cast"), who: "Caster" } }, { ...page, source: { kind: "trap" as const, trapId: "trap", due: "20:0", tokenIds: ["a"] } }]) {
      const qualifiedOn = [...Array.from({ length: 28 }, () => "q".repeat(2000)), "q"];
      const near = { ...base, states: { [row.holder]: { way: "type" as const, mark: "fail" as const, legendary: true, evasion: false, qualifiedOn } } };
      const ids = { plan: "0192f0a8-6c1e-7a4b-9c3d-000000000000", newId: () => "e" };
      const plan = buildPlan(near, dice, parts, ids)!;
      assert.ok(plan);
      qualifiedOn[28] = "q".repeat(1 + LIMITS.outcomeOpBytes + 1 - serializedBytes(plan));
      assert.ok(qualifiedOn[28].length <= 2000);
      assert.ok(pageBound(near, near.rows), "an outcome one byte over the limit must be refused before Apply");
    }
  });

  test("the protocol rejects ambiguous and oversized damage while old outcome amounts replay unchanged", () => {
    const { dice, parts } = setup();
    const op = { t: "actor.outcome", plan: "p", targets: [{ target: { tokenId: "a" }, damage: { parts } }] };
    assert.ok(clientOpSchema.safeParse(op).success);
    for (const extra of [{ amount: 2 }, { types: ["cold"] }]) assert.equal(clientOpSchema.safeParse({ ...op, targets: [{ ...op.targets[0], ...extra }] }).success, false);
    assert.equal(clientOpSchema.safeParse({ ...op, targets: [{ target: { tokenId: "a" }, damage: { parts: [{ amount: 100000 }, { amount: 1 }] } }] }).success, false);
    const legacy = clientOpSchema.parse({ t: "actor.outcome", plan: "old", targets: [{ target: { tokenId: "a" }, amount: 10, types: ["cold"] }] });
    for (const opVersion of [30, 31]) {
      const result = applyOp(dice.view, legacy, DM, { seq: 1, at: "2026-10-29T00:00:00Z", opVersion });
      assert.ok(result.ok);
      const target = result.state.tokens.a!.actor;
      assert.ok("inline" in target);
      assert.equal(target.inline.hp.cur, 92);
    }
  });
});
