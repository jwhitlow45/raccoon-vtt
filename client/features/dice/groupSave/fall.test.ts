import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { opSchema } from "#shared/protocol.ts";
import { actor, character, customMonster, room, scene, token } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { mark, newPage, sourceIds, type Page, type Source } from "./chain.ts";
import { fallFill, FALL_NAME } from "./fills.ts";
import { applyWaits, buildPlan, rowOutcome, UNHURT_FALL } from "./plan.ts";
import { captureChoices, restoreChoices } from "./reopen.ts";
import { groupRows } from "./rows.ts";
import { sourceScene } from "./start.ts";

/*
 * A fall card's group save (docs/design/design-v1-floors.md phase 4, 4.4):
 * no save, 1d6 Bludgeoning a full 10 ft, Prone unless the fall did no
 * damage, on the creature's floor now, and Apply removes the card.
 */

const IDS = { plan: "0192f0a8-6c1e-7a4b-9c3d-00000000000a", newId: () => "0192f0a8-6c1e-7a4b-9c3d-00000000000b" };

/** Two floors of Tower: Thorn fell from Upper floor to Ground floor, beside a rock that resists Bludgeoning. */
function tower(over: { thornOn?: string } = {}): RoomState {
  return room({
    scenes: {
      ground: scene("ground", { name: "Tower", floor: { of: "ground", level: 0, name: "Ground floor" } }),
      upper: scene("upper", { name: "Tower", order: 1, floor: { of: "ground", level: 1, name: "Upper floor" } }),
    },
    monsters: { rock: customMonster("rock", { resistances: "Bludgeoning" }) },
    characters: { c1: character("c1", { name: "Thorn", ownerIds: ["p1"] }) },
    tokens: {
      thorn: token("thorn", { sceneId: over.thornOn ?? "ground", kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }),
      rock: token("rock", { sceneId: "ground", kind: "monster", name: "Rock", actor: { inline: actor({ monsterId: "rock", hp: { cur: 30, max: 30, temp: 0 } }) } }),
    },
  });
}

/** A fall's page as fallFill fills one for a 10 ft drop, its outcome written out so it reads no rule the rules lane still builds. */
function fallPage(view: RoomState, tokenId: string, fallId = "120:0"): { page: Page; dice: DiceView } {
  const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view, srd: { monsters: [], rolls: {} } };
  const source: Source = { kind: "fall", fallId, tokenIds: [tokenId] };
  const test = { kind: "none" as const };
  const rows = groupRows(dice, sourceIds(source, ["someone else"]), test, false, new Map());
  const sceneId = sourceScene({ source }, view, "upper");
  let page: Page = {
    ...newPage({
      id: "p",
      sceneId,
      source,
      test,
      dc: null,
      secret: true,
      spell: false,
      switches: { dcShown: false, resultShown: true },
      fill: { name: FALL_NAME, from: "From Fall: No save, 1d6 Bludgeoning, Prone.", damageType: "bludgeoning" },
      outcome: { damage: "1d6 Bludgeoning", onPass: "none", conditions: ["prone"], lasts: { mode: "none", rounds: 10, anchor: "own" }, saveEnds: null },
    }),
    phase: "rolled",
    rows,
  };
  for (const r of rows) page = mark(page, r.holder, "fail");
  return { page, dice };
}

