import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Fall, RoomState } from "#shared/model.ts";
import { opSchema } from "#shared/protocol.ts";
import { actor, character, customMonster, room, scene, token } from "#shared/testutil.ts";
import { GROUND, UPPER, fallCard, run, thornToken, tower as floorsTower, withFalls } from "#shared/floorLinksTestutil.ts";
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
 * damage, on the creature's floor now, and Apply takes the creatures it
 * reaches off the card.
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

  test("Apply settles the card in the same op, and the server's schema takes it", () => {
    const { page, dice } = fallPage(tower(), "thorn");
    const plan = buildPlan(page, dice, [{ amount: 4, type: "bludgeoning" }], IDS)!;
    assert.deepEqual(plan.fall, { fallId: "120:0", tokenIds: ["thorn"] });
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
    assert.deepEqual(plan.fall, { fallId: "120:0", tokenIds: ["rock"] });
    // The DM skips the row: the plan names no creature and still settles the card, as a trap's settles its springing.
    const skipped = mark(page, row.holder, "skip");
    const settle = buildPlan(skipped, dice, [{ amount: 4, type: "bludgeoning" }], IDS);
    assert.ok(settle, "a fall card is settled even where the plan changes no one");
    assert.deepEqual([settle.targets, settle.fall], [[], { fallId: "120:0", tokenIds: ["rock"] }]);
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

  test("a creature that climbed to another floor of the scene since the page started still takes the fall (FLR4INT-ASTRA-05)", () => {
    const { page } = fallPage(tower(), "thorn");
    const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view: tower({ thornOn: "upper" }), srd: { monsters: [], rolls: {} } };
    assert.equal(applyWaits(page, dice, [{ amount: 4, type: "bludgeoning" }]), null);
    const plan = buildPlan(page, dice, [{ amount: 4, type: "bludgeoning" }], IDS);
    assert.deepEqual([plan?.targets.map((t) => t.target), plan?.fall], [[{ tokenId: "thorn" }], { fallId: "120:0", tokenIds: ["thorn"] }]);
  });

  test("a page that reaches none of its creatures, all on another scene or gone, sends nothing, so the card stays for them", () => {
    const { page } = fallPage(tower(), "thorn");
    const away = tower();
    delete away.tokens.thorn;
    const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view: away, srd: { monsters: [], rolls: {} } };
    assert.equal(buildPlan(page, dice, [{ amount: 4, type: "bludgeoning" }], IDS), null);
  });

  test("a reopened page keeps its fall, so applying again removes the card an undo brought back", () => {
    const { page } = fallPage(tower(), "thorn");
    const back = restoreChoices("p2", captureChoices(page));
    assert.deepEqual(back.source, { kind: "fall", fallId: "120:0", tokenIds: ["thorn"] });
  });
});

