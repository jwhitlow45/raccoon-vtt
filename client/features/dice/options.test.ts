import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import { createStore } from "zustand/vanilla";
import type { DiceRoll, LogEntry, RollRequest, RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { actor, character, entry, room, token } from "#shared/testutil.ts";
import type { OptionState } from "./optionState.ts";
import { ReceiptTracker } from "./useReceipt.ts";
import { watchInitiative, type InitiativeEnv } from "./useRollOption.ts";
import { asSave, critical, cutLabel, d20Roll, damageRolls, initiativeOp, initiativeRow, presetLine, resultWords, routeOf, scoreOf, spendOnStart, testLabel, withExtra, withUsed } from "./options.ts";

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

describe("initiative", () => {
  test("is written only to a row that still holds its value at the tap, as the DM's or the player's op", () => {
    const state = table();
    assert.deepEqual(initiativeOp(state, "e-bree", null, 17, false), { t: "encounter.setValue", entryId: "e-bree", value: 17 });
    assert.deepEqual(initiativeOp(state, "e-gob", 7, 15, true), { t: "encounter.setValues", values: [{ entryId: "e-gob", value: 15 }] });
    assert.equal(initiativeOp(state, "e-gob", null, 15, true), null, "typed meanwhile");
    assert.equal(initiativeOp(state, "gone", null, 15, true), null);
    assert.deepEqual(initiativeOp(state, "e-bree", null, 140, false), { t: "encounter.setValue", entryId: "e-bree", value: 100 }, "clamped as a typed value is");
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
    assert.equal(testLabel({ kind: "deathSave" }), "Death save");
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

  test("riders toggled on join the one line, one roll per type, doubled on a critical", () => {
    assert.deepEqual(damageRolls(rapier, { on: new Set(), critical: false }), [{ formula: "1d8+4", label: "Rapier damage, piercing" }]);
    assert.deepEqual(damageRolls(rapier, { on: new Set([1, 2]), critical: true, creature: { characterId: "bree" } }), [
      { formula: "2d8+4+6d6", label: "Rapier critical damage and Sneak Attack, piercing", creature: { characterId: "bree" } },
      { formula: "2d6", label: "Rapier critical damage and Sneak Attack, fire", creature: { characterId: "bree" } },
    ]);
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

  test("a save goes as a save of its ability, so the server records what fails it, and a check does not", () => {
    const roll = d20Roll({ tokenId: "gob" }, 2, { sources: [], extra: [], notes: [] }, "Dexterity save");
    assert.equal(asSave(roll, { kind: "save", ability: "dex" }).save, "dex");
    assert.equal(asSave(roll, { kind: "check", ability: "dex" }).save, undefined);
  });

  test("Used is kept per creature and action", () => {
    let used = withUsed({}, "t:gob", "actions:fire-breath", true);
    assert.deepEqual(used, { "t:gob": ["actions:fire-breath"] });
    used = withUsed(used, "t:gob", "actions:fire-breath", false);
    assert.deepEqual(used, {});
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
    const store = createStore<OptionState>(() => ({ tags: {}, since: {}, critical: {}, riders: {}, askOff: {}, picked: null, acted: {}, slots: {}, focus: 0, focused: 0 }));
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
