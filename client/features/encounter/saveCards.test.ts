import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { Effect, LogEntry, RollRequest, RoomState } from "#shared/model.ts";
import { reminderPreset, type RollPreset } from "#shared/rules/rollReminders.ts";
import { pendingSaves, type PendingSave } from "#shared/rules/saveEnds.ts";
import { actor, AT, character, effect, entry, room, token } from "#shared/testutil.ts";
import {
  askSaveOp,
  cardRoll,
  concentrationCard,
  concentrationResistOp,
  concentrationWords,
  endConcentrationOps,
  failOp,
  landedOp,
  landedWords,
  passOp,
  pressChip,
  rechargePrompts,
  rechargeTurn,
  recharged,
  resistOp,
  saveCard,
  saveEndsTest,
  saveFacts,
  settleOp,
  turnStarted,
  waitingRollOp,
  type SaveCardInput,
} from "./saveCards.ts";

const NO_PRESET: RollPreset = { sources: [], extra: [], notes: [] };

function frightened(id: string, due: Effect["due"], spell = false): Effect {
  return effect(id, { key: "frightened", save: { ability: "wis", dc: 15, ...(spell ? { spell: true as const } : {}) }, ...(due ? { due } : {}) });
}

/** Goblin 2 on the players' scene, Frightened with a save pending, and Legendary Resistance as given. */
function goblinRoom(opts: { resist?: { max: number; used: number }; effects?: Effect[] } = {}): RoomState {
  const effects = opts.effects ?? [frightened("e1", { id: "5:0", state: "pending" })];
  const legendary = opts.resist ? { legendary: { actionsMax: 3, actionsUsed: 0, resistMax: opts.resist.max, resistUsed: opts.resist.used } } : {};
  return room({ tokens: { g2: token("g2", { name: "Goblin", number: 2, actor: { inline: actor({ effects, ...legendary }) } }) } });
}

function only(view: RoomState): PendingSave {
  const [first, ...rest] = pendingSaves(view);
  assert.ok(first);
  assert.equal(rest.length, 0);
  return first;
}

function input(view: RoomState, over: Partial<SaveCardInput> = {}): SaveCardInput {
  const pending = only(view);
  return { pending, facts: saveFacts(view, pending.target), bonus: 1, loading: false, preset: NO_PRESET, failTapped: false, rolled: null, ...over };
}

const actionsOf = (card: ReturnType<typeof saveCard>) => card.buttons.map((b) => b.text);

