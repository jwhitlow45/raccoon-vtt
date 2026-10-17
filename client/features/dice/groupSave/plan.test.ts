import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { actor, room, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { mark, newPage, setDc, type Page } from "./chain.ts";
import { applyWaits, buildPlan, rowOutcome } from "./plan.ts";
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
