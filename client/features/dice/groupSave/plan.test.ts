import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor, castAsk, character, customMonster, effect, member, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { applyOp } from "#shared/reducer.ts";
import { OUTCOME_TOO_BIG } from "#shared/protocol.ts";
import { apply, mark, markGone, newPage, setAmount, setDc, stateOf, typeTotal, type Page } from "./chain.ts";
import { worstCase } from "./outcome.ts";
import { applyWaits, buildPlan, damageTo, openSaveState, pageBound, rowOutcome, rowWords } from "./plan.ts";
import { groupRows } from "./rows.ts";

/** What Apply freezes from the page (docs/design-v1-roll-options.md 5.4, 5.5). */

const DICE: DiceView = {
  you: { memberId: "dm1", role: "dm" },
  view: room({ tokens: { g1: token("g1", { kind: "monster", name: "Goblin", actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 0 } }) } }) } }),
  srd: { monsters: [], rolls: {} },
};
const ROWS = groupRows(DICE, ["g1"], { kind: "save", ability: "con" }, false);

/** Sunburst's page: Blinded on a fail, a Constitution save at each turn's end ending it, at the page's DC. */
function sunburst(dc: number | null, own: number | null = null): Page {
  const page = newPage({
    id: "p",
    sceneId: "s",
    source: { kind: "selection", tokenIds: ["g1"] },
    test: { kind: "save", ability: "con" },
    dc,
    secret: true,
    spell: true,
    switches: { dcShown: true, resultShown: true },
    outcome: { damage: "", conditions: ["blinded"], saveEnds: { ability: "con", dc: own } },
  });
  return mark({ ...page, phase: "rolled", rows: ROWS }, ROWS[0]!.holder, "fail");
}

describe("the save that ends the conditions", () => {
  test("takes the page's DC as it is when Apply builds the plan, typed after the fill included (W7B-P-4)", () => {
    let page = sunburst(13);
    assert.deepEqual(rowOutcome(page, ROWS[0]!, DICE, []).conditions[0]?.save, { ability: "con", dc: 13, spell: true });
    page = setDc(page, 17);
    const plan = buildPlan(page, DICE, [], { plan: "plan", newId: () => "e1" })!;
    assert.deepEqual(plan.targets[0]?.effects?.[0]?.save, { ability: "con", dc: 17, spell: true });
  });

  test("a DC of its own wins, and with neither Apply waits for one rather than guessing", () => {
    assert.equal(rowOutcome(sunburst(13, 12), ROWS[0]!, DICE, []).conditions[0]?.save?.dc, 12);
    assert.equal(applyWaits(sunburst(null), DICE, []), "Give the save that ends it a DC");
    assert.equal(applyWaits(sunburst(null, 15), DICE, []), null);
  });
});

describe("creatures gone from the group save", () => {
  test("with the DM on another scene, whose tokens the view does not hold, no row reads gone, and back on its scene a deleted creature does (LP7-PC-14)", () => {
    const page = sunburst(13);
    const row = ROWS[0]!;
    const away = markGone(page, "other", () => false);
    assert.equal(stateOf(away, row).gone ?? false, false);
    assert.equal(buildPlan(away, DICE, [], { plan: "p", newId: () => "e" })!.targets.length, 1);
    assert.equal(stateOf(markGone(page, "s", () => true), row).gone ?? false, false);
    assert.equal(stateOf(markGone(page, "s", () => false), row).gone, true);
  });
});