describe("save-ends cards", () => {
  test("one card per pending occurrence, and none for a settled one, as a reload rebuilds them", () => {
    const view = room({
      tokens: {
        g1: token("g1", { actor: { inline: actor({ effects: [frightened("a", { id: "4:0", state: "resolved" })] }) } }),
        g2: token("g2", { name: "Goblin", number: 2, actor: { inline: actor({ effects: [frightened("b", { id: "6:0", state: "pending" }), frightened("c", { id: "6:1", state: "pending" })] }) } }),
      },
      characters: { c1: character("c1", { name: "Bree", actor: actor({ effects: [frightened("d", { id: "5:0", state: "dismissed" }), frightened("e", undefined)] }) }) },
    });
    const cards = pendingSaves(view);
    assert.deepEqual(
      cards.map((p) => p.effect.due.id),
      ["6:0", "6:1"],
    );
    const card = saveCard(input(goblinRoom()));
    assert.equal(card.head, "Goblin 2 ended its turn Frightened.");
    assert.equal(card.save, "Wisdom save, DC 15, ends it.");
  });

  test("a monster with no Legendary Resistance: Roll, Passed, Failed and Dismiss, and a fail settles at once", () => {
    const view = goblinRoom();
    const card = saveCard(input(view));
    assert.deepEqual(actionsOf(card), ["Roll +1", "Passed", "Failed", "Dismiss"]);
    const pending = only(view);
    assert.deepEqual(failOp(pending, 0, "tag1"), { t: "actor.saveDue", target: { tokenId: "g2" }, effectId: "e1", due: "5:0", state: "resolved" });
    assert.deepEqual(landedOp(pending, 9, 0), { t: "actor.saveDue", target: { tokenId: "g2" }, effectId: "e1", due: "5:0", state: "resolved" });
    // The roll's fail is settled as it lands (landedOp), so no extra Accept is needed, and the notice tells it as the card goes.
    assert.equal(saveCard(input(view, { rolled: 9 })).status, "Rolled 9: a fail.");
    assert.equal(landedWords(pending, "Goblin 2", 9, 0), "Goblin 2 rolled 9: still Frightened.");
    assert.equal(landedWords(pending, "Goblin 2", 9, 2), null);
    assert.equal(landedWords(pending, "Goblin 2", 15, 2), "Goblin 2 rolled 15: Frightened ended.");
  });

  test("a monster with Legendary Resistance left: a fail waits on Use Legendary Resistance or Accept failure", () => {
    const view = goblinRoom({ resist: { max: 3, used: 1 } });
    const pending = only(view);
    assert.equal(saveFacts(view, pending.target).legendaryLeft, 2);
    assert.deepEqual(actionsOf(saveCard(input(view))), ["Roll +1", "Passed", "Failed", "Dismiss"]);
    assert.equal(failOp(pending, 2, "tag1"), null);
    assert.equal(landedOp(pending, 9, 2), null);
    for (const failed of [input(view, { rolled: 9 }), input(view, { failTapped: true })]) {
      assert.deepEqual(actionsOf(saveCard(failed)), ["Use Legendary Resistance (2 left)", "Accept failure"]);
      // The last use spent on another device meanwhile: the fail still has its one tap.
      assert.deepEqual(actionsOf(saveCard({ ...failed, facts: { ...failed.facts, legendaryLeft: 0 } })), ["Accept failure"]);
    }
    assert.deepEqual(resistOp(pending, "plan1"), {
      t: "actor.outcome",
      plan: "plan1",
      label: "Legendary Resistance",
      targets: [{ target: { tokenId: "g2" }, resist: true, remove: ["e1"] }],
    });
    assert.deepEqual(settleOp(pending, "resolved"), { t: "actor.saveDue", target: { tokenId: "g2" }, effectId: "e1", due: "5:0", state: "resolved" });
    // Used up: no choice is left, so a fail settles as it did before.
    const spent = goblinRoom({ resist: { max: 3, used: 3 } });
    assert.equal(saveFacts(spent, only(spent).target).legendaryLeft, 0);
  });

  test("a pass, typed or rolled, ends the effect, and the card's Dismiss settles it dismissed", () => {
    const view = goblinRoom();
    const pending = only(view);
    assert.deepEqual(passOp(pending, "tag1"), { t: "actor.effect.remove", target: { tokenId: "g2" }, effectId: "e1" });
    assert.deepEqual(landedOp(pending, 15, 0), { t: "actor.effect.remove", target: { tokenId: "g2" }, effectId: "e1" });
    assert.deepEqual(landedOp(pending, 15, 2), { t: "actor.effect.remove", target: { tokenId: "g2" }, effectId: "e1" });
    assert.deepEqual(saveCard(input(view, { rolled: 15 })).buttons, []);
    assert.deepEqual(settleOp(pending, "dismissed"), { t: "actor.saveDue", target: { tokenId: "g2" }, effectId: "e1", due: "5:0", state: "dismissed" });
  });

  test("a fails preset marks it failed, with no roll that could pass", () => {
    const view = goblinRoom({ effects: [effect("e1", { key: "restrained", save: { ability: "dex", dc: 13 }, due: { id: "5:0", state: "pending" } }), effect("s", { key: "stunned" })] });
    const pending = only(view);
    const goblin = view.tokens.g2?.actor;
    const preset = reminderPreset(goblin && "inline" in goblin ? goblin.inline.effects : [], saveEndsTest(pending.effect));
    assert.equal(preset.fails, "stunned");
    const card = saveCard(input(view, { preset }));
    assert.equal(card.status, "Fails: Stunned.");
    assert.deepEqual(actionsOf(card), ["Accept failure"]);
  });

  test("the card's roll carries its preset and its own chip, never the panel's", () => {
    const view = goblinRoom({ effects: [frightened("e1", { id: "5:0", state: "pending" }, true)] });
    const pending = only(view);
    assert.deepEqual(saveEndsTest(pending.effect), { kind: "save", ability: "wis", cause: "saveEnds", spell: true });
    const preset: RollPreset = { sources: [{ kind: "adv", from: "magic-resistance" }], extra: ["+1d4"], extraFrom: ["blessed"], notes: [] };
    const roll = cardRoll(pending.target, 1, preset, saveEndsTest(pending.effect), "dis");
    assert.equal(roll.formula, "1d20+1+1d4");
    assert.equal(roll.label, "Wisdom save");
    assert.deepEqual(roll.sources, [
      { kind: "adv", from: "magic-resistance" },
      { kind: "dis", from: "pressed" },
    ]);
    assert.equal(pressChip(null, "adv"), "adv");
    assert.equal(pressChip("adv", "dis"), "dis");
    assert.equal(pressChip("dis", "dis"), null);
    assert.equal(saveCard(input(view, { preset })).rollNote, "Adv: Magic Resistance. +1d4: Blessed");
  });

  test("while the block loads, Roll waits, and a creature with no bonus has none", () => {
    const view = goblinRoom();
    const loading = saveCard(input(view, { bonus: null, preset: null, loading: true }));
    assert.deepEqual(actionsOf(loading), ["Roll", "Passed", "Failed", "Dismiss"]);
    assert.equal(loading.rollLoading, true);
    assert.deepEqual(actionsOf(saveCard(input(view, { bonus: null, loading: false }))), ["Passed", "Failed", "Dismiss"]);
  });
});

