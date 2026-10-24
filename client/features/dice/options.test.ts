import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import { createStore } from "zustand/vanilla";
import type { DiceRoll, LogEntry, RollRequest, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { actor, castAsk, character, entry, room, token } from "#shared/testutil.ts";
import { reminderPreset } from "#shared/rules/rollReminders.ts";
import type { CastBlock, OptionState } from "./optionState.ts";
import { createDiceFolds } from "./diceFolds.ts";
import { ReceiptTracker } from "./useReceipt.ts";
import { watchInitiative, type InitiativeEnv } from "./useRollOption.ts";
import { TYPE_BONUS, BONUS_WORDS, parseBonus } from "../rolls/card.ts";
import { creatureRolls } from "./creature.ts";
import {
  asInitiative,
  asSave,
  commonTags,
  creatureKey,
  CRIT_WORDS,
  critical,
  cutLabel,
  d20Roll,
  damageRolls,
  dayCount,
  dayUseOf,
  dropOldRechargeMarks,
  foldSummary,
  groupAsks,
  groupNote,
  holderTarget,
  initiativeOp,
  initiativeRow,
  initiativeTag,
  markOf,
  markOnRoll,
  noNumbersNote,
  openForAsks,
  playerCreatures,
  presetLine,
  rechargeUseOf,
  resultWords,
  routedTest,
  routeOf,
  sameSpell,
  scoreOf,
  spellLevels,
  spendOnStart,
  spendsFor,
  testLabel,
  typedTap,
  typedText,
  withExtra,
} from "./options.ts";
import type { DayUse, LimitedUse, RechargeUse } from "#shared/dice/uses.ts";
import type { UseMark } from "#shared/model.ts";
import { abilityOp } from "../combat/logic.ts";
import type { RollPreset } from "#shared/rules/rollReminders.ts";

/** The roll options' rules (docs/design-v1-roll-options.md 4.2 and 4.3). */

function table(rolls: Record<string, RollRequest> = {}): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) },
    tokens: {
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
      gob: token("gob", { kind: "monster", name: "Goblin", actor: { inline: actor({ initScore: 12 }) } }),
    },
    rolls,
    encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-bree", { characterId: "bree", value: null }), entry("e-gob", { tokenId: "gob", value: 7 })] },
  });
}

function request(overrides: Partial<RollRequest> = {}): RollRequest {
  return { id: "r1", rev: 0, test: { kind: "save", choices: [{ ability: "wis" }, { ability: "dex" }] }, dc: 13, dcShown: false, resultShown: true, at: "2026-10-17T20:00:00.000Z", targets: [{ characterId: "bree" }], ...overrides };
}

describe("where a save or check tap goes", () => {
  test("an open request that asks the creature this test takes the roll as its answer, by its token or its character, for the DM whatever Ask says", () => {
    const state = table({ r1: request() });
    for (const creature of [{ tokenId: "breeTok" }, { characterId: "bree" }]) {
      const route = routeOf({ state, creature, test: { kind: "save", ability: "dex" }, dm: false, played: false, ask: false });
      assert.equal(route.kind, "answer");
      assert.equal(route.kind === "answer" && route.choice, 1);
    }
    assert.equal(routeOf({ state, creature: { tokenId: "breeTok" }, test: { kind: "save", ability: "dex" }, dm: true, played: true, ask: true }).kind, "answer");
    assert.equal(routeOf({ state, creature: { tokenId: "breeTok" }, test: { kind: "save", ability: "str" }, dm: false, played: false, ask: false }).kind, "roll", "a test the request does not ask");
  });

  test("an answer rolls the request's own test, so a save against a spell keeps the creature's Magic Resistance (ASTRA-09)", () => {
    const state = table({ r1: request({ spell: true, cause: "saveEnds" }) });
    const dex = { kind: "save" as const, ability: "dex" as const };
    const route = routeOf({ state, creature: { characterId: "bree" }, test: dex, dm: false, played: false, ask: false });
    assert.deepEqual(routedTest(route, dex), { kind: "save", ability: "dex", cause: "saveEnds", spell: true });
    assert.deepEqual(reminderPreset([], routedTest(route, dex), { magicResistance: true }).sources, [{ kind: "adv", from: "magic-resistance" }]);
    assert.deepEqual(reminderPreset([], dex, { magicResistance: true }).sources, [], "the option's own test knows of no spell");
    const free = routeOf({ state: table({}), creature: { characterId: "bree" }, test: dex, dm: false, played: false, ask: false });
    assert.equal(routedTest(free, dex), dex, "a free roll rolls the option's test");
  });

  test("an answered target rolls, and a check matches its skill too", () => {
    const answered = table({ r1: request({ targets: [{ characterId: "bree", total: 12 }] }) });
    assert.equal(routeOf({ state: answered, creature: { characterId: "bree" }, test: { kind: "save", ability: "dex" }, dm: false, played: false, ask: false }).kind, "roll");
    const check = table({ r1: request({ test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] } }) });
    assert.equal(routeOf({ state: check, creature: { characterId: "bree" }, test: { kind: "check", ability: "wis", skill: "perception" }, dm: false, played: false, ask: false }).kind, "answer");
    assert.equal(routeOf({ state: check, creature: { characterId: "bree" }, test: { kind: "check", ability: "wis" }, dm: false, played: false, ask: false }).kind, "roll");
  });

  test("the DM's Ask switch on a creature a player plays: on asks, off rolls, and attacks always roll", () => {
    const state = table();
    const save = { kind: "save" as const, ability: "dex" as const };
    assert.equal(routeOf({ state, creature: { tokenId: "breeTok" }, test: save, dm: true, played: true, ask: true }).kind, "ask");
    assert.equal(routeOf({ state, creature: { tokenId: "breeTok" }, test: save, dm: true, played: true, ask: false }).kind, "roll");
    assert.equal(routeOf({ state, creature: { tokenId: "breeTok" }, test: { kind: "attack" }, dm: true, played: true, ask: true }).kind, "roll");
    assert.equal(routeOf({ state, creature: { tokenId: "gob" }, test: save, dm: true, played: false, ask: true }).kind, "roll");
  });
});