describe("the DM's own amount and the outcome's size", () => {
  test("an amount the DM types wins over the worked-out one, which the row keeps to go back to (ASTRA-13)", () => {
    const page = { ...sunburst(13), outcome: { ...sunburst(13).outcome, damage: "12" } };
    const holder = ROWS[0]!.holder;
    assert.deepEqual([rowOutcome(page, ROWS[0]!, DICE, [{ amount: 12 }]).amount, rowOutcome(page, ROWS[0]!, DICE, [{ amount: 12 }]).computed], [12, 12]);
    const typed = setAmount(page, holder, 5);
    assert.deepEqual([rowOutcome(typed, ROWS[0]!, DICE, [{ amount: 12 }]).amount, rowOutcome(typed, ROWS[0]!, DICE, [{ amount: 12 }]).computed], [5, 12]);
    assert.equal(buildPlan(typed, DICE, [{ amount: 12 }], { plan: "p", newId: () => "e" })!.targets[0]!.amount, 5);
    assert.equal(rowOutcome(setAmount(typed, holder, null), ROWS[0]!, DICE, [{ amount: 12 }]).amount, 12);
  });

  test("a No save page, in setup until its Apply, takes the DM's own amount for one creature, the others the worked-out one (ASTRA-13, round 2)", () => {
    const tokens = { g1: token("g1", { kind: "monster", name: "Goblin", actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 0 } }) } }), g2: token("g2", { kind: "monster", name: "Hobgoblin", actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 0 } }) } }) };
    const dice: DiceView = { ...DICE, view: room({ tokens }) };
    const rows = groupRows(dice, ["g1", "g2"], { kind: "none" }, false);
    const setup: Page = { ...newPage({ id: "p", sceneId: "s", source: { kind: "selection", tokenIds: ["g1", "g2"] }, test: { kind: "none" }, dc: null, secret: true, spell: false, switches: { dcShown: true, resultShown: true }, outcome: { damage: "10" } }), rows };
    assert.equal(setup.phase, "setup");
    const typed = setAmount(setup, rows[0]!.holder, 4);
    const plan = buildPlan(typed, dice, [{ amount: 10 }], { plan: "p", newId: () => "e" })!;
    assert.equal(plan.targets[0]!.amount, 4);
    assert.deepEqual(plan.targets[1]!.damage?.parts, [{ amount: 10 }]);
  });

  test("the bound counts each condition's end and save, so 100 creatures with three conditions that last and end on a save are refused before any roll (ASTRA-14)", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `0192f0a8-6c1e-7a4b-9c3d-${String(i).padStart(12, "0")}`);
    const tokens = Object.fromEntries(hundred.map((id) => [id, token(id, { kind: "monster", name: "Cultist", actor: { inline: actor() } })]));
    const dice: DiceView = { ...DICE, view: room({ tokens }) };
    const rows = groupRows(dice, hundred, { kind: "save", ability: "wis" }, false);
    const page: Page = {
      ...newPage({ id: "p", sceneId: "s", source: { kind: "selection", tokenIds: hundred }, test: { kind: "save", ability: "wis" }, dc: 15, secret: true, spell: true, switches: { dcShown: true, resultShown: true } }),
      fill: { name: "Hypnotic Pattern", from: "" },
      outcome: { damage: "", onPass: "none", conditions: ["charmed", "incapacitated", "prone"], lasts: { mode: "turnEnd", rounds: 10, anchor: "own" }, saveEnds: { ability: "wis", dc: null } },
    };
    assert.equal(worstCase(rows.map((r) => r.target), page.outcome.conditions.map((key) => ({ key: key as "charmed" })), "Hypnotic Pattern"), null, "the keys alone fit, which is what let it through");
    assert.equal(pageBound(page, rows), OUTCOME_TOO_BIG);
    assert.equal(pageBound({ ...page, outcome: { ...page.outcome, conditions: ["charmed", "incapacitated"] } }, rows), null, "two fit, as Hypnotic Pattern needs");
  });
});