describe("a save-ends card for a creature a player plays", () => {
  function breeRoom(over: { sceneId?: string; rolls?: Record<string, RollRequest> } = {}): RoomState {
    return room({
      tokens: { b1: token("b1", { kind: "pc", name: "Bree", ownerIds: ["p1"], sceneId: over.sceneId ?? "s1", actor: { inline: actor({ effects: [frightened("e1", { id: "7:0", state: "pending" }, true)] }) } }) },
      rolls: over.rolls ?? {},
    });
  }

  function request(over: Partial<RollRequest["targets"][number]> = {}): Record<string, RollRequest> {
    return {
      r1: {
        id: "r1",
        rev: 0,
        test: { kind: "save", choices: [{ ability: "wis" }] },
        dc: 15,
        dcShown: false,
        resultShown: true,
        spell: true,
        cause: "saveEnds",
        ends: { effect: "e1", occurrence: "7:0" },
        at: AT,
        targets: [{ tokenId: "b1", ...over }],
      },
    };
  }

  test("starts with Ask, one request through askOp with its switches set and the occurrence named", () => {
    const view = breeRoom();
    const pending = only(view);
    assert.deepEqual(actionsOf(saveCard(input(view))), ["Ask Bree", "Roll +1", "Passed", "Failed", "Dismiss"]);
    const asked = askSaveOp(pending, "r9", 0);
    assert.ok(asked.ok);
    assert.deepEqual(asked.op, {
      t: "roll.ask",
      request: {
        id: "r9",
        test: { kind: "save", choices: [{ ability: "wis" }] },
        dc: 15,
        dcShown: false,
        resultShown: true,
        spell: true,
        cause: "saveEnds",
        ends: { effect: "e1", occurrence: "7:0" },
        targets: [{ tokenId: "b1" }],
      },
    });
    assert.equal(askSaveOp(pending, "r9", 20).ok, false);
  });

  test("off the players' scene no request can go: Roll when the bonus is known", () => {
    const view = breeRoom({ sceneId: "s2" });
    const card = saveCard(input(view));
    assert.deepEqual(actionsOf(card), ["Roll +1", "Passed", "Failed", "Dismiss"]);
    assert.equal(card.status, "Bree is not on the players' scene, so no request can go.");
    assert.deepEqual(actionsOf(saveCard(input(view, { bonus: null }))), ["Passed", "Failed", "Dismiss"]);
  });

  test("once asked: a waiting Roll that sends roll.dice unanswered, marks on the request, and closes that settle", () => {
    const view = breeRoom({ rolls: request() });
    const pending = only(view);
    assert.equal(pending.request?.id, "r1");
    const card = saveCard(input(view));
    assert.equal(card.status, "Asked Bree. Waiting for the roll.");
    assert.deepEqual(actionsOf(card), ["Roll +1", "Passed", "Failed", "Dismiss"]);
    const preset: RollPreset = { sources: [{ kind: "adv", from: "magic-resistance" }], extra: ["+1d4"], notes: [] };
    assert.deepEqual(waitingRollOp(pending, preset, "dis", "tag1"), { t: "roll.dice", tag: "tag1", rollId: "r1", target: { tokenId: "b1" }, cancelled: true, extra: "1d4", unanswered: true });
    assert.deepEqual(waitingRollOp(pending, preset, "adv", "tag1"), { t: "roll.dice", tag: "tag1", rollId: "r1", target: { tokenId: "b1" }, mode: "adv", extra: "1d4", unanswered: true });
    assert.deepEqual(passOp(pending, "tag2"), { t: "roll.answer", rollId: "r1", target: { tokenId: "b1" }, result: "pass", tag: "tag2" });
    // A DM's Fail mark leaves the request open, whatever Legendary Resistance is left.
    assert.deepEqual(failOp(pending, 0, "tag3"), { t: "roll.answer", rollId: "r1", target: { tokenId: "b1" }, result: "fail", tag: "tag3" });
    assert.deepEqual(settleOp(pending, "resolved"), { t: "roll.close", rollIds: ["r1"], settle: "resolved" });
    assert.deepEqual(settleOp(pending, "dismissed"), { t: "roll.close", rollIds: ["r1"], settle: "dismissed" });
  });

  test("a failed answer shows with Accept failure, and a pending ask to change it as text", () => {
    const failed = breeRoom({ rolls: request({ total: 9, result: "fail", tag: "a1", dice: { formula: "1d20+1", faces: [8], total: 9 } }) });
    const card = saveCard(input(failed));
    assert.equal(card.status, "Bree rolled 9: a fail.");
    assert.deepEqual(actionsOf(card), ["Accept failure"]);
    const asking = breeRoom({ rolls: request({ total: 9, result: "fail", tag: "a1", dice: { formula: "1d20+1", faces: [8], total: 9 }, change: { id: "x1", on: "a1", reason: "heroic-inspiration", face: 8 } }) });
    assert.equal(saveCard(input(asking)).status, "Bree rolled 9: a fail. Bree asks to reroll (Heroic Inspiration).");
    const typed = breeRoom({ rolls: request({ total: 12, result: "fail", tag: "a1" }) });
    assert.equal(saveCard(input(typed)).status, "Bree answered 12: a fail.");
    const marked = breeRoom({ rolls: request({ result: "fail", mark: "fail", tag: "a1" }) });
    assert.equal(saveCard(input(marked)).status, "Marked failed.");
    // A pass ends the effect on the server in the answer's op, so nothing is left to tap.
    const passed = breeRoom({ rolls: request({ total: 17, result: "pass", tag: "a1" }) });
    assert.deepEqual(saveCard(input(passed)).buttons, []);
  });

  test("a character a player owns is asked by its character", () => {
    const view = room({ characters: { c1: character("c1", { name: "Bree", actor: actor({ effects: [frightened("e1", { id: "7:0", state: "pending" })] }) }) } });
    const pending = only(view);
    assert.deepEqual(pending.target, { characterId: "c1" });
    assert.deepEqual(saveFacts(view, pending.target), { name: "Bree", played: true, askable: true, legendaryLeft: 0 });
  });
});