describe("a creature with no numbers", () => {
  test("lists its saves and checks with no bonus shown: the DM's ask needs none, and a roll here waits for the bonus typed (owner's no-numbers rule)", () => {
    const state = table();
    const dm = creatureRolls({ you: { memberId: "dm1", role: "dm" }, view: state, srd: { monsters: [], rolls: {} } }, { tokenId: "breeTok" })!;
    assert.equal(dm.numbers, null, "Bree has no stat block");
    assert.equal(dm.initBonus, state.characters.bree!.actor.initBonus, "its initiative is the card's own");
    const save = { kind: "save" as const, ability: "dex" as const };
    const asks = routeOf({ state, creature: { tokenId: "breeTok" }, test: save, dm: true, played: true, ask: true }).kind;
    assert.deepEqual(typedTap(asks, null), { bonus: null, waits: null }, "an ask goes with nothing typed");
    const rolls = routeOf({ state, creature: { tokenId: "breeTok" }, test: save, dm: true, played: true, ask: false }).kind;
    assert.deepEqual(typedTap(rolls, null), { bonus: null, waits: TYPE_BONUS }, "never a +0 no one gave");
    assert.deepEqual(typedTap(rolls, parseBonus("+3")), { bonus: 3, waits: null });
    assert.deepEqual(typedTap(rolls, parseBonus("+99")), { bonus: null, waits: BONUS_WORDS });
    const answer = routeOf({ state: table({ r1: request() }), creature: { characterId: "bree" }, test: save, dm: false, played: false, ask: false }).kind;
    assert.equal(answer, "answer");
    assert.deepEqual(typedTap(answer, null), { bonus: null, waits: TYPE_BONUS }, "a player's answer rolls here too");
    assert.deepEqual([typedText("STR", null), typedText("Athletics", parseBonus("-1"))], ["STR d20", "Athletics d20-1"]);
  });

  test("its note says why no bonus shows and what a tap does", () => {
    assert.equal(noNumbersNote({ name: "Bree", hidden: false, rollsHere: false }), "No stat block, so no bonus is known. A save or check tap asks its player.");
    assert.equal(noNumbersNote({ name: "Bree", hidden: false, rollsHere: true }), "No stat block, so no bonus is known. Type the bonus of the roll you make, then tap it.");
    assert.equal(noNumbersNote({ name: "Thorn", hidden: true, rollsHere: true }), "Thorn's numbers are for the DM and its own players. Type the bonus of the roll you make, then tap it.");
  });
});

describe("initiative", () => {
  test("is written only to a row that still holds its value at the tap, as the DM's or the player's op", () => {
    const state = table();
    assert.deepEqual(initiativeOp(state, "e-bree", null, 17, false), { t: "encounter.setValue", entryId: "e-bree", value: 17 });
    assert.deepEqual(initiativeOp(state, "e-gob", 7, 15, true), { t: "encounter.setValues", values: [{ entryId: "e-gob", value: 15 }] });
    assert.equal(initiativeOp(state, "e-gob", null, 15, true), null, "typed meanwhile");
    assert.equal(initiativeOp(state, "gone", null, 15, true), null);
    assert.deepEqual(initiativeOp(state, "e-bree", null, 140, false), { t: "encounter.setValue", entryId: "e-bree", value: 100 }, "clamped as a typed value is");
    assert.deepEqual(initiativeOp(state, "e-bree", null, 17, false, "t1"), { t: "encounter.setValue", entryId: "e-bree", value: 17, roll: "t1" }, "a player's names its roll, for a room with typed totals off");
    assert.deepEqual(initiativeOp(state, "e-gob", 7, 15, true, "t1"), { t: "encounter.setValues", values: [{ entryId: "e-gob", value: 15 }] }, "the DM's needs none");
  });

  test("a token of a character finds the character's row, and a room using scores gives a monster its score", () => {
    const state = table();
    assert.equal(initiativeRow(state, { tokenId: "breeTok" })?.id, "e-bree");
    assert.equal(initiativeRow(state, { tokenId: "gob" })?.id, "e-gob");
    assert.equal(scoreOf(state, { tokenId: "gob" }), null, "scores off");
    state.meta.settings.monsterInitScore = true;
    assert.equal(scoreOf(state, { tokenId: "gob" }), 12);
    assert.equal(scoreOf(state, { tokenId: "breeTok" }), null, "never a character's");
  });
});

describe("a roll's words", () => {
  test("labels name the roll, never the creature, cut to 60", () => {
    assert.equal(testLabel({ kind: "save", ability: "dex" }), "Dexterity save");
    assert.equal(testLabel({ kind: "check", ability: "dex", skill: "stealth" }), "Stealth check");
    assert.equal(testLabel({ kind: "deathSave" }), "Death Save");
    assert.equal(cutLabel("x".repeat(80)).length, 60);
  });

  test("a preset's few words and its extra after the bonus", () => {
    assert.equal(presetLine({ sources: [{ kind: "dis", from: "restrained" }], extra: ["-2", "+1d4"], extraFrom: ["exhaustion", "blessed"], notes: [] }), "Dis: Restrained. -2: Exhaustion. +1d4: Blessed");
    assert.equal(presetLine({ sources: [], extra: [], fails: "stunned", notes: [] }), "Fails: Stunned");
    assert.equal(withExtra("1d20+2", ["-2", "+1d4"]), "1d20+2-2+1d4");
    const roll = d20Roll({ tokenId: "gob" }, 4, { sources: [{ kind: "dis", from: "poisoned" }], extra: [], notes: [] }, "Scimitar", 19);
    assert.deepEqual(roll, { formula: "1d20+4", label: "Scimitar", creature: { tokenId: "gob" }, sources: [{ kind: "dis", from: "poisoned" }], critOn: 19 });
  });
});