/** The types each creature's damage carries, and a secret page's quiet (docs/design-v1-combat-controls.md 3.4 and 8). */
describe("the plan's damage types and its quiet", () => {
  const hp = { cur: 30, max: 30, temp: 0 };
  const tokens = {
    g1: token("g1", { kind: "monster", name: "Goblin", actor: { inline: actor({ hp }) } }),
    imp: token("imp", { kind: "monster", name: "Lurker", actor: { inline: actor({ hp, monsterId: "lurker" }) } }),
    tough: token("tough", { kind: "monster", name: "Ogre", actor: { inline: actor({ hp: { cur: 30, max: 30, temp: 20 } }) } }),
    stone: token("stone", { kind: "monster", name: "Statue", actor: { inline: actor({ hp, effects: [effect("e1", { key: "petrified" })] }) } }),
  };
  const dice: DiceView = { ...DICE, view: room({ tokens, monsters: { lurker: customMonster("lurker", { immunities: "Fire" }) } }) };
  const ids = Object.keys(tokens);
  const rows = groupRows(dice, ids, { kind: "save", ability: "dex" }, false);
  function page(damage: string, result: "fail" | "pass", secret = true): Page {
    const base: Page = {
      ...newPage({ id: "p", sceneId: "s", source: { kind: "selection", tokenIds: ids }, test: { kind: "save", ability: "dex" }, dc: 15, secret, spell: false, switches: { dcShown: true, resultShown: true }, outcome: { damage, onPass: "half" } }),
      phase: "rolled",
      rows,
    };
    return rows.reduce((p, r) => mark(p, r.holder, result), base);
  }
  const typesOf = (p: Page, amounts: { amount: number; type?: "fire" | "radiant" }[]) => {
    const plan = buildPlan(p, dice, amounts, { plan: "plan", newId: () => "e" })!;
    const result = applyOp(dice.view, plan, dice.you, { seq: 1, at: "2026-10-29T00:00:00Z" });
    assert.ok(result.ok);
    return Object.fromEntries(plan.targets.flatMap((t) => {
      const id = "tokenId" in t.target ? t.target.tokenId : "";
      const actor = result.state.tokens[id]?.actor;
      const types = actor && "inline" in actor ? actor.inline.hurt : undefined;
      return types?.length ? [[id, types]] : [];
    }));
  };

  test("mixed damage sends each type taken, immunity drops one, and temporary HP still counts, since the types go with the hit", () => {
    const flame = [
      { amount: 10, type: "fire" as const },
      { amount: 6, type: "radiant" as const },
    ];
    assert.deepEqual(typesOf(page("10 fire + 6 radiant", "fail"), flame), { g1: ["fire", "radiant"], imp: ["radiant"], tough: ["fire", "radiant"], stone: ["fire", "radiant"] });
    assert.deepEqual(rowOutcome(page("10 fire + 6 radiant", "fail"), rows[1]!, dice, flame).types, ["radiant"], "the preview agrees with the server");
  });

  test("a part rounded to 0 adds nothing, and a creature that takes nothing sends no types at all", () => {
    const thin = [
      { amount: 1, type: "fire" as const },
      { amount: 3, type: "radiant" as const },
    ];
    // Halved on a pass: fire 1 becomes 0, radiant 3 becomes 1. Petrified halves again: radiant 1 becomes 0.
    assert.deepEqual(typesOf(page("1 fire + 3 radiant", "pass"), thin), { g1: ["radiant"], imp: ["radiant"], tough: ["radiant"] }, "the statue takes 0 and records no types");
    const fire = [{ amount: 8, type: "fire" as const }];
    const only = buildPlan(page("8 fire", "fail"), dice, fire, { plan: "plan", newId: () => "e" })!;
    assert.deepEqual(only.targets.find((t) => "tokenId" in t.target && t.target.tokenId === "imp")?.damage?.parts, fire, "the server decides immunity even when the preview is zero");
    const lurker = rowOutcome(page("8 fire", "fail"), rows[1]!, dice, fire);
    assert.deepEqual([lurker.amount, lurker.types], [0, []]);
    assert.deepEqual(rowOutcome(page("12", "fail"), rows[0]!, dice, [{ amount: 12 }]).types, [], "untyped damage names none");
  });

  test("an amount the DM typed keeps the worked-out types, and a typed 0 sends none", () => {
    const fire = [{ amount: 8, type: "fire" as const }];
    const holder = rows[0]!.holder;
    assert.deepEqual(rowOutcome(setAmount(page("8 fire", "fail"), holder, 5), rows[0]!, dice, fire).types, ["fire"]);
    assert.deepEqual(rowOutcome(setAmount(page("8 fire", "fail"), holder, 0), rows[0]!, dice, fire).types, []);
    assert.equal(typesOf(setAmount(page("8 fire", "fail"), holder, 0), fire).g1, undefined, "no amount, so no target for it either");
  });

  test("secret saves make the outcome quiet, so a Legendary Resistance's line reaches only the DM and owners, and open saves do not", () => {
    const fire = [{ amount: 8, type: "fire" as const }];
    assert.equal(buildPlan(page("8 fire", "fail", true), dice, fire, { plan: "plan", newId: () => "e" })!.quiet, true);
    assert.equal("quiet" in buildPlan(page("8 fire", "fail", false), dice, fire, { plan: "plan", newId: () => "e" })!, false);
  });

  test("the page's bound counts every type its damage field names, on every row", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `0192f0a8-6c1e-7a4b-9c3d-${String(i).padStart(12, "0")}`);
    const many: DiceView = { ...DICE, view: room({ tokens: Object.fromEntries(hundred.map((id) => [id, token(id, { kind: "monster", name: "Cultist", actor: { inline: actor() } })])) }) };
    const cultists = groupRows(many, hundred, { kind: "save", ability: "wis" }, false);
    const at = (damage: string): Page => ({
      ...newPage({ id: "p", sceneId: "s", source: { kind: "selection", tokenIds: hundred }, test: { kind: "save", ability: "wis" }, dc: 15, secret: true, spell: true, switches: { dcShown: true, resultShown: true } }),
      fill: { name: "Prismatic Storm", from: "" },
      outcome: { damage, onPass: "none", conditions: ["charmed", "incapacitated"], lasts: { mode: "turnEnd", rounds: 10, anchor: "own" }, saveEnds: { ability: "wis", dc: null } },
    });
    assert.equal(pageBound(at("1d6 fire"), cultists.slice(0, 80)), null);
    const every = "1 acid + 1 bludgeoning + 1 cold + 1 fire + 1 force + 1 lightning + 1 necrotic + 1 piercing + 1 poison + 1 psychic + 1 radiant + 1 slashing + 1 thunder";
    assert.equal(pageBound(at(every), cultists), OUTCOME_TOO_BIG);
  });
});