describe("the concentration card", () => {
  const base = { dc: 10, bonus: 2, loading: false, preset: NO_PRESET, legendaryLeft: 0, failTapped: false, rolled: null };

  test("Roll beside Passed and Failed, and the DC decides a roll", () => {
    assert.deepEqual(
      concentrationCard(base).buttons.map((b) => b.text),
      ["Roll +2", "Passed", "Failed"],
    );
    assert.equal(concentrationCard({ ...base, rolled: 10 }).decided, "pass");
    assert.equal(concentrationCard({ ...base, rolled: 9 }).decided, "fail");
    assert.deepEqual(
      concentrationCard({ ...base, rolled: 9 }).buttons.map((b) => b.text),
      ["Accept failure"],
    );
    assert.equal(concentrationWords("Thorn", 10, "pass"), "Thorn rolled 10: concentration holds.");
    assert.equal(concentrationWords("Thorn", 9, "fail"), "Thorn rolled 9: concentration ended.");
  });

  test("Legendary Resistance left: a fail waits on Use Legendary Resistance or Accept failure", () => {
    for (const card of [concentrationCard({ ...base, legendaryLeft: 2, rolled: 4 }), concentrationCard({ ...base, legendaryLeft: 2, failTapped: true })]) {
      assert.equal(card.decided, null);
      assert.deepEqual(
        card.buttons.map((b) => b.text),
        ["Use Legendary Resistance (2 left)", "Accept failure"],
      );
    }
    assert.deepEqual(concentrationResistOp({ tokenId: "g1" }, "plan1"), { t: "actor.outcome", plan: "plan1", label: "Legendary Resistance", targets: [{ target: { tokenId: "g1" }, resist: true }] });
  });

  test("without the DC the total shows, and Passed or Failed decide", () => {
    const card = concentrationCard({ ...base, dc: undefined, rolled: 14 });
    assert.equal(card.status, "Rolled 14.");
    assert.equal(card.decided, null);
    assert.deepEqual(
      card.buttons.map((b) => b.text),
      ["Passed", "Failed"],
    );
  });

  test("a fail ends every concentrating effect", () => {
    const effects = [effect("a", { key: "concentrating", spell: "Bless" }), effect("b", { key: "blessed" })];
    assert.deepEqual(endConcentrationOps({ tokenId: "g1" }, effects), [{ t: "actor.effect.remove", target: { tokenId: "g1" }, effectId: "a" }]);
  });
});