describe("a fall card with two tokens of one creature (FLR4INT-ASTRA-08)", () => {
  const SIX = [{ amount: 6, type: "bludgeoning" as const }];
  let n = 0;
  /** Fresh ids for each Apply, as the panel makes them. */
  const ids = () => ({ plan: `0192f0a8-6c1e-7a4b-9c3d-1${String(n++).padStart(11, "0")}`, newId: () => `0192f0a8-6c1e-7a4b-9c3d-2${String(n++).padStart(11, "0")}` });

  /** The tower with a horse, two riders that show Thorn's one character, a goblin and Bree, and a card naming those `named`. */
  function room4(named: string[], over: Record<string, string> = {}): RoomState {
    const at = (id: string) => ({ sceneId: over[id] ?? GROUND, x: 6, y: 6 });
    const base = floorsTower({
      tokens: {
        horse: token("horse", { name: "Horse", ...at("horse") }),
        thorn: thornToken(at("thorn")),
        thorn2: thornToken({ id: "thorn2", ...at("thorn2") }),
        gob: token("gob", { name: "Goblin", ...at("gob") }),
        bree: token("bree", { name: "Bree", ...at("bree") }),
      },
    });
    const [first, ...riders] = named;
    return withFalls(base, fallCard({ tokenId: first!, ...(riders.length > 0 ? { riders } : {}) }));
  }

  /** The page the card's Apply opens, every row failed, as the DM's copy holds it. */
  function cardPage(view: RoomState, card: Fall): { page: Page; dice: DiceView } {
    const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view, srd: { monsters: [], rolls: {} } };
    const source: Source = { kind: "fall", fallId: card.id, tokenIds: [card.tokenId, ...(card.riders ?? [])].filter((id) => view.tokens[id]) };
    const test = { kind: "none" as const };
    const rows = groupRows(dice, sourceIds(source, []), test, false, new Map());
    let page: Page = {
      ...newPage({
        id: "p",
        sceneId: sourceScene({ source }, view, GROUND),
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

  /** Applies the card through the reducer as the DM would, again from what it still names, until it goes or nothing applies. */
  function applyAll(state: RoomState): { state: RoomState; applies: number } {
    let applies = 0;
    for (let card = state.falls?.["120:0"]; card && applies < 4; card = state.falls?.["120:0"]) {
      const { page, dice } = cardPage(state, card);
      const plan = buildPlan(page, dice, SIX, ids());
      if (!plan) break;
      assert.ok(opSchema.safeParse(plan).success);
      state = run(state, plan);
      applies++;
    }
    return { state, applies };
  }

  const hp = (state: RoomState, id: string) => {
    const t = state.tokens[id]!;
    return "inline" in t.actor ? t.actor.inline.hp?.cur : state.characters[t.actor.ref]?.actor.hp?.cur;
  };

  test("two riders that show one character take its 6 damage once, 20 to 14, and leave the card together", () => {
    const state = room4(["horse", "thorn", "thorn2"]);
    const { page, dice } = cardPage(state, state.falls!["120:0"]!);
    assert.equal(page.rows.length, 2, "a row for each creature");
    const plan = buildPlan(page, dice, SIX, ids())!;
    assert.deepEqual([...plan.fall!.tokenIds].sort(), ["horse", "thorn", "thorn2"]);
    assert.deepEqual(plan.targets.map((t) => t.target), page.rows.map((r) => r.target), "each creature damaged once");
    const after = applyAll(state);
    assert.deepEqual([hp(after.state, "thorn"), hp(after.state, "horse"), after.applies], [14, 14, 1], "never 8");
    assert.equal(after.state.falls?.["120:0"], undefined, "the card closes once every token it names is settled");
  });

  test("the card's own creature and a rider that share a character, beside a goblin, each take it once and the card goes", () => {
    const after = applyAll(room4(["thorn", "gob", "thorn2"]));
    assert.deepEqual([hp(after.state, "thorn"), hp(after.state, "gob"), after.applies], [14, 14, 1]);
    assert.equal(after.state.falls?.["120:0"], undefined);
  });

  test("the character's other token on another floor leaves with it, and one on another scene stays, as another creature there does", () => {
    const state = room4(["horse", "thorn", "thorn2", "bree"], { thorn2: UPPER, bree: "s2" });
    const { page, dice } = cardPage(state, state.falls!["120:0"]!);
    const plan = buildPlan(page, dice, SIX, ids())!;
    assert.deepEqual([...plan.fall!.tokenIds].sort(), ["horse", "thorn", "thorn2"]);
    const after = run(state, plan);
    assert.deepEqual([after.falls?.["120:0"]?.tokenId, after.falls?.["120:0"]?.riders], ["bree", undefined], "Bree keeps her fall");
    assert.equal(hp(after, "thorn"), 14);
    const away = room4(["horse", "thorn", "thorn2"], { thorn2: "s2" });
    const apart = cardPage(away, away.falls!["120:0"]!);
    assert.deepEqual([...buildPlan(apart.page, apart.dice, SIX, ids())!.fall!.tokenIds].sort(), ["horse", "thorn"], "one the page does not reach stays on the card");
  });

  test("a skipped row's creature still leaves with all its tokens", () => {
    const state = room4(["horse", "thorn", "thorn2"]);
    const { page, dice } = cardPage(state, state.falls!["120:0"]!);
    const skipped = mark(page, page.rows.find((r) => r.tokenId === "thorn")!.holder, "skip");
    const plan = buildPlan(skipped, dice, SIX, ids())!;
    assert.deepEqual([...plan.fall!.tokenIds].sort(), ["horse", "thorn", "thorn2"]);
    assert.deepEqual(plan.targets.map((t) => t.target), [{ tokenId: "horse" }]);
  });

  test("a token that shows another creature now stays on the card", () => {
    const state = room4(["horse", "thorn", "thorn2"]);
    const { page } = cardPage(state, state.falls!["120:0"]!);
    const swapped: RoomState = { ...state, tokens: { ...state.tokens, thorn2: { ...state.tokens.thorn2!, actor: { inline: actor() } } } };
    const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view: swapped, srd: { monsters: [], rolls: {} } };
    assert.deepEqual([...buildPlan(page, dice, SIX, ids())!.fall!.tokenIds].sort(), ["horse", "thorn"]);
  });
});