describe("damage, critical hits and results", () => {
  const rapier: NamedRoll = {
    key: "r",
    name: "Rapier",
    section: "actions",
    attack: 7,
    damage: [
      { formula: "1d8+4", type: "piercing" },
      { formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" },
      { formula: "1d6", type: "fire", optional: true, name: "if it is lit" },
    ],
  };

  test("riders toggled on join the one line, one roll per type, a critical sent as asked for the server's rule", () => {
    assert.deepEqual(damageRolls(rapier, { on: new Set(), critical: false }), [{ formula: "1d8+4", label: "Rapier damage, Piercing", type: "piercing" }]);
    assert.deepEqual(damageRolls(rapier, { on: new Set([1, 2]), critical: true, creature: { characterId: "bree" } }), [
      { formula: "1d8+4+3d6", label: "Rapier critical damage and Sneak Attack, Piercing", creature: { characterId: "bree" }, critical: true, type: "piercing" },
      { formula: "1d6", label: "Rapier critical damage and Sneak Attack, Fire", creature: { characterId: "bree" }, critical: true, type: "fire" },
    ]);
  });

  test("each roll carries its damage type on its line, whatever its label is cut to, and an untyped part carries none (docs/design-v1-combat-controls.md 3.4)", () => {
    const long: NamedRoll = { ...rapier, name: "A blade whose name runs on far past what a dice label can hold whole", damage: [rapier.damage[0]!, { formula: "2d6" }] };
    const rolls = damageRolls(long, { on: new Set(), critical: false });
    assert.deepEqual(
      rolls.map((r) => [r.formula, r.type]),
      [
        ["1d8+4", "piercing"],
        ["2d6", undefined],
      ],
    );
    assert.ok(!rolls[0]!.label!.includes("Piercing"), "the label lost its type to the cut, and the line still has it");
    assert.ok(!("type" in rolls[1]!), "no type key at all on an untyped roll");
  });

  test("the critical range: a kept 19 crits under critOn 19, a 1 misses, and a result reads its total and natural", () => {
    const at = (faces: number[], critOn?: 18 | 19): DiceRoll => ({ formula: "1d20+7", faces, total: faces[0]! + 7, ...(critOn ? { critOn } : {}) });
    assert.equal(critical(at([19], 19)), true);
    assert.equal(critical(at([19])), false);
    assert.equal(resultWords([at([20])], "attack"), "27, Natural 20. Critical damage next.");
    assert.equal(resultWords([at([1])], "attack"), "8, Natural 1: a miss");
    assert.equal(resultWords([{ formula: "1d20+2", faces: [9], total: 11, fails: "stunned" }], "d20"), "11, fails (Stunned)");
    assert.equal(resultWords([{ formula: "1d6", faces: [5], total: 5 }], "recharge", { recharge: 5 }), "Recharged (5)");
    assert.equal(resultWords([{ formula: "1d6", faces: [3], total: 3 }], "recharge", { recharge: 5 }), "Not yet (3)");
    assert.equal(resultWords([{ formula: "1d8+4", faces: [3], total: 7, label: "Rapier damage, piercing" }, { formula: "2d6", faces: [2, 2], total: 4, label: "Rapier damage, fire" }], "damage"), "11: 7 piercing, 4 fire");
  });

  test("a critical damage's row says how its total was reached, and the Damage cell names the room's rule (the critical hit rules addendum)", () => {
    const slashing: DiceRoll = { formula: "2d6+3", faces: [4, 6], total: 25, crit: "maxPlusRoll", label: "Scimitar critical damage, slashing" };
    const fire: DiceRoll = { formula: "1d6", faces: [2], total: 8, crit: "maxPlusRoll", label: "Scimitar critical damage, fire" };
    assert.equal(resultWords([slashing], "damage"), "25 (12 max + 13)");
    assert.equal(resultWords([slashing, fire], "damage"), "33: 25 slashing (12 max + 13), 8 fire (6 max + 2)");
    assert.equal(resultWords([{ ...slashing, formula: "4d6+3", faces: [1, 2, 5, 6], total: 17, crit: "rollTwice" }], "damage"), "17");
    assert.deepEqual(Object.values(CRIT_WORDS), ["Critical: dice rolled twice", "Critical: max plus a roll", "Critical: dice doubled", "Critical: total doubled"]);
  });

  test("a save goes as a save of its ability, so the server records what fails it, and a check does not", () => {
    const roll = d20Roll({ tokenId: "gob" }, 2, { sources: [], extra: [], notes: [] }, "Dexterity save");
    assert.equal(asSave(roll, { kind: "save", ability: "dex" }).save, "dex");
    assert.equal(asSave(roll, { kind: "check", ability: "dex" }).save, undefined);
  });

  test("initiative goes marked as initiative, so the server keeps a hidden-order creature's roll from players, and no other test does (docs/design-v1-combat-flow.md 11.3)", () => {
    const roll = d20Roll({ tokenId: "gob" }, 2, { sources: [], extra: [], notes: [] }, "Initiative");
    assert.equal(asInitiative(roll, { kind: "initiative" }).initiative, true);
    for (const test of [{ kind: "save", ability: "dex" }, { kind: "check", ability: "dex" }, { kind: "deathSave" }, { kind: "attack" }] as const) {
      assert.equal(asInitiative(roll, test).initiative, undefined, test.kind);
    }
  });

  test("a recharge action is spent only once what spends it started: Keep it on the open group save spends nothing", () => {
    let spent = 0;
    const spend = () => spent++;
    assert.equal(spendOnStart(() => false, spend), false, "another group save held rolls, and the DM kept it");
    assert.equal(spent, 0);
    assert.equal(spendOnStart(() => true, spend), true, "Discard started the new page");
    assert.equal(spent, 1);
    assert.equal(spendOnStart(() => true, null), true, "an action with no recharge spends nothing");
    assert.equal(spent, 1);
  });
});

describe("recharge and X/Day as room state (docs/design-v1-combat-controls.md 6)", () => {
  const breath: NamedRoll = { key: "actions:fire-breath", name: "Fire Breath", section: "actions", save: { ability: "dex", dc: 21, onPass: "half" }, damage: [{ formula: "18d6", type: "fire" }], recharge: 5 };
  const dominate: NamedRoll = { key: "actions:dominate-mind", name: "Dominate Mind", section: "actions", save: { ability: "wis", dc: 15, onPass: "none" }, damage: [], uses: "2/Day" };
  const BLOCK_BREATH: RechargeUse = { kind: "recharge", key: "actions:fire-breath", name: "Fire Breath", min: 5, section: "actions" };
  const BLOCK_DOMINATE: DayUse = { kind: "day", key: "actions:dominate-mind", name: "Dominate Mind", max: 2, short: true, section: "actions" };
  const used = (kind: UseMark["kind"], n = 1, max = 1): UseMark => ({ kind, name: "x", used: n, max });

  test("the old per-tab Used marks are deleted as a room loads, only that room's, and blocked storage never throws (3.6)", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const kept = new Map([
      ["rvtt.rechargeUsed.r1", "{}"],
      ["rvtt.rechargeUsed.r2", "{}"],
      ["rvtt.other", "1"],
    ]);
    try {
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { removeItem: (k: string) => kept.delete(k) } });
      dropOldRechargeMarks("r1");
      assert.deepEqual([...kept.keys()], ["rvtt.rechargeUsed.r2", "rvtt.other"]);
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: {
          removeItem() {
            throw new Error("blocked");
          },
        },
      });
      assert.doesNotThrow(() => dropOldRechargeMarks("r2"));
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() {
          throw new Error("denied");
        },
      });
      assert.doesNotThrow(() => dropOldRechargeMarks("r2"), "even reading the storage may throw, in a sandboxed frame");
    } finally {
      if (before) Object.defineProperty(globalThis, "sessionStorage", before);
      else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });

  test("a mark counts only under its own key and kind, never one inherited from Object", () => {
    const marks = { "actions:fire-breath": used("recharge"), "actions:dominate-mind": used("day", 1, 2) };
    assert.equal(markOf(marks, "actions:fire-breath", "recharge"), marks["actions:fire-breath"]);
    assert.equal(markOf(marks, "actions:fire-breath", "day"), undefined, "another kind under the key is not this ability's");
    assert.equal(markOf(marks, "actions:bite", "recharge"), undefined);
    assert.equal(markOf({}, "constructor", "recharge"), undefined);
    assert.equal(markOf(Object.create({ "actions:fire-breath": used("recharge") }) as Record<string, UseMark>, "actions:fire-breath", "recharge"), undefined, "only a mark of the actor's own");
    assert.equal(markOf(undefined, "actions:fire-breath", "recharge"), undefined, "a viewer whose copy holds no marks");
  });

  test("a recharge row's ability: the block's own entry by its key, else the roll's own facts, and never a spell's", () => {
    const blockName: LimitedUse = { ...BLOCK_BREATH, name: "Fire Breath of the Block" };
    assert.equal(rechargeUseOf(breath, [blockName]), blockName, "the block's entry wins, with its name and range");
    assert.deepEqual(rechargeUseOf(breath, []), BLOCK_BREATH, "a block that leaves it out: the roll's key, name and range");
    assert.deepEqual(rechargeUseOf(breath, null), BLOCK_BREATH, "no block read: the same");
    assert.deepEqual(rechargeUseOf({ ...breath, recharge: 6 }, [{ ...BLOCK_DOMINATE, key: breath.key }]), { ...BLOCK_BREATH, min: 6 }, "an X/Day entry under the key is not its recharge");
    assert.equal(rechargeUseOf(dominate, [BLOCK_BREATH]), null, "no recharge on the roll");
    assert.equal(rechargeUseOf({ ...breath, section: "spells" }, null), null, "a spell has no ability key");
  });

  test("an X/Day row's ability comes from the block, which leaves out spells and legendary actions, and from the roll only where no block is read", () => {
    assert.equal(dayUseOf(dominate, [BLOCK_DOMINATE]), BLOCK_DOMINATE, "the block knows a Short Rest brings it back");
    assert.equal(dayUseOf(dominate, [BLOCK_BREATH]), null, "a block that does not list it as X/Day, as a Spellcasting entry's spell");
    assert.deepEqual(dayUseOf(dominate, null), { ...BLOCK_DOMINATE, short: false });
    assert.equal(dayUseOf({ ...dominate, uses: "1/Day; Requires Soul Bag" }, null)?.max, 1);
    assert.equal(dayUseOf({ ...dominate, uses: "0/Day" }, null), null);
    assert.equal(dayUseOf({ ...dominate, uses: "10/Day" }, null), null, "past the 9 a mark holds");
    assert.equal(dayUseOf({ ...dominate, section: "spells" }, null), null);
    assert.equal(dayUseOf(breath, [BLOCK_DOMINATE]), null, "no uses on the roll");
  });

  test("a roll marks its recharge used only where this device shows it ready, and its op can never be refused for being used", () => {
    assert.equal(markOnRoll(BLOCK_BREATH, {}), BLOCK_BREATH);
    assert.equal(markOnRoll(BLOCK_BREATH, undefined), BLOCK_BREATH);
    assert.equal(markOnRoll(BLOCK_BREATH, { "actions:fire-breath": used("recharge") }), null, "shown used: nothing goes");
    assert.equal(markOnRoll(BLOCK_BREATH, { "actions:fire-breath": used("day") }), BLOCK_BREATH, "a mark of another kind leaves it ready");
    assert.equal(markOnRoll(null, {}), null, "a roll with no recharge marks nothing");
    const target = { tokenId: "drag" };
    assert.deepEqual(abilityOp(target, markOnRoll(BLOCK_BREATH, {})!, { ifReady: true, quiet: true }), {
      t: "actor.use",
      target,
      use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5, ifReady: true },
      quiet: true,
    });
    // Used's own tap: Mark used is public by name, Mark ready gives it back.
    assert.deepEqual(abilityOp(target, BLOCK_BREATH, { back: true }), { t: "actor.use", target, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 }, back: true });
    assert.deepEqual(abilityOp(target, BLOCK_DOMINATE), { t: "actor.use", target, use: { kind: "ability", key: "actions:dominate-mind", name: "Dominate Mind", limit: "day", max: 2, short: true } });
  });

  test("an X/Day row counts what is left after its printed words, and never below 0", () => {
    assert.deepEqual(dayCount("2/Day", BLOCK_DOMINATE, undefined), { left: 2, text: "2/Day, 2 left" });
    assert.deepEqual(dayCount("2/Day", BLOCK_DOMINATE, used("day", 1, 2)), { left: 1, text: "2/Day, 1 left" });
    assert.deepEqual(dayCount("2/Day", BLOCK_DOMINATE, used("day", 2, 2)), { left: 0, text: "2/Day, 0 left" });
    assert.equal(dayCount("1/Day; Requires Soul Bag", { ...BLOCK_DOMINATE, max: 1 }, used("day", 3, 3)).left, 0, "a mark from before the block was edited down");
    assert.equal(dayCount("1/Day; Requires Soul Bag", { ...BLOCK_DOMINATE, max: 1 }, undefined).text, "1/Day; Requires Soul Bag, 1 left");
  });

  test("a group save's recharge names its holder as the Dice panel keys it, a token or a character", () => {
    assert.deepEqual(holderTarget("t:drag"), { tokenId: "drag" });
    assert.deepEqual(holderTarget("c:bree"), { characterId: "bree" });
    assert.equal(holderTarget("t:"), null);
    assert.equal(holderTarget("x:drag"), null);
    assert.equal(holderTarget(""), null);
  });

  test("who may spend a creature's uses: the DM, or one who owns it, directly or through its character", () => {
    const state = table();
    state.tokens.lent = token("lent", { kind: "monster", name: "Mule", ownerIds: ["p2"] });
    state.tokens.breeTok!.ownerIds = [];
    const dm = { role: "dm" as const, memberId: "dm1" };
    const bree = { role: "player" as const, memberId: "p1" };
    const other = { role: "player" as const, memberId: "p2" };
    assert.equal(spendsFor(state, dm, { tokenId: "gob" }), true);
    assert.equal(spendsFor(state, bree, { tokenId: "gob" }), false);
    assert.equal(spendsFor(state, bree, { characterId: "bree" }), true);
    assert.equal(spendsFor(state, bree, { tokenId: "breeTok" }), true, "through the token's character");
    assert.equal(spendsFor(state, other, { tokenId: "breeTok" }), false);
    assert.equal(spendsFor(state, other, { tokenId: "lent" }), true, "a token lent to them");
    assert.equal(spendsFor(state, bree, { tokenId: "gone" }), false);
  });
});

