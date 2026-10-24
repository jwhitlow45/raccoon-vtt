import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { keys } from "#shared/keys.ts";
import type { Effect, LogEntry, LogEvent, RollRequest, RoomState, Viewer } from "#shared/model.ts";
import { projectEntity } from "#shared/project.ts";
import type { ActorTarget, Op } from "#shared/protocol.ts";
import { reminderPreset, type RollPreset } from "#shared/rules/rollReminders.ts";
import { pendingSaves, type PendingSave } from "#shared/rules/saveEnds.ts";
import { logSeq, remembered, rowTag } from "../dice/optionState.ts";
import { BONUS_WORDS, knownOrTyped, TYPE_BONUS } from "../rolls/card.ts";
import { actor, apply, AT, character, DM, effect, entry, P1, P2, room, token } from "#shared/testutil.ts";
import {
  askSaveOp,
  cardRoll,
  concentrationCard,
  concentrationResistOp,
  concentrationRollTo,
  concentrationWords,
  endConcentrationOps,
  failOp,
  landedOp,
  landedWords,
  passOp,
  pressChip,
  resistOp,
  saveCard,
  saveEndsRollTo,
  saveEndsTest,
  saveFacts,
  settleOp,
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

  test("a creature with no stat block keeps its Roll, with a bonus typed on the card, never a +0 no one gave (owner's no-numbers rule)", () => {
    const view = goblinRoom();
    assert.deepEqual(knownOrTyped(null, "", false), { bonus: null, typing: false, waits: null, error: false }, "nothing typed while the block loads");
    assert.deepEqual(knownOrTyped(null, "", true), { bonus: null, typing: true, waits: TYPE_BONUS, error: false });
    assert.deepEqual(knownOrTyped(null, "+3", true), { bonus: 3, typing: true, waits: null, error: false });
    assert.deepEqual(knownOrTyped(null, "x", true), { bonus: null, typing: true, waits: BONUS_WORDS, error: true });
    assert.deepEqual(knownOrTyped(4, "+3", true), { bonus: 4, typing: false, waits: null, error: false }, "a known bonus wins");
    assert.deepEqual(actionsOf(saveCard(input(view, { bonus: null, typed: true }))), ["Roll d20", "Passed", "Failed", "Dismiss"]);
    assert.deepEqual(actionsOf(saveCard(input(view, { bonus: 3, typed: true }))), ["Roll d20+3", "Passed", "Failed", "Dismiss"]);
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
    assert.deepEqual(actionsOf(saveCard(input(breeRoom(), { bonus: null, typed: true }))), ["Ask Bree", "Roll d20", "Passed", "Failed", "Dismiss"], "with no stat block, Ask and a Roll with a typed bonus");
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
    assert.deepEqual(waitingRollOp(pending, preset, null, "tag1", 3), { t: "roll.dice", tag: "tag1", rollId: "r1", target: { tokenId: "b1" }, mode: "adv", extra: "1d4", bonus: 3, unanswered: true }, "a bonus typed for a creature with no stat block goes with it");
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
    assert.equal(concentrationWords("Thorn", 10, "pass"), "Thorn rolled 10: Concentration holds.");
    assert.equal(concentrationWords("Thorn", 9, "fail"), "Thorn rolled 9: Concentration ended.");
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

  test("a creature with no stat block keeps its Roll, with a bonus typed on the card (owner's no-numbers rule)", () => {
    assert.deepEqual(concentrationCard({ ...base, bonus: null }).buttons.map((b) => b.text), ["Passed", "Failed"]);
    assert.deepEqual(concentrationCard({ ...base, bonus: null, typed: true }).buttons.map((b) => b.text), ["Passed", "Failed", "Roll d20"], "after the marks, which keep their row on a short phone");
    assert.deepEqual(concentrationCard({ ...base, bonus: -1, typed: true }).buttons.map((b) => b.text), ["Passed", "Failed", "Roll d20-1"]);
  });

  test("a fail ends every concentrating effect", () => {
    const effects = [effect("a", { key: "concentrating", spell: "Bless" }), effect("b", { key: "blessed" })];
    assert.deepEqual(endConcentrationOps({ tokenId: "g1" }, effects), [{ t: "actor.effect.remove", target: { tokenId: "g1" }, effectId: "a" }]);
  });
});

/**
 * A card's own roll as the server writes it, and as each viewer then reads
 * it (W7-SOL-01): a DC the players' view of the creature lacks never
 * reaches them on the roll's line either.
 */
test("a recharge card reads its row's roll of this turn only, and the Dice panel's roll of it this turn too", () => {
  const row = "t:d1|actions:fire-breath|recharge";
  // Rolled and failed on the dragon's turn of seq 4, from the card or the panel alike.
  let store = remembered({ tags: {}, since: {} }, row, "tag-old", logSeq([{ id: "3:0" }, { id: "4:1" }]));
  assert.equal(rowTag(store, row), "tag-old", "the Dice panel's row shows its newest roll");
  assert.equal(rowTag(store, row, 9), null, "the next turn's card, from seq 9, offers Roll again");
  store = remembered(store, row, "tag-new", logSeq([{ id: "4:1" }, { id: "9:0" }]));
  assert.equal(rowTag(store, row, 9), "tag-new", "a roll sent since the turn began is the card's, wherever it was tapped");
  assert.equal(logSeq([]), 0);
});

describe("a card's roll keeps a DC players may not see off its line", () => {
  function rolled(state: RoomState, by: Viewer, target: ActorTarget, envelope: { to: "all" | "dm"; dc?: number }): { state: RoomState; id: string } {
    const op: Op = { t: "sys.dice", asked: { t: "dice.roll", tag: "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d", rolls: [{ formula: "1d20+1", creature: target }], ...envelope }, batch: "AbCdEfGhIjKlMnOp", results: [{ formula: "1d20+1", faces: [16], total: 17 }] };
    const next = apply(state, op, by, state.log.length + 1);
    return { state: next, id: next.log.at(-1)!.id };
  }
  function line(state: RoomState, id: string, viewer: Viewer): Extract<LogEvent, { type: "dice" }> | null {
    const seen = projectEntity(keys.log(id), state, viewer, { sceneId: "s1" }) as LogEntry | null;
    return (seen?.data as Extract<LogEvent, { type: "dice" }> | undefined) ?? null;
  }
  /** Bree, p1's character, Frightened until a DC 17 Wisdom save, with her token on the players' scene. */
  function breeRoom(): RoomState {
    const fear = effect("e1", { key: "frightened", save: { ability: "wis", dc: 17 }, due: { id: "5:0", state: "pending" } });
    return room({
      characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ effects: [fear] }) }) },
      tokens: { thorn: token("thorn", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }) },
    });
  }

  test("save ends: a player's character rolls in the open with no DC, which only the DM's view holds", () => {
    const state = breeRoom();
    const pending = pendingSaves(state).find((p) => "characterId" in p.target);
    assert.ok(pending);
    const envelope = saveEndsRollTo(state, pending);
    assert.deepEqual(envelope, { to: "all" });
    const after = rolled(state, DM, pending.target, envelope);
    for (const viewer of [P1, P2]) {
      const bree = projectEntity(keys.character("bree"), after.state, viewer, { sceneId: "s1" }) as { actor: { effects: Effect[] } } | null;
      assert.equal(bree?.actor.effects[0]?.save?.dc, undefined, `${viewer.memberId}: the effect hides its DC`);
      const seen = line(after.state, after.id, viewer);
      assert.equal(seen?.rolls.length, 1, `${viewer.memberId} reads the roll`);
      assert.equal(seen && "dc" in seen, false, `${viewer.memberId}: the line hides the DC too`);
    }
  });

  test("save ends: a monster's roll is hidden from players and keeps its DC for the DMs", () => {
    const state = goblinRoom();
    const pending = only(state);
    const envelope = saveEndsRollTo(state, pending);
    assert.deepEqual(envelope, { to: "dm", dc: 15 });
    const after = rolled(state, DM, pending.target, envelope);
    assert.equal(line(after.state, after.id, DM)?.dc, 15);
    for (const viewer of [P1, P2]) assert.equal(line(after.state, after.id, viewer)?.dc, undefined);
  });

  test("concentration: the owner's roll carries no DC, which tells the damage to a player without exact HP", () => {
    const state = breeRoom();
    state.meta.settings.pcHpVisibleToParty = false;
    state.log = [{ id: "1:0", at: AT, kind: "event", data: { type: "concentration", characterId: "bree", dc: 12 } }];
    const seenBy = (viewer: Viewer) => projectEntity(keys.log("1:0"), state, viewer, { sceneId: "s1" }) as LogEntry | null;
    assert.equal((seenBy(P1)?.data as { dc?: number } | undefined)?.dc, 12, "the owner sees the DC");
    assert.equal((seenBy(P2)?.data as { dc?: number } | undefined)?.dc, undefined, "another player does not");
    const prompt = { target: { characterId: "bree" }, dc: 12 };
    const envelope = concentrationRollTo(state, false, prompt);
    assert.deepEqual(envelope, { to: "all" });
    const after = rolled(state, P1, prompt.target, envelope);
    const seen = line(after.state, after.id, P2);
    assert.equal(seen?.rolls.length, 1);
    assert.equal(seen && "dc" in seen, false);
    // A DM's monster rolls in secret, so its DC stays on the line for the DMs alone.
    assert.deepEqual(concentrationRollTo(goblinRoom(), true, { target: { tokenId: "g2" }, dc: 11 }), { to: "dm", dc: 11 });
  });
});