describe("recharge prompts", () => {
  const breath: NamedRoll = { key: "actions:fire-breath", name: "Fire Breath", section: "actions", damage: [{ formula: "16d6", type: "fire" }], recharge: 5 };
  const bite: NamedRoll = { key: "actions:bite", name: "Bite", section: "actions", attack: 10, damage: [{ formula: "2d10+6", type: "piercing" }] };
  const roar: NamedRoll = { key: "actions:roar", name: "Roar", section: "actions", damage: [], recharge: 6 };
  const view = room({
    tokens: { d1: token("d1", { name: "Young Red Dragon" }), b1: token("b1", { kind: "pc", name: "Bree", ownerIds: ["p1"] }) },
    encounter: { rev: 0, round: 2, activeEntryId: "x1", entries: [entry("x1", { tokenId: "d1" }), entry("x2", { tokenId: "b1" })] },
  });
  const line = (data: Extract<LogEntry["data"], { type: "turn" }>): LogEntry => ({ id: "9:0", at: AT, kind: "event", data }) as LogEntry;

  test("a turn starts on next, and not on Previous", () => {
    assert.equal(turnStarted(line({ type: "turn", entryId: "x1", round: 2 })), "x1");
    assert.equal(turnStarted(line({ type: "turn", entryId: "x1", round: 2, back: true })), null);
  });

  test("only actions marked Used, at their monster's turn start", () => {
    const used = { "t:d1": ["actions:fire-breath", "actions:bite"] };
    const turn = rechargeTurn(view, "9:0", "x1", used);
    assert.ok(turn);
    assert.deepEqual(turn.creature, { tokenId: "d1" });
    const prompts = rechargePrompts(turn, [breath, bite, roar]);
    assert.deepEqual(
      prompts.map((p) => p.text),
      ["Fire Breath can recharge (5–6)."],
    );
    assert.equal(prompts[0]?.row, "t:d1|actions:fire-breath|recharge");
    // Nothing marked Used: no prompt, and no block to load.
    assert.equal(rechargeTurn(view, "9:0", "x1", {}), null);
    // A creature a player plays is never prompted.
    assert.equal(rechargeTurn(view, "9:0", "x2", { "t:b1": ["actions:fire-breath"] }), null);
    assert.deepEqual(
      rechargePrompts({ ...turn, used: ["actions:roar"] }, [breath, roar]).map((p) => p.text),
      ["Roar can recharge (6)."],
    );
  });

  test("a recharge succeeds at or above its number", () => {
    assert.equal(recharged(5, 5), true);
    assert.equal(recharged(6, 5), true);
    assert.equal(recharged(4, 5), false);
  });
});