describe("HP chips once applied", () => {
  test("an applied line goes, and no older line of its side takes its place", async () => {
    const { hpChips } = await import("./options.ts");
    const line = (id: string, by: string, total: number) => ({ id, at: "", kind: "event" as const, data: { type: "dice" as const, by, to: "all" as const, rolls: [{ formula: "1d8", faces: [total], total, label: "Longsword damage, slashing" }] } });
    const log = [line("1:0", "p1", 3), line("2:0", "p1", 7), line("3:0", "dm1", 5)];
    const nameOf = () => "Bree";
    assert.deepEqual(hpChips(log, "p1", "damage", { applied: new Set(), nameOf }).map((c) => c.lineId), ["2:0", "3:0"]);
    assert.deepEqual(hpChips(log, "p1", "damage", { applied: new Set(["2:0"]), nameOf }).map((c) => c.lineId), ["3:0"]);
  });
});

describe("initiative written by the room, not the surface that rolled (ASTRA-08)", () => {
  function setup(value: number | null) {
    const view = room({ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [entry("e1", { tokenId: "g1", value })] } });
    const log: LogEntry[] = [];
    const tracker = new ReceiptTracker();
    tracker.env = { lookup: () => Promise.resolve({ parts: [] }), log: () => log };
    const store = createStore<OptionState>(() => ({ tags: {}, since: {}, critical: {}, riders: {}, askOff: {}, picked: null, acted: {}, slots: {}, focus: 0, focused: 0, cast: null, openings: 0, castFocused: 0, bonus: {} }));
    const sent: ClientOp[] = [];
    const env: InitiativeEnv = { tracker, store, view: () => view, dispatch: (op) => sent.push(op), dm: true };
    const land = (tag: string, total: number) => {
      log.push({ id: `${log.length + 1}:0`, at: "", kind: "event", data: { type: "dice", tag, by: "dm1", to: "dm", rolls: [{ formula: "1d20+2", faces: [total - 2], total }] } });
      tracker.answer(tag, 0, "taken");
    };
    return { view, tracker, store, sent, env, land };
  }
  const tick = () => new Promise<void>((done) => queueMicrotask(done));

  test("a roll that lands after its surface closed still sets its row, once, however many watch it", async () => {
    const { tracker, sent, env, land } = setup(null);
    tracker.sending("T", 0);
    watchInitiative(env, "T", { entryId: "e1", before: null });
    watchInitiative(env, "T", { entryId: "e1", before: null });
    await tick();
    assert.deepEqual(sent, [], "nothing until it lands");
    land("T", 17);
    await tick();
    assert.deepEqual(sent, [{ t: "encounter.setValues", values: [{ entryId: "e1", value: 17 }] }]);
  });

  test("a row changed meanwhile keeps its value and says so, and a refused roll writes nothing", async () => {
    const { view, tracker, store, sent, env, land } = setup(null);
    tracker.sending("T", 0);
    watchInitiative(env, "T", { entryId: "e1", before: null });
    view.encounter!.entries[0]!.value = 12;
    land("T", 17);
    await tick();
    assert.deepEqual(sent, []);
    assert.equal(store.getState().acted["T:changed"], true);
    tracker.sending("R", 0);
    watchInitiative(env, "R", { entryId: "e1", before: 12 });
    tracker.answer("R", 0, "refused", { code: "quota", message: "You are going too fast.", text: "You are going too fast." });
    await tick();
    assert.deepEqual(sent, []);
  });
});