describe("a fall card's group save", () => {
  test("its rows are the creature that fell, whatever is selected, on the floor it stands on now", () => {
    assert.deepEqual(sourceIds({ kind: "fall", fallId: "120:0", tokenIds: ["thorn"] }, ["rock"]), ["thorn"]);
    const source: Source = { kind: "fall", fallId: "120:0", tokenIds: ["thorn"] };
    assert.equal(sourceScene({ source }, tower(), "upper"), "ground", "where it landed, not the floor shown");
    assert.equal(sourceScene({ source }, tower({ thornOn: "upper" }), "ground"), "upper", "climbed back up before the DM applied it");
  });

  test("fills as a fall reads: no save, the dice of its drop, Bludgeoning and Prone", () => {
    const ten = fallFill({ ft: 10 });
    assert.deepEqual(ten.test, { kind: "none" });
    assert.equal(ten.dc, null);
    assert.equal(ten.spell, false);
    assert.equal(ten.fill.name, "Fall");
    assert.equal(ten.fill.from, "From Fall: No save, 1d6 Bludgeoning, Prone.");
    assert.equal(ten.outcome.damage, "1d6 Bludgeoning");
    assert.deepEqual(ten.outcome.conditions, ["prone"]);
    assert.equal(fallFill({ ft: 25 }).outcome.damage, "2d6 Bludgeoning");
    assert.equal(fallFill({ ft: 300 }).outcome.damage, "20d6 Bludgeoning");
  });

  test("Apply removes the card in the same op, and the server's schema takes it", () => {
    const { page, dice } = fallPage(tower(), "thorn");
    const plan = buildPlan(page, dice, [{ amount: 4, type: "bludgeoning" }], IDS)!;
    assert.deepEqual(plan.fall, { fallId: "120:0" });
    assert.equal(plan.trap, undefined);
    assert.equal(plan.targets.length, 1);
    assert.deepEqual(plan.targets[0]!.effects?.map((e) => e.key), ["prone"], "hurt, so Prone");
    assert.ok(opSchema.safeParse(plan).success);
  });

  test("a creature the fall does no damage to lands without Prone, and Apply still removes the card", () => {
    const { page, dice } = fallPage(tower(), "rock");
    // 1 Bludgeoning halved by its resistance comes to 0.
    const row = page.rows[0]!;
    const outcome = rowOutcome(page, row, dice, [{ amount: 1, type: "bludgeoning" }]);
    assert.equal(outcome.amount, 0);
    assert.deepEqual(outcome.conditions, []);
    assert.ok(outcome.skips.includes(UNHURT_FALL));
    const plan = buildPlan(page, dice, [{ amount: 1, type: "bludgeoning" }], IDS)!;
    assert.deepEqual(plan.targets.map((t) => t.effects), [undefined], "its damage goes, worked out to 0 by the server, with no Prone");
    assert.deepEqual(plan.fall, { fallId: "120:0" });
    // The DM skips the row: the plan names no creature and still removes the card, as a trap's settles its springing.
    const skipped = mark(page, row.holder, "skip");
    const settle = buildPlan(skipped, dice, [{ amount: 4, type: "bludgeoning" }], IDS);
    assert.ok(settle, "a fall card is settled even where the plan changes no one");
    assert.deepEqual([settle.targets, settle.fall], [[], { fallId: "120:0" }]);
    assert.ok(opSchema.safeParse(settle).success, "an outcome that only removes a card");
    // Hurt, the same rock is Prone.
    assert.deepEqual(rowOutcome(page, row, dice, [{ amount: 6, type: "bludgeoning" }]).conditions.map((c) => c.key), ["prone"]);
  });

  test("Prone stays in the preview until the damage is known, and any other page keeps its Prone at 0", () => {
    const { page, dice } = fallPage(tower(), "rock");
    assert.deepEqual(rowOutcome(page, page.rows[0]!, dice, null).conditions.map((c) => c.key), ["prone"]);
    const trapPage: Page = { ...page, source: { kind: "trap", trapId: "t", due: "1:0", tokenIds: ["rock"] } };
    assert.deepEqual(rowOutcome(trapPage, trapPage.rows[0]!, dice, [{ amount: 1, type: "bludgeoning" }]).conditions.map((c) => c.key), ["prone"]);
  });

  test("a page whose creature left the floor it was started on refuses, rather than removing the card unapplied", () => {
    const { page } = fallPage(tower(), "thorn");
    const moved = tower({ thornOn: "upper" });
    const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view: moved, srd: { monsters: [], rolls: {} } };
    assert.notEqual(applyWaits(page, dice, [{ amount: 4, type: "bludgeoning" }]), null);
    assert.equal(buildPlan(page, dice, [{ amount: 4, type: "bludgeoning" }], IDS), null);
  });

  test("a reopened page keeps its fall, so applying again removes the card an undo brought back", () => {
    const { page } = fallPage(tower(), "thorn");
    const back = restoreChoices("p2", captureChoices(page));
    assert.deepEqual(back.source, { kind: "fall", fallId: "120:0", tokenIds: ["thorn"] });
  });
});
