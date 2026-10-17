import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor, character, member, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { OUTCOME_TOO_BIG } from "#shared/protocol.ts";
import { mark, newPage, setAmount, setDc, typeTotal, type Page } from "./chain.ts";
import { worstCase } from "./outcome.ts";
import { applyWaits, buildPlan, damageTo, pageBound, rowOutcome, rowWords } from "./plan.ts";
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
    assert.deepEqual(words(setAmount(fails, holder, 3)).notes, ["Typed 3, worked out 12", "Gains Blinded"]);
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