describe("a player's creatures", () => {
  test("their character, its companion, then a token they own that is neither, such as a beast not made a companion, and never another's or an object (W7B-P-7)", () => {
    const view = room({
      characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }), mara: character("mara", { name: "Mara", ownerIds: ["p2"] }) },
      tokens: {
        breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
        owl: token("owl", { kind: "monster", name: "Owl", ownerIds: ["p1"], companion: { of: "bree", turn: "own" }, actor: { inline: actor({ srdId: "owl" }) } }),
        wolf: token("wolf", { kind: "monster", name: "Wolf", ownerIds: ["p1"], actor: { inline: actor({ srdId: "wolf" }) } }),
        cart: token("cart", { kind: "object", name: "Cart", ownerIds: ["p1"] }),
        theirs: token("theirs", { kind: "monster", name: "Hawk", ownerIds: ["p2"], actor: { inline: actor() } }),
        elsewhere: token("elsewhere", { kind: "monster", name: "Mule", ownerIds: ["p1"], sceneId: "s2", actor: { inline: actor() } }),
      },
    });
    // A player's projection leaves out the owners of a token they do not own.
    delete (view.tokens.theirs as { ownerIds?: string[] }).ownerIds;
    const scene = view.tokens.breeTok!.sceneId;
    assert.deepEqual(
      playerCreatures(view, "p1", scene, (t) => t.name).map((p) => p.key),
      ["c:bree", "t:owl", "t:wolf"],
    );
  });

  test("a token they own of a character they do not, the DM's NPC lent to them, keyed as its selection is, so its bar's Roll picks it (W7B-R2-2)", () => {
    const view = room({
      characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }), sage: character("sage", { name: "Sage", ownerIds: [] }) },
      tokens: {
        breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
        sageTok: token("sageTok", { kind: "npc", name: "Sage", ownerIds: ["p1"], actor: { ref: "sage" } }),
      },
    });
    const picks = playerCreatures(view, "p1", view.tokens.breeTok!.sceneId, (t) => t.name);
    assert.deepEqual(picks.map((p) => [p.key, p.creature]), [["c:bree", { characterId: "bree" }], ["c:sage", { tokenId: "sageTok" }]]);
    assert.equal(picks[1]!.key, creatureKey(view, { tokenId: "sageTok" }), "the key a selection of it reads");
  });
});