describe("a row in words", () => {
  const page = (): Page => ({ ...sunburst(13), states: {}, outcome: { ...sunburst(13).outcome, damage: "12", conditions: [] } });
  const holder = ROWS[0]!.holder;
  const words = (p: Page) => rowWords(p, ROWS[0]!, rowOutcome(p, ROWS[0]!, DICE, [{ amount: 12 }]));

  test("an asked row says how its answer came and its pass or fail against the DC beside it, never a bare number (W7B-P-11)", () => {
    const asked: Page = { ...page(), states: { [holder]: { way: "ask", asked: { rollId: "r1", dc: 13 }, answer: { tokenId: "g1", tag: "a1", total: 8 } } } };
    assert.deepEqual(words(asked), { how: "Asked: typed 8", verdict: "Fail vs DC 13", notes: [] });
    const rolled: Page = { ...page(), states: { [holder]: { way: "server", rolled: { formula: "1d20+2", faces: [12], total: 14, tokenId: "g1" } } } };
    assert.deepEqual(words(rolled), { how: "Rolled 14 (1d20+2: 12)", verdict: "Pass vs DC 13", notes: [] });
    const waiting: Page = { ...page(), states: { [holder]: { way: "ask", asked: { rollId: "r1", dc: 15 } } } };
    assert.deepEqual(words(waiting), { how: "Asked, waiting, asked against DC 15", verdict: null, notes: [] });
  });

  test("the DM's own mark shows in the control alone, a computed one as words a DC change judges again (W7B-P-12)", () => {
    const typed = typeTotal({ ...page(), states: { [holder]: { way: "type" } } }, holder, 11);
    assert.equal(words(typed).verdict, "Fail vs DC 13");
    assert.equal(words(setDc(typed, 10)).verdict, "Pass vs DC 10");
    assert.equal(words(mark(typed, holder, "pass")).verdict, null, "the mark is the DM's, so no verdict beside it");
  });

  test("the notes say only what the amount does not: a condition gained, a typed amount", () => {
    const fails: Page = { ...sunburst(13), states: { [holder]: { way: "type", typed: 5 } } };
    assert.deepEqual(words(fails).notes, ["Gains Blinded"]);
    assert.deepEqual(words(setAmount(fails, holder, 3)).notes, ["Typed 3", "Gains Blinded"]);
    const withDamage = { ...fails, outcome: { ...fails.outcome, damage: "12" } };
    assert.deepEqual(words(setAmount(withDamage, holder, 3)).notes, ["Typed 3, worked out 12", "Gains Blinded"]);
  });
});