describe("a group's shared tags, said once in its label (docs/design-v1-dice-ui.md 4.3)", () => {
  const blessed = { sources: [], extra: ["+1d4"], extraFrom: ["blessed"], notes: [] };
  const restrainedDex = { sources: [{ kind: "dis" as const, from: "restrained" }], extra: ["+1d4"], extraFrom: ["blessed"], notes: [] };
  const plain = { sources: [], extra: [], notes: [] };

  test("Bless alone: every save carries +1d4, so the label says it and no button does", () => {
    const six = Array.from({ length: 6 }, () => blessed);
    assert.deepEqual(commonTags(six), ["+1d4"]);
    assert.equal(groupNote(six), "+1d4: Blessed", "the effect named once, not six times");
  });

  test("Bless with Restrained: +1d4 is shared, Dex's Dis stays on its own button, and the label names both once", () => {
    const saves = [blessed, restrainedDex, blessed, blessed, blessed, blessed];
    assert.deepEqual(commonTags(saves), ["+1d4"]);
    assert.equal(groupNote(saves), "+1d4: Blessed. Dis: Restrained");
  });

  test("none: nothing shared, an empty label note, and one plain save keeps a part on every button that has it", () => {
    assert.deepEqual(commonTags([plain, plain]), []);
    assert.equal(groupNote([plain, plain]), "");
    assert.deepEqual(commonTags([blessed, plain]), [], "the plain save does not carry +1d4, so the Blessed ones keep their tag");
    assert.deepEqual(commonTags([]), []);
  });
});

describe("the folds' lines and openings (docs/design-v1-dice-pass.md 6)", () => {
  const preset = (extra: string[] = [], adv = false): RollPreset => ({ sources: adv ? [{ kind: "adv", from: "hasted" }] : [], extra, notes: [] });

  test("Saves and checks: its notes, then the six saves, each named as a word and signed with the true minus", () => {
    const saves = { str: 4, dex: 1, con: 3, int: 0, wis: 5, cha: -1 };
    assert.equal(foldSummary({ group: "saves", note: "asks Thorn. +1d4: Blessed", saves }), "asks Thorn. +1d4: Blessed · Str +4, Dex +1, Con +3, Int +0, Wis +5, Cha −1");
    assert.equal(foldSummary({ group: "saves", note: "", saves }), "Str +4, Dex +1, Con +3, Int +0, Wis +5, Cha −1");
    assert.equal(foldSummary({ group: "saves", note: "asks Bree", saves: null }), "asks Bree", "no numbers for a creature without them");
    assert.equal(foldSummary({ group: "saves", note: "", saves: null }), "");
  });

  test("Skills: only those above their ability's check, the trained ones", () => {
    const skills = [
      { name: "Athletics", bonus: 6, check: 3 },
      { name: "Acrobatics", bonus: 1, check: 1 },
      { name: "Insight", bonus: 4, check: 1 },
      { name: "Stealth", bonus: -2, check: 1 },
    ];
    assert.equal(foldSummary({ group: "skills", skills }), "Athletics +6, Insight +4");
    assert.equal(foldSummary({ group: "skills", skills: [{ name: "Acrobatics", bonus: 1, check: 1 }] }), "", "none trained, no line");
  });

  test("an action group names its rows, a used recharge as used, and Spells counts them after the DC and the attack", () => {
    assert.equal(foldSummary({ group: "rows", rows: [{ name: "Rend" }, { name: "Acid Breath", used: true }, { name: "Tail", used: false }] }), "Rend, Acid Breath (used), Tail");
    assert.equal(foldSummary({ group: "spells", dc: 14, attack: 6, count: 13 }), "DC 14 · +6 to hit · 13 spells");
    assert.equal(foldSummary({ group: "spells", dc: 14, count: 1 }), "DC 14 · 1 spell");
    assert.equal(foldSummary({ group: "spells", attack: -1, count: 0 }), "−1 to hit");
  });

  test("what waits in a folded group leads its line: the asks, then the asks for saves", () => {
    const saves = { str: 0, dex: 2, con: 0, int: 0, wis: 0, cha: 0 };
    assert.equal(foldSummary({ group: "saves", note: "", saves }, { asked: ["DEX save", "WIS save"], casts: [] }), "Asked: DEX save, WIS save · Str +0, Dex +2, Con +0, Int +0, Wis +0, Cha +0");
    assert.equal(foldSummary({ group: "spells", dc: 14, count: 2 }, { asked: [], casts: ["Fireball"] }), "Ask for saves waiting: Fireball · DC 14 · 2 spells");
    assert.equal(foldSummary({ group: "rows", rows: [{ name: "Rend" }] }, { asked: ["STR check"], casts: ["Acid Breath", "Rend"] }), "Asked: STR check · Ask for saves waiting: Acid Breath, Rend · Rend");
    assert.equal(foldSummary({ group: "rows", rows: [{ name: "Rend" }] }, { asked: [], casts: [] }), "Rend");
  });

  test("spells by level: cantrips, each level up, then those with none, each in its order", () => {
    const spell = (name: string, level?: number) => ({ name, ...(level !== undefined ? { level } : {}) });
    const levels = spellLevels([spell("Bless", 1), spell("Fireball", 3), spell("Sacred Flame", 0), spell("Darkness"), spell("Cure Wounds", 1), spell("Light", 0)]);
    assert.deepEqual(
      levels.map((l) => [l.label, l.rows.map((r) => r.name)]),
      [
        ["Cantrips", ["Sacred Flame", "Light"]],
        ["Level 1", ["Bless", "Cure Wounds"]],
        ["Level 3", ["Fireball"]],
        ["Other", ["Darkness"]],
      ],
    );
    assert.deepEqual(spellLevels([spell("Bless", 1), spell("Shield", 1)]).map((l) => l.label), [null], "one level needs no label");
    assert.deepEqual(spellLevels([spell("Darkness"), spell("Hold Person")]).map((l) => l.label), [null], "a monster's spells with no level take none");
    assert.deepEqual(spellLevels([spell("Fireball", 3), spell("Darkness")]).map((l) => l.label), ["Level 3", "Other"]);
    assert.deepEqual(spellLevels([spell("Fireball", 3), spell("Bless", 1)]).map((l) => l.label), ["Level 1", "Level 3"], "levels in order whatever the rows' order");
    assert.deepEqual(spellLevels([]), []);
  });

  test("Initiative's tag: what its tap does to the tracker, then its preset, parted, with the true minus", () => {
    assert.equal(initiativeTag({ value: 12 }, preset(["-4"])), "replaces 12 · −4");
    assert.equal(initiativeTag({ value: -3 }, preset()), "replaces −3");
    assert.equal(initiativeTag({ value: null }, preset(["+1d4"], true)), "sets row · Adv +1d4");
    assert.equal(initiativeTag(null, preset(["-2", "+1d4"])), "−2 +1d4", "no row, or a score's");
    assert.equal(initiativeTag(null, preset()), "");
  });

  test("a spell's name matches whatever its case and spaces", () => {
    assert.equal(sameSpell(" Fireball", "fireball "), true);
    assert.equal(sameSpell("Fireball", "Fire Bolt"), false);
  });
});