describe("the damage line's readers", () => {
  test("a player's creature's own spell rolls its damage in the open, and a monster's under the switch (W7B-P-20)", () => {
    const view = room({
      characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
      members: { p1: member("p1") },
      tokens: { breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }), g1: token("g1", { kind: "monster", name: "Goblin", actor: { inline: actor() } }) },
    });
    const base = { ...sunburst(13), secret: true };
    assert.equal(damageTo({ ...base, fill: { name: "Fireball", from: "", caster: "breeTok" } }, view), "all");
    assert.equal(damageTo({ ...base, fill: { name: "Fire Breath", from: "", caster: "g1" } }, view), "dm");
    assert.equal(damageTo({ ...base, secret: false, fill: null }, view), "all");
  });
});

describe("the Dice panel's row for the open group save", () => {
  test("says all answered while the damage is still owed, never ready while Apply waits for it (LP7-PC-13)", () => {
    const answered = sunburst(13);
    const owed = { ...answered, outcome: { ...answered.outcome, damage: "8d6 fire" } };
    assert.equal(applyWaits(owed, DICE, null), "Type the damage, or roll it");
    assert.equal(openSaveState(owed, 0), "all answered");
    assert.equal(openSaveState({ ...owed, damage: { state: "committed", tag: "d", amounts: [28] } }, 0), "ready to apply");
    assert.equal(openSaveState(answered, 0), "ready to apply", "no damage to owe");
    assert.equal(openSaveState(owed, 2), "2 waiting");
    assert.equal(openSaveState({ ...owed, phase: "setup" }, 0), "set up");
    assert.equal(openSaveState({ ...owed, phase: "applied" }, 0), "applied");
  });
});

describe("a player's ask for saves (docs/design-v1-player-save-spell.md 3.3)", () => {
  test("the plan carries the ask it answers, so the outcome closes it in the same op", () => {
    const page: Page = { ...sunburst(13), cast: { ask: castAsk("k1", { area: undefined, targets: ["g1"] }), who: "Thorn" } };
    const plan = buildPlan(page, DICE, [], { plan: "plan-1", newId: () => "e1" })!;
    assert.equal(plan.cast, "k1");
    assert.equal(buildPlan({ ...page, cast: undefined } as Page, DICE, [], { plan: "plan-2", newId: () => "e2" })!.cast, undefined, "a plain group save closes none");
  });

  test("Apply sends the ask the page holds then, never one it let go", () => {
    const page: Page = { ...sunburst(13), cast: { ask: castAsk("k1", { area: undefined, targets: ["g1"] }), who: "Thorn" } };
    const plan = buildPlan(page, DICE, [], { plan: "plan-1", newId: () => "e1" })!;
    const { cast: _held, ...free } = page;
    const sent = apply(free, plan).send.find((c) => c.kind === "outcome");
    assert.ok(sent && sent.kind === "outcome");
    assert.equal(sent.op.cast, undefined, "withdrawn meanwhile: a plain outcome");
    const blocked = apply({ ...page, cast: { ...page.cast!, blocked: "Resolved on another device." } }, plan);
    assert.deepEqual([blocked.send, blocked.error], [[], "Resolved on another device."]);
  });
});