describe("what waits in a creature's groups (docs/design-v1-dice-pass.md 6.4)", () => {
  const named = [
    { key: "a:rend", name: "Rend", section: "actions" as const },
    { key: "s:fireball", name: "Fireball", section: "spells" as const },
    { key: "s:hold", name: "Hold Person", section: "spells" as const },
    { key: "b:breath", name: "Breath", section: "bonusActions" as const },
  ];
  function state(rolls: Record<string, RollRequest> = {}, casts: RoomState["casts"] = {}): RoomState {
    return { ...table(rolls), casts };
  }

  test("a request opens Saves and checks for a save or a plain check, and Skills for a skill, by its id, and an answered one opens nothing", () => {
    const rolls = {
      r1: request(),
      r2: request({ id: "r2", test: { kind: "check", choices: [{ ability: "str" }, { ability: "wis", skill: "perception" }] } }),
      r3: request({ id: "r3", test: { kind: "save", choices: [{ ability: "con" }] }, targets: [{ characterId: "bree", total: 9 }] }),
      r4: request({ id: "r4", test: { kind: "save", choices: [{ ability: "int" }] }, targets: [{ tokenId: "gob" }] }),
    };
    const asks = groupAsks({ state: state(rolls), creature: { tokenId: "breeTok" }, named, cast: null });
    assert.deepEqual(asks.saves, { ids: ["r1", "r2"], asked: ["WIS save", "DEX save", "STR check"], casts: [] }, "in each request's order");
    assert.deepEqual(asks.skills, { ids: ["r2"], asked: ["Perception check"], casts: [] });
    assert.deepEqual(Object.keys(asks).sort(), ["saves", "skills"]);
    assert.deepEqual(groupAsks({ state: state(rolls), creature: { tokenId: "gob" }, named, cast: null }), { saves: { ids: ["r4"], asked: ["INT save"], casts: [] } }, "the goblin's own ask, a monster's");
    assert.deepEqual(groupAsks({ state: state(), creature: { tokenId: "breeTok" }, named, cast: null }), {});
    const perception = request({ id: "r5", test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, targets: [{ characterId: "bree", total: 12 }] });
    assert.deepEqual(groupAsks({ state: state({ r5: perception }), creature: { characterId: "bree" }, named, cast: null }), {}, "an answered skill check opens nothing");
  });

  test("an open block opens the group of its row, by the row's key or its spell's name, by its stamp, with its send only marked seen", () => {
    const base = { key: "c:bree", creature: { characterId: "bree" } };
    const byRoll = groupAsks({ state: state(), creature: { characterId: "bree" }, named, cast: { ...base, spell: "Old name", roll: "s:hold", opened: 3 } });
    assert.deepEqual(byRoll, { spells: { ids: ["open:3"], asked: [], casts: ["Old name"] } });
    const byName = groupAsks({ state: state(), creature: { characterId: "bree" }, named, cast: { ...base, spell: "breath", opened: 4, sent: "ask-9" } });
    assert.deepEqual(byName, { bonusActions: { ids: ["open:4"], quiet: ["ask-9"], asked: [], casts: ["breath"] } });
    assert.deepEqual(groupAsks({ state: state(), creature: { characterId: "bree" }, named, cast: { ...base, spell: "Fireball", area: "a1" } }).spells?.ids, ["open:0"], "a block opened before the stamps");
    assert.deepEqual(groupAsks({ state: state(), creature: { characterId: "bree" }, named, cast: { ...base, spell: "Gone", roll: "s:gone", opened: 5 } }), {}, "with no row it draws at the top, in no group");
    assert.deepEqual(groupAsks({ state: state(), creature: { tokenId: "gob" }, named, cast: { ...base, spell: "Fireball", opened: 6 } }), {}, "another creature's block");
  });

  test("a block names its spell in the folded line only until its send settles, and still opens its group by its stamp", () => {
    const cast = { key: "c:bree", creature: { characterId: "bree" }, spell: "Hold Person", roll: "s:hold", opened: 7, sent: "ask-7" };
    const at = (castPhase: Parameters<typeof groupAsks>[0]["castPhase"]) => groupAsks({ state: state(), creature: { characterId: "bree" }, named, cast, castPhase }).spells;
    assert.deepEqual(at(null), { ids: ["open:7"], quiet: ["ask-7"], asked: [], casts: ["Hold Person"] }, "not sent yet");
    assert.deepEqual(at("sending"), { ids: ["open:7"], quiet: ["ask-7"], asked: [], casts: ["Hold Person"] });
    for (const phase of ["refused", "unknown", "asked", "closed"] as const) assert.deepEqual(at(phase), { ids: ["open:7"], quiet: ["ask-7"], asked: [], casts: [] }, phase);
  });

  test("an ask for saves waiting in the view opens its row's group by its id, once with its block's send", () => {
    const casts = {
      k1: castAsk("k1", { caster: "breeTok", spell: "Fireball", area: "a1" }),
      k2: castAsk("k2", { caster: "breeTok", spell: "Hold Person", roll: "s:hold", area: undefined }),
      k3: castAsk("k3", { caster: "gob", spell: "Rend" }),
      k4: castAsk("k4", { caster: "breeTok", spell: "Unknown" }),
    };
    const asks = groupAsks({ state: state({}, casts), creature: { characterId: "bree" }, named, cast: { key: "c:bree", creature: { characterId: "bree" }, spell: "Fireball", opened: 2, sent: "k1" } });
    assert.deepEqual(asks, { spells: { ids: ["open:2", "k1", "k2"], quiet: ["k1"], asked: [], casts: ["Fireball", "Hold Person"] } });
  });

  test("a retry the block follows from the list above the card keeps its folded group folded, and so does that ask once it waits in the view (DB-O9)", () => {
    const folds = createDiceFolds(null);
    const phone = { width: 390, height: 844 };
    folds.get(phone);
    const block = { key: "c:bree", creature: { characterId: "bree" }, spell: "Hold Person", roll: "s:hold", opened: 1 };
    const render = (cast: CastBlock | null, casts: RoomState["casts"] = {}) => openForAsks(folds, "pc", groupAsks({ state: state({}, casts), creature: { characterId: "bree" }, named, cast }));
    render(block);
    assert.equal(folds.get(phone)["pc.spells"], true, "the opening opens Spells");
    render({ ...block, sent: "k1" });
    // Refused, then folded: the refusal shows above the card, whose Ask again moves the block to the retry.
    folds.tap("pc.spells", false, false);
    render({ ...block, sent: "k1" });
    render({ ...block, sent: "k2" });
    assert.equal(folds.get(phone)["pc.spells"], false, "the retry opened the folded group");
    render(null, { k2: castAsk("k2", { caster: "breeTok", spell: "Hold Person", roll: "s:hold", area: undefined }) });
    assert.equal(folds.get(phone)["pc.spells"], false, "the retry's ask, waiting in the view, opened it");
    render(null, { k2: castAsk("k2", { caster: "breeTok", spell: "Hold Person", roll: "s:hold", area: undefined }), k3: castAsk("k3", { caster: "breeTok", spell: "Hold Person", roll: "s:hold", area: undefined }) });
    assert.equal(folds.get(phone)["pc.spells"], true, "an ask first seen in the view still opens it");
  });

  test("each group opens in the creature's own kind, once per id it has not seen", () => {
    const calls: [string, readonly string[], readonly string[] | undefined][] = [];
    const store = { openForNew: (key: string, ids: readonly string[], quiet?: readonly string[]) => (calls.push([key, ids, quiet]), true) };
    openForAsks(store, "monster", { saves: { ids: ["r1"], asked: ["DEX save"], casts: [] }, spells: { ids: ["open:1"], quiet: ["k1"], asked: [], casts: ["Fireball"] } });
    assert.deepEqual(calls, [
      ["monster.saves", ["r1"], undefined],
      ["monster.spells", ["open:1"], ["k1"]],
    ]);
  });
});
